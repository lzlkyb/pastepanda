import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileSheet } from "./MobileSheet";
import { setupMotionClock } from "./mobileMotionTestUtils";

vi.mock("./useMobileBack", () => ({ useMobileBack: () => {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("关闭期间保留最后内容，滑出后才卸载；重开取消旧卸载", () => {
  const clock = setupMotionClock(),
    close = vi.fn();
  const view = render(
    <MobileSheet open title="配对" onClose={close} footer={<p>确认结果</p>}>
      <p>配对码 1234</p>
    </MobileSheet>,
  );
  act(() => clock.advance(1200));
  view.rerender(
    <MobileSheet open={false} title="" onClose={close}>
      {null}
    </MobileSheet>,
  );
  expect(screen.getByText("配对码 1234")).toBeTruthy();
  expect(screen.getByText("确认结果").parentElement?.className).toContain("sheetFooter");
  expect(document.body.dataset.mobileSheets).toBe("1");
  act(() => clock.advance(80));
  view.rerender(
    <MobileSheet open title="新配对" onClose={close}>
      <p>配对码 5678</p>
    </MobileSheet>,
  );
  act(() => clock.advance(1200));
  expect(screen.getByRole("dialog", { name: "新配对" })).toBeTruthy();
  expect(screen.getByText("配对码 5678")).toBeTruthy();
  view.rerender(
    <MobileSheet open={false} title="" onClose={close}>
      {null}
    </MobileSheet>,
  );
  act(() => clock.advance(1200));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.dataset.mobileSheets).toBeUndefined();
  expect(clock.frames.size).toBe(0);
});
it("减少动态效果时关闭立即卸载", () => {
  const clock = setupMotionClock();
  clock.reduced.matches = true;
  const view = render(
    <MobileSheet open title="画面" onClose={() => {}}>
      画质
    </MobileSheet>,
  );
  view.rerender(
    <MobileSheet open={false} title="画面" onClose={() => {}}>
      画质
    </MobileSheet>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(clock.frames.size).toBe(0);
});
it("完全滑出屏幕后立即释放弹层，不等待看不见的弹簧尾段", () => {
  const clock = setupMotionClock();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  const view = render(
    <MobileSheet open title="画面" onClose={() => {}}>
      画质
    </MobileSheet>,
  );
  act(() => clock.advance(1200));
  view.rerender(
    <MobileSheet open={false} title="画面" onClose={() => {}}>
      画质
    </MobileSheet>,
  );
  act(() => clock.advance(400));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(clock.frames.size).toBe(0);
});

it("来源面板的返回与关闭全部分别执行，Escape也返回来源", () => {
  const clock = setupMotionClock(); clock.reduced.matches = true;
  const back = vi.fn(), close = vi.fn();
  render(<MobileSheet open title="画质" onBack={back} onClose={close}>画质选择</MobileSheet>);
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(back).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(back).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭全部" }));
  expect(close).toHaveBeenCalledTimes(1);
});
