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
    cleanup_sync_tombstones(&store, &config);
}

/// 回收站保留天数。**缺省取 30 而不是 0**：键不存在意味着「从没配过」，
/// 不是「要求关闭」。`0` = 用户明确关掉了。
///
/// 收口成一处（规则 #11）：回收站清理、墓碑安全期、以及 **MCP 的 `kb_delete`
/// 工具描述**都要读它，三处各写一个默认值的话，改一处忘一处不会报错。
///
/// 🔴 `pub(crate)` 是为了第三处：描述里不拿真值拼，模型就会照着写死的
/// 「30 天」向用户打包票，而用户可能已经改成了 7 天——后果是用户信了那句话，
/// 第八天东西没了。
pub(crate) fn trash_days(config: &serde_json::Value) -> i64 {
    config
        .get("note_trash_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(30)
}

/// 墓碑安全期在回收站保留期之上再加多少天。
///
/// 宁大勿小：删早了的后果是已删的笔记在对端复活，而用户会以为
/// 是同步把垃圾又搬回来了。多留只是多几 KB。
const TOMBSTONE_GRACE_DAYS: i64 = 30;

/// 用户关掉回收站自动销毁时，拿什么当作安全期的基数。
const TRASH_DAYS_FALLBACK: i64 = 30;

/// 同步墓碑的回收（W3）。安全期 = 回收站保留期 + [`TOMBSTONE_GRACE_DAYS`]。
///
/// ❗ `note_trash_days == 0`（用户关掉了回收站自动销毁）时**不跟着关**，
/// 而是退回 [`TRASH_DAYS_FALLBACK`] 来算安全期。理由同本模块开头那一条：
/// 两个开关静默联动、而用户无从得知，是这里犯过的错。
/// 「不自动销毁笔记」是关于笔记的，与墓碑这份同步记账无关。
///
/// 真正拉着安全底线的是另一个条件（所有设备的游标都过了这条），
/// 见 [`DataStore::tombstone_gc`]。年龄只是叠在上面的第二道闸。
fn cleanup_sync_tombstones(store: &crate::data_store::DataStore, config: &serde_json::Value) {
    let base = trash_days(config);
    let safe_days = if base > 0 { base } else { TRASH_DAYS_FALLBACK } + TOMBSTONE_GRACE_DAYS;
    match store.tombstone_purge_expired(safe_days) {
        Ok(n) if n > 0 => log::info!(
            "[AutoCleanup] 回收 {} 条同步墓碑（已过 {} 天安全期、且所有已配对设备都已收到）",
            n,
            safe_days
        ),
        Ok(_) => {}
        Err(e) => log::warn!("[AutoCleanup] 墓碑回收失败: {}", e),
    }
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
    match store.note_purge_expired(trash_days(config)) {
        Ok(n) if n > 0 => log::info!("[AutoCleanup] 回收站销毁 {} 条超期笔记", n),
        Ok(_) => {}
        Err(e) => log::warn!("[AutoCleanup] 回收站清理失败: {}", e),
    }
}

/// 🔴 B7（2026-10-24 拍板：清理覆盖全部工作区）——自动清理要覆盖的工作区列表。
///
/// 改前只清 `config.current_workspace`，而 `clipboard_monitor` 的采集**永远写
/// 「默认」工作区**（HistoryItem 构造硬编码）——用户切过工作区后，「默认」区
/// 的记录永不过期，磁盘与 DB 持续膨胀，与用户设置的保留天数不符。
/// 语义：过期跟记录本身走，不跟「用户当前在看哪个区」走。
fn workspaces_to_auto_clean(current: &str, distinct: &[String]) -> Vec<String> {
    if distinct.is_empty() {
        // 没有历史记录时没有可清的；退回当前区名保持事件路径可测
        return vec![current.to_string()];
    }
    distinct.to_vec()
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
    let current = config
        .get("current_workspace")
        .and_then(|v| v.as_str())
        .unwrap_or("默认")
        .to_string();
    // B7：采集永远写「默认」区而旧实现只清 current_workspace——过期必须覆盖全部工作区。
    let distinct = store.distinct_workspaces().unwrap_or_default();
    let mut total = 0u32;
    let mut all_deleted: Vec<_> = Vec::new();
    for ws in workspaces_to_auto_clean(&current, &distinct) {
        match store.clear_history_with_undo(&ws, Some(days as u32)) {
            Ok((count, deleted)) => {
                total += count;
                all_deleted.extend(deleted);
            }
            Err(e) => log::warn!("[AutoCleanup] 清理工作区 {} 失败: {}", ws, e),
        }
    }
    if total > 0 {
        // B3：自动清理是**永久删除**（deleted 不进前端撤销栈），必须连图片
        // 文件一起清扫——改前只删表，images/ 目录孤儿图片无限增长。
        // 手动清空（commands::clear_history）有撤销，不能做这步。
        store.purge_image_files_for(&all_deleted);
        let deleted_ids: Vec<&str> = all_deleted.iter().map(|i| i.id.as_str()).collect();
        if let Err(e) = handle.emit(
            "auto-cleanup-done",
            serde_json::json!({ "count": total, "deleted_ids": deleted_ids }),
        ) {
            log::warn!("[AutoCleanup] 发送清理事件失败: {}", e);
        }
        log::info!("[AutoCleanup] 已清理 {} 条过期记录（全部工作区）", total);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B7 守卫：切到非默认工作区后，自动清理仍必须覆盖「默认」区
    /// （采集永远写默认区——改前只清 current_workspace，默认区永不过期）。改前为红。
    #[test]
    fn auto_cleanup_must_cover_default_workspace() {
        let distinct = vec!["默认".to_string(), "项目B".to_string()];
        let targets = workspaces_to_auto_clean("项目B", &distinct);
        assert!(
            targets.iter().any(|w| w == "默认"),
            "自动清理必须覆盖采集实际写入的「默认」工作区，实际只清了 {:?}",
            targets
        );
    }

    /// B7 守卫：所有工作区的过期记录都在清理范围内。
    #[test]
    fn auto_cleanup_covers_every_workspace() {
        let distinct = vec!["默认".to_string(), "项目B".to_string(), "归档".to_string()];
        let targets = workspaces_to_auto_clean("项目B", &distinct);
        for ws in &distinct {
            assert!(targets.contains(ws), "漏了工作区 {}", ws);
        }
    }
}
