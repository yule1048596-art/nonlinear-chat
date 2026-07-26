import { openDB, type IDBPDatabase } from 'idb';
import type { Graph, GraphMeta, KnowledgeChunk, KnowledgeFile, Settings } from '../types';
import { toMeta, type Snapshot, type SnapshotMeta } from './snapshots';

const DB_NAME = 'nonlinear-chat';
/** v2 加了 snapshots 表，v3 加了知识库两张表。升级只新建表，不动既有数据 */
const DB_VERSION = 3;
const GRAPHS = 'graphs';
const KV = 'kv';
const SNAPSHOTS = 'snapshots';
const KNOWLEDGE_FILES = 'knowledgeFiles';
const KNOWLEDGE_CHUNKS = 'knowledgeChunks';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    // upgrade 对每个跨越的版本都会跑，所以逐个 contains 判断即可，
    // 老库（v1/v2）升上来时只会补建缺失的表
    upgrade(database) {
      if (!database.objectStoreNames.contains(GRAPHS)) {
        const store = database.createObjectStore(GRAPHS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!database.objectStoreNames.contains(KV)) {
        database.createObjectStore(KV);
      }
      if (!database.objectStoreNames.contains(SNAPSHOTS)) {
        const store = database.createObjectStore(SNAPSHOTS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains(KNOWLEDGE_FILES)) {
        const store = database.createObjectStore(KNOWLEDGE_FILES, { keyPath: 'id' });
        store.createIndex('graphId', 'graphId');
      }
      if (!database.objectStoreNames.contains(KNOWLEDGE_CHUNKS)) {
        const store = database.createObjectStore(KNOWLEDGE_CHUNKS, { keyPath: 'id' });
        store.createIndex('graphId', 'graphId');
        store.createIndex('fileId', 'fileId');
      }
    },
  });
  return dbPromise;
}

export async function loadGraph(id: string): Promise<Graph | undefined> {
  return (await db()).get(GRAPHS, id);
}

export async function saveGraph(graph: Graph): Promise<void> {
  await (await db()).put(GRAPHS, graph);
}

export async function deleteGraph(id: string): Promise<void> {
  await (await db()).delete(GRAPHS, id);
  // 知识库挂在画布上，画布没了它就是无主数据，不清会一直占着空间
  await deleteKnowledgeForGraph(id);
}

export async function listGraphs(): Promise<GraphMeta[]> {
  const all: Graph[] = await (await db()).getAll(GRAPHS);
  return all
    .map((g) => ({
      id: g.id,
      title: g.title,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      nodeCount: Object.keys(g.nodes ?? {}).length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSettings(): Promise<Settings | undefined> {
  return (await db()).get(KV, 'settings');
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await db()).put(KV, settings, 'settings');
}

export async function loadLastGraphId(): Promise<string | undefined> {
  return (await db()).get(KV, 'lastGraphId');
}

export async function saveLastGraphId(id: string): Promise<void> {
  await (await db()).put(KV, id, 'lastGraphId');
}

/* ---------- 快照 ---------- */

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  await (await db()).put(SNAPSHOTS, snapshot);
}

/**
 * 列出快照的摘要信息。
 *
 * IndexedDB 没法只取部分字段，所以这里确实把整份读了出来再降维。
 * 上限是 10 份，个人使用量级下可以接受；真到了几十 MB 再拆成
 * meta / payload 两张表也不迟。
 */
export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const all: Snapshot[] = await (await db()).getAll(SNAPSHOTS);
  return all.map(toMeta).sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadSnapshot(id: string): Promise<Snapshot | undefined> {
  return (await db()).get(SNAPSHOTS, id);
}

export async function deleteSnapshot(id: string): Promise<void> {
  await (await db()).delete(SNAPSHOTS, id);
}

/* ---------- 知识库 ---------- */

export async function listKnowledgeFiles(graphId: string): Promise<KnowledgeFile[]> {
  const all: KnowledgeFile[] = await (await db()).getAllFromIndex(KNOWLEDGE_FILES, 'graphId', graphId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveKnowledgeFile(file: KnowledgeFile): Promise<void> {
  await (await db()).put(KNOWLEDGE_FILES, file);
}

/**
 * 批量写入切块。一个事务写完 —— 中途失败时不会留下「文件记录说有 300 块、
 * 实际只存进去 120 块」这种检索结果莫名其妙残缺的状态。
 */
export async function saveKnowledgeChunks(chunks: KnowledgeChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const database = await db();
  const tx = database.transaction(KNOWLEDGE_CHUNKS, 'readwrite');
  for (const chunk of chunks) void tx.store.put(chunk);
  await tx.done;
}

/** 读出一个画布的全部切块。检索时全量载入内存算点积，个人量级下够快 */
export async function loadKnowledgeChunks(graphId: string): Promise<KnowledgeChunk[]> {
  return (await db()).getAllFromIndex(KNOWLEDGE_CHUNKS, 'graphId', graphId);
}

/** 删文件连带删它的块。分两个事务，块先删 —— 中断了也只是留个空文件记录，不会留下无主的块 */
export async function deleteKnowledgeFile(fileId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(KNOWLEDGE_CHUNKS, 'readwrite');
  for (const key of await tx.store.index('fileId').getAllKeys(fileId)) void tx.store.delete(key);
  await tx.done;
  await database.delete(KNOWLEDGE_FILES, fileId);
}

export async function deleteKnowledgeForGraph(graphId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction([KNOWLEDGE_FILES, KNOWLEDGE_CHUNKS], 'readwrite');
  const files = tx.objectStore(KNOWLEDGE_FILES);
  const chunks = tx.objectStore(KNOWLEDGE_CHUNKS);
  for (const key of await files.index('graphId').getAllKeys(graphId)) void files.delete(key);
  for (const key of await chunks.index('graphId').getAllKeys(graphId)) void chunks.delete(key);
  await tx.done;
}

/** 整份替换所有画布，用于回滚。单个事务，中途失败不会留下半套数据 */
export async function replaceAllGraphs(graphs: Graph[]): Promise<void> {
  const database = await db();
  const tx = database.transaction(GRAPHS, 'readwrite');
  await tx.store.clear();
  for (const graph of graphs) await tx.store.put(graph);
  await tx.done;
}

export async function loadAllGraphs(): Promise<Graph[]> {
  return (await db()).getAll(GRAPHS);
}

export interface DebouncedSaver {
  queue: (graph: Graph) => void;
  flush: () => void;
  /** 丢弃指定画布的待写入。删除画布前必须调，否则定时器一到又把它写回去 */
  discard: (graphId: string) => void;
}

/**
 * 带 maxWait 的防抖：流式输出时 token 一直在来，纯防抖会永远不落盘，
 * 所以最多攒 maxWait 毫秒就强制存一次。
 *
 * write 可注入纯粹是为了能单测——防抖时序出错会静默丢数据或复活已删数据，
 * 是必须测得动的那类逻辑。
 */
export function createDebouncedSaver(
  wait = 600,
  maxWait = 3000,
  write: (graph: Graph) => void = (graph) => void saveGraph(graph),
): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstQueuedAt = 0;
  let pending: Graph | null = null;

  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    firstQueuedAt = 0;
  };

  const flush = () => {
    cancelTimer();
    if (pending) {
      const graph = pending;
      pending = null;
      write(graph);
    }
  };

  return {
    queue(graph: Graph) {
      pending = graph;
      const now = Date.now();
      if (!firstQueuedAt) firstQueuedAt = now;
      if (now - firstQueuedAt >= maxWait) {
        flush();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, wait);
    },
    flush,
    discard(graphId) {
      if (pending?.id !== graphId) return;
      pending = null;
      cancelTimer();
    },
  };
}
