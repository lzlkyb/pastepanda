/**
 * ScreenshotOverlay · 启动链回归测试。
 *
 * 覆盖的都是源码注释里点名过的真实历史 bug，不是想象出来的用例：
 * - :722-728  预截屏没等就自截 → 一次开窗截两遍全屏
 * - :746      截屏失败静默关窗 → 用户看不到原因
 * - :710-713  固定区域直接进标注 → 用户以为选区被锁死（改为紫框预览）
 * - :794      screenshot-refresh 的 unlisten 被丢弃 → StrictMode 下按一次热键截两遍
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ScreenshotOverlay } from "@/components/screenshot/ScreenshotOverlay";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  screenInfo,
  q,
  toolbar,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
});

afterEach(() => {
  cleanup();
  cleanupShotEnv();
});

describe("启动：截屏 → 选区态", () => {
  it("底图还没到时显示载入文案，而不是空白", () => {
    render(<ScreenshotOverlay />);
    // 初次渲染 screen 仍是 null，走 :3758 的早返回分支
    expect(screen.getByText("正在截取屏幕…")).toBeTruthy();
  });

  it("拿到底图后进入选区态：渲染 shot-root 且不在标注态", async () => {
    await renderOverlay();
    expect(q(".shot-root")).toBeTruthy();
    expect(screen.queryByText("正在截取屏幕…")).toBeNull();
    // 选区态没有选区 → 全屏蒙版入场层（:3947），且没有标注工具栏
    expect(q(".shade-enter")).toBeTruthy();
    expect(toolbar()).toBeNull();
  });

  it("优先用后端预截屏结果，命中时不再自己截一遍", async () => {
    await renderOverlay();
    expect(env.countInvoke("take_pending_shot_capture")).toBeGreaterThanOrEqual(1);
    // 预截屏已命中，capture_screen 一次都不该发 —— 否则就是"一次开窗截两遍"
    expect(env.countInvoke("capture_screen")).toBe(0);
  });

  it("取到底图后枚举邻窗矩形供磁吸使用", async () => {
    await renderOverlay();
    expect(env.countInvoke("enum_window_rects")).toBeGreaterThanOrEqual(1);
  });
});

describe("截屏失败不静默", () => {
  it("显示失败原因与重试/关闭两个出口", async () => {
    env.failCommand("take_pending_shot_capture", "屏幕捕获权限不足");
    await renderOverlay();

    expect(screen.getByText(/截图失败：/)).toBeTruthy();
    expect(screen.getByText(/屏幕捕获权限不足/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("点重试重新截屏，成功后进入选区态", async () => {
    env.failCommand("take_pending_shot_capture", "boom");
    await renderOverlay();
    expect(screen.getByText(/截图失败：/)).toBeTruthy();

    env.setCommand("capture_screen", () => screenInfo());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await flush();

    expect(env.countInvoke("capture_screen")).toBe(1);
    expect(screen.queryByText(/截图失败：/)).toBeNull();
    expect(q(".shot-root")).toBeTruthy();
  });

  it("点关闭走关窗命令", async () => {
    env.failCommand("take_pending_shot_capture", "boom");
    await renderOverlay();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await flush(1);

    expect(env.countInvoke("close_screenshot_window")).toBe(1);
  });

  it("重试再失败仍然显示新的失败原因", async () => {
    env.failCommand("take_pending_shot_capture", "第一次失败");
    await renderOverlay();

    env.failCommand("capture_screen", "第二次也失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await flush();

    expect(screen.getByText(/第二次也失败/)).toBeTruthy();
  });
});

describe("固定区域：预览而非锁死", () => {
  it("有记住的选区时进入紫框预览，不直接跳标注态", async () => {
    localStorage.setItem("pp_shot_region", JSON.stringify({ x: 100, y: 120, w: 400, h: 300 }));
    await renderOverlay();

    const box = q(".sel-rect");
    expect(box).toBeTruthy();
    // 关键：带 fixed-preview 类（虚线紫框预览态），且**没有**进标注态
    expect(box!.className).toContain("fixed-preview");
    expect(toolbar()).toBeNull();
  });

  it("记住的选区太小（<4px）时忽略，回到普通吸附", async () => {
    localStorage.setItem("pp_shot_region", JSON.stringify({ x: 10, y: 10, w: 2, h: 2 }));
    await renderOverlay();

    expect(q(".sel-rect")).toBeNull();
    expect(q(".shade-enter")).toBeTruthy();
  });

  it("记住的选区超出当前屏幕时钳制进屏内", async () => {
    // 屏幕 1920×1080，选区起点远超右下 → 应被钳到 (1920-400, 1080-300)
    localStorage.setItem("pp_shot_region", JSON.stringify({ x: 5000, y: 5000, w: 400, h: 300 }));
    await renderOverlay();

    const box = q(".sel-rect");
    expect(box).toBeTruthy();
    // dpr=1，CSS 像素与物理像素 1:1
    expect(box!.style.left).toBe("1520px");
    expect(box!.style.top).toBe("780px");
  });

  it("localStorage 内容损坏时不影响启动", async () => {
    localStorage.setItem("pp_shot_region", "{不是合法 JSON");
    await renderOverlay();

    expect(q(".shot-root")).toBeTruthy();
    expect(q(".sel-rect")).toBeNull();
  });
});

describe("screenshot-refresh 监听不泄漏", () => {
  it("StrictMode 双挂载后，一次 refresh 只重截一次", async () => {
    render(
      <StrictMode>
        <ScreenshotOverlay />
      </StrictMode>,
    );
    await flush();

    const before = env.countInvoke("take_pending_shot_capture");
    await env.emitBackend("screenshot-refresh", null);
    await flush();
    const delta = env.countInvoke("take_pending_shot_capture") - before;

    // 泄漏时这里会是 2（旧实现丢弃了 unlistenRefresh，StrictMode 留下两个监听器）
    expect(delta).toBe(1);
  });
});
