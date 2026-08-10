//! 云端 AI 命令层。
//!
//! **这里没有 `ai_get_key`，也不会有。** 密钥只能写入 / 查存在 / 清除，
//! 前端拿不到明文。界面上想展示“已配置”就用 [`ai_has_key`]。
//!
//! **密钥按厂商分开存**（`ai_key_<厂商>.bin`）：切厂商时不用重新输入，
//! 已存的会自动生效。同一时刻仍然只有一个厂商生效。
//!
//! 配置（厂商 / 地址 / 模型 / 预算 / 协议）走普通的 `config` 表——它们不是秘密，
//! 进备份也无妨。只有 Key 走 [`crate::ai::secret_store`]。

use crate::ai::actions::{self, AiAction};
use crate::ai::provider::{self, ProviderSpec};
use crate::ai::{budget, cache, secret_store, AiConfig};
use crate::content_classifier::ContentClassifier;
use crate::data_store::{
    AiUsageByAction, AiUsageDaily, AiUsageEntry, AiUsageLogRow, CustomAction, DataStore,
};
use md5::{Digest, Md5};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Manager, State};

/// 密钥与数据库同目录。
fn ai_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
}

/// 从 config 表读出 AI 配置；缺字段一律回退默认值，不报错。
fn read_ai_config(store: &DataStore) -> Result<AiConfig, String> {
    let raw = store.get_config()?;
    let d = AiConfig::default();
    let s = |key: &str| -> String {
        raw.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(AiConfig {
        enabled: raw
            .get("ai_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(d.enabled),
        provider: {
            let p = s("ai_provider");
            if p.is_empty() { d.provider } else { p }
        },
        base_url: s("ai_base_url"),
        model: s("ai_model"),
        protocol: s("ai_protocol"),
        daily_budget_cny: raw
            .get("ai_daily_budget_cny")
            .and_then(|v| v.as_f64())
            .unwrap_or(d.daily_budget_cny),
        timeout_secs: raw
            .get("ai_timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(d.timeout_secs),
        thinking_off: raw
            .get("ai_thinking_off")
            .and_then(|v| v.as_bool())
            .unwrap_or(d.thinking_off),
    })
}

/// 写回 config 表。单独抽出来是因为几个命令都要用。
fn write_ai_config(store: &DataStore, cfg: &AiConfig) -> Result<(), String> {
    let mut raw = store.get_config()?;
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("ai_enabled".to_string(), Value::Bool(cfg.enabled));
        obj.insert("ai_provider".to_string(), Value::String(cfg.provider.clone()));
        obj.insert(
            "ai_base_url".to_string(),
            Value::String(cfg.base_url.trim().to_string()),
        );
        obj.insert(
            "ai_model".to_string(),
            Value::String(cfg.model.trim().to_string()),
        );
        obj.insert(
            "ai_protocol".to_string(),
            Value::String(cfg.protocol.trim().to_string()),
        );
        obj.insert("ai_daily_budget_cny".to_string(), json!(cfg.daily_budget_cny));
        obj.insert("ai_timeout_secs".to_string(), json!(cfg.timeout_secs));
        obj.insert("ai_thinking_off".to_string(), json!(cfg.thinking_off));
    }
    store.save_config(&raw)
}

/// 读取 AI 配置（不含 Key）。
#[tauri::command]
pub fn ai_get_config(store: State<DataStore>) -> Result<AiConfig, String> {
    read_ai_config(&store)
}

/// 保存 AI 配置。
///
/// 故意**不**做完整性校验：用户可能先选厂商再填地址，中间态应该能存住。
/// 真正的校验在 [`ai_test_connection`] 和每次调用时做。
#[tauri::command]
pub fn ai_set_config(store: State<DataStore>, config: AiConfig) -> Result<(), String> {
    let mut cfg = config;
    // 超时太短会把正常回答切断，太长等于卡死界面；夹到合理区间
    cfg.timeout_secs = cfg.timeout_secs.clamp(5, 300);
    if !cfg.daily_budget_cny.is_finite() || cfg.daily_budget_cny < 0.0 {
        cfg.daily_budget_cny = 0.0;
    }

    // 厂商/模型/地址/协议一变，旧结果就不再代表当前配置——不清会拿旧模型的产物充数。
    // thinking_off 同理：开与不开思考，同一段输入的产物可能完全不同。
    let old = read_ai_config(&store)?;
    if old.provider != cfg.provider
        || old.effective_model() != cfg.effective_model()
        || old.effective_base_url() != cfg.effective_base_url()
        || old.effective_protocol() != cfg.effective_protocol()
        || old.thinking_off != cfg.thinking_off
    {
        cache::clear();
    }

    write_ai_config(&store, &cfg)
}

/// 取要操作的厂商 id：前端显式指定优先，否则用当前生效的。
fn target_provider(
    app: &tauri::AppHandle,
    explicit: Option<String>,
) -> Result<String, String> {
    if let Some(p) = explicit {
        if !p.trim().is_empty() {
            return Ok(provider::find(&p).id.to_string());
        }
    }
    let store = app.state::<DataStore>();
    Ok(read_ai_config(&store)?.spec().id.to_string())
}

/// 写入密钥（传空串等于清除）。不指定厂商时写给当前选中的那家。
#[tauri::command]
pub fn ai_set_key(
    app: tauri::AppHandle,
    key: String,
    provider: Option<String>,
) -> Result<(), String> {
    let p = target_provider(&app, provider)?;
    secret_store::save_key(&ai_data_dir(&app)?, &p, &key)
}

/// 是否已配置可用的密钥。只返回布尔值，不返回密钥本身。
#[tauri::command]
pub fn ai_has_key(app: tauri::AppHandle, provider: Option<String>) -> Result<bool, String> {
    let p = target_provider(&app, provider)?;
    Ok(secret_store::has_key(&ai_data_dir(&app)?, &p))
}

/// 删除已保存的密钥。
#[tauri::command]
pub fn ai_clear_key(app: tauri::AppHandle, provider: Option<String>) -> Result<(), String> {
    let p = target_provider(&app, provider)?;
    secret_store::clear_key(&ai_data_dir(&app)?, &p)
}

/// 厂商预设 + “这家是否已存密钥”。
///
/// 放在后端是为了避免前后端各维护一张表、又对不上。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    #[serde(flatten)]
    pub spec: &'static ProviderSpec,
    /// 界面据此在下拉里标“已配置”，告诉用户切过去不用重输密钥。
    pub has_key: bool,
    /// 这家能不能“关掉思考”。前端据此决定要不要显示那个开关——
    /// 摆一个点了没反应的开关，比不摆更坏。
    ///
    /// 同样放后端算：前端再维一份厂商 id 名单，两边必定会分叉。
    pub supports_thinking_off: bool,
}

#[tauri::command]
pub fn ai_list_providers(app: tauri::AppHandle) -> Result<Vec<ProviderInfo>, String> {
    let dir = ai_data_dir(&app)?;
    let configured = secret_store::configured_providers(&dir);
    Ok(provider::PROVIDERS
        .iter()
        .map(|spec| ProviderInfo {
            spec,
            has_key: configured.iter().any(|id| id == spec.id),
            supports_thinking_off: spec.thinking_control()
                != provider::ThinkingControl::Unsupported,
        })
        .collect())
}

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
        let key = secret_store::load_key(&dir, cfg.spec().id)?.unwrap_or_default();
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

// ===== 动作执行 =====

/// 可用动作清单（含选项规格，前端据此自动生成 chip）。仅内置；自定义走 [`ai_list_custom_actions`]。
#[tauri::command]
pub fn ai_list_actions() -> Vec<AiAction> {
    actions::ACTIONS.to_vec()
}

// ===== 自定义动作 =====

/// 编辑器里可选的“适用内容类型”。
///
/// 从后端拿而不是前端写一份：同一张表在两边各维护，加一类就得改两处。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeOption {
    pub id: &'static str,
    pub label: &'static str,
}

#[tauri::command]
pub fn ai_list_content_types() -> Vec<ContentTypeOption> {
    actions::SELECTABLE_CONTENT_TYPES
        .iter()
        .map(|(id, label)| ContentTypeOption { id, label })
        .collect()
}

#[tauri::command]
pub fn ai_list_custom_actions(store: State<DataStore>) -> Result<Vec<CustomAction>, String> {
    store.ai_custom_actions()
}

/// 新建或更新自定义动作，返回最终 id。
///
/// 两条属于 AI 层的校验在这里做（数据层不认识 `crate::ai`）：
/// 模板必含内容占位符、不能与内置动作重名。
#[tauri::command]
pub fn ai_save_custom_action(
    store: State<DataStore>,
    action: CustomAction,
) -> Result<String, String> {
    actions::validate_template(&action.template)?;

    let name = action.name.trim();
    if let Some(hit) = actions::ACTIONS.iter().find(|a| a.label == name) {
        return Err(format!(
            "“{}”是内置动作的名字，换一个吧",
            hit.label
        ));
    }

    // 选了不存在的内容类型 → 这个动作将永远不会出现，而用户看不出来
    for ct in &action.content_types {
        if !actions::SELECTABLE_CONTENT_TYPES.iter().any(|(id, _)| id == ct) {
            return Err(format!("不认识的内容类型：{}", ct));
        }
    }

    let id = store.ai_custom_action_save(&action)?;
    // 模板可能变了，旧结果不再代表当前配置。缓存键里虽然拌了模板哈希（已够），
    // 这里再清一把是为了连“改了名字/适用类型”这种不影响哈希的改动也给个干净状态
    cache::clear();
    Ok(id)
}

#[tauri::command]
pub fn ai_delete_custom_action(store: State<DataStore>, id: String) -> Result<(), String> {
    store.ai_custom_action_delete(&id)
}

#[tauri::command]
pub fn ai_reorder_custom_actions(
    store: State<DataStore>,
    ids: Vec<String>,
) -> Result<(), String> {
    store.ai_custom_actions_reorder(&ids)
}

/// 模板指纹，拌进缓存键。
///
/// **不拌就是个真 bug**：自定义动作的 id 在编辑前后不变，改完模板再跑会直接
/// 命中旧结果，用户会以为自己的修改没生效。
fn template_fingerprint(template: &str) -> String {
    let digest = Md5::new().chain_update(template.as_bytes()).finalize();
    format!("{:x}", digest)[..8].to_string()
}

/// 当日用量 + 换算好的展示字段。
///
/// **人民币在后端换算**：汇率常量只应存在一份，前端再乘一次就成了第二个数据源，
/// 改汇率时必然漏掉一边。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageInfo {
    #[serde(flatten)]
    pub usage: AiUsageDaily,
    /// 估算花费（人民币）。注意是**估算值**，真实金额以厂商账单为准。
    pub cost_cny: f64,
    /// 当前日预算（人民币），0 表示不限制。
    pub budget_cny: f64,
    /// 预算内大约还能调用多少次；不限制或本地厂商时为 null。
    pub remaining_calls: Option<u32>,
}

#[tauri::command]
pub fn ai_get_usage(store: State<DataStore>) -> Result<AiUsageInfo, String> {
    let cfg = read_ai_config(&store)?;
    let usage = store.ai_usage_today();
    Ok(AiUsageInfo {
        cost_cny: usage.cost_usd * provider::USD_TO_CNY,
        budget_cny: cfg.daily_budget_cny,
        remaining_calls: budget::estimate_remaining_calls(
            cfg.spec(),
            &usage,
            cfg.daily_budget_usd(),
        ),
        usage,
    })
}

/// 最近的调用明细。
///
/// **里面没有任何内容文本**——表里根本没那个字段。只有时间、动作、模型、
/// token 数与成败。
#[tauri::command]
pub fn ai_list_usage_log(
    store: State<DataStore>,
    limit: Option<u32>,
) -> Result<Vec<AiUsageLogRow>, String> {
    store.ai_usage_recent(limit.unwrap_or(50))
}

/// 按动作聚合 + 换算好的人民币。
///
/// 汇率只在后端乘一次，前端拿到的就是最终值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionCost {
    #[serde(flatten)]
    pub inner: AiUsageByAction,
    pub cost_cny: f64,
}

/// 一段时间的用量统计。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageStats {
    pub days: u32,
    /// 按天，升序；**缺的天不补 0**。
    pub daily: Vec<AiUsageDaily>,
    /// 按动作，花费降序。
    pub by_action: Vec<AiActionCost>,
    pub total_calls: u32,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_cost_cny: f64,
    /// 缓存命中率（0~1）。省下的钱直接体现在它上面。
    pub cache_hit_rate: f64,
}

#[tauri::command]
pub fn ai_get_usage_stats(
    store: State<DataStore>,
    days: Option<u32>,
) -> Result<AiUsageStats, String> {
    let days = days.unwrap_or(7).clamp(1, 90);
    let daily = store.ai_usage_daily(days)?;
    let by_action: Vec<AiActionCost> = store
        .ai_usage_by_action(days)?
        .into_iter()
        .map(|a| AiActionCost {
            cost_cny: a.cost_usd * provider::USD_TO_CNY,
            inner: a,
        })
        .collect();

    let total_calls: u32 = daily.iter().map(|d| d.calls).sum();
    let cached: u32 = daily.iter().map(|d| d.cached_calls).sum();
    let total_cost_usd: f64 = daily.iter().map(|d| d.cost_usd).sum();

    Ok(AiUsageStats {
        days,
        total_calls,
        total_prompt_tokens: daily.iter().map(|d| d.prompt_tokens).sum(),
        total_completion_tokens: daily.iter().map(|d| d.completion_tokens).sum(),
        total_cost_cny: total_cost_usd * provider::USD_TO_CNY,
        cache_hit_rate: if total_calls == 0 {
            0.0
        } else {
            cached as f64 / total_calls as f64
        },
        daily,
        by_action,
    })
}

/// 清空调用明细。这份账是用户的，必须能一键删掉。
#[tauri::command]
pub fn ai_clear_usage_log(store: State<DataStore>) -> Result<u32, String> {
    store.ai_usage_clear()
}

/// 记一笔用量明细。
///
/// 故意不返回错误：统计写不进去不应该影响用户拿到的调用结果。
/// 单独抽出来还有个原因：它是同步函数，能保证 `State` 守卫不会跨越 await。
fn record_usage(app: &tauri::AppHandle, entry: AiUsageEntry) {
    app.state::<DataStore>().ai_usage_add(&entry);
}

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
        let key = secret_store::load_key(&dir, cfg.spec().id)?.unwrap_or_default();
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

    // 本地厂商零费用，不受预算约束
    if !spec.is_local() {
        // 守卫限在这个块里：下面就是 await，DataStore 的锁不能活过去
        let today = { app.state::<DataStore>().ai_usage_today() };
        if let Err((spent_usd, budget_usd)) = budget::check(&today, cfg.daily_budget_usd()) {
            return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                spent_cny: spent_usd * provider::USD_TO_CNY,
                budget_cny: budget_usd * provider::USD_TO_CNY,
            }));
        }
    }

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
        cache::put(
            cache_key,
            cache::CachedValue {
                content: outcome.content.clone(),
                model: outcome.model.clone(),
            },
        );
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
        let key = secret_store::load_key(&dir, cfg.spec().id)?.unwrap_or_default();
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
