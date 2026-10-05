//! 被控能力门禁：当前仅 Windows 实现屏幕采集与输入注入。

pub fn require_inbound_host() -> Result<(), String> {
    require_supported_platform(cfg!(target_os = "windows"))
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
        assert_eq!(require_inbound_host().is_ok(), cfg!(target_os = "windows"));
    }
}
