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

use super::provider::{AiConfig, Protocol, ThinkingControl};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
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

    #[error("模型把 {0} token 的额度全用在“思考”上了，没留下答案——请把该动作的 token 上限调大（推理模型建议 ≥3000），或换一个不带思考的模型")]
    ThinkingOnly(u32),
}

/// 一次调用的结果。token 数用于预算统计；厂商不返回时为 0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOutcome {
    pub content: String,
    pub model: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// 回答撞到 `max_tokens` 被截断了。**调用方必须处理**：
    /// 截断的结果不该进缓存，否则半截答案会被当成正确结果反复返回 24 小时。
    pub truncated: bool,
}

// ===== OpenAI 兼容的请求/响应 =====

#[derive(Serialize)]
struct OaMessage<'a> {
    role: &'a str,
    content: &'a str,
}

/// 关思考的请求体（MiniMax / 智谱）。
#[derive(Serialize)]
struct ThinkingOff {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize)]
struct OaRequest<'a> {
    model: &'a str,
    messages: Vec<OaMessage<'a>>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// 两个关思考的字段写法不同，同时声明、按厂商二选一。
    /// 都是 `Option` 且为 `None` 时不序列化——不支持的厂商报文里看不到任何多余字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingOff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
}

#[derive(Deserialize)]
struct OaRespMessage {
    #[serde(default)]
    content: String,
    /// 另一派推理模型把思维链单独放这个字段，而不是内联进 `content`。
    /// 只用来判断“这是个会思考的模型”，**永远不当正文**。
    #[serde(default)]
    reasoning_content: String,
}

#[derive(Deserialize)]
struct OaChoice {
    #[serde(default)]
    message: Option<OaRespMessage>,
    /// `"length"` = 撞到 `max_tokens` 被截断。
    /// 不读它的话，一次「答案根本没生成出来」的调用会被当成正常回答返回。
    #[serde(default)]
    finish_reason: Option<String>,
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
    /// `"max_tokens"` = 被截断，对应 OpenAI 的 `finish_reason: "length"`。
    #[serde(default)]
    stop_reason: Option<String>,
}

/// 剥掉推理模型内联在正文里的思维链，返回（真正的回答, 是否检测到思考）。
///
/// 推理模型（实测 MiniMax-M3）在 OpenAI 兼容端点上会把思维链包在
/// `<think>…</think>` 里一并塞进 `content`。不剥的话用户拿到的就是一大块
/// “让我想想……”而不是答案。
///
/// **只在开头剥**。内联思维链总是出现在最前面，而剪贴板内容本身完全可能
/// 含有 `<think>` 字样（比如在翻译一段 HTML）——全文搜索替换会误伤正常内容。
///
/// 未闭合的情况必须单独处理：`max_tokens` 用尽时思维链会断在半句上，
/// 只有开标签没有闭标签，此时整段都是思考、正文一个字都没有。
fn strip_thinking(raw: &str) -> (String, bool) {
    const PAIRS: &[(&str, &str)] = &[("<think>", "</think>"), ("<thinking>", "</thinking>")];

    let trimmed = raw.trim_start();
    for (open, close) in PAIRS {
        if let Some(rest) = trimmed.strip_prefix(open) {
            return match rest.find(close) {
                Some(i) => (rest[i + close.len()..].trim().to_string(), true),
                None => (String::new(), true),
            };
        }
    }
    (trimmed.trim_end().to_string(), false)
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

/// 审查 backlog：#5 连接池复用 —— 每请求新建 client 会反复 TCP/TLS 握手；
/// 连接池常驻进程，超时按请求覆盖（reqwest 支持 per-request timeout）。
static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("PastePanda/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
});

/// 取那个常驻的连接池 client。
///
/// **不收 timeout 参数**：超时已经改成 per-request 设（见下面三个调用处的
/// `.timeout(...)`）。再留个用不上的参数会让人以为超时在这里生效。
fn build_client() -> Result<reqwest::Client, AiError> {
    CLIENT
        .clone()
        .ok_or_else(|| AiError::Network("HTTP 客户端初始化失败".to_string()))
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

    // 关“思考”：只向查实过写法的厂商发字段，其余一律不发。
    // 这不是保守，是因为发错字段名的代价（整个请求 400）比“没关成”大得多。
    // 自定义/中转服务商的 id 不在 PROVIDERS 里，而 `find()` 会**回退到默认厂商**（deepseek）——
    // 直接拿 spec 算 thinking_control 会把 DeepSeek 的开关字段塞给一个未知的中转服务，
    // 对方不认识就是 400。只有 id 真的命中内置表时才能用它的写法。
    let is_builtin = super::provider::PROVIDERS
        .iter()
        .any(|p| p.id == cfg.provider.trim());
    let (thinking, enable_thinking) = if cfg.thinking_off && is_builtin {
        match cfg.spec().thinking_control() {
            ThinkingControl::TypeObject => (Some(ThinkingOff { kind: "disabled" }), None),
            ThinkingControl::EnableFlag => (None, Some(false)),
            ThinkingControl::Unsupported => (None, None),
        }
    } else {
        (None, None)
    };

    let model = cfg.effective_model();
    let body = OaRequest {
        model: &model,
        messages,
        temperature: 0.3,
        stream: false,
        max_tokens,
        thinking,
        enable_thinking,
    };

    let resp = build_client()?
        .post(cfg.request_url())
        .bearer_auth(api_key.trim())
        .json(&body)
        .timeout(Duration::from_secs(cfg.timeout_secs))
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

    let choice = parsed.choices.into_iter().next();
    let truncated = choice
        .as_ref()
        .and_then(|c| c.finish_reason.as_deref())
        .is_some_and(|r| r == "length");
    let msg = choice.and_then(|c| c.message);
    let raw = msg.as_ref().map(|m| m.content.as_str()).unwrap_or_default();
    // 思维链在单独字段里的那一派模型：`content` 可能干净，但也可能因为
    // 额度都花在思考上而为空。记下来用于区分报错。
    let has_reasoning_field = msg
        .as_ref()
        .is_some_and(|m| !m.reasoning_content.trim().is_empty());

    let (content, had_inline_thinking) = strip_thinking(raw);
    if content.trim().is_empty() {
        // “模型没回话”与“模型光顾着思考了”是两件事，下一步完全不同，不能混成同一个报错
        if had_inline_thinking || has_reasoning_field || truncated {
            return Err(AiError::ThinkingOnly(max_tokens.unwrap_or(0)));
        }
        return Err(AiError::EmptyReply);
    }

    let usage = parsed.usage.unwrap_or_default();
    Ok(ChatOutcome {
        content,
        model: if parsed.model.is_empty() { model } else { parsed.model },
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        truncated,
    })
}

async fn chat_anthropic(
    cfg: &AiConfig,
    api_key: &str,
    system: Option<&str>,
    user: &str,
    max_tokens: Option<u32>,
) -> Result<ChatOutcome, AiError> {
    // Anthropic 的扩展思考是**默认关**的（要主动传 `thinking` 才开），
    // 所以 thinking_off 开关在这条路径上无需做任何事。
    let model = cfg.effective_model();
    let mt = max_tokens.unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS);
    let body = AnRequest {
        model: &model,
        // Anthropic 必填，不能省
        max_tokens: mt,
        system: system.filter(|s| !s.trim().is_empty()),
        messages: vec![AnMessage {
            role: "user",
            content: user,
        }],
        temperature: 0.3,
    };

    let resp = build_client()?
        .post(cfg.request_url())
        // 注意：不是 Bearer，是 x-api-key
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&body)
        .timeout(Duration::from_secs(cfg.timeout_secs))
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

    // 回复是内容块数组，只取 text 类型并拼起来。
    // 开了扩展思考时还会有 `thinking` 块，它们在这里就被滤掉了——
    // 不像 OpenAI 那边需要自己剥 `<think>` 标签。
    let content = parsed
        .content
        .iter()
        .filter(|b| b.kind == "text" || b.kind.is_empty())
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("");
    let truncated = parsed.stop_reason.as_deref() == Some("max_tokens");
    if content.trim().is_empty() {
        // 全部额度都花在 thinking 块上，一个 text 块都没生成出来
        let thought_only = parsed.content.iter().any(|b| b.kind == "thinking");
        if thought_only || truncated {
            return Err(AiError::ThinkingOnly(mt));
        }
        return Err(AiError::EmptyReply);
    }

    let usage = parsed.usage.unwrap_or_default();
    Ok(ChatOutcome {
        content: content.trim().to_string(),
        model: if parsed.model.is_empty() { model } else { parsed.model },
        // 字段名不同：input/output 而非 prompt/completion
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        truncated,
    })
}

// ===================== embedding（M5-2 语义索引） =====================

/// 一次 embedding 调用的结果。`prompt_tokens` 用于预算统计。
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingOutcome {
    pub vectors: Vec<Vec<f32>>,
    pub model: String,
    pub prompt_tokens: u32,
}

#[derive(Serialize)]
struct OaEmbedRequest<'a> {
    model: &'a str,
    input: Vec<&'a str>,
}

#[derive(Deserialize)]
struct OaEmbedData {
    #[serde(default)]
    embedding: Vec<f32>,
    #[serde(default)]
    index: usize,
}

#[derive(Deserialize, Default)]
struct OaEmbedResponse {
    #[serde(default)]
    data: Vec<OaEmbedData>,
    #[serde(default)]
    model: String,
    #[serde(default)]
    usage: Option<OaUsage>,
}

/// 批量文本转向量（OpenAI 兼容 `/embeddings`）。
///
/// 只有 OpenAI 兼容协议才有这个端点（Anthropic 协议没有 embedding），
/// 协议不符直接报配置错误。一次可传多条文本，按 `input` 顺序返回。
pub async fn embedding(
    cfg: &AiConfig,
    api_key: &str,
    model: &str,
    texts: &[String],
) -> Result<EmbeddingOutcome, AiError> {
    cfg.validate().map_err(AiError::Config)?;
    if cfg.effective_protocol() != Protocol::OpenAi {
        return Err(AiError::Config(
            "当前服务商不是 OpenAI 兼容协议，没有 /embeddings 接口——语义索引需要 OpenAI 兼容厂商".to_string(),
        ));
    }
    if cfg.spec().needs_key && api_key.trim().is_empty() {
        return Err(AiError::Config("未配置 API Key".to_string()));
    }
    if texts.is_empty() {
        return Err(AiError::Config("没有要向量化的文本".to_string()));
    }

    let body = OaEmbedRequest {
        model,
        input: texts.iter().map(|s| s.as_str()).collect(),
    };
    let url = format!("{}/embeddings", cfg.effective_base_url());
    let resp = build_client()?
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&body)
        .timeout(Duration::from_secs(cfg.timeout_secs))
        .send()
        .await
        .map_err(|e| map_send_error(e, cfg.timeout_secs))?;

    let status = resp.status();
    if !status.is_success() {
        let raw = resp.text().await.unwrap_or_default();
        return Err(map_status(status.as_u16(), &raw));
    }
    let parsed: OaEmbedResponse = resp
        .json()
        .await
        .map_err(|e| AiError::Decode(e.to_string()))?;

    // 按 index 排序：服务商不保证顺序
    let mut ordered = parsed.data;
    ordered.sort_by_key(|d| d.index);
    let vectors: Vec<Vec<f32>> = ordered.into_iter().map(|d| d.embedding).collect();
    if vectors.len() != texts.len() {
        return Err(AiError::Decode(format!(
            "返回 {} 条向量，期望 {} 条",
            vectors.len(),
            texts.len()
        )));
    }
    if vectors.iter().any(|v| v.is_empty()) {
        return Err(AiError::Decode("返回了空向量".to_string()));
    }

    Ok(EmbeddingOutcome {
        vectors,
        model: if parsed.model.is_empty() {
            model.to_string()
        } else {
            parsed.model
        },
        prompt_tokens: parsed.usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0),
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
    fn test_strip_thinking_removes_closed_block() {
        let (body, had) = strip_thinking("<think>让我想想，这段要压一半…</think>\n压缩后的结果");
        assert_eq!(body, "压缩后的结果");
        assert!(had);

        // 有些模型用 <thinking>
        let (body, had) = strip_thinking("<thinking>xxx</thinking>答案");
        assert_eq!(body, "答案");
        assert!(had);
    }

    #[test]
    fn test_strip_thinking_unclosed_means_nothing_left() {
        // 这正是实测撞到的那一个：max_tokens 用尽，思维链断在半句上，
        // 只有开标签没有闭标签。通行的 `<think>.*?</think>` 正则在这里匹配不上，
        // 会把整坑思维链当成正文交给用户——也就是这个 bug 本身。
        let (body, had) = strip_thinking("<think>先数一下字数，然后考虑哪些是冗余表达，接下来");
        assert!(body.is_empty(), "未闭合 = 正文一个字都没有，实际：{:?}", body);
        assert!(had);
    }

    #[test]
    fn test_strip_thinking_only_at_start() {
        // 剪贴板内容本身可能含 <think>（比如在翻译一段 HTML）。
        // 全文搜索替换会把用户的真实内容吃掉，所以只认开头。
        let raw = "这是正文。<think>这一段是用户自己的字</think>结尾";
        let (body, had) = strip_thinking(raw);
        assert_eq!(body, raw, "不在开头的 think 不能动");
        assert!(!had);
    }

    #[test]
    fn test_strip_thinking_passthrough() {
        let (body, had) = strip_thinking("  普通回答  ");
        assert_eq!(body, "普通回答");
        assert!(!had);
    }

    #[test]
    fn test_openai_parses_finish_reason_and_reasoning_field() {
        // 两个字段不接的后果：截断被当成正常回答，思维链被当成正文
        let raw = r#"{
            "model": "MiniMax-M3",
            "choices": [{
                "message": {"role":"assistant","content":"","reasoning_content":"嗯…"},
                "finish_reason": "length"
            }],
            "usage": {"prompt_tokens": 251, "completion_tokens": 1500}
        }"#;
        let parsed: OaResponse = serde_json::from_str(raw).unwrap();
        let c = &parsed.choices[0];
        assert_eq!(c.finish_reason.as_deref(), Some("length"));
        assert_eq!(c.message.as_ref().unwrap().reasoning_content, "嗯…");
    }

    #[test]
    fn test_anthropic_parses_stop_reason() {
        let raw = r#"{
            "model": "claude-haiku-4-5",
            "content": [{"type":"text","text":"半截"}],
            "stop_reason": "max_tokens"
        }"#;
        let parsed: AnResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.stop_reason.as_deref(), Some("max_tokens"));
    }

    #[test]
    fn test_thinking_only_error_tells_user_what_to_do() {
        // 这条报错存在的意义就是把“模型没回话”和“额度全花在思考上”分开，
        // 因为两者的下一步完全不同（一个重试，一个调大上限）
        let msg = AiError::ThinkingOnly(1500).to_string();
        assert!(msg.contains("1500"), "要告诉用户当前上限是多少");
        assert!(msg.contains("思考"));
        assert!(msg.contains("3000"), "要给出可操作的建议值");
    }

    #[test]
    fn test_thinking_off_serializes_per_vendor() {
        let mk = |thinking, enable_thinking| OaRequest {
            model: "m",
            messages: vec![OaMessage { role: "user", content: "hi" }],
            temperature: 0.3,
            stream: false,
            max_tokens: None,
            thinking,
            enable_thinking,
        };

        let j = serde_json::to_string(&mk(Some(ThinkingOff { kind: "disabled" }), None)).unwrap();
        assert!(j.contains(r#""thinking":{"type":"disabled"}"#), "{j}");
        assert!(!j.contains("enable_thinking"), "两个字段不能同时出现：{j}");

        let j = serde_json::to_string(&mk(None, Some(false))).unwrap();
        assert!(j.contains(r#""enable_thinking":false"#), "{j}");
        assert!(!j.contains(r#""thinking""#), "{j}");

        // 没核实过写法的厂商：报文里不得出现任何思考相关字段。
        // 多发一个对方不认识的字段，代价可能是整个请求 400。
        let j = serde_json::to_string(&mk(None, None)).unwrap();
        assert!(!j.contains("thinking"), "{j}");
    }

    #[test]
    fn test_thinking_control_only_for_documented_vendors() {
        use crate::ai::provider::find;
        // 四家有官方文档依据，且均为默认开思考
        assert_eq!(find("deepseek").thinking_control(), ThinkingControl::TypeObject);
        assert_eq!(find("zhipu").thinking_control(), ThinkingControl::TypeObject);
        assert_eq!(find("minimax").thinking_control(), ThinkingControl::TypeObject);
        assert_eq!(find("qwen").thinking_control(), ThinkingControl::EnableFlag);
        // 其余必须保持沉默——尤其是 custom（中转服务，背后是什么完全未知）
        assert_eq!(find("openai").thinking_control(), ThinkingControl::Unsupported);
        assert_eq!(find("anthropic").thinking_control(), ThinkingControl::Unsupported);
        assert_eq!(find("ollama").thinking_control(), ThinkingControl::Unsupported);
        assert_eq!(find("custom").thinking_control(), ThinkingControl::Unsupported);
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
            Some(1024),
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
