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
//! # 文件分工
//!
//! | 文件 | 管什么 |
//! |---|---|
//! | `wire` | 线上格式：字节 ↔ 结构，以及用途标识 [`PresenceApp`] 与包的用途 [`WireKind`] |
//! | `table` | 地址表：一份公告能不能收、收下记在哪儿 |
//! | `nearby` | 附近设备表：明文招呼攒出来的候选（**不入地址表**） |
//! | `socket` | 组播：监听套接字 + 往各网卡发包 |
//! | 本文件 | 公开 API、常量、后台线程 [`spawn`] |
//!
//! 拆开是按**变更理由**切的：协议演进只动 `wire`，调度策略只动本文件。
//! 原先是单文件 599 行（红线 600），加一个字段就会破线。
//!
//! # 同一端口上的两类包（2026-09-17 A3 新增）
//!
//! 一个端口上跑两类包，靠 [`WireKind`] 分流，**走的路径完全不同**：
//!
//! | | [`WireKind::Addr`] | 其余（明文：招呼 / 配对握手） |
//! |---|---|---|
//! | 收不收 | 只收**已配对**设备 | 同网段任何持**自己**私钥的机器 |
//! | 记到哪 | [`PresenceTable`] 的地址表 | [`Nearby`]，或交给 `on_plain` 注册的处理器 |
//! | 过期 | [`STALE_MS`]（60 秒） | [`NEARBY_TTL_MS`]（20 秒）/ 配对会话 60 秒 |
//! | 签名 | 有（挡重放 + 挡灌表） | **也有**，但内容不加密——理由见 [`WireKind`] |
//!
//! 为什么要「同一端口」而不是另开一个：另一套 presence 要另抢一个组播端口，
//! 而端口本身就是 09-17 那次事故的来源（写错一侧 = 静默串台）。同端口 + 包内
//! 分流把「哪个端口」这个变量消掉了。
//!
//! # 🔴 三个刻意的删减
//!
//! ## ① 地址公告里不带设备名
//!
//! 接收方只认**已配对**的 `node_id`，而名字在配对时就存进 `devices` 表了。
//! 公告再带一份名字，只是多给攻击者一个能一路进到界面上的可控字符串，
//! 换不来任何东西。顺带也少泄漏一点：组播是同网段谁都能收的，
//! 而机器名里常带真人姓名。
//!
//! ❗ **2026-09-17 修订**：这一条只管 [`WireKind::Addr`]。明文招呼包
//! （[`WireKind::Hello`]）**必须**带名字——「附近的设备」列表只有一串十六进制
//! 谁也认不出是谁。所以名字有一条窄通道：只在招呼包里、只用于显示、
//! 截断到 [`NAME_MAX_CHARS`] 个字符（见 `wire::clean_name`），
//! 且界面上必须同时标出「可自称，以指纹为准」。代价说清楚：**同网段能看到你的设备名**，
//! 与 `lan_pair` 的招呼包一致。
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
//! ❗ 同一条理由**在本模块内部也成立**：知识库同步和远程电脑是两套独立的
//! [`PresenceTable`] + 两个独立线程，各自 `bind` 各自的端口（5008 / 5009）。
//! 所以「本套用哪个端口」必须是 [`PresenceStart::port`] 的入参，
//! **监听与广播两侧都得用它**——任何一侧写死常量，都会把另一套的包吞掉。
//!
//! 🔴 而 2026-09-17 的事故证明了「端口不同」这一层隔离**不够**：两套的包
//! （同一 `node_id`、同一把签名密钥、同一份格式）在字节层面一模一样，于是
//! 端口一旦写错，包就会**静默进错表**——全套校验照常通过，地址表被写脏，
//! 日志与正常心跳长得完全一样。所以包内另有用途标识 [`PresenceApp`]，
//! 对不上就是 [`Heard::WrongApp`]，不再静默。
//!
//! # 开关是自己的一个，不是 `lan_sync_enabled`
//!
//! 设置里那个「局域网同步」开关管的是**剪贴板**同步。知识库同步是另一件事，
//! 用户可能只想要其中一个。所以开关是 [`ENABLE_KEY`]，且判断写在
//! [`spawn`] **里面**——放外面的话，将来接线的人会忘。

use super::identity::NodeIdentity;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use wire::MAX_PACKET;

mod nearby;
mod socket;
mod table;
mod wire;

pub use nearby::{Neighbor, Nearby, NEARBY_TTL_MS};
pub use socket::{announce_once, bind_listener, bind_listener_on, hello_packet, send_all, Announce};
pub use table::{Heard, PlainPacket, PlainHandler, PresenceTable};
pub use wire::{build, build_kind, Extras, PresenceApp, WireKind, NAME_MAX_CHARS};

/// 组播组，沿用 `lan_sync`。
pub const GROUP: Ipv4Addr = Ipv4Addr::new(224, 1, 1, 1);
/// 宣告端口。**不是** `lan_sync` 的 5007，见模块说明。
pub const PORT: u16 = 5008;
/// 两次宣告的间隔（秒）。
pub const ANNOUNCE_INTERVAL_SECS: u64 = 15;
/// 两份**招呼包**（[`WireKind::Hello`]）的间隔（秒）。只在
/// [`PresenceStart::hello_name`] 给了的时候用。
///
/// 🔴 5 秒这个数是**由 [`NEARBY_TTL_MS`]（20 秒）反推的**：20 / 5 = 4，
/// 也就是「容得下连丢 3 份心跳」。改动前先想清楚这两者的关系——招呼包发稀了，
/// 邻居会在列表里一闪一闪（TTL 修剪跑在下一份心跳前面）；发密了白刷组播。
///
/// 为什么不直接引用 `lan_pair::HELLO_INTERVAL_SECS`：两套招呼包是**各自协议里的
/// 各自选择**（格式、承载、消费方都不同），数值撞在一起只是撞在一起。
/// 守卫单测 `test_招呼间隔与附近表_TTL_相称` 钉的是上面那个比例，不是这个巧合。
pub const HELLO_INTERVAL_SECS: u64 = 5;
/// 地址多久没被刷新就当失效（毫秒）。= 4 个宣告周期，容得下丢几个 UDP 包。
pub const STALE_MS: i64 = 60_000;
/// 知识库同步的开关键。**故意不是** `lan_sync_enabled`。
pub const ENABLE_KEY: &str = "kb_sync_enabled";

/// 起 presence 线程要的全部参数。
///
/// 里面有两个 `u16`（`endpoint_port` / `port`）和三个 `Arc<..>`，
/// 位置参数下把两个端口写反编译器**不会报错**，只会连不上；收成结构体后按名字赋值。
///
/// ❗ `endpoint_port` 是**本机 iroh 端点**的端口（写进公告给别人拨），
/// `port` 是**本套 presence 的组播端口**（自己听 + 公告发往的地方），
/// 两者毫无关系，写反的后果是完全静默的。
pub struct PresenceStart {
    pub enabled: bool,
    /// 本套 presence 的用途。必须与 [`PresenceTable::new`] 传的那个一致，
    /// 否则会**自己拒自己**（收包侧按表上那个判用途）。
    pub app: PresenceApp,
    pub table: Arc<PresenceTable>,
    pub me: Arc<NodeIdentity>,
    /// 本机 iroh endpoint 端口（写进公告，供对端拨号）。
    pub endpoint_port: u16,
    pub is_paired: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub on_fresh: Arc<dyn Fn(&str) + Send + Sync>,
    pub running: Arc<AtomicBool>,
    /// 本套 presence 的端口：**既用于 bind 监听，也用于组播广播**，两边必须一致。
    ///
    /// 生产：知识库同步传 [`PORT`]（5008）、远程电脑传 `rc::RC_PRESENCE_PORT`（5009）；
    /// 测试传 0（临时端口），此时广播端口回落 [`PORT`]。
    /// 🔴 2026-09-17 前广播那侧写死 [`PORT`]，两套串台且**全静默**——见模块说明末节。
    pub port: u16,
    /// 要不要在地址公告之外**再周期发一种招呼包**：带上本机设备名，让同网段
    /// **还没配对**的邻居把本机列进「附近的设备」（[`Nearby`]）。
    ///
    /// - `Some(name)`：发。远程电脑用这个（它需要「附近设备」这块界面）。
    /// - `None`：不发。知识库同步**不需要**——它没有「附近设备」这个界面，
    ///   多喊一种包只是白白告诉同网段「这里有个 PastePanda」。地址公告照旧。
    ///
    /// 🔴 **这是周期心跳，不是一次性动作**。收包侧的 [`Nearby`] 靠「最近
    /// [`NEARBY_TTL_MS`] 内听到过」判在不在附近，所以只发一次的话，对端列表里
    /// 会闪一下就消失（TTL 修剪跑在下一份心跳前面）。间隔见 [`HELLO_INTERVAL_SECS`]。
    pub hello_name: Option<String>,
}

/// 起「监听 + 周期宣告」的线程。
///
/// 🔴 开关判断在**函数里面**：调用方拿不到「绕过开关」的写法。
/// 关着的时候不是静默返回，而是留一行日志说明为什么没起（规则 #15.3）。
///
/// `is_paired` 由调用方给（通常是查 `devices` 表），这样本模块不依赖 `DataStore`。
/// `on_fresh` 同理：听到一台已配对设备的新公告时回调，用来把休眠中的
/// 同步循环叫醒（见 `service::SyncCtx::wake`）——本模块自己不知道那边的存在。
pub fn spawn(p: PresenceStart) {
    let PresenceStart {
        enabled,
        app,
        table,
        me,
        endpoint_port,
        is_paired,
        on_fresh,
        running,
        port,
        hello_name,
    } = p;
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
        // 监听可用临时端口（测试传 0），**广播不能**：往 0 号端口发等于没发。
        let announce_port = if port == 0 { PORT } else { port };
        let listener = match socket::bind_listener_on(port) {
            Ok(s) => s,
            Err(e) => {
                // bind 失败必须复位 running，否则再也起不来（同 lan_sync 的 C8）
                log::warn!("[Presence] {}", e);
                running.store(false, Ordering::SeqCst);
                return;
            }
        };
        let my_id = me.node_id();
        // 🔴 打**实际**端口与用途：这里原本打常量 `PORT`，于是 rc 那套明明监听 5009、
        //    日志却写 5008，两套日志一模一样——「端口 5008」出现两次，正是 09-17
        //    那个 bug 的指纹。用途（`app`）同理：它是事后认串台的依据。
        log::info!(
            "[Presence] 地址宣告已启动，监听 {}，广播 {}（{}）",
            port,
            announce_port,
            app.label()
        );

        let mut last_announce = 0i64;
        // 招呼包的定时**独立于**地址公告（5 秒 vs 15 秒）。初值 0 ⇒ 起线程后
        // 立刻发第一份——否则对端要干等满一个间隔才看得到本机。
        let mut last_hello = 0i64;
        // 「上一份招呼包是否发失败」：用来把持续失败压成**一条** warn（跃变时才报）。
        // 网络断了的时候每 5 秒一条会淹掉日志，而那条信息量并不随时间增加。
        let mut hello_failed = false;
        let mut buf = [0u8; MAX_PACKET + 1];
        while running.load(Ordering::SeqCst) {
            let now = chrono::Utc::now().timestamp_millis();
            if now - last_announce >= ANNOUNCE_INTERVAL_SECS as i64 * 1000 {
                if let Err(e) = announce_once(
                    &me,
                    Announce {
                        app,
                        endpoint_port,
                        group_port: announce_port,
                        now_ms: now,
                    },
                ) {
                    log::warn!("[Presence] {}", e);
                }
                last_announce = now;
            }
            // 招呼包：让同网段**未配对**的邻居把本机列进「附近的设备」。
            //
            // 🔴 挂在同一个循环里而不是另起线程：`running` 一翻就跟着停，
            //    省掉第二个 running 标志、第二个线程、第二次 bind。
            //    （2026-09-17 那版的错误在别处——**根本没发**，见 `HELLO_INTERVAL_SECS`。）
            if let Some(name) = hello_name.as_deref() {
                if now - last_hello >= HELLO_INTERVAL_SECS as i64 * 1000 {
                    match hello_packet(&me, app, endpoint_port, name, now) {
                        Ok(packet) => match send_all(announce_port, &packet) {
                            Ok(()) => {
                                if hello_failed {
                                    log::info!("[Presence] 招呼包恢复发送");
                                    hello_failed = false;
                                }
                            }
                            // 跃变才报 warn：一块网卡发不出去是常态（`send_all` 内部
                            // 已逐块 debug），而**一块都发不出去**意味着邻居根本
                            // 看不到本机——那是要用户知道的，只是不该每 5 秒说一遍。
                            Err(e) => {
                                if !hello_failed {
                                    log::warn!("[Presence] 招呼包发不出去（同网段看不到本机）：{}", e);
                                    hello_failed = true;
                                }
                            }
                        },
                        // 签名/序列化失败是「不该发生」，每次报出来（它不会持续）。
                        Err(e) => log::warn!("[Presence] 做招呼包失败：{}", e),
                    }
                    last_hello = now;
                }
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
                        Heard::Fresh {
                            node_id,
                            addr,
                            returned,
                            legacy,
                        } => {
                            log::debug!("[Presence] {} 在 {}", &node_id[..8], addr);
                            // 🔴 只在**跃变**时叫醒（它刚回来），不是每份心跳都叫。
                            //   每份都叫的后果见 `Heard::Fresh::returned` 的注释：
                            //   休眠会被封顶在 15 秒，而且是广播式的、一台喂气全体醒。
                            if returned {
                                // ❗ info 级：正常的周期心跳走上面那条 debug 就够了，
                                //   而「从完全听不到到听得见」是状态跃变——正是 09-17
                                //   那次「rc 静默收不到包」最难查的地方，默认级别要看得见。
                                //
                                // ❗ `legacy` 也只在跃变时报（跃变罕见，不会刷屏）。
                                //   它的价值是回答「对端到底升没升级」：旧版本的对端广播
                                //   端口写死成同步那个，串台污染可能仍在——而这从界面上
                                //   完全看不出来，只有这里能说清。
                                log::info!(
                                    "[Presence] 端口 {}：听到 {} 的地址 {}{}",
                                    announce_port,
                                    &node_id[..8],
                                    addr,
                                    if legacy {
                                        "（旧版公告，无用途标识——这台对端该升级了）"
                                    } else {
                                        ""
                                    }
                                );
                                on_fresh(&node_id);
                            }
                        }
                        // 自己的包与未配对设备的包是常态，不值得记日志
                        Heard::Mine | Heard::Unpaired { .. } => {}
                        // 明文包（招呼 / 配对握手）交给注册过的处理器。
                        // 地址表一个字都不记——理由见 `table::hear_plain`。
                        Heard::Plain(p) => {
                            if !table.dispatch_plain(&p) {
                                // 没人接就留一条 debug：静默丢弃比报错难查一个量级
                                // （知识库同步那套没注册处理器，这是它的常态）。
                                log::debug!(
                                    "[Presence] 收到一份{}（来自 {}），本套 presence 没有消费方，已忽略",
                                    p.kind.label(),
                                    &p.node_id[..8]
                                );
                            }
                        }
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
                        // 🔴 09-17 那次就是这条路径**静默通过**：包进错表、校验照过、
                        //   表被写脏，日志里一个字都没有。现在明确报一句。
                        Heard::WrongApp { claimed } => log::warn!(
                            "[Presence] 端口 {}（{}）收到了「{}」的公告——对端把端口配错了，已丢弃",
                            announce_port,
                            app.label(),
                            claimed.label()
                        ),
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
