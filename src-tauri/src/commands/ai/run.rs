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
    /// v6.9：true = 内置免费额度不足（替代金额预算的拦截），
    /// 前端据此提示「去签到 / 兑换」而不是「今日预算用完」。
    #[serde(default)]
    pub is_quota: bool,
    /// v6.9 缺陷修复：配额拦截的具体原因，前端给不同引导。
    /// - `"exhausted"` → 余额耗尽，引导签到/兑换
    /// - `"dailyCap"` → 今日用量已达上限，引导明天再试
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_reason: Option<String>,
}

/// v6.9 缺陷修复：内置免费额度动作的 max_tokens 下限。
/// agnes-2.5-flash 是推理模型，reasoning 会先吃掉一部分 token，
/// max_tokens 太小会导致输出截断/为空（曾实测「16 token 全用在思考」）。
const BUILTIN_MAX_TOKENS_MIN: u32 = 2048;

// v6.9：内置免费额度本地限流（保护免费 key 的 RPM，免费用户实际 ~20/分钟，
// 客户端留余量压到 10/分钟）。进程内滑动窗口。
static BUILTIN_CALLS: std::sync::Mutex<std::collections::VecDeque<std::time::Instant>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
const BUILTIN_RATE_PER_MIN: usize = 10;

/// 内置免费额度限流：60s 窗口内 ≤10 次。超限返回 false（调用方拒绝）。
fn builtin_rate_ok() -> bool {
    let mut q = match BUILTIN_CALLS.lock() {
        Ok(q) => q,
        Err(_) => return false, // 锁异常：宁可拒绝也不裸奔
    };
    let now = std::time::Instant::now();
    while q
        .front()
        .map(|t| now.duration_since(*t).as_secs() >= 60)
        .unwrap_or(false)
    {
        q.pop_front();
    }
    if q.len() >= BUILTIN_RATE_PER_MIN {
        return false;
    }
    q.push_back(now);
    true
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
        // 内置免费用应用内置公共 key、其余读用户密钥——这个判断已收口到
        // resolve_ai_key，不再在这里展开（以前只有这一处知道内置 key）。
        let key = resolve_ai_key(&app, &cfg)?;
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

    let classifier = ContentClassifier::new();

    // 用户手工标签（前端无条件传，用不用在这里一处决定）。
    // 关着就直接丢掉——不进 prompt、也不进下面的出网闸探针。
    let user_tags: Option<String> = if cfg.tags_as_context {
        opts.get("userTags")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    // 出网闸：内容像密钥就不发，等用户明确确认。
    // 本地厂商跳过——内容根本不出机器，再问一遍是白打断。
    // 用 `is_sensitive_for_egress`（密钥 + 个人信息）而不是 `is_secret`：
    // 后者管的是“要不要入库/排除”，这边管的是“要不要出网”——
    // 后者风险更高，阀值就应该更低，不能两边用同一个判据。
    //
    // **标签名必须一起扫**：tags_as_context 默认开，而标签名也会随内容发出去。
    // 只扫正文的话，一个叫“张三 13800138000”的标签会直接绕过这道门。
    let egress_probe = match &user_tags {
        Some(t) => format!("{}\n{}", text, t),
        None => text.clone(),
    };
    if !force && !spec.is_local() && classifier.is_sensitive_for_egress(&egress_probe) {
        return Ok(AiRunResponse::NeedsConfirm(AiRunNeedsConfirm {
            reason: "这段内容含敏感信息（密钥凭证，或手机号/邮箱/身份证/IP 这类个人信息）。发送到云端意味着它会离开这台电脑，确认要继续吗？"
                .to_string(),
        }));
    }

    // 内容类型与语言在后端当场算，不让前端传：这样它与入库时的分类用的是同一套判定，
    // 也不用为了一个字符串去改变换契约。
    // language 是同一批 labels 里的语言级标签（content_type 到 code 就到顶了）。
    let labels = classifier.classify(&text);
    let content_type = ContentClassifier::content_type_from_labels(&labels);
    let language = ContentClassifier::language_from_labels(&labels);

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
            let (s, u, m) = actions::build_prompt(
                &action_id,
                &text,
                &opts,
                actions::PromptCtx {
                    content_type: Some(content_type),
                    language,
                    user_tags: user_tags.as_deref(),
                },
            )?;
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
        // v6.9：内置免费额度 → token 配额 + 本地限流（替代金额预算，与自配服务商隔离）
        if spec.is_builtin_free() {
            if !builtin_rate_ok() {
                cache::inflight_done(&cache_key);
                return Err("免费额度请求太频繁，请稍后再试（每分钟最多 10 次）".to_string());
            }
            // 前置检查（余额 + 每日上限），细分原因给前端不同引导（v6.9 缺陷修复）
            match { app.state::<DataStore>().quota_check() } {
                Err(block) => {
                    cache::inflight_done(&cache_key);
                    let reason = match block {
                        crate::data_store::QuotaBlock::Exhausted => "exhausted",
                        crate::data_store::QuotaBlock::DailyCap => "dailyCap",
                    };
                    return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                        spent_cny: 0.0,
                        budget_cny: 0.0,
                        is_quota: true,
                        quota_reason: Some(reason.to_string()),
                    }));
                }
                Ok(_) => {}
            }
        } else {
            // 守卫限在这个块里：下面就是 await，DataStore 的锁不能活过去
            let today = { app.state::<DataStore>().ai_usage_today() };
            if let Err((spent_usd, budget_usd)) = budget::check(&today, cfg.daily_budget_usd()) {
                cache::inflight_done(&cache_key);
                return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                    spent_cny: spent_usd * provider::USD_TO_CNY,
                    budget_cny: budget_usd * provider::USD_TO_CNY,
                    is_quota: false,
                    quota_reason: None,
                }));
            }
        }
    }

    // M3 偏好学习：动作偏好指令拼进 system prompt（“译文更简洁”之类）。
    // 偏好变化会清缓存（action_pref_set 里 cache::clear()），这里无需担心旧缓存命中。
    // 在 await 前取好值，锁不跨 await。
    //
    // **偏好指令必须过上面同一道出网闸**：它是用户自由输入（LearningsDialog 的输入框），
    // 且与 `text` 进的是**同一个请求**——只拦 text 不拦 pref 等于大门锁了窗户开着。
    // 这也是 `profile_refine` / `profile_export` / `profile_install_skill` 三条路径
    // 已经在做的事（`sanitize_profile`），只是这条频率最高的路径一直漏了。
    //
    // 命中就**整条不拼**，而不是换成占位文案：占位文案拼进 prompt 对模型是纯噪声
    //（与 `build_refine_input` 剔除已被替换的偏好项同理）。
    // 本地厂商不过滤：内容根本不出机器，与上面出网闸的 `!spec.is_local()` 保持一致。
    let system = {
        let store = app.state::<DataStore>();
        let pref = store.action_pref_get(&action_id)?;
        compose_system_with_pref(system, &pref, spec.is_local(), &classifier)
    };

    let started = std::time::Instant::now();
    // v6.9 缺陷修复：内置免费服务商强制 max_tokens 下限（推理模型 reasoning 占 token）
    let mt = if spec.is_builtin_free() {
        max_tokens.max(BUILTIN_MAX_TOKENS_MIN)
    } else {
        max_tokens
    };

    // v6.10 流式：远程服务商逐块 emit（前端打字机）。本地(Ollama)无意义不发。
    // 闭包捕获 app + action_id，事件带 actionId 让前端结果卡对号入座。
    let stream_cb: Option<Box<dyn Fn(&str) + Send + Sync>> = if !spec.is_local() {
        let app2 = app.clone();
        let aid = action_id.clone();
        Some(Box::new(move |d: &str| {
            let _ = app2.emit(
                "ai-run-chunk",
                serde_json::json!({ "actionId": aid, "delta": d }),
            );
        }))
    } else {
        None
    };

    let result = crate::ai::chat(
        &cfg,
        &key,
        Some(system.as_str()),
        &user,
        Some(mt),
        stream_cb.as_deref(),
    )
    .await;
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

    // v6.9：内置免费额度成功调用后扣减 token（缓存命中已在上方 return，不扣）。
    // 前置检查已保证余额>0，扣减失败只可能是竞态/异常——不吞掉结果，只记日志。
    if spec.is_builtin_free() {
        let total = outcome.prompt_tokens as u64 + outcome.completion_tokens as u64;
        if let Err(e) = app.state::<DataStore>().quota_spend(total) {
            log::warn!("[Quota] 扣减失败（结果仍返回）：{}", e);
        }
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
        let key = resolve_ai_key(&app, &cfg)?;
        if cfg.spec().needs_key && key.is_empty() {
            return Err("尚未配置 API Key，先在上面填一个再试跑".to_string());
        }
        (cfg, key)
    };
    cfg.validate()?;
    let spec = cfg.spec();

    let classifier = ContentClassifier::new();
    if !force && !spec.is_local() && classifier.is_sensitive_for_egress(&text) {
        return Ok(AiRunResponse::NeedsConfirm(AiRunNeedsConfirm {
            reason: "试跑用的这段内容含敏感信息（密钥凭证，或手机号/邮箱/身份证/IP 这类个人信息）。发送到云端意味着它会离开这台电脑，确认要继续吗？"
                .to_string(),
        }));
    }
    let labels = classifier.classify(&text);
    let content_type = ContentClassifier::content_type_from_labels(&labels);

    let (system, user, mut mt) = actions::build_custom_prompt(
        &template,
        &text,
        max_tokens.unwrap_or(2000).clamp(50, 4000),
        Some(content_type),
    )?;
    // v6.9 缺陷修复：内置免费服务商强制 max_tokens 下限（推理模型 reasoning 占 token）
    if spec.is_builtin_free() {
        mt = mt.max(BUILTIN_MAX_TOKENS_MIN);
    }

    if !spec.is_local() {
        // v6.9 缺陷修复：试跑路径此前绕过内置免费配额（不限流/不查余额/不扣减）。
        // 与主路径对齐：限流 → 配额检查（细分原因）→ 成功后再扣减。
        if spec.is_builtin_free() {
            if !builtin_rate_ok() {
                return Err("免费额度请求太频繁，请稍后再试（每分钟最多 10 次）".to_string());
            }
            match { app.state::<DataStore>().quota_check() } {
                Err(block) => {
                    let reason = match block {
                        crate::data_store::QuotaBlock::Exhausted => "exhausted",
                        crate::data_store::QuotaBlock::DailyCap => "dailyCap",
                    };
                    return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                        spent_cny: 0.0,
                        budget_cny: 0.0,
                        is_quota: true,
                        quota_reason: Some(reason.to_string()),
                    }));
                }
                Ok(_) => {}
            }
        } else {
            let today = { app.state::<DataStore>().ai_usage_today() };
            if let Err((spent_usd, budget_usd)) = budget::check(&today, cfg.daily_budget_usd()) {
                return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                    spent_cny: spent_usd * provider::USD_TO_CNY,
                    budget_cny: budget_usd * provider::USD_TO_CNY,
                    is_quota: false,
                    quota_reason: None,
                }));
            }
        }
    }

    let started = std::time::Instant::now();
    // v6.10 流式：试跑也逐块 emit（编辑器里长模板迭代时打字机反馈）
    let stream_cb: Option<Box<dyn Fn(&str) + Send + Sync>> = if !spec.is_local() {
        let app2 = app.clone();
        Some(Box::new(move |d: &str| {
            let _ = app2.emit(
                "ai-run-chunk",
                serde_json::json!({ "actionId": "custom-preview", "delta": d }),
            );
        }))
    } else {
        None
    };
    let result = crate::ai::chat(
        &cfg,
        &key,
        Some(system.as_str()),
        &user,
        Some(mt),
        stream_cb.as_deref(),
    )
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;

    // 试跑也进用量明细：它花的是同一份预算，不记就对不上账
    match result {
        Ok(o) => {
            // v6.9 缺陷修复：试跑路径补内置免费额度扣减（此前绕过，白嫖后门）
            if spec.is_builtin_free() {
                let total = o.prompt_tokens as u64 + o.completion_tokens as u64;
                if let Err(e) = app.state::<DataStore>().quota_spend(total) {
                    log::warn!("[Quota] 试跑扣减失败（结果仍返回）：{}", e);
                }
            }
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

/// 把动作偏好拼进 system prompt。
///
/// 从 `ai_run` 里抽出来的理由与 [`build_refine_input`]（profile.rs）相同：
/// 原命令是 `async` 且要 `AppHandle`，没法单测；而这里决定的是
/// **到底把哪些字节发给第三方**，是隐私红线，必须有测试盯着。
fn compose_system_with_pref(
    system: String,
    pref: &str,
    is_local: bool,
    classifier: &ContentClassifier,
) -> String {
    // 本地厂商（Ollama）不过滤：内容根本不出机器，与出网闸的 `!spec.is_local()` 一致
    if pref.is_empty() || (!is_local && classifier.is_sensitive_for_egress(pref)) {
        return system;
    }
    format!("{}\n\n用户偏好：{}", system, pref)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYS: &str = "你是一个翻译助手";

    fn compose(pref: &str, is_local: bool) -> String {
        compose_system_with_pref(SYS.to_string(), pref, is_local, &ContentClassifier::new())
    }

    #[test]
    fn test_empty_pref_keeps_system_unchanged() {
        assert_eq!(compose("", false), SYS);
    }

    #[test]
    fn test_normal_pref_is_appended() {
        let out = compose("译文更简洁", false);
        assert!(out.starts_with(SYS));
        assert!(out.contains("译文更简洁"));
    }

    /// 核心回归：偏好里的密钥曾经会跟着请求一起发给云端第三方。
    /// `text` 有出网闸、`pref` 没有，而两者进的是同一个请求。
    #[test]
    fn test_secret_pref_is_dropped_for_remote() {
        let pref = concat!("sk-", "abcdef1234567890abcdef1234567890");
        assert_eq!(compose(pref, false), SYS, "含密钥的偏好不得拼进出网的 system");
    }

    #[test]
    fn test_pii_pref_is_dropped_for_remote() {
        // 与出网闸同一判据：is_sensitive_for_egress = is_secret || has_pii
        let pref = "签名用我的邮箱 zhangsan@example.com";
        assert_eq!(compose(pref, false), SYS, "含个人信息的偏好不得出网");
    }

    /// 本地厂商不出网，不该为了隐私而牺牲功能。
    #[test]
    fn test_secret_pref_kept_for_local_provider() {
        let pref = concat!("sk-", "abcdef1234567890abcdef1234567890");
        let out = compose(pref, true);
        assert!(out.contains(pref), "本地厂商应照常拼接（内容不离开这台电脑）");
    }
}
