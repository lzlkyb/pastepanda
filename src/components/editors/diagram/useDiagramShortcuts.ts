/**
 * 画布快捷键（标准集）。
 *
 * 两条纪律，改动时别破坏：
 *  1. 仅当焦点在画布容器内（inCanvas）才拦截，避免劫持应用其它区域的 Ctrl+C/V 等。
 *     内嵌编辑器是弹窗形态，Delete 分支尤其要遵守，否则焦点在弹窗外按退格
 *     也会删掉选中节点。
 *  2. 输入框 / 文本域 / contentEditable 聚焦时一律不拦截。
 */
import { useEffect, type RefObject } from "react";

export interface DiagramShortcutOpts {
  /** 导入弹窗打开时整体关闭快捷键 */
  enabled: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  selectedEdgeId: string | null;
  hasClipboard: () => boolean;
  undo: () => void;
  redo: () => void;
  deleteTarget: () => void;
  duplicateNode: (id: string) => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  fitView: () => void;
  layout: () => void;
}

export function useDiagramShortcuts(o: DiagramShortcutOpts) {
  const {
    enabled, rootRef, selectedId, selectedEdgeId, hasClipboard,
    undo, redo, deleteTarget, duplicateNode, copySelected, pasteClipboard, fitView, layout,
  } = o;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!enabled) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const inCanvas = t ? rootRef.current?.contains(t) ?? false : false;
      if (!inCanvas) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "delete" || key === "backspace") {
        if (!(selectedId || selectedEdgeId)) return;
        e.preventDefault();
        deleteTarget();
      } else if (mod && key === "d") {
        if (!selectedId) return;
        e.preventDefault();
        duplicateNode(selectedId);
      } else if (mod && key === "c") {
        if (!selectedId) return; // 仅选中节点时拦截复制
        e.preventDefault();
        copySelected();
      } else if (mod && key === "v") {
        if (!hasClipboard()) return;
        e.preventDefault();
        pasteClipboard();
      } else if (!mod && key === "f") {
        e.preventDefault();
        fitView();
      } else if (!mod && key === "l") {
        e.preventDefault();
        layout();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    enabled, rootRef, selectedId, selectedEdgeId, hasClipboard,
    undo, redo, deleteTarget, duplicateNode, copySelected, pasteClipboard, fitView, layout,
  ]);
}
