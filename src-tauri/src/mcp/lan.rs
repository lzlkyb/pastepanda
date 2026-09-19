//! MCP 局域网直连：本机 IPv4 枚举与 Host 判定。
//!
//! 安全模型（与 `auth.rs` 配合）：
//! - 局域网开关默认关；关着时非回环一律 403；
//! - 开着时非回环可连，但仍要 Bearer 令牌 + Origin/Host 门；
//! - **不做 IP 白名单**（2026-09-15 拍板：有令牌就够了）。
//!
//! 🔴 **纯函数尽量集中在这里**，便于无 Tauri / 无网络环境的单测。

use std::net::{IpAddr, Ipv4Addr};

/// 是否回环（本机客户端）。
pub fn is_loopback_ip(ip: Option<IpAddr>) -> bool {
    match ip {
        // 测试与个别路径拿不到 ConnectInfo 时按本机处理，与旧行为一致
        None => true,
        Some(ip) => ip.is_loopback(),
    }
}

/// 本机非回环 IPv4 地址（用于 Host 放行与界面展示）。
///
/// 与 `lan_sync` 同一套过滤：up、非回环网卡、非 unspecified。
/// 这里**不缓存**：调用频率低（启服务 / 改开关 / status 展示），
/// 而缓存过期会让换网卡后界面上的地址变成错的。
pub fn local_ipv4s() -> Vec<Ipv4Addr> {
    netdev::get_interfaces()
        .into_iter()
        .filter(|i| i.is_up() && !i.is_loopback())
        .flat_map(|i| i.ipv4.into_iter().map(|n| n.addr()))
        .filter(|a| !a.is_loopback() && !a.is_unspecified())
        .collect()
}

/// `host[:port]` 是否是本机某个非回环 IPv4（局域网 Host 放行用）。
pub fn is_local_lan_host(authority: &str, local_ipv4s: &[Ipv4Addr]) -> bool {
    let authority = authority.trim();
    let host = match authority.split_once(':') {
        Some((h, _)) => h,
        None => authority,
    };
    if host.is_empty() {
        return false;
    }
    match host.parse::<Ipv4Addr>() {
        Ok(ip) => local_ipv4s.contains(&ip),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_loopback_ip() {
        assert!(is_loopback_ip(None));
        assert!(is_loopback_ip(Some(IpAddr::V4(Ipv4Addr::LOCALHOST))));
        assert!(is_loopback_ip(Some("::1".parse::<IpAddr>().unwrap())));
        assert!(!is_loopback_ip(Some(IpAddr::V4(Ipv4Addr::new(
            10, 203, 5, 99
        )))));
    }

    #[test]
    fn test_is_local_lan_host() {
        let local = vec![Ipv4Addr::new(10, 203, 5, 48)];
        assert!(is_local_lan_host("10.203.5.48:17650", &local));
        assert!(is_local_lan_host("10.203.5.48", &local));
        assert!(!is_local_lan_host("10.203.5.49:17650", &local));
        assert!(!is_local_lan_host("evil.com:17650", &local));
    }
}
