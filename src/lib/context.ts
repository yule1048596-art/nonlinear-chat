import type { ChatMessage, ChatNode } from '../types';

export type NodeMap = Record<string, ChatNode>;

/**
 * 收集 targetId 的全部祖先（含自身）。
 * DAG 里同一个祖先可能通过多条路径到达，用 Set 天然去重。
 */
export function collectAncestors(nodes: NodeMap, targetId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const node = nodes[id];
    if (!node) continue;
    seen.add(id);
    for (const parentId of node.parentIds) {
      if (!seen.has(parentId)) stack.push(parentId);
    }
  }
  return seen;
}

/** 收集 rootId 的全部后代（含自身），删除节点时用来级联 */
export function collectDescendants(nodes: NodeMap, rootId: string): Set<string> {
  const childrenOf = buildChildIndex(nodes);
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const childId of childrenOf.get(id) ?? []) {
      if (!seen.has(childId)) stack.push(childId);
    }
  }
  return seen;
}

export function buildChildIndex(nodes: NodeMap): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    for (const parentId of node.parentIds) {
      const bucket = index.get(parentId);
      if (bucket) bucket.push(node.id);
      else index.set(parentId, [node.id]);
    }
  }
  return index;
}

/**
 * 把 targetId 的祖先子图拓扑排序成一条线性消息链。
 *
 * 这是整个应用的核心：画布上是图，喂给模型的必须是序列。
 * 用 Kahn 算法，就绪节点按 createdAt 择小优先 —— 这样多条分支合并时
 * 会按真实发生的时间交错，因果顺序不会乱。
 */
export function topoOrder(nodes: NodeMap, targetId: string): ChatNode[] {
  const scope = collectAncestors(nodes, targetId);

  // 只统计作用域内的入度，作用域外的父节点不算约束
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of scope) {
    const node = nodes[id]!;
    const parents = node.parentIds.filter((p) => scope.has(p));
    indegree.set(id, parents.length);
    for (const parentId of parents) {
      const bucket = dependents.get(parentId);
      if (bucket) bucket.push(id);
      else dependents.set(parentId, [id]);
    }
  }

  const ready: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id);

  const byTime = (a: string, b: string) => {
    const na = nodes[a]!;
    const nb = nodes[b]!;
    return na.createdAt - nb.createdAt || (na.id < nb.id ? -1 : 1);
  };

  const ordered: ChatNode[] = [];
  while (ready.length) {
    ready.sort(byTime);
    const id = ready.shift()!;
    ordered.push(nodes[id]!);
    for (const childId of dependents.get(id) ?? []) {
      const next = indegree.get(childId)! - 1;
      indegree.set(childId, next);
      if (next === 0) ready.push(childId);
    }
  }

  // 正常情况下不会有环（addEdge 会拦），真出了环就按时间兜底，至少不丢消息
  if (ordered.length !== scope.size) {
    return [...scope].sort(byTime).map((id) => nodes[id]!);
  }
  return ordered;
}

/** 决定一个节点是否参与上下文 */
function participates(node: ChatNode): boolean {
  if (node.role === 'note') return node.includeInContext === true;
  if (node.status === 'error') return false;
  return node.content.trim().length > 0;
}

export interface BuildContextOptions {
  systemPrompt?: string;
  /** 保留最近 N 条非 system 消息，0 或不传表示全量 */
  limit?: number;
}

/**
 * 生成实际发给 API 的 messages。
 * 注意 targetId 自身也会被包含 —— 调用方传的是「最后一条 user 节点」的 id。
 */
export function buildContext(
  nodes: NodeMap,
  targetId: string,
  options: BuildContextOptions = {},
): ChatMessage[] {
  const chain = topoOrder(nodes, targetId).filter(participates);

  const systemParts: string[] = [];
  if (options.systemPrompt?.trim()) systemParts.push(options.systemPrompt.trim());

  let body: ChatMessage[] = [];
  for (const node of chain) {
    if (node.role === 'system') {
      systemParts.push(node.content.trim());
    } else {
      // note 走到这里说明用户勾了「参与上下文」，当成 user 发言
      body.push({
        role: node.role === 'assistant' ? 'assistant' : 'user',
        content: node.content,
      });
    }
  }

  if (options.limit && options.limit > 0 && body.length > options.limit) {
    body = body.slice(-options.limit);
  }

  const messages: ChatMessage[] = [];
  if (systemParts.length) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }
  return messages.concat(body);
}

/**
 * 加边前检测：把 from 设为 to 的父节点会不会成环。
 * 等价于问「from 是不是已经是 to 的后代」。
 */
export function wouldCreateCycle(nodes: NodeMap, from: string, to: string): boolean {
  if (from === to) return true;
  return collectAncestors(nodes, from).has(to);
}

/** 给节点算个深度，纯粹给自动布局用（多父取最深的那条路径） */
export function depthOf(nodes: NodeMap, id: string, memo = new Map<string, number>()): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  const node = nodes[id];
  if (!node || node.parentIds.length === 0) {
    memo.set(id, 0);
    return 0;
  }
  memo.set(id, 0); // 环保护：递归回到自己时先当 0
  let max = 0;
  for (const parentId of node.parentIds) {
    max = Math.max(max, depthOf(nodes, parentId, memo) + 1);
  }
  memo.set(id, max);
  return max;
}
