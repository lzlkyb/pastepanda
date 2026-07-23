use crate::paste_engine::PasteEngine;
use tauri::{Manager, State};

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
