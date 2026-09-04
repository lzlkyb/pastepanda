//! 邀请码（M6-P1）。一端生成、另一端粘贴批准。
//!
//! # 🔴 签名能证明什么、不能证明什么
//!
//! 邀请码是**自签**的：里面的签名由码里那个 `node_id` 对应的私钥做出。
//! 所以它能证明「做这个码的人确实持有那把私钥」，
//! **不能证明这个码在传给你的路上没被换掉**——攻击者换成自己那一份，
//! 同样自签有效，校验一样通过。
//!
//! 这不是签名做得不好，是自签的固有边界。真正挡住替换的是**两端各自看
//! 自己的短指纹、口头核对一致**（[`super::identity::NodeIdentity::fingerprint`]），
//! 同 SSH host key 指纹与 Signal 安全码的做法。
//!
//! 那签名还留着干什么？挡两件更常见的事：
//! - **手滑改错**：码被截断、少粘了几个字符 → 校验不通过，而不是配上一个错身份
//! - **旧码复用**：`ts` 参与签名，配上过期时间就能拒掉压在聊天记录里的老码
//!
//! 换句话说：**签名管完整性，指纹管真实性。** 两者都要，缺一不可。
//!
//! # 编码
//!
//! `base64url_no_pad(JSON)`，JSON 里含明文字段与签名。不加密——
//! 邀请码里没有秘密（公钥、设备名、地址都是要给对端看的）。
//! 加密只会让「用户能不能看懂自己在粘什么」变差。

use base64::Engine;
use serde::{Deserialize, Serialize};

/// 邀请码有效期（秒）。7 天：够跨一个周末，又不至于让半年前的码还能用。
pub const TTL_SECS: i64 = 7 * 24 * 3600;

/// 邀请码的载荷。字段顺序即签名的字节顺序，**不要重排**。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Invite {
    /// 邀请方的 `NodeId`（公钥 hex）。
    pub node_id: String,
    /// 邀请方的设备名，纯展示。
    pub name: String,
    /// 可达地址（`ip:port`），LAN 用。可以为空——WAN 走 relay 时不需要。
    pub addrs: Vec<String>,
    /// 生成时刻（epoch 毫秒）。参与签名，用来拒旧码。
    pub ts: i64,
}

/// 待签名的规范字节。
///
/// 🔴 **不能直接签 `serde_json::to_vec(&invite)`**：JSON 的字段顺序与空白
/// 不受保证，序列化实现一变签名就全废。这里手拼一个固定格式。
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Wire {
    #[serde(flatten)]
    invite: Invite,
    /// 签名的 base64url。
    sig: String,
}

/// 生成邀请码。
pub fn encode(
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
    let wire = Wire {
        invite,
        sig: b64().encode(sig),
    };
    let json = serde_json::to_vec(&wire).map_err(|e| format!("序列化邀请码失败：{}", e))?;
    Ok(b64().encode(json))
}

/// 解码并校验邀请码。`now_ms` 传当前时刻，用来判过期。
///
/// 每一种失败都给**不同**的话：用户手里只有一串 base64，
/// 统一报「邀请码无效」的话他无从下手（规则 #15.3）。
pub fn decode(code: &str, now_ms: i64) -> Result<Invite, String> {
    let raw = b64()
        .decode(code.trim())
        .map_err(|_| "这串不是有效的邀请码（base64 解不开，可能是复制时少了几个字符）")?;
    let wire: Wire = serde_json::from_slice(&raw)
        .map_err(|_| "邀请码内容不完整或版本不对（解出来的不是邀请码结构）")?;

    if wire.invite.node_id.len() != 64 {
        return Err(format!(
            "邀请码里的 node_id 长度不对（{} 字符，应为 64）",
            wire.invite.node_id.len()
        ));
    }
    let sig = b64()
        .decode(&wire.sig)
        .map_err(|_| "邀请码里的签名解不开")?;
    super::identity::verify(&wire.invite.node_id, &signing_bytes(&wire.invite), &sig)
        .map_err(|e| format!("{}——这串码被改动过，或不是完整地粘过来的", e))?;

    // 过期只判「太旧」，不判「来自未来」：对端时钟快几分钟是常态
    // （§7.5 说的就是这件事），因为时钟快一点就拒绝配对是自找麻烦。
    let age = now_ms - wire.invite.ts;
    if age > TTL_SECS * 1000 {
        return Err(format!(
            "这个邀请码已过期（生成于 {} 天前，有效期 {} 天）。请在对方那台机器上重新生成一个。",
            age / 86_400_000,
            TTL_SECS / 86_400
        ));
    }
    Ok(wire.invite)
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}
