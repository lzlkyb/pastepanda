import { useState, useRef, useCallback, useEffect } from "react";
import { useToast } from "@/components/Toast";
import { pasteTextGuarded } from "@/lib/api";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import type { EditorActions } from "@/lib/editorRegistry";

/**
 * 文本类编辑器共享核心（方案 A）：
 * 文本状态 + 撤销/重做 + 保存/复制/粘贴/存片段 + 能力注册。
 * TextEditor / MarkdownEditor（以及 P2 的 json/html 编辑器）均基于此构建。
 */
export function useEditorCore(item: HistoryItem, registerActions: (a: EditorActions) => void) {
  const [text, setText] = useState(item?.text || "");
  const { toast } = useToast();
  const originalText = item?.text || "";

  // 撤销/重做历史（纯文本级别，30 步）
  const historyRef = useRef<string[]>([item?.text || ""]);
  const historyIdxRef = useRef(0);

  const pushHistory = useCallback((newText: string) => {
    const stack = historyRef.current;
    const idx = historyIdxRef.current;
    const newStack = stack.slice(0, idx + 1);
    newStack.push(newText);
    if (newStack.length > 30) newStack.shift();
    historyRef.current = newStack;
    historyIdxRef.current = newStack.length - 1;
    setText(newText);
  }, []);

  const undo = useCallback(() => {
    if (historyIdxRef.current > 0) {
      historyIdxRef.current--;
      setText(historyRef.current[historyIdxRef.current]);
    }
  }, []);

  const redo = useCallback(() => {
    if (historyIdxRef.current < historyRef.current.length - 1) {
      historyIdxRef.current++;
      setText(historyRef.current[historyIdxRef.current]);
    }
  }, []);

  // 最新文本入 ref，供注册给外壳的闭包读取（避免过期快照）
  const textRef = useRef(text);
  textRef.current = text;

  /** 保存：invoke + 乐观更新 + top-200 刷新（修复 C12：基于回调时刻最新 state） */
  const save = useCallback(async (): Promise<boolean> => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("update_history", { id: item.id, text: textRef.current });
      // 乐观更新 — 基于最新 state 函数式更新（text 影响搜索过滤，同步清 _filterCache）
      useAppStore.setState((s) => ({
        history: s.history.map((h) =>
          h.id === item.id ? { ...h, text: textRef.current, md5: undefined } : h
        ),
        _filterCache: null,
      }));
      // 刷新必须基于回调时刻的最新 state — 仅替换后端响应中存在的条目，
      // 不在 top-200 内的条目保持原样，避免丢弃请求期间新复制的条目。
      invoke<HistoryItem[]>("get_history", {
        workspace: useAppStore.getState().config.current_workspace, filter: "all",
        search: "", offset: 0, limit: 200,
      }).then((items) => {
        const backendMap = new Map(items.map((i) => [i.id, i]));
        useAppStore.setState((s) => ({
          history: s.history.map((h) => backendMap.get(h.id) || h),
          _filterCache: null,
        }));
      }).catch(() => {});
      toast("已保存", "success");
      return true;
    } catch (e) {
      toast("保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
      return false;
    }
  }, [item.id, toast]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textRef.current);
      toast("已复制到剪贴板", "success");
    } catch { toast("复制失败", "error"); }
  }, [toast]);

  const paste = useCallback(async () => {
    // 仅粘贴成功时弹成功提示（pasteText 失败时已自行弹错误 toast）
    const ok = await pasteTextGuarded(textRef.current);
    if (ok) {
      toast("已粘贴", "success");
      // 粘贴信号回写（此前漏记）。编辑器里粘的可能是改过的文本，但**这条历史确实被用上了**，
      // 「按价值豁免过期清理」要的就是这个信号。编辑器内没有列表位置，下标传 -1。
      const { logItemPasted } = await import("@/lib/api/actionEvents");
      logItemPasted(item, -1);
    }
  }, [item, toast]);

  const addSnippet = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("add_snippet", { name: textRef.current.slice(0, 30), content: textRef.current });
      toast("已添加到片段库", "success");
    } catch { toast("添加失败", "error"); }
  }, [toast]);

  const isDirty = useCallback(() => textRef.current !== originalText, [originalText]);

  // 每次渲染都重新注册，保证外壳拿到的闭包始终新鲜（同旧版 handleSaveRef 模式）
  useEffect(() => {
    registerActions({ save, copy, paste, addSnippet, isDirty });
  });

  return {
    text, setText, pushHistory, undo, redo,
    originalText, isModified: text !== originalText,
    save, copy, paste, addSnippet, isDirty,
  };
}
