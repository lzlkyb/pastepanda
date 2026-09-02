//! 知识库 MCP Server（M4）—— 把本机笔记以 **MCP 工具**的形式开给
//! Claude Code 这类客户端，只读、只绑 `127.0.0.1`。
//!
//! 分层：
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`server`] | HTTP 传输（axum）+ 中间件 + 启停 |
//! | [`auth`] | `Origin` 校验 + Bearer 常量时间比较 |
//! | [`protocol`] | 手写的 JSON-RPC / MCP 协议（四个方法）|
//! | [`tools`] | 三个只读工具的定义与分发 |
//! | [`token`] | 访问令牌的生成与 DPAPI 加密落盘 |
//!
//! 默认**关闭**（决策 D7）：开一个本机监听端口是用户得知道且同意的事，
//! 不能因为升级就无声无息地多了一个服务。

pub mod auth;
pub mod protocol;
pub mod server;
pub mod source;
pub mod token;
pub mod tools;

#[cfg(test)]
mod tests;

pub use server::{McpServer, McpStatus, DEFAULT_PORT};

/// 配置项：是否开启 MCP 服务。存在 `config` 表（开关不是秘密，令牌才是）。
pub const CFG_ENABLED: &str = "mcp_server_enabled";

/// 配置项：监听端口。省略/非法时用 [`DEFAULT_PORT`]。
pub const CFG_PORT: &str = "mcp_server_port";
