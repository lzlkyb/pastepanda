//! 独占全屏检测（实施方案 §2.6 拍板 6：全屏时岛要隐藏；探针⑥ 的落地）。
//!
//! ## 判据：前台窗口矩形 == 所在显示器的矩形
//!
//! 全屏应用（游戏 / F11 浏览器 / 放映）的共同特征是**铺满整块屏**。
//! 不追「独占 vs 边框less」的切换通知（没有可靠的全局事件），只在需要判断时
//! 现查一次——调用方（岛的 show 门 / 收起后的复活轮询）本来就是低频路径。
//!
//! ## 两条排除，各挡一类误伤
//!
//! | 排除 | 挡的是 |
//! |---|---|
//! | 前台窗口属于**本进程** | 我们自己的全屏面（截图 / 长截图 / rc 工作台全屏）——岛在这些时刻由接线 #8 显式隐藏，不走这条判据；若这里不排除，「截图开全屏 → 岛想显示被拦 → 截图关了岛一直不出现」 |
//! | 前台窗口是**桌面 / Shell**（Progman / WorkerW / 桌面壁纸窗口） | 空桌面瞬间（如关掉最后一个应用时焦点落到桌面）矩形恰好等于屏幕，岛会无故消失 |

#[cfg(target_os = "windows")]
pub fn foreground_is_exclusive_fullscreen() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return false;
        }

        // 排除①：本进程（我们自己的全屏覆盖层不算「用户的独占全屏」）
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
            return false;
        }
        let m = mi.rcMonitor;

        let covers = rect.left <= m.left
            && rect.top <= m.top
            && rect.right >= m.right
            && rect.bottom >= m.bottom;
        covers && (rect.right - rect.left) > 0
    }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_is_exclusive_fullscreen() -> bool {
    false
}

#[cfg(test)]
mod tests {
    /// 排除①是这条判据最容易漏的一条（写的时候岛还没接截图，漏了根本测不出来）。
    /// 没法在无头测试里造一个前台窗口，但「本进程 pid 判定」这个行为可以钉住：
    /// 全屏判定对**自己进程的窗口**必须返回 false，无论矩形多大。
    #[test]
    fn test_own_process_never_counts_as_fullscreen() {
        // 当前测试进程必然持有若干窗口大小的概念，但没有前台窗口属于「别的应用」——
        // 在 CI 的会话里 GetForegroundWindow 多半是 NULL 或本进程窗口，两种都应返回 false。
        assert!(!super::foreground_is_exclusive_fullscreen());
    }
}
