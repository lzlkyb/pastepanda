use crate::content_classifier::ContentClassifier;
use crate::data_store::{compute_pinyin_initials, DataStore, HistoryItem};
use arboard::Clipboard;
use md5::{Digest, Md5};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
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

    /// 时间抑制兜底检查：是否仍处于自粘贴抑制窗口内。
    /// 作为 hash 主检查的兜底——覆盖 hash 已被清除的轮询竞态，以及无 hash 的粘贴路径（如文件）。
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

    /// U57：是否处于"hash 设防"模式（已知预期粘贴内容）。
    /// hash 模式下监听端只应按 hash 匹配跳过，不得用时间窗口无差别吞掉
    /// 粘贴后 3 秒内用户的新复制；时间兜底仅适用于无 hash 的粘贴路径。
    pub fn has_expected_hash(&self) -> bool {
        if let Ok(guard) = self.expected_hash.lock() {
            guard.is_some()
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
    /// 修复 U36：缓存"不记录匹配密钥模式的内容"开关
    cached_skip_sensitive: Arc<std::sync::RwLock<bool>>,
    /// 修复 U36：缓存应用排除名单（来源应用名，命中则不记录）
    cached_excluded_apps: Arc<std::sync::RwLock<Vec<String>>>,
}

impl ClipboardMonitor {
    pub fn new(app_handle: AppHandle, paste_suppress: Arc<PasteSuppress>) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            app_handle,
            paste_suppress,
            cached_auto_strip: Arc::new(std::sync::RwLock::new(false)),
            // U36：默认开启敏感内容防护
            cached_skip_sensitive: Arc::new(std::sync::RwLock::new(true)),
            cached_excluded_apps: Arc::new(std::sync::RwLock::new(Vec::new())),
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

    /// 修复 U36：更新敏感内容防护缓存（由前端保存配置后调用）
    pub fn update_sensitive_cache(&self, skip_sensitive: bool, excluded_apps: Vec<String>) {
        if let Ok(mut guard) = self.cached_skip_sensitive.write() {
            *guard = skip_sensitive;
        }
        if let Ok(mut guard) = self.cached_excluded_apps.write() {
            *guard = excluded_apps;
        }
    }

    /// 修复 U36：判断文本是否应按敏感内容跳过记录
    fn should_skip_sensitive(&self, text: &str) -> bool {
        let skip = self
            .cached_skip_sensitive
            .read()
            .map(|g| *g)
            .unwrap_or(true);
        if !skip {
            return false;
        }
        let classifier = crate::content_classifier::ContentClassifier::new();
        classifier.is_secret(text)
    }

    /// 修复 U36：判断来源应用是否在排除名单内
    fn is_excluded_app(&self, source_title: &str) -> bool {
        let excluded = match self.cached_excluded_apps.read() {
            Ok(g) => g.clone(),
            Err(_) => return false,
        };
        if excluded.is_empty() || source_title.is_empty() {
            return false;
        }
        let lower = source_title.to_lowercase();
        excluded.iter().any(|app| {
            let app = app.trim().to_lowercase();
            !app.is_empty() && lower.contains(&app)
        })
    }

    pub fn start(&self) {
        // 修复 M2：原子 CAS 替代"先判断后置位"，防止并发 toggle 同时通过检查
        // 而 spawn 出两个轮询线程（各持独立 last_text_hash → 图片/文件重复入库）
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let running = self.running.clone();
        let app_handle = self.app_handle.clone();
        let paste_suppress = self.paste_suppress.clone();

        std::thread::spawn(move || {
            log::info!("[ClipboardMonitor] 监听线程启动");

            let mut clipboard = match Clipboard::new() {
                Ok(c) => c,
                Err(e) => {
                    // 修复 C8：失败时复位 running，否则 is_running() 永远为 true、
                    // start() 永远提前返回，监听永久失效（只能重启应用）。
                    // 同时广播状态事件，让 UI 不再显示"监听中"。
                    log::error!("[ClipboardMonitor] 无法打开剪贴板: {}", e);
                    running.store(false, Ordering::SeqCst);
                    let _ = app_handle.emit("monitor-status-changed", false);
                    return;
                }
            };

            let mut last_text_hash: Option<String> = None;
            let poll_interval = Duration::from_millis(400);

            // Low 修复：启动/重启时以当前剪贴板内容作为基准 hash，
            // 避免监听恢复后必然把已存在的内容重复记录一条
            if let Ok(initial_text) = clipboard.get_text() {
                if !initial_text.is_empty() {
                    let initial_text = if let Some(monitor) = app_handle.try_state::<ClipboardMonitor>()
                    {
                        if monitor.get_auto_strip() {
                            initial_text.trim().to_string()
                        } else {
                            initial_text
                        }
                    } else {
                        initial_text
                    };
                    if !initial_text.is_empty() {
                        last_text_hash = Some(format!(
                            "{:x}",
                            Md5::new().chain_update(initial_text.as_bytes()).finalize()
                        ));
                    }
                }
            }

            while running.load(Ordering::SeqCst) {
                std::thread::sleep(poll_interval);

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

                        // U57：hash 设防模式下只认 hash 匹配（上面已处理），
                        // 窗口过期仍未命中则清除陈旧 hash，避免误吞用户后续复制的相同内容；
                        // 时间兜底仅对无 hash 的粘贴路径（如"粘贴当前剪贴板"）生效
                        if paste_suppress.has_expected_hash() {
                            if !paste_suppress.is_suppressed() {
                                paste_suppress.clear_hash();
                            }
                        } else if paste_suppress.is_suppressed() {
                            log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (无hash路径·时间抑制窗口内)");
                            last_text_hash = Some(hash);
                            continue;
                        }

                        if Some(&hash) != last_text_hash.as_ref() {
                            last_text_hash = Some(hash.clone());

                            // 获取前台窗口信息（标题 + 图标，一次调用）
                            let (source_title, source_icon) = get_foreground_window_info(&app_handle);

                            // 修复 U36：敏感内容防护 —— 命中应用排除名单或密钥模式时不记录
                            // （在入库/合并/推送/局域网同步之前拦截，确保敏感内容不落盘、不外传）
                            if let Some(monitor) = app_handle.try_state::<ClipboardMonitor>() {
                                if monitor.is_excluded_app(&source_title) {
                                    log::info!(
                                        "[ClipboardMonitor] 跳过敏感内容：来源应用 \"{}\" 在排除名单内",
                                        source_title
                                    );
                                    continue;
                                }
                                if monitor.should_skip_sensitive(&text) {
                                    log::info!(
                                        "[ClipboardMonitor] 跳过敏感内容：匹配密钥/凭证模式，不记录"
                                    );
                                    continue;
                                }
                            }

                            // 计算拼音首字母
                            let pinyin_initials = compute_pinyin_initials(&text);
                            let now_str =
                                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

                            // 智能合并：检查是否已存在相同 md5 的文本记录
                            let store = app_handle.try_state::<DataStore>();
                            let mut existing_id: Option<String> = None;
                            if let Some(ref store) = store {
                                if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认") {
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
                                // 统一分类：一次 classify() 同时派生 content_type 和自动标签
                                let labels = ContentClassifier::new().classify(&text);
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
                                    content_type: Some(ContentClassifier::content_type_from_labels(&labels).to_string()),
                                    tags: Vec::new(),
                                };

                                // 插入数据库
                                if let Some(ref store) = store {
                                    if let Err(e) = store.insert_history(&item) {
                                        log::error!("[ClipboardMonitor] 插入失败: {}", e);
                                    }
                                }

                                // 自动标签写入：后台线程只做 DB 操作（分类已在上方同步完成，< 0.5ms）
                                // 并发上限：剪贴板高频突发（同步工具/脚本）时避免无界创建线程（M29）
                                {
                                    const MAX_CLASSIFY_IN_FLIGHT: usize = 4;
                                    static CLASSIFY_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

                                    if CLASSIFY_IN_FLIGHT.load(Ordering::SeqCst) >= MAX_CLASSIFY_IN_FLIGHT {
                                        log::debug!("[ContentClassifier] 标签写入线程已达上限，跳过本条");
                                    } else {
                                        CLASSIFY_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
                                        let history_id = item.id.clone();
                                        let app_clone = app_handle.clone();
                                        std::thread::spawn(move || {
                                            // panic-safe 计数复位
                                            struct DecOnDrop;
                                            impl Drop for DecOnDrop {
                                                fn drop(&mut self) {
                                                    CLASSIFY_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
                                                }
                                            }
                                            let _dec = DecOnDrop;

                                            if let Some(store) = app_clone.try_state::<DataStore>() {
                                                if let Ok(tag_ids) = store.resolve_auto_tag_ids(&labels) {
                                                    if !tag_ids.is_empty() {
                                                        if let Err(e) = store.add_history_tags(&history_id, &tag_ids) {
                                                            log::warn!("[ContentClassifier] 写入自动标签失败: {}", e);
                                                        } else {
                                                            log::info!("[ContentClassifier] 自动分类: {:?} → {}", labels, history_id);
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

                                // U57：hash 设防模式下只认 hash 匹配（上面已处理），
                                // 窗口过期仍未命中则清除陈旧 hash；时间兜底仅对无 hash 路径生效
                                if paste_suppress.has_expected_hash() {
                                    if !paste_suppress.is_suppressed() {
                                        paste_suppress.clear_hash();
                                    }
                                } else if paste_suppress.is_suppressed() {
                                    log::info!("[ClipboardMonitor] 跳过自身粘贴图片 (无hash路径·时间抑制窗口内)");
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
                                        let Some(img_buf) = img_buf else {
                                            log::error!(
                                                "[ClipboardMonitor] 图片 RGBA 数据与尺寸不匹配 ({}x{})，跳过本次图片",
                                                img.width,
                                                img.height
                                            );
                                            last_text_hash = None;
                                            continue;
                                        };
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
                                            // 修复 M4：保存失败即中止，不再插入指向不存在文件的历史记录
                                            // （此前仅 log 不中断，记录 content 指向缺失文件，UI 点击必报错）
                                            log::error!(
                                                "[ClipboardMonitor] 保存图片失败 ({}): {}，跳过本条记录",
                                                img_path.display(),
                                                e
                                            );
                                            last_text_hash = None;
                                            continue;
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
                                        content_type: Some("image".to_string()),
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
                                                content_type: Some("file".to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_new_not_suppressed() {
        let ps = PasteSuppress::new();
        assert!(!ps.is_suppressed());
        assert!(!ps.has_expected_hash());
    }

    #[test]
    fn test_set_activates_time_window() {
        let ps = PasteSuppress::new();
        ps.set(Duration::from_millis(200));
        assert!(ps.is_suppressed());
    }

    #[test]
    fn test_time_window_expires() {
        let ps = PasteSuppress::new();
        ps.set(Duration::from_millis(50));
        assert!(ps.is_suppressed());
        thread::sleep(Duration::from_millis(80));
        assert!(!ps.is_suppressed());
    }

    #[test]
    fn test_set_with_hash() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_millis(200), "abc123".to_string());
        assert!(ps.is_suppressed());
        assert!(ps.has_expected_hash());
        assert!(ps.is_hash_suppressed("abc123"));
        assert!(!ps.is_hash_suppressed("other"));
    }

    #[test]
    fn test_hash_suppressed_after_time_expires() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_millis(30), "hash1".to_string());
        thread::sleep(Duration::from_millis(60));
        // 时间窗口过期
        assert!(!ps.is_suppressed());
        // 但 hash 仍然匹配（U57 双重检查的核心）
        assert!(ps.has_expected_hash());
        assert!(ps.is_hash_suppressed("hash1"));
    }

    #[test]
    fn test_clear_hash() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_secs(10), "h".to_string());
        assert!(ps.has_expected_hash());
        ps.clear_hash();
        assert!(!ps.has_expected_hash());
        assert!(!ps.is_hash_suppressed("h"));
        // 时间窗口不受 clear_hash 影响
        assert!(ps.is_suppressed());
    }

    #[test]
    fn test_u57_dual_check_pattern() {
        // 模拟 U57 修复后的监听循环逻辑：
        // if has_expected_hash() { if !is_hash_suppressed(hash) { clear_hash(); } }
        // else if is_suppressed() { skip }
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_millis(30), "pasted_content".to_string());
        thread::sleep(Duration::from_millis(60)); // 时间过期

        // 场景 1：新复制的内容 hash 匹配 → 应跳过（自粘贴回显）
        let new_hash = "pasted_content";
        if ps.has_expected_hash() {
            assert!(ps.is_hash_suppressed(new_hash)); // 匹配 → 跳过
        }

        // 场景 2：新复制的内容 hash 不匹配 → 应清除 hash 并正常记录
        let different_hash = "user_new_content";
        if ps.has_expected_hash() {
            if !ps.is_hash_suppressed(different_hash) {
                ps.clear_hash(); // 不匹配 → 清除，正常记录
            }
        }
        assert!(!ps.has_expected_hash());
    }

    #[test]
    fn test_set_overwrites_previous() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_secs(10), "old".to_string());
        ps.set_with_hash(Duration::from_secs(10), "new".to_string());
        assert!(ps.is_hash_suppressed("new"));
        assert!(!ps.is_hash_suppressed("old"));
    }

    #[test]
    fn test_concurrent_access() {
        let ps = Arc::new(PasteSuppress::new());
        let ps2 = Arc::clone(&ps);
        let handle = thread::spawn(move || {
            ps2.set_with_hash(Duration::from_millis(100), "t".to_string());
        });
        handle.join().unwrap();
        assert!(ps.is_suppressed());
        assert!(ps.is_hash_suppressed("t"));
    }
}
