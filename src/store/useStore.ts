import { create } from 'zustand';
import type {
  Attachment,
  ChatMessage,
  ChatNode,
  EmbeddingSettings,
  Graph,
  GraphMeta,
  KnowledgeChunk,
  KnowledgeFile,
  NodeRole,
  Profile,
  Settings,
} from '../types';
import {
  buildContext,
  collectAncestors,
  collectDescendants,
  migrateContextMode,
  wouldCreateCycle,
  type NodeMap,
} from '../lib/context';
import { DEFAULT_EMBEDDING, EmbeddingError, embedOne, type EmbeddingConfig } from '../lib/embeddings';
import { isLocalUrl } from '../lib/endpoint';
import {
  blobToDataUrl,
  contentToText,
  detectAttachmentKind,
  formatBytes,
  MAX_IMAGE_BYTES,
  type ResolvedAttachment,
} from '../lib/attachments';
import { indexFile } from '../lib/indexer';
import { parseFile } from '../lib/parsers';
import { retrieve, type RetrievedChunk } from '../lib/knowledge';
import { loadViewMode, saveViewMode, type ViewMode } from '../lib/view';
import { demoGraph } from '../lib/demo';
import { emptyHistory, record, redo as redoStep, undo as undoStep, type StepResult } from '../lib/history';
import { LlmError, streamChat } from '../lib/llm';
import { placeChild, placeSibling } from '../lib/layout';
import { computeLayout, isSameLayout } from '../lib/autoLayout';
import {
  buildSignature,
  pruneIds,
  shouldSnapshot,
  type Snapshot,
  type SnapshotMeta,
  type SnapshotReason,
} from '../lib/snapshots';
import {
  buildFullBackup,
  buildSettingsBackup,
  mergeProfiles,
  type FullBackup,
  type SettingsBackup,
} from '../lib/backup';
import {
  buildArchive,
  countPayload,
  type ArchiveCounts,
  type ArchiveManifest,
  type ParsedArchive,
} from '../lib/archive';
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
  embedding: { ...DEFAULT_EMBEDDING, topK: 5 },
};

const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = { ...DEFAULT_EMBEDDING, topK: 5 };

const uid = () => crypto.randomUUID();
const now = () => Date.now();

/**
 * 正在跑的请求，放在 React 状态外面，避免每个 token 都触发无谓的重渲染。
 *
 * 带着 graphId 是因为生成不随画布切换而中断：人切走去别的画布看点东西，
 * 回来时答案应该已经生成好了。写回时要认准当初那张画布，不能写进眼前这张。
 */
interface RunningTask {
  controller: AbortController;
  graphId: string;
}

const controllers = new Map<string, RunningTask>();

/**
 * 已经切走、但还有生成在往里写的画布。
 *
 * 它们不在 `state.graph` 里，可内存中这一份才是最新的 —— 磁盘上那份落后
 * 一个防抖周期。切回去时必须优先拿这一份，否则刚生成的内容会被磁盘上的
 * 旧版本盖掉。
 */
const detached = new Map<string, Graph>();

/**
 * 被撤销/重做作废掉的生成。
 *
 * abort() 是同步返回的，但 run() 里的 AbortError 分支要到之后的微任务才执行。
 * 那时它会把已经收到的部分内容 flush 回节点里 —— 正好盖掉刚刚还原出来的状态，
 * 撤销就被静默地取消了。所以要区分两种中止：
 *   - 用户按「停止」：保留已生成的部分（这是他想要的）
 *   - 撤销/重做：整个结果作废，一个字都不许写回去
 */
const abandoned = new Set<string>();
const saver = db.createDebouncedSaver();

/**
 * 当前画布的全部切块。
 *
 * 检索是拿查询向量和每一块算点积，必须全量在手。每次提问都从 IndexedDB
 * 重读几千条（每条还带 1024 个浮点数）纯属浪费，按画布缓存一份，
 * 增删文件或切画布时作废。
 */
let chunkCache: { graphId: string; chunks: KnowledgeChunk[] } | null = null;
const invalidateChunks = () => {
  chunkCache = null;
};

async function loadChunks(graphId: string): Promise<KnowledgeChunk[]> {
  if (chunkCache?.graphId === graphId) return chunkCache.chunks;
  const chunks = await db.loadKnowledgeChunks(graphId);
  chunkCache = { graphId, chunks };
  return chunks;
}

/**
 * 附件转成 data URI 之后缓存起来。
 *
 * 二进制在 IndexedDB 里是原样的 Blob，只有发请求那一刻才需要 base64。
 * 同一张图在一条链上可能被多轮对话反复带上，每次重编码是白费力气。
 */
const dataUrlCache = new Map<string, string>();

async function resolveAttachment(att: Attachment): Promise<ResolvedAttachment> {
  if (att.kind === 'text') {
    return { id: att.id, name: att.name, kind: 'text', text: att.text };
  }
  let dataUrl = dataUrlCache.get(att.id);
  if (!dataUrl) {
    dataUrl = await blobToDataUrl(att.blob);
    dataUrlCache.set(att.id, dataUrl);
  }
  return { id: att.id, name: att.name, kind: 'image', dataUrl };
}

/** 检索用的查询词就是这次真正要问的那句话 */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return contentToText(messages[i]!.content);
  }
  return '';
}

function describeError(err: unknown): string {
  if (err instanceof EmbeddingError) {
    return err.hint ? `${err.message}\n\n${err.hint}` : err.message;
  }
  return (err as Error)?.message ?? String(err);
}

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

/**
 * 加载画布时的清洗：
 * - 页面在流式输出中途被关掉，状态会卡在 streaming，统一洗成 idle
 * - 旧数据的 includeInContext 迁移成 contextMode
 */
function sanitize(graph: Graph): Graph {
  const nodes: NodeMap = {};
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    nodes[id] = node.status === 'streaming' ? { ...node, status: 'idle' } : node;
  }
  return { ...graph, nodes: migrateContextMode(nodes) };
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

  /** 画布视图模式。纯视图偏好，存 localStorage，不进画布数据 */
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  select: (id: string | null) => void;
  /** 正在对比的节点。放 store 而非 node.data，否则会破坏 Canvas 的节点对象缓存 */
  compareNodeId: string | null;
  setCompare: (id: string | null) => void;
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

  snapshots: SnapshotMeta[];
  /** 打一个快照。返回是否真的存了（自动快照在内容没变时会跳过） */
  takeSnapshot: (reason?: SnapshotReason) => Promise<boolean>;
  refreshSnapshots: () => Promise<void>;
  /** 整份回滚到某个快照。回滚本身也会先打一个「恢复前」的点 */
  restoreSnapshot: (snapshotId: string) => Promise<boolean>;
  /** 只从快照里捞回一个画布，不动其他数据 */
  restoreGraphFromSnapshot: (snapshotId: string, graphId: string) => Promise<boolean>;
  removeSnapshot: (snapshotId: string) => Promise<void>;

  /** 打包全部数据用于导出。includeKeys 默认关，导出文件常被到处传 */
  exportSettings: (includeKeys: boolean) => SettingsBackup;
  exportEverything: (includeKeys: boolean) => Promise<FullBackup>;
  /** 完整备份包（.nexus.zip）：画布、设置、附件原件、知识库与向量 */
  exportArchive: (includeKeys: boolean) => Promise<{ blob: Blob; manifest: ArchiveManifest }>;
  /** 恢复完整备份包。整份替换，之前会自动打一个快照 */
  restoreArchive: (parsed: ParsedArchive) => Promise<ArchiveCounts>;
  /** 只合并模型配置，不碰本地已有的。返回加了几条、跳过几条 */
  importSettings: (backup: SettingsBackup) => { added: number; skipped: number };
  /** 整份恢复：替换所有画布和设置，恢复前自动打快照 */
  restoreBackup: (backup: FullBackup) => Promise<{ graphs: number }>;

  /** 当前画布的知识库。知识库归属画布，切画布就是另一套资料 */
  knowledgeFiles: KnowledgeFile[];
  /** 正在建索引的文件，null 表示空闲 */
  indexing: { name: string; phase: 'parse' | 'embed'; done: number; total: number } | null;
  refreshKnowledge: () => Promise<void>;
  /** 逐个建索引。返回成功数和失败明细 —— 一个文件坏了不该拖累其余的 */
  addKnowledgeFiles: (files: File[]) => Promise<{ ok: number; failed: { name: string; error: string }[] }>;
  setKnowledgeEnabled: (fileId: string, enabled: boolean) => Promise<void>;
  removeKnowledgeFile: (fileId: string) => Promise<void>;
  /** 检索。失败会抛出，由调用方决定是报错还是忽略 */
  retrieveKnowledge: (query: string) => Promise<RetrievedChunk[]>;

  /** 当前画布的附件。二进制存在单独的表里，这里拿的是完整记录（含 Blob） */
  attachments: Attachment[];
  refreshAttachments: () => Promise<void>;
  /** 给某个节点挂附件。返回成功数和失败明细 —— 一个坏文件不该拖累其余的 */
  addAttachments: (
    nodeId: string,
    files: File[],
  ) => Promise<{ ok: number; failed: { name: string; error: string }[] }>;
  removeAttachment: (attachmentId: string) => Promise<void>;
  /** 把这些节点的附件解析成可发送的形式。预览面板和 run() 共用 */
  resolveAttachments: (nodeIds: Set<string>) => Promise<Map<string, ResolvedAttachment[]> | undefined>;

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

  /**
   * 往**指定画布**写。生成任务专用。
   *
   * 眼前这张就走正常的 commit；已经切走的那张改内存里的副本再排队落盘。
   * 两条路都不入历史 —— 流式每 33ms 一次，而且撤销栈是跟着当前画布走的，
   * 后台那张的历史早在切走时就清掉了。
   */
  const commitTo = (graphId: string, mutate: (nodes: NodeMap) => void) => {
    if (get().graph?.id === graphId) {
      commit(mutate, { history: false });
      return;
    }
    const graph = detached.get(graphId);
    if (!graph) return; // 画布已经删了，写了也没地方去
    const nodes = { ...graph.nodes };
    mutate(nodes);
    const next: Graph = { ...graph, nodes, updatedAt: now() };
    detached.set(graphId, next);
    saver.queue(next);
  };

  /** 一个画布上还有没有在跑的生成。没有了就不必再把它挂在 detached 里 */
  const hasRunning = (graphId: string) =>
    [...controllers.values()].some((t) => t.graphId === graphId);

  /**
   * 离开当前画布前的收尾。
   *
   * 上面还有生成在跑就把它挂进 detached —— 生成不因为切画布而中断，
   * 但它得有个地方可写。历史是会话状态，跟着当前画布走，一律清掉。
   */
  const leaveCurrentGraph = () => {
    saver.flush();
    const graph = get().graph;
    if (graph && hasRunning(graph.id)) detached.set(graph.id, graph);
    resetHistory();
    if (graph) void gcAttachments(graph);
  };

  /**
   * 收走这张画布里已经没有主人的附件。
   *
   * 只在撤销历史刚被丢掉时调 —— 删节点是可撤销的，节点会以原来的 id 回来，
   * 附件按 nodeId 挂着就自动接上了。可附件是二进制原件，删了不像节点那样
   * 还躺在撤销栈里。历史没了，才轮得到清。
   */
  const gcAttachments = async (graph: Graph) => {
    const live = new Set(Object.keys(graph.nodes));
    const removed = await db.gcAttachments(graph.id, live);
    if (removed) void get().refreshAttachments();
  };

  /** 掐掉所有在跑的生成，并标记为作废——它们的结果不该写回还原后的状态 */
  const abandonRunning = () => {
    for (const [id, task] of controllers) {
      abandoned.add(id);
      task.controller.abort();
    }
  };

  /**
   * 掐掉某一张画布上的生成并作废。
   *
   * 画布要被删掉或整份换掉时必须先做这个：不掐的话它还会继续往 detached
   * 里写、继续排队落盘，于是被删/被换掉的内容被它自己的生成一路写回来。
   */
  /**
   * 拿到「此刻全部画布」的可信版本，用于导出和快照。
   *
   * 不能只 `saver.flush()` 然后从磁盘读：flush 里的写入是不等待的
   * （`void saveGraph(...)`），读写谁先落地全靠 IndexedDB 恰好按事务创建
   * 顺序串行 —— 在 saveGraph 里多加一个 await 就会静默错位，而错位的表现
   * 是导出文件里少了用户眼前刚打的那句话。
   *
   * 内存里那份本来就是权威版本，直接盖上去，竞态就不存在了。
   */
  const currentGraphs = async (): Promise<Graph[]> => {
    saver.flush();
    const onDisk = await db.loadAllGraphs();
    const live = new Map<string, Graph>(detached);
    const active = get().graph;
    if (active) live.set(active.id, active);
    const merged = onDisk.map((g) => live.get(g.id) ?? g);
    // 刚建出来还没落盘的画布，磁盘上根本没有，补进去
    for (const [id, graph] of live) if (!onDisk.some((g) => g.id === id)) merged.push(graph);
    return merged;
  };

  const abandonGraph = (graphId: string) => {
    for (const [nodeId, task] of controllers) {
      if (task.graphId !== graphId) continue;
      abandoned.add(nodeId);
      task.controller.abort();
    }
    detached.delete(graphId);
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

  /** 换画布之后：知识库和附件都归属画布，缓存和列表都得跟着换 */
  const afterGraphSwitch = async () => {
    invalidateChunks();
    dataUrlCache.clear();
    await get().refreshKnowledge();
    await get().refreshAttachments();
  };

  /** 把这条链上用到的附件解析成可直接发送的形式 */
  const resolveAttachmentsFor = async (nodeIds: Set<string>) => {
    const list = get().attachments.filter((a) => nodeIds.has(a.nodeId));
    if (!list.length) return undefined;
    const map = new Map<string, ResolvedAttachment[]>();
    for (const att of list) {
      const resolved = await resolveAttachment(att);
      const bucket = map.get(att.nodeId);
      if (bucket) bucket.push(resolved);
      else map.set(att.nodeId, [resolved]);
    }
    return map;
  };

  const embeddingConfig = (): EmbeddingConfig => {
    const e = get().settings.embedding ?? DEFAULT_EMBEDDING_SETTINGS;
    return { baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model };
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
    const attachments = await resolveAttachmentsFor(
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
              error: `知识库检索失败，这次提问没有发出去。\n\n${describeError(err)}\n\n也可以在知识库面板里把文件停用，先不带资料提问。`,
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
    graph: null,
    graphs: [],
    snapshots: [],
    settings: DEFAULT_SETTINGS,
    selectedId: null,
    compareNodeId: null,
    ready: false,
    canUndo: false,
    canRedo: false,

    undo() {
      abandonRunning();
      return applyStep(undoStep(history, get().graph?.nodes ?? {}));
    },

    redo() {
      abandonRunning();
      return applyStep(redoStep(history, get().graph?.nodes ?? {}));
    },

    async init() {
      const [settings, lastId, graphs, demoSeeded] = await Promise.all([
        db.loadSettings(),
        db.loadLastGraphId(),
        db.listGraphs(),
        db.loadDemoSeeded(),
      ]);
      // 老版本存的设置可能缺字段，跟默认值合一次
      const merged: Settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
      if (!merged.profiles?.length) merged.profiles = DEFAULT_SETTINGS.profiles;

      resetHistory();
      let graph = lastId ? await db.loadGraph(lastId) : undefined;
      if (!graph && graphs.length) graph = await db.loadGraph(graphs[0]!.id);
      if (!graph) {
        /*
         * 真正的头一次：给一张预填好的示例画布，而不是一张空的。
         *
         * 这个应用最值钱的是「两条分支汇进同一个提问」，可它要发三四轮、
         * 再手动拖一条边才看得见 —— 而且得先去申请一个 API Key。
         * 于是最该被看到的东西恰好落在漏斗最深处。示例画布不需要 Key
         * 就能读、能选中看上下文高亮。
         *
         * 只在**从没播过**时给。删光了再打开又冒出来的话，它就成了
         * 一个删不掉的东西 —— 比一个没用的东西更烦人。
         */
        graph = demoSeeded ? emptyGraph() : demoGraph(uid, now());
        await db.saveGraph(graph);
        if (!demoSeeded) await db.markDemoSeeded();
      }
      graph = sanitize(graph);

      await db.saveLastGraphId(graph.id);
      set({ settings: merged, graph, graphs: await db.listGraphs(), ready: true });
      await afterGraphSwitch();
      // 上一次会话里删掉的节点，撤销栈已经随页面一起没了，附件可以收了
      void gcAttachments(graph);
    },

    async refreshGraphList() {
      set({ graphs: await db.listGraphs() });
    },

    async newGraph() {
      leaveCurrentGraph();
      const graph = emptyGraph();
      await db.saveGraph(graph);
      await db.saveLastGraphId(graph.id);
      set({ graph, selectedId: null, graphs: await db.listGraphs() });
      await afterGraphSwitch();
    },

    async openGraph(id) {
      /*
       * 后台那份优先于磁盘那份。
       *
       * 切走时如果还有生成在跑，内存里的副本一直在被写，而磁盘落后一个
       * 防抖周期 —— 从磁盘读就会把刚生成出来的几百个字盖掉。
       */
      const live = detached.get(id);
      const graph = live ?? (await db.loadGraph(id));
      if (!graph) return;
      leaveCurrentGraph();
      await db.saveLastGraphId(id);
      /*
       * 后台那份不能过 sanitize：它把 streaming 洗成 idle，是为了收拾
       * 「流式输出中途关了页面」留下的残状态。可这里的 streaming 是真在跑，
       * 洗掉就成了「转圈突然停了、下一次 flush 又转起来」。
       */
      set({ graph: live ?? sanitize(graph), selectedId: null });
      await afterGraphSwitch();
    },

    async removeGraph(id) {
      // 删之前留一个回滚点
      await get().takeSnapshot('删除画布前');
      abandonGraph(id); // 画布都要删了，上面在跑的生成必须先掐掉并作废
      // 必须先丢弃待写入：防抖存盘里可能还压着这个画布，删完定时器一到
      // 又会把它写回去，用户看到的就是「删了又自己回来了」
      saver.discard(id);
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
      await get().takeSnapshot('导入前');
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
          /*
           * 附件引用必须清掉。附件的二进制从来不在导出文件里，而且这里连
           * 节点 id 都重新映射过 —— 留着就是一串指向不存在文件的悬空 id。
           * 更要命的是「有附件就不算空节点」那条判断会认下它，
           * 于是一个空正文的节点会被当成有内容，发出一条 content 为空的消息。
           */
          attachmentIds: undefined,
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
      await afterGraphSwitch();
    },

    viewMode: loadViewMode(),

    setViewMode(mode) {
      if (get().viewMode === mode) return;
      saveViewMode(mode);
      set({ viewMode: mode });
    },

    select(id) {
      set({ selectedId: id });
    },

    setCompare(id) {
      set({ compareNodeId: id });
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
      for (const victim of doomed) controllers.get(victim)?.controller.abort();

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

    exportSettings(includeKeys) {
      return buildSettingsBackup(get().settings, includeKeys);
    },

    async exportEverything(includeKeys) {
      return buildFullBackup(get().settings, await currentGraphs(), includeKeys);
    },

    async exportArchive(includeKeys) {
      const [graphs, attachments, knowledgeFiles, knowledgeChunks] = await Promise.all([
        currentGraphs(),
        db.loadAllAttachments(),
        db.loadAllKnowledgeFiles(),
        db.loadAllKnowledgeChunks(),
      ]);
      return buildArchive(
        { settings: get().settings, graphs, attachments, knowledgeFiles, knowledgeChunks },
        includeKeys,
      );
    },

    async restoreArchive(parsed) {
      await get().takeSnapshot('导入前');
      // 所有画布都要被换掉，在跑的生成一律作废，否则它们会往新数据上写
      abandonRunning();
      detached.clear();
      saver.flush();

      const { payload } = parsed;
      await db.replaceAllGraphs(payload.graphs);
      await db.replaceAttachmentsAndKnowledge(
        payload.attachments,
        payload.knowledgeFiles,
        payload.knowledgeChunks,
      );
      await db.saveSettings(payload.settings);
      resetHistory();
      invalidateChunks();
      dataUrlCache.clear();

      const first = payload.graphs[0];
      if (first) await db.saveLastGraphId(first.id);

      set({
        settings: payload.settings,
        graph: first ? sanitize(first) : emptyGraph(),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return countPayload(payload);
    },

    importSettings(backup) {
      const current = get().settings;
      const { profiles, added, skipped } = mergeProfiles(
        current.profiles,
        backup.settings.profiles ?? [],
        uid,
      );
      /*
       * 只并配置，不导入 systemPrompt / contextLimit —— 那两个是本机偏好，
       * 而「导入设置」的语义是拿到别处的模型配置，不是拿别人的状态盖掉自己的。
       * 要整体覆盖请用完整备份恢复，那条路径会先打快照。
       */
      persistSettings({ ...current, profiles });
      return { added, skipped };
    },

    async restoreBackup(backup) {
      await get().takeSnapshot('导入前');
      saver.flush();

      await db.replaceAllGraphs(backup.graphs);
      await db.saveSettings(backup.settings);
      resetHistory();

      const first = backup.graphs[0];
      if (first) await db.saveLastGraphId(first.id);

      set({
        settings: backup.settings,
        graph: first ? sanitize(first) : emptyGraph(),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return { graphs: backup.graphs.length };
    },

    async takeSnapshot(reason = '自动') {
      // 内存里那份才是用户眼前的版本，磁盘上的可能落后一个防抖周期
      const [graphs, latestList] = await Promise.all([currentGraphs(), db.listSnapshots()]);
      const settings = get().settings;
      const signature = buildSignature(graphs, settings);

      const latest = latestList[0]
        ? { signature: (await db.loadSnapshot(latestList[0].id))?.signature ?? '', createdAt: latestList[0].createdAt }
        : undefined;

      if (!shouldSnapshot({ reason, signature, latest, now: now() })) return false;

      const snapshot: Snapshot = {
        id: uid(),
        createdAt: now(),
        reason,
        signature,
        graphs,
        settings,
      };
      await db.saveSnapshot(snapshot);

      // 存完再淘汰，保证任何时刻都至少有一份可用的快照
      const all = await db.listSnapshots();
      for (const id of pruneIds(all)) await db.deleteSnapshot(id);

      set({ snapshots: await db.listSnapshots() });
      return true;
    },

    async refreshSnapshots() {
      set({ snapshots: await db.listSnapshots() });
    },

    async restoreSnapshot(snapshotId) {
      const snapshot = await db.loadSnapshot(snapshotId);
      if (!snapshot) return false;

      // 回滚也是破坏性的：先给当前状态留一个回头路
      await get().takeSnapshot('恢复前');

      // 所有画布都要被换掉，后台还在跑的生成一律作废 —— 否则它们会把
      // 刚刚被替换掉的内容一路写回来，回滚就白做了
      abandonRunning();
      detached.clear();

      saver.flush();
      await db.replaceAllGraphs(snapshot.graphs);
      await db.saveSettings(snapshot.settings);

      resetHistory(); // 历史属于被替换掉的那份数据，留着会串台
      const first = snapshot.graphs[0];
      if (first) await db.saveLastGraphId(first.id);

      set({
        settings: snapshot.settings,
        graph: first ? sanitize(first) : emptyGraph(),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return true;
    },

    async restoreGraphFromSnapshot(snapshotId, graphId) {
      const snapshot = await db.loadSnapshot(snapshotId);
      const target = snapshot?.graphs.find((g) => g.id === graphId);
      if (!target) return false;

      await get().takeSnapshot('恢复前');
      abandonGraph(graphId); // 这一张要被整份换掉，它上面在跑的生成同样得作废
      saver.flush();
      await db.saveGraph(target);
      await db.saveLastGraphId(target.id);
      resetHistory();

      set({
        graph: sanitize(target),
        selectedId: null,
        graphs: await db.listGraphs(),
        snapshots: await db.listSnapshots(),
      });
      await afterGraphSwitch();
      return true;
    },

    async removeSnapshot(snapshotId) {
      await db.deleteSnapshot(snapshotId);
      set({ snapshots: await db.listSnapshots() });
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

    knowledgeFiles: [],
    indexing: null,

    async refreshKnowledge() {
      const graphId = get().graph?.id;
      set({ knowledgeFiles: graphId ? await db.listKnowledgeFiles(graphId) : [] });
    },

    async addKnowledgeFiles(files) {
      const graphId = get().graph?.id;
      if (!graphId) return { ok: 0, failed: [] };

      const config = embeddingConfig();
      const failed: { name: string; error: string }[] = [];
      let ok = 0;

      for (const source of files) {
        set({ indexing: { name: source.name, phase: 'parse', done: 0, total: 1 } });
        try {
          const { file, chunks } = await indexFile(source, graphId, config, {
            onProgress: (p) => set({ indexing: { name: source.name, ...p } }),
          });
          // 先写块再写文件记录：中途断了只会留下一批无主的块，而检索永远
          // 按文件记录过滤，读不到它们；反过来则会出现「有文件却检索不到内容」
          await db.saveKnowledgeChunks(chunks);
          await db.saveKnowledgeFile(file);
          invalidateChunks();
          ok++;
        } catch (err) {
          failed.push({ name: source.name, error: describeError(err) });
        }
      }

      set({ indexing: null });
      await get().refreshKnowledge();
      return { ok, failed };
    },

    async setKnowledgeEnabled(fileId, enabled) {
      const file = get().knowledgeFiles.find((f) => f.id === fileId);
      if (!file) return;
      await db.saveKnowledgeFile({ ...file, enabled });
      await get().refreshKnowledge();
    },

    async removeKnowledgeFile(fileId) {
      await db.deleteKnowledgeFile(fileId);
      invalidateChunks();
      await get().refreshKnowledge();
    },

    async retrieveKnowledge(query) {
      const graphId = get().graph?.id;
      if (!graphId || !query.trim()) return [];

      const files = get().knowledgeFiles.filter((f) => f.enabled && f.status === 'ready');
      if (!files.length) return [];

      const chunks = await loadChunks(graphId);
      if (!chunks.length) return [];

      const vector = await embedOne(embeddingConfig(), query);
      return retrieve(vector, chunks, {
        topK: get().settings.embedding?.topK ?? DEFAULT_EMBEDDING_SETTINGS.topK,
        // 只在启用的文件里找。顺带把没有文件记录的无主块挡在外面
        enabledFileIds: new Set(files.map((f) => f.id)),
        fileNames: new Map(files.map((f) => [f.id, f.name])),
      });
    },

    attachments: [],

    resolveAttachments: (nodeIds) => resolveAttachmentsFor(nodeIds),

    async refreshAttachments() {
      const graphId = get().graph?.id;
      set({ attachments: graphId ? await db.listAttachments(graphId) : [] });
    },

    async addAttachments(nodeId, files) {
      const graph = get().graph;
      if (!graph) return { ok: 0, failed: [] };

      const failed: { name: string; error: string }[] = [];
      const added: Attachment[] = [];

      for (const file of files) {
        const kind = detectAttachmentKind(file);
        if (!kind) {
          failed.push({ name: file.name, error: '不支持这个类型' });
          continue;
        }
        if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
          failed.push({
            name: file.name,
            error: `图片 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_IMAGE_BYTES)} 上限`,
          });
          continue;
        }
        try {
          let text: string | undefined;
          let warning: string | undefined;
          if (kind === 'text') {
            // 复用知识库那套解析器：txt/md/docx/epub 已经支持
            const parsed = await parseFile(file);
            if (!parsed.text.trim()) throw new Error('没有解析出可用的文字');
            text = parsed.text;
            warning = parsed.warnings.length ? parsed.warnings.join('；') : undefined;
          }
          const attachment: Attachment = {
            id: uid(),
            graphId: graph.id,
            nodeId,
            name: file.name,
            mime: file.type,
            size: file.size,
            kind,
            // File 本身就是 Blob，直接存，不转 base64
            blob: file,
            text,
            warning,
            createdAt: now(),
          };
          await db.saveAttachment(attachment);
          added.push(attachment);
        } catch (err) {
          failed.push({ name: file.name, error: (err as Error)?.message ?? String(err) });
        }
      }

      if (added.length) {
        commit(
          (nodes) => {
            const current = nodes[nodeId];
            if (!current) return;
            nodes[nodeId] = {
              ...current,
              attachmentIds: [...(current.attachmentIds ?? []), ...added.map((a) => a.id)],
              updatedAt: now(),
            };
          },
          { label: '添加附件' },
        );
        set({ attachments: [...get().attachments, ...added] });
      }
      return { ok: added.length, failed };
    },

    async removeAttachment(attachmentId) {
      const att = get().attachments.find((a) => a.id === attachmentId);
      await db.deleteAttachment(attachmentId);
      dataUrlCache.delete(attachmentId);

      if (att) {
        /*
         * 这一步刻意不进撤销历史：二进制已经删了，撤销只能把 id 放回节点上，
         * 指向一个不存在的文件。与其给一个撤了也回不来的承诺，不如不给。
         */
        commit(
          (nodes) => {
            const current = nodes[att.nodeId];
            if (!current) return;
            nodes[att.nodeId] = {
              ...current,
              attachmentIds: (current.attachmentIds ?? []).filter((id) => id !== attachmentId),
              updatedAt: now(),
            };
          },
          { history: false },
        );
      }
      set({ attachments: get().attachments.filter((a) => a.id !== attachmentId) });
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
