/**
 * `FullscreenShell` 的**窗口级外观**：主题明暗 + 全屏态 + 全屏切换。
 *
 * 抽出来的动因是规则 7 的体量红线（壳本身已接近上限），行为与注释逐块原样搬移。
 *
 * 两条接线共用一套逻辑（不是「两套实现并存」）：
 *   - 宿主接管（md-editor 多标签窗口）→ 传 `darkMode` / `isFullscreen`，本 hook
 *     **整段跳过自管分支**，不重复挂窗口级监听（规则 8.2）。
 *   - 壳自管（单文档直用 / 测试）→ 参数留空，自己读配置与窗口状态。
 */
import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_THEME, isDarkTheme } from "@/lib/theme";
import { logger } from "@/lib/logger";

export interface ShellWindowStateOptions {
  /** 主题明暗；不传则壳自己读 */
  darkMode?: boolean;
  /** 全屏态；不传则壳自己同步 */
  isFullscreen?: boolean;
  /** 全屏切换；不传则壳自己调窗口 API */
  onFullscreenToggle?: () => void;
}

export interface ShellWindowStateApi {
  darkOn: boolean;
  fullscreenOn: boolean;
  toggleFullscreen: () => Promise<void>;
}

export function useShellWindowState({
  darkMode,
  isFullscreen,
  onFullscreenToggle,
}: ShellWindowStateOptions): ShellWindowStateApi {
  const [ownDark, setOwnDark] = useState(false);
  const [ownIsFullscreen, setOwnIsFullscreen] = useState(false);

  // 主题判定：统一走 isDarkTheme（theme.ts 收口），灭掉各类型硬编码 midnight||ocean-dark。
  // 宿主接管（darkMode 有值）时整段跳过 —— 不挂重复的窗口级监听（规则 8.2）。
  useEffect(() => {
    if (darkMode !== undefined) return;
    const applyTheme = (theme: string) => setOwnDark(isDarkTheme(theme || DEFAULT_THEME));
    invoke<{ theme?: string }>("get_config")
      .then((cfg) => applyTheme(cfg.theme ?? DEFAULT_THEME))
      .catch(() => { /* 读不到就保持默认亮色 */ });
    // 运行时主题切换也跟随（独立窗口拿不到主窗口 store，只能监听事件）
    const unsubPromise = listen<{ theme?: string }>("theme-changed", (e) =>
      applyTheme(e.payload?.theme ?? DEFAULT_THEME));
    return () => { void unsubPromise.then((u) => u()); };
  }, [darkMode]);

  useEffect(() => {
    if (isFullscreen !== undefined) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    win.isFullscreen().then((fs) => { if (!disposed) setOwnIsFullscreen(fs); }).catch(() => {});
    win.onResized(() => {
      win.isFullscreen().then((fs) => { if (!disposed) setOwnIsFullscreen(fs); }).catch(() => {});
    }).then((fn) => { if (disposed) fn(); else unlistenResize = fn; });
    return () => { disposed = true; unlistenResize?.(); };
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    if (onFullscreenToggle) {
      onFullscreenToggle();
      return;
    }
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setOwnIsFullscreen(next);
    } catch (e) {
      logger.error("切换全屏失败", e);
    }
  }, [onFullscreenToggle]);

  return {
    darkOn: darkMode ?? ownDark,
    fullscreenOn: isFullscreen ?? ownIsFullscreen,
    toggleFullscreen,
  };
}
