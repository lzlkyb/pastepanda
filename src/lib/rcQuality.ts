/**
 * rcQuality — 画质档的**唯一**定义处。
 *
 * 🔴 收口之前这个档位表被写了三遍，且互相不一致：
 *    ① `RcQualityBar` 的 `QUALITIES`（带 fps/宽度说明）；
 *    ② `RcAllowPanel` 的 label（「超清（约 2.5K）」「原生（主屏 4K 硬编）」）；
 *    ③ `rcSessionStats.qualityLabel` 的 if 链（HUD 短文案）。
 *    ① 与 ② 的按钮文字对不上（同一个「超清」两处写法不同），
 *    ③ 是第二份实现。现在全部从这里取。
 *
 * 说明性文字（fps / 宽度 / 「约 2.5K」/「主屏 4K 硬编」）统一降为 `tip`
 * （悬停显示），不再挤进按钮文字——这正是设计稿 §4「说明升为 title」那条。
 */
import type { RcQuality } from "@/lib/api/rc";

export interface RcQualityOption {
  key: RcQuality;
  /** 按钮 / 徽章上的短文案 */
  label: string;
  /** 悬停说明 */
  tip: string;
  /**
   * 下拉菜单里跟在 label 右侧的短补充（`10fps · 1280` 这类**档位差异**）。
   * 这些数字原先只写在 `tip` 里，要逐项悬停才看得见——菜单的「双列信息卡」把它们
   * 摆到明面，才看得出相邻档位差在哪。只摘 `tip` 已有的口径，不新造事实。
   */
  meta?: string;
  /**
   * 在下拉菜单里**独占一整行**，并在其后画一条分隔线。
   * 给「不是档次、而是模式」的项用（当前只有 `auto`）：它和下面各实名档不在同一维度，
   * 混进两列网格会被读成又一个档位。
   */
  solo?: boolean;
}

/**
 * 档位表，顺序 = 界面上的呈现顺序（从自适应到最高）。
 * `auto` 是默认档（2A）：被控端会话内按 RTT/带宽在 流畅/均衡/清晰/超清 之间
 * 自动换档；其余实名档 = 锁定。fps120（P1 零拷贝专属）仅在能力达标时展示。
 * `tip` 里保留了设置页原有口径——它们是同一档的补充事实；`meta` 是它的短摘。
 */
export const RC_QUALITIES: readonly RcQualityOption[] = [
  {
    key: "auto",
    label: "自动",
    tip: "按延迟与带宽在 流畅/均衡/清晰/超清 间自动切换（默认）；选其它档即锁定",
    meta: "自动换档",
    solo: true,
  },
  { key: "smooth", label: "流畅", tip: "约 10fps · 宽 960 · 适合弱网", meta: "10fps · 960" },
  { key: "balanced", label: "均衡", tip: "约 10fps · 宽 1280", meta: "10fps · 1280" },
  { key: "sharp", label: "清晰", tip: "约 15fps · 宽 1920 · 适合局域网", meta: "15fps · 1920" },
  { key: "ultra", label: "超清", tip: "约 12fps · 宽 2560（约 2.5K）· JPEG 路径", meta: "12fps · 2560" },
  {
    key: "uhd",
    label: "原生",
    tip: "硬编原生分辨率（约 4K · 20fps）· 需 GPU · 无硬编时回落超清",
    meta: "4K · 20fps",
  },
  {
    key: "uhd60",
    label: "4K60",
    tip: "原生分辨率 60fps（4K 屏即 4K60）· 需 HEVC 硬编 · 同画质比 H.264 省约一半带宽",
    meta: "4K · 60fps",
  },
  {
    key: "fps60",
    label: "高帧率",
    tip: "1080p 60fps · 拖动最跟手 · 需硬编，跑不满时自动降频",
    meta: "1080p · 60",
  },
  {
    key: "fps120",
    label: "高帧率+",
    tip: "单屏 1080p 120fps（零拷贝硬编）· 需 ≥100Hz 高刷屏 + 硬件编码器，跑不满时自动降频",
    meta: "1080p · 120",
  },
  {
    key: "fps144",
    label: "高帧率·144",
    tip: "单屏 1080p 144fps（零拷贝硬编 · H.264 L5.2）· 需 ≥144Hz 屏 + 硬件编码器，跑不满时自动降频",
    meta: "1080p · 144",
  },
  {
    key: "fps165",
    label: "高帧率·165",
    tip: "单屏 1080p 165fps（零拷贝硬编 · H.264 L5.2）· 需 ≥165Hz 屏 + 硬件编码器，线上约 33Mbps",
    meta: "1080p · 165",
  },
];

/** 后端默认档（2A 起 = 自动）。未知档位一律回落到它，不猜、不显示空文案。 */
export const DEFAULT_QUALITY: RcQuality = "auto";

/**
 * P1：高帧率档只在能力达标时出现——跑不到的档不卖。
 * - 发起端视角：以被控端 caps 上报为准（`peerFps120` = 硬编 + 单屏 + ≥100Hz）；
 * - 被控端/设置页视角：本机探测（`h264Gpu` 硬件 D3D11-aware MFT + 刷新率）。
 * 两者都没给时不出高帧档（宁缺毋滥）。
 *
 * 2026-09-22：fps144/fps165 进门槛表——与后端 `video::HIGH_FPS_LADDER` 同源
 * 的刷新率下限（100/144/165），硬编 + 单屏是共同前置。`refreshHz` 两个视角
 * 语义不同（发起端 = 对端屏 / 设置页 = 本机屏），调用方各自传对。
 *
 * Q3/Q4：`uhd60`（4K60）同理——4K60 的 H.264 要 L5.2（解码端兼容性差），
 * 必须走 HEVC；发起端看 `peerHevc`（对端 caps），设置页看本机
 * `h264Gpu && hevcHw`。后端 `set_stream_quality` 有同一套校验兜直连。
 */
/** 高帧率档 → 被控端刷新率下限（Hz）。与后端 HIGH_FPS_LADDER 同源。 */
const HIGH_FPS_MIN_HZ: Partial<Record<RcQuality, number>> = {
  fps120: 100,
  fps144: 144,
  fps165: 165,
};

export function visibleQualities(opts: {
  peerFps120?: boolean;
  h264Gpu?: boolean;
  refreshHz?: number;
  peerHevc?: boolean;
  hevcHw?: boolean;
}): readonly RcQualityOption[] {
  const hz = opts.refreshHz ?? 0;
  let list = RC_QUALITIES.filter((o) => {
    const minHz = HIGH_FPS_MIN_HZ[o.key as RcQuality];
    if (minHz === undefined) return true;
    // fps120：沿用旧口径——peerFps120=true 即显示（对端 caps 已统一判定
    // 硬编+单屏+≥100Hz），refreshHz 只是设置页视角的本地证据，undefined 不拦。
    if (o.key === "fps120")
      return opts.peerFps120 === true || (opts.h264Gpu === true && hz >= 100);
    // fps144/fps165：必须有刷新率证据——宁缺毋滥，不让跑不到的档进菜单
    return (opts.peerFps120 === true || opts.h264Gpu === true) && hz >= minHz;
  });
  const hevcOk =
    opts.peerHevc === true || (opts.h264Gpu === true && opts.hevcHw === true);
  if (!hevcOk) list = list.filter((o) => o.key !== "uhd60");
  return list;
}

/** 自动档实际生效档位的短文案（后端 RcStatus.active_quality）。 */
export function activeQualityLabel(active: string | undefined): string {
  return qualityLabel(active || "balanced");
}

/**
 * HUD / 窄处的画质文案。auto 有**两种**形态，必须分清：
 * - 知道自动档此刻落在哪一档（只有**被控端**知道，换档发生在推流的机器上）
 *   → 「自动 · 清晰」；
 * - 不知道（发起端视角：档位由对方决定）
 *   → 「自动 · 由对方决定」，不拿本机的档冒充对端；
 *   旧版在这里把本机 cfg 解析出的值当生效档传进来，于是出现
 *   `quality === "auto" && active === "auto"` → 「自动 · 自动」这种空话。
 */
export function qualityHudLabel(
  q: string,
  active?: string,
  peerDriven = false,
): string {
  if (q !== "auto") return qualityLabel(q);
  if (active && active !== "auto") return `自动 · ${activeQualityLabel(active)}`;
  return peerDriven ? "自动 · 由对方决定" : "自动";
}

const LABELS = new Map<string, string>(RC_QUALITIES.map((o) => [o.key, o.label]));
const DEFAULT_LABEL = LABELS.get(DEFAULT_QUALITY) ?? "均衡";

/**
 * Q5：码率倍率选项（会话底栏「码率」下拉）。语义是**天花板**：与后端按
 * RTT/丢包算出的自动缩放相乘——调高不会越过弱网保护，调低则任何网络下都省。
 * 100 = 跟随链路（既有行为，完全不变）。
 */
export interface RcBitrateOption {
  pct: number;
  label: string;
  tip: string;
  /** 下拉菜单里 label 右侧的短补充，与 `RcQualityOption.meta` 同一用途。 */
  meta?: string;
}

export const RC_BITRATE_OPTIONS: readonly RcBitrateOption[] = [
  { pct: 50, label: "50% · 省带宽", tip: "画质明显下降，流量最省", meta: "最省流量" },
  { pct: 75, label: "75%", tip: "略省带宽，画质略降", meta: "略省带宽" },
  { pct: 100, label: "跟随链路", tip: "默认。按延迟/丢包自动调节，弱网自动降低", meta: "默认" },
  { pct: 150, label: "150%", tip: "档位上限内再提一半码率，弱网时仍会自动让路", meta: "再提一半" },
  {
    pct: 200,
    label: "200% · 尽量清晰",
    tip: "档位内最高画质；弱网保护仍生效，不会硬塞",
    meta: "档位内最高",
  },
];

/** 下拉当前值的短文案（未知 pct 直接显示百分比，不猜档名）。 */
export function bitrateLabel(pct: number): string {
  return RC_BITRATE_OPTIONS.find((o) => o.pct === pct)?.label ?? `${pct}%`;
}

/**
 * 短文案。给宽度受限的位置用（HUD、画面占位提示）。
 * 未知档回落默认档的文案——与后端默认档一致。
 */
export function qualityLabel(q: string): string {
  return LABELS.get(q) ?? DEFAULT_LABEL;
}
