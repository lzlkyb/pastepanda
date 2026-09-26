/**
 * 编辑器窗口级快捷键。
 *
 *   Ctrl+W      关闭当前标签（脏则进守卫）
 *   Ctrl+T      新建空白文档
 *   Ctrl+Tab    下一个标签（Shift 反向，环状）
 *   Ctrl+1..9   跳到第 N 个标签（超出范围不拦，避免吞掉浏览器/系统默认行为）
 *
 * ❗ 只挂在宿主一份。改造前 `FullscreenInner` 里每个文档各自监听 Ctrl+S / Esc，
 * 多标签下按一次 Esc 会 12 个标签同时弹守卫 —— 所以文档级的那些现在都带
 * `active` 门控（见 CodeDocument），窗口级的这套只此一处。
 *
 * 从 `FullscreenEditor.tsx`（宿主）拆出，动因是规则 7 的体量红线。
 */
import { useEffect } from "react";
import type { EditorTab } from "./useEditorTabs";
import type { MutableRefObject } from "react";

export interface EditorWindowKeysOptions {
  activeIdRef: MutableRefObject<string | null>;
  tabsRef: MutableRefObject<EditorTab[]>;
  select: (id: string) => void;
  requestCloseTab: (id: string) => void;
  /** 新建空白文档（Ctrl+T 与标签栏 + 按钮共用） */
  onNewTab: () => void;
}

export function useEditorWindowKeys({
  activeIdRef,
  tabsRef,
  select,
  requestCloseTab,
  onNewTab,
}: EditorWindowKeysOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "w") {
        e.preventDefault();
        const id = activeIdRef.current;
        if (id) requestCloseTab(id);
        return;
      }
      if (key === "t") {
        e.preventDefault();
        onNewTab();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const list = tabsRef.current;
        if (list.length < 2) return;
        const i = list.findIndex((t) => t.id === activeIdRef.current);
        const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
        if (next) select(next.id);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const target = tabsRef.current[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          select(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIdRef, onNewTab, requestCloseTab, select, tabsRef]);
}
