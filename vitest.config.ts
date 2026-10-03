import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [path.resolve(__dirname, "./src/test-setup.ts")],
    // .cache 是各会话的本地产物目录（含外部仓库完整克隆，如 hyperframes-source
    // 自带几百个测试）；vitest 默认只排 node_modules/dist，不排它会把别人的测试
    // 扫进本仓 run，pre-push 直接被判挂。
    exclude: ["**/node_modules/**", "**/dist/**", "**/.cache/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/__mocks__/@tauri-apps-api-core.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "./src/__mocks__/@tauri-apps-api-event.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "./src/__mocks__/@tauri-apps-api-window.ts"),
    },
  },
});
