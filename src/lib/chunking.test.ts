import { describe, expect, it } from 'vitest';
import { chunkText, OVERLAP_CHARS, TARGET_CHARS } from './chunking';

const para = (label: string, n: number) => label.repeat(n);

describe('chunkText', () => {
  it('空文本不产生块', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('短文本就是一块', () => {
    const out = chunkText('很短的一段话');
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('很短的一段话');
    expect(out[0]!.index).toBe(0);
  });

  /** 段落是作者自己划的语义边界，比按固定字数硬切好得多 */
  it('优先在段落边界切，不把一段劈两半', () => {
    const a = para('甲', 400);
    const b = para('乙', 400);
    const out = chunkText(`${a}\n\n${b}`, 500, 0);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe(a);
    expect(out[1]!.text).toBe(b);
  });

  it('多个小段落合并到接近目标长度，不产生一堆碎块', () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i}段内容`).join('\n\n');
    const out = chunkText(text, 200, 0);
    expect(out.length).toBeLessThan(10);
    expect(out.map((c) => c.text).join('')).toContain('第9段内容');
  });

  it('单个超长段落按句子切', () => {
    const long = Array.from({ length: 30 }, (_, i) => `这是第${i}句话。`).join('');
    const out = chunkText(long, 100, 0);
    expect(out.length).toBeGreaterThan(1);
    // 切点应落在句号后面，而不是把句子劈开
    for (const c of out) expect(c.text.trim().endsWith('。')).toBe(true);
  });

  it('没有标点的超长串也能硬切，不会卡死或返回超长块', () => {
    const out = chunkText('啊'.repeat(2000), 300, 0);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(300);
  });

  it('相邻块之间留重叠，跨边界的句子不会两边都读不懂', () => {
    const out = chunkText(`${para('甲', 300)}\n\n${para('乙', 300)}`, 400, 50);
    expect(out).toHaveLength(2);
    // 第二块开头应带上第一块结尾的一小段
    expect(out[1]!.text.startsWith('甲')).toBe(true);
    expect(out[1]!.text).toContain('乙');
  });

  it('第一块不加重叠前缀', () => {
    const out = chunkText(`${para('甲', 300)}\n\n${para('乙', 300)}`, 400, 50);
    expect(out[0]!.text.startsWith('甲')).toBe(true);
    expect(out[0]!.text).not.toContain('乙');
  });

  it('过短的尾块并回上一块，避免出现三个字的碎片', () => {
    const out = chunkText(`${para('甲', 550)}\n\n参考文献`, 600, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('参考文献');
  });

  it('块序号连续从 0 开始', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(String(i % 10), 300)).join('\n\n');
    const out = chunkText(text, 400, 20);
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i));
  });

  it('start/end 落在原文范围内且递增', () => {
    const text = Array.from({ length: 8 }, (_, i) => `段落${i}` + para('x', 200)).join('\n\n');
    const out = chunkText(text, 400, 30);
    for (const c of out) {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(text.length);
      expect(c.start).toBeLessThan(c.end);
    }
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start);
    }
  });

  it('默认参数下不产生远超目标长度的块', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}段。`.repeat(20)).join('\n\n');
    for (const c of chunkText(text)) {
      // 允许重叠带来的额外长度
      expect(c.text.length).toBeLessThanOrEqual(TARGET_CHARS + OVERLAP_CHARS + 50);
    }
  });

  it('全文内容不会丢失', () => {
    const text = Array.from({ length: 15 }, (_, i) => `唯一标记${i}` + para('填', 100)).join('\n\n');
    const joined = chunkText(text, 300, 20).map((c) => c.text).join('');
    for (let i = 0; i < 15; i++) expect(joined).toContain(`唯一标记${i}`);
  });
});
