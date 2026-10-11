import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import os from "os";

// 🔴 通用排除：.cache 是各会话的本地产物目录（含外部仓库完整克隆，如 hyperframes-source
// 自带几百个测试）；design/ 是 HTML 设计稿目录，里面的 motion.test.cjs 之类
// 是稿件脚本不是本仓测试。vitest 默认只排 node_modules/dist，不排它们会把
// 无关文件扫进本仓 run，pre-push 直接被判挂。
const GENERIC_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.cache/**", "**/target/**", "**/target-macos/**", "**/target-macos-intel/**", "**/target-android/**", "design/**"];

// 并发上限的内存档，理由见下面 test.maxWorkers。
const MAX_WORKERS = 10;

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
  "src/hooks/useRcAudio.test.ts",
  "src/hooks/useRcSessionAudio.test.ts",
  "src/lib/rcAudio.test.ts",
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

// setupFiles 故意不在顶层写、只挂在各自 project 上：extends:true 走的是 mergeConfig，
// 数组是**拼接**而不是覆盖，顶层再留一份会让共享 setup 在 jsdom 侧跑两遍。
// node 侧也不该装 DOM 专属 setup——它有 300 多个文件，多一条 import 就是多轮模块图。
const SETUP_SHARED = path.resolve(__dirname, "./src/test-setup.ts");
const SETUP_DOM = path.resolve(__dirname, "./src/test-setup.dom.ts");

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    globals: true,
    exclude: GENERIC_EXCLUDE,
    // vitest 4.1.9 里 pool 的默认值已经是 forks（CLI 帮助原文：default `forks`），
    // 这里显式写死只是防未来默认值翻回 threads。
    pool: "forks",
    // 按内存而非核数封顶：本机 16 逻辑核但空闲内存只有 3GB 量级，vitest 默认
    // maxWorkers = cpus-1 = 15 个 fork，机器被烘热时撞的是它硬编码的 worker 启动闸
    // （60s/90s，源码 WORKER_START_TIMEOUT=9e4，**改不了**），表现是随机判红。
    // 档位实测（同一台机、全仓 388/389 文件）：6 档 318.74s、10 档 320.59s——两档没有
    // 可见差别，所以没必要为了省内存把并发压到 6；另有一次 15 档 120.89s 是机器空时
    // 测的（跑时有并发会话在抢 CPU/IO），不能反过来当「降并发会变慢」的证据。
    // ⚠️ 键名踩过两次坑，别再退回它们：
    //   ① `poolOptions.forks.maxForks` 在 vitest 4 里**整块是死配置**（4.1.9 实测：
    //      只对 poolOptions 打一条 deprecate 警告然后忽略，并发一直是 15）；
    //   ② CLI 的 `--max-workers` / `--maxWorkers` 同样**不生效**（12 文件实测三档
    //      16.7–18.4s 没差别，只有 `VITEST_MAX_WORKERS=1` 翻到 31.30s）——
    //      临时压并发走下面的环境变量，别加 CLI 参数。
    // 取 min(10, cpus-1)：不越过 vitest 自己的默认值，CI（4 vCPU）拿到的仍是 3。
    maxWorkers: Math.min(MAX_WORKERS, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
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
          setupFiles: [SETUP_SHARED],
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
          setupFiles: [SETUP_SHARED, SETUP_DOM],
          include: ["**/*.test.tsx", "**/*.spec.tsx", ...DOM_NEEDED_TS],
          exclude: GENERIC_EXCLUDE,
        },
      },
    ],
  },
});
