use crate::content_classifier::ContentClassifier;
use crate::data_store::{compute_pinyin_initials, DataStore, HistoryItem};
use arboard::Clipboard;
use md5::{Digest, Md5};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// 剪贴板变化事件，推送到前端
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardChanged {
    pub item: HistoryItem,
}

/// 粘贴抑制状态 — 防止自身粘贴被记录
pub struct PasteSuppress {
    pub until: Mutex<Option<Instant>>,
    /// 预期粘贴内容的 hash，即使时间抑制过期，匹配 hash 也跳过
    pub expected_hash: Mutex<Option<String>>,
}

impl PasteSuppress {
    pub fn new() -> Self {
        Self {
            until: Mutex::new(None),
            expected_hash: Mutex::new(None),
        }
    }

    pub fn set(&self, duration: Duration) {
        if let Ok(mut guard) = self.until.lock() {
            *guard = Some(Instant::now() + duration);
        }
    }

    pub fn set_with_hash(&self, duration: Duration, hash: String) {
        if let Ok(mut guard) = self.until.lock() {
            *guard = Some(Instant::now() + duration);
        }
        if let Ok(mut guard) = self.expected_hash.lock() {
            *guard = Some(hash);
        }
    }

    pub fn is_suppressed(&self) -> bool {
        if let Ok(guard) = self.until.lock() {
            guard.map_or(false, |t| Instant::now() < t)
        } else {
            false
        }
    }

    /// 检查内容 hash 是否匹配预期粘贴内容（即使时间抑制已过期也跳过）
    pub fn is_hash_suppressed(&self, hash: &str) -> bool {
        if let Ok(guard) = self.expected_hash.lock() {
            guard.as_ref().map_or(false, |h| h == hash)
        } else {
            false
        }
    }

    pub fn clear_hash(&self) {
        if let Ok(mut guard) = self.expected_hash.lock() {
            *guard = None;
        }
    }
}

/// 剪贴板监听器 — 后台轮询检测剪贴板变化
pub struct ClipboardMonitor {
    running: Arc<AtomicBool>,
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    /// 缓存 auto_strip 配置值，避免每 400ms 都锁定数据库读取配置
    cached_auto_strip: Arc<std::sync::RwLock<bool>>,
}

impl ClipboardMonitor {
    pub fn new(app_handle: AppHandle, paste_suppress: Arc<PasteSuppress>) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            app_handle,
            paste_suppress,
            cached_auto_strip: Arc::new(std::sync::RwLock::new(false)),
        }
    }

    /// 更新缓存的 auto_strip 配置（由前端保存配置后调用）
    pub fn update_auto_strip_cache(&self, enabled: bool) {
        if let Ok(mut guard) = self.cached_auto_strip.write() {
            *guard = enabled;
        }
    }

    /// 读取缓存的 auto_strip 配置（无锁竞争，比每次查数据库快得多）
    fn get_auto_strip(&self) -> bool {
        self.cached_auto_strip.read().map(|g| *g).unwrap_or(false)
    }

    pub fn start(&self) {
        if self.running.load(Ordering::SeqCst) {
            return;
        }
        self.running.store(true, Ordering::SeqCst);

        let running = self.running.clone();
        let app_handle = self.app_handle.clone();
        let paste_suppress = self.paste_suppress.clone();

        std::thread::spawn(move || {
            log::info!("[ClipboardMonitor] 监听线程启动");

            let mut clipboard = match Clipboard::new() {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[ClipboardMonitor] 无法打开剪贴板: {}", e);
                    return;
                }
            };

            let mut last_text_hash: Option<String> = None;
            let poll_interval = Duration::from_millis(400);

            while running.load(Ordering::SeqCst) {
                std::thread::sleep(poll_interval);

                // 持续追踪前台窗口（跳过自身窗口）
                if let Some(engine) = app_handle.try_state::<crate::paste_engine::PasteEngine>() {
                    engine.track_foreground_window();
                }

                // 尝试读取文本
                match clipboard.get_text() {
                    Ok(text) if !text.is_empty() => {

                        // 自动去除空白（使用缓存的配置，避免每 400ms 锁数据库）
                        let text = if let Some(monitor) = app_handle.try_state::<ClipboardMonitor>()
                        {
                            if monitor.get_auto_strip() {
                                text.trim().to_string()
                            } else {
                                text
                            }
                        } else {
                            text
                        };

                        if text.is_empty() {
                            last_text_hash = None;
                            continue;
                        }

                        let hash =
                            format!("{:x}", Md5::new().chain_update(text.as_bytes()).finalize());

                        // 检查是否是我们自己写入的粘贴内容（hash 匹配）
                        if paste_suppress.is_hash_suppressed(&hash) {
                            log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (hash匹配)");
                            paste_suppress.clear_hash();
                            last_text_hash = Some(hash);
                            continue;
                        }

                        if Some(&hash) != last_text_hash.as_ref() {
                            last_text_hash = Some(hash.clone());

                            // 获取前台窗口信息（标题 + 图标，一次调用）
                            let (source_title, source_icon) = get_foreground_window_info(&app_handle);

                            // 计算拼音首字母
                            let pinyin_initials = compute_pinyin_initials(&text);
                            let now_str =
                                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

                            // 智能合并：检查是否已存在相同 md5 的文本记录
                            let store = app_handle.try_state::<DataStore>();
                            let mut existing_id: Option<String> = None;
                            if let Some(ref store) = store {
                                if let Ok(Some(existing)) = store.find_latest_by_md5(&hash) {
                                    // 找到重复内容，只更新时间戳（不创建新记录）
                                    existing_id = Some(existing.id.clone());
                                    if let Err(e) =
                                        store.update_history_time(&existing.id, &now_str)
                                    {
                                        log::warn!(
                                            "[ClipboardMonitor] 更新重复记录时间失败: {}",
                                            e
                                        );
                                    } else {
                                        log::info!(
                                            "[ClipboardMonitor] 智能合并重复文本 (id={})",
                                            existing.id
                                        );
                                    }
                                    // 推送更新后的 item 到前端（前端会 prepend，使旧记录移到顶部）
                                    // 注意：..existing 的 tags 已被 load_tags_into_items 填充，不能覆盖
                                    let updated_item = HistoryItem {
                                        time: now_str.clone(),
                                        source: source_title.clone(),
                                        source_icon: source_icon.clone(),
                                        group_id: existing.group_id.clone(),
                                        ..existing
                                    };
                                    if let Err(e) = app_handle.emit(
                                        "clipboard-changed",
                                        ClipboardChanged {
                                            item: updated_item.clone(),
                                        },
                                    ) {
                                        log::warn!("[ClipboardMonitor] 推送合并事件失败: {}", e);
                                    }
                                    // LAN 同步
                                    if let Some(lan_sync) =
                                        app_handle.try_state::<crate::lan_sync::LanSync>()
                                    {
                                        lan_sync.send(&text);
                                    }
                                }
                            }

                            // 如果没有找到重复记录，则正常创建新记录
                            if existing_id.is_none() {
                                let item = HistoryItem {
                                    id: Uuid::new_v4().to_string(),
                                    text: text.clone(),
                                    time: now_str,
                                    item_type: "text".to_string(),
                                    content: String::new(),
                                    pinned: false,
                                    source: source_title.clone(),
                                    workspace: "默认".to_string(),
                                    md5: Some(hash),
                                    pinyin_initials: Some(pinyin_initials),
                                    group_id: None,
                                    source_icon: source_icon.clone(),
                                    tags: Vec::new(),
                                };

                                // 插入数据库
                                if let Some(ref store) = store {
                                    if let Err(e) = store.insert_history(&item) {
                                        log::error!("[ClipboardMonitor] 插入失败: {}", e);
                                    }
                                }

                                // AI 自动分类：用 std::thread 后台执行，不阻塞轮询循环
                                // 注意：不能用 tokio::spawn，因为监听线程是 std::thread，没有 Tokio runtime
                                {
                                    let history_id = item.id.clone();
                                    let classify_text = item.text.clone();
                                    let app_clone = app_handle.clone();
                                    std::thread::spawn(move || {
                                        // ContentClassifier 是无状态的纯逻辑引擎，直接创建实例即可
                                        let classifier = ContentClassifier::new();
                                        let labels = classifier.classify(&classify_text);
                                        if let Some(store) = app_clone.try_state::<DataStore>() {
                                            if let Ok(tag_ids) = store.resolve_auto_tag_ids(&labels) {
                                                if !tag_ids.is_empty() {
                                                    if let Err(e) = store.add_history_tags(&history_id, &tag_ids) {
                                                        log::warn!("[ContentClassifier] 写入自动标签失败: {}", e);
                                                    } else {
                                                        log::info!("[ContentClassifier] 自动分类: {:?} → {}", labels, history_id);
                                                        // 传递增量数据：history_id + tag_ids，前端只更新该 item 的标签
                                                        let _ = app_clone.emit("tags-updated", serde_json::json!({
                                                            "history_id": history_id,
                                                            "tag_ids": tag_ids,
                                                        }));
                                                    }
                                                }
                                            }
                                        }
                                    });
                                }

                                // 推送事件到前端
                                if let Err(e) = app_handle.emit(
                                    "clipboard-changed",
                                    ClipboardChanged { item: item.clone() },
                                ) {
                                    log::warn!("[ClipboardMonitor] 推送文本事件失败: {}", e);
                                }

                                // LAN 同步：发送文本到局域网
                                if let Some(lan_sync) =
                                    app_handle.try_state::<crate::lan_sync::LanSync>()
                                {
                                    lan_sync.send(&text);
                                }
                            }
                        }
                    }
                    _ => {
                        // 尝试读取图片
                        match clipboard.get_image() {
                            Ok(img) if img.width > 0 && img.height > 0 => {
                                // 图片大小限制：超过 50MB（RGBA bytes）则跳过
                                const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
                                if img.bytes.len() > MAX_IMAGE_BYTES {
                                    log::warn!(
                                        "[ClipboardMonitor] 图片过大 ({} bytes)，跳过记录",
                                        img.bytes.len()
                                    );
                                    last_text_hash = None;
                                    continue;
                                }

                                // 生成图片 hash
                                let img_hash =
                                    format!("{:x}", Md5::new().chain_update(&img.bytes).finalize());

                                // 检查是否是我们自己写入的粘贴图片（hash 匹配）
                                if paste_suppress.is_hash_suppressed(&img_hash) {
                                    log::info!("[ClipboardMonitor] 跳过自身粘贴图片 (hash匹配)");
                                    paste_suppress.clear_hash();
                                    last_text_hash = Some(img_hash);
                                    continue;
                                }

                                if Some(&img_hash) != last_text_hash.as_ref() {
                                    last_text_hash = Some(img_hash.clone());

                                    // 保存图片到磁盘
                                    let app_dir =
                                        app_handle.path().app_data_dir().unwrap_or_default();
                                    let img_dir = app_dir.join("images");
                                    if let Err(e) = std::fs::create_dir_all(&img_dir) {
                                        log::error!("[ClipboardMonitor] 创建图片目录失败 (跳过此次图片保存): {}", e);
                                        last_text_hash = None;
                                        continue; // 目录创建失败则不继续，避免后续 save 也失败导致数据丢失
                                    }
                                    let img_path = img_dir.join(format!("{}.png", img_hash));

                                    if !img_path.exists() {
                                        // 将 RGBA 数据转为 PNG 并保存
                                        let img_buf = image::RgbaImage::from_raw(
                                            img.width as u32,
                                            img.height as u32,
                                            img.bytes.to_vec(),
                                        );
                                        if let Some(img_buf) = img_buf {
                                            let dyn_img = image::DynamicImage::ImageRgba8(img_buf);
                                            // 缩放到最大 1080px（长边限制）
                                            let max_dim = 1080u32;
                                            let dyn_img = if img.width as u32 > max_dim
                                                || img.height as u32 > max_dim
                                            {
                                                let ratio = max_dim as f64
                                                    / img.width.max(img.height) as f64;
                                                let new_w = (img.width as f64 * ratio) as u32;
                                                let new_h = (img.height as f64 * ratio) as u32;
                                                dyn_img.resize_exact(
                                                    new_w,
                                                    new_h,
                                                    image::imageops::FilterType::Lanczos3,
                                                )
                                            } else {
                                                dyn_img
                                            };
                                            if let Err(e) = dyn_img.save(&img_path) {
                                                log::error!(
                                                    "[ClipboardMonitor] 保存图片失败 ({}): {}",
                                                    img_path.display(),
                                                    e
                                                );
                                            }
                                        }
                                    }

                                    let (img_source_title, img_source_icon) = get_foreground_window_info(&app_handle);

                                    let item = HistoryItem {
                                        id: Uuid::new_v4().to_string(),
                                        text: format!("[图片] {}x{}", img.width, img.height),
                                        time: chrono::Local::now()
                                            .format("%Y-%m-%d %H:%M:%S")
                                            .to_string(),
                                        item_type: "image".to_string(),
                                        content: img_path.to_string_lossy().to_string(),
                                        pinned: false,
                                        source: img_source_title,
                                        workspace: "默认".to_string(),
                                        md5: Some(img_hash),
                                        pinyin_initials: None,
                                        group_id: None,
                                        source_icon: img_source_icon,
                                        tags: Vec::new(),
                                    };

                                    if let Some(store) = app_handle.try_state::<DataStore>() {
                                        if let Err(e) = store.insert_history(&item) {
                                            log::error!(
                                                "[ClipboardMonitor] 插入图片记录失败: {}",
                                                e
                                            );
                                        }
                                    }
                                    if let Err(e) = app_handle.emit(
                                        "clipboard-changed",
                                        ClipboardChanged { item: item.clone() },
                                    ) {
                                        log::warn!("[ClipboardMonitor] 推送图片事件失败: {}", e);
                                    }

                                    // LAN 同步：发送图片到局域网
                                    if let Some(lan_sync) =
                                        app_handle.try_state::<crate::lan_sync::LanSync>()
                                    {
                                        let img_path_str = img_path.to_string_lossy().to_string();
                                        lan_sync.send_item(
                                            "image",
                                            &format!("[图片] {}", img_path_str),
                                            &img_path_str,
                                        );
                                    }
                                }
                            }
                            _ => {
                                // 尝试读取文件列表 (CF_HDROP)
                                #[cfg(target_os = "windows")]
                                if let Some(files) = get_clipboard_files() {
                                    let files_hash = files.join("|");
                                    let hash = format!(
                                        "{:x}",
                                        Md5::new().chain_update(files_hash.as_bytes()).finalize()
                                    );
                                    if Some(&hash) != last_text_hash.as_ref() {
                                        last_text_hash = Some(hash);
                                        let (file_source_title, file_source_icon) = get_foreground_window_info(&app_handle);
                                        for file_path in &files {
                                            let filename = std::path::Path::new(file_path)
                                                .file_name()
                                                .map(|n| n.to_string_lossy().to_string())
                                                .unwrap_or_else(|| file_path.clone());
                                            let file_hash = format!(
                                                "{:x}",
                                                Md5::new()
                                                    .chain_update(file_path.as_bytes())
                                                    .finalize()
                                            );
                                            let item = HistoryItem {
                                                id: Uuid::new_v4().to_string(),
                                                text: filename,
                                                time: chrono::Local::now()
                                                    .format("%Y-%m-%d %H:%M:%S")
                                                    .to_string(),
                                                item_type: "file".to_string(),
                                                content: file_path.clone(),
                                                pinned: false,
                                                source: file_source_title.clone(),
                                                workspace: "默认".to_string(),
                                                md5: Some(file_hash),
                                                pinyin_initials: None,
                                                group_id: None,
                                                source_icon: file_source_icon.clone(),
                                                tags: Vec::new(),
                                            };
                                            if let Some(store) = app_handle.try_state::<DataStore>()
                                            {
                                                if let Err(e) = store.insert_history(&item) {
                                                    log::error!(
                                                        "[ClipboardMonitor] 插入文件记录失败: {}",
                                                        e
                                                    );
                                                }
                                            }
                                            if let Err(e) = app_handle.emit(
                                                "clipboard-changed",
                                                ClipboardChanged { item: item.clone() },
                                            ) {
                                                log::warn!(
                                                    "[ClipboardMonitor] 推送文件事件失败: {}",
                                                    e
                                                );
                                            }

                                            // LAN 同步：发送文件路径到局域网
                                            if let Some(lan_sync) =
                                                app_handle.try_state::<crate::lan_sync::LanSync>()
                                            {
                                                lan_sync.send_item("file", &file_path, "");
                                            }
                                        }
                                    }
                                } else {
                                    last_text_hash = None;
                                }
                                #[cfg(not(target_os = "windows"))]
                                {
                                    last_text_hash = None;
                                }
                            }
                        }
                    }
                }
            }

            log::info!("[ClipboardMonitor] 监听线程退出");
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// 获取前台窗口标题 + 提取来源图标
/// 返回 (窗口标题, 图标文件名)
fn get_foreground_window_info(app_handle: &tauri::AppHandle) -> (String, Option<String>) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::*;
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return (String::new(), None);
            }
            let len = GetWindowTextLengthW(hwnd);
            if len == 0 {
                return (String::new(), None);
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..len as usize]);

            // 提取图标（首次提取约 50ms，后续缓存 <1ms）
            let icon = app_handle
                .try_state::<crate::icon_extractor::IconCache>()
                .and_then(|cache| cache.extract_icon_by_hwnd(hwnd));

            (title, icon)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        (String::new(), None)
    }
}

/// 从剪贴板读取文件路径列表 (CF_HDROP)
#[cfg(target_os = "windows")]
fn get_clipboard_files() -> Option<Vec<String>> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }

        const CF_HDROP: u32 = 15;
        let handle = GetClipboardData(CF_HDROP);
        let handle = match handle {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return None;
            }
        };

        if handle.is_invalid() {
            let _ = CloseClipboard();
            return None;
        }

        let hdrop = HDROP(handle.0);
        let mut files = Vec::new();

        // 获取文件数量
        let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);

        for i in 0..count {
            // 获取文件名长度（不含 null terminator）
            let needed = DragQueryFileW(hdrop, i, None);
            if needed == 0 {
                continue;
            }

            // 分配缓冲区并读取文件名
            let mut buf = vec![0u16; (needed + 1) as usize];
            let copied = DragQueryFileW(hdrop, i, Some(&mut buf));
            if copied > 0 {
                let path = OsString::from_wide(&buf[..copied as usize]);
                files.push(path.to_string_lossy().into_owned());
            }
        }

        let _ = CloseClipboard();
        if files.is_empty() {
            None
        } else {
            Some(files)
        }
    }
}
