//! AI 用量账的命令层：当日汇总、明细列表、按动作聚合、清空。
//!
//! 从 `commands/ai.rs`（曾 1282 行）拆出。用 `use super::*` 继承父模块的导入——
//! Rust 子模块能看到父模块的私有项，所以拆分不需要动任何可见性。

use super::*;

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
pub(crate) fn record_usage(app: &tauri::AppHandle, entry: AiUsageEntry) {
    app.state::<DataStore>().ai_usage_add(&entry);
}
