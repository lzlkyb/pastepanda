//! 聚焦输入框探测 —— 为栈浮标提供「贴输入框右上方」的锚点矩形。
//!
//! ## 为什么需要独立模块
//!
//! 窗口级锚点（`stack_hud.rs::anchor_rect`）在最大化浏览器/表单里离真正的输入框
//! 可能有上千像素。这里用 UIA `GetFocusedElement`（现代 App）与
//! `GetGUIThreadInfo` caret（经典 Win32 Edit）拿到聚焦控件的屏幕矩形。
//!
//! ## 性能红线（规则 8）
//!
//! UIA 创建 COM 客户端 + 跨进程查询约 20–80ms，不能在热键路径上无缓存重复调用。
//! 同一前台窗口 **500ms** 内复用上次结果（含失败结果，失败也要缓存，否则会反复砸 UIA）。
//!
//! ## 正确性（规则 11）
//!
//! 控件矩形必须落在**粘贴引擎解析出的前台目标窗口**内（中心点在窗口内 + 不是整窗），
//! 否则会出现「浮标贴在 A 窗输入框、实际粘到 B 窗」。失败一律退回窗口锚，不猜。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::stack_hud_pos::control_rect_plausible;

/// 缓存有效期：同一前台窗口 500ms 内不重复问 UIA / GUIThreadInfo。
const CACHE_TTL: Duration = Duration::from_millis(500);

struct FocusCache {
    hwnd: isize,
    at: Instant,
    /// `None` = 上次探测失败（也要缓存，避免反复砸 UIA）
    rect: Option<(f64, f64, f64, f64)>,
}

static FOCUS_CACHE: Mutex<Option<FocusCache>> = Mutex::new(None);

/// 取前台目标窗口上的聚焦控件矩形（物理像素 `(x, y, w, h)`）。
///
/// 链：UIA focused element → GetGUIThreadInfo caret → None。
/// `hwnd` 必须已是 `capture_foreground_now` 过滤后的有效目标。
///
/// 走 500ms 缓存 —— 热键推送路径用这个。
pub fn focused_control_rect(hwnd: isize) -> Option<(f64, f64, f64, f64)> {
    focused_control_rect_inner(hwnd, false)
}

/// 绕过缓存强制重探 —— **只给跟随轮询用**。
///
/// 轮询要发现「用户 Tab 到了下一个输入框」，命中缓存等于永远看不见变化。
/// 热键路径仍走缓存，避免与轮询叠成双倍 UIA 查询。
pub fn focused_control_rect_fresh(hwnd: isize) -> Option<(f64, f64, f64, f64)> {
    focused_control_rect_inner(hwnd, true)
}

fn focused_control_rect_inner(hwnd: isize, force: bool) -> Option<(f64, f64, f64, f64)> {
    if !force {
        if let Ok(guard) = FOCUS_CACHE.lock() {
            if let Some(c) = guard.as_ref() {
                if c.hwnd == hwnd && c.at.elapsed() < CACHE_TTL {
                    return c.rect;
                }
            }
        }
    }

    let rect = probe(hwnd);

    if let Ok(mut guard) = FOCUS_CACHE.lock() {
        *guard = Some(FocusCache {
            hwnd,
            at: Instant::now(),
            rect,
        });
    }
    rect
}

/// 真正的系统探测（缓存未命中时调用）。
fn probe(hwnd: isize) -> Option<(f64, f64, f64, f64)> {
    #[cfg(target_os = "windows")]
    {
        let win = window_rect(hwnd)?;
        let raw = uia_focused_rect().or_else(|| caret_rect(hwnd))?;
        if !within_window(raw, win) || !control_rect_plausible(raw.2, raw.3, win.2, win.3) {
            return None;
        }
        Some(raw)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hwnd;
        None
    }
}

/// 控件矩形中心点是否落在目标窗口内（允许 2px 容差，覆盖 DPI 取整）。
#[cfg(target_os = "windows")]
fn within_window(ctrl: (f64, f64, f64, f64), win: (f64, f64, f64, f64)) -> bool {
    const TOL: f64 = 2.0;
    let (cx, cy) = (ctrl.0 + ctrl.2 / 2.0, ctrl.1 + ctrl.3 / 2.0);
    cx >= win.0 - TOL && cy >= win.1 - TOL && cx <= win.0 + win.2 + TOL && cy <= win.1 + win.3 + TOL
}

#[cfg(target_os = "windows")]
fn window_rect(hwnd: isize) -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let mut r = RECT::default();
    let ok = unsafe { GetWindowRect(HWND(hwnd as *mut _), &mut r).is_ok() };
    if !ok || r.right <= r.left || r.bottom <= r.top {
        return None;
    }
    Some((
        r.left as f64,
        r.top as f64,
        (r.right - r.left) as f64,
        (r.bottom - r.top) as f64,
    ))
}

/// COM 初始化 RAII —— 与 `screenshot.rs` 同一配方（只卸载本调用真正新初始化的公寓）。
#[cfg(target_os = "windows")]
struct ComInit;
#[cfg(target_os = "windows")]
impl ComInit {
    fn new() -> Option<Self> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.0 == 0 {
            Some(ComInit)
        } else {
            None
        }
    }
}
#[cfg(target_os = "windows")]
impl Drop for ComInit {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
}

/// UIA `GetFocusedElement` → 聚焦控件屏幕矩形。
///
/// 对 Chrome / Edge / VS Code / Electron / WPF / UWP 等现代宿主有效；
/// 失败返回 None，由 caret 路径接手。
#[cfg(target_os = "windows")]
fn uia_focused_rect() -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    let _com = ComInit::new()?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL) }.ok()?;
    let element = unsafe { automation.GetFocusedElement() }.ok()?;
    let r = unsafe { element.CurrentBoundingRectangle() }.ok()?;
    let w = (r.right - r.left) as f64;
    let h = (r.bottom - r.top) as f64;
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some((r.left as f64, r.top as f64, w, h))
}

/// 经典 Win32：`GetGUIThreadInfo` 的 caret（客户端坐标 → 屏幕物理坐标）。
///
/// caret 本身宽常为 0，这里撑到 2px 以便形成可锚定的矩形；高度取 `rcCaret`。
#[cfg(target_os = "windows")]
fn caret_rect(hwnd: isize) -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };

    let mut pid = 0u32;
    let tid = unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
    if tid == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(tid, &mut info) }.is_err() {
        return None;
    }
    let caret_hwnd = info.hwndCaret;
    if caret_hwnd.0.is_null() {
        return None;
    }
    let mut tl = POINT {
        x: info.rcCaret.left,
        y: info.rcCaret.top,
    };
    let mut br = POINT {
        x: info.rcCaret.right.max(info.rcCaret.left + 2),
        y: info.rcCaret.bottom.max(info.rcCaret.top + 1),
    };
    // ClientToScreen 在 windows 0.58 返回 BOOL，失败时坐标保持不变
    unsafe {
        let _ = ClientToScreen(caret_hwnd, &mut tl);
        let _ = ClientToScreen(caret_hwnd, &mut br);
    }
    let w = (br.x - tl.x) as f64;
    let h = (br.y - tl.y) as f64;
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some((tl.x as f64, tl.y as f64, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓存命中：同一 hwnd 且未过期时不再探测（用真实 probe 不可达，验证缓存结构语义）
    #[test]
    fn test_cache_ttl_semantics() {
        let hit = |at_elapsed: Duration| at_elapsed < CACHE_TTL;
        assert!(hit(Duration::from_millis(0)));
        assert!(hit(Duration::from_millis(499)));
        assert!(!hit(CACHE_TTL));
        assert!(!hit(Duration::from_millis(501)));
    }
}
