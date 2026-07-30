import { openDB, type IDBPDatabase } from 'idb';
import type { Attachment, Graph, GraphMeta, KnowledgeChunk, KnowledgeFile, Settings } from '../types';
import { toMeta, type Snapshot, type SnapshotMeta } from './snapshots';
import { orphanAttachmentIds } from './attachments';
import { DEMO_SEEDED_KEY } from './demo';

const DB_NAME = 'nonlinear-chat';
/** v2 加 snapshots，v3 加知识库两张表，v4 加附件表。升级只新建表，不动既有数据 */
const DB_VERSION = 4;
const GRAPHS = 'graphs';
const KV = 'kv';
const SNAPSHOTS = 'snapshots';
const KNOWLEDGE_FILES = 'knowledgeFiles';
const KNOWLEDGE_CHUNKS = 'knowledgeChunks';
const ATTACHMENTS = 'attachments';

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
      if (!database.objectStoreNames.contains(ATTACHMENTS)) {
        const store = database.createObjectStore(ATTACHMENTS, { keyPath: 'id' });
        store.createIndex('graphId', 'graphId');
        store.createIndex('nodeId', 'nodeId');
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
  // 知识库和附件都挂在画布上，画布没了它们就是无主数据，不清会一直占着空间
  await deleteKnowledgeForGraph(id);
  await deleteAttachmentsForGraph(id);
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

/**
 * 示例画布播过没有。
 *
 * 只看「库里有没有画布」是不够的：用户把示例删光、再把自己建的也删光，
 * 下次打开示例就又冒出来了 —— 一个删不掉的东西比一个没用的东西更烦人。
 */
export async function loadDemoSeeded(): Promise<boolean> {
  return (await (await db()).get(KV, DEMO_SEEDED_KEY)) === true;
}

export async function markDemoSeeded(): Promise<void> {
  await (await db()).put(KV, true, DEMO_SEEDED_KEY);
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

/* ---------- 附件 ---------- */

export async function saveAttachment(attachment: Attachment): Promise<void> {
  await (await db()).put(ATTACHMENTS, attachment);
}

/** 读出一个画布的全部附件。只在打开画布时读一次，之后靠 store 里的缓存 */
export async function listAttachments(graphId: string): Promise<Attachment[]> {
  const all: Attachment[] = await (await db()).getAllFromIndex(ATTACHMENTS, 'graphId', graphId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteAttachment(id: string): Promise<void> {
  await (await db()).delete(ATTACHMENTS, id);
}

/**
 * 清掉一张画布里没有主人的附件，返回删了几个。
 * 挑谁是孤儿的逻辑在 `orphanAttachmentIds`，那里说明了为什么不能删节点时就删。
 */
export async function gcAttachments(graphId: string, liveNodeIds: Set<string>): Promise<number> {
  const database = await db();
  const tx = database.transaction(ATTACHMENTS, 'readwrite');
  const orphans = orphanAttachmentIds(await tx.store.index('graphId').getAll(graphId), liveNodeIds);
  for (const id of orphans) void tx.store.delete(id);
  await tx.done;
  return orphans.length;
}

export async function deleteAttachmentsForGraph(graphId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(ATTACHMENTS, 'readwrite');
  for (const key of await tx.store.index('graphId').getAllKeys(graphId)) void tx.store.delete(key);
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

/* ---------- 完整备份用的全库读写 ---------- */

export async function loadAllAttachments(): Promise<Attachment[]> {
  return (await db()).getAll(ATTACHMENTS);
}

export async function loadAllKnowledgeFiles(): Promise<KnowledgeFile[]> {
  return (await db()).getAll(KNOWLEDGE_FILES);
}

export async function loadAllKnowledgeChunks(): Promise<KnowledgeChunk[]> {
  return (await db()).getAll(KNOWLEDGE_CHUNKS);
}

/**
 * 整份替换附件与知识库，用于恢复完整备份。
 *
 * 三张表放在**同一个事务**里：清空和写入必须一起成功。分开做的话，中途
 * 失败会留下「画布还在、附件已清空」这种状态 —— 而恢复备份本来就是
 * 用户手里没别的副本了才会做的事。
 */
export async function replaceAttachmentsAndKnowledge(
  attachments: Attachment[],
  files: KnowledgeFile[],
  chunks: KnowledgeChunk[],
): Promise<void> {
  const database = await db();
  const tx = database.transaction([ATTACHMENTS, KNOWLEDGE_FILES, KNOWLEDGE_CHUNKS], 'readwrite');
  const attStore = tx.objectStore(ATTACHMENTS);
  const fileStore = tx.objectStore(KNOWLEDGE_FILES);
  const chunkStore = tx.objectStore(KNOWLEDGE_CHUNKS);
  await Promise.all([attStore.clear(), fileStore.clear(), chunkStore.clear()]);
  for (const a of attachments) void attStore.put(a);
  for (const f of files) void fileStore.put(f);
  for (const c of chunks) void chunkStore.put(c);
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
 * **待写入按画布 id 分槽。** 从前只有一个 pending 槽，够用是因为「同时只写
 * 一个画布」这个假设成立；等到生成任务能在切走画布后继续写回原画布，
 * 两个画布就会交替排队，后一个直接把前一个顶掉 —— 丢的是已经生成出来的
 * 回答，而且悄无声息。
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
  const pending = new Map<string, Graph>();

  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    firstQueuedAt = 0;
  };

  const flush = () => {
    cancelTimer();
    if (!pending.size) return;
    const graphs = [...pending.values()];
    pending.clear();
    for (const graph of graphs) write(graph);
  };

  return {
    queue(graph: Graph) {
      pending.set(graph.id, graph);
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
      if (!pending.delete(graphId)) return;
      // 还有别的画布等着写就别把定时器一起掐了
      if (!pending.size) cancelTimer();
    },
  };
}
