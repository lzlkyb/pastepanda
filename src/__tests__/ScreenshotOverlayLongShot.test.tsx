/**
 * ScreenshotOverlay · 长截图回归测试。
 *
 * 最要紧的一条来自 useLongShot 抽取前的 :4775 注释：每个 IPC 都必须包 withTimeout，
 * 因为「裸 await 一旦挂起 → finally 永不执行 → show_screenshot_window 不会被调用 →
 *   截图窗永久隐藏但进程还在，全屏透明覆盖层还挡着鼠标，只能杀进程」。
 *
 * 所以这里的核心断言是：**不管中途怎么失败，窗口都要被恢复**。
 *
 * ⚠️ 交互契约已对齐微信 PC 版：点工具栏「长截图」**立即开截**（无预览层、
 * 无模式选择）；之后用户自己滚，软件持续采样实时拼接，直到收到
 * LONGSHOT_CONTROL 的 stop（完成）/ abort（取消）才结束。
 * 因此每个用例都必须显式发一条控制事件收尾 —— 不发就真的会一直采样下去。
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
import { LONGSHOT_CONTROL } from "@/lib/screenshot/longshotEvents";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
  // 默认让长截图能跑起来并很快收尾
  env.setCommand("arm_longshot_escape", () => true);
  env.setCommand("open_longshot_status", () => true);
  env.setCommand("capture_region", () => screenInfo({ width: 600, height: 400 }));
});

afterEach(async () => {
  // 长截图是本文件里唯一带长异步链的流程：采样循环 → 恢复窗口 → 合成 → OCR。
  // 不在这里排空的话，上一条用例遗留的收尾会在下一条 beforeEach 重置计数器**之后**才落地，
  // 被记到新计数器上 —— 表现为"只恢复一次"莫名其妙数到 2。先 flush 再卸载，归属就对了。
  await flush(4);
  cleanup();
  cleanupShotEnv();
});

/** 进标注态 → 点工具栏「长截图」。新契约下这一下就已经开截了。 */
async function clickLongShot(): Promise<void> {
  await renderOverlay();
  await enterAnnotate();
  const btn = qq(".annot-toolbar .tool.longshot")[0];
  if (!btn) throw new Error("找不到长截图按钮");
  if (btn.className.includes("disabled")) throw new Error("长截图按钮是禁用态");
  fireEvent.click(btn);
  await flush(6);
}

/**
 * 开截 → 发一条控制事件收尾。
 *
 * ⚠️ 必须发：实时拼接循环的终止权**完全在用户手里**（微信就是这样），
 * 既没有屏数上限也没有总时长上限。测试里不发 stop/abort 就会一直采样。
 */
/**
 * 收尾半段。从 `runLongShot` 里拆出来，是为了让需要断言「开截那一刻」的用例
 * 能在中间插一脚（见「全局 Esc 被占用」那条）。
 */
async function finishLongShot(end: "stop" | "abort" = "stop"): Promise<void> {
  await env.emitBackend(LONGSHOT_CONTROL, end);
  // ❌ 不能用固定 sleep 等它收尾：循环闲置时会 sleep(200) 降速（见 idleSpins），
  // 全量并行跑时这一觉会被拖得更长 —— 固定等 260ms 在空机器上够、在负载下必挂。
  // 改成轮询真实收尾信号（窗口被恢复），不把测试建在墙钟上。
  for (let i = 0; i < 60 && env.countInvoke("show_screenshot_window") === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await flush(2);
  }
  await flush(8);
}

async function runLongShot(end: "stop" | "abort" = "stop"): Promise<void> {
  await clickLongShot();
  await finishLongShot(end);
}

describe("启动准备", () => {
  it("点「长截图」立即开截：注册全局 Esc、开状态窗、隐藏截图窗", async () => {
    await runLongShot();

    expect(env.countInvoke("arm_longshot_escape")).toBe(1);
    expect(env.countInvoke("open_longshot_status")).toBe(1);
    expect(env.countInvoke("hide_screenshot_window")).toBe(1);
  });

  it("不再出现预览层与滚动方式选择（已对齐微信）", async () => {
    await clickLongShot();
    expect(q(".ls-preview")).toBeNull();
    expect(q(".ls-modepick")).toBeNull();
    // 已经真的开截了，而不是停在某个确认态
    expect(env.countInvoke("hide_screenshot_window")).toBe(1);
    await env.emitBackend(LONGSHOT_CONTROL, "abort");
    await flush(8);
  });

  it("不再往目标窗口注入滚轮（自动滚动已砍掉）", async () => {
    await runLongShot();
    expect(env.countInvoke("scroll_longshot")).toBe(0);
    expect(env.countInvoke("get_scroll_bottom")).toBe(0);
  });

  it("全局 Esc 被占用时明确告知，但不阻断长截图", async () => {
    env.setCommand("arm_longshot_escape", () => false);
    await clickLongShot();

    // 🔴 断言必须做在**开截那一刻**，不能放到整个流程跑完之后。
    //
    // 截图窗的 toast 是**单槽**的，后一条会盖掉前一条。旧版把这句断言写在
    // `runLongShot()` 之后能过，只是因为那时候**没有别的消息说话**——
    // 一旦给拼接质量补上回执（“有几段只勉强对上”）它就挂了。
    // 而那个覆盖本身是对的：长截图跑完的那一刻，Esc 能不能用已经不重要了。
    expect(screen.getByText(/全局 Esc 被占用/)).toBeTruthy();

    await finishLongShot();
    // “不阻断”：提示归提示，截图窗该隐还是要隐、流程该跑还是要跑。
    expect(env.countInvoke("hide_screenshot_window")).toBe(1);
  });

  it("状态窗开不起来时也照样告知（不静默）", async () => {
    env.setCommand("open_longshot_status", () => false);
    await clickLongShot();

    expect(q(".shot-toast")).toBeTruthy();
  });
});

describe("窗口一定会被恢复", () => {
  it("首帧截取就失败：报错并恢复窗口", async () => {
    env.failCommand("capture_region", "目标窗口无响应");
    await clickLongShot();

    expect(screen.getByText(/长截图失败：/)).toBeTruthy();
    // 核心回归：窗口必须恢复，否则全屏透明覆盖层永久挡鼠标，只能杀进程
    expect(env.countInvoke("show_screenshot_window")).toBeGreaterThanOrEqual(1);
    expect(env.countInvoke("close_longshot_status")).toBeGreaterThanOrEqual(1);
  });

  it("点「完成」正常收尾，且只恢复一次", async () => {
    await runLongShot("stop");

    expect(env.countInvoke("show_screenshot_window")).toBe(1);
    expect(env.countInvoke("close_longshot_status")).toBe(1);
  });

  it("点「取消」不出图，但照样恢复窗口并告知", async () => {
    await runLongShot("abort");

    expect(env.countInvoke("show_screenshot_window")).toBe(1);
    expect(screen.getByText(/已放弃长截图/)).toBeTruthy();
  });

  it("恢复截图窗失败时退而关窗，不把进程留在隐藏态", async () => {
    env.failCommand("capture_region", "boom");
    // 注意：restoreShotWindow 用的是 `.then(() => true).catch(() => false)`，
    // 所以"恢复失败"只能用 **reject** 表达；命令返回 false 仍算成功。
    env.failCommand("show_screenshot_window", "窗口句柄失效");
    await clickLongShot();

    expect(env.countInvoke("close_screenshot_window")).toBeGreaterThanOrEqual(1);
  });
});
