import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
