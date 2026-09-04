//! 多机同步（M6）。
//!
//! 当前只落地了 **P1 身份/配对层**：
//!
//! | | 位置 |
//! |---|---|
//! | ed25519 身份 + `NodeId` + 短指纹 | [`identity`] |
//! | 邀请码编解码与校验 | [`invite`] |
//! | 已配对设备表 | `data_store::device` |
//! | 增量算/写/应用（本地就能端到端测）| [`engine`] |
//!
//! ❗ **还没有界面，也还没有地址发现（`kb_presence`）。**
//! 配对界面按规则 #4 要先出设计稿；所以这一层现在**不接任何 Tauri 命令**——
//! 接了就是没人调的死代码。

pub mod engine;
pub mod hlc;
pub mod identity;
pub mod invite;
pub mod transport;

#[cfg(test)]
mod tests;
