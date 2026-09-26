/**
 * 远程电脑 IPC 命令封装（对应 `src-tauri/src/commands/rc.rs`）。
 *
 * 从 `src/lib/api/rc.ts` 拆分而来，仅搬代码、不改行为；原始 `rc.ts` 现为本文件的
 * re-export 门面，所有 `from "@/lib/api/rc"` 的引用继续原样工作。
 * 失败由调用方 toast，这里不吞。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  RcCapability,
  RcDeviceTag,
  RcIdentity,
  RcInvite,
  RcInviteCreated,
  RcMonitorInfo,
  RcSession,
  RcStatus,
  RcSyncOffer,
  RcTargetDevice,
  RcUnoCreated,
} from "./rcTypes";
import type {
  RcCaptureScope,
  RcEncodeCaps,
  RcHistoryItem,
  RcInputEvent,
  RcQuality,
} from "./rcFrameTypes";

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

/** 设备彩色标签（2026-09-26 对齐稿①）。整组覆盖式保存；空数组 = 清空。 */
export function rcDeviceTagsSet(nodeId: string, tags: RcDeviceTag[]): Promise<void> {
  return invoke("rc_device_tags_set", { nodeId, tags });
}

/** 设备描述性备注（长文本）。空串 = 清除；与改名别名互不串扰。 */
export function rcDeviceRemarkSet(nodeId: string, remark: string): Promise<void> {
  return invoke("rc_device_remark_set", { nodeId, remark });
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
  /** 固定接入密码（Q2 方案 C）。与 unoCode 互斥携带。 */
  unoPass?: string,
): Promise<RcSession> {
  return invoke("rc_request_session", {
    nodeId,
    capability,
    unoCode: unoCode ?? null,
    unoPass: unoPass ?? null,
  });
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

/** 开启 / 换无人值守固定密码（Q2 方案 C，被控端）。 */
export function rcUnoPassEnable(p: {
  password: string;
  capability: RcCapability;
  allowWan: boolean;
}): Promise<void> {
  return invoke("rc_uno_pass_enable", {
    password: p.password,
    capability: p.capability,
    allowWan: p.allowWan,
  });
}

/** 一键全局关闭无人值守固定密码（幂等）。 */
export function rcUnoPassDisable(): Promise<void> {
  return invoke("rc_uno_pass_disable");
}

/** 只改「允许跨网」开关，不动密码本体。 */
export function rcUnoPassSetWan(allow: boolean): Promise<void> {
  return invoke("rc_uno_pass_set_wan", { allow });
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

/**
 * 决策 10：设置某台设备的「自动接收文件」。`on=false` 即恢复每次确认。
 *
 * 🔴 它**只影响要不要弹确认条，不影响门禁**：被禁用 / 未配对的设备照样进不来。
 * 🔴 只对**推送**方向生效（对方发给本机）。取回方向是「我挑文件发给对方」，
 *    没有可自动的东西，所以那一边不显示这个开关。
 */
export function rcDeviceAutoAcceptSet(nodeId: string, on: boolean): Promise<void> {
  return invoke("rc_device_auto_accept_set", { nodeId, on });
}

export function rcEndSession(): Promise<void> {
  return invoke("rc_end_session");
}

export function rcRequireActive(): Promise<RcSession> {
  return invoke<RcSession>("rc_require_active");
}

// ── G3 音频 ─────────────────────────────────────────────────────────────

/** G3：会话中开关系统声音（被控端有可见提示）。 */
export function rcAudioToggle(on: boolean): Promise<void> {
  return invoke("rc_audio_toggle", { on });
}

/**
 * G3：被控端**本机**静音系统声音（一票否决——对端开着也听不到）。
 *
 * ❗ 2026-09-20（G3-B）之后它**不再只是本机状态**：切换时会推一条 `host_audio`
 * 帧给对端，对端据此显示「对方已静音（不发送声音）」。在此之前对端只能感到
 * 声音没了、无从判断是不是坏了。
 *
 * 跨会话保持（隐私开关不做自动回退），应用重启回到默认「可被听」。
 */
export function rcSetAudioLocalMute(muted: boolean): Promise<void> {
  return invoke("rc_set_audio_local_mute", { muted });
}

/**
 * G3-C：被控端**本机**设置主机扬声器静音（对端操作过之后的一键恢复入口）。
 *
 * 与 `rcSendInput({ kind: "set_host_mute" })` 的分工：那个是发起端请对端静音，
 * 这个是本机自己改。**不影响**环回采集——发起端照样听得到（同 Parsec /
 * GameStream 的「mute host speakers」：让主机本地闭嘴，不改变串流）。
 */
export function rcHostMuteSet(on: boolean): Promise<void> {
  return invoke("rc_host_mute_set", { on });
}

export function rcSendInput(event: RcInputEvent): Promise<void> {
  return invoke("rc_send_input", { event });
}

export function rcPushClipboard(text: string): Promise<void> {
  return invoke("rc_push_clipboard", { text });
}

/** 后端等回包（最长约 4s）；空串 = 对方剪贴板真空白。C5 起超时/失败直接 reject，
 *  不再折叠成 null（null 与「拉到了但没内容」必须可区分）。 */
export function rcPullClipboard(): Promise<string | null> {
  return invoke("rc_pull_clipboard");
}

export function rcSessionHistory(): Promise<RcHistoryItem[]> {
  return invoke("rc_session_history");
}

export function rcHistoryClear(): Promise<void> {
  return invoke("rc_history_clear");
}

export function rcSetQuality(quality: RcQuality): Promise<void> {
  return invoke("rc_set_quality", { quality });
}

/** Q5：保存发起端「码率倍率」偏好（50–200，100 = 跟随链路）。 */
export function rcSetBitratePct(pct: number): Promise<void> {
  return invoke("rc_set_bitrate_pct", { pct });
}

export function rcEncodeCaps(): Promise<RcEncodeCaps> {
  return invoke<RcEncodeCaps>("rc_encode_caps");
}

export function rcSetCaptureScope(scope: RcCaptureScope): Promise<void> {
  return invoke("rc_set_capture_scope", { scope });
}

export function rcListMonitors(): Promise<RcMonitorInfo[]> {
  return invoke("rc_list_monitors");
}
