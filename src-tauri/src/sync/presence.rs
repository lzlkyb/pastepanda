//! 局域网地址宣告（M6 `kb_presence`）。
//!
//! # 为什么需要它
//!
//! 配对（[`super::invite`]）交换的是**身份**，不是地址。而局域网 IP 会漂：
//! 换 WiFi、DHCP 续租、插网线、开 VPN，地址就变了。没有这一层，
//! 每次地址变都要重新粘一遍邀请码——那不叫「配一次就一直能用」。
//!
//! 所以这里做一件很窄的事：**在组播上周期性喊「node_id X 在这个端口上」**，
//! 已配对的对端听见就更新自己那份地址表。不搬任何笔记字节。
//!
//! # 🔴 三个刻意的删减
//!
//! ## ① 公告里不带设备名
//!
//! 接收方只认**已配对**的 `node_id`，而名字在配对时就存进 `devices` 表了。
//! 公告再带一份名字，只是多给攻击者一个能一路进到界面上的可控字符串，
//! 换不来任何东西。顺带也少泄漏一点：组播是同网段谁都能收的，
//! 而机器名里常带真人姓名。
//!
//! ## ② 公告里不带 IP，只带端口
//!
//! 地址取 `recv_from` 的**源 IP**。这样免了枚举本机网卡——那件事本身有坑
//! （iroh 的 `bound_sockets()` 返回的是通配 `0.0.0.0`，拨它必然超时，
//! 而且失败起来**看着像是 iroh 连不上**，探针阶段已经栽过一次）。
//! 更重要的是：源 IP 才是真正能到达我们的那个地址，比对端自己猜的准。
//! 多网卡也自然成立——每张网卡发来的包源 IP 不同，各记一条。
//!
//! ## ③ 不加密
//!
//! `lan_sync` 的信封用配对密钥做 AES-256-GCM，因为它搬的是剪贴板内容。
//! 这里搬的是「一个公钥 + 一个端口号」——公钥本来就是给人看的东西。
//! 而且真要加密就得有组共享密钥，而配对是一对一的节点密钥，没有组密钥。
//!
//! # 🔴 签名管什么、不管什么
//!
//! **认证边界在传输层，不在这里。** iroh 的 QUIC/TLS 用 ed25519 身份完成握手，
//! 所以哪怕有人把一份合法公告从自己的 IP 上重发（源 IP 不在签名覆盖范围内，
//! 也**不可能**在——发送方并不知道自己会从哪张网卡出去），
//! 我们最多白拨一次：握手过不去，因为对方没有那把私钥。
//!
//! 那签名留着挡两件事：
//! - **表被塞满**：没有签名，任何人都能宣告任意 `node_id`，把地址表灌成垃圾
//! - **重放**：`ts` 参与签名，于是可以要求每个节点的 `ts` **严格递增**
//!
//! # 端口为什么不跟 `lan_sync` 共用
//!
//! 组播组沿用 `lan_sync` 的 `224.1.1.1`，但端口用 5008 而不是 5007。
//! 共用一个端口有两个实际问题：两个监听线程要抢 `bind`；
//! 而且双方都会拿到对方的包，然后互相在日志里刷「解密/校验失败」——
//! 那种噪音会把真问题埋掉。
//!
//! # 开关是自己的一个，不是 `lan_sync_enabled`
//!
//! 设置里那个「局域网同步」开关管的是**剪贴板**同步。知识库同步是另一件事，
//! 用户可能只想要其中一个。所以开关是 [`ENABLE_KEY`]，且判断写在
//! [`spawn`] **里面**——放外面的话，将来接线的人会忘。

use super::identity::NodeIdentity;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 组播组，沿用 `lan_sync`。
pub const GROUP: Ipv4Addr = Ipv4Addr::new(224, 1, 1, 1);
/// 宣告端口。**不是** `lan_sync` 的 5007，见模块说明。
pub const PORT: u16 = 5008;
/// 两次宣告的间隔（秒）。
pub const ANNOUNCE_INTERVAL_SECS: u64 = 15;
/// 地址多久没被刷新就当失效（毫秒）。= 4 个宣告周期，容得下丢几个 UDP 包。
pub const STALE_MS: i64 = 60_000;
/// 单个节点最多记几个地址（多网卡 / VPN）。同时也是「拨号尝试次数」的上限。
const MAX_ADDRS_PER_NODE: usize = 4;
/// 超过这个大小的包在解析前直接丢——合法公告只有两百来字节。
const MAX_PACKET: usize = 2048;
/// 时间戳允许的偏差（毫秒）。沿用 `lan_sync` 的 120 秒。
const CLOCK_WINDOW_MS: i64 = 120_000;
/// 线上格式版本。
const WIRE_V: u8 = 1;
/// 知识库同步的开关键。**故意不是** `lan_sync_enabled`。
pub const ENABLE_KEY: &str = "kb_sync_enabled";

/// 线上格式。字段少得可疑——那是刻意的，见模块说明 ①②。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Wire {
    v: u8,
    /// 宣告方的 `NodeId`（公钥 hex，64 字符）。
    node_id: String,
    /// 宣告方 iroh 端点监听的端口。IP 由接收方从源地址取。
    port: u16,
    /// 宣告时刻（epoch 毫秒）。参与签名，用来做窗口 + 单调检查。
    ts: i64,
    /// 签名的 base64url。
    sig: String,
}

/// 待签名的规范字节。
///
/// 🔴 用 `|` 分隔：三个字段分别是 hex、数字、数字，都不可能含 `|`，
/// 所以拼接无歧义。
///
/// 前缀与 [`super::invite`] 的**必须不同**，否则一份邀请码的签名可能被
/// 拿来当公告用（跨协议签名复用）。
fn signing_bytes(node_id: &str, port: u16, ts: i64) -> Vec<u8> {
    format!("pastepanda-presence-v1|{}|{}|{}", node_id, port, ts).into_bytes()
}

/// 做一份公告。`endpoint_port` 传本机 iroh 端点的监听端口。
pub fn build(me: &NodeIdentity, endpoint_port: u16, now_ms: i64) -> Result<Vec<u8>, String> {
    let node_id = me.node_id();
    let sig = me.sign(&signing_bytes(&node_id, endpoint_port, now_ms))?;
    let wire = Wire {
        v: WIRE_V,
        node_id,
        port: endpoint_port,
        ts: now_ms,
        sig: b64().encode(sig),
    };
    serde_json::to_vec(&wire).map_err(|e| format!("序列化地址公告失败：{}", e))
}

/// 收到一份公告之后发生了什么。
///
/// 每种失败都是**不同**的枚举值而不是一个 `Option`：这些情况的排查方向
/// 完全不一样（没配对 vs 时钟不对 vs 被篡改），合并成一个就没法查（规则 #15.3）。
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// 收下了：这个已配对节点现在可以在 `addr` 拨到。
    Fresh { node_id: String, addr: SocketAddr },
    /// 自己发的（组播会回环）。
    Mine,
    /// 不是已配对设备。连地址都不记——否则同网段任何人都能把表灌满。
    Unpaired { node_id: String },
    /// 时间戳超出窗口：对端时钟差太多，或者是很旧的重放。
    OutOfWindow { node_id: String, skew_ms: i64 },
    /// 时间戳没有前进，按重放丢。
    Replay { node_id: String },
    /// 包本身有问题（超长 / 不是 JSON / 版本不对 / 签名不过）。
    Bad(String),
}

/// 某个节点的地址们。
#[derive(Debug, Default)]
struct NodeAddrs {
    /// 对端自称的最近一次宣告时刻。单调检查用。
    last_ts: i64,
    /// 地址 -> **本机**收到它的时刻。过期判断用本机时钟，
    /// 免得对端时钟一歪，地址就跟着提前失效或永不失效。
    addrs: Vec<(SocketAddr, i64)>,
}

/// 已配对设备的当前地址表。只在内存里——地址是易失的，
/// 存盘只会让重启后拿着过期地址去拨。
#[derive(Debug, Default)]
pub struct PresenceTable {
    inner: Mutex<HashMap<String, NodeAddrs>>,
}

impl PresenceTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// 解析 + 校验 + 记录，一处收口（规则 #11）。
    ///
    /// `is_paired` 用闭包传进来而不是直接查库：这样本模块不依赖 `DataStore`，
    /// 单测不起库就能覆盖全部分支。
    ///
    /// 🔴 检查顺序是有讲究的，不要重排：
    /// 「已配对」比「验签名」便宜得多，所以放前面——同网段有人乱发包时，
    /// 我们不为每个包都做一次 ed25519 验签。而验签必须在**动表之前**，
    /// 否则未认证的包就能改我们的状态。
    pub fn hear(
        &self,
        packet: &[u8],
        src_ip: IpAddr,
        my_node_id: &str,
        is_paired: &dyn Fn(&str) -> bool,
        now_ms: i64,
    ) -> Heard {
        if packet.len() > MAX_PACKET {
            return Heard::Bad(format!("公告包超长（{}B），已丢弃", packet.len()));
        }
        let wire: Wire = match serde_json::from_slice(packet) {
            Ok(w) => w,
            Err(_) => return Heard::Bad("不是地址公告的结构".to_string()),
        };
        if wire.v != WIRE_V {
            return Heard::Bad(format!("公告版本 {} 不认识（本机 {}）", wire.v, WIRE_V));
        }
        if wire.node_id.len() != 64 {
            return Heard::Bad(format!(
                "公告里的 node_id 长度不对（{} 字符，应为 64）",
                wire.node_id.len()
            ));
        }
        if wire.node_id == my_node_id {
            return Heard::Mine;
        }
        if !is_paired(&wire.node_id) {
            return Heard::Unpaired {
                node_id: wire.node_id,
            };
        }
        let Ok(sig) = b64().decode(&wire.sig) else {
            return Heard::Bad("公告里的签名解不开".to_string());
        };
        if let Err(e) = super::identity::verify(
            &wire.node_id,
            &signing_bytes(&wire.node_id, wire.port, wire.ts),
            &sig,
        ) {
            return Heard::Bad(format!("公告签名校验不通过：{}", e));
        }

        let skew = now_ms - wire.ts;
        if skew.abs() > CLOCK_WINDOW_MS {
            return Heard::OutOfWindow {
                node_id: wire.node_id,
                skew_ms: skew,
            };
        }

        let addr = SocketAddr::new(src_ip, wire.port);
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.entry(wire.node_id.clone()).or_default();
        // 严格递增：原样重发同一份公告（ts 相同）也算重放。
        // 宣告间隔是秒级、ts 是毫秒级，正常情况下撞不上。
        if wire.ts <= entry.last_ts {
            return Heard::Replay {
                node_id: wire.node_id,
            };
        }
        entry.last_ts = wire.ts;
        match entry.addrs.iter_mut().find(|(a, _)| *a == addr) {
            Some(slot) => slot.1 = now_ms,
            None => {
                entry.addrs.push((addr, now_ms));
                if entry.addrs.len() > MAX_ADDRS_PER_NODE {
                    // 淘汰最久没刷新的，而不是最先加进来的：
                    // 网卡换了之后老地址不会再被刷新，正好被挤掉。
                    entry.addrs.sort_by_key(|(_, seen)| *seen);
                    entry.addrs.remove(0);
                }
            }
        }
        Heard::Fresh {
            node_id: wire.node_id,
            addr,
        }
    }

    /// 某个节点当前可拨的地址，最近刷新的排前面。已过期的不返回。
    pub fn addrs_of(&self, node_id: &str, now_ms: i64) -> Vec<SocketAddr> {
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let Some(e) = map.get(node_id) else {
            return Vec::new();
        };
        let mut live: Vec<(SocketAddr, i64)> = e
            .addrs
            .iter()
            .filter(|(_, seen)| now_ms - *seen <= STALE_MS)
            .copied()
            .collect();
        live.sort_by_key(|(_, seen)| -*seen);
        live.into_iter().map(|(a, _)| a).collect()
    }

    /// 当前还听得见的所有节点。给「谁在线」用。
    pub fn live(&self, now_ms: i64) -> Vec<String> {
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut ids: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.addrs.iter().any(|(_, s)| now_ms - *s <= STALE_MS))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// 「忘记此设备」时把地址一起清掉。
    ///
    /// ❗ 不清的话：忘记之后对端还在喊，但 `is_paired` 会把新公告拒掉——
    /// 于是表里留下一条**永不刷新也永不被覆盖**的僵尸地址，
    /// 一直挂到 [`STALE_MS`] 过完。
    pub fn forget(&self, node_id: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(node_id);
    }
}

// ===== 套接字 =====

/// 监听用套接字：绑 [`PORT`]、加入组播组、带读超时（好让线程能停下来）。
pub fn bind_listener() -> Result<UdpSocket, String> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, PORT))
        .map_err(|e| format!("绑定地址公告端口 {} 失败（可能被占用）：{}", PORT, e))?;
    if let Err(e) = sock.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED) {
        // 不是致命错误：网卡不支持组播、或者在容器里跑时，仍然想让线程起来
        log::warn!("[Presence] 加入组播组失败（同网段将发现不到对端）：{}", e);
    }
    sock.set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .map_err(|e| format!("设置读取超时失败：{}", e))?;
    Ok(sock)
}

/// 发送用套接字。与监听分开：绑同一个端口再往它发包在各平台行为不一致，
/// 而发送方根本不需要固定端口（接收方只看源 IP）。
pub fn bind_sender() -> Result<UdpSocket, String> {
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("创建发送套接字失败：{}", e))
}

/// 喊一次。
pub fn announce_once(
    sock: &UdpSocket,
    me: &NodeIdentity,
    endpoint_port: u16,
    now_ms: i64,
) -> Result<(), String> {
    let packet = build(me, endpoint_port, now_ms)?;
    sock.send_to(&packet, (GROUP, PORT))
        .map_err(|e| format!("发送地址公告失败：{}", e))?;
    Ok(())
}

// ===== 后台线程 =====

/// 起「监听 + 周期宣告」的线程。
///
/// 🔴 开关判断在**函数里面**：调用方拿不到「绕过开关」的写法。
/// 关着的时候不是静默返回，而是留一行日志说明为什么没起（规则 #15.3）。
///
/// `is_paired` 由调用方给（通常是查 `devices` 表），这样本模块不依赖 `DataStore`。
pub fn spawn(
    enabled: bool,
    table: Arc<PresenceTable>,
    me: Arc<NodeIdentity>,
    endpoint_port: u16,
    is_paired: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    running: Arc<AtomicBool>,
) {
    if !enabled {
        log::info!(
            "[Presence] 知识库同步开关（{}）是关的，不启动地址宣告",
            ENABLE_KEY
        );
        return;
    }
    // 同 lan_sync / ClipboardMonitor 的 CAS：防并发启动出双线程
    if running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        let listener = match bind_listener() {
            Ok(s) => s,
            Err(e) => {
                // bind 失败必须复位 running，否则再也起不来（同 lan_sync 的 C8）
                log::warn!("[Presence] {}", e);
                running.store(false, Ordering::SeqCst);
                return;
            }
        };
        let sender = match bind_sender() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[Presence] {}", e);
                running.store(false, Ordering::SeqCst);
                return;
            }
        };
        let my_id = me.node_id();
        log::info!("[Presence] 地址宣告已启动，端口 {}", PORT);

        let mut last_announce = 0i64;
        let mut buf = [0u8; MAX_PACKET + 1];
        while running.load(Ordering::SeqCst) {
            let now = chrono::Utc::now().timestamp_millis();
            if now - last_announce >= ANNOUNCE_INTERVAL_SECS as i64 * 1000 {
                if let Err(e) = announce_once(&sender, &me, endpoint_port, now) {
                    log::warn!("[Presence] {}", e);
                }
                last_announce = now;
            }
            // 读超时 2 秒，所以这个循环最慢 2 秒转一圈，停止请求最多等 2 秒
            match listener.recv_from(&mut buf) {
                Ok((len, src)) => {
                    let heard = table.hear(
                        &buf[..len],
                        src.ip(),
                        &my_id,
                        &|id| is_paired(id),
                        chrono::Utc::now().timestamp_millis(),
                    );
                    match heard {
                        Heard::Fresh { node_id, addr } => {
                            log::debug!("[Presence] {} 在 {}", &node_id[..8], addr);
                        }
                        // 自己的包与未配对设备的包是常态，不值得记日志
                        Heard::Mine | Heard::Unpaired { .. } => {}
                        // 🔴 重放要记（debug 级）。正常情况下它极少出现，
                        // 但对端做一次 NTP 回拨 / 改时区之后，它**所有**新公告都会
                        // 被这条严格递增判成重放并丢掉，表现是「对方明明开着却一直显示
                        // 离线」，且 STALE_MS 过后地址失效、不会自愈。
                        // 静默丢弃的话这种情况完全无从查起。
                        Heard::Replay { node_id } => {
                            log::debug!(
                                "[Presence] {} 的公告时间戳没有前进，按重放丢弃（对端是不是回拨过时钟？）",
                                &node_id[..8]
                            );
                        }
                        Heard::OutOfWindow { node_id, skew_ms } => {
                            log::warn!(
                                "[Presence] {} 的公告时间差 {}ms，超窗已丢弃（对一下两台机器的时钟）",
                                &node_id[..8],
                                skew_ms
                            );
                        }
                        Heard::Bad(why) => log::warn!("[Presence] {}", why),
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => log::warn!("[Presence] 接收失败：{}", e),
            }
        }
        log::info!("[Presence] 地址宣告已停止");
    });
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}
