import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionFrameState, SessionModeNotice } from "./SessionScreenNotices";
afterEach(cleanup);
const pointer = { charging: false, dragging: false, scrolling: false, modeHint: "触控板 · 划动移动指针" };

it("常态不持续遮住画面，拖拽、滚动和只看状态仍有明确反馈", () => {
  const view = render(<SessionModeNotice hasFrame canControl pointer={pointer} />);
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<SessionModeNotice hasFrame canControl pointer={{ ...pointer, dragging: true }} />);
  expect(screen.getByRole("status").textContent).toContain("拖拽中");
  view.rerender(<SessionModeNotice hasFrame canControl pointer={{ ...pointer, scrolling: true }} />);
  expect(screen.getByRole("status").textContent).toContain("滚动中");
  view.rerender(<SessionModeNotice hasFrame canControl={false} pointer={pointer} />);
  expect(screen.getByRole("status").textContent).toContain("只看模式");
});

it("等待和恢复阶段说清状态，保留取消与返回入口，恢复后撤掉提示", () => {
  const onReturn = vi.fn();
  const view = render(<SessionFrameState text="电脑正在准备画面…" hasFrame={false} onReturn={onReturn} />);
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  expect(onReturn).toHaveBeenCalledOnce();
  view.rerender(<SessionFrameState text="正在恢复画面…" hasFrame onReturn={onReturn} />);
  expect(screen.getByRole("status").textContent).toContain("输入已暂停");
  expect(screen.getByRole("button", { name: "返回设备" })).toBeTruthy();
  view.rerender(<SessionFrameState text="" hasFrame onReturn={onReturn} />);
  expect(screen.queryByRole("status")).toBeNull();
});
