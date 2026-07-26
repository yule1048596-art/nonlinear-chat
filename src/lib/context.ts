import type { ChatMessage, ChatNode, NodeRole } from '../types';
import { formatKnowledgeBlock, type RetrievedChunk } from './knowledge';

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

/** 这个角色默认进不进上下文。批注是画布上的备忘，默认不进 */
export function inContextByDefault(role: NodeRole): boolean {
  return role !== 'note';
}

/**
 * 节点当前实际进不进上下文（不考虑内容是否为空）。
 * UI 用它显示状态，participates 在此基础上再排除空节点和出错节点。
 */
export function isInContext(node: ChatNode): boolean {
  if (node.contextMode === 'include') return true;
  if (node.contextMode === 'exclude') return false;
  return inContextByDefault(node.role);
}

export type ExcludeReason = 'muted' | 'empty' | 'error' | 'note';

export const EXCLUDE_LABEL: Record<ExcludeReason, string> = {
  muted: '已静音',
  empty: '内容为空',
  error: '这次请求出错了',
  note: '批注默认不进上下文',
};

/**
 * 节点被排除的原因；返回 null 表示会进上下文。
 * 顺序即优先级，UI 上显示的理由要和实际生效的那条一致。
 */
export function excludeReason(node: ChatNode): ExcludeReason | null {
  if (node.contextMode === 'exclude') return 'muted';
  /*
   * 空节点永远跳过，且这条要排在 include 前面 ——「重新生成前先把内容清空」
   * 正是靠它把自己排除出自己的上下文，让首次生成和重新生成共用一条代码路径。
   * 若 include 能强行把空节点塞进去，那条路径就断了。
   */
  if (!node.content.trim()) return 'empty';
  if (node.status === 'error') return 'error';
  if (node.contextMode === 'include') return null;
  return inContextByDefault(node.role) ? null : 'note';
}

/**
 * 把旧数据里的 includeInContext 迁移成 contextMode。
 * 加载画布时跑一次即可；已经有 contextMode 的节点不动。
 */
export function migrateContextMode(nodes: NodeMap): NodeMap {
  let changed = false;
  const out: NodeMap = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (node.contextMode !== undefined || node.includeInContext === undefined) {
      out[id] = node;
      continue;
    }
    const { includeInContext, ...rest } = node;
    out[id] = { ...rest, contextMode: includeInContext ? 'include' : 'auto' };
    changed = true;
  }
  return changed ? out : nodes;
}

export interface BuildContextOptions {
  systemPrompt?: string;
  /** 保留最近 N 条非 system 消息，0 或不传表示全量 */
  limit?: number;
  /**
   * 知识库检索到的片段。
   * 检索本身要发网络请求，在外面做完再把结果传进来 ——
   * 这个函数得保持同步且无副作用，预览面板才能随手调。
   */
  knowledge?: RetrievedChunk[];
}

export interface ContextEntry {
  message: ChatMessage;
  /**
   * 这条消息来自哪些节点。
   * 通常是一个；system 那条可能由多个 system 节点合并而来，
   * 若还带了全局提示词则数组会比实际来源少一项。
   * 知识库注入的那条不来自任何节点，这里是空数组。
   */
  sourceIds: string[];
  /** 知识库注入的消息带上命中的片段，预览面板据此显示出处和分数 */
  knowledge?: RetrievedChunk[];
}

export interface ExcludedNode {
  node: ChatNode;
  reason: ExcludeReason;
}

export interface ContextExplain {
  entries: ContextEntry[];
  /** 在祖先链上、但没能进上下文的节点 */
  excluded: ExcludedNode[];
  /** 因为条数上限被裁掉的消息数 */
  trimmed: number;
  /** 全局提示词是否参与了那条 system 消息 */
  usedGlobalPrompt: boolean;
}

/**
 * 生成上下文，并说明每条消息的来源、哪些节点被排除、为什么。
 *
 * buildContext 直接建立在它之上，两者不可能各算各的 —— 预览面板要是和
 * 真正发出去的内容对不上，那比没有预览更糟。
 */
export function explainContext(
  nodes: NodeMap,
  targetId: string,
  options: BuildContextOptions = {},
): ContextExplain {
  const chain = topoOrder(nodes, targetId);

  const excluded: ExcludedNode[] = [];
  const systemParts: string[] = [];
  const systemSources: string[] = [];
  let body: ContextEntry[] = [];

  const globalPrompt = options.systemPrompt?.trim();
  if (globalPrompt) systemParts.push(globalPrompt);

  for (const node of chain) {
    const reason = excludeReason(node);
    if (reason) {
      excluded.push({ node, reason });
      continue;
    }
    if (node.role === 'system') {
      systemParts.push(node.content.trim());
      systemSources.push(node.id);
    } else {
      // 批注走到这里说明被显式设成了 include，当成 user 发言
      body.push({
        message: {
          role: node.role === 'assistant' ? 'assistant' : 'user',
          content: node.content,
        },
        sourceIds: [node.id],
      });
    }
  }

  let trimmed = 0;
  if (options.limit && options.limit > 0 && body.length > options.limit) {
    trimmed = body.length - options.limit;
    body = body.slice(-options.limit);
    // 从后往前切很可能正好切在一问一答中间，让对话以 assistant 开头。
    // 那读起来就是模型凭空接了半句话，部分服务商也要求首条必须是 user。
    while (body.length && body[0]!.message.role === 'assistant') {
      body.shift();
      trimmed++;
    }
  }

  /*
   * 知识库插在最后一条消息之前，而不是并进开头那条 system。
   * 两个原因：紧挨着问题模型不容易在长对话里把资料忘了；
   * 单独一条也让预览面板能把它和用户自己的话分开显示。
   * 放在裁剪之后 —— 这批资料是为这次提问检索的，被条数上限刷掉毫无道理。
   */
  const block = formatKnowledgeBlock(options.knowledge ?? []);
  if (block) {
    body.splice(Math.max(0, body.length - 1), 0, {
      message: { role: 'system', content: block },
      sourceIds: [],
      knowledge: options.knowledge,
    });
  }

  const entries: ContextEntry[] = [];
  if (systemParts.length) {
    entries.push({
      message: { role: 'system', content: systemParts.join('\n\n') },
      sourceIds: systemSources,
    });
  }

  return {
    entries: entries.concat(body),
    excluded,
    trimmed,
    usedGlobalPrompt: !!globalPrompt,
  };
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
  return explainContext(nodes, targetId, options).entries.map((e) => e.message);
}

/**
 * 加边前检测：把 from 设为 to 的父节点会不会成环。
 * 等价于问「from 是不是已经是 to 的后代」。
 */
export function wouldCreateCycle(nodes: NodeMap, from: string, to: string): boolean {
  if (from === to) return true;
  return collectAncestors(nodes, from).has(to);
}

/**
 * 算出哪些节点应该被折叠隐藏。
 *
 * DAG 下不能简单地「隐藏折叠节点的所有后代」：一个汇合节点可能同时挂在
 * 被折叠的分支和另一条可见分支下面，把它藏掉就等于凭空吞掉了一条可见路径
 * 的终点。
 *
 * 正确规则是从根节点往下传播可见性：
 *   - 没有父节点的节点始终可见
 *   - 其余节点可见，当且仅当它至少有一个「可见且未折叠」的父节点
 *   - 折叠节点自身可见，但可见性不经由它传递下去
 *
 * 于是汇合节点只要还有一条没被折叠的来路，就仍然可见。O(V+E)。
 */
export function computeHidden(nodes: NodeMap): Set<string> {
  const childrenOf = buildChildIndex(nodes);
  const visible = new Set<string>();
  const queue: string[] = [];

  for (const node of Object.values(nodes)) {
    // 父节点可能已被删除，这种悬空引用要当成根处理，否则整条分支会凭空消失
    const liveParents = node.parentIds.filter((p) => nodes[p]);
    if (liveParents.length === 0) {
      visible.add(node.id);
      queue.push(node.id);
    }
  }

  while (queue.length) {
    const id = queue.shift()!;
    const node = nodes[id];
    if (!node || node.subtreeCollapsed) continue; // 折叠节点不再往下传播可见性
    for (const childId of childrenOf.get(id) ?? []) {
      if (visible.has(childId)) continue;
      visible.add(childId);
      queue.push(childId);
    }
  }

  const hidden = new Set<string>();
  for (const id of Object.keys(nodes)) if (!visible.has(id)) hidden.add(id);
  return hidden;
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
