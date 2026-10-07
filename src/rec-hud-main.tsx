/**
 * rec-hud-main — 录屏完成/失败通知 HUD（主窗隐藏时的通知通路，设计稿二期 §1）。
 *
 * 数据由后端一次性下发（rec_hud_take，新事件覆盖旧值）；前端 8s（失败 10s）自关，
 * hover 暂停倒计时（同 Toast U4.2 心智，底部进度条同步停走）。
 * 按钮：打开文件夹（成功态）/ ↻ 重录（成功态）/ ✕。后端另有 15s 强关安全网。
 */
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { recQualityOf } from "./lib/recQuality";
import { logger } from "./lib/logger";
import { applyTheme, DEFAULT_THEME, normalizeTheme } from "./lib/theme";
import "./styles/globals.css";
import "./styles/theme.css";
import "./styles/recsel.css";

applyTheme(DEFAULT_THEME);
invoke<{ theme?: string }>("get_config")
  .then((cfg) => applyTheme(normalizeTheme(cfg?.theme)))
  .catch(() => { /* 读取失败保持默认主题 */ });

/** rec_hud_take 的载荷（后端 open_hud_window 组装）。 */
interface HudData {
  ok: boolean;
  path?: string;
  bytes?: number;
  durationMs?: number;
  quality?: string;
  note?: string | null;
  message?: string;
}

function Root() {
  const [data, setData] = useState<HudData | null>(null);
  useEffect(() => {
    // 取不到数据（数据被更新的窗取走）= 这个窗不该存在，自关
    invoke<HudData | null>("rec_hud_take")
      // 🔴 prev ?? d：dev StrictMode 下 effect 双跑，第二次必然 None——直接 setData
      // 会把第一次拿到的数据抹掉，HUD 空白 15s 等安全网回收（P2，2026-10-05 审查）
      .then((d) => setData((prev) => prev ?? d))
      .catch((e) => {
        logger.error("HUD 数据读取失败", e);
        void getCurrentWindow().close();
      });
    // None（数据被更新的窗取走 / dev 双取的空手）不能自关：生产里窗刚建就被更新的
    // 事件顶掉时自关是对的，但 dev 双跑的第二次必然 None，自关会让 HUD 闪现即消失；
    // 留空窗交给后端 15s 安全网回收（P2，二期审查）。
  }, []);
  if (!data) return null;
  return (
    <ErrorBoundary componentName="录屏 HUD" fallback={null}>
      <RecHud data={data} />
    </ErrorBoundary>
  );
}

function fmtDur(ms?: number): string {
  if (!ms || ms <= 0) return "--:--";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function RecHud({ data }: { data: HudData }) {
  const total = data.ok ? 8000 : 10000;
  const [left, setLeft] = useState(total);
  const [actErr, setActErr] = useState<string | null>(null);
  const pausedRef = useRef(false);
  const closedRef = useRef(false);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    void getCurrentWindow().close();
  };

  useEffect(() => {
    const startedAt = Date.now();
    const t = setInterval(() => {
      if (pausedRef.current) return;
      const remain = total - (Date.now() - startedAt);
      if (remain <= 0) close();
      else setLeft(remain);
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = data.path ? (data.path.split(/[/\\]/).pop() ?? data.path) : undefined;
  const q = recQualityOf(data.quality ?? null);
  const mb = data.bytes ? (data.bytes / 1024 / 1024).toFixed(1) : null;

  const reveal = () => {
    if (!data.path) return;
    invoke("rec_reveal", { path: data.path })
      .then(() => close())
      .catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };
  // ✂ 预览（四期 1.4）：刚录完最自然的下一步是「看一眼 / 掐一下」，放 primary
  const preview = () => {
    if (!data.path) return;
    invoke("rec_open_preview", { path: data.path })
      .then(() => close())
      .catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };
  const rerecord = () => {
    invoke("rec_rerecord")
      .then(() => close())
      .catch((e: unknown) => setActErr(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div
      className="rec-hud-root"
      onMouseEnter={() => (pausedRef.current = true)}
      onMouseLeave={() => (pausedRef.current = false)}
    >
      <div className="rec-hud" role="status">
        <div className="rec-hud-top">
          <span className={`rec-hud-badge${data.ok ? "" : " bad"}`}>
            <span className="dot" />
            {data.ok ? "已保存" : "失败"}
          </span>
          <span className="rec-hud-name">{name ?? data.message ?? "录屏"}</span>
          <button type="button" className="rec-hud-x" onClick={close} title="关闭">
            ✕
          </button>
        </div>
        {data.ok ? (
          <div className="rec-hud-meta">
            {mb ? <span>{mb} MB</span> : null}
            <span>{fmtDur(data.durationMs)}</span>
            <span>
              {q.label} · {q.key === "original" ? "60" : "30"}fps
            </span>
            {data.note ? <span className="rec-hud-err">{data.note}</span> : null}
          </div>
        ) : (
          <div className="rec-hud-err">{data.message ?? "录制失败"}</div>
        )}
        {actErr ? <div className="rec-hud-err">{actErr}</div> : null}
        {data.ok && (
          <div className="rec-hud-btns">
            {data.path && (
              <button type="button" className="rec-hud-btn primary" onClick={preview} title="预览 / 掐头去尾">
                ✂ 预览
              </button>
            )}
            {data.path && (
              <button type="button" className="rec-hud-btn" onClick={reveal}>
                📁 打开文件夹
              </button>
            )}
            <button type="button" className="rec-hud-btn" onClick={rerecord} title="同区域同档位，直接进倒计时">
              ↻ 重录
            </button>
          </div>
        )}
        <div className="rec-hud-life">
          <i style={{ "--hud-life": `${Math.max(0, (left / total) * 100)}%` } as React.CSSProperties} />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
