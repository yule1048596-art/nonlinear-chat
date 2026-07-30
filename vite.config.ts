import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /*
   * 单元测试只在 src 下。
   *
   * vitest 默认会把 `**\/*.spec.ts` 也收进来 —— 那正是 e2e/ 里 Playwright
   * 用例的后缀，vitest 一加载就炸「did not expect test.describe() to be
   * called here」。本地跑没露馅是因为 npm test 的输出被 tail 掉了，
   * CI 上直接红了一片。
   */
  test: {
    include: ['src/**/*.test.ts'],
  },
  // 相对路径，方便直接部署到 GitHub Pages 之类的子路径下
  base: './',
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // 语法高亮那一坨（highlight.js）比业务代码还大，拆出去让它单独缓存
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/highlight\.js|lowlight|react-markdown|remark|rehype|micromark|mdast|hast/.test(id)) {
            return 'markdown';
          }
          if (id.includes('@xyflow') || id.includes('d3-')) return 'flow';
          if (/[\\/]react(-dom)?[\\/]|scheduler/.test(id)) return 'react';
        },
      },
    },
  },
});
