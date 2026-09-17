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
  device_deny: Record<string, boolean>;
  running: boolean;
  quality: string;
  capture_scope: string;
  rtt_ms?: number;
  /**
   * 会话链路实际走的路：`lan` / `direct` / `relay`；空串 = 未测到（不猜）。
   * 后端从 iroh **活连接**实测（`rc/link.rs` 复用 `sync::path_kind`），
   * 与设备列表那个基于组播的推测是两回事。
   */
  path_kind?: string;
  /**
   * 最后一次收到对端 pong 的时间戳（ms）；0 = 还没收到过。
   * 链路活性判据的唯一来源（见 `useRcLinkState`）——ping 的本地 invoke
   * 成功与否不代表对端收到了。
   */
  last_pong_ms?: number;
  /** 非阻塞发起申请的后台失败原因 */
  outbound_error?: string | null;
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

export function rcRequestSession(nodeId: string, capability: RcCapability): Promise<RcSession> {
  return invoke("rc_request_session", { nodeId, capability });
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
  codec: "jpeg" | "h264";
  key: boolean;
}

export function rcLatestFrame(): Promise<RcFramePayload | null> {
  return invoke<RcFramePayload | null>("rc_latest_frame");
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
  | { kind: "set_codec"; codec: string };

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

export type RcQuality = "uhd" | "ultra" | "sharp" | "balanced" | "smooth";
export type RcCaptureScope = "virtual" | "primary" | `monitor:${number}`;

export function rcSetQuality(quality: RcQuality): Promise<void> {
  return invoke("rc_set_quality", { quality });
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
