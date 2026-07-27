import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { TrayPopup } from "./components/TrayPopup";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "./lib/theme";
import { invoke } from "@tauri-apps/api/core";
import "./styles/globals.css";
// 托盘弹窗同为独立窗口，必须加载主题样式表，否则 popup.css 里的
// var(--dialog-bg)/var(--accent)/var(--text-*) 全部无定义，弹窗会退化成白底黑字、
// 渐变与边框失效。buttons.css 提供 VersionBadge 徽章样式（自 app.css 迁入，两入口共用）。
import "./styles/theme.css";
import "./styles/buttons.css";
import "./styles/popup.css";

// 先同步应用默认主题兜底（避免无样式闪烁），再异步读取用户实际主题，
// 使弹窗外观跟随应用主题（TrayPopup 的 MutationObserver 会自动同步内部 state）
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme((cfg.theme as ThemeKey) || DEFAULT_THEME))
  .catch(() => { /* 读取失败时保持默认主题 */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <TrayPopup />
    </MotionConfig>
  </React.StrictMode>,
);
