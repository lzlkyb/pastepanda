//! System-managed login item. Only explicit settings changes register the app.
extern "C" {
    fn pp_mac_startup_status() -> i32;
    fn pp_mac_startup_set(enable: bool) -> i32;
}
fn status_error(status: i32) -> String {
    match status {
        -1 => "登录自启适配需要 macOS 13 或更高版本".into(),
        2 => "请在系统设置 → 通用 → 登录项中允许 PastePanda，然后重新启用自启".into(),
        3 => "请从已安装的 PastePanda.app 设置登录自启，开发进程不支持此操作".into(),
        _ => "无法更新 Mac 登录项，请检查系统设置中的登录项权限".into(),
    }
}
pub fn effective_enabled() -> Result<bool, String> {
    match unsafe { pp_mac_startup_status() } {
        0 | 2 => Ok(false),
        1 => Ok(true),
        status => Err(status_error(status)),
    }
}
pub fn set_enabled(enable: bool) -> Result<(), String> {
    match unsafe { pp_mac_startup_set(enable) } {
        0 => Ok(()),
        status => Err(status_error(status)),
    }
}
pub fn sync_on_boot(config_enabled: bool) -> Result<crate::autostart::BootSync, String> {
    // External removal/approval decisions are respected; never silently re-register.
    match unsafe { pp_mac_startup_status() } {
        0 | 2 if config_enabled => Ok(crate::autostart::BootSync::DisabledExternally),
        1 if !config_enabled => {
            set_enabled(false)?;
            Ok(crate::autostart::BootSync::CleanedGhost)
        }
        0 | 1 | 2 => Ok(crate::autostart::BootSync::None),
        status => Err(status_error(status)),
    }
}
