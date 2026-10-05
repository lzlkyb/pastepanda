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
  codec: "jpeg" | "h264" | "hevc" | "av1";
  key: boolean;
}

/** 旧 JSON 轮询路径的帧已废弃，新路径：批量原始二进制（无 base64 / JSON 开销）。 */
export interface RcBinFrame {
  codec: "jpeg" | "h264" | "hevc" | "av1";
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
  | { kind: "frame_presented"; session_id: string; at_ms: number }
  | { kind: "mouse_move"; x: number; y: number }
  | { kind: "mouse_button"; x: number; y: number; button: number; down: boolean }
  | { kind: "wheel"; x: number; y: number; delta: number }
  | { kind: "key"; vk: number; down: boolean }
  /**
   * 乙-①：输入法选字完成后的**整串文本**，被控端按 Unicode 注入
   * （`SendInput` 的 `KEYEVENTF_UNICODE`，不经 VK 表）。
   *
   * 为什么必须有这条：候选期间的按键被守卫全部拦下（那是「打进对方机器」的事故源），
   * 拦完之后如果什么都不发，远控就打不出中文——等于把 bug 换成了残废。
   * 只在「打字模式」下发（判据 `lib/rcKeyMode.rcImeCommitOf`）。
   */
  | { kind: "text"; text: string }
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
  | { kind: "set_host_mute"; on: boolean }
  /**
   * 乙-①：把本机的键盘模式告诉被控端——`"type"` 按 VK 注入（打字模式，中文可输入），
   * `"direct"` 按扫描码注入（直传模式，游戏/快捷键准）。
   *
   * 要求 Control：它改的是「对方的机器怎么被按键」，不是「我自己看什么画面」，
   * 与键鼠注入同量级（口径同 `set_host_mute`）。
   */
  | { kind: "set_key_mode"; mode: string }
  /**
   * 乙-③：要求锁住**被控者本人的物理键鼠**（RustDesk 的 block-input 语义，仅 Windows 有意义）。
   *
   * 🔴 这条不是「一键就能锁」：被控端必须先在抽屉里勾了「允许对方锁定我的输入」，
   * 没勾它只回一条失败原因（`status.peer_input.err`），本机一个键都不吞。
   * 锁的是**物理输入**，不锁注入那一路——所以锁上之后你照常能操作对方机器。
   */
  | { kind: "set_input_lock"; on: boolean }
  /**
   * B 方案后台保活（2026-10-02）：发起端页面进/出后台。被控端收到 bg_pause
   * 挂起推流 + 看门狗放宽到 5 分钟（`link::PEER_BG_TTL_MS`）；bg_resume 立即
   * 补关键帧。生命周期事件，只看会话也发（免 Control 白名单）。
   * 发送方：`useRcBackgroundPause`（桌面/手机两壳共用）。
   */
  | { kind: "bg_pause" }
  | { kind: "bg_resume" };

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
  /** P2.3：对端 AV1 硬编可用（旧对端没有这个字段 → false）。 */
  av1_hw: boolean;
  refresh_hz: number;
  monitors: number;
}
