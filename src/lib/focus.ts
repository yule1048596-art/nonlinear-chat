import type { ChatNode, NodeRole } from '../types';
import { buildChildIndex, topoOrder, type NodeMap } from './context';

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
  /** 在主干上（也就是当前这条会发给模型的链） */
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

const ROW = 30;
const COL = 24;

/**
 * 画一棵极简的树：一条竖直的主干，外加几根岔出去的短枝。
 *
 * 这里刻意**不用 dagre**。上一版用了，主干会被它左右挪来挪去以求少交叉，
 * 结果一条线画得歪歪扭扭，看着「复杂」—— 可这张图要说的事只有两件：
 * 「我在这条链的第几节」和「哪儿还有别的路」。
 *
 * 所以主干写死一条直线（一张卡一个点，和牌堆一一对应），
 * 岔路只画一节短枝挂在旁边，不再往下展开。看得懂比画得全重要。
 */
export function buildMiniGraph(nodes: NodeMap, deck: Deck): MiniGraph {
  if (deck.cards.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const childrenOf = buildChildIndex(nodes);
  const spineHeads = new Set(deck.cards.map((c) => c.nodeIds[0]!));

  const miniNodes: MiniNode[] = [];
  const miniEdges: MiniEdge[] = [];
  let minX = 0;

  deck.cards.forEach((card, i) => {
    const headId = card.nodeIds[0]!;
    const head = nodes[headId];
    if (!head) return;

    const y = i * ROW;
    miniNodes.push({
      id: card.nodeIds[card.nodeIds.length - 1]!,
      x: 0,
      y,
      role: head.role,
      onPath: true,
      current: i === deck.index,
    });

    // 主干：上一节连到这一节
    if (i > 0) {
      miniEdges.push({ id: `spine-${i}`, x1: 0, y1: (i - 1) * ROW, x2: 0, y2: y, onPath: true });
    }

    /*
     * 岔路：这张卡的末节点下面，除了主干的下一节之外还挂着什么。
     * 只画一节，不往下递归 —— 它要回答的是「这儿有岔路」，不是「岔路通向哪」。
     */
    const tail = card.nodeIds[card.nodeIds.length - 1]!;
    const forks = (childrenOf.get(tail) ?? []).filter((id) => !spineHeads.has(id));
    forks.forEach((forkId, k) => {
      const fork = nodes[forkId];
      if (!fork) return;
      const fx = -(k + 1) * COL;
      const fy = y + ROW * 0.6;
      minX = Math.min(minX, fx);
      miniNodes.push({ id: forkId, x: fx, y: fy, role: fork.role, onPath: false, current: false });
      miniEdges.push({ id: `fork-${forkId}`, x1: 0, y1: y, x2: fx, y2: fy, onPath: false });
    });
  });

  // 平移到非负坐标，SVG 才画得出来
  const shift = -minX;
  for (const n of miniNodes) n.x += shift;
  for (const e of miniEdges) {
    e.x1 += shift;
    e.x2 += shift;
  }

  return {
    nodes: miniNodes,
    edges: miniEdges,
    width: Math.max(...miniNodes.map((n) => n.x)),
    height: Math.max(...miniNodes.map((n) => n.y)),
  };
}
