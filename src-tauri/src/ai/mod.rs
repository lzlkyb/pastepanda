//! 云端 AI 接入的地基层（阶段 B0）。
//!
//! 本模块只回答两件事：**密钥怎么安全存**、**能不能连上**。
//! 具体动作（翻译 / 摘要 / 解释代码）属于阶段 B1，不在这里。
//!
//! 三条设计红线（改动前先看这里）：
//!
//! 1. **API Key 绝不进 `config` 表**。那张表是明文 KV，而且 `save_config()` 每次调用
//!    都会把全量配置明文写一份到 `config_backups/` 并保留 10 份——Key 一旦进去，
//!    就变成“明文散 10 份、换 Key 后旧 Key 不退休”。所以它走 DPAPI 加密 + 独立文件，
//!    详见 [`secret_store`]。
//! 2. **Key 永不回读到前端**。命令层只有 set / has / clear，没有 get。
//! 3. **默认厂商是 DeepSeek 而非 OpenAI**。这不是偏好是网络实况：国内直连
//!    `api.openai.com` 多半不通，默认值必须是拿起来就能用的那个。
//! 4. **用量统计同样不走 `config` 表**（见 [`budget`]）。它每次调用都要写，
//!    进了 config 就变成“用一次 AI 多一份配置备份”。

pub mod actions;
pub mod budget;
pub mod cache;
pub mod client;
pub mod profile_prompt;
pub mod provider;
pub mod secret_store;

pub use client::{chat, AiError, ChatOutcome};
pub use provider::{AiConfig, Protocol, ProviderSpec};
