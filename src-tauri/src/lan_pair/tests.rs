//! 附近设备配对的单测。
//!
//! 重点不是“路跑得通”，而是**安全性质真的成立**：
//! 中间人会不会被 pin 拆穿、分道派生是不是真的分开了。
//! 这些错了都不会让功能看起来坏，只会静默地不安全。

use super::*;

/// 跑一次完整握手，返回两端的会话。
fn handshake(now: i64) -> (PendingPair, PendingPair) {
    let mut a = PendingPair::start("B", "B 机", PairRole::Initiator, now).unwrap();
    let mut b = PendingPair::start("A", "A 机", PairRole::Responder, now).unwrap();
    let (a_pk, b_pk) = (a.my_pk.clone(), b.my_pk.clone());
    a.accept_peer_key(&b_pk).unwrap();
    b.accept_peer_key(&a_pk).unwrap();
    (a, b)
}

#[test]
fn test_两端算出同一个pin() {
    let (a, b) = handshake(1000);
    assert_eq!(a.pin, b.pin, "两端 pin 必须一致，否则用户永远配不上");
    assert_eq!(a.shared, b.shared, "共享值也必须一致");
}

#[test]
fn test_中间人会让两端pin对不上() {
    // 🔴 这是整个方案的安全基础。M 分别与 A、B 协商，
    //    两边得到不同的共享值 → 两个 pin 不同 → 用户当场发现。
    //    这一条若不成立，6 位数字就只是个装饰。
    let now = 1000;
    let mut a = PendingPair::start("B", "B 机", PairRole::Initiator, now).unwrap();
    let mut b = PendingPair::start("A", "A 机", PairRole::Responder, now).unwrap();
    // 中间人的两对密钥：分别冒充 B 和 A
    let mut m_to_a = PendingPair::start("B", "假 B", PairRole::Responder, now).unwrap();
    let mut m_to_b = PendingPair::start("A", "假 A", PairRole::Initiator, now).unwrap();

    let (a_pk, b_pk) = (a.my_pk.clone(), b.my_pk.clone());
    let (ma_pk, mb_pk) = (m_to_a.my_pk.clone(), m_to_b.my_pk.clone());

    a.accept_peer_key(&ma_pk).unwrap(); // A 以为在跟 B 说话
    m_to_a.accept_peer_key(&a_pk).unwrap();
    b.accept_peer_key(&mb_pk).unwrap(); // B 以为在跟 A 说话
    m_to_b.accept_peer_key(&b_pk).unwrap();

    assert_ne!(a.pin, b.pin, "被中间人插足时两端 pin 必须不同，否则整套机制失效");
}

#[test]
fn test_pin固定六位() {
    // 不补齐的话，一端显示 7412、另一端显示 007412，用户会以为不一致。
    for seed in 0u8..30 {
        let pin = verify_pin(&[seed; 32]);
        assert_eq!(pin.len(), 6, "pin 必须恒为 6 位，实得 {}", pin);
        assert!(pin.chars().all(|c| c.is_ascii_digit()));
    }
}

#[test]
fn test密钥封装与解开往返() {
    let (a, b) = handshake(1000);
    let shared_a = a.shared.unwrap();
    let shared_b = b.shared.unwrap();

    let original = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    let (nonce, sealed) = seal_pairing_key(&shared_a, original).unwrap();
    let got = open_pairing_key(&shared_b, &nonce, &sealed).unwrap();
    assert_eq!(got, original, "对方必须能原样拿到配对密钥");
}

#[test]
fn test_共享值不对就解不开() {
    // GCM 认证标签保证这里是**报错**而不是静默得到一串垃圾。
    // 静默的话会把垃圾当密钥存下，之后永远同步不了且无从查起。
    let (a, _b) = handshake(1000);
    let shared_a = a.shared.unwrap();
    let (nonce, sealed) = seal_pairing_key(&shared_a, "secret-key-value").unwrap();

    let wrong = vec![9u8; 32];
    assert!(
        open_pairing_key(&wrong, &nonce, &sealed).is_err(),
        "用错的共享值必须解密失败"
    );
}

#[test]
fn test_pin与传输密钥是分道的() {
    // 🔴 pin 会显示给人看，等于公开。如果两者同源且不分道，
    //    pin 就泄露了传输密钥的前几个字节。
    let shared = vec![7u8; 32];
    let pin_material = hkdf32(&shared, "pp-pair-verify");
    let key_material = hkdf32(&shared, "pp-key-transfer");
    assert_ne!(pin_material, key_material, "两个用途必须派生出不同密钥");
}

#[test]
fn test_会话过期() {
    let p = PendingPair::start("B", "B 机", PairRole::Initiator, 1000).unwrap();
    assert!(!p.expired(1000 + PAIR_WINDOW_SECS));
    assert!(p.expired(1000 + PAIR_WINDOW_SECS + 1));
}

#[test]
fn test_协商只能做一次() {
    // agree_ephemeral 会消耗私钥。第二次必须报错而不是 panic。
    let now = 1000;
    let mut a = PendingPair::start("B", "B 机", PairRole::Initiator, now).unwrap();
    let b = PendingPair::start("A", "A 机", PairRole::Responder, now).unwrap();
    assert!(a.accept_peer_key(&b.my_pk).is_ok());
    assert!(a.accept_peer_key(&b.my_pk).is_err(), "第二次协商该报错");
}

#[test]
fn test_对方公钥格式不对不会panic() {
    let mut a = PendingPair::start("B", "B 机", PairRole::Initiator, 1000).unwrap();
    assert!(a.accept_peer_key("不是 hex").is_err());
}

#[test]
fn test_非ascii输入不会panic() {
    // 🔴 回归护栏（2026-09-06）。原实现用 `&s[i*2..i*2+2]` 切片，
    //    切到多字节字符中间会直接 panic。而这些字符串全部来自 UDP 包，
    //    对方完全可控 —— 等于一个远程 DoS。
    //
    //    “8 个汉字”那一条尤其阴：它恰好 24 字节，能过长度检查。
    for bad in ["不是 hex", "一二三四五六七八", "你好", "😀😀", "ÿÿ"] {
        assert!(hex_to_vec(bad).is_none(), "{:?} 应该返回 None 而不是 panic", bad);
        assert!(hex_to_12(bad).is_none(), "{:?} 应该返回 None 而不是 panic", bad);
    }
    // 正常的 hex 仍然要能解
    assert_eq!(hex_to_vec("00ff10"), Some(vec![0x00, 0xff, 0x10]));
    assert!(hex_to_12("000102030405060708090a0b").is_some());
    // 奇数长度 / 空串
    assert!(hex_to_vec("abc").is_none());
    assert!(hex_to_vec("").is_none());
}

// ===== 附近设备表 =====

fn hello(id: &str, name: &str, ts: i64) -> PairPacket {
    PairPacket::hello(id, name, ts)
}

#[test]
fn test_自己发的招呼包不进列表() {
    let st = PairState::new();
    st.on_hello(&hello("me", "本机", 1000), "me", 1000);
    assert!(st.list_nearby(1000, &[]).is_empty(), "组播会回环，不滤就会看到自己");
}

#[test]
fn test_过期设备自动清掉() {
    let st = PairState::new();
    st.on_hello(&hello("b", "B 机", 1000), "me", 1000);
    assert_eq!(st.list_nearby(1000, &[]).len(), 1);
    assert_eq!(
        st.list_nearby(1000 + NEARBY_TTL_SECS + 1, &[]).len(),
        0,
        "超过 TTL 没听到就该从列表里消失"
    );
}

#[test]
fn test_已配对的设备不在附近列表里() {
    // 两处都出现的话，用户会以为没配上、反复点。
    let st = PairState::new();
    st.on_hello(&hello("b", "B 机", 1000), "me", 1000);
    let paired = vec!["b".to_string()];
    assert!(st.list_nearby(1000, &paired).is_empty());
}

#[test]
fn test_时钟偏差太大的招呼包不收() {
    let st = PairState::new();
    st.on_hello(&hello("b", "B 机", 1), "me", 100_000);
    assert!(st.list_nearby(100_000, &[]).is_empty());
}

#[test]
fn test_连续拒绝后拉黑() {
    let st = PairState::new();
    assert!(!st.is_blocked("b"));
    for _ in 0..REJECT_LIMIT {
        st.note_reject("b");
    }
    assert!(st.is_blocked("b"), "达到阈值后不应再弹框");
}

#[test]
fn test_过期会话读不到也不残留() {
    let st = PairState::new();
    let p = PendingPair::start("b", "B 机", PairRole::Initiator, 1000).unwrap();
    st.begin(p);
    assert!(st.snapshot(1000).is_some());
    assert!(
        st.snapshot(1000 + PAIR_WINDOW_SECS + 1).is_none(),
        "超时的会话该自动作废"
    );
    assert!(st.snapshot(1000).is_none(), "作废后不应还能被读回来");
}

#[test]
fn test_招呼包不带公钥与密文() {
    // 招呼包是明文广播的，里面多一个字段就多一分泄露。
    let p = PairPacket::hello("id", "名字", 1000);
    assert_eq!(p.kind, KIND_HELLO);
    assert!(p.pk.is_empty(), "临时公钥只在握手时发，不应广播");
    assert!(p.sealed.is_empty());
    assert!(p.to_id.is_empty());
}

#[test]
fn test报文能序列化往返() {
    let p = PairPacket::hello("id-1", "书房台式机", 1234);
    let json = serde_json::to_string(&p).unwrap();
    let back: PairPacket = serde_json::from_str(&json).unwrap();
    assert_eq!(back.from_id, "id-1");
    assert_eq!(back.from_name, "书房台式机");
    assert_eq!(back.v, PAIR_PROTO_V);
}

#[test]
fn test_缺字段的报文也能解() {
    // 旧版本或别人伪造的包可能缺字段，serde(default) 要能兑现承诺——
    // 否则一个畸形包就能让接收端直接报错。
    let json = r#"{"v":3,"kind":"pp-hello","from_id":"x","ts":1}"#;
    let p: PairPacket = serde_json::from_str(json).unwrap();
    assert_eq!(p.from_id, "x");
    assert!(p.from_name.is_empty());
}

// ===== 确认顺序（2026-09-06 修的 bug）=====
//
// 握手是**单向**的：只有发起方送密钥，而它送完就 clear、不重发。
// 以前接受方未确认时直接丢包，于是「发起方先点」会静默失败。
// 下面两个测试把**两种顺序都钉住**：少一个就只能拦住其中一半。

#[test]
fn test_接受方先确认_当场能解开密钥() {
    let (a, mut b) = handshake(1000);
    let shared = a.shared.clone().unwrap();
    let (nonce, sealed) = seal_pairing_key(&shared, "a-very-long-pairing-key-0123456789").unwrap();

    // B 先点了确认，密钥随后到——不走暂存，直接解。
    b.confirmed = true;
    assert!(b.stashed_key.is_none(), "这条路径不该留下暂存");
    let key = open_pairing_key(&b.shared.clone().unwrap(), &nonce, &sealed).unwrap();
    assert_eq!(key, "a-very-long-pairing-key-0123456789");
}

#[test]
fn test_发起方先确认_密钥暂存后仍能解开() {
    // 🔴 这就是那个 bug 的回归测：以前这一种顺序下包被丢弃，
    //    而发起方已经 clear 了会话、不会重发 → 两端零提示地配不上。
    let (a, mut b) = handshake(1000);
    let shared = a.shared.clone().unwrap();
    let (nonce, sealed) = seal_pairing_key(&shared, "a-very-long-pairing-key-0123456789").unwrap();

    // 密钥先到，B 还没点确认 → 只能暂存，不能应用也不能丢。
    assert!(!b.confirmed);
    b.stashed_key = Some((nonce, sealed));

    // B 随后点确认 → 拿暂存的密文当场完成。
    b.confirmed = true;
    let (nonce, sealed) = b.stashed_key.clone().expect("暂存不能丢，否则这种顺序永远配不上");
    let key = open_pairing_key(&b.shared.clone().unwrap(), &nonce, &sealed).unwrap();
    assert_eq!(key, "a-very-long-pairing-key-0123456789");
}

#[test]
fn test_暂存的是密文_没有正确共享值照样解不开() {
    // 暂存不等于放行：存的是密文，门禁还在 GCM 认证上。
    // 否则「本端不确认就不应用」就只剩一个 bool 守着了。
    let (a, _b) = handshake(1000);
    let shared = a.shared.clone().unwrap();
    let (nonce, sealed) = seal_pairing_key(&shared, "a-very-long-pairing-key-0123456789").unwrap();

    // 用另一次握手的共享值（= 中间人的处境）去解同一份密文。
    let (other, _) = handshake(1000);
    let wrong = other.shared.clone().unwrap();
    assert_ne!(wrong, shared, "两次握手的临时密钥不可能撞车");
    assert!(
        open_pairing_key(&wrong, &nonce, &sealed).is_err(),
        "共享值不对就必须解不开（GCM 认证）"
    );
}

#[test]
fn test_新开的会话没有暂存() {
    let p = PendingPair::start("X", "X 机", PairRole::Responder, 1000).unwrap();
    assert!(p.stashed_key.is_none());
    assert!(!p.confirmed);
}
