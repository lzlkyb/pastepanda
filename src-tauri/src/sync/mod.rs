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
//! ❗ **还没有传输层，也没有界面。** 传输选型（LAN 组播扩展 / iroh / relay 兜底）
//! 需要单独一轮方案对比，配对界面按规则 #4 要先出设计稿。
//! 所以这一层现在**不接任何 Tauri 命令**——接了就是没人调的死代码。

pub mod engine;
pub mod identity;
pub mod invite;

#[cfg(test)]
mod tests;
