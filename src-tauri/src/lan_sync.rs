use crate::data_store::{compute_pinyin_initials, DataStore, HistoryItem, TimeBump};
// 内容 md5 走共享实现：原先本文件自己拄了一份 `md5_hex`，注释写着“与
// clipboard_monitor::md5_hex 同口径”——但那只是注释承诺。智能合并完全依赖
// 两边真的算出同一个值，不一致就会堆重复记录。
use crate::hashing::content_md5;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MULTICAST_GROUP: std::net::Ipv4Addr = std::net::Ipv4Addr::new(224, 1, 1, 1);
const MULTICAST_PORT: u16 = 5007;
/// 图片通过 LAN 同步的最大文件大小 (2MB)
const MAX_IMAGE_SIZE_LAN: u64 = 2 * 1024 * 1024;
/// 单条局域网消息允许的最大原始负载大小 (20MB)，超过则在解析/解码前直接丢弃，
/// 防止恶意或畸形数据包耗尽 CPU/内存/磁盘资源
const MAX_LAN_MESSAGE_BYTES: usize = 20 * 1024 * 1024;
/// 重放防护窗口（秒）：时间戳偏差超过此值的消息直接丢弃（修复 M12）
const REPLAY_WINDOW_SECS: i64 = 120;
/// 重放防护 nonce 缓存上限（按时间戳清理，防止无界增长）
const REPLAY_CACHE_MAX: usize = 2048;

/// v2 线上格式：AES-256-GCM 加密信封（修复 C2 明文广播 / M13 自研 MAC）。
/// 旧版 v1 为明文 JSON + MD5 三明治签名，已废弃：同 LAN 任意主机可被动嗅探全部内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanEnvelope {
    /// 协议版本，固定 2
    v: u8,
    /// 96-bit 随机 nonce（hex，24 字符）：每条消息唯一，同时用于 GCM 与重放防护
    nonce: String,
    /// 密文 + GCM 认证标签（base64）。认证标签提供完整性与来源认证，
    /// 只有持有相同配对密钥的设备才能解密与验证
    ct: String,
}

/// 内层明文消息（仅持有配对密钥的设备可见）
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanMessage {
    #[serde(rename = "type")]
    msg_type: String,
    /// 剪贴板条目类型: "text" / "image" / "file"
    item_type: String,
    text: String,
    /// 图片 base64 数据（仅 image 类型）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    image_base64: String,
    device_id: String,
    device_name: String,
    /// Unix 时间戳（秒），参与加密内层，接收方校验时间窗口防重放
    ts: i64,
}

/// 生成一个新的随机配对密钥：16 字节，hex 编码为 32 位字符串
/// （直接复用已有的 uuid 依赖，避免引入新的随机数 crate）
pub fn generate_pairing_key() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 配对密钥强度校验（修复 M14）：拒绝过短、超长、单一字符重复等弱密钥。
/// 旧协议下可设置 "1" 这类密钥被离线爆破；新协议密钥直接派生 AES 密钥，必须保证强度。
pub fn validate_pairing_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.len() < 16 {
        return Err("配对密钥至少需要 16 个字符，请使用应用生成的密钥或从另一台设备完整复制".to_string());
    }
    if key.len() > 128 {
        return Err("配对密钥不能超过 128 个字符".to_string());
    }
    if let Some(first) = key.chars().next() {
        if key.chars().all(|c| c == first) {
            return Err("配对密钥不能由单一重复字符组成".to_string());
        }
    }
    Ok(())
}

// ===== 组播收发：逐块网卡 =====

/// 本机所有可用于组播收发的 IPv4 网卡地址。
///
/// # 🔴 为什么必须逐块列出，而不能图省事用 `INADDR_ANY`
///
/// `Ipv4Addr::UNSPECIFIED` 在组播语境下**不是「所有网卡」**，
/// 而是「让系统按路由表挑一块」。装了 VMware / VirtualBox / Hyper-V /
/// WSL / Docker / VPN 的机器上（现在相当常见），挑中的经常是**虚拟网卡**——于是：
///   · 发出去的组播包压根没上真实局域网
///   · 加入组播组也加在了虚拟网卡上，收不到真实局域网的包
/// 两台同网段的机器就此互相看不见，**而且不报任何错**。
/// 这正是 2026-09-06「发送测试消息两台电脑互相发现不了」的根因。
fn enumerate_ifaces() -> Vec<std::net::Ipv4Addr> {
    let addrs: Vec<std::net::Ipv4Addr> = netdev::get_interfaces()
        .into_iter()
        .filter(|i| i.is_up() && !i.is_loopback())
        .flat_map(|i| i.ipv4.into_iter().map(|n| n.addr()))
        .filter(|a| !a.is_loopback() && !a.is_unspecified())
        .collect();
    if addrs.is_empty() {
        // 一块都枚举不到时退回旧行为：宁可只走系统默认那块，也好过一个包都不发
        log::warn!("[LanSync] 没枚举到可用的 IPv4 网卡，退回系统默认网卡");
        return vec![std::net::Ipv4Addr::UNSPECIFIED];
    }
    addrs
}

/// 网卡列表缓存：`(枚举时刻, 地址表)`。
static IFACE_CACHE: Mutex<Option<(i64, Vec<std::net::Ipv4Addr>)>> = Mutex::new(None);

/// 缓存存活秒数。
const IFACE_CACHE_SECS: i64 = 30;

/// 本机可用于组播收发的 IPv4 网卡地址（带缓存）。
///
/// # 🔴 为什么要缓存
///
/// `netdev::get_interfaces()` **不便宜**：它默认带 `gateway` feature，
/// 除了 `GetAdaptersAddresses` 还要去解析每块网卡的网关。而组播发送在
/// 招呼包心跳上是**每 5 秒一次**，再加上每条消息一次——把枚举硬件
/// 放在这条路径上是纯浪费（规则 #8）。
///
/// 网卡变动是低频事件（插拔网线、切 Wi-Fi、连 VPN），缓存 30 秒足够新鲜：
/// 最坏情况是切网络后 30 秒内发不出去，而对端的招呼包本来就是 5 秒一发，
/// 发现延迟本就在秒级。
///
/// ❗ 监听侧的 join 只在启动时跑一次，不受缓存影响。
fn multicast_ifaces() -> Vec<std::net::Ipv4Addr> {
    let now = chrono::Utc::now().timestamp();
    if let Ok(g) = IFACE_CACHE.lock() {
        if let Some((at, list)) = g.as_ref() {
            if now - *at < IFACE_CACHE_SECS {
                return list.clone();
            }
        }
    }
    let addrs = enumerate_ifaces();
    if let Ok(mut g) = IFACE_CACHE.lock() {
        *g = Some((now, addrs.clone()));
    }
    addrs
}

/// 经指定网卡发一份组播包。
fn send_via_iface(ifaddr: &std::net::Ipv4Addr, payload: &[u8]) -> std::io::Result<()> {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::net::{SocketAddr, SocketAddrV4};

    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // 🔴 这一行是关键：不设它，包就从系统按路由表挑的那块网卡出去。
    sock.set_multicast_if_v4(ifaddr)?;
    // ❗ 组播 TTL 不是 `set_ttl`：那个设的是 `IP_TTL`，组播看的是 `IP_MULTICAST_TTL`。
    //   旧代码写的 `set_ttl(2)` 对组播**从来没生效过**，组播 TTL 一直是默认的 1。
    //   同网段仍能通，所以一直没被发现——但代码里写的「跨一跳」意图从未成立。
    sock.set_multicast_ttl_v4(2)?;
    sock.bind(&SockAddr::from(SocketAddr::from(SocketAddrV4::new(
        *ifaddr, 0,
    ))))?;
    sock.send_to(
        payload,
        &SockAddr::from(SocketAddr::from(SocketAddrV4::new(
            MULTICAST_GROUP,
            MULTICAST_PORT,
        ))),
    )?;
    Ok(())
}

/// 往**每一块**网卡各发一份组播包。
///
/// 收口三处重复（招呼包 / 握手包 / 加密消息），它们原先各写了一遍
/// 「bind 0.0.0.0:0 → set_ttl → send_to」（规则 #11）。
///
/// 单块网卡失败只记 debug：虚拟网卡发不出去是常态，逐块 warn 会刷屏。
/// 但**一块都没发出去**是真问题，必须记下来（规则 #15.3）。
fn send_multicast(payload: &[u8], what: &str) {
    let mut sent = 0usize;
    for ifaddr in multicast_ifaces() {
        match send_via_iface(&ifaddr, payload) {
            Ok(()) => sent += 1,
            Err(e) => log::debug!("[LanSync] 经网卡 {} 发送{}失败: {}", ifaddr, what, e),
        }
    }
    if sent == 0 {
        log::warn!("[LanSync] {}没能从任何一块网卡发出去", what);
    }
}

/// 配置里存配对密钥的键。
pub const CFG_PAIRING_KEY: &str = "lan_pairing_key";

/// 启用一把配对密钥：**同时**写配置与写内存。
///
/// # 🔴 两件事必须一起做，少一件都是一个真 bug
///
/// - 只写内存 → 配对当时好用、**重启就失效**（启动时从配置读的还是旧密钥，见 `lib.rs` 的 setup）
/// - 只写配置 → 当前会话仍用旧密钥，要重启才生效
///
/// 收成一个函数是因为这件事有**三个**入口（规则 #11）：手动粘密钥、重新生成、
/// 以及「附近设备一键配对」。而 2026-09-06 的真实反馈正是第三个入口漏了落盘：
/// `handle_pair_packet` 是监听线程里的自由函数，当时的签名里根本拿不到 `DataStore`——
/// 不是有人忘了写一行，是那条路径压根没有落盘的能力。
pub fn apply_pairing_key(app: &AppHandle, key: &str) -> Result<(), String> {
    let key = key.trim();
    validate_pairing_key(key)?;

    let store = app
        .try_state::<DataStore>()
        .ok_or("数据库还没就绪，配对密钥没能保存")?;
    let mut config = store.get_config()?;
    // ❗ 不能 `if let Some(..)` 了事：配置不是对象时会静默跳过写入，
    //   而 `save_config` 照样返回 Ok（规则 #15.3）。
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象，配对密钥没能保存")?;
    obj.insert(
        CFG_PAIRING_KEY.to_string(),
        serde_json::Value::String(key.to_string()),
    );
    store.save_config(&config)?;

    if let Some(lan) = app.try_state::<LanSync>() {
        lan.set_pairing_key(key.to_string());
    }
    Ok(())
}

// ===== 记住的设备名单（持久化）=====

/// 配置里存「记住的设备」名单的键。
pub const CFG_PAIRED_DEVICES: &str = "lan_paired_devices";

/// 一台记住的设备。
///
/// # 🔴 只持久化身份，不持久化在线状态
///
/// `last_seen` 每收到一个包就变，写进配置等于每同步一次剪贴板就写一次盘。
/// 在不在线是**运行期**的事，留在内存那张表（[`LanSync::devices`]）里。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairedDevice {
    pub device_id: String,
    pub device_name: String,
    /// 首次记住的时刻（epoch 秒）。
    pub paired_at: i64,
}

/// 读「记住的设备」名单。读不到就当空——这是展示用数据，不值得让整个面板报错。
pub fn load_paired(app: &AppHandle) -> Vec<PairedDevice> {
    let Some(store) = app.try_state::<DataStore>() else {
        return Vec::new();
    };
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(CFG_PAIRED_DEVICES).cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn save_paired(app: &AppHandle, list: &[PairedDevice]) -> Result<(), String> {
    let store = app
        .try_state::<DataStore>()
        .ok_or("数据库还没就绪，设备名单没能保存")?;
    let mut config = store.get_config()?;
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象，设备名单没能保存")?;
    obj.insert(
        CFG_PAIRED_DEVICES.to_string(),
        serde_json::to_value(list).map_err(|e| e.to_string())?,
    );
    store.save_config(&config)
}

/// 记住一台设备（已存在就只在名字变了时更新）。
///
/// ❗ 这个函数在**每收到一条对端加密消息**时都会被调用，所以
/// **没变化就一个字节都不写**——否则每同步一次剪贴板就写一次配置。
pub fn remember_device(app: &AppHandle, device_id: &str, device_name: &str) {
    if device_id.is_empty() {
        return;
    }
    let mut list = load_paired(app);
    match list.iter_mut().find(|d| d.device_id == device_id) {
        // 名字也没变 → 什么都不做
        Some(d) if d.device_name == device_name => return,
        Some(d) => d.device_name = device_name.to_string(),
        None => list.push(PairedDevice {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            paired_at: chrono::Utc::now().timestamp(),
        }),
    }
    if let Err(e) = save_paired(app, &list) {
        log::warn!("[LanSync] 记住设备 {} 失败：{}", device_id, e);
    }
}

/// 忘记一台设备。返回「原本在不在名单里」。
///
/// # 🔴 它只清本机记录，**不吊销配对密钥**
///
/// 局域网同步是**单一群组密钥**模型：[`LanSync`] 只有一把 `pairing_key`，
/// 谁拿到谁就能解密。所以忘记之后对方**仍然能解开本机的广播**，
/// 只是本机不再把它当成已知设备（于是它会重新出现在「附近的设备」里，可以重新配对）。
///
/// 要真正踢掉一台设备只能重新生成密钥，而那会把**所有**设备一起踢掉。
/// 界面上必须把这件事说清楚，否则用户会以为点了「忘记」就断开了。
pub fn forget_device(app: &AppHandle, device_id: &str) -> Result<bool, String> {
    let mut list = load_paired(app);
    let before = list.len();
    list.retain(|d| d.device_id != device_id);
    if list.len() == before {
        return Ok(false);
    }
    save_paired(app, &list)?;
    Ok(true)
}

/// 密钥派生：配对密钥 → SHA-256 → 32 字节 AES-256 密钥
fn derive_aes_key(pairing_key: &str) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, pairing_key.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// hex → 12 字节 nonce。
///
/// 🔴 2026-09-06 修一个**远程可触发的 panic**：原实现先判 `s.len() != 24`
/// （字节长）再用 `&s[i*2..i*2+2]` 切片。传一串 8 个汉字（恰好 24 字节）
/// 就能过长度检查、然后切在字符中间 panic。而 `nonce` 直接来自 UDP 包的
/// `LanEnvelope`，完全由对方控制 —— 足以把监听线程打挂、局域网同步停止工作。
///
/// 现在收口到 [`crate::lan_pair::hex_to_12`]，它按字节解析，任何输入都不会 panic。
fn hex_decode_12(s: &str) -> Result<[u8; 12], String> {
    crate::lan_pair::hex_to_12(s).ok_or_else(|| "nonce 编码无效".to_string())
}

/// 将内层消息加密封装为 v2 信封（AES-256-GCM，nonce 由调用方生成）
fn seal_message(
    pairing_key: &str,
    inner_json: &str,
    nonce_bytes: &[u8; 12],
) -> Result<String, String> {
    use ring::aead;

    let key_bytes = derive_aes_key(pairing_key);
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map_err(|_| "创建加密密钥失败".to_string())?;
    let sealing_key = aead::LessSafeKey::new(unbound);

    let nonce = aead::Nonce::assume_unique_for_key(*nonce_bytes);
    let mut in_out = inner_json.as_bytes().to_vec();
    sealing_key
        .seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut in_out)
        .map_err(|_| "加密失败".to_string())?;

    let envelope = LanEnvelope {
        v: 2,
        nonce: hex_encode(nonce_bytes),
        ct: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &in_out),
    };
    serde_json::to_string(&envelope).map_err(|e| format!("序列化信封失败: {}", e))
}

/// 解密并验证 v2 信封，返回内层消息与 nonce。
/// GCM 认证标签保证：密钥不匹配、密文被篡改、字段被替换都会解密失败（Err）。
fn open_message(pairing_key: &str, envelope_json: &str) -> Result<(LanMessage, String), String> {
    use ring::aead;

    let envelope: LanEnvelope =
        serde_json::from_str(envelope_json).map_err(|e| format!("非 v2 信封格式: {}", e))?;
    if envelope.v != 2 {
        return Err(format!("不支持的协议版本: {}", envelope.v));
    }

    let nonce_bytes = hex_decode_12(&envelope.nonce)?;
    let mut ct = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &envelope.ct)
        .map_err(|e| format!("密文解码失败: {}", e))?;

    let key_bytes = derive_aes_key(pairing_key);
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map_err(|_| "创建解密密钥失败".to_string())?;
    let opening_key = aead::LessSafeKey::new(unbound);

    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);
    let plaintext = opening_key
        .open_in_place(nonce, aead::Aad::empty(), &mut ct)
        .map_err(|_| "解密校验失败（密钥不匹配或消息被篡改）".to_string())?;

    let msg: LanMessage =
        serde_json::from_slice(plaintext).map_err(|e| format!("内层消息解析失败: {}", e))?;
    Ok((msg, envelope.nonce))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanDevice {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: String,
}

// ===== 附近设备配对：包的收发与握手状态机 =====
//
// 这几个写成**自由函数**而不是 `LanSync` 的方法：监听线程拿不到 `&self`
// （它 move 进去的只有几个 Arc 克隆），写成方法就得把整个 `LanSync` 克隆进线程。

/// 广播一次招呼包（让未配对的设备看得见本机）。
///
/// ❗ 写成自由函数而不是 `LanSync` 的方法：唯一的调用方是那个
/// 脱离 `&self` 跑的广播线程。之前两边各写了一份，方法那份没人调、
/// 被 dead_code 警告逮到——同一件事只留一处。
fn send_hello(device_id: &str) {
    let name = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "未知设备".to_string());
    send_pair_raw(&crate::lan_pair::PairPacket::hello(
        device_id,
        &name,
        chrono::Utc::now().timestamp(),
    ));
}

/// 发一个明文握手包。与 [`LanSync::send_pair_packet`] 同逻辑，供线程内使用。
fn send_pair_raw(p: &crate::lan_pair::PairPacket) {
    let Ok(json) = serde_json::to_string(p) else {
        log::warn!("[LanPair] 序列化握手包失败");
        return;
    };
    send_multicast(json.as_bytes(), "握手包");
}

/// 试着把一包当握手包解。
///
/// ❗ 加密信封与握手包**都是 JSON**，所以不能光看能不能解成 JSON，
/// 必须卡 `kind` 字段以 `pp-` 开头。否则会把加密包误当握手包吃掉。
fn try_parse_pair(text: &str) -> Option<crate::lan_pair::PairPacket> {
    let p: crate::lan_pair::PairPacket = serde_json::from_str(text).ok()?;
    if p.kind.starts_with("pp-") {
        Some(p)
    } else {
        None
    }
}

/// 握手状态机。四种包各走一支。
///
/// 🔴 这里所有输入都**不可信**（明文、可伪造）。真正的安全靠两处：
/// ① 用户肉眼核对两端 pin 一致；② `pp-pair-key` 的 GCM 认证（共享值不对就解不开）。
fn handle_pair_packet(
    p: &crate::lan_pair::PairPacket,
    self_id: &str,
    pair: &std::sync::Arc<crate::lan_pair::PairState>,
    pairing_key: &Arc<Mutex<String>>,
    // 🔴 接受对方密钥时要落盘，而落盘要经由 `DataStore`（只能从 AppHandle 取）。
    //   之前这个签名里没有它，所以那条路径只能写内存——配对完当时好用、重启就失效。
    app: &AppHandle,
) {
    use crate::lan_pair::{PairPacket, PairRole, KIND_HELLO, KIND_KEY, KIND_REQ, KIND_RESP};

    let now = chrono::Utc::now().timestamp();
    if p.from_id == self_id {
        return; // 组播会回环，自己发的不处理
    }

    match p.kind.as_str() {
        KIND_HELLO => pair.on_hello(p, self_id, now),

        // 对方想跟我配对：开一个 Responder 会话，回自己的公钥。
        // 弹框交给前端轮询 `snapshot` 发现。
        KIND_REQ if p.to_id == self_id => {
            if pair.is_blocked(&p.from_id) {
                log::info!("[LanPair] 已拉黑的对端再次请求，忽略");
                return;
            }
            match crate::lan_pair::PendingPair::start(
                &p.from_id,
                &p.from_name,
                PairRole::Responder,
                now,
            ) {
                Ok(mut pending) => {
                    if let Err(e) = pending.accept_peer_key(&p.pk) {
                        log::warn!("[LanPair] 协商失败: {}", e);
                        return;
                    }
                    let my_pk = pending.my_pk.clone();
                    pair.begin(pending);
                    send_pair_raw(&PairPacket {
                        v: crate::lan_pair::PAIR_PROTO_V,
                        kind: KIND_RESP.into(),
                        from_id: self_id.into(),
                        from_name: String::new(),
                        to_id: p.from_id.clone(),
                        pk: my_pk,
                        nonce: String::new(),
                        sealed: String::new(),
                        ts: now,
                    });
                }
                Err(e) => log::warn!("[LanPair] 开会话失败: {}", e),
            }
        }

        // 对方回了公钥：完成协商，两端现在都能算出 pin 了。
        KIND_RESP if p.to_id == self_id => {
            let r = pair.with_pending(now, |pending| {
                if pending.peer_id != p.from_id {
                    return Err("应答来自另一台设备，忽略".to_string());
                }
                pending.accept_peer_key(&p.pk)
            });
            if let Some(Err(e)) = r {
                log::warn!("[LanPair] 处理应答失败: {}", e);
            }
        }

        // 对方把配对密钥送来了：解开、存下。
        //
        // ❗ 必须确认本端已经确认过（`confirmed`）才能收——
        // 否则对方单方面点一下就能换掉我的密钥，那道核对门就白设了。
        KIND_KEY if p.to_id == self_id => {
            let shared = pair.with_pending(now, |pending| {
                if pending.peer_id != p.from_id {
                    return None;
                }
                if !pending.confirmed {
                    log::warn!("[LanPair] 本端尚未确认，拒收对方送来的密钥");
                    return None;
                }
                pending.shared.clone()
            });
            let Some(Some(shared)) = shared else { return };

            match crate::lan_pair::open_pairing_key(&shared, &p.nonce, &p.sealed) {
                Ok(key) => {
                    if let Err(e) = crate::lan_sync::validate_pairing_key(&key) {
                        log::warn!("[LanPair] 对方送来的密钥不合格: {}", e);
                        return;
                    }
                    crate::secret_registry::register(
                        crate::secret_registry::SLOT_LAN_PAIRING,
                        &key,
                    );
                    // 🔴 必须落盘，否则重启后从配置读回的还是旧密钥，配对关系整个丢失。
                    //   失败也要把内存那份写上（下面的 fallback）：本次会话至少能用，
                    //   但得把「重启后会失效」这件事明确记下来，不静默（规则 #15.3）。
                    if let Err(e) = crate::lan_sync::apply_pairing_key(app, &key) {
                        log::warn!(
                            "[LanPair] 配对密钥没能写进配置（{}）——本次会话可用，但重启后需要重新配对",
                            e
                        );
                        if let Ok(mut g) = pairing_key.lock() {
                            *g = key;
                        }
                    }
                    pair.clear();
                    log::info!("[LanPair] 配对完成，已接受对方的配对密钥");
                }
                // 解不开 = 共享值不对 = 中间人或乱包。不静默，记下来。
                Err(e) => log::warn!("[LanPair] {}", e),
            }
        }

        _ => {}
    }
}

pub struct LanSync {
    running: Arc<AtomicBool>,
    device_id: String,
    pairing_key: Arc<Mutex<String>>,
    pub devices: Arc<Mutex<HashMap<String, LanDevice>>>,
    /// 重放防护：近期已见 nonce → 接收时间戳（修复 M12）
    seen_nonces: Arc<Mutex<HashMap<String, i64>>>,
    /// 附近设备发现与配对握手的状态（见 [`crate::lan_pair`]）。
    pair: Arc<crate::lan_pair::PairState>,
}

impl LanSync {
    pub fn new(device_id: String, pairing_key: String) -> Self {
        // 登记哈希：配对密钥在设置页是个 readOnly 输入框，用户选中后按 Ctrl+C
        // 是**系统级复制**，剪贴板监听会把它明文记进历史（开了局域网同步
        // 还会同步到其他设备）。登记放在 `new` 与 `set_pairing_key` 两处而不是
        // 命令层：命令层有三个入口，漏一个就是静默泄露。
        crate::secret_registry::register(crate::secret_registry::SLOT_LAN_PAIRING, &pairing_key);
        Self {
            running: Arc::new(AtomicBool::new(false)),
            device_id,
            pairing_key: Arc::new(Mutex::new(pairing_key)),
            devices: Arc::new(Mutex::new(HashMap::new())),
            seen_nonces: Arc::new(Mutex::new(HashMap::new())),
            pair: crate::lan_pair::PairState::new(),
        }
    }

    /// 本机 device_id。握手包要用它分辨“这包是不是发给我的”。
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 配对状态（附近设备表 / 进行中的握手）。
    pub fn pair(&self) -> Arc<crate::lan_pair::PairState> {
        self.pair.clone()
    }

    /// 监听线程是否在跑。
    ///
    /// ❗ 它会在「端口被占」或「一块网卡都没能加入组播组」时自己变回 false，
    /// 所以它跟配置里那个开关不是一回事，界面上要分开显示。
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 从运行期在线表里拿掉一台设备。
    ///
    /// ❗ 忘记设备时要一并做，否则它还会显示「在线」。
    pub fn drop_device(&self, device_id: &str) {
        if let Ok(mut d) = self.devices.lock() {
            d.remove(device_id);
        }
    }

    /// 发一个**明文**握手包（招呼 / 请求 / 应答 / 密钥投递）。
    ///
    /// ❗ 走与加密广播同一个组播地址，接收端靠 `kind` 字段分流。
    /// 内容不加密是**故意的**：未配对的两台机器没有共同密钥，
    /// 加了就回到“彼此隐形”的原点。包里唯一的机密是 `sealed`，那一项已单独加密。
    pub fn send_pair_packet(&self, p: &crate::lan_pair::PairPacket) {
        let Ok(json) = serde_json::to_string(p) else {
            log::warn!("[LanPair] 序列化握手包失败");
            return;
        };
        send_multicast(json.as_bytes(), "握手包");
    }

    /// 获取已发现的设备列表
    pub fn get_devices(&self) -> Vec<LanDevice> {
        self.devices
            .lock()
            .map(|d| d.values().cloned().collect())
            .unwrap_or_default()
    }

    /// 获取当前配对密钥（用于在设置面板中展示，供用户手动同步到其他设备）
    pub fn get_pairing_key(&self) -> String {
        self.pairing_key.lock().map(|k| k.clone()).unwrap_or_default()
    }

    /// 更新运行时使用的配对密钥（持久化由调用方负责）
    pub fn set_pairing_key(&self, key: String) {
        // 覆盖登记（旧密钥的哈希同时失效）——理由同 `new`。
        crate::secret_registry::register(crate::secret_registry::SLOT_LAN_PAIRING, &key);
        if let Ok(mut guard) = self.pairing_key.lock() {
            *guard = key;
        }
    }

    /// 发送剪贴板文本到局域网
    pub fn send(&self, text: &str) {
        self.send_item("text", text, "");
    }

    /// 发送剪贴板条目（支持 text/image/file）— v2 加密协议
    pub fn send_item(&self, item_type: &str, text: &str, image_path: &str) {
        if text.is_empty() && image_path.is_empty() {
            return;
        }

        let mut image_base64 = String::new();

        // 图片类型：读取并编码为 base64
        if item_type == "image" && !image_path.is_empty() {
            match std::fs::metadata(image_path) {
                Ok(meta) if meta.len() <= MAX_IMAGE_SIZE_LAN => match std::fs::read(image_path) {
                    Ok(data) => {
                        image_base64 = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &data,
                        );
                        log::info!("[LanSync] 图片已编码 {}B", data.len());
                    }
                    Err(e) => {
                        log::warn!("[LanSync] 读取图片失败: {}", e);
                    }
                },
                Ok(meta) => {
                    log::warn!(
                        "[LanSync] 图片过大 ({}B > {}B)，跳过",
                        meta.len(),
                        MAX_IMAGE_SIZE_LAN
                    );
                }
                Err(e) => {
                    log::warn!("[LanSync] 获取图片元数据失败: {}", e);
                }
            }
        }

        let device_name = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "未知设备".to_string());
        let pairing_key = self.get_pairing_key();

        let msg = LanMessage {
            msg_type: "clipboard".to_string(),
            item_type: item_type.to_string(),
            text: text.to_string(),
            image_base64,
            device_id: self.device_id.clone(),
            device_name,
            ts: chrono::Utc::now().timestamp(),
        };

        let inner_json = match serde_json::to_string(&msg) {
            Ok(j) => j,
            Err(e) => {
                log::warn!("[LanSync] 序列化消息失败: {}", e);
                return;
            }
        };

        // 修复 C2：随机 96-bit nonce + AES-256-GCM 加密后再广播，
        // 同 LAN 主机即使加入组播组也只能看到密文
        use ring::rand::SecureRandom;
        let rng = ring::rand::SystemRandom::new();
        let mut nonce_bytes = [0u8; 12];
        if let Err(e) = rng.fill(&mut nonce_bytes) {
            log::warn!("[LanSync] 生成 nonce 失败: {}", e);
            return;
        }

        let wire = match seal_message(&pairing_key, &inner_json, &nonce_bytes) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[LanSync] 加密消息失败: {}", e);
                return;
            }
        };

        send_multicast(wire.as_bytes(), "加密消息");
    }

    /// 启动局域网监听线程
    pub fn start_listener(&self, app_handle: AppHandle) {
        // 与 ClipboardMonitor::start 一致的原子 CAS，防止并发启动双线程
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let running = self.running.clone();
        let device_id = self.device_id.clone();
        let devices = self.devices.clone();
        let pairing_key = self.pairing_key.clone();
        let seen_nonces = self.seen_nonces.clone();
        let pair = self.pair.clone();

        // 招呼包广播线程：让未配对的设备看得见本机。
        // ❗ 只在局域网同步开着时发（running 结束就停）——
        // 这是“设备名会被同网段看到”那个隐私代价的唯一闸门。
        {
            let running = running.clone();
            let hello_id = self.device_id.clone();
            std::thread::spawn(move || {
                while running.load(Ordering::SeqCst) {
                    send_hello(&hello_id);
                    std::thread::sleep(std::time::Duration::from_secs(
                        crate::lan_pair::HELLO_INTERVAL_SECS,
                    ));
                }
                log::info!("[LanPair] 招呼广播线程退出");
            });
        }

        std::thread::spawn(move || {
            log::info!("[LanSync] 监听线程启动");

            let socket = match UdpSocket::bind("0.0.0.0:5007") {
                Ok(s) => s,
                Err(e) => {
                    // 修复（同 C8 模式）：bind 失败必须复位 running，否则无法再次启动监听
                    log::warn!("[LanSync] 绑定端口 5007 失败 (可能被占用): {}", e);
                    running.store(false, Ordering::SeqCst);
                    return;
                }
            };

            // 🔴 逐块网卡加入组播组。旧代码用 `INADDR_ANY` 只加了系统挑的那一块，
            //   在有虚拟网卡的机器上经常加错（详见 `multicast_ifaces`）。
            let mut joined = 0usize;
            for ifaddr in multicast_ifaces() {
                match socket.join_multicast_v4(&MULTICAST_GROUP, &ifaddr) {
                    Ok(()) => joined += 1,
                    // 虚拟网卡加不进去是常态，逐块 warn 会刷屏
                    Err(e) => log::debug!("[LanSync] 网卡 {} 加入组播组失败: {}", ifaddr, e),
                }
            }
            if joined == 0 {
                // 🔴 一块都没加成 = 这个监听线程**永远收不到任何东西**。
                //   旧代码只 warn 一句就继续跑，界面显示「运行中」而功能是死的——
                //   用户看到的就是「没报错但就是发现不了」（规则 #15.3）。
                //   复位 running 后返回，开关会回到关态，用户至少能重试。
                log::error!("[LanSync] 没能在任何一块网卡上加入组播组，局域网发现不可用");
                running.store(false, Ordering::SeqCst);
                return;
            }
            log::info!("[LanSync] 已在 {} 块网卡上加入组播组", joined);
            if let Err(e) = socket.set_read_timeout(Some(std::time::Duration::from_secs(2))) {
                log::warn!("[LanSync] 设置读取超时失败: {}", e);
            }

            let mut buf = [0u8; 65536];
            while running.load(Ordering::SeqCst) {
                match socket.recv_from(&mut buf) {
                    Ok((len, _addr)) => {
                        // 消息大小上限：在解析/解码前直接丢弃超大数据包，防止资源耗尽
                        if len > MAX_LAN_MESSAGE_BYTES {
                            log::warn!(
                                "[LanSync] 收到超大数据包 ({}B > {}B)，已丢弃",
                                len,
                                MAX_LAN_MESSAGE_BYTES
                            );
                            continue;
                        }
                        let Ok(text) = std::str::from_utf8(&buf[..len]) else {
                            continue;
                        };

                        // 🔴 握手包必须在解密**之前**分流。它们是明文的，
                        // 走下面那条路会被当成「解不开的包」丢掉——而那正是
                        // 未配对设备彼此隐形的原因。
                        if let Some(p) = try_parse_pair(text) {
                            handle_pair_packet(&p, &device_id, &pair, &pairing_key, &app_handle);
                            continue;
                        }

                        // 修复 C2/M13：解密 + GCM 认证。密钥不匹配/被篡改/旧版明文消息
                        // 都会在此失败并丢弃 — 不再存在"明文可读、签名可伪造"的通道
                        let local_key =
                            pairing_key.lock().map(|k| k.clone()).unwrap_or_default();
                        let (msg, nonce) = match open_message(&local_key, text) {
                            Ok(r) => r,
                            Err(_) => {
                                log::warn!(
                                    "[LanSync] 消息解密/验证失败，已丢弃（未配对设备、旧版本或伪造消息）"
                                );
                                continue;
                            }
                        };

                        // 过滤自身消息
                        if msg.device_id == device_id {
                            continue;
                        }

                        // 修复 M12：重放防护 — 时间窗口 + nonce 去重。
                        // 旧协议无 nonce/timestamp，抓包后原样重发即可注入过时/误导内容
                        let now_ts = chrono::Utc::now().timestamp();
                        if (now_ts - msg.ts).abs() > REPLAY_WINDOW_SECS {
                            log::warn!(
                                "[LanSync] 消息时间戳超出窗口 ({}s)，按重放丢弃",
                                now_ts - msg.ts
                            );
                            continue;
                        }
                        {
                            // 安全相关锁：中毒时恢复而非 panic，避免重放防护永久失效
                            let mut seen =
                                seen_nonces.lock().unwrap_or_else(|p| p.into_inner());
                            if seen.len() >= REPLAY_CACHE_MAX {
                                seen.retain(|_, ts| (now_ts - *ts).abs() <= REPLAY_WINDOW_SECS * 2);
                            }
                            if seen.insert(nonce, now_ts).is_some() {
                                log::warn!("[LanSync] 重复 nonce，按重放攻击丢弃");
                                continue;
                            }
                        }

                        // 更新设备列表
                        {
                            let now = chrono::Local::now()
                                .format("%Y-%m-%d %H:%M:%S")
                                .to_string();
                            // 🔴 同时记进持久化名单。不记的话，重启后「已配对」就归零，
                            //   而且对方掉线后仍留在内存表里被当成已配对、被从附近设备里过滤掉，
                            //   于是「既看不见也配不回来」（2026-09-06 的真实反馈）。
                            //
                            // ❗ 先拿**内存表**卡一道，只在「本次运行头一回见到它」或「改名了」时
                            //   才去碰配置。`remember_device` 内部虽然也判了「没变化不写盘」，
                            //   但它得先 `get_config()` 才知道——而那是一次全表扫描 + JSON 解析，
                            //   还要抢数据库连接锁。放在每条消息上跑是浪费（规则 #8）。
                            let known = devices
                                .lock()
                                .ok()
                                .and_then(|d| d.get(&msg.device_id).map(|x| x.device_name.clone()));
                            if known.as_deref() != Some(msg.device_name.as_str()) {
                                remember_device(&app_handle, &msg.device_id, &msg.device_name);
                            }
                            if let Ok(mut devs) = devices.lock() {
                                devs.insert(
                                    msg.device_id.clone(),
                                    LanDevice {
                                        device_id: msg.device_id.clone(),
                                        device_name: msg.device_name.clone(),
                                        last_seen: now,
                                    },
                                );
                            }
                        }

                        // 根据类型处理
                        let now_str =
                            chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                        let source = format!("局域网: {}", msg.device_name);
                        let item_type = msg.item_type.clone();

                        let (final_text, content) = match item_type.as_str() {
                            "image" if !msg.image_base64.is_empty() => {
                                // 解码图片并保存到本地
                                match save_synced_image(&msg.image_base64, &app_handle) {
                                    Ok(path) => (
                                        format!("[图片同步] 来自 {}", msg.device_name),
                                        path,
                                    ),
                                    Err(e) => {
                                        log::warn!("[LanSync] 保存同步图片失败: {}", e);
                                        (format!("[图片同步失败] {}", e), String::new())
                                    }
                                }
                            }
                            "file" => {
                                // 与本地文件捕获格式一致：text=文件名, content=路径
                                let path = &msg.text;
                                let filename = std::path::Path::new(path)
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| path.clone());
                                (filename, path.clone())
                            }
                            _ => (msg.text.clone(), String::new()),
                        };

                        // 为文本类型计算拼音首字母，支持前端拼音搜索
                        let pinyin_initials = if item_type == "text" {
                            Some(compute_pinyin_initials(&final_text))
                        } else {
                            None
                        };

                        // 计算统一内容类型（与本地剪贴板使用相同的 classify() 路径），
                        // 同时保留 labels 供后续附加自动标签（修复：LAN 同步条目此前不打标签）
                        let (content_type, labels) = match item_type.as_str() {
                            "image" => (Some("image".to_string()), None),
                            "file" => (Some("file".to_string()), None),
                            _ => {
                                let labels = crate::content_classifier::ContentClassifier::new().classify(&final_text);
                                let ct = crate::content_classifier::ContentClassifier::content_type_from_labels(&labels).to_string();
                                (Some(ct), Some(labels))
                            }
                        };

                        // 智能合并：同步消息按内容 md5 去重——同一内容被多台设备连续广播、
                        // 或本机已存在相同内容时，只更新时间不新建（此前 LAN 同步完全不去重，
                        // md5 也存 None，收到几条广播就堆几条重复记录）
                        let sync_hash = content_md5(&final_text);
                        let store = app_handle.try_state::<DataStore>();
                        let mut merged = false;
                        if let Some(ref store) = store {
                            if let Ok(Some(existing)) =
                                store.find_latest_by_md5(&sync_hash, "默认", &item_type)
                            {
                                merged = true;
                                // 写入失败时不能 emit 新时间：那会让界面显示“刚刚”而 DB 里还是
                                // 旧时间，下次重载就跳回去。内容本身不会丢（那条记录本就存在），
                                // 所以仍然 merged/continue，只是不拿不存在的时间去骗前端。
                                let time_written =
                                    match store.update_history_time(&existing.id, &now_str, TimeBump::Recapture) {
                                        Err(e) => {
                                            log::warn!(
                                                "[LanSync] 更新重复同步记录时间失败: {}",
                                                e
                                            );
                                            false
                                        }
                                        Ok(_) => {
                                            log::info!(
                                                "[LanSync] 智能合并重复同步内容 (id={})",
                                                existing.id
                                            );
                                            true
                                        }
                                    };
                                let shown_time = if time_written {
                                    now_str.clone()
                                } else {
                                    existing.time.clone()
                                };
                                let updated_item = HistoryItem {
                                    time: shown_time,
                                    source: source.clone(),
                                    group_id: existing.group_id.clone(),
                                    ..existing
                                };
                                let _ = app_handle.emit(
                                    "clipboard-changed",
                                    serde_json::json!({ "item": updated_item }),
                                );
                            }
                        }
                        if merged {
                            continue;
                        }

                        let item = HistoryItem {
                            id: uuid::Uuid::new_v4().to_string(),
                            text: final_text,
                            time: now_str,
                            item_type,
                            content,
                            pinned: false,
                            source,
                            workspace: "默认".to_string(),
                            md5: Some(sync_hash),
                            pinyin_initials,
                            group_id: None,
                            source_icon: None,
                            content_type,
                            tags: Vec::new(),
                            ocr_text: None,
                        };

                        let history_id = item.id.clone();

                        if let Some(store) = app_handle.try_state::<DataStore>() {
                            if let Err(e) = store.insert_history(&item) {
                                log::error!("[LanSync] 插入同步记录失败: {}", e);
                            } else if let Some(ref labels) = labels {
                                // 附加自动标签（与本地捕获一致）：解析标签 ID → 写入 → 通知前端
                                if let Ok(tag_ids) = store.resolve_auto_tag_ids(labels) {
                                    if !tag_ids.is_empty() {
                                        if let Err(e) = store.add_history_tags(&history_id, &tag_ids) {
                                            log::warn!("[LanSync] 写入自动标签失败: {}", e);
                                        } else {
                                            log::info!("[LanSync] 自动分类: {:?} → {}", labels, history_id);
                                            let _ = app_handle.emit("tags-updated", serde_json::json!({
                                                "history_id": history_id,
                                                "tag_ids": tag_ids,
                                            }));
                                        }
                                    }
                                }
                            }
                        }

                        if let Err(e) = app_handle.emit(
                            "clipboard-changed",
                            crate::clipboard_monitor::ClipboardChanged { item },
                        ) {
                            log::warn!("[LanSync] 推送同步事件失败: {}", e);
                        }
                    }
                    // ❗ 上面给 socket 设了 2 秒读超时，所以“没收到包”是**常态**，不是错。
                    // 🔴 Windows 上读超时报的是 `TimedOut`（WSAETIMEDOUT / os error 10060），
                    // 不是 `WouldBlock`——只放过后者的话空闲时会每 2 秒刷一条 warn，
                    // 把真正的接收错误和配对握手日志全淹掉。
                    Err(ref e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        continue
                    }
                    Err(e) => {
                        log::warn!("[LanSync] 接收失败: {}", e);
                    }
                }
            }

            log::info!("[LanSync] 监听线程退出");
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// 将 base64 编码的图片保存到本地 images 目录，返回路径
fn save_synced_image(base64_data: &str, app_handle: &AppHandle) -> Result<String, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    if bytes.len() > MAX_LAN_MESSAGE_BYTES {
        return Err(format!(
            "解码后的图片数据过大 ({}B > {}B)，已拒绝写入",
            bytes.len(),
            MAX_LAN_MESSAGE_BYTES
        ));
    }

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {}", e))?;
    let images_dir = app_dir.join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;

    let file_name = format!("lan_{}.png", uuid::Uuid::new_v4());
    let file_path = images_dir.join(&file_name);

    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入图片文件失败: {}", e))?;

    Ok(file_path.to_str().unwrap_or("").to_string())
}
