/**
 * ScrollContext.test.tsx — 滚动上下文单元测试
 *
 * 覆盖：
 * - ScrollProvider 正常提供 scrollRef / lenisRef
 * - useScrollRef 在 Provider 内外行为
 * - useLenisRef 在 Provider 内外行为
 * - 边界：null ref 值也能正常传递
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import React, { createRef, type RefObject } from "react";
import { ScrollProvider, useScrollRef, useLenisRef } from "@/contexts/ScrollContext";

// 创建 mock ref 对象
function createMockRef<T>(current: T): RefObject<T | null> {
  const ref = createRef<T>();
  (ref as any).current = current;
  return ref as RefObject<T | null>;
}

describe("ScrollContext", () => {
  describe("ScrollProvider", () => {
    it("正常渲染不崩溃", () => {
      const scrollRef = createMockRef<HTMLDivElement>(document.createElement("div"));
      const lenisRef = createMockRef<any>(null);

      const { result } = renderHook(
        () => useScrollRef(),
        {
          wrapper: ({ children }) => (
            <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
              {children}
            </ScrollProvider>
          ),
        },
      );

      expect(result.current).toBe(scrollRef);
    });
  });

  describe("useScrollRef", () => {
    it("在 ScrollProvider 内返回传入的 scrollRef", () => {
      const scrollRef = createMockRef<HTMLDivElement>(document.createElement("div"));
      const lenisRef = createMockRef<any>(null);

      const { result } = renderHook(() => useScrollRef(), {
        wrapper: ({ children }) => (
          <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
            {children}
          </ScrollProvider>
        ),
      });

      expect(result.current).toBe(scrollRef);
    });

    it("在 ScrollProvider 外返回 null", () => {
      const { result } = renderHook(() => useScrollRef());
      expect(result.current).toBeNull();
    });

    it("scrollRef 为 null 时也能正常传递", () => {
      const nullRef = createMockRef<HTMLDivElement | null>(null);
      const lenisRef = createMockRef<any>(null);

      const { result } = renderHook(() => useScrollRef(), {
        wrapper: ({ children }) => (
          <ScrollProvider scrollRef={nullRef} lenisRef={lenisRef}>
            {children}
          </ScrollProvider>
        ),
      });

      expect(result.current).toBe(nullRef);
    });
  });

  describe("useLenisRef", () => {
    it("在 ScrollProvider 内返回传入的 lenisRef", () => {
      const scrollRef = createMockRef<HTMLDivElement>(document.createElement("div"));
      const lenisRef = createMockRef<any>({ someLenisObject: true });

      const { result } = renderHook(() => useLenisRef(), {
        wrapper: ({ children }) => (
          <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
            {children}
          </ScrollProvider>
        ),
      });

      expect(result.current).toBe(lenisRef);
    });

    it("在 ScrollProvider 外返回 null", () => {
      const { result } = renderHook(() => useLenisRef());
      expect(result.current).toBeNull();
    });

    it("lenisRef 为 null 时也能正常传递", () => {
      const scrollRef = createMockRef<HTMLDivElement>(document.createElement("div"));
      const nullLenis = createMockRef<any>(null);

      const { result } = renderHook(() => useLenisRef(), {
        wrapper: ({ children }) => (
          <ScrollProvider scrollRef={scrollRef} lenisRef={nullLenis}>
            {children}
          </ScrollProvider>
        ),
      });

      expect(result.current).toBe(nullLenis);
    });
  });

  describe("组合使用", () => {
    it("useScrollRef 和 useLenisRef 在同一 Provider 下都能获取到正确的值", () => {
      const scrollRef = createMockRef<HTMLDivElement>(document.createElement("div"));
      const lenisRef = createMockRef<any>({ destroy: () => {} });

      const { result: scrollResult } = renderHook(() => useScrollRef(), {
        wrapper: ({ children }) => (
          <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
            {children}
          </ScrollProvider>
        ),
      });

      const { result: lenisResult } = renderHook(() => useLenisRef(), {
        wrapper: ({ children }) => (
          <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
            {children}
          </ScrollProvider>
        ),
      });

      expect(scrollResult.current).toBe(scrollRef);
      expect(lenisResult.current).toBe(lenisRef);
    });
  });
});
