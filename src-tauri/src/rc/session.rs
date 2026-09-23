//! 会话状态机与门禁（R0 核心）。
//!
//! # 红线
//!
//! 1. **无 Grant 会话即拒绝一切 Input 帧**——R0 只有信令，Input 在 R2，门禁先立。
//! 2. **被控端默认关**：`rc_enabled=false` 时入站 Request 直接 Deny。
//! 3. **设备级禁止**优先于能力档。
//! 4. **申请能力不得超过被控端能力上限**。

use super::protocol::{Capability, SessionPhase};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Q6：自动重连最多试几次、首试等多久（第 N 次延迟 = 基础 × N，2s/4s/6s）。
pub(super) const RECONNECT_MAX_ATTEMPTS: u32 = 3;
pub(super) const RECONNECT_BASE_DELAY_MS: u64 = 2_000;

/// 🔴 D12（2026-09-22 审计）：一轮重连「落地没落地」的轮询间隔与窗口。
///
/// [`RcService::request_session`] 是**非阻塞**的——它落一个 OutboundPending 就
/// 返回 Ok，真正的拨号在后台任务里跑（`dial_and_request` 带 15s 超时）。
/// 所以窗口必须盖过那 15s，否则会把「还在拨」误判成「失败了」。
/// 250ms × 72 = 18s。
pub(super) const RECONNECT_SETTLE_POLL_MS: u64 = 250;
pub(super) const RECONNECT_SETTLE_POLLS: u32 = 72;

/// 配置键。
pub const CFG_ENABLED: &str = "rc_enabled";
pub const CFG_CAPABILITY: &str = "rc_capability";
/// 设备级禁止：`{ "<node_id>": true }` 表示禁止该设备远程本机。
pub const CFG_DEVICE_DENY: &str = "rc_device_deny";

/// 一条会话记录（双向共用一份结构）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub id: String,
    /// 对端 node_id。
    pub peer: String,
    /// 对端设备名（展示用；门禁不看它）。
    pub peer_name: String,
    /// 对端**统一显示名**（`commands::rc::display_name_of`：备注优先于自报名）。
    ///
    /// 构造会话时留空——`RcService::status()` 每次投影时从配对表现查回填，
    /// 这样会话中途改备注也能立刻反映，不用等下一场会话。
    /// `serde(default)` 只为反序列化兼容旧载荷；本结构实际不落盘。
    #[serde(default)]
    pub display_name: String,
    /// 已授权的能力（Active 后才有意义；Pending 时是申请值）。
    pub capability: Capability,
    pub phase: SessionPhase,
    /// 墙钟起始时刻（epoch ms）。**只用于展示与历史**（时长记录）——
    /// 一切超时判据看 [`Self::started_mono`]。
    pub started_ms: i64,
    /// 🔴 C3（2026-09-23 审计）：单调钟起始时刻（`mono::mono_ms()` 口径）。
    ///
    /// 会话 TTL 与两侧心跳看门狗的时间锚。原先它们全锚 `started_ms`——墙钟一跳
    /// （NTP 回拨、手动改表、睡眠唤醒）要么把活会话秒判过期，要么让该断的永不断。
    /// `0` = 未填（反序列化残值 / 遗漏的构造点），判据遇 0 必须保守不触发。
    /// 单调基座是进程私有的，`skip` 不发给前端。
    #[serde(skip)]
    pub started_mono: i64,
    /// 被控侧：是否本机用户已点头。
    pub granted: bool,
}

/// 一次读出的会话三元组（P1-2）。
///
/// 🔴 `peer` / `phase` / `capability` 必须**同源**（来自同一次加锁的同一条
/// `Session`）。旧路径 `session_is` + `session_capability` 两次加锁之间会话
/// 可被换掉——旧 peer 的迟到输入会挂到**新会话**的能力上执行。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionSnapshot {
    pub peer: String,
    pub phase: SessionPhase,
    pub capability: Capability,
}

impl Session {
    /// 从同一条会话抽出快照。三元组同源的唯一取值点。
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            peer: self.peer.clone(),
            phase: self.phase,
            capability: self.capability,
        }
    }
}

/// 门禁判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Allow,
    /// 本机「允许被远程」关着。
    Disabled,
    /// 该设备被单独禁止。
    DeviceDenied,
    /// 未配对。
    NotPaired,
    /// 申请能力超过本机能力上限。
    CapabilityTooHigh,
    /// 已有会话。
    Busy,
}

impl Gate {
    pub fn deny_reason(&self) -> &'static str {
        match self {
            Gate::Allow => "",
            Gate::Disabled => "对方未开启「允许被远程协助」",
            Gate::DeviceDenied => "对方已单独禁止这台设备远程",
            Gate::NotPaired => "设备未配对",
            Gate::CapabilityTooHigh => "申请的能力超过对方允许的上限",
            Gate::Busy => "对方已有进行中的远程会话",
        }
    }

    /// 稳定错误码：前端分档文案用，不要改字符串。
    pub fn deny_code(&self) -> &'static str {
        match self {
            Gate::Allow => "",
            Gate::Disabled => "disabled",
            Gate::DeviceDenied => "device_denied",
            Gate::NotPaired => "not_paired",
            Gate::CapabilityTooHigh => "capability_too_high",
            Gate::Busy => "busy",
        }
    }
}

/// 被控侧入站申请的门禁。
///
/// `paired` 由调用方查 `devices` 表给出（本模块不依赖 DataStore）。
pub fn gate_inbound(
    rc_enabled: bool,
    max_cap: Capability,
    device_deny: &HashMap<String, bool>,
    peer: &str,
    paired: bool,
    requested: Capability,
    has_session: bool,
) -> Gate {
    if !rc_enabled {
        return Gate::Disabled;
    }
    if !paired {
        return Gate::NotPaired;
    }
    if device_deny.get(peer).copied().unwrap_or(false) {
        return Gate::DeviceDenied;
    }
    if !requested.allowed_by(max_cap) {
        return Gate::CapabilityTooHigh;
    }
    if has_session {
        return Gate::Busy;
    }
    Gate::Allow
}

/// 发起侧本地预检（对端真正门禁仍在对端）。
pub fn gate_outbound(has_session: bool) -> Gate {
    if has_session {
        Gate::Busy
    } else {
        Gate::Allow
    }
}

/// 合法迁移表。返回 `false` = 拒绝迁移（调用方报错，状态不动）。
pub fn can_transition(from: SessionPhase, to: SessionPhase) -> bool {
    use SessionPhase::*;
    matches!(
        (from, to),
        (Idle, OutboundPending)
            | (Idle, InboundActive)
            | (OutboundPending, OutboundActive)
            | (OutboundPending, Idle)
            | (OutboundActive, Idle)
            | (InboundActive, Idle)
    )
}

/// 会话是否已建立（可谈画面/输入）。
pub fn is_active(phase: SessionPhase) -> bool {
    matches!(
        phase,
        SessionPhase::OutboundActive | SessionPhase::InboundActive
    )
}

/// 被控横幅是否必须展示。Active 时恒 true——不可关到看不见（规则 15）。
pub fn must_show_control_banner(phase: SessionPhase) -> bool {
    phase == SessionPhase::InboundActive
}

/// 🔴 P1-6（2026-09-23 审计）：会话序号发生器。id 的唯一性靠它兜底，
/// 不再依赖「时间的分辨率够细」这个假设（见 [`new_session_id`]）。
static SESSION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 生成会话 id。不用 uuid 依赖：时间 + 随机 4 字节 + 进程内单调序号。
///
/// 🔴 P1-6：为什么必须加序号。id 是**收口的凭据**——`force_end_if_session` /
/// `session_id_is` 全按它认领会话（A2 那类「旧任务误杀新会话」的 bug 就是靠它挡的）。
/// 旧形状 `rc-{now_ms}-{subsec_nanos}` 里两个因子都可能重复：
/// - `now_ms` 在同一毫秒内建两场会话（快速断开重连：Err 分支收口 + 立刻重发申请）
///   必然相同；
/// - `subsec_nanos` 看着随机，但 Windows 上 `SystemTime` 的粒度是 100ns，且它走的是
///   同一个 `GetSystemTimePreciseAsFileTime` 口径——同一毫秒内两次取值可以完全相等。
///
/// 两个都撞上的后果是**旧任务的收口命中新会话**：新画面被拆掉，还留下重复的历史。
/// 序号是进程内单调的，同一次运行里永不重复；不引新依赖（原注释的约束照旧）。
pub fn new_session_id(now_ms: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("rc-{}-{:08x}-{:x}", now_ms, nanos, seq)
}

/// `last_seen` 多陈旧就不再算在线（毫秒）。
///
/// # 2026-09-21 从 120_000 收到 30_000（在线状态准确性修复）
///
/// 原值 120s 是「宽」的那头：它让**对端已关机**的设备在库里继续显示在线 2 分钟。
/// 配合当时「`probe` 拨通就刷 `last_seen`」的行为，用户点一下刷新就能把窗口重新充满
/// ——表现是「点一下就变在线」「打开页面状态不准」「一直显示在线」。
///
/// 🔴 30s 的依据：`last_seen` 现在**只由真实解除刷新**（真握手 / 会话建立 / 组播听见），
/// 探测行为不再写入。所以这个窗口的含义变纯粹了——「最近 30 秒内确实接触过」。
/// 组播 `STALE_MS`（60s）比它宽，是因为组播丢了还能靠下一轮补；这里是跨网唯一线索，
/// 必须比组播更保守，宁可显示离线也不显示假在线。
///
/// 改这个数之前先想清楚：**调大 = 更多假在线，调小 = 更多假离线**，
/// 在无中心服务器下两者不可兼得（见 `is_rc_online_for` 的说明）。
pub const ONLINE_STALE_MS: i64 = 30_000;

/// 设备可达性档位（比二值在线更诚实，见设计稿）。
///
/// - `live`：组播听得见或正在开会话 —— 绿点
/// - `recent`：2 分钟内还联系过 —— 琥珀
/// - `seen`：连上过但已过期 —— 灰 + 「仍可尝试」
/// - `never`：配对后从未连上 —— 灰
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RcPresence {
    Live,
    Recent,
    Seen,
    Never,
}

impl RcPresence {
    pub fn as_str(&self) -> &'static str {
        match self {
            RcPresence::Live => "live",
            RcPresence::Recent => "recent",
            RcPresence::Seen => "seen",
            RcPresence::Never => "never",
        }
    }
}

/// 按 node_id 判定可达性档位（纯函数，便于单测）。
pub fn rc_presence_level(
    node_id: &str,
    last_seen_ms: i64,
    live_ids: &std::collections::HashSet<String>,
    session_peer: Option<&str>,
    now_ms: i64,
) -> RcPresence {
    if live_ids.contains(node_id) || session_peer == Some(node_id) {
        return RcPresence::Live;
    }
    if last_seen_ms <= 0 {
        return RcPresence::Never;
    }
    if now_ms - last_seen_ms <= ONLINE_STALE_MS {
        RcPresence::Recent
    } else {
        RcPresence::Seen
    }
}

/// 按 node_id 判定在线（纯函数，便于单测）。
///
/// # 🔴 2026-09-21 重做：不再读 `conn_state`
///
/// 旧实现第三条证据是 `conn_state == "online" && last_seen 未过期`。问题在于
/// `conn_state` 是一个**只写 online 从不写 offline 的状态位**（`rc_device_touch(x, false)`
/// 在当时的代码里零调用点）——它一旦变真就永远为真，任何判定只要读它就必然产生假在线。
///
/// 现在判定**完全由证据实时推导**，不读任何可能过期的布尔位：
/// 1. presence 组播听得见（局域网最强证据）；
/// 2. 正在和它开会话（会话本身比时间戳更硬）；
/// 3. `last_seen` 在 [`ONLINE_STALE_MS`] 内（跨网 / 打洞 / 中继——组播听不见时唯一线索）。
///
/// `conn_state` 参数**已删除**：留着它只会诱使调用方再读一次那个脏字段。
/// 调用方（`commands/rc.rs`）拿本函数的返回值去填 `RcTargetDevice::conn_state`，
/// 方向是「判定 → 展示」，不再是「存储 → 展示」。
///
/// ❗ 第 3 条的两个前提缺一不可，改动时别拆散：
///
/// - `last_seen` 只由**真接触**刷新（探测不再写它，见 `RcService::probe_peer`）；
/// - 窗口是 30s 而不是 120s。
///
/// 少任何一条，「点一下就变在线」都会回来。
pub fn is_rc_online_for(
    node_id: &str,
    last_seen_ms: i64,
    live_ids: &std::collections::HashSet<String>,
    session_peer: Option<&str>,
    now_ms: i64,
) -> bool {
    if live_ids.contains(node_id) {
        return true;
    }
    if session_peer == Some(node_id) {
        return true;
    }
    last_seen_ms > 0 && now_ms - last_seen_ms <= ONLINE_STALE_MS
}

/// 活跃会话最长持续（毫秒）。超时后推流循环自动结束，避免无人值守挂死。
pub(super) const SESSION_TTL_MS: i64 = 2 * 60 * 60 * 1000;

/// TTL 判据（C3，纯函数，假时钟纪律同 `link_stale_kick`）。
///
/// 两个时间都必须是 `mono::mono_ms()` 口径——混进墙钟值时差会立刻算错，
/// 而单调钟下的超时计算不受系统时间跳变影响。
/// `started_mono = 0`（未填/反序列化残值）一律判**不过期**：宁可漏判一场
/// （还有心跳看门狗兜底），也不能因为哪个构造点漏填字段就把活会话秒杀。
pub fn ttl_expired(started_mono: i64, now_mono: i64) -> bool {
    started_mono != 0 && now_mono - started_mono > SESSION_TTL_MS
}

mod lifecycle;

#[cfg(test)]
mod tests;
