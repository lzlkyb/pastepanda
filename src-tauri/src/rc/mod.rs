//! 远程电脑（远程协助）· R0 协议与门禁 + R1 UI 壳的后端。
//!
//! 定位见规划 §3.7：已配对自有设备之间的看屏 +（R2）键鼠；
//! **不做** shell / 文件 / 无人值守。默认关闭。

pub mod input;
pub mod jpeg;
pub mod join;
pub mod net;
pub mod notify;
pub mod pressed;
pub mod protocol;
pub mod service;
pub mod session;
pub mod video;

#[cfg(target_os = "windows")]
pub mod dxgi;
#[cfg(target_os = "windows")]
pub mod encode_h264;

#[cfg(test)]
mod tests;

pub use protocol::{Capability, RcFrame, SessionPhase, ALPN};
pub use service::{cfg_enabled, global, install_global, RcService, RcStatus};
pub use session::{gate_inbound, gate_outbound, Gate, Session, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED};
pub use video::VideoFrame;
