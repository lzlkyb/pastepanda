//! Verify capture exclusion synchronously: Tauri's setter only acknowledges its queued message.
use tauri::WebviewWindow;
use windows::Win32::{Foundation::HWND, Graphics::Dwm::DwmFlush, UI::WindowsAndMessaging::{
    GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
}};

pub(super) fn protect(window: &WebviewWindow) -> Result<(), String> {
    let raw = window.hwnd().map_err(|error| error.to_string())?;
    let handle = raw.0 as isize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    // Called from the recording command worker, after show() has been queued.
    // The UI-thread callback runs after ShowWindow; DWM must have a visible surface first.
    window.run_on_main_thread(move || {
        let _ = sender.send(protect_visible(HWND(handle as *mut _)));
    }).map_err(|error| error.to_string())?;
    receiver.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| format!("等待捕获排除失败：{error}"))?
}

fn protect_visible(hwnd: HWND) -> Result<(), String> {
    let mut affinity = 0;
    unsafe {
        DwmFlush().map_err(|error| format!("窗口合成尚未就绪：{error}"))?;
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
            .map_err(|error| format!("系统拒绝捕获排除：{error}"))?;
        GetWindowDisplayAffinity(hwnd, &mut affinity)
            .map_err(|error| format!("无法核对捕获排除：{error}"))?;
    }
    if affinity != WDA_EXCLUDEFROMCAPTURE.0 {
        return Err(format!("系统未启用捕获排除（{affinity}）"));
    }
    Ok(())
}
