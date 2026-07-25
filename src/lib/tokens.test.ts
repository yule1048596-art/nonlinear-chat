import { describe, expect, it } from 'vitest';
import { estimateMessageTokens, estimateTokens, formatTokens } from './tokens';

describe('estimateTokens', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('中文按字算，密度远高于英文', () => {
    const cn = estimateTokens('讲讲缓存失效策略'); // 8 字
    expect(cn).toBeGreaterThanOrEqual(7);
    expect(cn).toBeLessThanOrEqual(9);
  });

  it('英文约 4 字符一个 token', () => {
    const text = 'a'.repeat(40);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(9);
    expect(estimateTokens(text)).toBeLessThanOrEqual(12);
  });

  /** 这条是整个模块存在的理由：字符数一样，token 数差三四倍 */
  it('等长的中文比英文贵得多 —— 只报字符数会严重误导', () => {
    const cn = '缓存失效有三种常见策略分别是过期主动'; // 18 字
    const en = 'abcdefghijklmnopqr'; // 18 字符
    expect(cn.length).toBe(en.length);
    expect(estimateTokens(cn)).toBeGreaterThan(estimateTokens(en) * 2.5);
  });

  it('中英混排两部分都算上', () => {
    const mixed = estimateTokens('用 Redis 做缓存');
    expect(mixed).toBeGreaterThan(estimateTokens('用'));
    expect(mixed).toBeGreaterThan(estimateTokens('Redis'));
  });

  it('日文假名和韩文谚文也按 CJK 算', () => {
    expect(estimateTokens('ひらがな')).toBeGreaterThanOrEqual(3);
    expect(estimateTokens('한국어')).toBeGreaterThanOrEqual(2);
  });

  it('代码按普通文本算，不会崩', () => {
    expect(estimateTokens('const ok = true;\nawait redis.del(key);')).toBeGreaterThan(5);
  });

  it('emoji 等代理对不会算出负数', () => {
    expect(estimateTokens('🎉🎉🎉')).toBeGreaterThan(0);
  });
});

describe('estimateMessageTokens', () => {
  it('每条消息按 chat 模板补一点开销', () => {
    const one = estimateMessageTokens([{ content: '你好' }]);
    const two = estimateMessageTokens([{ content: '你好' }, { content: '你好' }]);
    expect(two).toBeGreaterThan(one * 1.5);
  });

  it('空数组是 0', () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});

describe('formatTokens', () => {
  it('千以内原样显示', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('上千缩写', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(12345)).toBe('12k');
  });
});
