//! 已配对设备的地址表：一份公告**能不能收**、收下之后记在哪儿。
//!
//! 一张表属于**一套** presence（见 [`PresenceApp`]）——两套各自 `bind` 各自的
//! 组播端口、各自维护一张表。所以「本表是哪一套」是构造参数而不是可选项。

use super::wire::{
    clean_name, decode_sig, PresenceApp, Wire, WireKind, CLOCK_WINDOW_MS, MAX_PACKET, WIRE_V,
};
use super::STALE_MS;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

/// 单个节点最多记几个地址（多网卡 / VPN）。同时也是「拨号尝试次数」的上限。
const MAX_ADDRS_PER_NODE: usize = 4;

/// 一个**明文包**（[`WireKind`] 里非 `Addr` 的那几种）通过全部校验之后的形态。
///
/// 这个类型的存在意思是：**包的合法性已经判完了，但「要不要记、记到哪」不属于本表**。
/// 地址表只管已配对设备的地址；招呼包与配对握手包是另一条路，
/// 由 [`PresenceTable::on_plain`] 注册的处理器拿走（远程电脑那边是
/// `rc/pin.rs` + `sync::presence::Nearby`）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlainPacket {
    pub kind: WireKind,
    pub node_id: String,
    /// 对方**自报**的名字（已过 [`clean_name`]）。空串 = 没带。
    pub name: String,
    /// 本次会话的临时公钥（hex）。空串 = 没带。
    pub pk: String,
    /// 这包给谁。空串 = 没指定（招呼包）。
    pub to_id: String,
    /// 包里的时刻（epoch 毫秒）。
    pub ts: i64,
    /// 发送方在**本套 presence 端口**上的源地址。
    pub src: SocketAddr,
}

/// 收到一份公告之后发生了什么。
///
/// 每种失败都是**不同**的枚举值而不是一个 `Option`：这些情况的排查方向
/// 完全不一样（没配对 vs 时钟不对 vs 被篡改），合并成一个就没法查（规则 #15.3）。
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// 收下了：这个已配对节点现在可以在 `addr` 拨到。
    ///
    /// `returned` = 这一份公告是一次**跃变**（之前一个新鲜地址都没有，现在有了），
    /// 也就是「它回来了」。
    ///
    /// 🔴 为何必须区分它与「又收到一份心跳」：公告是 **15 秒一份的心跳**，
    /// 而 [`super::super::service::SyncCtx::wake`] 是拿来叫醒休眠循环的。
    /// 若每份公告都叫醒，休眠（本该 1800 秒）就被封顶在 15 秒——
    /// 而且 `notify_waiters()` 是广播，**任一**已配对设备在局域网里喂气，
    /// 就会把所有休眠循环全叫起来。结果是一台拒绝本机的设备每 15 秒被重拨一次、
    /// 永远下去——比没加休眠之前（封顶 60 秒）还糟。（2026-09-07 审出。）
    Fresh {
        node_id: String,
        addr: SocketAddr,
        returned: bool,
        /// 这份公告**没有**用途标识 ⇒ 对端还是旧版本，建议升级。
        ///
        /// 不是错误（旧包照收），但值得在日志里说一次：旧版本的广播端口写死成
        /// 同步那个，它发来的包可能本该属于另一张表——见 [`Heard::WrongApp`]。
        legacy: bool,
    },
    /// 包本身合法，但**自称属于另一套 presence**（用途标识对不上）。
    ///
    /// 只有「对端的端口配错了」或「将来新增第三套 presence 时接线写错」会走到这里。
    /// 一个字都不能记：这个包描述的是**别的通道**的端点，记进本表就是把地址搞脏。
    WrongApp { claimed: PresenceApp },
    /// 自己发的（组播会回环）。
    Mine,
    /// 不是已配对设备。连地址都不记——否则同网段任何人都能把表灌满。
    Unpaired { node_id: String },
    /// 通过了全部校验的**明文包**，交给 [`PresenceTable::on_plain`] 的处理器。
    ///
    /// 与 [`Heard::Fresh`] 的关键区别：这里**没有任何东西被记进地址表**。
    Plain(PlainPacket),
    /// 时间戳超出窗口：对端时钟差太多，或者是很旧的重放。
    OutOfWindow { node_id: String, skew_ms: i64 },
    /// 时间戳没有前进，按重放丢。
    Replay { node_id: String },
    /// 包本身有问题（超长 / 不是 JSON / 版本不对 / 签名不过）。
    Bad(String),
}

/// 明文包的处理器。注册了才会被调用——没注册时 [`Heard::Plain`] 只留一条 debug。
pub type PlainHandler = Arc<dyn Fn(&PlainPacket) + Send + Sync>;

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
///
/// ❗ 手写 `Debug` 而不是 `derive`：`PlainHandler` 是个闭包，没有 `Debug`。
/// 打不出内容没关系，但「有没有注册处理器」在排障时值得看得见。
pub struct PresenceTable {
    /// 本表为哪一套 presence 服务。串台判定要用（[`Heard::WrongApp`]）。
    app: PresenceApp,
    inner: Mutex<HashMap<String, NodeAddrs>>,
    /// 明文包的处理器。挂在这里而不是 [`super::PresenceStart`] 上，是为了
    /// **只有需要它的那套 presence 才付这个代价**：知识库同步那套不注册，
    /// 于是它的明文包只留一条 debug。
    plain: Mutex<Option<PlainHandler>>,
}

impl std::fmt::Debug for PresenceTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let has_plain = self.plain.lock().map(|g| g.is_some()).unwrap_or(false);
        let nodes = self.inner.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("PresenceTable")
            .field("app", &self.app)
            .field("nodes", &nodes)
            .field("has_plain_handler", &has_plain)
            .finish()
    }
}

impl PresenceTable {
    /// `app` 必须与 [`super::PresenceStart::app`] 一致——`spawn` 里那份是
    /// 广播包的标识，这份是收包时的判据，两者对不上就会自己拒自己。
    pub fn new(app: PresenceApp) -> Self {
        Self {
            app,
            inner: Mutex::new(HashMap::new()),
            plain: Mutex::new(None),
        }
    }

    /// 注册明文包的处理器（A3：远程电脑用它接「附近设备」与 6 位数字配对）。
    ///
    /// 后注册的覆盖先注册的——同一套 presence 同时只该有一个消费方。
    pub fn on_plain(&self, f: PlainHandler) {
        *self.plain.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// 把 [`Heard::Plain`] 交给处理器。返回「有没有人接」——
    /// 没人接时调用方留一条 debug（规则 #15.3：静默丢弃比报错难查一个量级）。
    pub fn dispatch_plain(&self, p: &PlainPacket) -> bool {
        let f = self.plain.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match f {
            Some(f) => {
                f(p);
                true
            }
            None => false,
        }
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
    /// 用途标识（`app`）的判定排在**验签之后**，理由写在下面那一处。
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
        // 🔴 明文那几种（招呼 / 配对握手）**在 `is_paired` 之前**分走。
        //   顺序在这里是语义，不只是性能：附近设备按定义就是还没配对的邻居，
        //   若先过 `is_paired`，它们会全部落进 `Heard::Unpaired` 而消失。
        if wire.kind.is_plain() {
            return self.hear_plain(&wire, src_ip, now_ms);
        }
        if !is_paired(&wire.node_id) {
            return Heard::Unpaired {
                node_id: wire.node_id,
            };
        }
        let Ok(sig) = super::wire::decode_sig(&wire.sig) else {
            return Heard::Bad("公告里的签名解不开".to_string());
        };
        if let Err(e) = crate::sync::identity::verify(
            &wire.node_id,
            &super::wire::signing_bytes(&wire.node_id, wire.port, wire.ts),
            &sig,
        ) {
            return Heard::Bad(format!("公告签名校验不通过：{}", e));
        }

        // 🔴 用途标识（2026-09-17 加）。放在**验签之后**是刻意的：这样只有持
        //   合法私钥的已配对设备才可能把这条判定的日志打出来，同网段任何人乱发
        //   包都刷不了我们的日志（规则 #15.3 的前提是这条日志本身可信）。
        let legacy = match wire.app {
            Some(a) if a != self.app => return Heard::WrongApp { claimed: a },
            Some(_) => false,
            // 旧版本的包没有这个字段。**按旧口径收下**，不拒：旧对端的 kb 公告
            // 同样是 None，拒掉就等于把它的知识库同步也一起打到中继上——
            // 为了一个新字段引入一个新的退化，不划算。调用方拿到 `legacy`
            // 之后会在日志里提示一次「这台对端该升级了」。
            None => true,
        };

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
        // ❗ 必须在下面刷新 `seen` **之前**算：刷完之后永远是「新鲜」，跃变就测不到了。
        let was_live = entry.addrs.iter().any(|(_, s)| now_ms - *s <= STALE_MS);
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
            returned: !was_live,
            legacy,
        }
    }

    /// 明文包（招呼 / 配对握手）的校验。
    ///
    /// 🔴 与地址公告分家的第一条就是**不查 `is_paired`**。那一关留在地址表那条路上，
    /// 因为那条路是「同网段任何人乱发都能把表灌满」的唯一入口；明文包一个字都不入表，
    /// 所以没有这个口子——它改成「表本身有上限 + TTL」（见 [`super::Nearby`]）。
    ///
    /// 顺序沿用 [`PresenceTable::hear`] 那套：便宜的先做、验签在动任何状态之前，
    /// **用途标识（`app`）排在验签之后**（同一条理由：只有持合法私钥的设备
    /// 才可能把这条判定的日志打出来，同网段乱发的人刷不了我们的日志）。
    fn hear_plain(&self, wire: &Wire, src_ip: IpAddr, now_ms: i64) -> Heard {
        let Ok(sig) = decode_sig(&wire.sig) else {
            return Heard::Bad("明文包里的签名解不开".to_string());
        };
        if let Err(e) = crate::sync::identity::verify(
            &wire.node_id,
            &super::wire::signing_bytes(&wire.node_id, wire.port, wire.ts),
            &sig,
        ) {
            return Heard::Bad(format!("明文包签名校验不通过：{}", e));
        }
        match wire.app {
            Some(a) if a != self.app => return Heard::WrongApp { claimed: a },
            // 明文包是本版新增的，正常一定带 `app`。`None` 只可能来自
            // 「中间人抹掉了这个字段」——拒掉，因为把一份用途不明的包当本套收下，
            // 正是 09-17 那次串台污染的老路。旧版本的对端根本不发明文包，
            // 所以这里不会误伤升级过渡期。
            None => return Heard::Bad("明文包没有用途标识，不知该交给哪一套".to_string()),
            Some(_) => {}
        }
        let skew = now_ms - wire.ts;
        if skew.abs() > CLOCK_WINDOW_MS {
            return Heard::OutOfWindow {
                node_id: wire.node_id.clone(),
                skew_ms: skew,
            };
        }
        // ❗ 明文包**不做**「时间戳严格递增」的重放检查：那个检查要读改写表状态，
        //   而这里刻意不碰表。配对会话本身有 60 秒有效期（`rc/pin.rs`），
        //   重放一份过期会话里的握手包，对方那边早就没有对应会话了。
        Heard::Plain(PlainPacket {
            kind: wire.kind,
            node_id: wire.node_id.clone(),
            name: wire.name.as_deref().map(clean_name).unwrap_or_default(),
            pk: wire.pk.clone().unwrap_or_default(),
            to_id: wire.to_id.clone().unwrap_or_default(),
            ts: wire.ts,
            // IP 取源地址（同地址公告那条路上的一条铁律），端口取包里自报的
            // **端点**端口——两者合起来是对端自报的可达地址。
            src: SocketAddr::new(src_ip, wire.port),
        })
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
