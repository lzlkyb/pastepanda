//! 无人值守接入码（Q2 方案 B）：被控端不在场时的临时授权。
//!
//! 场景（对标清单 Q2）：帮**不在场**的家人修电脑、连自己的服务器。现有两条
//! 入路（现场 6 位数字配对、邀请码 + 指纹核对）都要求被控端有人点头，覆盖不了。
//!
//! # 与商业产品「固定密码」的区别（本模块存在的理由）
//!
//! 固定密码模式的攻击面是 ToDesk / 向日葵们被爆过的地方：
//!
//! | 风险 | 本模块怎么压住 |
//! | --- | --- |
//! | 离线爆破 | 码默认 **15 分钟过期、限用 1 次**，窗口按分钟计；每次生成都是新码 |
//! | 密码即永久后门 | 码**不落盘**——只在本模块的内存表里挂一条（且只存 SHA-256 摘要），关机即全作废；泄露的损失上限 = 一个码 + 一段窗口 |
//! | 授权范围模糊 | 验码通过 = 写进 `rc_devices` 白名单，与现场配对**同一张表**：横幅、历史、逐台禁止、免确认开关全部照常生效，撤销 = 撤销这条设备 |
//!
//! # 熵的真实数字（诚实版）
//!
//! 展示码 8 字符 × 5 bit/字符 = **40 bit**（设计稿写 128 bit 是笔误：8 个 base32
//! 字符装不下 128 bit，而「电话里念得完」决定了长度上限）。40 bit 对这个威胁
//! 模型是够的：猜码的每次尝试都要完成一次完整的 iroh 连接 + Request 握手
//! （百毫秒级、对端全程记日志），2^40 ≈ 1.1e12 在 15 分钟窗口内是天文数字；
//! 即便 24 小时档，在线爆破也远够不着。真正要防的从来不是猜码，是**码被
//! 截图外传**——那由「会过期 + 用完即废 + 被控横幅可见」兜底。
//!
//! # 传递格式
//!
//! 展示码 `XXXX-XXXX`（电话可读）；跨网时对方还得知道本机 node_id，所以生成端
//! 同时给「完整接入串」`PPU-<码>-<node_id>`（复制粘贴走微信/剪贴板）。
//! 解析归一化在发送端做（[`super::service`] 的拨号要的是拆好的两段）；
//! 本模块只认 8 个字符的码本身。
//!
//! # 比对为什么不存明文
//!
//! 内存里也只存 `SHA-256(归一化码)`： casual 读内存（崩溃转储、剪贴板工具
//! 误抓）扫不到码本身。要说清它**防不了**什么（2026-09-19 审查）：摘要无盐，
//! 40 bit 的码在单卡 GPU 上是小时级离线爆破——能定向读内存的攻击者本就在
//! 你的机器上跑代码了，那已经是另一个威胁模型；这里的收益是「不把明文码
//! 摆在任何一个内存扫描器面前」。比较是常数时间的（异或折叠，见 `ct_eq`）。

use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use std::sync::Mutex;

use super::protocol::Capability;

/// 展示码字符集：Crockford base32（去 I/L/O/U，避免与 1/0 手抄混淆）。
pub const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 展示码长度（字符数）。
pub const CODE_LEN: usize = 8;

/// 默认时效：15 分钟（毫秒）。
pub const TTL_SHORT_MS: i64 = 15 * 60 * 1000;

/// 放宽档：24 小时（毫秒）——给装机 / 挂机场景，仍限在本模块内可随时撤销。
pub const TTL_DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 「不限次」的内部表示。
pub const UNLIMITED_USES: u32 = u32::MAX;

/// 🔴 P3-2（2026-09-25 审计）：verify→consume 竞态的占位 TTL。
///
/// `verify` 不消费（「码对但本机正忙」不该烧掉一次机会），但**会占位**：
/// 占位把「验过、正在建立会话」的窗口从原来的一次连接握手收紧到显式边界。
/// 60 秒与确认条超时同量级——准入流程（建会话 + 落白名单）正常远快于它；
/// 进程崩溃等异常残留也最多占位这么久，码自动回到可用状态。
pub const PENDING_TTL_MS: i64 = 60_000;

/// 验码的三种结局（🔴 P3-2：`verify` 从 `Option<UnoGrant>` 改成三态）。
///
/// 旧的两态表达不了「码对、但另一台设备正在凭它准入」——那个窗口正是
/// 两台设备并发准入的后门，必须单独一态让调用方给出**不同**的拒绝话术。
#[derive(Debug, Clone)]
pub enum UnoVerify {
    /// 验过并**占位成功**：授权交给调用方。占位在 [`UnoCodes::consume`]
    ///（会话真建立）时清掉，在 [`UnoCodes::release`]（准入中途失败）时退掉，
    /// 或 [`PENDING_TTL_MS`] 后自行过期。
    Ok(UnoGrant),
    /// 码本身有效，但另一台设备正在凭它准入（占位未消费未过期）。
    /// 第二台必须拒——「verify 只判不消费」的窗口不允许并发准入。
    InUse,
    /// 没这个码 / 已过期 / 已用尽。
    Invalid,
}

/// 完整接入串的前缀。解析（前端 `lib/rcUno.ts`）与这里保持同一格式。
pub const FULL_PREFIX: &str = "PPU";

/// 验码通过后交给调用方的授权。
#[derive(Debug, Clone)]
pub struct UnoGrant {
    /// 授予的能力档（生成时选定）。申请档超过它时由调用方压档。
    pub capability: Capability,
    /// 生成时勾了「接入后开免确认」：这台设备落白名单时同时置 trusted。
    pub also_trust: bool,
    /// 验证摘要。`pub(crate)`：消费（[`UnoCodes::consume`]）时要拿它回表定位；
    /// 除消费外不许有第二个读点。
    pub(crate) hash: [u8; 32],
}

/// 给界面看的在效码摘要。**绝不包含码本身**（码只有生成那一刻能看见）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UnoInfo {
    /// 过期时刻（epoch 毫秒）。
    pub expires_ms: i64,
    /// true = 24 小时内不限次。
    pub unlimited: bool,
    /// 授予的能力档（view / control）。
    pub capability: String,
    /// 接入的设备是否自动开免确认。
    pub also_trust: bool,
}

struct Entry {
    hash: [u8; 32],
    expires_ms: i64,
    max_uses: u32,
    uses: u32,
    capability: Capability,
    also_trust: bool,
    /// 🔴 P3-2：占位截止时刻（0 = 没有占位）。语义见 [`UnoVerify::Ok`]。
    pending_until_ms: i64,
}

/// 内存待验表。挂在 `RcService` 上，随进程生灭——**没有落盘这回事**。
#[derive(Default)]
pub struct UnoCodes {
    entries: Mutex<Vec<Entry>>,
}

impl UnoCodes {
    /// 生成一个新码，把摘要挂进待验表，**明文只在返回值里出现这一次**。
    ///
    /// `unlimited` = false 时 `max_uses` 为 1（用掉即废）；true = 窗口内不限次。
    pub fn generate(
        &self,
        now_ms: i64,
        ttl_ms: i64,
        unlimited: bool,
        capability: Capability,
        also_trust: bool,
    ) -> Result<String, String> {
        let rng = SystemRandom::new();
        let mut bytes = [0u8; 5];
        rng.fill(&mut bytes)
            .map_err(|_| "系统随机源不可用，无法生成接入码".to_string())?;
        // 40 bit → 8 × 5 bit，逐段查表
        let mut bits = u64::from_be_bytes([0, 0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]]);
        let mut chars = [0u8; CODE_LEN];
        for c in chars.iter_mut() {
            *c = ALPHABET[(bits & 0x1f) as usize];
            bits >>= 5;
        }
        let code = String::from_utf8(chars.to_vec()).expect("字符集是 ASCII");
        let norm = normalize(&code).expect("刚生成的码必然合法");
        let entry = Entry {
            hash: code_hash(&norm),
            expires_ms: now_ms.saturating_add(ttl_ms),
            max_uses: if unlimited { UNLIMITED_USES } else { 1 },
            uses: 0,
            capability,
            also_trust,
            pending_until_ms: 0,
        };
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(entry);
        // 展示形态：四四分组。ASCII 切片不会踩 UTF-8 边界
        Ok(format!("{}-{}", &code[..4], &code[4..]))
    }

    /// 验码。**只判不消费**——「用掉一次」发生在会话真的建立之后
    /// （[`Self::consume`]），否则「码被验证通过但被控端正忙」会白烧掉一次机会。
    ///
    /// 🔴 P3-2（2026-09-25 审计）：但**会原子占位**。旧的「只判不消费」留下
    /// 一段窗口：verify 过的设备还在建会话/落白名单，同一码就能被另一台并发
    /// verify 命中并准入——一次性码被洗成两台。现在命中即占位
    ///（[`PENDING_TTL_MS`]），占位中的码对第二台 verify 返回
    /// [`UnoVerify::InUse`]；`consume` 清占位、`release` 退占位、过期自愈。
    pub fn verify(&self, raw: &str, now_ms: i64) -> UnoVerify {
        let Some(norm) = normalize(raw) else {
            return UnoVerify::Invalid;
        };
        let hash = code_hash(&norm);
        let mut g = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        g.retain(|e| e.expires_ms > now_ms && e.uses < e.max_uses);
        let Some(e) = g.iter_mut().find(|e| ct_eq(&e.hash, &hash)) else {
            return UnoVerify::Invalid;
        };
        if e.pending_until_ms > now_ms {
            return UnoVerify::InUse;
        }
        e.pending_until_ms = now_ms.saturating_add(PENDING_TTL_MS);
        UnoVerify::Ok(UnoGrant {
            capability: e.capability,
            also_trust: e.also_trust,
            hash: e.hash,
        })
    }

    /// 🔴 P3-2：解除占位。准入在 verify 之后、consume 之前失败的路径
    /// （本机忙 / 逐台禁止 / 落白名单失败）必须调它，否则「码对但本机忙」的
    /// 合法重试会在占位期内被误伤成「正在使用中」。幂等：码已被消费掉时
    /// 是无操作。
    pub fn release(&self, hash: &[u8; 32]) {
        let mut g = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(e) = g.iter_mut().find(|e| ct_eq(&e.hash, hash)) {
            e.pending_until_ms = 0;
        }
    }

    /// 消费一次。到量的码当场出表；仍在表里的（不限次档）顺带清占位（P3-2）——
    /// 会话真建立了，下一个并发 verify 不该再被这台的占位挡着。
    pub fn consume(&self, hash: &[u8; 32]) {
        let mut g = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(i) = g.iter().position(|e| ct_eq(&e.hash, hash)) {
            g[i].uses += 1;
            g[i].pending_until_ms = 0;
            if g[i].uses >= g[i].max_uses {
                g.remove(i);
            }
        }
    }

    /// 撤销全部（被控端「一键作废」按钮）。
    pub fn revoke_all(&self) -> usize {
        let mut g = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let n = g.len();
        g.clear();
        n
    }

    /// 在效码摘要（顺带清理过期/用尽的）。给设置页的「生效中」条幅。
    pub fn active(&self, now_ms: i64) -> Vec<UnoInfo> {
        let mut g = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        g.retain(|e| e.expires_ms > now_ms && e.uses < e.max_uses);
        g.iter()
            .map(|e| UnoInfo {
                expires_ms: e.expires_ms,
                unlimited: e.max_uses == UNLIMITED_USES,
                capability: e.capability.as_str().to_string(),
                also_trust: e.also_trust,
            })
            .collect()
    }
}

/// 完整接入串：`PPU-<XXXX-XXXX>-<node_id>`。跨网传递时对方必须连 node_id
/// 一起拿到——8 位展示码只够「同局域网从附近设备里认出这台机器」。
pub fn full_string(code: &str, node_id: &str) -> String {
    format!("{FULL_PREFIX}-{code}-{node_id}")
}

/// 归一化：大写、去分隔符、Crockford 易混字符回映射（O→0，I/L→1），
/// 然后整码校验。**任何一步不过就当没这回事**——攻击者可以随便喂垃圾，
/// 我们不欠他一个精确的错误分类。
fn normalize(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(CODE_LEN);
    for ch in raw.chars() {
        match ch {
            '-' | ' ' | '\t' => continue,
            'o' | 'O' => out.push('0'),
            'i' | 'I' | 'l' | 'L' => out.push('1'),
            c if c.is_ascii_uppercase() || c.is_ascii_digit() => out.push(c),
            c if c.is_ascii_lowercase() => {
                out.push(c.to_ascii_uppercase());
            }
            _ => return None,
        }
    }
    if out.len() != CODE_LEN || !out.bytes().all(|b| ALPHABET.contains(&b)) {
        return None;
    }
    Some(out)
}

fn code_hash(norm: &str) -> [u8; 32] {
    let d = digest::digest(&digest::SHA256, norm.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

/// 常数时间比较：逐字节异或折叠，只在最后分派一次分支。
///
/// 不用 `ring::constant_time`——它在 ring 0.17 新版里被标记为
/// 「内部实现、不对外承诺」，依赖它等于踩一个随时会塌的接口；
/// 这 3 行折叠是标准的常数时间比较写法，语义只有一处分支。
fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_757_000_000_000;

    /// P3-2 起 verify 返回三态枚举，测试里统一用它拆包。
    fn verify_ok(u: &UnoCodes, code: &str, now: i64) -> UnoGrant {
        match u.verify(code, now) {
            UnoVerify::Ok(g) => g,
            other => panic!("verify 应通过，实际 {other:?}"),
        }
    }

    #[test]
    fn 生成与验证闭环_格式为四四分组() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        assert_eq!(code.len(), 9, "8 字符 + 1 个分隔横杠");
        assert_eq!(code.as_bytes()[4], b'-');
        for (i, c) in code.bytes().enumerate() {
            if i == 4 {
                continue;
            }
            assert!(ALPHABET.contains(&c.to_ascii_uppercase()), "字符 {c} 不在去歧义字符集里");
        }
        let g = verify_ok(&u, &code, T0 + 1);
        assert_eq!(g.capability, Capability::Control);
        assert!(!g.also_trust);
    }

    #[test]
    fn 大小写横杠与易混字符都能归一化() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_SHORT_MS, false, Capability::View, false).unwrap();
        let bare: String = code.chars().filter(|c| *c != '-').collect();
        // P3-2：verify 会占位，每种写法验完退占位再验下一种（本测试只考察归一化，
        // 不考察并发）。
        let g = verify_ok(&u, &code.to_lowercase(), T0 + 1);
        u.release(&g.hash);
        // 无横杠
        let g = verify_ok(&u, &bare, T0 + 1);
        u.release(&g.hash);
        // 空格分组（电话里念码的常见记法）
        let g = verify_ok(&u, &format!("{} {}", &bare[..4], &bare[4..]), T0 + 1);
        u.release(&g.hash);
        // O→0、I/L→1 只在码里真的有 0/1 时才能构造——这里只验证「不 panic 且结果稳定」
        let _ = verify_ok(&u, &bare, T0 + 1);
    }

    #[test]
    fn 错码_垃圾_长度不对都拒() {
        let u = UnoCodes::default();
        u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        assert!(matches!(u.verify("AAAAAAAA", T0 + 1), UnoVerify::Invalid), "没这个码");
        assert!(
            matches!(u.verify("带着垃圾字!@#", T0 + 1), UnoVerify::Invalid),
            "非法字符整码拒绝"
        );
        assert!(matches!(u.verify("ABCD", T0 + 1), UnoVerify::Invalid), "长度不对");
        assert!(matches!(u.verify("", T0 + 1), UnoVerify::Invalid), "空串");
    }

    #[test]
    fn 过期即作废() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        assert!(
            matches!(u.verify(&code, T0 + TTL_SHORT_MS - 1), UnoVerify::Ok(_)),
            "窗口内有效"
        );
        assert!(
            matches!(u.verify(&code, T0 + TTL_SHORT_MS), UnoVerify::Invalid),
            "到点即废"
        );
        assert!(u.active(T0 + TTL_SHORT_MS).is_empty(), "过期的不进在效列表");
    }

    /// 🔴 P3-2（2026-09-25 审计）改写：占位期内并发第二台必须被拒。
    ///
    /// 旧断言「没消费就能反复验」钉的正是缺陷本体——verify 与 consume 之间
    /// 的窗口里，同一码可被另一台命中并准入，一次性码被洗成两台。
    #[test]
    fn 一次码消费后即废_并发第二台被占位拒绝_p3_2() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        let g = verify_ok(&u, &code, T0 + 1);
        // 占位期内第二台 verify：不是「有效」也不是「无效」，而是「正在使用中」
        assert!(
            matches!(u.verify(&code, T0 + 2), UnoVerify::InUse),
            "并发第二台必须被拒（旧实现这里会放行 = 缺陷本体）"
        );
        u.consume(&g.hash);
        assert!(
            matches!(u.verify(&code, T0 + 3), UnoVerify::Invalid),
            "消费一次即废"
        );
    }

    /// 🔴 P3-2：占位 TTL 过期后码自动回到可用状态——准入流程异常残留
    /// （崩溃、漏调 release）最多占位 60 秒，不会把码永久卡死。
    #[test]
    fn 占位过期码可再用_p3_2() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        assert!(matches!(u.verify(&code, T0 + 1), UnoVerify::Ok(_)));
        assert!(matches!(u.verify(&code, T0 + 2), UnoVerify::InUse));
        assert!(
            matches!(u.verify(&code, T0 + 1 + PENDING_TTL_MS), UnoVerify::Ok(_)),
            "占位过期自愈，码可再用"
        );
    }

    /// 🔴 P3-2：准入在 verify 之后失败的路径（本机忙等）必须 release 退占位，
    /// 合法重试不该在占位期内被误伤成「正在使用中」。
    #[test]
    fn 准入失败退占位后立即可重验_p3_2() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        let g = verify_ok(&u, &code, T0 + 1);
        assert!(matches!(u.verify(&code, T0 + 2), UnoVerify::InUse));
        u.release(&g.hash);
        assert!(
            matches!(u.verify(&code, T0 + 3), UnoVerify::Ok(_)),
            "release 后立即可重验"
        );
    }

    #[test]
    fn 二十四小时档可反复消费() {
        let u = UnoCodes::default();
        let code = u.generate(T0, TTL_DAY_MS, true, Capability::Control, false).unwrap();
        for i in 1..5 {
            let g = verify_ok(&u, &code, T0 + i);
            u.consume(&g.hash);
        }
        assert!(matches!(u.verify(&code, T0 + 10), UnoVerify::Ok(_)));
        let list = u.active(T0 + 10);
        assert_eq!(list.len(), 1);
        assert!(list[0].unlimited);
    }

    #[test]
    fn 撤销全部_生成端一键作废() {
        let u = UnoCodes::default();
        u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        u.generate(T0, TTL_SHORT_MS, false, Capability::View, true).unwrap();
        assert_eq!(u.active(T0).len(), 2);
        assert_eq!(u.revoke_all(), 2);
        assert!(u.active(T0).is_empty());
        assert!(matches!(u.verify("AAAAAAAA", T0), UnoVerify::Invalid));
    }

    #[test]
    fn 在效列表不给码本身只给摘要信息() {
        let u = UnoCodes::default();
        u.generate(T0, TTL_DAY_MS, true, Capability::View, true).unwrap();
        let list = u.active(T0);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].capability, "view");
        assert!(list[0].also_trust);
        // 🔴 序列化结果里不允许出现码的任何形态——码只有生成那一刻可见
        let json = serde_json::to_string(&list).unwrap();
        assert!(!json.contains("code"));
        assert!(!json.contains("hash"));
    }

    #[test]
    fn 完整接入串格式() {
        let s = full_string("AB2C-3DEF", "kbaiiimcgytf");
        assert!(s.starts_with("PPU-AB2C-3DEF-"));
        assert!(s.ends_with("kbaiiimcgytf"));
    }

    /// 随机源 bad case 打不出来就不硬测：fill 失败路径依赖 ring 内部状态，
    /// 这里只钉住「generate 的错误会如实往上传」的形状。
    #[test]
    fn 两个码不同_不共享随机() {
        let u = UnoCodes::default();
        let a = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        let b = u.generate(T0, TTL_SHORT_MS, false, Capability::Control, false).unwrap();
        assert_ne!(a, b, "两次生成撞码 = 随机源坏了");
    }
}
