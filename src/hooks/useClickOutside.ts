/**
 * useClickOutside — 点到元素外面时回调（关浮层 / 下拉 / 面板）。
 *
 * 全仓原本有 10 个文件各写了一遍同样的 effect（`BatchBar` 的注释甚至直说
 * 「跟 `ViewControls` 同一套做法」）。收口成一份（规则 #11）。
 *
 * ❗ 用 `mousedown` 而不是 `click`：
 *   用 `click` 时，在列表上按住拖选再松手也会算一次外部点击，体验上反应滞后。
 *   （这句是从 `ViewControls` 原注释里继承的，不是新推断。）
 *
 * ❗ 监在 `document` 而不是某个容器：浮层常常 portal 到 body，挂容器上接不到。
 */
import { useEffect, type RefObject } from "react";

export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, onOutside, enabled]);
}
