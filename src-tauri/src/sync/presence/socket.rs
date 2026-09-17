//! 组播侧：一个监听套接字，加「往每一块网卡各发一份公告」的发送路径。
//!
//! 收发用**两个不同的套接字**：绑同一个端口再往它发包在各平台行为不一致，
//! 而发送方根本不需要固定端口（接收方只看源 IP）。理由见 [`announce_once`]。

use super::wire::{build, PresenceApp};
use super::{GROUP, PORT};
use crate::sync::identity::NodeIdentity;
use std::net::{Ipv4Addr, UdpSocket};

/// 监听用套接字：绑 [`PORT`]、加入组播组、带读超时（好让线程能停下来）。
pub fn bind_listener() -> Result<UdpSocket, String> {
    bind_listener_on(PORT)
}

/// 同上，但可以指定端口。**测试用 0（临时端口）**——
/// 固定 5008 会让并行跑的测试互相抢，表现为随机失败（与被测逻辑无关）。
pub fn bind_listener_on(port: u16) -> Result<UdpSocket, String> {
    // 🔴 重试而不是一次就放弃：`stop()` 只置标志，宣告线程要等它那 2 秒读超时
    // 走完才真的退出。用户在这 2 秒内关了再开（或前端连点开关），
    // 新线程就会 bind 失败、只留一条 warning 退出——
    // **地址发现静默死掉，而开关看着是开的**，正是我们想修掉的那个症状。
    let mut last = String::new();
    for i in 0..6 {
        match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(s) => return finish_listener(s),
            Err(e) => {
                last = e.to_string();
                if i < 5 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    }
    Err(format!(
        "绑定地址公告端口 {} 失败（重试 6 次仍被占用）：{}",
        port, last
    ))
}

fn finish_listener(sock: UdpSocket) -> Result<UdpSocket, String> {
    // 🔴 逐块网卡加入组播组。这里原本是 `Ipv4Addr::UNSPECIFIED`，
    //    而它在组播语境下**不是「所有网卡」**，是「让系统按路由表挑一块」——
    //    装了 VMware / VirtualBox / Hyper-V / WSL / Docker / VPN 的机器上
    //    经常挑中虚拟网卡，于是同网段的两台机器互相听不见。
    //
    // ❗ 这不是新发现：`lan_sync` 2026-09-06 就因为同一件事修过一次
    //   （见 `lan_sync::multicast_ifaces` 的注释），只是没搬到这个新模块。
    //   本模块里它的症状更隐蔽：不表现为「同步不了」，而是 `service::target()`
    //   拿不到局域网地址 → 退到只给 node_id 的兜底分支 → **走 n0 公共中继**，
    //   同一局域网的两台机器静静地绕道跨国同步，而界面徽章还写着「外网」。
    let mut joined = 0usize;
    for ifaddr in crate::lan_sync::multicast_ifaces() {
        match sock.join_multicast_v4(&GROUP, &ifaddr) {
            Ok(()) => joined += 1,
            // 虚拟网卡加不进去是常态，逐块 warn 会刷屏
            Err(e) => log::debug!("[Presence] 网卡 {} 加入组播组失败：{}", ifaddr, e),
        }
    }
    if joined == 0 {
        // ❗ 不像 `lan_sync` 那样直接放弃线程：本模块的宣告是**单向也有用**的
        //   （只要对端听得见我们，它就会拨过来，而同步会话本来就是双向的）。
        //   但绝不能静默（规则 #15.3）：这意味着本机永远听不到任何公告。
        log::error!("[Presence] 没能在任何一块网卡上加入组播组，本机听不到对端的地址公告（同步会退到中继）");
    } else {
        log::info!("[Presence] 已在 {} 块网卡上加入组播组", joined);
    }
    sock.set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .map_err(|e| format!("设置读取超时失败：{}", e))?;
    Ok(sock)
}

/// 宣告一次要的全部参数。
///
/// 收成结构体是因为里面有**两个 `u16`**（`endpoint_port` / `group_port`）——
/// 位置参数下把它们写反，编译器不会报错，只会「对端照着错端口拨号」，
/// 而且从外面**完全看不出来**（2026-09-17 已经在 `commands/kb_sync.rs`
/// 踩过一次同款：把 presence 的端口当成端点端口写进了公告）。
pub struct Announce {
    /// 本套 presence 的用途，写进公告供接收侧认串台。
    pub app: PresenceApp,
    /// 写进公告的端口：本机 **iroh 端点**端口，供对端拨号。
    pub endpoint_port: u16,
    /// 包发往的组播端口：**本套 presence** 的端口，也是本机在听的那个。
    pub group_port: u16,
    pub now_ms: i64,
}

/// 往**每一块**网卡各发一份地址公告。
///
/// 发送与监听用不同的套接字：绑同一个端口再往它发包在各平台行为不一致，
/// 而发送方根本不需要固定端口（接收方只看源 IP）。
///
/// 🔴 这里原本是一个 `bind(0.0.0.0:0)` 的 socket 直接 `send_to`，
/// 没有 `set_multicast_if_v4`——包从系统按路由表挑的那一块出去，
/// 在有虚拟网卡的机器上经常根本没上真实局域网。理由同 `finish_listener`。
///
/// ❗ 复用 `lan_sync` 那套（带 30 秒网卡缓存），不重写一份：
/// `netdev::get_interfaces()` 不便宜，而它已经在招呼包路径上被缓存过了。
///
/// 🔴 `group_port` 必须由调用方给：本进程里跑着**两套** presence（5008 知识库同步 /
/// 5009 远程电脑），写死就串台——2026-09-17 的事故见 [`super::PresenceStart::port`]。
/// `app` 同理，它是**事后**认出串台的唯一手段（[`super::Heard::WrongApp`]）。
pub fn announce_once(me: &NodeIdentity, a: Announce) -> Result<(), String> {
    let Announce {
        app,
        endpoint_port,
        group_port,
        now_ms,
    } = a;
    let mut sent = 0usize;
    let mut last = String::new();
    for (i, ifaddr) in crate::lan_sync::multicast_ifaces().into_iter().enumerate() {
        // 🔴 每块网卡**各建一份包、ts 不同**（2026-09-07 修）。
        //
        //    旧写法是上层 `build()` 一次、这里把**同一份字节**往每块网卡各发一份，
        //    于是 N 份包带着**同一个 `ts`**。而接收侧的严格递增重放检查
        //    （`wire.ts <= entry.last_ts` ⇒ `return Heard::Replay`）就在学习源地址
        //    那几行**之前**：第一份被接受并写 `last_ts`，其余每一份都被当重放
        //    丢掉、**永远走不到学地址**。后果：`service::target()` 只拿到一个候选地址，
        //    如果那一个是不可路由的网卡（Hyper-V / VMware 虚拟网卡很常见），
        //    打洞就失败、回落公共 relay——而旧的 `transport_of()` 仍然报 "lan"。
        //    （现在不会了：传输方式改成从活连接实测，这种情况徽章会写「绕中继」——
        //    但上面那个只学得到一个候选地址的 bug 本身仍然得防。）
        //
        //    `now_ms + i` 而不是改接收侧的检查顺序：把重放检查挪到学地址之后，
        //    等于允许一个第三方重放旧包把**自己的 IP** 登记到那个 node_id 名下；
        //    而每包不同 ts 既保住了严格递增的重放防护，也让 N 个源地址都能被学到。
        //    代价：每次宣告多签 N-1 次名（ed25519，微秒级）与最多几毫秒的 ts 偏差，
        //    而 `CLOCK_WINDOW_MS` 是分钟级的，不会因此被卡。
        let packet = build(me, app, endpoint_port, now_ms + i as i64)?;
        match crate::lan_sync::send_via_iface(&ifaddr, GROUP, group_port, &packet) {
            Ok(()) => sent += 1,
            Err(e) => {
                // 虚拟网卡发不出去是常态，逐块 warn 会刷屏
                log::debug!("[Presence] 经网卡 {} 发送地址公告失败：{}", ifaddr, e);
                last = e.to_string();
            }
        }
    }
    if sent == 0 {
        // 一块都没发出去 = 对端永远不知道本机地址，必须报（规则 #15.3）
        return Err(format!("地址公告没能从任何一块网卡发出去：{}", last));
    }
    Ok(())
}

/// 把一个**已经做好的**包往每一块网卡各发一份。
///
/// 与 [`announce_once`] 的分工是「发」与「做包」：那个负责做包（每块网卡一份、
/// `ts` 递增），这个只负责发——A3 的招呼包与配对握手包都是**一次性动作包**，
/// 不需要按网卡错开时间戳（接收侧的严格递增重放检查只对地址公告生效，
/// 见 `table::hear_plain`）。
///
/// `group_port` 与 `announce_once` 同一个理由必须由调用方给：本进程里跑着两套
/// presence（5008 知识库同步 / 5009 远程电脑），写死就串台。
pub fn send_all(group_port: u16, packet: &[u8]) -> Result<(), String> {
    let mut sent = 0usize;
    let mut last = String::new();
    for ifaddr in crate::lan_sync::multicast_ifaces() {
        match crate::lan_sync::send_via_iface(&ifaddr, GROUP, group_port, packet) {
            Ok(()) => sent += 1,
            Err(e) => {
                // 虚拟网卡发不出去是常态，逐块 warn 会刷屏
                log::debug!("[Presence] 经网卡 {} 发送失败：{}", ifaddr, e);
                last = e.to_string();
            }
        }
    }
    if sent == 0 {
        // 与 `announce_once` 同一条判据：一块都没发出去就等于这个动作没发生，
        // 而调用方（配对、招呼）都在等结果，静默失败会让人以为是对方没响应。
        return Err(format!("包没能从任何一块网卡发出去：{}", last));
    }
    Ok(())
}
