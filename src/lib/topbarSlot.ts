/**
 * topbarSlot.ts —— 顶栏「模式专属段」插槽的地址簿。
 *
 * `TopBar` 渲染一个空容器并把它登记在这里；各个模式的主体组件（目前只有
 * `KnowledgeView`）拿到这个节点后用 `createPortal` 把自己的按钮投进去。
 *
 * ❗ **为什么绕这一圈，而不是把按钮直接写进 `TopBar`：**
 * 知识模式那个「⋯」菜单靠 `CtxMenuCtx`，而那个 Provider 在 `KnowledgeView`
 * **内部**（`TopBar` 是它的兄弟节点，在 Provider 外面）。`createPortal` 只改
 * **DOM 落点**、不改 **React 树位置**，所以投出去的按钮在 React 树上仍然在
 * Provider 里，`useContext` 照常拿得到。直接写进 `TopBar` 的话菜单永远弹不出来。
 *
 * 同理，这里也不把 `KnowledgeView` 的状态提升到 store：`moreItems` / `newFolderId`
 * 全长在它的四个 hook 上，而那个文件头部明写「它自己不持有任何业务状态」。
 *
 * 单例是故意的：主窗口只有一个 `TopBar`。托盘弹窗（`TrayPopup`）是另一个
 * webview，模块实例不共享，不会互相覆盖。
 */
import { useSyncExternalStore } from "react";

let slotEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

/**
 * 登记（或注销）插槽节点。直接当 `ref` 回调用：
 * `<div ref={setTopBarSlot} />`——它是模块级的稳定函数，不会每次渲染都拆装一遍。
 * 卸载时 React 会传 null，订阅方随之拿到 null 并停止 portal。
 */
export function setTopBarSlot(node: HTMLElement | null) {
  if (slotEl === node) return;
  slotEl = node;
  listeners.forEach((fn) => fn());
}

/**
 * 订阅插槽节点。返回 null 表示顶栏还没挂上（或已卸载），此时不该 portal。
 *
 * 用 `useSyncExternalStore` 而不是 `useEffect` + `useState`：插槽节点是在
 * **commit 阶段**由 ref 回调写入的，而订阅方可能在同一轮里先渲染；
 * 外部 store 能把这个时序差变成一次普通的重渲染，不用自己写轮询或延迟。
 */
export function useTopBarSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => slotEl,
    // SSR 快照：项目不做服务端渲染，给一个恒 null 以满足类型。
    () => null,
  );
}
