//! Launch Services through the system executable; never invoke a shell.
use std::{path::Path, process::Command};
fn launch(target: &str, reveal: bool) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/open");
    if reveal {
        command.arg("-R");
    }
    let output = command
        .arg(target)
        .output()
        .map_err(|e| format!("打开失败：{e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "打开失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
fn file_target(path: &Path, reveal: bool) -> Result<String, String> {
    let selected = if reveal && !path.exists() {
        path.parent().ok_or("目标目录不存在")?
    } else {
        path
    };
    let canonical = selected
        .canonicalize()
        .map_err(|e| format!("目标路径不可用：{e}"))?;
    canonical
        .into_os_string()
        .into_string()
        .map_err(|_| "目标路径不是有效 UTF-8".into())
}
pub fn file(path: &Path, reveal: bool) -> Result<(), String> {
    launch(&file_target(path, reveal)?, reveal)
}
pub fn url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("只允许打开 http/https/mailto 链接".into());
    }
    launch(url, false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_paths_cannot_be_open_options() {
        let folder = std::env::temp_dir().join(format!("pp-open-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("--args $() ; 文本.txt");
        std::fs::write(&file, b"example").unwrap();
        let target = file_target(&file, false).unwrap();
        assert!(target.starts_with('/'));
        assert!(target.ends_with("--args $() ; 文本.txt"));
        assert!(file_target(&folder.join("missing"), false).is_err());
        assert!(file_target(&folder.join("missing"), true).is_ok());
        assert!(url("file:///tmp/test").is_err());
        assert!(url("-a Terminal").is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }
}

/// Finder passes document URLs, not argv. Only local Markdown documents are accepted.
pub fn markdown_document(url: &url::Url) -> Option<std::path::PathBuf> {
    let path = url.to_file_path().ok()?;
    let extension = path.extension()?.to_str()?;
    if !["md", "markdown"]
        .iter()
        .any(|ext| extension.eq_ignore_ascii_case(ext))
    {
        return None;
    }
    Some(path)
}

static DOCUMENT_QUEUE: std::sync::Mutex<Vec<url::Url>> = std::sync::Mutex::new(Vec::new());
fn deferred_documents(
    queue: &mut Vec<url::Url>,
    urls: Vec<url::Url>,
    ready: bool,
) -> Vec<url::Url> {
    queue.extend(urls);
    if ready {
        std::mem::take(queue)
    } else {
        Vec::new()
    }
}

pub fn open_documents(app: &tauri::AppHandle, urls: Vec<url::Url>) {
    use tauri::Manager;
    // Opened can precede Ready/setup on macOS. Never access managed editor state early.
    let urls = deferred_documents(
        &mut DOCUMENT_QUEUE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        urls,
        app.try_state::<crate::PendingEditor>().is_some(),
    );
    if urls.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for document in urls.iter().filter_map(markdown_document) {
            if !document.is_file() {
                document_error(&app, "文件不存在或无法读取".into());
                continue;
            }
            if let Err(error) = crate::commands::open_fullscreen_editor(
                app.clone(),
                None,
                None,
                Some(document.to_string_lossy().into_owned()),
                Some("markdown".into()),
                None,
            )
            .await
            {
                document_error(&app, error);
            }
        }
    });
}

fn document_error(app: &tauri::AppHandle, error: String) {
    log::warn!("[Mac] 打开 Markdown 文档失败：{error}");
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(error)
        .title("无法打开 Markdown 文档")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

#[cfg(test)]
mod document_tests {
    use super::*;
    #[test]
    fn finder_events_before_setup_are_delivered_once_after_ready() {
        let first = url::Url::parse("file:///Users/me/first.md").unwrap();
        let second = url::Url::parse("file:///Users/me/second.md").unwrap();
        let mut queue = Vec::new();
        assert!(deferred_documents(&mut queue, vec![first.clone()], false).is_empty());
        assert!(deferred_documents(&mut queue, vec![second.clone()], false).is_empty());
        assert_eq!(
            deferred_documents(&mut queue, vec![], true),
            vec![first, second]
        );
        assert!(deferred_documents(&mut queue, vec![], true).is_empty());
    }

    #[test]
    fn finder_documents_are_local_markdown_only_and_decode_spaces() {
        assert_eq!(
            markdown_document(&url::Url::parse("file:///Users/me/a%20b.MD").unwrap()),
            Some(std::path::PathBuf::from("/Users/me/a b.MD"))
        );
        for url in [
            "https://example.com/a.md",
            "file://remote/a.md",
            "file:///Users/me/a.exe",
            "file:///Users/me/README",
        ] {
            assert!(markdown_document(&url::Url::parse(url).unwrap()).is_none());
        }
    }
}
