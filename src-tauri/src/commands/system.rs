use super::is_unsafe_network_path;
use crate::data_store::DataStore;
use tauri::{Emitter, Manager, State};

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
