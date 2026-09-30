//! 画面暂停（丙-③，2026-09-30）——被控端一键「暂停对方观看」。
//!
//! # 为什么是「停止出帧」而不是「盖一块黑窗」
//!
//! 原稿那句「对方仍在看，但看到的是黑」在两种机制下含义正好相反（详见
//! `docs/远程电脑-交互审计与方案-2026-09-29.md` §12.6）：黑色置顶窗不调
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 会被 DXGI 桌面复制一并抓走
//!（对方也看黑），调了它就只有房间里的人看黑——而且黑窗会盖住丙-② 那颗「结束」
//! 角标，等于把用户锁在自己的屏幕外面。本条走**停止出帧**：不新增窗口、不碰
//! 屏幕合成，会话照连、键鼠照用、剪贴板照走，只是画面停在对方按下暂停前那一帧。
//!
//! # 暂停拦的是「画面」，不是「会话」
//!
//! 判据只被推流主循环问一次（[`crate::rc::inbound::video_run`] 圈首），输入读取、
//! 心跳、剪贴板、文件通道一律不受影响。所以对方此刻仍能操作这台机器——**这是
//! 有意的**：这条按钮答的是「别看我屏幕」，不是「别动我电脑」（那是乙-③ 的收回
//! 键鼠）。措辞与提示都必须守住这条边界，不许写成「已断开画面/已断开连接」。
//!
//! # 为什么只在本场会话有效
//!
//! 与 `audio_local_mute` 相反：那个是被控者的**长期隐私意愿**（跨会话保持），
//! 这条是「此刻这一场别看」。留着它跨会话，下一场对方连进来看到一张冻住的旧画面，
//! 只会以为是链路坏了。所以会话开始清位、会话收口也清位。
//!
//! # 状态怎么到对端眼前
//!
//! `{"t":"vpause","on":bool}` —— 与 `input_state` / `host_audio` 同一条控制流
//!（[`RcService::emit_video_pause`]），发起端只投影对方报来的事实。旧对端不发这条
//! 帧 ⇒ 发起端的 `peer_video_paused` 恒 false ⇒ 不摆「对方已暂停画面」。

use super::RcService;
use std::sync::atomic::{AtomicBool, Ordering};

/// 暂停期间推流循环的轮询周期。取 300ms 是「恢复要秒级」与「空转不烧 CPU」的折中：
/// 这一圈除了读一个原子量什么都不做，但恢复按钮按下后最多 300ms 就出帧。
pub const PAUSE_POLL_MS: u64 = 300;

/// 会话期内的画面暂停状态。两个原子量：热路径（每圈一次）只读不锁。
#[derive(Default)]
pub struct VideoPauseGate {
    /// 被控端：本机已暂停出帧
    paused: AtomicBool,
    /// 发起端：对端报来的暂停状态（false = 没暂停 / 旧对端不发这条帧）
    peer_paused: AtomicBool,
}

impl RcService {
    /// 推流主循环的唯一问题：这一帧画面该不该发给对方。
    ///
    /// 🔴 它同时是 `status()` 投影 `video_paused` 的来源——判据写两遍必漏一处
    ///（规则 11.1），抽屉按钮的态与实际出帧的态必须是同一个原子量。
    pub(in crate::rc) fn video_paused(&self) -> bool {
        self.video_pause.paused.load(Ordering::SeqCst)
    }

    /// 暂停 / 恢复对方观看。**返回改后的状态**（前端据此切按钮，不做乐观置位）。
    ///
    /// 推流循环最迟 [`PAUSE_POLL_MS`] 后见效，这里不主动唤醒它：暂停不是急停，
    /// 多等半拍只是多出一帧，不值得为它在热路径上加一把 notify。
    pub async fn set_video_pause(&self, on: bool) -> bool {
        self.video_pause.paused.store(on, Ordering::SeqCst);
        log::info!(
            "[RC] 本机画面{}（会话不断，键鼠与剪贴板照常）",
            if on { "已暂停推送" } else { "已恢复推送" }
        );
        self.emit_video_pause().await;
        self.notify.emit_changed();
        on
    }

    /// 发起端：对端报来的暂停状态（快照用）。
    pub fn peer_video_paused(&self) -> bool {
        self.video_pause.peer_paused.load(Ordering::SeqCst)
    }

    /// 发起端：记下 `vpause` 帧（`outbound.rs` 解出后调用）。
    ///
    /// 🔴 这里主动 `emit_changed` 是被控端那颗按钮换不来的一条待遇：不推的话，对端
    /// 按下暂停到我们看见「对方已暂停画面」最坏要等下一拍 status 轮询（会话中 2s），
    /// 而那 2s 里胶囊上挂的是「操作后 Ns 无画面」——一条把「他在挡着」误诊成「链路不行」
    /// 的假结论。多一次状态广播换掉它，值得。
    pub(in crate::rc) fn set_peer_video_paused(&self, on: bool) {
        self.video_pause.peer_paused.store(on, Ordering::SeqCst);
        self.notify.emit_changed();
    }

    /// 被控端：把本机暂停状态推给对端（与 `emit_input_state` 同一条控制流）。
    ///
    /// 没有控制流（未 Accept / 已断开）时静默返回：它不是关键路径，按钮的态
    /// 本来就由本机那个原子量决定。
    pub async fn emit_video_pause(&self) {
        let msg = serde_json::json!({
            "t": "vpause",
            "on": self.video_paused(),
        });
        let Ok(b) = serde_json::to_vec(&msg) else {
            return;
        };
        let guard = self.inbound_send.lock().await;
        if let Some(send) = guard.as_ref() {
            let mut g = send.lock().await;
            let _ = crate::sync::transport::write_frame(&mut g, &b).await;
        }
    }

    /// 会话**开始**：暂停位与对端报来的暂停位清回「正常推流」。
    ///
    /// 🔴 与 `input_gate_begin` 同一条理由：`end_session` 的全局复位以「没换场」
    /// 为前提，换场路径会跳过它——上一场按的暂停就会漏进下一场，让新对端一上来
    /// 就看到一张冻住的旧画面。开始处清一遍，语义才不依赖上一场怎么结束。
    pub(in crate::rc) fn video_pause_begin(&self) {
        let g = &self.video_pause;
        g.paused.store(false, Ordering::SeqCst);
        g.peer_paused.store(false, Ordering::SeqCst);
    }

    /// 会话收口：暂停作废（发起端那份对端状态也一起清）。
    pub(in crate::rc) fn video_pause_reset(&self) {
        self.video_pause_begin();
    }
}

#[cfg(test)]
mod tests {
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

    use super::*;

    /// 默认必须是「正常推流」：反过来的话，任何一次没走清位路径的开局都会让对方
    /// 一连进来就看到黑屏，而界面上没有任何地方说明为什么。
    #[test]
    fn 默认不暂停() {
        let svc = RcService::new(crate::rc::tests::store());
        assert!(!svc.video_paused());
        assert!(!svc.peer_video_paused());
    }

    /// 暂停不跨会话：按下去只作用于**当前这一场**。
    #[test]
    fn 会话开始与收口都把暂停清干净() {
        let svc = RcService::new(crate::rc::tests::store());
        svc.video_pause.paused.store(true, Ordering::SeqCst);
        svc.set_peer_video_paused(true);
        svc.video_pause_begin();
        assert!(!svc.video_paused(), "上一场的暂停漏进下一场 = 新对端看到冻帧");
        assert!(
            !svc.peer_video_paused(),
            "发起端那份对端状态跨会话残留 = 下一场凭空挂着「对方已暂停画面」"
        );
        svc.video_pause.paused.store(true, Ordering::SeqCst);
        svc.video_pause_reset();
        assert!(!svc.video_paused());
    }
}
