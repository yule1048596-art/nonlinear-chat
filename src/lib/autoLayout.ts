import dagre from '@dagrejs/dagre';
import type { ChatNode } from '../types';
import type { NodeMap } from './context';

export const NODE_WIDTH_FALLBACK = 380;
export const NODE_HEIGHT_FALLBACK = 160;

export interface LayoutOptions {
  /** 实测节点尺寸。取不到就用兜底值，布局会松一点但不会错位 */
  dimensions?: Map<string, { width: number; height: number }>;
  /** 同层节点的水平间距 */
  nodeSep?: number;
  /** 层与层之间的垂直间距 */
  rankSep?: number;
}

/**
 * 用 dagre 做分层布局。
 *
 * 为什么用 dagre 而不是自己写树形排版：这里是 DAG 不是树——一个节点可以有
 * 多个父节点（合并分支正是本应用的核心）。树形算法处理不了汇合，会把同一个
 * 节点画在两个地方或者交叉成一团。dagre 的分层算法专门解决这个。
 *
 * 返回新的坐标表；调用方负责把它写进 store（这样才能进撤销历史）。
 */
export function computeLayout(
  nodes: NodeMap,
  options: LayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const { dimensions, nodeSep = 60, rankSep = 90 } = options;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: nodeSep, ranksep: rankSep, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  const list = Object.values(nodes);
  if (list.length === 0) return {};

  for (const node of list) {
    const size = dimensions?.get(node.id);
    g.setNode(node.id, {
      width: size?.width || NODE_WIDTH_FALLBACK,
      height: size?.height || NODE_HEIGHT_FALLBACK,
    });
  }

  for (const node of list) {
    for (const parentId of node.parentIds) {
      // 父节点可能已被删除，留着悬空边会让 dagre 凭空造出一个节点
      if (nodes[parentId]) g.setEdge(parentId, node.id);
    }
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of list) {
    const laid = g.node(node.id);
    if (!laid) continue;
    // dagre 给的是中心点，React Flow 要左上角
    positions[node.id] = {
      x: Math.round(laid.x - laid.width / 2),
      y: Math.round(laid.y - laid.height / 2),
    };
  }
  return positions;
}

/** 布局前后位置是否几乎没变——没变就不必写进撤销历史，免得白占一条 */
export function isSameLayout(
  nodes: NodeMap,
  positions: Record<string, { x: number; y: number }>,
  tolerance = 1,
): boolean {
  return Object.entries(positions).every(([id, pos]) => {
    const node: ChatNode | undefined = nodes[id];
    if (!node) return true;
    return (
      Math.abs(node.position.x - pos.x) <= tolerance &&
      Math.abs(node.position.y - pos.y) <= tolerance
    );
  });
}
