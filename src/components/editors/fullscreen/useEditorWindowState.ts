/**
 * 编辑器**窗口级**状态：主题明暗 + 全屏态 + 两个窗口操作。
 *
 * 为什么提到宿主（而不是每份文档各读一份）：
 *   - 主题有窗口级 `theme-changed` 事件要跟随。每标签一份就是最多 12 份
 *     窗口级监听（规则 8.2：辅助窗口用 hide() 不销毁，监听会一直挂着）。
 *   - 全屏态是窗口的属性，不是文档的：切换后所有标签一起变，共用一份才一致。
 *
 * 从 `FullscreenEditor.tsx`（宿主）拆出，动因是规则 7 的体量红线。
 * 逻辑与注释原样搬移，只把 state 与两个操作收成返回值。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_THEME, isDarkTheme } from "@/lib/theme";
import { logger } from "@/lib/logger";

export interface EditorWindowState {
  /** 当前主题是否为暗色（下发给每份文档，驱动 CodeMirror 主题舱） */
  darkMode: boolean;
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  minimize: () => void;
}

export function useEditorWindowState(): EditorWindowState {
  const [darkMode, setDarkMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const apply = (theme?: string) => setDarkMode(isDarkTheme(theme || DEFAULT_THEME));
    invoke<{ theme?: string }>("get_config")
      .then((cfg) => apply(cfg.theme))
      .catch(() => { /* 读不到就保持默认亮色 */ });
    const unsub = listen<{ theme?: string }>("theme-changed", (e) => apply(e.payload?.theme));
    return () => { void unsub.then((u) => u()); };
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    win.isFullscreen().then((fs) => { if (!disposed) setIsFullscreen(fs); }).catch(() => {});
    win.onResized(() => {
      win.isFullscreen().then((fs) => { if (!disposed) setIsFullscreen(fs); }).catch(() => {});
    }).then((fn) => { if (disposed) fn(); else unlistenResize = fn; });
    return () => { disposed = true; unlistenResize?.(); };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch (e) {
      logger.error("[全屏切换] 失败", e);
    }
  }, []);

  const minimize = useCallback(() => {
    void getCurrentWindow().minimize();
  }, []);

  return { darkMode, isFullscreen, toggleFullscreen, minimize };
}
