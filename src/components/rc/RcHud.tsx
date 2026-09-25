/**
 * RcHud — 「连接详情」入口 + 明细面板（2026-09-21 A 方案稿对账后收编）。
 *
 * 稿的要求：遥测**不再常驻铺在画面上**。原先这里是一条最多 10 格的 chip 条
 * （编码 / 延迟 / 画面龄 / 四段 / 操作 / 丢包 / 码率 / 路径 / 画质·画面 / 链路），
 * 本项目有 4 个窗口、同一组件可能各挂一份，画面顶部长期被信息条占住。
 * 2026-09-24 控端态浮条收编后入口进一步缩成**一枚 i 图标**，住在
 * RcSessionCapsule 的动作段里（深色玻璃语境）；点击在胶囊下方弹出明细面板，
 * 数据一格不少。左上角的常驻小按钮随 viewTools / 底栏一起退场。
 *
 * 为什么去掉 hover 自动展开（原悬停 300ms 开）：入口从一条宽信息条缩成一个小按钮后，
 * 鼠标掠过画面左上角就弹面板的误触概率明显上升；稿里的同类入口也是点击式。
 * 键盘可达改由真 `<button>` 天然承担（不再手写 role="button" + onKeyDown）。
 *
 * 诚实性底线不变（2026-09-17 改造留下的分格口径，各格只说自己那一件事）：
 * `linkState` = 链路还活着吗（对端 pong 新鲜度）；`pathKind` = 数据走的哪条路；
 * 延迟分档 = 心跳实测的网速感受。**链路异常时的常驻可见性由会话顶条承担**
 * （RcSessionTop 的 pillDanger / pillWarn），这里不在按钮上重复播报。
 *
 * 穿透纪律：wrapper 与面板之外的区域照旧 pointer-events:none（远程点击不被挡），
 * 只有按钮与面板自己的盒子是交互面。面板展开期间浮条由父组件锁显（面板 DOM
 * 在浮条 root 内，鼠标移进去不触发 onMouseLeave）。
 */
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import styles from "./RemoteComputer.module.css";
import { isSessionEscape } from "@/lib/rcKeyGuard";
import { registerRcPanel, unregisterRcPanel } from "@/lib/rcPanelFocus";
import {
  linkStateLabel,
  pathKindHint,
  pathKindLabel,
  rttGrade,
  rttGradeLabel,
  type RcLinkState,
} from "@/lib/rcSessionStats";
import { qualityHudLabel } from "@/lib/rcQuality";
import { scopeLabelLong } from "@/lib/rcScope";

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
  frameSize,
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
  /** `lan` / `direct` / `relay`；空串 = 未测到，不显示这一行。 */
  pathKind: string;
  pointerLocked?: boolean;
  /** 画面原始像素尺寸（useRcFrames 的 size）；宽高任一为 0 = 无样本不显示。 */
  frameSize?: { w: number; h: number };
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 打开时点外面（画面/工具栏/窗外）就收——与 RcDropdown 同一交互口径
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // 🔴 再审计（Esc 两级取消，2026-09-25）：明细面板展开期间向 rcPanelFocus 登记，
  // useRcInput 的 window 级 Esc 兜底据此让路，不直落「结束会话」确认；Esc 收起
  // 自己（document 监听先于 window 兜底，stopPropagation 防穿透）。
  // register/unregister 在 effect/cleanup 配对，StrictMode 双挂载也平衡。
  useEffect(() => {
    if (!open) return;
    registerRcPanel();
    const onEsc = (e: KeyboardEvent) => {
      if (!isSessionEscape(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      unregisterRcPanel();
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const grade = rttGrade(rttMs);
  const rttCls = grade === "unknown" ? "" : grade === "poor" ? styles.hudWarn : styles.hudOk;
  const linkCls =
    linkState === "connected"
      ? styles.hudOk
      : linkState === "failed"
        ? styles.hudBad
        : styles.hudWarn;
  const path = pathKindLabel(pathKind);

  // 面板内容。每一行对应一个真实数据源，无样本就不出行（不拿 0 充数）。
  const rows: HudRow[] = [
    {
      label: "编码",
      value: `${codec === "h264" ? "H.264" : codec === "hevc" ? "HEVC" : "JPEG"}${fps > 0 ? ` · ${fps}fps` : ""}`,
      hint:
        codec === "h264"
          ? "硬编（D3D11）或 CPU 编码，按画质档与能力选择"
          : "浏览器解不出 H.264 时的兜底路径",
    },
  ];
  if (frameSize && frameSize.w > 0 && frameSize.h > 0) {
    rows.push({
      label: "分辨率",
      value: `${frameSize.w}×${frameSize.h}`,
      hint: "对方画面的原始像素尺寸（与「画面」行的采集范围不是一回事）",
    });
  }
  rows.push(
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
    { label: "画面", value: scopeLabelLong(scope), hint: "对方采集的画面范围" },
    { label: "链路", value: linkStateLabel(linkState), cls: linkCls, hint: "按对端 pong 的新鲜度判定" },
  );
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
    rows.push({ label: "指针", value: "已锁定", cls: styles.hudAccent, hint: "拖出画面边缘不丢事件" });
  }

  return (
    <div className={styles.hudWrapCap} ref={wrapRef}>
      <button
        type="button"
        className={styles.capBtn}
        title="连接详情：编码 / 分辨率 / 延迟 / 丢包 / 码率"
        aria-label="连接详情"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.hudPanel} aria-label="连接详情">
          <div className={styles.hudPanelHead}>连接详情</div>
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
