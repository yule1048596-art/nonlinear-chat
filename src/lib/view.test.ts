import { describe, expect, it } from 'vitest';
import { pairTurns, summarize } from './view';
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

describe('summarize', () => {
  it('普通一段话原样返回', () => {
    expect(summarize('怎么把 DAG 转成线性序列')).toBe('怎么把 DAG 转成线性序列');
  });

  it('空内容返回空串', () => {
    expect(summarize('')).toBe('');
    expect(summarize('   \n\n  ')).toBe('');
  });

  it('取第一段有内容的文字，跳过空行', () => {
    expect(summarize('\n\n\n真正的第一行\n第二行')).toBe('真正的第一行');
  });

  /** 首行常常是 `## 标题`，带着井号显示等于白占一行的宽度 */
  it('剥掉标题记号', () => {
    expect(summarize('## 快照保留策略\n\n正文')).toBe('快照保留策略');
    expect(summarize('###### 六级标题')).toBe('六级标题');
  });

  it('剥掉列表、引用记号', () => {
    expect(summarize('- 第一项')).toBe('第一项');
    expect(summarize('1. 第一项')).toBe('第一项');
    expect(summarize('> 引用的话')).toBe('引用的话');
  });

  /** 这条最要紧：AI 回答经常以 ```ts 开头，整行只有语言名，等于什么都没说 */
  it('跳过代码块围栏，取里面的第一行代码', () => {
    expect(summarize('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('剥掉粗体、斜体、行内代码的记号', () => {
    expect(summarize('**重点**在这里')).toBe('重点在这里');
    expect(summarize('用 `buildContext` 生成')).toBe('用 buildContext 生成');
    expect(summarize('*强调*的内容')).toBe('强调的内容');
    expect(summarize('~~删除~~线')).toBe('删除线');
  });

  it('链接只留文字，图片不留孤零零的感叹号', () => {
    expect(summarize('见 [文档](https://example.com) 说明')).toBe('见 文档 说明');
    expect(summarize('![截图](a.png) 后面的话')).toBe('截图 后面的话');
  });

  it('乘号星号不该被当成斜体记号吃掉', () => {
    expect(summarize('3 * 4 = 12')).toBe('3 * 4 = 12');
  });

  it('把换行和连续空白压成单个空格', () => {
    expect(summarize('前面    中间\t后面')).toBe('前面 中间 后面');
  });

  it('超长时截断并加省略号', () => {
    const out = summarize('啊'.repeat(100), 10);
    expect(out).toBe(`${'啊'.repeat(10)}…`);
  });

  it('不超长时不加省略号', () => {
    expect(summarize('短', 10)).toBe('短');
    expect(summarize('啊'.repeat(10), 10)).toBe('啊'.repeat(10));
  });

  /** 按 code unit 截断会把代理对切一半，显示成乱码方块 */
  it('截断不会把 emoji 劈成半个', () => {
    const out = summarize('👨‍👩‍👧🎉🎊🎈🎁', 2);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('�');
    expect([...out.replace('…', '')]).toHaveLength(2);
  });

  it('表格分隔行不会被当成标题', () => {
    expect(summarize('| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |')).toBe('| 列 A | 列 B |');
  });
});

describe('pairTurns', () => {
  it('一问一答合成一张卡', () => {
    const g = graph(node('q', 'user'), node('a', 'assistant', ['q']));
    const { mergedInto, answerOf } = pairTurns(g);
    expect(answerOf.get('q')).toBe('a');
    expect(mergedInto.get('a')).toBe('q');
  });

  /**
   * 这条是整个规则存在的理由：branchRegenerate 会给同一个问题并排生成
   * 多个回答，合进去就没法表达「哪一版」了。
   */
  it('一个问题有两个回答时一律不合并', () => {
    const g = graph(
      node('q', 'user'),
      node('a1', 'assistant', ['q']),
      node('a2', 'assistant', ['q']),
    );
    const { mergedInto, answerOf } = pairTurns(g);
    expect(answerOf.size).toBe(0);
    expect(mergedInto.size).toBe(0);
  });

  /** 回答被两条分支共用时，它属于哪一张卡说不清 */
  it('回答有多个父节点时不合并', () => {
    const g = graph(
      node('q1', 'user'),
      node('q2', 'user'),
      node('a', 'assistant', ['q1', 'q2']),
    );
    expect(pairTurns(g).answerOf.size).toBe(0);
  });

  it('还没有回答的提问不合并', () => {
    expect(pairTurns(graph(node('q', 'user'))).answerOf.size).toBe(0);
  });

  it('子节点不是 assistant 时不合并', () => {
    const g = graph(node('q1', 'user'), node('q2', 'user', ['q1']));
    expect(pairTurns(g).answerOf.size).toBe(0);
  });

  it('system 和 note 不参与配对', () => {
    const g = graph(
      node('sys', 'system'),
      node('a', 'assistant', ['sys']),
      node('memo', 'note'),
      node('a2', 'assistant', ['memo']),
    );
    expect(pairTurns(g).answerOf.size).toBe(0);
  });

  it('一条问答链上的每一对都各自合并', () => {
    const g = graph(
      node('q1', 'user'),
      node('a1', 'assistant', ['q1']),
      node('q2', 'user', ['a1']),
      node('a2', 'assistant', ['q2']),
    );
    const { answerOf } = pairTurns(g);
    expect(answerOf.get('q1')).toBe('a1');
    expect(answerOf.get('q2')).toBe('a2');
    expect(answerOf.size).toBe(2);
  });

  /** 回答自己有几个下游分支，不影响它作为「这一轮的答案」的身份 */
  it('回答带多个子节点仍然可以合并', () => {
    const g = graph(
      node('q', 'user'),
      node('a', 'assistant', ['q']),
      node('f1', 'user', ['a']),
      node('f2', 'user', ['a']),
    );
    expect(pairTurns(g).answerOf.get('q')).toBe('a');
  });

  it('被折叠藏起来的节点不参与配对', () => {
    const g = graph(node('q', 'user'), node('a', 'assistant', ['q']));
    expect(pairTurns(g, new Set(['a'])).answerOf.size).toBe(0);
    expect(pairTurns(g, new Set(['q'])).answerOf.size).toBe(0);
  });

  /** 只有一个可见回答时应该合并，藏起来的那个不算数 */
  it('两个回答里有一个被藏起来时，可见的那个可以合并', () => {
    const g = graph(
      node('q', 'user'),
      node('a1', 'assistant', ['q']),
      node('a2', 'assistant', ['q']),
    );
    expect(pairTurns(g, new Set(['a2'])).answerOf.get('q')).toBe('a1');
  });

  it('空图不出错', () => {
    expect(pairTurns({}).answerOf.size).toBe(0);
  });
});
