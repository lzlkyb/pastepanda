//! 与某个对端「现在走哪条路」——从 iroh 的连接层直接读，不靠推断。
//!
//! # 🔴 为何需要它
//!
//! 现有的在线判据（`src/lib/kbOnline.ts`）是两个**间接证据**的并：
//! 组播听得见，或者 90 秒内真同步成功过。两个都不是「此刻通不通」：
//!
//! - 组播只证明同子网可见，而同步走的是 iroh QUIC（可直连、可过中继）；
//! - 那个 90 秒窗口是个**滞后**：对端 5 秒前刚断网，界面还要显示 85 秒的「在线」。
//!
//! 而 iroh 自己就知道每条网络路径此刻活不活跃。等于说：
//! 以前是关着仪表盘、靠「上次到没到目的地」推断发动机在不在转。
//!
//! # 比现有的 `transport` 多一档，而那一档是必要的
//!
//! 现有的 `lan` / `wan` / `""` 把**打洞成功的公网直连**与**绕公共中继**
//! 混成同一个「外网」，而两者速度差一个量级（n0 的公共中继在欧洲，
//! 那是真实的跨境流量）。用户看到「外网」时无从判断该不该去查网络。
//!
//! # iroh 1.1.0 的实际 API（已源码核实，别凭印象改）
//!
//! ```text
//! endpoint.remote_info(id).await        -> Option<RemoteInfo>
//! RemoteInfo::addrs()                   -> Iterator<&TransportAddrInfo>
//! TransportAddrInfo::addr()             -> &TransportAddr        // is_relay() / is_ip()
//! TransportAddrInfo::usage()            -> TransportAddrUsage    // Active | Inactive
//! ```
//!
//! ❗ 旧版 iroh 那个 `conn_type()` / `ConnectionType` 在 1.1.0 里**不存在**。
//!
//! ❗ `Connection::path_events()` 看着更好（事件驱动，不用轮询），但它在
//!   **Connection** 上，而我们每轮同步开一个会话就关 ⇒ 它只覆盖单次会话，
//!   回答不了「此刻在不在线」。端点级的 `remote_info` 才是对的工具。

use iroh::TransportAddr;

/// 此刻与对端之间最好的一条活跃路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    /// 局域网直连（活跃的 IP 路径，且是私网地址）。
    Lan,
    /// 公网直连（活跃的 IP 路径，打洞成功）。
    Direct,
    /// 绕中继（只有活跃的 relay 路径）。
    Relay,
    /// 一条活跃路径都没有。
    None,
}

impl PathKind {
    /// 给界面的短标签。
    pub fn label(self) -> &'static str {
        match self {
            PathKind::Lan => "局域网",
            PathKind::Direct => "公网直连",
            PathKind::Relay => "绕中继",
            PathKind::None => "离线",
        }
    }

    /// 存进库的稳定字符串（不用中文：文案改了不能让库里的值失效）。
    pub fn as_str(self) -> &'static str {
        match self {
            PathKind::Lan => "lan",
            PathKind::Direct => "direct",
            PathKind::Relay => "relay",
            PathKind::None => "",
        }
    }
}

/// 这个 IP 是私网地址吗（= 同一局域网）。
///
/// ❗ v4 看 `is_private()` 与 `is_link_local()`（169.254.x，无 DHCP 时的自分配）；
///   v6 看 `is_unique_local()`（fc00::/7）与 `is_unicast_link_local()`（fe80::/10）。
///   只看 v4 的 `is_private()` 会把 IPv6 局域网当成公网直连。
fn is_lan_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local() || v4.is_loopback()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_unique_local() || v6.is_unicast_link_local() || v6.is_loopback()
        }
    }
}

/// 从 iroh 的地址表推出 [`PathKind`]。
///
/// ❗ 故意**不收** iroh 的 `TransportAddrInfo`：它的字段是 `pub(super)`、
///   外面构造不出来，收它就没法单测。调用方把它拆成
///   `(是否活跃, 地址)` 传进来。
///
/// 优先级：局域网直连 > 公网直连 > 中继。iroh 会并行探测多条路径，
/// 同时有多条活跃时报**最好的那条**——那才是数据实际会走的。
///
/// 🔴 `Inactive` 的一律不算。iroh 的 remote map 会留着历史地址（文档原话：
/// “may include outdated or unusable addresses”），拿它们当在线就又回到
/// 「靠陈旧痕迹推断」了。
pub fn path_kind_of<'a>(addrs: impl Iterator<Item = (bool, &'a TransportAddr)>) -> PathKind {
    let mut best = PathKind::None;
    for (active, addr) in addrs {
        if !active {
            continue;
        }
        let k = match addr {
            TransportAddr::Ip(sa) if is_lan_ip(sa.ip()) => PathKind::Lan,
            TransportAddr::Ip(_) => PathKind::Direct,
            TransportAddr::Relay(_) => PathKind::Relay,
            // `TransportAddr` 是 `#[non_exhaustive]` 的（还有 `Custom`）。
            // 不认识的路径类型当中继算：它至少证明**通**，
            // 而把它报成直连会让用户以为速度应该很快。
            _ => PathKind::Relay,
        };
        // 优先级比较：Lan(3) > Direct(2) > Relay(1) > None(0)
        let rank = |p: PathKind| match p {
            PathKind::Lan => 3,
            PathKind::Direct => 2,
            PathKind::Relay => 1,
            PathKind::None => 0,
        };
        if rank(k) > rank(best) {
            best = k;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn ip(s: &str) -> TransportAddr {
        TransportAddr::Ip(s.parse().unwrap())
    }

    fn relay() -> TransportAddr {
        TransportAddr::Relay(iroh::RelayUrl::from_str("https://relay.example/").unwrap())
    }

    #[test]
    fn test_一条活跃路径都没有就是离线() {
        assert_eq!(path_kind_of(std::iter::empty()), PathKind::None);
        // 🔴 只有 Inactive 也是离线——iroh 的 remote map 会留历史地址，
        //    不排除的话就又回到靠陈旧痕迹推断了。
        let addrs = [ip("192.168.1.9:7842"), relay()];
        assert_eq!(
            path_kind_of(addrs.iter().map(|a| (false, a))),
            PathKind::None,
            "Inactive 的地址不能算成在线"
        );
    }

    #[test]
    fn test_私网地址算局域网公网地址算直连() {
        let lan = ip("192.168.1.9:7842");
        assert_eq!(path_kind_of(std::iter::once((true, &lan))), PathKind::Lan);
        let ten = ip("10.0.0.5:7842");
        assert_eq!(path_kind_of(std::iter::once((true, &ten))), PathKind::Lan);
        // 169.254 = 无 DHCP 时的自分配，仍然是同一段网
        let ll = ip("169.254.3.4:7842");
        assert_eq!(path_kind_of(std::iter::once((true, &ll))), PathKind::Lan);

        let wan = ip("5.223.65.62:7842");
        assert_eq!(
            path_kind_of(std::iter::once((true, &wan))),
            PathKind::Direct,
            "公网 IP 直连是「打洞成功」，不能与绕中继混成同一个标签"
        );
    }

    #[test]
    fn test_ipv6_局域网不能被当成公网直连() {
        // 只看 v4 的 `is_private()` 就会漏这两个
        let ula = ip("[fd00::1]:7842");
        assert_eq!(path_kind_of(std::iter::once((true, &ula))), PathKind::Lan);
        let ll6 = ip("[fe80::1]:7842");
        assert_eq!(path_kind_of(std::iter::once((true, &ll6))), PathKind::Lan);
    }

    #[test]
    fn test_多条活跃时报最好的那条() {
        // iroh 会并行探测；数据实际走最好的那条，报最差的会让用户
        // 去查一个不存在的网络问题。
        let r = relay();
        let lan = ip("192.168.1.9:7842");
        let wan = ip("5.223.65.62:7842");

        let all = [(true, &r), (true, &wan), (true, &lan)];
        assert_eq!(path_kind_of(all.iter().copied()), PathKind::Lan);

        let no_lan = [(true, &r), (true, &wan)];
        assert_eq!(path_kind_of(no_lan.iter().copied()), PathKind::Direct);

        let only_relay = [(true, &r)];
        assert_eq!(path_kind_of(only_relay.iter().copied()), PathKind::Relay);
    }

    #[test]
    fn test_活跃的中继比不活跃的局域网强() {
        // 🔴 优先级比的是**活跃的**那几条。一条早已失效的局域网地址
        //    不能把正在用的中继盖掉——那正是“靠陈旧痕迹推断”的重蹈。
        let lan = ip("192.168.1.9:7842");
        let r = relay();
        let mixed = [(false, &lan), (true, &r)];
        assert_eq!(path_kind_of(mixed.iter().copied()), PathKind::Relay);
    }

    #[test]
    fn test_存库的值不用中文() {
        // 文案改了不能让库里的值失效，所以两套分开。
        for k in [PathKind::Lan, PathKind::Direct, PathKind::Relay] {
            assert!(k.as_str().is_ascii(), "{:?} 存库的值得是 ASCII", k);
            assert!(!k.label().is_empty());
        }
        assert_eq!(PathKind::None.as_str(), "", "离线存空串，与现有 `transport` 的口径一致");
    }
}
