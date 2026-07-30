import type { StoreApi } from 'zustand';
import type { Attachment, ChatNode, Graph, KnowledgeChunk, Settings } from '../types';
import { migrateContextMode, type NodeMap } from '../lib/context';
import { DEFAULT_EMBEDDING } from '../lib/embeddings';
import { blobToDataUrl, type ResolvedAttachment } from '../lib/attachments';
import { emptyHistory, record, redo as redoStep, undo as undoStep } from '../lib/history';
import * as db from '../lib/db';
import type { State } from './types';

/**
 * 各切片共用的那一层。
 *
 * 这里放两类东西：
 *
 * 1. **React 状态之外的可变状态** —— 在跑的请求、后台画布、各种缓存。
 *    它们每秒变几十次（流式输出每 33ms 一轮），放进 store 会把整棵组件树
 *    重渲染到卡死，所以留在模块作用域里。
 * 2. **所有切片都要用的写入原语** —— commit、撤销栈、落盘。
 *
 * 换句话说：切开的是代码，不是运行时。四个切片仍然共用同一份状态、
 * 同一个撤销栈、同一个防抖存盘器。
 */

// 别叫 Set / Get —— 那会盖掉全局的 Set<string>，类型位置上悄悄变成 store 的 setter
type SetState = StoreApi<State>['setState'];
type GetState = StoreApi<State>['getState'];

/** 新装的默认配置。真实 Key 只能由使用者自己填，任何情况下都不写进代码 */
export const DEFAULT_SETTINGS: Settings = {
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

export const uid = () => crypto.randomUUID();
export const now = () => Date.now();

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

export const controllers = new Map<string, RunningTask>();

/**
 * 已经切走、但还有生成在往里写的画布。
 *
 * 它们不在 `state.graph` 里，可内存中这一份才是最新的 —— 磁盘上那份落后
 * 一个防抖周期。切回去时必须优先拿这一份，否则刚生成的内容会被磁盘上的
 * 旧版本盖掉。
 */
export const detached = new Map<string, Graph>();

/**
 * 被撤销/重做作废掉的生成。
 *
 * abort() 是同步返回的，但 run() 里的 AbortError 分支要到之后的微任务才执行。
 * 那时它会把已经收到的部分内容 flush 回节点里 —— 正好盖掉刚刚还原出来的状态，
 * 撤销就被静默地取消了。所以要区分两种中止：
 *   - 用户按「停止」：保留已生成的部分（这是他想要的）
 *   - 撤销/重做：整个结果作废，一个字都不许写回去
 */
export const abandoned = new Set<string>();

export const saver = db.createDebouncedSaver();

/**
 * 当前画布的全部切块。
 *
 * 检索是拿查询向量和每一块算点积，必须全量在手。每次提问都从 IndexedDB
 * 重读几千条（每条还带 1024 个浮点数）纯属浪费，按画布缓存一份，
 * 增删文件或切画布时作废。
 */
let chunkCache: { graphId: string; chunks: KnowledgeChunk[] } | null = null;

export const invalidateChunks = () => {
  chunkCache = null;
};

export async function loadChunks(graphId: string): Promise<KnowledgeChunk[]> {
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
export const dataUrlCache = new Map<string, string>();

export async function resolveAttachment(att: Attachment): Promise<ResolvedAttachment> {
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

export function emptyGraph(): Graph {
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
export function sanitize(graph: Graph): Graph {
  const nodes: NodeMap = {};
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    nodes[id] = node.status === 'streaming' ? { ...node, status: 'idle' } : node;
  }
  return { ...graph, nodes: migrateContextMode(nodes) };
}

export interface CommitOptions {
  /** 操作名，撤销时回显给用户 */
  label?: string;
  /** 传 false 表示不入历史：流式输出每 33ms 一次，会瞬间淹没历史栈 */
  history?: boolean;
  /** 同 key 的连续操作合并成一条（连续打字、一次拖拽的每个 mousemove） */
  coalesceKey?: string;
}

export interface StoreCore {
  /** 所有对图的写操作都走这里：记历史 + 打时间戳 + 排队落盘 */
  commit: (mutate: (nodes: NodeMap) => void, options?: CommitOptions) => void;
  commitTo: (graphId: string, mutate: (nodes: NodeMap) => void) => void;
  resetHistory: () => void;
  undo: () => string | null;
  redo: () => string | null;
  hasRunning: (graphId: string) => boolean;
  leaveCurrentGraph: () => void;
  abandonRunning: () => void;
  abandonGraph: (graphId: string) => void;
  currentGraphs: () => Promise<Graph[]>;
  persistSettings: (settings: Settings) => void;
  afterGraphSwitch: () => Promise<void>;
  gcAttachments: (graph: Graph) => Promise<void>;
}

export function createCore(set: SetState, get: GetState): StoreCore {
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

  const commit: StoreCore['commit'] = (mutate, options = {}) => {
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
  const commitTo: StoreCore['commitTo'] = (graphId, mutate) => {
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
  const hasRunning: StoreCore['hasRunning'] = (graphId) =>
    [...controllers.values()].some((t) => t.graphId === graphId);

  /**
   * 收走这张画布里已经没有主人的附件。
   *
   * 只在撤销历史刚被丢掉时调 —— 删节点是可撤销的，节点会以原来的 id 回来，
   * 附件按 nodeId 挂着就自动接上了。可附件是二进制原件，删了不像节点那样
   * 还躺在撤销栈里。历史没了，才轮得到清。
   */
  const gcAttachments: StoreCore['gcAttachments'] = async (graph) => {
    const live = new Set(Object.keys(graph.nodes));
    const removed = await db.gcAttachments(graph.id, live);
    if (removed) void get().refreshAttachments();
  };

  /**
   * 离开当前画布前的收尾。
   *
   * 上面还有生成在跑就把它挂进 detached —— 生成不因为切画布而中断，
   * 但它得有个地方可写。历史是会话状态，跟着当前画布走，一律清掉。
   */
  const leaveCurrentGraph: StoreCore['leaveCurrentGraph'] = () => {
    saver.flush();
    const graph = get().graph;
    if (graph && hasRunning(graph.id)) detached.set(graph.id, graph);
    resetHistory();
    if (graph) void gcAttachments(graph);
  };

  /** 掐掉所有在跑的生成，并标记为作废——它们的结果不该写回还原后的状态 */
  const abandonRunning: StoreCore['abandonRunning'] = () => {
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
  const abandonGraph: StoreCore['abandonGraph'] = (graphId) => {
    for (const [nodeId, task] of controllers) {
      if (task.graphId !== graphId) continue;
      abandoned.add(nodeId);
      task.controller.abort();
    }
    detached.delete(graphId);
  };

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
  const currentGraphs: StoreCore['currentGraphs'] = async () => {
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

  /** 撤销和重做只换 nodes，不动画布 id/标题，也不记新历史 */
  const applyStep = (step: ReturnType<typeof undoStep<NodeMap>>): string | null => {
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

  const persistSettings: StoreCore['persistSettings'] = (settings) => {
    set({ settings });
    void db.saveSettings(settings);
  };

  /** 换画布之后：知识库和附件都归属画布，缓存和列表都得跟着换 */
  const afterGraphSwitch: StoreCore['afterGraphSwitch'] = async () => {
    invalidateChunks();
    dataUrlCache.clear();
    await get().refreshKnowledge();
    await get().refreshAttachments();
  };

  return {
    commit,
    commitTo,
    resetHistory,
    undo: () => {
      abandonRunning();
      return applyStep(undoStep(history, get().graph?.nodes ?? {}));
    },
    redo: () => {
      abandonRunning();
      return applyStep(redoStep(history, get().graph?.nodes ?? {}));
    },
    hasRunning,
    leaveCurrentGraph,
    abandonRunning,
    abandonGraph,
    currentGraphs,
    persistSettings,
    afterGraphSwitch,
    gcAttachments,
  };
}
