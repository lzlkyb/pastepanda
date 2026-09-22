//! PIN ok 附加证明（HMAC 派生与校验）与纯判定函数。

use super::*;

/// 什么情况下允许写 `rc_devices`。
///
/// 抽成**纯函数**是为了能在无网络、无库的环境下把这条不变量钉死
/// （规则 11.1：需要运行环境的部分与纯判断分开）。
///
/// # 🔴 这里没有「两端数字相同」这一条，不是漏了
///
/// 系统验不了它——「两端看到的数字一样」只有用户的眼睛能确认，而那正是
/// 「各自点一次确认」这一步存在的全部意义。函数名说的是**谁确认了**，
/// 不是**数字对不对**，免得后人以为这里该补一个比较。
///
/// ❗ `peer_ok` 的前置条件是 [`verify_pin_ok_proof`] 通过（P1-1）。
/// 本函数不重复验 proof——它只回答「确认状态齐了没有」。
pub fn commit_allowed(me_ok: bool, peer_ok: bool, pin_ready: bool, expired: bool) -> bool {
    me_ok && peer_ok && pin_ready && !expired
}

/// 一份待验证的 `pin_ok`（由明文包拆出；证明材料齐了才认）。
#[derive(Debug, Clone, PartialEq)]
pub struct PinOkIn {
    /// 发信人 node_id（= 对端）。
    pub peer_id: String,
    /// 本机 node_id（= 包里的 `to_id`，调用方已比对过）。
    pub my_node_id: String,
    /// 包内时间戳（参与证明绑定，不是接收时刻）。
    pub ts: i64,
    /// 附加证明 hex。**空 = 没带，拒**（P1-1）。
    pub ok_proof: String,
}

/// `pin_ok` 附加证明的消息字节。纯函数，收发两侧共用同一份绑定材料。
///
/// 绑 `"pin-ok"` 前缀（防跨用途重用）+ 发信人 + 收信人 + 包内 ts。
/// 不绑 `port`：证明走的是另一条信道（HMAC over shared），端口变化不影响语义。
pub fn pin_ok_proof_msg(node_id: &str, to_id: &str, ts: i64) -> String {
    format!("pin-ok|{node_id}|{to_id}|{ts}")
}

/// 算一份 `pin_ok` 证明：HMAC-SHA256(hkdf32(shared, "pp-pin-ok"), msg) 的 hex。
///
/// 🔴 HKDF info 与 pin / 密钥传输**分道**（同 `lan_pair::hkdf32` 的理由）：
/// pin 会显示给人看（等于公开），不能让证明材料与它同源。
pub fn pin_ok_proof(shared: &[u8], node_id: &str, to_id: &str, ts: i64) -> String {
    use ring::hmac;
    let key = hmac::Key::new(hmac::HMAC_SHA256, &hkdf32(shared, "pp-pin-ok"));
    let tag = hmac::sign(&key, pin_ok_proof_msg(node_id, to_id, ts).as_bytes());
    hex(tag.as_ref())
}

/// 验 `pin_ok` 证明。走 `ring::hmac::verify`（常数时间比对认证标签）。
pub fn verify_pin_ok_proof(
    shared: &[u8],
    node_id: &str,
    to_id: &str,
    ts: i64,
    proof_hex: &str,
) -> bool {
    if proof_hex.is_empty() {
        return false;
    }
    use ring::hmac;
    let Some(got) = crate::lan_pair::hex_to_vec(proof_hex) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, &hkdf32(shared, "pp-pin-ok"));
    hmac::verify(&key, pin_ok_proof_msg(node_id, to_id, ts).as_bytes(), &got).is_ok()
}

/// 该不该重发、重发哪一种。纯函数（时间由调用方传入）。
///
/// 两种要重发的情况：
/// - **发起方还没拿到对方的公钥**（`pin_req` 丢了）→ 重发 `pin_req`
/// - **本端确认了、对方还没确认**（`pin_ok` 丢了）→ 重发 `pin_ok`
///
/// ❗ 已经拿到双方公钥、且本端还没点确认的**不重发**：那时球在用户手里
/// （他在看数字），不是网络问题。
pub fn should_resend(
    initiator: bool,
    pin_ready: bool,
    me_ok: bool,
    peer_ok: bool,
    last_sent_ms: i64,
    now_ms: i64,
) -> Option<WireKind> {
    if now_ms - last_sent_ms < RESEND_MS {
        return None;
    }
    if initiator && !pin_ready {
        return Some(WireKind::PinReq);
    }
    if me_ok && !peer_ok {
        return Some(WireKind::PinOk);
    }
    None
}
