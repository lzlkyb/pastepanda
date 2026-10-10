import { useState } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileBack } from "./useMobileBack";
import { useRef } from "react";
import { setupMotionClock } from "./mobileMotionTestUtils";

afterEach(async () => {
  cleanup();
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeUndefined());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function native(phase: string, progress = 0) {
  act(() => window.dispatchEvent(new CustomEvent("mobile-native-back", { detail: { phase, progress, edge: "left" } })));
}
it("原生进度与取消不执行业务，提交仅返回一次", async () => {
  setupMotionClock();
  const back = vi.fn();
  function Detail() {
    const ref = useRef<HTMLElement>(null);
    useMobileBack(true, back, true, 0, ref);
    return <section ref={ref} data-testid="detail" />;
  }
  const view = render(<Detail />);
  const element = view.getByTestId("detail");
  Object.defineProperty(element, "clientWidth", { value: 390 });
  native("start"); native("progress", 0.5);
  expect(element.style.getPropertyValue("--mobile-back-offset")).not.toBe("0px");
  expect(back).not.toHaveBeenCalled();
  native("cancel");
  expect(element.style.getPropertyValue("--mobile-back-offset")).toBe("");
  expect(back).not.toHaveBeenCalled();
  native("start"); native("commit"); native("commit");
  await waitFor(() => expect(back).toHaveBeenCalledOnce());
});

it("返回预览中替换弹层，旧提交不能关闭新任务", async () => {
  const first = vi.fn(), next = vi.fn();
  function Layer({ name }: { name: string }) { useMobileBack(true, name === "first" ? first : next, true); return null; }
  const view = render(<Layer key="first" name="first" />);
  native("start");
  view.rerender(<Layer key="next" name="next" />);
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeTruthy());
  native("commit");
  await new Promise(resolve => window.setTimeout(resolve, 30));
  expect(first).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
});

it("原生返回已提交但pop尚未到达时，新弹层不被旧返回关闭", () => {
  const base = history.state, original = vi.fn(), fresh = vi.fn();
  const h = renderHook(() => {
    const [open, setOpen] = useState(false);
    useMobileBack(true, original, true, 0);
    useMobileBack(open, fresh, true, 10);
    return setOpen;
  });
  // Hold the browser's async traversal at the boundary that creates the race.
  const traversal = vi.spyOn(history, "back").mockImplementation(() => {});
  native("start"); native("commit");
  act(() => h.result.current(true));
  act(() => { history.replaceState(base, ""); window.dispatchEvent(new PopStateEvent("popstate", { state: base })); });
  traversal.mockRestore();
  expect(original).toHaveBeenCalledOnce(); expect(fresh).not.toHaveBeenCalled();
});

it("提交后旧层卸载只遍历一次，新层可在迟到pop之后正常返回", async () => {
  const base = history.state, first = vi.fn(), next = vi.fn();
  function Layer({ name }: { name: string }) { useMobileBack(true, name === "first" ? first : next, true); return null; }
  const view = render(<Layer key="first" name="first" />);
  const traversal = vi.spyOn(history, "back").mockImplementation(() => {});
  native("start"); native("commit");
  view.rerender(<Layer key="next" name="next" />);
  const count = traversal.mock.calls.length;
  act(() => { history.replaceState(base, ""); window.dispatchEvent(new PopStateEvent("popstate", {state:base})); });
  traversal.mockRestore();
  expect(count).toBe(1); expect(first).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  expect(history.state?.mobileBackLayer).toBeTruthy();
  act(() => history.back());
  await waitFor(() => expect(next).toHaveBeenCalledOnce());
});

it("替换弹层时，旧层异步回收不会关闭新层", async () => {
  const first = vi.fn();
  const second = vi.fn();
  function Layer({ name }: { name: string }) {
    useMobileBack(true, name === "first" ? first : second);
    return null;
  }
  const view = render(<Layer key="first" name="first" />);
  const oldId = history.state.mobileBackLayer;
  view.rerender(<Layer key="second" name="second" />);
  await waitFor(() => expect(history.state?.mobileBackLayer).not.toBe(oldId));
  expect(second).not.toHaveBeenCalled();
  act(() => history.back());
  await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  expect(first).not.toHaveBeenCalled();
});

it("会话上有弹层时先收起弹层，再返回才触发会话确认", async () => {
  const sessionBack = vi.fn();
  const sheetBack = vi.fn();
  const { result } = renderHook(() => {
    const [open, setOpen] = useState(false);
    useMobileBack(true, sessionBack, true);
    useMobileBack(open, () => {
      sheetBack();
      setOpen(false);
    });
    return setOpen;
  });
  act(() => result.current(true));
  act(() => history.back());
  await waitFor(() => expect(sheetBack).toHaveBeenCalledTimes(1));
  expect(sessionBack).not.toHaveBeenCalled();
  act(() => history.back());
  await waitFor(() => expect(sessionBack).toHaveBeenCalledTimes(1));
  expect(history.state?.mobileBackLayer).toBeTruthy();
});
