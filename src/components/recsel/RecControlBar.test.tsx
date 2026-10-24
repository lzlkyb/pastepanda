/**
 * RecControlBar 行为测试（四期批1：体积显示 + 暂停键）。
 *
 * 钉两件事：
 * 1. 体积放进更多，主条不占空间；仍用统一 formatBytes 显示。
 * 2. 暂停命令确认后换「继续」，传参保持标量 paused。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));

import { RecControlBar } from "./RecControlBar";
import { installResizeObserver } from "@/test-helpers/resizeObserver";

// RecControlBar 挂载即构造 ResizeObserver（尺寸 effect），jsdom 没有这个全局——不装桩
// 开局就抛。刻意**不**装进共享 test-setup.dom.ts：那会让所有 jsdom 测试里
// `typeof ResizeObserver === "undefined"` 的守卫翻转分支（手机端 KnowledgeList、
// useSheetDrag 都靠这条守卫在 jsdom 里活命），2026-10-16 全局装过一次，满载下
// KnowledgeView.test.tsx 随机判红，已收口到用到的文件。
installResizeObserver();

function okStatus(bytes: number) {
  return { recording: true, finalizing: false, paused: false, path: "x", elapsedMs: 0, bytes, quality: "high" };
}

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.listen.mockReset().mockResolvedValue(() => {});
  vi.useFakeTimers();
});

describe("RecControlBar：体积列与暂停键", () => {
  it("rec_status.bytes 在更多详情走 formatBytes 展示", async () => {
    h.invoke.mockImplementation((_cmd: string) => {
      return Promise.resolve(okStatus(12_897_481));
    });
    const { queryByText, getByRole } = render(
      <RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />,
    );
    // 首帧（还没轮询到）：无体积占位
    expect(queryByText(/MB/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // advanceTimersByTimeAsync 已冲刷微任务：轮询的 .then 里 setState 完成，直接断言
    expect(queryByText(/12.3 MB/)).toBeNull();
    // 2026-10-16：「更多」改成图标按钮（§5.2 删掉与按钮同义的文字），按可及名找
    fireEvent.click(getByRole("button", { name: "更多" }));
    expect(queryByText(/12.3 MB/)).not.toBeNull();
    vi.useRealTimers();
  });

  it("点暂停 → rec_pause 收到 { paused: true }，按钮换「继续」", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "rec_status") return Promise.resolve(okStatus(0));
      return Promise.resolve(undefined);
    });
    const { getByText } = render(
      <RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />,
    );
    // 准备态（status 还没到）不再渲染暂停键——它是点不动的死控件，而且会把条撑宽。
    // 所以这里必须等首轮 rec_status 落地再取按钮。用 getByText 而不是 findByText：
    // 本文件跑在 fake timers 下，findBy 的轮询等待不会自己前进（会挂到用例超时）。
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const pause = getByText("暂停");
    await act(async () => {
      fireEvent.click(pause);
    });
    expect(h.invoke).toHaveBeenCalledWith("rec_pause", { paused: true });
    expect(getByText("继续")).not.toBeNull();
    vi.useRealTimers();
  });
});

/**
 * 窗口尺寸自锁回归守卫（2026-10-18 实测缺陷）。
 *
 * `.surface` 的自然尺寸是后端窗口尺寸的**唯一**来源（ResizeObserver → rec_control_resize）。
 * 给它加 `max-width/max-height: 100vw/100vh` 会把量测钳到**当前**窗口尺寸：
 * 内容一旦比窗口大，量回来的永远等于旧窗口 ⇒ 后端收到「尺寸没变」⇒ 窗口不涨；
 * 而元素自身尺寸没变，ResizeObserver 连回调都不触发。
 * 实测 260×36 窗口里 `.row` 要 311×38（抓手与底部被切），展开「更多」后面板高 187
 * 却只显示 36px 一条——就是这条自锁。jsdom 不做布局，只能用样式断言钉住。
 */
describe("控制条窗口尺寸由内容决定", () => {
  it(".surface 不带 max-width / max-height 上限，且不被 flex 压缩", () => {
    const css = readFileSync("src/components/recsel/RecControlBar.module.css", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const start = css.indexOf(".surface {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).not.toMatch(/max-(width|height)/);
    expect(block).toMatch(/flex:\s*none/);
  });
});

/**
 * 审查 R1 / R2（2026-10-24）：标记热键的回话与保存期的「活着」证据。
 * R1 的失败方式是静默——Rust 改名/删 emit、或前端删监听，编译全绿、用户只是
 * 从此按热键没反应；事件名两端同名另有源码对读守卫（recMarkFeedbackContract.test.ts）。
 */
describe("标记反馈（R1）与保存期秒表（R2）", () => {
  const listenHandlers: Record<string, (e: { payload: unknown }) => void> = {};

  function captureListen() {
    h.listen.mockImplementation(((ev: unknown, cb: unknown) => {
      listenHandlers[String(ev)] = cb as (e: { payload: unknown }) => void;
      return Promise.resolve(() => {});
    }) as typeof h.listen);
  }

  it("rec-marked(recorded) → 主条闪「已标记 mm:ss」，约 2.4s 后自己收掉", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "rec_status") return Promise.resolve(okStatus(0));
      return Promise.resolve(undefined);
    });
    captureListen();
    render(<RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => {
      listenHandlers["rec-marked"]({ payload: { recorded: true, elapsedMs: 83_000 } });
    });
    expect(screen.getByText(/已标记 01:23/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.queryByText(/已标记/)).toBeNull();
    vi.useRealTimers();
  });

  it("rec-marked(recorded=false) → 异常面板说清「为什么没记上 + 去哪开」，不默默吞掉", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "rec_status") return Promise.resolve(okStatus(0));
      return Promise.resolve(undefined);
    });
    captureListen();
    render(<RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => {
      listenHandlers["rec-marked"]({ payload: { recorded: false, elapsedMs: 1000 } });
    });
    // problem 非空 → notice 面板自动展开（组件头既有机制），错误文案指到真实设置名。
    // 本文件在 fake timers 下，findBy 的轮询不会自己前进——setState 在上面那个
    // act 里已落定，直接同步取即可（文件头注释的既有教训）。
    expect(screen.getByText(/记录点击与按键事件/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("保存态：秒数滚动，超 10s 补「请勿此刻退出」（U1：>10s 要么可取消要么给说法）", async () => {
    const { getByText, queryByText } = render(
      <RecControlBar qualityLabel="高清" onStop={() => {}} finalizing={true} />,
    );
    expect(getByText(/正在保存录像/)).toBeTruthy();
    expect(queryByText(/请勿此刻退出/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(getByText(/已 11s/)).toBeTruthy();
    expect(getByText(/请勿此刻退出/)).toBeTruthy();
    vi.useRealTimers();
  });
});
