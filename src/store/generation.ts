import type { StoreApi } from 'zustand';
import type { ChatMessage, ChatNode, Profile } from '../types';
import { buildContext, collectAncestors } from '../lib/context';
import { describeEmbeddingError } from '../lib/embeddings';
import { isLocalUrl } from '../lib/endpoint';
import { contentToText } from '../lib/attachments';
import { LlmError, streamChat } from '../lib/llm';
import { placeChild } from '../lib/layout';
import {
  abandoned,
  controllers,
  DEFAULT_SETTINGS,
  detached,
  now,
  saver,
  uid,
  type StoreCore,
} from './core';
import type { GenerationSlice, State } from './types';

// 别叫 Set / Get —— 那会盖掉全局的 Set<string>，类型位置上悄悄变成 store 的 setter
type SetState = StoreApi<State>['setState'];
type GetState = StoreApi<State>['getState'];

/** 检索用的查询词就是这次真正要问的那句话 */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return contentToText(messages[i]!.content);
  }
  return '';
}

/**
 * 流式生成，以及它依赖的模型配置。
 *
 * 这一片最要紧的一条：生成任务认的是**发起时那张画布**（见 core 里的
 * commitTo）。人切走去别处看点东西，回来时答案应该已经在那儿了，而不是
 * 停在半句上、或者写进了眼前这张不相干的画布。
 */
export function createGenerationSlice(
  set: SetState,
  get: GetState,
  core: StoreCore,
): GenerationSlice {
  const { commit, commitTo, hasRunning, persistSettings } = core;

  const profileFor = (profileId?: string): Profile => {
    const { settings } = get();
    return (
      settings.profiles.find((p) => p.id === profileId) ??
      settings.profiles.find((p) => p.id === settings.activeProfileId) ??
      settings.profiles[0] ??
      DEFAULT_SETTINGS.profiles[0]!
    );
  };

  /**
   * 把一个 assistant 节点跑起来。
   * 关键技巧：先把它的 content 清空，buildContext 会自动跳过空节点，
   * 于是「首次生成」和「重新生成」共用同一条代码路径。
   */
  const run = async (assistantId: string) => {
    const graph = get().graph;
    const target = graph?.nodes[assistantId];
    if (!graph || !target) return;
    if (controllers.has(assistantId)) return;
    // 认准这张画布。中途切走了，结果也要写回这里，不能落到眼前那张上
    const graphId = graph.id;

    const profile = profileFor(target.profileId);
    // 本地服务通常不设 Key，不该被这道拦截挡下来
    if (!profile.apiKey && !isLocalUrl(profile.baseUrl)) {
      commit(
        (nodes) => {
          nodes[assistantId] = {
            ...nodes[assistantId]!,
            status: 'error',
            error: '还没填 API Key，点右上角「设置」配置一下。',
            updatedAt: now(),
          };
        },
        { history: false },
      );
      return;
    }

    // 这一步会清空已有回答，必须可撤销——重新生成把好答案冲掉是很常见的手滑
    commit(
      (nodes) => {
        nodes[assistantId] = {
          ...nodes[assistantId]!,
          content: '',
          reasoning: '',
          status: 'streaming',
          error: undefined,
          usage: undefined,
          model: profile.model,
          profileId: profile.id,
          updatedAt: now(),
        };
      },
      { label: '生成回答' },
    );

    const { settings } = get();
    // 附件要读 Blob 转 data URI，是异步的，所以先解析好再交给同步的 buildContext
    const attachments = await get().resolveAttachments(
      collectAncestors(get().graph!.nodes, assistantId),
    );
    const base = {
      systemPrompt: settings.systemPrompt,
      limit: settings.contextLimit,
      attachments,
    };
    let messages = buildContext(get().graph!.nodes, assistantId, base);

    if (!messages.some((m) => m.role !== 'system')) {
      commit(
        (nodes) => {
          nodes[assistantId] = {
            ...nodes[assistantId]!,
            status: 'error',
            error: '上下文是空的 —— 往上游的节点里写点内容再发送。',
            updatedAt: now(),
          };
        },
        { history: false },
      );
      return;
    }

    /*
     * 检索知识库。
     *
     * 失败时整条请求就失败，而不是安静地不带资料继续问 —— 用户明明往这个
     * 画布里加了资料，答案却是凭空编的，这种「看起来正常其实没读资料」
     * 比直接报错难发现得多。报错文案里给出两条出路：把服务起起来，或者
     * 在知识库面板里把文件停用。
     */
    if (get().knowledgeFiles.some((f) => f.enabled && f.status === 'ready')) {
      try {
        const hits = await get().retrieveKnowledge(lastUserText(messages));
        messages = buildContext(get().graph!.nodes, assistantId, { ...base, knowledge: hits });
      } catch (err) {
        commit(
          (nodes) => {
            const current = nodes[assistantId];
            if (!current) return;
            nodes[assistantId] = {
              ...current,
              status: 'error',
              error: `知识库检索失败，这次提问没有发出去。\n\n${describeEmbeddingError(err)}\n\n也可以在知识库面板里把文件停用，先不带资料提问。`,
              updatedAt: now(),
            };
          },
          { history: false },
        );
        return;
      }
    }

    const controller = new AbortController();
    controllers.set(assistantId, { controller, graphId });

    let content = '';
    let reasoning = '';
    let usage: ChatNode['usage'];
    let lastFlush = 0;

    const flush = (status: ChatNode['status'], error?: string) => {
      // commitTo 认 graphId：切走了就写进后台那份副本，不入历史（每 33ms 一次）
      commitTo(graphId, (nodes) => {
        const current = nodes[assistantId];
        if (!current) return;
        nodes[assistantId] = {
          ...current,
          content,
          reasoning: reasoning || undefined,
          usage,
          status,
          error,
          updatedAt: now(),
        };
      });
      lastFlush = performance.now();
    };

    try {
      for await (const chunk of streamChat(profile, messages, controller.signal)) {
        if (chunk.delta) content += chunk.delta;
        if (chunk.reasoning) reasoning += chunk.reasoning;
        if (chunk.usage) usage = chunk.usage;
        // 每个 token 都 set 会把画布拖垮，节流到 ~30fps
        if (performance.now() - lastFlush > 33) flush('streaming');
      }
      flush('idle');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // 被撤销/重做作废的，一个字都不写回去，否则会盖掉刚还原的状态；
        // 用户主动按「停止」则保留已经吐出来的部分
        if (!abandoned.has(assistantId)) flush('idle');
      } else if (err instanceof LlmError) {
        flush('error', err.hint ? `${err.message}\n\n${err.hint}` : err.message);
      } else {
        flush('error', (err as Error)?.message ?? String(err));
      }
    } finally {
      controllers.delete(assistantId);
      abandoned.delete(assistantId);
      saver.flush();
      // 后台那张画布上最后一个生成结束了，就不用再挂着了
      if (!hasRunning(graphId)) detached.delete(graphId);
    }
  };

  return {
    settings: DEFAULT_SETTINGS,

    async send(userNodeId) {
      const graph = get().graph;
      const source = graph?.nodes[userNodeId];
      if (!graph || !source) return;

      // 复用「空的」assistant 子节点，避免重复点击刷出一堆空节点。
      // 已经有内容的回答绝不覆盖 —— 再点一次发送会在旁边并排生成新的一版，
      // 这是画布相对线性聊天最要紧的一条：任何时候都不该丢掉已有的回答。
      const children = Object.values(graph.nodes).filter(
        (n) => n.role === 'assistant' && n.parentIds.length === 1 && n.parentIds[0] === userNodeId,
      );
      const blank = children.find((n) => !n.content.trim() && n.status !== 'streaming');
      if (blank) {
        await run(blank.id);
        return;
      }
      if (children.length) {
        await get().branchRegenerate(children[children.length - 1]!.id);
        return;
      }

      const id = uid();
      const profile = profileFor();
      commit((nodes) => {
        nodes[id] = {
          id,
          role: 'assistant',
          content: '',
          parentIds: [userNodeId],
          position: placeChild(nodes, [source]),
          createdAt: now(),
          updatedAt: now(),
          status: 'idle',
          profileId: profile.id,
          model: profile.model,
        };
      });
      set({ selectedId: id });
      await run(id);
    },

    async regenerate(assistantId) {
      await run(assistantId);
    },

    /** 保留旧回答，在旁边并排生成一个新版本 —— 线性聊天做不到的事 */
    async branchRegenerate(assistantId) {
      const newId = get().addSibling(assistantId);
      if (!newId) return;
      await run(newId);
    },

    stop(nodeId) {
      controllers.get(nodeId)?.controller.abort();
    },

    updateSettings(patch) {
      persistSettings({ ...get().settings, ...patch });
    },

    upsertProfile(profile) {
      const { settings } = get();
      const exists = settings.profiles.some((p) => p.id === profile.id);
      persistSettings({
        ...settings,
        profiles: exists
          ? settings.profiles.map((p) => (p.id === profile.id ? profile : p))
          : [...settings.profiles, profile],
      });
    },

    removeProfile(id) {
      const { settings } = get();
      if (settings.profiles.length <= 1) return;
      const profiles = settings.profiles.filter((p) => p.id !== id);
      persistSettings({
        ...settings,
        profiles,
        activeProfileId:
          settings.activeProfileId === id ? profiles[0]!.id : settings.activeProfileId,
      });
    },

    activeProfile() {
      return profileFor();
    },
  };
}
