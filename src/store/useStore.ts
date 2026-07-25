import { create } from 'zustand';
import type { ChatNode, Graph, GraphMeta, NodeRole, Profile, Settings } from '../types';
import { buildContext, collectDescendants, wouldCreateCycle, type NodeMap } from '../lib/context';
import { emptyHistory, record, redo as redoStep, undo as undoStep, type StepResult } from '../lib/history';
import { LlmError, streamChat } from '../lib/llm';
import { placeChild, placeSibling } from '../lib/layout';
import { computeLayout, isSameLayout } from '../lib/autoLayout';
import * as db from '../lib/db';

const DEFAULT_SETTINGS: Settings = {
  profiles: [
    {
      id: 'default',
      name: '小米 MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: '', // 只能由使用者自己在设置里填，任何情况下都不写进代码
      model: 'mimo-v2.5-pro',
      temperature: 0.7,
    },
  ],
  activeProfileId: 'default',
  systemPrompt: '',
  contextLimit: 0,
};

const uid = () => crypto.randomUUID();
const now = () => Date.now();

/** 正在跑的请求，放在 React 状态外面，避免每个 token 都触发无谓的重渲染 */
const controllers = new Map<string, AbortController>();
const saver = db.createDebouncedSaver();

function emptyGraph(): Graph {
  const seed: ChatNode = {
    id: uid(),
    role: 'user',
    content: '',
    parentIds: [],
    position: { x: 0, y: 0 },
    createdAt: now(),
    updatedAt: now(),
  };
  return {
    id: uid(),
    title: '未命名画布',
    nodes: { [seed.id]: seed },
    createdAt: now(),
    updatedAt: now(),
  };
}

/** 页面在流式输出中途被关掉，重开时状态会卡在 streaming，这里洗一遍 */
function sanitize(graph: Graph): Graph {
  const nodes: NodeMap = {};
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    nodes[id] = node.status === 'streaming' ? { ...node, status: 'idle' } : node;
  }
  return { ...graph, nodes };
}

interface State {
  graph: Graph | null;
  graphs: GraphMeta[];
  settings: Settings;
  selectedId: string | null;
  ready: boolean;
  /** 只暴露能否撤销/重做，历史本身放在闭包里，避免每次快照都触发全局重渲染 */
  canUndo: boolean;
  canRedo: boolean;

  /** 返回被撤销/重做的操作名，供 toast 提示；没得撤了返回 null */
  undo: () => string | null;
  redo: () => string | null;

  init: () => Promise<void>;
  refreshGraphList: () => Promise<void>;
  newGraph: () => Promise<void>;
  openGraph: (id: string) => Promise<void>;
  removeGraph: (id: string) => Promise<void>;
  renameGraph: (title: string) => void;
  importGraph: (graph: Graph) => Promise<void>;

  select: (id: string | null) => void;
  updateNode: (id: string, patch: Partial<ChatNode>) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  /** 返回实际删掉的节点数，调用方用它提示「删了 N 个，⌘Z 可撤销」 */
  removeNode: (id: string, cascade: boolean) => number;
  addChild: (parentId: string, role: NodeRole) => string | null;
  addSibling: (nodeId: string) => string | null;
  addRootNode: (role: NodeRole, position: { x: number; y: number }) => string | null;
  linkNodes: (from: string, to: string) => string | null;
  unlinkNodes: (from: string, to: string) => void;
  /** 一键整理布局。传入实测节点尺寸，返回是否真的动了 */
  applyLayout: (dimensions?: Map<string, { width: number; height: number }>) => boolean;

  send: (userNodeId: string) => Promise<void>;
  regenerate: (assistantId: string) => Promise<void>;
  branchRegenerate: (assistantId: string) => Promise<void>;
  stop: (nodeId: string) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  upsertProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
  activeProfile: () => Profile;
}

export const useStore = create<State>((set, get) => {
  let history = emptyHistory<NodeMap>();

  const syncHistoryFlags = () => {
    const canUndo = history.past.length > 0;
    const canRedo = history.future.length > 0;
    const s = get();
    if (s.canUndo !== canUndo || s.canRedo !== canRedo) set({ canUndo, canRedo });
  };

  const resetHistory = () => {
    history = emptyHistory<NodeMap>();
    syncHistoryFlags();
  };

  interface CommitOptions {
    /** 操作名，撤销时回显给用户 */
    label?: string;
    /** 传 false 表示不入历史：流式输出每 33ms 一次，会瞬间淹没历史栈 */
    history?: boolean;
    /** 同 key 的连续操作合并成一条（连续打字、一次拖拽的每个 mousemove） */
    coalesceKey?: string;
  }

  /** 所有对图的写操作都走这里：记历史 + 打时间戳 + 排队落盘 */
  const commit = (mutate: (nodes: NodeMap) => void, options: CommitOptions = {}) => {
    const graph = get().graph;
    if (!graph) return;

    if (options.history !== false) {
      history = record(history, {
        state: graph.nodes, // 变更「前」的快照，撤销要回到这里
        label: options.label ?? '修改',
        coalesceKey: options.coalesceKey,
        at: now(),
      });
    }

    const nodes = { ...graph.nodes };
    mutate(nodes);
    const next: Graph = { ...graph, nodes, updatedAt: now() };
    set({ graph: next });
    saver.queue(next);
    syncHistoryFlags();
  };

  /** 撤销和重做只换 nodes，不动画布 id/标题，也不记新历史 */
  const applyStep = (step: StepResult<NodeMap> | null): string | null => {
    const graph = get().graph;
    if (!step || !graph) return null;
    history = step.history;
    const next: Graph = { ...graph, nodes: step.state, updatedAt: now() };
    // 撤销后选中的节点可能已经不存在了
    const selectedId = get().selectedId;
    set({
      graph: next,
      selectedId: selectedId && step.state[selectedId] ? selectedId : null,
    });
    saver.queue(next);
    syncHistoryFlags();
    return step.label;
  };

  const persistSettings = (settings: Settings) => {
    set({ settings });
    void db.saveSettings(settings);
  };

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

    const profile = profileFor(target.profileId);
    if (!profile.apiKey && !profile.baseUrl.includes('localhost')) {
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
    const messages = buildContext(get().graph!.nodes, assistantId, {
      systemPrompt: settings.systemPrompt,
      limit: settings.contextLimit,
    });

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

    const controller = new AbortController();
    controllers.set(assistantId, controller);

    let content = '';
    let reasoning = '';
    let usage: ChatNode['usage'];
    let lastFlush = 0;

    const flush = (status: ChatNode['status'], error?: string) => {
      commit(
        (nodes) => {
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
        },
        // 每 33ms 一次，入历史会瞬间把栈冲爆；起点已经记过了
        { history: false },
      );
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
        // 用户手动停止：保留已经吐出来的部分
        flush('idle');
      } else if (err instanceof LlmError) {
        flush('error', err.hint ? `${err.message}\n\n${err.hint}` : err.message);
      } else {
        flush('error', (err as Error)?.message ?? String(err));
      }
    } finally {
      controllers.delete(assistantId);
      saver.flush();
    }
  };

  return {
    graph: null,
    graphs: [],
    settings: DEFAULT_SETTINGS,
    selectedId: null,
    ready: false,
    canUndo: false,
    canRedo: false,

    undo() {
      // 先掐掉在跑的请求：否则流式输出会继续往刚被还原的节点里写，状态就乱了
      for (const controller of controllers.values()) controller.abort();
      return applyStep(undoStep(history, get().graph?.nodes ?? {}));
    },

    redo() {
      for (const controller of controllers.values()) controller.abort();
      return applyStep(redoStep(history, get().graph?.nodes ?? {}));
    },

    async init() {
      const [settings, lastId, graphs] = await Promise.all([
        db.loadSettings(),
        db.loadLastGraphId(),
        db.listGraphs(),
      ]);
      // 老版本存的设置可能缺字段，跟默认值合一次
      const merged: Settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
      if (!merged.profiles?.length) merged.profiles = DEFAULT_SETTINGS.profiles;

      resetHistory();
      let graph = lastId ? await db.loadGraph(lastId) : undefined;
      if (!graph && graphs.length) graph = await db.loadGraph(graphs[0]!.id);
      if (!graph) {
        graph = emptyGraph();
        await db.saveGraph(graph);
      }
      graph = sanitize(graph);

      await db.saveLastGraphId(graph.id);
      set({ settings: merged, graph, graphs: await db.listGraphs(), ready: true });
    },

    async refreshGraphList() {
      set({ graphs: await db.listGraphs() });
    },

    async newGraph() {
      saver.flush();
      resetHistory(); // 历史是会话状态，不跨画布
      const graph = emptyGraph();
      await db.saveGraph(graph);
      await db.saveLastGraphId(graph.id);
      set({ graph, selectedId: null, graphs: await db.listGraphs() });
    },

    async openGraph(id) {
      saver.flush();
      const graph = await db.loadGraph(id);
      if (!graph) return;
      resetHistory();
      await db.saveLastGraphId(id);
      set({ graph: sanitize(graph), selectedId: null });
    },

    async removeGraph(id) {
      await db.deleteGraph(id);
      const graphs = await db.listGraphs();
      set({ graphs });
      if (get().graph?.id === id) {
        if (graphs.length) await get().openGraph(graphs[0]!.id);
        else await get().newGraph();
      }
    },

    renameGraph(title) {
      const graph = get().graph;
      if (!graph) return;
      const next = { ...graph, title, updatedAt: now() };
      set({ graph: next });
      saver.queue(next);
      void get().refreshGraphList();
    },

    async importGraph(incoming) {
      // 换一套 id，避免和已有画布撞车
      const idMap = new Map<string, string>();
      for (const id of Object.keys(incoming.nodes)) idMap.set(id, uid());
      const nodes: NodeMap = {};
      for (const [oldId, node] of Object.entries(incoming.nodes)) {
        const newId = idMap.get(oldId)!;
        nodes[newId] = {
          ...node,
          id: newId,
          parentIds: node.parentIds.map((p) => idMap.get(p)).filter((p): p is string => !!p),
          status: node.status === 'streaming' ? 'idle' : node.status,
        };
      }
      const graph: Graph = {
        id: uid(),
        title: incoming.title || '导入的画布',
        nodes,
        createdAt: now(),
        updatedAt: now(),
      };
      await db.saveGraph(graph);
      await db.saveLastGraphId(graph.id);
      resetHistory();
      set({ graph, selectedId: null, graphs: await db.listGraphs() });
    },

    select(id) {
      set({ selectedId: id });
    },

    updateNode(id, patch) {
      // 连续打字合并成一条历史，否则每敲一个字符就是一次撤销
      const isTyping = 'content' in patch && Object.keys(patch).length === 1;
      commit(
        (nodes) => {
          const current = nodes[id];
          if (!current) return;
          nodes[id] = { ...current, ...patch, updatedAt: now() };
        },
        isTyping ? { label: '编辑内容', coalesceKey: `text:${id}` } : { label: '修改节点' },
      );
    },

    moveNode(id, position) {
      commit(
        (nodes) => {
          const current = nodes[id];
          if (!current) return;
          nodes[id] = { ...current, position };
        },
        // 拖拽期间每次 mousemove 都会调进来，一次拖拽只该留一条历史
        { label: '移动节点', coalesceKey: `move:${id}` },
      );
    },

    removeNode(id, cascade) {
      const graph = get().graph;
      if (!graph) return 0;
      const doomed = cascade ? collectDescendants(graph.nodes, id) : new Set([id]);
      for (const victim of doomed) controllers.get(victim)?.abort();

      commit(
        (nodes) => {
          for (const victim of doomed) delete nodes[victim];
          // 幸存者不能挂着已删除的父节点
          for (const [nodeId, node] of Object.entries(nodes)) {
            if (node.parentIds.some((p) => doomed.has(p))) {
              nodes[nodeId] = {
                ...node,
                parentIds: node.parentIds.filter((p) => !doomed.has(p)),
              };
            }
          }
        },
        { label: doomed.size > 1 ? `删除 ${doomed.size} 个节点` : '删除节点' },
      );
      if (doomed.has(get().selectedId ?? '')) set({ selectedId: null });
      return doomed.size;
    },

    addChild(parentId, role) {
      const graph = get().graph;
      const parent = graph?.nodes[parentId];
      if (!graph || !parent) return null;
      const id = uid();
      const node: ChatNode = {
        id,
        role,
        content: '',
        parentIds: [parentId],
        position: placeChild(graph.nodes, [parent]),
        createdAt: now(),
        updatedAt: now(),
      };
      commit(
        (nodes) => {
          nodes[id] = node;
        },
        { label: '新建节点' },
      );
      set({ selectedId: id });
      return id;
    },

    addSibling(nodeId) {
      const graph = get().graph;
      const source = graph?.nodes[nodeId];
      if (!graph || !source) return null;
      const id = uid();
      const node: ChatNode = {
        id,
        role: source.role,
        content: '',
        parentIds: [...source.parentIds],
        position: placeSibling(graph.nodes, source),
        createdAt: now(),
        updatedAt: now(),
      };
      commit(
        (nodes) => {
          nodes[id] = node;
        },
        { label: '新建并列分支' },
      );
      set({ selectedId: id });
      return id;
    },

    addRootNode(role, position) {
      const graph = get().graph;
      if (!graph) return null;
      const id = uid();
      commit(
        (nodes) => {
          nodes[id] = {
            id,
            role,
            content: '',
            parentIds: [],
            position,
            createdAt: now(),
            updatedAt: now(),
          };
        },
        { label: '新建节点' },
      );
      set({ selectedId: id });
      return id;
    },

    applyLayout(dimensions) {
      const graph = get().graph;
      if (!graph || Object.keys(graph.nodes).length === 0) return false;

      const positions = computeLayout(graph.nodes, { dimensions });
      // 已经是整齐的就别白占一条撤销记录
      if (isSameLayout(graph.nodes, positions)) return false;

      commit(
        (nodes) => {
          for (const [id, position] of Object.entries(positions)) {
            const node = nodes[id];
            if (node) nodes[id] = { ...node, position };
          }
        },
        { label: '整理布局' },
      );
      return true;
    },

    /** 返回 null 表示成功，否则返回拒绝原因 */
    linkNodes(from, to) {
      const graph = get().graph;
      if (!graph || !graph.nodes[from] || !graph.nodes[to]) return '节点不存在';
      if (graph.nodes[to]!.parentIds.includes(from)) return '这条连线已经存在了';
      if (wouldCreateCycle(graph.nodes, from, to)) return '不能连成环 —— 上下文没法拓扑排序';
      commit(
        (nodes) => {
          const node = nodes[to]!;
          nodes[to] = { ...node, parentIds: [...node.parentIds, from], updatedAt: now() };
        },
        { label: '连接节点' },
      );
      return null;
    },

    unlinkNodes(from, to) {
      commit(
        (nodes) => {
          const node = nodes[to];
          if (!node) return;
          nodes[to] = {
            ...node,
            parentIds: node.parentIds.filter((p) => p !== from),
            updatedAt: now(),
          };
        },
        { label: '断开连接' },
      );
    },

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
      controllers.get(nodeId)?.abort();
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
});

export const newProfile = (): Profile => ({
  id: uid(),
  name: '新配置',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
});

// 关标签页前把没落盘的改动冲掉
window.addEventListener('beforeunload', () => saver.flush());
