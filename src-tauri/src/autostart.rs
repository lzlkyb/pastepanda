//! 开机自启（HKCU Run）收口模块。
//!
//! 为什么存在：此前自启条目只在设置开关切换那一刻写一次注册表，之后永不校验——
//! 清理工具/安全软件删掉 Run 值、任务管理器/系统设置禁用（`StartupApproved` 打标记）、
//! 重装换目录导致 exe 路径过期，任何一种发生后软件都不自愈，而界面读的是配置文件
//! 仍显示「已开启」。这就是用户反馈的「自启有时候失效」。
//!
//! 收口内容：
//! - 全部注册表读写只在本模块发生（`set_startup`/`get_startup` 是仅有的两个外壳）；
//! - 纯判断（拼命令 / 解析路径 / 解析禁用标记）与 IO 分开，前者可无环境单测；
//! - `sync_on_boot`：每次启动按配置对账（缺失/过期 → 补写；被系统禁用 → 尊重外部
//!   关停并把配置收敛为关；配置为关但有残留 → 清除）。

/// Run 键里的值名。改名 = 所有用户的自启条目一夜失效，别动。
const RUN_VALUE_NAME: &str = "ClipboardManager";
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// 任务管理器/系统设置「启动应用」的禁用标记存放处；值不存在 = 默认启用。
const APPROVED_KEY_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const APPROVED_VALUE_NAME: &str = RUN_VALUE_NAME;

// ===== 纯函数（可无环境单测） =====

/// 拼自启命令：路径加引号防空格，`/silent` 让开机启动静默驻留托盘不抢焦点。
pub fn build_run_command(exe: &str) -> String {
    format!("\"{}\" /silent", exe)
}

/// 从 Run 值里取出 exe 路径。兼容三种历史格式：`"path" /silent`、`"path"`、`path`。
pub fn extract_exe_path(cmd: &str) -> &str {
    let t = cmd.trim();
    if let Some(rest) = t.strip_prefix('"') {
        match rest.find('"') {
            Some(end) => &rest[..end],
            None => rest,
        }
    } else {
        match t.find(' ') {
            Some(end) => &t[..end],
            None => t,
        }
    }
}

/// Run 值是否与当前 exe 的期望命令一致（含 `/silent`）。
/// 整串比较而非只比路径：旧版本写的无 `/silent` 条目会被判过期并在启动对账时升级。
/// 大小写不敏感：Windows 路径大小写不敏感，避免盘符/目录大小写差异造成每次启动都重写。
pub fn run_entry_is_current(cmd: &str, exe: &str) -> bool {
    cmd.trim().to_lowercase() == build_run_command(exe).to_lowercase()
}

/// 解析 StartupApproved 的 REG_BINARY：首字节 bit0 置位（如 0x03）= 已禁用，
/// 0x02 = 启用。值缺失/过短按「未禁用」处理（宽容：拿不到标记时不能把用户配置改关）。
pub fn approved_flag_says_disabled(bytes: &[u8]) -> bool {
    bytes.first().is_some_and(|b| b & 0x01 != 0)
}

// ===== 启动对账 =====

/// `sync_on_boot` 的对账结论，供 lib.rs 记日志/回写配置。
#[derive(Debug, PartialEq, Eq)]
pub enum BootSync {
    /// 注册表与配置一致，无事发生。
    None,
    /// 配置说开但条目缺失/路径过期/旧格式 → 已重写。
    Repaired,
    /// 被任务管理器/系统设置/安全软件禁用 → 尊重外部关停，调用方应把配置收敛为关。
    DisabledExternally,
    /// 配置说关但注册表有残留条目 → 已清除（防幽灵自启）。
    CleanedGhost,
}

/// 每次启动按配置对账。IO 失败返回 Err，调用方记日志即可——设置页打开时
/// 前端还会用 `get_startup` 再对账一次，兜住这次失败。
pub fn sync_on_boot(config_enabled: bool) -> Result<BootSync, String> {
    #[cfg(target_os = "windows")]
    {
        let disabled = read_approved_disabled()?;
        if config_enabled {
            if disabled {
                // 任务管理器等的外部禁用不覆盖（用户意图优先于应用内配置），
                // 只把应用内开关收敛为关，用户想开回来在设置里重开即可。
                return Ok(BootSync::DisabledExternally);
            }
            let stale = match read_run_command()? {
                Some(cmd) => {
                    let exe = current_exe_path()?;
                    !run_entry_is_current(&cmd, &exe)
                }
                None => true,
            };
            if stale {
                write_run_command()?;
                return Ok(BootSync::Repaired);
            }
            Ok(BootSync::None)
        } else {
            let mut acted = false;
            if read_run_command()?.is_some() {
                delete_run_command()?;
                acted = true;
            }
            if disabled {
                clear_approved_flag()?;
            }
            Ok(if acted { BootSync::CleanedGhost } else { BootSync::None })
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = config_enabled;
        Ok(BootSync::None)
    }
}

// ===== 注册表 IO（Windows；其余平台空实现保持可编译） =====

/// 当前进程 exe 的绝对路径。
fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("获取当前 exe 路径失败: {}", e))
}

/// 自启是否真实生效：条目存在 && 指向当前 exe && 未被 StartupApproved 禁用。
#[cfg(target_os = "windows")]
pub fn effective_enabled() -> Result<bool, String> {
    let Some(cmd) = read_run_command()? else {
        return Ok(false);
    };
    if read_approved_disabled()? {
        return Ok(false);
    }
    let exe = current_exe_path()?;
    Ok(run_entry_is_current(&cmd, &exe))
}

#[cfg(target_os = "windows")]
pub fn read_run_command() -> Result<Option<String>, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(RUN_KEY_PATH)
        .map_err(|e| format!("打开 Run 键失败: {}", e))?;
    match key.get_value::<String, _>(RUN_VALUE_NAME) {
        Ok(v) => Ok(Some(v)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取自启条目失败: {}", e)),
    }
}

/// 重写 Run 值（create_subkey 保证键存在；每次都是当前 exe，修过期路径）。
#[cfg(target_os = "windows")]
pub fn write_run_command() -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let exe = current_exe_path()?;
    let cmd = build_run_command(&exe);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(RUN_KEY_PATH)
        .map_err(|e| format!("打开 Run 键失败: {}", e))?;
    key.set_value(RUN_VALUE_NAME, &cmd)
        .map_err(|e| format!("写入自启条目失败: {}", e))
}

/// 删除 Run 值；本就不存在视为成功。
#[cfg(target_os = "windows")]
pub fn delete_run_command() -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(RUN_KEY_PATH, winreg::enums::KEY_WRITE)
        .map_err(|e| format!("打开 Run 键失败: {}", e))?;
    match key.delete_value(RUN_VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除自启条目失败: {}", e)),
    }
}

#[cfg(target_os = "windows")]
pub fn read_approved_disabled() -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey(APPROVED_KEY_PATH) {
        Ok(k) => k,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("打开 StartupApproved 键失败: {}", e)),
    };
    match key.get_raw_value(APPROVED_VALUE_NAME) {
        Ok(v) => Ok(approved_flag_says_disabled(&v.bytes)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("读取禁用标记失败: {}", e)),
    }
}

/// 删除禁用标记（值不存在 = 默认启用）。在 `StartupApproved\Run` 下删值需要 KEY_WRITE。
#[cfg(target_os = "windows")]
pub fn clear_approved_flag() -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(APPROVED_KEY_PATH, winreg::enums::KEY_WRITE) {
        Ok(k) => k,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("打开 StartupApproved 键失败: {}", e)),
    };
    match key.delete_value(APPROVED_VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除禁用标记失败: {}", e)),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn effective_enabled() -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(target_os = "windows"))]
pub fn read_run_command() -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "windows"))]
pub fn write_run_command() -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "windows"))]
pub fn delete_run_command() -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "windows"))]
pub fn read_approved_disabled() -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(target_os = "windows"))]
pub fn clear_approved_flag() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_command_quotes_path_and_appends_silent() {
        assert_eq!(build_run_command(r"C:\App\PastePanda.exe"), "\"C:\\App\\PastePanda.exe\" /silent");
        // 路径带空格也必须整体加引号
        assert_eq!(
            build_run_command(r"C:\Program Files\PastePanda.exe"),
            "\"C:\\Program Files\\PastePanda.exe\" /silent"
        );
    }

    #[test]
    fn extract_exe_path_handles_historical_formats() {
        assert_eq!(extract_exe_path("\"C:\\A\\p.exe\" /silent"), r"C:\A\p.exe");
        assert_eq!(extract_exe_path("\"C:\\A\\p.exe\""), r"C:\A\p.exe");
        assert_eq!(extract_exe_path("C:\\A\\p.exe /x"), r"C:\A\p.exe");
        assert_eq!(extract_exe_path("C:\\A\\p.exe"), r"C:\A\p.exe");
        // 没有闭合引号的坏数据：取整个剩余部分，不 panic
        assert_eq!(extract_exe_path("\"C:\\A\\p.exe"), r"C:\A\p.exe");
    }

    #[test]
    fn current_check_is_case_insensitive_and_requires_silent() {
        let exe = r"C:\App\PastePanda.exe";
        assert!(run_entry_is_current("\"c:\\APP\\pastepanda.exe\" /SILENT", exe));
        assert!(!run_entry_is_current("\"C:\\Old\\PastePanda.exe\" /silent", exe));
        // 旧格式（无 /silent）：判过期，启动对账时升级
        assert!(!run_entry_is_current("\"C:\\App\\PastePanda.exe\"", exe));
        assert!(!run_entry_is_current("", exe));
    }

    #[test]
    fn approved_flag_bit0_marks_disabled() {
        assert!(!approved_flag_says_disabled(&[0x02, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(approved_flag_says_disabled(&[0x03, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(!approved_flag_says_disabled(&[0x00]));
        // 宽容：拿不到标记时按「未禁用」处理
        assert!(!approved_flag_says_disabled(&[]));
    }
}
