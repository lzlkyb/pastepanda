/**
 * rcWindowOps 守卫单测（方案A，2026-09-25）：三键 / 自适应的唯一出口。
 *
 * 钉三件事：命令名逐字（Rust 端注册名必须严丝合缝）、失败必上抛 notify
 * （U3.5 不静默——「点了没反应」这一类故障靠它杜绝）、非 Tauri 环境
 * （浏览器直开 rc.html 看版式）零调用零 toast 不崩。
 *
 * 拖拽不在这里：定稿与 md 全屏编辑器同款（deep 拖拽区，Tauri 注入脚本内置），
 * 无 JS 通道。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import {
  rcFitWindowToVideo,
  rcWindowClose,
  rcWindowMinimize,
  rcWindowToggleMaximize,
} from "./rcWindowOps";

const notify = vi.fn();

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("rcWindowOps（窗口操作唯一出口）", () => {
  it("三键逐字打到对应命令", async () => {
    await rcWindowMinimize(notify);
    await rcWindowToggleMaximize(notify);
    await rcWindowClose(notify);

    expect(h.invoke).toHaveBeenNthCalledWith(1, "rc_window_minimize");
    expect(h.invoke).toHaveBeenNthCalledWith(2, "rc_window_toggle_maximize");
    expect(h.invoke).toHaveBeenNthCalledWith(3, "rc_window_close");
  });

  it("🔴 失败必上抛 notify（Rust 的 Err 是人话，直接透传）——不许静默", async () => {
    h.invoke.mockRejectedValueOnce("最小化窗口被拒绝：权限不足");

    await expect(rcWindowMinimize(notify)).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith("窗口操作失败：最小化窗口被拒绝：权限不足", "error");
  });

  it("自适应带画面宽高参数；失败上抛（跳过=false 不打扰）", async () => {
    await rcFitWindowToVideo(1920, 1080, notify);
    expect(h.invoke).toHaveBeenCalledWith("rc_fit_window_to_video", {
      videoW: 1920,
      videoH: 1080,
    });
    expect(notify).not.toHaveBeenCalled();

    h.invoke.mockRejectedValueOnce("调整窗口尺寸失败：xxx");
    await expect(rcFitWindowToVideo(1920, 1080, notify)).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith("画面自适应窗口失败：调整窗口尺寸失败：xxx", "error");
  });

  it("非 Tauri 环境（浏览器直开 rc.html 预览）：零调用零 toast，不崩", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    await expect(rcWindowMinimize(notify)).resolves.toBe(false);
    await expect(rcFitWindowToVideo(1920, 1080, notify)).resolves.toBe(false);

    expect(h.invoke).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

