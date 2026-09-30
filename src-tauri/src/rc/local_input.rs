//! 本机**物理**键鼠的观察与拦截（乙-③，2026-09-30）。
//!
//! # 为什么是低层钩子（WH_KEYBOARD_LL / WH_MOUSE_LL）而不是 `BlockInput`
//!
//! `BlockInput` 是驱动级的一刀切：它把**所有**输入都堵掉，包括我们用
//! `SendInput` 注进来的那一路——锁上的瞬间远程操作也一起死了。
//! 低层钩子能看到 `LLKHF_INJECTED` / `LLMHF_INJECTED` 这个「是不是注入的」标志，
//! 于是能做到「只堵人手，不堵对方」，这正是 RustDesk block-input 的语义。
//!
//! # 三条不许越过的线
//!
//! 1. **投向我们自己窗口的输入永不吞**（鼠标按落点判、键盘按前台窗口判）。
//!    否则被控者连「解除锁定」那一下点击都点不到 = 把人锁在自己的机器外面。
//!    Ctrl+Alt+Del 本来就不经过低层钩子（SAS 走独立通道），是最后一道逃生门。
//! 2. **钩子只在会话期间存在**。低层钩子在输入路径上同步执行，常驻等于给
//!    全系统每一次键鼠事件加一次回调——没人远程的时候不该收这份钱。
//! 3. **只观察不吞的时候也要有活动戳**：抽屉上那枚「本机在用」和
//!    「10 分钟无操作自动归还」都读它，没有钩子就没有真相（不做猜测式兜底）。
//!
//! # 已知失效面（诚实申报，未实测）
//!
//! 前台是**以管理员权限运行**的应用时，非提权进程的钩子收不到事件（UIPI），
//! 锁定会静默失效。这条与远程注入本身同一处境（`injected_err` 的 UIPI 分支），
//! 不在本档解决；界面上不许宣称「已锁定＝对方一定动不了」。

/// 吞不吞这一次**物理**输入（纯函数，可离线单测）。
///
/// - `injected`：`LLKHF_INJECTED`/`LLMHF_INJECTED`——远程那一路注入的输入
///   **永远放行**，不然锁定会把发起端自己也锁在外面（按下键后对面毫无反应）。
/// - `aimed_at_own_ui`：事件落在本进程的窗口上（被控者的抽屉/横幅/主窗）。
///   放行是逃生门，见文件头第 1 条。
/// - `gate_on`：锁定开关。
pub fn should_swallow(injected: bool, aimed_at_own_ui: bool, gate_on: bool) -> bool {
    gate_on && !injected && !aimed_at_own_ui
}

/// 「暂时收回我的键鼠」的 10 分钟自动归还判据（纯函数，可离线单测）。
///
/// `last_local_ms == 0` = 钩子没见过任何本机输入（钩子没装上 / 刚装上）。
/// 这时**以收回时刻起算**：宁可早一点把控制权还给对方，也不能因为读不到活动
/// 而永远霸着——对方画面上的「主机正在自己操作」会变成假话。
pub fn hold_should_return(
    hold_since_ms: u64,
    last_local_ms: u64,
    now_ms: u64,
    limit_ms: u64,
) -> bool {
    let anchor = if last_local_ms > hold_since_ms {
        last_local_ms
    } else {
        hold_since_ms
    };
    now_ms.saturating_sub(anchor) >= limit_ms
}

/// 收回后多久无本机操作自动归还（乙-③ 拍板值：10 分钟）。
pub const HOLD_AUTO_RETURN_MS: u64 = 10 * 60 * 1000;

#[cfg(target_os = "windows")]
mod win {
    use super::should_swallow;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, GetForegroundWindow,
        GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, WindowFromPoint, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_QUIT, HHOOK,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT,
    };

    /// 钩子线程用的单调时钟（与 `service::now_ms` 同源，别在模块里再造第二把表）。
    fn now_u64() -> u64 {
        crate::rc::service::now_ms().max(0) as u64
    }

    /// 锁定开关（钩子回调拿不到任何上下文，只能读进程级原子量）。
    static SWALLOW: AtomicBool = AtomicBool::new(false);
    /// 最近一次**物理**输入的时刻（键盘/鼠标分开——抽屉上的两枚 pill 语义不同）。
    static LAST_KBD_MS: AtomicU64 = AtomicU64::new(0);
    static LAST_MOUSE_MS: AtomicU64 = AtomicU64::new(0);
    /// 钩子线程的 id：0 = 没在跑。装/拆都只认它（幂等）。
    static HOOK_THREAD_ID: AtomicUsize = AtomicUsize::new(0);

    /// 本进程拥有的窗口 = 逃生门（文件头第 1 条）。
    unsafe fn is_own_window(hwnd: HWND) -> bool {
        if hwnd.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(std::ptr::from_mut(&mut pid)));
        pid != 0 && pid == GetCurrentProcessId()
    }

    unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let injected = kb.flags.contains(LLKHF_INJECTED);
            if !injected {
                LAST_KBD_MS.store(now_u64(), Ordering::Relaxed);
                // 键盘没有「落点」，只能看前台窗口归属：焦点在我们窗上时
                // 被控者正在用我们的 UI（点解除、按 Esc），必须放行。
                if should_swallow(
                    false,
                    is_own_window(GetForegroundWindow()),
                    SWALLOW.load(Ordering::Relaxed),
                ) {
                    return LRESULT(1);
                }
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let injected = (ms.flags & LLMHF_INJECTED) != 0;
            if !injected {
                LAST_MOUSE_MS.store(now_u64(), Ordering::Relaxed);
                if should_swallow(
                    false,
                    is_own_window(WindowFromPoint(ms.pt)),
                    SWALLOW.load(Ordering::Relaxed),
                ) {
                    return LRESULT(1);
                }
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    /// 钩子线程主体：装两个低层钩子 + 消息泵（低层钩子必须有消息循环，
    /// 不泵消息的话系统会在超时后**静默摘掉钩子**，锁定就成了假锁）。
    unsafe fn hook_main() {
        HOOK_THREAD_ID.store(GetCurrentThreadId() as usize, Ordering::SeqCst);
        let hkbd = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), HINSTANCE::default(), 0);
        let hmouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE::default(), 0);
        if hkbd.is_err() && hmouse.is_err() {
            log::warn!("[RC] 本机输入钩子安装失败：锁定与「谁在动」指示不可用");
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            return;
        }
        let mut msg = MSG::default();
        // GetMessageW 返回 FALSE（0）既可能是 WM_QUIT 也可能是错误——两者都该收线程。
        while GetMessageW(std::ptr::from_mut(&mut msg), None, 0, 0).as_bool() {
            let _ = TranslateMessage(std::ptr::from_ref(&msg));
            let _ = DispatchMessageW(std::ptr::from_ref(&msg));
        }
        if let Ok(h) = hkbd {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Ok(h) = hmouse {
            let _ = UnhookWindowsHookEx(h);
        }
        HOOK_THREAD_ID.store(0, Ordering::SeqCst);
        log::debug!("[RC] 本机输入钩子线程已收");
    }

    /// 会话开始：装钩子（幂等）。非 Windows 目标是空实现。
    pub fn start_watching() {
        if HOOK_THREAD_ID.load(Ordering::SeqCst) != 0 {
            return;
        }
        // 钩子必须待在自己的线程里：tokio 的 worker 会被回收复用，
        // 线程一没消息泵钩子就被摘，std 线程才是对的载体。
        // JoinHandle 直接丢弃 = 分离线程（不是终止），会话结束时靠 WM_QUIT 收。
        let spawned = std::thread::Builder::new()
            .name("rc-local-input".into())
            .spawn(|| unsafe { hook_main() });
        if spawned.is_err() {
            log::warn!("[RC] 本机输入钩子线程起不来：锁定与「谁在动」指示不可用");
        }
    }

    /// 会话收口：摘钩子。锁定开关一并清掉——钩子没了还留着开关，
    /// 下一次会话会莫名其妙继续吞本机输入。
    pub fn stop_watching() {
        SWALLOW.store(false, Ordering::Relaxed);
        let tid = HOOK_THREAD_ID.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid as u32, WM_QUIT, WPARAM::default(), LPARAM::default());
            }
        }
    }

    /// 锁定开关。返回**改后**状态（读不回真值的那条链路宁可不显示断言）。
    pub fn set_swallow(on: bool) -> bool {
        SWALLOW.store(on, Ordering::SeqCst);
        on
    }

    pub fn is_locked() -> bool {
        SWALLOW.load(Ordering::Relaxed)
    }

    /// 最近一次物理键盘输入（ms，0 = 没见过）。
    pub fn last_kbd_ms() -> u64 {
        LAST_KBD_MS.load(Ordering::Relaxed)
    }

    /// 最近一次物理鼠标输入（ms，0 = 没见过）。
    pub fn last_mouse_ms() -> u64 {
        LAST_MOUSE_MS.load(Ordering::Relaxed)
    }

    /// 钩子是否活着（抽屉据此决定「读不到就说不清」而不是猜）。
    pub fn is_watching() -> bool {
        HOOK_THREAD_ID.load(Ordering::SeqCst) != 0
    }
}

#[cfg(not(target_os = "windows"))]
mod win {
    // 非 Windows 宿主没有注入链路，也就没有「要堵的那一路」：全部空实现。
    // `set_swallow` 恒返 false = 诚实回报「这台机器上锁不住」，不假装锁定成功。
    pub fn start_watching() {}
    pub fn stop_watching() {}
    pub fn set_swallow(_on: bool) -> bool {
        false
    }
    pub fn is_locked() -> bool {
        false
    }
    pub fn last_kbd_ms() -> u64 {
        0
    }
    pub fn last_mouse_ms() -> u64 {
        0
    }
    pub fn is_watching() -> bool {
        false
    }
}

pub use win::{
    is_locked, is_watching, last_kbd_ms, last_mouse_ms, set_swallow, start_watching, stop_watching,
};

#[cfg(test)]
mod tests {
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 注入的输入永不吞_关闸时永不吞() {
        assert!(should_swallow(false, false, true), "物理输入 + 未投向自己 + 开着闸 = 吞");
        assert!(
            !should_swallow(true, false, true),
            "远程注入那一路必须活着，否则锁定把发起端也锁外面了"
        );
        assert!(
            !should_swallow(false, true, true),
            "投向自己窗口的点击是逃生门，不许吞"
        );
        assert!(!should_swallow(false, false, false), "闸关着就什么都不吞");
    }

    #[test]
    fn 收回十分钟无操作才归还() {
        let t0 = 1_000_000u64;
        let lim = HOLD_AUTO_RETURN_MS;
        assert!(
            !hold_should_return(t0, 0, t0 + lim - 1, lim),
            "差一毫秒不还"
        );
        assert!(
            hold_should_return(t0, 0, t0 + lim, lim),
            "到点就还：读不到本机活动时以收回时刻起算"
        );
        // 本机一直在动 → 时钟跟着活动往后挪
        assert!(
            !hold_should_return(t0, t0 + lim - 1000, t0 + lim, lim),
            "刚动过键盘就不该还"
        );
        assert!(
            hold_should_return(t0, t0 + lim - 1000, t0 + 2 * lim, lim),
            "停下来够十分钟就必须还"
        );
        // 活动戳比收回时刻还老（上一场会话的残留）：按收回时刻算，不能被旧值续命
        assert!(hold_should_return(t0, t0 - 60_000, t0 + lim, lim));
    }
}
