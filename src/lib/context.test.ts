import { describe, expect, it } from 'vitest';
import {
  buildContext,
  collectDescendants,
  computeHidden,
  isInContext,
  migrateContextMode,
  topoOrder,
  wouldCreateCycle,
} from './context';
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

  it('批注默认不进上下文，设为 include 后作为 user 消息进', () => {
    const first = node('u1', 'user', '问一');
    const memo = node('n', 'note', '记一笔：注意并发'); // 建得比 u1 晚，所以排在它后面
    const g = graph(first, memo, node('u2', 'user', '问二', ['u1', 'n']));
    expect(texts(buildContext(g, 'u2'))).toEqual(['user:问一', 'user:问二']);

    memo.contextMode = 'include';
    expect(texts(buildContext(g, 'u2'))).toEqual([
      'user:问一',
      'user:记一笔：注意并发',
      'user:问二',
    ]);
  });

  it('任意角色都能被静音', () => {
    const bad = node('a1', 'assistant', '这个回答是错的', ['u1']);
    const g = graph(node('u1', 'user', '问一'), bad, node('u2', 'user', '再问', ['a1']));
    expect(texts(buildContext(g, 'u2'))).toEqual(['user:问一', 'assistant:这个回答是错的', 'user:再问']);

    bad.contextMode = 'exclude';
    expect(texts(buildContext(g, 'u2'))).toEqual(['user:问一', 'user:再问']);
  });

  it('静音优先级高于一切，system 也能被静音', () => {
    const sys = node('s', 'system', '设定');
    sys.contextMode = 'exclude';
    const g = graph(sys, node('u1', 'user', '问一', ['s']));
    expect(texts(buildContext(g, 'u1'))).toEqual(['user:问一']);
  });

  /**
   * 「空节点永远跳过」必须优先于 include，否则重新生成会断：
   * run() 靠先清空内容把节点排除出它自己的上下文。
   */
  it('include 不能把空节点强行塞进上下文', () => {
    const blank = node('a1', 'assistant', '', ['u1']);
    blank.contextMode = 'include';
    const g = graph(node('u1', 'user', '问一'), blank);
    expect(texts(buildContext(g, 'a1'))).toEqual(['user:问一']);
  });
});

describe('buildContext · 其余', () => {
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
    // limit=2 会切出 [assistant 二, user 三]，开头的 assistant 要被丢掉
    expect(texts(buildContext(g, 'u2', { limit: 2 }))).toEqual(['system:设定', 'user:三']);
  });

  /**
   * 从后往前裁剪很容易正好切在一问一答中间。留着开头的 assistant，
   * 对话读起来就是模型凭空接了半句话，部分服务商还会直接拒绝。
   */
  it('裁剪后不会以 assistant 开头', () => {
    const g = graph(
      node('u1', 'user', '问一'),
      node('a1', 'assistant', '答一', ['u1']),
      node('u2', 'user', '问二', ['a1']),
      node('a2', 'assistant', '答二', ['u2']),
      node('u3', 'user', '问三', ['a2']),
    );
    for (const limit of [1, 2, 3, 4, 5]) {
      const msgs = buildContext(g, 'u3', { limit });
      const body = msgs.filter((m) => m.role !== 'system');
      if (body.length) expect(body[0]!.role).toBe('user');
    }
  });

  it('limit 大于实际条数时原样返回', () => {
    const g = graph(node('u1', 'user', '问一'), node('a1', 'assistant', '答一', ['u1']));
    expect(texts(buildContext(g, 'a1', { limit: 99 }))).toEqual(['user:问一', 'assistant:答一']);
  });
});

describe('migrateContextMode', () => {
  it('includeInContext=true 迁移成 include 并去掉旧字段', () => {
    const memo = node('n', 'note', '批注');
    memo.includeInContext = true;
    const out = migrateContextMode(graph(memo));
    expect(out.n!.contextMode).toBe('include');
    expect('includeInContext' in out.n!).toBe(false);
  });

  it('includeInContext=false 迁移成 auto', () => {
    const memo = node('n', 'note', '批注');
    memo.includeInContext = false;
    expect(migrateContextMode(graph(memo)).n!.contextMode).toBe('auto');
  });

  it('没有旧字段的节点原样返回同一个对象引用', () => {
    const g = graph(node('u1', 'user', '问一'));
    expect(migrateContextMode(g)).toBe(g);
  });

  it('已经有 contextMode 的不被旧字段覆盖', () => {
    const n1 = node('n', 'note', '批注');
    n1.includeInContext = true;
    n1.contextMode = 'exclude';
    expect(migrateContextMode(graph(n1)).n!.contextMode).toBe('exclude');
  });
});

describe('isInContext', () => {
  it('按角色给出默认值', () => {
    expect(isInContext(node('u', 'user', 'x'))).toBe(true);
    expect(isInContext(node('a', 'assistant', 'x'))).toBe(true);
    expect(isInContext(node('s', 'system', 'x'))).toBe(true);
    expect(isInContext(node('n', 'note', 'x'))).toBe(false);
  });

  it('显式设置覆盖默认值', () => {
    const memo = node('n', 'note', 'x');
    memo.contextMode = 'include';
    expect(isInContext(memo)).toBe(true);

    const user = node('u', 'user', 'x');
    user.contextMode = 'exclude';
    expect(isInContext(user)).toBe(false);
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

describe('computeHidden', () => {
  const collapse = (n: ChatNode) => {
    n.subtreeCollapsed = true;
    return n;
  };

  it('没有折叠时什么都不藏', () => {
    const g = graph(node('a', 'user', 'a'), node('b', 'assistant', 'b', ['a']));
    expect([...computeHidden(g)]).toEqual([]);
  });

  it('折叠节点自身可见，后代被隐藏', () => {
    const g = graph(
      node('root', 'user', 'root'),
      collapse(node('x', 'assistant', 'x', ['root'])),
      node('y', 'user', 'y', ['x']),
      node('z', 'user', 'z', ['y']),
    );
    const hidden = computeHidden(g);
    expect(hidden.has('x')).toBe(false);
    expect([...hidden].sort()).toEqual(['y', 'z']);
  });

  /**
   * 这条是整个函数存在的理由：汇合节点同时挂在被折叠的分支和可见分支下面。
   * 天真的「隐藏所有后代」写法会把它错误地藏掉，等于吞掉一条可见路径的终点。
   */
  it('菱形结构：汇合节点只要还有一条未折叠的来路就保持可见', () => {
    const g = graph(
      node('root', 'user', 'root'),
      collapse(node('left', 'assistant', '左（已折叠）', ['root'])),
      node('right', 'assistant', '右', ['root']),
      node('join', 'user', '汇合', ['left', 'right']),
      node('after', 'assistant', '汇合之后', ['join']),
    );
    const hidden = computeHidden(g);
    expect(hidden.has('join')).toBe(false);
    expect(hidden.has('after')).toBe(false);
    expect([...hidden]).toEqual([]);
  });

  it('菱形结构：两条来路都折叠了，汇合节点才隐藏', () => {
    const g = graph(
      node('root', 'user', 'root'),
      collapse(node('left', 'assistant', '左', ['root'])),
      collapse(node('right', 'assistant', '右', ['root'])),
      node('join', 'user', '汇合', ['left', 'right']),
    );
    expect([...computeHidden(g)]).toEqual(['join']);
  });

  it('嵌套折叠不会互相干扰', () => {
    const g = graph(
      collapse(node('a', 'user', 'a')),
      collapse(node('b', 'assistant', 'b', ['a'])),
      node('c', 'user', 'c', ['b']),
    );
    expect([...computeHidden(g)].sort()).toEqual(['b', 'c']);
  });

  it('父节点已被删除的悬空节点当成根，不会凭空消失', () => {
    const g = graph(node('orphan', 'user', '父节点已删除', ['gone']));
    expect([...computeHidden(g)]).toEqual([]);
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
