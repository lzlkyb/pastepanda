/**
 * rec-main — 录屏选区窗独立入口（透明全屏覆盖层）。
 *
 * 与主窗口独立 React root（同 screenshot-main 模式）；只做录屏选区一件事，
 * 不引入 appStore。配置默认值（画质档 / 音源开关）在挂载时一次性读入。
 */
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecSelectOverlay } from "./components/recsel/RecSelectOverlay";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
// 独立窗口必须加载主题样式表，否则 var(--accent)/var(--danger) 等全部无定义
import "./styles/theme.css";
import "./styles/recsel.css";

window.addEventListener("error", (event) => {
  logger.error("录屏窗口未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("录屏窗口未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 主题跟随（同 screenshot-main：先默认防裸样式，再读用户主题，并监听广播）
applyTheme(DEFAULT_THEME);
// 🔴 入口脚本执行 = 模块图加载完成——此刻立即报就绪，不等 React 渲染：
// dev 下外部工具写文件会触发 vite 全量 reload 反复打断页面加载，挂载级的
// recReady 可能永远轮不到执行，选区窗会被后端存活探针误杀（2026-10-06 实录）。
// React 崩溃仍有 ErrorBoundary/CrashPanel + 后端权威收尾兜底，探针语义不变。
invoke("rec_ready").catch(() => {});
invoke<{ theme?: string }>("get_config")
  .then((cfg) => {
    applyTheme(normalizeTheme(cfg?.theme));
    render(cfg ?? null);
  })
  .catch(() => render(null));

function render(config: Record<string, unknown> | null) {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary componentName="录屏窗口" fallback={(err) => <CrashPanel error={err} />}>
        <RecSelectOverlay config={config} />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

/** 崩溃兜底：录屏窗是全屏透明层，Escape 是最后的逃生口（同截图 CrashPanel 思路）。 */
function CrashPanel({ error }: { error: Error | null }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        invoke("rec_close_windows").catch(() => {
          /* 最后的出口自己挂了只能靠任务管理器 */
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div
      /* ui-rule-ok: 救命面板——样式表没加载/主题变量未应用时也要可见可点，inline 是有意为之（同 screenshot-main 的 CrashPanel） */
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.72)",
        color: "#fff", // ui-rule-ok: 救命面板不依赖主题令牌，样式表未加载也要可见（同 screenshot-main CrashPanel）
        font: "12px/1.6 system-ui, sans-serif",
      }}
    >
      <div
        /* ui-rule-ok: 同上，救命面板不依赖主题令牌 */
        style={{
          maxWidth: 560,
          padding: "16px 24px",
          borderRadius: 12,
          background: "rgba(24,24,28,0.96)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>⚠️ 录屏窗口渲染异常</div>
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#ff9d9d", marginBottom: 8 /* ui-rule-ok: 救命面板错误文字，不依赖主题 */ }}>
          {error?.message || "未知错误"}
        </div>
        <button
          /* ui-rule-ok: 同上，救命面板不依赖主题令牌 */
          style={{
            padding: "4px 12px",
            borderRadius: 8,
            cursor: "pointer",
            color: "#fff", // ui-rule-ok: 救命面板不依赖主题令牌
            background: "rgba(255,255,255,0.22)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
          onClick={() => invoke("rec_close_windows").catch(() => {})}
        >
          关闭窗口（Esc）
        </button>
      </div>
    </div>
  );
}
