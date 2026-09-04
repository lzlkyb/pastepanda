//! M6-P1 身份与邀请码的测试。

use super::identity::NodeIdentity;
use super::invite;

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pp_sync_{}_{}", tag, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ===== 身份 =====

#[test]
fn test_身份落盘后重启是同一个() {
    let dir = tmp_dir("id");
    let a = NodeIdentity::load_or_create(&dir).unwrap();
    let b = NodeIdentity::load_or_create(&dir).unwrap();
    assert_eq!(a.node_id(), b.node_id(), "重启后身份变了 = 所有已配对设备都认不出这台机器");
    assert_eq!(a.node_id().len(), 64, "node_id 应为 32 字节的 hex");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_两台机器的身份不同() {
    let (d1, d2) = (tmp_dir("id1"), tmp_dir("id2"));
    let a = NodeIdentity::load_or_create(&d1).unwrap();
    let b = NodeIdentity::load_or_create(&d2).unwrap();
    assert_ne!(a.node_id(), b.node_id());
    let _ = std::fs::remove_dir_all(&d1);
    let _ = std::fs::remove_dir_all(&d2);
}

/// 🔴 身份文件损坏时**报错**，不自动换新身份。
///
/// 与 `mcp::token` 的「解不开就重建」故意不同：令牌丢了重发一个就行，
/// 身份丢了意味着所有已配对设备都认不出这台机器——那必须让用户看见。
#[test]
fn test_身份文件损坏时报错而不是悄悄换一个() {
    let dir = tmp_dir("bad");
    let first = NodeIdentity::load_or_create(&dir).unwrap();
    std::fs::write(dir.join("sync_node_key.bin"), b"not a dpapi blob").unwrap();

    let e = NodeIdentity::load_or_create(&dir).expect_err("损坏的身份文件必须报错");
    assert!(e.contains("不会自动换新身份"), "错误信息要说清后果：{}", e);
    assert!(e.contains("sync_node_key.bin"), "要告诉用户删哪个文件才能重建：{}", e);
    drop(first);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_签名能验通而改一个字节就验不通() {
    let dir = tmp_dir("sig");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let msg = b"hello sync";
    let sig = me.sign(msg).unwrap();

    assert!(super::identity::verify(&me.node_id(), msg, &sig).is_ok());
    assert!(
        super::identity::verify(&me.node_id(), b"hello synd", &sig).is_err(),
        "消息改了签名还能过 = 校验没起作用"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_短指纹是node_id的前缀且分组() {
    let dir = tmp_dir("fp");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let fp = me.fingerprint();
    assert_eq!(fp.len(), 19, "4 组 4 字符 + 3 个连字符：{}", fp);
    assert_eq!(fp.replace('-', ""), me.node_id()[..16], "指纹必须真的是 node_id 的前缀");
    let _ = std::fs::remove_dir_all(&dir);
}

// ===== 邀请码 =====

const NOW: i64 = 1_788_500_000_000;

#[test]
fn test_邀请码能原样解回来() {
    let dir = tmp_dir("inv");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "书房台式机", vec!["192.168.1.7:5007".into()], NOW).unwrap();

    let got = invite::decode(&code, NOW + 1000).unwrap();
    assert_eq!(got.node_id, me.node_id());
    assert_eq!(got.name, "书房台式机");
    assert_eq!(got.addrs, vec!["192.168.1.7:5007"]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 🔴 签名管**完整性**：码被改一个字符就该拒，而不是配上一个错身份。
#[test]
fn test_改动过的邀请码拒绝() {
    let dir = tmp_dir("tamper");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "书房台式机", vec![], NOW).unwrap();

    // 解出 JSON、把设备名改掉、再编回去——签名覆盖了 name，所以必须验不过。
    let raw = base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        &code,
    )
    .unwrap();
    let s = String::from_utf8(raw).unwrap().replace("书房台式机", "攻击者的机器");
    let bad = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, s);

    let e = invite::decode(&bad, NOW).expect_err("改过的码必须拒");
    assert!(e.contains("被改动过"), "{}", e);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_截断的邀请码给得出所以然的错() {
    // 用户手里只有一串 base64，统一报「无效」的话他无从下手（规则 #15.3）。
    let e = invite::decode("这显然不是邀请码", NOW).expect_err("该拒");
    assert!(e.contains("base64"), "要指出是复制缺字符：{}", e);
}

#[test]
fn test_过期的邀请码拒绝且说清怎么办() {
    let dir = tmp_dir("old");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "老机器", vec![], NOW).unwrap();

    let later = NOW + (invite::TTL_SECS + 1) * 1000;
    let e = invite::decode(&code, later).expect_err("过期必须拒");
    assert!(e.contains("已过期") && e.contains("重新生成"), "{}", e);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 对端时钟**快**一点不该拒绝配对。
///
/// §7.5 说的就是这件事：两台机器差几秒到几分钟是常态。
/// 因为时钟快就拒绝配对是自找麻烦，所以只判「太旧」，不判「来自未来」。
#[test]
fn test_对端时钟稍快不影响配对() {
    let dir = tmp_dir("skew");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    // 码上的时间比本机「现在」晚 5 分钟
    let code = invite::encode(&me, "快五分钟的机器", vec![], NOW + 300_000).unwrap();
    assert!(invite::decode(&code, NOW).is_ok(), "对端时钟快 5 分钟就配不上，那没法用");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 🔴 `{:?}` 不能把私钥打出来。
///
/// 这条是补出来的：第一版 `NodeIdentity` 没有 `Debug`，加的时候差点顺手
/// `#[derive(Debug)]`——那会把 seed 打进每一句 `{:?}` 与每一次 panic 消息，
/// 而那两个地方都会进日志。
#[test]
fn test_debug输出里没有私钥() {
    let dir = tmp_dir("dbg");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let s = format!("{:?}", me);
    assert!(s.contains("已隐去"), "{}", s);
    assert!(s.contains(&me.fingerprint()), "指纹是公开信息，可以露：{}", s);
    // 私钥不是 node_id，但确认输出里没有任何 64 字符长的 hex 串。
    assert!(
        !s.split(|c: char| !c.is_ascii_hexdigit()).any(|t| t.len() >= 64),
        "输出里出现了 64 位以上的 hex，可能是密钥材料：{}",
        s
    );
    let _ = std::fs::remove_dir_all(&dir);
}
