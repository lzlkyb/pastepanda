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

// ===== .md 文件关联（HKCU 注册表，无需管理员权限） =====

/// 关联用的 ProgId（与写入注册表的一致）
const MD_PROG_ID: &str = "PastePanda.md";
/// RegisteredApplications 中的应用名
const MD_APP_REG_NAME: &str = "PastePanda";

/// 打开系统"默认应用"设置页并定位到 PastePanda，引导用户将 .md 设为默认。
/// 四种已验证的坑（记录在案，避免重蹈覆辙）：
/// - COM LaunchAdvancedAssociationUI：Win11 上只弹"请转到设置>应用>默认应用"
///   提示框（且返回成功，无法靠返回值回退）；
/// - ms-settings:defaultappsbytype：Win11 已移除该页，URI 失效跳设置首页；
/// - rundll32 shell32.dll,OpenAs_RunDLL：弹出的是遗留版"打开方式"对话框，
///   Win11 上没有"始终"按钮，只能打开一次文件，无法真正设置默认关联；
/// - explorer.exe 启动带查询参数的 URI（?registeredAppUser=...）：explorer
///   解析失败会回退打开"文档"文件夹。必须走 ShellExecuteW 协议激活
///   （即官方文档 LaunchUriAsync 的 Win32 等价方式）。
/// 正解：ShellExecuteW 打开 ms-settings:defaultapps?registeredAppUser=PastePanda
/// —— 依赖 RegisteredApplications + Capabilities 注册（set_md_association 已写入），
/// 设置页自动定位到 PastePanda，用户点击 .md 一行即可在带"始终"按钮的
/// 现代对话框中选择 PastePanda。（该查询参数需 Win11 21H2 2023-04 累积更新
/// 及以上，缺失时会降级为普通默认应用页，仍优于打开文档文件夹。）
#[cfg(target_os = "windows")]
fn open_default_apps_ui() {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // 应用名纯 ASCII 无需 URI 转义；若未来改名含特殊字符需先转义
    let uri: Vec<u16> = format!(
        "ms-settings:defaultapps?registeredAppUser={}",
        MD_APP_REG_NAME
    )
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let ret = unsafe {
        ShellExecuteW(
            HWND(std::ptr::null_mut()),
            PCWSTR(verb.as_ptr()),
            PCWSTR(uri.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW 返回值 > 32 表示成功
    if ret.0 as usize > 32 {
        return;
    }
    // 回退：打开系统默认应用设置页（无查询参数的 URI explorer 可正常处理）
    if let Err(e) = std::process::Command::new("explorer")
        .arg("ms-settings:defaultapps")
        .spawn()
    {
        log::warn!("[Commands] 打开默认应用设置页失败: {}", e);
    }
}

/// 查询 .md 文件关联状态。
/// 返回："default"（已是默认打开方式）| "registered"（已注册但未设为默认）| "unregistered"（未注册）。
/// 若注册表中的 exe 路径与当前进程不一致（如应用被移动），视为未注册，重新开启开关即可自愈。
#[tauri::command]
pub fn get_md_association_status() -> String {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // 1) ProgId 是否已注册且指向当前 exe
        let registered = hkcu
            .open_subkey(r"Software\Classes\PastePanda.md\shell\open\command")
            .and_then(|k| k.get_value::<String, _>(""))
            .map(|cmd| {
                std::env::current_exe()
                    .map(|exe| cmd.contains(&exe.to_string_lossy().to_string()))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !registered {
            return "unregistered".to_string();
        }
        // 2) 解析 UserChoice ProgId 指向的实际打开命令。
        //    Windows 可能写入我们注册的 PastePanda.md，也可能写入自动生成的
        //    ProgId（如 md_auto_file），后者同样指向 PastePanda.exe。
        //    因此不能只比较 ProgId 字符串，需要解析其 shell\open\command。
        let is_default = hkcu
            .open_subkey(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
            )
            .and_then(|k| k.get_value::<String, _>("ProgId"))
            .map(|prog_id| {
                if prog_id == MD_PROG_ID {
                    return true;
                }
                // 解析该 ProgId 的打开命令：先查 HKCU\Software\Classes，再查 HKCR
                let exe_str = match std::env::current_exe() {
                    Ok(e) => e.to_string_lossy().to_string(),
                    Err(_) => return false,
                };
                let cmd = hkcu
                    .open_subkey(format!(
                        r"Software\Classes\{}\shell\open\command",
                        prog_id
                    ))
                    .or_else(|_| {
                        RegKey::predef(HKEY_CLASSES_ROOT)
                            .open_subkey(format!(r"{}\shell\open\command", prog_id))
                    })
                    .and_then(|k| k.get_value::<String, _>(""));
                match cmd {
                    Ok(c) => c.contains(&exe_str),
                    Err(_) => false,
                }
            })
            .unwrap_or(false);
        if is_default {
            "default".to_string()
        } else {
            "registered".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        "unregistered".to_string()
    }
}

/// 开启/关闭 .md 文件关联。
/// 开启：写入 ProgId（shell/open/command + DefaultIcon）、.md OpenWithProgids、
/// Capabilities 与 RegisteredApplications，然后弹出系统确认界面引导设为默认
/// （Windows 10+ 不允许应用静默设为默认，必须由用户确认一次）。
/// 关闭：清除上述注册表项（UserChoice 由系统管理，不直接写）。
#[tauri::command]
pub fn set_md_association(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::{RegKey, RegValue};
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let exe_str = exe.to_string_lossy().to_string();

            // ProgId：HKCU\Software\Classes\PastePanda.md
            let (prog_key, _) = hkcu
                .create_subkey(r"Software\Classes\PastePanda.md")
                .map_err(|e| e.to_string())?;
            let type_name = "Markdown 文档".to_string();
            prog_key.set_value("", &type_name).map_err(|e| e.to_string())?;
            let (icon_key, _) = prog_key
                .create_subkey("DefaultIcon")
                .map_err(|e| e.to_string())?;
            let icon_val = format!("\"{}\",0", exe_str);
            icon_key.set_value("", &icon_val).map_err(|e| e.to_string())?;
            let (cmd_key, _) = prog_key
                .create_subkey(r"shell\open\command")
                .map_err(|e| e.to_string())?;
            let open_cmd = format!("\"{}\" \"%1\"", exe_str);
            cmd_key.set_value("", &open_cmd).map_err(|e| e.to_string())?;

            // 出现在右键"打开方式"列表：HKCU\Software\Classes\.md\OpenWithProgids
            let (owp, _) = hkcu
                .create_subkey(r"Software\Classes\.md\OpenWithProgids")
                .map_err(|e| e.to_string())?;
            owp.set_raw_value(
                MD_PROG_ID,
                &RegValue {
                    bytes: vec![],
                    vtype: REG_NONE,
                },
            )
            .map_err(|e| e.to_string())?;

            // Capabilities：让应用出现在"设置 → 默认应用"中
            let (cap, _) = hkcu
                .create_subkey(r"Software\PastePanda\Capabilities")
                .map_err(|e| e.to_string())?;
            let app_name = "PastePanda".to_string();
            let app_desc = "PastePanda - 智能剪贴板管理器".to_string();
            cap.set_value("ApplicationName", &app_name)
                .map_err(|e| e.to_string())?;
            cap.set_value("ApplicationDescription", &app_desc)
                .map_err(|e| e.to_string())?;
            let (fa, _) = cap
                .create_subkey("FileAssociations")
                .map_err(|e| e.to_string())?;
            let prog_id = MD_PROG_ID.to_string();
            fa.set_value(".md", &prog_id).map_err(|e| e.to_string())?;
            let (ra, _) = hkcu
                .create_subkey(r"Software\RegisteredApplications")
                .map_err(|e| e.to_string())?;
            let cap_path = r"Software\PastePanda\Capabilities".to_string();
            ra.set_value(MD_APP_REG_NAME, &cap_path)
                .map_err(|e| e.to_string())?;

            // 注册完成后引导用户在系统设置中确认默认
            open_default_apps_ui();
            Ok(())
        } else {
            let _ = hkcu.delete_subkey_all(r"Software\Classes\PastePanda.md");
            if let Ok(owp) =
                hkcu.open_subkey_with_flags(r"Software\Classes\.md\OpenWithProgids", KEY_WRITE)
            {
                let _ = owp.delete_value(MD_PROG_ID);
            }
            let _ = hkcu.delete_subkey_all(r"Software\PastePanda\Capabilities");
            if let Ok(ra) = hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", KEY_WRITE)
            {
                let _ = ra.delete_value(MD_APP_REG_NAME);
            }
            Ok(())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enable;
        Ok(())
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

/// 读取文本文件快速预览：最多 128KB，最多 20 行。
/// 返回：{ kind: "text"|"binary"|"missing", file_size, total_lines, lines: String[], truncated, extension }
/// 二进制文件返回 lines=[] 与 kind="binary"，前端据此显示"二进制文件"占位。
#[tauri::command]
pub fn read_text_file_preview(path: String) -> Result<serde_json::Value, String> {
    use std::io::Read;

    if is_unsafe_network_path(&path) {
        return Err("不支持的网络共享路径".to_string());
    }

    let meta = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m,
        _ => return Ok(serde_json::json!({
            "kind": "missing",
            "file_size": 0,
            "total_lines": 0,
            "lines": [],
            "truncated": false,
            "extension": "",
        })),
    };

    let file_size = meta.len();
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    const MAX_BYTES: u64 = 128 * 1024;
    const MAX_LINES: usize = 20;

    // 上限：防止大文件读取卡 UI；超过上限仍允许读取前 128KB。
    let read_limit = file_size.min(MAX_BYTES);

    let mut file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut preview_bytes: Vec<u8> = Vec::with_capacity(read_limit as usize);
    let taken = (&mut file).take(read_limit);
    std::io::BufReader::new(taken)
        .read_to_end(&mut preview_bytes)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    // 二进制检测：前 8KB 内是否出现 NUL 字节
    let is_binary = preview_bytes
        .iter()
        .take(8192)
        .any(|&b| b == 0);

    if is_binary {
        return Ok(serde_json::json!({
            "kind": "binary",
            "file_size": file_size,
            "total_lines": 0,
            "lines": [],
            "truncated": false,
            "extension": ext,
        }));
    }

    // 文本解码（lossy UTF-8，容错非 UTF-8 编码）
    let preview_str = String::from_utf8_lossy(&preview_bytes).into_owned();

    let mut lines: Vec<String> = Vec::new();
    let mut total_lines = 0usize;
    let mut truncated = false;
    for line in preview_str.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if lines.len() < MAX_LINES {
            lines.push(line.to_string());
        } else {
            truncated = true;
        }
        total_lines += 1;
    }
    // 文件以 \n 结尾时，split 多一个空串；保持与 wc -l 一致
    if total_lines > 0 && preview_str.ends_with('\n') {
        total_lines = total_lines.saturating_sub(1);
        if lines.len() > total_lines {
            lines.truncate(total_lines);
        }
    }
    if file_size > MAX_BYTES {
        truncated = true;
    }

    Ok(serde_json::json!({
        "kind": "text",
        "file_size": file_size,
        "total_lines": total_lines,
        "lines": lines,
        "truncated": truncated,
        "extension": ext,
    }))
}

/// 读取文本文件完整内容（编辑器用）：上限 10MB，返回 UTF-8 字符串。
/// 二进制文件返回错误提示，前端据此处理。
#[tauri::command]
pub fn read_text_file_full(path: String) -> Result<String, String> {
    use std::io::Read;

    if is_unsafe_network_path(&path) {
        return Err("不支持的网络共享路径".to_string());
    }

    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("无法读取文件: {}", e))?;

    if !meta.is_file() {
        return Err("路径不是文件".to_string());
    }

    const MAX_BYTES: u64 = 10 * 1024 * 1024; // 10MB
    if meta.len() > MAX_BYTES {
        return Err("文件过大（超过 10MB 限制）".to_string());
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut bytes: Vec<u8> = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes).map_err(|e| format!("读取文件失败: {}", e))?;

    // 二进制检测：前 8KB 内是否出现 NUL 字节
    let is_binary = bytes.iter().take(8192).any(|&b| b == 0);
    if is_binary {
        return Err("不支持打开二进制文件".to_string());
    }

    // BOM 处理：跳过 UTF-8 BOM（EF BB BF）
    let content = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(content)
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

/// 取走首次启动时通过文件关联传入的待打开文件路径（取走后清空）。
/// 前端挂载后调用，用于处理"应用未运行时双击 .md 文件"的场景。
#[tauri::command]
pub fn take_pending_file_open(
    pending: State<crate::PendingFileOpen>,
) -> Result<Vec<String>, String> {
    let mut guard = pending
        .0
        .lock()
        .map_err(|e| format!("锁获取失败: {}", e))?;
    Ok(guard.take().unwrap_or_default())
}

/// 打开全屏编辑器（独立 OS 全屏窗口，通用外壳：markdown/json/html/text/csv）。
/// - 编辑器窗口已存在：emit `md-editor-load` 事件推送新数据并聚焦（支持连续打开不同内容）。
/// - 不存在：把初始数据存入 PendingEditor，再创建 decorations(false) 的 editor.html 窗口，
///   窗口内前端挂载后调用 take_editor_init 取走数据。
/// content_type 决定前端查表选择的语言模式/视图形态；缺省回退 markdown。
#[tauri::command]
pub async fn open_fullscreen_editor(
    app: tauri::AppHandle,
    source_id: Option<String>,
    content: Option<String>,
    file_path: Option<String>,
    content_type: Option<String>,
    language: Option<String>,
) -> Result<(), String> {
    // 修复白屏（about:blank）：同步 command 里建 WebviewWindow 会死锁（tauri#13963），
    // 改为 async command 使其运行在主线程事件循环上。State 经 app.state() 获取。
    let pending = app.state::<crate::PendingEditor>();
    let payload = serde_json::json!({
        "sourceId": source_id,
        "content": content,
        "filePath": file_path,
        "contentType": content_type,
        "language": language,
    });

    // 窗口已存在 → 定向推送 + 聚焦
    if let Some(window) = app.get_webview_window("md-editor") {
        window
            .emit("md-editor-load", payload)
            .map_err(|e| format!("推送编辑器数据失败: {}", e))?;
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // 窗口不存在 → 存初始数据 + 建窗
    {
        let mut guard = pending
            .0
            .lock()
            .map_err(|e| format!("锁获取失败: {}", e))?;
        *guard = Some(crate::EditorInitData {
            source_id,
            content,
            file_path,
            content_type: content_type.clone(),
            language,
        });
    }

    use tauri::webview::WebviewWindowBuilder;

    // 窗口标题随内容类型变化（窗口 label 保持 md-editor，避免改动 capabilities）
    let title = match content_type.as_deref() {
        Some("json") => "PastePanda JSON 编辑器",
        Some("html") => "PastePanda HTML 编辑器",
        Some("text") => "PastePanda 文本编辑器",
        Some("csv") => "PastePanda 表格编辑器",
        Some("code") | Some("config") | Some("shell") => "PastePanda 代码编辑器",
        _ => "PastePanda Markdown 编辑器",
    };

    let mut builder =
        WebviewWindowBuilder::new(&app, "md-editor", tauri::WebviewUrl::App("editor.html".into()))
            .title(title)
            .decorations(false)
            .visible(false);

    // 方案 A（近全屏留边）：按主窗口所在显示器（回退主显示器）计算 94%×90% 的居中尺寸，
    // 四周保留呼吸边，不再 100% 霸屏。
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let mon_w = size.width as f64 / scale;
        let mon_h = size.height as f64 / scale;
        let win_w = (mon_w * 0.94).round();
        let win_h = (mon_h * 0.90).round();
        let pos = monitor.position();
        let x = pos.x as f64 / scale + (mon_w - win_w) / 2.0;
        let y = pos.y as f64 / scale + (mon_h - win_h) / 2.0;
        builder = builder.inner_size(win_w, win_h).position(x, y);
    } else {
        builder = builder.inner_size(1280.0, 800.0).center();
    }

    let window = builder
        .build()
        .map_err(|e| format!("创建编辑器窗口失败: {}", e))?;

    // 无边框窗口圆角：Windows 11 DWM 原生属性（比「透明 webview + CSS」方案稳定，后者有已知 bug）
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        };
        // tauri 的 hwnd() 返回 windows 0.61 的 HWND；本项目依赖 windows 0.58，
        // 两者内部同为 *mut c_void，直接透传原始指针。
        if let Ok(thwnd) = window.hwnd() {
            let hwnd = windows::Win32::Foundation::HWND(thwnd.0);
            let pref = DWMWCP_ROUND;
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &pref as *const _ as *const std::ffi::c_void,
                    std::mem::size_of_val(&pref) as u32,
                );
            }
        }
    }

    // 先隐藏建窗再显示，避免创建瞬间的闪烁。async command 已规避 tauri#13963 死锁。
    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

/// 读取全屏编辑器的初始数据（幂等，不清空）。编辑器窗口挂载后调用。
///
/// 用 clone 而非 take：dev 模式下 React StrictMode 会双重挂载，挂载 effect 执行两次。
/// 若用 take，第一次（被丢弃的）调用会消费掉数据，第二次（保留的）调用拿到 null，
/// 编辑器内容为空。clone 保证两次调用拿到相同数据。PendingEditor 总是在
/// open_fullscreen_editor 建窗前被覆盖，不会误用过期数据。
#[tauri::command]
pub fn take_editor_init(
    pending: State<crate::PendingEditor>,
) -> Result<Option<crate::EditorInitData>, String> {
    let guard = pending
        .0
        .lock()
        .map_err(|e| format!("锁获取失败: {}", e))?;
    Ok(guard.clone())
}

/// 关闭全屏编辑器窗口。
///
/// 前端 ✕/Esc 触发关闭时先播放退场动画（约 190ms），动画结束后调用本命令真正关窗，
/// 避免直接 window.close() 导致窗口瞬间消失。window 参数由 Tauri 注入为调用方窗口。
#[tauri::command]
pub fn close_editor_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .close()
        .map_err(|e| format!("关闭编辑器窗口失败: {}", e))
}
