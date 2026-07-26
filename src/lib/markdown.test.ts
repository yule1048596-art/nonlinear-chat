import { describe, expect, it } from 'vitest';
import { findSiblings, pathToMarkdown } from './markdown';
import type { ChatNode, NodeRole } from '../types';

let clock = 0;
function node(
  id: string,
  role: NodeRole,
  content: string,
  parentIds: string[] = [],
  over: Partial<ChatNode> = {},
): ChatNode {
  clock += 1;
  return {
    id,
    role,
    content,
    parentIds,
    position: { x: 0, y: 0 },
    createdAt: clock,
    updatedAt: clock,
    ...over,
  };
}

const graph = (...nodes: ChatNode[]) => Object.fromEntries(nodes.map((n) => [n.id, n]));
const FIXED = new Date('2026-07-26T10:30:00');

describe('pathToMarkdown', () => {
  it('按对话顺序输出，角色作为二级标题', () => {
    const g = graph(
      node('u1', 'user', '限流选哪种？'),
      node('a1', 'assistant', '令牌桶。', ['u1'], { model: 'mimo-v2.5-pro' }),
      node('u2', 'user', '为什么？', ['a1']),
    );
    const md = pathToMarkdown(g, 'u2', { title: '网关设计', now: FIXED });

    expect(md).toContain('# 网关设计');
    expect(md.indexOf('## 你')).toBeLessThan(md.indexOf('## AI'));
    expect(md).toContain('限流选哪种？');
    expect(md).toContain('令牌桶。');
  });

  it('AI 标题带上模型名，方便对比不同模型的回答', () => {
    const g = graph(
      node('u1', 'user', '问'),
      node('a1', 'assistant', '答', ['u1'], { model: 'deepseek-chat' }),
    );
    expect(pathToMarkdown(g, 'a1', { now: FIXED })).toContain('## AI · deepseek-chat');
  });

  it('没有模型名时只写 AI', () => {
    const g = graph(node('u1', 'user', '问'), node('a1', 'assistant', '答', ['u1']));
    expect(pathToMarkdown(g, 'a1', { now: FIXED })).toContain('## AI\n');
  });

  it('全局提示词写在最前面', () => {
    const g = graph(node('u1', 'user', '问'));
    const md = pathToMarkdown(g, 'u1', { systemPrompt: '用中文回答', now: FIXED });
    expect(md).toContain('## 全局 System 提示词');
    expect(md.indexOf('用中文回答')).toBeLessThan(md.indexOf('## 你'));
  });

  it('没有全局提示词就不写那一节', () => {
    const g = graph(node('u1', 'user', '问'));
    expect(pathToMarkdown(g, 'u1', { now: FIXED })).not.toContain('全局 System');
  });

  /**
   * 导出的是给人读的思考记录，被静音/出错的节点也是过程的一部分。
   * 删掉反而看不懂中间为什么拐弯，所以保留但标注。
   */
  it('保留被排除的节点并标注原因', () => {
    const g = graph(
      node('u1', 'user', '问'),
      node('a1', 'assistant', '跑偏的回答', ['u1'], { contextMode: 'exclude' }),
      node('a2', 'assistant', '超时了', ['u1'], { status: 'error' }),
      node('memo', 'note', '记一笔', ['u1']),
      node('u2', 'user', '再问', ['a1', 'a2', 'memo']),
    );
    const md = pathToMarkdown(g, 'u2', { now: FIXED });

    expect(md).toContain('跑偏的回答');
    expect(md).toContain('已静音');
    expect(md).toContain('这次请求出错了');
    expect(md).toContain('批注默认不进上下文');
  });

  it('只走这一条路径，旁支不导出', () => {
    const g = graph(
      node('u1', 'user', '起点'),
      node('a1', 'assistant', '走这边', ['u1']),
      node('side', 'assistant', '另一条支线', ['u1']),
      node('u2', 'user', '继续', ['a1']),
    );
    const md = pathToMarkdown(g, 'u2', { now: FIXED });
    expect(md).toContain('走这边');
    expect(md).not.toContain('另一条支线');
  });

  it('跳过空节点', () => {
    const g = graph(node('u1', 'user', '问'), node('a1', 'assistant', '   ', ['u1']));
    const md = pathToMarkdown(g, 'a1', { now: FIXED });
    expect(md.match(/^## .+$/gm)).toEqual(['## 你']);
  });

  it('没有标题时用默认名，且以单个换行收尾', () => {
    const g = graph(node('u1', 'user', '问'));
    const md = pathToMarkdown(g, 'u1', { now: FIXED });
    expect(md).toContain('# 未命名画布');
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});

describe('findSiblings', () => {
  it('找出同一个问题下的所有回答，按时间排序', () => {
    const g = graph(
      node('u1', 'user', '问'),
      node('a1', 'assistant', '第一版', ['u1']),
      node('a2', 'assistant', '第二版', ['u1']),
      node('a3', 'assistant', '第三版', ['u1']),
    );
    expect(findSiblings(g, 'a2').map((n) => n.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('父节点集合不同就不算同源', () => {
    const g = graph(
      node('u1', 'user', '问一'),
      node('u2', 'user', '问二'),
      node('a1', 'assistant', '答一', ['u1']),
      node('a2', 'assistant', '答二', ['u2']),
    );
    expect(findSiblings(g, 'a1').map((n) => n.id)).toEqual(['a1']);
  });

  it('多父的情况按集合比较，顺序不影响', () => {
    const g = graph(
      node('x', 'user', 'x'),
      node('y', 'user', 'y'),
      node('a1', 'assistant', '答一', ['x', 'y']),
      node('a2', 'assistant', '答二', ['y', 'x']),
    );
    expect(findSiblings(g, 'a1').map((n) => n.id)).toEqual(['a1', 'a2']);
  });

  it('非回答节点没有可比的兄弟', () => {
    const g = graph(node('u1', 'user', '问'), node('u2', 'user', '也是问'));
    expect(findSiblings(g, 'u1')).toEqual([]);
  });

  it('节点不存在时返回空', () => {
    expect(findSiblings({}, 'nope')).toEqual([]);
  });
});
