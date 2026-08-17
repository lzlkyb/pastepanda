use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 最近一次成功注册的热键配置（重注册失败时回滚用）
static LAST_GOOD: OnceLock<Mutex<Option<HotkeyConfig>>> = OnceLock::new();

fn last_good() -> &'static Mutex<Option<HotkeyConfig>> {
    LAST_GOOD.get_or_init(|| Mutex::new(None))
}

/// 全局热键配置
#[derive(Clone)]
pub struct HotkeyConfig {
    pub show_window: String,
    pub seq_paste: String,
    pub index_prefix: String,
    pub stack_toggle: String,
    pub stack_paste: String,
    pub quick_paste: String,
    pub screenshot: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        // U7：避开常用系统/应用快捷键 — 原默认 Ctrl+Shift+V（粘贴为纯文本）、
        // Ctrl+Q（退出/关标签）、Ctrl+Shift+P（命令面板）会被全局注册静默劫持。
        // Ctrl+Alt 系列极少被占用；仅影响新安装用户，已保存的配置不受影响。
        Self {
            show_window: "Ctrl+Alt+V".to_string(),
            seq_paste: "Ctrl+Alt+Q".to_string(),
            index_prefix: "Ctrl+Alt".to_string(),
            stack_toggle: "Ctrl+Alt+K".to_string(),
            stack_paste: "Ctrl+Alt+P".to_string(),
            // Win+V 被系统保留，Alt+V 为最接近的替代；仅影响新安装用户
            quick_paste: "Alt+V".to_string(),
            // 截图标注（区域截图直觉；Snipaste 为 F1，QQ 为 Ctrl+Alt+A）
            screenshot: "Ctrl+Alt+A".to_string(),
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
/// 失败时回滚到上一次成功的配置，避免"新热键被占用 → 全部热键失效"（M27）
pub fn reregister_global_hotkeys(app: &AppHandle, config: &HotkeyConfig) -> Result<(), String> {
    unregister_all_hotkeys(app);
    match register_global_hotkeys(app, config) {
        Ok(()) => Ok(()),
        Err(e) => {
            let prev = last_good()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Some(prev_cfg) = prev {
                unregister_all_hotkeys(app);
                match register_global_hotkeys(app, &prev_cfg) {
                    Ok(()) => log::warn!("[HotkeyManager] 新热键注册失败，已回滚到上次成功的配置"),
                    Err(re) => log::error!("[HotkeyManager] 新热键注册失败且回滚也失败: {}", re),
                }
            } else {
                log::warn!("[HotkeyManager] 新热键注册失败，且无可回滚的历史配置");
            }
            Err(e)
        }
    }
}

/// 注册全局热键
pub fn register_global_hotkeys(app: &AppHandle, config: &HotkeyConfig) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut errors: Vec<String> = Vec::new();

    // 主唤出热键（留空 = 禁用）
    if config.show_window.trim().is_empty() {
        log::info!("[HotkeyManager] 唤出热键已禁用（留空），跳过注册");
    } else if let Ok(shortcut) = parse_shortcut(&config.show_window) {
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

    // 依次粘贴热键（留空 = 禁用）
    if config.seq_paste.trim().is_empty() {
        log::info!("[HotkeyManager] 依次粘贴热键已禁用（留空），跳过注册");
    } else if let Ok(shortcut) = parse_shortcut(&config.seq_paste) {
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                log::info!("[HotkeyManager] 依次粘贴热键触发!");
                // 第一时间保存前台窗口句柄，确保粘贴目标正确
                if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                    engine.save_foreground_hwnd();
                }
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
                    // 第一时间保存前台窗口句柄
                    if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                        engine.save_foreground_hwnd();
                    }
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

    // 剪贴板栈：切换栈模式（留空 = 禁用）
    if config.stack_toggle.trim().is_empty() {
        log::info!("[HotkeyManager] 栈模式切换热键已禁用（留空），跳过注册");
    } else if let Ok(shortcut) = parse_shortcut(&config.stack_toggle) {
        let stack_toggle_str = config.stack_toggle.clone();
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                log::info!("[HotkeyManager] 栈模式切换热键触发!");
                let _ = app.emit("hotkey-stack-toggle", ());
            }
        }) {
            Ok(_) => log::info!("[HotkeyManager] 注册栈模式切换热键: {}", stack_toggle_str),
            Err(e) => {
                let msg = format!("栈模式热键注册失败: {}", e);
                log::warn!("[HotkeyManager] {}", msg);
                errors.push(msg);
            }
        }
    } else {
        errors.push(format!("无效的栈模式热键: {}", config.stack_toggle));
    }

    // 剪贴板栈：粘贴栈顶（留空 = 禁用）
    if config.stack_paste.trim().is_empty() {
        log::info!("[HotkeyManager] 栈粘贴热键已禁用（留空），跳过注册");
    } else if let Ok(shortcut) = parse_shortcut(&config.stack_paste) {
        let stack_paste_str = config.stack_paste.clone();
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                log::info!("[HotkeyManager] 栈粘贴热键触发!");
                // 第一时间保存前台窗口句柄，确保粘贴目标正确
                if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                    engine.save_foreground_hwnd();
                }
                let _ = app.emit("hotkey-stack-paste", ());
            }
        }) {
            Ok(_) => log::info!("[HotkeyManager] 注册栈粘贴热键: {}", stack_paste_str),
            Err(e) => {
                let msg = format!("栈粘贴热键注册失败: {}", e);
                log::warn!("[HotkeyManager] {}", msg);
                errors.push(msg);
            }
        }
    } else {
        errors.push(format!("无效的栈粘贴热键: {}", config.stack_paste));
    }

    // 快捷粘贴面板（类 Win+V，留空 = 禁用）
    if config.quick_paste.trim().is_empty() {
        log::info!("[HotkeyManager] 快捷粘贴热键已禁用（留空），跳过注册");
    } else if let Ok(shortcut) = parse_shortcut(&config.quick_paste) {
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                log::info!("[HotkeyManager] 快捷粘贴热键触发!");
                // 第一时间保存前台窗口句柄，确保粘贴目标正确
                if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                    engine.save_foreground_hwnd();
                }
                crate::quick_paste::toggle_quick_paste(app);
            }
        }) {
            Ok(_) => log::info!("[HotkeyManager] 注册快捷粘贴热键: {}", config.quick_paste),
            Err(e) => {
                let msg = format!("快捷粘贴热键注册失败: {}", e);
                log::warn!("[HotkeyManager] {}", msg);
                errors.push(msg);
            }
        }
    } else {
        errors.push(format!("无效的快捷粘贴热键: {}", config.quick_paste));
    }

    // 截图标注（留空 = 禁用）
    if config.screenshot.trim().is_empty() {
        log::info!("[HotkeyManager] 截图热键已禁用（留空），跳过注册");
    } else if let Ok(shortcut) = parse_shortcut(&config.screenshot) {
        match gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                log::info!("[HotkeyManager] 截图热键触发!");
                crate::screenshot::open_screenshot_window(app);
            }
        }) {
            Ok(_) => log::info!("[HotkeyManager] 注册截图热键: {}", config.screenshot),
            Err(e) => {
                let msg = format!("截图热键注册失败: {}", e);
                log::warn!("[HotkeyManager] {}", msg);
                errors.push(msg);
            }
        }
    } else {
        errors.push(format!("无效的截图热键: {}", config.screenshot));
    }

    if errors.is_empty() {
        // 记录最近一次成功配置，供 reregister 失败时回滚（M27）
        *last_good().lock().unwrap_or_else(|p| p.into_inner()) = Some(config.clone());
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
