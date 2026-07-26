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

/// 读取最新配置并执行一次清理；有记录被清理时 emit 事件通知前端。
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
