import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端测试。
 *
 * 单元测试全在纯逻辑层，跨组件的流程一条都守不住 —— v0.12 修的「切画布不
 * 中断生成」「备份往返」「附件 GC」全是这一类，当时只能一条条手动在浏览器里
 * 验；下次谁改动碰坏了，不会有人告诉你。这里补的就是那层护栏。
 *
 * 两个服务端一起起：
 * - dev server：被测的应用本身
 * - mock server：假的 OpenAI 兼容端点，把收到的 messages 原样回显 ——
 *   这是验证「DAG 拼出来的上下文对不对」唯一可靠的手段，光看界面看不出
 *   到底发了什么出去。出片速度由模型名决定（mock-fast / mock-slow）。
 */
export default defineConfig({
  testDir: './e2e',
  // 竞态用例（流式期间切画布）依赖真实时序，并发跑会互相打架
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // 失败时能看到当时长什么样，比读断言消息猜快得多
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
    },
    {
      command: 'node scripts/mock-server.mjs',
      url: 'http://localhost:8787/v1/models',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
    },
  ],
});
