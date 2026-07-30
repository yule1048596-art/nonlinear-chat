import { expect, test } from '@playwright/test';
import { nodeAction, nodeCard, readGraph, seedApp, typeInNode, waitForIdle } from './fixtures';

/**
 * 首次发送 —— 最基本的一条路：打字 → 发送 → 回答落地。
 *
 * 顺带把「DAG 拼出来的上下文对不对」也钉住。假服务端会把收到的 messages
 * 原样回显进正文，所以断言回答内容就等于断言了请求体 —— 这是光看界面
 * 永远看不出来的那一半。
 */
test.describe('发送', () => {
  test('打字、发送、回答落进画布', async ({ page }) => {
    await seedApp(page, {
      graphs: [{ id: 'g1', title: '测试画布', nodes: [{ id: 'q', role: 'user', content: '' }] }],
    });

    const card = nodeCard(page, '');
    await typeInNode(card, '限流选哪种算法？');
    await (await nodeAction(card, '发送')).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    const answer = graph.nodes.find((n) => n.role === 'assistant');
    expect(answer, '应该多出一个 assistant 节点').toBeTruthy();
    expect(answer!.parentIds).toEqual(['q']);
    // 假服务端回显收到的 messages：这一发只该有一条 user
    expect(answer!.content).toContain('收到 **1** 条消息');
    expect(answer!.content).toContain('限流选哪种算法？');

    await expect(nodeCard(page, '收到 **1** 条消息').or(nodeCard(page, '条消息'))).toBeVisible();
  });

  /*
   * 这条是整个应用存在的理由：两条独立分支汇进同一个提问，模型必须一次
   * 看到两条分支的全部内容，而且顺序按真实发生的时间交错、不能乱。
   *
   * 单元测试里 buildContext 已经测过了，但那是纯函数。这里测的是从画布
   * 到 HTTP 请求体这一整条链路上没人把它弄丢。
   */
  test('多父合并：两条分支的内容都进了同一个请求，且顺序不乱', async ({ page }) => {
    await seedApp(page, {
      systemPrompt: '',
      graphs: [
        {
          id: 'g1',
          title: '汇合',
          nodes: [
            { id: 'sys', role: 'system', content: '你是资深后端工程师。', x: 400, y: -200 },
            { id: 'q1', role: 'user', content: '左边：限流', parents: ['sys'], x: 0, y: 0 },
            { id: 'a1', role: 'assistant', content: '左边的回答', parents: ['q1'], x: 0, y: 200 },
            { id: 'q2', role: 'user', content: '右边：缓存', parents: ['sys'], x: 800, y: 0 },
            { id: 'a2', role: 'assistant', content: '右边的回答', parents: ['q2'], x: 800, y: 200 },
            { id: 'q3', role: 'user', content: '合起来看', parents: ['a1', 'a2'], x: 400, y: 460 },
          ],
        },
      ],
    });

    const merge = nodeCard(page, '合起来看');
    await (await nodeAction(merge, '发送')).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    const answer = graph.nodes.find((n) => n.parentIds.includes('q3') && n.role === 'assistant')!;

    // system 抽出来单列一条，其余 5 条按时间交错
    expect(answer.content).toContain('收到 **6** 条消息');
    const body = answer.content;
    for (const piece of ['你是资深后端工程师。', '左边：限流', '左边的回答', '右边：缓存', '右边的回答', '合起来看']) {
      expect(body, `请求体里少了「${piece}」`).toContain(piece);
    }
    // 顺序：system 最前，然后左边整条，再右边整条，最后汇合点
    const at = (s: string) => body.indexOf(s);
    expect(at('你是资深后端工程师。')).toBeLessThan(at('左边：限流'));
    expect(at('左边：限流')).toBeLessThan(at('左边的回答'));
    expect(at('左边的回答')).toBeLessThan(at('右边：缓存'));
    expect(at('右边：缓存')).toBeLessThan(at('右边的回答'));
    expect(at('右边的回答')).toBeLessThan(at('合起来看'));
  });
});
