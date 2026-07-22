import { useEffect, useRef, ReactNode } from "react";

/**
 * 共享焦点陷阱包装器（修复 U31）
 * - 将 Tab / Shift+Tab 焦点限制在对话框内部，避免焦点移出到背景内容
 * - 渲染 role="dialog" aria-modal="true"，让屏幕阅读器感知对话框已打开
 * - 挂载时自动聚焦首个可聚焦元素；卸载时恢复原焦点
 * - 使用 display:contents 保持布局透明，不破坏对话框的 flex 结构
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FocusTrap({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const prevFocused = document.activeElement as HTMLElement | null;

    // 挂载时聚焦首个可聚焦元素（对话框打开即获得焦点）
    const first = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (first) first.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((f) => f.offsetParent !== null || f === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        // Shift+Tab：在首元素（或焦点不在容器内）时跳回末尾
        if (!activeEl || activeEl === firstEl || !el.contains(activeEl)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        // Tab：在末元素（或焦点不在容器内）时跳回开头
        if (!activeEl || activeEl === lastEl || !el.contains(activeEl)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };

    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      // 卸载时恢复打开对话框前的焦点
      if (prevFocused && typeof prevFocused.focus === "function") {
        prevFocused.focus();
      }
    };
  }, [active]);

  return (
    <div ref={ref} role="dialog" aria-modal="true" style={{ display: "contents" }}>
      {children}
    </div>
  );
}
