import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_VERSION,
  archiveFilename,
  buildArchive,
  compareCounts,
  countPayload,
  looksLikeArchive,
  packVectors,
  readArchive,
  unpackVectors,
  type ArchivePayload,
} from './archive';
import type { Attachment, ChatNode, Graph, KnowledgeChunk, KnowledgeFile, Settings } from '../types';

const node = (id: string, content = ''): ChatNode => ({
  id,
  role: 'user',
  content,
  parentIds: [],
  position: { x: 0, y: 0 },
  createdAt: 1,
  updatedAt: 1,
});

const graph = (id: string, nodeIds: string[]): Graph => ({
  id,
  title: id,
  nodes: Object.fromEntries(nodeIds.map((n) => [n, node(n, `${n} 的内容`)])),
  createdAt: 1,
  updatedAt: 2,
});

const settings = (): Settings => ({
  profiles: [
    {
      id: 'p1',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-secret',
      model: 'deepseek-chat',
      temperature: 0.7,
    },
  ],
  activeProfileId: 'p1',
  systemPrompt: '设定',
  contextLimit: 0,
  embedding: { baseUrl: 'https://api.jina.ai/v1', apiKey: 'jina-secret', model: 'j3', topK: 4 },
});

const attachment = (id: string, nodeId: string, bytes: number[]): Attachment => ({
  id,
  graphId: 'g1',
  nodeId,
  name: `${id}.png`,
  mime: 'image/png',
  size: bytes.length,
  kind: 'image',
  blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
  createdAt: 3,
});

const chunk = (id: string, embedding: number[]): KnowledgeChunk => ({
  id,
  graphId: 'g1',
  fileId: 'f1',
  index: 0,
  text: `${id} 的正文`,
  embedding: new Float32Array(embedding),
});

const file = (id: string): KnowledgeFile => ({
  id,
  graphId: 'g1',
  name: `${id}.md`,
  kind: 'markdown',
  size: 100,
  charCount: 50,
  chunkCount: 2,
  enabled: true,
  status: 'ready',
  createdAt: 4,
});

const payload = (): ArchivePayload => ({
  settings: settings(),
  graphs: [graph('g1', ['n1', 'n2']), graph('g2', ['n3'])],
  attachments: [attachment('a1', 'n1', [1, 2, 3, 4]), attachment('a2', 'n2', [9, 9])],
  knowledgeFiles: [file('f1')],
  knowledgeChunks: [chunk('c1', [0.5, -0.25, 1]), chunk('c2', [0, 1, 0])],
});

const toBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe('countPayload', () => {
  it('数清楚每一类', () => {
    expect(countPayload(payload())).toEqual({
      graphs: 2,
      nodes: 3,
      attachments: 2,
      attachmentBytes: 6,
      knowledgeFiles: 1,
      knowledgeChunks: 2,
    });
  });
});

describe('向量打包', () => {
  it('打包再解开还是原来那些数', () => {
    const chunks = [chunk('a', [1, 2, 3]), chunk('b', [-1, 0.5])];
    const packed = packVectors(chunks);
    const back = unpackVectors(packed, [3, 2]);
    expect([...back[0]!]).toEqual([1, 2, 3]);
    expect([...back[1]!]).toEqual([-1, 0.5]);
  });

  it('空的也不出错', () => {
    expect(unpackVectors(new Uint8Array(0), [])).toEqual([]);
  });

  /*
   * 字节数对不上时宁可一个向量都不给。
   *
   * 半截向量比没有更糟：检索照样跑得出一个看着正常的相似度排序，
   * 只是它是错的 —— 而「资料明明加了，答案却不沾边」极难被察觉。
   */
  it('字节数对不上时整体作废，不给半截向量', () => {
    const packed = packVectors([chunk('a', [1, 2, 3])]);
    expect(unpackVectors(packed, [3, 2]).every((v) => v.length === 0)).toBe(true);
    expect(unpackVectors(packed.slice(0, 8), [3]).every((v) => v.length === 0)).toBe(true);
  });
});

describe('打包与还原', () => {
  it('整套数据原样回来', async () => {
    const original = payload();
    const { blob, manifest } = await buildArchive(original, true);
    const parsed = await readArchive(await toBytes(blob));

    expect(manifest.version).toBe(ARCHIVE_VERSION);
    expect(parsed.mismatches).toEqual([]);
    expect(countPayload(parsed.payload)).toEqual(countPayload(original));

    expect(parsed.payload.graphs.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(parsed.payload.graphs[0]!.nodes['n1']!.content).toBe('n1 的内容');
    expect(parsed.payload.knowledgeFiles[0]!.name).toBe('f1.md');
  });

  /** 附件是整件事的理由：v1 的 JSON 备份里根本没有它们 */
  it('附件的字节一个不差', async () => {
    const { blob } = await buildArchive(payload(), true);
    const parsed = await readArchive(await toBytes(blob));

    const a1 = parsed.payload.attachments.find((a) => a.id === 'a1')!;
    expect(a1.name).toBe('a1.png');
    expect(a1.mime).toBe('image/png');
    expect([...(await toBytes(a1.blob))]).toEqual([1, 2, 3, 4]);
    const a2 = parsed.payload.attachments.find((a) => a.id === 'a2')!;
    expect([...(await toBytes(a2.blob))]).toEqual([9, 9]);
  });

  it('向量原样回来，检索不用重新跑一遍', async () => {
    const { blob } = await buildArchive(payload(), true);
    const parsed = await readArchive(await toBytes(blob));
    const c1 = parsed.payload.knowledgeChunks.find((c) => c.id === 'c1')!;
    expect(c1.embedding).toBeInstanceOf(Float32Array);
    expect([...c1.embedding]).toEqual([0.5, -0.25, 1]);
    expect(c1.text).toBe('c1 的正文');
  });

  it('默认不带 Key，明确要求时才带', async () => {
    const stripped = await readArchive(await toBytes((await buildArchive(payload(), false)).blob));
    expect(stripped.manifest.keysIncluded).toBe(false);
    expect(stripped.payload.settings.profiles[0]!.apiKey).toBe('');
    expect(stripped.payload.settings.embedding!.apiKey).toBe('');

    const kept = await readArchive(await toBytes((await buildArchive(payload(), true)).blob));
    expect(kept.payload.settings.profiles[0]!.apiKey).toBe('sk-secret');
    expect(kept.payload.settings.embedding!.apiKey).toBe('jina-secret');
  });

  it('没有附件、没有知识库时也能打包还原', async () => {
    const bare: ArchivePayload = {
      settings: settings(),
      graphs: [graph('g1', ['n1'])],
      attachments: [],
      knowledgeFiles: [],
      knowledgeChunks: [],
    };
    const parsed = await readArchive(await toBytes((await buildArchive(bare, false)).blob));
    expect(parsed.mismatches).toEqual([]);
    expect(parsed.payload.graphs).toHaveLength(1);
    expect(parsed.payload.attachments).toEqual([]);
  });
});

describe('readArchive 的拒收', () => {
  it('不是备份包就说清楚', async () => {
    const notZip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(readArchive(notZip)).rejects.toThrow();
  });

  it('未来版本的包不硬啃', async () => {
    const { blob } = await buildArchive(payload(), false);
    const bytes = await toBytes(blob);
    // 直接改 manifest 里的版本号：解出来重新打一次
    const parsed = await readArchive(bytes);
    const future = { ...parsed.manifest, version: ARCHIVE_VERSION + 1 };
    const { zipSync, strToU8 } = await import('fflate');
    const tampered = zipSync({ 'manifest.json': strToU8(JSON.stringify(future)) });
    await expect(readArchive(tampered)).rejects.toThrow(/v\d+/);
  });
});

describe('compareCounts', () => {
  const base = {
    graphs: 1,
    nodes: 2,
    attachments: 3,
    attachmentBytes: 4,
    knowledgeFiles: 5,
    knowledgeChunks: 6,
  };

  it('一致时没有话说', () => {
    expect(compareCounts(base, { ...base })).toEqual([]);
  });

  /*
   * 备份最怕的不是导入失败，是**导入成功但少了东西** —— 少了什么要过很久
   * 才会被发现，那时原始数据可能已经没了。所以要当场吵一句。
   */
  it('对不上时逐项说明差在哪', () => {
    const actual = { ...base, attachments: 1, knowledgeChunks: 0 };
    expect(compareCounts(base, actual)).toEqual([
      '附件：清单写 3，实际 1',
      '知识库切块：清单写 6，实际 0',
    ]);
  });

  it('附件字节数少了也要报', () => {
    expect(compareCounts(base, { ...base, attachmentBytes: 2 })).toEqual([
      '附件字节数：清单写 4，实际 2',
    ]);
  });
});

describe('looksLikeArchive', () => {
  it('认得出备份包', () => {
    expect(looksLikeArchive({ name: 'nexus-20260729-1930.nexus.zip' })).toBe(true);
    expect(looksLikeArchive({ name: '随便什么.ZIP' })).toBe(true);
  });

  it('JSON 走旧那条路', () => {
    expect(looksLikeArchive({ name: 'nexus-backup.json' })).toBe(false);
    expect(looksLikeArchive({ name: '画布.json' })).toBe(false);
  });
});

describe('archiveFilename', () => {
  it('带日期和 .nexus.zip 后缀', () => {
    expect(archiveFilename()).toMatch(/^nexus-\d{8}-\d{4}\.nexus\.zip$/);
  });
});
