use super::model::{Pin, Rect};
use super::{desktop, model, publish};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
pub(crate) const LABEL: &str = "clothesline";
static CREATING: AtomicBool = AtomicBool::new(false);
static POLL: AtomicU64 = AtomicU64::new(0);
static READY: AtomicBool = AtomicBool::new(false);
static NATIVE_READY: AtomicBool = AtomicBool::new(false);
static REQUESTED: AtomicBool = AtomicBool::new(false);

fn set_pointer_passthrough(win: &tauri::WebviewWindow, ignore: bool) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        let target = win.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        win.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                // Tao adds WS_EX_LAYERED for passthrough. Without initializing alpha,
                // Windows will not compose the window until passthrough is removed on hover.
                // Run both calls on the UI thread so initialization follows the style change.
                target.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
                if ignore {
                    use windows::Win32::Foundation::{COLORREF, HWND};
                    use windows::Win32::UI::WindowsAndMessaging::{SetLayeredWindowAttributes, LWA_ALPHA};
                    let hwnd = target.hwnd().map_err(|e| e.to_string())?;
                    unsafe {
                        SetLayeredWindowAttributes(HWND(hwnd.0), COLORREF(0), 255, LWA_ALPHA)
                            .map_err(|e| e.to_string())?;
                    }
                }
                Ok(())
            })();
            if let Err(error) = &result {
                log::warn!("[Clothesline] 鼠标穿透/显示初始化失败: {error}");
                let _ = target.app_handle().emit("clothesline-error", format!("晾衣绳显示未完成：{error}"));
            }
            let _ = sender.send(result);
        })?;
        receiver.recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?
            .map_err(|e| tauri::Error::Io(std::io::Error::other(e)))
    }
    #[cfg(not(windows))]
    win.set_ignore_cursor_events(ignore)
}

fn raise_above_desktop(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let target = win.clone();
        let _ = win.run_on_main_thread(move || {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};
            if let Ok(hwnd) = target.hwnd() {
                // Activating Progman must not cover the desktop rope. Keep ordinary Z order, without stealing focus.
                unsafe { let _ = SetWindowPos(HWND(hwnd.0), HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = win;
}

pub(super) fn sync_visibility(app: &AppHandle) {
    if !READY.load(Ordering::SeqCst) || !NATIVE_READY.load(Ordering::SeqCst) {
        return;
    }
    let show = {
        let m = model();
        desktop::can_show(
            desktop::is_desktop(),
            m.snapshot.enabled,
            m.suspended,
            m.captures,
            REQUESTED.load(Ordering::SeqCst),
        )
    };
    if !show {
        hide_window(app);
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
            if let Err(error) = win.show() {
                log::warn!("[Clothesline] 显示失败: {error}");
                return;
            }
            #[cfg(windows)]
            {
                let target = win.clone();
                let _ = win.run_on_main_thread(move || unsafe {
                    if let Ok(hwnd) = target.hwnd() {
                        use windows::Win32::Graphics::Gdi::{RedrawWindow, RDW_INVALIDATE, RDW_ALLCHILDREN, RDW_UPDATENOW};
                        // Compose the first visible frame without waiting for a hover-induced style change.
                        let _ = RedrawWindow(windows::Win32::Foundation::HWND(hwnd.0), None, None, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
                    }
                });
            }
            let _ = app.emit_to(LABEL, "clothesline-visible", true);
            start_poll(app);
        }
        raise_above_desktop(&win);
    }
}

pub(crate) fn ensure(app: &AppHandle) {
    {
        let m = model();
        if !m.snapshot.enabled || m.suspended || m.captures > 0 {
            return;
        }
    }
    REQUESTED.store(true, Ordering::SeqCst);
    if app.get_webview_window(LABEL).is_some() {
        sync_visibility(app);
        return;
    }
    if CREATING.swap(true, Ordering::SeqCst) {
        return;
    }
    READY.store(false, Ordering::SeqCst);
    NATIVE_READY.store(false, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            if app.get_webview_window(LABEL).is_some() {
                return Ok(());
            }
            let monitors = app.available_monitors().map_err(|e| e.to_string())?;
            #[cfg(windows)]
            let cursor = cursor();
            #[cfg(not(windows))]
            let cursor = None::<(f64, f64)>;
            let monitor = monitors
                .iter()
                .find(|m| {
                    let wa = m.work_area();
                    cursor.is_some_and(|(x, y)| {
                        x >= wa.position.x as f64
                            && y >= wa.position.y as f64
                            && x < (wa.position.x + wa.size.width as i32) as f64
                            && y < (wa.position.y + wa.size.height as i32) as f64
                    })
                })
                .cloned()
                .or(app.primary_monitor().map_err(|e| e.to_string())?)
                .ok_or("找不到可用显示器")?;
            let wa = monitor.work_area();
            let scale = monitor.scale_factor();
            {
                let mut m = model();
                m.snapshot.work_area = Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    width: wa.size.width as f64,
                    height: wa.size.height as f64,
                };
                m.snapshot.scale = scale;
                if !m.snapshot.enabled || m.suspended || m.captures > 0 {
                    return Ok(());
                }
            }
            let win = tauri::WebviewWindowBuilder::new(
                &app,
                LABEL,
                tauri::WebviewUrl::App("clothesline.html".into()),
            )
            .decorations(false)
            .always_on_top(false)
            .skip_taskbar(true)
            .transparent(true)
            .focused(false)
            .resizable(false)
            .visible(false)
            .shadow(false)
            .inner_size(wa.size.width as f64 / scale, wa.size.height as f64 / scale)
            .position(wa.position.x as f64 / scale, wa.position.y as f64 / scale)
            .build()
            .map_err(|e| e.to_string())?;
            set_pointer_passthrough(&win, true)
                .map_err(|e| e.to_string())?;
            win.set_position(tauri::PhysicalPosition::new(wa.position.x, wa.position.y))
                .map_err(|e| e.to_string())?;
            win.set_size(tauri::PhysicalSize::new(wa.size.width, wa.size.height))
                .map_err(|e| e.to_string())?;
            NATIVE_READY.store(true, Ordering::SeqCst);
            sync_visibility(&app);
            // 页面回报 ready 后才点亮，防止冷启动白屏遮住其它应用。
            Ok(())
        })();
        CREATING.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            log::warn!("[Clothesline] 建窗失败: {error}");
            let _ = app.emit(
                "clothesline-error",
                format!("晾衣绳未能显示：{error}；图片历史已保留"),
            );
        }
    });
}
pub(crate) fn retry(app: &AppHandle) -> Result<(), String> {
    if !model().snapshot.enabled { return Err("请先开启晾衣绳".into()); }
    if let Some(win) = app.get_webview_window(LABEL) {
        READY.store(false, Ordering::SeqCst);
        hide_window(app);
        set_pointer_passthrough(&win, true).map_err(|e| e.to_string())?;
        NATIVE_READY.store(true, Ordering::SeqCst);
        win.eval("location.reload()").map_err(|e| e.to_string())?;
    } else { ensure(app); }
    Ok(())
}
pub(crate) fn ready(app: &AppHandle) -> Result<(), String> {
    READY.store(true, Ordering::SeqCst);
    app.get_webview_window(LABEL).ok_or("晾衣绳窗口已关闭")?;
    sync_visibility(app);
    publish(app);
    if let Some((pin, drop)) = model().pending_pin.take() {
        let _ = app.emit_to(
            LABEL,
            if drop {
                "clothesline-pin-drop"
            } else {
                "clothesline-pin-preview"
            },
            pin,
        );
    }
    Ok(())
}
pub(crate) async fn wait_ready(app: &AppHandle) -> Result<(), String> {
    let start = std::time::Instant::now();
    while !READY.load(Ordering::SeqCst) || !NATIVE_READY.load(Ordering::SeqCst) || app.get_webview_window(LABEL).is_none() {
        if start.elapsed() > std::time::Duration::from_secs(6) {
            return Err("晾衣绳未能就绪，原贴图保留；请重试".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    Ok(())
}
pub(crate) fn hide(app: &AppHandle) {
    REQUESTED.store(false, Ordering::SeqCst);
    hide_window(app);
}
fn hide_window(app: &AppHandle) {
    POLL.fetch_add(1, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = set_pointer_passthrough(&win, true);
        let _ = win.hide();
    }
    let _ = app.emit_to(LABEL, "clothesline-visible", false);
}
pub(crate) fn disable(app: &AppHandle) {
    hide(app);
    READY.store(false, Ordering::SeqCst);
    NATIVE_READY.store(false, Ordering::SeqCst);
    {
        let mut m = model();
        m.regions.clear();
        m.dragging = false;
        m.pending_pin = None;
    }
    // 关闭开关释放 WebView；重新开启也能恢复加载失败的页面，照片记录仍在会话中。
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.close();
    }
}
pub fn set_suspended(app: &AppHandle, suspended: bool) {
    model().suspended = suspended;
    let show = {
        let m = model();
        m.captures == 0 && !m.snapshot.items.is_empty()
    };
    if suspended {
        hide_for_capture(app);
    } else if show {
        ensure(app);
    }
}
fn hide_for_capture(app: &AppHandle) {
    hide_window(app);
    #[cfg(windows)]
    unsafe {
        if let Some(win) = app.get_webview_window(LABEL) {
            if let Ok(hwnd) = win.hwnd() {
                let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                    windows::Win32::Foundation::HWND(hwnd.0),
                    windows::Win32::UI::WindowsAndMessaging::SW_HIDE,
                );
            }
        }
        let _ = windows::Win32::Graphics::Dwm::DwmFlush();
    }
}
pub struct CaptureGuard(AppHandle);
/// OLE 期间让出鼠标，桌面上的绳子仍可见；切换其它应用仍由桌面可见性门控隐藏。
pub struct DragGuard(AppHandle);
impl DragGuard {
    pub fn new(app: &AppHandle) -> Self {
        model().transfers += 1;
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = set_pointer_passthrough(&win, true);
            #[cfg(windows)]
            if let Ok(hwnd) = win.hwnd() {
                // WindowFromPoint 跳过 disabled HWND，连 WebView 子窗口也不再遮住 OLE 接收区。
                unsafe { let _ = windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow(windows::Win32::Foundation::HWND(hwnd.0), false); }
            }
        }
        Self(app.clone())
    }
}
impl Drop for DragGuard {
    fn drop(&mut self) {
        let last = { let mut m = model(); m.transfers = m.transfers.saturating_sub(1); m.transfers == 0 };
        #[cfg(windows)]
        if last {
            if let Some(win) = self.0.get_webview_window(LABEL) {
                if let Ok(hwnd) = win.hwnd() {
                    unsafe { let _ = windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow(windows::Win32::Foundation::HWND(hwnd.0), true); }
                }
            }
        }
        #[cfg(not(windows))]
        let _ = last;
        sync_visibility(&self.0);
        // 短拖动可能没赶上 60ms 的命中采样；重置 inside，避免结束后一直留在穿透态。
        if last {
            if self.0.get_webview_window(LABEL).is_some_and(|win| win.is_visible().unwrap_or(false)) {
                let _ = self.0.emit_to(LABEL, "clothesline-visible", true);
                start_poll(&self.0);
            }
        }
    }
}
impl CaptureGuard {
    pub fn new(app: &AppHandle) -> Self {
        // Tauri 隐藏消息与 DWM 合成均需在取像素前完成。
        model().captures += 1;
        hide_for_capture(app);
        Self(app.clone())
    }
}
impl Drop for CaptureGuard {
    fn drop(&mut self) {
        let show = {
            let mut m = model();
            m.captures = m.captures.saturating_sub(1);
            m.captures == 0 && !m.suspended && !m.snapshot.items.is_empty()
        };
        if show {
            ensure(&self.0);
        }
    }
}
fn start_poll(app: &AppHandle) {
    let mine = POLL.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        let mut inside = false;
        let mut ticks = 0;
        while POLL.load(Ordering::SeqCst) == mine {
            let Some(win) = app.get_webview_window(LABEL) else {
                return;
            };
            if !win.is_visible().unwrap_or(false) {
                return;
            }
            ticks += 1;
            if ticks % 16 == 0 {
                refresh_work_area(&app, &win);
            }
            #[cfg(windows)]
            let point = cursor();
            #[cfg(not(windows))]
            let point = win.cursor_position().ok().map(|p| (p.x, p.y));
            if let (Some((x, y)), Ok(origin), Ok(scale)) =
                (point, win.outer_position(), win.scale_factor())
            {
                #[cfg(windows)]
                let pressed_inside = inside && unsafe {
                    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
                    GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0
                };
                #[cfg(not(windows))]
                let pressed_inside = false;
                let hit = model().hit(
                    (x - origin.x as f64) / scale,
                    (y - origin.y as f64) / scale,
                    if inside { 6.0 } else { 2.0 },
                    pressed_inside,
                );
                if hit != inside {
                    inside = hit;
                    let _ = set_pointer_passthrough(&win, !hit);
                    let _ = app.emit_to(LABEL, "clothesline-hover", hit);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    });
}
#[cfg(windows)]
fn cursor() -> Option<(f64, f64)> {
    let mut point = windows::Win32::Foundation::POINT::default();
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point).ok()?;
    }
    Some((point.x as f64, point.y as f64))
}
// 原生贴图的模态拖拽通过窗口消息回传；接收窗口不抢原生拖拽的鼠标捕获。
pub fn pin_drag(app: &AppHandle, mut pin: Pin, drop: bool) -> bool {
    #[cfg(windows)]
    { pin.point = cursor().map(|(x, y)| [x, y]); }
    if !desktop::is_desktop() {
        pin_drag_cancel(app);
        return false;
    }
    {
        let m = model();
        if !m.snapshot.enabled || m.suspended {
            return false;
        }
    }
    if !model().snapshot.work_area.valid() {
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let wa = monitor.work_area();
            let mut m = model();
            m.snapshot.work_area = Rect {
                x: wa.position.x as f64,
                y: wa.position.y as f64,
                width: wa.size.width as f64,
                height: wa.size.height as f64,
            };
            m.snapshot.scale = monitor.scale_factor();
        }
    }
    let near = {
        let m = model();
        let wa = m.snapshot.work_area;
        let scale = m.snapshot.scale;
        let anchors = m.snapshot.anchors.as_ref();
        let top = anchors
            .and_then(|v| v.get("left"))
            .and_then(|v| v.get("y"))
            .and_then(|v| v.as_f64())
            .unwrap_or(32.0 / (wa.height / scale).max(1.0));
        let bottom = anchors
            .and_then(|v| v.get("right"))
            .and_then(|v| v.get("y"))
            .and_then(|v| v.as_f64())
            .unwrap_or(top);
        let near_y = |y| y >= wa.y + top.min(bottom) * wa.height - 40.0 * scale
            && y <= wa.y + top.max(bottom) * wa.height + 180.0 * scale;
        near_y(pin.rect.y) || pin.point.is_some_and(|p| near_y(p[1]))
    };
    if near
        || app
            .get_webview_window(LABEL)
            .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        if !app
            .get_webview_window(LABEL)
            .is_some_and(|w| w.is_visible().unwrap_or(false))
        {
            model().pending_pin = Some((pin.clone(), drop));
        }
        if near {
            ensure(app);
        }
        return app.emit_to(
            LABEL,
            if drop {
                "clothesline-pin-drop"
            } else {
                "clothesline-pin-preview"
            },
            pin,
        ).is_ok();
    }
    false
}
pub fn restore_drag_pin(app: &AppHandle, pin: Pin) -> bool {
    if !model().snapshot.enabled { return false; }
    let Ok(mut payload) = serde_json::to_value(pin) else { return false; };
    payload["force"] = serde_json::Value::Bool(true);
    app.emit_to(LABEL, "clothesline-pin-drop", payload).is_ok()
}
pub fn pin_drag_cancel(app: &AppHandle) {
    model().pending_pin = None;
    let _ = app.emit_to(LABEL, "clothesline-pin-preview", serde_json::Value::Null);
}
fn refresh_work_area(app: &AppHandle, win: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = win.current_monitor().or_else(|_| app.primary_monitor()) else {
        return;
    };
    let wa = monitor.work_area();
    let scale = monitor.scale_factor();
    let rect = Rect {
        x: wa.position.x as f64,
        y: wa.position.y as f64,
        width: wa.size.width as f64,
        height: wa.size.height as f64,
    };
    let changed = {
        let mut m = model();
        let old = m.snapshot.work_area;
        if old.x == rect.x
            && old.y == rect.y
            && old.width == rect.width
            && old.height == rect.height
            && m.snapshot.scale == scale
        {
            false
        } else {
            m.snapshot.work_area = rect;
            m.snapshot.scale = scale;
            m.regions.clear();
            true
        }
    };
    if changed {
        let _ = win.set_position(tauri::PhysicalPosition::new(wa.position.x, wa.position.y));
        let _ = win.set_size(tauri::PhysicalSize::new(wa.size.width, wa.size.height));
        publish(app);
    }
}
