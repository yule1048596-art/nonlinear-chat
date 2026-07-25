import { openDB, type IDBPDatabase } from 'idb';
import type { Graph, GraphMeta, Settings } from '../types';

const DB_NAME = 'nonlinear-chat';
const DB_VERSION = 1;
const GRAPHS = 'graphs';
const KV = 'kv';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(GRAPHS)) {
        const store = database.createObjectStore(GRAPHS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!database.objectStoreNames.contains(KV)) {
        database.createObjectStore(KV);
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
 * 带 maxWait 的防抖：流式输出时 token 一直在来，纯防抖会永远不落盘，
 * 所以最多攒 maxWait 毫秒就强制存一次。
 */
export function createDebouncedSaver(wait = 600, maxWait = 3000) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstQueuedAt = 0;
  let pending: Graph | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    firstQueuedAt = 0;
    if (pending) {
      const graph = pending;
      pending = null;
      void saveGraph(graph);
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
  };
}
