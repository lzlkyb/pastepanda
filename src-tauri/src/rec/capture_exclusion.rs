//! 录屏浮层的捕获排除（Windows）。
//!
//! ## 为什么需要两条通道
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 是首选：DWM 在捕获渲染通道里
//! 整个跳过该窗口。但它在某些窗口形态上会返回**误导性错误码**
//! `ERROR_NOT_ENOUGH_MEMORY (0x80070008)`——与内存无关，真实含义是「窗口不满足排除前提」：
//! ① `WS_EX_LAYERED` 窗口在 `SetLayeredWindowAttributes` 之前调用（分层属性未就位）；
//! ② 窗口刚 `show()`、DWM 侧的重定向表面还没建立；
//! ③ WebView2 承载的窗口（本项目 2026-10-18 实录：exstyle=0x08040118 连续 8 次重试均失败）。
//! 对 ①② 靠「补 layered 属性 + 有限重试」处理；对 ③ 需要另一条通道。
//!
//! 备用通道是微软文档化的 `WCA_EXCLUDED_FROM_DDA`（`SetWindowCompositionAttribute`
//! 的 attrib **24**，Win10 1709+）：它只把窗口从 **Desktop Duplication API** 的捕获里剔除，
//! 不经过 DWM 重定向位图，因此不受上面三个前提限制。本产品的录屏正是 DXGI Desktop
//! Duplication（`Cargo.toml`: "R4：DXGI Desktop Duplication + D3D11 抓帧"），所以这条
//! 降级通道对本产品**等价可用**——只是不再顺带挡住 OBS / 截图工具。
use tauri::WebviewWindow;
use windows::core::{s, w};
use windows::Win32::{
    Foundation::{BOOL, COLORREF, HWND},
    Graphics::Dwm::DwmFlush,
    System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
    UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, GetWindowLongPtrW, SetLayeredWindowAttributes,
        SetWindowDisplayAffinity, GWL_EXSTYLE, LWA_ALPHA, WDA_EXCLUDEFROMCAPTURE, WS_EX_LAYERED,
    },
};

/// 首次失败后的重试次数与间隔：DWM 建立重定向表面通常 1～2 帧内完成。
const RETRIES: u32 = 8;
const RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// `WINDOWCOMPOSITIONATTRIB::WCA_EXCLUDED_FROM_DDA`（未进 win32 元数据，按文档值硬编码）。
const WCA_EXCLUDED_FROM_DDA: u32 = 24;

/// 实际生效的排除通道 —— 决定要不要给用户报警。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Excluded {
    /// `WDA_EXCLUDEFROMCAPTURE`：对 DDA / WGC / BitBlt / PrintWindow 全通道生效。
    Capture,
    /// 仅 `WCA_EXCLUDED_FROM_DDA`：只对 Desktop Duplication（本产品的抓屏路径）生效。
    DdaOnly,
}

pub(super) fn protect(window: &WebviewWindow) -> Result<Excluded, String> {
    let raw = window.hwnd().map_err(|error| error.to_string())?;
    let handle = raw.0 as isize;
    let run = |apply: fn(HWND) -> Result<(), String>| {
        // Called from the recording command worker, after show() has been queued.
        // The UI-thread callback runs after ShowWindow; DWM must have a visible surface first.
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let _ = sender.send(apply(HWND(handle as *mut _)));
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|error| format!("等待捕获排除失败：{error}"))?
    };
    protect_with_fallback(
        || run(protect_visible_capture),
        || run(protect_visible_dda),
        RETRIES,
        RETRY_INTERVAL,
    )
}

/// 编排：先按重试语义打全通道排除，失败再走 DDA 单通道，两条都失败才把**两种**原因一起报上去。
/// 抽成纯函数是为了能在单测里驱动（webview 在单测环境里造不出来）。
fn protect_with_fallback<A, B>(
    mut capture: A,
    mut dda: B,
    retries: u32,
    interval: std::time::Duration,
) -> Result<Excluded, String>
where
    A: FnMut() -> Result<(), String>,
    B: FnMut() -> Result<(), String>,
{
    match retry_until_ok(&mut capture, retries, interval) {
        Ok(()) => Ok(Excluded::Capture),
        Err(capture_error) => match retry_until_ok(&mut dda, 2, interval) {
            Ok(()) => {
                log::info!("[Rec] 捕获排除降级为 DDA 通道（全通道失败：{capture_error}）");
                Ok(Excluded::DdaOnly)
            }
            Err(dda_error) => {
                Err(format!("全通道：{capture_error}；DDA 通道：{dda_error}"))
            }
        },
    }
}

/// 唯一的重试语义出口：首次尝试 + `retries` 次重试，成功即返回，全败返回**最后一次**原因。
fn retry_until_ok<F>(
    attempt: &mut F,
    retries: u32,
    interval: std::time::Duration,
) -> Result<(), String>
where
    F: FnMut() -> Result<(), String>,
{
    let mut last = String::from("捕获排除未执行");
    for index in 0..=retries {
        if index > 0 {
            std::thread::sleep(interval);
        }
        match attempt() {
            Ok(()) => return Ok(()),
            Err(error) => last = error,
        }
    }
    Err(format!(
        "{last}（已重试 {retries} 次，共 {}ms）",
        interval.as_millis() * u128::from(retries)
    ))
}

/// 全通道：`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`。
fn protect_visible_capture(hwnd: HWND) -> Result<(), String> {
    let mut affinity = 0;
    let ex_style = ex_style(hwnd);
    unsafe {
        DwmFlush().map_err(|error| format!("窗口合成尚未就绪：{error}"))?;
        // 分层窗口必须先把 layered 属性落定，否则重定向表面不完整：
        // 这一步只补「初始化」，alpha=255 表示视觉不变。
        if ex_style & WS_EX_LAYERED.0 != 0 {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        }
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
            .map_err(|error| format!("系统拒绝捕获排除（exstyle=0x{ex_style:08X}）：{error}"))?;
        GetWindowDisplayAffinity(hwnd, &mut affinity)
            .map_err(|error| format!("无法核对捕获排除：{error}"))?;
    }
    if affinity != WDA_EXCLUDEFROMCAPTURE.0 {
        return Err(format!(
            "系统未启用捕获排除（affinity={affinity}，exstyle=0x{ex_style:08X}）"
        ));
    }
    Ok(())
}

/// 单通道：只把窗口从 Desktop Duplication 的捕获里剔除（本产品录屏走的正是这条路）。
fn protect_visible_dda(hwnd: HWND) -> Result<(), String> {
    let ex_style = ex_style(hwnd);
    set_composition_attribute(hwnd, WCA_EXCLUDED_FROM_DDA, true)
        .map_err(|error| format!("系统拒绝 DDA 排除（exstyle=0x{ex_style:08X}）：{error}"))
}

fn ex_style(hwnd: HWND) -> u32 {
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 }
}

#[repr(C)]
struct WindowCompositionAttribData {
    attrib: u32,
    pv_data: *mut core::ffi::c_void,
    cb_data: u32,
}

type SetWindowCompositionAttributeFn =
    unsafe extern "system" fn(HWND, *mut WindowCompositionAttribData) -> BOOL;

/// 调 `SetWindowCompositionAttribute`（user32 的未文档化导出，按名字取址）。
fn set_composition_attribute(hwnd: HWND, attrib: u32, enable: bool) -> Result<(), String> {
    unsafe {
        let module =
            GetModuleHandleW(w!("user32.dll")).map_err(|error| format!("取 user32 失败：{error}"))?;
        let Some(address) = GetProcAddress(module, s!("SetWindowCompositionAttribute")) else {
            return Err("系统不提供 SetWindowCompositionAttribute".into());
        };
        let apply: SetWindowCompositionAttributeFn = std::mem::transmute(address);
        let mut value = BOOL(i32::from(enable));
        let mut data = WindowCompositionAttribData {
            attrib,
            pv_data: (&raw mut value).cast(),
            cb_data: std::mem::size_of::<BOOL>() as u32,
        };
        if apply(hwnd, &mut data).as_bool() {
            Ok(())
        } else {
            Err(windows::core::Error::from_win32().message())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{protect_with_fallback, retry_until_ok, Excluded};
    use std::cell::Cell;
    use std::time::Duration;

    /// 首次失败、第二次成功：必须真的重试，而不是把第一个错误直接抛给调用方。
    #[test]
    fn retries_until_success() {
        let calls = Cell::new(0);
        let mut attempt = || {
            calls.set(calls.get() + 1);
            if calls.get() < 2 {
                Err("系统拒绝捕获排除（exstyle=0x08080000）".to_string())
            } else {
                Ok(())
            }
        };
        assert!(retry_until_ok(&mut attempt, 8, Duration::from_millis(0)).is_ok());
        assert_eq!(calls.get(), 2, "第一次失败后必须再试");
    }

    /// 全败：返回**最后一次**原因，并显式标注重试次数，否则日志里只剩一句无归因的失败。
    #[test]
    fn returns_last_error_after_exhausting_retries() {
        let calls = Cell::new(0);
        let mut attempt = || {
            calls.set(calls.get() + 1);
            Err(format!("第 {} 次失败", calls.get()))
        };
        let message =
            retry_until_ok(&mut attempt, 3, Duration::from_millis(0)).expect_err("全败必须返回错误");
        assert_eq!(calls.get(), 4, "首次 + 3 次重试");
        assert!(message.contains("第 4 次失败"), "应报告最后一次原因：{message}");
        assert!(message.contains("已重试 3 次"), "应标注重试次数：{message}");
    }

    /// 🔴 2026-10-18 实录的形状：全通道连续失败（WebView2 窗口），DDA 通道顶上。
    /// 这条用例钉住的是「不许因为全通道失败就直接给用户弹警告」。
    #[test]
    fn falls_back_to_dda_when_capture_affinity_fails() {
        let capture_calls = Cell::new(0);
        let dda_calls = Cell::new(0);
        let outcome = protect_with_fallback(
            || {
                capture_calls.set(capture_calls.get() + 1);
                Err("系统拒绝捕获排除（exstyle=0x08040118）".to_string())
            },
            || {
                dda_calls.set(dda_calls.get() + 1);
                Ok(())
            },
            2,
            Duration::from_millis(0),
        );
        assert_eq!(outcome, Ok(Excluded::DdaOnly));
        assert_eq!(capture_calls.get(), 3, "全通道：首次 + 2 次重试");
        assert_eq!(dda_calls.get(), 1, "DDA 首次即成功，不该重试");
    }

    /// 两条通道都失败时，报错必须同时带上两种原因，否则下一轮仍然无法归因。
    #[test]
    fn reports_both_channels_when_everything_fails() {
        let message = protect_with_fallback(
            || Err("全通道失败".to_string()),
            || Err("DDA 失败".to_string()),
            0,
            Duration::from_millis(0),
        )
        .expect_err("两条都失败必须报错");
        assert!(message.contains("全通道失败"), "{message}");
        assert!(message.contains("DDA 失败"), "{message}");
    }
}
