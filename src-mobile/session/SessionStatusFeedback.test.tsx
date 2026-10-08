import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAcknowledgedSendFailure } from "./SessionStatusFeedback";

it("关闭输入失败后保持确认状态，恢复后新的失败再次显示", () => {
  const view = renderHook(({ failed }) => useAcknowledgedSendFailure(failed), { initialProps: { failed: true } });
  expect(view.result.current.visible).toBe(true);
  act(() => view.result.current.dismiss());
  view.rerender({ failed: true });
  expect(view.result.current.visible).toBe(false);
  view.rerender({ failed: false });
  view.rerender({ failed: true });
  expect(view.result.current.visible).toBe(true);
});
