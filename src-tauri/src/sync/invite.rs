//! 邀请码。一端生成、另一端粘贴批准。
//!
//! # 🔴 现行格式：PP1 短码（2026-09-18，方案 B1+B3 落地）
//!
//! ```text
//! PP1-<base58( 公钥32字节 ‖ 设备名UTF-8 )>-<4位校验>
//! ```
//!
//! 校验位 = CRC32（IEEE）对载荷取 `58^4` 模，编码成 4 个 base58 字符。
//! 它**只声明挡手滑**（抄漏一位、粘丢半截），不挡攻击者——攻击者换掉载荷
//! 后可以把校验位一起重算。真正挡替换的是**两端各自核对短指纹**
//! （[`super::identity::NodeIdentity::fingerprint`]，同 SSH host key 的做法）。
//!
//! 与 v1（JSON+签名）相比，码里**没有**了 `ts` / `sig` / `addrs`：
//! - **没 `ts`** ⇒ 码内过期判据取消，过期完全由**邀请门**兜。两条路的门宽
//!   与各自码 TTL 本就同宽（2026-09-17 修的），所以「贴着门宽的码」语义不变；
//! - **没 `sig`** ⇒ v1 注释里的结论原样成立：自签只能证明「做码的人持有私钥」，
//!   挡不住主动替换（攻击者换成自己那份同样自签有效）；完整性由 CRC 兜手滑，
//!   真实性由指纹兜，签名是纯冗余；
//! - **`name` 保留**（2026-09-17 §6-#3 拍板：去掉的话列表只能先显示指纹，不值）。
//!   所以「52 字符」是**空名下限**；带 3 个汉字的名字约 65 字符，仍是一行。
//!
//! # 旧码（v1）仍可读，反向不成立
//!
//! [`decode`] 先试 PP1 提取（含从聊天文字里自动抠码，见下），失败再回落
//! v1 解析（`sig` / `addrs` 转可选）。**旧版读不了 PP1** ⇒ 跨版本时让旧版那台
//! 生成码。v1 的生成器保留为 [`v1_encode`]（仅测试构建），给旧行为的测试对拍用。
//!
//! # `normalize` 的放宽：从上下文里自动抠码
//!
//! 短码的使用场景恰恰是口头 / 微信传递，用户大概率连「邀请码：」一起粘。
//! v1 时代数 `visible_junk` 然后报错让人自己删，对 308 字符的长码合理；
//! 对 65 字符的短码是自找麻烦 ⇒ PP1 路径改成「找 `PP1` 前缀 + base58 字母表
//! 正则直接提取」，成功就静默通过。放宽不降低安全性：把关的是 CRC + 指纹，
//! 洗字符变不出一个能过校验的码。

use base64::Engine;
use serde::{Deserialize, Serialize};

/// 知识库同步邀请码的有效期（秒）。7 天：够跨一个周末，又不至于让半年前的码还能用。
///
/// ❗ **别拿它当远程电脑配对的窗口**——那边要短得多，见 [`RC_TTL_SECS`]。
pub const TTL_SECS: i64 = 7 * 24 * 3600;

/// 远程电脑配对邀请码的有效期（秒）。
///
/// 🔴 **必须与远程邀请门同宽**：`commands::rc::RC_INVITE_DOOR_MS` 由本常量派生出，
/// 两处**不允许**各写一个数。
///
/// PP1 短码里没有 `ts`，这个常量现在只作用于**v1 旧码**的过期判定
/// （新码的过期完全由门兜，门宽由它派生，口径仍然是同一处）。
pub const RC_TTL_SECS: i64 = 30 * 60;

/// 邀请码的载荷（解码结果）。字段顺序即 v1 签名的字节顺序，**不要重排**。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Invite {
    /// 邀请方的 `NodeId`（公钥 hex）。
    pub node_id: String,
    /// 邀请方的设备名，纯展示。PP1 码里随载荷携带；用户没填就是空串
    /// （配对侧回退「新设备」，见 `rc_pair` / `kb_sync_pair`）。
    pub name: String,
    /// v1 遗留字段：全库无人消费（两个生产调用点都传空），PP1 码恒为空。
    /// 保留只为 v1 解码路径与既有前端接口不动。
    pub addrs: Vec<String>,
    /// 生成时刻（epoch 毫秒）。**只对 v1 码有意义**（参与其签名、用于过期判定）；
    /// PP1 码没有 ts，解码时填 `now_ms`（过期由门兜，这个值不参与判定）。
    pub ts: i64,
}

// ===== base58（不引 `bs58` crate：一个字母表 + 两段标准算法）=====

/// Bitcoin base58 字母表：剔除了肉眼易混的 `0 O I l`。
const B58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn b58_encode(bytes: &[u8]) -> String {
    // 前导零字节每个编码成一个 '1'（base58 的标准约定）
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 138 / 100 + 1);
    for &b in &bytes[zeros..] {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push('1');
    }
    for &d in digits.iter().rev() {
        out.push(B58_ALPHABET[d as usize] as char);
    }
    out
}

fn b58_decode(s: &str) -> Option<Vec<u8>> {
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len() * 733 / 1000 + 1);
    for ch in s.bytes() {
        let val = B58_ALPHABET.iter().position(|&a| a == ch)? as u32;
        let mut carry = val;
        for b in bytes.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xFF) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xFF) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev());
    Some(out)
}

// ===== CRC32（IEEE 802.3，无表位算：≤62 字节的载荷不值得开一张 256 项的表）=====

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 校验位宽：4 个 base58 字符（`58^4 ≈ 1131 万`）。
/// 挡手滑够了——抄错一位还能过的概率约 1/1131 万；挡攻击者**本来就不归它管**。
const CHECK_MOD: u32 = 58 * 58 * 58 * 58;

fn checksum_of(payload: &[u8]) -> [char; 4] {
    let v = crc32(payload) % CHECK_MOD;
    let mut out = ['1'; 4];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = B58_ALPHABET[(v / 58u32.pow(3 - i as u32) % 58) as usize] as char;
    }
    out
}

// ===== 编码（PP1）=====

/// 设备名在码里的字节上限（30 字节 = 10 个汉字）。
/// 再长码就重新逼近 v1 的量级，而名字超长的场景本来就该让对方改用局域网配对。
const MAX_NAME_BYTES: usize = 30;

/// 载荷下限：32 字节公钥的 base58 是 **43~44** 位（2^256 落在 58^43 与 58^44 之间，
/// 约 6% 的公钥只要 43 位——`tmp_a1` 实测 20/300），加 4 位校验即 47 起步；
/// 公钥带前导零字节还会更短（每个零字节换一个 '1'、数值部分少一位）。
/// 下限取 40：既兜住全部真实码，又保持「顺手收集的散字符够不成候选」的过滤作用。
const MIN_PAYLOAD_CHARS: usize = 40;
/// 载荷上限（公钥 32B + 名字 30B = 62B ⇒ base58 ≤ 86 + 校验 4）。超出视为不是 PP1 码。
const MAX_PAYLOAD_CHARS: usize = 96;

/// 生成 PP1 邀请码：`PP1-<base58(公钥‖名字)>-<4位校验>`。
///
/// 码里**没有**时刻——过期由邀请门兜（门宽与本文件两个 `TTL` 常量同源）。
pub fn encode(me: &super::identity::NodeIdentity, name: &str) -> Result<String, String> {
    let name = name.trim();
    let mut payload = me.public_key_bytes().to_vec();
    let mut name_len = 0usize;
    for c in name.chars() {
        let len = c.len_utf8();
        if name_len + len > MAX_NAME_BYTES {
            break;
        }
        name_len += len;
        let mut buf = [0u8; 4];
        payload.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
    let check: String = checksum_of(&payload).iter().collect();
    Ok(format!("PP1-{}-{}", b58_encode(&payload), check))
}

// ===== 解码 =====

/// 解码并校验邀请码。`now_ms` 传当前时刻，`ttl_secs` 传**调用方那条路的**窗口
/// （知识库同步用 [`TTL_SECS`]、远程电脑用 [`RC_TTL_SECS`]——只作用于 v1 旧码）。
///
/// 先试 PP1（含自动抠码），失败回落 v1；两边都失败时优先给 **PP1 的具体错误**——
/// 拿着 `PP1-` 开头的短码的人，给它一句 v1 的 base64 话术是往错方向引。
pub fn decode(code: &str, now_ms: i64, ttl_secs: i64) -> Result<Invite, String> {
    let new_err = match extract_new(code, now_ms) {
        NewScan::Hit(inv) => return Ok(inv),
        NewScan::Broken(e) => Some(e),
        NewScan::Absent => None,
    };
    decode_v1(code, now_ms, ttl_secs).map_err(|e| new_err.unwrap_or(e))
}

/// PP1 提取的结果。
enum NewScan {
    /// 提取并校验成功。
    Hit(Invite),
    /// 明确是 PP1 码（找到了 ≥ [`MIN_PAYLOAD_CHARS`] 的候选）但校验不过 / 解不开。
    Broken(String),
    /// 输入里没有 PP1 码的踪影，走 v1。
    Absent,
}

/// 在用户粘进来的**任意文本**里找 PP1 码。
///
/// # 匹配规则（为什么这么宽 / 这么窄）
///
/// - 前缀 `PP1` **大小写不敏感**、且要求前一个字符不是 ASCII 字母数字
///   （token 边界）——避免误伤 v1 长 base64 串中间恰好出现的 "PP1"；
/// - 前缀之后收集 base58 字符；**跳过**（不终止）空白、`-`、以及一切非 ASCII
///   字符（「邀请码：」、零宽字符、软连字符都算）——这正是自动抠码的宽容点；
/// - 遇到**第一个**非 base58 的 ASCII 字符（英文字母数字之外混进的 `_` `=` 等、
///   或被排除的 `0 O I l`）就终止——后续是聊天文字，继续收只会把码拼坏，
///   CRC 会兜住这种损坏；
/// - 多个候选时取第一个过校验的；有候选但全不过 ⇒ [`NewScan::Broken`]。
fn extract_new(code: &str, now_ms: i64) -> NewScan {
    let lower = code.to_ascii_lowercase();
    let mut saw_candidate = false;
    let mut from = 0usize;
    while let Some(pos) = lower[from..].find("pp1") {
        let abs = from + pos;
        from = abs + 3;
        // token 边界：前一个字符是 ASCII 字母数字 ⇒ 这是更长 token 的一部分，跳过
        if abs > 0 {
            let prev = code[..abs].chars().next_back().unwrap();
            if prev.is_ascii_alphanumeric() {
                continue;
            }
        }
        let mut collected = String::new();
        for ch in code[from..].chars() {
            if ch.is_ascii() && B58_ALPHABET.contains(&(ch as u8)) {
                collected.push(ch);
            } else if ch == '-' || ch.is_whitespace() || !ch.is_ascii() {
                continue;
            } else {
                break;
            }
        }
        if collected.len() < MIN_PAYLOAD_CHARS {
            continue;
        }
        saw_candidate = true;
        // 🔴 从**最长前缀**往下试：码后面直接跟英文字母时（全是 base58 字符），
        //   收集到的串 = 码 + 尾巴，整串的 CRC 必不过；逐个截短重试，
        //   第一个过校验的前缀就是码本体（尾巴再长也只多花微秒级）。
        let top = collected.len().min(MAX_PAYLOAD_CHARS);
        let mut found = None;
        for k in (MIN_PAYLOAD_CHARS..=top).rev() {
            if let Some(inv) = parse_payload(&collected[..k], now_ms) {
                found = Some(inv);
                break;
            }
        }
        if let Some(inv) = found {
            return NewScan::Hit(inv);
        }
    }
    if saw_candidate {
        return NewScan::Broken(
            "这串邀请码的校验位不对——多半是被改动过、或只复制到了一半。\
             请回到对方那台机器整段重新复制一次（从 PP1 到末尾 4 位）。"
                .to_string(),
        );
    }
    NewScan::Absent
}

/// 把 base58 载荷（不含校验）解成 [`Invite`]；校验不过 / 结构不对返回 `None`。
fn parse_payload(collected: &str, now_ms: i64) -> Option<Invite> {
    let (body, check) = collected.split_at(collected.len() - 4);
    let payload = b58_decode(body)?;
    if payload.len() < 32 {
        return None;
    }
    let expect = checksum_of(&payload);
    if check.chars().enumerate().any(|(i, ch)| ch != expect[i]) {
        return None;
    }
    let node_id = super::identity::to_hex(&payload[..32]);
    // 名字按 UTF-8 解；解不开 = 码被截断在多字节字符中间，按校验失败处理
    let name = std::str::from_utf8(&payload[32..]).ok()?.trim().to_string();
    Some(Invite {
        node_id,
        name,
        addrs: Vec::new(),
        ts: now_ms,
    })
}

// ===== v1 旧码（只读；生成器仅供测试对拍）=====

#[derive(Debug, Serialize, Deserialize)]
struct WireV1 {
    #[serde(flatten)]
    invite: Invite,
    /// 签名的 base64url。**可选**：B1 之后新码不带签名，v1 码才带。
    sig: Option<String>,
}

/// v1 的「待签名规范字节」。🔴 生成端与校验端必须逐字一致，**不要重排**。
fn signing_bytes(v: &Invite) -> Vec<u8> {
    format!(
        "pastepanda-invite-v1\n{}\n{}\n{}\n{}",
        v.node_id,
        v.name,
        v.addrs.join(","),
        v.ts
    )
    .into_bytes()
}

/// v1 生成器（JSON+自签，308 字符那版）。**生产编码不走这里**——
/// 保留它是为了让「旧码仍可读」的兼容路径有对拍物：旧行为的全部测试
/// （签名拦篡改、ts 拦过期）都靠它造旧码。
#[cfg(test)]
pub(super) fn v1_encode(
    me: &super::identity::NodeIdentity,
    name: &str,
    addrs: Vec<String>,
    now_ms: i64,
) -> Result<String, String> {
    let invite = Invite {
        node_id: me.node_id(),
        name: name.trim().to_string(),
        addrs,
        ts: now_ms,
    };
    let sig = me.sign(&signing_bytes(&invite))?;
    let wire = WireV1 {
        invite,
        sig: Some(b64().encode(sig)),
    };
    let json = serde_json::to_vec(&wire).map_err(|e| format!("序列化邀请码失败：{}", e))?;
    Ok(b64().encode(json))
}

/// v1 解码：base64 → JSON →（有签名才验签）→ ts 过期判定。
/// 每一种失败都给**不同**的话：用户手里只有一串 base64，
/// 统一报「邀请码无效」的话他无从下手（规则 #15.3）。
fn decode_v1(code: &str, now_ms: i64, ttl_secs: i64) -> Result<Invite, String> {
    let cleaned = normalize(code);

    // 🔴 先分开「多粘了别的文字」与「码本身坏了」——这是两种完全不同的失误，
    //   给同一句话会把人往错方向引。
    if cleaned.visible_junk > 0 {
        return Err(format!(
            "这串里混进了 {} 个不属于邀请码的字符（多半是把「邀请码：」这样的前缀、\
             或整段聊天内容一起粘进来了）。邀请码是一长串字母、数字和 - _，请只粘那一段。",
            cleaned.visible_junk
        ));
    }
    if cleaned.code.is_empty() {
        return Err("没有粘进任何邀请码内容".to_string());
    }

    // 洗过之后剩下的全是 base64url 字母，所以这里**只剩一种失败可能**：长度不合法
    // （len % 4 == 1）。文案因此可以直接指向真正的原因，不再猫一句狗一句。
    let raw = b64().decode(&cleaned.code).map_err(|_| {
        "这串邀请码长度不对，多半是只复制到了一半。请回到那台机器重新点一次「复制邀请码」"
    })?;
    let wire: WireV1 = serde_json::from_slice(&raw)
        .map_err(|_| "邀请码内容不完整或版本不对（解出来的不是邀请码结构）")?;

    if wire.invite.node_id.len() != 64 {
        return Err(format!(
            "邀请码里的 node_id 长度不对（{} 字符，应为 64）",
            wire.invite.node_id.len()
        ));
    }
    if let Some(sig) = &wire.sig {
        let sig = b64().decode(sig).map_err(|_| "邀请码里的签名解不开")?;
        super::identity::verify(&wire.invite.node_id, &signing_bytes(&wire.invite), &sig)
            .map_err(|e| format!("{}——这串码被改动过，或不是完整地粘过来的", e))?;
    }

    // 过期只判「太旧」，不判「来自未来」：对端时钟快几分钟是常态
    // （§7.5 说的就是这件事），因为时钟快一点就拒绝配对是自找麻烦。
    let age = now_ms - wire.invite.ts;
    if age > ttl_secs * 1000 {
        return Err(format!(
            "这份邀请码已过期（生成于 {}前，有效期 {}）。请在对方那台重新生成一份。",
            human_span_ms(age),
            human_span_secs(ttl_secs)
        ));
    }
    Ok(wire.invite)
}

/// 把秒数说成人话。用于「有效期」这类**预先知道**的量。
///
/// 只保留一个数量级：窗口要么是几十分钟、要么是几天，
/// 写「有效期 168 小时」比写「7 天」难读（旧文案写「有效期 0 天」更糟——
/// 30 分钟的窗口整除 86400 就是 0）。
fn human_span_secs(secs: i64) -> String {
    if secs < 3600 {
        format!("{} 分钟", secs / 60)
    } else if secs < 86_400 {
        format!("{} 小时", secs / 3600)
    } else {
        format!("{} 天", secs / 86_400)
    }
}

/// 把「已经过去了多久」说成人话。向上取整到分钟：差 20 秒说「0 分钟前」很怪。
fn human_span_ms(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    if secs < 3600 {
        format!("{} 分钟", (secs + 59) / 60)
    } else if secs < 86_400 {
        format!("{} 小时", secs / 3600)
    } else {
        format!("{} 天", secs / 86_400)
    }
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// [`normalize`] 的结果。
struct Cleaned {
    /// 洗完之后的纯 base64url 串。
    code: String,
    /// 丢掉的**看得见**的字符数。只用来决定错误话术，不影响解码。
    visible_junk: usize,
}

/// 把人手搬运过的 v1 邀请码洗成解码器能吃的形式。
///
/// # 🔴 用白名单，不用黑名单
///
/// 邀请码是靠人在微信 / 邮件 / 便笺之间搬的，路上会被插入软换行、空格、
/// 以及各种**肉眼完全看不见**的格式字符——所以“用户核对过邀请码是对的”与
/// “程序说解不开”可以同时成立。
///
/// 2026-09-06 的第一版修复用的是**黑名单**（`is_whitespace()` 加上列举
/// ZWSP/ZWNJ/ZWJ/BOM），但那份名单**在构造上就不可能完整**——复查时一次就又找出五个漏网的：
///   - `U+200E` LRM / `U+200F` RLM（富文本控件、聊天软件会插）
///   - `U+2060` WORD JOINER（排版控件的折行点）
///   - `U+00AD` 软连字符（编辑器在长串**折行处**插的，正是本 bug 最典型的场景）
///   - `U+2066`..`U+2069` 方向隔离符
///
/// 它们全是 Cf 类格式字符，`char::is_whitespace()` 一个都不认（White_Space=No）。
///
/// 改成**只保留 base64url 字母表** `[A-Za-z0-9_-]`，就没有「漏了哪一个」这回事了。
/// 放宽不降低安全性：真正把关的是下面那道**签名校验**，洗字符只能让合法的码能读，
/// 变不出一个能过签名的码。
///
/// 顺带兼容标准字母表（`+/`）与尾部 `=` 填充：本地只会发 URL_SAFE_NO_PAD，
/// 但码可能经过别的系统转手。
fn normalize(code: &str) -> Cleaned {
    let mut out = String::with_capacity(code.len());
    let mut visible_junk = 0usize;
    for c in code.chars() {
        // 标准字母表 → URL 安全字母表
        let c = match c {
            '+' => '-',
            '/' => '_',
            c => c,
        };
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c == '=' || c.is_whitespace() {
            // 填充与空白：预期之内，静静丢掉
            // （解码器是 NO_PAD 模式，看到 `=` 反而会报错）
        } else if c.is_alphanumeric() || c.is_ascii_graphic() {
            // 看得见的杂字：多半是把「邀请码：」之类的前缀或整段聊天一起粘进来了。
            //
            // ❗ 这个判据是**近似**的（全角标点如「：」既不是 alphanumeric 也不是
            //   ascii_graphic，会被当成不可见字符）。但它**只决定报哪一句话**，
            //   不影响能不能解码，所以不值得为此引一个 Unicode 分类库。
            visible_junk += 1;
        }
        // 其余（零宽、方向标记、软连字符……）一律静静丢掉
    }
    Cleaned {
        code: out,
        visible_junk,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base58与crc32用已知向量钉住() {
        // 手写实现最容易错的是前导零与进位方向，两条各钉一头：
        // [0,0,1] → 两个前导零各编码成 '1'，字节值 1 是字母表第 1 位 '2'
        assert_eq!(b58_encode(&[0, 0, 1]), "112");
        assert_eq!(b58_decode("112"), Some(vec![0, 0, 1]));
        // 32 字节全 0：每个零字节编码成一个 '1'（44 是**随机** 32 字节的常规长度，
        // 别跟它混——前导零走的是 base58 的专用规则）
        assert_eq!(b58_encode(&[0u8; 32]), "1".repeat(32));
        // CRC32("123456789") = 0xCBF43926（IEEE 标准向量）
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn 校验位与载荷互相对应() {
        let payload = b"pastepanda-checksum-roundtrip";
        let expect = checksum_of(payload);
        let check: String = expect.iter().collect();
        assert_eq!(check.len(), 4);
        assert!(check.chars().all(|c| B58_ALPHABET.contains(&(c as u8))));
        // 同载荷同校验、改一位载荷校验应当变化
        let mut other = payload.to_vec();
        other[0] ^= 1;
        assert_ne!(checksum_of(&other), expect);
    }

    /// 🔴 回归钉（tmp_a1 实测 20/300 命中）：**43 位 body 的短码必须能解回**。
    ///
    /// 32 字节公钥的 base58 多数是 44 位，但数值 < 58^43 的公钥（约 6%）只有
    /// 43 位 ⇒ 空名码整段 47 字符。下限曾是 48，把自家生成、自家都解不开的码
    /// 推进 v1 路径报「解出来的不是邀请码结构」。`[0x01; 32]` 的数值 ≈2^248，
    /// 落在 58^42 与 58^43 之间 ⇒ **确定性**造出 43 位 body，不用赌随机身份。
    #[test]
    fn test_43位body的短码必须能解回() {
        let payload = [0x01u8; 32]; // 无名字：载荷就是 32 字节公钥
        let body = b58_encode(&payload);
        assert_eq!(body.chars().count(), 43, "构造前提：body 恰好 43 位");
        let check: String = checksum_of(&payload).iter().collect();
        let code = format!("PP1-{}-{}", body, check);
        assert_eq!(code.chars().count(), 52); // 9（PP1- 与 - 与校验 4 位）+ 43 位 body

        let inv = decode(&code, 1_000_000, RC_TTL_SECS).expect("43 位 body 的码不能被下限挡掉");
        assert_eq!(inv.node_id, crate::sync::identity::to_hex(&payload));
        assert_eq!(inv.name, "");
    }
}
