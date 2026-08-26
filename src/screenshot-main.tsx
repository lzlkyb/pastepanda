/**
 * screenshot-main — 截图标注窗口独立入口（透明全屏覆盖层）。
 *
 * 与主窗口独立 React root；只做截图一件事，不引入 appStore 等主窗口状态。
 */
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
// 独立窗口必须加载主题样式表，否则 var(--dialog-bg)/var(--accent) 等全部无定义
import "./styles/theme.css";
import "./styles/screenshot.css";

window.addEventListener("error", (event) => {
  logger.error("截图窗口未捕获错误", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  logger.error("截图窗口未处理的 Promise 拒绝", event.reason);
  event.preventDefault();
});

// 截图遮罩层跟随用户主题（方案 B 令牌化，design/PastePanda-截图主题适配-设计稿.html）。
// 与 popup-main.tsx 同款模式：先应用默认主题避免无样式闪烁，再异步读取用户实际主题；
// 并监听主窗口 theme-changed 广播，常驻截图窗跨主题切换实时跟随。
// 浅色主题下工具栏等浮层走浅玻璃 + 深字，靠 --shot-bar-border 描边 + 阴影保底辨识
// （浅色玻璃压在浅色截图内容上的对比度问题由令牌族统一补偿）。
applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => { /* 读取失败时保持默认主题 */ });

listen<{ theme?: string }>("theme-changed", (e) => {
  applyTheme(normalizeTheme(e.payload?.theme));
}).catch(() => { /* 监听注册失败时退化为仅打开时读取一次 */ });

/* 崩溃面板故意用 inline style 而不走 CSS 类 + 主题变量（与全站风格不一致是有意为之）：
 * 它是救命用的，要在“样式表没加载成 / 主题变量未应用”这种最坏情况下也能看清、能点。
 * 别为了“统一风格”把它改成类名——那等于给唯一的逃生出口加了一条依赖。 */
const BTN: React.CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  borderRadius: 6,
  cursor: "pointer",
  color: "#fff",
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.2)",
};

/**
 * 崩溃兜底面板 —— 它被挂载就意味着截图窗已经崩了。
 *
 * ❗ 为什么 Esc 监听要写在这里：截图窗唯一的 keydown 监听注册在 ScreenshotOverlay
 * 的 useEffect 里。组件一崩，ErrorBoundary 换掉整棵子树，React 跟着跑 cleanup 把那个
 * 监听摘掉 —— 于是 Esc 没人接，而截图窗是全屏 topmost 遮罩，工具栏/右键退出这些
 * 出口也都在那棵树上一起没了，用户就被困在一块关不掉的遮罩后面
 * （dev 里还能右键刷新逃出来，打包版未必）。
 *
 * 兜底监听只在崩溃后存在（本组件挂载才注册），因此不会与 ScreenshotOverlay 里那套
 * Esc 优先级（AI 弹层 → 链式弹层 → 长截图中止 → 关窗）抢事件。
 */
function CrashPanel({ error }: { error: Error | null }) {
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const close = useCallback(() => {
    setCloseErr(null);
    invoke("close_screenshot_window").catch((e: unknown) => {
      // 规则 15.3：兜底出口自己失败了也不能静默，否则用户点了没反应、无从判断
      logger.error("兜底关闭截图窗失败", e);
      setCloseErr(e instanceof Error ? e.message : String(e));
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    // 捕获阶段：崩溃态下已经没别的监听者，用捕获只为保证任何残留 handler 都抢不走
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.72)",
        color: "#fff",
        font: "12px/1.6 system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 560,
          padding: "18px 20px",
          borderRadius: 10,
          background: "rgba(24,24,28,0.96)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>⚠️ 截图窗口渲染异常</div>
        {/* 以前这里是一句写死的提示，error.message / stack 全被吞掉——只进 webview
            console，而 logger 不写文件、截图窗又没开 devtools，崩溃一旦发生就没任何线索。 */}
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#ff9d9d", marginBottom: 12 }}>
          {error?.message || "未知错误"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={{ ...BTN, background: "rgba(255,255,255,0.22)" }}
            onClick={close}
            autoFocus
          >
            关闭截图窗（Esc）
          </button>
          <button
            style={BTN}
            onClick={() => {
              void navigator.clipboard.writeText(`${error?.message || ""}\n\n${error?.stack || ""}`);
            }}
          >
            📋 复制错误详情
          </button>
        </div>
        {closeErr && (
          <div style={{ marginTop: 10, color: "#ffcf8b" }}>
            关窗失败：{closeErr}（可在窗口内右键选“刷新”，或从任务栏退出 PastePanda）
          </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary componentName="截图窗口" fallback={(err) => <CrashPanel error={err} />}>
      <ScreenshotOverlay />
    </ErrorBoundary>
  </React.StrictMode>,
);
