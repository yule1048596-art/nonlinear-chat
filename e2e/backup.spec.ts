import { expect, test } from '@playwright/test';
import { inventory, seedApp } from './fixtures';

/**
 * 备份往返：导出 → 把库清空（相当于换了一台电脑）→ 导入 → 一样不少。
 *
 * 备份最怕的不是导入失败，是**导入成功但少了东西** —— 少了什么要过很久
 * 才会被发现，那时原始数据可能已经没了。所以这条测的不是「能不能导入」，
 * 是「导进来的和导出去的是不是同一份」，逐项对账，连附件字节数和向量的
 * 每一个数都比。
 */
test.describe('完整备份', () => {
  test('导出 .nexus.zip、清空全库、再导入 —— 一样不少', async ({ page }) => {
    await seedApp(page, {
      graphs: [
        {
          id: 'g1',
          title: '带附件的画布',
          nodes: [
            { id: 'q', role: 'user', content: '一个提问' },
            { id: 'a', role: 'assistant', content: '一个回答', parents: ['q'] },
          ],
        },
        { id: 'g2', title: '带知识库的画布', nodes: [{ id: 'x', role: 'user', content: '另一张' }] },
      ],
      attachments: [
        { id: 'att1', graphId: 'g1', nodeId: 'q', name: '资料.txt', text: '附件的正文内容' },
      ],
      knowledge: [
        {
          id: 'kf1',
          graphId: 'g2',
          name: '手册.md',
          chunks: [
            { id: 'kc1', text: '第一块正文', embedding: [0.5, -0.25, 1] },
            { id: 'kc2', text: '第二块正文', embedding: [0, 1, 0] },
          ],
        },
      ],
    });

    const before = await inventory(page);
    expect(before).toEqual({
      graphs: 2,
      nodes: 3,
      attachments: 1,
      attachmentBytes: 21, // 「附件的正文内容」7 个汉字 × 3 字节
      knowledgeFiles: 1,
      knowledgeChunks: 2,
    });

    // 导出
    await page.locator('.toolbar button', { hasText: '设置' }).click();
    await page.locator('.tab', { hasText: '数据' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button', { hasText: '导出全部' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.nexus\.zip$/);
    const archive = await download.path();
    await page.locator('.drawer.right .icon-btn').first().click();

    // 换一台电脑：把本地全清了
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => {
        const req = indexedDB.open('nonlinear-chat');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const names = ['graphs', 'attachments', 'knowledgeFiles', 'knowledgeChunks'];
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(names, 'readwrite');
        for (const n of names) tx.objectStore(n).clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    });
    await page.reload();
    await expect(page.locator('.title-input')).toHaveValue('未命名画布');

    // 导入（确认框里会先报出包里有多少东西）
    const dialog = page.waitForEvent('dialog');
    await page.locator('.toolbar input[type=file]').setInputFiles(archive);
    const message = (await dialog).message();
    expect(message, '恢复前要说清楚包里有什么').toContain('2 个画布');
    expect(message).toContain('1 个附件');
    expect(message).toContain('1 份知识库资料');
    await (await dialog).accept();

    await expect(page.locator('.toast, [class*=toast]').first()).toContainText('已恢复', {
      timeout: 15_000,
    });

    const after = await inventory(page);
    expect(after, '导进来的必须和导出去的一模一样').toEqual(before);
  });

  test('恢复后附件字节和向量逐值相同，不是只有数量对', async ({ page }) => {
    await seedApp(page, {
      graphs: [{ id: 'g1', title: '往返', nodes: [{ id: 'q', role: 'user', content: '提问' }] }],
      attachments: [{ id: 'att1', graphId: 'g1', nodeId: 'q', name: 'a.txt', text: 'ABCDEF' }],
      knowledge: [
        {
          id: 'kf1',
          graphId: 'g1',
          name: 'k.md',
          chunks: [{ id: 'kc1', text: '正文', embedding: [0.5, -0.25, 0.125] }],
        },
      ],
    });

    const read = () =>
      page.evaluate(async () => {
        const db: IDBDatabase = await new Promise((res, rej) => {
          const req = indexedDB.open('nonlinear-chat');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const all = (name: string) =>
          new Promise<Record<string, unknown>[]>((res, rej) => {
            const q = db.transaction(name).objectStore(name).getAll();
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          });
        const [atts, chunks] = await Promise.all([all('attachments'), all('knowledgeChunks')]);
        db.close();
        const att = atts[0] as { blob: Blob; name: string } | undefined;
        return {
          name: att?.name ?? null,
          bytes: att ? [...new Uint8Array(await att.blob.arrayBuffer())] : [],
          vector: chunks[0] ? [...(chunks[0].embedding as Float32Array)] : [],
        };
      });

    const before = await read();
    expect(before.bytes).toEqual([65, 66, 67, 68, 69, 70]);
    expect(before.vector).toEqual([0.5, -0.25, 0.125]);

    await page.locator('.toolbar button', { hasText: '设置' }).click();
    await page.locator('.tab', { hasText: '数据' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button', { hasText: '导出全部' }).click(),
    ]);
    const archive = await download.path();
    await page.locator('.drawer.right .icon-btn').first().click();

    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => {
        const req = indexedDB.open('nonlinear-chat');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const names = ['graphs', 'attachments', 'knowledgeFiles', 'knowledgeChunks'];
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(names, 'readwrite');
        for (const n of names) tx.objectStore(n).clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    });
    await page.reload();
    await expect(page.locator('.title-input')).toHaveValue('未命名画布');

    page.on('dialog', (d) => void d.accept());
    await page.locator('.toolbar input[type=file]').setInputFiles(archive);
    await expect(page.locator('.toast, [class*=toast]').first()).toContainText('已恢复', {
      timeout: 15_000,
    });

    const after = await read();
    expect(after.name).toBe(before.name);
    expect(after.bytes, '附件字节要一个不差').toEqual(before.bytes);
    expect(after.vector, '向量要逐值相同，否则检索排序会悄悄失真').toEqual(before.vector);
  });
});
