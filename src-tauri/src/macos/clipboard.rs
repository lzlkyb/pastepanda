//! macOS capture feeds the same bounded processing queue as Windows.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Snapshot {
    change_count: i64,
    text: String,
    html: String,
    files: Vec<String>,
    source: String,
    executable: String,
}
extern "C" {
    fn pp_mac_clipboard_change_count() -> i64;
    fn pp_mac_clipboard_snapshot(out: *mut *mut u8, length: *mut usize) -> i32;
    fn pp_mac_free(memory: *mut std::ffi::c_void);
}
fn snapshot() -> Result<Snapshot, String> {
    let mut data = std::ptr::null_mut();
    let mut length = 0;
    let status = unsafe { pp_mac_clipboard_snapshot(&mut data, &mut length) };
    if status != 0 {
        return Err(format!("Mac 剪贴板快照暂不可读（{status}）"));
    }
    struct Allocation(*mut u8);
    impl Drop for Allocation {
        fn drop(&mut self) {
            unsafe { pp_mac_free(self.0.cast()) };
        }
    }
    let _allocation = Allocation(data);
    if data.is_null() || length > 16 * 1024 * 1024 {
        return Err("Mac 剪贴板快照大小无效".into());
    }
    serde_json::from_slice(unsafe { std::slice::from_raw_parts(data, length) })
        .map_err(|e| format!("Mac 剪贴板快照解析失败：{e}"))
}
pub(super) fn run(
    running: Arc<AtomicBool>,
    app: AppHandle,
    suppress: Arc<PasteSuppress>,
    auto_strip: Arc<std::sync::RwLock<bool>>,
) {
    let Some(monitor) = app.try_state::<ClipboardMonitor>() else {
        running.store(false, Ordering::SeqCst);
        let _ = app.emit("monitor-status-changed", false);
        return;
    };
    let sensitive = monitor.cached_skip_sensitive.clone();
    let excluded = monitor.cached_excluded_apps.clone();
    let doc_capture = monitor.cached_doc_capture.clone();
    let queue = Arc::new(CaptureQueue::new());
    let worker_queue = queue.clone();
    let worker_running = running.clone();
    let worker_app = app.clone();
    let worker_sensitive = sensitive.clone();
    let worker_excluded = excluded.clone();
    let worker = std::thread::Builder::new()
        .name("mac-clipboard-writer".into())
        .spawn(move || {
            worker_loop(
                &worker_queue,
                &worker_running,
                &worker_app,
                &worker_sensitive,
                &worker_excluded,
            );
        });
    if let Err(error) = worker {
        log::error!("Mac 剪贴板处理线程启动失败：{error}");
        running.store(false, Ordering::SeqCst);
        let _ = app.emit("monitor-status-changed", false);
        return;
    }
    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(error) => {
            log::error!("Mac 剪贴板打开失败：{error}");
            running.store(false, Ordering::SeqCst);
            let _ = app.emit("monitor-status-changed", false);
            return;
        }
    };
    let dedup = CaptureDedup::new();
    let mut last_change = None;
    while running.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(400));
        let sequence = unsafe { pp_mac_clipboard_change_count() };
        if last_change == Some(sequence) {
            continue;
        }
        let snap = match snapshot() {
            Ok(s) => s,
            Err(error) => {
                log::debug!("{error}");
                continue;
            }
        };
        // Suppression uses the shared writer identity logic; excluded apps are rejected
        // before image decoding, HTML localization, database writes or LAN transmission.
        if is_excluded_app_with(&excluded, &snap.source) {
            last_change = Some(snap.change_count);
            continue;
        }
        let time = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let exe_path = (!snap.executable.is_empty()).then(|| PathBuf::from(&snap.executable));
        let title = snap.source;
        let item = if !snap.files.is_empty() {
            let hash = files_clipboard_hash(&snap.files);
            if own_write_skip(&suppress, &[&hash], "file", WriteKind::Files)
                || dedup.is_recent(&hash)
            {
                last_change = Some(snap.change_count);
                continue;
            }
            dedup.note(&hash);
            Some(CapturedItem::Files {
                paths: snap.files,
                title,
                exe_path,
                time,
            })
        } else if !snap.html.is_empty()
            && html_fragment_has_image(&snap.html)
            && html_fragment_has_text(&snap.html)
        {
            let text = if snap.text.is_empty() {
                html_fragment_to_plain_text_fallback(&snap.html)
            } else {
                snap.text
            };
            let hash = md5_hex(snap.html.as_bytes());
            if own_write_skip(&suppress, &[&hash], "rich", WriteKind::Rich)
                || dedup.is_recent(&hash)
                || should_skip_sensitive_with(&sensitive, &text)
                || should_skip_sensitive_with(&sensitive, &snap.html)
            {
                last_change = Some(snap.change_count);
                continue;
            }
            let Ok(dir) = app.path().app_data_dir() else {
                continue;
            };
            let (html, _) = localize_html_images(&snap.html, &dir.join("images"));
            dedup.note(&hash);
            Some(CapturedItem::Rich {
                html_fragment: html.clone(),
                plain_text: text,
                hash: md5_hex(html.as_bytes()),
                title,
                exe_path,
                time,
            })
        } else if !snap.text.is_empty() {
            let text = if read_bool_cache(&auto_strip) {
                snap.text.trim().to_string()
            } else {
                snap.text
            };
            if text.is_empty() {
                last_change = Some(snap.change_count);
                dedup.clear();
                continue;
            }
            let text_hash = md5_hex(text.as_bytes());
            let doc = read_bool_cache(&doc_capture) && detect_doc_fragment(&snap.html, &text);
            let hash = if doc {
                md5_hex(snap.html.as_bytes())
            } else {
                text_hash.clone()
            };
            let kind = if doc {
                WriteKind::Rich
            } else {
                WriteKind::Text
            };
            if own_write_skip(&suppress, &[&hash, &text_hash], "text", kind)
                || dedup.is_recent(&hash)
            {
                last_change = Some(snap.change_count);
                continue;
            }
            dedup.note(&hash);
            Some(if doc {
                CapturedItem::Doc {
                    html_fragment: snap.html,
                    plain_text: text,
                    hash,
                    title,
                    exe_path,
                    time,
                }
            } else {
                CapturedItem::Text {
                    text,
                    hash,
                    title,
                    exe_path,
                    time,
                }
            })
        } else {
            match clipboard.get_image() {
                Ok(image) => {
                    // Do not pair pixels from a later copy with this snapshot's source.
                    if unsafe { pp_mac_clipboard_change_count() } != snap.change_count {
                        continue;
                    }
                    let hash = md5_hex(image.bytes.as_ref());
                    if own_write_skip(&suppress, &[&hash], "image", WriteKind::Image)
                        || dedup.is_recent(&hash)
                    {
                        last_change = Some(snap.change_count);
                        continue;
                    }
                    dedup.note(&hash);
                    Some(CapturedItem::Image {
                        rgba: image.bytes.into_owned(),
                        width: image.width,
                        height: image.height,
                        hash,
                        title,
                        exe_path,
                        time,
                    })
                }
                Err(_) => {
                    dedup.clear();
                    None
                }
            }
        };
        last_change = Some(snap.change_count);
        if let Some(item) = item {
            queue.push(item);
        }
    }
    queue.condvar.notify_all();
}
