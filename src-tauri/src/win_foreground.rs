//! Windows 前台窗口抢夺（Ditto 配方）。
//!
//! **为什么需要它**：Windows 有"前台锁定超时"机制 —— 非前台进程调用
//! `SetForegroundWindow` 会**静默失败**（返回 false 但不报错）。表现是窗口
//! `show()` 出来了、看得见，却拿不到键盘焦点——用户按的键全发给了之前的前台窗口。
//!
//! 长截图就踩了这个坑：期间往目标窗口注入滚轮把它激活了，结束后
//! `show()` + `set_focus()` 恢复截图窗，但 `set_focus` 被前台锁定拒绝，
//! 于是"窗口回来了但 Esc 失灵"，用户退不出截图。
//!
//! ⚠️ `paste_engine.rs` 的 `restore_and_send_ctrl_v` 里有一份同源实现（写得更早，
//! 还耦合了最小化恢复与按键投递，属于核心粘贴路径）。本次不动它是为了不把
//! 截图的修复风险扩到粘贴引擎上；下次改那块时应收口到这里（规则 11.1）。

/// 把指定窗口抢到前台并拿到键盘焦点。返回是否**实际确认**成为前台。
///
/// 不看 `SetForegroundWindow` 的返回值（它不可靠），而是轮询 `GetForegroundWindow`
/// 实际确认。整个过程有 500ms 硬超时，抢不到就返回 false，绝不死循环。
#[cfg(target_os = "windows")]
pub fn force_foreground(hwnd_raw: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsWindow,
        SetForegroundWindow, SystemParametersInfoW, SPI_GETFOREGROUNDLOCKTIMEOUT,
        SPI_SETFOREGROUNDLOCKTIMEOUT, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        if !IsWindow(hwnd).as_bool() {
            return false;
        }
        // 已经是前台就不折腾
        if GetForegroundWindow() == hwnd {
            return true;
        }

        // 1) 临时关闭"前台锁定超时"：置 0 让 SetForegroundWindow 稳定成功，结束后恢复原值。
        let mut lock_timeout: u32 = 0;
        let got_timeout = SystemParametersInfoW(
            SPI_GETFOREGROUNDLOCKTIMEOUT,
            0,
            Some(&mut lock_timeout as *mut u32 as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok();
        let _ = SystemParametersInfoW(
            SPI_SETFOREGROUNDLOCKTIMEOUT,
            0,
            None,
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );

        // 2) 把本线程输入队列挂到"当前前台窗口"所在线程，获得设置前台的权限。
        let cur_tid = GetCurrentThreadId();
        let fore_tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let attached =
            fore_tid != 0 && fore_tid != cur_tid && AttachThreadInput(cur_tid, fore_tid, true).as_bool();

        // 3) 循环激活并确认。SetForegroundWindow 的返回值不可靠，一律以
        //    GetForegroundWindow 的实测结果为准。
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let mut confirmed = false;
        while std::time::Instant::now() < deadline {
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            for _ in 0..3 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                if GetForegroundWindow() == hwnd {
                    confirmed = true;
                    break;
                }
            }
            if confirmed {
                break;
            }
        }

        // 4) 无论成败都要恢复前台锁定超时 & 解除线程输入挂接。
        if got_timeout {
            let _ = SystemParametersInfoW(
                SPI_SETFOREGROUNDLOCKTIMEOUT,
                0,
                Some(lock_timeout as usize as *mut core::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            );
        }
        if attached {
            let _ = AttachThreadInput(cur_tid, fore_tid, false);
        }

        confirmed
    }
}

#[cfg(not(target_os = "windows"))]
pub fn force_foreground(_hwnd_raw: isize) -> bool {
    false
}
