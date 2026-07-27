import { describe, expect, it } from 'vitest';
import {
  buildContext,
  collectDescendants,
  computeHidden,
  explainContext,
  isInContext,
  migrateContextMode,
  topoOrder,
  wouldCreateCycle,
} from './context';
import { contentToText, type ResolvedAttachment } from './attachments';
import type { ChatMessage, ChatNode, NodeRole } from '../types';

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
const texts = (msgs: ChatMessage[]) =>
  msgs.map((m) => `${m.role}:${contentToText(m.content)}`);

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

describe('explainContext', () => {
  /** 预览要是和真正发出去的内容对不上，比没有预览更糟 */
  it('entries 和 buildContext 的结果始终一致', () => {
    const memo = node('n', 'note', '批注');
    memo.contextMode = 'include';
    const muted = node('a2', 'assistant', '被静音的回答', ['u1']);
    muted.contextMode = 'exclude';
    const g = graph(
      node('s', 'system', '设定'),
      node('u1', 'user', '问一', ['s']),
      node('a1', 'assistant', '答一', ['u1']),
      muted,
      memo,
      node('u2', 'user', '问二', ['a1', 'a2', 'n']),
    );
    for (const opts of [{}, { systemPrompt: '全局' }, { limit: 2 }, { systemPrompt: '全局', limit: 1 }]) {
      expect(explainContext(g, 'u2', opts).entries.map((e) => e.message)).toEqual(
        buildContext(g, 'u2', opts),
      );
    }
  });

  it('每条消息都能溯源到节点', () => {
    const g = graph(
      node('u1', 'user', '问一'),
      node('a1', 'assistant', '答一', ['u1']),
      node('u2', 'user', '问二', ['a1']),
    );
    const { entries } = explainContext(g, 'u2');
    expect(entries.map((e) => e.sourceIds)).toEqual([['u1'], ['a1'], ['u2']]);
  });

  it('合并的 system 消息记录全部来源节点', () => {
    const g = graph(
      node('s1', 'system', '设定一'),
      node('s2', 'system', '设定二', ['s1']),
      node('u1', 'user', '问', ['s2']),
    );
    const { entries, usedGlobalPrompt } = explainContext(g, 'u1', { systemPrompt: '全局' });
    expect(entries[0]!.message.content).toBe('全局\n\n设定一\n\n设定二');
    expect(entries[0]!.sourceIds).toEqual(['s1', 's2']);
    expect(usedGlobalPrompt).toBe(true);
  });

  it('逐个说明节点被排除的原因', () => {
    const muted = node('a1', 'assistant', '静音的', ['u1']);
    muted.contextMode = 'exclude';
    const failed = node('a2', 'assistant', '出错的', ['u1']);
    failed.status = 'error';
    const g = graph(
      node('u1', 'user', '问'),
      muted,
      failed,
      node('blank', 'user', '   ', ['u1']),
      node('memo', 'note', '批注', ['u1']),
      node('end', 'user', '汇总', ['a1', 'a2', 'blank', 'memo']),
    );
    const byId = Object.fromEntries(
      explainContext(g, 'end').excluded.map((e) => [e.node.id, e.reason]),
    );
    expect(byId).toEqual({ a1: 'muted', a2: 'error', blank: 'empty', memo: 'note' });
  });

  it('报告被 limit 裁掉的条数', () => {
    const g = graph(
      node('u1', 'user', '一'),
      node('a1', 'assistant', '二', ['u1']),
      node('u2', 'user', '三', ['a1']),
    );
    // limit=2 切出 [assistant 二, user 三]，开头的 assistant 还要再丢一条
    expect(explainContext(g, 'u2', { limit: 2 }).trimmed).toBe(2);
    expect(explainContext(g, 'u2', {}).trimmed).toBe(0);
  });

  it('没有全局提示词时如实报告', () => {
    const g = graph(node('u1', 'user', '问'));
    expect(explainContext(g, 'u1').usedGlobalPrompt).toBe(false);
  });
});

describe('知识库注入', () => {
  const hit = (fileName: string, text: string, score = 0.7) => ({
    chunkId: `c-${text}`,
    fileId: 'f1',
    fileName,
    index: 0,
    text,
    score,
  });

  const convo = () =>
    graph(
      node('u1', 'user', '问一'),
      node('a1', 'assistant', '答一', ['u1']),
      node('u2', 'user', '问二', ['a1']),
    );

  it('没有命中时上下文和不传知识库时完全一样', () => {
    const g = convo();
    expect(buildContext(g, 'u2', { knowledge: [] })).toEqual(buildContext(g, 'u2'));
  });

  /** 紧挨着问题，模型不容易在长对话里把资料忘了 */
  it('资料插在最后一条消息之前', () => {
    const out = buildContext(convo(), 'u2', { knowledge: [hit('笔记.md', '资料内容')] });
    expect(texts(out)).toEqual([
      'user:问一',
      'assistant:答一',
      expect.stringContaining('system:'),
      'user:问二',
    ]);
    expect(out[2]!.content).toContain('资料内容');
  });

  it('资料以 system 身份出现，不冒充用户说过的话', () => {
    const out = buildContext(convo(), 'u2', { knowledge: [hit('笔记.md', '资料内容')] });
    expect(out[2]!.role).toBe('system');
    expect(out[3]!.content).toBe('问二'); // 用户自己的话没被污染
  });

  /** 这批资料是为这次提问检索的，被条数上限刷掉毫无道理 */
  it('裁剪之后再插入，不会被 limit 刷掉', () => {
    const out = buildContext(convo(), 'u2', { knowledge: [hit('笔记.md', '资料内容')], limit: 1 });
    expect(texts(out)).toEqual([expect.stringContaining('system:'), 'user:问二']);
    expect(out[0]!.content).toContain('资料内容');
  });

  it('只有一条消息时资料排在它前面', () => {
    const out = buildContext(graph(node('u1', 'user', '问')), 'u1', {
      knowledge: [hit('笔记.md', '资料内容')],
    });
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('和全局提示词共存，各占一条互不吞并', () => {
    const out = buildContext(convo(), 'u2', {
      systemPrompt: '你是助手',
      knowledge: [hit('笔记.md', '资料内容')],
    });
    expect(out[0]!.content).toBe('你是助手');
    expect(out[0]!.content).not.toContain('资料内容');
    expect(out.filter((m) => m.role === 'system')).toHaveLength(2);
  });

  it('explainContext 把命中片段挂在那条消息上，预览能显示出处和分数', () => {
    const hits = [hit('甲.md', '甲内容', 0.81), hit('乙.md', '乙内容', 0.62)];
    const entry = explainContext(convo(), 'u2', { knowledge: hits }).entries.find((e) => e.knowledge);
    expect(entry!.sourceIds).toEqual([]);
    expect(entry!.knowledge!.map((k) => k.score)).toEqual([0.81, 0.62]);
  });

  /** 预览面板和实际发送必须同源，否则比没有预览更糟 */
  it('带知识库时 buildContext 仍等于 explainContext 的 entries', () => {
    const g = convo();
    for (const opts of [
      { knowledge: [hit('a.md', 'x')] },
      { knowledge: [hit('a.md', 'x')], limit: 2 },
      { knowledge: [hit('a.md', 'x')], systemPrompt: '提示' },
      { knowledge: [] },
    ]) {
      expect(buildContext(g, 'u2', opts)).toEqual(
        explainContext(g, 'u2', opts).entries.map((e) => e.message),
      );
    }
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

describe('附件注入', () => {
  const convo = () =>
    graph(node('u1', 'user', '这张图里是什么？'), node('a1', 'assistant', '答', ['u1']));

  const img = (id: string): ResolvedAttachment => ({
    id,
    name: `${id}.png`,
    kind: 'image',
    dataUrl: `data:image/png;base64,${id}`,
  });

  it('不传附件时和以前完全一样', () => {
    const g = convo();
    expect(buildContext(g, 'a1')).toEqual(buildContext(g, 'a1', { attachments: new Map() }));
  });

  it('图片挂到对应节点的消息上', () => {
    const out = buildContext(convo(), 'a1', {
      attachments: new Map([['u1', [img('x')]]]),
    });
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ]);
  });

  /** 模型的回答里不存在「附件」这回事，挂错了会发出去一个非法的 assistant 消息 */
  it('assistant 消息永远不带附件', () => {
    const g = graph(
      node('u1', 'user', '问'),
      node('a1', 'assistant', '答', ['u1']),
      node('u2', 'user', '再问', ['a1']),
    );
    const out = buildContext(g, 'u2', { attachments: new Map([['a1', [img('y')]]]) });
    expect(out[1]!.content).toBe('答');
  });

  it('文本附件展开进正文，仍然是纯字符串', () => {
    const out = buildContext(convo(), 'a1', {
      attachments: new Map([['u1', [{ id: 't', name: '料.md', kind: 'text' as const, text: '材料正文' }]]]),
    });
    expect(typeof out[0]!.content).toBe('string');
    expect(out[0]!.content).toContain('材料正文');
  });

  it('带附件时 buildContext 仍等于 explainContext 的 entries', () => {
    const g = convo();
    const opts = { attachments: new Map([['u1', [img('z')]]]) };
    expect(buildContext(g, 'a1', opts)).toEqual(
      explainContext(g, 'a1', opts).entries.map((e) => e.message),
    );
  });
});

describe('附件与「空节点」的判定', () => {
  const img = (id: string): ResolvedAttachment => ({
    id,
    name: `${id}.png`,
    kind: 'image',
    dataUrl: `data:image/png;base64,${id}`,
  });

  /** 「只丢一张图，一个字不写」是常见用法，正文为空不该让这张图发不出去 */
  it('只有附件没有正文的提问仍然会进上下文', () => {
    const q = node('u1', 'user', '');
    q.attachmentIds = ['x'];
    const g = graph(q, node('a1', 'assistant', '', ['u1']));
    const out = buildContext(g, 'a1', { attachments: new Map([['u1', [img('x')]]]) });
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ]);
  });

  /**
   * 重新生成靠的正是「先清空内容，把节点排除出自己的上下文」。
   * assistant 要是能靠 attachmentIds 绕过这条，那条路径就断了。
   */
  it('assistant 节点即使挂着附件，清空内容后仍算空', () => {
    const a = node('a1', 'assistant', '', ['u1']);
    a.attachmentIds = ['y'];
    const g = graph(node('u1', 'user', '问'), a);
    expect(texts(buildContext(g, 'a1'))).toEqual(['user:问']);
  });

  it('没有附件的空提问照样被跳过', () => {
    const g = graph(node('u1', 'user', ''), node('a1', 'assistant', '', ['u1']));
    expect(buildContext(g, 'a1')).toEqual([]);
  });
});
