import { describe, expect, it } from 'vitest';
import { buildContext, collectDescendants, topoOrder, wouldCreateCycle } from './context';
import type { ChatNode, NodeRole } from '../types';

let clock = 0;

function node(id: string, role: NodeRole, content: string, parentIds: string[] = []): ChatNode {
  clock += 1;
  return {
    id,
    role,
    content,
    parentIds,
    position: { x: 0, y: 0 },
    createdAt: clock,
    updatedAt: clock,
  };
}

function graph(...nodes: ChatNode[]) {
  return Object.fromEntries(nodes.map((n) => [n.id, n]));
}

const roles = (nodes: ChatNode[]) => nodes.map((n) => n.id);
const texts = (msgs: { role: string; content: string }[]) =>
  msgs.map((m) => `${m.role}:${m.content}`);

describe('topoOrder', () => {
  it('沿着单链把祖先按顺序排出来', () => {
    const g = graph(
      node('u1', 'user', '问一'),
      node('a1', 'assistant', '答一', ['u1']),
      node('u2', 'user', '问二', ['a1']),
    );
    expect(roles(topoOrder(g, 'u2'))).toEqual(['u1', 'a1', 'u2']);
  });

  it('只取祖先，旁支不进上下文', () => {
    const g = graph(
      node('u1', 'user', '问一'),
      node('a1', 'assistant', '答一', ['u1']),
      node('side', 'user', '另一条支线', ['u1']),
      node('u2', 'user', '问二', ['a1']),
    );
    expect(roles(topoOrder(g, 'u2'))).toEqual(['u1', 'a1', 'u2']);
  });

  it('多父合并时按时间交错，且每条分支内部保持因果顺序', () => {
    const g = graph(
      node('au', 'user', 'A问'),
      node('aa', 'assistant', 'A答', ['au']),
      node('bu', 'user', 'B问'),
      node('ba', 'assistant', 'B答', ['bu']),
      node('merge', 'user', '合起来', ['aa', 'ba']),
    );
    expect(roles(topoOrder(g, 'merge'))).toEqual(['au', 'aa', 'bu', 'ba', 'merge']);
  });

  it('菱形结构里共同祖先只出现一次', () => {
    const g = graph(
      node('root', 'user', '起点'),
      node('l', 'assistant', '左', ['root']),
      node('r', 'assistant', '右', ['root']),
      node('join', 'user', '汇合', ['l', 'r']),
    );
    const order = roles(topoOrder(g, 'join'));
    expect(order).toEqual(['root', 'l', 'r', 'join']);
    expect(order.filter((id) => id === 'root')).toHaveLength(1);
  });

  it('父节点先于子节点，哪怕子节点建得更早', () => {
    const child = node('child', 'user', '后接上的父亲');
    const parent = node('parent', 'assistant', '晚建但是父亲');
    child.parentIds = [parent.id]; // 事后连线：child.createdAt < parent.createdAt
    const g = graph(child, parent);
    expect(roles(topoOrder(g, 'child'))).toEqual(['parent', 'child']);
  });
});

describe('buildContext', () => {
  it('system 节点合并进一条 system 消息，排在最前面', () => {
    const g = graph(
      node('s', 'system', '你是一个严谨的评审'),
      node('u1', 'user', '看看这段代码', ['s']),
      node('a1', 'assistant', '有三个问题', ['u1']),
    );
    expect(texts(buildContext(g, 'a1', { systemPrompt: '全局设定' }))).toEqual([
      'system:全局设定\n\n你是一个严谨的评审',
      'user:看看这段代码',
      'assistant:有三个问题',
    ]);
  });

  it('空节点被跳过 —— 重新生成正是靠这个复用同一条路径', () => {
    const g = graph(
      node('u1', 'user', '问一'),
      node('a1', 'assistant', '', ['u1']), // 正要重新生成的节点
    );
    expect(texts(buildContext(g, 'a1'))).toEqual(['user:问一']);
  });

  it('批注默认不进上下文，勾选后作为 user 消息进', () => {
    const first = node('u1', 'user', '问一');
    const memo = node('n', 'note', '记一笔：注意并发'); // 建得比 u1 晚，所以排在它后面
    const g = graph(first, memo, node('u2', 'user', '问二', ['u1', 'n']));
    expect(texts(buildContext(g, 'u2'))).toEqual(['user:问一', 'user:问二']);

    memo.includeInContext = true;
    expect(texts(buildContext(g, 'u2'))).toEqual([
      'user:问一',
      'user:记一笔：注意并发',
      'user:问二',
    ]);
  });

  it('出错的节点不会把报错内容带进下一轮', () => {
    const bad = node('a1', 'assistant', '限流了', ['u1']);
    bad.status = 'error';
    const g = graph(node('u1', 'user', '问一'), bad, node('u2', 'user', '再问', ['a1']));
    expect(texts(buildContext(g, 'u2'))).toEqual(['user:问一', 'user:再问']);
  });

  it('limit 只裁剪对话消息，system 永远保留', () => {
    const g = graph(
      node('s', 'system', '设定'),
      node('u1', 'user', '一', ['s']),
      node('a1', 'assistant', '二', ['u1']),
      node('u2', 'user', '三', ['a1']),
    );
    expect(texts(buildContext(g, 'u2', { limit: 2 }))).toEqual([
      'system:设定',
      'assistant:二',
      'user:三',
    ]);
  });
});

describe('wouldCreateCycle', () => {
  const g = graph(
    node('a', 'user', 'a'),
    node('b', 'assistant', 'b', ['a']),
    node('c', 'user', 'c', ['b']),
    node('loose', 'user', '游离节点'),
  );

  it('拦住自环和反向连线', () => {
    expect(wouldCreateCycle(g, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(g, 'c', 'a')).toBe(true); // c 是 a 的后代
    expect(wouldCreateCycle(g, 'b', 'a')).toBe(true);
  });

  it('放行合法的新连线', () => {
    expect(wouldCreateCycle(g, 'loose', 'c')).toBe(false);
    expect(wouldCreateCycle(g, 'a', 'loose')).toBe(false);
  });
});

describe('collectDescendants', () => {
  it('级联删除时把整棵子树都收上来', () => {
    const g = graph(
      node('root', 'user', 'root'),
      node('x', 'assistant', 'x', ['root']),
      node('y', 'user', 'y', ['x']),
      node('z', 'user', 'z', ['x']),
      node('other', 'user', 'other'),
    );
    expect([...collectDescendants(g, 'x')].sort()).toEqual(['x', 'y', 'z']);
    expect(collectDescendants(g, 'x').has('other')).toBe(false);
  });
});
