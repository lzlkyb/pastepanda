/**
 * 远程电脑 API（方案 A：与同步配对分离）——对应 `src-tauri/src/commands/rc.rs`。
 *
 * 字段名与 Rust 一致（snake_case）。失败由调用方 toast，这里不吞。
 */
import { invoke } from "@tauri-apps/api/core";

export type RcCapability = "view" | "control";

export interface RcSession {
  id: string;
  peer: string;
  peer_name: string;
  capability: RcCapability;
  phase: "idle" | "outbound_pending" | "outbound_active" | "inbound_pending" | "inbound_active";
  started_ms: number;
  granted: boolean;
}

export interface RcInboundKnock {
  peer: string;
  peer_name: string;
  capability: RcCapability;
  first_seen_ms: number;
}

export interface RcJoinRequest {
  node_id: string;
  first_seen_ms: number;
  last_seen_ms: number;
  tries: number;
}

export interface RcStatus {
  enabled: boolean;
  capability: RcCapability;
  session: RcSession | null;
  pending: RcInboundKnock[];
  joins: RcJoinRequest[];
  /** 在效的无人值守接入码摘要（Q2）。不含码本身；空数组 = 没有生效中的码。 */
  uno?: RcUnoInfo[];
  device_deny: Record<string, boolean>;
  running: boolean;
  /** auto / uhd / ultra / sharp / balanced / smooth（auto = 被控端自动换档） */
  quality: string;
  /**
   * 自动档当前实际生效的档位（2A）。非 auto 档时与 quality 相同。
   * HUD / 设置页显示真实档位用它，不猜。
   */
  active_quality?: string;
  capture_scope: string;
  /** 发起端「码率倍率」偏好（Q5，50–200，100 = 跟随链路）。会话下拉初值。 */
  bitrate_pct?: number;
  rtt_ms?: number;
  /** 发起端本端丢包率（‰，EMA）；0 = 尚未采样。HUD 显示「丢包 x.x%」。 */
  loss_permille?: number;
  /**
   * 会话链路实际走的路：`lan` / `direct` / `relay`；空串 = 未测到（不猜）。
   * 后端从 iroh **活连接**实测（`rc/link.rs` 复用 `sync::path_kind`），
   * 与设备列表那个基于组播的推测是两回事。
   */
  path_kind?: string;
  /**
   * 时钟偏差（被控端时钟 − 发起端时钟，ms，EMA）。「画面延迟」= 本地时刻 −
   * (帧采集时刻 − 偏差)。0 = 尚未校准（显示的延迟带两机时钟差）。
   */
  clock_skew_ms?: number;
  /** 发起端视角：被控端是否支持 fps120（P1 caps）。被控端视角恒 false。 */
  peer_fps120?: boolean;
  /** 发起端视角：被控端是否支持 HEVC 硬编（Q3 caps）。4K60 档门控用。 */
  peer_hevc?: boolean;
  /** 发起端视角：被控端主屏刷新率（Hz）。0 = 未上报。 */
  peer_refresh_hz?: number;
  /**
   * 发起端视角：被控端在线显示器列表（Q7 caps 帧）。空 = 未上报
   * （旧版本对端）或单屏——会话底栏据此出不出逐屏选项与「下一屏」。
   */
  peer_monitors?: RcMonitorInfo[];
  /**
   * 最后一次收到对端 pong 的时间戳（ms）；0 = 还没收到过。
   * 链路活性判据的唯一来源（见 `useRcLinkState`）——ping 的本地 invoke
   * 成功与否不代表对端收到了。
   */
  last_pong_ms?: number;
  /** 非阻塞发起申请的后台失败原因 */
  outbound_error?: string | null;
  /**
   * Q6：发起端自动重连进度（免确认设备异常断流后）。null = 没有。
   * attempt/max 驱动「正在重连 N/M」；gave_up = 次数用尽，提示手动重连。
   */
  reconnecting?: {
    peer: string;
    peer_name: string;
    /** 原会话能力档（「重连失败」时手动重连复用） */
    capability: RcCapability;
    attempt: number;
    max: number;
    gave_up: boolean;
  } | null;
}

/** 路径切换事件 payload（C：relay ↔ 直连 自动切换）。 */
export interface RcPathChanged {
  from: string;
  to: string;
}

export type RcPresence = "live" | "recent" | "seen" | "never";

export interface RcTargetDevice {
  node_id: string;
  name: string;
  conn_state: string;
  last_seen: number;
  denied: boolean;
  /** rc = 远程配对；sync = 仅同步配对（可直接发起远程） */
  source: "rc" | "sync";
  /** 可达性档位：live / recent / seen / never */
  presence: RcPresence;
  /**
   * 上一次会话**实测**走的路径（`lan` / `direct` / `relay`）。
   * 空串 = 还没连过（或只做过笔记同步），此时不显示这一格。
   */
  last_path?: string;
  /** A1：本地备注名。空串 = 没起过，显示回落 `name`。仅同步配对设备恒空。 */
  note?: string;
  /** 方案 D「免确认直连」：这台设备发起远程时跳过人工同意。默认 false。 */
  trusted?: boolean;
}

export interface RcSyncOffer {
  node_id: string;
  name: string;
  paired_at: string;
}

export interface RcIdentity {
  node_id: string;
  fingerprint: string;
  device_name: string;
  running: boolean;
}

export interface RcInviteCreated {
  code: string;
  expires_at: number;
}

export interface RcInvite {
  node_id: string;
  name: string;
  addrs: string[];
  ts: number;
}

/** 在效的无人值守接入码摘要（Q2）。后端绝不给码本身——码只有生成那一刻可见。 */
export interface RcUnoInfo {
  /** 过期时刻（epoch 毫秒）。 */
  expires_ms: number;
  /** true = 24 小时内不限次。 */
  unlimited: boolean;
  capability: RcCapability;
  /** 接入的设备是否自动开免确认。 */
  also_trust: boolean;
}

export interface RcUnoCreated {
  /** 展示码 `XXXX-XXXX`（电话可读）。 */
  code: string;
  /** 完整接入串 `PPU-<码>-<node_id>`（跨网粘贴用）。 */
  full: string;
  expires_at: number;
}

export function rcStatus(): Promise<RcStatus> {
  return invoke<RcStatus>("rc_status");
}

export function rcIdentity(): Promise<RcIdentity> {
  return invoke<RcIdentity>("rc_identity");
}

export function rcTargets(): Promise<RcTargetDevice[]> {
  return invoke<RcTargetDevice[]>("rc_targets");
}

/** 按需探活：短超时拨一次，通了后端会刷 last_seen。 */
export function rcProbeTargets(nodeIds: string[]): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>("rc_probe_targets", { nodeIds });
}

export function rcSyncOffers(): Promise<RcSyncOffer[]> {
  return invoke<RcSyncOffer[]>("rc_sync_offers");
}

export function kbSyncAllowFromRc(nodeId: string, name: string): Promise<void> {
  return invoke("kb_sync_allow_from_rc", { nodeId, name });
}

export function kbSyncDenyFromRc(nodeId: string): Promise<void> {
  return invoke("kb_sync_deny_from_rc", { nodeId });
}

export function rcInviteCreate(name: string): Promise<RcInviteCreated> {
  return invoke<RcInviteCreated>("rc_invite_create", { name });
}

export function rcInvitePreview(code: string): Promise<RcInvite> {
  return invoke<RcInvite>("rc_invite_preview", { code });
}

export function rcPair(code: string): Promise<RcInvite> {
  return invoke<RcInvite>("rc_pair", { code });
}

export function rcForget(nodeId: string): Promise<void> {
  return invoke("rc_forget", { nodeId });
}

/** A1：设置设备的本地备注名。空串 = 清除（显示回落对端自报名）。 */
export function rcDeviceRename(nodeId: string, note: string): Promise<void> {
  return invoke("rc_device_rename", { nodeId, note });
}

export function rcJoinApprove(nodeId: string, name: string): Promise<void> {
  return invoke("rc_join_approve", { nodeId, name });
}

export function rcJoinDeny(nodeId: string): Promise<void> {
  return invoke("rc_join_deny", { nodeId });
}

export function rcSetEnabled(enable: boolean): Promise<void> {
  return invoke("rc_set_enabled", { enable });
}

/** 工具箱一键起通道：不要求「允许被远程」（方案 A）。 */
export function rcStartChannel(): Promise<void> {
  return invoke("rc_start_channel");
}

export function rcSetCapability(capability: RcCapability): Promise<void> {
  return invoke("rc_set_capability", { capability });
}

export function rcSetDeviceAllowed(nodeId: string, allowed: boolean): Promise<void> {
  return invoke("rc_set_device_allowed", { nodeId, allowed });
}

export function rcRequestSession(
  nodeId: string,
  capability: RcCapability,
  unoCode?: string,
): Promise<RcSession> {
  return invoke("rc_request_session", { nodeId, capability, unoCode: unoCode ?? null });
}

/** 生成无人值守接入码（Q2 方案 B，被控端）。`ttlSecs` 只认 900 / 86400。 */
export function rcUnoGenerate(p: {
  ttlSecs: number;
  unlimited: boolean;
  capability: RcCapability;
  alsoTrust: boolean;
}): Promise<RcUnoCreated> {
  return invoke<RcUnoCreated>("rc_uno_generate", {
    ttlSecs: p.ttlSecs,
    unlimited: p.unlimited,
    capability: p.capability,
    alsoTrust: p.alsoTrust,
  });
}

/** 撤销全部无人值守接入码。返回撤销数量。 */
export function rcUnoRevoke(): Promise<number> {
  return invoke<number>("rc_uno_revoke");
}

export function rcCancelRequest(): Promise<void> {
  return invoke("rc_cancel_request");
}

export function rcClearOutboundError(): Promise<void> {
  return invoke("rc_clear_outbound_error");
}

export function rcApproveInbound(nodeId: string): Promise<RcSession> {
  return invoke("rc_approve_inbound", { nodeId });
}

export function rcDenyInbound(nodeId: string): Promise<void> {
  return invoke("rc_deny_inbound", { nodeId });
}

/** 方案 D：设置某台设备的「免确认直连」。`trusted=false` 即恢复每次询问。 */
export function rcDeviceTrustSet(nodeId: string, trusted: boolean): Promise<void> {
  return invoke("rc_device_trust_set", { nodeId, trusted });
}

export function rcEndSession(): Promise<void> {
  return invoke("rc_end_session");
}

export function rcRequireActive(): Promise<RcSession> {
  return invoke<RcSession>("rc_require_active");
}

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

export function rcLatestFrame(): Promise<RcFramePayload | null> {
  return invoke<RcFramePayload | null>("rc_latest_frame");
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

/**
 * 解析 `rc_drain_frames` 返回的原始字节。布局见后端 `encode_frame_batch`
 * （全部小端）：`"RCF2" u32 | count u32`，后跟 count 条
 * `codec u8 | key u8 | full u8 | has_rect u8 | at_ms i64 | cap u16 | enc u16
 *  | w u32 | h u32 | rect x,y,w,h 4×u32 | data_len u32 | data`。
 */
export function parseFrameBatch(buf: ArrayBuffer): RcBinFrame[] {
  const u8 = new Uint8Array(buf);
  if (u8.length < 8 || u8[0] !== 0x52 || u8[1] !== 0x43 || u8[2] !== 0x46 || u8[3] !== 0x32) {
    throw new Error("帧批量数据头不合法（RCF2）");
  }
  const v = new DataView(buf);
  const count = v.getUint32(4, true);
  const out: RcBinFrame[] = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 44 > u8.length) throw new Error("帧批量数据被截断");
    const codecByte = v.getUint8(off);
    const key = v.getUint8(off + 1) === 1;
    const full = v.getUint8(off + 2) === 1;
    const hasRect = v.getUint8(off + 3) === 1;
    const atMs = Number(v.getBigInt64(off + 4, true));
    const capMs = v.getUint16(off + 12, true);
    const encMs = v.getUint16(off + 14, true);
    const width = v.getUint32(off + 16, true);
    const height = v.getUint32(off + 20, true);
    let rect: RcFrameRect | null = null;
    if (hasRect) {
      rect = {
        x: v.getUint32(off + 24, true),
        y: v.getUint32(off + 28, true),
        w: v.getUint32(off + 32, true),
        h: v.getUint32(off + 36, true),
      };
    }
    const len = v.getUint32(off + 40, true);
    off += 44;
    if (off + len > u8.length) throw new Error("帧数据被截断");
    // 视图而非拷贝：底层 ArrayBuffer 在本轮应用完成前一直存活
    const data = new Uint8Array(buf, off, len);
    off += len;
    out.push({
      codec: codecByte === 2 ? "hevc" : codecByte === 1 ? "h264" : "jpeg",
      key,
      full,
      at_ms: atMs,
      cap_ms: capMs,
      enc_ms: encMs,
      width,
      height,
      rect,
      data,
    });
  }
  return out;
}

/** 批量取走后端攒下的全部待显示帧（H.264 P 帧与脏块帧必须全序不丢）。 */
export function rcDrainFrames(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("rc_drain_frames");
}

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
  | { kind: "request_key" };

export function rcSendInput(event: RcInputEvent): Promise<void> {
  return invoke("rc_send_input", { event });
}

export function rcPushClipboard(text: string): Promise<void> {
  return invoke("rc_push_clipboard", { text });
}

/** 后端等回包（最长约 4s）；超时/失败返回 null。 */
export function rcPullClipboard(): Promise<string | null> {
  return invoke("rc_pull_clipboard");
}

export interface RcHistoryItem {
  peer: string;
  peer_name: string;
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

export function rcSessionHistory(): Promise<RcHistoryItem[]> {
  return invoke("rc_session_history");
}

export function rcHistoryClear(): Promise<void> {
  return invoke("rc_history_clear");
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
  | "fps120";
export type RcCaptureScope = "virtual" | "primary" | `monitor:${number}`;

export function rcSetQuality(quality: RcQuality): Promise<void> {
  return invoke("rc_set_quality", { quality });
}

/** Q5：保存发起端「码率倍率」偏好（50–200，100 = 跟随链路）。 */
export function rcSetBitratePct(pct: number): Promise<void> {
  return invoke("rc_set_bitrate_pct", { pct });
}

/** P1/P3：本机画面编码能力（设置页 / 会话 UI 诚实出档用）。 */
export interface RcEncodeCaps {
  h264_gpu: boolean;
  hevc_hw: boolean;
  refresh_hz: number;
  monitors: number;
}

export function rcEncodeCaps(): Promise<RcEncodeCaps> {
  return invoke<RcEncodeCaps>("rc_encode_caps");
}

export function rcSetCaptureScope(scope: RcCaptureScope): Promise<void> {
  return invoke("rc_set_capture_scope", { scope });
}

export interface RcMonitorInfo {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  primary: boolean;
}

export function rcListMonitors(): Promise<RcMonitorInfo[]> {
  return invoke("rc_list_monitors");
}

/* A3 的局域网 6 位数字配对**不在本文件**：见 `lib/api/rcPair.ts`。
 * 那是独立的一条路（对应 `commands/rc_pair.rs`），与这里的邀请码 / 会话
 * 命令没有共用状态，拆开是为了让两边都别逼近 `.ts ≤ 400` 的红线。 */
