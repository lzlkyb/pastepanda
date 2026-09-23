/**
 * 远程电脑「帧 / 音频 / 输入 / 历史 / 画质」相关类型定义。
 *
 * 从 `src/lib/api/rc.ts` 拆分而来，仅搬类型、不改行为；原始 `rc.ts` 现为本文件的
 * re-export 门面，所有 `from "@/lib/api/rc"` 的引用继续原样工作。
 */

export interface RcFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RcFramePayload {
  jpeg_base64: string;
  at_ms: number;
  full: boolean;
  width: number;
  height: number;
  rect: RcFrameRect | null;
  codec: "jpeg" | "h264" | "hevc";
  key: boolean;
}

/** 旧 JSON 轮询路径的帧已废弃，新路径：批量原始二进制（无 base64 / JSON 开销）。 */
export interface RcBinFrame {
  codec: "jpeg" | "h264" | "hevc";
  key: boolean;
  full: boolean;
  at_ms: number;
  /** P0-2 延迟分段：被控端采集/编码耗时（ms）。0 = 未统计。 */
  cap_ms: number;
  enc_ms: number;
  width: number;
  height: number;
  rect: RcFrameRect | null;
  data: Uint8Array;
}

// ── G3 音频 ─────────────────────────────────────────────────────────────

/** 音频流配置（后端 `AudioCfg`）。asc = AudioSpecificConfig，喂 AudioDecoder `description`。 */
export interface RcAudioCfg {
  sr: number;
  ch: number;
  asc: Uint8Array;
  br: number;
}

/** 一帧裸 AAC（AAC-LC 帧相互独立，丢一帧只咔一声）。 */
export interface RcAudioFrame {
  ptsMs: number;
  data: Uint8Array;
}

export type RcAudioItem = { type: 0; cfg: RcAudioCfg } | ({ type: 1 } & RcAudioFrame);

export type RcInputEvent =
  | { kind: "mouse_move"; x: number; y: number }
  | { kind: "mouse_button"; x: number; y: number; button: number; down: boolean }
  | { kind: "wheel"; x: number; y: number; delta: number }
  | { kind: "key"; vk: number; down: boolean }
  | { kind: "clipboard_push"; text: string }
  | { kind: "clipboard_pull" }
  | { kind: "ping"; ts?: number }
  | { kind: "set_quality"; quality: string }
  | { kind: "set_capture_scope"; scope: string }
  | { kind: "set_codec"; codec: string }
  /** Q5：码率倍率（50–200，100 = 跟随链路）。与弱网自动缩放相乘。 */
  | { kind: "set_bitrate_pct"; pct: number }
  /** 解码断链 → 请求被控端下一帧强制 IDR（弱网花屏自愈） */
  | { kind: "request_key" }
  /** G3：开关系统声音（音频流）。被控端有可见提示。 */
  | { kind: "audio_on"; on: boolean }
  /** G3-C：请被控端把**主机扬声器**静音/恢复（要求 Control 会话）。 */
  | { kind: "set_host_mute"; on: boolean };

export interface RcHistoryItem {
  peer: string;
  peer_name: string;
  /**
   * 统一显示名（备注优先）。后端查询时按 node_id join 配对表叠加，
   * 落库的 `peer_name` 快照原文不动。缺失 = 旧版后端或该设备没起备注
   * ⇒ 前端回落 `peer_name`。
   */
  display_name?: string;
  capability: string;
  dir: "inbound" | "outbound";
  started_ms: number;
  ended_ms: number;
  duration_ms: number;
  reason: string;
  /**
   * 本次实测走的路径（`lan` / `direct` / `relay`）。
   * 空串或缺失 = 更早的记录（那时还没记这个）或本次一条路都没通 ⇒ 不显示。
   */
  path_kind?: string;
  /** 本会话 RTT 摘要（毫秒）。全 0 或缺失 = 没采到样本 ⇒ 不显示。 */
  rtt_min?: number;
  rtt_avg?: number;
  rtt_max?: number;
}

export type RcQuality =
  | "auto"
  | "uhd"
  | "uhd60"
  | "ultra"
  | "sharp"
  | "balanced"
  | "smooth"
  | "fps60"
  | "fps120"
  | "fps144"
  | "fps165";
export type RcCaptureScope = "virtual" | "primary" | `monitor:${number}`;

/** P1/P3：本机画面编码能力（设置页 / 会话 UI 诚实出档用）。 */
export interface RcEncodeCaps {
  h264_gpu: boolean;
  hevc_hw: boolean;
  refresh_hz: number;
  monitors: number;
}
