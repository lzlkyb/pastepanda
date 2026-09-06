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
//! | 一次完整的同步往返 | [`session`] |
//! | 生成方这边的「有人敲门」待确认队列 | [`join`] |
//! | 谁拨、撞上了谁让位、失败等多久 | [`coordinate`] |
//! | 自己跑的循环 | [`service`] |
//!
//! ❗ **还没有界面。**
//! 配对界面按规则 #4 要先出设计稿；所以这一层现在**不接任何 Tauri 命令**——
//! 接了就是没人调的死代码。

pub mod coordinate;
pub mod engine;
pub mod hlc;
pub mod identity;
pub mod invite;
pub mod join;
pub mod presence;
pub mod service;
pub mod session;
pub mod transport;

#[cfg(test)]
mod tests;
