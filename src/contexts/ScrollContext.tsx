import { createContext, useContext, useEffect, RefObject } from "react";
import type Lenis from "lenis";

interface ScrollContextValue {
  scrollRef: RefObject<HTMLDivElement | null>;
  lenisRef: RefObject<Lenis | null>;
}

const ScrollContext = createContext<ScrollContextValue | null>(null);

export function ScrollProvider({
  scrollRef,
  lenisRef,
  children,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  lenisRef: RefObject<Lenis | null>;
  children: React.ReactNode;
}) {
  return (
    <ScrollContext.Provider value={{ scrollRef, lenisRef }}>
      {children}
    </ScrollContext.Provider>
  );
}

export function useScrollRef(): RefObject<HTMLDivElement | null> | null {
  return useContext(ScrollContext)?.scrollRef ?? null;
}

export function useLenisRef(): RefObject<Lenis | null> | null {
  return useContext(ScrollContext)?.lenisRef ?? null;
}

// 模态弹框滚动锁：打开任意模态时暂停主窗口 Lenis 平滑滚动，
// 避免弹框内滚轮穿透到底层列表（Lenis 全局接管 wheel 的已知副作用）。
// 用全局引用计数支持嵌套弹框：最后一层关闭才真正恢复 Lenis。
let modalScrollLockCount = 0;

export function useModalScrollLock(): void {
  const lenisRef = useLenisRef();
  useEffect(() => {
    const lenis = lenisRef?.current ?? null;
    modalScrollLockCount += 1;
    if (modalScrollLockCount === 1 && lenis) {
      lenis.stop();
    }
    return () => {
      modalScrollLockCount -= 1;
      if (modalScrollLockCount <= 0) {
        modalScrollLockCount = 0;
        lenis?.start();
      }
    };
  }, [lenisRef]);
}
