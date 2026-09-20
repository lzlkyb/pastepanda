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

/// 默认接收目录（`<下载>/PastePanda 接收/`）。
///
/// 由 Rust 给而不是前端拼：中文系统的下载目录叫「下载」，且可能被用户
/// 重定向到别的盘——只有 `SHGetKnownFolderPath` 知道真实位置。
#[tauri::command]
pub fn rc_file_default_dir() -> Result<String, String> {
    crate::rc::file_transfer::default_receive_dir()
        .map(|p| p.to_string_lossy().to_string())
}
