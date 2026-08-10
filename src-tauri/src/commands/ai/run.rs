//! AI 动作的执行层：`ai_run`（出网闸 → 缓存 → 预算 → 调用）与 `ai_preview_custom`（试跑）。
//!
//! 从 `commands/ai.rs` 拆出。这里是唯一会把剪贴板内容发出去的地方，
//! 顺序（出网闸 → 参数校验 → 缓存 → 预算 → 真实调用）是有讲究的，别随手调。

use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunOk {
    pub content: String,
    pub model: String,
    /// true 表示这次没有实际调用云端（也就没有计费）。
    pub cached: bool,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// 回答撞到 token 上限被截断。内容仍然返回（半截总比没有强），
    /// 但界面要说清楚，否则用户会把截断当成模型水平差。
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunNeedsConfirm {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunBudgetExceeded {
    pub spent_cny: f64,
    pub budget_cny: f64,
}

/// `ai_run` 的返回。
///
/// 用枚举而不是 `Err(String)` 区分“需要确认”和“超预算”：它们不是错误，
/// 是需要前端分支处理的**正常结果**。真正的错误（网络/鉴权/解析）才走 Err。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AiRunResponse {
    Ok(AiRunOk),
    NeedsConfirm(AiRunNeedsConfirm),
    BudgetExceeded(AiRunBudgetExceeded),
}

/// 对一段内容执行一个云端动作。
///
/// 顺序是有讲究的：**出网闸 → 参数校验 → 缓存 → 预算 → 真实调用**。
/// - 出网闸放最前：即使结果已缓存，敏感内容也要重新问一遍，不能因为“上次同意过”就静默放行；
/// - 缓存在预算之前：命中缓存不花钱，不应该被预算拦住。
///
/// 本地厂商（Ollama）不走出网闸——内容根本没离开这台电脑。
///
/// `force` 表示用户已在敏感内容提示上确认过。
#[tauri::command]
pub async fn ai_run(
    app: tauri::AppHandle,
    action_id: String,
    text: String,
    opts: Option<HashMap<String, String>>,
    force: Option<bool>,
) -> Result<AiRunResponse, String> {
    let opts = opts.unwrap_or_default();
    let force = force.unwrap_or(false);

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

    if !cfg.enabled {
        return Err("AI 功能未启用".to_string());
    }
    cfg.validate()?;

    let spec = cfg.spec();

    // 出网闸：内容像密钥就不发，等用户明确确认。
    // 本地厂商跳过——内容根本不出机器，再问一遍是白打断。
    // 这里复用的就是「敏感内容防护」那套判定（is_secret），
    // 只不过那边管的是“要不要入库”，这边管的是“要不要出网”。
    let classifier = ContentClassifier::new();
    if !force && !spec.is_local() && classifier.is_secret(&text) {
        return Ok(AiRunResponse::NeedsConfirm(AiRunNeedsConfirm {
            reason: "这段内容看起来是密钥或凭证。发送到云端意味着它会离开这台电脑，确认要继续吗？"
                .to_string(),
        }));
    }

    // 内容类型在后端当场算，不让前端传：这样它与入库时的分类用的是同一套判定，
    // 也不用为了一个字符串去改变换契约
    let labels = classifier.classify(&text);
    let content_type = ContentClassifier::content_type_from_labels(&labels);

    // 内置优先；找不到再查自定义。守卫限在块里，下面有 await
    let custom: Option<CustomAction> = if actions::find_action(&action_id).is_some() {
        None
    } else {
        let store = app.state::<DataStore>();
        store.ai_custom_action(&action_id)?
    };

    // 先造 prompt（顺带做动作存不存在、长度超不超限的校验）
    let (system, user, max_tokens, cache_id) = match &custom {
        Some(c) => {
            if !c.enabled {
                return Err(format!("「{}」已停用", c.name));
            }
            let (s, u, m) =
                actions::build_custom_prompt(&c.template, &text, c.max_tokens, Some(content_type))?;
            // 模板一改，旧缓存就不该再命中
            (
                s,
                u,
                m,
                format!("{}#{}", action_id, template_fingerprint(&c.template)),
            )
        }
        None => {
            let (s, u, m) = actions::build_prompt(&action_id, &text, &opts, Some(content_type))?;
            (s, u, m, action_id.clone())
        }
    };

    let cache_key = cache::make_key(&cache_id, &opts, text.trim());
    if let Some(hit) = cache::get(&cache_key) {
        // 缓存命中也记一笔（cost = 0）——这是证明缓存到底省了多少钱的唯一数据。
        record_usage(
            &app,
            AiUsageEntry {
                action_id: action_id.clone(),
                provider: spec.id.to_string(),
                model: hit.model.clone(),
                prompt_tokens: 0,
                completion_tokens: 0,
                cost_usd: 0.0,
                cached: true,
                latency_ms: 0,
                ok: true,
                error: None,
            },
        );
        return Ok(AiRunResponse::Ok(AiRunOk {
            content: hit.content,
            model: hit.model,
            cached: true,
            prompt_tokens: 0,
            completion_tokens: 0,
            // 截断的结果压根不会进缓存，命中的一定是完整的
            truncated: false,
        }));
    }

    // 审查 backlog：#4 并发防重复计费 —— 同 key 并发只放行一个真实调用，
    // 其余等待其缓存结果（最多 ~1.5s），命中即按缓存返回。
    if !cache::inflight_add(&cache_key) {
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if let Some(hit) = cache::get(&cache_key) {
                record_usage(
                    &app,
                    AiUsageEntry {
                        action_id: action_id.clone(),
                        provider: spec.id.to_string(),
                        model: hit.model.clone(),
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        cost_usd: 0.0,
                        cached: true,
                        latency_ms: 0,
                        ok: true,
                        error: None,
                    },
                );
                return Ok(AiRunResponse::Ok(AiRunOk {
                    content: hit.content,
                    model: hit.model,
                    cached: true,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    truncated: false,
                }));
            }
            if !cache::inflight_active(&cache_key) {
                break; // 在跑的那个已完成但没写缓存（失败）——继续正常调用
            }
        }
    }

    // 本地厂商零费用，不受预算约束
    if !spec.is_local() {
        // 守卫限在这个块里：下面就是 await，DataStore 的锁不能活过去
        let today = { app.state::<DataStore>().ai_usage_today() };
        if let Err((spent_usd, budget_usd)) = budget::check(&today, cfg.daily_budget_usd()) {
            cache::inflight_done(&cache_key);
            return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                spent_cny: spent_usd * provider::USD_TO_CNY,
                budget_cny: budget_usd * provider::USD_TO_CNY,
            }));
        }
    }

    // M3 偏好学习：动作偏好指令拼进 system prompt（“译文更简洁”之类）。
    // 偏好变化会清缓存（action_pref_set 里 cache::clear()），这里无需担心旧缓存命中。
    // 在 await 前取好值，锁不跨 await。
    let system = {
        let store = app.state::<DataStore>();
        let pref = store.action_pref_get(&action_id)?;
        if pref.is_empty() {
            system
        } else {
            format!("{}\n\n用户偏好：{}", system, pref)
        }
    };

    let started = std::time::Instant::now();
    let result = crate::ai::chat(&cfg, &key, Some(system.as_str()), &user, Some(max_tokens)).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    let outcome = match result {
        Ok(o) => o,
        Err(e) => {
            // 失败也记：不记就对不上账，用户会以为统计坏了
            let msg = e.to_string();
            record_usage(
                &app,
                AiUsageEntry {
                    action_id: action_id.clone(),
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
            cache::inflight_done(&cache_key);
            return Err(msg);
        }
    };

    record_usage(
        &app,
        AiUsageEntry {
            action_id: action_id.clone(),
            provider: spec.id.to_string(),
            model: outcome.model.clone(),
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            cost_usd: budget::estimate_cost(
                spec,
                outcome.prompt_tokens,
                outcome.completion_tokens,
            ),
            cached: false,
            latency_ms,
            ok: true,
            error: None,
        },
    );
    // 截断的结果不进缓存。否则半截答案会被当成正确结果反复返回 24 小时，
    // 而且因为命中缓存不花钱也不报错，用户重试多少次都一模一样，
    // 看起来就像是“稳定复现的正确行为”。
    if !outcome.truncated {
        cache::inflight_done(&cache_key); // 先释放再 put（cache_key 随后被 move）
        cache::put(
            cache_key,
            cache::CachedValue {
                content: outcome.content.clone(),
                model: outcome.model.clone(),
            },
        );
    } else {
        cache::inflight_done(&cache_key);
    }

    Ok(AiRunResponse::Ok(AiRunOk {
        content: outcome.content,
        model: outcome.model,
        cached: false,
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        truncated: outcome.truncated,
    }))
}

/// 编辑器里的「试跑」：拿**还没保存**的模板真发一次。
///
/// 为什么要有它：写 prompt 本来就要迭代，而“保存 → 关掉设置 → 去变换中心找条内容试
/// → 回来改”这个循环长得没人会走完。
///
/// 几个刻意的取舍：
/// - **会真实计费**，按钮上写明了；
/// - **不走缓存**——用户点“试跑”就是想看这一次的结果；
/// - **不要求 AI 总开关已启用**：配置过程中本来就该能试；
/// - 但出网闸与预算照走，它和正式调用一样会把内容发出去。
#[tauri::command]
pub async fn ai_preview_custom(
    app: tauri::AppHandle,
    template: String,
    text: String,
    max_tokens: Option<u32>,
    force: Option<bool>,
) -> Result<AiRunResponse, String> {
    let force = force.unwrap_or(false);

    let (cfg, key) = {
        let store = app.state::<DataStore>();
        let cfg = read_ai_config(&store)?;
        let dir = ai_data_dir(&app)?;
        let key = secret_store::load_key(&dir, &cfg.provider)?.unwrap_or_default();
        if cfg.spec().needs_key && key.is_empty() {
            return Err("尚未配置 API Key，先在上面填一个再试跑".to_string());
        }
        (cfg, key)
    };
    cfg.validate()?;
    let spec = cfg.spec();

    let classifier = ContentClassifier::new();
    if !force && !spec.is_local() && classifier.is_secret(&text) {
        return Ok(AiRunResponse::NeedsConfirm(AiRunNeedsConfirm {
            reason: "试跑用的这段内容看起来是密钥或凭证。发送到云端意味着它会离开这台电脑，确认要继续吗？"
                .to_string(),
        }));
    }
    let labels = classifier.classify(&text);
    let content_type = ContentClassifier::content_type_from_labels(&labels);

    let (system, user, mt) = actions::build_custom_prompt(
        &template,
        &text,
        max_tokens.unwrap_or(2000).clamp(50, 4000),
        Some(content_type),
    )?;

    if !spec.is_local() {
        let today = { app.state::<DataStore>().ai_usage_today() };
        if let Err((spent_usd, budget_usd)) = budget::check(&today, cfg.daily_budget_usd()) {
            return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                spent_cny: spent_usd * provider::USD_TO_CNY,
                budget_cny: budget_usd * provider::USD_TO_CNY,
            }));
        }
    }

    let started = std::time::Instant::now();
    let result = crate::ai::chat(&cfg, &key, Some(system.as_str()), &user, Some(mt)).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    // 试跑也进用量明细：它花的是同一份预算，不记就对不上账
    match result {
        Ok(o) => {
            record_usage(
                &app,
                AiUsageEntry {
                    action_id: "custom-preview".to_string(),
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
            Ok(AiRunResponse::Ok(AiRunOk {
                content: o.content,
                model: o.model,
                cached: false,
                prompt_tokens: o.prompt_tokens,
                completion_tokens: o.completion_tokens,
                truncated: o.truncated,
            }))
        }
        Err(e) => {
            let msg = e.to_string();
            record_usage(
                &app,
                AiUsageEntry {
                    action_id: "custom-preview".to_string(),
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
            Err(msg)
        }
    }
}
