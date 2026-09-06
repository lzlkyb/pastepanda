//! 局域网【附近设备配对】：免去手动交换 32 位密钥。
//!
//! 设计稿：`design/PastePanda-局域网同步-附近设备配对-设计稿.html`
//!
//! # 为什么以前看不见附近设备
//!
//! 广播包全是 AES-256-GCM 加密的，解不开就丢；而解密密钥就是配对密钥。
//! 于是「没交换密钥 = 彼此隐形」——发现被鉴权挡住了。
//! 本模块加一条**明文招呼包**（不含任何剪贴板数据）把这层撕开。
//!
//! # 🔴 6 位数字是【指纹】，不是【密钥】
//!
//! 直接把长密钥换成 6 位数字是错的：那只有 100 万种可能，抓一个密文包
//! 就能离线爆破（[`crate::lan_sync::validate_pairing_key`] 强制 ≥16 字符就是为了堵它）。
//!
//! 正确的用法是蓝牙 SSP / Signal 安全码那一套：真密钥由两端现场协商
//! （X25519，32 字节，**从不上网**），6 位数字只是那把密钥的摘要。
//! 中间人插足会让两端算出**不同**的共享值 → 两个数字对不上 → 用户当场发现。
//!
//! # 🔴 协商出的密钥只当【一次性信道】，不当广播密钥
//!
//! 现有架构是【所有设备共用同一把 `pairing_key`】，而 ECDH 算出的是
//! 【成对密钥】。若直接拿协商密钥当 AES key，A 同时连 B 和 C 时
//! 广播就不知道该用哪把。所以协商密钥只用来
//! **把发起方已有的 `pairing_key` 加密送过去**，共享密钥模型不变。
//!
//! # 🔴 为何是【每次临时密钥】而不是长期身份
//!
//! 最初我打算让招呼包带一把长期公钥，这样算 pin 不用额外往返。
//! 但 ring 的 `agreement` **只有 `EphemeralPrivateKey::generate()`**，
//! 没有从种子恢复的构造器，且 `agree_ephemeral` 会消耗私钥——
//! 它按设计就只支持一次性密钥。
//!
//! 而重新想一遍会发现：**我们根本不需要长期身份**。公钥只在配对
//! 那一瞬间有用，配完就再也用不到。所以改成握手时现生一对：
//! 零新依赖、不用持久化私钥（少一个泄露面）、而且每次配对都是全新密钥
//! （前向安全更强）。代价只是握手多一个包，局域网内是毫秒级。

use ring::agreement;
use ring::rand::SystemRandom;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 握手包的协议版。与 `LanEnvelope.v`（加密广播）分开计数。
pub const PAIR_PROTO_V: u32 = 3;

/// 招呼包广播间隔（秒）。跟现有设备列表轮询同节奏。
pub const HELLO_INTERVAL_SECS: u64 = 5;

/// 附近设备多久没听到就从列表里拿掉（秒）。
pub const NEARBY_TTL_SECS: i64 = 20;

/// 配对会话有效期（秒）。超时两端同时作废。
pub const PAIR_WINDOW_SECS: i64 = 60;

/// 同一对端连续被拒绝多少次后，本次进程内不再弹框。
pub const REJECT_LIMIT: u32 = 2;

pub const KIND_HELLO: &str = "pp-hello";
pub const KIND_REQ: &str = "pp-pair-req";
pub const KIND_RESP: &str = "pp-pair-resp";
pub const KIND_KEY: &str = "pp-pair-key";

/// 握手报文。四种包共用一个结构，靠 `kind` 分流。
///
/// ❗ 全部是**明文**，也全部**不可信**——任何人都能伪造。
/// 它们只负责“把两台机器牵到一起”；真正定对方是谁的是后续的 pin 核对。
/// 唯一带机密的是 `sealed`，而它已经加密。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairPacket {
    pub v: u32,
    pub kind: String,
    pub from_id: String,
    #[serde(default)]
    pub from_name: String,
    /// 定向包（req/resp/key）的目标；招呼包为空。
    #[serde(default)]
    pub to_id: String,
    /// 发送方本次会话的临时公钥（hex）。招呼包不带。
    #[serde(default)]
    pub pk: String,
    /// 仅 `pp-pair-key`：nonce（hex, 12 字节）
    #[serde(default)]
    pub nonce: String,
    /// 仅 `pp-pair-key`：密文 + GCM tag（hex）
    #[serde(default)]
    pub sealed: String,
    pub ts: i64,
}

impl PairPacket {
    pub fn hello(device_id: &str, device_name: &str, ts: i64) -> Self {
        Self {
            v: PAIR_PROTO_V,
            kind: KIND_HELLO.into(),
            from_id: device_id.into(),
            from_name: device_name.into(),
            to_id: String::new(),
            pk: String::new(),
            nonce: String::new(),
            sealed: String::new(),
            ts,
        }
    }
}

/// 附近的（尚未配对的）设备，给界面用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NearbyDevice {
    pub device_id: String,
    pub device_name: String,
    /// 最后一次听到的 unix 秒。
    pub last_seen: i64,
}

/// 本端在这次配对里扮演的角色。决定“谁把密钥送给谁”。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairRole {
    /// 发起方：确认后把**自己的** pairing_key 送出去。
    Initiator,
    /// 接受方：确认后等对方送密钥过来，收下并覆盖本机的。
    Responder,
}

/// 一次进行中的配对。
///
/// ❗ `my_priv` 是 `Option` 因为 `agree_ephemeral` 会**消耗**私钥，
/// 只能 `take()` 出来用一次。用完就只剩 `shared`。
pub struct PendingPair {
    pub peer_id: String,
    pub peer_name: String,
    pub role: PairRole,
    my_priv: Option<agreement::EphemeralPrivateKey>,
    /// 本端公钥（hex），发给对方用。
    pub my_pk: String,
    /// 协商出的共享值。拿到对方公钥后才有。
    pub shared: Option<Vec<u8>>,
    /// 两端核对用的 6 位数字。
    pub pin: String,
    /// 本端用户是否已点确认。
    pub confirmed: bool,
    pub started_at: i64,
}

impl PendingPair {
    /// 开一个会话：现生一对临时密钥。
    pub fn start(
        peer_id: &str,
        peer_name: &str,
        role: PairRole,
        now: i64,
    ) -> Result<Self, String> {
        let rng = SystemRandom::new();
        let my_priv = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng)
            .map_err(|_| "生成临时密钥失败".to_string())?;
        let my_pk = hex(
            my_priv
                .compute_public_key()
                .map_err(|_| "推导公钥失败".to_string())?
                .as_ref(),
        );
        Ok(Self {
            peer_id: peer_id.into(),
            peer_name: peer_name.into(),
            role,
            my_priv: Some(my_priv),
            my_pk,
            shared: None,
            pin: String::new(),
            confirmed: false,
            started_at: now,
        })
    }

    /// 收到对方公钥，完成协商并算出 pin。**只能调一次**。
    pub fn accept_peer_key(&mut self, peer_pk_hex: &str) -> Result<(), String> {
        let my_priv = self
            .my_priv
            .take()
            .ok_or_else(|| "本次配对已经协商过了".to_string())?;
        let peer = hex_to_vec(peer_pk_hex).ok_or_else(|| "对方公钥格式无效".to_string())?;
        let peer_pub = agreement::UnparsedPublicKey::new(&agreement::X25519, peer);
        let shared = agreement::agree_ephemeral(my_priv, &peer_pub, |m| m.to_vec())
            .map_err(|_| "密钥协商失败".to_string())?;
        self.pin = verify_pin(&shared);
        self.shared = Some(shared);
        Ok(())
    }

    pub fn expired(&self, now: i64) -> bool {
        now - self.started_at > PAIR_WINDOW_SECS
    }
}

/// HKDF-SHA256 派生 32 字节。`info` 就是分道的那把“钥匙”。
///
/// ❗ 同一个共享值要同时支撑 pin 与密钥传输两个用途，**必须分道**：
/// 不分的话 pin（会显示给人看，等于公开）就泄露了传输密钥的信息。
pub fn hkdf32(shared: &[u8], info: &str) -> [u8; 32] {
    let salt = ring::hkdf::Salt::new(ring::hkdf::HKDF_SHA256, b"pastepanda-lan-pair");
    let prk = salt.extract(shared);
    let infos = [info.as_bytes()];
    let okm = prk
        .expand(&infos, ring::hkdf::HKDF_SHA256)
        .expect("HKDF expand 不应失败（长度固定 32）");
    let mut out = [0u8; 32];
    okm.fill(&mut out).expect("HKDF fill 不应失败");
    out
}

/// 两端拿来肉眼核对的 6 位数字。
///
/// 🔴 它是**共享密钥的摘要**，不是密钥。中间人会让两端算出不同的
/// shared → 两个 pin 对不上 → 用户发现。他无法“凑”成一样，
/// 那等于对 HKDF 做原像攻击。
///
/// 固定补齐到 6 位（如 `007412`）——不补齐的话两端位数不同会让人误以为不一致。
pub fn verify_pin(shared: &[u8]) -> String {
    let d = hkdf32(shared, "pp-pair-verify");
    let n = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000;
    format!("{:06}", n)
}

/// 把发起方的 `pairing_key` 封进密文。返回（nonce_hex, sealed_hex）。
pub fn seal_pairing_key(shared: &[u8], pairing_key: &str) -> Result<(String, String), String> {
    use ring::aead;
    use ring::rand::SecureRandom;

    let key_bytes = hkdf32(shared, "pp-key-transfer");
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map_err(|_| "构造传输密钥失败".to_string())?;
    let key = aead::LessSafeKey::new(unbound);

    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成 nonce 失败".to_string())?;
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);

    let mut buf = pairing_key.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut buf)
        .map_err(|_| "加密配对密钥失败".to_string())?;

    Ok((hex(&nonce_bytes), hex(&buf)))
}

/// 解开对方送来的 `pairing_key`。
///
/// GCM 认证标签保证：共享值不对（= 被中间人换过公钥）就会解密失败，
/// 而不是静默得到一串垃圾。
pub fn open_pairing_key(shared: &[u8], nonce_hex: &str, sealed_hex: &str) -> Result<String, String> {
    use ring::aead;

    let nonce_bytes = hex_to_12(nonce_hex).ok_or_else(|| "nonce 格式无效".to_string())?;
    let mut buf = hex_to_vec(sealed_hex).ok_or_else(|| "密文格式无效".to_string())?;

    let key_bytes = hkdf32(shared, "pp-key-transfer");
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
        .map_err(|_| "构造传输密钥失败".to_string())?;
    let key = aead::LessSafeKey::new(unbound);
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);

    let plain = key
        .open_in_place(nonce, aead::Aad::empty(), &mut buf)
        .map_err(|_| "解密配对密钥失败（对方身份不匹配）".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|_| "配对密钥不是有效文本".to_string())
}

/// 附近设备表 + 进行中的配对 + 拒绝计数。
/// 由监听线程写、命令层读。
#[derive(Default)]
pub struct PairState {
    nearby: Mutex<HashMap<String, NearbyDevice>>,
    /// 同时只允许一个进行中的配对——两个 pin 同时弹出来，用户分不清谁是谁。
    pending: Mutex<Option<PendingPair>>,
    /// device_id → 被拒次数。达到 [`REJECT_LIMIT`] 后不再弹框。
    rejects: Mutex<HashMap<String, u32>>,
}

impl PairState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 收到招呼包。自己发的、时钟偏差太大的、格式不对的都不记。
    pub fn on_hello(&self, p: &PairPacket, self_id: &str, now: i64) {
        if p.from_id == self_id || p.from_id.is_empty() {
            return;
        }
        if (now - p.ts).abs() > NEARBY_TTL_SECS * 3 {
            return;
        }
        if let Ok(mut m) = self.nearby.lock() {
            m.insert(
                p.from_id.clone(),
                NearbyDevice {
                    device_id: p.from_id.clone(),
                    device_name: p.from_name.clone(),
                    last_seen: now,
                },
            );
        }
    }

    /// 列出附近设备（顺手清掉过期的）。`paired` 里的不再列——
    /// 已配对的设备在另一个列表里，两处都出现会让人以为没配上。
    pub fn list_nearby(&self, now: i64, paired: &[String]) -> Vec<NearbyDevice> {
        let Ok(mut m) = self.nearby.lock() else {
            return Vec::new();
        };
        m.retain(|_, d| now - d.last_seen <= NEARBY_TTL_SECS);
        let mut v: Vec<NearbyDevice> = m
            .values()
            .filter(|d| !paired.contains(&d.device_id))
            .cloned()
            .collect();
        v.sort_by(|a, b| a.device_name.cmp(&b.device_name));
        v
    }

    /// 最后一次听到某设备招呼包的 unix 秒。
    ///
    /// ❗ 判「在线」要用这个，不能用「最近收到过它的加密消息」：
    /// 加密消息只在剪贴板变动时才发，拿它当心跳会让一台安静但在线的设备
    /// 显示成离线，也会让一台几小时前发过一条、现已关机的设备一直显示在线。
    /// 招呼包是每 [`HELLO_INTERVAL_SECS`] 秒一次的心跳，才是正确的判据。
    pub fn last_heard(&self, device_id: &str) -> Option<i64> {
        self.nearby
            .lock()
            .ok()
            .and_then(|m| m.get(device_id).map(|d| d.last_seen))
    }

    pub fn device_name_of(&self, device_id: &str) -> Option<String> {
        self.nearby
            .lock()
            .ok()
            .and_then(|m| m.get(device_id).map(|d| d.device_name.clone()))
    }

    /// 放一个新会话进去。返回本端公钥（要发给对方）。
    pub fn begin(&self, p: PendingPair) -> String {
        let pk = p.my_pk.clone();
        if let Ok(mut g) = self.pending.lock() {
            *g = Some(p);
        }
        pk
    }

    /// 对进行中的会话做一件事。会话不存在或已过期时返回 `None`。
    pub fn with_pending<T>(
        &self,
        now: i64,
        f: impl FnOnce(&mut PendingPair) -> T,
    ) -> Option<T> {
        let mut g = self.pending.lock().ok()?;
        let expired = g.as_ref().map(|p| p.expired(now)).unwrap_or(false);
        if expired {
            *g = None;
            return None;
        }
        g.as_mut().map(f)
    }

    /// 读一份快照给界面（peer_id, peer_name, pin, role, 本端是否已确认）。
    pub fn snapshot(&self, now: i64) -> Option<(String, String, String, PairRole, bool)> {
        self.with_pending(now, |p| {
            (
                p.peer_id.clone(),
                p.peer_name.clone(),
                p.pin.clone(),
                p.role,
                p.confirmed,
            )
        })
    }

    pub fn clear(&self) {
        if let Ok(mut g) = self.pending.lock() {
            *g = None;
        }
    }

    pub fn note_reject(&self, device_id: &str) {
        if let Ok(mut m) = self.rejects.lock() {
            *m.entry(device_id.to_string()).or_insert(0) += 1;
        }
    }

    pub fn is_blocked(&self, device_id: &str) -> bool {
        self.rejects
            .lock()
            .map(|m| m.get(device_id).copied().unwrap_or(0) >= REJECT_LIMIT)
            .unwrap_or(false)
    }
}

// ===== hex 小工具 =====

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// hex → 字节。
///
/// 🔴 **必须按字节切，不能用 `&s[i*2..i*2+2]`**。
/// 后者在非 ASCII 字符上会 **panic**（切到了字符中间），而这里的输入
/// 直接来自 UDP 包——对方发一个 `pk` 带汉字的握手包就能把监听线程打挂。
/// 2026-09-06 单测当场逐到这个。
///
/// 同样的坑在 `lan_sync::hex_decode_12` 里已经存在了很久（nonce 也来自网络），
/// 那边现已改成复用本函数。
pub(crate) fn hex_to_vec(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.is_empty() || b.len() % 2 != 0 {
        return None;
    }
    (0..b.len() / 2)
        .map(|i| {
            let hi = char::from(b[i * 2]).to_digit(16)?;
            let lo = char::from(b[i * 2 + 1]).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// hex → 固定 12 字节（AES-GCM 的 nonce 长度）。
pub(crate) fn hex_to_12(s: &str) -> Option<[u8; 12]> {
    let v = hex_to_vec(s)?;
    if v.len() != 12 {
        return None;
    }
    let mut out = [0u8; 12];
    out.copy_from_slice(&v);
    Some(out)
}

#[cfg(test)]
mod tests;
