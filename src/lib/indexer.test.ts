import { describe, expect, it, vi } from 'vitest';
import { indexFile } from './indexer';
import type { EmbeddingConfig } from './embeddings';

const config: EmbeddingConfig = {
  baseUrl: 'http://localhost:8081/v1',
  apiKey: '',
  model: 'text-embedding-bge-m3',
};

/** 每条输入回一条能认出来源的假向量，用来验证块和向量有没有配错 */
const fakeEmbed = vi.fn(async (_c: EmbeddingConfig, inputs: string[], opts: any = {}) => {
  const out = inputs.map((_, i) => new Float32Array([i, 0, 0, 0]));
  opts.onProgress?.({ done: inputs.length, total: inputs.length });
  return out;
});

const makeFile = (name: string, content: string) =>
  new File([content], name, { type: 'text/plain' });

const opts = (extra: Record<string, unknown> = {}) => ({
  embed: fakeEmbed as any,
  now: () => 1_700_000_000_000,
  newId: () => 'file-1',
  ...extra,
});

describe('indexFile', () => {
  it('产出文件记录与切块，数量一致', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i}段内容。`.repeat(30)).join('\n\n');
    const { file, chunks } = await indexFile(makeFile('笔记.txt', text), 'g1', config, opts());

    expect(file.chunkCount).toBe(chunks.length);
    expect(chunks.length).toBeGreaterThan(1);
    expect(file.status).toBe('ready');
    expect(file.name).toBe('笔记.txt');
    expect(file.kind).toBe('text');
    expect(file.enabled).toBe(true);
  });

  it('每个块都带上画布和文件归属，便于按画布清理', async () => {
    const { file, chunks } = await indexFile(makeFile('a.md', '内容'), 'g-x', config, opts());
    for (const c of chunks) {
      expect(c.graphId).toBe('g-x');
      expect(c.fileId).toBe(file.id);
    }
  });

  /** 块 id 用「文件 id + 序号」，重复索引同一文件不会因为随机 id 而残留旧块 */
  it('块 id 由文件 id 与序号推导，可预测', async () => {
    const { chunks } = await indexFile(
      makeFile('a.txt', Array.from({ length: 10 }, (_, i) => `段${i}`.repeat(200)).join('\n\n')),
      'g1',
      config,
      opts(),
    );
    expect(chunks[0]!.id).toBe('file-1:0');
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  /** 顺序错位会让每段文字配上别人的向量，检索结果就全是错的 */
  it('第 i 块拿到第 i 条向量', async () => {
    const text = Array.from({ length: 8 }, (_, i) => `段${i}`.repeat(200)).join('\n\n');
    const { chunks } = await indexFile(makeFile('a.txt', text), 'g1', config, opts());
    chunks.forEach((c, i) => expect(c.embedding[0]).toBe(i));
  });

  it('记下建库用的向量模型，换模型后能看出旧向量不可比', async () => {
    const { file } = await indexFile(makeFile('a.txt', '内容'), 'g1', config, opts());
    expect(file.embeddingModel).toBe('text-embedding-bge-m3');
  });

  it('解析和向量两个阶段都回报进度', async () => {
    const phases: string[] = [];
    await indexFile(
      makeFile('a.txt', '一些内容'),
      'g1',
      config,
      opts({ onProgress: (p: any) => phases.push(p.phase) }),
    );
    expect(phases).toContain('parse');
    expect(phases).toContain('embed');
  });

  it('空文件报错而不是建出一个零块的空壳', async () => {
    await expect(indexFile(makeFile('空.txt', '   \n\n '), 'g1', config, opts())).rejects.toThrow(
      '没有解析出可用的文字',
    );
  });

  it('不支持的类型直接报错，不去调向量服务', async () => {
    const embed = vi.fn();
    await expect(
      indexFile(makeFile('a.pdf', 'x'), 'g1', config, opts({ embed })),
    ).rejects.toThrow('不支持的文件类型');
    expect(embed).not.toHaveBeenCalled();
  });

  it('向量服务失败时整体失败，不落下半套数据', async () => {
    const embed = vi.fn(async () => {
      throw new Error('连不上');
    });
    await expect(indexFile(makeFile('a.txt', '内容'), 'g1', config, opts({ embed }))).rejects.toThrow(
      '连不上',
    );
  });

  it('透传取消信号', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const embed = vi.fn(async (_c: any, inputs: string[], o: any) => {
      seen = o.signal;
      return inputs.map(() => new Float32Array([1, 0, 0, 0]));
    });
    await indexFile(makeFile('a.txt', '内容'), 'g1', config, opts({ embed, signal: controller.signal }));
    expect(seen).toBe(controller.signal);
  });
});
