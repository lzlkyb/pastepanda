//! 屏幕录制（本地写 MP4，与 rc/ 的网络推流管线平行）。
//!
//! - `quality` 档位表（纯函数）；`sink` MF SinkWriter mux；`session` 采集会话；
//!   `commands` Tauri 命令。Windows 使用 DXGI/MF，Mac 使用 ScreenCaptureKit/AVAssetWriter。
//! - 窗口两个：`rec-select`（全屏透明覆盖层：预览 → 确认条 → 倒计时 → 录制中红框，
//!   录制中整窗鼠标穿透）＋ `rec-control`（置顶小条：REC / 计时 / 停止，可拖动）。
//! - 窗口机制照抄截图窗（screenshot.rs）：运行时创建、物理像素定位、前端 ready
//!   存活探针（React 树崩了 / webview 白屏时自动关窗，不让用户被困在遮罩后面）。

#![cfg(any(target_os = "windows", target_os = "macos"))]

pub mod commands;
pub mod event_types;
pub mod events;
mod gif_job;
#[cfg(target_os = "macos")]
#[path = "../macos/h264_frames.rs"]
mod h264_frames;
#[cfg(windows)]
pub mod gif;
#[cfg(target_os = "macos")]
#[path = "../macos/rec_gif.rs"]
pub mod gif;
#[cfg(windows)]
pub mod hooks;
#[cfg(target_os = "macos")]
mod mac_validation;
#[cfg(target_os = "macos")]
mod mac_keys;
#[cfg(windows)]
pub mod pointer;
pub mod quality;
mod control_layout;
pub mod scan;
#[cfg(windows)]
pub mod session;
#[cfg(target_os = "macos")]
#[path = "../macos/rec_session.rs"]
pub mod session;
pub mod session_types;
#[cfg(windows)]
pub mod sink;
pub mod trim_types;
#[cfg(not(target_os = "macos"))]
pub mod trim;
#[cfg(target_os = "macos")]
#[path = "../macos/rec_trim.rs"]
pub mod trim;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SELECT_LABEL: &str = "rec-select";
pub const CONTROL_LABEL: &str = "rec-control";
pub const HUD_LABEL: &str = "rec-hud";
pub const PREVIEW_LABEL: &str = "rec-preview";

/// 防止快速连按热键并发创建同名窗口（同 screenshot::CREATING）。
static CREATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 窗口世代号：每次新建 +1，探针据此不误杀新一轮窗口。
static GEN: AtomicU64 = AtomicU64::new(0);
static READY_GEN: AtomicU64 = AtomicU64::new(0);
/// 10s（原 5s）：dev 下页面加载慢/被外部触发的整页 reload 打断时，5s 会把
/// 好端端的选区窗误杀（2026-10-06 实录）。就绪前整窗穿透（见 create_selector），
/// 没渲染好的窗口不吃点击，放宽超时不会变成陷阱。
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次性交给 HUD 窗的数据（窗挂载后 rec_hud_take 取走；新事件覆盖旧值）。
static HUD_DATA: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// 一次性交给预览裁剪窗的数据（窗挂载后 rec_preview_take 取走；重开覆盖旧值）。
static PREVIEW_DATA: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// HUD 安全网世代号：15s 强制关窗只关自己那一代（前端 8/10s 自关是主路径）。
static HUD_GEN: AtomicU64 = AtomicU64::new(0);
/// 「重录上次区域」计划：open_rerecord 存入，选区窗挂载经 URL 参数确认后取走。
/// URL 带模式标记，普通开窗绝不消费——建窗失败残留的旧计划不会劫持下一次开窗。
static RERECORD: Mutex<Option<session::RecOpts>> = Mutex::new(None);

/// 前端覆盖层挂载后调：撤销存活探针（commands.rs 的 `rec_ready` 写这里）。
pub(crate) fn mark_ready() {
    READY_GEN.store(GEN.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// 「重录上次区域」入口（HUD 按钮 / 托盘共用）：沿用上次的区域与参数，
/// 跳过框选直入倒计时。无上次记录 / 收尾中直接报错，不静默。
pub fn open_rerecord(app: &AppHandle) -> Result<(), String> {
    let st = session::status();
    if st.recording || st.finalizing {
        return Err("已有录制在进行".into());
    }
    let Some(opts) = session::last_opts() else {
        return Err("还没有上次录制".into());
    };
    *RERECORD.lock().unwrap_or_else(|p| p.into_inner()) = Some(opts);
    if let Some(w) = app.get_webview_window(SELECT_LABEL) {
        let _ = w.close();
    }
    create_selector(app, "rec.html?mode=rerecord");
    Ok(())
}

/// 选区窗挂载后按 URL 模式取重录计划（普通开窗传的 URL 没有标记，取不到）。
pub fn take_rerecord() -> Option<session::RecOpts> {
    RERECORD.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// 一次性交给 HUD 窗的数据（窗挂载后经 rec_hud_take 取走）。
pub fn take_hud_data() -> Option<serde_json::Value> {
    HUD_DATA.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// 一次性交给预览裁剪窗的数据（窗挂载后经 rec_preview_take 取走）。
pub fn take_preview_data() -> Option<serde_json::Value> {
    PREVIEW_DATA
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
}

/// 打开预览裁剪窗（rec_open_preview 校验路径并放行资产白名单后调用）。
/// 居中于主屏偏上；数据经 PREVIEW_DATA 下发，重开时旧窗顶掉重建。
pub fn open_preview_window(app: &AppHandle, data: serde_json::Value) {
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.close();
    }
    *PREVIEW_DATA.lock().unwrap_or_else(|p| p.into_inner()) = Some(data);
    let (mx, my, mw, mh, scale) = primary_screen_metrics(app);
    // 逻辑 840×600（视频区自适应 + 时间轴 + 操作行）；物理尺寸 = 逻辑 × 主屏 scale
    //（同 HUD/控制条：builder 收逻辑值，物理覆盖一次）
    let win_w = (840.0 * scale).round() as i32;
    let win_h = (600.0 * scale).round() as i32;
    let x = mx + (mw - win_w) / 2;
    let y = my + (mh - win_h) / 3;
    let built = WebviewWindowBuilder::new(
        app,
        PREVIEW_LABEL,
        WebviewUrl::App("rec-preview.html".into()),
    )
    .title("")
    .inner_size(840.0, 600.0) // 逻辑值占位；下方按物理覆盖
    .position(x as f64, y as f64)
    .resizable(false)
    .decorations(false)
    .shadow(true)
    .build();
    match built {
        Ok(window) => {
            #[cfg(target_os="macos")]
            let _=crate::macos::screen::place_window(&window,x,y,win_w as u32,win_h as u32);
            #[cfg(not(target_os="macos"))]
            let _ = window.set_size(tauri::PhysicalSize::new(win_w as u32, win_h as u32));
            #[cfg(not(target_os="macos"))]
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(e) => log::warn!("[Rec] 创建预览窗失败: {e}"),
    }
}

/// 打开 HUD 轻浮窗（主窗隐藏时的完成/失败通知，规则 15.1）。
/// 右下角贴主屏工作区；前端 8/10s 自关，这里留 15s 安全网（只关自己那一代）。
pub fn open_hud_window(app: &AppHandle, data: &serde_json::Value) {
    if let Some(w) = app.get_webview_window(HUD_LABEL) {
        let _ = w.close();
    }
    *HUD_DATA.lock().unwrap_or_else(|p| p.into_inner()) = Some(data.clone());
    let gen = HUD_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let (mx, my, mw, mh, scale) = primary_screen_metrics(app);
    // 内容按逻辑 320×118 设计；物理尺寸 = 逻辑 × scale——🔴 不乘的话 125% 缩放下
    // CSS 视口只有 256×94，按钮和进度条会被裁掉（P1，2026-10-05 二期审查）
    let win_w = (320.0 * scale).round() as i32;
    let win_h = (118.0 * scale).round() as i32;
    let margin_x = (14.0 * scale).round() as i32;
    let margin_y = (52.0 * scale).round() as i32;
    let x = mx + mw - win_w - margin_x;
    let y = my + mh - win_h - margin_y;
    let built = WebviewWindowBuilder::new(app, HUD_LABEL, WebviewUrl::App("rec-hud.html".into()))
        .title("")
        .inner_size(320.0, 118.0) // 逻辑值占位；下方按物理覆盖
        .position(x as f64, y as f64)
        .resizable(false);
    let built = built
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .build();
    match built {
        Ok(window) => {
            // builder 收逻辑像素，物理覆盖一次（同选区窗的坑）
            #[cfg(target_os="macos")]
            let _=crate::macos::screen::place_window(&window,x,y,win_w as u32,win_h as u32);
            #[cfg(not(target_os="macos"))]
            let _ = window.set_size(tauri::PhysicalSize::new(win_w as u32, win_h as u32));
            #[cfg(not(target_os="macos"))]
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = window.show();
            let probe = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(15)).await;
                if HUD_GEN.load(Ordering::SeqCst) == gen {
                    if let Some(w) = probe.get_webview_window(HUD_LABEL) {
                        let _ = w.close();
                    }
                }
            });
        }
        Err(e) => log::warn!("[Rec] 创建 HUD 窗失败: {e}"),
    }
}

/// 主屏几何（物理像素 + 缩放系数；primary_monitor 不可用时退回 SM_CXSCREEN，scale=1）。
fn primary_screen_metrics(app: &AppHandle) -> (i32, i32, i32, i32, f64) {
    #[cfg(not(target_os="macos"))]
    if let Ok(Some(m)) = app.primary_monitor() {
        let p = m.position();
        let s = m.size();
        return (p.x, p.y, s.width as i32, s.height as i32, m.scale_factor());
    }
    #[cfg(target_os = "macos")]
    {
        let m = crate::macos::screen::primary().ok();
        return m
            .map(|m| (m.x, m.y, m.w, m.h, crate::macos::screen::primary_scale()))
            .unwrap_or((0, 0, 0, 0, 1.0));
    }
    #[cfg(windows)]
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    #[cfg(windows)]
    unsafe {
        (
            0,
            0,
            GetSystemMetrics(SM_CXSCREEN).max(1),
            GetSystemMetrics(SM_CYSCREEN).max(1),
            1.0,
        )
    }
}

/// 虚拟屏几何（物理像素）——与 rc/dxgi.rs、screenshot.rs 同源口径。
#[cfg(windows)]
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

/// Mac 选区几何采用窗口系统的真实显示器数据；不把原生查询失败静默变成 0×0。
pub(crate) fn selector_screen_metrics(app: &AppHandle) -> Result<(i32, i32, i32, i32), String> {
    #[cfg(target_os = "macos")]
    let metrics = {let r=crate::macos::screen::desktop()?;(r.x,r.y,r.w,r.h)};
    #[cfg(windows)]
    let metrics = virtual_screen_metrics();
    if metrics.2 < 16 || metrics.3 < 16 {
        return Err("显示器尺寸无效，无法打开录屏选区".into());
    }
    Ok(metrics)
}
fn report_startup_failure(app: &AppHandle, message: &str) {
    log::warn!("[Rec] {message}");
    let _ = app.emit(
        "rec-failed",
        serde_json::json!({"message":message,"hud":false}),
    );
}

/// 打开（或聚焦）录屏选区窗。热键 / 工具箱 / 托盘共用入口。
pub fn open_selector_window(app: &AppHandle) {
    log::info!("[Rec] 请求打开录屏选区");
    let st = session::status();
    // 已有会话在录：热键语义 = 停止（见 commands::rec_toggle）
    if st.recording {
        let _ = session::stop(false);
        return;
    }
    // 收尾中（亚秒窗口）：不开窗也不报错——开了也会在 rec_start 处吃到
    // 「已有录制在进行」的错误卡，白白给用户一次假失败
    if st.finalizing {
        return;
    }
    if let Some(w) = app.get_webview_window(SELECT_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("rec-refresh", ());
        return;
    }
    create_selector(app, "rec.html");
}

fn create_selector(app: &AppHandle, url: &str) {
    if CREATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let url = url.to_string();
    std::thread::spawn(move || {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                CREATING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = Reset;
        let (x, y, w, h) = match selector_screen_metrics(&app) {
            Ok(metrics) => metrics,
            Err(error) => {
                report_startup_failure(&app, &error);
                return;
            }
        };
        log::info!("[Rec] 选区屏幕几何 {x},{y} {w}×{h}");
        // 世代号在 build() 之前递增（同截图窗：build 一返回前端就可能 ready）
        let generation = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let builder = WebviewWindowBuilder::new(&app, SELECT_LABEL, WebviewUrl::App(url.into()))
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
                #[cfg(target_os="macos")]
                let _=crate::macos::screen::place_window(&window,x,y,w.max(1) as u32,h.max(1) as u32);
                #[cfg(not(target_os="macos"))]
                let _ = window.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
                #[cfg(not(target_os="macos"))]
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                // 🔴 就绪前整窗穿透：页面加载慢/被整页 reload 打断期间，一个没渲染
                // 出来的全屏窗绝不能吃用户的点击（卡死陷阱的延伸教训）。
                // rec_ready 到达时恢复交互并抢焦点（见 commands::rec_ready）。
                let _ = window.set_ignore_cursor_events(true);
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
                    log::warn!(
                        "[Rec] 选区窗前端 {}s 内未就绪，自动关窗",
                        READY_TIMEOUT.as_secs()
                    );
                    let _ = probe.emit("rec-startup-failed", ());
                    close_windows(&probe);
                });
            }
            Err(e) => report_startup_failure(&app, &format!("创建录屏选区失败：{e}")),
        }
    });
}

/// 打开录制控制条窗（rec_start 成功后调用）。位置：选区上缘外 12px，越界回弹到屏内。
pub fn open_control_window(app: &AppHandle, region: (i32, i32, u32, u32)) -> Result<(), String> {
    let screen = selector_screen_metrics(app)?;
    let scale = monitor_scale_at(app, region.0, region.1);
    let layout = control_layout::place(screen,region,scale)?;
    let (bx,by,bar_w,bar_h)=(layout.x,layout.y,layout.w,layout.h);
    if let Some(old) = app.get_webview_window(CONTROL_LABEL) {
        let _ = old.close();
    }
    let builder = WebviewWindowBuilder::new(
        app,
        CONTROL_LABEL,
        WebviewUrl::App("rec-control.html".into()),
    )
    .title("")
    .inner_size(496.0, 48.0) // 逻辑值占位；下方按物理覆盖
    .position(bx as f64, by as f64)
    .resizable(false);
    let built = builder
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .build();
    let window = built.map_err(|e| format!("创建录制控制条失败：{e}"))?;
    // 超时取消可能发生在 build 等待期间；晚到的控制条不应复活已停止会话。
    if !session::status().recording {
        let _=window.destroy();
        return Err("录制已停止，控制条不再打开".into());
    }
    #[cfg(target_os="macos")]
    crate::macos::screen::place_window(&window,bx,by,bar_w,bar_h)?;
    #[cfg(not(target_os="macos"))]
    window.set_size(tauri::PhysicalSize::new(bar_w,bar_h)).map_err(|e|format!("设置录制控制条大小失败：{e}"))?;
    #[cfg(not(target_os="macos"))]
    window.set_position(tauri::PhysicalPosition::new(bx,by)).map_err(|e|format!("定位录制控制条失败：{e}"))?;
    window.show().map_err(|e|format!("显示录制控制条失败：{e}"))?;
    log::info!("[Rec] 控制条已显示 {bx},{by} {bar_w}×{bar_h}");
    Ok(())
}

/// 物理坐标所在显示器的缩放系数（跨屏 DPI 各异：控制条贴着选区落在哪块屏，
/// 就按谁的 scale 换算物理尺寸）；坐标不在任何屏上（边缘情况）退 1.0。
fn monitor_scale_at(app: &AppHandle, x: i32, y: i32) -> f64 {
    #[cfg(target_os="macos")]
    {let _=(app,x,y);return crate::macos::screen::primary_scale();}
    #[cfg(not(target_os="macos"))]
    if let Ok(monitors) = app.available_monitors() {
        for m in monitors {
            let p = m.position();
            let s = m.size();
            if x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32 {
                return m.scale_factor();
            }
        }
    }
    #[cfg(not(target_os="macos"))]
    {1.0}
}

/// 关闭录屏相关窗口（选区 + 控制条）。会话收尾由后端权威调用（见 session::start），
/// 前端 rec_close_windows 只是冗余保险。
/// 🔴 用 destroy() 强拆而非 close()：destroy 绕过 CloseRequested 流程，
/// 不给任何 handler「拦一下」的机会——2026-10-06 实录踩坑后收尾只许成功不许失败。
pub fn close_windows(app: &AppHandle) {
    for label in [SELECT_LABEL, CONTROL_LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            if let Err(e) = w.destroy() {
                log::warn!("[Rec] 强拆窗口 {label} 失败: {e}");
            }
        }
    }
}
