/**
 * rc-main — 「远程电脑」独立工作台窗口入口（2A 配套，2026-09-18）。
 *
 * 模式照抄 editor-main：独立 React root，不共享主窗口 App.tsx 的状态；
 * 主题先同步兜底再异步跟随；独立窗口必须自带 ConfirmDialogHost
 * （confirmDialog 只是把请求放进模块级槽位，真正画出来的是宿主——
 * 不挂的话 await confirmDialog 永远不返回，见 screenshot-main 的注释）。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { ToastProvider } from "./components/Toast";
import { RcWorkbench } from "./components/rc/RcWorkbench";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
// 独立窗口同样需要主题与全局组件样式，否则 [data-theme] 变量无定义，
// 卡片/开关/确认弹窗全部回退成浏览器默认样式
import "./styles/theme.css";
import "./styles/buttons.css";
import "./styles/dialog.css";

applyTheme(DEFAULT_THEME);
// OS「减少动态效果」：挂 no-anim 类（与 editor-main 同款处理）
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("no-anim");
}
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => {
    /* 读取失败时保持默认主题 */
  });

// 主窗口切主题时实时跟随（工作台常驻打开时感知明显）
listen<{ theme?: string }>("theme-changed", (e) => {
  applyTheme(normalizeTheme(e.payload?.theme));
}).catch(() => {
  /* 监听注册失败时退化为仅打开时读取一次 */
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary componentName="远程电脑工作台">
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <RcWorkbench />
          <ConfirmDialogHost />
        </ToastProvider>
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
);
