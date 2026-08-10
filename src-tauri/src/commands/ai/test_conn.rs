//! 连通性测试：真实发一次最小请求验证配置，**通过后自动启用 AI**。
//!
//! 两个刻意的取舍：
//! - 自动启用——“测通了还要自己去找个开关打开”是多余的一步；想暂时不用的，高级区有停用；
//! - **不用 `/models` 之类的探测接口**——部分中转服务只实现了 chat，
//!   拿探测接口会报“不支持”，把可用的配置误判成坏的。

use super::*;

/// 连通性测试结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub model: String,
    pub protocol: &'static str,
    pub latency_ms: u64,
    pub reply: String,
    /// 测试通过后自动启用了 AI，前端据此刷新变换注册表。
    pub auto_enabled: bool,
}

/// 真实发一次最小请求验证配置，**通过后自动启用**。
///
/// 自动启用是有意的：“测通了但还要自己去找个开关打开”是多余的一步。
/// 想暂时不用的，高级区里有“停用”。
///
/// 故意不用 `/models` 之类的探测接口：部分中转服务只实现了 chat，
/// 用探测接口会报“不支持”，把可用的配置误判成坏的。
#[tauri::command]
pub async fn ai_test_connection(app: tauri::AppHandle) -> Result<AiTestResult, String> {
    // 先把需要的东西取出来，确保 DataStore 的锁不跨越 await
    let (cfg, key) = {
        let store = app.state::<DataStore>();
        let cfg = read_ai_config(&store)?;
        let dir = ai_data_dir(&app)?;
        let key = secret_store::load_key(&dir, &cfg.provider)?.unwrap_or_default();
        if cfg.spec().needs_key && key.is_empty() {
            return Err("尚未配置 API Key".to_string());
        }
        (cfg, key)
    };
    cfg.validate()?;

    let started = std::time::Instant::now();
    // 测试上限用 1024 而不是 16：不带思考的模型实际只输出几个 token（上限 ≠ 预分配，不会多花钱），
    // 而带思考的推理模型（如 Agnes-2.5-flash）思考过程就要吃掉几百 token——16 会全部耗在思考上，
    // 答案一个字都生成不出来，测试必然报「额度全用在思考上」。
    let result = crate::ai::chat(
        &cfg,
        &key,
        Some("你是连通性测试助手，只需按要求回答，不要其他内容。"),
        "回复两个字：正常",
        Some(1024),
    )
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let spec = cfg.spec();

    // 测试也是真实计费的调用，不记就对不上服务商后台的数。失败同样要记。
    let outcome = match result {
        Ok(o) => {
            record_usage(
                &app,
                AiUsageEntry {
                    action_id: "connection-test".to_string(),
                    provider: spec.id.to_string(),
                    model: o.model.clone(),
                    prompt_tokens: o.prompt_tokens,
                    completion_tokens: o.completion_tokens,
                    cost_usd: budget::estimate_cost(spec, o.prompt_tokens, o.completion_tokens),
                    cached: false,
                    latency_ms,
                    ok: true,
                    error: None,
                },
            );
            o
        }
        Err(e) => {
            let msg = e.to_string();
            record_usage(
                &app,
                AiUsageEntry {
                    action_id: "connection-test".to_string(),
                    provider: spec.id.to_string(),
                    model: cfg.effective_model(),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    cost_usd: 0.0,
                    cached: false,
                    latency_ms,
                    ok: false,
                    error: Some(msg.clone()),
                },
            );
            return Err(msg);
        }
    };

    // 测通就启用
    let mut auto_enabled = false;
    if !cfg.enabled {
        let store = app.state::<DataStore>();
        let mut next = cfg.clone();
        next.enabled = true;
        write_ai_config(&store, &next)?;
        auto_enabled = true;
    }

    Ok(AiTestResult {
        model: outcome.model,
        protocol: cfg.effective_protocol().id(),
        latency_ms,
        reply: outcome.content,
        auto_enabled,
    })
}
