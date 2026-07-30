import { expect, test } from '@playwright/test';
import {
  nodeAction,
  nodeCard,
  readGraph,
  seedApp,
  waitForIdle,
  waitForStreaming,
} from './fixtures';

/**
 * 生成到一半切画布。
 *
 * 这条是 v0.12 修的那个 bug 的回归测试，也是最该有 e2e 的一类：涉及
 * store、防抖存盘、React 生命周期三方，纯逻辑测试一条都覆盖不到。
 *
 * 修之前的现象：切走之后流式写入打在**新画布**上 —— 内容写不进去（节点
 * 不在那张图里），但新画布的 updatedAt 被反复刷新（画布列表排序会乱），
 * 而原画布那个节点永远停在 streaming，切回去是一个转不完的圈。
 */
const twoCanvases = [
  { id: 'gA', title: '画布 A', nodes: [{ id: 'qa', role: 'user' as const, content: 'A 的问题' }] },
  { id: 'gB', title: '画布 B', nodes: [{ id: 'qb', role: 'user' as const, content: 'B 的问题' }] },
];

async function switchTo(page: import('@playwright/test').Page, title: string) {
  await page.locator('.toolbar button', { hasText: '画布' }).click();
  await page.locator('.drawer li', { hasText: title }).click();
  await expect(page.locator('.title-input')).toHaveValue(title);
}

test.describe('流式期间切画布', () => {
  test('生成不中断，写回原画布；另一张一个字都不动', async ({ page }) => {
    await seedApp(page, { model: 'mock-slow', graphs: twoCanvases, openGraphId: 'gA' });

    const beforeB = await readGraph(page, 'gB');

    await (await nodeAction(nodeCard(page, 'A 的问题'), '发送')).click();
    await waitForStreaming(page);

    await switchTo(page, '画布 B');
    // 切走之后原画布上的生成要自己跑完
    await waitForIdle(page, 'gA');

    const a = await readGraph(page, 'gA');
    const answer = a.nodes.find((n) => n.role === 'assistant')!;
    expect(answer.status, '不能卡在 streaming').not.toBe('streaming');
    expect(answer.content, '答案要完整生成完').toContain('const ok = true;');
    expect(answer.parentIds).toEqual(['qa']);

    const afterB = await readGraph(page, 'gB');
    expect(afterB.nodes, 'B 不该多出节点').toHaveLength(beforeB.nodes.length);
    expect(afterB.updatedAt, 'B 的 updatedAt 不该被别人的生成刷新').toBe(beforeB.updatedAt);
  });

  test('切回去时答案已经在那儿了', async ({ page }) => {
    await seedApp(page, { model: 'mock-slow', graphs: twoCanvases, openGraphId: 'gA' });

    await (await nodeAction(nodeCard(page, 'A 的问题'), '发送')).click();
    await waitForStreaming(page);
    await switchTo(page, '画布 B');
    await waitForIdle(page, 'gA');
    await switchTo(page, '画布 A');

    await expect(nodeCard(page, 'const ok = true;')).toBeVisible();
    // 转圈的徽章不该还挂着
    await expect(page.locator('.streaming-badge')).toHaveCount(0);
  });

  /*
   * 后台还在生成时把那张画布删掉：必须掐掉并作废，否则它会继续往
   * detached 副本里写、继续排队落盘，把刚删掉的画布一路写回来。
   */
  test('后台生成中删掉那张画布，它不会自己复活', async ({ page }) => {
    await seedApp(page, { model: 'mock-slow', graphs: twoCanvases, openGraphId: 'gA' });
    page.on('dialog', (d) => void d.accept());

    await (await nodeAction(nodeCard(page, 'A 的问题'), '发送')).click();
    await waitForStreaming(page);
    await switchTo(page, '画布 B');

    await page.locator('.toolbar button', { hasText: '画布' }).click();
    await page.locator('.drawer li', { hasText: '画布 A' }).locator('.icon-btn').click();
    await expect(page.locator('.drawer li', { hasText: '画布 A' })).toHaveCount(0);

    // 等到原本那一发怎么也该跑完的时候，再看它有没有把画布带回来
    await page.waitForTimeout(3000);
    await expect
      .poll(async () => (await page.evaluate(async () => {
        const db: IDBDatabase = await new Promise((res, rej) => {
          const req = indexedDB.open('nonlinear-chat');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const all = await new Promise<{ id: string }[]>((res, rej) => {
          const q = db.transaction('graphs').objectStore('graphs').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        db.close();
        return all.map((g) => g.id);
      })).includes('gA'), { message: '被删的画布不该复活' })
      .toBe(false);
  });
});
