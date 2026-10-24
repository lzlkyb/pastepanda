//! 前台采样只回答一个问题：要不要把绳窗口抬到顶层。
//!
//! 2026-10-23 之前这里的语义完全不同：`can_show` 依赖 `desktop`，而 `desktop` 由
//! `EnumWindows` 枚举所有顶层窗口算出——只要有任意一个可见窗口存在，就判定「桌面被
//! 挡住」并隐藏整根绳。那个判据的真实含义是「桌面是否完全干净」，用户要知道的却是
//! 「绳子会不会挡住我」。后一个问题不需要计算：窗口 `always_on_top(false)`，被应用
//! 窗口盖住时本来就看不见，是 Z 序顺带提供的免费结果。
//!
//! 用 240 行去猜一件免费的事，必然有猜错的时候。实测路径：把贴图拖进微信时前台变成
//! 微信 ⇒ `desktop = false` ⇒ 整根绳消失。多显示器、虚拟桌面、UWP 宿主窗口下同类
//! 误判也无法靠继续加类名白名单修完。
//!
//! 现在只剩 Z 序这一件事需要知道前台是谁：
//! - 桌面是前台（Progman / WorkerW / 任务栏 / 前台缺失）→ 窗口必须抬到顶层，
//!   否则会被桌面窗口本身盖住，永远看不见；
//! - 普通应用是前台 → 不抬，让窗口自然待在应用之下，被盖住的部分就该看不见。
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

static DESKTOP: AtomicBool = AtomicBool::new(false);

/// 前台是否处于「桌面上下文」。只影响 Z 序抬升，**不再影响显示与否**。
fn on_desktop_context(class: &str, own: bool, inactive: bool) -> bool {
    own || inactive
        || class.is_empty()
        || crate::todo_island_fullscreen::SHELL_CLASSES.contains(&class)
        || matches!(class, "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

/// 绳子该不该显示。这里刻意**不接受**前台信息：
/// 常驻显示的判断只有「开关 / 挂起 / 截图进行中 / 是否请求过」四个。
pub(super) fn can_show(enabled: bool, suspended: bool, captures: usize, requested: bool) -> bool {
    enabled && !suspended && captures == 0 && requested
}

pub(super) fn on_desktop() -> bool {
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
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetAncestor, GetClassNameW, GetForegroundWindow, GetMessageW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, TranslateMessage, GA_ROOTOWNER, MSG,
        EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND,
        WINEVENT_OUTOFCONTEXT,
    };
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static REFRESH: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn own_surfaces(app: &AppHandle) -> Vec<isize> {
        [super::super::window::LABEL, crate::todo_island::WINDOW_LABEL]
            .iter()
            .filter_map(|label| app.get_webview_window(label).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize))
            .collect()
    }

    fn refresh(app: &AppHandle) {
        // 前台采样、状态提交与可见性必须在同一次串行检查里完成：
        // 迟到的采样不能覆盖更新的前台结果。
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
            let surfaces = own_surfaces(app);
            let surface = surfaces.contains(&(hwnd.0 as isize)) || surfaces.contains(&(root.0 as isize));
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let pin =
                pid == std::process::id() && (class == "PinnedImageWindow" || class == "#32768");
            let inactive =
                !hwnd.0.is_null() && (!IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool());
            let next = on_desktop_context(&class, surface || rope || pin, inactive);
            let previous = DESKTOP.swap(next, Ordering::SeqCst);
            if next != previous {
                log::info!("[Clothesline] on_desktop={next} foreground_class={class} previous={previous} own_pin={pin}");
            }
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
            // Shell 焦点可能先于最终的最小化/隐藏状态到达。
            // 只合并一次延迟检查，不做隐藏窗口轮询。
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
                windows::Win32::Foundation::HMODULE::default(),
                Some(foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_invalid() {
                log::warn!("[Clothesline] 前台事件监听失败，绳层无法感知桌面切换");
                return;
            }
            let minimize_hook = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND,
                windows::Win32::Foundation::HMODULE::default(), Some(foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
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
    fn rope_is_no_longer_hidden_by_a_foreground_app() {
        // 这条钉住本次修复的核心：显示判断里已经**没有**前台信息这个入参。
        // 开关开、未挂起、没有截图在途、用户请求过 ⇒ 就必须显示，
        // 无论前台是微信、Chrome 还是资源管理器。
        assert!(can_show(true, false, 0, true));
        assert!(!can_show(false, false, 0, true), "开关关掉不显示");
        assert!(!can_show(true, true, 0, true), "挂起时不显示");
        assert!(!can_show(true, false, 1, true), "截图进行中不显示");
        assert!(!can_show(true, false, 0, false), "没请求过不显示");
    }

    #[test]
    fn desktop_context_only_decides_z_order() {
        // 桌面自己在前台 ⇒ 必须抬到顶层，否则被 Progman 盖住。
        assert!(on_desktop_context("Progman", false, false));
        assert!(on_desktop_context("WorkerW", false, false));
        assert!(on_desktop_context("Shell_TrayWnd", false, false));
        assert!(on_desktop_context("Shell_SecondaryTrayWnd", false, false));
        assert!(on_desktop_context("", false, false), "前台窗口缺失按桌面处理");
        assert!(on_desktop_context("Chrome_WidgetWin_1", false, true), "前台窗口最小化按桌面处理");
        // 自己的窗口（绳本身、贴图、待办岛）在前台 ⇒ 仍在桌面上下文里。
        assert!(on_desktop_context("PinnedImageWindow", true, false));
        assert!(on_desktop_context("Tauri Window", true, false));
        // 普通应用在前台 ⇒ 不抬，让它自然盖住绳子。
        assert!(!on_desktop_context("Chrome_WidgetWin_1", false, false));
        assert!(!on_desktop_context("Tauri Window", false, false));
        assert!(!on_desktop_context("WeChatMainWndForPC", false, false));
    }
}
