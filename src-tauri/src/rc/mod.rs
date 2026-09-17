//! 远程电脑（远程协助）· R0 协议与门禁 + R1 UI 壳的后端。
//!
//! 定位见规划 §3.7：已配对自有设备之间的看屏 +（R2）键鼠；
//! **不做** shell / 文件 / 无人值守。默认关闭。

pub mod clipboard;
pub mod discovery;
pub mod history;
pub mod inbound;
pub mod input;
pub mod jpeg;
pub mod join;
pub mod link;
pub mod net;
pub mod notify;
pub mod outbound;
pub mod pin;
pub mod pressed;
pub mod protocol;
pub mod service;
pub mod session;
pub mod stream_cfg;
pub mod video;

#[cfg(target_os = "windows")]
pub mod dxgi;
#[cfg(target_os = "windows")]
pub mod encode_h264;

#[cfg(test)]
mod tests;

/// 本机设备名（主机名）。
///
/// 放在 rc 域而不是命令层：**局域网配对要把名字随握手包自报给对方**
/// （`rc/pin.rs` 的会话 + `rc/discovery.rs` 的发送），而命令层也要用它显示。
/// 两处各写一份 `hostname::get()` 就是两个数据源，迟早不一致。
pub fn local_device_name() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().trim().to_string())
        .unwrap_or_default()
}

pub use pin::{commit_allowed, Confirmed, Done, Outgoing, PairPrompt, Pairs, PAIR_WINDOW_SECS};
pub use protocol::{Capability, RcFrame, SessionPhase, ALPN};
pub use service::{cfg_enabled, global, install_global, RcService, RcStatus};
pub use session::{
    gate_inbound, gate_outbound, is_rc_online_for, Gate, Session, CFG_CAPABILITY, CFG_DEVICE_DENY,
    CFG_ENABLED, ONLINE_STALE_MS,
};
pub use video::VideoFrame;
