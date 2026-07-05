use std::str::FromStr;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 全局热键配置
pub struct HotkeyConfig {
    pub show_window: String,
    pub seq_paste: String,
    pub index_prefix: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            show_window: "Ctrl+Shift+V".to_string(),
            seq_paste: "Ctrl+Q".to_string(),
            index_prefix: "Ctrl+Alt".to_string(),
        }
    }
}

/// 将前端格式（ctrl+shift+v）转为 Tauri Shortcut 格式（Ctrl+Shift+V）
fn normalize_hotkey(s: &str) -> String {
    s.split('+')
        .map(|part| {
            let p = part.trim().to_lowercase();
            match p.as_str() {
                "ctrl" | "control" => "Ctrl".to_string(),
                "shift" => "Shift".to_string(),
                "alt" => "Alt".to_string(),
                "meta" | "super" | "cmd" => "Meta".to_string(),
                // 功能键
                ref k if k.starts_with("f") && k.len() >= 2 => {
                    let mut c = p.chars();
                    c.next(); // skip 'f'
                    let num: String = c.collect();
                    format!("F{}", num)
                }
                // 特殊键映射
                "space" => "Space".to_string(),
                "tab" => "Tab".to_string(),
                "esc" | "escape" => "Escape".to_string(),
                "return" | "enter" => "Return".to_string(),
                "backspace" => "Backspace".to_string(),
                "delete" => "Delete".to_string(),
                "home" => "Home".to_string(),
                "end" => "End".to_string(),
                "pageup" => "PageUp".to_string(),
                "pagedown" => "PageDown".to_string(),
                "up" => "ArrowUp".to_string(),
                "down" => "ArrowDown".to_string(),
                "left" => "ArrowLeft".to_string(),
                "right" => "ArrowRight".to_string(),
                "insert" => "Insert".to_string(),
                "capslock" => "CapsLock".to_string(),
                other => {
                    // 单字符转大写（如 v → V, b → B）
                    if other.len() == 1 {
                        other.to_uppercase()
                    } else {
                        let mut c = other.chars();
                        match c.next() {
                            None => String::new(),
                            Some(f) => f.to_uppercase().to_string() + c.as_str(),
                        }
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    let normalized = normalize_hotkey(s);
    Shortcut::from_str(&normalized).map_err(|e| format!("无效热键 '{}': {}", normalized, e))
}

/// 注销所有已注册的全局热键
pub fn unregister_all_hotkeys(app: &AppHandle) {
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        log::warn!("[HotkeyManager] 注销所有热键失败: {}", e);
    } else {
        log::info!("[HotkeyManager] 已注销所有热键");
    }
}

/// 注销并重新注册全局热键（供前端设置保存后调用）
pub fn reregister_global_hotkeys(app: &AppHandle, config: &HotkeyConfig) -> Result<(), String> {
    unregister_all_hotkeys(app);
    register_global_hotkeys(app, config)
}

/// 注册全局热键
pub fn register_global_hotkeys(app: &AppHandle, config: &HotkeyConfig) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut errors: Vec<String> = Vec::new();

    // 主唤出热键
    if let Ok(shortcut) = parse_shortcut(&config.show_window) {
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        // 在显示窗口之前，保存当前前台窗口（备用）
                        if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                            engine.save_foreground_hwnd();
                        }
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        }) {
            Ok(_) => log::info!("[HotkeyManager] 注册唤出热键: {}", config.show_window),
            Err(e) => {
                let msg = format!("唤出热键注册失败 (可能被其他程序占用): {}", e);
                log::warn!("[HotkeyManager] {}", msg);
                errors.push(msg);
            }
        }
    } else {
        errors.push(format!("无效的唤出热键: {}", config.show_window));
    }

    // 依次粘贴热键
    if let Ok(shortcut) = parse_shortcut(&config.seq_paste) {
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                log::info!("[HotkeyManager] 依次粘贴热键触发!");
                let _ = app.emit("hotkey-sequential-paste", ());
            }
        }) {
            Ok(_) => log::info!("[HotkeyManager] 注册依次粘贴热键: {}", config.seq_paste),
            Err(e) => {
                let msg = format!("依次粘贴热键注册失败: {}", e);
                log::warn!("[HotkeyManager] {}", msg);
                errors.push(msg);
            }
        }
    } else {
        errors.push(format!("无效的依次粘贴热键: {}", config.seq_paste));
    }

    // 索引粘贴 Ctrl+Alt+1..9
    for i in 1..=9 {
        let hotkey_str = format!("{}+{}", config.index_prefix, i);
        if let Ok(shortcut) = parse_shortcut(&hotkey_str) {
            let idx = i;
            match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit("hotkey-index-paste", idx);
                }
            }) {
                Ok(_) => log::info!("[HotkeyManager] 注册索引粘贴: {}", hotkey_str),
                Err(e) => {
                    let msg = format!("索引热键注册失败 {}: {}", hotkey_str, e);
                    log::warn!("[HotkeyManager] {}", msg);
                    errors.push(msg);
                }
            }
        }
    }

    // 全选(Ctrl+A)：使用应用内键盘事件处理，不注册全局热键（避免劫持其他应用）

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
