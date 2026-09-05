//! 设备身份（M6-P1）。每台机器一对 ed25519 密钥，公钥就是 `NodeId`。
//!
//! # 为什么用 `ring` 而不是 `ed25519-dalek`
//!
//! `ring` **已经在依赖里**（`lan_sync` 的 AES-256-GCM、`mcp::token` 的随机数都在用它）。
//! 而 `ed25519-dalek` 常连带 `rand`/`getrandom 0.3+`——本机 Windows 缺 `ProcessPrng` 导出，
//! 链上那一档的二进制**启动即挂 `0xc0000139`**，且 `cargo tree` 看不出来。
//! 为一个 60 行的模块引入那个风险不值得。
//!
//! # 存的是 32 字节**种子**，不是密钥对
//!
//! `ring::signature::Ed25519KeyPair::from_seed_unchecked` 收 32 字节种子；
//! 而 iroh 的 `SecretKey::from_bytes([u8; 32])` 收的正是同样的东西。
//! 所以将来接 WAN 传输时**身份不用换**——这是特意留的口，
//! 不是巧合（传输层选型还没拍板，见总排期）。
//!
//! # 私钥落盘走 `dpapi`，不是 `secret_registry`
//!
//! 🔴 设计稿 §3.2 写「私钥存 `secret_registry`，类比 `SLOT_LAN_PAIRING`」——**那是误读**。
//! `secret_registry` 不存任何东西，它只登记哈希，让剪贴板监听把用户自己的密钥打码
//! （`is_own_secret`）。真正的静态加密是 `dpapi`，先例是 `mcp::token`（决策 D4）。
//!
//! 顺带说明：现有的 `lan_pairing_key` 是**明文存在 config 里**的。
//! 本模块不沿用那个做法。

use std::path::{Path, PathBuf};

/// 私钥种子文件名。
const SEED_FILE: &str = "sync_node_key.bin";
/// DPAPI entropy。**带版本后缀**：改它会让已存的身份全部失效（= 设备要重新配对）。
const ENTROPY: &[u8] = b"pastepanda-sync-node-v1";
/// 种子长度，ed25519 固定 32。
const SEED_LEN: usize = 32;

fn seed_path(app_dir: &Path) -> PathBuf {
    app_dir.join(SEED_FILE)
}

/// 本机的同步身份。
pub struct NodeIdentity {
    seed: [u8; SEED_LEN],
    /// 公钥 32 字节。就是 `NodeId`。
    public: Vec<u8>,
}

impl NodeIdentity {
    /// 读回身份；文件不存在就生成一个新的并落盘。
    ///
    /// 🔴 与 `mcp::token` 的「解不开就重建」**故意不同**：令牌丢了重发一个就行，
    /// 而身份丢了意味着**所有已配对的设备都认不出这台机器了**（见设计稿 §6.4：
    /// 私钥丢失 = 身份变了 = 需要重新配对）。
    /// 所以这里解不开就**报错**，让用户看见，而不是悄悄换一个身份。
    pub fn load_or_create(app_dir: &Path) -> Result<Self, String> {
        let path = seed_path(app_dir);
        if path.exists() {
            let cipher = std::fs::read(&path).map_err(|e| format!("读身份文件失败：{}", e))?;
            let plain = crate::dpapi::unprotect(&cipher, ENTROPY).map_err(|e| {
                format!(
                    "身份文件解不开（{}）。**不会自动换新身份**——那会让所有已配对设备\
                     突然认不出这台机器。请确认是不是换过 Windows 账户或重装过系统；\
                     确实要重建的话，删掉 {} 再启动。",
                    e,
                    path.display()
                )
            })?;
            let seed: [u8; SEED_LEN] = plain
                .as_slice()
                .try_into()
                .map_err(|_| format!("身份文件长度不对（{} 字节，应为 32）", plain.len()))?;
            return Self::from_seed(seed);
        }
        let seed = random_seed()?;
        let me = Self::from_seed(seed)?;
        save(app_dir, &seed)?;
        log::info!("[Sync] 已生成本机同步身份 node_id={}", me.node_id());
        Ok(me)
    }

    fn from_seed(seed: [u8; SEED_LEN]) -> Result<Self, String> {
        let kp = keypair(&seed)?;
        use ring::signature::KeyPair;
        Ok(Self {
            seed,
            public: kp.public_key().as_ref().to_vec(),
        })
    }

    /// `NodeId` = 公钥的小写 hex（64 字符）。
    ///
    /// 用 hex 而不是 base64：用户**会**肉眼比对这个值（「是不是那台」），
    /// 而 base64 有 `-_` / `+/` 两套变体、还分大小写，比对时容易看错。
    pub fn node_id(&self) -> String {
        to_hex(&self.public)
    }

    /// 给用户看的短指纹（前 4 组，共 16 字符）。
    ///
    /// 🔴 **配对的安全性靠这个，不靠邀请码里的签名。**
    /// 邀请码是自签的：签名只证明「做这个码的人持有那把私钥」，
    /// **不证明这个码没被换成攻击者自己的那一份**（那一份同样自签有效）。
    /// 所以两端必须**各自看自己的指纹、口头核对一致**——
    /// 同 SSH host key 指纹、Signal 安全码的做法。
    pub fn fingerprint(&self) -> String {
        let h = self.node_id();
        h.as_bytes()
            .chunks(4)
            .take(4)
            .map(|c| String::from_utf8_lossy(c).to_string())
            .collect::<Vec<_>>()
            .join("-")
    }

    pub fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        let kp = keypair(&self.seed)?;
        Ok(kp.sign(msg).as_ref().to_vec())
    }

    /// 给 iroh 绑端点用的密钥。这就是本模块开头说的「身份不用换」那个口。
    ///
    /// 🔴 **不对外露裸种子。** `pub(crate)` 加上返回 `SecretKey` 而不是
    /// `[u8; 32]`，是为了让私钥没有一个能被随手打印 / 序列化的形态。
    ///
    /// ❗ 上一版 `transport::bind` 是另收一个 `seed: [u8; 32]` 参数的，
    /// 而 `me` 那个参数完全没用（`let _ = me;`）。后果是**生产环境
    /// 没法用真身份绑端点**：随便造个种子的话，端点 id 就不等于
    /// 大家配对时认的 `node_id`，配对直接失效。现在两者**同源，且类型上就不可能分开**。
    pub(crate) fn iroh_secret(&self) -> iroh::SecretKey {
        iroh::SecretKey::from_bytes(&self.seed)
    }
}

/// 🔴 **手写而不是 `#[derive(Debug)]`**：派生实现会把 `seed`（私钥）
/// 打进每一句 `{:?}` 与每一次 panic 消息——而那两个地方都会进日志。
/// 只露公开信息（短指纹）。
impl std::fmt::Debug for NodeIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("fingerprint", &self.fingerprint())
            .field("seed", &"<已隐去>")
            .finish()
    }
}

fn keypair(seed: &[u8; SEED_LEN]) -> Result<ring::signature::Ed25519KeyPair, String> {
    ring::signature::Ed25519KeyPair::from_seed_unchecked(seed)
        .map_err(|e| format!("从种子构造密钥对失败：{}", e))
}

fn random_seed() -> Result<[u8; SEED_LEN], String> {
    use ring::rand::SecureRandom;
    let rng = ring::rand::SystemRandom::new();
    let mut buf = [0u8; SEED_LEN];
    rng.fill(&mut buf)
        .map_err(|_| "生成身份失败（系统随机数源不可用）".to_string())?;
    Ok(buf)
}

fn save(app_dir: &Path, seed: &[u8; SEED_LEN]) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| format!("无法创建数据目录：{}", e))?;
    let cipher = crate::dpapi::protect(seed, ENTROPY)?;
    // 临时文件 + rename：写一半崩了会留下半个身份文件，而那种文件解得开、
    // 长度却不对，下次启动就是「身份损坏」——照 mcp::token 的先例。
    let path = seed_path(app_dir);
    let tmp = app_dir.join(".sync_node_key.tmp");
    std::fs::write(&tmp, &cipher).map_err(|e| format!("写身份临时文件失败：{}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存身份失败：{}", e)
    })
}

/// 校验某个 `NodeId` 对一段消息的签名。
pub fn verify(node_id: &str, msg: &[u8], sig: &[u8]) -> Result<(), String> {
    let pk = from_hex(node_id).ok_or("node_id 不是合法的 hex")?;
    if pk.len() != 32 {
        return Err(format!("node_id 长度不对（{} 字节，应为 32）", pk.len()));
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &pk)
        .verify(msg, sig)
        .map_err(|_| "签名校验不通过".to_string())
}

// ===== hex（不引 `hex` crate，就这么点儿）=====

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/// 🔴 **先挡非 ASCII，再切片。**
///
/// `&s[i..i + 2]` 是**字节**切片，落在多字节 UTF-8 字符中间会 `panic`，
/// 而本工程是 `panic = "abort"`——整个应用直接挂。
///
/// 这不是理论风险：`invite::decode` 校的是 `node_id.len() != 64`，那是**字节长度**。
/// 一串含一个 3 字节汉字 + 61 个 ASCII 的 `node_id` 刚好 64 字节、能过校验，
/// 然后在这里炸。用户在配对框里粘一串坑过的邀请码就能把程序弄崩。
fn from_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.is_empty() || !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
