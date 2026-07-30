import { describe, expect, it } from 'vitest';
import { demoGraph } from './demo';
import { buildContext, explainContext, topoOrder } from './context';
import { pairTurns } from './view';

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const build = () => demoGraph(ids(), 1_700_000_000_000);

const nodesOf = (g = build()) => Object.values(g.nodes);
const byContent = (g: ReturnType<typeof build>, needle: string) =>
  Object.values(g.nodes).find((n) => n.content.includes(needle))!;

describe('demoGraph', () => {
  it('id 全部来自传进去的生成器，不会和真实画布撞车', () => {
    const g = build();
    const all = [g.id, ...Object.keys(g.nodes)];
    expect(all.every((id) => /^id-\d+$/.test(id))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it('父子引用都指向图里真实存在的节点', () => {
    const g = build();
    for (const node of Object.values(g.nodes)) {
      for (const parent of node.parentIds) expect(g.nodes[parent]).toBeDefined();
    }
  });

  /*
   * 这是整张示例画布存在的理由。
   *
   * 它要一眼讲清楚「一个节点可以有多个父节点」—— 树做不到的那件事。
   * 少了这条，示例就退化成一段普通的线性对话，不如不放。
   */
  it('有一个节点同时挂着两条分支（多父合并）', () => {
    const g = build();
    const merged = Object.values(g.nodes).filter((n) => n.parentIds.length > 1);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.parentIds).toHaveLength(2);
    expect(merged[0]!.role).toBe('user');
  });

  it('两条分支各自独立，汇合之前互不可达', () => {
    const g = build();
    const a1 = byContent(g, '令牌桶');
    const a2 = byContent(g, '逻辑过期');
    // 谁也不是谁的祖先
    expect(topoOrder(g.nodes, a1.id).some((n) => n.id === a2.id)).toBe(false);
    expect(topoOrder(g.nodes, a2.id).some((n) => n.id === a1.id)).toBe(false);
  });

  /** 合并之后模型看到的是完整五条 + system，这正是底部状态条会报的数 */
  it('从汇合点发出去时，两条分支的内容都在上下文里', () => {
    const g = build();
    const merged = Object.values(g.nodes).find((n) => n.parentIds.length > 1)!;
    const messages = buildContext(g.nodes, merged.id);

    expect(messages[0]!.role).toBe('system');
    const body = messages.map((m) => String(m.content)).join('\n');
    expect(body).toContain('令牌桶'); // 左边那条分支
    expect(body).toContain('逻辑过期'); // 右边那条分支
    expect(messages.filter((m) => m.role !== 'system')).toHaveLength(5);
  });

  it('合并后的顺序是「先限流那条、后缓存那条」，不是两条交错', () => {
    const g = build();
    const merged = Object.values(g.nodes).find((n) => n.parentIds.length > 1)!;
    const text = buildContext(g.nodes, merged.id).map((m) => String(m.content));
    const 限流 = text.findIndex((t) => t.includes('令牌桶'));
    const 缓存 = text.findIndex((t) => t.includes('逻辑过期'));
    expect(限流).toBeGreaterThan(-1);
    expect(限流).toBeLessThan(缓存);
  });

  /** 批注是用来解释这张画布的，不该混进发给模型的内容里 */
  it('批注节点不进上下文', () => {
    const g = build();
    const note = Object.values(g.nodes).find((n) => n.role === 'note')!;
    expect(note.parentIds).toEqual([]);
    const last = Object.values(g.nodes).find((n) => n.content.includes('顺序不能反'))!;
    const entries = explainContext(g.nodes, last.id).entries;
    expect(entries.some((e) => e.sourceIds.includes(note.id))).toBe(false);
  });

  /*
   * 回答是手写的样例文字，不是模型输出。挂上模型名就等于伪造了一条
   * 「某某模型说过这话」的记录 —— 演示可以是假的，但不能假装不是。
   */
  it('回答不挂模型名，也不带用量数据', () => {
    for (const node of nodesOf()) {
      expect(node.model).toBeUndefined();
      expect(node.profileId).toBeUndefined();
      expect(node.usage).toBeUndefined();
    }
  });

  it('批注里写明了这是示例、回答是手写的', () => {
    const note = nodesOf().find((n) => n.role === 'note')!;
    expect(note.content).toContain('示例画布');
    expect(note.content).toContain('不是模型输出');
  });

  /*
   * 只有 AI 节点会渲染 Markdown，提问 / 系统 / 批注都是纯文本框。
   * 在那三种里写星号会原样显示成 `**这样**` —— 示例画布上的排版错字
   * 是所有人看到的第一样东西。
   */
  it('非 AI 节点里不带 Markdown 标记', () => {
    for (const node of nodesOf()) {
      if (node.role === 'assistant') continue;
      expect(node.content, `${node.role} 节点里有 Markdown 标记`).not.toMatch(/\*\*|^[-*] |^#+ /m);
    }
  });

  it('没有半路留下的空节点或残留状态', () => {
    for (const node of nodesOf()) {
      expect(node.content.trim().length).toBeGreaterThan(0);
      expect(node.status).toBeUndefined();
      expect(node.error).toBeUndefined();
    }
  });

  /*
   * 排版是这张画布的内容的一部分：一眼看上去必须是「两条并排的路往下汇成一个点」。
   *
   * 不去猜卡片高度（正文一改就飘），只钉住两条会毁掉这个形状的硬约束。
   */
  it('孩子永远排在父节点下方，边不会往回走', () => {
    const g = build();
    for (const node of Object.values(g.nodes)) {
      for (const parentId of node.parentIds) {
        const parent = g.nodes[parentId]!;
        expect(
          node.position.y,
          `${parent.content.slice(0, 8)} → ${node.content.slice(0, 8)} 这条边是往上走的`,
        ).toBeGreaterThan(parent.position.y);
      }
    }
  });

  it('两条分支各占一列，横向不重叠', () => {
    const g = build();
    const 左 = byContent(g, '选哪种算法').position.x;
    const 右 = byContent(g, '缓存雪崩').position.x;
    // 卡片宽 380，列间至少留出一整张卡的距离，才看得出是「两条」而不是一团
    expect(Math.abs(左 - 右)).toBeGreaterThanOrEqual(380 * 2);
    // 同一条分支上的问答必须严格对齐，否则看着像散落的卡片而不是一条路
    expect(byContent(g, '令牌桶').position.x).toBe(左);
    expect(byContent(g, '逻辑过期').position.x).toBe(右);
  });

  it('汇合点落在两条分支中间', () => {
    const g = build();
    const 左 = byContent(g, '选哪种算法').position.x;
    const 右 = byContent(g, '缓存雪崩').position.x;
    const 汇合 = Object.values(g.nodes).find((n) => n.parentIds.length > 1)!;
    expect(汇合.position.x).toBe((左 + 右) / 2);
  });

  /** 一问一答会在地图/聚焦视图里并成一张卡，示例里三轮都该并得起来 */
  it('三轮问答在地图视图里各并成一张卡', () => {
    const g = build();
    const { mergedInto } = pairTurns(g.nodes);
    expect(mergedInto.size).toBe(3);
  });

  it('每次生成的都是新的一份，改一份不会影响另一份', () => {
    const a = build();
    const b = build();
    expect(a.id).toBe(b.id); // 同一个确定性的 id 生成器
    const first = Object.values(a.nodes)[0]!;
    first.content = '被改过了';
    expect(Object.values(b.nodes)[0]!.content).not.toBe('被改过了');
  });
});
