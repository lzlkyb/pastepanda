/**
 * RcHud — 会话画面左上角状态条（诚实文案）。
 *
 * 每一格只说自己那一件事，互不代言（2026-09-17 改造）：
 * - `linkState` = 链路还活着吗（对端 pong 的新鲜度）
 * - `pathKind`  = 数据走的哪条路（局域网直连 / 公网直连 / 绕中继）
 * - 延迟分档    = 网速感受（<30ms 很流畅 … >200ms 偏慢）
 *
 * 交互（2026-09-19 重做）：`.hud` 曾整体 `pointer-events: none`（纯信息层，
 * 不拦截远程点击），代价是 chip 上的 title 悬停提示一并失效。现在恢复
 * **chip 条自身**的指针交互：悬停 300ms 或点击，浮出「状态明细」面板——
 * 收编原 title 文案并扩全（四段延迟 / 码率 / 丢包 / 路径……）。穿透保证不变：
 * 外层 wrapper 与面板之外的区域照旧穿透，只有 chip 条与面板自己的盒子是
 * 交互面（刻意保留的死区，且面板关闭后完全让给远程）。
 * HUD 不在画面 stage（RcScreenCanvas）子树内，这里的点击/移动不会漏给远程，
 * 无需再 stopPropagation。
 *
 * B（设计稿 §6）：「操作后未响应」不再在这里渲染——收口到 RcSessionTop 一处。
 * 🔴 原来那一格「心跳正常 / 心跳超时」是拿 ping 的本地 invoke 结果 + 画面停滞
 *    一起算的，两个方向都会错。现在只认 pong 新鲜度。
 */
import { useEffect, useRef, useState } from "react";
import styles from "./RemoteComputer.module.css";
import { Activity, Monitor, MousePointer2, Network, Video, Zap } from "lucide-react";
import {
  linkStateLabel,
  pathKindHint,
  pathKindLabel,
  rttGrade,
  rttGradeLabel,
  type RcLinkState,
} from "@/lib/rcSessionStats";
import { qualityHudLabel } from "@/lib/rcQuality";
import { scopeLabel, scopeLabelLong } from "@/lib/rcScope";

/** 悬停多久才展开（ms）。太短会路过就弹，太长不如点。 */
const HOVER_OPEN_MS = 300;
/** 移出后多久收起（ms）。给「chip → 面板」的空隙留余量。 */
const HOVER_CLOSE_MS = 250;

interface HudRow {
  label: string;
  value: string;
  hint?: string;
  cls?: string;
}

export function RcHud({
  codec,
  fps,
  rttMs,
  frameLatencyMs,
  lossPermille,
  bitrateKbps,
  segCapMs,
  segEncMs,
  segNetMs,
  segDecMs,
  respMs,
  quality,
  activeQuality,
  peerDriven,
  scope,
  linkState,
  pathKind,
  pointerLocked,
}: {
  codec: string;
  fps: number;
  rttMs: number;
  /** P2-10：画面链路延迟（被控端采集→本地上屏，EMA）。0/缺省 = 无样本不显示。 */
  frameLatencyMs?: number;
  /** P0-4：丢包率（‰）。0/缺省 = 未采样不显示。 */
  lossPermille?: number;
  /** 画面码率估计（kbps）。0/缺省 = 无样本不显示。 */
  bitrateKbps?: number;
  /** P0-2 延迟四段（各段 EMA，ms）。任一为 0 = 无样本。 */
  segCapMs?: number;
  segEncMs?: number;
  segNetMs?: number;
  segDecMs?: number;
  /** P4：操作延迟近似（输入→下一帧到达，EMA）。0/缺省 = 无样本不显示。 */
  respMs?: number;
  quality: string;
  /** 自动档（auto）当前**实际**生效的档位；只有被控端视角能提供，其余传 undefined。 */
  activeQuality?: string;
  /** 出站会话：档位由对方实际生效，本机只提要求（自动档无法知道对方落到哪一档）。 */
  peerDriven?: boolean;
  scope: string;
  linkState: RcLinkState;
  /** `lan` / `direct` / `relay`；空串 = 未测到，不显示这一格。 */
  pathKind: string;
  pointerLocked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  const scheduleOpen = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) return;
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_MS);
  };
  const scheduleClose = () => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  const toggle = () => {
    clearTimers();
    setOpen((v) => !v);
  };

  // 打开时点外面（画面/工具栏/窗外）就收——与 RcDropdown 同一交互口径
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => clearTimers, []);

  const grade = rttGrade(rttMs);
  const rttCls = grade === "unknown" ? "" : grade === "poor" ? styles.hudWarn : styles.hudOk;
  const linkCls =
    linkState === "connected"
      ? styles.hudOk
      : linkState === "failed"
        ? styles.hudBad
        : styles.hudWarn;
  const path = pathKindLabel(pathKind);
  /* v4 对稿（B 窗）：每格配 11px 图标，图标+文字双冗余（图标 aria-hidden）。
     导航纪律：图标一律 aria-hidden，文案本身自足。 */
  const icon = (I: typeof Video) => <I size={11} aria-hidden="true" />;

  // 明细面板的内容。与 chip 同一套数据、同一套出现条件——chip 有哪格，面板就有哪行。
  const rows: HudRow[] = [
    {
      label: "编码",
      value: `${codec === "h264" ? "H.264" : codec === "hevc" ? "HEVC" : "JPEG"}${fps > 0 ? ` · ${fps}fps` : ""}`,
      hint:
        codec === "h264"
          ? "硬编（D3D11）或 CPU 编码，按画质档与能力选择"
          : "浏览器解不出 H.264 时的兜底路径",
    },
    {
      label: "画质",
      value: qualityHudLabel(quality, activeQuality, peerDriven),
      hint:
        quality === "auto"
          ? "被控端按链路状况自动换档"
          : peerDriven
            ? "档位由对方机器决定"
            : undefined,
    },
    { label: "画面", value: scopeLabelLong(scope) },
    { label: "链路", value: linkStateLabel(linkState), cls: linkCls, hint: "按对端 pong 的新鲜度判定" },
  ];
  if (path) {
    rows.push({ label: "路径", value: path, hint: pathKindHint(pathKind) });
  }
  if (rttMs > 0) {
    rows.push({
      label: "往返",
      value: `~${rttMs}ms${grade !== "unknown" ? ` · ${rttGradeLabel(grade)}` : ""}`,
      cls: rttCls,
      hint: "心跳 ping-pong 实测",
    });
  }
  if (frameLatencyMs != null && frameLatencyMs > 0) {
    rows.push({
      label: "画面龄",
      value: `≈${frameLatencyMs}ms`,
      hint: "对方采集到本地上屏的全程；两机时钟差已用 pong 校准，仍为近似值",
    });
  }
  if ((segCapMs ?? 0) > 0 && (segEncMs ?? 0) > 0) {
    rows.push({
      label: "分段",
      value: `采集 ${segCapMs} · 编码 ${segEncMs} · 网络≈${segNetMs} · 解码 ${segDecMs} ms`,
      hint: "四段拆解；网络段 = 画面龄 − 采集/编码/解码（采样有抖动，看趋势别看单帧）",
    });
  }
  if ((respMs ?? 0) > 0) {
    rows.push({
      label: "操作",
      value: `≈${respMs}ms`,
      hint: "键鼠发出到下一帧到达（纯本机时钟，无跨机偏差）",
    });
  }
  if (lossPermille != null && lossPermille > 0) {
    rows.push({
      label: "丢包",
      value: `${(lossPermille / 10).toFixed(1)}%`,
      cls: lossPermille >= 20 ? styles.hudWarn : styles.hudOk,
      hint: "500ms 采样、指数平滑；参与码率与自动档调节",
    });
  }
  if (bitrateKbps != null && bitrateKbps > 0) {
    rows.push({
      label: "码率",
      value: bitrateKbps >= 1000 ? `${(bitrateKbps / 1000).toFixed(1)}Mbps` : `${bitrateKbps}kbps`,
      hint: "画面码率估计",
    });
  }
  if (pointerLocked) {
    rows.push({ label: "指针", value: "已锁定", hint: "拖出画面边缘不丢事件" });
  }

  return (
    <div className={styles.hudWrap} ref={wrapRef} onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose}>
      <div
        className={styles.hud}
        title="悬停/点击展开状态明细"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          // 键盘可达：Enter/Space 等价点击（读屏用户不靠 hover）
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={styles.hudOk}>
          {icon(Video)}
          {codec === "h264" ? "H.264" : codec === "hevc" ? "HEVC" : "JPEG"}
          {fps > 0 ? ` · ${fps}fps` : ""}
        </span>
        {rttMs > 0 && (
          <span className={rttCls}>
            {icon(Zap)}
            延迟 ~{rttMs}ms{grade !== "unknown" ? ` · ${rttGradeLabel(grade)}` : ""}
          </span>
        )}
        {frameLatencyMs != null && frameLatencyMs > 0 && (
          <span>
            {icon(Video)}
            画面 ≈{frameLatencyMs}ms
          </span>
        )}
        {(segCapMs ?? 0) > 0 && (segEncMs ?? 0) > 0 && (
          <span>
            {icon(Activity)}
            采{segCapMs}·编{segEncMs}·网≈{segNetMs}·解{segDecMs} ms
          </span>
        )}
        {(respMs ?? 0) > 0 && (
          <span>
            {icon(Zap)}
            操作 ≈{respMs}ms
          </span>
        )}
        {lossPermille != null && lossPermille > 0 && (
          <span className={lossPermille >= 20 ? styles.hudWarn : styles.hudOk}>
            {icon(Activity)}
            丢包 {(lossPermille / 10).toFixed(1)}%
          </span>
        )}
        {bitrateKbps != null && bitrateKbps > 0 && (
          <span>
            {icon(Network)}
            {bitrateKbps >= 1000 ? `${(bitrateKbps / 1000).toFixed(1)}Mbps` : `${bitrateKbps}kbps`}
          </span>
        )}
        {path && (
          <span>
            {icon(Network)}
            {path}
          </span>
        )}
        <span>
          {icon(Monitor)}
          {qualityHudLabel(quality, activeQuality, peerDriven)} · {scopeLabel(scope)}
        </span>
        <span className={linkCls}>
          {icon(Activity)}
          {linkStateLabel(linkState)}
        </span>
        {pointerLocked && (
          <span className={styles.hudAccent}>
            {icon(MousePointer2)}
            指针已锁定
          </span>
        )}
      </div>
      {open && rows.length > 0 && (
        <div className={styles.hudPanel} aria-label="画面状态明细">
          {rows.map((r) => (
            <div key={r.label} className={styles.hudRow}>
              <span className={styles.hudRowLabel}>{r.label}</span>
              <span className={`${styles.hudRowVal} ${r.cls ?? ""}`.trimEnd()}>{r.value}</span>
              {r.hint && <span className={styles.hudRowHint}>{r.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
