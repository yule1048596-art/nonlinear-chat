import { describe, expect, it } from 'vitest';
import {
  dot,
  formatKnowledgeBlock,
  isNormalized,
  magnitude,
  retrieve,
  type StoredChunk,
} from './knowledge';

/** 造一个 L2 归一化的向量 */
const unit = (...v: number[]): Float32Array => {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return new Float32Array(v.map((x) => x / m));
};

const chunk = (id: string, fileId: string, index: number, text: string, vec: Float32Array): StoredChunk => ({
  id,
  fileId,
  index,
  text,
  embedding: vec,
});

describe('向量基础运算', () => {
  it('点积', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('模长', () => {
    expect(magnitude([3, 4])).toBe(5);
  });

  it('识别是否已归一化', () => {
    expect(isNormalized(unit(1, 2, 3))).toBe(true);
    expect(isNormalized([3, 4])).toBe(false);
    expect(isNormalized([1, 0, 0])).toBe(true);
  });

  /** 归一化后点积就是余弦，检索每次比较能省一次开方 */
  it('归一化向量的点积等于余弦相似度', () => {
    const a = unit(1, 1, 0);
    const b = unit(1, 0, 0);
    expect(dot(a, b)).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(dot(a, a)).toBeCloseTo(1, 5);
  });

  it('长度不同的向量按较短的算，不越界', () => {
    expect(() => dot([1, 2, 3], [1, 2])).not.toThrow();
    expect(dot([1, 2, 3], [1, 2])).toBe(5);
  });
});

describe('retrieve', () => {
  const near = unit(1, 0, 0);
  const mid = unit(1, 1, 0);
  const far = unit(0, 0, 1);

  const chunks = [
    chunk('c-far', 'f2', 0, '不相关的内容', far),
    chunk('c-near', 'f1', 0, '最相关的内容', near),
    chunk('c-mid', 'f1', 1, '沾点边的内容', mid),
  ];
  const names = new Map([
    ['f1', '笔记.md'],
    ['f2', '别的.txt'],
  ]);

  it('按相似度从高到低排序', () => {
    const out = retrieve(near, chunks, { fileNames: names });
    expect(out.map((c) => c.chunkId)).toEqual(['c-near', 'c-mid', 'c-far']);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it('topK 限制返回数量', () => {
    expect(retrieve(near, chunks, { topK: 2 })).toHaveLength(2);
    expect(retrieve(near, chunks, { topK: 0 })).toEqual([]);
  });

  it('只在启用的文件里检索', () => {
    const out = retrieve(near, chunks, { enabledFileIds: new Set(['f2']) });
    expect(out.map((c) => c.fileId)).toEqual(['f2']);
  });

  it('带上文件名用于回显出处', () => {
    expect(retrieve(near, chunks, { fileNames: names })[0]!.fileName).toBe('笔记.md');
  });

  it('没有文件名映射时给出占位而不是崩掉', () => {
    expect(retrieve(near, chunks)[0]!.fileName).toBe('未知文件');
  });

  it('空库返回空', () => {
    expect(retrieve(near, [])).toEqual([]);
  });

  /**
   * 刻意不做阈值过滤：bge-m3 上「两个技术话题」和「技术 vs 无关话题」的
   * 分差只有 0.07 左右，任何绝对阈值都会一刀切错。
   */
  it('不按阈值过滤，低分块照样返回并如实给出分数', () => {
    const out = retrieve(near, [chunk('c', 'f', 0, 'x', far)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBeCloseTo(0, 5);
  });

  it('分数相同时排序稳定，不会每次刷新换一个顺序', () => {
    const same = [
      chunk('b', 'fb', 0, 'x', near),
      chunk('a', 'fa', 0, 'x', near),
    ];
    expect(retrieve(near, same).map((c) => c.chunkId)).toEqual(
      retrieve(near, same).map((c) => c.chunkId),
    );
    expect(retrieve(near, same)[0]!.chunkId).toBe('a'); // fa < fb
  });
});

describe('formatKnowledgeBlock', () => {
  const made = (fileName: string, text: string) => ({
    chunkId: 'c',
    fileId: 'f',
    fileName,
    index: 0,
    text,
    score: 0.7,
  });

  it('没有命中时返回空串，不往上下文里塞空壳', () => {
    expect(formatKnowledgeBlock([])).toBe('');
  });

  it('标明这是参考资料而不是对话内容', () => {
    const out = formatKnowledgeBlock([made('笔记.md', '内容')]);
    expect(out).toContain('参考资料');
    expect(out).toContain('不是对话的一部分');
  });

  it('每段都标出处，避免模型把资料当成用户说过的话', () => {
    const out = formatKnowledgeBlock([made('甲.md', '甲内容'), made('乙.md', '乙内容')]);
    expect(out).toContain('《甲.md》');
    expect(out).toContain('《乙.md》');
    expect(out).toContain('资料 1');
    expect(out).toContain('资料 2');
  });
});
