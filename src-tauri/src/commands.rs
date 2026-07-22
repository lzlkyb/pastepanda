use crate::data_store::{DataStore, Group, HistoryItem, Snippet, Stats, Tag};
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

/// 图片扩展名白名单：用于校验用户选择/粘贴的图片路径，防止通过这些命令读取或写入任意文件
const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"];

/// 校验路径是否为合法的图片文件：规范化路径后确认其存在、是普通文件，且扩展名在允许列表内。
/// 返回规范化后的路径，调用方应使用该路径进行后续文件操作。
fn validate_image_file_path(path: &str) -> Result<std::path::PathBuf, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("路径无效或文件不存在: {e}"))?;

    if !canonical.is_file() {
        return Err("目标路径不是一个有效的文件".to_string());
    }

    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    if !ALLOWED_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的文件类型: .{ext}，仅允许图片文件 ({})",
            ALLOWED_IMAGE_EXTENSIONS.join(", ")
        ));
    }

    Ok(canonical)
}

/// 图片最大解码像素数（100MP ≈ 400MB RGBA 内存），防止解压炸弹（修复 C18）
pub(crate) const MAX_DECODE_PIXELS: u64 = 100_000_000;

/// 仅读取图片头部获取尺寸（不完整解码），并校验是否超过解码上限。
/// 供所有 image::open 调用点前置调用，防止小文件解码出巨大位图导致内存暴涨（修复 C18）。
pub(crate) fn check_image_decode_limits(path: &std::path::Path) -> Result<(u32, u32), String> {
    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("无法打开图片: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("无法识别图片格式: {e}"))?;
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| format!("无法读取图片尺寸: {e}"))?;
    if (w as u64) * (h as u64) > MAX_DECODE_PIXELS {
        return Err(format!(
            "图片尺寸过大 ({}x{}，约 {}MP)，超过 {}MP 解码上限",
            w,
            h,
            (w as u64) * (h as u64) / 1_000_000,
            MAX_DECODE_PIXELS / 1_000_000
        ));
    }
    Ok((w, h))
}

/// 读取文件内容并返回 base64 编码（用于图片粘贴并变换）
#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    // 修复 C15：与 get_image_data_url 一致的 20MB 上限，防止合法扩展名的超大文件导致 OOM
    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "图片文件过大 ({}MB)，超过 20MB 限制",
            metadata.len() / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("读取文件失败: {e}"))?;
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
    // 修复 Low：单次原子操作完成 读取被删记录 + 删除，避免读写竞态
    let (count, deleted_items) = store.clear_history_with_undo(&workspace, before_days)?;
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

        // 修复 U36：刷新敏感内容防护缓存（默认开启）
        let skip_sensitive = config
            .get("skip_sensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let excluded_apps: Vec<String> = config
            .get("excluded_apps")
            .and_then(|v| v.as_str())
            .map(|s| {
                s.split(',')
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        monitor.update_sensitive_cache(skip_sensitive, excluded_apps);
    }

    Ok(())
}

#[tauri::command]
pub fn get_stats(store: State<DataStore>, workspace: String) -> Result<Stats, String> {
    store.get_stats(&workspace)
}

// ===== 粘贴引擎命令 =====

/// 粘贴诊断结果
#[derive(serde::Serialize)]
pub struct PasteResult {
    pub success: bool,
    pub error: Option<String>,
    pub target_hwnd: Option<isize>,
    pub clipboard_written: bool,
    pub wm_paste_sent: bool,
}

/// 复制文本到剪贴板并执行粘贴（Ctrl+V）
#[tauri::command]
pub fn paste_text(engine: State<PasteEngine>, text: String) -> Result<PasteResult, String> {
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

/// 记录片段被使用（复制）
#[tauri::command]
pub fn use_snippet(store: State<DataStore>, id: String) -> Result<(), String> {
    store.use_snippet(&id)
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
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "图片文件过大 ({}MB)，超过 20MB 限制",
            metadata.len() / 1024 / 1024
        ));
    }

    let mut file = std::fs::File::open(&canonical).map_err(|e| e.to_string())?;
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
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::io::BufWriter;
    use std::io::Write;

    const MAX_WIDTH: u32 = 300;
    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;

    // 修复 C16：与其他图片命令一致的严格路径校验（canonicalize + 白名单）
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!("图片文件过大 ({}MB)", metadata.len() / 1024 / 1024));
    }

    // 修复 C18：仅读头部校验尺寸，防止解压炸弹
    let (w, h) = check_image_decode_limits(&canonical)?;

    // 用源路径 + 修改时间生成缩略图文件名（内容变化自动重建）
    let mut hasher = DefaultHasher::new();
    canonical.to_string_lossy().hash(&mut hasher);
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

    let img = image::open(&canonical).map_err(|e| format!("无法打开图片: {}", e))?;

    // 如果原图宽度 ≤ 300px，直接复制（转为 JPEG 减小体积）
    let output_img = if w <= MAX_WIDTH {
        img
    } else {
        let ratio = MAX_WIDTH as f64 / w as f64;
        let new_h = ((h as f64 * ratio) as u32).max(1);
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
    // 修复 C16/C18 同类问题：统一路径校验 + 仅读头部获取尺寸（无需完整解码，防解压炸弹）
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {}", e))?;
    let file_size = metadata.len();

    let (width, height) = check_image_decode_limits(&canonical)?;

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
        .unwrap_or("Ctrl+Alt+V")
        .to_string();
    let seq_paste = config
        .get("sequential_hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or("Ctrl+Alt+Q")
        .to_string();
    let stack_toggle = config
        .get("stack_toggle_hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or("Ctrl+Alt+K")
        .to_string();
    let stack_paste = config
        .get("stack_paste_hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or("Ctrl+Alt+P")
        .to_string();
    let hotkey_config = crate::hotkey_manager::HotkeyConfig {
        show_window,
        seq_paste,
        index_prefix: "Ctrl+Alt".to_string(),
        stack_toggle,
        stack_paste,
    };
    crate::hotkey_manager::reregister_global_hotkeys(&app, &hotkey_config)
}

/// 安全检查：拒绝 UNC / 网络共享路径（\\server\share 或 //server/share）。
/// Windows 上对此类路径执行 exists()/metadata()/explorer 会自动发起 SMB 认证，
/// 泄漏用户的 NTLMv2 凭据哈希（可被离线爆破或中继）。剪贴板中的文件路径可能被
/// 恶意程序或 LAN 同步注入，因此必须在任何文件系统操作前拦截（修复 C3）。
fn is_unsafe_network_path(path: &str) -> bool {
    let trimmed = path.trim();
    trimmed.starts_with("\\\\") || trimmed.starts_with("//")
}

/// 获取文件信息（大小、是否存在）
#[tauri::command]
pub fn get_file_info(path: String) -> Result<serde_json::Value, String> {
    if is_unsafe_network_path(&path) {
        return Ok(serde_json::json!({
            "size": 0,
            "exists": false,
        }));
    }
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
    if is_unsafe_network_path(&path) {
        return Err("不支持打开网络共享路径（安全限制）".to_string());
    }
    // 先检查文件是否存在
    if !std::path::Path::new(&path).exists() {
        return Err(format!("文件不存在: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // 与 open_file_location 保持一致：调用 explorer.exe 打开文件，
        // 避免通过 cmd /C start 触发 shell 解析导致的命令注入/参数注入风险
        Command::new("explorer")
            .arg(&path)
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
    if is_unsafe_network_path(&path) {
        return Err("不支持打开网络共享路径（安全限制）".to_string());
    }
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

/// 保存图片目标路径的敏感目录黑名单（防御性层：拒绝写入到开机启动项、系统目录等敏感位置）
fn sensitive_dest_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(
            std::path::PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
        );
    }
    if let Ok(windir) = std::env::var("WINDIR").or_else(|_| std::env::var("SystemRoot")) {
        dirs.push(std::path::PathBuf::from(windir).join("System32"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        dirs.push(std::path::PathBuf::from(pf));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        dirs.push(std::path::PathBuf::from(pf86));
    }

    dirs
}

/// 保存图片文件（直接复制源文件到目标路径）
/// 安全约束：
/// - source 必须是已存在的图片文件（扩展名在白名单内），防止读取任意文件内容；
/// - dest 的文件扩展名也必须在图片白名单内，拒绝 .exe/.bat/.lnk 等可执行/快捷方式扩展名；
/// - dest 所在目录不得落在敏感目录（开机启动目录、System32、Program Files 等）内。
/// 目标路径本身允许是用户通过系统"另存为"对话框选择的任意正常位置——该对话框已构成
/// "写到哪里"的用户同意边界，这里只约束"写入的是什么"，避免任意文件读取后写出的攻击链。
#[tauri::command]
pub fn save_image_file(source: String, dest: String) -> Result<(), String> {
    let source_canonical = validate_image_file_path(&source)?;

    let dest_path = std::path::Path::new(&dest);

    let dest_ext = dest_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_IMAGE_EXTENSIONS.contains(&dest_ext.as_str()) {
        return Err(format!(
            "不支持的目标文件类型: .{dest_ext}，仅允许保存为图片文件 ({})",
            ALLOWED_IMAGE_EXTENSIONS.join(", ")
        ));
    }

    let dest_parent = dest_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "目标路径无效".to_string())?;
    let dest_file_name = dest_path
        .file_name()
        .ok_or_else(|| "目标路径缺少文件名".to_string())?;

    // 目标所在目录必须已存在（不基于用户输入创建任意目录，避免路径穿越产生的副作用）
    let dest_parent_canonical =
        std::fs::canonicalize(dest_parent).map_err(|_| "目标目录不存在或无效".to_string())?;

    // 防御性层：拒绝写入到系统/开机等敏感目录，降低"写图片到启动项进行骚扰性持久化"的风险
    for sensitive in sensitive_dest_dirs() {
        if let Ok(sensitive_canonical) = std::fs::canonicalize(&sensitive) {
            if dest_parent_canonical.starts_with(&sensitive_canonical) {
                return Err(format!(
                    "出于安全考虑，不允许保存到该目录: {}",
                    sensitive.display()
                ));
            }
        }
    }

    let dest_final = dest_parent_canonical.join(dest_file_name);
    std::fs::copy(&source_canonical, &dest_final).map_err(|e| format!("保存图片失败: {}", e))?;
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

/// 获取当前局域网配对密钥（用于在设置面板中展示，供用户手动复制到其他设备完成配对）
#[tauri::command]
pub fn get_lan_pairing_key(
    app: tauri::AppHandle,
    store: State<DataStore>,
) -> Result<String, String> {
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        let key = lan_sync.get_pairing_key();
        if !key.is_empty() {
            return Ok(key);
        }
    }
    // 回退：正常情况下启动时已生成并注入 LanSync，这里仅作兜底，直接读配置
    let config = store.get_config()?;
    Ok(config
        .get("lan_pairing_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// 设置（粘贴自其他设备的）局域网配对密钥，持久化并立即在运行时生效
#[tauri::command]
pub fn set_lan_pairing_key(
    app: tauri::AppHandle,
    store: State<DataStore>,
    key: String,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("配对密钥不能为空".to_string());
    }
    // 修复 M14：密钥强度校验，拒绝 "1" 这类可离线爆破的弱密钥
    crate::lan_sync::validate_pairing_key(&key)?;

    let mut config = store.get_config()?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "lan_pairing_key".to_string(),
            serde_json::Value::String(key.clone()),
        );
    }
    store.save_config(&config)?;

    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        lan_sync.set_pairing_key(key);
    }
    Ok(())
}

/// 重新生成一个随机配对密钥，持久化并立即生效，返回新密钥。
/// 注意：更换密钥后，其他已配对设备需要重新粘贴此密钥才能继续同步。
#[tauri::command]
pub fn regenerate_lan_pairing_key(
    app: tauri::AppHandle,
    store: State<DataStore>,
) -> Result<String, String> {
    let new_key = crate::lan_sync::generate_pairing_key();

    let mut config = store.get_config()?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "lan_pairing_key".to_string(),
            serde_json::Value::String(new_key.clone()),
        );
    }
    store.save_config(&config)?;

    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        lan_sync.set_pairing_key(new_key.clone());
    }
    Ok(new_key)
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
            // U5：自启命令追加 /silent 标志 — 开机启动时静默驻留托盘，不弹窗抢焦点
            // （路径加引号防止空格导致解析错误）
            let cmd = format!("\"{}\" /silent", exe_path.to_string_lossy());
            key.set_value("ClipboardManager", &cmd)
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

    // 修复 C16/C18 同类问题：OCR 通道此前无任何路径校验，可读取任意文件。
    // 统一走白名单 + canonicalize（兼防 UNC 凭据泄漏），并做头部尺寸校验防解压炸弹。
    let canonical = validate_image_file_path(path)?;
    check_image_decode_limits(&canonical)?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // 1. 用 StorageFile 打开图片文件
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(canonical_str))
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

/// 关闭置顶图片（通知前端隐藏遮罩层 + 主动关闭当前原生置顶窗口）
#[tauri::command]
pub fn close_pinned_image() -> Result<(), String> {
    log::info!("[pinned-image] close_pinned_image 被调用");
    crate::pinned_window::close_current_window();
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

/// 设置剪贴板栈模式（切换托盘图标橙色圆点）
#[tauri::command]
pub fn set_stack_mode(app: tauri::AppHandle, active: bool) {
    crate::tray_manager::set_tray_stack_mode(&app, active);
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

/// 指数退避重试辅助函数
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                // 指数退避：1s, 2s, 4s, 8s, ...
                let delay_secs = 1u64 << (attempt - 1);
                log::warn!(
                    "[Update] {} 失败（第 {}/{} 次），{} 秒后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        }
    }
}

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端
/// 内置指数退避重试：检查更新最多重试 3 次，下载安装最多重试 2 次
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

        // 检查更新（带重试，最多 3 次，指数退避 1s/2s/4s）
        let check_result = match retry_with_backoff(3, "检查更新", || updater.check()).await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("检查更新失败（已重试 3 次）: {}", e)
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

        // 下载并安装（带重试，最多 2 次，指数退避 1s/2s）
        let app_progress = app.clone();
        let app_ready = app.clone();
        let result = retry_with_backoff(2, "下载安装", || {
            let u = update.clone();
            let ap = app_progress.clone();
            let ar = app_ready.clone();
            async move {
                u.download_and_install(
                    move |downloaded, total| {
                        let _ = ap.emit(
                            "update:progress",
                            serde_json::json!({
                                "downloaded": downloaded,
                                "total": total,
                            }),
                        );
                    },
                    move || {
                        let _ = ar.emit("update:ready", ());
                    },
                )
                .await
            }
        })
        .await;

        if let Err(e) = result {
            let _ = app.emit(
                "update:error",
                serde_json::json!({
                    "message": format!("下载安装失败（已重试 2 次）: {}", e)
                }),
            );
        }
    });
}

// ===== 分组命令 =====

#[tauri::command]
pub fn get_groups(store: State<DataStore>) -> Result<Vec<Group>, String> {
    store.get_groups()
}

#[tauri::command]
pub fn create_group(
    store: State<DataStore>,
    name: String,
    color: String,
    icon: String,
) -> Result<Group, String> {
    store.create_group(&name, &color, &icon)
}

#[tauri::command]
pub fn update_group(
    store: State<DataStore>,
    id: String,
    name: String,
    color: String,
    icon: String,
) -> Result<(), String> {
    store.update_group(&id, &name, &color, &icon)
}

#[tauri::command]
pub fn delete_group(store: State<DataStore>, id: String) -> Result<(), String> {
    store.delete_group(&id)
}

#[tauri::command]
pub fn reorder_groups(store: State<DataStore>, ids: Vec<String>) -> Result<(), String> {
    store.reorder_groups(&ids)
}

#[tauri::command]
pub fn move_to_group(
    store: State<DataStore>,
    history_ids: Vec<String>,
    group_id: Option<String>,
) -> Result<u32, String> {
    store.move_to_group(&history_ids, group_id.as_deref())
}

// ===== 标签命令 =====

#[tauri::command]
pub fn get_tags(store: State<DataStore>) -> Result<Vec<Tag>, String> {
    store.get_tags()
}

#[tauri::command]
pub fn create_tag(store: State<DataStore>, name: String, color: String) -> Result<Tag, String> {
    store.create_tag(&name, &color)
}

#[tauri::command]
pub fn update_tag(
    store: State<DataStore>,
    id: String,
    name: String,
    color: String,
) -> Result<(), String> {
    store.update_tag(&id, &name, &color)
}

#[tauri::command]
pub fn delete_tag(store: State<DataStore>, id: String) -> Result<(), String> {
    store.delete_tag(&id)
}

#[tauri::command]
pub fn set_item_tags(
    store: State<DataStore>,
    history_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    store.set_item_tags(&history_id, &tag_ids)
}

#[tauri::command]
pub fn add_item_tags(
    store: State<DataStore>,
    history_ids: Vec<String>,
    tag_ids: Vec<String>,
) -> Result<u32, String> {
    store.add_item_tags(&history_ids, &tag_ids)
}

#[tauri::command]
pub fn remove_item_tags(
    store: State<DataStore>,
    history_ids: Vec<String>,
    tag_ids: Vec<String>,
) -> Result<u32, String> {
    store.remove_item_tags(&history_ids, &tag_ids)
}

#[tauri::command]
pub fn get_items_with_tags(
    store: State<DataStore>,
    history_ids: Vec<String>,
) -> Result<Vec<(String, Vec<Tag>)>, String> {
    store.get_items_with_tags(&history_ids)
}

/// 将指定记录的所有自动标签转为手动标签（用户确认 AI 分类结果）
#[tauri::command]
pub fn confirm_auto_tags(
    store: State<DataStore>,
    history_id: String,
) -> Result<(), String> {
    store.confirm_auto_tags(&history_id)
}

// ===== 来源图标命令 =====

/// 获取来源应用的图标文件完整路径
/// 前端用 convertFileSrc 转 asset:// URL
/// 如果 item 中已有 source_icon 则直接返回完整路径，否则尝试从窗口标题查找缓存
#[tauri::command]
pub fn get_source_app_icon(
    icon_cache: State<crate::icon_extractor::IconCache>,
    source_icon: Option<String>,
    window_title: String,
) -> Result<Option<String>, String> {
    // 1. 优先使用已存储的 source_icon 文件名（含磁盘恢复缓存 + 文件有效性验证）
    if let Some(ref filename) = source_icon {
        if let Some(full_path) = icon_cache.get_icon_full_path(filename) {
            return Ok(Some(full_path.to_string_lossy().to_string()));
        }
    }

    // 2. 回退：source_icon 为空或文件不存在时，通过窗口标题查找前台窗口 → exe 路径 → hash → 图标
    //    需要当前窗口正是来源窗口才能命中（get_foreground_window 获取当前前台窗口）
    if !window_title.is_empty() {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
            use windows::Win32::System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
            };
            use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
            use windows::Win32::Foundation::CloseHandle;
            use windows::core::PWSTR;

            unsafe {
                let fg = GetForegroundWindow();
                if !fg.is_invalid() {
                    // 获取前台窗口标题
                    let mut title_buf = [0u16; 512];
                    let title_len = GetWindowTextW(fg, &mut title_buf);
                    if title_len > 0 {
                        let current_title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
                        // 仅当前台窗口标题与目标匹配时才查找（避免错配）
                        if current_title == window_title {
                            // 通过窗口句柄获取进程路径
                            let mut pid: u32 = 0;
                            GetWindowThreadProcessId(fg, Some(&mut pid));
                            if pid != 0 {
                                if let Ok(handle) = OpenProcess(
                                    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                                    false, pid,
                                ) {
                                    let mut exe_buf = [0u16; 260];
                                    let mut exe_len = exe_buf.len() as u32;
                                    let result = QueryFullProcessImageNameW(
                                        handle,
                                        PROCESS_NAME_WIN32,
                                        PWSTR(exe_buf.as_mut_ptr()),
                                        &mut exe_len,
                                    );
                                    let _ = CloseHandle(handle);

                                    if result.is_ok() && exe_len > 0 {
                                        let exe_path = std::path::PathBuf::from(
                                            String::from_utf16_lossy(&exe_buf[..exe_len as usize])
                                        );
                                        if let Some(full_path) = icon_cache.get_icon_by_exe_path(&exe_path) {
                                            log::debug!("[get_source_app_icon] 回退命中: title={}, exe={}, icon={}",
                                                window_title, exe_path.display(), full_path.display());
                                            return Ok(Some(full_path.to_string_lossy().to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        log::debug!("[get_source_app_icon] 未找到图标: source_icon={:?}, title={}", source_icon, window_title);
    }

    Ok(None)
}

/// 清理来源图标缓存目录
#[tauri::command]
pub fn clear_source_icon_cache(
    icon_cache: State<crate::icon_extractor::IconCache>,
) -> Result<u32, String> {
    let cache_dir = icon_cache.cache_dir.clone();
    let mut count = 0u32;
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if std::fs::remove_file(entry.path()).is_ok() {
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}
