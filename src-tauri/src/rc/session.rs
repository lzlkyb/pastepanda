//! 会话状态机与门禁（R0 核心）。
//!
//! # 红线
//!
//! 1. **无 Grant 会话即拒绝一切 Input 帧**——R0 只有信令，Input 在 R2，门禁先立。
//! 2. **被控端默认关**：`rc_enabled=false` 时入站 Request 直接 Deny。
//! 3. **设备级禁止**优先于能力档。
//! 4. **申请能力不得超过被控端能力上限**。

use super::protocol::{Capability, RcFrame, SessionPhase};
use super::service::RcService;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

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
    /// 已授权的能力（Active 后才有意义；Pending 时是申请值）。
    pub capability: Capability,
    pub phase: SessionPhase,
    pub started_ms: i64,
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

/// 生成会话 id。不用 uuid 依赖：时间 + 随机 4 字节够用（进程内唯一即可）。
pub fn new_session_id(now_ms: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("rc-{}-{:08x}", now_ms, nanos)
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

/// 会话生命周期（Tier B 第 5 组：从 `service.rs` 归位到状态机文件）。
///
/// 为什么放这里：上面是「状态**能不能**变」（转移表 + 门禁），这一块是「状态
/// **怎么变**」（建立后的收口/判定）。拆在两个文件里，改转移表的人看不到收口
/// 顺序，改收口的人看不到转移表——A2（重连自杀）那种 bug 正是出在这个缝里。
///
/// 这些方法要碰的 `RcService` 字段标了 `pub(super)`（见那边的可见性说明）；
/// 四个子结构体（clip / notify / stream / pressed 的内部字段）仍然私有。
impl RcService {
    pub async fn end_session(&self, reason: &str) -> Result<(), String> {
        // 🔴 take 语义（2026-09-20 审计 P2：end_session 可重入）：从槽里**取出**
        // 会话而不是只读——用户点结束与断流 `force_end_if_session` 并发触发时，
        // 旧实现两次都能读到同一份快照 → 双份历史 + 双份 End 帧。改成取走后，
        // 第二个调用方在这里就拿到 None（返回「没有进行中的会话」）。
        let (peer, peer_name, cap, phase, started) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(s) = inner.session.take() else {
                return Err("没有进行中的会话".into());
            };
            log::info!("[RC] 会话结束：{reason}");
            (
                s.peer.clone(),
                s.peer_name.clone(),
                s.capability,
                s.phase,
                s.started_ms,
            )
        };
        // 尽力通知对端：发起端走 outbound_send；被控端走 inbound_send
        {
            let mut guard = self.outbound_send.lock().await;
            if let Some(send) = guard.as_mut() {
                if let Ok(b) = (RcFrame::End {
                    reason: reason.to_string(),
                })
                .encode()
                {
                    let _ = crate::sync::transport::write_frame(send, &b).await;
                }
            }
            *guard = None;
        }
        // P0-3：连接句柄一并清——留着会把下一场会话的鼠标数据报发进旧连接
        *self.outbound_conn.lock().await = None;
        {
            let ib = self.inbound_send.lock().await.take();
            if let Some(send) = ib {
                let mut g = send.lock().await;
                if let Ok(b) = (RcFrame::End {
                    reason: reason.to_string(),
                })
                .encode()
                {
                    let _ = crate::sync::transport::write_frame(&mut g, &b).await;
                }
            }
        }
        // 补发卡住的 up：对端断线/会话结束时，被按住的 Ctrl/Shift/鼠标键不会自动弹起。
        // ⚠️ 必须在清 session 之前、且直接调注入函数（release_all），不要走 handle_inbound_input——
        // 会话结束态下它的 session_capability() 返回 None，能力校验会拦掉释放。
        // `end_session_releases_pressed_keys` 单测钉住「释放确实发生了」。
        {
            let mut g = self.pressed.lock().unwrap_or_else(|p| p.into_inner());
            g.release_all();
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.session = None; // take 已清，这里兜底（快照块只 take 了 session）
            inner.pending.clear();
            // 双连接守卫的标记随会话一起收（service.rs 审计 P2-1）
            inner.inbound_streaming = false;
        }
        // 链路句柄随会话一起收掉。交回的档位写进日志——真机排查时这是
        // 「这一次到底走的是局域网、公网直连还是绕中继」的唯一记录。
        // ❗ 必须在上面那个块**之外**调：`link` 与 `inner` 是两把锁，
        //    若在持 inner 时加 link，会与 `status()` 的加锁顺序相反（ABBA 死锁）。
        let end = self.link.detach();
        if end.path != crate::sync::path_kind::PathKind::None {
            log::info!(
                "[RC] 本次会话路径：{}（RTT 均 {}/峰值 {}ms）",
                end.path.label(),
                end.rtt_avg,
                end.rtt_max
            );
        }
        // 🔴 会话结束 → 标设备离线（2026-09-21 在线状态修复）。
        //
        // 这里的历史包袱值得记一笔，别再走回头路：
        // - 最初调 `rc_device_touch(&peer, false)` → 它**顺带把 last_seen 清 0**，
        //   于是「上次在线」永远显示不出来，且设备**永远离线**（跨网/组播被拦时
        //   再也好不了）——这是第一个极端。
        // - 为了修它改成 `touch(&peer, true)` → 于是只有写 online 没有写 offline，
        //   `conn_state` 只置位不复位，产生**假在线**——这是第二个极端。
        //
        // 两个极端同源：`rc_device_touch(x, false)` 把「标离线」和「清 last_seen」
        // 耦合成一个动作。现在拆开——用 `rc_device_mark_offline`（只动 conn_state）。
        // 「上次在线：3 小时前」由 `last_seen` 保留，离线判定不再被它误导。
        let _ = self.store.rc_device_mark_offline(&peer);
        // B-5：把这次**实测**的路径落到设备行，下次打开面板就能看到
        // 「上次走的是局域网直连」——而不是靠「有没有听到组播」去猜。
        // 空串（一条路都没通）会被 `rc_device_note_path` 忽略，不会抹掉上一次的实测值。
        let _ = self.store.rc_device_note_path(&peer, end.path.as_str());
        // C-4：历史里带上路径与网速摘要（旧记录没有这几个字段，前端按「没有」处理）。
        super::history::append_history(
            &self.store,
            super::history::HistoryFacts {
                peer: &peer,
                peer_name: &peer_name,
                cap,
                phase,
                started_ms: started,
                reason,
                end,
            },
        );
        self.clear_frame();
        // 出站帧队列一并清：旧会话攒下的 H.264 P 帧 / 脏块对新会话是毒数据
        self.clear_outbox();
        self.note_rtt(0);
        // 自动档与会话同生命周期（2A）：不复位的话 `status()` 会继续报上一场
        // 停留的「生效档」，而画面早就不推了——陈旧数据比没有数据更坏。
        // ❗ 必须在这里（inner 锁已放出、link 已 detach 之后）调用，别挪进锁块。
        self.reset_stream_after_session();
        // C8(b)：作废仍在等待的剪贴板 pull，并清掉可能由迟到回包写入的文本，
        // 避免下一个会话把它当成自己的结果返回。
        self.invalidate_clipboard();
        // 🔴 音频状态随会话收口（2026-09-20 审计 P1-1）：audio_reset 本就按
        // 「会话收口」语义设计（清对端申请位 / 对端开关镜像 / 收流缓冲，
        // 刻意不动 audio_local_mute），但此前只有发起端 request 成功与
        // inbound video 失败兜底两处调用——被控端的 `audio_muted` /
        // `spk_muted_by_peer` 会跨会话残留：上一场对端关过声音，下一场
        // 换个对端申请音频也听不到，无报错无横幅。接线补在这里，与
        // `reset_stream_after_session` 同层（inner 锁已放出）。
        self.audio_reset();
        // Q6：收口顺手清自动重连状态。异常断流路径的顺序是 force_end（清）→
        // begin（重建），这里清掉不碍触发；它兜的是「用户主动结束」要清掉
        // 残留的「重连中/重连失败」横幅——用户已经自己做了决定。
        *self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // 收口时清空注入错误（已被前端看到或已无意义）
        self.notify.take_inject_err();
        *self
            .last_outbound_error
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        self.emit_changed();
        Ok(())
    }

    /// 当前会话 id 是否等于给定值（收口按 session id 判定，避免重连时被旧任务按 peer 误杀）。
    pub fn session_id_is(&self, id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.id == id)
    }

    /// 流断开 / 对端消失时本地收口：只清**该 session id** 的会话，避免误杀同 peer 的新会话。
    pub async fn force_end_if_session(&self, session_id: &str, reason: &str) {
        let should = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            matches!(inner.session.as_ref(), Some(s) if s.id == session_id)
        };
        if !should {
            return;
        }
        log::info!("[RC] 强制结束会话（{session_id}）：{reason}");
        let _ = self.end_session(reason).await;
    }

    /// 该 peer 是否有一场**活跃**（Pending/Outbound/Inbound Active 任一）会话。
    /// 自动重连任务睡醒后用它判断「是不是已经不用我重连了」。
    fn has_session_with(&self, peer: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(inner.session.as_ref(), Some(s) if s.peer == peer && is_active(s.phase))
    }

    /// Q6：用户手动发起时清自动重连 episode（含 gave_up 残留横幅）。
    /// `pub`：commands::rc_request_session（rc 模块外）在用户动作入口调用。
    pub fn clear_auto_reconnect(&self) {
        *self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 🔴 D12（2026-09-22 审计）：等这一轮重连**落地**，返回是否成功。
    ///
    /// # 为什么必须等
    ///
    /// [`RcService::request_session`] 是非阻塞的：它把会话落到 `OutboundPending`
    /// 就返回 `Ok`，拨号在后台任务里跑。旧实现的重试循环见 `Ok` 就 `return`，
    /// 于是——**第一次尝试永远「成功」**，循环体的第二次、第三次尝试与末尾的
    /// `gave_up` 全是死代码。真实症状是：免确认设备断线后横幅显示「重连中 1/3」，
    /// 拨号在 200ms 后失败（对端还没回来），横幅当场消失，用户以为自动重连
    /// 成功了；`gave_up`（「自动重连失败」）永远不会出现。
    ///
    /// # 判据只看会话槽位，不看 `last_outbound_error`
    ///
    /// 错误槽是全局单值、多个发起路径共用，按它归因会互相踩（用户手动发起的
    /// 失败会被误算成重连失败）。会话槽位带 id，归因是准的：
    /// - 槽里还是本 id 且 phase 已 `Active` → **成功**；
    /// - 槽里已不是本 id（被拨号失败分支清掉 / 被换成别的会话）→ 本轮结束，`false`；
    /// - 到窗口上限仍是 `OutboundPending`（拨号还在跑）→ 也回 `false`：
    ///   下一轮循环顶部的 `has_session_with` 会兜住「迟到的成功」，
    ///   而它若真的失败，那时槽已清、重试照常发生。**不存在两边都漏的组合。**
    ///
    /// 窗口参数开放给单测（生产调用走 [`RECONNECT_SETTLE_POLLS`]）。
    pub(super) async fn reconnect_round_settled_with(
        &self,
        session_id: &str,
        polls: u32,
        poll_ms: u64,
    ) -> bool {
        for _ in 0..polls {
            tokio::time::sleep(std::time::Duration::from_millis(poll_ms)).await;
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            match inner.session.as_ref() {
                // 还是本场会话：只有进 Active 才算落地
                Some(s) if s.id == session_id => {
                    if is_active(s.phase) {
                        return true;
                    }
                }
                // 槽位易主或已空：本轮已经没有可等的东西了
                _ => return false,
            }
        }
        false
    }

    /// 生产口径的一轮落地等待（见 [`Self::reconnect_round_settled_with`]）。
    async fn reconnect_round_settled(&self, session_id: &str) -> bool {
        self.reconnect_round_settled_with(
            session_id,
            RECONNECT_SETTLE_POLLS,
            RECONNECT_SETTLE_POLL_MS,
        )
        .await
    }

    /// 收口前取一场会话的（能力、设备名），供自动重连发起点用。
    /// 只认 session id（与 `session_id_is` 同一纪律：不按 peer 认领）。
    pub(super) fn session_brief_if(
        &self,
        session_id: &str,
    ) -> Option<(Capability, String)> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.session.as_ref().filter(|s| s.id == session_id).map(|s| {
            (s.capability, s.peer_name.clone())
        })
    }

    /// Q6：免确认设备异常断流后自动重连（发起端）。
    ///
    /// 只在**异常断流**路径调用（画面流 Err）——用户主动结束 / 对端主动结束 /
    /// TTL 到期都不会走到这，那三种情况默默再敲门是骚扰。逐次确认（非免确认）
    /// 的设备也不进：每次申请都要对方点头，自动连发等于骚扰对方。
    ///
    /// episode 自带重试循环（2s/4s/6s），期间用户任何手动动作（发起/结束）都会
    /// 清状态、任务睡醒后看到状态没了就退出——不需要 AbortHandle。
    pub fn begin_auto_reconnect(self: &Arc<Self>, peer: &str, peer_name: String, cap: Capability) {
        if !self.device_trusted(peer) {
            log::debug!("[RC] 对端未开免确认，断线后不自动重连");
            return;
        }
        let epoch = self
            .reconnect_epoch
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut st = self.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = st.as_ref() {
                if s.peer == peer && !s.gave_up {
                    // episode 已在跑（任务自己在循环重试），不叠加第二个
                    return;
                }
            }
            *st = Some(super::service::AutoReconnect {
                peer: peer.to_string(),
                peer_name,
                capability: cap,
                attempt: 0,
                max: RECONNECT_MAX_ATTEMPTS,
                gave_up: false,
                epoch,
            });
        }
        self.emit_changed();
        let svc = Arc::clone(self);
        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            for attempt in 1..=RECONNECT_MAX_ATTEMPTS {
                let delay = RECONNECT_BASE_DELAY_MS * attempt as u64;
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                // 睡醒先核对 episode 还归不归我管：状态被清、被换成新 episode
                //（代次不同）都算易主。只认 peer 不认代次的话，旧任务会在
                // 「手动重连成功又断流」后收养新 episode，双任务并行重试。
                let still_mine = {
                    let st = svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
                    matches!(st.as_ref(), Some(s) if s.peer == peer && s.epoch == epoch && !s.gave_up)
                };
                if !still_mine {
                    return;
                }
                if svc.has_session_with(&peer) {
                    // 用户已手动重连上 → episode 完成
                    *svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    svc.emit_changed();
                    return;
                }
                // 进度给 UI：attempt 写回状态再 emit，横幅显示「第 N/M 次」
                {
                    let mut st = svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(s) = st.as_mut() {
                        s.attempt = attempt;
                    }
                }
                svc.emit_changed();
                log::info!("[RC] 自动重连第 {attempt}/{RECONNECT_MAX_ATTEMPTS} 次：{peer}");
                // 自动重连只发生在「已经建立过会话」的设备上（免确认白名单成员），
                // 永远不走无人值守凭证那两条路——码是一次性的不该烧，密码是
                // 本机长期秘密、发起侧根本没有它（重连靠的是白名单信任）。
                match svc.request_session(&peer, cap, None, None).await {
                    // 🔴 D12：`Ok` 只代表**申请已受理**，拨号还在后台跑。必须等它
                    // 落地再决定——旧实现见 Ok 就 return，于是第一圈无论成败都
                    // 「成功」，第二次/第三次尝试与末尾的 gave_up 全是死代码。
                    Ok(sess) => {
                        if svc.reconnect_round_settled(&sess.id).await {
                            // 真的连上了。episode 到此交棒：之后若画面再断，
                            // 断流路径会重新 begin（attempt 重新计数——每次
                            // 「成功重连后再断」是新一轮故障，理应给满重试）。
                            log::info!("[RC] 自动重连成功（第 {attempt} 轮）：{peer}");
                            *svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner()) = None;
                            svc.emit_changed();
                            return;
                        }
                        log::warn!(
                            "[RC] 自动重连第 {attempt}/{RECONNECT_MAX_ATTEMPTS} 轮未落地（会话未激活）"
                        );
                    }
                    Err(e) => log::warn!("[RC] 自动重连第 {attempt} 次失败：{e}"),
                }
            }
            // 次数用尽：保留 gave_up 状态给 UI「自动重连失败」，用户手动动作时清
            {
                let mut st = svc.auto_reconnect.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(s) = st.as_mut() {
                    if s.peer == peer {
                        s.gave_up = true;
                    }
                }
            }
            svc.emit_changed();
        });
    }

    /// 会话是否超过 TTL（推流循环每圈检查）。
    pub fn session_expired(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => {
                super::service::now_ms() - s.started_ms > SESSION_TTL_MS
            }
            _ => false,
        }
    }

    pub fn require_active(&self) -> Result<Session, String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match inner.session.as_ref() {
            Some(s) if is_active(s.phase) => Ok(s.clone()),
            Some(_) => Err("会话尚未建立".into()),
            None => Err("没有进行中的远程会话".into()),
        }
    }

    pub fn must_show_banner(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        matches!(
            inner.session.as_ref(),
            Some(s) if s.phase == SessionPhase::InboundActive
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deny_map(ids: &[&str]) -> HashMap<String, bool> {
        ids.iter().map(|s| (s.to_string(), true)).collect()
    }

    #[test]
    fn inbound_disabled_by_default() {
        let g = gate_inbound(
            false,
            Capability::Control,
            &HashMap::new(),
            "peer",
            true,
            Capability::View,
            false,
        );
        assert_eq!(g, Gate::Disabled);
    }

    #[test]
    fn inbound_requires_pairing() {
        let g = gate_inbound(
            true,
            Capability::View,
            &HashMap::new(),
            "peer",
            false,
            Capability::View,
            false,
        );
        assert_eq!(g, Gate::NotPaired);
    }

    #[test]
    fn inbound_device_deny() {
        let g = gate_inbound(
            true,
            Capability::Control,
            &deny_map(&["peer"]),
            "peer",
            true,
            Capability::View,
            false,
        );
        assert_eq!(g, Gate::DeviceDenied);
    }

    #[test]
    fn inbound_capability_cap() {
        let g = gate_inbound(
            true,
            Capability::View,
            &HashMap::new(),
            "peer",
            true,
            Capability::Control,
            false,
        );
        assert_eq!(g, Gate::CapabilityTooHigh);
    }

    #[test]
    fn inbound_busy() {
        let g = gate_inbound(
            true,
            Capability::Control,
            &HashMap::new(),
            "peer",
            true,
            Capability::View,
            true,
        );
        assert_eq!(g, Gate::Busy);
    }

    #[test]
    fn inbound_allow() {
        let g = gate_inbound(
            true,
            Capability::Control,
            &HashMap::new(),
            "peer",
            true,
            Capability::View,
            false,
        );
        assert_eq!(g, Gate::Allow);
    }

    #[test]
    fn transitions() {
        use SessionPhase::*;
        assert!(can_transition(Idle, OutboundPending));
        assert!(can_transition(OutboundPending, OutboundActive));
        assert!(can_transition(OutboundActive, Idle));
        // 非法
        assert!(!can_transition(Idle, OutboundActive));
        assert!(!can_transition(OutboundPending, InboundActive));
        assert!(!can_transition(OutboundActive, OutboundPending));
    }

    #[test]
    fn banner_required_when_inbound_active() {
        assert!(must_show_control_banner(SessionPhase::InboundActive));
        assert!(!must_show_control_banner(SessionPhase::OutboundActive));
    }

    #[test]
    fn can_transition_busy_rules() {
        use SessionPhase::*;
        // approve_inbound 从无会话直达 InboundActive 是本就存在的迁移
        assert!(can_transition(Idle, InboundActive));
        // 进行中的发起会话不能被新入站申请顶掉（[busy_local] 闸）
        assert!(!can_transition(OutboundActive, InboundActive));
        // 已经在进行中的被控会话不能被再次 approve 顶掉
        assert!(!can_transition(InboundActive, InboundActive));
    }
}
