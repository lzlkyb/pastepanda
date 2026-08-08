//! 云端调用，支持两种事实标准协议。
//!
//! | | OpenAI 兼容 | Anthropic Messages |
//! |---|---|---|
//! | 路径 | `{base}/chat/completions` | `{base}/messages` |
//! | 鉴权 | `Authorization: Bearer <key>` | `x-api-key: <key>` |
//! | 额外头 | 无 | `anthropic-version: 2023-06-01` |
//! | 系统提示词 | messages 里一条 `role:"system"` | 顶层 `system` 字段 |
//! | max_tokens | 可选 | **必填** |
//! | 回复 | `choices[0].message.content` | `content[0].text` |
//! | 用量 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
//!
//! 差异多到不能用一套结构体套，所以下面是两条独立路径，只共享错误归一与返回结构。
//!
//! 只做一件事：发一次请求、把结果或**人看得懂的错误**拿回来。
//! 不做重试（重试 = 重复计费，应该是调用方的决定），不做流式。

use super::provider::{AiConfig, Protocol};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Anthropic 的 `max_tokens` 是必填项，调用方没给时用这个。
const ANTHROPIC_DEFAULT_MAX_TOKENS: u32 = 1024;

/// Anthropic API 版本头。它是必需的，不带会直接 400。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 调用失败的归一分类。每条都直接是可以摆到界面上的中文，
/// 不把 `reqwest` 的英文原文偷懒透给用户。
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("配置不完整：{0}")]
    Config(String),

    #[error("API Key 无效、已过期或没有权限（HTTP {0}）")]
    Unauthorized(u16),

    #[error("账户余额不足或已欠费（HTTP {0}）")]
    Payment(u16),

    #[error("请求过于频繁，稍后再试（HTTP 429）")]
    RateLimited,

    #[error("请求被拒绝（HTTP 403）——常见原因是服务商封锁了当前地区，需代理或换国内服务商")]
    Forbidden,

    #[error("请求超时（{0} 秒）——若在国内网络，请确认所选厂商可直连")]
    Timeout(u64),

    #[error("网络不可达：{0}")]
    Network(String),

    #[error("接口路径不存在（HTTP 404）——检查接口地址，以及协议选对了没有")]
    NotFound,

    #[error("服务端返回 HTTP {status}：{body}")]
    Http { status: u16, body: String },

    #[error("响应解析失败：{0}——若对方是 Anthropic 格式，请在高级里改协议")]
    Decode(String),

    #[error("模型没有返回任何内容")]
    EmptyReply,
}

/// 一次调用的结果。token 数用于预算统计；厂商不返回时为 0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOutcome {
    pub content: String,
    pub model: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

// ===== OpenAI 兼容的请求/响应 =====

#[derive(Serialize)]
struct OaMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct OaRequest<'a> {
    model: &'a str,
    messages: Vec<OaMessage<'a>>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct OaRespMessage {
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct OaChoice {
    #[serde(default)]
    message: Option<OaRespMessage>,
}

#[derive(Deserialize, Default)]
struct OaUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[derive(Deserialize)]
struct OaResponse {
    #[serde(default)]
    model: String,
    #[serde(default)]
    choices: Vec<OaChoice>,
    #[serde(default)]
    usage: Option<OaUsage>,
}

// ===== Anthropic Messages 的请求/响应 =====

#[derive(Serialize)]
struct AnMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct AnRequest<'a> {
    model: &'a str,
    /// Anthropic 必填
    max_tokens: u32,
    /// 系统提示词在顶层，不在 messages 里
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: Vec<AnMessage<'a>>,
    temperature: f32,
}

#[derive(Deserialize)]
struct AnContentBlock {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize, Default)]
struct AnUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}

#[derive(Deserialize)]
struct AnResponse {
    #[serde(default)]
    model: String,
    #[serde(default)]
    content: Vec<AnContentBlock>,
    #[serde(default)]
    usage: Option<AnUsage>,
}

/// 截断过长的错误体：厂商报错时常回一大块 HTML，直接摆给用户毫无意义。
/// 按**字符**截断而非字节，避免把中文切成乱码。
fn truncate_body(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max_chars).collect();
    format!("{}…", head)
}

/// HTTP 状态码 → 归一错误。两种协议的状态码语义一致，可以共用。
fn map_status(code: u16, raw_body: &str) -> AiError {
    match code {
        401 => AiError::Unauthorized(code),
        403 => AiError::Forbidden,
        402 => AiError::Payment(code),
        404 => AiError::NotFound,
        429 => AiError::RateLimited,
        _ => AiError::Http {
            status: code,
            body: truncate_body(raw_body, 300),
        },
    }
}

fn build_client(timeout_secs: u64) -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("PastePanda/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AiError::Network(e.to_string()))
}

fn map_send_error(e: reqwest::Error, timeout_secs: u64) -> AiError {
    if e.is_timeout() {
        AiError::Timeout(timeout_secs)
    } else {
        AiError::Network(e.to_string())
    }
}

/// 发一次请求。根据配置的协议自动选路径、鉴权头与报文格式。
///
/// * `system` —— 可选的系统提示词
/// * `max_tokens` —— 上限；Anthropic 必填，`None` 时用默认值
pub async fn chat(
    cfg: &AiConfig,
    api_key: &str,
    system: Option<&str>,
    user: &str,
    max_tokens: Option<u32>,
) -> Result<ChatOutcome, AiError> {
    cfg.validate().map_err(AiError::Config)?;

    // 本地厂商（Ollama）不需要密钥，其余必须有
    if cfg.spec().needs_key && api_key.trim().is_empty() {
        return Err(AiError::Config("未配置 API Key".to_string()));
    }

    match cfg.effective_protocol() {
        Protocol::OpenAi => chat_openai(cfg, api_key, system, user, max_tokens).await,
        Protocol::Anthropic => chat_anthropic(cfg, api_key, system, user, max_tokens).await,
    }
}

async fn chat_openai(
    cfg: &AiConfig,
    api_key: &str,
    system: Option<&str>,
    user: &str,
    max_tokens: Option<u32>,
) -> Result<ChatOutcome, AiError> {
    let mut messages = Vec::with_capacity(2);
    if let Some(sys) = system {
        if !sys.trim().is_empty() {
            messages.push(OaMessage {
                role: "system",
                content: sys,
            });
        }
    }
    messages.push(OaMessage {
        role: "user",
        content: user,
    });

    let model = cfg.effective_model();
    let body = OaRequest {
        model: &model,
        messages,
        temperature: 0.3,
        stream: false,
        max_tokens,
    };

    let resp = build_client(cfg.timeout_secs)?
        .post(cfg.request_url())
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| map_send_error(e, cfg.timeout_secs))?;

    let status = resp.status();
    if !status.is_success() {
        let raw = resp.text().await.unwrap_or_default();
        return Err(map_status(status.as_u16(), &raw));
    }

    let parsed: OaResponse = resp
        .json()
        .await
        .map_err(|e| AiError::Decode(e.to_string()))?;

    let content = parsed
        .choices
        .into_iter()
        .find_map(|c| c.message.map(|m| m.content))
        .unwrap_or_default();
    if content.trim().is_empty() {
        return Err(AiError::EmptyReply);
    }

    let usage = parsed.usage.unwrap_or_default();
    Ok(ChatOutcome {
        content: content.trim().to_string(),
        model: if parsed.model.is_empty() { model } else { parsed.model },
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
    })
}

async fn chat_anthropic(
    cfg: &AiConfig,
    api_key: &str,
    system: Option<&str>,
    user: &str,
    max_tokens: Option<u32>,
) -> Result<ChatOutcome, AiError> {
    let model = cfg.effective_model();
    let body = AnRequest {
        model: &model,
        // Anthropic 必填，不能省
        max_tokens: max_tokens.unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS),
        system: system.filter(|s| !s.trim().is_empty()),
        messages: vec![AnMessage {
            role: "user",
            content: user,
        }],
        temperature: 0.3,
    };

    let resp = build_client(cfg.timeout_secs)?
        .post(cfg.request_url())
        // 注意：不是 Bearer，是 x-api-key
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| map_send_error(e, cfg.timeout_secs))?;

    let status = resp.status();
    if !status.is_success() {
        let raw = resp.text().await.unwrap_or_default();
        return Err(map_status(status.as_u16(), &raw));
    }

    let parsed: AnResponse = resp
        .json()
        .await
        .map_err(|e| AiError::Decode(e.to_string()))?;

    // 回复是内容块数组，只取 text 类型并拼起来
    let content = parsed
        .content
        .iter()
        .filter(|b| b.kind == "text" || b.kind.is_empty())
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("");
    if content.trim().is_empty() {
        return Err(AiError::EmptyReply);
    }

    let usage = parsed.usage.unwrap_or_default();
    Ok(ChatOutcome {
        content: content.trim().to_string(),
        model: if parsed.model.is_empty() { model } else { parsed.model },
        // 字段名不同：input/output 而非 prompt/completion
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_body_keeps_chinese_intact() {
        // 按字符截：中文不能被切成乱码
        let s = "余额不足请充值".repeat(100);
        let out = truncate_body(&s, 10);
        assert_eq!(out.chars().count(), 11, "10 个字符 + 一个省略号");
        assert!(out.ends_with('…'));
        assert!(out.starts_with("余额不足"));
    }

    #[test]
    fn test_truncate_body_short_input_unchanged() {
        assert_eq!(truncate_body("  hello  ", 300), "hello");
    }

    #[test]
    fn test_status_mapping_covers_common_cases() {
        assert!(matches!(map_status(401, ""), AiError::Unauthorized(401)));
        assert!(matches!(map_status(402, ""), AiError::Payment(402)));
        // 403 单独分一类：实测 Anthropic 官方端点在国内就是 403 地域封锁，
        // 归到 Unauthorized 会让用户去白白检查密钥
        assert!(matches!(map_status(403, ""), AiError::Forbidden));
        // 404 单独分一类：协议选错时就是 404，提示要指向协议
        assert!(matches!(map_status(404, ""), AiError::NotFound));
        assert!(matches!(map_status(429, ""), AiError::RateLimited));
        assert!(matches!(map_status(500, "boom"), AiError::Http { status: 500, .. }));
    }

    #[test]
    fn test_error_messages_are_chinese_and_actionable() {
        // 错误文案直接会被摆到界面上，不得退化成英文，而且要带下一步
        assert!(AiError::Unauthorized(401).to_string().contains("API Key"));
        assert!(AiError::RateLimited.to_string().contains("频繁"));
        assert!(AiError::Timeout(60).to_string().contains("超时"));
        assert!(AiError::EmptyReply.to_string().contains("没有返回"));
        assert!(AiError::Forbidden.to_string().contains("地区"));
        assert!(AiError::NotFound.to_string().contains("协议"));
    }

    #[tokio::test]
    async fn test_chat_rejects_empty_key_before_network() {
        // 没有 Key 时必须在发请求**之前**就失败，否则会白白等一个超时
        let cfg = AiConfig::default();
        let err = chat(&cfg, "   ", None, "hi", None).await.unwrap_err();
        assert!(matches!(err, AiError::Config(_)));
    }

    #[tokio::test]
    async fn test_local_provider_does_not_require_key() {
        // Ollama 不需密钥，不能被“未配置 Key”拦住。
        // 本机没跑 Ollama，所以它会挂在网络错误上——那正是我们要验的：
        // 说明它真的去发请求了，而不是在参数校验阶段就被弹回。
        let cfg = AiConfig {
            provider: "ollama".to_string(),
            model: "qwen2.5".to_string(),
            timeout_secs: 5,
            ..Default::default()
        };
        let err = chat(&cfg, "", None, "hi", None).await.unwrap_err();
        assert!(
            !matches!(err, AiError::Config(_)),
            "本地厂商不应因缺密钥而被拦，实际：{}",
            err
        );
    }

    #[tokio::test]
    async fn test_chat_rejects_incomplete_custom_config() {
        let cfg = AiConfig {
            provider: "custom".to_string(),
            ..Default::default()
        };
        let err = chat(&cfg, "sk-whatever", None, "hi", None)
            .await
            .unwrap_err();
        assert!(matches!(err, AiError::Config(_)));
    }

    #[test]
    fn test_anthropic_request_shape() {
        // Anthropic 的报文与 OpenAI 差异很大，这里钉住三件事：
        // max_tokens 必需、system 在顶层、messages 里没有 system 角色
        let body = AnRequest {
            model: "claude-haiku-4-5-20251001",
            max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
            system: Some("你是工具"),
            messages: vec![AnMessage {
                role: "user",
                content: "hi",
            }],
            temperature: 0.3,
        };
        let json = serde_json::to_string(&body).unwrap();
        assert!(json.contains("\"max_tokens\":1024"), "max_tokens 必须序列化出来");
        assert!(json.contains("\"system\":"), "system 应在顶层");
        assert!(!json.contains("\"role\":\"system\""), "system 不能出现在 messages 里");

        // 系统提示词为空时应该整个不序列化，而不是传 null
        let no_sys = AnRequest {
            model: "m",
            max_tokens: 16,
            system: None,
            messages: vec![AnMessage { role: "user", content: "hi" }],
            temperature: 0.3,
        };
        assert!(!serde_json::to_string(&no_sys).unwrap().contains("system"));
    }

    #[test]
    fn test_anthropic_response_parsing() {
        // token 字段名与 OpenAI 不同（input/output 而非 prompt/completion），
        // 回复是内容块数组而非单个字符串
        let raw = r#"{
            "model": "claude-haiku-4-5-20251001",
            "content": [{"type":"text","text":"正常"}],
            "usage": {"input_tokens": 22, "output_tokens": 1}
        }"#;
        let parsed: AnResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.content.len(), 1);
        assert_eq!(parsed.content[0].text, "正常");
        let usage = parsed.usage.unwrap();
        assert_eq!(usage.input_tokens, 22);
        assert_eq!(usage.output_tokens, 1);
    }

    #[test]
    fn test_openai_response_parsing() {
        let raw = r#"{
            "model": "deepseek-v4-flash",
            "choices": [{"message": {"role":"assistant","content":"OK"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 1}
        }"#;
        let parsed: OaResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.model, "deepseek-v4-flash");
        let usage = parsed.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 10);
    }

    /// 真实联网连通性测试。**默认不跑**（会计费、依赖外部服务，CI 不应该碰）。
    ///
    /// 跑法（密钥从环境变量读，不进源码）：
    /// ```text
    /// PASTEPANDA_AI_KEY=sk-xxx cargo test --lib -- --ignored test_live_connection --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "需要真实 API Key 且会计费，默认跳过"]
    async fn test_live_connection() {
        let key = std::env::var("PASTEPANDA_AI_KEY")
            .expect("请先设置环境变量 PASTEPANDA_AI_KEY");
        let cfg = AiConfig::default(); // 默认就是 DeepSeek

        let out = chat(
            &cfg,
            &key,
            Some("你是连通性测试助手，只需按要求回答，不要其他内容。"),
            "回复两个字：正常",
            Some(16),
        )
        .await
        .expect("调用失败");

        println!(
            "[live] 协议={} 请求模型={} 实际模型={} 回复={:?} tokens={}+{}",
            cfg.effective_protocol().id(),
            cfg.effective_model(),
            out.model,
            out.content,
            out.prompt_tokens,
            out.completion_tokens
        );
        assert!(!out.content.trim().is_empty(), "回复不应为空");
        assert!(!out.model.is_empty(), "应返回模型名");
    }
}
