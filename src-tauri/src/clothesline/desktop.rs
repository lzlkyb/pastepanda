//! 桌面可见性由前台切换事件驱动；隐藏时不靠定时器唤醒 WebView。
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

static DESKTOP: AtomicBool = AtomicBool::new(false);

fn context(previous: bool, class: &str, rope: bool, pin: bool, desktop_exposed: bool) -> bool {
    if crate::todo_island_fullscreen::SHELL_CLASSES.contains(&class) {
        true
    } else if class == "Shell_TrayWnd" || class == "Shell_SecondaryTrayWnd" {
        // Taskbar focus preserves desktop context; Win+D / last-app minimize can also restore it.
        previous || desktop_exposed
    } else if rope || pin || class.is_empty() {
        previous || desktop_exposed
    } else {
        false
    }
}
fn foreground_context(previous: bool, class: &str, rope: bool, pin: bool, exposed: bool, inactive: bool) -> bool {
    // Preparing / hiding our pin may temporarily leave that HWND in foreground.
    // It inherits the desktop context; only an inactive external app needs exposure recovery.
    if inactive && !rope && !pin { exposed } else { context(previous, class, rope, pin, exposed) }
}
pub(super) fn can_show(
    desktop: bool,
    enabled: bool,
    suspended: bool,
    captures: usize,
    requested: bool,
) -> bool {
    desktop && enabled && !suspended && captures == 0 && requested
}
pub(super) fn is_desktop() -> bool {
    #[cfg(windows)]
    {
        DESKTOP.load(Ordering::SeqCst)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::OnceLock;
    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{BOOL, HMODULE, HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetMessageW,
        GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindowVisible, GA_ROOTOWNER, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
        GetWindowThreadProcessId, TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG,
        EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, WINEVENT_OUTOFCONTEXT,
    };
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static REFRESH: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Scan { surfaces: Vec<isize>, blocked: bool }
    unsafe extern "system" fn visible_app(hwnd: HWND, data: LPARAM) -> BOOL {
        let scan = &mut *(data.0 as *mut Scan);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool()
            || scan.surfaces.contains(&(hwnd.0 as isize))
            || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize != 0 { return BOOL(1); }
        let mut name = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut name).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..n]);
        if crate::todo_island_fullscreen::SHELL_CLASSES.contains(&class.as_str())
            || matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") { return BOOL(1); }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, std::mem::size_of::<u32>() as u32);
        if cloaked != 0 { return BOOL(1); }
        let mut rect = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() || rect.right <= rect.left || rect.bottom <= rect.top { return BOOL(1); }
        scan.blocked = true;
        BOOL(0)
    }

    fn surface_handles(app: &AppHandle) -> Vec<isize> {
        [super::super::window::LABEL, crate::todo_island::WINDOW_LABEL].iter()
            .filter_map(|label| app.get_webview_window(label).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize)).collect()
    }
    unsafe fn desktop_exposed(surfaces: &[isize]) -> bool {
        let mut scan = Scan { surfaces: surfaces.to_vec(), blocked: false };
        let result = EnumWindows(Some(visible_app), LPARAM(&mut scan as *mut _ as isize));
        result.is_ok() && !scan.blocked
    }

    fn refresh(app: &AppHandle) {
        // Keep foreground sampling, state commit and visibility in one serialized check.
        // A delayed scan must never overwrite a newer app-focus result.
        let _refresh = REFRESH.lock().unwrap_or_else(|p| p.into_inner());
        unsafe {
            let hwnd = GetForegroundWindow();
            let root = GetAncestor(hwnd, GA_ROOTOWNER);
            let mut class = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut class);
            let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
            let rope = app
                .get_webview_window(super::super::window::LABEL)
                .and_then(|w| w.hwnd().ok())
                .is_some_and(|h| h.0 == hwnd.0 || h.0 == root.0);
            let surfaces = surface_handles(app);
            let surface = surfaces.contains(&(hwnd.0 as isize)) || surfaces.contains(&(root.0 as isize));
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let pin =
                pid == std::process::id() && (class == "PinnedImageWindow" || class == "#32768");
            let probe = surface || pin || class.is_empty() || matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
                || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool();
            let exposed = probe && desktop_exposed(&surfaces);
            let previous = is_desktop();
            let inactive = !hwnd.0.is_null() && (!IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool());
            let next = foreground_context(previous, &class, surface, pin, exposed, inactive);
            DESKTOP.store(next, Ordering::SeqCst);
            if next != previous { log::info!("[Clothesline] desktop={next} foreground_class={class} exposed={exposed} previous={previous} own_pin={pin} inactive={inactive}"); }
            if !rope {
                // 桌面空白仍鼠标穿透；用户点到预览外部后由前台切换关闭，不吞底层点击。
                let _ = app.emit_to(
                    super::super::window::LABEL,
                    "clothesline-preview-dismiss",
                    (),
                );
            }
        }
        super::super::window::sync_visibility(app);
    }
    unsafe extern "system" fn foreground(
        _hook: HWINEVENTHOOK,
        event: u32,
        _hwnd: HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if let Some(app) = APP.get() {
            if event == EVENT_SYSTEM_FOREGROUND { refresh(app); }
            // Shell focus can arrive before the final minimize/hide state settles.
            // Coalesce a single delayed check, never a hidden-window polling loop.
            let revision = REVISION.fetch_add(1, Ordering::SeqCst) + 1;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if REVISION.load(Ordering::SeqCst) == revision { refresh(&app); }
            });
        }
    }
    pub(super) fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                HMODULE::default(),
                Some(foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_invalid() {
                log::warn!("[Clothesline] 桌面前台事件监听失败，绳层保持隐藏");
                return;
            }
            let minimize_hook = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND,
                HMODULE::default(), Some(foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
            if minimize_hook.is_invalid() { log::warn!("[Clothesline] 最小化事件监听失败"); }
            refresh(&app);
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = UnhookWinEvent(hook);
            if !minimize_hook.is_invalid() { let _ = UnhookWinEvent(minimize_hook); }
        });
    }
}
pub(super) fn install(app: &AppHandle) {
    #[cfg(windows)]
    native::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_pin_preparation_keeps_desktop_but_external_apps_still_hide_rope() {
        assert!(foreground_context(true, "PinnedImageWindow", false, true, false, true));
        assert!(foreground_context(true, "Tauri Window", true, false, false, true));
        assert!(!foreground_context(false, "PinnedImageWindow", false, true, false, true));
        assert!(!foreground_context(true, "Chrome_WidgetWin_1", false, false, false, true));
        assert!(!foreground_context(true, "Chrome_WidgetWin_1", false, false, true, false));
        assert!(foreground_context(false, "Chrome_WidgetWin_1", false, false, true, true));
    }
    #[test]
    fn application_never_lights_rope_but_desktop_restores_it() {
        assert!(context(false, "Progman", false, false, true));
        assert!(context(false, "WorkerW", false, false, true));
        assert!(!context(true, "Chrome_WidgetWin_1", false, false, false));
        assert!(!context(true, "Tauri Window", false, false, false));
    }
    #[test]
    fn pin_context_is_inherited_instead_of_enabling_overlay() {
        assert!(context(true, "PinnedImageWindow", false, true, true));
        assert!(!context(false, "PinnedImageWindow", false, true, false));
        assert!(context(true, "Tauri Window", true, false, true));
        assert!(!context(false, "Tauri Window", true, false, false));
    }
    #[test]
    fn returning_to_exposed_desktop_does_not_require_a_desktop_click() {
        assert!(context(false, "Shell_TrayWnd", false, false, true));
        assert!(!context(false, "Shell_TrayWnd", false, false, false));
        assert!(context(false, "PinnedImageWindow", false, true, true));
        assert!(!context(false, "Chrome_WidgetWin_1", false, false, true));
    }
    #[test]
    fn taskbar_focus_preserves_desktop_even_with_background_app_windows() {
        assert!(context(true, "Shell_TrayWnd", false, false, false));
        assert!(context(true, "Shell_SecondaryTrayWnd", false, false, false));
        assert!(!context(false, "Shell_TrayWnd", false, false, false));
    }
    #[test]
    fn visibility_respects_privacy_switch_and_idle() {
        assert!(can_show(true, true, false, 0, true));
        assert!(!can_show(false, true, false, 0, true));
        assert!(!can_show(true, false, false, 0, true));
        assert!(!can_show(true, true, true, 0, true));
        assert!(!can_show(true, true, false, 1, true));
        assert!(!can_show(true, true, false, 0, false));
    }
}
