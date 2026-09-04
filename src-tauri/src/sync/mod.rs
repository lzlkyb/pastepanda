//! 多机同步（M6）。
//!
//! 已落地的部分：
//!
//! | | 位置 |
//! |---|---|
//! | ed25519 身份 + `NodeId` + 短指纹 | [`identity`] |
//! | 邀请码编解码与校验 | [`invite`] |
//! | 已配对设备表 | `data_store::device` |
//! | 增量算/写/应用（本地就能端到端测）| [`engine`] |
//! | 混合逻辑时钟（跨机可比的版本号）| [`hlc`] |
//! | 只搬字节的 QUIC 传输 | [`transport`] |
//! | 局域网地址宣告（`kb_presence`）| [`presence`] |
//!
//! ❗ **还没有界面，也还没有把这些串起来的同步编排。**
//! 配对界面按规则 #4 要先出设计稿；所以这一层现在**不接任何 Tauri 命令**——
//! 接了就是没人调的死代码。

pub mod engine;
pub mod hlc;
pub mod identity;
pub mod invite;
pub mod presence;
pub mod transport;

#[cfg(test)]
mod tests;
