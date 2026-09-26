/**
 * 远程电脑核心类型定义（方案 A：与同步配对分离）——对应 `src-tauri/src/commands/rc.rs`。
 *
 * 从 `src/lib/api/rc.ts` 拆分而来，仅搬类型、不改行为；原始 `rc.ts` 现为本文件的
 * re-export 门面，所有 `from "@/lib/api/rc"` 的引用继续原样工作。
 * 字段名与 Rust 一致（snake_case）。
 */

export type RcCapability = "view" | "control";

export interface RcSession {
  id: string;
  peer: string;
  peer_name: string;
  /**
   * 对端统一显示名（备注优先，后端 status 投影时现查配对表回填）。
   * 空串 / 缺失（旧版后端）= 前端回落 `peer_name`，再回落指纹。
   */
  display_name?: string;
  capability: RcCapability;
  phase: "idle" | "outbound_pending" | "outbound_active" | "inbound_pending" | "inbound_active";
  started_ms: number;
  granted: boolean;
}

export interface RcInboundKnock {
  peer: string;
  peer_name: string;
  /** 对端统一显示名（备注优先）。空串 / 缺失 = 回落 peer_name。 */
  display_name?: string;
  capability: RcCapability;
  first_seen_ms: number;
}

export interface RcJoinRequest {
  node_id: string;
  first_seen_ms: number;
  last_seen_ms: number;
  tries: number;
}

/** 无人值守固定密码的开启状态（Q2 方案 C）。后端绝不回传密码或其哈希。 */
export interface RcUnoPassInfo {
  /** 密码接入授予的能力档上限。 */
  cap: RcCapability;
  /** true = 允许跨网（false = 仅局域网，默认）。 */
  wan: boolean;
  /** 开启时刻（epoch 毫秒）。换密码会刷新。 */
  since_ms: number;
}

/** 🔴 P1-4（2026-09-23 审计）：一次非阻塞发起失败的**带归因**投影（后端同名结构）。
 * 失败槽是全局单值而写它的路径有多条（手动发起 / 自动重连、多台设备），
 * 旧裸文案会归因漂移；`peer`/`session_id` 供展示侧把错误挂回正确的设备。 */
export interface RcOutboundError {
  peer: string;
  session_id: string;
  /** 给用户看的文案（原 `Option<String>` 的内容）。 */
  error: string;
}

export interface RcStatus {
  enabled: boolean;
  capability: RcCapability;
  session: RcSession | null;
  pending: RcInboundKnock[];
  joins: RcJoinRequest[];
  /** 在效的无人值守接入码摘要（Q2）。不含码本身；空数组 = 没有生效中的码。 */
  uno?: RcUnoInfo[];
  /** 无人值守固定密码的开启状态（Q2 方案 C）。缺省 = 未开启。 */
  uno_pass?: RcUnoPassInfo;
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
   * 后端从 iroh**活连接**实测（`rc/link.rs` 复用 `sync::path_kind`），
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
   * 发起端视角：被控端 caps 是否声明「能读鼠标移动数据报」（R3）。
   * false / 缺省 = 官方 7.2.1 及更早——会话顶栏提示升级对端；
   * **不改传输**（MouseMove 仍走数据报，旧对端收不到是已知限制）。
   */
  peer_dgram_input?: boolean;
  /**
   * 🔴 C3（2026-09-23 审计）：最后一次收到对端 pong 的「距今毫秒数」；
   * null / 缺省 = 本会话还没收到过任何 pong。
   *
   * 后端 pong 时间戳是**进程私有单调钟**（墙钟一跳就会把新鲜度判据算乱），
   * 裸时刻跨进程比较无意义——唯一安全的投影是 age。前端收到后立刻用
   * `performance.now()` 定锚外推（见 `useRcLinkState`），全程不碰墙钟。
   * 链路活性判据的唯一来源——ping 的本地 invoke 成功与否不代表对端收到了。
   */
  pong_age_ms?: number | null;
  /**
   * 非阻塞发起申请的后台失败原因。
   * 🔴 P1-4：后端槽位是全局单值而写它的有多台设备——旧裸串会把 A 的失败挂在 B
   * 脸上，现在带归因；给用户看的文案取 `.error`（见 `RcOutboundError`）。
   */
  outbound_error?: RcOutboundError | null;
  /**
   * Q6：发起端自动重连进度（免确认设备异常断流后）。null = 没有。
   * attempt/max 驱动「正在重连 N/M」；gave_up = 次数用尽，提示手动重连。
   */
  reconnecting?: {
    peer: string;
    peer_name: string;
    /** 对端统一显示名（备注优先）。空串 / 缺失 = 回落 peer_name。 */
    display_name?: string;
    /** 原会话能力档（「重连失败」时手动重连复用） */
    capability: RcCapability;
    attempt: number;
    max: number;
    gave_up: boolean;
  } | null;
  /**
   * G3：被控端**本机**是否已静音系统声音（被控者自己在横幅上关的）。
   *
   * 与「对端开关」不是一回事：这个为 true 时对端开不开都听不到。**跨会话保持**，
   * 所以会话结束后仍可能为 true（下次被控时横幅按钮仍是「已静音」态）。
   */
  audio_local_mute?: boolean;
  /**
   * G3-B/C：**对端**报来的主机音频状态（发起端视角）。
   *
   * `null` / 缺失 = 旧对端不发这条帧（或本会话还没收到）→ 不摆相关断言。
   */
  peer_audio?: {
    /** 对方按了「不发送声音」（对方可见、可自行恢复）。 */
    local_mute: boolean;
    /** 对方**主机扬声器**静音中（G3-C 按钮态以它为准，不做乐观置位）。 */
    spk_mute: boolean;
    /** 上一次切换动作在对方那边失败的原因（成功 = 空）。 */
    err?: string | null;
  } | null;
  /** G3-C：对端静音了**本机**扬声器（被控端视角，横幅提示 + 恢复入口）。 */
  spk_muted_by_peer?: boolean;
}

/** 路径切换事件 payload（C：relay ↔ 直连 自动切换）。 */
export interface RcPathChanged {
  from: string;
  to: string;
}

export type RcPresence = "live" | "recent" | "seen" | "never";

/** 设备彩色标签（对齐 RustDesk TagPainter：行上只画色点，文字进悬停）。 */
export interface RcDeviceTag {
  name: string;
  /** 色板键（red/amber/green/cyan/blue/violet），不是 hex——颜色必须来自令牌（V3）。 */
  color: string;
}

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
  /**
   * 统一显示名（备注优先，后端 `display_name_of` 算好下发）。
   * 前端各显示点只读它（用 `rcDisplayName`），不再各自拼 `note || name`。
   * 缺失 = 旧版后端，`rcDisplayName` 会回落 `note`/`name`。
   */
  display_name?: string;
  /** 方案 D「免确认直连」：这台设备发起远程时跳过人工同意。默认 false。 */
  trusted?: boolean;
  /**
   * 决策 10：这台设备**推送**文件过来时跳过确认条（自动落进系统下载目录）。
   * 默认 false。与 `trusted` 是两件独立的事：那条管「接管我的屏幕」，
   * 这条只管「自动收下它发的文件」——可以只允许后者。
   */
  auto_accept?: boolean;
  /**
   * 对端**自报的系统**短标签（如 `Windows 11`）。
   *
   * 来源是会话 `Accept` 帧；空串 / 缺失 = 还没建立过会话，或对端是旧版 /
   * 采不到。此时**不渲染这一格**，不编默认值。仅同步配对设备恒为空。
   */
  os?: string;
  /**
   * 彩色标签（设备组织，2026-09-26 对齐稿①）。本机私产，不随信令同步。
   * 缺失/空数组 = 没打过标签；仅同步配对设备恒为空。取值口径见 `lib/rcDeviceTags`。
   */
  tags?: RcDeviceTag[];
  /** 描述性备注长文本（悬停/详情显示）。与 `note`（改名别名）分开：别名顶替显示名，这条只做补充。 */
  remark?: string;
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

export interface RcMonitorInfo {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  primary: boolean;
}
