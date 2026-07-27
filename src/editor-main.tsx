import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { FullscreenEditor } from "./components/editors/FullscreenEditor";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, DEFAULT_THEME, ThemeKey } from "./lib/theme";
import { useAppStore } from "./stores/appStore";
import { invoke } from "@tauri-apps/api/core";
import "./styles/globals.css";
// 独立窗口同样需要加载主题与全局组件样式，否则 [data-theme] 变量无定义，
// Markdown 预览会回退成白底黑字、h1 渐变标题透明、代码块褪色（与主窗口弹框预览不一致）。
// 顺序与 main.tsx 保持一致；不引入 app.css（主窗口专属布局样式，与本窗口无关）。
import "./styles/theme.css";
import "./styles/buttons.css";
import "./styles/dialog.css";
import "./styles/code-theme.css";

// 编辑器独立窗口：先同步应用默认主题兜底（避免无样式闪烁），
// 再异步读取用户实际主题，使编辑器外观跟随应用主题
applyTheme(DEFAULT_THEME);
// #3 OS「减少动态效果」：挂 no-anim 类（关窗快照等 CSS 判断依赖它）。
// 同步执行、独立于 get_config；但不改写 store 里的 window_animation——
// 那是用户的真实设置，useDialogAnim 已通过 usePrefersReducedMotion 直接感知此偏好
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("no-anim");
}
invoke<{ theme?: string; window_animation?: boolean }>("get_config")
  .then((cfg) => {
    applyTheme((cfg.theme as ThemeKey) || DEFAULT_THEME);
    // 「窗口动画」关闭：no-anim 类让纯 CSS 入场/退场动画降级为即时显隐，
    // 同时同步到本窗口独立 store，使 ConfirmDialog 等走 useDialogAnim 的组件一致
    if (cfg.window_animation === false) {
      document.documentElement.classList.add("no-anim");
      useAppStore.getState().updateConfig({ window_animation: false });
    }
  })
  .catch(() => { /* 读取失败时保持默认主题 */ });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary componentName="全屏编辑器">
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <FullscreenEditor />
        </ToastProvider>
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>
);
