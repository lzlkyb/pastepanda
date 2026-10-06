import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { resolve } from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const projectRoot = __dirname;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "./src"),
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
          overlay: false,
        }
      : { overlay: false },
    watch: {
      ignored: [
        "**/src-tauri/**",
        // 🔴 非应用页面的产物/文档目录必须排除：vite 对任意被监听的 .html 变更
        // 会向**所有**连接的页面广播整页 reload——别的工具往 docs/、dist-mobile/
        // 写文件时，刚打开的录屏覆盖层等窗口会被反复打断加载、永远到不了就绪
        // （2026-10-06「选区窗 5s 未就绪自动关窗」实录的根因）。src-mobile/ 源码
        // 照常监听，这里只排构建产物与文档。
        "**/docs/**",
        "**/dist-mobile/**",
        "**/.cache/**",
      ],
    },
  },

  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        popup: resolve(projectRoot, "popup.html"),
        editor: resolve(projectRoot, "editor.html"),
        quickpaste: resolve(projectRoot, "quickpaste.html"),
        screenshot: resolve(projectRoot, "screenshot.html"),
        longshot: resolve(projectRoot, "longshot.html"),
        stackhud: resolve(projectRoot, "stackhud.html"),
        rc: resolve(projectRoot, "rc.html"),
        rcask: resolve(projectRoot, "rcask.html"),
        todoisland: resolve(projectRoot, "todoisland.html"),
        rec: resolve(projectRoot, "rec.html"),
        reccontrol: resolve(projectRoot, "rec-control.html"),
        rechud: resolve(projectRoot, "rec-hud.html"),
      },
    },
  },

  // 预构建编辑器依赖：@codemirror/* 是互相引用的小包集合，
  // 不提前 include 会在 dev 首次打开编辑器窗口时逐个按需预构建、反复刷新，
  // 造成明显的打开卡顿。language-data 虽为懒加载，也一并预构建以避免二次卡顿。
  optimizeDeps: {
    include: [
      "@codemirror/commands",
      "@codemirror/lang-markdown",
      "@codemirror/language",
      "@codemirror/language-data",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/theme-one-dark",
      "@codemirror/view",
    ],
  },
}));
