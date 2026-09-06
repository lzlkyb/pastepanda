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
    // 用户手里只有一串码，统一报「无效」的话他无从下手（规则 #15.3）。
    //
    // ❗ 断言的是**说法具体**，不再断言字面含 "base64"（2026-09-06 改）：
    //   “base64” 是用户看不懂的黑话，而旧文案「可能是复制时少了几个字符」
    //   还把人往错方向引——真正的常见原因是混进了看不见的字符（见下一条用例）。
    let e = invite::decode("这显然不是邀请码", NOW).expect_err("该拒");
    assert!(
        e.contains("不属于邀请码的字符") || e.contains("只复制到了一半"),
        "要说得出所以然，不能只报「无效」：{}",
        e
    );
}

#[test]
fn test_搬运途中混入的不可见字符不影响解码() {
    // 🔴 真实反馈（2026-09-06）：用户核实邀请码没错，却持续报「解不开」。
    // 邀请码靠人在微信 / 邮件 / 便笺之间搬，路上会被插入软换行、空格、
    // 零宽字符——这些**肉眼完全看不见**，所以“核对过是对的”与“程序说解不开”
    // 可以同时成立。旧实现只做了 `trim()`，只去得掉首尾空白。
    let dir = tmp_dir("dirty");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "书房台式机", vec![], NOW).unwrap();

    // 在中间插一堆看不见的东西：换行、回车、空格、制表符、零宽空格、BOM
    let mid = code.len() / 2;
    let dirty = format!(
        "  {}\n\r\t\u{200b}\u{feff} {}  ",
        &code[..mid],
        &code[mid..]
    );
    let inv = invite::decode(&dirty, NOW).expect("洗掉不可见字符后应该能解开");
    assert_eq!(inv.name, "书房台式机");
    assert_eq!(inv.node_id, me.node_id());

    // ❗ 放宽不能放到“改过的码也能过”：把身份字段改掉仍须被签名拦下。
    let tampered = dirty.replace("书房台式机", "别的机器");
    if tampered != dirty {
        assert!(invite::decode(&tampered, NOW).is_err(), "改过的码必须拒");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test黑名单漏掉的那五个不可见字符也要能洗掉() {
    // 🔴 2026-09-06 的第一版修复用黑名单列举不可见字符，复查时一次就又找出五个漏网的。
    // 它们全是 Cf 类格式字符，`is_whitespace()` 一个都不认（White_Space=No），
    // 所以旧实现会把它们当正常字符交给 base64 解码器 → 报「解不开」。
    //
    // 其中 U+00AD 软连字符最要紧：编辑器就是在长串的**折行处**插它的，
    // 而“长串在聊天框里被折行”正是本 bug 最典型的场景。
    //
    // 这条挂了 = 有人把白名单改回了黑名单。
    let dir = tmp_dir("invisible");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "书房台式机", vec![], NOW).unwrap();

    for (name, ch) in [
        ("U+200E LRM 左至右标记", '\u{200e}'),
        ("U+200F RLM 右至左标记", '\u{200f}'),
        ("U+2060 WORD JOINER", '\u{2060}'),
        ("U+00AD 软连字符", '\u{00ad}'),
        ("U+2066 方向隔离符", '\u{2066}'),
    ] {
        // 插在中间，模拟折行处被插入
        let mid = code.len() / 2;
        let dirty = format!("{}{}{}", &code[..mid], ch, &code[mid..]);
        let inv = invite::decode(&dirty, NOW)
            .unwrap_or_else(|e| panic!("{} 没被洗掉：{}", name, e));
        assert_eq!(inv.node_id, me.node_id(), "{}", name);
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test多粘了别的文字与码本身坏了要报不同的话() {
    // 两种完全不同的失误，给同一句话会把人往错方向引（规则 #15.3）。
    let dir = tmp_dir("junk");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "书房台式机", vec![], NOW).unwrap();

    // ① 把前缀一起粘进来了 → 要明确说「混进了别的字符」
    let with_prefix = format!("邀请码{}", code);
    let e1 = invite::decode(&with_prefix, NOW).expect_err("多粘了文字该拒");
    assert!(e1.contains("不属于邀请码的字符"), "该提示混入文字：{}", e1);

    // ② 只复制到一半 → 要明确说「只复制到了一半」，而不是说混入了字符
    //   造一个长度 %4==1 的截断（那是洗完之后唯一还能失败的情形）
    let cut = code.len() - (code.len() % 4) - 3;
    let truncated = &code[..cut + 1];
    let e2 = invite::decode(truncated, NOW).expect_err("截断的码该拒");
    assert!(
        !e2.contains("不属于邀请码的字符"),
        "截断不该报成「混入了字符」，那会让用户去找不存在的脏字符：{}",
        e2
    );

    // ③ 空串要单独一句，不能跟上面两种混
    let e3 = invite::decode("   \n  ", NOW).expect_err("空串该拒");
    assert!(e3.contains("没有粘进"), "空串要说清楚是空的：{}", e3);

    let _ = std::fs::remove_dir_all(&dir);
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
    sync_from(a, b, since, since, tag)
}

/// 同上，但发送游标与接收侧的「上次同步点」可以分开给。
///
/// 分开是因为**冲突检测只看接收侧那个游标**：拿旧游标重发一批
/// （`send_since` 小）不该被判成冲突，只有「上次同步之后两边都改过」才算。
fn sync_from(
    a: &DataStore,
    b: &DataStore,
    send_since: i64,
    recv_cursor: i64,
    tag: &str,
) -> (i64, super::engine::ApplyReport) {
    let dir = tmp_dir(tag);
    let delta = compute_delta(a, send_since).expect("算增量失败");
    write_delta(a, &delta, &dir).expect("写增量失败");
    let rep = apply_delta(b, &dir, recv_cursor).expect("应用增量失败");
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
    a.note_set_tags(&n.id, std::slice::from_ref(&t.id)).unwrap();

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
    let rep = apply_delta(&b, &dir, 0).unwrap();
    assert_eq!(rep.missing_files, 1, "{:?}", rep);
    assert_eq!(rep.created, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

// ===== HLC 端到端（§7.5 档②）=====

/// 🔴 HLC 存在的全部理由，端到端验一遍。
///
/// 场景（设计稿 §7.5 描述的那个静默丢数据）：
/// 1. A 改了一篇，同步给 B
/// 2. **B 的钟比 A 慢**，B 在看到 A 那版之后又改了一次
/// 3. A 再同步过来
///
/// 没有 HLC 时：B 那次编辑的 `updated_ms` 因为钟慢而比 A 的小 → 判输 →
/// **B 的改动被静默丢掉，还不进冲突列表**（不是同一毫秒）。
///
/// 有 HLC 时：B 应用 A 那批时先吸收了 A 的时钟，
/// 于是 B 之后发出的时间戳必定大于 A 那批 → B 赢。
#[test]
fn test_hlc_钟慢的一方在看到对端版本之后改的不会判输() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "A 的版本").unwrap();

    // 把 A 的时间戳人为推到「未来」，模拟 A 的钟比 B 快 2 分钟。
    //
    // ❗ 必须在 `MAX_FUTURE_SKEW_MS`（5 分钟）**之内**：超了就该被拒吸收，
    //   那是另一条用例要测的东西。第一版写了 1 小时，被下面那句守卫断言逮住。
    let a_future = crate::data_store::wall_ms_for_test() + 120_000;
    set_updated_ms(&a, &n.id, a_future);

    // B 应用 A 那批 —— 这一步会吸收 A 的时钟
    let (_, rep) = sync(&a, &b, 0, "hlc1");
    assert_eq!(rep.created, 1, "{:?}", rep);
    assert!(
        rep.clock_too_far_ahead_ms.is_none(),
        "1 小时在 5 分钟上限之外，本该被拒——这条用例要的是被吸收，改用例设计"
    );

    // B 在看到 A 那版之后改
    b.note_update(&n.id, "甲", "B 后改的").unwrap();
    let b_ms = b.note_updated_ms(&n.id).unwrap();
    assert!(
        b_ms > a_future,
        "B 钟慢，但它是后改的，时间戳必须更大：B={} A={}",
        b_ms,
        a_future
    );

    // A 再把自己那版推过来 —— 必须输
    let (_, rep) = sync(&a, &b, 0, "hlc2");
    assert_eq!(rep.skipped_older, 1, "A 的旧版本该被跳过：{:?}", rep);
    assert_eq!(
        b.note_get(&n.id).unwrap().unwrap().content,
        "B 后改的",
        "🔴 B 的编辑被 A 的旧版本覆盖了 —— 这正是 HLC 要修的那个静默丢数据"
    );
}

/// 对端时钟超前太多时**拒绝吸收，并把后果报出来**。
#[test]
fn test_hlc_对端时钟超前太多要报出来() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    // A 声称自己在 10 年后
    set_updated_ms(&a, &n.id, crate::data_store::wall_ms_for_test() + 10 * 365 * 86_400_000);

    let (_, rep) = sync(&a, &b, 0, "hlc3");
    let ahead = rep
        .clock_too_far_ahead_ms
        .expect("超前 10 年必须报出来，不能静默吸收");
    assert!(ahead > 0, "{:?}", rep);
}

/// HLC 下界要落盘：**吸收了远端但本机还没写东西**时，重启不能退回去。
#[test]
fn test_hlc_下界落盘后重启不回退() {
    let dir = tmp_dir("hlcfile");
    let db = dir.join("t.db").to_string_lossy().to_string();

    let future = crate::data_store::wall_ms_for_test() + 60_000; // 未来 1 分钟，在上限内
    {
        let s = DataStore::new(&db).unwrap();
        assert_eq!(
            s.absorb_remote_clock(future),
            crate::sync::hlc::Absorb::Ok
        );
        // 故意**不写任何笔记** —— 那个抬升只存在于内存里
    }
    {
        let s = DataStore::new(&db).unwrap();
        let n = s.note_create(None, "甲", "正文").unwrap();
        let ms = s.note_updated_ms(&n.id).unwrap();
        assert!(
            ms > future,
            "重启后下界退回去了：新笔记 {} 应大于已吸收的 {}",
            ms,
            future
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// 直接改 `updated_ms`，构造跨机时钟偏斜。
fn set_updated_ms(store: &DataStore, id: &str, ms: i64) {
    store
        .lock_conn()
        .execute(
            "UPDATE notes SET updated_ms = ?2 WHERE id = ?1",
            rusqlite::params![id, ms],
        )
        .expect("改 updated_ms 失败");
}

// ===== 真冲突（§7.4，判据已按 §7.5 重定义）=====

/// 🔴 两边都在上次同步之后改过 = 真冲突：输的那一份必须留下副本。
///
/// 这一条修的是 §7.4 的判据。原文说真冲突是「同毫秒两端不同改（概率极低）」，
/// 而 §7.5 已推翻它——**并发 + 时钟偏斜一点都不罕见**。
/// HLC 给了全序，但全序不告诉你并发：「B 看到 A 那版之后改的」和
/// 「B 独立改的」在时间戳上长得一样。游标是我们手里唯一的共同祖先标记。
#[test]
fn test_两边都改过时留下冲突副本() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "共同起点").unwrap();
    let (cursor, _) = sync(&a, &b, 0, "cf1");

    // 上次同步之后，两边各改一次
    b.note_update(&n.id, "甲", "B 改的").unwrap();
    a.note_update(&n.id, "甲", "A 改的").unwrap();

    let (_, rep) = sync_from(&a, &b, cursor, cursor, "cf2");
    assert_eq!(rep.conflicts, 1, "两边都改过该判冲突：{:?}", rep);

    // 冲突副本要能被 AM-7 的类别筛出来
    let copies = b
        .note_search("冲突副本", "all", &[], 10)
        .unwrap();
    assert_eq!(copies.len(), 1, "该留下一份冲突副本：{:?}", copies.len());
    assert!(
        crate::markdown::kinds_of(&copies[0].content).contains(&"conflict".to_string()),
        "副本里要有 - [conflict] 行，否则 kb_search(kind=conflict) 找不到它"
    );
}

/// 只有一边改过 ⇒ **不是**冲突，不该留副本。
///
/// 这条守的是「别凭空造冲突」：真实使用里绝大多数同步都是单边改动，
/// 每次都留副本的话知识库会被垃圾淹掉。
#[test]
fn test_只有一边改过不算冲突() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "共同起点").unwrap();
    let (cursor, _) = sync(&a, &b, 0, "cf3");

    a.note_update(&n.id, "甲", "只有 A 改了").unwrap();
    let (_, rep) = sync_from(&a, &b, cursor, cursor, "cf4");

    assert_eq!(rep.conflicts, 0, "{:?}", rep);
    assert_eq!(b.note_get(&n.id).unwrap().unwrap().content, "只有 A 改了");
    assert!(b.note_search("冲突副本", "all", &[], 10).unwrap().is_empty());
}

/// 拿**旧游标**重发一批（比如重试）不该被判成冲突。
#[test]
fn test_旧游标重发不判冲突() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    let (cursor, _) = sync(&a, &b, 0, "cf5");

    // 发送侧用 since=0 重发全部，但接收侧的同步点仍是 cursor
    let (_, rep) = sync_from(&a, &b, 0, cursor, "cf6");
    assert_eq!(rep.conflicts, 0, "重发不是冲突：{:?}", rep);
    let _ = n;
}

/// 首次同步（游标 0）时一切都算「对端的新东西」，不判冲突。
#[test]
fn test_首次同步不判冲突() {
    let (a, b) = (store(), store());
    a.note_create(None, "甲", "A 的").unwrap();
    b.note_create(None, "乙", "B 的").unwrap();

    let (_, rep) = sync(&a, &b, 0, "cf7");
    assert_eq!(rep.conflicts, 0, "首次同步不该判冲突：{:?}", rep);
}

/// 游标**不能退**：退了会把已同步过的东西当成「两边都改过」，凭空造一批副本。
#[test]
fn test_游标只前进不后退() {
    let store = store();
    store.device_pair("aa", "机器", "").unwrap();
    store.device_advance_cursor("aa", 500).unwrap();
    store.device_advance_cursor("aa", 100).unwrap();
    assert_eq!(store.device_cursor("aa"), 500, "游标退回去了");
    store.device_advance_cursor("aa", 900).unwrap();
    assert_eq!(store.device_cursor("aa"), 900);
}

/// 🔴 同步之后，两边同一篇的**版本戳必须一样**。
///
/// 这条是上面「只有一边改过被误判成冲突」那个 bug 的根因守卫。
///
/// `note_import_dir` 会用**本机** HLC 发一个新戳，于是同一份内容在两台机器上
/// 戳不同——而 LWW 是靠比这个戳判胜负的，戳不同比较就没意义：
/// B 刚导入那份（没改过）可能带着更大的戳，**A 之后的真实编辑反而判输**。
///
/// 所以 `updated_ms` 必须当成**内容版本的戳**，跟着内容走，而不是
/// 「本地这行何时被碰过」。
#[test]
fn test_同步后两边版本戳一致() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    sync(&a, &b, 0, "st1");
    assert_eq!(
        b.note_updated_ms(&n.id),
        a.note_updated_ms(&n.id),
        "戳不一致 ⇒ 后续所有 LWW 比较都失去意义"
    );

    // 更新一次之后仍要一致
    a.note_update(&n.id, "甲", "改过").unwrap();
    sync(&a, &b, 0, "st2");
    assert_eq!(b.note_updated_ms(&n.id), a.note_updated_ms(&n.id));
}

/// 承上：戳对齐之后，A 的后续编辑不会输给 B 那份没动过的副本。
#[test]
fn test_对端没动过的副本不会压过本机的新编辑() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "初版").unwrap();
    let (cursor, _) = sync(&a, &b, 0, "st3");

    // 只有 A 改；B 一直没动
    a.note_update(&n.id, "甲", "A 的新编辑").unwrap();
    let (_, rep) = sync_from(&a, &b, cursor, cursor, "st4");

    assert_eq!(rep.skipped_older, 0, "A 的新编辑被跳过了：{:?}", rep);
    assert_eq!(rep.conflicts, 0, "{:?}", rep);
    assert_eq!(b.note_get(&n.id).unwrap().unwrap().content, "A 的新编辑");
}

// ===== 传输层（两个端点在同一进程内，不出网卡）=====

/// 一个「假装没网」的端点：relay 与地址发现都关掉。
///
/// ❗ 端点密钥**从身份里来**，不是 `[seed; 32]` 那种造的——
/// 旧写法下端点 id 与 `NodeIdentity::node_id()` 是两回事，
/// 而生产环境里那就是「配对认的 id 跟实际拨得通的 id 不同」。
/// 现在测试走的路径与生产一致。
async fn offline_ep(tag: u8) -> iroh::Endpoint {
    let dir = tmp_dir(&format!("ep{}", tag));
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let ep = super::transport::bind(&me, false)
        .await
        .expect("绑定端点失败");
    let _ = std::fs::remove_dir_all(&dir);
    ep
}

/// `bound_sockets()` 返回的是**通配地址**（`0.0.0.0`），往它拨号必然超时。
/// 同进程测试要换成回环——探针里栽过这一条。
fn dialable(ep: &iroh::Endpoint) -> iroh::EndpointAddr {
    let mut addr = iroh::EndpointAddr::new(ep.id());
    for s in ep.bound_sockets() {
        let ip = match s.ip() {
            std::net::IpAddr::V4(v) if v.is_unspecified() => {
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            }
            std::net::IpAddr::V6(v) if v.is_unspecified() => {
                std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
            }
            other => other,
        };
        addr = addr.with_ip_addr(std::net::SocketAddr::new(ip, s.port()));
    }
    addr
}

/// 🔴 一次真正的跨「网络」同步：A 的增量经 iroh 到 B，B 应用。
///
/// 两个端点在同一进程内，但走的是**真的 QUIC 连接**（relay 与地址发现都关掉了），
/// 与两台机器之间唯一的差别是网卡。
#[tokio::test]
async fn test_传输层把增量搬到对端并应用() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "会议纪要", "正文内容").unwrap();

    let out = tmp_dir("tx_out");
    let inbox = tmp_dir("tx_in");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &out).unwrap();

    let listener = offline_ep(21).await;
    let dialer = offline_ep(22).await;
    let to = dialable(&listener);

    let inbox2 = inbox.clone();
    let recv = tokio::spawn(async move { super::transport::recv_dir(&listener, &inbox2).await });
    let sent = super::transport::send_dir(&dialer, to, &out)
        .await
        .expect("发送失败");
    let got = recv.await.unwrap().expect("接收失败");
    assert_eq!(sent, got, "收发字节数不一致");
    assert!(sent > 0);

    // 收到的目录原样交给 engine
    let rep = apply_delta(&b, &inbox, 0).expect("应用失败");
    assert_eq!(rep.created, 1, "{:?}", rep);
    assert_eq!(
        b.note_get(&n.id).unwrap().unwrap().content,
        "正文内容",
        "经 iroh 搬过来的内容不一致"
    );
    assert_eq!(
        b.note_updated_ms(&n.id),
        a.note_updated_ms(&n.id),
        "版本戳要一致"
    );

    let _ = std::fs::remove_dir_all(&out);
    let _ = std::fs::remove_dir_all(&inbox);
}

/// 子目录（文件夹结构）要跟着过去。
#[tokio::test]
async fn test_传输层保留子目录结构() {
    let a = store();
    let f = a.folder_create("工作", None).unwrap();
    let n = a.note_create(None, "甲", "正文").unwrap();
    a.note_set_folder(&n.id, Some(&f.id)).unwrap();

    let out = tmp_dir("tx2_out");
    let inbox = tmp_dir("tx2_in");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &out).unwrap();

    let listener = offline_ep(23).await;
    let dialer = offline_ep(24).await;
    let to = dialable(&listener);
    let inbox2 = inbox.clone();
    let recv = tokio::spawn(async move { super::transport::recv_dir(&listener, &inbox2).await });
    super::transport::send_dir(&dialer, to, &out).await.unwrap();
    recv.await.unwrap().unwrap();

    let b = store();
    let rep = apply_delta(&b, &inbox, 0).unwrap();
    assert_eq!(rep.created, 1, "{:?}", rep);
    assert!(
        b.note_get(&n.id).unwrap().unwrap().folder_id.is_some(),
        "文件夹结构没过来"
    );
    let _ = std::fs::remove_dir_all(&out);
    let _ = std::fs::remove_dir_all(&inbox);
}

/// 🔴 路径穿越必须被拒。名字来自网络，这是本模块唯一的安全边界。
#[test]
fn test_拒绝路径穿越的文件名() {
    let root = std::path::Path::new("C:/tmp/inbox");
    for bad in [
        "../evil.md",
        "a/../../evil.md",
        "/etc/passwd",
        "C:/windows/system32/evil.dll",
        "a//b.md",
        "",
        "./x.md",
    ] {
        assert!(
            super::transport::safe_rel_for_test(root, bad).is_err(),
            "这个名字该被拒：{:?}",
            bad
        );
    }
    // 正常的相对路径要放过，两种分隔符都认
    assert!(super::transport::safe_rel_for_test(root, "工作/甲.md").is_ok());
    assert!(super::transport::safe_rel_for_test(root, "工作\\甲.md").is_ok());
}

// ===== kb_presence 地址宣告 =====

mod presence_tests {
    use super::tmp_dir;
    use crate::sync::identity::NodeIdentity;
    use crate::sync::presence::{build, Heard, PresenceTable, STALE_MS};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    /// 固定时刻。测试**不取当前时间**：presence 有 ±120 秒的时间窗，
    /// 用真实时钟的话测试就依赖执行时刻了。
    const T0: i64 = 1_757_000_000_000;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, last))
    }

    /// 「这些 node_id 是已配对的」。
    fn paired(ids: Vec<String>) -> impl Fn(&str) -> bool {
        move |id| ids.iter().any(|x| x == id)
    }

    /// 谁都不认。
    fn nobody(_: &str) -> bool {
        false
    }

    #[test]
    fn test_已配对对端的公告被收下并用源ip当地址() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_b")).unwrap();
        let packet = build(&a, 41234, T0).unwrap();

        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&packet, ip(20), &b.node_id(), &known, T0 + 100);

        // 🔴 地址 = 源 IP + 公告里的端口。公告本身**不含 IP**。
        assert_eq!(
            heard,
            Heard::Fresh {
                node_id: a.node_id(),
                addr: SocketAddr::new(ip(20), 41234),
            }
        );
        assert_eq!(
            table.addrs_of(&a.node_id(), T0 + 100),
            vec![SocketAddr::new(ip(20), 41234)]
        );
        assert_eq!(table.live(T0 + 100), vec![a.node_id()]);
    }

    #[test]
    fn test_公告里没有设备名字段() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_noname")).unwrap();
        let packet = build(&a, 1234, T0).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&packet).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        // 钉住线上格式：多一个字段就是多一个能进界面的对端可控字符串。
        // 设备名在配对时已入 devices 表，公告不该再带一份。
        assert_eq!(keys, vec!["node_id", "port", "sig", "ts", "v"]);
    }

    #[test]
    fn test_未配对的节点公告直接丢掉() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_unp_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_unp_b")).unwrap();
        let packet = build(&a, 1234, T0).unwrap();

        let table = PresenceTable::new();
        let heard = table.hear(&packet, ip(30), &b.node_id(), &nobody, T0);

        assert_eq!(
            heard,
            Heard::Unpaired {
                node_id: a.node_id()
            }
        );
        // 🔴 关键：连表项都不许建。否则同网段任何人都能把地址表灌满。
        assert!(table.addrs_of(&a.node_id(), T0).is_empty());
        assert!(table.live(T0).is_empty());
    }

    #[test]
    fn test_自己的公告回环时忽略() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_self")).unwrap();
        let packet = build(&a, 1234, T0).unwrap();
        let table = PresenceTable::new();
        // 组播会把自己发的包回环给自己
        let known = paired(vec![a.node_id()]);
        assert_eq!(
            table.hear(&packet, ip(2), &a.node_id(), &known, T0),
            Heard::Mine
        );
        assert!(table.live(T0).is_empty());
    }

    #[test]
    fn test_改过端口的公告签名不通过() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_tamper_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_tamper_b")).unwrap();
        let packet = build(&a, 41234, T0).unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&packet).unwrap();
        // 把端口改成攻击者自己的，签名不动
        v["port"] = serde_json::json!(9999);
        let tampered = serde_json::to_vec(&v).unwrap();

        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&tampered, ip(40), &b.node_id(), &known, T0);
        assert!(
            matches!(&heard, Heard::Bad(why) if why.contains("签名")),
            "改过端口却收下了：{:?}",
            heard
        );
        assert!(table.addrs_of(&a.node_id(), T0).is_empty());
    }

    #[test]
    fn test_原样重放同一份公告会被拒() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_replay_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_replay_b")).unwrap();
        let packet = build(&a, 41234, T0).unwrap();
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);

        assert!(matches!(
            table.hear(&packet, ip(50), &b.node_id(), &known, T0),
            Heard::Fresh { .. }
        ));
        // 同一份包从别的 IP 重发：ts 没前进 → 重放
        let again = table.hear(&packet, ip(51), &b.node_id(), &known, T0 + 1000);
        assert_eq!(
            again,
            Heard::Replay {
                node_id: a.node_id()
            }
        );
        // 攻击者那个 IP 没被记进去
        assert_eq!(
            table.addrs_of(&a.node_id(), T0 + 1000),
            vec![SocketAddr::new(ip(50), 41234)]
        );
    }

    #[test]
    fn test_时钟差太多的公告不收且说清是时钟问题() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_skew_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_skew_b")).unwrap();
        // 对端时钟慢 10 分钟，远超 ±120 秒窗口
        let packet = build(&a, 41234, T0 - 600_000).unwrap();
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&packet, ip(60), &b.node_id(), &known, T0);
        assert!(
            matches!(&heard, Heard::OutOfWindow { skew_ms, .. } if *skew_ms == 600_000),
            "{:?}",
            heard
        );
        assert!(table.addrs_of(&a.node_id(), T0).is_empty());
    }

    #[test]
    fn test_地址过期后不再返回() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_stale_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_stale_b")).unwrap();
        let packet = build(&a, 41234, T0).unwrap();
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        table.hear(&packet, ip(70), &b.node_id(), &known, T0);

        // 界限当天还在
        assert_eq!(table.addrs_of(&a.node_id(), T0 + STALE_MS).len(), 1);
        // 过了就不给 —— 拨一个 60 秒没刷新的地址只会白等超时
        assert!(table.addrs_of(&a.node_id(), T0 + STALE_MS + 1).is_empty());
        assert!(table.live(T0 + STALE_MS + 1).is_empty());
    }

    #[test]
    fn test_多网卡的地址都记着且最近的排前面() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_multi_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_multi_b")).unwrap();
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        // 同一台机器两张网卡各发一份（ts 递增，所以都不是重放）
        let p1 = build(&a, 41234, T0).unwrap();
        let p2 = build(&a, 41234, T0 + 1).unwrap();
        table.hear(&p1, ip(80), &b.node_id(), &known, T0);
        table.hear(&p2, ip(81), &b.node_id(), &known, T0 + 1);

        assert_eq!(
            table.addrs_of(&a.node_id(), T0 + 2),
            vec![
                SocketAddr::new(ip(81), 41234),
                SocketAddr::new(ip(80), 41234)
            ],
            "最近刷新的应排前面（先拨最可能通的那个）"
        );
    }

    #[test]
    fn test_地址条数有上限且淘汰最久没刷新的() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_cap_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_cap_b")).unwrap();
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        // 6 个不同源 IP（换过几次网络后的残留），上限是 4
        for (i, last) in [10u8, 11, 12, 13, 14, 15].iter().enumerate() {
            let p = build(&a, 41234, T0 + i as i64).unwrap();
            table.hear(&p, ip(*last), &b.node_id(), &known, T0 + i as i64);
        }
        let addrs = table.addrs_of(&a.node_id(), T0 + 10);
        assert_eq!(addrs.len(), 4, "地址条数应封顶：{:?}", addrs);
        // 留下的是最后 4 个，最早的 .10 / .11 被挤掉
        assert_eq!(addrs[0], SocketAddr::new(ip(15), 41234));
        assert!(!addrs.contains(&SocketAddr::new(ip(10), 41234)));
        assert!(!addrs.contains(&SocketAddr::new(ip(11), 41234)));
    }

    #[test]
    fn test_忘记设备时地址一起清掉() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_forget_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_forget_b")).unwrap();
        let packet = build(&a, 41234, T0).unwrap();
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        table.hear(&packet, ip(90), &b.node_id(), &known, T0);
        assert_eq!(table.addrs_of(&a.node_id(), T0).len(), 1);

        table.forget(&a.node_id());
        // 不清的话会留一条永不刷新也永不被覆盖的僵尸地址（is_paired 已经在拒新公告了）
        assert!(table.addrs_of(&a.node_id(), T0).is_empty());
    }

    #[test]
    fn test_畸形包各给不同的说法() {
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_bad_b")).unwrap();
        let table = PresenceTable::new();
        let me = b.node_id();

        // 不是 JSON
        assert!(matches!(
            table.hear(b"not json at all", ip(1), &me, &nobody, T0),
            Heard::Bad(_)
        ));
        // 版本不认识
        let wrong_v = serde_json::json!({
            "v": 99, "node_id": "0".repeat(64), "port": 1, "ts": T0, "sig": ""
        });
        let heard = table.hear(
            &serde_json::to_vec(&wrong_v).unwrap(),
            ip(1),
            &me,
            &nobody,
            T0,
        );
        assert!(
            matches!(&heard, Heard::Bad(w) if w.contains("版本")),
            "{:?}",
            heard
        );
        // node_id 长度不对
        let short = serde_json::json!({
            "v": 1, "node_id": "abcd", "port": 1, "ts": T0, "sig": ""
        });
        let heard = table.hear(&serde_json::to_vec(&short).unwrap(), ip(1), &me, &nobody, T0);
        assert!(
            matches!(&heard, Heard::Bad(w) if w.contains("长度")),
            "{:?}",
            heard
        );
        // 超长包在解析前就丢
        let huge = vec![b'x'; 4096];
        let heard = table.hear(&huge, ip(1), &me, &nobody, T0);
        assert!(
            matches!(&heard, Heard::Bad(w) if w.contains("超长")),
            "{:?}",
            heard
        );
    }

    #[test]
    fn test_邀请码的签名不能当公告用() {
        // 🔴 跨协议签名复用：两个模块的签名前缀必须不同。
        // 这个测试盯的是「有人把 invite 的签名搬到 presence 的字段里」这条路。
        use base64::Engine as _;
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_cross_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_cross_b")).unwrap();
        let code = crate::sync::invite::encode(&a, "甲机", vec![], T0).unwrap();
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(code)
            .unwrap();
        let invite_wire: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        let stolen_sig = invite_wire["sig"].as_str().unwrap().to_string();

        let forged = serde_json::json!({
            "v": 1, "node_id": a.node_id(), "port": 41234, "ts": T0, "sig": stolen_sig
        });
        let table = PresenceTable::new();
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(
            &serde_json::to_vec(&forged).unwrap(),
            ip(99),
            &b.node_id(),
            &known,
            T0,
        );
        assert!(
            matches!(&heard, Heard::Bad(w) if w.contains("签名")),
            "邀请码签名被当成地址公告收下了：{:?}",
            heard
        );
    }
}

// ===== 一次完整的同步会话 =====

use super::session::{accept_session, dial_session};

/// 把两台机器配成对，返回 (甲的 node_id, 乙的 node_id)。
///
/// `offline_ep` 用的是 `[seed; 32]` 而不是那个临时身份，所以对端 id
/// 要从端点自己取（`ep.id()`），不能从 `NodeIdentity` 取。
fn pair_up(
    a: &DataStore,
    b: &DataStore,
    ep_a: &iroh::Endpoint,
    ep_b: &iroh::Endpoint,
) -> (String, String) {
    let (ia, ib) = (ep_a.id().to_string(), ep_b.id().to_string());
    a.device_pair(&ib, "乙机", "").unwrap();
    b.device_pair(&ia, "甲机", "").unwrap();
    (ia, ib)
}

#[tokio::test]
async fn test_会话一次往返两边都拿到对方的东西() {
    let (a, b) = (store(), store());
    let na = a.note_create(None, "甲这边写的", "甲的正文").unwrap();
    let nb = b.note_create(None, "乙这边写的", "乙的正文").unwrap();

    let ep_a = offline_ep(31).await;
    let ep_b = offline_ep(32).await;
    let (ia, ib) = pair_up(&a, &b, &ep_a, &ep_b);
    let to = dialable(&ep_b);

    // 拨号方与接受方在同一个任务里并行推进（tokio::join! 不需要 Send）
    let known = |id: &str| id == ia;
    let (ra, rb) = tokio::join!(
        dial_session(&a, &ep_a, &ib, to),
        accept_session(&b, &ep_b, &known)
    );
    let ra = ra.expect("拨号方会话失败");
    let rb = rb.expect("接受方会话失败");

    // 双向都搬到了
    assert_eq!(ra.applied.created, 1, "甲应收到乙那一篇：{:?}", ra.applied);
    assert_eq!(rb.applied.created, 1, "乙应收到甲那一篇：{:?}", rb.applied);
    assert_eq!(a.note_get(&nb.id).unwrap().unwrap().content, "乙的正文");
    assert_eq!(b.note_get(&na.id).unwrap().unwrap().content, "甲的正文");
    // 版本戳跟着内容走，两边必须一致，否则后写胜没法比
    assert_eq!(a.note_updated_ms(&nb.id), b.note_updated_ms(&nb.id));
    assert_eq!(a.note_updated_ms(&na.id), b.note_updated_ms(&na.id));

    // 两边算出同一个高水位，游标都推到它
    assert_eq!(ra.high_water_ms, rb.high_water_ms, "两边高水位应一致");
    assert_eq!(a.device_cursor(&ib), ra.high_water_ms);
    assert_eq!(b.device_cursor(&ia), rb.high_water_ms);
    assert_eq!(ra.applied.conflicts, 0);
    assert_eq!(rb.applied.conflicts, 0);
}

#[tokio::test]
async fn test_第二轮什么都不搬也不生冲突副本() {
    // 🔴 这是回归测试。第一版把游标推成「本机这一批的最大戳」，
    //    于是对端那一批落在游标之外，第二轮被当成本机的新东西发回去，
    //    而接收侧的 `both_changed` 两个条件都满足 → **每篇都生一份冲突副本**，
    //    每轮再生一次。第一轮完全看不出来。
    let (a, b) = (store(), store());
    a.note_create(None, "甲这边写的", "甲的正文").unwrap();
    b.note_create(None, "乙这边写的", "乙的正文").unwrap();

    let ep_a = offline_ep(33).await;
    let ep_b = offline_ep(34).await;
    let (ia, ib) = pair_up(&a, &b, &ep_a, &ep_b);

    let known = |id: &str| id == ia;
    let (r1a, r1b) = tokio::join!(
        dial_session(&a, &ep_a, &ib, dialable(&ep_b)),
        accept_session(&b, &ep_b, &known)
    );
    let r1a = r1a.expect("第一轮拨号失败");
    r1b.expect("第一轮接受失败");
    let after_first = a.note_changed_since(0).unwrap().len();
    assert_eq!(after_first, 2, "第一轮之后两边各有两篇");

    // 第二轮：两边都没改过任何东西
    let (r2a, r2b) = tokio::join!(
        dial_session(&a, &ep_a, &ib, dialable(&ep_b)),
        accept_session(&b, &ep_b, &known)
    );
    let r2a = r2a.expect("第二轮拨号失败");
    let r2b = r2b.expect("第二轮接受失败");

    assert_eq!(
        r2a.since_ms, r1a.high_water_ms,
        "第二轮的起点应就是上一轮的高水位"
    );
    // ❗ 不能断言 `since == high_water`：导入本身会走 `note_update`/`note_create`，
    //   而那两个会叫 `hlc_now()` → `issue()` 把本机下界抬高（就算随后又把
    //   `updated_ms` 盖回对端的值，下界也不会降回去）。所以第二轮的高水位
    //   比第一轮高。无害：游标只要 ≥ 已发过的最大戳就行。
    for (tag, r) in [("甲", &r2a), ("乙", &r2b)] {
        assert_eq!(r.applied.created, 0, "{}第二轮不该新建：{:?}", tag, r.applied);
        assert_eq!(r.applied.updated, 0, "{}第二轮不该更新：{:?}", tag, r.applied);
        assert_eq!(
            r.applied.conflicts, 0,
            "{}第二轮生成了冲突副本，游标没推对：{:?}",
            tag, r.applied
        );
        assert_eq!(r.sent_bytes, 0, "{}第二轮不该搬任何字节", tag);
    }
    assert_eq!(
        a.note_changed_since(0).unwrap().len(),
        after_first,
        "第二轮之后笔记数不该变（多出来的就是冲突副本）"
    );
    assert_eq!(b.note_changed_since(0).unwrap().len(), after_first);
}

#[tokio::test]
async fn test_没配对的对端连进来会被拒() {
    let (a, b) = (store(), store());
    let ep_a = offline_ep(35).await;
    let ep_b = offline_ep(36).await;
    let ib = ep_b.id().to_string();
    // 只有甲认得乙，乙不认得甲
    a.device_pair(&ib, "乙机", "").unwrap();

    let nobody = |_: &str| false;
    let (ra, rb) = tokio::join!(
        dial_session(&a, &ep_a, &ib, dialable(&ep_b)),
        accept_session(&b, &ep_b, &nobody)
    );
    let err = rb.expect_err("没配对却把会话走完了");
    assert!(err.contains("还没配对"), "{}", err);
    // 拨号方那边也必须失败，而不是挂住等一个永不到来的 hello
    assert!(ra.is_err(), "对端拒绝之后拨号方应报错，实际：{:?}", ra);
}

#[test]
fn test_同一份增量应用两次不生冲突副本() {
    // 🔴 会话游标推对了就不该有回声；但会话中途失败、或一边推了游标另一边没推，
    //    下一轮 `since = min(两边游标)` 会退回去，回声照样出现。
    //    `apply_delta` 里那条「内容一模一样直接跳过」就是兜这个。
    //    没有它的话：本地戳 == 对端戳，而两者都 > 游标 0 → 每篇一份冲突副本。
    let (a, b) = (store(), store());
    let n = a.note_create(None, "会议纪要", "正文内容").unwrap();

    let dir = tmp_dir("echo");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &dir).unwrap();

    let first = apply_delta(&b, &dir, 0).expect("第一次应用失败");
    assert_eq!(first.created, 1, "{:?}", first);

    // 原样再来一遍，游标仍是 0（模拟游标没推上去）
    let dir2 = tmp_dir("echo2");
    write_delta(&a, &delta, &dir2).unwrap();
    let second = apply_delta(&b, &dir2, 0).expect("第二次应用失败");
    assert_eq!(second.identical, 1, "内容相同应被识别出来：{:?}", second);
    assert_eq!(second.conflicts, 0, "回声不该算冲突：{:?}", second);
    assert_eq!(second.created, 0);
    assert_eq!(second.updated, 0);
    assert_eq!(
        b.note_changed_since(0).unwrap().len(),
        1,
        "库里应仍只有一篇（多出来的就是冲突副本）"
    );
    assert_eq!(b.note_updated_ms(&n.id), a.note_updated_ms(&n.id));

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

#[test]
fn test_戳相同但内容不同仍按平手处理() {
    // 上面那条只比内容、不比戳，就是为了不把**真平手**吞掉：
    // 两台机器吸收同一个下界之后可能发出同一个值，那时内容是不同的。
    let (a, b) = (store(), store());
    let n = a.note_create(None, "会议纪要", "甲的版本").unwrap();
    let dir = tmp_dir("tie");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &dir).unwrap();

    // 在乙这边造一篇同 id、同戳、但内容不同的
    let stamp = a.note_updated_ms(&n.id).unwrap();
    apply_delta(&b, &dir, 0).unwrap();
    b.note_update(&n.id, "会议纪要", "乙的版本").unwrap();
    {
        let conn = b.lock_conn();
        conn.execute(
            "UPDATE notes SET updated_ms = ?2 WHERE id = ?1",
            rusqlite::params![&n.id, stamp],
        )
        .unwrap();
    }

    let dir2 = tmp_dir("tie2");
    write_delta(&a, &delta, &dir2).unwrap();
    let rep = apply_delta(&b, &dir2, 0).expect("应用失败");
    assert_eq!(rep.identical, 0, "内容不同不该走「一模一样」那条：{:?}", rep);
    // 平手时本地赢，且因为两边都在游标之后改过，对端那份留了副本
    assert_eq!(rep.skipped_older, 1, "{:?}", rep);
    assert_eq!(rep.conflicts, 1, "真平手应留冲突副本：{:?}", rep);
    assert_eq!(
        b.note_get(&n.id).unwrap().unwrap().content,
        "乙的版本",
        "平手时本地赢"
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

// ===== 编排决策（coordinate） =====

mod coordinate_tests {
    use crate::sync::coordinate::*;

    #[test]
    fn test_碰撞规则是反对称的() {
        // 🔴 这是「恰好活一个会话」的**全部**依据：任意一对 id，
        //    两边各自调用必须得到相反的结论。
        //    只测「a 比 b 大就 KeepMine」是空的——那只是把实现抄一遍。
        let (long_a, long_b) = ("a".repeat(64), "b".repeat(64));
        let ids: Vec<&str> = vec!["00", "01", "ff", &long_a, &long_b, "0f3c9a", "f03c9a"];
        for a in &ids {
            for b in &ids {
                if a == b {
                    continue;
                }
                let x = resolve_collision(a, b);
                let y = resolve_collision(b, a);
                assert_ne!(
                    x, y,
                    "({}, {}) 两边得到同一个结论 → 会话要么都活要么都死",
                    a, b
                );
            }
        }
    }

    #[test]
    fn test_连到自己身上不会让位给自己() {
        // 让位给自己 = 永远等不到那个「对端发起的会话」。
        assert_eq!(resolve_collision("abc", "abc"), Collision::KeepMine);
    }

    #[test]
    fn test_退避走阶梯且到顶不再涨() {
        assert_eq!(backoff_secs(1), 5);
        assert_eq!(backoff_secs(2), 10);
        assert_eq!(backoff_secs(3), 30);
        assert_eq!(backoff_secs(4), 60);
        // 到顶就一直是最后一档，不会越界 panic 也不会无限涨
        assert_eq!(backoff_secs(5), 60);
        assert_eq!(backoff_secs(9999), 60);
        // fails 从 1 起算，传 0 也不能 panic
        assert_eq!(backoff_secs(0), 5);
    }

    #[test]
    fn test_抖动不越界且真的会变() {
        let mut seen = std::collections::HashSet::new();
        for seed in 0..500u64 {
            let v = jittered_secs(PERIOD_SECS, JITTER_SECS, seed);
            assert!(
                (PERIOD_SECS - JITTER_SECS..=PERIOD_SECS + JITTER_SECS).contains(&v),
                "seed={} 抖出了 {}，越界",
                seed,
                v
            );
            seen.insert(v);
        }
        // 抖动的意义就是让碰撞少见；只要它其实是个常数，那意义就没了
        assert!(seen.len() > 5, "抖动几乎不变（只有 {} 种取值）", seen.len());
    }

    #[test]
    fn test_抖动幅度为零就是固定间隔() {
        for seed in 0..20u64 {
            assert_eq!(jittered_secs(30, 0, seed), 30);
        }
    }

    #[test]
    fn test_抖动不会因为下界减到负数而崩() {
        // base 比 jitter 小是配置写错，但不能 panic（本项目 panic = abort）
        for seed in 0..50u64 {
            let v = jittered_secs(3, 10, seed);
            assert!(v <= 13, "seed={} 得到 {}", seed, v);
        }
    }
}

// ===== 会话槽与让位（coordinate 的有状态那半） =====

mod slot_tests {
    use crate::sync::coordinate::{Admit, Coordinator, YIELD_WAIT};

    /// 比 `hi` 小、比 `lo` 大的一组 id。用真实长度（64 字符 hex）免得
    /// 将来加了长度校验测试才炸。
    fn lo() -> String {
        "1".repeat(64)
    }
    fn hi() -> String {
        "9".repeat(64)
    }

    #[test]
    fn test_槽被占时同一对端拿不到第二个() {
        let c = Coordinator::new(lo());
        let peer = hi();
        let h = c.try_hold(&peer).expect("第一次应拿到");
        assert_eq!(h.peer(), peer);
        assert!(c.try_hold(&peer).is_none(), "同一对端不该拿到第二把");
        // 不同对端互不影响 —— 多设备要能并行
        assert!(c.try_hold("0".repeat(64).as_str()).is_some());
    }

    #[test]
    fn test_槽随作用域自动释放() {
        // 会话怎么退出（返回 / ? / panic）都不该漏槽，所以用 Drop 而不是显式 release
        let c = Coordinator::new(lo());
        let peer = hi();
        {
            let _h = c.try_hold(&peer).unwrap();
        }
        assert!(c.try_hold(&peer).is_some(), "出了作用域应已释放");
    }

    #[tokio::test]
    async fn test_没配对的入连接直接判未配对() {
        let c = Coordinator::new(lo());
        assert!(matches!(c.admit(&hi(), false).await, Admit::NotPaired));
    }

    #[tokio::test]
    async fn test_没撞上就直接收下() {
        let c = Coordinator::new(lo());
        assert!(matches!(c.admit(&hi(), true).await, Admit::Ok(_)));
    }

    #[tokio::test]
    async fn test_本机id更大时保留自己那个会话并拒掉入连接() {
        // 本机 hi、对端 lo ⇒ 按 RFC 4271 §6.8 保留本机发起的那个
        let c = Coordinator::new(hi());
        let peer = lo();
        let _mine = c.try_hold(&peer).expect("先占住，模拟本机正在拨它");
        match c.admit(&peer, true).await {
            Admit::Reject(why) => assert!(why.contains("node_id 更大"), "{}", why),
            other => panic!("id 更大却没保留自己的会话：{:?}", other),
        }
    }

    #[tokio::test]
    async fn test_本机id更小时让位并在槽腾出后收下() {
        // 本机 lo、对端 hi ⇒ 让位。让位方**不取消**自己的出会话，
        // 而是等它因为对端拒绝而自行退出（见 coordinate 模块文档）。
        let c = std::sync::Arc::new(Coordinator::new(lo()));
        let peer = hi();
        let mine = c.try_hold(&peer).expect("先占住，模拟本机正在拨它");

        // 模拟「本机那个出会话被对端拒了，于是很快退出」
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            drop(mine);
        });

        match c.admit(&peer, true).await {
            Admit::Ok(h) => assert_eq!(h.peer(), peer),
            other => panic!("让位之后应能收下入连接：{:?}", other),
        }
    }

    #[tokio::test]
    async fn test_让位等不到就拒而不是无限等() {
        // 丢包 / 对端崩了的时候，本机那个出会话可能一直不退。
        // 那时必须超时放弃，两边各自重试（有抖动，活锁有界）——
        // 这是明知的取舍，但**绝不能挂死**。
        let c = Coordinator::new(lo());
        let peer = hi();
        let _stuck = c.try_hold(&peer).expect("占住且永不释放");

        let t0 = tokio::time::Instant::now();
        match c.admit(&peer, true).await {
            Admit::Reject(why) => assert!(why.contains("没退出"), "{}", why),
            other => panic!("等不到却收下了：{:?}", other),
        }
        assert!(
            t0.elapsed() >= YIELD_WAIT,
            "应该真的等满 {:?} 才放弃",
            YIELD_WAIT
        );
    }
}

// ===== 服务把手（画界面时才发现的两个洞） =====

mod service_tests {
    use super::{store, tmp_dir};
    use crate::sync::identity::NodeIdentity;
    use crate::sync::service::{sleep_or_stop, SyncService};
    use std::sync::Arc;
    use std::time::Duration;

    /// 造一个合法的对端 node_id（真实曲线点，不是随手编的 hex）。
    fn a_peer_id(tag: &str) -> String {
        let d = tmp_dir(&format!("peer_{}", tag));
        let id = NodeIdentity::load_or_create(&d).unwrap().node_id();
        let _ = std::fs::remove_dir_all(&d);
        id
    }

    #[tokio::test]
    async fn test_关开关时不用等满退避() {
        // 🔴 退避到顶是 60 秒。要是直接 sleep，用户关掉开关得等最多一分钟
        //    才真的停——界面上就是「明明关了还在同步」。
        let stop = Arc::new(tokio::sync::Notify::new());
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            s2.notify_waiters();
        });
        let t0 = tokio::time::Instant::now();
        let finished = sleep_or_stop(&stop, 60).await;
        assert!(!finished, "被叫醒时应返回 false（= 该退出了）");
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "应当立刻醒，实际等了 {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test]
    async fn test_没被叫醒时正常睡完() {
        let stop = tokio::sync::Notify::new();
        assert!(sleep_or_stop(&stop, 0).await, "睡完应返回 true");
    }

    #[tokio::test]
    async fn test_开关关着时不启动() {
        let svc = SyncService::new();
        let dir = tmp_dir("svc_off");
        svc.start_on(store(), &dir, false, false, 0)
            .await
            .expect("关着时 start 不该报错");
        assert!(!svc.is_running().await, "开关关着却起来了");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_配对之后立刻就有循环不用重启() {
        // 🔴 这是画配对界面时发现的洞：旧版 `spawn` 是启动时读一次 device_list，
        //    配对之后那台**不会有循环**，要重启应用才生效。
        //    用户配完正盯着界面看，什么都不动 —— 看起来就是坏的。
        let s = store();
        let svc = SyncService::new();
        let dir = tmp_dir("svc_pair");
        svc.start_on(s.clone(), &dir, true, false, 0)
            .await
            .expect("启动失败");
        assert!(svc.is_running().await);
        assert_eq!(svc.peer_count().await, 0, "一开始没有已配对设备");

        let peer = a_peer_id("new");
        s.device_pair(&peer, "新设备", "").unwrap();
        svc.add_peer(&peer).await.unwrap();
        assert_eq!(svc.peer_count().await, 1, "配对之后应立刻有一条循环");

        // 幂等：重复配同一台不该起两条（两条会白拨，虽然会话槽挡得住）
        svc.add_peer(&peer).await.unwrap();
        assert_eq!(svc.peer_count().await, 1, "重复配对起了两条循环");

        // 忘记之后循环不该再留着
        svc.drop_peer(&peer).await;
        assert_eq!(svc.peer_count().await, 0);

        svc.stop().await;
        assert!(!svc.is_running().await, "stop 之后不该还在跑");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_重复start是幂等的() {
        let s = store();
        let svc = SyncService::new();
        let dir = tmp_dir("svc_twice");
        svc.start_on(s.clone(), &dir, true, false, 0).await.unwrap();
        // 前端可能重复调（比如设置页重挂载），第二次不该再绑一个端点
        svc.start_on(s.clone(), &dir, true, false, 0).await.unwrap();
        assert!(svc.is_running().await);
        svc.stop().await;
        // 停了之后还能再起
        svc.start_on(s.clone(), &dir, true, false, 0).await.unwrap();
        assert!(svc.is_running().await);
        svc.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_没在跑的时候立即同步给得出所以然的错() {
        let svc = SyncService::new();
        let err = svc.sync_now(&a_peer_id("nosvc")).await.expect_err("应报错");
        assert!(err.contains("没有在运行"), "{}", err);
    }

    #[tokio::test]
    async fn test_端点身份就是配对时那个身份() {
        // 🔴 第三个洞：旧版 `transport::bind(me, seed, relay)` 里 `me` 完全没用
        //    （`let _ = me;`），种子是另给的。生产环境只能随手造个种子，
        //    于是端点 id ≠ 大家配对时认的 node_id —— 配对直接失效。
        let dir = tmp_dir("ident_eq");
        let me = NodeIdentity::load_or_create(&dir).unwrap();
        let ep = crate::sync::transport::bind(&me, false).await.unwrap();
        assert_eq!(
            ep.id().to_string(),
            me.node_id(),
            "端点 id 必须等于身份的 node_id"
        );
        ep.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod presence_stop_tests {
    use super::{store, tmp_dir};
    use crate::sync::service::SyncService;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn test_关开关时地址宣告也要停() {
        // 🔴 回归测试。第一版给 presence::spawn 传的是一个没人持有的
        //    `Arc::new(AtomicBool::new(false))`，于是 stop() 关不掉它。后果两层：
        //    ① 停了之后还在组播上喊本机地址；
        //    ② 关掉再打开时端口 5008 仍被僵尸线程占着，bind 失败只留一条 warning，
        //       **地址发现静默死掉，而界面上开关是开的**。
        let svc = SyncService::new();
        let dir = tmp_dir("presence_stop");
        svc.start_on(store(), &dir, true, false, 0).await.expect("启动失败");

        let flag = svc.presence_flag().await.expect("起来之后该有这个标志");
        // spawn 里那个 CAS 成功了才会置 true —— 它同时证明宣告线程真的起来了
        assert!(flag.load(Ordering::SeqCst), "地址宣告没起来");

        svc.stop().await;
        assert!(
            !flag.load(Ordering::SeqCst),
            "stop() 没有关掉地址宣告，会留一个占着 5008 端口的僵尸线程"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn test_没落地的条目会把游标夹在它前面() {
    // 🔴 这条钉的是「夹」而不是「不推」。
    //    完全不推游标会引出冲突副本风暴：游标钉在低位 C 时，
    //    `local > C && incoming > C` 让任何一篇「本地改过、对端还是旧版」的笔记
    //    每轮生一份副本——就是 705d6af 修掉的那个，换个门进来。
    let (a, b) = (store(), store());
    let n1 = a.note_create(None, "先写的", "正文一").unwrap();
    let n2 = a.note_create(None, "后写的", "正文二").unwrap();
    let (ms1, ms2) = (
        a.note_updated_ms(&n1.id).unwrap(),
        a.note_updated_ms(&n2.id).unwrap(),
    );
    assert!(ms1 < ms2, "两篇的时间戳应有先后");

    let dir = tmp_dir("unsettled");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &dir).unwrap();

    // 模拟传输被截断：清单里有、文件却没到（**两篇都删掉**，验最小值取的是较早那个）
    for id in [&n1.id, &n2.id] {
        let _ = std::fs::remove_file(dir.join(format!("{}.md", id)));
    }
    let rep = apply_delta(&b, &dir, 0).expect("应用失败");

    assert_eq!(rep.missing_files, 2, "{:?}", rep);
    assert_eq!(
        rep.unsettled_min_ms,
        Some(ms1),
        "应取**最小**的那个未落地时间戳，否则夹不住更早的那篇：{:?}",
        rep
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_全都落地时不夹游标() {
    let (a, b) = (store(), store());
    a.note_create(None, "会议纪要", "正文内容").unwrap();
    let dir = tmp_dir("settled");
    let delta = compute_delta(&a, 0).unwrap();
    write_delta(&a, &delta, &dir).unwrap();

    let rep = apply_delta(&b, &dir, 0).expect("应用失败");
    assert_eq!(rep.missing_files, 0);
    assert_eq!(rep.import_failed, 0);
    assert_eq!(
        rep.unsettled_min_ms, None,
        "没有未落地的东西就不该夹游标：{:?}",
        rep
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ===== §12.12：三机以上的删除传播 =====

/// 🔴 本次修的就是这个：A 删 → B 收到 → **C 也要删掉**。
///
/// 改之前 `note_delete` 不落墓碑（只有物理清理才落），于是 B 手里没有
/// 可转发的删除记录，B↔C 的清单里就没有它——C 永远保留那篇。
#[test]
fn test_三台机器删除能传到第三台() {
    let (a, b, c) = (store(), store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();

    // 先让三台都有这篇
    let (cur_ab, _) = sync(&a, &b, 0, "t3_1");
    let (cur_bc, _) = sync(&b, &c, 0, "t3_2");
    assert!(c.note_get(&n.id).unwrap().is_some(), "C 该先拿到这篇");

    // A 删掉，同步给 B
    a.note_delete(&n.id).unwrap();
    let (_, rep_ab) = sync(&a, &b, cur_ab, "t3_3");
    assert_eq!(rep_ab.deleted, 1, "B 该收到删除");
    assert!(b.note_get(&n.id).unwrap().is_none());

    // 🔴 关键：B 再与 C 同步时，清单里必须带着这条删除
    let (_, rep_bc) = sync(&b, &c, cur_bc, "t3_4");
    assert_eq!(rep_bc.deleted, 1, "C 没收到删除——三台以上删不干净（§12.12）");
    assert!(c.note_get(&n.id).unwrap().is_none(), "C 上那篇该没了");
}

/// 还原必须能撤销「删除意图」墓碑。
///
/// 这正是上一版补丁被**撤回**的原因（见设计稿 §12.12）：
/// 补落墓碑而不能撤销的话，用户在本机还原后，本机仍会把墓碑广播给第三台，
/// 把还原的副本又删掉；而 `note_is_tombstoned` 还会让这个 id 再也导不进来。
#[test]
fn test_还原会撤销删除意图墓碑() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    let (cur, _) = sync(&a, &b, 0, "r1_1");

    a.note_delete(&n.id).unwrap();
    sync(&a, &b, cur, "r1_2");
    assert!(b.note_get(&n.id).unwrap().is_none(), "B 该软删了");

    // 用户在 B 上从回收站还原
    b.note_restore_deleted(&n.id).unwrap();
    assert!(b.note_get(&n.id).unwrap().is_some());

    // ① B 不该再把这条墓碑广播出去
    let d = compute_delta(&b, 0).unwrap();
    assert!(
        d.tombstones.iter().all(|(id, _)| id != &n.id),
        "还原之后 B 不该再广播这条墓碑，否则会把别处还原的副本又删掉"
    );

    // ② A 上落的是可撤销的删除意图，不该永久封杀这个 id
    assert!(
        !a.note_is_tombstoned(&n.id),
        "软删落的是 purged=0 墓碑，note_is_tombstoned 不该认它——否则还原后的副本永远导不回去"
    );
}

/// 物理清理把墓碑升级成不可撤销；软删那一类不影响导入。
#[test]
fn test_两类墓碑的分界() {
    let a = store();
    let n = a.note_create(None, "甲", "正文").unwrap();

    a.note_delete(&n.id).unwrap();
    assert!(
        !a.note_is_tombstoned(&n.id),
        "软删只是删除意图，还能还原，不该当成不可恢复"
    );
    // 但它已经能传播了——这正是三机场景需要的
    assert_eq!(a.note_tombstones_since(0).unwrap().len(), 1, "软删就该落下可转发的墓碑");

    a.note_purge(&n.id).unwrap();
    assert!(
        a.note_is_tombstoned(&n.id),
        "物理清之后不可恢复，该把 id 封死"
    );
    assert_eq!(
        a.note_tombstones_since(0).unwrap().len(),
        1,
        "升级而不是新增一条"
    );
}

/// 🔴 坑②：转发时按 `local_ms` 取，不按 `tombstone_ms`。
///
/// A 离线一周后才把旧删除同步给 B，B 记下的 `tombstone_ms` 是一周前的；
/// 若按它筛选，B↔C 的游标早已推过那个点 → C 永远收不到这条删除。
/// 上一版补丁就是在这里失效的——而那是**最常见的离线场景**。
#[test]
fn test旧删除转发时不会被游标跳过() {
    let b = store();
    let 一周前 = b.sync_high_water_ms() - 7 * 86_400_000;
    // B↔C 的游标已经推到「现在」（远晚于那条删除的源头时刻）
    let 游标 = b.sync_high_water_ms();

    b.note_record_remote_tombstone("远端来的id", 一周前);

    let tombs = b.note_tombstones_since(游标).unwrap();
    let hit = tombs.iter().find(|(id, _, _)| id == "远端来的id");
    assert!(
        hit.is_some(),
        "按 tombstone_ms 筛会漏掉它——那正是 C 永远收不到删除的原因"
    );
    assert_eq!(
        hit.unwrap().1,
        一周前,
        "传出去的必须仍是**源头删除时刻**，LWW 语义不能变"
    );
}

/// 🔴 游标必须跟着 `local_ms` 前进，否则同一条墓碑会无限重发。
///
/// 这是改 §12.12 时自己造出来的坑：筛选改成了 `local_ms`，而 `compute_delta`
/// 一度仍用 `tombstone_ms` 算新游标。转发旧删除时（tombstone_ms 是一周前），
/// `.max(since_ms)` 会把游标压回原处 → 下一轮这条墓碑又被取到、又发一遍，永不收敛。
#[test]
fn test转发旧删除后游标要前进() {
    let b = store();
    let 一周前 = b.sync_high_water_ms() - 7 * 86_400_000;
    let 游标 = b.sync_high_water_ms();

    b.note_record_remote_tombstone("远端来的id", 一周前);

    let d = compute_delta(&b, 游标).unwrap();
    assert_eq!(d.tombstones.len(), 1, "该取到那条转发的墓碑");
    assert!(
        d.cursor_ms > 游标,
        "游标没前进（{} ≤ {}）——下一轮这条墓碑会被重复发送，永不收敛",
        d.cursor_ms,
        游标
    );

    // 拿新游标再算一次：这条不该再出现
    let d2 = compute_delta(&b, d.cursor_ms).unwrap();
    assert!(
        d2.tombstones.is_empty(),
        "同一条墓碑在游标推过之后又出现了：{:?}",
        d2.tombstones
    );
}
