/**
 * ScrollContext.test.tsx — 滚动上下文单元测试
 *
 * 覆盖：
 * - ScrollProvider 正常提供 scrollRef / lenisRef
 * - useScrollRef 在 Provider 内外行为
 * - useLenisRef 在 Provider 内外行为
 * - 边界：null ref 值也能正常传递
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, render, screen, fireEvent } from "@testing-library/react";
import React, { createRef, useState, type RefObject } from "react";
import { ScrollProvider, useScrollRef, useLenisRef, useModalScrollLock } from "@/contexts/ScrollContext";

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


// ============================================================
// 🔴 批次③（2026-10-24）：Lenis 迟到也要锁上
// 改前 useModalScrollLock 只在 count===1 时尝试 stop，且在挂载时捕获一次
// Lenis 实例——启动早期弹出的模态（更新/里程碑弹窗）永远锁不上，弹框内
// 滚轮穿透到底层卡片列表。改前此用例为红。
// ============================================================
describe("useModalScrollLock 批次③：Lenis 迟到也要锁上", () => {
  it("弹窗先于 Lenis 挂载，Lenis 就绪后再开第二个弹窗 → 迟到的 Lenis 必须被 stop", () => {
    const lenis = { stop: vi.fn(), start: vi.fn() };
    const lenisRef = createMockRef<any>(null);
    const scrollRef = createMockRef<HTMLDivElement>(document.createElement("div"));

    function Modal() {
      useModalScrollLock();
      return null;
    }
    function Harness() {
      const [count, setCount] = useState(1);
      return (
        <ScrollProvider scrollRef={scrollRef} lenisRef={lenisRef}>
          {Array.from({ length: count }, (_, i) => (
            <Modal key={i} />
          ))}
          <button onClick={() => setCount((c) => c + 1)}>add</button>
        </ScrollProvider>
      );
    }

    const { unmount } = render(<Harness />);
    // 第一个弹窗在 Lenis 就绪前打开：此刻没有 Lenis 可锁是事实；
    // 但 Lenis 就绪后打开第二个弹窗，必须真的把它 stop 住——
    // 改前 stop 只在 count===1 时尝试，第二个弹窗看到 count===2 永远不再尝试。
    lenisRef.current = lenis;
    fireEvent.click(screen.getByText("add"));
    expect(lenis.stop, "Lenis 就绪后新弹窗必须真正锁住滚动").toHaveBeenCalled();

    unmount();
    expect(lenis.start, "全部弹窗关闭后必须恢复滚动").toHaveBeenCalled();
  });
});
