import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// 🔴 通用排除：.cache 是各会话的本地产物目录（含外部仓库完整克隆，如 hyperframes-source
// 自带几百个测试）；design/ 是 HTML 设计稿目录，里面的 motion.test.cjs 之类
// 是稿件脚本不是本仓测试。vitest 默认只排 node_modules/dist，不排它们会把
// 无关文件扫进本仓 run，pre-push 直接被判挂。
const GENERIC_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.cache/**", "design/**"];

// 需要真实 DOM 的纯 .ts 测试：不在这个清单里的 .ts 测试跑在 node 环境下。
// 判据是实测（跑一遍 node 环境，收集失败清单），不是靠正则猜。
const DOM_NEEDED_TS: string[] = [
  "scripts/prepare-android.test.ts",
  "src-mobile/devices/useMobileFileSend.test.ts",
  "src-mobile/devices/useMobileReceiveDir.test.ts",
  "src-mobile/devices/useQrScan.test.ts",
  "src-mobile/session/mobileInputTelemetry.test.ts",
  "src-mobile/session/pointerPreference.test.ts",
  "src-mobile/session/useAutoSuggestToast.test.ts",
  "src-mobile/session/useDirectSwitchToast.test.ts",
  "src-mobile/session/useFloatingMouse.test.ts",
  "src-mobile/session/useImmersiveCapsule.test.ts",
  "src-mobile/session/useMobileConnectionInfo.test.ts",
  "src-mobile/session/useRcMobileInput.test.ts",
  "src-mobile/session/useRcSessionKeepalive.test.ts",
  "src-mobile/session/useRemoteCursor.test.ts",
  "src-mobile/session/useSessionClipboard.test.ts",
  "src-mobile/session/useSessionPointer.test.ts",
  "src-mobile/session/useTouchGestures.test.ts",
  "src-mobile/ui/mobileSpring.test.ts",
  "src/__tests__/aiAwareness.test.ts",
  "src/__tests__/api-paste-signal.test.ts",
  "src/__tests__/api-stack.test.ts",
  "src/__tests__/api.test.ts",
  "src/__tests__/appStore-extended.test.ts",
  "src/__tests__/docPipeline.test.ts",
  "src/__tests__/fullscreenOutlineSpy.test.ts",
  "src/__tests__/insertAtCursor.test.ts",
  "src/__tests__/logger.test.ts",
  "src/__tests__/markdownHeadingAnchor.test.ts",
  "src/__tests__/milestones.test.ts",
  "src/__tests__/pasteItem.test.ts",
  "src/__tests__/restoreDeleted.test.ts",
  "src/__tests__/richContent.test.ts",
  "src/__tests__/screenshotImageIo.test.ts",
  "src/__tests__/screenshotPixelProbe.test.ts",
  "src/__tests__/storageMigration.test.ts",
  "src/__tests__/theme.test.ts",
  "src/__tests__/useFirstTimeTip.test.ts",
  "src/hooks/useRcBackgroundPause.test.ts",
  "src/hooks/useRcClipboardAuto.test.ts",
  "src/hooks/useRcFrames.gate.test.ts",
  "src/hooks/useRcFrames.recovery.test.ts",
  "src/hooks/useRcFrames.wait.test.ts",
  "src/hooks/useRcInput.test.ts",
  "src/hooks/useRcNearbyPair.test.ts",
  "src/hooks/useRcSessionPrefs.test.ts",
  "src/hooks/useWindowVisible.test.ts",
  "src/lib/imagePreviewWheel.test.ts",
  "src/lib/notes/article.test.ts",
  "src/lib/notes/deposit.test.ts",
  "src/lib/notes/extract.test.ts",
  "src/lib/notes/htmlToMd.test.ts",
  "src/lib/rcFocusRelease.test.ts",
  "src/lib/rcJpegSink.test.ts",
  "src/lib/rcWindowOps.test.ts",
];

const alias = {
  "@": path.resolve(__dirname, "./src"),
  "@tauri-apps/api/core": path.resolve(__dirname, "./src/__mocks__/@tauri-apps-api-core.ts"),
  "@tauri-apps/api/event": path.resolve(__dirname, "./src/__mocks__/@tauri-apps-api-event.ts"),
  "@tauri-apps/api/window": path.resolve(__dirname, "./src/__mocks__/@tauri-apps-api-window.ts"),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    globals: true,
    setupFiles: [path.resolve(__dirname, "./src/test-setup.ts")],
    exclude: GENERIC_EXCLUDE,
    pool: "forks",
    poolOptions: {
      forks: {
        // 按内存而非核数封顶：本机 16 逻辑核但空闲内存只剩 3GB 量级，
        // 默认按核数开 16 个 fork、每个都要装一套 jsdom，直接把机器打成
        // 页抖动——表现是 vitest 硬编码的 worker 启动闸（60s/90s，见
        // vitest/dist/chunks/cli-api START_TIMEOUT）超时，随机判红。
        maxForks: 6,
      },
    },
    // 单条用例的墙钟预算。默认 5000ms 在满载机器上会被「fake timers 推进
    // 60 秒虚拟时间」这类 CPU 密集用例撞穿（2026-10-08 实测：同一条用例
    // 单独跑 463ms 全绿、全仓并发跑 7.6s 超时），而用例超时是**中断**执行，
    // 残留的 fake timers 会让同文件后面的用例全渲染成空壳——一次 5s 误判
    // 级联成 4 条红。
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // include 故意写全仓通配（不是按目录列举）：收窄成 src/** 之类的话，
          // 落在别处的新 .test.ts 会两个 project 都不匹配，静默不跑。
          include: ["**/*.test.ts", "**/*.spec.ts"],
          exclude: [...GENERIC_EXCLUDE, ...DOM_NEEDED_TS],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["**/*.test.tsx", "**/*.spec.tsx", ...DOM_NEEDED_TS],
          exclude: GENERIC_EXCLUDE,
        },
      },
    ],
  },
});
