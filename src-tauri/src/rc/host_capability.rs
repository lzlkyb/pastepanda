//! 被控能力门禁。Mac additionally requires supported capture and system authorization.

pub fn require_inbound_host() -> Result<(), String> {
    require_supported_platform(cfg!(any(target_os = "windows",target_os="macos")))?;
    // Unit tests exercise admission with a supported host, without accessing a
    // desktop or granting OS permissions. Native readiness is an app integration check.
    #[cfg(all(target_os="macos",not(test)))]
    {crate::rc::mac_capture::require_host()}
    #[cfg(any(not(target_os="macos"),test))]
    {Ok(())}
}

fn require_supported_platform(supported: bool) -> Result<(), String> {
    if supported { Ok(()) } else {
        Err("这台设备暂不支持被远程观看或控制，请改为从手机连接 Windows 电脑".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_host_and_allows_windows() {
        assert!(require_supported_platform(false).unwrap_err().contains("暂不支持"));
        assert!(require_supported_platform(true).is_ok());
        if cfg!(target_os="windows"){assert!(require_inbound_host().is_ok());}
    }
}
