//! 屏幕录制（本地写 MP4，与 rc/ 的网络推流管线平行）。
//!
//! - `quality` 档位表（纯函数）；`sink` MF SinkWriter mux；`session` 采集会话；
//!   `commands` Tauri 命令。本模块 **Windows 桌面专属**（依赖 DXGI/MF）。
//! - 窗口两个：`rec-select`（全屏透明覆盖层：预览 → 确认条 → 倒计时 → 录制中红框，
//!   录制中整窗鼠标穿透）＋ `rec-control`（置顶小条：REC / 计时 / 停止，可拖动）。
//! - 窗口机制照抄截图窗（screenshot.rs）：运行时创建、物理像素定位、前端 ready
//!   存活探针（React 树崩了 / webview 白屏时自动关窗，不让用户被困在遮罩后面）。

#![cfg(target_os = "windows")]

pub mod commands;
pub mod quality;
pub mod session;
pub mod sink;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SELECT_LABEL: &str = "rec-select";
pub const CONTROL_LABEL: &str = "rec-control";

/// 防止快速连按热键并发创建同名窗口（同 screenshot::CREATING）。
static CREATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 窗口世代号：每次新建 +1，探针据此不误杀新一轮窗口。
static GEN: AtomicU64 = AtomicU64::new(0);
static READY_GEN: AtomicU64 = AtomicU64::new(0);
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// 前端覆盖层挂载后调：撤销存活探针（commands.rs 的 `rec_ready` 写这里）。
pub(crate) fn mark_ready() {
    READY_GEN.store(GEN.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// 虚拟屏几何（物理像素）——与 rc/dxgi.rs、screenshot.rs 同源口径。
pub(crate) fn virtual_screen_metrics() -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// 打开（或聚焦）录屏选区窗。热键 / 工具箱 / 托盘共用入口。
pub fn open_selector_window(app: &AppHandle) {
    // 已有会话在录：热键语义 = 停止（见 commands::rec_toggle）
    if session::status().recording {
        let _ = session::stop(false);
        return;
    }
    if let Some(w) = app.get_webview_window(SELECT_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("rec-refresh", ());
        return;
    }
    create_selector(app);
}

fn create_selector(app: &AppHandle) {
    if CREATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                CREATING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = Reset;
        let (x, y, w, h) = virtual_screen_metrics();
        // 世代号在 build() 之前递增（同截图窗：build 一返回前端就可能 ready）
        let generation = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let builder = WebviewWindowBuilder::new(&app, SELECT_LABEL, WebviewUrl::App("rec.html".into()))
            .title("")
            .inner_size(w.max(1) as f64, h.max(1) as f64)
            .position(x as f64, y as f64)
            .resizable(false)
            .visible(false);
        let built = builder
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .transparent(true)
            .build();
        match built {
            Ok(window) => {
                // builder 的 inner_size/position 收逻辑像素（同截图窗的坑），
                // 用物理量覆盖一次；此时窗还 invisible，用户看不到中间帧。
                let _ = window.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                let _ = window.show();
                let _ = window.set_focus();
                let probe = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(READY_TIMEOUT).await;
                    if GEN.load(Ordering::SeqCst) != generation
                        || READY_GEN.load(Ordering::SeqCst) == generation
                        || probe.get_webview_window(SELECT_LABEL).is_none()
                    {
                        return;
                    }
                    log::warn!("[Rec] 选区窗前端 {}s 内未就绪，自动关窗", READY_TIMEOUT.as_secs());
                    let _ = probe.emit("rec-startup-failed", ());
                    close_windows(&probe);
                });
            }
            Err(e) => log::warn!("[Rec] 创建选区窗失败: {e}"),
        }
    });
}

/// 打开录制控制条窗（rec_start 成功后调用）。位置：选区上缘外 12px，越界回弹到屏内。
pub fn open_control_window(app: &AppHandle, region: (i32, i32, u32, u32)) {
    let (sx, sy, sw, sh) = virtual_screen_metrics();
    let (rx, ry, rw, _) = region;
    // 物理坐标先定，build 后按物理覆盖（同选区窗）
    let bar_w = 340i32;
    let bar_h = 48i32;
    let mut bx = rx + (rw as i32 - bar_w) / 2;
    let mut by = ry - bar_h - 12;
    if by < sy {
        by = (ry + region.3 as i32) + 12; // 上方放不下翻到选区下方
    }
    bx = bx.clamp(sx, sx + sw - bar_w);
    by = by.clamp(sy, sy + sh - bar_h);
    if let Some(old) = app.get_webview_window(CONTROL_LABEL) {
        let _ = old.close();
    }
    let builder = WebviewWindowBuilder::new(app, CONTROL_LABEL, WebviewUrl::App("rec-control.html".into()))
        .title("")
        .inner_size(bar_w as f64, bar_h as f64)
        .position(bx as f64, by as f64)
        .resizable(false);
    let built = builder
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .build();
    match built {
        Ok(window) => {
            let _ = window.set_size(tauri::PhysicalSize::new(bar_w as u32, bar_h as u32));
            let _ = window.set_position(tauri::PhysicalPosition::new(bx, by));
            let _ = window.show();
        }
        Err(e) => log::warn!("[Rec] 创建控制条窗失败: {e}"),
    }
}

/// 关闭录屏相关窗口（选区 + 控制条）。会话收尾事件到达后由前端触发，
/// 也可在后端启动失败路径直接调用。
pub fn close_windows(app: &AppHandle) {
    for label in [SELECT_LABEL, CONTROL_LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
}
