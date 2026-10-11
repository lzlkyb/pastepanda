import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RcReceiveDirNotice } from "./RcReceiveDirNotice";
import type { useMobileReceiveDir } from "./useMobileReceiveDir";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const directory = () => ({ dir: "/receive", error: null, busy: false, note: "已恢复默认接收位置，请重新取文件。", clearNote: vi.fn(), reset: vi.fn(), retry: vi.fn(), canReset: false }) as ReturnType<typeof useMobileReceiveDir>;
it("成功回执可主动关闭，也会在可见阅读时间后清除", () => {
  vi.useFakeTimers(); const state = directory(); const view = render(<RcReceiveDirNotice directory={state} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(state.clearNote).toHaveBeenCalledOnce(); view.unmount();
  const timed = directory(); render(<RcReceiveDirNotice directory={timed} />);
  act(() => vi.advanceTimersByTime(4000)); expect(timed.clearNote).toHaveBeenCalledOnce();
});
it("接收目录错误保留恢复动作，不自动消失", () => {
  vi.useFakeTimers(); const state = { ...directory(), error: "位置不可访问", canReset: true };
  render(<RcReceiveDirNotice directory={state} />);
  act(() => vi.advanceTimersByTime(30000)); expect(state.clearNote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重置接收位置" })); expect(state.reset).toHaveBeenCalledOnce();
});
