import { describe, expect, it } from 'vitest';
import { buildDeck, buildMiniGraph, nextChoices, previousId } from './focus';
import type { ChatNode, NodeRole } from '../types';

let clock = 0;
function node(id: string, role: NodeRole, parentIds: string[] = []): ChatNode {
  clock += 1;
  return {
    id,
    role,
    content: `${id} 的内容`,
    parentIds,
    position: { x: 0, y: 0 },
    createdAt: clock,
    updatedAt: clock,
  };
}
const graph = (...list: ChatNode[]) => Object.fromEntries(list.map((n) => [n.id, n]));
const ids = (deck: { cards: { id: string }[] }) => deck.cards.map((c) => c.id);

describe('buildDeck', () => {
  it('没有选中节点时是空牌堆', () => {
    expect(buildDeck(graph(node('a', 'user')), null)).toEqual({ cards: [], index: -1, ahead: [] });
    expect(buildDeck({}, 'nope')).toEqual({ cards: [], index: -1, ahead: [] });
  });

  it('一问一答合成一张卡', () => {
    const g = graph(node('q', 'user'), node('a', 'assistant', ['q']));
    const deck = buildDeck(g, 'a');
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0]).toMatchObject({ id: 'q', questionId: 'q', answerId: 'a' });
  });

  it('一条问答链每轮一张卡，按顺序排', () => {
    const g = graph(
      node('q1', 'user'),
      node('a1', 'assistant', ['q1']),
      node('q2', 'user', ['a1']),
      node('a2', 'assistant', ['q2']),
    );
    expect(ids(buildDeck(g, 'a2'))).toEqual(['q1', 'q2']);
  });

  /** 和地图视图同一条规则：一个问题有多版回答时不能合并 */
  it('一问两答时提问和回答各自成卡', () => {
    const g = graph(
      node('q', 'user'),
      node('a1', 'assistant', ['q']),
      node('a2', 'assistant', ['q']),
    );
    const deck = buildDeck(g, 'a1');
    expect(ids(deck)).toEqual(['q', 'a1']);
    expect(deck.cards[0]!.answerId).toBeUndefined();
  });

  it('回答被多条分支共用时不合并', () => {
    const g = graph(node('q1', 'user'), node('q2', 'user'), node('a', 'assistant', ['q1', 'q2']));
    expect(ids(buildDeck(g, 'a'))).toEqual(['q1', 'q2', 'a']);
  });

  /**
   * 上一条里回答的首个父节点不是链上那个提问，光靠「首个父节点对得上」
   * 就能挡住。这条专门盯「首个父节点对得上、但还挂着别的父节点」——
   * 只有真去数父节点个数才拦得下来。
   */
  it('回答的第一个父节点对得上、但还有别的父节点时也不合并', () => {
    // side 先建，这样 topoOrder 会把它排在 q 前面，q 正好紧挨着 a，
    // 且 a.parentIds[0] === 'q' —— 只有真去数父节点个数才拦得下来
    const side = node('side', 'user');
    const q = node('q', 'user');
    const g = graph(side, q, node('a', 'assistant', ['q', 'side']));
    const deck = buildDeck(g, 'a');
    expect(ids(deck)).toEqual(['side', 'q', 'a']);
    expect(deck.cards.find((c) => c.id === 'q')?.answerId).toBeUndefined();
  });

  it('system 和 note 各自成卡', () => {
    const g = graph(
      node('sys', 'system'),
      node('q', 'user', ['sys']),
      node('a', 'assistant', ['q']),
    );
    expect(ids(buildDeck(g, 'a'))).toEqual(['sys', 'q']);
  });

  /** 最前面的一张永远是选中节点那张，更早的叠在后面 */
  it('index 指向选中节点所在的卡', () => {
    const g = graph(
      node('q1', 'user'),
      node('a1', 'assistant', ['q1']),
      node('q2', 'user', ['a1']),
      node('a2', 'assistant', ['q2']),
    );
    expect(buildDeck(g, 'a2').index).toBe(1);
    expect(buildDeck(g, 'a1').index).toBe(0);
    // 选中提问和选中它的回答，落在同一张卡上
    expect(buildDeck(g, 'q2').index).toBe(1);
  });

  /**
   * 牌堆用的就是 topoOrder —— 真正发给模型的那条上下文链。
   * 两者一致，聚焦视图读到的顺序才不会和模型看到的各说各话。
   */
  it('多父合并时按时间交错，和上下文链一致', () => {
    const g = graph(
      node('au', 'user'),
      node('aa', 'assistant', ['au']),
      node('bu', 'user'),
      node('ba', 'assistant', ['bu']),
      node('merge', 'user', ['aa', 'ba']),
    );
    expect(ids(buildDeck(g, 'merge'))).toEqual(['au', 'bu', 'merge']);
  });

  it('只选中一个孤立提问时就一张卡', () => {
    const deck = buildDeck(graph(node('q', 'user')), 'q');
    expect(deck.cards).toHaveLength(1);
    expect(deck.index).toBe(0);
    expect(deck.cards[0]!.answerId).toBeUndefined();
  });
});

describe('nextChoices', () => {
  it('没有下游时返回空', () => {
    const g = graph(node('q', 'user'), node('a', 'assistant', ['q']));
    expect(nextChoices(g, buildDeck(g, 'a').cards[0])).toEqual([]);
  });

  /** 合并卡要从回答往下走，不是从提问 —— 否则会把自己的回答当成「下一张」 */
  it('合并卡从回答往下找，不会把自己的回答算进去', () => {
    const g = graph(
      node('q', 'user'),
      node('a', 'assistant', ['q']),
      node('q2', 'user', ['a']),
    );
    const deck = buildDeck(g, 'a');
    expect(nextChoices(g, deck.cards[0]).map((n) => n.id)).toEqual(['q2']);
  });

  it('有岔路时全部列出，按时间排', () => {
    const g = graph(
      node('q', 'user'),
      node('a', 'assistant', ['q']),
      node('f1', 'user', ['a']),
      node('f2', 'user', ['a']),
    );
    const deck = buildDeck(g, 'a');
    expect(nextChoices(g, deck.cards[0]).map((n) => n.id)).toEqual(['f1', 'f2']);
  });

  it('传 undefined 不炸', () => {
    expect(nextChoices({}, undefined)).toEqual([]);
  });
});

describe('previousId', () => {
  const chain = () =>
    graph(
      node('q1', 'user'),
      node('a1', 'assistant', ['q1']),
      node('q2', 'user', ['a1']),
      node('a2', 'assistant', ['q2']),
    );

  /** 回到上一轮，落点是那一轮的回答 —— 那才是「这条链走到这里」的位置 */
  it('返回上一张卡的最后一个节点', () => {
    expect(previousId(buildDeck(chain(), 'a2'))).toBe('a1');
  });

  it('已经在最早那轮时返回 null', () => {
    expect(previousId(buildDeck(chain(), 'a1'))).toBe(null);
    expect(previousId({ cards: [], index: -1, ahead: [] })).toBe(null);
  });
});

describe('buildMiniGraph', () => {
  /** 带坐标的节点：迷你图直接用编辑视图的坐标，不再自己排版 */
  const at = (n: ChatNode, x: number, y: number): ChatNode => ({ ...n, position: { x, y } });

  it('空图返回空', () => {
    expect(buildMiniGraph({}, null).nodes).toEqual([]);
  });

  /** 唯一的抽象：一问一答缩成一个圆，和地图视图共用 pairTurns */
  it('一问一答合成一个圆点', () => {
    const g = graph(at(node('q', 'user'), 0, 0), at(node('a', 'assistant', ['q']), 0, 200));
    const m = buildMiniGraph(g, 'a');
    expect(m.nodes.map((n) => n.id)).toEqual(['q']);
    expect(m.nodes[0]!.current).toBe(true); // 选中回答时，那张合并卡就是当前
  });

  it('一问两答时三个都各自成点', () => {
    const g = graph(
      at(node('q', 'user'), 0, 0),
      at(node('a1', 'assistant', ['q']), -200, 200),
      at(node('a2', 'assistant', ['q']), 200, 200),
    );
    expect(buildMiniGraph(g, 'a1').nodes.map((n) => n.id).sort()).toEqual(['a1', 'a2', 'q']);
  });

  /** 「有几棵树就显示几棵」：互不相连的部分也要在图里 */
  it('画出全部节点，包括和当前链无关的另一棵树', () => {
    const g = graph(
      at(node('q1', 'user'), 0, 0),
      at(node('a1', 'assistant', ['q1']), 0, 200),
      at(node('lone', 'user'), 800, 0), // 另一棵树，完全不相连
    );
    expect(buildMiniGraph(g, 'a1').nodes.map((n) => n.id).sort()).toEqual(['lone', 'q1']);
  });

  /** 横向沿用画布：哪条分支在左、哪条在右，是用户自己摆的，得留着 */
  it('横向沿用编辑视图的左右关系', () => {
    const g = graph(
      at(node('root', 'user'), 0, 0),
      at(node('left', 'note', ['root']), -400, 300),
      at(node('right', 'note', ['root']), 400, 300),
    );
    const byId = Object.fromEntries(buildMiniGraph(g, 'root').nodes.map((n) => [n.id, n]));
    expect(byId.left!.x).toBeLessThan(byId.right!.x);
  });

  /** 纵向按层级均分：照搬画布的 y 会把画布本身的疏密也搬过来，看着就乱 */
  it('纵向按层级排，同层等高、逐层等距', () => {
    const g = graph(
      at(node('root', 'user'), 0, 0),
      at(node('l', 'note', ['root']), -400, 900), // 画布上被拖得很远
      at(node('r', 'note', ['root']), 400, 200), // 画布上离得很近
      at(node('deep', 'note', ['l']), -400, 1800),
    );
    const byId = Object.fromEntries(buildMiniGraph(g, 'root').nodes.map((n) => [n.id, n]));
    // 同一层的两个节点高度相同，不受画布上相差 700px 的影响
    expect(byId.l!.y).toBe(byId.r!.y);
    // 逐层等距
    expect(byId.l!.y - byId.root!.y).toBe(byId.deep!.y - byId.l!.y);
    expect(byId.deep!.y).toBeGreaterThan(byId.l!.y);
  });

  /** 问答合并后相邻两张卡的层级差 2，直接拿层级当行号会空出一行 */
  it('合并之后行号仍然连续，不留空行', () => {
    const g = graph(
      at(node('q1', 'user'), 0, 0),
      at(node('a1', 'assistant', ['q1']), 0, 200),
      at(node('q2', 'user', ['a1']), 0, 400),
      at(node('a2', 'assistant', ['q2']), 0, 600),
    );
    const ys = buildMiniGraph(g, 'a2').nodes.map((n) => n.y).sort((x, y) => x - y);
    expect(ys).toHaveLength(2);
    expect(ys[1]! - ys[0]!).toBe(34); // 正好一行，不是两行
  });

  it('全在一条竖线上时横向不会除以零', () => {
    const g = graph(
      at(node('a', 'user'), 100, 0),
      at(node('b', 'note', ['a']), 100, 300),
    );
    for (const n of buildMiniGraph(g, 'a').nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(n.x).toBe(0);
    }
  });

  it('标出哪些在当前上下文链上', () => {
    const g = graph(
      at(node('q', 'user'), 0, 0),
      at(node('a1', 'assistant', ['q']), -200, 200),
      at(node('a2', 'assistant', ['q']), 200, 200),
    );
    const byId = Object.fromEntries(buildMiniGraph(g, 'a1').nodes.map((n) => [n.id, n]));
    expect(byId.q!.onPath).toBe(true);
    expect(byId.a1!.onPath).toBe(true);
    expect(byId.a2!.onPath).toBe(false);
  });

  /** 回答被并进提问后，它的下游要改挂到提问上，否则边会指向一个不存在的圆点 */
  it('被并进去的回答，它的出边改从提问出发', () => {
    const g = graph(
      at(node('q', 'user'), 0, 0),
      at(node('a', 'assistant', ['q']), 0, 200),
      at(node('next', 'user', ['a']), 0, 400),
    );
    const m = buildMiniGraph(g, 'next');
    const ids = new Set(m.nodes.map((n) => n.id));
    expect(m.edges.map((e) => e.id)).toEqual(['q->next']);
    for (const e of m.edges) {
      expect(ids.has(e.id.split('->')[0]!)).toBe(true);
      expect(ids.has(e.id.split('->')[1]!)).toBe(true);
    }
  });

  /**
   * 「同时挂着提问和它的回答」这种改挂后会重合的情况其实不可能出现：
   * 那样提问就有两个孩子，pairTurns 根本不会合并它。这条把结论钉住 ——
   * 否则以后有人放宽合并条件时，边会悄悄重复。
   */
  it('同时挂着提问和回答时不合并，三条边都在', () => {
    const g = graph(
      at(node('q', 'user'), 0, 0),
      at(node('a', 'assistant', ['q']), 0, 200),
      at(node('x', 'user', ['a', 'q']), 0, 400),
    );
    const m = buildMiniGraph(g, 'x');
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['a', 'q', 'x']);
    expect(m.edges.map((e) => e.id).sort()).toEqual(['a->x', 'q->a', 'q->x']);
  });

  /** 父节点列表里有重复项（导入的脏数据）时，同一条边不该画两遍 */
  it('重复的父节点只画一条边', () => {
    const g = graph(
      at(node('p', 'user'), 0, 0),
      at(node('c', 'user', ['p', 'p']), 0, 200),
    );
    expect(buildMiniGraph(g, 'c').edges.map((e) => e.id)).toEqual(['p->c']);
  });

  it('坐标非负，尺寸框得住所有点', () => {
    const g = graph(
      at(node('a', 'user'), -500, -300),
      at(node('b', 'user'), 200, 400),
    );
    const m = buildMiniGraph(g, 'a');
    for (const n of m.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(m.width);
      expect(n.y).toBeLessThanOrEqual(m.height);
    }
  });
});

describe('前方预览（给动画留落点）', () => {
  const chain = () =>
    graph(
      node('q1', 'user'),
      node('a1', 'assistant', ['q1']),
      node('q2', 'user', ['a1']),
      node('a2', 'assistant', ['q2']),
      node('q3', 'user', ['a2']),
      node('a3', 'assistant', ['q3']),
    );

  /**
   * 这是整件事的理由：往回翻时，当前这张要滑到「前方」去。
   * 前方没有位置的话它只能从 DOM 里消失，最该有过渡的那张反而是硬切。
   */
  it('停在中间时，前方有下一张', () => {
    const deck = buildDeck(chain(), 'a2');
    expect(deck.ahead.map((c) => c.id)).toEqual(['q3']);
  });

  it('已经在最后一张时，前方是空的', () => {
    expect(buildDeck(chain(), 'a3').ahead).toEqual([]);
  });

  /** 预览不属于上下文链，不能混进 cards 里 */
  it('预览不进 cards，上下文链的语义不变', () => {
    const deck = buildDeck(chain(), 'a2');
    expect(deck.cards.map((c) => c.id)).toEqual(['q1', 'q2']);
    expect(deck.cards.map((c) => c.id)).not.toContain('q3');
  });

  it('有岔路时挑最早的那条当预览', () => {
    const g = graph(
      node('q', 'user'),
      node('a', 'assistant', ['q']),
      node('early', 'user', ['a']),
      node('late', 'user', ['a']),
    );
    expect(buildDeck(g, 'a').ahead.map((c) => c.id)).toEqual(['early']);
  });

  it('空牌堆时前方也是空的', () => {
    expect(buildDeck({}, null).ahead).toEqual([]);
  });
});
