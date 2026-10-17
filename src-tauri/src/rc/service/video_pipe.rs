//! 编码管线状态回传（丙，2026-10-12，Issue #19）——被控端把「这一场画面为什么
//! 是这个样子」告诉发起端。
//!
//! # 为什么这条必须跨过那台机器
//!
//! Issue #19 的现场：发起端看到的是一条局域网直连、RTT 35ms 的链路，画面却是
//! 0.4–1fps 的幻灯片。真正的原因在被控端进程里（硬编连败 → 熔断 → 只剩 GDI 全帧
//! JPEG），而它当时**只写被控端日志**。用户能看到的只有症状，于是每一条解释都
//! 只能是猜（「网络不行吧」「对方机器卡吧」）。规则 15.1：症状常驻可见，原因就
//! 必须常驻可见——所以档位与「对方已暂停画面」走同一条控制流、落在同一排胶囊上。
//!
//! # 为什么是状态帧而不是每帧元数据
//!
//! 一场会话里这个值最多变几档（起播一档、换软编一档、熔断一档），而视频帧每圈
//! 一个。每圈比一次「与上次发出去的档名是否相同」，不同才发 ⇒ 正常会话零额外包。
//! 与之对照：`vhdr.c` 是**流级**编码标准（流重建才重写），拿它表达会话级降级会
//! 在 3 分钟 30 次流重建那种现场里反复闪。
//!
//! # 档位表（跨端契约，改动要同时改 `src/lib/rcVideoPipe.ts`）
//!
//! | 档名 | 含义 | 发起端怎么摆 |
//! |---|---|---|
//! | `hw` | 硬件编码器（含零拷贝已判死后的 CPU 送帧路径） | 不摆 |
//! | `sw` | 甲-3 换引擎：CPU 软编 MFT | 「对方软件编码」 |
//! | `enc_fuse` | 甲-4 熔断：硬编+软编都连败，只剩 JPEG | 「对方编码已降级」 |
//! | `grab_fuse` | DXGI 抓屏整池判死，只剩 JPEG | 「对方抓屏已降级」 |
//! | `single` | 本圈单帧没编出来（瞬态） | 不摆 |
//! | `no_enc` | 本会话没有编码器（用户配 JPEG / 打不开）——**分不清是哪一种** | 不摆 |
//! | `jpeg` | 非 Windows 宿主恒 JPEG（正常态） | 不摆 |
//!
//! `no_enc` 不摆是刻意的：它是「配置如此」和「打不开」的并集，摆出来就是在猜，
//! 而猜错的降级说明比没有说明更坏（与「对方已静音」同一条纪律：没有证据不摆断言）。
//!
//! # 旧对端
//!
//! 不发这条帧 ⇒ 发起端存的档名恒空串 ⇒ 前端一个字段读成 `null` ⇒ 不摆任何断言。

use super::RcService;
use std::sync::Mutex;

/// 发起端侧存的对端档位。两个字符串各自一把锁：会话内每 5s 最多写一次，
/// 读侧是 `status()` 投影（前端 2s 轮询），都不在帧热路径上。
#[derive(Default)]
pub struct VideoPipeState {
    /// 档名（见模块头的档位表）。空串 = 本会话还没收到 / 旧对端。
    code: Mutex<String>,
    /// 被控端原文标签（`pipeline_state()` 的第二项），只进详情不参与判据。
    label: Mutex<String>,
}

impl RcService {
    /// 被控端：把当前档位推给对端（与 `emit_video_pause` 同一条控制流）。
    ///
    /// 返回值 = **这条帧真的写进了控制流**。没有控制流（未 Accept / 已断开）时返回
    /// false 而不是制造错误分支：档位是诊断附加信息，值得为它断线就不对了；但调用方
    /// 要拿这个结果决定「算不算已经发过」——先把档记成已送达、再发现流不在，那一档
    /// 就永远补不回去了（直到下次变档，而熔断往往就停在那一档）。
    pub async fn emit_video_pipe(&self, code: &str, label: &str) -> bool {
        let msg = serde_json::json!({ "t": "vpipe", "c": code, "p": label });
        let Ok(b) = serde_json::to_vec(&msg) else {
            return false;
        };
        let guard = self.inbound_send.lock().await;
        let Some(send) = guard.as_ref() else {
            return false;
        };
        let mut g = send.lock().await;
        crate::sync::transport::write_frame(&mut g, &b).await.is_ok()
    }

    /// 发起端：记下 `vpipe` 帧（`outbound.rs` 解出后调用）。
    ///
    /// 与 [`Self::set_peer_video_paused`] 同一待遇：主动 `emit_changed`，不等下一拍
    /// status 轮询——画面正在变幻灯片的时候，这两秒的空窗足够让人去点「重连」。
    pub(in crate::rc) fn set_peer_video_pipe(&self, code: &str, label: &str) {
        let g = &self.video_pipe;
        *g.code.lock().unwrap_or_else(|p| p.into_inner()) = code.to_string();
        *g.label.lock().unwrap_or_else(|p| p.into_inner()) = label.to_string();
        self.notify.emit_changed();
    }

    /// 发起端：对端报来的档位 `(档名, 原文)`。空串 = 没收到过。
    pub(in crate::rc) fn peer_video_pipe(&self) -> (String, String) {
        let g = &self.video_pipe;
        (
            g.code.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            g.label.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        )
    }

    /// 会话开始：清空对端档位。上一场「已熔断」漏进下一场 = 新对端一进来就
    /// 看到一条不属于这台机器此刻的降级说明（与 `video_pause_begin` 同一条理由）。
    pub(in crate::rc) fn video_pipe_begin(&self) {
        let g = &self.video_pipe;
        *g.code.lock().unwrap_or_else(|p| p.into_inner()) = String::new();
        *g.label.lock().unwrap_or_else(|p| p.into_inner()) = String::new();
    }

    /// 会话收口：同上。
    pub(in crate::rc) fn video_pipe_reset(&self) {
        self.video_pipe_begin();
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 默认必须是「没收到」：反过来的话，旧对端（根本不发这条帧）会被判成
    /// 某个具体档位，前端就会摆出一条编造的降级说明。
    #[test]
    fn 默认是没收到() {
        let svc = RcService::new(crate::rc::tests::store());
        assert_eq!(svc.peer_video_pipe(), (String::new(), String::new()));
    }

    /// 跨会话不残留（与 `vpause` 同一条纪律）。
    #[test]
    fn 会话开始与收口都清空对端档位() {
        let svc = RcService::new(crate::rc::tests::store());
        svc.set_peer_video_pipe("enc_fuse", "JPEG（编码已熔断）");
        assert_eq!(svc.peer_video_pipe().0, "enc_fuse");
        svc.video_pipe_begin();
        assert_eq!(svc.peer_video_pipe(), (String::new(), String::new()));
        svc.set_peer_video_pipe("sw", "H264-软编MFT");
        svc.video_pipe_reset();
        assert_eq!(svc.peer_video_pipe(), (String::new(), String::new()));
    }

    /// 没有控制流时回执必须是「没送达」：推流侧据此决定要不要把这一档记成已发。
    /// 反过来的话，Accept 之前算出的那一档会被当成已经发过，而熔断那一档往往正好
    /// 停在「再也变不了」的地方——发出去的那一次错过就补不回来了。
    #[tokio::test]
    async fn 无控制流时回执是没送达() {
        let svc = RcService::new(crate::rc::tests::store());
        assert!(
            !svc.emit_video_pipe("enc_fuse", "JPEG（编码已熔断）").await,
            "无流却报「已送达」—— 推流侧会把这档记成发过，之后再也不补"
        );
    }
}
