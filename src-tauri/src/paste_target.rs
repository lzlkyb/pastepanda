//! 粘贴目标窗口判据的唯一实现。
//!
//! ## 为什么单独成文件
//!
//! 「这个 hwnd 能不能当粘贴目标」这条判据在 `paste_engine.rs` 里曾有两份**不一致**的
//! 实现：`save_foreground_hwnd` 排除了桌面（`GetDesktopWindow` / `GetShellWindow`），
//! 而 `capture_foreground_now` **只排除自身进程**。同一条链路上两处判据不一致的直接
//! 后果是：「实时抓取」这条路径会把桌面 / 任务栏当成有效目标；投递到桌面时
//! `SetForegroundWindow` 会成功（前台本来就是桌面）→ `confirmed` 成立 → 返回 success
//! → 前端把栈顶**永久出队**，而用户什么都没粘到。
//!
//! 判据收口后，`save_foreground_hwnd` 与 `capture_foreground_now` 都走
//! [`is_valid_target`]，不再可能各自漂移。
//!
//! ## 与 `screenshot.rs` 里那份的关系（刻意不合并）
//!
//! `screenshot.rs` 也有一组外壳窗口类名表（`SHELL_CLASSES` / `is_tray_class`，
//! 见 `screenshot.rs:1921-1943`），但那是**截图吸附命中**语义：任务栏在那里被刻意
//! 留作"可被吸附的普通窗口"，而这里要求任务栏必须**排除**（按键投给任务栏等于丢弃）。
//! 两者判据方向相反，是两套不同的业务规则，合并只会把一方的语义强加给另一方。
//! 这份注释是给下一个想合并它们的人看的。

/// 永远不能作为粘贴目标的外壳窗口类名。
///
/// - `Progman` / `WorkerW`：桌面与壁纸层（用户按 Win+D 或点击桌面空白时前台是它们）
/// - `Shell_TrayWnd` / `Shell_SecondaryTrayWnd`：主 / 副屏任务栏（用户点任务栏空白处）
///
/// 这份表与 `screenshot.rs` 的 `SHELL_CLASSES` **不是**同一份，理由见模块注释。
pub const SHELL_TARGET_CLASSES: &[&str] = &[
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
];

/// 纯函数判据：类名是否属于「不能当粘贴目标」的外壳窗口。
///
/// 抽成纯函数是为了能脱离 Win32 单测——`is_valid_target` 本身需要真实窗口句柄，
/// 在 CI 上跑不了，而这条**恰好是最容易写反**的部分（历史上就写反过）。
pub fn is_shell_target_class(name: &str) -> bool {
    SHELL_TARGET_CLASSES.contains(&name)
}

/// 这个窗口句柄能否作为粘贴目标。
///
/// 四项判据，任一不满足即拒绝：
/// 1. 句柄非空且 `IsWindow` 为真（窗口还活着）
/// 2. 不是 `GetDesktopWindow()` / `GetShellWindow()` 返回的桌面与外壳句柄
/// 3. 类名不属于 [`SHELL_TARGET_CLASSES`]（桌面 / 任务栏）
/// 4. 不属于本进程（自己的窗口不能当自己的粘贴目标）
///
/// `own_pid` 传本进程 id（`PasteEngine` 在构造时缓存了它）。
#[cfg(target_os = "windows")]
pub fn is_valid_target(hwnd: isize, own_pid: u32) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetDesktopWindow, GetShellWindow, GetWindowThreadProcessId, IsWindow,
    };

    if hwnd == 0 {
        return false;
    }
    let h = HWND(hwnd as *mut _);
    unsafe {
        if !IsWindow(h).as_bool() {
            return false;
        }
        if h == GetDesktopWindow() || h == GetShellWindow() {
            return false;
        }
        // 类名判据。取不到类名时不额外拒绝：`IsWindow` 已经过了，而取不到类名
        // 通常意味着窗口正在销毁——此时误拒会阻塞一次本可以成功的粘贴，
        // 而桌面/任务栏这类必须拦的目标，类名一定取得回来。
        let mut cls = [0u16; 128];
        let n = GetClassNameW(h, &mut cls);
        if n > 0 {
            let name = String::from_utf16_lossy(&cls[..n as usize]);
            if is_shell_target_class(&name) {
                return false;
            }
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == own_pid {
            return false;
        }
        true
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_valid_target(_hwnd: isize, _own_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四种外壳窗口必须被拦。少拦一个就会重演「提示已粘贴、实际啥也没有」。
    #[test]
    fn test_shell_target_classes_blocked() {
        for name in [
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
        ] {
            assert!(is_shell_target_class(name), "外壳窗口 {} 必须被拦截", name);
        }
    }

    /// 普通应用窗口不能被误拦——误拦会让粘贴直接失败。
    #[test]
    fn test_normal_windows_not_blocked() {
        for name in [
            "Chrome_WidgetWin_1",
            "Notepad",
            "ApplicationFrameWindow",
            "ConsoleWindowClass",
            "Windows.UI.Core.CoreWindow",
            "XamlExplorerHostIslandWindow",
        ] {
            assert!(
                !is_shell_target_class(name),
                "普通窗口 {} 不该被当作外壳窗口拦截",
                name
            );
        }
    }

    /// 空类名（`GetClassNameW` 失败）不能被当成外壳窗口。
    #[test]
    fn test_empty_class_not_blocked() {
        assert!(!is_shell_target_class(""));
    }

    /// 与 `screenshot.rs` 的吸附语义必须不同：任务栏在那里是「可吸附的普通窗口」，
    /// 在这里必须被拒绝。这条测的就是「有人想合并两份判据」这一动作。
    #[test]
    fn test_tray_differs_from_screenshot_snap_semantics() {
        assert!(
            is_shell_target_class("Shell_TrayWnd"),
            "粘贴目标判据必须拒绝任务栏（与截图吸附的语义刻意相反）"
        );
    }
}
