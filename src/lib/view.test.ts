import { describe, expect, it } from 'vitest';
import { summarize } from './view';

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
