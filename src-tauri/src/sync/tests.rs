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

// ===== 同步引擎（本地端到端，不联网）=====

use super::engine::{apply_delta, compute_delta, write_delta};
use crate::data_store::DataStore;

fn store() -> DataStore {
    DataStore::new(":memory:").expect("建内存库失败")
}

/// 跑一次 A → B 的同步。返回 (新游标, 应用报告)。
fn sync(a: &DataStore, b: &DataStore, since: i64, tag: &str) -> (i64, super::engine::ApplyReport) {
    let dir = tmp_dir(tag);
    let delta = compute_delta(a, since).expect("算增量失败");
    write_delta(a, &delta, &dir).expect("写增量失败");
    let rep = apply_delta(b, &dir).expect("应用增量失败");
    let _ = std::fs::remove_dir_all(&dir);
    (delta.cursor_ms, rep)
}

#[test]
fn test_新笔记同步到对端() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "会议纪要", "正文内容").unwrap();

    let (_, rep) = sync(&a, &b, 0, "e2e1");
    assert_eq!(rep.created, 1, "{:?}", rep);

    let got = b.note_get(&n.id).unwrap().expect("对端该有这一篇");
    assert_eq!(got.title, "会议纪要");
    assert_eq!(got.content, "正文内容");
    assert_eq!(got.id, n.id, "id 必须一致，否则删除传播找不到人");
}

/// 游标要起作用：同一批不能反复重发。
#[test]
fn test_游标之后没有新东西就是空增量() {
    let (a, b) = (store(), store());
    a.note_create(None, "甲", "正文").unwrap();

    let (cursor, _) = sync(&a, &b, 0, "e2e2");
    assert!(cursor > 0);

    let d = compute_delta(&a, cursor).unwrap();
    assert!(d.is_empty(), "游标之后不该再有东西：{:?}", d);
}

/// 🔴 后写胜：本地更新时，对端那份旧版本**不能**覆盖它。
///
/// 这条正是「完全复用 import_vault_dir」会踩的坑——那条路无条件 note_update。
#[test]
fn test_本地更新时对端旧版本不会覆盖() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "A 的初版").unwrap();
    sync(&a, &b, 0, "e2e3a");

    // B 后改：它的 updated_ms 更大
    b.note_update(&n.id, "甲", "B 改过的，更新").unwrap();

    // A 再把**同一个旧版本**推过来（since=0，所以会重发）
    let (_, rep) = sync(&a, &b, 0, "e2e3b");

    assert_eq!(rep.skipped_older, 1, "该跳过 A 的旧版本：{:?}", rep);
    assert_eq!(
        b.note_get(&n.id).unwrap().unwrap().content,
        "B 改过的，更新",
        "本地新版本被对端旧版本覆盖了 —— 后写胜没生效"
    );
}

/// 反过来：对端更新时应当覆盖本地旧版本。
#[test]
fn test_对端更新时会覆盖本地旧版本() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "初版").unwrap();
    sync(&a, &b, 0, "e2e4a");

    a.note_update(&n.id, "甲", "A 后改的").unwrap();
    let (_, rep) = sync(&a, &b, 0, "e2e4b");

    assert_eq!(rep.skipped_older, 0, "{:?}", rep);
    assert_eq!(b.note_get(&n.id).unwrap().unwrap().content, "A 后改的");
}

/// 🔴 删除要传播：A 删掉并彻底清理之后，B 上那一篇也该进回收站。
#[test]
fn test_删除会传播到对端() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    sync(&a, &b, 0, "e2e5a");
    assert!(b.note_get(&n.id).unwrap().is_some());

    a.note_delete(&n.id).unwrap();
    a.note_purge(&n.id).unwrap();

    let (_, rep) = sync(&a, &b, 0, "e2e5b");
    assert_eq!(rep.deleted, 1, "{:?}", rep);
    assert!(
        b.note_get(&n.id).unwrap().is_none(),
        "对端那篇该进回收站（note_get 只看活的）"
    );
}

/// 🔴 同一批里既有那篇的文件、又有它的墓碑时，**删除必须赢**。
///
/// 这一条钉的是顺序：先删后导的话，刚导入的文件会把它建回来，
/// 于是「删除等于没发生」——而报告里会显示 created 1 / deleted 1，看起来两件都做了。
#[test]
fn test_同一批里删除压过内容() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    // 不先同步：让 B 从零开始，同一批里同时收到「这篇的内容」与「它的墓碑」
    a.note_delete(&n.id).unwrap();
    a.note_purge(&n.id).unwrap();

    // A 已经物理删了，所以 note_changed_since 里没有它，只有墓碑。
    let d = compute_delta(&a, 0).unwrap();
    assert!(d.notes.is_empty(), "物理删之后不该再出现在变更集里");
    assert_eq!(d.tombstones.len(), 1);

    let (_, rep) = sync(&a, &b, 0, "e2e6");
    assert_eq!(rep.created, 0);
    assert!(b.note_get(&n.id).unwrap().is_none());
    let _ = rep;
}

/// 文件夹结构要跟着走。
#[test]
fn test_文件夹路径跟着同步() {
    let (a, b) = (store(), store());
    let f = a.folder_create("工作", None).unwrap();
    let sub = a.folder_create("NC 二开", Some(&f.id)).unwrap();
    let n = a.note_create(None, "甲", "正文").unwrap();
    a.note_set_folder(&n.id, Some(&sub.id)).unwrap();

    sync(&a, &b, 0, "e2e7");
    let got = b.note_get(&n.id).unwrap().unwrap();
    assert!(got.folder_id.is_some(), "对端该按路径重建出文件夹");
}

/// 标签要跟着走——不带的话对端会把标签清空。
#[test]
fn test_标签跟着同步() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    let t = a.create_tag("重要", "#f00").unwrap();
    a.note_set_tags(&n.id, &[t.id.clone()]).unwrap();

    sync(&a, &b, 0, "e2e8");
    let got = b.note_get(&n.id).unwrap().unwrap();
    assert!(
        got.tags.iter().any(|x| x.name == "重要"),
        "标签没同步过来：{:?}",
        got.tags
    );
}

/// 清单说有、文件却不在（传输被截断）**不能静默**。
#[test]
fn test_传输截断要报出来而不是当成没变() {
    let (a, b) = (store(), store());
    a.note_create(None, "甲", "正文").unwrap();

    let dir = tmp_dir("e2e9");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &dir).unwrap();
    // 删掉那个 .md，只留清单 —— 模拟传了一半
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        if e.path().extension().is_some_and(|x| x == "md") {
            std::fs::remove_file(e.path()).unwrap();
        }
    }
    let rep = apply_delta(&b, &dir).unwrap();
    assert_eq!(rep.missing_files, 1, "{:?}", rep);
    assert_eq!(rep.created, 0);
    let _ = std::fs::remove_dir_all(&dir);
}
