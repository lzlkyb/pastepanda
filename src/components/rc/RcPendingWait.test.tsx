import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { RcPendingWait } from "./RcPendingWait";
import styles from "./RemoteComputer.module.css";

/** jsdom 无布局：这里只断言「文案与进度条是否按 started_ms 算」这类事实。 */

const T0 = 1_700_000_000_000; // 固定时钟，避免真实时间的秒级抖动

function renderWait(extra: Partial<Parameters<typeof RcPendingWait>[0]> = {}) {
  return render(
    <RcPendingWait
      peerName="工作电脑"
      capability="control"
      startedMs={T0 - 12_000}
      busy={false}
      onCancel={() => {}}
      {...extra}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RcPendingWait 倒计时与进度（批3）", () => {
  it("按 120s 窗口给出剩余时间、已等待与进度条", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { container, getByText } = renderWait();
    expect(getByText(/1 分 48 秒后自动取消/)).toBeDefined();
    expect(getByText(/已等待 12 秒/)).toBeDefined();
    const bar = container.querySelector(`.${styles.waitTrack}`);
    expect(bar!.getAttribute("aria-valuenow")).toBe("10");
    const fill = container.querySelector<HTMLElement>(`.${styles.waitFill}`);
    expect(fill!.style.width).toBe("10%");
  });

  it("到点后说「正在收尾」，不出现「0 秒后自动取消」", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { getByText, queryByText } = renderWait();
    act(() => vi.advanceTimersByTime(108_000));
    expect(getByText(/等待超时，正在收尾/)).toBeDefined();
    expect(queryByText(/0 秒后自动取消/)).toBeNull();
  });

  it("起点不可用 → 不给倒计时也不给进度条（不编造）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { container, getByText } = renderWait({ startedMs: null });
    expect(getByText(/2 分钟内未响应将自动取消/)).toBeDefined();
    expect(container.querySelector(`.${styles.waitTrack}`)).toBeNull();
  });

  it("一直保留「取消申请」；capability=control 时不渲染「改为可控」", () => {
    const { getByText, queryByText } = renderWait();
    expect(getByText("取消申请")).toBeDefined();
    expect(queryByText("改为可控")).toBeNull();
  });
});
