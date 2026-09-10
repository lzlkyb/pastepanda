//! 一次同步里「数据实际走的哪条路」——从 iroh 的连接层直接读，不靠推断。
//!
//! # 🔴 它答的是「怎么连的」，不是「在不在线」（别再拿它当在线判据）
//!
//! 最初想用它替掉在线判据，走不通，原因见下面那节。在线判据仍然是
//! `devices.last_ok_ms` + 组播（`src/lib/kbOnline.ts`）。这里只答一件事：
//! **上一次同步成功时，笔记实际是从哪条路过去的。**
//!
//! 这件事原来是靠猜的：`transport_of()` 拿「presence 里有没有它的地址」
//! 当传输方式，于是 `wan` 与「组播听得见」在构造上互斥——那个「外网」标签
//! 是个到不了的死分支，WAN 对端一律显示离线（2026-09-07 实测复现过）。
//! 现在改成从活连接实测，那条互斥也随之消失。
//!
//! # 比现有的 `transport` 多一档，而那一档是必要的
//!
//! 现有的 `lan` / `wan` / `""` 把**打洞成功的公网直连**与**绕公共中继**
//! 混成同一个「外网」，而两者速度差一个量级（n0 的公共中继在欧洲，
//! 那是真实的跨境流量）。用户看到「外网」时无从判断该不该去查网络。
//!
//! # 🔴 绝不要改成 `Endpoint::remote_info()`（iroh 1.1.0 源码三处印证）
//!
//! `remote_info()` 看着才是「问端点某个对端现在怎么样」的正道，而它的
//! `TransportAddrUsage::Active` 看着就是「此刻在通」。**都不是。**
//! 那个 `Active` 一旦置上就再也不会撤，端点活多久它就残留多久：
//!
//! 1. `PathStatus::Open` 才映射成 `Active`，而把 `Open` 改回 `Inactive` 的只有
//!    `abandoned_path()` 一处；
//! 2. 而 `handle_path_event(Abandoned)` 在 `conn_state.handle.upgrade()` 拿不到
//!    连接时**直接 return**（原注释 `"event for closed connection"`）——连接已经
//!    关掉的路径，那一处永远走不到；
//! 3. `handle_connection_close()` 只从 `connections` 里摘掉连接、清 `selected_path`，
//!    **完全不碰** 喂 `remote_info()` 的那张端点级 `state.paths`；而唯一会清理的
//!    `prune_non_relay_paths()` 要非中继路径攒够 30 条才触发，且明文
//!    `_ => { /* ignore paths that are open */ }`。
//!
//! 我们每轮同步开一个会话就关 ⇒ 拿 `remote_info()` 判在线，会在对端断网后
//! 一直报「在线」直到进程重启。
//!
//! # 对的 API：`Connection::paths()`（已源码核实，别凭印象改）
//!
//! ```text
//! conn.paths()            -> PathList        // 文档原话：不含已关闭的路径
//! PathList::iter()        -> Iterator<Path>
//! Path::remote_addr()     -> &TransportAddr
//! Path::is_selected()     -> bool           // 当前被选中用于传输应用数据
//! ```
//!
//! 它是**按连接**的（每次会话新建一份），所以没有上面那种粘滞；
//! 而 `is_selected()` 直接就是「数据走哪条」，不用再拿「最好的那条」去推。
//!
//! ❗ 旧版 iroh 那个 `conn_type()` / `ConnectionType` 在 1.1.0 里**不存在**。

use iroh::TransportAddr;

/// 这一次会话里数据实际走的那条路。
///
/// ❗ `Default` 是为了给 `SessionReport` 的 `#[derive(Default)]` 充数，
///   充的是 `None`——“没测到”而不是随便猜一档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PathKind {
    /// 局域网直连（IP 路径，且是私网地址）。
    Lan,
    /// 公网直连（IP 路径，打洞成功）。
    Direct,
    /// 绕中继。
    Relay,
    /// 一条开放路径都没有。
    #[default]
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

/// 把一条连接的开放路径表折成 [`PathKind`]。
///
/// 入参是 `(是否被选中, 路径的远端地址)`——即 `Connection::paths()` 里每条的
/// `(is_selected(), remote_addr())`。**每条都是开放的**（那个 API 不返回已关闭的），
/// 所以 `false` 只表示「不是当前在传数据的那条」，不表示不可用。
///
/// ❗ 故意**不收** iroh 的 `Path`：`remote_addr()` 的生命周期绑在 `&self` 上
///   （不是 `'a`），跨不出闭包；`Path` 也构造不出来，收它就没法单测。
///   转换在 [`of_conn`] 里做。
///
/// 🔴 被选中的那条**优先**，哪怕另有一条「更好」的没被选中。
/// 这与最初的写法相反，而那个反过来是错的：局域网地址还开着、数据却在走中继时，
/// 「报最好的那条」会写出「局域网」，正好把这个判据要暴露的问题掩掉。
///
/// 没有任何一条被选中时（快照可能正落在路径迁移中间）才退回「开放路径里最好的」，
/// 优先级 局域网直连 > 公网直连 > 中继。
pub fn path_kind_of<'a>(paths: impl Iterator<Item = (bool, &'a TransportAddr)>) -> PathKind {
    let mut selected = PathKind::None;
    let mut any = PathKind::None;
    for (is_selected, addr) in paths {
        let k = kind_of_addr(addr);
        if is_selected && rank(k) > rank(selected) {
            selected = k;
        }
        if rank(k) > rank(any) {
            any = k;
        }
    }
    if selected != PathKind::None {
        selected
    } else {
        any
    }
}

/// 单条地址属于哪一档。
fn kind_of_addr(addr: &TransportAddr) -> PathKind {
    match addr {
        TransportAddr::Ip(sa) if is_lan_ip(sa.ip()) => PathKind::Lan,
        TransportAddr::Ip(_) => PathKind::Direct,
        TransportAddr::Relay(_) => PathKind::Relay,
        // `TransportAddr` 是 `#[non_exhaustive]` 的（还有 `Custom`）。
        // 不认识的路径类型当中继算：它至少证明**通**，
        // 而把它报成直连会让用户以为速度应该很快。
        _ => PathKind::Relay,
    }
}

/// 优先级：Lan(3) > Direct(2) > Relay(1) > None(0)
fn rank(p: PathKind) -> u8 {
    match p {
        PathKind::Lan => 3,
        PathKind::Direct => 2,
        PathKind::Relay => 1,
        PathKind::None => 0,
    }
}

/// 从一条**活着的**连接上读它此刻在走哪条路。
///
/// ❗ 得在会话还没掉的时候读。会话关掉之后 `paths()` 仍能返回最后那份快照
///   （`PathStateReceiver::get` 无视 `closed` 直接克隆），所以在 `run` 收尾处
///   读是安全的；而那份快照只属于这一次会话，不会串到下一次。
pub fn of_conn(conn: &iroh::endpoint::Connection) -> PathKind {
    let list = conn.paths();
    // 先克隆成 owned：`Path::remote_addr()` 的返回借着 `Path` 自身，出不了闭包。
    let owned: Vec<(bool, TransportAddr)> = list
        .iter()
        .map(|p| (p.is_selected(), p.remote_addr().clone()))
        .collect();
    path_kind_of(owned.iter().map(|(sel, addr)| (*sel, addr)))
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
    fn test_没有开放路径就是离线() {
        assert_eq!(path_kind_of(std::iter::empty()), PathKind::None);
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
    fn test_被选中的那条优先哪怕另有更好的没被选中() {
        // 🔴 这与最初的写法相反，而那个反过来是错的：局域网地址还开着、
        //    数据却在走中继时，「报最好的那条」会写出「局域网」，
        //    正好把这个判据要暴露的问题掩掉。
        let r = relay();
        let lan = ip("192.168.1.9:7842");
        let wan = ip("5.223.65.62:7842");

        let relay_selected = [(true, &r), (false, &wan), (false, &lan)];
        assert_eq!(
            path_kind_of(relay_selected.iter().copied()),
            PathKind::Relay,
            "数据在走中继，就不能因为局域网路径还开着而报「局域网」"
        );

        let lan_selected = [(false, &r), (false, &wan), (true, &lan)];
        assert_eq!(path_kind_of(lan_selected.iter().copied()), PathKind::Lan);

        let direct_selected = [(false, &r), (true, &wan), (false, &lan)];
        assert_eq!(
            path_kind_of(direct_selected.iter().copied()),
            PathKind::Direct
        );
    }

    #[test]
    fn test_一条都没被选中时退回最好的开放路径() {
        // 快照可能正落在路径迁移中间。这时每条都是开放的
        // （`Connection::paths()` 不返回已关闭的），报最好的那条比报「离线」有用。
        let r = relay();
        let lan = ip("192.168.1.9:7842");
        let none_selected = [(false, &r), (false, &lan)];
        assert_eq!(path_kind_of(none_selected.iter().copied()), PathKind::Lan);

        let only_relay = [(false, &r)];
        assert_eq!(path_kind_of(only_relay.iter().copied()), PathKind::Relay);
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
