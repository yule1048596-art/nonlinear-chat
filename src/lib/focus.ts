import type { ChatNode, NodeRole } from '../types';
import {
  buildChildIndex,
  collectAncestors,
  collectDescendants,
  topoOrder,
  type NodeMap,
} from './context';
import { computeLayout } from './autoLayout';

/**
 * 聚焦视图的一张卡片 = 一轮对话。
 *
 * 和地图视图用的是同一条合并规则（提问恰好一个 assistant 子节点、
 * 该回答恰好一个父节点），道理也一样：数据模型必须保持一条消息一个节点，
 * 因为「一个问题并排生成多个回答」是这个应用的核心特性。
 */
export interface FocusCard {
  /** 卡片 id 用主节点（有提问就是提问）的 id */
  id: string;
  questionId?: string;
  answerId?: string;
  /** 组成这张卡的全部节点，按出现顺序 */
  nodeIds: string[];
}

export interface Deck {
  cards: FocusCard[];
  /** 当前在最前面的是第几张。-1 表示牌堆是空的 */
  index: number;
}

/**
 * 把「从根到目标节点」这条链取成一摞卡片。
 *
 * 用的就是 topoOrder —— 也就是**真正发给模型的那条上下文链**。
 * 聚焦视图读到的顺序和模型看到的顺序因此永远一致，不会各说各话。
 *
 * 最前面的一张永远是目标节点所在的卡，更早的几轮叠在它后面。
 */
export function buildDeck(nodes: NodeMap, targetId: string | null): Deck {
  if (!targetId || !nodes[targetId]) return { cards: [], index: -1 };

  const chain = topoOrder(nodes, targetId);
  const childrenOf = buildChildIndex(nodes);
  const cards: FocusCard[] = [];

  for (let i = 0; i < chain.length; i++) {
    const node = chain[i]!;
    // 已经被上一张卡当作回答吸收掉了
    if (cards[cards.length - 1]?.answerId === node.id) continue;

    const next = chain[i + 1];
    const canMerge =
      node.role === 'user' &&
      next?.role === 'assistant' &&
      next.parentIds.length === 1 &&
      next.parentIds[0] === node.id &&
      (childrenOf.get(node.id) ?? []).length === 1;

    if (canMerge) {
      cards.push({
        id: node.id,
        questionId: node.id,
        answerId: next!.id,
        nodeIds: [node.id, next!.id],
      });
    } else {
      cards.push({
        id: node.id,
        questionId: node.role === 'user' ? node.id : undefined,
        answerId: node.role === 'assistant' ? node.id : undefined,
        nodeIds: [node.id],
      });
    }
  }

  // 目标节点所在的那张排在最前
  const index = cards.findIndex((c) => c.nodeIds.includes(targetId));
  return { cards, index: index === -1 ? cards.length - 1 : index };
}

/**
 * 从当前节点往下走一步有哪些去处。
 *
 * DAG 里「下一张」不是唯一的：一个回答可能挂着好几个追问，
 * 一个提问可能有好几版回答。有岔路就得让人自己选，不能替他挑一条。
 */
export function nextChoices(nodes: NodeMap, card: FocusCard | undefined): ChatNode[] {
  if (!card) return [];
  const childrenOf = buildChildIndex(nodes);
  // 从卡片的最后一个节点往下找 —— 合并卡要从回答往下走，而不是从提问
  const tail = card.nodeIds[card.nodeIds.length - 1]!;
  return (childrenOf.get(tail) ?? [])
    .map((id) => nodes[id])
    .filter((n): n is ChatNode => !!n)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** 上一张卡的主节点 id；已经在最前面（最早那轮）时返回 null */
export function previousId(deck: Deck): string | null {
  if (deck.index <= 0) return null;
  const prev = deck.cards[deck.index - 1];
  if (!prev) return null;
  // 选中卡片的最后一个节点：它才是「这条链走到这里」的位置
  return prev.nodeIds[prev.nodeIds.length - 1] ?? null;
}

/* ---------- 导航用的迷你结构图 ---------- */

export interface MiniNode {
  id: string;
  x: number;
  y: number;
  role: NodeRole;
  /** 在当前这条链上（也就是会发给模型的那些） */
  onPath: boolean;
  current: boolean;
}

export interface MiniEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  onPath: boolean;
}

export interface MiniGraph {
  nodes: MiniNode[];
  edges: MiniEdge[];
  width: number;
  height: number;
}

/** 迷你图的取材范围：当前这条链，加上挂在它上面的每一处分叉，以及它往下通向哪儿 */
function neighbourhood(nodes: NodeMap, targetId: string): Set<string> {
  const scope = collectAncestors(nodes, targetId);
  for (const id of collectDescendants(nodes, targetId)) scope.add(id);

  // 链上每个节点的孩子都算进来 —— 分叉正是从这些地方岔出去的，
  // 不带上它们，导航图就又退化成一条直线
  const childrenOf = buildChildIndex(nodes);
  for (const id of [...scope]) {
    for (const child of childrenOf.get(id) ?? []) scope.add(child);
  }
  return scope;
}

/**
 * 把「当前这条链和它周围的分叉」排成一张可以画出来的小图。
 *
 * 这是聚焦视图里唯一能看出分支结构的地方 —— 牌堆本身是线性的，
 * 只画当前路径的话，这个视图就不知道自己身处一张图里。
 */
export function buildMiniGraph(
  nodes: NodeMap,
  targetId: string | null,
  size = 11,
): MiniGraph {
  const empty: MiniGraph = { nodes: [], edges: [], width: 0, height: 0 };
  if (!targetId || !nodes[targetId]) return empty;

  const scope = neighbourhood(nodes, targetId);
  const sub: NodeMap = {};
  for (const id of scope) {
    const node = nodes[id];
    if (!node) continue;
    sub[id] = { ...node, parentIds: node.parentIds.filter((p) => scope.has(p)) };
  }
  if (Object.keys(sub).length === 0) return empty;

  const dimensions = new Map(Object.keys(sub).map((id) => [id, { width: size, height: size }]));
  const positions = computeLayout(sub, { dimensions, nodeSep: 16, rankSep: 26 });

  const xs = Object.values(positions).map((p) => p.x);
  const ys = Object.values(positions).map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  const path = collectAncestors(nodes, targetId);
  const at = (id: string) => {
    const p = positions[id];
    return p ? { x: p.x - minX + size / 2, y: p.y - minY + size / 2 } : null;
  };

  const miniNodes: MiniNode[] = [];
  for (const id of Object.keys(sub)) {
    const p = at(id);
    if (!p) continue;
    miniNodes.push({
      id,
      x: p.x,
      y: p.y,
      role: sub[id]!.role,
      onPath: path.has(id),
      current: id === targetId,
    });
  }

  const miniEdges: MiniEdge[] = [];
  for (const node of Object.values(sub)) {
    for (const parentId of node.parentIds) {
      const a = at(parentId);
      const b = at(node.id);
      if (!a || !b) continue;
      miniEdges.push({
        id: `${parentId}->${node.id}`,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        onPath: path.has(parentId) && path.has(node.id),
      });
    }
  }

  return {
    nodes: miniNodes,
    edges: miniEdges,
    width: Math.max(...miniNodes.map((n) => n.x)) + size / 2,
    height: Math.max(...miniNodes.map((n) => n.y)) + size / 2,
  };
}
