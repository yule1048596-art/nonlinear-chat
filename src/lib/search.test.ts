import { describe, expect, it } from 'vitest';
import { findHits } from './search';
import type { ChatNode } from '../types';

let clock = 0;
function node(id: string, content: string): ChatNode {
  clock += 1;
  return {
    id,
    role: 'user',
    content,
    parentIds: [],
    position: { x: 0, y: 0 },
    createdAt: clock,
    updatedAt: clock,
  };
}

const graph = (...nodes: ChatNode[]) => Object.fromEntries(nodes.map((n) => [n.id, n]));

/** 摘要里被标记为高亮的那一段 */
const highlighted = (hit: { excerpt: string; matchStart: number; matchLength: number }) =>
  hit.excerpt.slice(hit.matchStart, hit.matchStart + hit.matchLength);

describe('findHits', () => {
  it('空查询不返回结果', () => {
    expect(findHits(graph(node('a', '随便什么')), '')).toEqual([]);
    expect(findHits(graph(node('a', '随便什么')), '   ')).toEqual([]);
  });

  it('大小写不敏感', () => {
    const hits = findHits(graph(node('a', 'Redis 缓存')), 'redis');
    expect(hits).toHaveLength(1);
    expect(highlighted(hits[0]!)).toBe('Redis');
  });

  it('高亮正好落在匹配词上', () => {
    const hits = findHits(graph(node('a', '讲讲缓存失效策略')), '缓存');
    expect(highlighted(hits[0]!)).toBe('缓存');
  });

  /**
   * 这条是 bug 回归测试：摘要要把换行压成空格才好单行显示，但如果偏移量
   * 还按原文算，前缀里每有一个多余空白，高亮就右移一格。
   */
  it('前缀含换行时高亮不偏移', () => {
    const content = '第一行\n\n第二行\n\n\n这里有目标词';
    const hits = findHits(graph(node('a', content)), '目标词');
    expect(highlighted(hits[0]!)).toBe('目标词');
  });

  it('前缀含连续空格时高亮不偏移', () => {
    const hits = findHits(graph(node('a', 'a     b     c 目标')), '目标');
    expect(highlighted(hits[0]!)).toBe('目标');
  });

  it('匹配词本身含空白时长度按压缩后算', () => {
    const hits = findHits(graph(node('a', '前面 token   估算 后面')), 'token   估算');
    expect(highlighted(hits[0]!)).toBe('token 估算');
  });

  it('长文本前后加省略号，且高亮仍然对齐', () => {
    const long = 'x'.repeat(200) + '目标词' + 'y'.repeat(200);
    const hits = findHits(graph(node('a', long)), '目标词');
    const hit = hits[0]!;
    expect(hit.excerpt.startsWith('…')).toBe(true);
    expect(hit.excerpt.endsWith('…')).toBe(true);
    expect(highlighted(hit)).toBe('目标词');
  });

  it('命中在开头时不加前省略号，高亮从头开始', () => {
    const hits = findHits(graph(node('a', '目标词在最前面')), '目标词');
    const hit = hits[0]!;
    expect(hit.excerpt.startsWith('…')).toBe(false);
    expect(hit.matchStart).toBe(0);
    expect(highlighted(hit)).toBe('目标词');
  });

  it('多个结果按最近修改排序', () => {
    const old = node('old', '目标 A');
    const recent = node('recent', '目标 B');
    recent.updatedAt = old.updatedAt + 1000;
    const hits = findHits(graph(old, recent), '目标');
    expect(hits.map((h) => h.node.id)).toEqual(['recent', 'old']);
  });

  it('没有匹配就返回空', () => {
    expect(findHits(graph(node('a', '缓存')), '限流')).toEqual([]);
  });
});
