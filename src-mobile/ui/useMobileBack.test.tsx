import { useState } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileBack } from "./useMobileBack";

afterEach(async () => {
  cleanup();
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeUndefined());
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
