import { useCallback, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FullscreenTypeSpec } from "./types";

interface Options {
  text: string;
  fileName: string;
  spec: FullscreenTypeSpec;
  latestText: RefObject<string>;
  markSynced: (path: string) => Promise<void>;
  setCurrentFilePath: (path: string) => void;
  setEffectiveSourceId: (id: string | null) => void;
  setFileName: (name: string) => void;
  setInitialContent: (text: string) => void;
  setIsDirty: (dirty: boolean) => void;
  setAutoSaveError: (failed: boolean) => void;
  notify: (text: string, kind: "success" | "error") => void;
}

/** Shared manual / close-save path. True only when this exact draft has been saved. */
export function useDocumentSaveAs({
  text, fileName, spec, latestText, markSynced, setCurrentFilePath,
  setEffectiveSourceId, setFileName, setInitialContent, setIsDirty,
  setAutoSaveError, notify,
}: Options): () => Promise<boolean> {
  return useCallback(async () => {
    try {
      const selectedPath = await save({ defaultPath: fileName, filters: [spec.fileFilter] });
      if (!selectedPath) return false;
      await invoke("write_text_file_full", { path: selectedPath, text });
      await markSynced(selectedPath);
      setCurrentFilePath(selectedPath);
      // 另存为后文档身份是文件，后续保存不得继续改原卡片/剪贴板。
      setEffectiveSourceId(null);
      setFileName(selectedPath.split(/[\\/]/).pop() || spec.defaultFileName);
      setInitialContent(text);
      const unchanged = latestText.current === text;
      setIsDirty(!unchanged);
      setAutoSaveError(false);
      notify("已保存", "success");
      return unchanged;
    } catch (e: unknown) {
      notify("保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
      return false;
    }
  }, [text, fileName, spec, latestText, markSynced, setCurrentFilePath,
    setEffectiveSourceId, setFileName, setInitialContent, setIsDirty, setAutoSaveError, notify]);
}
