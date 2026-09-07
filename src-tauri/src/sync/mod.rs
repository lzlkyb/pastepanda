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
//! # 接口层
//!
//! 命令在 `commands::kb_sync`（身份 / 邀请码 / 配对 / 设备表 / 敲门确认 /
//! 立即同步 / 开关），界面在知识库模式的「知识库同步」面板。
//!
//! ❗ 这儿原本写的是「**还没有界面**、这一层不接任何 Tauri 命令」。
//! 那是 M6 刚开头时的状态，后来接上了却没回来改这段——
//! 而它是整个模块的门面，读代码的人第一眼看到的就是它。

pub mod attach;
pub mod coordinate;
pub mod digest;
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
mod attach_tests;
#[cfg(test)]
mod digest_tests;
#[cfg(test)]
mod gc_tests;
#[cfg(test)]
mod tests;
