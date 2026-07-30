import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 端到端用例的共用装置。
 *
 * 种数据走的是「先让应用启动一次、再写 IndexedDB、然后刷新」这条路，
 * 而不是在 addInitScript 里自己建库 —— 建库要复制一遍 db.ts 里的 schema
 * （版本号、六张表、各自的索引），复制出来的那份迟早和真的对不上，
 * 到时候测试挂在一个和被测行为毫无关系的地方。让应用自己建，永远不会错。
 */

export const MOCK_BASE_URL = 'http://localhost:8787/v1';

/** 出片速度由模型名决定，见 scripts/mock-server.mjs */
export type MockModel = 'mock-fast' | 'mock-slow';

export interface SeedNode {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'note';
  content: string;
  parents?: string[];
  x?: number;
  y?: number;
}

export interface SeedGraph {
  id: string;
  title: string;
  nodes: SeedNode[];
}

export interface SeedAttachment {
  id: string;
  graphId: string;
  nodeId: string;
  name: string;
  text: string;
}

/** 知识库的一份资料，连同它的切块与向量 —— 备份往返要连向量一起对账 */
export interface SeedKnowledge {
  id: string;
  graphId: string;
  name: string;
  chunks: { id: string; text: string; embedding: number[] }[];
}

export interface Seed {
  graphs?: SeedGraph[];
  /** 打开哪一张。不传就是第一张 */
  openGraphId?: string;
  model?: MockModel;
  systemPrompt?: string;
  attachments?: SeedAttachment[];
  knowledge?: SeedKnowledge[];
  view?: 'edit' | 'map' | 'focus';
}

/**
 * 应用启动完成的标志：某个视图把内容画出来了，说明 init() 走完、
 * IndexedDB 也建好了。
 *
 * 三个视图各有各的节点长相（编辑是 React Flow 节点、聚焦是卡片牌堆），
 * 只认其中一个的话，换个视图种数据就会卡在这里 —— 而且报的是超时，
 * 和真正的失败原因隔着十万八千里。
 */
async function waitForApp(page: Page) {
  await page.waitForSelector('.react-flow__node, .focus-card, .focus-empty', { timeout: 15_000 });
}

/**
 * 把画布/设置/附件写进 IndexedDB，然后刷新让应用读到。
 *
 * 每条用例都从一个确定的状态开始 —— 上一条留下的画布、上一版的示例画布、
 * 甚至 demoSeeded 标记，都会让断言变成猜谜。
 */
export async function seedApp(page: Page, seed: Seed = {}) {
  await page.goto('/');
  await waitForApp(page);

  await page.evaluate(async (s: Seed) => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('nonlinear-chat');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

    const now = Date.now();
    const graphs = (s.graphs ?? []).map((g, gi) => ({
      id: g.id,
      title: g.title,
      createdAt: now,
      updatedAt: now + gi,
      nodes: Object.fromEntries(
        g.nodes.map((n, i) => [
          n.id,
          {
            id: n.id,
            role: n.role,
            content: n.content,
            parentIds: n.parents ?? [],
            position: { x: n.x ?? 0, y: n.y ?? i * 220 },
            createdAt: now + i,
            updatedAt: now + i,
          },
        ]),
      ),
    }));

    const settings = {
      profiles: [
        {
          id: 'mock',
          name: 'Mock',
          baseUrl: 'http://localhost:8787/v1',
          apiKey: '',
          model: s.model ?? 'mock-fast',
          temperature: 0.7,
        },
      ],
      activeProfileId: 'mock',
      systemPrompt: s.systemPrompt ?? '',
      contextLimit: 0,
    };

    const stores = ['graphs', 'attachments', 'knowledgeFiles', 'knowledgeChunks', 'snapshots'];
    await new Promise<void>((res, rej) => {
      const tx = db.transaction([...stores, 'kv'], 'readwrite');
      for (const name of stores) tx.objectStore(name).clear();

      const gs = tx.objectStore('graphs');
      for (const g of graphs) gs.put(g);

      const as = tx.objectStore('attachments');
      for (const a of s.attachments ?? []) {
        const bytes = new TextEncoder().encode(a.text);
        as.put({
          id: a.id,
          graphId: a.graphId,
          nodeId: a.nodeId,
          name: a.name,
          mime: 'text/plain',
          size: bytes.byteLength,
          kind: 'text',
          blob: new Blob([bytes], { type: 'text/plain' }),
          text: a.text,
          createdAt: Date.now(),
        });
      }

      const kfs = tx.objectStore('knowledgeFiles');
      const kcs = tx.objectStore('knowledgeChunks');
      for (const k of s.knowledge ?? []) {
        kfs.put({
          id: k.id,
          graphId: k.graphId,
          name: k.name,
          kind: 'text',
          size: 100,
          charCount: k.chunks.reduce((n, c) => n + c.text.length, 0),
          chunkCount: k.chunks.length,
          enabled: true,
          status: 'ready',
          createdAt: Date.now(),
        });
        k.chunks.forEach((c, i) => {
          kcs.put({
            id: c.id,
            graphId: k.graphId,
            fileId: k.id,
            index: i,
            text: c.text,
            embedding: new Float32Array(c.embedding),
          });
        });
      }

      const kv = tx.objectStore('kv');
      kv.put(settings, 'settings');
      // 示例画布只在空库时才播；这里明确标记已播过，免得它挤进断言
      kv.put(true, 'demoSeeded');
      const open = s.openGraphId ?? graphs[0]?.id;
      if (open) kv.put(open, 'lastGraphId');
      else kv.delete('lastGraphId');

      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    localStorage.setItem('nexus-view', s.view ?? 'edit');
  }, seed);

  await page.reload();
  await waitForApp(page);
}

/** 读回 IndexedDB，用来断言「真正落盘的是什么」而不只是界面显示了什么 */
export async function readGraphs(page: Page) {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('nonlinear-chat');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = await new Promise<Record<string, unknown>[]>((res, rej) => {
      const q = db.transaction('graphs').objectStore('graphs').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return all.map((g) => {
      const graph = g as { id: string; title: string; updatedAt: number; nodes: Record<string, {
        id: string; role: string; content: string; parentIds: string[]; status?: string;
      }> };
      return {
        id: graph.id,
        title: graph.title,
        updatedAt: graph.updatedAt,
        nodes: Object.values(graph.nodes).map((n) => ({
          id: n.id,
          role: n.role,
          content: n.content,
          parentIds: n.parentIds,
          status: n.status ?? null,
        })),
      };
    });
  });
}

export async function readGraph(page: Page, graphId: string) {
  const all = await readGraphs(page);
  const found = all.find((g) => g.id === graphId);
  if (!found) throw new Error(`画布 ${graphId} 不在库里`);
  return found;
}

/** 库里各类东西的数量，备份往返用它对账 */
export async function inventory(page: Page) {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('nonlinear-chat');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = (name: string) =>
      new Promise<unknown[]>((res, rej) => {
        const q = db.transaction(name).objectStore(name).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    const [graphs, attachments, files, chunks] = await Promise.all([
      all('graphs'),
      all('attachments'),
      all('knowledgeFiles'),
      all('knowledgeChunks'),
    ]);
    db.close();
    return {
      graphs: graphs.length,
      nodes: (graphs as { nodes: object }[]).reduce((n, g) => n + Object.keys(g.nodes).length, 0),
      attachments: attachments.length,
      attachmentBytes: (attachments as { size: number }[]).reduce((n, a) => n + a.size, 0),
      knowledgeFiles: files.length,
      knowledgeChunks: chunks.length,
    };
  });
}

/* ---------- 页面上的定位 ---------- */

/** 画布上正文包含这段字的那个节点卡片 */
export function nodeCard(page: Page, text: string): Locator {
  return page.locator('.react-flow__node').filter({ hasText: text }).first();
}

/** 节点操作条上的按钮。它平时 opacity 为 0，要先把鼠标移上去 */
export async function nodeAction(card: Locator, label: string): Promise<Locator> {
  await card.hover();
  return card.locator('.node-actions button', { hasText: new RegExp(`^${label}`) }).first();
}

/** 在提问节点里打字。节点正文是个 textarea，不是富文本 */
export async function typeInNode(card: Locator, text: string) {
  const input = card.locator('textarea.node-input');
  await input.click();
  await input.fill(text);
}

/**
 * 等一个 assistant 节点结束生成。
 *
 * 盯的是**落盘后的状态**而不是界面上的转圈：流式期间每 33ms 才 flush 一次，
 * 界面先安静下来、磁盘上还没写完是常事，光看界面会测出假的通过。
 */
export async function waitForIdle(page: Page, graphId: string, timeout = 20_000) {
  await expect
    .poll(
      async () => {
        const g = await readGraph(page, graphId);
        const assistants = g.nodes.filter((n) => n.role === 'assistant');
        if (!assistants.length) return 'none';
        return assistants.every((n) => n.status !== 'streaming') ? 'done' : 'streaming';
      },
      { timeout, message: `画布 ${graphId} 里还有没跑完的生成` },
    )
    .toBe('done');
}

/**
 * 等到确实开始流了 —— 竞态用例要在这之后下手。
 *
 * 这里**不能**去读 IndexedDB。防抖存盘 wait=600 / maxWait=3000，而流式期间
 * 每 33ms 就排一次队，防抖计时器一直被重置；一段两秒内跑完的回答，中途
 * 一个字都不会落盘，第一次写就是结束时那下 flush。照磁盘看，它从来没有
 * 「正在流」过。
 *
 * 顶栏那个「N 个生成中」才是真正的实时信号，也正是用户看见的东西。
 */
export async function waitForStreaming(page: Page, timeout = 10_000) {
  await expect(page.locator('.streaming-badge')).toBeVisible({ timeout });
}
