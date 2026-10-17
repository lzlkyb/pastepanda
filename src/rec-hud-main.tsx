import { setMotionPreference } from "./lib/motionPreference";
import { MotionPolicy } from "./components/MotionPolicy";
/**
 * rec-hud-main — 录屏完成/失败通知 HUD（主窗隐藏时的通知通路，设计稿二期 §1）。
 *
 * 结果主动关闭；与主窗共用 RecResultCard，文件位置和异常摘要不因计时器消失。
 */
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecResultCard } from "./components/recsel/RecResultCard";
import type { RecHudData } from "./lib/api/rec";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/recsel.css";

applyTheme(DEFAULT_THEME);
invoke<{ theme?: string; window_animation?: boolean }>("get_config")
  .then((cfg) => { setMotionPreference(cfg?.window_animation !== false); applyTheme(normalizeTheme(cfg?.theme)); })
  .catch(() => { /* 读取失败保持默认主题 */ });

function Root() {
  const [data, setData] = useState<RecHudData | null>(null);
  const take = useRef<Promise<RecHudData | null> | null>(null);
  useEffect(() => {
    let alive = true;
    // StrictMode 复用同一消费；HMR 后确实取空则自关，不能留下常驻空白窗口。
    take.current ??= invoke<RecHudData | null>("rec_hud_take");
    take.current
      .then((d) => { if (alive) { if (d) setData(d); else void getCurrentWindow().close(); } })
      .catch((e) => {
        if (!alive) return;
        logger.error("HUD 数据读取失败", e);
        void getCurrentWindow().close();
      });
    return () => { alive = false; };
  }, []);
  if (!data) return null;
  return (
    <ErrorBoundary componentName="录屏 HUD" fallback={null}>
      <RecHud data={data} />
    </ErrorBoundary>
  );
}

function RecHud({ data }: { data: RecHudData }) {
  return <RecResultCard data={data} onClose={() => void getCurrentWindow().close()} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionPolicy>
      <Root />
    </MotionPolicy>
  </React.StrictMode>,
);
