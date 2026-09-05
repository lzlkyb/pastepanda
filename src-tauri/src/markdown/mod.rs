//! Markdown 结构层：把一篇笔记的正文看成「若干个可寻址的节」。
//!
//! # 为何在顶层而不在 `mcp/` 下
//!
//! 它的第一个消费者是 MCP 的精准编辑工具（O-8），但下一个是检索切片层（O-4），
//! 而那是数据层的事。把数据层的基础塞进 `mcp/` 是层次错位。
//!
//! 切片为何该靠它：**按标题切比按字数切语义完整得多**。
//! 切到一句话中间的切片对检索是负贡献——它既不能单独读懂，又会抢走一个名额。
//!
//! # 分层
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`sections`] | 解析大纲、按定位符找节、取一节的原文 |
//! | [`edit`] | 应用一次编辑，返新正文 + 报告 |
//! | [`rank`] | 给各节打相关性分，找出「最相关的那几节」（AM-2）|
//! | [`chunks`] | 把节切成可寻址、可重算的切片（O-4）|
//!
//! 全部**是纯函数**。落库的原子性在 `mcp/source.rs`，不在这里。

pub mod annotate;
pub mod chunks;
pub mod edit;
pub mod links;
pub mod rank;
pub mod sections;

#[cfg(test)]
mod tests;

pub use annotate::{kinds_of, parse_observations, Observation};
pub use chunks::{chunk_note, content_hash, Chunk, CHUNK_OVERLAP, CHUNK_WINDOW};
pub use edit::{apply, ContentEdit, EditReport, InsertAt};
pub use links::{parse_links, WikiLink};
pub use rank::{rank_sections, SectionHit};
pub use sections::{locate, outline, slice, LocateError, Section, SectionRef};
