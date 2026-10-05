/**
 * rec-control-main — 录屏控制条窗独立入口（小置顶条）。
 *
 * 窗体由后端 rec_start 成功后创建（位置吸附选区上缘外）。职责只有三件：
 * REC 脉动 + 计时（前端自计，秒级够用）+ 停止（可丢弃）。
 * 计时不与后端对时：无暂停/无中途改参，起点误差可忽略（设计稿 §4）。
 */
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecControlBar } from "./components/recsel/RecControlBar";
import { recStatus } from "./lib/api/rec";
import { recQualityOf } from "./lib/recQuality";
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

// 会话收尾 → 后端事件；控制条收到「正在写入」→ rec-done 后随选区窗一起关。
function Root() {
  const [finalizing, setFinalizing] = useState(false);
  const [qualityLabel, setQualityLabel] = useState("");
  useEffect(() => {
    recStatus()
      .then((s) => {
        if (s.quality) {
          const q = recQualityOf(s.quality);
          setQualityLabel(`${q.label} · ${q.key === "original" ? "60" : "30"}fps`);
        }
      })
      .catch(() => { /* 读不到档位就不显示徽标 */ });
    const close = () => invoke("rec_close_windows").catch(() => { /* 保底出口 */ });
    const un1 = listen("rec-done", close);
    const un2 = listen("rec-discarded", close);
    const un3 = listen("rec-failed", () => setFinalizing(true));
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
      void un3.then((f) => f());
    };
  }, []);
  return (
    <ErrorBoundary componentName="录屏控制条" fallback={null}>
      <RecControlBar
        qualityLabel={qualityLabel}
        finalizing={finalizing}
        onStop={(discard) => {
          setFinalizing(true);
          invoke("rec_stop", { discard }).catch((e: unknown) => {
            logger.error("停止录制失败", e);
            // 停止失败不能让控制条卡死在「正在写入」：回退可再按
            setFinalizing(false);
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
