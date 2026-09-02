//! 自动清理调度器：启动后延迟首跑 + 每小时循环检查。
//!
//! 原实现在前端 init.ts 用 setInterval 调度，存在两个问题：
//! 1. 依赖主窗口 JS 运行时——关闭窗口仅驻留托盘时定时器随之停摆，清理不再执行；
//! 2. 清理结果被塞进前端撤销栈，策略性清理污染了本应留给"用户误删"的撤销额度。
//!
//! 挪到后端后：每次运行前从数据库读取最新配置（设置页改天数即时生效，无需重启），
//! 清理完成 emit `auto-cleanup-done` 事件（携带 count + deleted_ids），
//! 前端监听后仅做列表刷新与提示，不写撤销栈。

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 启动后首次清理的延迟：等待前端完成初始加载并注册事件监听，
/// 避免首跑事件在前端挂载前发出而丢失（前端首屏拉取在此之前，不受影响）。
const FIRST_RUN_DELAY: Duration = Duration::from_secs(10);

/// 周期性清理间隔：1 小时（托盘应用长期运行不重启，需运行期间持续检查）
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 启动自动清理后台线程（启动延迟首跑 + 每小时循环）。
pub fn start(handle: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_RUN_DELAY);
        loop {
            run_once(&handle);
            std::thread::sleep(CLEANUP_INTERVAL);
        }
    });
}

/// 读取最新配置并执行一次清理。
///
/// ❗ **两项清理必须各自独立地判自己的开关。**原实现在
/// `auto_cleanup_days == 0` 时直接 `return`；把回收站清理接在那之后的话，
/// 「关掉了剪贴板自动清理」的用户会连回收站清理也永远不跑——
/// 两个开关静默联动，而用户无从得知。
fn run_once(handle: &AppHandle) {
    let store = match handle.try_state::<crate::data_store::DataStore>() {
        Some(s) => s,
        None => return,
    };
    let config = match store.get_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[AutoCleanup] 读取配置失败，跳过本次清理: {}", e);
            return;
        }
    };
    cleanup_history(handle, &store, &config);
    cleanup_note_trash(&store, &config);
    cleanup_mcp_audit(&store, &config);
}

/// MCP 调用审计的超期清理（W3）。口径同回收站：默认 30 天，`0` = 不清理。
///
/// 同样单开一个配置项——审计日志与剪贴板流水、与笔记回收站都不是一回事。
fn cleanup_mcp_audit(store: &crate::data_store::DataStore, config: &serde_json::Value) {
    let days = config
        .get("mcp_audit_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(30);
    match store.mcp_audit_purge_expired(days) {
        Ok(n) if n > 0 => log::info!("[AutoCleanup] MCP 审计清理 {} 条超期记录", n),
        Ok(_) => {}
        Err(e) => log::warn!("[AutoCleanup] MCP 审计清理失败: {}", e),
    }
}

/// 回收站超期清理（W1 / R3）。
///
/// 默认 30 天；`0` = 用户关掉了（`note_purge_expired` 自己会拦）。
/// **缺省值取 30 而不是 0**：键不存在意味着「从没配过」，不是「要求关闭」。
///
/// 不发事件通知前端：回收站不是常驻视图，用户下次点进去自然拉到新数据；
/// 为此推一个没人看的事件只会多一条前端监听路径。
fn cleanup_note_trash(store: &crate::data_store::DataStore, config: &serde_json::Value) {
    let days = config
        .get("note_trash_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(30);
    match store.note_purge_expired(days) {
        Ok(n) if n > 0 => log::info!("[AutoCleanup] 回收站销毁 {} 条超期笔记", n),
        Ok(_) => {}
        Err(e) => log::warn!("[AutoCleanup] 回收站清理失败: {}", e),
    }
}

/// 剪贴板历史的过期清理（原有行为，只是从 `run_once` 里拆出来了）。
fn cleanup_history(
    handle: &AppHandle,
    store: &crate::data_store::DataStore,
    config: &serde_json::Value,
) {
    let days = config
        .get("auto_cleanup_days")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if days == 0 {
        return; // 用户关闭了自动清理
    }
    let workspace = config
        .get("current_workspace")
        .and_then(|v| v.as_str())
        .unwrap_or("默认")
        .to_string();

    match store.clear_history_with_undo(&workspace, Some(days as u32)) {
        Ok((count, deleted)) if count > 0 => {
            let deleted_ids: Vec<&str> = deleted.iter().map(|i| i.id.as_str()).collect();
            if let Err(e) = handle.emit(
                "auto-cleanup-done",
                serde_json::json!({ "count": count, "deleted_ids": deleted_ids }),
            ) {
                log::warn!("[AutoCleanup] 发送清理事件失败: {}", e);
            }
            log::info!("[AutoCleanup] 已清理 {} 条过期记录", count);
        }
        Ok(_) => {}
        Err(e) => log::warn!("[AutoCleanup] 清理失败: {}", e),
    }
}
