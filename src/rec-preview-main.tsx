/**
 * rec-preview-main — 预览裁剪窗入口（四期 1.4）。
 *
 * 数据由后端一次性下发（rec_preview_take，重开覆盖旧值）；视频走 asset 协议
 * （rec_open_preview 已按次放行白名单）。Esc 两级取消：先重置选区、再按关窗。
 */
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecPreview } from "./components/recsel/RecPreview";
import { type RecPreviewData } from "./lib/api/rec";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/recsel.css";

applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => { /* 读取失败保持默认主题 */ });

function Root() {
  const [data, setData] = useState<RecPreviewData | null>(null);
  useEffect(() => {
    // 取不到数据 = 这个窗不该存在，自关（dev StrictMode 双跑用 prev ?? d 兜住，
    // 同 rec-hud-main 的 P2 教训）
    invoke<RecPreviewData | null>("rec_preview_take")
      .then((d) => setData((prev) => prev ?? d))
      .catch((e) => {
        logger.error("预览数据读取失败", e);
        void getCurrentWindow().close();
      });
  }, []);
  if (!data) return null;
  return (
    <ErrorBoundary componentName="录屏预览" fallback={null}>
      <RecPreview data={data} />
    </ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
