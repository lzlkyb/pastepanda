/**
 * 菜单的输入处理：键盘导航、关闭时机、Shift+F10 唤出。
 *
 * 三个 effect 都挂在 window 上 —— 菜单是 portal 出去的，焦点也不一定在它身上，
 * 挂在元素上收不到。
 */

import { useCallback, useEffect, useState, type RefObject } from "react";
import { useAppStore } from "@/stores/appStore";
import { navigableSubIndexes, stepSubIndex, type MenuItem } from "./menuModel";

/**
 * 当前高亮项 + 键盘导航。
 *
 * activeIndex 索引 flatItems（可落点的顶层项），activeSubIndex 索引该父项的
 * children **真实下标**（不是紧凑序号）—— 所以移动必须过 stepSubIndex，
 * 它会跳过非交互子项、并在端点停住。
 */
export function useMenuKeyboard(params: {
  open: boolean;
  flatItems: MenuItem[];
  onClose: () => void;
}) {
  const { open, flatItems, onClose } = params;
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null);

  /** 回到"什么都没选中"（每次重新打开菜单时调用） */
  const resetActive = useCallback(() => {
    setActiveIndex(-1);
    setActiveSubIndex(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const parentItem = flatItems[activeIndex];
      const subIdxs = navigableSubIndexes(parentItem);
      const inSub = activeSubIndex !== null;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (inSub) {
          // 在子菜单里就在子项之间走。以前这里无条件退出子菜单再移动父项索引，于是
          // 子菜单第 2 项往后键盘永远到不了；更糟的是 ArrowDown 会静默跳到紧邻的顶层项
          // ——「更多操作」后面正好是「删除」——再按 Enter 就把条目删了。
          setActiveSubIndex((cur) => stepSubIndex(subIdxs, cur, 1));
        } else {
          setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (inSub) {
          setActiveSubIndex((cur) => stepSubIndex(subIdxs, cur, -1));
        } else {
          setActiveIndex((i) => Math.max(i - 1, 0));
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        if (inSub) setActiveSubIndex(subIdxs[0] ?? null);
        else setActiveIndex(flatItems.length > 0 ? 0 : -1);
      } else if (e.key === "End") {
        e.preventDefault();
        if (inSub) setActiveSubIndex(subIdxs[subIdxs.length - 1] ?? null);
        else setActiveIndex(flatItems.length - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (inSub) {
          if (parentItem?.children?.[activeSubIndex]) {
            parentItem.children[activeSubIndex].onClick?.();
            onClose();
          }
        } else if (activeIndex >= 0 && activeIndex < flatItems.length) {
          const item = flatItems[activeIndex];
          if (item.onClick) {
            item.onClick();
            onClose();
          } else if (item.children) {
            // 展开子菜单，落在首个可点子项
            setActiveSubIndex(subIdxs[0] ?? null);
          }
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (activeIndex >= 0 && parentItem?.children && !inSub) {
          setActiveSubIndex(subIdxs[0] ?? null);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (inSub) setActiveSubIndex(null);
      } else if (e.key === "Escape") {
        // Esc 逐层退：先收子菜单，再关整个菜单
        if (inSub) setActiveSubIndex(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, activeIndex, activeSubIndex, flatItems, onClose]);

  return { activeIndex, activeSubIndex, setActiveIndex, setActiveSubIndex, resetActive };
}

/**
 * 关闭时机：点菜单外面、右键别处、滚动、滚轮、窗口失焦、改窗口大小。
 *
 * 滚动那几类必须管：菜单是 position:fixed，视口一变它就停在旧坐标上，指着的已经
 * 不是原来那张卡片了，而菜单项还是那张卡的。
 */
export function useMenuDismiss(params: {
  open: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const { open, menuRef, onClose } = params;
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      // 忽略菜单自身区域内的事件（子菜单限高时内部要能自己滚）
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      onClose();
    };
    // 这几类不可能是"打开菜单的那一下"，所以立刻注册、不用等下一帧。
    // scroll 不冒泡，必须用捕获才收得到内层滚动容器的。
    window.addEventListener("scroll", close, true);
    window.addEventListener("wheel", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    // 用 mousedown 而不是 click（更早触发，更可靠）。
    // 用 requestAnimationFrame 而不是固定延时来注册：打开菜单的那次原生
    // mousedown/contextmenu 事件在本次调用栈内已经完整派发完毕（JS 单线程，
    // 捕获/冒泡阶段必须先跑完；effect 本身也只在该调用栈结束后才执行），
    // 所以哪怕下一帧就注册也收不到"打开菜单"的那个事件 —— 不需要固定延时窗口
    // 或"跳过首个事件"那种脆弱兜底，那样反而会把真实的关闭点击一起吞掉。
    const raf = requestAnimationFrame(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("contextmenu", close);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [open, menuRef, onClose]);
}

/**
 * U40：键盘唤出右键菜单（Shift+F10 / ContextMenu 键）。
 *
 * 做法是在"当前聚焦/选中的那张卡片"上派发一个原生 contextmenu 事件，让卡片自己的
 * 监听器带着**正确的菜单项**打开 —— 而不是由这里直接开菜单。没有目标卡片时什么都不做：
 * 以前会回退到"列表区中心"开菜单，但那条路径只设坐标不设菜单项，弹出来的是上一次
 * 那张卡的菜单，键盘用户按一下就能对自己没选中的卡片执行删除。
 */
export function useContextMenuHotkey() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      // 定位目标卡片：优先键盘焦点项，其次首个选中项
      const store = useAppStore.getState();
      const targetId = store.focusId || (store.selectedIds.size > 0 ? [...store.selectedIds][0] : null);
      const cardEl = targetId
        ? document.querySelector(`[data-item-id="${targetId}"] [role="option"]`)
        : null;
      if (!cardEl) return;
      const rect = cardEl.getBoundingClientRect();
      cardEl.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.min(48, rect.width / 3),
        clientY: rect.top + rect.height / 2,
      }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
