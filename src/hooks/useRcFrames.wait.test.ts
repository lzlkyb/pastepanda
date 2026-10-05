/**
 * useRcFrames 等画面阶段文案单测（§17.3，2026-10-03 真机教训）。
 *
 * 背景：手机点「远程控制」后曾有 30 秒静默等待，界面只有一句静态
 * 「等待对方画面…」+ 无动画，用户只能判断「卡死了」。首帧前的等待实际分
 * 三段（拨号 / 等对方批准 / 编码器起帧），hook 现在按 phase 说实话。
 *
 * 钉住：① 阶段文案在取帧循环一起来时就上屏（不等 1s ticker）；② 传了
 * phase 才有阶段文案，不传保持历史兜底；③ 空批（无帧）不会把文案清掉。
 * 环境与 .gate.test.ts 同：rcDrainFrames 恒返空批、窗口恒可见。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRcFrames } from "./useRcFrames";
import { rcDrainFrames } from "@/lib/api/rc";

vi.mock("@/lib/api/rc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 空批：没有帧——等画面文案必须在无帧时也成立
  rcDrainFrames: vi.fn(async () => new ArrayBuffer(0)),
}));

const canvas = () => document.createElement("canvas");

beforeEach(() => {
  vi.mocked(rcDrainFrames).mockClear();
});

describe("useRcFrames 等画面阶段文案", () => {
  it("outbound_pending：立刻上屏「已通知电脑，等待对方同意…」", async () => {
    const ref = { current: canvas() };
    const { result } = renderHook(() =>
      useRcFrames("s1", ref, { phase: "outbound_pending" }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(result.current.statusText).toBe("已通知电脑，等待对方同意…");
    expect(result.current.waitHint).toBe(""); // 30s 阈值内不出人话
  });

  it("outbound_active：电脑正在准备画面…", async () => {
    const ref = { current: canvas() };
    const { result } = renderHook(() =>
      useRcFrames("s1", ref, { phase: "outbound_active" }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(result.current.statusText).toBe("电脑正在准备画面…");
  });

  it("无会话（刚点下去）：正在连接电脑…", async () => {
    const ref = { current: canvas() };
    const { result } = renderHook(() => useRcFrames("s1", ref));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(result.current.statusText).toBe("正在连接电脑…");
  });
});
