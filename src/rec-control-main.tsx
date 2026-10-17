/** Compact recording window; backend status supplies the clock and audio health. */
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecControlBar } from "./components/recsel/RecControlBar";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/recsel.css";

window.addEventListener("error", (event) => {
  logger.error("录屏控制条未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("录屏控制条未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => { /* 读取失败保持默认主题 */ });

// Backend owns window cleanup; late frontend events must never close a newer session.
function Root() {
  const [finalizing, setFinalizing] = useState(false);
  return (
    <ErrorBoundary componentName="录屏控制条" fallback={null}>
      <RecControlBar
        qualityLabel=""
        finalizing={finalizing}
        onStop={(discard) => {
          setFinalizing(true);
          return invoke<void>("rec_stop", { discard }).catch((e: unknown) => {
            logger.error("停止录制失败", e);
            // 停止失败不能让控制条卡死在「正在写入」：回退可再按
            setFinalizing(false);
            throw e;
          });
        }}
      />
    </ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
