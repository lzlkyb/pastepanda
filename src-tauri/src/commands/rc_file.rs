//! 远程电脑 · 文件传输命令（G6 · B3）。
//!
//! 刻意**不放 `commands/rc.rs`**：那个文件已经 1300 行，再塞会把「找一条 rc 命令」
//! 变成翻巨人肩膀。与 `commands/rc_pair.rs` 的分法一致。
//!
//! 命令本身只做「参数转换 + 转调服务层」——所有判据都在 `rc/file_proto.rs`
//! （协议）、`rc/file_state.rs`（状态）、`rc/file_transfer.rs`（收发）。

use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::data_store::DataStore;
use crate::rc::file_state::FileSnapshot;
use crate::rc::service::RcService;

/// 把本机文件发给对端。可多选，**串行**传（弱网下并发文件互挤，总时长反而更长）。
///
/// 返回成功只代表「已受理」：不合法的文件在这一步就被拒（同步做完），
/// 真正的传输在后台跑，进度经 `rc-file-state` 事件回传。
#[tauri::command]
pub async fn rc_file_send(
    svc: State<'_, Arc<RcService>>,
    peer: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    svc.file_send(&peer, paths).await
}

/// 向对端要文件，落到 `dir`。
///
/// ❗ `dir` 必须在调用**之前**由用户选好：对方一接受就会开始灌字节，
/// 没有「先请求再选目录」这种顺序（设计稿 11.2 的注意事项 1）。
#[tauri::command]
pub async fn rc_file_pull(
    svc: State<'_, Arc<RcService>>,
    peer: String,
    dir: String,
) -> Result<(), String> {
    svc.file_pull(&peer, PathBuf::from(dir)).await
}

/// 用户在确认条上回应：`accept_dir` 有值 = 接受（推送方向是落盘目录、
/// 取回方向是要发送的文件路径）；`None` = 拒绝。
#[tauri::command]
pub fn rc_file_respond(
    svc: State<'_, Arc<RcService>>,
    ask_id: String,
    accept_dir: Option<String>,
) -> Result<(), String> {
    svc.file_respond(&ask_id, accept_dir.map(PathBuf::from))
}

/// 取消一条进行中的任务（收侧保留 `.pppart`，下次可续）。
#[tauri::command]
pub fn rc_file_cancel(svc: State<'_, Arc<RcService>>, task_id: String) {
    svc.file_cancel(&task_id);
}

/// 清掉已结束的任务（前端「清空」按钮）。
#[tauri::command]
pub fn rc_file_clear_finished(svc: State<'_, Arc<RcService>>) {
    svc.file_clear_finished();
}

/// 文件状态快照。前端首次挂载取一次；之后靠 `rc-file-state` 事件
/// （**同一个形状**，见 `file_state::FileSnapshot`）。
#[tauri::command]
pub fn rc_file_snapshot(svc: State<'_, Arc<RcService>>) -> FileSnapshot {
    svc.file_snapshot()
}

/// 接收目录（用户在设置里配置的覆盖目录；未配置 = `<下载>/PastePanda 接收/`）。
///
/// 由 Rust 给而不是前端拼：中文系统的下载目录叫「下载」，且可能被用户
/// 重定向到别的盘——只有 `SHGetKnownFolderPath` 知道真实位置。
/// 2026-09-27：push 接受不再每次弹目录选择框（用户拍板：默认落 + 设置可改），
/// 本命令成为「落点」的唯一取值口；`rc_file_receive_dir_set` 是唯一写入口。
#[tauri::command]
pub fn rc_file_default_dir(store: State<'_, DataStore>) -> Result<String, String> {
    let config = store.get_config()?;
    crate::rc::file_transfer::effective_receive_dir(&config)
        .map(|p| p.to_string_lossy().to_string())
}

/// 设置文件接收目录（空串 = 恢复默认 `<下载>/PastePanda 接收/`）。
///
/// 保存前就创建目录：设置那一刻就暴露「盘符不存在」这类问题，
/// 别等第一场传输落盘才炸。
#[tauri::command]
pub fn rc_file_receive_dir_set(store: State<'_, DataStore>, dir: String) -> Result<String, String> {
    let trimmed = dir.trim().to_string();
    let effective = if trimmed.is_empty() {
        crate::rc::file_transfer::default_receive_dir()?
    } else {
        let p = std::path::PathBuf::from(&trimmed);
        if !p.is_absolute() {
            return Err("接收目录必须是绝对路径".into());
        }
        std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败：{e}"))?;
        p
    };
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        "rc_file_receive_dir".to_string(),
        serde_json::Value::String(if trimmed.is_empty() {
            String::new()
        } else {
            effective.to_string_lossy().to_string()
        }),
    );
    store.save_config(&config)?;
    Ok(effective.to_string_lossy().to_string())
}
