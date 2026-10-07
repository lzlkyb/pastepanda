//! 录屏事件钩子（四期 1.3）——WH_MOUSE_LL / WH_KEYBOARD_LL 绑定录制会话生命周期。
//!
//! # 隐私红线
//!
//! 键盘只记**修饰键组合 + 命名键**（Ctrl+C / Enter / Esc）；普通字符键、OEM
//! 标点、IME 输入一律不进事件流——`classify_key` 是唯一闸口（纯函数，有守卫
//! 单测钉住「裸字母/数字/标点必须返回 None」）。钩子只在录制会话存活期间安装
//! （`start_hooks` 返回的 guard Drop 即卸载），平时零钩子。
//!
//! # 性能纪律（规则 8）
//!
//! LL 钩子回调跑在系统输入路径上，必须快：回调里只做查表 + `try_send`
//! （通道满即丢弃，绝不阻塞、不分配大对象、不碰 IO）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HHOOK, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN,
};

/// 录制期事件（坐标 = 桌面绝对物理像素，与 DXGI 指针 `PtrMeta` 同参照系）。
#[derive(Debug, Clone)]
pub enum RecEvent {
    Click { x: i32, y: i32, button: MouseBtn },
    Key { combo: String },
    Mark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseBtn {
    Left,
    Right,
    Middle,
}

impl MouseBtn {
    pub fn as_str(self) -> &'static str {
        match self {
            MouseBtn::Left => "left",
            MouseBtn::Right => "right",
            MouseBtn::Middle => "middle",
        }
    }
}

// ── 纯函数：连击去重 / 按键分类（无环境，可单测）────────────────────────

/// 连击去重（规格 §1.3）：同一坐标 80ms 内的点击合并为一次。
#[derive(Default)]
pub struct ClickDedup {
    last: Option<(i32, i32, u64)>,
}

const DEDUP_MS: u64 = 80;

impl ClickDedup {
    /// true = 应发出（非连击）；false = 80ms 内同坐标，吞掉。
    pub fn allow(&mut self, x: i32, y: i32, now_ms: u64) -> bool {
        match self.last {
            Some((lx, ly, lt)) if lx == x && ly == y && now_ms.saturating_sub(lt) < DEDUP_MS => {
                false
            }
            _ => {
                self.last = Some((x, y, now_ms));
                true
            }
        }
    }
}

/// 修饰键快照（回调时经 `GetAsyncKeyState` 采样，避免 LL 事件漏 UP 导致粘键）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
}

impl Mods {
    /// 组合前缀，规范序 Ctrl+Shift+Alt+Win+（与全站热键书写一致）；空 = ""。
    pub fn prefix(&self) -> String {
        let mut s = String::new();
        if self.ctrl {
            s.push_str("Ctrl+");
        }
        if self.shift {
            s.push_str("Shift+");
        }
        if self.alt {
            s.push_str("Alt+");
        }
        if self.win {
            s.push_str("Win+");
        }
        s
    }
}

/// 命名键表：**只有这张表里的键**（及其带修饰组合）会进事件流。
/// 字母/数字算「命名键」是为了 Ctrl+C / Ctrl+1 这类组合；裸字符在
/// [`classify_key`] 里按隐私策略拦掉。
fn named_key(vk: u32) -> Option<&'static str> {
    if let Some(i) = (vk as usize).checked_sub(0x30).filter(|&i| i < 10) {
        return DIGITS.get(i).copied();
    }
    if let Some(i) = (vk as usize).checked_sub(0x41).filter(|&i| i < 26) {
        return LETTERS.get(i).copied();
    }
    if let Some(i) = (vk as usize).checked_sub(0x60).filter(|&i| i < 10) {
        return NUMPAD.get(i).copied();
    }
    if let Some(i) = (vk as usize).checked_sub(0x70).filter(|&i| i < 24) {
        return FNKEYS.get(i).copied();
    }
    Some(match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x13 => "Pause",
        0x14 => "CapsLock",
        0x1B => "Esc",
        0x20 => "Space",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "←",
        0x26 => "↑",
        0x27 => "→",
        0x28 => "↓",
        0x2C => "PrintScreen",
        0x2D => "Insert",
        0x2E => "Delete",
        _ => return None,
    })
}

static DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
static LETTERS: [&str; 26] = [
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S",
    "T", "U", "V", "W", "X", "Y", "Z",
];
static NUMPAD: [&str; 10] = ["Num0", "Num1", "Num2", "Num3", "Num4", "Num5", "Num6", "Num7", "Num8", "Num9"];
static FNKEYS: [&str; 24] = [
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15",
    "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
];

/// 按键分类（隐私唯一闸口）：None = 不记录。
/// - 修饰键本身 → None（不记「按下了 Ctrl」）
/// - 裸字母/数字 → None（防隐私泄露，规格红线）
/// - 命名键 → Some("Enter" / "Ctrl+Enter"，前缀规范序）
/// - 其余（OEM 标点/IME）→ None（v1 范围外，sidecar note 注明）
pub fn classify_key(vk: u32, m: Mods) -> Option<String> {
    match vk {
        // 修饰键自身：永远不记
        0x10 | 0x11 | 0x12 | 0x14 | 0x5B | 0x5C | 0xA0..=0xA5 => None,
        // 裸字符键：无修饰不记（隐私红线）
        0x30..=0x39 | 0x41..=0x5A if !m.ctrl && !m.alt && !m.win => None,
        _ => {
            let name = named_key(vk)?;
            Some(format!("{}{}", m.prefix(), name))
        }
    }
}

// ── 钩子线程 ────────────────────────────────────────────────────────────

/// 事件通道（会话 → 主循环）。满即丢（try_send），事件是尽力而为的元数据。
pub fn send_event(tx: &SyncSender<RecEvent>, ev: RecEvent) {
    if let Err(TrySendError::Disconnected(_)) = tx.try_send(ev) {
        // 会话已收尾：静默（钩子 guard 马上要卸了）
    }
}

static HOOK_TX: Mutex<Option<SyncSender<RecEvent>>> = Mutex::new(None);
// HHOOK 是 *mut c_void 包装、非线程安全标记——静态里存裸指针值，卸载时还原
static HOOK_MOUSE: Mutex<Option<isize>> = Mutex::new(None);
static HOOK_KBD: Mutex<Option<isize>> = Mutex::new(None);
static DEDUP: Mutex<ClickDedup> = Mutex::new(ClickDedup { last: None });
static T0: OnceLock<Instant> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code as u32 == HC_ACTION && RUNNING.load(Ordering::Relaxed) {
        let msg = wparam.0 as u32;
        let btn = match msg {
            WM_LBUTTONDOWN => Some(MouseBtn::Left),
            WM_RBUTTONDOWN => Some(MouseBtn::Right),
            WM_MBUTTONDOWN => Some(MouseBtn::Middle),
            // X 鼠标侧键不记（前进/后退是导航噪音）
            _ => None,
        };
        if let Some(button) = btn {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let (x, y) = (info.pt.x, info.pt.y);
            let mut d = DEDUP.lock().unwrap_or_else(|p| p.into_inner());
            if d.allow(x, y, now_ms()) {
                if let Some(tx) = HOOK_TX.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                    send_event(tx, RecEvent::Click { x, y, button });
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code as u32 == HC_ACTION && RUNNING.load(Ordering::Relaxed) {
        let msg = wparam.0 as u32;
        let down = matches!(msg, WM_KEYDOWN | WM_SYSKEYDOWN);
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = info.vkCode;
        // 修饰键状态在回调里现采样（GetAsyncKeyState）：LL 流偶尔丢 UP 事件
        // 也不会粘键；一个 GetAsyncKeyState ~百 ns，输入路径无感。
        let m = Mods {
            ctrl: async_down(0x11),
            shift: async_down(0x10),
            alt: async_down(0x12),
            win: async_down(0x5B) || async_down(0x5C),
        };
        // 按下沿才记（UP 不产生事件）；修饰键/裸字符由 classify_key 拦
        if down {
            if let Some(combo) = classify_key(vk, m) {
                if let Some(tx) = HOOK_TX.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                    send_event(tx, RecEvent::Key { combo });
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn async_down(vk: i32) -> bool {
    (unsafe { GetAsyncKeyState(vk) } as u16) & 0x8000 != 0
}

/// 钩子 guard：Drop = 停泵、卸钩、收线程。会话线程栈上持有即可。
pub struct EventHooks {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl Drop for EventHooks {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Relaxed);
        // WM_QUIT 投到钩子线程的消息队列，GetMessageW 返回 0 退出循环
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
        *HOOK_TX.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// 安装鼠标 + 键盘 LL 钩子并起泵线程。失败（权限/环境）降级为无钩子，
/// 只影响高亮与 sidecar，不影响录制本体。
pub fn start_hooks(tx: SyncSender<RecEvent>) -> EventHooks {
    *HOOK_TX.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    RUNNING.store(true, Ordering::Relaxed);
    T0.get_or_init(Instant::now);
    *DEDUP.lock().unwrap_or_else(|p| p.into_inner()) = ClickDedup { last: None };

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<(u32, Result<(), String>)>();
    let join = std::thread::Builder::new()
        .name("rec-hooks".into())
        .spawn(move || unsafe {
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE::default(), 0)
                .map_err(|e| format!("鼠标钩子：{e}"));
            let kbd = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), HINSTANCE::default(), 0)
                .map_err(|e| format!("键盘钩子：{e}"));
            let tid = windows::Win32::System::Threading::GetCurrentThreadId();
            let _ = ready_tx.send((
                tid,
                match (&mouse, &kbd) {
                    (Err(e), _) | (_, Err(e)) => Err(e.clone()),
                    _ => Ok(()),
                },
            ));
            if let Ok(h) = mouse {
                *HOOK_MOUSE.lock().unwrap_or_else(|p| p.into_inner()) = Some(h.0 as isize);
            }
            if let Ok(h) = kbd {
                *HOOK_KBD.lock().unwrap_or_else(|p| p.into_inner()) = Some(h.0 as isize);
            }
            // 消息泵：LL 钩子回调依赖本线程泵消息；WM_QUIT 到达（GetMessageW
            // 返回 0）即退——guard Drop 先置 RUNNING=false 再投 WM_QUIT，
            // PostThreadMessage 丢失时 RUNNING 检查兜底。
            let mut msg = MSG::default();
            loop {
                if !RUNNING.load(Ordering::Relaxed) {
                    break;
                }
                let got = GetMessageW(&mut msg, windows::Win32::Foundation::HWND::default(), 0, 0);
                if got.0 <= 0 {
                    break; // WM_QUIT / 错误
                }
                let _ = DispatchMessageW(&msg);
            }
            if let Some(h) = HOOK_MOUSE.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = UnhookWindowsHookEx(HHOOK(h as *mut core::ffi::c_void));
            }
            if let Some(h) = HOOK_KBD.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = UnhookWindowsHookEx(HHOOK(h as *mut core::ffi::c_void));
            }
        })
        .map_err(|e| log::warn!("[Rec] 钩子线程启动失败：{e}"))
        .ok();

    // 等钩子线程报告（至多 2s），失败只记日志
    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok((tid, Ok(()))) => {
            log::info!("[Rec] 录制事件钩子已安装（鼠标+键盘，仅会话存活期）");
            EventHooks { thread_id: tid, join }
        }
        Ok((tid, Err(e))) => {
            log::warn!("[Rec] 事件钩子安装失败（高亮/sidecar 将无数据）：{e}");
            EventHooks { thread_id: tid, join }
        }
        Err(_) => {
            log::warn!("[Rec] 钩子线程未在 2s 内就绪");
            EventHooks { thread_id: 0, join }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 连击去重_同坐标80ms内合并() {
        let mut d = ClickDedup::default();
        assert!(d.allow(100, 200, 0));
        assert!(!d.allow(100, 200, 79), "80ms 内同坐标合并");
        assert!(d.allow(100, 200, 80), "到 80ms 放行");
        assert!(d.allow(100, 201, 10), "坐标不同不合并");
    }

    #[test]
    fn 按键分类_裸字符不记_组合与命名键记() {
        let none = Mods::default();
        let ctrl = Mods { ctrl: true, ..Default::default() };
        let ctrl_shift = Mods { ctrl: true, shift: true, ..Default::default() };
        assert_eq!(classify_key(0x43, none), None, "裸 C 不记（隐私红线）");
        assert_eq!(classify_key(0x31, none), None, "裸 1 不记");
        assert_eq!(classify_key(0xBA, none), None, "OEM 标点不记");
        assert_eq!(classify_key(0x43, ctrl).as_deref(), Some("Ctrl+C"));
        assert_eq!(classify_key(0x43, ctrl_shift).as_deref(), Some("Ctrl+Shift+C"));
        assert_eq!(classify_key(0x0D, none).as_deref(), Some("Enter"));
        assert_eq!(classify_key(0x1B, none).as_deref(), Some("Esc"));
        assert_eq!(classify_key(0x0D, ctrl).as_deref(), Some("Ctrl+Enter"));
        assert_eq!(classify_key(0x70, none).as_deref(), Some("F1"));
        assert_eq!(classify_key(0x64, none).as_deref(), Some("Num4"));
        assert_eq!(classify_key(0xA2, ctrl), None, "修饰键本身不记");
        assert_eq!(classify_key(0x11, none), None, "VK_CONTROL 不记");
    }

    #[test]
    fn 组合前缀规范序() {
        let m = Mods { ctrl: true, shift: true, alt: true, win: true };
        assert_eq!(m.prefix(), "Ctrl+Shift+Alt+Win+");
        assert_eq!(Mods::default().prefix(), "");
    }
}
