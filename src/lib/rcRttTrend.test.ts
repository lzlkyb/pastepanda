import { describe, expect, it } from "vitest";
import { pushRttSample, resetRttTrend, rttTrendWindow } from "./rcRttTrend";

describe("rcRttTrend", () => {
  it("0/负样本不记点（无 pong 时不拿 0 充数）", () => {
    resetRttTrend();
    pushRttSample(0);
    pushRttSample(-5);
    expect(rttTrendWindow(60)).toHaveLength(0);
  });

  it("同值连续 push 去重（EMA 未变不因 re-render 加粗趋势线）", () => {
    resetRttTrend();
    pushRttSample(20);
    pushRttSample(20);
    pushRttSample(20);
    expect(rttTrendWindow(60)).toHaveLength(1);
  });

  it("窗口外的陈旧点被滤掉", () => {
    resetRttTrend();
    const now = 2_000_000_000_000;
    pushRttSample(11, now - 90_000);
    pushRttSample(22, now - 30_000);
    const win = rttTrendWindow(60, now);
    expect(win.map((s) => s.ms)).toEqual([22]);
  });

  it("环形缓冲封顶，驻留内存有上界", () => {
    resetRttTrend();
    for (let i = 1; i <= 400; i++) pushRttSample(i, 2_000_000_000_000 + i);
    expect(rttTrendWindow(10_000_000).length).toBeLessThanOrEqual(300);
  });
});
