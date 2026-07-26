import type { ChatNode } from '../types';
import type { NodeMap } from './context';

export const MAX_RESULTS = 40;

/** 命中位置左右各留一点上下文，让用户看清匹配在哪 */
const LEAD = 24;
const TRAIL = 56;
const ELLIPSIS = '…';

export interface Hit {
  node: ChatNode;
  excerpt: string;
  /** 高亮在 excerpt 里的起始下标 */
  matchStart: number;
  /** 高亮长度（按 excerpt 计，不是查询词长度） */
  matchLength: number;
}

/**
 * 在当前画布里找匹配的节点。
 *
 * 注意偏移量必须在「压缩空白之后」的字符串上算。摘要要把换行和连续空格压成
 * 一个空格才好在一行里显示，而这个压缩会改变字符串长度——先按原文算下标再
 * 压缩，高亮就会整体错位（前缀里有换行时尤其明显）。
 */
export function findHits(nodes: NodeMap, query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: Hit[] = [];
  for (const node of Object.values(nodes)) {
    const raw = node.content;
    const index = raw.toLowerCase().indexOf(q);
    if (index === -1) continue;

    const from = Math.max(0, index - LEAD);
    const to = Math.min(raw.length, index + q.length + TRAIL);

    // 先切片再压缩，然后在压缩后的串上重新定位——匹配词本身也可能含空白
    const body = collapse(raw.slice(from, to));
    const prefix = collapse(raw.slice(from, index));
    const matched = collapse(raw.slice(index, index + q.length));

    const head = from > 0 ? ELLIPSIS : '';
    const tail = to < raw.length ? ELLIPSIS : '';

    hits.push({
      node,
      excerpt: head + body + tail,
      matchStart: head.length + prefix.length,
      matchLength: matched.length,
    });
  }

  // 越晚改动的越可能是用户在找的
  return hits.sort((a, b) => b.node.updatedAt - a.node.updatedAt).slice(0, MAX_RESULTS);
}

/**
 * 把连续空白压成一个空格。
 * 不做 trim —— 前缀末尾的那个空格是内容的一部分，去掉会让偏移量对不上。
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}
