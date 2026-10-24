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

/** 当前是否有模态滚动锁在场。Lenis 的创建方（useSmoothScroll 等）在初始化时
 *  读它：锁先于 Lenis 存在的窗口期（启动早期弹出的更新/里程碑弹窗）由创建方补锁。 */
export function isModalScrollLocked(): boolean {
  return modalScrollLockCount > 0;
}

export function useModalScrollLock(): void {
  const lenisRef = useLenisRef();
  useEffect(() => {
    modalScrollLockCount += 1;
    // 🔴 批次③：改前（a）挂载时捕获一次 Lenis 实例、（b）只在 count===1 时
    // 尝试 stop——第一个弹窗先于 Lenis 就绪打开时就永远锁不上，之后第二个
    // 弹窗看到 count===2 也不再尝试，弹框内滚轮穿透到底层列表。
    // 现在：每次有弹窗进场都**现取** lenisRef.current 并 stop（幂等），
    // Lenis 迟到的情况由创建方经 isModalScrollLocked() 补锁。
    lenisRef?.current?.stop();
    return () => {
      modalScrollLockCount -= 1;
      if (modalScrollLockCount <= 0) {
        modalScrollLockCount = 0;
        // 刻意读 cleanup 时刻的实例，不按 exhaustive-deps 建议拷贝挂载时的值：
        // Lenis 可能在此期间销毁重建，恢复的必须是当前活着的那个——
        // 「挂载时拷贝一份」正是本次修掉的 bug 形态（Lenis 迟到 = 锁不住/恢复错实例）。
        // eslint-disable-next-line react-hooks/exhaustive-deps
        lenisRef?.current?.start();
      }
    };
  }, [lenisRef]);
}
