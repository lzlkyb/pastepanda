import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFirstTimeTip } from "@/hooks/useFirstTimeTip";

const STORAGE_KEY = "pastepanda_shown_tips";

beforeEach(() => {
  localStorage.clear();
});

describe("useFirstTimeTip", () => {
  it("shouldShow returns true for never-seen tip", () => {
    const { result } = renderHook(() => useFirstTimeTip());

    expect(result.current.shouldShow("welcome-tip")).toBe(true);
  });

  it("shouldShow returns false after markShown", () => {
    const { result } = renderHook(() => useFirstTimeTip());

    act(() => {
      result.current.markShown("welcome-tip");
    });

    expect(result.current.shouldShow("welcome-tip")).toBe(false);
  });

  it("markShown persists to localStorage", () => {
    const { result } = renderHook(() => useFirstTimeTip());

    act(() => {
      result.current.markShown("tip-1");
      result.current.markShown("tip-2");
    });

    // 检查 localStorage
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toContain("tip-1");
    expect(stored).toContain("tip-2");
    expect(stored).toHaveLength(2);
  });

  it("different tipIds are independent", () => {
    const { result } = renderHook(() => useFirstTimeTip());

    act(() => {
      result.current.markShown("tip-a");
    });

    expect(result.current.shouldShow("tip-a")).toBe(false);
    expect(result.current.shouldShow("tip-b")).toBe(true);
  });

  it("loads previously shown tips from localStorage", () => {
    // 预设已看过的 tip
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["old-tip"]));

    const { result } = renderHook(() => useFirstTimeTip());

    expect(result.current.shouldShow("old-tip")).toBe(false);
    expect(result.current.shouldShow("new-tip")).toBe(true);
  });

  it("handles corrupt localStorage gracefully", () => {
    localStorage.setItem(STORAGE_KEY, "not-valid-json{{[");

    const { result } = renderHook(() => useFirstTimeTip());

    // 损坏的 JSON 被当作空 Set
    expect(result.current.shouldShow("any-tip")).toBe(true);

    // 标记后仍能正常工作
    act(() => {
      result.current.markShown("tip-x");
    });

    expect(result.current.shouldShow("tip-x")).toBe(false);
  });

  it("multiple hooks share the same storage", () => {
    const { result: hook1 } = renderHook(() => useFirstTimeTip());
    const { result: hook2 } = renderHook(() => useFirstTimeTip());

    act(() => {
      hook1.current.markShown("shared-tip");
    });

    expect(hook2.current.shouldShow("shared-tip")).toBe(false);
  });
});
