/**
 * 生成 README 用的真实截图（亮 / 暗各一张）。
 *
 * puppeteer 不在 devDependencies 里 —— 它要下载一整个 Chrome，放进依赖会让
 * 每次 CI 都白下一遍。需要重新生成截图时临时装一下：
 *
 *   npm i -D puppeteer
 *   npm run dev            # 另开一个终端
 *   node scripts/screenshot.mjs
 *   npm un -D puppeteer
 *
 * 脚本会自己往 IndexedDB 里塞一个演示画布，不会碰你真实的数据（用的是
 * 独立的临时浏览器 profile）。
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const URL = 'http://localhost:5173';
const OUT = 'docs';
const WIDTH = 1440;
const HEIGHT = 1010;

/** 演示内容：两条独立分支汇入同一个节点——这是本项目区别于线性聊天的核心 */
const DEMO = {
  id: 'showcase',
  title: 'API 网关设计',
  nodes: [
    ['sys', 'system', '你是务实的后端架构师。给取舍，不要罗列所有可能性。', [], 420, 0],
    ['qa', 'user', '网关限流选哪种算法？', ['sys'], 0, 200],
    [
      'aa',
      'assistant',
      '**令牌桶**，除非你明确不想要突发流量。\n\n| 算法 | 取舍 |\n| --- | --- |\n| 固定窗口 | 简单，但临界点会放进双倍流量 |\n| 滑动窗口 | 平滑，内存开销随 QPS 线性涨 |\n| 漏桶 | 恒定速率，突发直接丢 |\n| 令牌桶 | 允许攒额度应对突发 |\n\n网关前面通常有 CDN 削峰，真正打进来的突发是有价值的正常流量，不该丢。',
      ['qa'],
      0,
      340,
    ],
    ['qb', 'user', '热点 key 的缓存失效怎么处理？', ['sys'], 860, 200],
    [
      'ab',
      'assistant',
      '**逻辑过期 + 异步重建**。\n\n物理不过期，value 里存一个过期时间戳。读到过期值就先返回旧数据，同时起一个异步任务去重建。\n\n```js\nif (Date.now() > v.expireAt && lock.tryAcquire(key)) {\n  queue.push(() => rebuild(key));\n}\nreturn v.data; // 旧数据先顶上\n```\n\n代价是有短暂脏读。换来的是热点 key 过期瞬间不会有几千个请求同时穿透到数据库。',
      ['qb'],
      860,
      340,
    ],
    ['merge', 'user', '把这两点结合起来，设计网关侧的完整方案', ['aa', 'ab'], 420, 820],
  ],
};

async function seed(page, demo) {
  await page.evaluate(async (d) => {
    const t = Date.now();
    const nodes = Object.fromEntries(
      d.nodes.map(([id, role, content, parentIds, x, y], i) => [
        id,
        {
          id,
          role,
          content,
          parentIds,
          position: { x, y },
          createdAt: t + i * 1000,
          updatedAt: t,
          ...(role === 'assistant' ? { model: 'mimo-v2.5-pro' } : {}),
        },
      ]),
    );
    const graph = { id: d.id, title: d.title, nodes, createdAt: t, updatedAt: t };
    await new Promise((res) => {
      const q = indexedDB.open('nonlinear-chat');
      q.onsuccess = () => {
        const tx = q.result.transaction(['graphs', 'kv'], 'readwrite');
        tx.objectStore('graphs').put(graph);
        tx.objectStore('kv').put(d.id, 'lastGraphId');
        tx.oncomplete = res;
      };
    });
  }, demo);
}

async function shoot(browser, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });

  // 先开一次把 IndexedDB 建起来，塞好数据再刷新
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await seed(page, DEMO);
  await page.evaluate((t) => localStorage.setItem('nexus-theme', t), theme);
  await page.reload({ waitUntil: 'networkidle0' });

  // 选中合并节点，让「这一发会带上哪些上下文」的高亮显示出来
  await page.waitForSelector('.node');
  await page.evaluate(() => {
    const merge = [...document.querySelectorAll('.node')].find((n) =>
      (n.querySelector('textarea')?.value || '').includes('结合起来'),
    );
    const head = merge?.querySelector('.node-head');
    for (const type of ['mousedown', 'mouseup', 'click']) {
      head?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => document.querySelector('.react-flow__controls-fitview')?.click());
  await new Promise((r) => setTimeout(r, 900)); // 等 fitView 动画走完

  const path = `${OUT}/canvas-${theme}.png`;
  await page.screenshot({ path });
  console.log(`✓ ${path}`);
  await page.close();
}

const browser = await puppeteer.launch({ headless: 'new' });
await mkdir(OUT, { recursive: true });
for (const theme of ['dark', 'light']) await shoot(browser, theme);
await browser.close();
