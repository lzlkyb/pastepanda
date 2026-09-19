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
}

/**
 * 档位表，顺序 = 界面上的呈现顺序（从自适应到最高）。
 * `auto` 是默认档（2A）：被控端会话内按 RTT/带宽在 流畅/均衡/清晰/超清 之间
 * 自动换档；其余实名档 = 锁定。fps120（P1 零拷贝专属）仅在能力达标时展示。
 * `tip` 里保留了设置页原有口径——它们是同一档的补充事实。
 */
export const RC_QUALITIES: readonly RcQualityOption[] = [
  {
    key: "auto",
    label: "自动",
    tip: "按延迟与带宽在 流畅/均衡/清晰/超清 间自动切换（默认）；选其它档即锁定",
  },
  { key: "smooth", label: "流畅", tip: "约 10fps · 宽 960 · 适合弱网" },
  { key: "balanced", label: "均衡", tip: "约 10fps · 宽 1280" },
  { key: "sharp", label: "清晰", tip: "约 15fps · 宽 1920 · 适合局域网" },
  { key: "ultra", label: "超清", tip: "约 12fps · 宽 2560（约 2.5K）· JPEG 路径" },
  { key: "uhd", label: "原生", tip: "硬编原生分辨率（约 4K · 20fps）· 需 GPU · 无硬编时回落超清" },
  {
    key: "uhd60",
    label: "4K60",
    tip: "原生分辨率 60fps（4K 屏即 4K60）· 需 HEVC 硬编 · 同画质比 H.264 省约一半带宽",
  },
  { key: "fps60", label: "高帧率", tip: "1080p 60fps · 拖动最跟手 · 需硬编，跑不满时自动降频" },
  {
    key: "fps120",
    label: "高帧率+",
    tip: "单屏 1080p 120fps（零拷贝硬编）· 需 ≥100Hz 高刷屏 + 硬件编码器，跑不满时自动降频",
  },
];

/** 后端默认档（2A 起 = 自动）。未知档位一律回落到它，不猜、不显示空文案。 */
export const DEFAULT_QUALITY: RcQuality = "auto";

/**
 * P1：fps120「高帧率+」只在能力达标时出现——跑不到的档不卖。
 * - 发起端视角：以被控端 caps 上报为准（`peerFps120`）；
 * - 被控端/设置页视角：本机探测（`h264Gpu` 硬件 D3D11-aware MFT + 刷新 ≥100Hz）。
 * 两者都没给时不出 fps120（宁缺毋滥）。
 *
 * Q3/Q4：`uhd60`（4K60）同理——4K60 的 H.264 要 L5.2（解码端兼容性差），
 * 必须走 HEVC；发起端看 `peerHevc`（对端 caps），设置页看本机
 * `h264Gpu && hevcHw`。后端 `set_stream_quality` 有同一套校验兜直连。
 */
export function visibleQualities(opts: {
  peerFps120?: boolean;
  h264Gpu?: boolean;
  refreshHz?: number;
  peerHevc?: boolean;
  hevcHw?: boolean;
}): readonly RcQualityOption[] {
  const ok =
    opts.peerFps120 === true ||
    (opts.h264Gpu === true && (opts.refreshHz ?? 0) >= 100);
  const hevcOk =
    opts.peerHevc === true || (opts.h264Gpu === true && opts.hevcHw === true);
  let list = ok ? RC_QUALITIES : RC_QUALITIES.filter((o) => o.key !== "fps120");
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
}

export const RC_BITRATE_OPTIONS: readonly RcBitrateOption[] = [
  { pct: 50, label: "50% · 省带宽", tip: "画质明显下降，流量最省" },
  { pct: 75, label: "75%", tip: "略省带宽，画质略降" },
  { pct: 100, label: "跟随链路", tip: "默认。按延迟/丢包自动调节，弱网自动降低" },
  { pct: 150, label: "150%", tip: "档位上限内再提一半码率，弱网时仍会自动让路" },
  { pct: 200, label: "200% · 尽量清晰", tip: "档位内最高画质；弱网保护仍生效，不会硬塞" },
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
