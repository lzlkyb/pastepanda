/**
 * ScreenshotOverlay · 长截图回归测试。
 *
 * 最要紧的一条来自 :4775 的注释：每个 IPC 都必须包 withTimeout，因为
 * 「裸 await 一旦挂起 → finally 永不执行 → show_screenshot_window 不会被调用 →
 *   截图窗永久隐藏但进程还在，全屏透明覆盖层还挡着鼠标，只能杀进程」。
 *
 * 所以这里的核心断言是：**不管中途怎么失败，窗口都要被恢复**。
 * 这一块是批 3 要提取成 useLongShot 的目标（371 行，依赖表只有 6 项）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fireEvent, cleanup, screen } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  screenInfo,
  enterAnnotate,
  q,
  qq,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
  // 默认让长截图能跑起来并很快收尾
  env.setCommand("arm_longshot_escape", () => true);
  env.setCommand("open_longshot_status", () => true);
  env.setCommand("capture_region", () => screenInfo({ width: 600, height: 400 }));
  env.setCommand("get_scroll_bottom", () => true); // 第一帧就到底 → 循环立刻结束
});

afterEach(async () => {
  // 长截图是本文件里唯一带长异步链的流程：滚动循环 → 恢复窗口 → 合成 → OCR。
  // 不在这里排空的话，上一条用例遗留的收尾会在下一条 beforeEach 重置计数器**之后**才落地，
  // 被记到新计数器上 —— 表现为"只恢复一次"莫名其妙数到 2。先 flush 再卸载，归属就对了。
  await flush(4);
  cleanup();
  cleanupShotEnv();
});

/** 进标注态并点「长截图」 */
async function startLongShot(): Promise<void> {
  await renderOverlay();
  await enterAnnotate();
  const btn = qq(".annot-toolbar .tool.longshot")[0];
  if (!btn) throw new Error("找不到长截图按钮");
  if (btn.className.includes("disabled")) throw new Error("长截图按钮是禁用态");
  fireEvent.click(btn);
  await flush(8);
}

describe("启动准备", () => {
  it("注册全局 Esc、开状态窗、隐藏截图窗", async () => {
    await startLongShot();

    expect(env.countInvoke("arm_longshot_escape")).toBe(1);
    expect(env.countInvoke("open_longshot_status")).toBe(1);
    expect(env.countInvoke("hide_screenshot_window")).toBe(1);
  });

  it("全局 Esc 被占用时明确告知，但不阻断长截图", async () => {
    env.setCommand("arm_longshot_escape", () => false);
    await startLongShot();

    expect(screen.getByText(/全局 Esc 被占用/)).toBeTruthy();
    expect(env.countInvoke("hide_screenshot_window")).toBe(1);
  });

  it("状态窗开不起来时也照样告知（不静默）", async () => {
    env.setCommand("open_longshot_status", () => false);
    await startLongShot();

    expect(q(".shot-toast")).toBeTruthy();
  });
});

describe("窗口一定会被恢复", () => {
  it("首帧截取就失败：报错并恢复窗口", async () => {
    env.failCommand("capture_region", "目标窗口无响应");
    await startLongShot();

    expect(screen.getByText(/长截图失败：/)).toBeTruthy();
    // 核心回归：窗口必须恢复，否则全屏透明覆盖层永久挡鼠标，只能杀进程
    expect(env.countInvoke("show_screenshot_window")).toBeGreaterThanOrEqual(1);
    expect(env.countInvoke("close_longshot_status")).toBeGreaterThanOrEqual(1);
  });

  it("滚动命令失败也恢复窗口", async () => {
    env.setCommand("get_scroll_bottom", () => false); // 不到底 → 会去滚动
    env.failCommand("scroll_longshot", "SendInput 被拒绝");
    await startLongShot();

    expect(env.countInvoke("show_screenshot_window")).toBeGreaterThanOrEqual(1);
  });

  it("正常收尾同样恢复窗口，且只恢复一次", async () => {
    await startLongShot();

    expect(env.countInvoke("show_screenshot_window")).toBe(1);
    expect(env.countInvoke("close_longshot_status")).toBe(1);
  });

  it("恢复截图窗失败时退而关窗，不把进程留在隐藏态", async () => {
    env.failCommand("capture_region", "boom");
    // 注意：restoreShotWindow 用的是 `.then(() => true).catch(() => false)`，
    // 所以"恢复失败"只能用 **reject** 表达；命令返回 false 仍算成功。
    env.failCommand("show_screenshot_window", "窗口句柄失效");
    await startLongShot();

    expect(env.countInvoke("close_screenshot_window")).toBeGreaterThanOrEqual(1);
  });
});

describe("长截图期间的按钮状态", () => {
  it("已有标注时长截图按钮禁用并说明原因", async () => {
    await renderOverlay();
    await enterAnnotate();

    // 画一笔
    const cv = q(".annot-canvas") ?? q(".shot-root")!;
    fireEvent.mouseDown(cv, { clientX: 300, clientY: 250 });
    fireEvent.mouseMove(cv, { clientX: 480, clientY: 380 });
    fireEvent.mouseUp(cv, { clientX: 480, clientY: 380 });
    await flush(1);

    const btn = qq(".annot-toolbar .tool.longshot")[0];
    expect(btn.className).toContain("disabled");
    expect(btn.getAttribute("data-tip")).toContain("已有标注");
  });
});
