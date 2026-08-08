//! 日预算判定与花费估算。
//!
//! **这里没有状态**：用量存在 SQLite 的 `ai_usage_log`（见 `data_store/ai_usage.rs`），
//! 这个模块只做纯计算。
//!
//! 早先用过一个独立的 `ai_usage.json`，已废弃：两个数据源迟早对不上，
//! 而且它只有当日汇总，答不了“每次用了多少 token”。之所以当初没直接进库，
//! 是因为担心走 `config` 表会触发备份；现在它有自己的表，那个顾虑不存在了。
//!
//! **关于估算精度**：单价表是各家公开价的近似值，会随时间漂移，且不包含
//! 缓存命中折扣。它的用途是**拦住失控的连续调用**，不是对账。真实金额以厂商
//! 账单为准，所以同时把原始 token 数也暴露出去。

use super::provider::ProviderSpec;
use crate::data_store::AiUsageDaily;
use std::path::Path;

/// 一次剪贴板动作的经验 token 量（输入 / 输出）。仅在**没有任何历史**时用来估算次数。
const TYPICAL_PROMPT_TOKENS: u32 = 600;
const TYPICAL_COMPLETION_TOKENS: u32 = 300;

/// v6 之前的独立用量文件名。
const LEGACY_USAGE_FILE: &str = "ai_usage.json";

/// 估算一次调用的花费（美元）。单价来自厂商表（见 `provider.rs`）。
pub fn estimate_cost(spec: &ProviderSpec, prompt_tokens: u32, completion_tokens: u32) -> f64 {
    (prompt_tokens as f64 * spec.price_in + completion_tokens as f64 * spec.price_out) / 1_000_000.0
}

/// 调用前的预算检查。
///
/// 返回 `Err((已花费, 预算))` 表示已超限。`budget_usd <= 0` 视为**不限制**。
///
/// 注意：只能在调用**前**拿已花费比对，本次调用的成本要等返回才知道，
/// 所以**最后一次调用会轻微超出预算**。这是有意接受的：要完全不超就得先估
/// token 再拦，而估算本身也不准，徒增复杂度。
pub fn check(daily: &AiUsageDaily, budget_usd: f64) -> Result<(), (f64, f64)> {
    if budget_usd <= 0.0 {
        return Ok(());
    }
    if daily.cost_usd >= budget_usd {
        return Err((daily.cost_usd, budget_usd));
    }
    Ok(())
}

/// 估算在日预算内**大约还能调用多少次**。
///
/// 给用户看的是次数而不是金额：“还剩 ¥2.4”对不接触 API 计价的人没有直觉，
/// “大约还能翻译 300 次”才有。
///
/// 均值只算**真实计费的那些**（`billable_calls`）。把免费的缓存命中与失败
/// 掉进分母会把单次均价稀释，次数就会系统性偏大。没历史才退回经验值。
///
/// 返回 `None` 表示“不适用”：预算为 0（不限制）或本地厂商（零费用）。
pub fn estimate_remaining_calls(
    spec: &ProviderSpec,
    daily: &AiUsageDaily,
    budget_usd: f64,
) -> Option<u32> {
    if budget_usd <= 0.0 || spec.is_local() {
        return None;
    }
    let per_call = if daily.billable_calls > 0 && daily.cost_usd > 0.0 {
        daily.cost_usd / daily.billable_calls as f64
    } else {
        estimate_cost(spec, TYPICAL_PROMPT_TOKENS, TYPICAL_COMPLETION_TOKENS)
    };
    if per_call <= 0.0 {
        return None;
    }
    let left = (budget_usd - daily.cost_usd).max(0.0);
    Some((left / per_call).floor() as u32)
}

/// 删掉 v6 之前的独立用量文件。
///
/// 不是为了省那几百字节，而是为了不留下一份看上去像权威数据源、实际已经
/// 停止更新的文件——以后排查对不上账时它只会把人带偏。删不掉不算错。
pub fn remove_legacy_usage_file(app_dir: &Path) {
    let path = app_dir.join(LEGACY_USAGE_FILE);
    if !path.exists() {
        return;
    }
    match std::fs::remove_file(&path) {
        Ok(()) => log::info!("[AI] 已清理旧用量文件 {}", LEGACY_USAGE_FILE),
        Err(e) => log::warn!("[AI] 清理旧用量文件失败：{}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{find, PROVIDERS};

    fn daily(billable: u32, cost: f64) -> AiUsageDaily {
        AiUsageDaily {
            date: "2026-08-08".to_string(),
            calls: billable,
            billable_calls: billable,
            cost_usd: cost,
            ..Default::default()
        }
    }

    #[test]
    fn test_check_blocks_when_over_budget() {
        match check(&daily(1, 1.0), 0.5) {
            Err((spent, budget)) => {
                assert_eq!(spent, 1.0);
                assert_eq!(budget, 0.5);
            }
            Ok(()) => panic!("已超预算应该被拦"),
        }
        assert!(check(&daily(1, 0.1), 0.5).is_ok());
        // 预算 0 视为不限制
        assert!(check(&daily(1, 999.0), 0.0).is_ok(), "预算 0 应视为不限制");
    }

    #[test]
    fn test_remaining_calls_prefers_user_history() {
        let ds = find("deepseek");

        // 无历史：用经验值，1 美元预算下应能做很多次
        let n0 = estimate_remaining_calls(ds, &daily(0, 0.0), 1.0).expect("应给出次数");
        assert!(n0 > 100, "1 美元预算下次数不该这么少：{}", n0);

        // 有历史且每次都很贵 → 次数必须显著变少，而不是继续用经验值
        let n1 = estimate_remaining_calls(ds, &daily(2, 0.2), 1.0).expect("应给出次数");
        assert_eq!(n1, 8, "剩余 0.8 美元 / 每次 0.1 美元");
        assert!(n1 < n0);

        // 已花超预算 → 0 而不是负数
        assert_eq!(estimate_remaining_calls(ds, &daily(2, 5.0), 1.0), Some(0));
    }

    #[test]
    fn test_remaining_calls_ignores_free_calls_in_average() {
        // 这是个容易搞错的地方：同样花了 0.2 美元，一个只有 2 次计费调用，
        // 另一个因为缓存命中多了 98 条免费记录。若拿总条数当分母，
        // 均价会被稀释 50 倍，“还能做 N 次”会离谱地乐观。
        let ds = find("deepseek");
        let with_cache = AiUsageDaily {
            date: "2026-08-08".to_string(),
            calls: 100,
            billable_calls: 2,
            cached_calls: 98,
            cost_usd: 0.2,
            ..Default::default()
        };
        assert_eq!(
            estimate_remaining_calls(ds, &with_cache, 1.0),
            estimate_remaining_calls(ds, &daily(2, 0.2), 1.0),
            "均价只能用计费次数算，缓存命中不得进分母"
        );
    }

    #[test]
    fn test_remaining_calls_not_applicable_cases() {
        let fresh = daily(0, 0.0);
        // 预算 0 = 不限制，展示“还能做 N 次”是错的
        assert_eq!(estimate_remaining_calls(find("deepseek"), &fresh, 0.0), None);
        // 本地厂商零费用，同理
        assert_eq!(estimate_remaining_calls(find("ollama"), &fresh, 1.0), None);
    }

    #[test]
    fn test_estimate_cost_scales_with_tokens() {
        let ds = find("deepseek");
        let a = estimate_cost(ds, 1000, 1000);
        let b = estimate_cost(ds, 2000, 2000);
        assert!((b - a * 2.0).abs() < 1e-12, "花费应与 token 数线性");
        // 输出比输入贵（DeepSeek）
        assert!(estimate_cost(ds, 0, 1000) > estimate_cost(ds, 1000, 0));
        // 自定义厂商价格未知，必须不低于**表里任何一家**（宁可早拦）。
        // 对全表断言而不是挑一家比：以后哪家涨价都会在这里被拦下
        let custom = estimate_cost(find("custom"), 1000, 1000);
        for p in PROVIDERS.iter().filter(|p| p.id != "custom") {
            assert!(
                custom >= estimate_cost(p, 1000, 1000),
                "custom 的估价低于 {}，预算就拦不住中转服务了",
                p.id
            );
        }
        // 本地厂商零费用
        assert_eq!(estimate_cost(find("ollama"), 100_000, 100_000), 0.0);
    }

    #[test]
    fn test_remove_legacy_usage_file_is_idempotent() {
        let dir = std::env::temp_dir().join("pastepanda_ai_legacy_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 没文件时不能炸
        remove_legacy_usage_file(&dir);

        let f = dir.join(LEGACY_USAGE_FILE);
        std::fs::write(&f, "{}").unwrap();
        remove_legacy_usage_file(&dir);
        assert!(!f.exists(), "旧用量文件应被删除");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
