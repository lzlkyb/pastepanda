//! 独占全屏检测（实施方案 §2.6 拍板 6：全屏时岛要隐藏；探针⑥ 的落地）。
//!
//! ## 判据：前台窗口矩形 == 所在显示器的矩形
//!
//! 全屏应用（游戏 / F11 浏览器 / 放映）的共同特征是**铺满整块屏**。
//! 不追「独占 vs 边框less」的切换通知（没有可靠的全局事件），只在需要判断时
//! 现查一次——调用方（岛的 show 门 / 收起后的复活轮询）本来就是低频路径。
//!
//! ## 三条排除，各挡一类误伤
//!
//! | 排除 | 挡的是 |
//! |---|---|
//! | 前台窗口属于**本进程** | 我们自己的全屏面（截图 / 长截图 / rc 工作台全屏）——岛在这些时刻由接线 #8 显式隐藏，不走这条判据；若这里不排除，「截图开全屏 → 岛想显示被拦 → 截图关了岛一直不出现」 |
//! | 前台窗口是**桌面 / Shell**（Progman / WorkerW） | 空桌面瞬间（如关掉最后一个应用时焦点落到桌面）矩形恰好等于屏幕，岛会无故消失 |
//! | 前台窗口矩形**大小为零** | 正在销毁 / 尚未布局的窗口，防御性判据 |
//!
//! ## 判据本体与 Win32 取值是分开的
//!
//! [`is_exclusive_fullscreen`] 是纯函数，[`foreground_is_exclusive_fullscreen`] 只负责
//! 把 Win32 那句 `GetForegroundWindow` 的结果喂给它。分开的原因是**测试进程控制不了
//! 当前前台窗口**：跑测试时前台可能是 IDE、浏览器，或锁屏的 `LockApp.exe`（矩形恰好
//! 铺满屏幕）。旧版把断言直接写在真实函数上，于是机器一锁屏用例就红——断的其实是
//! 「环境恰好不满足」，不是它声称的那条不变量。抽纯函数后三条排除各自可钉。
//! 同类先例：`paste_target::is_shell_target_class`（同一条理由）。

/// 桌面 / 壁纸层窗口类名（排除②）。
///
/// 只含桌面，**不含任务栏** —— 点任务栏时 `Shell_TrayWnd` 的矩形是任务栏那条，
/// 本来就铺不满屏，矩形判据会自然否掉，不需要专门列一份。
/// （这与 `paste_target::SHELL_TARGET_CLASSES` 刻意不同：那边任务栏必须显式排除，
/// 判据方向相反，理由见那边的模块注释。）
pub const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW"];

/// 判据本体：给定前台窗口的归属、类名与两个矩形，是否算「独占全屏」。
///
/// `window` / `monitor` 都是 `(left, top, right, bottom)`（逻辑 px）。
/// 用四元组而不是 `RECT`，是为了让单测能脱离 Win32 构造。
pub fn is_exclusive_fullscreen(
    foreground_pid: u32,
    own_pid: u32,
    class_name: &str,
    window: (i32, i32, i32, i32),
    monitor: (i32, i32, i32, i32),
) -> bool {
    if foreground_pid == own_pid || SHELL_CLASSES.contains(&class_name) {
        return false;
    }
    let (l, t, r, b) = window;
    let (ml, mt, mr, mb) = monitor;
    let covers = l <= ml && t <= mt && r >= mr && b >= mb;
    covers && (r - l) > 0
}

/// 当前前台窗口是否独占全屏。低频路径，调用方现查即可。
#[cfg(target_os = "windows")]
pub fn foreground_is_exclusive_fullscreen() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return false;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        // 排除②用类名判。取不到类名（多半是窗口正在销毁）时**不**走排除，
        // 与模块其余失败分支的取向一致：宁可多判一次全屏，也别把正常窗口排除掉。
        let mut cls = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut cls);
        let class_name = if n > 0 {
            String::from_utf16_lossy(&cls[..n as usize])
        } else {
            String::new()
        };

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

        is_exclusive_fullscreen(
            pid,
            std::process::id(),
            &class_name,
            (rect.left, rect.top, rect.right, rect.bottom),
            (
                mi.rcMonitor.left,
                mi.rcMonitor.top,
                mi.rcMonitor.right,
                mi.rcMonitor.bottom,
            ),
        )
    }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_is_exclusive_fullscreen() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 铺满整块主屏的窗口矩形（无边框全屏的典型形状）。
    const COVERS: (i32, i32, i32, i32) = (0, 0, 1920, 1080);
    const MONITOR: (i32, i32, i32, i32) = (0, 0, 1920, 1080);
    /// 假的「别的进程」与「本进程」。
    const OTHER: u32 = 4321;
    const OWN: u32 = 1;

    /// 排除①：本进程的窗口，无论矩形多大都不算独占全屏。
    /// 漏了它就会出现「截图开全屏 → 岛被拦 → 截图关了岛一直不出现」。
    #[test]
    fn test_own_process_never_counts_as_fullscreen() {
        assert!(
            !is_exclusive_fullscreen(OWN, OWN, "Notepad", COVERS, MONITOR),
            "自己进程铺满屏幕也不算全屏"
        );
    }

    /// 排除②：桌面 / 壁纸层铺满屏幕也不算 —— 空桌面瞬间焦点落到桌面
    /// （用户按 Win+D、或关掉最后一个应用），岛不该无故消失。
    ///
    /// ❗ 类名在这里**逐字写死**，不从 `SHELL_CLASSES` 遍历过来。拿被测常量当输入
    /// 是自证：实测把 `SHELL_CLASSES` 清成 `&[]` 时，遍历写法照样 8/8 全绿。
    #[test]
    fn test_shell_classes_never_count_as_fullscreen() {
        for name in ["Progman", "WorkerW"] {
            assert!(
                !is_exclusive_fullscreen(OTHER, OWN, name, COVERS, MONITOR),
                "外壳窗口 {name} 不能算独占全屏"
            );
        }
    }

    /// 正例：别的进程 + 铺满整块屏 ⇒ 是全屏。
    #[test]
    fn test_other_process_covering_monitor_counts_as_fullscreen() {
        assert!(is_exclusive_fullscreen(OTHER, OWN, "Notepad", COVERS, MONITOR));
    }

    /// 「窗口很大」不够，四条边**各自**都要覆盖到（差 1px 都不算）。
    #[test]
    fn test_each_edge_must_cover() {
        let cases: [((i32, i32, i32, i32), &str); 4] = [
            ((1, 0, 1920, 1080), "左边差 1px"),
            ((0, 1, 1920, 1080), "上边差 1px"),
            ((0, 0, 1919, 1080), "右边差 1px"),
            ((0, 0, 1920, 1079), "下边差 1px"),
        ];
        for (rect, why) in cases {
            assert!(
                !is_exclusive_fullscreen(OTHER, OWN, "Notepad", rect, MONITOR),
                "{why}：{rect:?} 不该算全屏"
            );
        }
    }

    /// 比屏幕大（无边框全屏常见的 overscan，或跨屏拉伸）仍算全屏 ——
    /// 判据是「覆盖」不是「相等」。
    #[test]
    fn test_oversized_window_counts() {
        assert!(is_exclusive_fullscreen(
            OTHER,
            OWN,
            "Notepad",
            (-8, -8, 1928, 1088),
            MONITOR
        ));
    }

    /// 显示器原点不在 (0,0)（副屏在主屏右侧 / 上方）时，比较的是**该窗口所在那块屏**，
    /// 不能按「屏幕从 0,0 开始」写死。
    #[test]
    fn test_secondary_monitor_with_offset_origin() {
        let second: (i32, i32, i32, i32) = (1920, -200, 3840, 880);
        assert!(is_exclusive_fullscreen(OTHER, OWN, "Notepad", second, second));
        // 同一块屏上少覆盖一条边
        assert!(!is_exclusive_fullscreen(
            OTHER,
            OWN,
            "Notepad",
            (1920, -200, 3839, 880),
            second
        ));
        // 主屏的矩形拿副屏的矩形去比 —— 不该算（防「忘了传窗口所在那块屏」）
        assert!(!is_exclusive_fullscreen(OTHER, OWN, "Notepad", COVERS, second));
    }

    /// 防御性判据：零宽矩形（窗口正在销毁 / 尚未布局）不算全屏。
    #[test]
    fn test_zero_size_window_does_not_count() {
        assert!(!is_exclusive_fullscreen(
            OTHER,
            OWN,
            "Notepad",
            (0, 0, 0, 0),
            (0, 0, 0, 0)
        ));
    }

    /// 空类名（取不到类名）不应被当成外壳窗口 —— 排除②只在有类名时生效。
    #[test]
    fn test_empty_class_name_is_not_shell() {
        assert!(is_exclusive_fullscreen(OTHER, OWN, "", COVERS, MONITOR));
    }

    // ❗ 真实函数 `foreground_is_exclusive_fullscreen` 没有单测，是**有意**的：
    //    它读的是「当前」前台窗口，而测试进程控制不了那是谁（IDE / 浏览器 /
    //    锁屏的 LockApp.exe）。对它下任何断言都是在断环境，不是在断代码。
    //    它的全部逻辑已由上面这些用例覆盖，剩下的只有「取值 → 喂参数」这层接线，
    //    而参数顺序在类型上是可读的（两个四元组 + 两个 pid）。
}
