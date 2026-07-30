import { expect, test } from '@playwright/test';
import { nodeAction, nodeCard, readGraph, seedApp, waitForIdle } from './fixtures';

/**
 * 附件真的随请求发出去了吗。
 *
 * 界面上看到一个文件芯片，不等于它进了请求体 —— 中间隔着「解析成正文」
 * 「拼进 message」两步，任何一步断了，界面照样显示得好好的，模型却什么
 * 都没收到。假服务端把收到的 messages 原样回显，正好把这段暗箱照亮。
 */
test.describe('附件', () => {
  test('文本附件展开成正文，跟着提问一起发出去', async ({ page }) => {
    await seedApp(page, {
      graphs: [
        { id: 'g1', title: '带附件', nodes: [{ id: 'q', role: 'user', content: '按这份资料回答' }] },
      ],
    });

    const card = nodeCard(page, '按这份资料回答');
    await card.hover();
    await card.locator('input[type=file]').setInputFiles({
      name: '资料.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('限流的推荐做法是令牌桶。', 'utf8'),
    });

    // 芯片出现，说明存进去了
    await expect(card.locator('.attach-chip')).toContainText('资料.txt');

    await (await nodeAction(card, '发送')).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    const answer = graph.nodes.find((n) => n.role === 'assistant')!;
    expect(answer.content, '附件正文必须出现在请求体里').toContain('限流的推荐做法是令牌桶。');
    expect(answer.content, '文件名也要带上，模型才知道这是引来的材料').toContain('资料.txt');
    expect(answer.content).toContain('按这份资料回答');
  });

  /*
   * 删掉挂着附件的节点后，附件不能当场删 —— ⌘Z 撤销会把节点原样带回来，
   * 那时附件得还接得上。附件是二进制原件，删了不像节点还躺在撤销栈里。
   */
  test('删节点再撤销，附件接得回来', async ({ page }) => {
    await seedApp(page, {
      graphs: [
        { id: 'g1', title: '附件与撤销', nodes: [{ id: 'q', role: 'user', content: '挂着附件的提问' }] },
      ],
      attachments: [
        { id: 'att1', graphId: 'g1', nodeId: 'q', name: '资料.txt', text: '一些参考资料' },
      ],
    });

    const card = nodeCard(page, '挂着附件的提问');
    await expect(card.locator('.attach-chip')).toContainText('资料.txt');

    await (await nodeAction(card, '✕')).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+z');
    const back = nodeCard(page, '挂着附件的提问');
    await expect(back).toBeVisible();
    await expect(back.locator('.attach-chip'), '撤销回来的节点上附件必须还在').toContainText(
      '资料.txt',
    );
  });
});
