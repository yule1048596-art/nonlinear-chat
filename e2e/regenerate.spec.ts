import { expect, test } from '@playwright/test';
import {
  nodeAction,
  nodeCard,
  readGraph,
  seedApp,
  waitForIdle,
  waitForStreaming,
} from './fixtures';

const oneTurn = (content = '') => ({
  id: 'g1',
  title: '一轮',
  nodes: [
    { id: 'q', role: 'user' as const, content: '这一轮的问题', x: 0, y: 0 },
    { id: 'a', role: 'assistant' as const, content, parents: ['q'], x: 0, y: 220 },
  ],
});

test.describe('停止与重生', () => {
  /*
   * 「停止」保留已经吐出来的部分 —— 这是和「撤销作废」明确区分开的行为：
   * 用户主动按停止时，他要的就是已经生成的那一段。
   */
  test('停止：留下已经生成的部分，状态回到 idle', async ({ page }) => {
    await seedApp(page, { model: 'mock-slow', graphs: [oneTurn()] });

    await (await nodeAction(nodeCard(page, '这一轮的问题'), '发送')).click();
    await waitForStreaming(page);

    const answer = nodeCard(page, 'AI');
    await (await nodeAction(answer, '停止')).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    const a = graph.nodes.find((n) => n.role === 'assistant')!;
    expect(a.status).not.toBe('streaming');
    expect(a.content.length, '停止时已经收到的内容必须留着').toBeGreaterThan(0);
    // 完整回答会以代码块收尾；中途停下就不该有那个结尾
    expect(a.content).not.toContain('const ok = true;');
  });

  /*
   * 重生就地换掉，并排另开一个 —— 后者是这个应用的招牌：
   * 「重新生成一次，上一版好答案没了」正是线性聊天里最烦的事之一。
   */
  test('重生就地替换，节点不增加', async ({ page }) => {
    await seedApp(page, { graphs: [oneTurn('旧的回答')] });

    const before = await readGraph(page, 'g1');
    expect(before.nodes).toHaveLength(2);

    await (await nodeAction(nodeCard(page, '旧的回答'), '重生')).click();
    await waitForIdle(page, 'g1');

    const after = await readGraph(page, 'g1');
    expect(after.nodes, '重生不该多出节点').toHaveLength(2);
    const a = after.nodes.find((n) => n.role === 'assistant')!;
    expect(a.id, '重生是就地改，节点 id 不变').toBe('a');
    expect(a.content).toContain('收到 **1** 条消息');
    expect(a.content, '旧内容应该被换掉').not.toContain('旧的回答');
  });

  test('并排保留旧回答，在旁边多出一个', async ({ page }) => {
    await seedApp(page, { graphs: [oneTurn('旧的回答')] });

    await (await nodeAction(nodeCard(page, '旧的回答'), '并排')).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    expect(graph.nodes, '并排应该多出一个节点').toHaveLength(3);

    const answers = graph.nodes.filter((n) => n.role === 'assistant');
    expect(answers).toHaveLength(2);
    expect(answers.find((n) => n.id === 'a')!.content, '旧回答必须原样留着').toBe('旧的回答');
    // 两个回答挂在同一个提问下 —— 这才叫「同一个问题的另一版」
    for (const a of answers) expect(a.parentIds).toEqual(['q']);
    expect(answers.find((n) => n.id !== 'a')!.content).toContain('收到 **1** 条消息');
  });
});
