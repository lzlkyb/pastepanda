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

export function FocusTrap({
  children,
  active = true,
  initialFocus,
}: {
  children: ReactNode;
  active?: boolean;
  /** 审查：指定挂载后聚焦的元素选择器——默认聚焦首个可聚焦元素（常是头部 X 按钮），
   *  会把 ConfirmDialog/PasteGuard 的 autoFocus 主操作覆盖掉；传 selector 如 "[data-autofocus]" 跳过头部 */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const prevFocused = document.activeElement as HTMLElement | null;

    // 挂载时聚焦：优先 initialFocus 指定元素，否则首个可聚焦元素
    const target = initialFocus
      ? el.querySelector<HTMLElement>(initialFocus)
      : el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (target) target.focus();

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
    // initialFocus 只在 active 变 true 的那一瞬消费（决定初始焦点）。
    // 把它列进依赖，父组件改一下选择器就会重装 keydown 并把焦点抢回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <div ref={ref} role="dialog" aria-modal="true" style={{ display: "contents" }}>
      {children}
    </div>
  );
}
