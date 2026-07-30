import { expect, test } from '@playwright/test';
import { readGraph, seedApp, waitForIdle } from './fixtures';

/**
 * 聚焦视图的落点选择。
 *
 * 「接着问」挂在这一轮的回答后面，「另起分支」挂回这一轮的提问上 ——
 * 两者只差一个父节点，界面上却看不出区别，正是最容易悄悄错掉的那种事：
 * 分支挂错了地方，人要到后面发现上下文不对才反应过来。
 */
const oneTurn = {
  id: 'g1',
  title: '聚焦',
  nodes: [
    { id: 'q', role: 'user' as const, content: '这一轮的提问' },
    { id: 'a', role: 'assistant' as const, content: '这一轮的回答', parents: ['q'] },
  ],
};

test.describe('聚焦视图', () => {
  test.beforeEach(async ({ page }) => {
    await seedApp(page, { view: 'focus', graphs: [oneTurn] });
  });

  test('默认「接着问」：新提问挂在回答后面', async ({ page }) => {
    await expect(page.locator('.focus-anchor button', { hasText: '接着问' })).toHaveClass(/is-on/);

    await page.locator('.focus-input textarea').fill('接着往下问');
    await page.locator('.focus-input button', { hasText: '发送' }).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    const asked = graph.nodes.find((n) => n.content === '接着往下问')!;
    expect(asked.parentIds, '接着问应该挂在回答上').toEqual(['a']);
  });

  test('选「另起分支」：新提问挂回提问上，开出第二条路', async ({ page }) => {
    const fork = page.locator('.focus-anchor button', { hasText: '另起分支' });
    await expect(fork, '一问一答的卡片上它必须可用').toBeEnabled();
    await fork.click();
    await expect(fork).toHaveClass(/is-on/);

    await page.locator('.focus-input textarea').fill('换个方向问');
    await page.locator('.focus-input button', { hasText: '发送' }).click();
    await waitForIdle(page, 'g1');

    const graph = await readGraph(page, 'g1');
    const asked = graph.nodes.find((n) => n.content === '换个方向问')!;
    expect(asked.parentIds, '另起分支应该挂回提问上，不是回答').toEqual(['q']);

    // 提问下面现在有两条路：原来的回答，和刚开的这一条
    const childrenOfQ = graph.nodes.filter((n) => n.parentIds.includes('q'));
    expect(childrenOfQ).toHaveLength(2);
  });

  /*
   * 单节点卡上两个落点是同一个，按钮保持可见但禁用 —— 这是上一版专门修的：
   * 之前它直接不渲染，用户的原话是「分支按钮怎么消失了」。
   */
  test('单节点卡上「另起分支」可见但禁用，并说明原因', async ({ page }) => {
    await seedApp(page, {
      view: 'focus',
      graphs: [{ id: 'g1', title: '只有一问', nodes: [{ id: 'q', role: 'user', content: '还没有回答' }] }],
    });

    const fork = page.locator('.focus-anchor button', { hasText: '另起分支' });
    await expect(fork, '不能藏起来').toBeVisible();
    await expect(fork).toBeDisabled();
    await expect(fork).toHaveAttribute('title', /两个落点是同一个/);
  });
});
