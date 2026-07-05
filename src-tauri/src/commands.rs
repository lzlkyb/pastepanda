use crate::data_store::{DataStore, HistoryItem, Snippet, Stats};
use crate::paste_engine::PasteEngine;
use tauri::{Emitter, Manager, State};

/// 应用配置（从 tauri.conf.json 运行时读取，唯一配置来源）
use std::sync::LazyLock;
use std::sync::OnceLock;

/// 应用版本号（唯一来源：tauri.conf.json，构建时已由 sync-version.mjs 同步到 Cargo.toml）
/// 编译期 CARGO_PKG_VERSION 作为兜底，确保与 tauri.conf.json 一致。
pub static APP_VERSION: LazyLock<String> = LazyLock::new(|| {
    // 主路径：编译期嵌入（Cargo.toml 已由 prebuild 脚本同步）
    let compiled = env!("CARGO_PKG_VERSION").to_string();
    if !compiled.is_empty() && compiled != "0.0.0" {
        return compiled;
    }
    // 兜底：运行时读取 tauri.conf.json
    read_from_conf("version").unwrap_or_else(|_| "0.0.0".to_string())
});

/// 应用名称（由 lib.rs setup 通过 Tauri 框架 API 初始化，dev/安装版均可正确读取）
pub static APP_NAME: OnceLock<String> = OnceLock::new();

/// 获取应用版本号
#[tauri::command]
pub fn get_app_version() -> String {
    APP_VERSION.to_string()
}

/// 获取应用名称
#[tauri::command]
pub fn get_app_name() -> String {
    APP_NAME
        .get()
        .map(|s| s.as_str())
        .unwrap_or("PastePanda")
        .to_string()
}

/// 读取文件内容并返回 base64 编码（用于图片粘贴并变换）
#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::fs;
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

/// 从 tauri.conf.json 读取指定 key 的字符串值（兜底逻辑）
fn read_from_conf(key: &str) -> Result<String, Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    // 候选路径：当前目录 → exe 同级 → exe 父目录的 ..（开发模式 src-tauri/）
    let mut candidates = vec![std::path::PathBuf::from("tauri.conf.json")];
    if let Some(dir) = &exe_dir {
        candidates.push(dir.join("tauri.conf.json"));
        candidates.push(dir.join("..").join("tauri.conf.json"));
    }

    for path in &candidates {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            let search = format!("\"{}\"", key);
            if let Some(start) = content.find(&search) {
                let after_key = &content[start + search.len()..];
                let trimmed = after_key.trim_start_matches(|c| c == ':' || c == ' ' || c == '"');
                if let Some(end) = trimmed.find('"') {
                    return Ok(trimmed[..end].to_string());
                }
            }
        }
    }
    Err(format!("{} not found in tauri.conf.json", key).into())
}

#[tauri::command]
pub fn get_history(
    store: State<DataStore>,
    workspace: String,
    filter: String,
    search: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<HistoryItem>, String> {
    store.get_history(&workspace, &filter, &search, offset, limit)
}

#[tauri::command]
pub fn insert_history(store: State<DataStore>, item: HistoryItem) -> Result<(), String> {
    store.insert_history(&item)
}

/// 更新历史记录（编辑对话框用）
#[tauri::command]
pub fn update_history(store: State<DataStore>, id: String, text: String) -> Result<(), String> {
    store.update_history(&id, &text)
}

#[tauri::command]
pub fn delete_history(store: State<DataStore>, ids: Vec<String>) -> Result<u32, String> {
    store.delete_history(&ids)
}

#[tauri::command]
pub fn toggle_pin(store: State<DataStore>, id: String) -> Result<bool, String> {
    store.toggle_pin(&id)
}

#[tauri::command]
pub fn clear_history(
    store: State<DataStore>,
    workspace: String,
    before_days: Option<u32>,
) -> Result<serde_json::Value, String> {
    // 先获取即将被删除的记录（用于撤销）
    let deleted_items = store.get_history_before_cleanup(&workspace, before_days)?;
    let count = store.clear_history(&workspace, before_days)?;
    Ok(serde_json::json!({
        "count": count,
        "deleted_items": deleted_items,
    }))
}

#[tauri::command]
pub fn get_config(store: State<DataStore>) -> Result<serde_json::Value, String> {
    store.get_config()
}

#[tauri::command]
pub fn save_config(
    store: State<DataStore>,
    config: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store.save_config(&config)?;

    // 刷新剪贴板监听器的 auto_strip 缓存，避免每次都锁数据库读取配置
    if let Some(monitor) = app.try_state::<crate::clipboard_monitor::ClipboardMonitor>() {
        let auto_strip = config
            .get("auto_strip")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        monitor.update_auto_strip_cache(auto_strip);
    }

    Ok(())
}

#[tauri::command]
pub fn get_stats(store: State<DataStore>, workspace: String) -> Result<Stats, String> {
    store.get_stats(&workspace)
}

// ===== 粘贴引擎命令 =====

/// 复制文本到剪贴板并执行粘贴（Ctrl+V）
#[tauri::command]
pub fn paste_text(engine: State<PasteEngine>, text: String) -> Result<(), String> {
    engine.execute_paste(Some(text))
}

/// 仅复制文本到剪贴板（不粘贴）
#[tauri::command]
pub fn copy_only(engine: State<PasteEngine>, text: String) -> Result<(), String> {
    engine.copy_only(&text)
}

/// 粘贴图片到目标窗口
#[tauri::command]
pub fn paste_image(engine: State<PasteEngine>, image_path: String) -> Result<(), String> {
    engine.execute_paste_image(&image_path)
}

/// 保存当前前台窗口句柄（在显示窗口之前调用）
#[tauri::command]
pub fn save_foreground(engine: State<PasteEngine>) -> Result<(), String> {
    engine.save_foreground_hwnd();
    Ok(())
}

/// 切换窗口显示/隐藏
#[tauri::command]
pub fn toggle_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            if let Err(e) = window.hide() {
                log::warn!("[Commands] 隐藏窗口失败: {}", e);
            }
        } else {
            // 显示窗口前保存前台窗口句柄，确保粘贴时能找到正确的目标
            if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                engine.save_foreground_hwnd();
            }
            // 临时置顶确保窗口获得焦点，随后恢复（避免托盘弹窗关闭后焦点丢失）
            let _ = window.set_always_on_top(true);
            if let Err(e) = window.show() {
                log::warn!("[Commands] 显示窗口失败: {}", e);
            }
            window.set_focus().ok();
            // 延迟恢复置顶状态，确保焦点已稳定
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                let _ = w.set_always_on_top(false);
            });
        }
    }
    Ok(())
}

/// 从托盘弹窗触发：显示主窗口（先隐藏弹窗，避免弹窗 always_on_top 阻挡主窗口）
#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    // 1. 先隐藏托盘弹窗（弹窗是 always_on_top，必须先在 Rust 层关闭）
    if let Some(popup) = app.get_webview_window("tray-popup") {
        if popup.is_visible().unwrap_or(false) {
            popup.hide().ok();
        }
    }

    // 2. 显示主窗口
    if let Some(window) = app.get_webview_window("main") {
        // 保存前台窗口句柄（粘贴目标）
        if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
            engine.save_foreground_hwnd();
        }

        // 如果窗口最小化，先恢复
        window.unminimize().ok();

        // 临时置顶确保获得焦点，随后恢复
        let _ = window.set_always_on_top(true);
        if let Err(e) = window.show() {
            log::warn!("[Commands] show_main_window 显示失败: {}", e);
        }
        window.set_focus().ok();

        // 延迟恢复置顶状态
        let w = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = w.set_always_on_top(false);
        });
    }

    Ok(())
}

/// 退出应用程序
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 导入历史记录
#[tauri::command]
pub fn import_history(store: State<DataStore>, items: Vec<HistoryItem>) -> Result<u32, String> {
    store.import_history(&items)
}

/// 添加片段
#[tauri::command]
pub fn add_snippet(
    store: State<DataStore>,
    name: String,
    content: String,
) -> Result<String, String> {
    store.add_snippet(&name, &content)
}

/// 获取所有片段
#[tauri::command]
pub fn get_snippets(store: State<DataStore>) -> Result<Vec<Snippet>, String> {
    store.get_snippets()
}

/// 更新片段
#[tauri::command]
pub fn update_snippet(
    store: State<DataStore>,
    id: String,
    name: String,
    content: String,
    tag: String,
) -> Result<(), String> {
    store.update_snippet(&id, &name, &content, &tag)
}

/// 删除片段
#[tauri::command]
pub fn delete_snippet(store: State<DataStore>, id: String) -> Result<(), String> {
    store.delete_snippet(&id)
}

/// 获取全部历史记录（用于导出）
#[tauri::command]
pub fn get_all_history(
    store: State<DataStore>,
    workspace: String,
) -> Result<Vec<HistoryItem>, String> {
    store.get_all_history(&workspace)
}

/// 读取图片文件并返回 base64 data URL（原图，用于预览）
#[tauri::command]
pub fn get_image_data_url(path: String) -> Result<String, String> {
    use std::io::Read;

    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "图片文件过大 ({}MB)，超过 20MB 限制",
            metadata.len() / 1024 / 1024
        ));
    }

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    let base64_str = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &buffer);
    let mime = get_mime_from_path(&path);
    Ok(format!("data:{};base64,{}", mime, base64_str))
}

/// 获取缩略图缓存目录（在应用数据目录下，确保在 Tauri asset scope 内）
fn get_thumb_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?
        .join("thumbnails");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建缩略图缓存目录: {}", e))?;
    Ok(dir)
}

/// 生成图片缩略图并写入应用数据目录，返回文件路径（最大宽度 300px，用于卡片列表）
/// 使用文件路径而非 base64 data URL，浏览器可原生缓存图片
#[tauri::command]
pub fn get_image_thumbnail(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    use image::GenericImageView;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::io::BufWriter;
    use std::io::Write;

    const MAX_WIDTH: u32 = 300;
    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;

    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!("图片文件过大 ({}MB)", metadata.len() / 1024 / 1024));
    }

    // 用源路径 + 修改时间生成缩略图文件名（内容变化自动重建）
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let modified = metadata
        .modified()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        })
        .unwrap_or(0);
    modified.hash(&mut hasher);
    let hash = hasher.finish();
    let thumb_name = format!("thumb_{:016x}.jpg", hash);

    let thumb_dir = get_thumb_dir(&app_handle)?;
    let thumb_path = thumb_dir.join(&thumb_name);

    // 如果缩略图已存在且源文件未变化，直接返回路径
    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let img = image::open(&path).map_err(|e| format!("无法打开图片: {}", e))?;
    let (w, h) = img.dimensions();

    // 如果原图宽度 ≤ 300px，直接复制（转为 JPEG 减小体积）
    let output_img = if w <= MAX_WIDTH {
        img
    } else {
        let ratio = MAX_WIDTH as f64 / w as f64;
        let new_h = (h as f64 * ratio) as u32;
        img.resize_exact(MAX_WIDTH, new_h, image::imageops::FilterType::Lanczos3)
    };

    // 写入 JPEG 格式（比 PNG 小 3-5 倍，适合照片类图片）
    let file =
        std::fs::File::create(&thumb_path).map_err(|e| format!("无法创建缩略图文件: {}", e))?;
    let mut writer = BufWriter::new(file);
    output_img
        .write_to(&mut writer, image::ImageFormat::Jpeg)
        .map_err(|e| format!("无法写入缩略图: {}", e))?;
    writer.flush().map_err(|e| e.to_string())?;

    Ok(thumb_path.to_string_lossy().to_string())
}

/// 获取图片信息（尺寸、文件大小）
#[tauri::command]
pub fn get_image_info(path: String) -> Result<serde_json::Value, String> {
    use image::GenericImageView;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {}", e))?;
    let file_size = metadata.len();

    let (width, height) = image::open(&path)
        .map(|img| img.dimensions())
        .map_err(|e| format!("无法读取图片尺寸: {}", e))?;

    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未知");

    let size_str = if file_size >= 1024 * 1024 {
        format!("{:.1} MB", file_size as f64 / 1024.0 / 1024.0)
    } else if file_size >= 1024 {
        format!("{:.1} KB", file_size as f64 / 1024.0)
    } else {
        format!("{} B", file_size)
    };

    Ok(serde_json::json!({
        "width": width,
        "height": height,
        "file_size": file_size,
        "size_str": size_str,
        "file_name": file_name,
        "path": path,
    }))
}

fn get_mime_from_path(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// 重新注册全局热键（前端保存设置后调用）
#[tauri::command]
pub fn reregister_hotkeys(app: tauri::AppHandle, store: State<DataStore>) -> Result<(), String> {
    let config = store.get_config()?;
    let show_window = config
        .get("hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or("Ctrl+Shift+V")
        .to_string();
    let seq_paste = config
        .get("sequential_hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or("Ctrl+Q")
        .to_string();
    let hotkey_config = crate::hotkey_manager::HotkeyConfig {
        show_window,
        seq_paste,
        index_prefix: "Ctrl+Alt".to_string(),
    };
    crate::hotkey_manager::reregister_global_hotkeys(&app, &hotkey_config)
}

/// 获取文件信息（大小、是否存在）
#[tauri::command]
pub fn get_file_info(path: String) -> Result<serde_json::Value, String> {
    let metadata = std::fs::metadata(&path);
    match metadata {
        Ok(m) => Ok(serde_json::json!({
            "size": m.len(),
            "exists": true,
        })),
        Err(_) => Ok(serde_json::json!({
            "size": 0,
            "exists": false,
        })),
    }
}

/// 用系统默认程序打开文件（直接调用 Windows ShellExecute）
#[tauri::command]
pub fn open_file_with_system(path: String) -> Result<(), String> {
    // 先检查文件是否存在
    if !std::path::Path::new(&path).exists() {
        return Err(format!("文件不存在: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // ShellExecute 等价：用系统默认程序打开文件
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("打开文件失败: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("不支持的平台".to_string())
    }
}

/// 打开文件所在文件夹并选中文件
#[tauri::command]
pub fn open_file_location(path: String) -> Result<(), String> {
    // 先检查路径是否存在（文件或父目录）
    let p = std::path::Path::new(&path);
    let check_path = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent().map(|pp| pp.to_path_buf()).unwrap_or_default()
    };
    if !check_path.exists() {
        return Err("目标路径不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("不支持的平台".to_string())
    }
}

/// 保存图片文件（直接复制源文件到目标路径）
#[tauri::command]
pub fn save_image_file(source: String, dest: String) -> Result<(), String> {
    std::fs::copy(&source, &dest).map_err(|e| format!("保存图片失败: {}", e))?;
    Ok(())
}

// ===== 局域网同步命令 =====

/// 获取局域网同步状态（是否启用）
#[tauri::command]
pub fn get_lan_status(store: State<DataStore>) -> Result<bool, String> {
    let config = store.get_config()?;
    Ok(config
        .get("lan_sync_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// 切换局域网同步
#[tauri::command]
pub fn toggle_lan_sync(
    app: tauri::AppHandle,
    store: State<DataStore>,
    enable: bool,
) -> Result<(), String> {
    // 保存配置
    let mut config = store.get_config()?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "lan_sync_enabled".to_string(),
            serde_json::Value::Bool(enable),
        );
    }
    store.save_config(&config)?;

    // 启动/停止 LAN 同步
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        if enable {
            lan_sync.start_listener(app.clone());
        } else {
            lan_sync.stop();
        }
    }
    Ok(())
}

/// 发送测试同步消息
#[tauri::command]
pub fn send_lan_test(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        lan_sync.send("🔔 这是一条局域网同步测试消息");
    }
    Ok(())
}

/// 获取已发现的局域网设备列表
#[tauri::command]
pub fn get_lan_devices(app: tauri::AppHandle) -> Result<Vec<crate::lan_sync::LanDevice>, String> {
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        Ok(lan_sync.get_devices())
    } else {
        Ok(Vec::new())
    }
}

/// 设置开机自启
#[tauri::command]
pub fn set_startup(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = r"Software\Microsoft\Windows\CurrentVersion\Run";
        let (key, _) = hkcu.create_subkey(path).map_err(|e| e.to_string())?;
        if enable {
            let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value("ClipboardManager", &exe_path.to_string_lossy().to_string())
                .map_err(|e| e.to_string())?;
        } else {
            if let Err(e) = key.delete_value("ClipboardManager") {
                log::warn!("[Commands] 删除开机自启注册表失败: {}", e);
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enable;
        Ok(())
    }
}

/// 获取开机自启状态
#[tauri::command]
pub fn get_startup() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = r"Software\Microsoft\Windows\CurrentVersion\Run";
        match hkcu.open_subkey(path) {
            Ok(key) => Ok(key.get_value::<String, _>("ClipboardManager").is_ok()),
            Err(_) => Ok(false),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

/// 切换剪贴板监听状态
#[tauri::command]
pub fn toggle_monitor(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(monitor) = app.try_state::<crate::clipboard_monitor::ClipboardMonitor>() {
        if monitor.is_running() {
            monitor.stop();
            Ok(false)
        } else {
            monitor.start();
            Ok(true)
        }
    } else {
        Err("监听器未初始化".to_string())
    }
}

/// 获取剪贴板监听状态
#[tauri::command]
pub fn get_monitor_status(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(monitor) = app.try_state::<crate::clipboard_monitor::ClipboardMonitor>() {
        Ok(monitor.is_running())
    } else {
        Err("监听器未初始化".to_string())
    }
}

// ===== OCR 图片文字识别 =====

/// OCR 识别结果 — 每个词的信息
#[derive(serde::Serialize, Clone)]
pub struct OcrWordInfo {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// OCR 识别结果 — 按行分组
#[derive(serde::Serialize, Clone)]
pub struct OcrLineInfo {
    pub text: String,
    pub words: Vec<OcrWordInfo>,
}

/// OCR 识别结果
#[derive(serde::Serialize, Clone)]
pub struct OcrResult {
    pub lines: Vec<OcrLineInfo>,
    pub full_text: String,
}

/// 对图片文件执行 OCR 文字识别（Windows OCR 引擎）
/// 使用 async + spawn_blocking 避免阻塞主线程导致 UI 卡死
#[tauri::command]
pub async fn ocr_image(path: String) -> Result<OcrResult, String> {
    tokio::task::spawn_blocking(move || ocr_image_impl(&path))
        .await
        .map_err(|e| format!("OCR 任务失败: {}", e))?
}

#[cfg(target_os = "windows")]
fn ocr_image_impl(path: &str) -> Result<OcrResult, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    // 1. 用 StorageFile 打开图片文件
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|e| format!("打开文件失败: {}", e))?
        .get()
        .map_err(|e| format!("等待文件打开失败: {}", e))?;

    // 2. 打开文件流 (需要 Storage_Streams feature)
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("打开文件流失败: {}", e))?
        .get()
        .map_err(|e| format!("等待文件流失败: {}", e))?;

    // 3. 解码图片 (静态方法, 需要 Storage_Streams feature)
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("创建解码器失败: {}", e))?
        .get()
        .map_err(|e| format!("解码图片失败: {}", e))?;

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("获取位图失败: {}", e))?
        .get()
        .map_err(|e| format!("读取位图数据失败: {}", e))?;

    // 4. 创建 OCR 引擎（中文优先，回退英文）
    let language = Language::CreateLanguage(&HSTRING::from("zh-Hans"))
        .or_else(|_| Language::CreateLanguage(&HSTRING::from("en-US")))
        .map_err(|_| "无法创建语言对象".to_string())?;

    let engine = OcrEngine::TryCreateFromLanguage(&language)
        .map_err(|e| format!("创建 OCR 引擎失败: {}. 请确保系统已安装中文语言包", e))?;

    // 5. 执行 OCR
    let ocr_result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR 识别失败: {}", e))?
        .get()
        .map_err(|e| format!("获取 OCR 结果失败: {}", e))?;

    // 6. 提取结果 (Lines/Words 需要 Foundation_Collections feature)
    let lines = {
        let ocr_lines = ocr_result
            .Lines()
            .map_err(|e| format!("获取 OCR 行失败: {}", e))?;
        let count = ocr_lines
            .Size()
            .map_err(|e| format!("获取行数失败: {}", e))? as usize;
        let mut lines_vec = Vec::with_capacity(count);
        for i in 0..count {
            let line = ocr_lines
                .GetAt(i as u32)
                .map_err(|e| format!("获取第 {} 行失败: {}", i, e))?;
            let line_text = line.Text().unwrap_or_default().to_string();

            let words_iv = line.Words().map_err(|e| format!("获取词列表失败: {}", e))?;
            let wcount = words_iv
                .Size()
                .map_err(|e| format!("获取词数失败: {}", e))? as usize;
            let mut words = Vec::with_capacity(wcount);
            for j in 0..wcount {
                let word = words_iv
                    .GetAt(j as u32)
                    .map_err(|e| format!("获取第 {}-{} 个词失败: {}", i, j, e))?;
                let rect = word.BoundingRect().unwrap_or_default();
                words.push(OcrWordInfo {
                    text: word.Text().unwrap_or_default().to_string(),
                    x: rect.X,
                    y: rect.Y,
                    width: rect.Width,
                    height: rect.Height,
                });
            }
            lines_vec.push(OcrLineInfo {
                text: line_text,
                words,
            });
        }
        lines_vec
    };

    let full_text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(OcrResult { lines, full_text })
}

#[cfg(not(target_os = "windows"))]
fn ocr_image_impl(_path: &str) -> Result<OcrResult, String> {
    Err("OCR 功能仅支持 Windows 系统".to_string())
}

// ===== 置顶图片（原生 Windows 窗口） =====

/// 创建原生 Windows 窗口显示置顶图片（GDI 渲染，不依赖 WebView）
#[tauri::command]
pub fn open_pinned_image(
    _app: tauri::AppHandle,
    _store: State<DataStore>,
    path: String,
) -> Result<(), String> {
    log::info!("[pinned-image] open_pinned_image 被调用, path: {}", path);
    crate::pinned_window::create_native_window(&path)
}

/// 关闭置顶图片（通知前端隐藏遮罩层 + 取消窗口置顶）
#[tauri::command]
pub fn close_pinned_image() -> Result<(), String> {
    log::info!("[pinned-image] close_pinned_image 被调用（原生窗口自行关闭，无需额外操作）");
    Ok(())
}

/// 隐藏托盘弹窗（前端点击弹窗外部时调用）
#[tauri::command]
pub fn hide_tray_popup(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(popup) = app.get_webview_window("tray-popup") {
        if popup.is_visible().unwrap_or(false) {
            popup.hide().ok();
        }
    }
    Ok(())
}

/// 前端主动获取托盘弹窗初始化数据（解决事件时序竞态问题）
#[tauri::command]
pub fn get_tray_popup_data(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use crate::tray_manager;

    let monitoring = tray_manager::is_monitoring_public(&app);
    let recents = tray_manager::get_recent_texts_public(&app, 3);
    let popup_data = tray_manager::build_popup_data_public(&app, &recents, monitoring);
    Ok(popup_data)
}

/// 从托盘弹窗触发：通过 Rust 中转 emit "tray-open-settings" 事件到主窗口
/// 避免前端弹窗 hide() 后 emit 事件丢失的问题
#[tauri::command]
pub fn emit_tray_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit("tray-open-settings", ())
            .map_err(|e| format!("发送设置事件失败: {}", e))?;
    }
    Ok(())
}

// ===== 自动更新（后台线程，不阻塞 UI） =====

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    tauri::async_runtime::spawn(async move {
        // → 通知前端：检查中
        let _ = app.emit("update:checking", ());

        // 使用 UpdaterExt trait 的方法检查更新
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("更新插件初始化失败: {}", e)
                    }),
                );
                return;
            }
        };

        let check_result = match updater.check().await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("检查更新失败: {}", e)
                    }),
                );
                return;
            }
        };

        let update = match check_result {
            Some(u) => u,
            None => {
                // 已是最新版本
                let _ = app.emit("update:uptodate", ());
                return;
            }
        };

        // → 通知前端：发现新版本
        let _ = app.emit(
            "update:available",
            serde_json::json!({
                "version": update.version,
                "body": update.body,
            }),
        );

        // → 通知前端：开始下载
        let _ = app.emit("update:downloading", ());

        // 下载并安装（带进度回调）
        let app_progress = app.clone();
        let app_ready = app.clone();
        let result = update
            .download_and_install(
                // on_chunk: 下载进度回调
                move |downloaded, total| {
                    let _ = app_progress.emit(
                        "update:progress",
                        serde_json::json!({
                            "downloaded": downloaded,
                            "total": total,
                        }),
                    );
                },
                // on_download_finish: 下载完成回调
                move || {
                    let _ = app_ready.emit("update:ready", ());
                },
            )
            .await;

        if let Err(e) = result {
            let _ = app.emit(
                "update:error",
                serde_json::json!({
                    "message": format!("下载安装失败: {}", e)
                }),
            );
        }
    });
}
