/**
 * 全屏编辑器窗口的独立设置读取（自动保存开关 / 预览行号）。
 *
 * 独立 OS 窗口不与主窗口共享 zustand store，设置只能经 `get_config` 读取。
 *
 * ❗ 主题（theme）**刻意不在这里**：主题有 `theme-changed` 事件要跟随，
 * 若每个标签各读一份、各挂一份监听，12 个标签就是 12 份窗口级监听
 * —— 正是规则 8.2「多窗口乘法」要防的。宿主统一读一次并向下传。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface EditorPrefs {
  /** 自动保存（设置 md_auto_save，缺省开） */
  autoSaveEnabled: boolean;
  /** 预览行号（设置 markdown_preview_line_numbers，缺省开） */
  previewLineNumbers: boolean;
  togglePreviewLineNumbers: () => void;
}

export function useEditorPrefs(): EditorPrefs {
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [previewLineNumbers, setPreviewLineNumbers] = useState(true);

  useEffect(() => {
    invoke<{ md_auto_save?: boolean; markdown_preview_line_numbers?: boolean }>("get_config")
      .then((cfg) => {
        setAutoSaveEnabled(cfg.md_auto_save !== false);
        setPreviewLineNumbers(cfg.markdown_preview_line_numbers !== false);
      })
      .catch(() => {
        /* 读取失败时保持默认（自动保存开、行号开） */
      });
  }, []);

  /** 翻转即时生效，并写回配置持久化（读全量 → 覆盖单键 → 写回） */
  const togglePreviewLineNumbers = useCallback(() => {
    setPreviewLineNumbers((prev) => {
      const next = !prev;
      invoke<Record<string, unknown>>("get_config")
        .then((cfg) => invoke("save_config", { config: { ...cfg, markdown_preview_line_numbers: next } }))
        .catch(() => {
          /* 持久化失败不影响开关即时生效 */
        });
      return next;
    });
  }, []);

  return { autoSaveEnabled, previewLineNumbers, togglePreviewLineNumbers };
}
