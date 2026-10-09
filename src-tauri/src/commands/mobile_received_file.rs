//! Completed receiver tasks are the only authority for native file actions.
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
#[cfg(target_os = "android")]
use tauri::Manager;
use crate::rc::file_state::{FileTask, TaskDir, TaskState};
use crate::rc::service::RcService;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceivedFileAction { Open, Share, Export }
#[derive(Deserialize, Serialize)]
pub struct ReceivedFileReply { pub status: String }

#[tauri::command]
pub async fn mobile_received_file_action(app: AppHandle, svc: State<'_, std::sync::Arc<RcService>>,
    task_id: String, action: ReceivedFileAction) -> Result<ReceivedFileReply, String> {
    let snapshot = svc.file_snapshot();
    let task = snapshot.tasks.iter().find(|task| task.id == task_id).ok_or("文件记录已失效，请重新接收")?;
    let source = received_source(task)?;
    #[cfg(target_os = "android")]
    {
        let root = app.path().app_cache_dir().map_err(|_| "文件操作目录不可用")?.join("received-file-out");
        let name = task.name.clone();
        let file = tauri::async_runtime::spawn_blocking(move || stage_received(&source, &root, &name))
            .await.map_err(|_| "文件准备失败，请重试")??;
        app.state::<super::mobile_knowledge_share::KnowledgeShare<tauri::Wry>>().0
            .run_mobile_plugin("receivedFile", serde_json::json!({ "path": file, "action": action }))
            .map_err(|reason| format!("{reason}"))
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, source, action); Err("文件打开、分享和导出仅在手机端可用".into()) }
}

fn received_source(task: &FileTask) -> Result<PathBuf, String> {
    if task.dir != TaskDir::Recv || task.state != TaskState::Done { return Err("只有已完整接收的文件可以使用".into()); }
    let source = Path::new(task.path.as_deref().ok_or("文件位置不可用，请重新接收")?);
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "文件已移动或删除，请重新接收")?;
    // Do not follow a replacement link to some unrelated private file.
    if !metadata.is_file() || metadata.len() != task.size { return Err("接收文件已变化，请重新接收".into()); }
    source.canonicalize().map_err(|_| "文件无法读取，请重新接收".into())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn stage_received(source: &Path, root: &Path, name: &str) -> Result<String, String> {
    let name = crate::rc::file_proto::safe_file_name(name)?;
    std::fs::create_dir_all(root).map_err(|_| "手机存储空间不足或文件目录不可用")?;
    // External readers may still hold yesterday's URI. Only prune expired action directories.
    for entry in std::fs::read_dir(root).map_err(|_| "文件操作目录不可用")?.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) && entry.metadata().ok().and_then(|m| m.modified().ok())
            .and_then(|time| time.elapsed().ok()).is_some_and(|age| age.as_secs() > 86_400) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let directory = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&directory).map_err(|_| "文件操作目录创建失败")?;
    let target = directory.join(name);
    if std::fs::copy(source, &target).is_err() {
        let _ = std::fs::remove_dir_all(&directory);
        return Err("文件准备失败，请检查手机存储空间后重试".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn received_file_never_accepts_send_pending_missing_or_changed_file() {
        let root = std::env::temp_dir().join(format!("received-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap(); let file = root.join("report.txt"); std::fs::write(&file, b"safe").unwrap();
        let mut task = FileTask { id: "t".into(), peer: "p".into(), peer_name: "电脑".into(), dir: TaskDir::Recv,
            name: "report.txt".into(), size: 4, offset: 0, done: 4, path: Some(file.to_string_lossy().into_owned()),
            state: TaskState::Done, err: None, started_ms: 0, updated_ms: 0 };
        assert!(received_source(&task).is_ok()); task.dir = TaskDir::Send; assert!(received_source(&task).is_err());
        task.dir = TaskDir::Recv; task.state = TaskState::Transferring; assert!(received_source(&task).is_err());
        task.state = TaskState::Done; task.size = 5; assert!(received_source(&task).is_err());
        task.size = 4; let source = received_source(&task).unwrap();
        let staged = stage_received(&source, &root.join("cache"), "../../report.txt").unwrap();
        assert!(Path::new(&staged).starts_with(root.join("cache"))); assert_eq!(std::fs::read(&staged).unwrap(), b"safe");
        std::fs::remove_file(file).unwrap(); assert!(received_source(&task).is_err()); std::fs::remove_dir_all(root).unwrap();
    }
}
