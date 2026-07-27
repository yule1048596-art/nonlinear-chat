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
    expect(buildDeck(graph(node('a', 'user')), null)).toEqual({ cards: [], index: -1 });
    expect(buildDeck({}, 'nope')).toEqual({ cards: [], index: -1 });
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
    expect(previousId({ cards: [], index: -1 })).toBe(null);
  });
});

describe('buildMiniGraph', () => {
  it('没有选中节点时是空图', () => {
    expect(buildMiniGraph({}, null).nodes).toEqual([]);
    expect(buildMiniGraph(graph(node('a', 'user')), 'nope').nodes).toEqual([]);
  });

  /** 这是整个改动的理由：只画当前路径的话，导航图就是一条直线，看不出有分叉 */
  it('把挂在链上的分叉一并带进来，而不只是当前路径', () => {
    const g = graph(
      node('q', 'user'),
      node('a1', 'assistant', ['q']),
      node('a2', 'assistant', ['q']), // 平行的另一版回答，不在当前路径上
    );
    const mini = buildMiniGraph(g, 'a1');
    expect(mini.nodes.map((n) => n.id).sort()).toEqual(['a1', 'a2', 'q']);
  });

  it('标出哪些在当前路径上、哪个是当前节点', () => {
    const g = graph(
      node('q', 'user'),
      node('a1', 'assistant', ['q']),
      node('a2', 'assistant', ['q']),
    );
    const byId = Object.fromEntries(buildMiniGraph(g, 'a1').nodes.map((n) => [n.id, n]));
    expect(byId.q!.onPath).toBe(true);
    expect(byId.a1!.onPath).toBe(true);
    expect(byId.a1!.current).toBe(true);
    expect(byId.a2!.onPath).toBe(false);
    expect(byId.a2!.current).toBe(false);
  });

  it('也带上当前节点的下游，能看出这条链通向哪儿', () => {
    const g = graph(
      node('q', 'user'),
      node('a', 'assistant', ['q']),
      node('q2', 'user', ['a']),
      node('a2', 'assistant', ['q2']),
    );
    expect(buildMiniGraph(g, 'a').nodes.map((n) => n.id).sort()).toEqual(['a', 'a2', 'q', 'q2']);
  });

  it('边只连范围内的节点，不会指向图外', () => {
    const g = graph(
      node('q', 'user'),
      node('a', 'assistant', ['q']),
      node('far', 'user', ['a']),
      node('farther', 'assistant', ['far']),
    );
    const mini = buildMiniGraph(g, 'a');
    const ids = new Set(mini.nodes.map((n) => n.id));
    for (const e of mini.edges) {
      expect(ids.has(e.id.split('->')[0]!)).toBe(true);
      expect(ids.has(e.id.split('->')[1]!)).toBe(true);
    }
  });

  it('当前路径上的边被标出来', () => {
    const g = graph(node('q', 'user'), node('a', 'assistant', ['q']), node('b', 'assistant', ['q']));
    const mini = buildMiniGraph(g, 'a');
    expect(mini.edges.find((e) => e.id === 'q->a')?.onPath).toBe(true);
    expect(mini.edges.find((e) => e.id === 'q->b')?.onPath).toBe(false);
  });

  it('坐标非负，尺寸把所有点都框得住', () => {
    const g = graph(
      node('q', 'user'),
      node('a1', 'assistant', ['q']),
      node('a2', 'assistant', ['q']),
      node('m', 'user', ['a1', 'a2']),
    );
    const mini = buildMiniGraph(g, 'm');
    for (const n of mini.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(mini.width);
      expect(n.y).toBeLessThanOrEqual(mini.height);
    }
  });
});
