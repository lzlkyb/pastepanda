//! 免费额度命令（v6.9 签到送 token）：总览 / 签到 / 兑换码。
//!
//! 纯本地只读/记账，不联网、不含内容。计量（quota_spend）由 ai_run
//! 在 builtin-agnes 分支内部调用，不暴露为命令（防止前端绕过计费逻辑）。

use tauri::State;
use crate::data_store::{DataStore, QuotaInfo, RedeemResult, SignResult};

/// 免费额度总览（余额 / 签到状态 / 今日用量 / 阶梯）。
#[tauri::command]
pub fn ai_quota_get(store: State<DataStore>) -> Result<QuotaInfo, String> {
    store.quota_get()
}

/// 每日签到。返回本次奖励与连续天数；重复签到返回 ok=false。
#[tauri::command]
pub fn ai_quota_sign(store: State<DataStore>) -> Result<SignResult, String> {
    store.quota_sign()
}

/// 激活兑换码（离线验证 + 本地幂等）。
#[tauri::command]
pub fn ai_quota_redeem(store: State<DataStore>, code: String) -> Result<RedeemResult, String> {
    store.quota_redeem(&code)
}
