import type { ChatNode, NodeRole } from '../types';
import { buildChildIndex, collectAncestors, depthOf, topoOrder, type NodeMap } from './context';
import { pairTurns } from './view';

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
  /** 从根到当前节点这条链，也就是真正发给模型的上下文 */
  cards: FocusCard[];
  /** 当前在最前面的是第几张。-1 表示牌堆是空的 */
  index: number;
  /**
   * 前方还没走到的那几张。
   *
   * 它们**不属于上下文链** —— 单独放一个字段就是为了不动 cards 的语义。
   * 存在的理由是动画：往回翻时，当前这张的位置会滑到「前方」去，
   * 前方没有位置的话它只能从 DOM 里消失，最该有过渡的那张反而是硬切。
   */
  ahead: FocusCard[];
}

/** 前方预览留几张。渲染上只用得到一张，多留无益 */
const AHEAD = 1;

/**
 * 把「从根到目标节点」这条链取成一摞卡片。
 *
 * 用的就是 topoOrder —— 也就是**真正发给模型的那条上下文链**。
 * 聚焦视图读到的顺序和模型看到的顺序因此永远一致，不会各说各话。
 *
 * 最前面的一张永远是目标节点所在的卡，更早的几轮叠在它后面。
 */
export function buildDeck(nodes: NodeMap, targetId: string | null): Deck {
  if (!targetId || !nodes[targetId]) return { cards: [], index: -1, ahead: [] };

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
  const at = index === -1 ? cards.length - 1 : index;

  /*
   * 顺着「最早的那个孩子」往下再取几张当预览。
   * 有岔路时挑哪条都不算错 —— 这几张只是给动画一个落点，
   * 真要走哪条还是底部那个分支选择器说了算。
   */
  const ahead: FocusCard[] = [];
  const seen = new Set(cards.map((c) => c.id));
  let tail = cards[at]?.nodeIds[cards[at]!.nodeIds.length - 1];
  for (let k = 0; k < AHEAD && tail; k++) {
    const next = (childrenOf.get(tail) ?? [])
      .map((id) => nodes[id])
      .filter((n): n is ChatNode => !!n)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
    if (!next) break;
    const card = buildDeck(nodes, next.id);
    const found = card.cards[card.index];
    if (!found) break;
    /*
     * 前方那张有可能就是牌堆里已有的那张。
     *
     * 停在一个还没走到回答的提问上时，当前卡是「提问」单独一张；
     * 而往前一步是它的回答，那条链上提问和回答会合并成一张 ——
     * 合并卡的 id 用的是提问的 id，于是同一个 id 出现了两次。
     * 渲染层按 card.id 做 key（翻页要靠它复用 DOM 才有过渡），
     * key 一撞 React 就会丢掉其中一张。
     *
     * 这两张本来也是同一轮，摆两次没有意义，直接不摆。
     */
    if (seen.has(found.id)) break;
    seen.add(found.id);
    ahead.push(found);
    tail = found.nodeIds[found.nodeIds.length - 1];
  }

  return { cards, index: at, ahead };
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

/** 编辑视图里卡片的大致中心相对于它的坐标 */
const CARD_CX = 190;

/** 迷你图的行高。纵向按层级均分，不用画布的原始 y */
const MINI_ROW = 34;
/** 横向最大跨度。画布可能宽达几千像素，压到这个范围里 */
const MINI_SPAN = 108;

/**
 * 把编辑视图整张图缩小成一堆圆点。
 *
 * 纵横两个方向用的不是同一套来源，这是有意的：
 *
 * - **纵向按图的层级均分。** 直接用画布的 y 会把画布本身的疏密照搬过来 ——
 *   上面挤成一团、下面拉得老长，看着就乱。按层级排则每一行等距，
 *   一眼看得出「这是第几层」。
 * - **横向沿用画布的 x。** 左右关系是用户自己摆的：哪条分支在左、哪条在右，
 *   他心里有数。这一层对应感必须留着，否则又变成「另一张图」了。
 *
 * 唯一的抽象是问答合并：和地图视图共用 pairTurns，一问一答缩成一个圆。
 */
export function buildMiniGraph(nodes: NodeMap, selectedId: string | null): MiniGraph {
  const empty: MiniGraph = { nodes: [], edges: [], width: 0, height: 0 };
  const all = Object.values(nodes);
  if (all.length === 0) return empty;

  const pairing = pairTurns(nodes);
  const path = selectedId ? collectAncestors(nodes, selectedId) : new Set<string>();

  // 被并进提问的回答不再单独出圆点
  const visible = all.filter((n) => !pairing.mergedInto.has(n.id));
  if (visible.length === 0) return empty;

  /*
   * 层级压成连续的行号。问答合并之后，相邻两张卡的层级会差 2
   * （提问 d、回答 d+1、下一个提问 d+2），直接拿层级当行号会空出一行。
   */
  const memo = new Map<string, number>();
  const rawDepth = new Map(visible.map((n) => [n.id, depthOf(nodes, n.id, memo)]));
  const rows = [...new Set(rawDepth.values())].sort((a, b) => a - b);
  const rowOf = new Map(rows.map((d, i) => [d, i]));

  const xs = visible.map((n) => n.position.x + CARD_CX);
  const minCanvasX = Math.min(...xs);
  const spanX = Math.max(...xs) - minCanvasX;
  // 全在一条竖线上时不要除以 0
  const kx = spanX > 0 ? MINI_SPAN / spanX : 0;

  const points = new Map(
    visible.map((n) => [
      n.id,
      {
        x: (n.position.x + CARD_CX - minCanvasX) * kx,
        y: (rowOf.get(rawDepth.get(n.id)!) ?? 0) * MINI_ROW,
      },
    ]),
  );

  const miniNodes: MiniNode[] = visible.map((n) => {
    const p = points.get(n.id)!;
    const answerId = pairing.answerOf.get(n.id);
    return {
      id: n.id,
      x: p.x,
      y: p.y,
      role: n.role,
      // 合并卡里只要有一头在链上，这个圆就算在链上
      onPath: path.has(n.id) || (!!answerId && path.has(answerId)),
      current: n.id === selectedId || answerId === selectedId,
    };
  });

  const miniEdges: MiniEdge[] = [];
  const seen = new Set<string>();
  for (const node of visible) {
    for (const parentId of node.parentIds) {
      // 父节点若是被并进去的回答，边改从那张卡（也就是提问）出发
      const source = pairing.mergedInto.get(parentId) ?? parentId;
      const a = points.get(source);
      const b = points.get(node.id);
      if (!a || !b || source === node.id) continue;
      const id = `${source}->${node.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      miniEdges.push({
        id,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        onPath: path.has(source) && path.has(node.id),
      });
    }
  }

  return {
    nodes: miniNodes,
    edges: miniEdges,
    width: Math.max(...miniNodes.map((n) => n.x)),
    height: Math.max(...miniNodes.map((n) => n.y)),
  };
}
