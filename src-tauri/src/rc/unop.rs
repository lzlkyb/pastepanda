//! 无人值守固定密码（Q2 方案 C）：给「自家服务器 / 出租机」这种真长期需求。
//!
//! 方案 B（一次性接入码，[`super::uno`]）覆盖 90% 的无人值守场景；C 是**辅路**：
//! 密码长期有效、可反复使用，换来的就是 B 里根本不存在的两样新攻击面——
//! **离线爆破**（哈希落盘，攻击者拿到文件可慢慢试）与**在线爆破**（无限次慢速试）。
//! 设计稿给的四条对策，全部落在本模块 + [`super::service`] 的接线上：
//!
//! | 对策 | 落点 |
//! | --- | --- |
//! | Argon2id 存哈希 | [`hash_password`] / [`verify`]，PHC 串进 `config` 表的 [`CFG_KEY`]，明文永不落盘 |
//! | 每对端指数退避 + 连续 5 次失败锁 10 分钟 | [`BruteGate`]（内存态，重启清零）；**验码前**先查闸，锁定期连 Argon2 都不跑 |
//! | 被控横幅常驻「无人值守模式中」+ 一键全局关闭 | `RcStatus.uno_pass` 投影 + 前端 RcOverlay 常驻条 + `rc_uno_pass_disable` |
//! | 默认仅局域网，跨网显式打开 | `PassCfg.wan`（默认 false）；准入时用 `path_kind::of_conn` 实测来路 |
//!
//! # Argon2id 的参数与它防的是什么
//!
//! OWASP 最低配（m=19 MiB, t=2, p=1，[`hash_password`] 内写死）：GPU 爆破的
//! 显存占用被钉在每路 19 MiB，离线爆破弱口令的成本比 PBKDF2 高一个量级。
//! 参数随 PHC 串自描述——以后调参，旧哈希照样能验，不用迁移。
//!
//! 它**防不了**运行中的进程被定向读内存（攻击者已在你机器上跑代码，那是另
//! 一个威胁模型），也防不了用户把密码设成 `123456`——所以 [`PASS_MIN_CHARS`]
//! 只能拦最蠢的，真正的闸是 [`BruteGate`]。
//!
//! # 与方案 B 的三个刻意差别
//!
//! 1. **落盘**。B 的码不落盘、关机即废；C 的密码哈希必须活过重启（服务器场景
//!    重启后连不上=功能失效）。落盘内容只有 PHC 串，明文只在 [`hash_password`]
//!    的入参里出现过一次。
//! 2. **不自动开免确认**。B 生成时可勾「接入后开免确认」，因为码是短时效的、
//!    风险可控；C 的密码是长期的，「知道密码」与「这台设备可信」必须保持
//!    分离（设计稿威胁表第三行）——接人的设备落白名单后，免确认请人工逐台开。
//! 3. **不限次、不自动过期**。没有消耗计数；泄露后的止损手段是「一键全局关闭」
//!    + 换密码，这就是横幅常驻存在的理由。
//!
//! # 防爆破闸的语义（[`BruteGate`]）
//!
//! - 键是**对端 node_id**（iroh TLS 已验真，伪造要真密钥对）。因此攻击者刷满
//!   5 次只会**锁他自己**，锁不到合法用户的 node_id——per-peer 的天然好处，
//!   不存在「外部攻击者把合法用户锁在门外」的 DoS。
//! - 指数退避：连续失败 n 次后，下一次尝试要距上次失败 ≥ base·2^(n-1)
//!   （1s 起步、60s 封顶）。锁定期满后计数**不清零**：下一错直接再锁，
//!   攻击者无法用「等 10 分钟重置计数」把尝试速率拉回起步。
//! - 连续成功验密即清档。**清档点在验密通过之后、建会话之前**——「密码对但
//!   本机忙」不算失败（他没在爆破），不该吃退避。
//! - 键上限 [`PEERS_CAP`]：node_id 虽验真但密钥对免费，无上限的表就是内存
//!   DoS。满了逐出「最久没失败」的（最不可能是正在进行的攻击）。

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use super::protocol::Capability;

/// `config` 表里放方案 C 配置的键。值是 [`PassCfg`] 的 JSON；缺键 / 非对象 = 未开启。
pub const CFG_KEY: &str = "rc_uno_pass";

/// 密码最短长度（trim 后按字符数）。只拦最蠢的弱口令；真正的闸在 [`BruteGate`]。
pub const PASS_MIN_CHARS: usize = 6;

/// 密码最长长度。Argon2 本无实用上限，这是给 UI 与日志的口径。
pub const PASS_MAX_CHARS: usize = 64;

/// 退避起步：第 1 次失败后，下一次尝试至少隔 1 秒。
pub const BACKOFF_BASE_MS: i64 = 1_000;

/// 退避封顶：60 秒。指数增长到此为止，锁住的 10 分钟才是主刑。
pub const BACKOFF_MAX_MS: i64 = 60_000;

/// 连续失败多少次触发锁定（设计稿：5 次）。
pub const LOCK_THRESHOLD: u32 = 5;

/// 锁定时长（设计稿：10 分钟）。
pub const LOCK_MS: i64 = 10 * 60 * 1000;

/// 退避闸的对端键上限。
const PEERS_CAP: usize = 4096;

/// 指数退避的位移上限：2^6 = 64s ≥ [`BACKOFF_MAX_MS`]，再往上就是白算。
const BACKOFF_MAX_SHIFT: u32 = 6;

/// 落盘的方案 C 配置（`config` 表 [`CFG_KEY`] 键下的 JSON）。
///
/// 🔴 只有 PHC 串，**没有**明文密码；`phc` 自带盐与参数，改字段名等于改线上格式。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PassCfg {
    /// Argon2id PHC 串（`$argon2id$v=19$m=19456,t=2,p=1$…$…`）。
    pub phc: String,
    /// 密码接入授予的能力档上限（view / control）。
    pub cap: String,
    /// true = 允许跨网密码接入。**默认 false**（仅局域网）——设计稿的第四条对策。
    pub wan: bool,
    /// 开启时刻（epoch 毫秒），横幅「已开启 N」用。
    pub since_ms: i64,
}

impl PassCfg {
    pub fn capability(&self) -> Option<Capability> {
        Capability::parse(&self.cap)
    }
}

/// 给界面（`RcStatus.uno_pass`）看的开启状态。**绝不包含** PHC 串——
/// 那是可拿去离线爆破的验证材料，界面没有理由要它。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UnoPassInfo {
    /// 密码接入授予的能力档上限（view / control）。
    pub cap: String,
    /// 是否允许跨网（false = 仅局域网，默认）。
    pub wan: bool,
    /// 开启时刻（epoch 毫秒）。换密码会刷新。
    pub since_ms: i64,
}

impl From<PassCfg> for UnoPassInfo {
    fn from(c: PassCfg) -> Self {
        UnoPassInfo {
            cap: c.cap,
            wan: c.wan,
            since_ms: c.since_ms,
        }
    }
}

/// 从整份配置里取方案 C 状态。缺键、存了 null、或反序列化失败一律 = 未开启
/// （读不出就当关——配置损坏时宁可回到「要人点头」的保守态）。
pub fn cfg_from(config: &serde_json::Value) -> Option<PassCfg> {
    config
        .get(CFG_KEY)
        .filter(|v| v.is_object())
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// 密码归一：trim 两端空白。**不做**大小写折叠（密码大小写敏感，与 uno 码的
/// 宽松归一是有意的差别——码要在电话里念，密码在聊天框里粘）。
pub fn normalize(pass: &str) -> String {
    pass.trim().to_string()
}

/// 设密码：归一 → 长度校验 → Argon2id（OWASP 最低配）→ PHC 串。
/// 明文只在入参里出现这一次，返回值可直接落 [`CFG_KEY`]。
pub fn hash_password(raw: &str, now_ms: i64, cap: Capability, wan: bool) -> Result<PassCfg, String> {
    let pass = normalize(raw);
    let n = pass.chars().count();
    if n < PASS_MIN_CHARS {
        return Err(format!("密码太短：至少 {PASS_MIN_CHARS} 个字符"));
    }
    if n > PASS_MAX_CHARS {
        return Err(format!("密码太长：最多 {PASS_MAX_CHARS} 个字符"));
    }
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    let phc = Argon2::default()
        .hash_password(pass.as_bytes(), &salt)
        .map_err(|e| format!("密码哈希失败：{e}"))?
        .to_string();
    Ok(PassCfg {
        phc,
        cap: cap.as_str().to_string(),
        wan,
        since_ms: now_ms,
    })
}

/// 验密码。归一与 [`hash_password`] 同一条 `normalize`；Argon2 的比对内部即
/// 常数时间（subtle），这里不再叠一层自写比较。
pub fn verify(phc: &str, raw: &str) -> bool {
    let Ok(hash) = PasswordHash::new(phc) else {
        // 哈希串坏了 = 这条配置已不可用；如实判否，让用户去重设密码
        return false;
    };
    Argon2::default()
        .verify_password(normalize(raw).as_bytes(), &hash)
        .is_ok()
}

/// 单个对端的失败累积。
#[derive(Debug, Clone, Copy)]
struct PeerFail {
    /// 连续失败次数（成功验密才清零；锁定期满不清——见模块注释）。
    consecutive: u32,
    last_fail_ms: i64,
    /// 0 = 未锁定；否则在此之前一律拒。
    locked_until_ms: i64,
}

/// 闸的裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateCheck {
    /// 放行（可以跑 Argon2 验密）。
    Ok,
    /// 拒绝；剩余等待毫秒。对端可据此展示「N 秒后再试」。
    Wait(i64),
}

/// 每对端防爆破闸（纯内存，随进程生灭）。
#[derive(Default)]
pub struct BruteGate {
    peers: Mutex<HashMap<String, PeerFail>>,
}

impl BruteGate {
    /// 尝试前查闸。**先查后验**：锁定期连 Argon2 都不跑，把「无限次慢速试」
    /// 和「拿验密当 CPU 烤箱」一起按住。
    pub fn check(&self, peer: &str, now: i64) -> GateCheck {
        let g = self.peers.lock().unwrap_or_else(|p| p.into_inner());
        let Some(p) = g.get(peer) else {
            return GateCheck::Ok;
        };
        if now < p.locked_until_ms {
            return GateCheck::Wait(p.locked_until_ms - now);
        }
        if p.consecutive > 0 {
            let shift = (p.consecutive - 1).min(BACKOFF_MAX_SHIFT);
            let delay = BACKOFF_BASE_MS
                .saturating_mul(1i64 << shift)
                .min(BACKOFF_MAX_MS);
            let since = now - p.last_fail_ms;
            if since < delay {
                return GateCheck::Wait(delay - since);
            }
        }
        GateCheck::Ok
    }

    /// 记一次密码错误。
    pub fn record_failure(&self, peer: &str, now: i64) {
        let mut g = self.peers.lock().unwrap_or_else(|p| p.into_inner());
        if g.len() >= PEERS_CAP && !g.contains_key(peer) {
            // 逐出最久没失败的：最不可能是正在进行的攻击
            if let Some(oldest) = g
                .iter()
                .min_by_key(|(_, p)| p.last_fail_ms)
                .map(|(k, _)| k.clone())
            {
                g.remove(&oldest);
            }
        }
        let e = g.entry(peer.to_string()).or_insert(PeerFail {
            consecutive: 0,
            last_fail_ms: now,
            locked_until_ms: 0,
        });
        e.consecutive = e.consecutive.saturating_add(1);
        e.last_fail_ms = now;
        if e.consecutive >= LOCK_THRESHOLD {
            e.locked_until_ms = now.saturating_add(LOCK_MS);
        }
    }

    /// 密码验过了就清档（建会话成功与否与此无关——busy 不是爆破）。
    pub fn record_success(&self, peer: &str) {
        self.peers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(peer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_757_000_000_000;

    #[test]
    fn 哈希验证闭环_错密码拒绝() {
        let cfg = hash_password("s3cret-密码", T0, Capability::Control, false).unwrap();
        assert!(cfg.phc.starts_with("$argon2id$"), "PHC 串要自描述算法：{}", &cfg.phc[..20]);
        assert!(cfg.cap == "control" && !cfg.wan);
        assert!(verify(&cfg.phc, " s3cret-密码 "), "两端空白剥掉后应能验过");
        assert!(!verify(&cfg.phc, "s3cret-密码x"), "错密码必须拒");
        assert!(!verify(&cfg.phc, "S3CRET-密码"), "大小写敏感（与 uno 码的宽松归一不同）");
    }

    #[test]
    fn 密码长度校验() {
        assert!(hash_password("a".repeat(PASS_MIN_CHARS - 1).as_str(), T0, Capability::View, false).is_err());
        assert!(hash_password(&"a".repeat(PASS_MIN_CHARS), T0, Capability::View, false).is_ok());
        assert!(hash_password(&"a".repeat(PASS_MAX_CHARS), T0, Capability::View, false).is_ok());
        assert!(hash_password(&"a".repeat(PASS_MAX_CHARS + 1), T0, Capability::View, false).is_err());
        // 空白不算长度：trim 后不足照样拒
        assert!(hash_password("      ab      ", T0, Capability::View, false).is_err());
    }

    #[test]
    fn 配置缺失或损坏一律视为未开启() {
        assert!(cfg_from(&serde_json::json!({})).is_none());
        assert!(cfg_from(&serde_json::json!({ "rc_uno_pass": null })).is_none());
        assert!(cfg_from(&serde_json::json!({ "rc_uno_pass": { "phc": "乱写" } })).is_none());
        let cfg = hash_password("s3cret-密码", T0, Capability::View, true).unwrap();
        let back: PassCfg =
            serde_json::from_value(serde_json::to_value(&cfg).unwrap()).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn 闸_首次不受限_失败后按指数退避() {
        let g = BruteGate::default();
        assert_eq!(g.check("peerA", T0), GateCheck::Ok, "没失败过 = 不设防");
        g.record_failure("peerA", T0);
        assert!(matches!(g.check("peerA", T0 + 100), GateCheck::Wait(_)), "刚失败就试 = 退避");
        assert_eq!(g.check("peerA", T0 + BACKOFF_BASE_MS), GateCheck::Ok, "隔够 1s = 放行");
        // 第 2 次失败后窗口翻倍到 2s
        g.record_failure("peerA", T0 + BACKOFF_BASE_MS);
        let last = T0 + BACKOFF_BASE_MS;
        assert_eq!(
            g.check("peerA", last + BACKOFF_BASE_MS * 2),
            GateCheck::Ok,
            "隔够 2s = 放行"
        );
        assert!(matches!(
            g.check("peerA", last + BACKOFF_BASE_MS),
            GateCheck::Wait(_)
        ));
    }

    #[test]
    fn 闸_连续五次失败锁十分钟_锁内不跑验密() {
        // 时间线（每次都隔够当前退避，确保拦下的是锁不是退避）：
        // 失败 @T0(+0) 窗1s → @+2s 窗2s → @+5s 窗4s → @+9s 窗8s → 第5次 @+17s = 锁
        let g = BruteGate::default();
        for at in [0i64, 2000, 5000, 9000] {
            g.record_failure("peerA", T0 + at);
        }
        // 前 4 次：退避在增长，但还没有 10 分钟级的死锁
        assert!(matches!(
            g.check("peerA", T0 + 15_000),
            GateCheck::Wait(w) if w < LOCK_MS
        ), "4 次失败只该有秒级退避");
        g.record_failure("peerA", T0 + 17_000); // 第 5 次：锁
        let late = T0 + 300_000; // 退避早就过点了，但锁还没过
        assert!(matches!(
            g.check("peerA", late),
            GateCheck::Wait(w) if w <= LOCK_MS
        ), "第 5 次失败后要锁满 10 分钟");
    }

    #[test]
    fn 闸_锁定期满后计数不清零_再错立刻再锁() {
        let g = BruteGate::default();
        for i in 0..LOCK_THRESHOLD {
            g.record_failure("peerA", T0 + i64::from(i) * 1000);
        }
        // 5 次失败停在 T0+4000，锁到 T0+4000+LOCK_MS；过期点已过 = 放行
        let after_lock = T0 + 4000 + LOCK_MS + 1000;
        assert_eq!(g.check("peerA", after_lock), GateCheck::Ok, "锁过期后放行一次");
        g.record_failure("peerA", after_lock);
        // 再错 → 直接再锁；在新的锁内（还没到点）必须是 Wait
        let inside = after_lock + LOCK_MS - 1000;
        assert!(
            matches!(g.check("peerA", inside), GateCheck::Wait(w) if w <= LOCK_MS),
            "计数还在 ⇒ 第 6 次失败直接再锁，攻击者拉不回起步速率"
        );
    }

    #[test]
    fn 闸_验密通过清档_busy不算失败() {
        let g = BruteGate::default();
        for i in 0..3 {
            g.record_failure("peerA", T0 + i * 2000);
        }
        g.record_success("peerA");
        assert_eq!(g.check("peerA", T0), GateCheck::Ok, "成功验密 = 连续链断掉");
    }

    #[test]
    fn 闸_按对端隔离_一个挨锁不连坐() {
        let g = BruteGate::default();
        for i in 0..LOCK_THRESHOLD {
            g.record_failure("attacker", T0 + i64::from(i) * 2000);
        }
        assert!(matches!(g.check("attacker", T0 + 1), GateCheck::Wait(_)));
        assert_eq!(
            g.check("legit-user", T0 + 1),
            GateCheck::Ok,
            "per-peer 的意义：攻击者锁不到别人的 node_id"
        );
    }

    #[test]
    fn 闸_大量失败不溢出位移_锁始终优先于退避() {
        let g = BruteGate::default();
        // 300 次连错：consecutive 远超位移上限，锁也在反复重设——
        // 无论如何 check 都不许 panic，且等待永远 ≤ 锁长（不会「永封」）。
        for i in 0..300 {
            g.record_failure("peerA", T0 + i64::from(i) * 1000);
        }
        let after = T0 + 299_000 + LOCK_MS + 1000; // 最后一把锁刚过期
        match g.check("peerA", after) {
            GateCheck::Ok => {}
            GateCheck::Wait(w) => assert!(w <= LOCK_MS, "等待不得超过锁长：{w}"),
        }
        // 锁过期内依旧是 Wait 且不超锁长
        assert!(matches!(
            g.check("peerA", T0 + 299_000 + LOCK_MS - 1000),
            GateCheck::Wait(w) if w <= LOCK_MS
        ));
    }

    #[test]
    fn 闸_对端表有上限_满了逐出最久没失败的() {
        let g = BruteGate::default();
        // "peer0" 比所有人都老 10 秒——逐出目标必须唯一，
        // 否则 min_by_key 在并列值上撞 HashMap 迭代序，断言变成抽奖。
        g.record_failure("peer0", T0 - 10_000);
        for i in 1..PEERS_CAP {
            g.record_failure(&format!("peer{i}"), T0);
        }
        assert_eq!(g.peers.lock().unwrap_or_else(|p| p.into_inner()).len(), PEERS_CAP);
        g.record_failure("newcomer", T0 + 1);
        let len = g.peers.lock().unwrap_or_else(|p| p.into_inner()).len();
        assert_eq!(len, PEERS_CAP, "满了要顶替，不能无限长");
        assert!(!g.peers.lock().unwrap_or_else(|p| p.into_inner()).contains_key("peer0"));
    }
}
