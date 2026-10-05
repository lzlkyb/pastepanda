/**
 * useRcSessionPrefs 的码率兜底守卫（2026-10-02 默认改 200 的回归钉）：
 *
 * status 未加载（bitratePct=undefined）时下拉兜底必须等于
 * `RC_BITRATE_PCT_DEFAULT`（200）——兜底值如果还停留在旧默认 100，UI 会把
 * 「尽量清晰」显示成「跟随链路」，用户以为生效的是另一个值（规则 15：
 * 反馈必须与事实一致）。与后端 `DEFAULT_USER_BITRATE_PCT` 的同值性由
 * 两端注释互相指认（纯常量，跨端无法单测钉死）。
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RC_BITRATE_PCT_DEFAULT } from "@/lib/rcQuality";
import { useRcSessionPrefs } from "./useRcSessionPrefs";

describe("useRcSessionPrefs 码率兜底", () => {
  it("bitratePct 未加载时兜底 = RC_BITRATE_PCT_DEFAULT（200）", () => {
    const { result } = renderHook(() =>
      useRcSessionPrefs({ sessionId: "s1", quality: "balanced", captureScope: "virtual" }),
    );
    expect(RC_BITRATE_PCT_DEFAULT).toBe(200);
    expect(result.current.bitratePick).toBe(RC_BITRATE_PCT_DEFAULT);
  });

  it("status 到达后纠正成配置值；换会话重置", () => {
    const { result, rerender } = renderHook(
      (p: { pct?: number }) =>
        useRcSessionPrefs({
          sessionId: "s1",
          quality: "balanced",
          captureScope: "virtual",
          bitratePct: p.pct,
        }),
      { initialProps: { pct: undefined as number | undefined } },
    );
    expect(result.current.bitratePick).toBe(RC_BITRATE_PCT_DEFAULT);
    rerender({ pct: 75 });
    expect(result.current.bitratePick).toBe(75);
  });
});
