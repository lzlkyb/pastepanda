import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { resolve } from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const projectRoot = __dirname;

/**
 * 移动端独立构建（手机端规划 §5：复用逻辑层、不复用桌面布局层）。
 *
 * 与桌面 vite.config.ts 的关系：
 * - 共享 `@` → src/ 别名：src-mobile 直接 import src/lib 的逻辑层（rcH264/rcFile/stores）
 * - 端口 1422（1420 桌面 dev、1421 桌面 HMR ws，互不抢占）
 * - 产物 dist-mobile：tauri.android.conf.json 的 frontendDist 指向它，
 *   桌面包不带移动页面，APK 不带桌面页面（体积互不污染）
 * - 无 codemirror optimizeDeps：移动端没有编辑器窗口
 */
export default defineConfig(async () => ({
  plugins: [
    react(),
    // 🔴 dev 必须吐 mobile 入口（2026-09-30 真机踩坑）：dev server 的 root 是项目根，
    //    vite 对 `/` 的默认回退是根目录 index.html——那是**桌面**入口，于是
    //    `tauri android dev` 的手机 WebView 里挂起 UpdateProvider / 桌面布局，
    //    移动端组件一个都不加载（真机 logcat 里 React 树 at UpdateProvider/App→桌面）。
    //    把 `/` 与 `/index.html` 改写为 src-mobile/index.html。
    //    ❗ 必须是插件钩子：写在 config 顶层对象里会被 vite 静默忽略（实测）。
    //    build 侧靠下面 rollupOptions.input 指向 mobile 入口，不受影响。
    {
      name: "mobile-entry-rewrite",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/" || req.url === "/index.html") {
            req.url = "/src-mobile/index.html";
          }
          next();
        });
      },
    },
  ],

  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "./src"),
    },
  },

  clearScreen: false,
  // 🔴 必须与桌面 dev 分开缓存目录（2026-10-01 踩坑）：两边默认都写
  //    `node_modules/.vite`，`tauri android dev` 启动时的整体重预构建会把
  //    桌面 vite（还在跑、内存里是旧 metadata）的依赖记录挤掉——桌面端随即
  //    整页 502/504 Outdated Optimize Dep、页面空白。桌面用默认 `.vite`，
  //    移动端挪到 `.vite-mobile`，两路互不可见。
  cacheDir: "node_modules/.vite-mobile",

  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1423,
          overlay: false,
        }
      : { overlay: false },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    outDir: "dist-mobile",
    rollupOptions: {
      input: {
        mobile: resolve(projectRoot, "src-mobile/index.html"),
      },
    },
  },
}));
