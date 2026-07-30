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
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        popup: resolve(projectRoot, "popup.html"),
        editor: resolve(projectRoot, "editor.html"),
        quickpaste: resolve(projectRoot, "quickpaste.html"),
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
