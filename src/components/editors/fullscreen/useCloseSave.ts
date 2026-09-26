/**
 * 关闭前保存（宿主的多标签关闭守卫逐项调用，返回「是否已处置完毕」）。
 *
 * 返回布尔而不是自己关窗，是本次多标签改造的关键改动：
 * 原 `handleConfirmClose` 在失败/取消时靠 `return` 半途退出且不调 onClose，
 * 单标签时代够用；多标签下宿主必须**全部**标签都处置成功后才关窗，
 * 否则会出现「关到一半卡住、剩下几个标签还开着而窗口已经要关」。
 *
 * 这里是最后一道冲突闸门 —— 窗口关掉之后用户再没机会挑回来了，
 * 所以外部改动不被确认就**不关**（`return false`，宿主据此保留窗口）。
 *
 * 从 `useDocumentFile` 拆出，动因是 `docs/结构设计规范.md` §3.1 的 `.ts ≤ 400` 红线。
 */
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { FileWatch } from "../useFileWatch";

export interface CloseSaveOptions {
  effectiveSourceId: string | null;
  currentFilePath: string | null;
  text: string;
  fileWatch: FileWatch;
}

export function useCloseSave({
  effectiveSourceId,
  currentFilePath,
  text,
  fileWatch,
}: CloseSaveOptions): () => Promise<boolean> {
  const { checkNow, markSynced } = fileWatch;

  return useCallback(async (): Promise<boolean> => {
    if (effectiveSourceId) {
      try {
        await invoke("update_history", { id: effectiveSourceId, text });
        return true;
      } catch {
        return false;
      }
    }
    // 未命名文档：没有落盘目标，无处可存，视为已处置（与原行为一致）
    if (!currentFilePath) return true;
    if (await checkNow()) {
      const overwrite = await ask(
        "这个文件已被外部程序修改。\n\n保存并关闭会覆盖掉外部的改动。",
        {
          title: "文件已在外部修改",
          kind: "warning",
          okLabel: "仍然覆盖并关闭",
          cancelLabel: "不关闭，我自己处理",
        }
      );
      if (!overwrite) return false; // 注意：宿主据此不关，窗口留着
    }
    try {
      await invoke("write_text_file_full", { path: currentFilePath, text });
      await markSynced(currentFilePath);
      return true;
    } catch {
      return false;
    }
    // 依赖里放 checkNow/markSynced 而不是 fileWatch 对象：方法身份稳定
    // （markSynced 恒定、checkNow 只在 filePath 变时才换），既不会多余重跑，
    // 也不会在 useFileWatch 改内部依赖时静默失联。
  }, [effectiveSourceId, currentFilePath, text, checkNow, markSynced]);
}
