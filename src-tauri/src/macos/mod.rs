//! macOS paste adapter. Target IDs are process IDs, never Windows HWNDs.
pub mod screen;
pub mod screen_layout;
pub mod open;
pub mod file_assoc;
pub mod scroll;
pub mod secret_store;
pub mod startup;
use std::sync::Mutex;
use std::time::{Duration, Instant};
static LAST_PASTE_TARGET: Mutex<Option<(i32, Instant)>> = Mutex::new(None);

extern "C" {
    fn pp_mac_frontmost_pid() -> i32;
    fn pp_mac_accessibility_trusted() -> bool;
    fn pp_mac_target_valid(pid: i32, own_pid: u32) -> bool;
    fn pp_mac_activate_target(pid: i32) -> i32;
    fn pp_mac_send_paste(pid: i32) -> i32;
    fn pp_mac_send_tab(pid: i32) -> i32;
    fn pp_mac_write_clipboard(json: *const u8, length: usize, files: bool) -> i32;
}

fn target_pid(target: isize, own_pid: u32) -> Option<i32> {
    let pid = i32::try_from(target).ok()?;
    (pid > 0 && pid as u32 != own_pid).then_some(pid)
}
pub fn valid_target(target: isize, own_pid: u32) -> bool {
    target_pid(target, own_pid).is_some_and(|pid| unsafe { pp_mac_target_valid(pid, own_pid) })
}
pub fn frontmost_target(own_pid: u32) -> Option<isize> {
    let pid = unsafe { pp_mac_frontmost_pid() } as isize;
    valid_target(pid, own_pid).then_some(pid)
}
pub fn require_accessibility() -> Result<(), String> {
    if unsafe { pp_mac_accessibility_trusted() } {
        Ok(())
    } else {
        Err("自动粘贴需要辅助功能权限。请在系统设置 → 隐私与安全性 → 辅助功能中允许 PastePanda；也可使用复制后手动 Command+V。".into())
    }
}
fn native_result(status: i32) -> Result<(), String> {
    match status {
        0 => Ok(()),
        1 => require_accessibility().and(Err("辅助功能权限不可用".into())),
        2 => Err("目标应用已关闭或焦点已变化，本次粘贴已取消".into()),
        3 => Err("无法将目标应用切换到前台，本次粘贴已取消".into()),
        _ => Err("无法创建 Mac 粘贴按键事件".into()),
    }
}
/// Called before clipboard writes. Wait for confirmed activation, not just its request.
pub fn prepare_target(target: isize, own_pid: u32) -> Result<(), String> {
    require_accessibility()?;
    let pid = target_pid(target, own_pid).ok_or("无效的粘贴目标")?;
    native_result(unsafe { pp_mac_activate_target(pid) })?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(500) {
        if unsafe { pp_mac_frontmost_pid() } == pid {
            return valid_target(target, own_pid)
                .then_some(())
                .ok_or("目标窗口已关闭".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("目标应用未获得焦点，剪贴板未改动".into())
}
pub fn send_paste(target: isize, own_pid: u32) -> Result<(), String> {
    let pid = target_pid(target, own_pid).ok_or("无效的粘贴目标")?;
    let mut last = LAST_PASTE_TARGET.lock().map_err(|_| "粘贴目标状态不可用")?;
    *last = None;
    native_result(unsafe { pp_mac_send_paste(pid) })
        .map_err(|error| format!("{error}；内容已复制，可手动 Command+V"))?;
    *last = Some((pid, Instant::now()));
    Ok(())
}

pub fn send_tab(own_pid: u32) -> Result<(), String> {
    let last = LAST_PASTE_TARGET
        .lock()
        .map_err(|_| "粘贴目标状态不可用")?
        .take();
    let (pid, when) = last.ok_or("没有刚完成的粘贴，Tab 已取消")?;
    if when.elapsed() > Duration::from_secs(2) || target_pid(pid as isize, own_pid).is_none() {
        return Err("粘贴目标已过期，Tab 已取消".into());
    }
    native_result(unsafe { pp_mac_send_tab(pid) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tab_requires_a_recent_successful_external_paste_and_consumes_it_once() {
        *LAST_PASTE_TARGET.lock().unwrap() = Some((123, Instant::now() - Duration::from_secs(3)));
        assert!(send_tab(42).is_err());
        assert!(LAST_PASTE_TARGET.lock().unwrap().is_none());
        assert!(send_tab(42).is_err());
        *LAST_PASTE_TARGET.lock().unwrap() = Some((42, Instant::now()));
        assert!(send_tab(42).is_err());
        assert!(LAST_PASTE_TARGET.lock().unwrap().is_none());
    }
    #[test]
    fn bundle_categories_do_not_match_lookalike_apps() {
        assert_eq!(application_category("com.microsoft.Excel"), "excel");
        assert_eq!(application_category("com.jetbrains.pycharm"), "ide");
        assert_eq!(application_category("com.example.fake.chrome"), "other");
        assert_eq!(application_category(""), "other");
    }
    #[test]
    fn invalid_or_own_process_never_reaches_native_adapter() {
        for id in [-1, 0, 42, isize::MAX] {
            assert_eq!(target_pid(id, 42), None);
        }
        assert_eq!(target_pid(123, 42), Some(123));
    }
}

fn write_clipboard(values: &[&str], files: bool) -> Result<(), String> {
    let json = serde_json::to_vec(values).map_err(|e| format!("剪贴板数据编码失败：{e}"))?;
    match unsafe { pp_mac_write_clipboard(json.as_ptr(), json.len(), files) } {
        0 => Ok(()),
        1 => Err("剪贴板数据无效，或文件已不存在".into()),
        _ => Err("写入 Mac 系统剪贴板失败".into()),
    }
}
pub fn copy_files(paths: &[String]) -> Result<(), String> {
    write_clipboard(&paths.iter().map(String::as_str).collect::<Vec<_>>(), true)
}
pub fn copy_rich(html: &str, plain: &str) -> Result<(), String> {
    write_clipboard(&[html, plain], false)
}

/// Metadata is queried for the same PID selected by the paste engine.
pub fn application_info(target: isize, own_pid: u32) -> Option<(String, String)> {
    extern "C" {
        fn pp_mac_application_info(pid: i32, output: *mut *mut u8, length: *mut usize) -> i32;
        fn pp_mac_free(memory: *mut std::ffi::c_void);
    }
    #[derive(serde::Deserialize)]
    struct Info {
        name: String,
        bundle_id: String,
    }
    let pid = target_pid(target, own_pid)?;
    let mut output = std::ptr::null_mut();
    let mut length = 0;
    let status = unsafe { pp_mac_application_info(pid, &mut output, &mut length) };
    if output.is_null() {
        return None;
    }
    let info = if status == 0 {
        serde_json::from_slice::<Info>(unsafe { std::slice::from_raw_parts(output, length) }).ok()
    } else {
        None
    };
    unsafe {
        pp_mac_free(output.cast());
    }
    let info = info?;
    let category = application_category(&info.bundle_id);
    Some((info.name, category.into()))
}
fn application_category(bundle_id: &str) -> &'static str {
    match bundle_id.to_ascii_lowercase().as_str() {
        "com.apple.safari"
        | "com.google.chrome"
        | "com.microsoft.edgemac"
        | "org.mozilla.firefox"
        | "com.brave.browser"
        | "com.operasoftware.opera" => "browser",
        "com.microsoft.excel" => "excel",
        "com.microsoft.word" => "word",
        "com.kingsoft.wpsoffice.mac" => "office",
        "com.microsoft.vscode" | "com.apple.dt.xcode" => "ide",
        id if id.starts_with("com.jetbrains.") => "ide",
        "com.apple.terminal" | "com.googlecode.iterm2" | "org.alacritty" => "terminal",
        _ => "other",
    }
}
