//! 输入权交接（乙-③，2026-09-30）——被控端这一侧的**两把独立的闸**。
//!
//! # 为什么是两把闸而不是一把
//!
//! 设计稿里那两个按钮动的是**不同的人的手**，混成一把就会做错：
//!
//! | 闸 | 谁按的 | 挡住谁 | 落点 |
//! |----|--------|--------|------|
//! | `hold`（暂时收回我的键鼠） | **被控者** | 对端**注入**的键鼠 | [`RcService::input_injection_allowed`]，注入前丢弃 |
//! | `lock`（锁定对方键鼠） | **发起端**（须被控者授权） | 被控者本人的**物理**键鼠 | [`crate::rc::local_input::set_swallow`]，低层钩子吞 |
//!
//! `lock` 绝不能顺手把注入那一路也关掉：那正是远程操作本身，关掉等于把发起端
//! 也锁在外面。反过来 `hold` 不吞本机物理输入——被控者正在用这机器，吞他就是
//! 把他锁在自己的键盘外面，那把钥匙还得靠他自己点「恢复」。
//!
//! # 授权为什么是「本次」
//!
//! `lock_granted` 挂在会话上（会话收口即复位，见 [`RcService::input_reset`]），
//! 不写进配置。理由与 `audio_local_mute` 相反：那个是**被控者的隐私意愿**，
//! 跨会话保持；这个是**交给对方的一份临时权力**，「下次还有效」正是无人值守的
//! 形状。待拍板 ② 取「本次」。
//!
//! # 状态怎么到对端眼前
//!
//! 三条都是**被控端的事实**，发起端只能靠被控端推帧：
//! `{"t":"input_state", host_hold, lock_granted, lock_active, err?}` —— 与
//! `host_audio` 同一条控制流、同一套「只投影对方报来的事实」的纪律
//!（见 [`RcService::emit_input_state`]）。

use super::{PeerInputState, RcInputPills, RcService};
use crate::rc::local_input;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// 「谁在动」的活跃窗口：这段时间内有过一次输入就算「在用」。
///
/// 🔴 取 3s 是为了**盖过状态轮询周期**：pill 走 `rc_status` 投影，而会话活跃时
/// 前端每 2s 拉一次（`rcStoreEngine` 的 `ACTIVE_MS`）。窗口比 2s 短的话，绝大多数
/// 轮询落到两次活动之间的空隙里，指示器就会「闪一下就没」，读起来像功能坏了。
/// 3s = 一个完整周期 + 余量，任意一拍动作至少被一次投影看见；代价是「在用」会比
/// 真实动作晚约 1~3s 才熄灭，对一个方位指示器是可接受的。
pub const ACTIVITY_WINDOW_MS: u64 = 3_000;

/// 收回后自动归还的**检查**周期（真正的时限是 `HOLD_AUTO_RETURN_MS`）。
/// 30s 是精度取舍：用户读的是「十分钟」，早半分钟晚半分钟都不构成误导。
const HOLD_CHECK_EVERY_MS: u64 = 30_000;

/// 一枚 pill 的结论（优先级见 [`input_actor`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputActor {
    /// 窗口内谁都没动（前端不点亮）
    Idle,
    /// 被控者本人在用（灰）
    Local,
    /// 对方的输入真的落进了本机（绿）
    Peer,
    /// 对方在无权的窗口里按了，已被拦（红）
    PeerBlocked,
}

/// 「谁在动」的唯一判据（纯函数，可离线单测）。
///
/// 🔴 优先级是 `blocked > peer > local`，不是「谁的时间戳新听谁的」：
/// 收回期间对方还在点鼠标、本机也在动，此时用户该看到的是「有人被拦了」——
/// 那条红的才是这台机器正在发生的事。
///
/// `at == 0` 是「从未发生过」（钩子没装上 / 刚收口），不能当成「很久以前」而
/// 被 `now - 0 <= window` 误判成新鲜。
pub fn input_actor(
    now_ms: u64,
    peer_at: u64,
    local_at: u64,
    blocked_at: u64,
    window: u64,
) -> InputActor {
    let fresh = |at: u64| at != 0 && now_ms.saturating_sub(at) <= window;
    if fresh(blocked_at) {
        InputActor::PeerBlocked
    } else if fresh(peer_at) {
        InputActor::Peer
    } else if fresh(local_at) {
        InputActor::Local
    } else {
        InputActor::Idle
    }
}

impl InputActor {
    /// 投影给前端的稳定字符串（与 `rcTypes.ts` 的 union 同集合）。
    pub fn wire(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Local => "local",
            Self::Peer => "peer",
            Self::PeerBlocked => "blocked",
        }
    }
}

/// 会话期内的输入权状态。字段全是原子量：注入路径（tokio 任务）、钩子线程与
/// 命令层都会读，为它单独加一把锁会把「读一下能不能注入」放进热路径。
#[derive(Default)]
pub struct InputGate {
    /// 被控者收回了键鼠（对端注入丢弃）
    hold: AtomicBool,
    /// 收回发生的时刻（mono ms）——十分钟自动归还的锚点
    hold_since_ms: AtomicU64,
    /// 归还检查任务在跑（幂等闸，防止反复点收回开出第二个循环）
    hold_ticker: AtomicBool,
    /// 被控者允许对方锁定本机输入（**本次会话**）
    lock_granted: AtomicBool,
    /// 对方要求锁定（授权到位才真的生效）
    lock_requested: AtomicBool,
    /// 对端键盘/鼠标最近一次**到达**的时刻（不论有没有被拦）
    peer_kbd_at: AtomicU64,
    peer_mouse_at: AtomicU64,
    /// 对端最近一次「无权却被拦」的时刻
    peer_kbd_blocked_at: AtomicU64,
    peer_mouse_blocked_at: AtomicU64,
}

impl InputGate {
    fn mono_now() -> u64 {
        crate::rc::mono::mono_ms().max(0) as u64
    }

    /// 本机最近一次物理活动（键盘与鼠标取新者；钩子没跑 = 0）。
    fn local_activity_at(&self) -> u64 {
        local_input::last_kbd_ms().max(local_input::last_mouse_ms())
    }
}

impl RcService {
    // ── 闸 A：被控者收回键鼠 ──────────────────────────────────────────────

    pub(in crate::rc) fn input_hold(&self) -> bool {
        self.input_gate.hold.load(Ordering::SeqCst)
    }

    /// 注入路径的唯一问题：这一拍对端的键鼠该不该打进本机。
    ///
    /// 🔴 只有 `hold` 参与判据。**锁定不是它的理由**——锁的是本机的物理输入，
    /// 远程那一路必须照常通，否则「锁定对方键鼠」会把发起端自己也锁在外面。
    pub fn input_injection_allowed(&self) -> bool {
        !self.input_hold()
    }

    /// 收回 / 归还。**收回时先把对端正按住的键弹起**——否则那颗键会一直卡在按下态：
    /// 注入被闸掉之后 up 也进不来，本机等于凭空按住一个 Ctrl。
    ///
    /// 返回改后的状态（前端据此切按钮，不做乐观置位）。
    pub async fn set_input_hold(self: &std::sync::Arc<Self>, on: bool) -> bool {
        let prev = self.input_gate.hold.swap(on, Ordering::SeqCst);
        if on {
            self.input_gate
                .hold_since_ms
                .store(InputGate::mono_now(), Ordering::SeqCst);
            if !prev {
                let mode = self.key_mode();
                let failures = {
                    let mut g = self.pressed.lock().unwrap_or_else(|p| p.into_inner());
                    g.release_all(mode)
                };
                if !failures.is_empty() {
                    log::warn!(
                        "[RC] 收回键鼠时释放对端按住的键失败：{}",
                        failures
                            .iter()
                            .map(|f| f.what.clone())
                            .collect::<Vec<_>>()
                            .join("、")
                    );
                }
            }
            self.spawn_hold_ticker();
        } else {
            // 主动归还：锚点清掉，让下一次收回重新计时（ticker 靠闸位自己退出）
            self.input_gate.hold_since_ms.store(0, Ordering::SeqCst);
        }
        log::info!(
            "[RC] 本机键鼠{}",
            if on {
                "已收回（对端输入将被拦下）"
            } else {
                "已归还"
            }
        );
        self.emit_input_state(None).await;
        self.notify.emit_changed();
        on
    }

    /// 十分钟无本机操作自动归还的检查循环。只在收回期间存在（闸位一关就退出），
    /// 且同一时刻至多一个（`hold_ticker` 抢位）。
    ///
    /// 收 `self: &Arc<Self>`：任务要**持有**服务活过本次调用，`&self` 借不到这条命。
    fn spawn_hold_ticker(self: &std::sync::Arc<Self>) {
        if self
            .input_gate
            .hold_ticker
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let svc = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(HOLD_CHECK_EVERY_MS)).await;
                if !svc.input_hold() {
                    break;
                }
                let since = svc.input_gate.hold_since_ms.load(Ordering::SeqCst);
                let local = svc.input_gate.local_activity_at();
                // 本机活动读物理输入钩子的戳；钩子没装上（恒 0）时判据退回以收回
                // 时刻起算——宁可早一点归还，也不能因为读不到活动就一直霸着。
                if local_input::hold_should_return(
                    since,
                    local,
                    InputGate::mono_now(),
                    local_input::HOLD_AUTO_RETURN_MS,
                ) {
                    log::info!("[RC] 收回满十分钟无本机操作，自动把键鼠归还对端");
                    svc.set_input_hold(false).await;
                    break;
                }
            }
            svc.input_gate.hold_ticker.store(false, Ordering::SeqCst);
        });
    }

    // ── 闸 B：对方锁定本机物理键鼠 ────────────────────────────────────────

    /// 被控者是否允许对方锁定本机输入（本次会话）。
    pub fn input_lock_granted(&self) -> bool {
        self.input_gate.lock_granted.load(Ordering::SeqCst)
    }

    /// 本机输入现在真的被锁住吗（读钩子的实际闸位，不读「对方要求过」）。
    pub fn input_lock_active(&self) -> bool {
        local_input::is_locked()
    }

    /// 被控者勾选 / 取消「允许对方锁定我的输入」。
    ///
    /// 取消授权要**立刻把已经生效的锁解开**：授权是锁的唯一来源，撤了授权还锁着，
    /// 就是「点了取消却还被锁」的假反馈。
    pub async fn set_input_lock_grant(&self, on: bool) {
        self.input_gate.lock_granted.store(on, Ordering::SeqCst);
        if !on {
            local_input::set_swallow(false);
        }
        log::info!(
            "[RC] {}对方锁定本机输入",
            if on { "允许" } else { "不再允许" }
        );
        self.emit_input_state(None).await;
        self.notify.emit_changed();
    }

    /// 对端要求锁定 / 解锁。**授权不在就拒绝**，并回一条带原因的帧——
    /// 发起端的按钮需要知道「点了但没锁」，静默失败是这条功能最坏的形态。
    ///
    /// 返回（是否落地，给发起端的失败原因）。
    pub async fn peer_request_input_lock(&self, on: bool) -> (bool, Option<String>) {
        if on && !self.input_lock_granted() {
            log::info!("[RC] 对端要求锁定本机输入，但被控者未授权，已拒绝");
            let err = "对方未开启「允许对方锁定我的输入」".to_string();
            self.emit_input_state(Some(&err)).await;
            self.notify.emit_changed();
            return (false, Some(err));
        }
        // 钩子没装上的话 set_swallow 改的是空气：如实回报，不报「已锁定」
        let actual = if on && !local_input::is_watching() {
            false
        } else {
            local_input::set_swallow(on)
        };
        self.input_gate.lock_requested.store(on, Ordering::SeqCst);
        let err = if on && !actual {
            #[cfg(target_os="macos")]
            let message="本机输入拦截未运行，请检查辅助功能权限后重新连接";
            #[cfg(not(target_os="macos"))]
            let message="本机输入监视未运行，无法锁定";
            Some(message.to_string())
        } else {
            None
        };
        log::info!(
            "[RC] 对端{}本机物理输入（实际={actual}）",
            if on { "要求锁定" } else { "解除锁定" }
        );
        self.emit_input_state(err.as_deref()).await;
        self.notify.emit_changed();
        (actual, err)
    }

    // ── 「谁在动」活动戳 ───────────────────────────────────────────────────

    /// 对端一条键盘事件到达。`injected=false` = 被收回闸拦下（红 pill 的依据）。
    ///
    /// 🔴 成功注入那一次要把「被拦」戳**清零**：pill 答的是「最近一次尝试的结局」，
    /// 留着旧的拦痕会让归还键鼠之后的正常操作一直显示成红的。
    pub(in crate::rc) fn note_peer_kbd(&self, injected: bool) {
        let g = &self.input_gate;
        let now = InputGate::mono_now();
        g.peer_kbd_at.store(now, Ordering::Relaxed);
        g.peer_kbd_blocked_at.store(if injected { 0 } else { now }, Ordering::Relaxed);
    }

    /// 对端一条鼠标事件到达（移动也算——「谁在动鼠标」问的就是它）。
    pub(in crate::rc) fn note_peer_mouse(&self, injected: bool) {
        let g = &self.input_gate;
        let now = InputGate::mono_now();
        g.peer_mouse_at.store(now, Ordering::Relaxed);
        g.peer_mouse_blocked_at.store(if injected { 0 } else { now }, Ordering::Relaxed);
    }

    /// 两枚 pill 的当前结论（status 投影用）。
    pub fn input_pills(&self) -> RcInputPills {
        let g = &self.input_gate;
        let now = InputGate::mono_now();
        RcInputPills {
            keyboard: input_actor(
                now,
                g.peer_kbd_at.load(Ordering::Relaxed),
                local_input::last_kbd_ms(),
                g.peer_kbd_blocked_at.load(Ordering::Relaxed),
                ACTIVITY_WINDOW_MS,
            )
            .wire(),
            mouse: input_actor(
                now,
                g.peer_mouse_at.load(Ordering::Relaxed),
                local_input::last_mouse_ms(),
                g.peer_mouse_blocked_at.load(Ordering::Relaxed),
                ACTIVITY_WINDOW_MS,
            )
            .wire(),
        }
    }

    // ── 跨端推送 / 会话收口 ────────────────────────────────────────────────

    /// 被控端：把本机输入权状态推给对端（与 `emit_host_audio` 同一条控制流）。
    ///
    /// `err` 只在动作失败时带——发起端据此把按钮退回原样，而不是点了没反应。
    /// 没有控制流（未 Accept / 已断开）时静默返回：它不是关键路径。
    pub async fn emit_input_state(&self, err: Option<&str>) {
        let mut msg = serde_json::json!({
            "t": "input_state",
            "host_hold": self.input_hold(),
            "lock_granted": self.input_lock_granted(),
            "lock_active": local_input::is_locked(),
        });
        if let Some(e) = err {
            msg["err"] = serde_json::Value::String(e.to_string());
        }
        let Ok(b) = serde_json::to_vec(&msg) else {
            return;
        };
        let guard = self.inbound_send.lock().await;
        if let Some(send) = guard.as_ref() {
            let mut g = send.lock().await;
            let _ = crate::sync::transport::write_frame(&mut g, &b).await;
        }
    }

    /// 发起端：记下对端报来的输入权状态（`outbound.rs` 解出 `input_state` 后调用）。
    pub(in crate::rc) fn set_peer_input_state(&self, st: PeerInputState) {
        *self.peer_input_state.lock().unwrap_or_else(|p| p.into_inner()) = Some(st);
    }

    /// 发起端：对端报来的输入权状态（快照用）。None = 旧对端不发这条帧。
    pub(in crate::rc) fn peer_input_state(&self) -> Option<PeerInputState> {
        self.peer_input_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 会话**开始**：把两把闸与活动戳清回安全侧（只碰原子量，不拿任何锁）。
    ///
    /// 🔴 这条必须在建立入站会话时调，不能只靠收口：`end_session` 的全局复位以
    /// 「没换场」为前提（A4），换场路径会跳过它——于是上一场勾的「允许对方锁定
    /// 我的输入」就漏进了下一场，正好把「本次授权」变成我们承诺不做的那种
    /// 长期权力。开始处清一遍，这个语义才不依赖上一场是怎么结束的。
    pub(in crate::rc) fn input_gate_begin(&self) {
        let g = &self.input_gate;
        g.hold.store(false, Ordering::SeqCst);
        g.hold_since_ms.store(0, Ordering::SeqCst);
        g.lock_granted.store(false, Ordering::SeqCst);
        g.lock_requested.store(false, Ordering::SeqCst);
        g.peer_kbd_at.store(0, Ordering::Relaxed);
        g.peer_mouse_at.store(0, Ordering::Relaxed);
        g.peer_kbd_blocked_at.store(0, Ordering::Relaxed);
        g.peer_mouse_blocked_at.store(0, Ordering::Relaxed);
        // 解锁是无条件的：钩子留着 SWALLOW，下一场会话没人授权也在吞本机输入。
        local_input::set_swallow(false);
    }

    /// 会话收口：输入权状态全部作废（发起端那份对端状态也一起清）。
    ///
    /// 🔴 必须在 `release_all` **之后**调（与 `reset_key_mode` 同期）：收回期间补发
    /// 的 up 会被注入闸拦掉，键就真卡住了。所以收回那一刻已经先把按住键弹起
    ///（见 [`RcService::set_input_hold`]），这里只做清位。
    pub(in crate::rc) fn input_reset(&self) {
        self.input_gate_begin();
        *self.peer_input_state.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 谁在动_优先级是无权被拦_对方在用_本机在用() {
        let now = 100_000u64;
        let w = ACTIVITY_WINDOW_MS;
        assert_eq!(input_actor(now, 0, 0, 0, w), InputActor::Idle);
        // 窗口内只有本机动过
        assert_eq!(input_actor(now, 0, now - 10, 0, w), InputActor::Local);
        // 只有对方动过
        assert_eq!(input_actor(now, now - 10, 0, 0, w), InputActor::Peer);
        // 两个都动过 → 绿的赢（对方真的在用）
        assert_eq!(input_actor(now, now - 10, now - 5, 0, w), InputActor::Peer);
        // 被拦的那拍必须压过一切：它才是「这台机器正在发生的事」
        assert_eq!(
            input_actor(now, now - 10, now - 5, now - 5, w),
            InputActor::PeerBlocked
        );
        // 过了窗口就不算在用（陈旧的活动戳不能一直点着绿灯）
        assert_eq!(input_actor(now, now - w - 1, 0, 0, w), InputActor::Idle);
        // 0 = 从未发生过，不能被当成「就在刚才」
        assert_eq!(input_actor(0, 0, 0, 0, w), InputActor::Idle);
    }

    /// 两把闸各管各的：这条判据写反的两种坏法都很糟——
    /// 「锁定也拦注入」= 发起端把自己锁在外面；「收回也吞物理」= 被控者动不了自己的机器。
    #[test]
    fn 收回拦注入_锁定不拦注入() {
        let svc = RcService::new(crate::rc::tests::store());
        assert!(svc.input_injection_allowed(), "默认不收回，注入照常");
        svc.input_gate.hold.store(true, Ordering::SeqCst);
        assert!(!svc.input_injection_allowed(), "收回期间对端的键鼠必须进不来");
        svc.input_gate.lock_requested.store(true, Ordering::SeqCst);
        assert!(!svc.input_injection_allowed(), "只是收回，仍拦");
        svc.input_gate.hold.store(false, Ordering::SeqCst);
        assert!(
            svc.input_injection_allowed(),
            "只锁定不收回时注入必须照常——否则发起端把自己锁外面了"
        );
    }

    /// 乙-③ 的核心安全语义：授权不在，锁就不成立（默认必须是「不允许」）。
    #[test]
    fn 默认不允许对方锁定本机输入() {
        let svc = RcService::new(crate::rc::tests::store());
        assert!(
            !svc.input_lock_granted(),
            "默认开 = 任何人连进来就能锁住这台机器的键盘"
        );
        assert!(!svc.input_lock_active(), "没人授权时钩子闸必须是关的");
    }

    #[test]
    fn 会话收口把输入权清干净() {
        let svc = RcService::new(crate::rc::tests::store());
        svc.input_gate.hold.store(true, Ordering::SeqCst);
        svc.input_gate.lock_granted.store(true, Ordering::SeqCst);
        svc.input_gate.peer_kbd_at.store(123, Ordering::Relaxed);
        svc.input_reset();
        assert!(
            !svc.input_hold(),
            "收回不能跨会话残留：下一场会话没人点过按钮却是拦的"
        );
        assert!(!svc.input_lock_granted(), "授权是本次的，会话结束就作废");
        assert_eq!(svc.input_pills().keyboard, InputActor::Idle.wire());
        assert_eq!(svc.peer_input_state(), None);
    }

    /// pill 答的是「最近一次尝试的结局」：被拦记红，成功注入必须把红痕抹掉，
    /// 否则归还键鼠之后的正常操作会一直显示成「对方无权却被按下」。
    #[test]
    fn 被拦记红_成功注入清红() {
        let svc = RcService::new(crate::rc::tests::store());
        svc.note_peer_kbd(false);
        assert_eq!(svc.input_pills().keyboard, InputActor::PeerBlocked.wire());
        svc.note_peer_kbd(true);
        assert_eq!(svc.input_pills().keyboard, InputActor::Peer.wire());
        // 鼠标同一条判据（它才是「谁在动鼠标」的主角）
        svc.note_peer_mouse(false);
        assert_eq!(svc.input_pills().mouse, InputActor::PeerBlocked.wire());
        svc.note_peer_mouse(true);
        assert_eq!(svc.input_pills().mouse, InputActor::Peer.wire());
        // 两枚互不牵连：只动键盘不会把鼠标那枚点亮
        let svc2 = RcService::new(crate::rc::tests::store());
        svc2.note_peer_kbd(true);
        assert_eq!(svc2.input_pills().mouse, InputActor::Idle.wire());
    }
}
