/**
 * Toast 的「撤销」按钮 —— 守 `onAction` 这条通用动作分支（2026-09-18）。
 *
 * 背景：`action === "undo"` 原本写死调 `restoreDeleted()`（历史记录的撤销删除）。
 * 远程申请撤回要的是「调用方给的撤销动作」，于是加了 `onAction`，并把两条路
 * **并成同一支渲染**（否则两个字段同时被设会渲染出两个「撤销」按钮）。
 * 合并的代价是：以后谁再动这支按钮，必须同时保住两种语义 —— 本文件就是那个保证。
 *
 * 为什么不塞进 rcDangerGuards.test.tsx：那边把整个 Toast 模块换成了替身
 * （只需要捕获 `toast` 的入参），而这一条要的是**真渲染**。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToastProvider, useToast, UNDO_WINDOW_MS } from "@/components/Toast";

const h = vi.hoisted(() => ({ restoreDeleted: vi.fn(), onAction: vi.fn() }));

vi.mock("@/lib/api/history", () => ({ restoreDeleted: h.restoreDeleted }));

function Probe() {
  const { toast } = useToast();
  return (
    <>
      <button
        onClick={() =>
          toast(
            "已向「客厅机」发起远程（可控）",
            "info",
            UNDO_WINDOW_MS,
            undefined,
            undefined,
            undefined,
            undefined,
            h.onAction,
          )
        }
      >
        新路 onAction
      </button>
      <button
        onClick={() =>
          toast("已删除 3 条记录", "info", undefined, undefined, undefined, undefined, "undo")
        }
      >
        老路 undo
      </button>
    </>
  );
}

beforeEach(() => {
  cleanup();
  h.restoreDeleted.mockReset().mockResolvedValue(undefined);
  h.onAction.mockReset();
});

describe("Toast 的撤销按钮", () => {
  it("onAction：点「撤销」调的是调用方给的回调", () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("新路 onAction"));
    fireEvent.click(screen.getByText("撤销"));

    expect(h.onAction).toHaveBeenCalledTimes(1);
    // 合并分支之后老路不能被带走：restoreDeleted 只该服务「撤销删除」那条
    expect(h.restoreDeleted).not.toHaveBeenCalled();
  });

  it('action:"undo"（无 onAction）：老路子仍然调 restoreDeleted', () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("老路 undo"));
    fireEvent.click(screen.getByText("撤销"));

    expect(h.restoreDeleted).toHaveBeenCalledTimes(1);
    expect(h.onAction).not.toHaveBeenCalled();
  });
});
