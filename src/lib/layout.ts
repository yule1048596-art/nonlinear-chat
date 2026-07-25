import type { ChatNode } from '../types';
import type { NodeMap } from './context';

export const NODE_WIDTH = 380;
/** 节点高度是自适应的，这里只用一个保守估计值来排新节点的位置 */
const ROW_GAP = 260;
const COL_GAP = 60;

function overlaps(nodes: NodeMap, x: number, y: number, ignore?: Set<string>): boolean {
  for (const node of Object.values(nodes)) {
    if (ignore?.has(node.id)) continue;
    if (
      Math.abs(node.position.x - x) < NODE_WIDTH + COL_GAP - 1 &&
      Math.abs(node.position.y - y) < ROW_GAP - 1
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 给新子节点找位置：先放父节点正下方，占了就往右挪一列，
 * 挪满 8 列还占就往下再压一行。保证新节点永远看得见、不叠在一起。
 */
export function placeChild(nodes: NodeMap, parents: ChatNode[]): { x: number; y: number } {
  if (parents.length === 0) return findFreeSpot(nodes, 0, 0);

  const avgX = parents.reduce((sum, p) => sum + p.position.x, 0) / parents.length;
  const maxY = Math.max(...parents.map((p) => p.position.y));
  return findFreeSpot(nodes, Math.round(avgX), maxY + ROW_GAP);
}

/** 同级另开一个分支：放到父节点下方偏右 */
export function placeSibling(nodes: NodeMap, sibling: ChatNode): { x: number; y: number } {
  return findFreeSpot(nodes, sibling.position.x + NODE_WIDTH + COL_GAP, sibling.position.y);
}

export function findFreeSpot(nodes: NodeMap, startX: number, startY: number) {
  let x = startX;
  let y = startY;
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 8; col++) {
      if (!overlaps(nodes, x, y)) return { x, y };
      x += NODE_WIDTH + COL_GAP;
    }
    x = startX;
    y += ROW_GAP;
  }
  return { x: startX, y };
}
