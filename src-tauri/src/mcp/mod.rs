//! 知识库 MCP Server（M4）—— 把本机笔记以 **MCP 工具**的形式开给
//! Claude Code 这类客户端，只绑 `127.0.0.1`。
//!
//! M4 只读；M5 加了七个写工具，默认全开但**逐项可关**（见 [`gate`]）。
//!
//! 分层：
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`server`] | HTTP 传输（axum）+ 中间件 + 启停 |
//! | [`auth`] | `Origin` 校验 + Bearer 常量时间比较 |
//! | [`protocol`] | 手写的 JSON-RPC / MCP 协议（四个方法）|
//! | [`tools`] | 工具的定义与分发（四个只读 + 七个写）|
//! | [`gate`] | 七个写权限开关与**双层门**（M5）|
//! | [`token`] | 访问令牌的生成与 DPAPI 加密落盘 |
//!
//! 默认**关闭**（决策 D7）：开一个本机监听端口是用户得知道且同意的事，
//! 不能因为升级就无声无息地多了一个服务。

pub mod auth;
pub mod gate;
pub mod protocol;
pub mod audit;
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

// 没有「写能力一次性告知」那个配置项：本功能上线前项目尚未发版，
// 不存在「当初基于只读承诺开过服务」的老用户。无人可告的告知只会误发。
// （若将来发布后再扩大权限，那时得重新把这一条加回来。）

/// User-Agent → 写入要落的来源标记，形如 `agent:claude-code`。
///
/// 与 W3 审计的 `client` **同源**（实测 Claude Code 每个请求都带
/// `claude-code/2.1.233 (sdk-cli)`），所以版本历史里的名字与调用记录对得上。
/// 不用 `clientInfo.name`（规划里原本这么写的）：MCP over HTTP 无状态，
/// 它只在 `initialize` 里出现一次，`tools/call` 不带——详见 A-53。
///
/// 🔴 **永不返回空串**：空在 W2 里的语义是「人亲自改的」，会让锚定快照静默失效。
pub fn source_agent_from_ua(ua: &str) -> String {
    // 只取 `名字/版本` 的名字部分：带上版本号的话，客户端一升级，
    // 历史列表里就多出一个看似不同的来源。
    let name: String = ua
        .split('/')
        .next()
        .unwrap_or("")
        .trim()
        // 截长：别让一个离谱的 UA 把这一列撞成几 KB。
        .chars()
        .take(40)
        .collect();
    if name.is_empty() {
        "agent:unknown".to_string()
    } else {
        format!("agent:{}", name)
    }
}
