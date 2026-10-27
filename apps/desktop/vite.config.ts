import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * 只有渲染进程走 Vite。主进程由 `bun build --target=node` 单独构建 (见 package.json)。
 * 渲染进程禁止 import @kura/core —— 它需要 Node 内建模块, 只能经 window.kura 走 IPC。
 */
export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
