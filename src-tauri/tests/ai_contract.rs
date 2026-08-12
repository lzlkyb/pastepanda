//! v6.10 测试规划 · L2 管线契约测试(mock 服务商)。
//!
//! 跑法:`cargo test --test ai_contract`(无网络、无真实 key、毫秒级可重复)。
//!
//! 覆盖:主路径成功 / 流式一致性 / 推理模型(思考占满)/ 自动放宽重试 /
//! 截断 / 错误映射 / 超时 / 缓存键稳定性 / max_tokens 透传。配额链路
//! (C9/C10/C12) 依赖命令层 AppHandle,由 data_store 单测 + 手工验收兜底。

mod support;

use pastepanda_lib::ai::{chat, AiConfig, AiError};
use support::{mock_config, MockMode, MockServer};

/// 非流式主路径:正常回答。
#[tokio::test]
async fn c1_main_path_ok() {
    let (srv, base) = MockServer::start(MockMode::Ok("你好".to_string()));
    let cfg = mock_config(&base);
    let out = chat(&cfg, "sk-mock", None, "hi", Some(100), None).await.expect("应成功");
    assert_eq!(out.content, "你好");
    assert_eq!(out.model, "mock-agnes");
    assert_eq!(out.prompt_tokens, 10);
    assert_eq!(out.completion_tokens, 20);
    assert!(!out.truncated);
    // 请求体校验:OpenAI 协议、stream=false(未传 on_delta)
    let req = srv.request_body(0).expect("有请求");
    assert_eq!(req["model"], "mock-agnes-2.5-flash");
    assert_eq!(req["stream"], false);
    assert_eq!(req["messages"][0]["content"], "hi");
}

/// 流式 vs 非流式一致性:拼接结果必须等于整包结果。
#[tokio::test]
async fn c2_stream_equals_non_stream() {
    let chunks = vec!["你".to_string(), "好".to_string(), "，世".to_string(), "界".to_string()];
    let (srv, base) = MockServer::start(MockMode::OkStream(chunks));
    let cfg = mock_config(&base);
    let got = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let got2 = std::sync::Arc::clone(&got);
    let out = chat(&cfg, "sk-mock", None, "hi", Some(100), Some(&move |d| got2.lock().unwrap().push_str(d)))
        .await
        .expect("流式应成功");
    assert_eq!(*got.lock().unwrap(), "你好，世界", "on_delta 必须收到每个分块");
    assert_eq!(out.content, "你好，世界", "拼接结果与非流式一致");
    assert_eq!(out.model, "mock-agnes");
    assert!(!out.truncated);
    // 请求体 stream=true
    let req = srv.request_body(0).expect("有请求");
    assert_eq!(req["stream"], true);
}

/// 流式推理模型:reasoning_content 只判 ThinkingOnly,绝不当正文。
#[tokio::test]
async fn c3_stream_reasoning_not_body() {
    let (srv, base) = MockServer::start(MockMode::ThinkingOnlyStream);
    let cfg = mock_config(&base);
    // 必须传 on_delta 才会走流式路径(SSE 解析);空闭包只计数不收集
    let err = chat(&cfg, "sk-mock", None, "hi", Some(100), Some(&|_| {})).await;
    assert!(matches!(err, Err(AiError::ThinkingOnly(_))), "思考占满应报 ThinkingOnly: {err:?}");
    // 请求次数:首调失败后自动放宽重试一次
    assert!(srv.request_count() >= 1);
}

/// 自动放宽重试:首次 ThinkingOnly → 自动 ×2 重试 → 第二次成功。
#[tokio::test]
async fn c4_thinking_auto_retry_succeeds() {
    let (srv, base) = MockServer::start(MockMode::ThinkingThenOk);
    let cfg = mock_config(&base);
    let out = chat(&cfg, "sk-mock", None, "hi", Some(100), None).await.expect("放宽后应成功");
    assert_eq!(out.content, "放宽后成功");
    // 两次请求:第一次 max_tokens=100,第二次翻倍=200
    assert_eq!(srv.request_count(), 2, "应恰好重试一次");
    assert_eq!(srv.request_body(0).unwrap()["max_tokens"], 100);
    assert_eq!(srv.request_body(1).unwrap()["max_tokens"], 200);
}

/// 放宽重试仍失败:透传 ThinkingOnly(不无限重试)。
#[tokio::test]
async fn c4b_thinking_retry_fails_then_errors() {
    let (srv, base) = MockServer::start(MockMode::ThinkingOnly);
    let cfg = mock_config(&base);
    let err = chat(&cfg, "sk-mock", None, "hi", Some(100), None).await;
    assert!(matches!(err, Err(AiError::ThinkingOnly(_))));
    assert!(srv.request_count() <= 2, "只允许一次放宽重试");
}

/// 截断:finish_reason=length → truncated=true。
#[tokio::test]
async fn c6_truncated_flag() {
    let (srv, base) = MockServer::start(MockMode::Truncated("半截答案".to_string()));
    let cfg = mock_config(&base);
    let out = chat(&cfg, "sk-mock", None, "hi", Some(100), None).await.expect("截断仍是成功响应");
    assert!(out.truncated, "length finish_reason 必须标记截断");
    assert_eq!(out.content, "半截答案");
}

/// 错误映射:401(鉴权)、429(限流)、500(服务端)。
#[tokio::test]
async fn c7_error_mapping() {
    // 401 → Unauthorized
    let (srv, base) = MockServer::start(MockMode::Status(401));
    let err = chat(&mock_config(&base), "sk-mock", None, "hi", Some(100), None).await;
    assert!(matches!(err, Err(AiError::Unauthorized(401))), "{err:?}");
    drop(srv);

    // 429 → RateLimited
    let (srv, base) = MockServer::start(MockMode::Status(429));
    let err = chat(&mock_config(&base), "sk-mock", None, "hi", Some(100), None).await;
    assert!(matches!(err, Err(AiError::RateLimited)), "{err:?}");
    drop(srv);

    // 500 → 通用 Http 错误
    let (srv, base) = MockServer::start(MockMode::Status(500));
    let err = chat(&mock_config(&base), "sk-mock", None, "hi", Some(100), None).await;
    match err {
        Err(AiError::Http { status, .. }) => assert_eq!(status, 500),
        other => panic!("500 应映射为 Http(500): {other:?}"),
    }
    drop(srv);
}

/// 超时:mock 挂起 → 客户端超时报错(不 panic)。
#[tokio::test]
async fn c8_timeout() {
    let (srv, base) = MockServer::start(MockMode::Hang);
    // 1 秒超时;mock 挂 60 秒 → 必然触发 timeout
    let mut cfg = mock_config(&base);
    cfg.timeout_secs = 1;
    let started = std::time::Instant::now();
    let err = chat(&cfg, "sk-mock", None, "hi", Some(100), None).await;
    assert!(matches!(err, Err(AiError::Timeout(_))), "{err:?}");
    assert!(started.elapsed().as_secs() < 10, "必须快速失败而非卡死");
    drop(srv);
}

/// 缓存键稳定性:同动作+同选项(乱序)+同文本 → 同键;不同文本 → 不同键。
#[test]
fn c5_cache_key_stable() {
    use std::collections::HashMap;
    use pastepanda_lib::ai::cache::make_key;
    let mut o1 = HashMap::new();
    o1.insert("lang".to_string(), "en".to_string());
    o1.insert("tone".to_string(), "formal".to_string());
    let mut o2 = HashMap::new();
    o2.insert("tone".to_string(), "formal".to_string());
    o2.insert("lang".to_string(), "en".to_string());
    let k1 = make_key("ai-translate", &o1, "你好世界");
    let k2 = make_key("ai-translate", &o2, "你好世界");
    assert_eq!(k1, k2, "选项顺序不应影响缓存键");
    let k3 = make_key("ai-translate", &o1, "再见世界");
    assert_ne!(k1, k3, "不同内容必须不同键");
    let k4 = make_key("ai-summarize", &o1, "你好世界");
    assert_ne!(k1, k4, "不同动作必须不同键");
}

/// max_tokens 透传:None → 请求不带该字段;Some → 透传。
#[tokio::test]
async fn c14_max_tokens_passthrough() {
    // Some
    let (srv, base) = MockServer::start(MockMode::Ok("x".to_string()));
    let _ = chat(&mock_config(&base), "sk-mock", None, "hi", Some(777), None).await.unwrap();
    assert_eq!(srv.request_body(0).unwrap()["max_tokens"], 777);
    drop(srv);

    // None → 不序列化(请求体无 max_tokens 字段)
    let (srv, base) = MockServer::start(MockMode::Ok("x".to_string()));
    let _ = chat(&mock_config(&base), "sk-mock", None, "hi", None, None).await.unwrap();
    assert!(srv.request_body(0).unwrap().get("max_tokens").is_none());
    drop(srv);
}

/// 空回答(非推理):模型返回空 content 且无思维链 → EmptyReply。
#[tokio::test]
async fn c15_empty_reply() {
    // 用 ThinkingOnly 模式测空 content,但流式且带 reasoning → ThinkingOnly;
    // 空 content 无 reasoning 走 Ok("") 模式:通过 Ok(空)验证 EmptyReply 路径
    let (srv, base) = MockServer::start(MockMode::Ok(String::new()));
    let err = chat(&mock_config(&base), "sk-mock", None, "hi", Some(100), None).await;
    assert!(matches!(err, Err(AiError::EmptyReply)), "{err:?}");
    drop(srv);
}

/// 密钥为空且厂商需要 key → Config 错误(不发起网络)。
#[tokio::test]
async fn c16_missing_key_no_network() {
    let (srv, base) = MockServer::start(MockMode::Ok("x".to_string()));
    let mut cfg = mock_config(&base);
    cfg.provider = "deepseek".to_string(); // deepseek 需要 key
    let err = chat(&cfg, "   ", None, "hi", Some(100), None).await;
    assert!(matches!(err, Err(AiError::Config(_))), "{err:?}");
    assert_eq!(srv.request_count(), 0, "缺 key 不应发起网络请求");
    drop(srv);
}

/// AiConfig 校验:timeout=0 → 校验失败(配置完整性检查必须生效)。
#[test]
fn c17_config_validation_rejects_invalid() {
    let mut cfg: AiConfig = mock_config("http://127.0.0.1:9/v1");
    cfg.timeout_secs = 0;
    let err = cfg.validate();
    assert!(err.is_err(), "timeout=0 必须校验失败");
    // 合法配置必须通过(防校验误伤正常配置)
    cfg.timeout_secs = 60;
    assert!(cfg.validate().is_ok(), "正常配置必须通过校验");
}
