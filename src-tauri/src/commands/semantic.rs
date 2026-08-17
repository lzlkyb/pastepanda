//! 语义索引命令层（M5-2）：摘要 → 云端 embedding → 本地向量 → 余弦检索。
//!
//! 与 ai_run 同一套纪律：
//! - **原文不出本机**——出网的只有摘要（M5-1 已做敏感过滤）与搜索词（出网前再查一次 is_secret）；
//! - 每次出网**过日预算**，token 记入用量明细；
//! - 开关（`mem_enhance_enabled`）默认关；关时搜索自动退回 FTS5，功能不缺失。
//!
//! 索引是**懒构建**的：`semantic_search` 前自动补齐最多 200 条未向量化的摘要，
//! 设置页也有「立即建立索引」按钮（`semantic_index`）。

use crate::ai::provider;
use crate::ai::{budget, client, AiConfig};
use crate::content_classifier::ContentClassifier;
use crate::data_store::AiUsageEntry;
use crate::data_store::DataStore;
use serde::Serialize;
use tauri::{Manager, State};

/// 每次搜索前自动补齐的条数上限（一次 embedding 请求量控制）。
const PENDING_BATCH: i64 = 200;
/// 手动索引 / 自动补齐时单次 embedding 请求的文本条数。
const EMBED_BATCH: usize = 20;

/// 本轮 embedding 是否已触及日预算。
///
/// **必须在批处理循环内逐批测**。循环外的 `budget::check` 只是“进门查”：
/// `semantic_index` 的 limit 上限 2000、`EMBED_BATCH` = 20，一次检查之后最多
/// 能发 100 次请求；`semantic_search` 的自动补齐是 10 次。那等于用户设的
/// 预算上限在这条路径上形同虚设（而 `ai_run` 那边是一次调用一次检查，很紧）。
///
/// **为什么不重查数据库**：用量是整轮结束后一次性记账的，循环期间
/// `ai_usage_daily` 还是旧值，重查等于没查。所以用“库里的今日花费
/// + 本轮本地累计估算”来判。
///
/// 预算 ≤ 0 表示不限制。
fn budget_crossed(cfg: &AiConfig, today_cost_usd: f64, prompt_tokens: u32) -> bool {
    let cap = cfg.daily_budget_usd();
    if cap <= 0.0 {
        return false;
    }
    today_cost_usd + budget::estimate_cost(cfg.spec(), prompt_tokens, 0) >= cap
}

/// 语义索引状态（设置页「AI 记忆增强」区展示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    /// AI 记忆增强总开关（默认关）。
    pub enabled: bool,
    /// 当前 AI 主配置的厂商 id。
    pub provider: String,
    /// 该厂商是否支持 embedding（决定索引可用性）。
    pub provider_supports: bool,
    /// 实际生效的 embedding 模型名。
    pub model: String,
    /// 厂商默认 embedding 模型（设置页提示用；为空表示该厂商不支持）。
    pub default_model: String,
    /// 已入库向量条数。
    pub vector_count: u32,
    /// 待补齐（有摘要无向量）条数。
    pub pending: u32,
}

/// 一次补齐的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndexResult {
    pub indexed: u32,
    pub pending_left: u32,
}

/// 一条语义命中（text 是本机历史全文，直接可展示/复制；不出网）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHit {
    pub history_id: String,
    /// 余弦相似度 0~1。
    pub score: f32,
    /// 命中条目的检索摘要（含正文头 80 字，足够预览）。
    pub summary: String,
    pub created_at: String,
    pub text: String,
}

fn read_mem_config(store: &DataStore) -> (bool, String) {
    let raw = store.get_config().unwrap_or_default();
    let enabled = raw
        .get("mem_enhance_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let model = raw
        .get("mem_embed_model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    (enabled, model)
}

/// 解析实际生效的 embedding 模型：优先用户覆盖，否则用厂商默认。
/// 返回 `(model, dim)`；厂商不支持且无覆盖时返回 Err（可读中文）。
fn resolve_embed_model(cfg: &AiConfig, override_model: &str) -> Result<(String, usize), String> {
    if !override_model.is_empty() {
        return Ok((override_model.to_string(), 0));
    }
    match provider::embedding_model_for(&cfg.provider) {
        Some((m, dim)) => Ok((m.to_string(), dim)),
        None => Err(format!(
            "当前服务商 {} 不支持 embedding（没有 /embeddings 接口）。\
             可换 OpenAI 兼容厂商（OpenAI / 智谱 / 通义 / 硅基流动 / 火山 / 混元），\
             或在高级设置里填一个中转的 embedding 模型名",
            cfg.spec().name
        )),
    }
}

/// 写语义索引配置（开关 + 模型覆盖）。模型留空 = 用厂商默认。
#[tauri::command]
pub fn semantic_set_config(
    store: State<DataStore>,
    enabled: bool,
    model: Option<String>,
) -> Result<(), String> {
    let mut raw = store.get_config()?;
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("mem_enhance_enabled".to_string(), serde_json::Value::Bool(enabled));
        if let Some(m) = model {
            obj.insert("mem_embed_model".to_string(), serde_json::Value::String(m.trim().to_string()));
        }
    }
    store.save_config(&raw)?;
    Ok(())
}

/// 语义索引状态（不触发任何出网）。
#[tauri::command]
pub fn semantic_status(store: State<DataStore>) -> Result<SemanticStatus, String> {
    let cfg = crate::commands::ai::read_ai_config(&store)?;
    let (enabled, override_model) = read_mem_config(&store);
    let (model, _) = resolve_embed_model(&cfg, &override_model).unwrap_or_else(|e| {
        // 厂商不支持时 model 留空，错误由 provider_supports=false 表达
        let _ = e;
        (String::new(), 0)
    });
    let (default_model, _) = provider::embedding_model_for(&cfg.provider)
        .map(|(m, d)| (m.to_string(), d))
        .unwrap_or_default();
    let supports = !default_model.is_empty() || !override_model.is_empty();
    Ok(SemanticStatus {
        enabled,
        provider: cfg.provider.clone(),
        provider_supports: supports,
        model,
        default_model,
        vector_count: store.semantic_vectors_count()?,
        pending: store.semantic_vector_pending_count()?,
    })
}

/// 补齐语义索引（把有摘要但没向量的历史向量化）。可手动触发。
#[tauri::command]
pub async fn semantic_index(
    app: tauri::AppHandle,
    store: State<'_, DataStore>,
    limit: Option<i64>,
) -> Result<SemanticIndexResult, String> {
    let limit = limit.unwrap_or(PENDING_BATCH).clamp(1, 2000);
    let (enabled, override_model) = read_mem_config(&store);
    if !enabled {
        return Err("AI 记忆增强未开启——先在 AI 设置里打开开关".to_string());
    }
    let cfg = crate::commands::ai::read_ai_config(&store)?;
    // 红线（claude.md 规则 16）：所有 AI/云端路径必须受主开关 cfg.enabled 门控，
    // 否则「主 AI 关、记忆增强开」时仍会出网调用 embedding 端点。
    if !cfg.enabled {
        return Err("AI 功能未启用——请先在 AI 设置中打开总开关".to_string());
    }
    let (model, _) = resolve_embed_model(&cfg, &override_model)?;
    if cfg.effective_protocol() != crate::ai::provider::Protocol::OpenAi {
        return Err("当前服务商不是 OpenAI 兼容协议，没有 /embeddings 接口".to_string());
    }
    // 走统一的密钥解析：内置免费（Agnes）没有用户密钥文件，
    // 直接 load_key 会拿到空字串、带空密钥出网
    let key = crate::commands::ai::resolve_ai_key(&app, &cfg)?;
    if cfg.spec().needs_key && key.trim().is_empty() {
        return Err("未配置当前服务商的 API Key".to_string());
    }

    // 预算检查（embedding 也计费）
    let today = store.ai_usage_daily(1)?;
    let today_row = today.first().cloned().unwrap_or_default();
    if let Err((spent, budget_usd)) = budget::check(&today_row, cfg.daily_budget_usd()) {
        return Err(format!(
            "今日预算已用完（已用 ${:.2}，上限 ${:.2}）——语义索引需要出网计费",
            spent, budget_usd
        ));
    }

    let pending = store.semantic_vector_pending(limit)?;
    let mut indexed = 0u32;
    let started = std::time::Instant::now();
    let mut prompt_tokens = 0u32;
    let mut ok = true;
    let mut error: Option<String> = None;

    for chunk in pending.chunks(EMBED_BATCH) {
        let texts: Vec<String> = chunk.iter().map(|(_, s)| s.clone()).collect();
        match client::embedding(&cfg, &key, &model, &texts).await {
            Ok(out) => {
                for ((id, _), vec) in chunk.iter().zip(out.vectors.iter()) {
                    if let Err(e) = store.semantic_vector_set(id, &out.model, vec) {
                        error = Some(e);
                        ok = false;
                        break;
                    }
                }
                indexed += chunk.len() as u32;
                prompt_tokens += out.prompt_tokens;
                if error.is_some() {
                    break;
                }
                // 跨线就停，不报错：未完成的会落到 pending_left，下次接着补。
                if budget_crossed(&cfg, today_row.cost_usd, prompt_tokens) {
                    log::info!("[语义索引] 触及日预算，本轮停在 {} 条", indexed);
                    break;
                }
            }
            Err(e) => {
                error = Some(e.to_string());
                ok = false;
                break;
            }
        }
    }

    // 记账：无论成败都记（对得上服务商后台）
    record_semantic_usage(
        &app,
        &cfg,
        &model,
        "semantic-index",
        prompt_tokens,
        ok,
        error.clone(),
        started.elapsed().as_millis() as u64,
    );

    if !ok {
        return Err(error.unwrap_or_else(|| "索引失败".to_string()));
    }
    Ok(SemanticIndexResult {
        indexed,
        pending_left: store.semantic_vector_pending_count()?,
    })
}

/// 语义搜索：先补齐 pending（懒构建），再向量化查询词，余弦 top-k。
/// 失败（未开启 / 厂商不支持 / 出网失败）返回 Err，由前端回退 FTS5 关键词搜索。
#[tauri::command]
pub async fn semantic_search(
    app: tauri::AppHandle,
    store: State<'_, DataStore>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("搜索词为空".to_string());
    }
    let (enabled, override_model) = read_mem_config(&store);
    if !enabled {
        return Err("AI 记忆增强未开启——先在 AI 设置里打开开关".to_string());
    }
    // 红线（claude.md 规则 16）：主 AI 开关未启用时不得出网做 embedding 检索。
    let cfg = crate::commands::ai::read_ai_config(&store)?;
    if !cfg.enabled {
        return Err("AI 功能未启用——请先在 AI 设置中打开总开关".to_string());
    }
    // 搜索词也要过敏感防护：密钥与个人信息都不该出网。
    // 用 is_sensitive_for_egress 而不是 is_secret：本命令确实会把 query 发去云端做 embedding，
    // 而下面那句报错本身就写着“不会发送到云端”——它就是个出网口。
    let classifier = ContentClassifier::new();
    if classifier.is_sensitive_for_egress(&query) {
        return Err(
            "搜索词含敏感信息（密钥或个人信息），已拦截——语义搜索不会把它们发送到云端"
                .to_string(),
        );
    }

    let cfg = crate::commands::ai::read_ai_config(&store)?;
    let (model, _) = resolve_embed_model(&cfg, &override_model)?;
    let key = crate::commands::ai::resolve_ai_key(&app, &cfg)?;

    // 懒构建：先把没向量化的摘要补上（最多一批），再搜索
    let pending = store.semantic_vector_pending(PENDING_BATCH)?;
    if !pending.is_empty() {
        // 预算检查（embedding 也计费）
        let today = store.ai_usage_daily(1)?;
        let today_row = today.first().cloned().unwrap_or_default();
        if let Err((spent, budget_usd)) = budget::check(&today_row, cfg.daily_budget_usd()) {
            return Err(format!(
                "今日预算已用完（已用 ${:.2}，上限 ${:.2}）——语义搜索需要出网计费",
                spent, budget_usd
            ));
        }
        let mut prompt_tokens = 0u32;
        let mut indexed_ok = true;
        let started = std::time::Instant::now();
        for chunk in pending.chunks(EMBED_BATCH) {
            let texts: Vec<String> = chunk.iter().map(|(_, s)| s.clone()).collect();
            match client::embedding(&cfg, &key, &model, &texts).await {
                Ok(out) => {
                    for ((id, _), vec) in chunk.iter().zip(out.vectors.iter()) {
                        let _ = store.semantic_vector_set(id, &out.model, vec);
                    }
                    prompt_tokens += out.prompt_tokens;
                    // 同 `semantic_index`：预算得逐批测，不能只靠循环外那一次。
                    // 这里停下来不影响搜索本身——补齐是附带的，已建好的向量照用。
                    if budget_crossed(&cfg, today_row.cost_usd, prompt_tokens) {
                        log::info!("[语义搜索] 自动补齐触及日预算，本轮提前停止");
                        break;
                    }
                }
                Err(e) => {
                    record_semantic_usage(
                        &app,
                        &cfg,
                        &model,
                        "semantic-index",
                        prompt_tokens,
                        false,
                        Some(e.to_string()),
                        started.elapsed().as_millis() as u64,
                    );
                    indexed_ok = false;
                    break;
                }
            }
        }
        if indexed_ok {
            record_semantic_usage(
                &app,
                &cfg,
                &model,
                "semantic-index",
                prompt_tokens,
                true,
                None,
                started.elapsed().as_millis() as u64,
            );
        }
    }

    // 查询词 → 向量（单条，也计预算）
    let today = store.ai_usage_daily(1)?;
    let today_row = today.first().cloned().unwrap_or_default();
    if let Err((spent, budget_usd)) = budget::check(&today_row, cfg.daily_budget_usd()) {
        return Err(format!(
            "今日预算已用完（已用 ${:.2}，上限 ${:.2}）",
            spent, budget_usd
        ));
    }
    let started = std::time::Instant::now();
    let qvec = match client::embedding(&cfg, &key, &model, &[query.clone()]).await {
        Ok(out) => {
            record_semantic_usage(
                &app,
                &cfg,
                &model,
                "semantic-search",
                out.prompt_tokens,
                true,
                None,
                started.elapsed().as_millis() as u64,
            );
            out.vectors.into_iter().next().unwrap_or_default()
        }
        Err(e) => {
            record_semantic_usage(
                &app,
                &cfg,
                &model,
                "semantic-search",
                0,
                false,
                Some(e.to_string()),
                started.elapsed().as_millis() as u64,
            );
            return Err(format!("语义搜索失败（已退回关键词搜索）：{e}"));
        }
    };
    if qvec.is_empty() {
        return Err("语义搜索失败：返回了空向量（已退回关键词搜索）".to_string());
    }

    let top_k = limit.unwrap_or(10).clamp(1, 50);
    let hits = store.semantic_search_vectors(&qvec, top_k)?;
    let mut out = Vec::with_capacity(hits.len());
    for (history_id, score, created_at, text) in hits {
        let summary = store.history_summary(&history_id)?;
        out.push(SemanticHit {
            history_id,
            score,
            summary,
            created_at,
            text,
        });
    }
    Ok(out)
}

fn record_semantic_usage(
    app: &tauri::AppHandle,
    cfg: &AiConfig,
    model: &str,
    action_id: &str,
    prompt_tokens: u32,
    ok: bool,
    error: Option<String>,
    latency_ms: u64,
) {
    let spec = cfg.spec();
    let cost_usd = budget::estimate_cost(spec, prompt_tokens, 0);
    app.state::<DataStore>()
        .ai_usage_add(&AiUsageEntry {
            action_id: action_id.to_string(),
            provider: spec.id.to_string(),
            model: model.to_string(),
            prompt_tokens,
            completion_tokens: 0,
            cost_usd,
            cached: false,
            latency_ms,
            ok,
            error,
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `budget_crossed` 现在同时把守 `semantic_index` 与 `semantic_search` 的补齐循环，
    /// 是唯一的逐批预算闸门，行为得钉住。
    #[test]
    fn test_budget_crossed_semantics() {
        let mut cfg = AiConfig::default();

        // 预算 ≤ 0 = 不限制：无论花了多少都不该拦
        cfg.daily_budget_cny = 0.0;
        assert!(!budget_crossed(&cfg, 999.0, 1_000_000));

        // 设 7.2 元 ≈ $1（USD_TO_CNY = 7.2）
        cfg.daily_budget_cny = 7.2;
        assert!((cfg.daily_budget_usd() - 1.0).abs() < 1e-9);

        // 今日已花 $0，本轮 0 token → 没跨线
        assert!(!budget_crossed(&cfg, 0.0, 0));

        // 今日已花超过上限 → 跨线（哪怕本轮一个 token 都没用）
        assert!(budget_crossed(&cfg, 1.5, 0));

        // 关键用例：库里的今日花费尚未越线，靠**本轮本地累计**才越线。
        // 这正是循环外那一次 budget::check 拦不住的情况——用量要等整轮结束才记账。
        let spec = cfg.spec();
        let tokens_for_one_usd = {
            // 找一个能让估算费用超过剩余额度的 token 数
            let mut t = 1_000u32;
            while budget::estimate_cost(spec, t, 0) < 0.5 && t < 1_000_000_000 {
                t = t.saturating_mul(2);
            }
            t
        };
        assert!(
            budget_crossed(&cfg, 0.6, tokens_for_one_usd),
            "已花 $0.6 + 本轮估算 ≥$0.5 应当越过 $1 上限"
        );
    }
}
