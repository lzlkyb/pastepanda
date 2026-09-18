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

/// 本文件绝大多数用例测的是**邀请码本身**的行为，窗口取「知识库同步」那一档（7 天）。
///
/// ❗ 窗口自 2026-09-17 起是 [`invite::decode`] 的**参数**——两条路的窗口相差 336 倍
/// （30 分钟 vs 7 天），写成常量必然漂，而漂的表现是「用户撞在门上却拿到一句
/// 指不到动作的错误」。这里只给测试一个省事的默认值；
/// 远程电脑那一档由 `test_远程配对的窗口是30分钟且与邀请门同宽` 单独钉住。
fn decode_kb(code: &str, now_ms: i64) -> Result<invite::Invite, String> {
    invite::decode(code, now_ms, invite::TTL_SECS)
}

#[test]
fn test_邀请码能原样解回来() {
    let dir = tmp_dir("inv");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "书房台式机", vec!["192.168.1.7:5007".into()], NOW).unwrap();

    let got = decode_kb(&code, NOW + 1000).unwrap();
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

    let e = decode_kb(&bad, NOW).expect_err("改过的码必须拒");
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
    let e = decode_kb("这显然不是邀请码", NOW).expect_err("该拒");
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
    let inv = decode_kb(&dirty, NOW).expect("洗掉不可见字符后应该能解开");
    assert_eq!(inv.name, "书房台式机");
    assert_eq!(inv.node_id, me.node_id());

    // ❗ 放宽不能放到“改过的码也能过”：把身份字段改掉仍须被签名拦下。
    let tampered = dirty.replace("书房台式机", "别的机器");
    if tampered != dirty {
        assert!(decode_kb(&tampered, NOW).is_err(), "改过的码必须拒");
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
        let inv = decode_kb(&dirty, NOW)
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
    let e1 = decode_kb(&with_prefix, NOW).expect_err("多粘了文字该拒");
    assert!(e1.contains("不属于邀请码的字符"), "该提示混入文字：{}", e1);

    // ② 只复制到一半 → 要明确说「只复制到了一半」，而不是说混入了字符
    //   造一个长度 %4==1 的截断（那是洗完之后唯一还能失败的情形）
    let cut = code.len() - (code.len() % 4) - 3;
    let truncated = &code[..cut + 1];
    let e2 = decode_kb(truncated, NOW).expect_err("截断的码该拒");
    assert!(
        !e2.contains("不属于邀请码的字符"),
        "截断不该报成「混入了字符」，那会让用户去找不存在的脏字符：{}",
        e2
    );

    // ③ 空串要单独一句，不能跟上面两种混
    let e3 = decode_kb("   \n  ", NOW).expect_err("空串该拒");
    assert!(e3.contains("没有粘进"), "空串要说清楚是空的：{}", e3);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_过期的邀请码拒绝且说清怎么办() {
    let dir = tmp_dir("old");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "老机器", vec![], NOW).unwrap();

    let later = NOW + (invite::TTL_SECS + 1) * 1000;
    let e = decode_kb(&code, later).expect_err("过期必须拒");
    assert!(e.contains("已过期") && e.contains("重新生成"), "{}", e);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 🔴 同一个过期时间点，两条路必须给出**不同**的答案（2026-09-17 修的那处错配）。
///
/// 修复前：码 TTL 是 7 天、远程邀请门只有 30 分钟 ⇒用户手里的码「还有效」，
/// 但他撞上的是门，对端只会回一句 `not_paired`（「尚未远程配对」）——
/// **指不到「回去重新生成一个」这个唯一正确的动作**，于是他只能反复重试同一个失效窗口。
///
/// 这条用例同时钉住两件事：
/// ① 两条路的窗口**真的不同**（拿同一个时间点分别解，一个收一个拒）；
/// ② 过期话术**说人话**——30 分钟整除 86400 是 0，旧文案会写成「有效期 0 天」。
#[test]
fn test_过期的两种情况要说得出是多久() {
    let dir = tmp_dir("old2");
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let code = invite::encode(&me, "老机器", vec![], NOW).unwrap();
    let later = NOW + 31 * 60 * 1000; // 31 分钟之后

    // 知识库同步那一档（7 天）：远没到期
    assert!(
        invite::decode(&code, later, invite::TTL_SECS).is_ok(),
        "知识库那档是 7 天，31 分钟就拒会打断正常配对"
    );

    // 远程电脑那一档（30 分钟）：必须拒，且要把「多久之前 / 有效期多久」说清楚
    let e = invite::decode(&code, later, invite::RC_TTL_SECS).expect_err("31 分钟前的码该拒");
    assert!(e.contains("已过期"), "{}", e);
    assert!(e.contains("31 分钟前"), "要说清多久之前生成的，实际：{}", e);
    assert!(e.contains("30 分钟"), "有效期要说成人话，实际：{}", e);
    assert!(
        !e.contains("0 天"),
        "30 分钟整除 86400 就是 0 天——旧文案正是这样写的，实际：{}",
        e
    );
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
    assert!(decode_kb(&code, NOW).is_ok(), "对端时钟快 5 分钟就配不上，那没法用");
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

/// 🔴 纯粹的「把笔记挪到另一个文件夹」要能同步过去。
///
/// 这一条之前完全没有覆盖，而它同时被**三处**拦着（缺一不可）：
/// ① `note_set_folder` 不刷 `updated_ms` → 压根不进增量；
/// ② 回声拦截只比标题/正文/标签 → 纯移动被当成「一模一样」跳过；
/// ③ `note_import_dir` 只在**新建**分支设文件夹，而同步过来的笔记带 id、永远走更新分支。
#[test]
fn test_只挪文件夹也要同步过去() {
    let (a, b) = (store(), store());
    let f1 = a.folder_create("工作", None).unwrap();
    let f2 = a.folder_create("归档", None).unwrap();
    let n = a.note_create(None, "甲", "正文一字不改").unwrap();
    a.note_set_folder(&n.id, Some(&f1.id)).unwrap();

    let (cursor, _) = sync(&a, &b, 0, "mv1");
    let landed = b.note_get(&n.id).unwrap().unwrap();
    let fid = landed.folder_id.clone().expect("第一轮就该落在「工作」里");
    assert_eq!(b.folder_list().unwrap().iter().find(|f| f.id == fid).unwrap().name, "工作");

    // 只挪文件夹，标题/正文/标签一字不改
    a.note_set_folder(&n.id, Some(&f2.id)).unwrap();

    let (_, rep) = sync_from(&a, &b, cursor, cursor, "mv2");
    assert_eq!(rep.identical, 0, "纯移动被回声拦截吃掉了：{:?}", rep);

    let moved = b.note_get(&n.id).unwrap().unwrap();
    let fid2 = moved.folder_id.expect("移动后还在未分类？");
    assert_eq!(
        b.folder_list().unwrap().iter().find(|f| f.id == fid2).unwrap().name,
        "归档",
        "文件夹移动没传过去"
    );
}

/// ❗ 上一条的反面：**真的一字未改**（连文件夹也没变）时，回声拦截必须照旧生效。
///
/// 🔴 拆开写是因为把文件夹掺进拦截条件很容易把拦截本身弄失效（比如
/// Windows 上分隔符不统一就永远不相等），而那会直接引回「每轮再生一批冲突副本」。
#[test]
fn test_连文件夹也没变时回声拦截仍然生效() {
    let (a, b) = (store(), store());
    let f = a.folder_create("工作", None).unwrap();
    let n = a.note_create(None, "甲", "正文").unwrap();
    a.note_set_folder(&n.id, Some(&f.id)).unwrap();

    let (cursor, _) = sync(&a, &b, 0, "echo1");
    // 拿旧游标重发同一批 = 回声
    let (_, rep) = sync_from(&a, &b, 0, cursor, "echo2");
    assert_eq!(rep.identical, 1, "回声该被拦下：{:?}", rep);
    assert_eq!(rep.conflicts, 0, "回声不该算冲突：{:?}", rep);
}

/// 🔴 严格赢的一边**不再**存副本，但仍然要计数。
///
/// 改之前一次冲突会在**每台机器上生两份**副本：赢家存对端那份、输家存自己那份，
/// 而两者是**同一个版本**（`losing_ms` 相同、标题逐字相同），副本再互相同步过去。
///
/// ❗ 计数必须留：不留的话赢家那台机器界面显「冲突 0 处」，用户压根不知道出过冲突。
#[test]
fn test_严格赢的一边不存副本但要计数() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "共同起点").unwrap();
    let (cursor, _) = sync(&a, &b, 0, "win1");

    // 上次同步之后两边各改一次，**A 先改 B 后改** ⇒ B 的戳更大，接收侧（B）严格赢
    a.note_update(&n.id, "甲", "A 改的").unwrap();
    // 隔开 2ms：同一毫秒内两次写会变成「平手」（见 test_戳相同…），
    // 平手赢家也会存副本，这条用例要的是**严格赢**才不存。CI 上写入极快会踩到。
    std::thread::sleep(std::time::Duration::from_millis(2));
    b.note_update(&n.id, "甲", "B 改的").unwrap();

    let (_, rep) = sync_from(&a, &b, cursor, cursor, "win2");
    assert_eq!(rep.skipped_older, 1, "B 应该赢：{:?}", rep);
    assert_eq!(rep.conflicts, 1, "赢了也要把冲突报出来：{:?}", rep);
    assert_eq!(
        b.note_get(&n.id).unwrap().unwrap().content,
        "B 改的",
        "B 的内容该留下"
    );
    // 关键断言：A 那份不在这里存副本——A 那台机器会把自己那份存成副本再同步过来
    assert!(
        b.note_search("冲突副本", "all", &[], 10).unwrap().is_empty(),
        "严格赢的一边不该再存一份（内容与输家那份完全相同）"
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
            super::transport::safe_rel(root, bad).is_err(),
            "这个名字该被拒：{:?}",
            bad
        );
    }
    // 正常的相对路径要放过，两种分隔符都认
    assert!(super::transport::safe_rel(root, "工作/甲.md").is_ok());
    assert!(super::transport::safe_rel(root, "工作\\甲.md").is_ok());
}

/// 🔴 对端开了头就不再发了，接收侧不能永远挂在那儿。
///
/// 加了全局并发闸之后这条从「卡住一台对端」升级成「占掉两个会话位中的一个」：
/// 两个卡住的会话就能让全机同步停摆。
///
/// ❗ 用毫秒级的停滞上限跑，不真等 30 秒（这正是 `read_dir_with` 存在的理由）。
#[tokio::test]
async fn test_对端发到一半不发了要中断而不是挂死() {
    let listener = offline_ep(41).await;
    let dialer = offline_ep(42).await;
    let to = dialable(&listener);
    let inbox = tmp_dir("stall_in");

    let inbox2 = inbox.clone();
    let recv = tokio::spawn(async move {
        let mut w = super::transport::accept(&listener).await.unwrap();
        super::transport::read_dir_with(
            &mut w.recv,
            &inbox2,
            std::time::Duration::from_millis(300),
        )
        .await
    });

    // 拨号方：把「名字 + 内容长度」发完，然后**一个内容字节也不发**，也不关连接。
    let mut w = super::transport::dial(&dialer, to).await.unwrap();
    let name = b"a.md";
    w.send.write_all(&(name.len() as u32).to_be_bytes()).await.unwrap();
    w.send.write_all(name).await.unwrap();
    w.send.write_all(&1000u64.to_be_bytes()).await.unwrap();

    let t0 = tokio::time::Instant::now();
    let r = recv.await.unwrap();
    let e = r.expect_err("对端不发了，这里必须报错而不是一直等");
    assert!(e.contains("没动"), "报的不是停滞：{}", e);
    assert!(
        t0.elapsed() < std::time::Duration::from_secs(5),
        "停滞超时没生效，等了 {:?}",
        t0.elapsed()
    );

    drop(w);
    let _ = std::fs::remove_dir_all(&inbox);
}

/// 🔴 清单**内容**里的路径也要过同一道门。2026-09-07 审出的真漏洞：
/// `transport` 只校验线上的文件**名**，而 `.pp-sync-manifest` 这个名字合法，
/// 它的**内容**当时直接 `dir.join(rel)` → `remove_file`——
/// 已配对的对端能删本机任意文件。
#[test]
fn test_清单里的穿越路径不能删掉外面的文件() {
    let s = store();
    let n = s.note_create(None, "甲", "正文").unwrap();

    let inbox = tmp_dir("evil_in");
    // 把“受害者”放在 inbox **外面**，模拟本机任意文件
    let victim_dir = tmp_dir("evil_victim");
    let victim = victim_dir.join("别删我.txt");
    std::fs::write(&victim, "这个文件不该被同步碰到").unwrap();

    // 恶意清单：真实 note_id + `incoming = 0`（使 both_changed 为假、不留痕迹）
    // + 一个指向 inbox 外面的绝对路径。走到 `local >= incoming` 就会 remove_file。
    let evil = format!("{}\t0\t{}\n", n.id, victim.to_string_lossy().replace('\\', "/"));
    std::fs::write(inbox.join(".pp-sync-manifest"), evil).unwrap();
    std::fs::write(inbox.join(".pp-sync-tombstones"), "").unwrap();

    let r = apply_delta(&s, &inbox, 0);
    assert!(r.is_err(), "穿越路径应该把会话停下来，而不是默默执行：{:?}", r);
    assert!(
        victim.is_file(),
        "对端通过清单删掉了 inbox 外面的文件——路径穿越回来了"
    );

    let _ = std::fs::remove_dir_all(&inbox);
    let _ = std::fs::remove_dir_all(&victim_dir);
}

// ===== kb_presence 地址宣告 =====

mod presence_tests {
    use super::tmp_dir;
    use crate::sync::identity::NodeIdentity;
    use crate::sync::presence::{
        build, Heard, PresenceApp, PresenceTable, ANNOUNCE_INTERVAL_SECS, STALE_MS,
    };
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
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();

        let table = PresenceTable::new(PresenceApp::Kb);
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&packet, ip(20), &b.node_id(), &known, T0 + 100);

        // 🔴 地址 = 源 IP + 公告里的端口。公告本身**不含 IP**。
        assert_eq!(
            heard,
            Heard::Fresh {
                node_id: a.node_id(),
                addr: SocketAddr::new(ip(20), 41234),
                // 第一份公告就是一次跃变（之前表里根本没它）。
                returned: true,
                // 本包由当前版本的 `build` 发出，带用途标识。
                legacy: false,
            }
        );
        assert_eq!(
            table.addrs_of(&a.node_id(), T0 + 100),
            vec![SocketAddr::new(ip(20), 41234)]
        );
        assert_eq!(table.live(T0 + 100), vec![a.node_id()]);
    }

    /// 🔴 公告是 15 秒一份的**心跳**，只有「从听不到到听得到」那一下是跃变。
    ///
    /// 为何钉它：`service` 拿 `returned` 决定要不要叫醒休眠的同步循环，
    /// 而 `notify_waiters()` 是广播。若每份心跳都算跃变，休眠（本该 1800 秒）
    /// 就被封顶在 15 秒，且任一已配对设备喂气就把全体叫起来——
    /// 一台拒绝本机的设备会每 15 秒被重拨一次、永远下去。
    #[test]
    fn test_只有从没声音到有声音才算它回来了() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_returned")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_returned_b")).unwrap();
        let table = PresenceTable::new(PresenceApp::Kb);
        let known = paired(vec![a.node_id()]);

        // 第一份：表里本没它 → 跃变
        let h1 = table.hear(
            &build(&a, PresenceApp::Kb, 41234, T0).unwrap(),
            ip(20),
            &b.node_id(),
            &known,
            T0,
        );
        assert!(matches!(h1, Heard::Fresh { returned: true, .. }));

        // 第二份（一个心跳周期后，地址还新鲜）→ **不是**跃变
        let t2 = T0 + ANNOUNCE_INTERVAL_SECS as i64 * 1000;
        let h2 = table.hear(
            &build(&a, PresenceApp::Kb, 41234, t2).unwrap(),
            ip(20),
            &b.node_id(),
            &known,
            t2,
        );
        assert!(
            matches!(h2, Heard::Fresh { returned: false, .. }),
            "心跳不能算跃变，否则休眠会被封顶在 15 秒"
        );

        // 隐身超过 STALE_MS 后再冒头 → 又是跃变（这才是真的「回来了」）
        let t3 = t2 + STALE_MS + 1;
        let h3 = table.hear(
            &build(&a, PresenceApp::Kb, 41234, t3).unwrap(),
            ip(20),
            &b.node_id(),
            &known,
            t3,
        );
        assert!(matches!(h3, Heard::Fresh { returned: true, .. }));
    }

    #[test]
    fn test_公告里没有设备名字段() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_noname")).unwrap();
        let packet = build(&a, PresenceApp::Kb, 1234, T0).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&packet).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        // 钉住线上格式：多一个字段就是多一个能进界面的对端可控字符串。
        // 设备名在配对时已入 devices 表，公告不该再带一份。
        //
        // `app` 是例外——它是**枚举**（只可能取值 kb/rc），不是自由文本，
        // 进不了界面也就无法承载可控字符串。加它就是为了认串台（见 Heard::WrongApp）。
        assert_eq!(keys, vec!["app", "node_id", "port", "sig", "ts", "v"]);
    }

    /// 🔴 回归：2026-09-17 那次串台之所以排查半天，是因为包进错表**完全不报错**——
    /// 两套 presence 的包除端口外一模一样（同一 `node_id`、同一把签名密钥），
    /// 全套校验照常通过，地址表被静默写脏，日志与正常心跳长得一样。
    #[test]
    fn test_另一套presence的公告被认出来并丢掉() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_wrongapp_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_wrongapp_b")).unwrap();
        // a 发的是**知识库同步**的公告，却被投进了远程电脑那张表（端口配错）
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&packet, ip(21), &b.node_id(), &known, T0);

        assert_eq!(
            heard,
            Heard::WrongApp {
                claimed: PresenceApp::Kb
            }
        );
        // 🔴 关键：地址一个都不许记。记了就是拿**别的通道**的端点去拨号。
        assert!(table.addrs_of(&a.node_id(), T0).is_empty());
        assert!(table.live(T0).is_empty());
    }

    /// 判定是按**表**来的，不是一刀切拒：同一份包投进对的那张表就正常收下。
    #[test]
    fn test_用途对得上就照常收下() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_rightapp_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_rightapp_b")).unwrap();
        let packet = build(&a, PresenceApp::Rc, 41234, T0).unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&packet, ip(23), &b.node_id(), &known, T0);

        assert!(
            matches!(heard, Heard::Fresh { legacy: false, .. }),
            "{:?}",
            heard
        );
        assert_eq!(table.addrs_of(&a.node_id(), T0).len(), 1);
    }

    /// 🔴 与旧版本的兼容，靠的正是「`app` **不参与签名**」（取舍见 `presence::wire::build`）。
    ///
    /// 删掉字段之后老签名仍然验得过——旧版本收新版本的包就是这个道理。
    /// 反过来，旧包（无 `app`）在新版本这里走 `legacy` 分支**按旧口径收下**：
    /// 拒掉它等于把旧对端的知识库同步也一起打到中继上，为一个新字段引入
    /// 一个新的退化，不划算。
    ///
    /// 📌 若哪天有人把 `app` 塞进 `signing_bytes`，这个测试会红。别直接改绿它——
    /// 那次改动的真实代价是「升级过渡期两个方向一起退到 n0 中继」。
    #[test]
    fn test_旧版公告没有用途标识时按旧口径收下() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_legacy_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_legacy_b")).unwrap();
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();

        // 模拟旧版本发出的包：包体里没有 `app`，签名原样不动
        let mut v: serde_json::Value = serde_json::from_slice(&packet).unwrap();
        v.as_object_mut().unwrap().remove("app");
        let old = serde_json::to_vec(&v).unwrap();

        let table = PresenceTable::new(PresenceApp::Kb);
        let known = paired(vec![a.node_id()]);
        let heard = table.hear(&old, ip(22), &b.node_id(), &known, T0);

        assert_eq!(
            heard,
            Heard::Fresh {
                node_id: a.node_id(),
                addr: SocketAddr::new(ip(22), 41234),
                returned: true,
                legacy: true,
            }
        );
        assert_eq!(table.addrs_of(&a.node_id(), T0).len(), 1);
    }

    #[test]
    fn test_未配对的节点公告直接丢掉() {
        let a = NodeIdentity::load_or_create(&tmp_dir("pres_unp_a")).unwrap();
        let b = NodeIdentity::load_or_create(&tmp_dir("pres_unp_b")).unwrap();
        let packet = build(&a, PresenceApp::Kb, 1234, T0).unwrap();

        let table = PresenceTable::new(PresenceApp::Kb);
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
        let packet = build(&a, PresenceApp::Kb, 1234, T0).unwrap();
        let table = PresenceTable::new(PresenceApp::Kb);
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
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&packet).unwrap();
        // 把端口改成攻击者自己的，签名不动
        v["port"] = serde_json::json!(9999);
        let tampered = serde_json::to_vec(&v).unwrap();

        let table = PresenceTable::new(PresenceApp::Kb);
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
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();
        let table = PresenceTable::new(PresenceApp::Kb);
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
        let packet = build(&a, PresenceApp::Kb, 41234, T0 - 600_000).unwrap();
        let table = PresenceTable::new(PresenceApp::Kb);
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
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();
        let table = PresenceTable::new(PresenceApp::Kb);
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
        let table = PresenceTable::new(PresenceApp::Kb);
        let known = paired(vec![a.node_id()]);
        // 同一台机器两张网卡各发一份（ts 递增，所以都不是重放）
        let p1 = build(&a, PresenceApp::Kb, 41234, T0).unwrap();
        let p2 = build(&a, PresenceApp::Kb, 41234, T0 + 1).unwrap();
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
        let table = PresenceTable::new(PresenceApp::Kb);
        let known = paired(vec![a.node_id()]);
        // 6 个不同源 IP（换过几次网络后的残留），上限是 4
        for (i, last) in [10u8, 11, 12, 13, 14, 15].iter().enumerate() {
            let p = build(&a, PresenceApp::Kb, 41234, T0 + i as i64).unwrap();
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
        let packet = build(&a, PresenceApp::Kb, 41234, T0).unwrap();
        let table = PresenceTable::new(PresenceApp::Kb);
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
        let table = PresenceTable::new(PresenceApp::Kb);
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
        let table = PresenceTable::new(PresenceApp::Kb);
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
        dial_session(&a, &ep_a, &ib, to, false),
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
        dial_session(&a, &ep_a, &ib, dialable(&ep_b), false),
        accept_session(&b, &ep_b, &known)
    );
    let r1a = r1a.expect("第一轮拨号失败");
    r1b.expect("第一轮接受失败");
    let after_first = a.note_changed_since(0).unwrap().len();
    assert_eq!(after_first, 2, "第一轮之后两边各有两篇");

    // 第二轮：两边都没改过任何东西
    let (r2a, r2b) = tokio::join!(
        dial_session(&a, &ep_a, &ib, dialable(&ep_b), false),
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
        dial_session(&a, &ep_a, &ib, dialable(&ep_b), false),
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
    // 🔴 平手是赢家仍然要存副本的**唯一**情形：两边都走 `local >= incoming`、
    //    都没有输家，不存就是两台机器各留各的、永久静默分叉。
    assert_eq!(
        b.note_search("冲突副本", "all", &[], 10).unwrap().len(),
        1,
        "平手时赢家必须把对端那版存下来"
    );
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
        // ❗ 2026-09-06 新增的第五档。原来封顶 60 秒而循环**永不放弃**，
        //   一个永远回不来的对端就是每分钟一次、永远下去；
        //   而听不到它组播时那一拨走的是 n0 公共 relay（真实跨国流量）。
        assert_eq!(backoff_secs(5), 300);
        // 到顶就一直是最后一档，不会越界 panic 也不会无限涨
        assert_eq!(backoff_secs(6), 300);
        assert_eq!(backoff_secs(9999), 300);
        // fails 从 1 起算，传 0 也不能 panic
        assert_eq!(backoff_secs(0), 5);
    }

    #[test]
    fn test_退避阶梯单调不降() {
        // 阶梯写错顺序（比如把 300 插到中间）不会报错，只会让重试节奏变得很怪。
        let mut prev = 0;
        for f in 1..=10u32 {
            let w = backoff_secs(f);
            assert!(w >= prev, "阶梯在第 {} 次回落了：{} -> {}", f, prev, w);
            prev = w;
        }
    }

    // ===== 对端拒绝的分类（2026-09-06）=====
    //
    // 🔴 这一组盯的是一个**错了不会报错**的东西：分类错了只会表现为
    // 「白烧 relay 流量」或「界面上只写离线不说原因」。

    #[test]
    fn test_认得出对端说的还没配对() {
        use crate::sync::service::{is_busy_reject, is_not_paired_reject};
        // 真实形状：`session::explain` 把 `close_reason()` 拼在原错误后面。
        let real = "读帧长度失败：connection lost（closed by peer: not paired (code 1)）";
        assert!(is_not_paired_reject(real));
        // 它不应该同时被当成「在忙」——两者的重试节奏差一个数量级。
        assert!(!is_busy_reject(real));
    }

    #[test]
    fn test_等对方确认算在忙而不是故障() {
        use crate::sync::join::REJECT_PENDING;
        use crate::sync::service::{is_busy_reject, is_not_paired_reject};
        let real = format!("读帧长度失败：connection lost（closed by peer: {} (code 1)）", REJECT_PENDING);
        // 走短延迟重试：用户刚在对面点完确认，不该再等一分钟。
        assert!(is_busy_reject(&real));
        assert!(!is_not_paired_reject(&real));
    }

    #[test]
    fn test_普通网络错误两者都不匹配() {
        use crate::sync::service::{is_busy_reject, is_not_paired_reject};
        // 这种才该走退避阶梯（重试真的可能会好）。
        for e in ["连接对端失败：timed out", "读帧长度失败：connection lost"] {
            assert!(!is_not_paired_reject(e), "{}", e);
            assert!(!is_busy_reject(e), "{}", e);
        }
    }

    #[test]
    fn test_休眠阈值落在阶梯顶之后() {
        use crate::sync::coordinate::{DORMANT_AFTER_FAILS, DORMANT_POLL_SECS};
        // 休眠前要先把整个退避阶梯走完，否则那几档根本用不上。
        assert!(
            (DORMANT_AFTER_FAILS as usize) > BACKOFF_STEPS_SECS.len(),
            "休眠阈值比阶梯还短，退避就白设了"
        );
        // 休眠心跳必须比阶梯最后一档稀，否则「休眠」反而拨得更勤。
        assert!(
            DORMANT_POLL_SECS > *BACKOFF_STEPS_SECS.last().unwrap(),
            "休眠间隔没比退避顶档更稀"
        );
    }

    #[test]
    fn test_抖动不越界且真的会变() {
        let mut seen = std::collections::HashSet::new();
        for seed in 0..500u64 {
            let v = jittered_secs(HEARTBEAT_SECS, JITTER_SECS, seed);
            assert!(
                (HEARTBEAT_SECS - JITTER_SECS..=HEARTBEAT_SECS + JITTER_SECS).contains(&v),
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
    fn test_抖动幅度要按心跳比例给() {
        // 🔴 这条盯的是一个**改了不会报错**的东西：`JITTER_SECS` 是个绝对秒数，
        //    而它的意义是「占心跳的百分之几」。周期从 30 秒改成 600 秒心跳的那一次，
        //    抖动没跟着改，于是它从 ±33% 变成 ±1.7%——等于没有抖动，
        //    几台设备一起开机就会一直聚成惊群，而且**台数越多越明显**。
        let pct = JITTER_SECS as f64 * 100.0 / HEARTBEAT_SECS as f64;
        assert!(
            JITTER_SECS >= HEARTBEAT_SECS / 10,
            "抖动只有心跳的 {:.1}%，撑不开心跳惊群",
            pct
        );
        assert!(
            JITTER_SECS <= HEARTBEAT_SECS / 4,
            "抖动大到心跳的 {:.1}%，「最多多久兜底一次」这个上限就没意义了",
            pct
        );
    }

    #[test]
    fn test_合并窗口必须比去抖间隔短且有封顶() {
        use crate::sync::coordinate::{
            MIN_SESSION_GAP_SECS, WRITE_COALESCE_MAX_SECS, WRITE_COALESCE_SECS,
        };
        // 合并窗口是**直接加在**「改完到同步出去」的延迟上的。
        // 它比去抖间隔还长的话，用户感受到的就不是「合并」而是「变慢了」。
        assert!(
            WRITE_COALESCE_SECS < MIN_SESSION_GAP_SECS,
            "合并窗口（{}s）比去抖间隔（{}s）还长",
            WRITE_COALESCE_SECS,
            MIN_SESSION_GAP_SECS
        );
        // 🔴 封顶必须真的卡得住：没它的话，一直在写的人就一直不同步。
        assert!(WRITE_COALESCE_MAX_SECS > WRITE_COALESCE_SECS);
        // 闸位不能降到 1：完全串行的话，一台慢对端（走中继、跨国）
        // 会把其它所有设备堵在后面；降到 0 则是直接把同步关掉。
        assert!(
            crate::sync::coordinate::MAX_CONCURRENT_SESSIONS >= 2,
            "并发闸降到 {} 会让一台慢对端堵住全部",
            crate::sync::coordinate::MAX_CONCURRENT_SESSIONS
        );
        // 也不能大到把心跳都盖住（那就变成另一个同步周期了）
        assert!(WRITE_COALESCE_MAX_SECS < HEARTBEAT_SECS);
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
    use crate::sync::coordinate::{Admit, Coordinator, HoldErr, YIELD_WAIT};

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
        // ❗ 闸位给到 4：这条盯的是**每对端那把锁**，不能让全局闸插进来干扰结论。
        let c = Coordinator::with_limit(lo(), 4);
        let peer = hi();
        let h = c.try_hold(&peer).expect("第一次应拿到");
        assert_eq!(h.peer(), peer);
        assert_eq!(
            c.try_hold(&peer).unwrap_err(),
            HoldErr::PeerBusy,
            "同一对端不该拿到第二把"
        );
        // 不同对端互不影响 —— 多设备要能并行
        assert!(c.try_hold("0".repeat(64).as_str()).is_ok());
    }

    #[test]
    fn test_槽随作用域自动释放() {
        // 会话怎么退出（返回 / ? / panic）都不该漏槽，所以用 Drop 而不是显式 release
        let c = Coordinator::new(lo());
        let peer = hi();
        {
            let _h = c.try_hold(&peer).unwrap();
        }
        assert!(c.try_hold(&peer).is_ok(), "出了作用域应已释放");
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

    // ===== 全局并发闸（W6 止血第一条，2026-09-07）=====

    #[test]
    fn test_闸满了不同对端也开不了会话() {
        // 🔴 每对端一把锁**天生挡不住**「7 个不同对端各开一个」——
        //    而那正是 8 台设备互配时一次写入广播唤醒的形状。闸就是为这个加的。
        let c = Coordinator::with_limit(lo(), 2);
        let a = c.try_hold(&"a".repeat(64)).expect("第 1 个");
        let b = c.try_hold(&"b".repeat(64)).expect("第 2 个");
        assert_eq!(c.free_slots(), 0);
        assert_eq!(
            c.try_hold(&"c".repeat(64)).unwrap_err(),
            HoldErr::GateFull,
            "闸满了却还放第 3 个不同对端进来"
        );
        drop(a);
        assert_eq!(c.free_slots(), 1, "闸位没随会话结束归还");
        assert!(c.try_hold(&"c".repeat(64)).is_ok(), "腾出来之后应能开");
        drop(b);
    }

    #[test]
    fn test_闸满与对端在忙是两种原因() {
        // 🔴 合成一个 `None` 的话，`admit` 会把「闸满」当成撞车去让位，
        //    而让位等的是那把槽的释放通知——槽根本没被这个对端占着，
        //    只会白等满 YIELD_WAIT。两个原因必须能分开。
        let peer = hi();
        // 闸只有 1 位：按「先闸后槽」的顺序，先撞上的是闸
        let c1 = Coordinator::with_limit(lo(), 1);
        let _h1 = c1.try_hold(&peer).unwrap();
        assert_eq!(c1.try_hold(&peer).unwrap_err(), HoldErr::GateFull);
        // 闸有余量时，同一对端才报 PeerBusy
        let c2 = Coordinator::with_limit(lo(), 4);
        let _h2 = c2.try_hold(&peer).unwrap();
        assert_eq!(c2.try_hold(&peer).unwrap_err(), HoldErr::PeerBusy);
    }

    #[tokio::test]
    async fn test_闸满时拒的是可重试的在忙而不是故障() {
        // 🔴 这条盯的是**跨文件的一致性**：拒绝理由里的字样必须能被
        //    `service::is_busy_reject` 认出来。认不出就会被当成故障走退避阶梯，
        //    一台正常设备被退到 300 秒一拨，而本机可能下一秒就空出来了。
        use crate::sync::service::{is_busy_reject, is_not_paired_reject};
        let c = Coordinator::with_limit(lo(), 1);
        let _h = c.try_hold(&"a".repeat(64)).unwrap();
        match c.admit(&hi(), true).await {
            Admit::Reject(why) => {
                assert!(is_busy_reject(&why), "闸满被判成故障了：{}", why);
                assert!(!is_not_paired_reject(&why), "{}", why);
            }
            other => panic!("闸满却收下了入连接：{:?}", other),
        }
    }

    #[tokio::test]
    async fn test_闸满时不走让位所以不会白等满超时() {
        // 对端 id 比本机大 ⇒ 真撞车的话会走 YieldToPeer 等满 YIELD_WAIT。
        // 闸满不是撞车，必须立刻拒。
        let c = Coordinator::with_limit(lo(), 1);
        let _h = c.try_hold(&"a".repeat(64)).unwrap();
        let t0 = tokio::time::Instant::now();
        assert!(matches!(c.admit(&hi(), true).await, Admit::Reject(_)));
        assert!(
            t0.elapsed() < YIELD_WAIT,
            "闸满走进了让位分支，白等了 {:?}",
            t0.elapsed()
        );
    }
}

// ===== 暂存目录回收（2026-09-07） =====
//
// 🔴 暂存目录里是**明文笔记**。会话自己会删，但进程崩溃时残留，
// 而之前没有任何地方清理它们。

mod scratch_gc_tests {
    use crate::sync::session::sweep_scratch_in;
    use std::time::Duration;

    fn mkdir(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = root.join(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("a.md"), "明文笔记").unwrap();
        p
    }

    #[test]
    fn test_到期的扫掉_不是我们的不碰() {
        let root = super::tmp_dir("gc_root");
        let mine = mkdir(&root, "pp_session_out_abc");
        let mine2 = mkdir(&root, "pp_session_in_def");
        // ❗ 别人的东西：`%TEMP%` 是共用的，认错前缀就是删别人的文件
        let theirs = mkdir(&root, "pp_other_xyz");
        let unrelated = mkdir(&root, "chrome_tmp");

        // ttl = 0 ⇒ 刚建的也算到期，免得去改 mtime
        let n = sweep_scratch_in(&root, Duration::from_secs(0));
        assert_eq!(n, 2, "该删两个");
        assert!(!mine.exists() && !mine2.exists(), "自己的暂存目录没删掉");
        assert!(theirs.exists(), "前缀不对的被误删了（%TEMP% 是共用的）");
        assert!(unrelated.exists(), "无关目录被误删了");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_没到期的一律不动() {
        // 🔴 这条盯的是「误删正在跑的会话目录」——那会直接把那次同步弄崩。
        let root = super::tmp_dir("gc_root2");
        let live = mkdir(&root, "pp_session_out_live");

        let n = sweep_scratch_in(&root, Duration::from_secs(24 * 3600));
        assert_eq!(n, 0, "刚建的目录不该被删");
        assert!(live.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_根目录不存在不崩() {
        assert_eq!(
            sweep_scratch_in(std::path::Path::new("D:/这个目录不存在的"), Duration::from_secs(0)),
            0
        );
    }
}

// ===== 写入合并窗口（W6 止血第三条，2026-09-07） =====
//
// ❗ 窗口长度从参数进，所以这里全用毫秒级的值：不用真睡 3 秒，
// 也不用为了 `tokio::time::pause()` 去开 tokio 的 `test-util`
// （`features = ["full"]` 不含它）。

mod coalesce_tests {
    use crate::sync::service::coalesce_writes;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;

    const QUIET: Duration = Duration::from_millis(60);

    /// 🔴 测试里用 `notify_one()` 而不是生产里那个 `notify_waiters()`。
    ///
    /// `notify_waiters()` **只叫醒当时已注册的等待者、不存许可**，
    /// 而循环每转一圈要重新建一个 `notified()`。机器一卡，写入任务没被调度到，
    /// 四次通知可以**全部丢掉**——实测到过一次：本该 180ms 的用例只跑了 68.7ms。
    ///
    /// ❗ 这不是产品 bug：生产里漏接一次只意味着早放行一个窗口、照样去拨，无害。
    /// 但它让**测试**变成了招式。`notify_one()` 会存一个许可，
    /// 下一次 `notified()` 立刻返回，于是不论调度怎么拖都不会丢——
    /// 而 `coalesce_writes` 跑的仍然是同一条代码路径。
    fn poke(n: &Notify) {
        n.notify_one();
    }

    #[tokio::test]
    async fn test_安静一个窗口之后放行() {
        let (stop, wrote) = (Notify::new(), Notify::new());
        let t0 = tokio::time::Instant::now();
        assert!(coalesce_writes(&stop, &wrote, QUIET, Duration::from_secs(30)).await);
        assert!(t0.elapsed() >= QUIET, "没等满一个安静窗口就放行了");
    }

    #[tokio::test]
    async fn test_连续写入会把窗口顶回去() {
        // 这就是「连续编辑不该每次都叫醒全部对端」那一条。
        let stop = Arc::new(Notify::new());
        let wrote = Arc::new(Notify::new());
        let w2 = wrote.clone();
        // 每 30ms 写一次（比 60ms 的窗口密），连写 4 次
        tokio::spawn(async move {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_millis(30)).await;
                poke(&w2);
            }
        });
        let t0 = tokio::time::Instant::now();
        assert!(coalesce_writes(&stop, &wrote, QUIET, Duration::from_secs(30)).await);
        // 4×30ms（每一次都把窗口顶回去）+ 60ms（最后一个完整安静窗口）= 180ms。
        // 睡眠只会超时不会提前，而 `poke` 不丢通知，所以这个下界是确定的。
        // 不顶的话只有 ~60ms。
        assert!(
            t0.elapsed() >= Duration::from_millis(4 * 30 + 60),
            "窗口没被新写入顶回去，只用了 {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test]
    async fn test_一直在写也不会无限期不同步() {
        // 🔴 没有封顶的话，写一小时的人就一小时不同步——
        //    那是把「合并」做成了「饿死」。
        let stop = Arc::new(Notify::new());
        let wrote = Arc::new(Notify::new());
        let w2 = wrote.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                poke(&w2);
            }
        });
        let max = Duration::from_millis(300);
        let t0 = tokio::time::Instant::now();
        assert!(coalesce_writes(&stop, &wrote, QUIET, max).await);
        let e = t0.elapsed();
        // 🔴 下界与上界都要断：
        //    每 10ms 写一次、窗口 60ms ⇒ 安静窗口**永远轮不到**，只能由封顶放行。
        //    只断上界的话，“提前从安静窗口跑掉”也会算通过——那就根本没测到封顶。
        assert!(e >= max, "不是被封顶放行的（只用了 {:?}），这条测的不是封顶", e);
        assert!(e < max * 3, "封顶没生效，等了 {:?}", e);
    }

    #[tokio::test]
    async fn test_关开关时立刻退出而不是等满窗口() {
        // 开关一关就该停，不能让用户看着「明明关了还在同步」。
        let stop = Arc::new(Notify::new());
        let wrote = Notify::new();
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            poke(&s2);
        });
        assert!(
            !coalesce_writes(&stop, &wrote, Duration::from_secs(300), Duration::from_secs(3600))
                .await,
            "开关关了必须返回 false"
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

// ===== 待确认的敲门（sync::join，2026-09-06）=====
//
// 这一块补的是「配对只有粘贴方写表」那个断链（见 `sync::join` 模块注释）。
// 下面盯的都是「错了不会报错，只会表现为配不上」的性质。

use super::join::{JoinRequests, KNOCK_TTL_MS};

#[test]
fn test_敲门会进待确认列表() {
    let j = JoinRequests::new();
    assert!(j.knock("peer-a", 1_000));
    let v = j.list(1_000);
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].node_id, "peer-a");
    assert_eq!(v[0].tries, 1);
}

#[test]
fn test_重复敲门只累加次数不堆条() {
    // 对端被拒后会一直重试，堆成 N 条的话界面上就是一屏相同的指纹。
    let j = JoinRequests::new();
    for i in 0..5 {
        assert!(j.knock("peer-a", 1_000 + i));
    }
    let v = j.list(1_000);
    assert_eq!(v.len(), 1, "同一台反复敲门不能堆出多条");
    assert_eq!(v[0].tries, 5);
    assert_eq!(v[0].first_seen_ms, 1_000, "首次时间不该被后续敲门覆盖");
}

#[test]
fn test_不再敲的会过期消失() {
    let j = JoinRequests::new();
    j.knock("peer-a", 1_000);
    assert_eq!(j.list(1_000 + KNOCK_TTL_MS).len(), 1, "刚好到期还算新鲜");
    assert!(
        j.list(1_000 + KNOCK_TTL_MS + 1).is_empty(),
        "对方不再试了就该从列表里消失，而不是挂到天荒地老"
    );
}

#[test]
fn test_拒绝过的不再记() {
    // 🔴 不守这一条的后果：用户点了拒绝，而对端每几秒重试一次，
    //    于是那个框一直弹回来——变成骚扰。
    let j = JoinRequests::new();
    j.knock("peer-a", 1_000);
    j.deny("peer-a");
    assert!(j.list(1_000).is_empty(), "拒绝后应立即从列表里消失");
    assert!(!j.knock("peer-a", 2_000), "拒绝过的不能再进列表");
    assert!(j.list(2_000).is_empty());
}

#[test]
fn test_放行后拿掉_但不进拒绝名单() {
    let j = JoinRequests::new();
    j.knock("peer-a", 1_000);
    assert!(j.take("peer-a"), "放行时应该能拿到它");
    assert!(!j.take("peer-a"), "拿过一次就不在了");
    // 放行不等于拉黑：万一用户之后又「忘记此设备」，它还得能重新敲门。
    assert!(j.knock("peer-a", 2_000), "放行过的设备以后还得能再敲门");
}

#[test]
fn test_放行卡住没敲过门的() {
    // 🔴 `kb_sync_join_approve` 靠这个返回值卡住「前端传任意 node_id
    //    就能把任何人写进设备表」。
    let j = JoinRequests::new();
    assert!(!j.take("从来没敲过门的人"));
}

#[test]
fn test_关开关清队列_但拒绝名单留着() {
    // 关一下再开就又开始弹同一台被拒过的机器，那不是用户要的。
    let j = JoinRequests::new();
    j.knock("good", 1_000);
    j.knock("bad", 1_000);
    j.deny("bad");
    j.clear();
    assert!(j.list(1_000).is_empty());
    assert!(j.knock("good", 2_000), "没被拒过的重启后还能敲");
    assert!(!j.knock("bad", 2_000), "被拒过的不能因为 clear 就复活");
}

#[test]
fn test_空的nodeid不记() {
    let j = JoinRequests::new();
    assert!(!j.knock("", 1_000));
    assert!(j.list(1_000).is_empty());
}

/// 失败不能把「曾经同步成功过」抹掉。
///
/// 🔴 知识库那条同步提示就靠 `last_ok_ms` 分「对方没开机」与「上午还好好的现在坏了」：
/// 前者你什么都做不了（不报警），后者才值得橙色一行。
/// `at_ms` 代替不了——它是「上次**尝试**」，失败时同样在刷。
use super::service::{record_into, LastSync, Outcome};

#[test]
fn test_失败不覆盖上次成功时间() {
    use std::collections::HashMap;
    use std::sync::Mutex;

    let last: Mutex<HashMap<String, LastSync>> = Mutex::new(HashMap::new());
    last.lock().unwrap().insert(
        "p1".to_string(),
        LastSync {
            peer: "p1".to_string(),
            at_ms: 1_000,
            last_ok_ms: 1_000,
            ..Default::default()
        },
    );

    record_into(&last, "p1", Outcome::Failed("网络不通".to_string()), 3, 30, false);
    record_into(&last, "p2", Outcome::Failed("超时".to_string()), 1, 5, false);
    record_into(&last, "p3", Outcome::Failed("一直连不上".to_string()), 20, 1800, true);

    let m = last.lock().unwrap();

    let p1 = &m["p1"];
    assert_eq!(p1.last_ok_ms, 1_000, "失败不能把「曾经成功过」抹掉");
    assert!(p1.at_ms > 1_000, "at_ms 是「上次尝试」，失败时应该刷新");
    assert_eq!(p1.fails, 3);
    assert!(!p1.dormant);

    assert_eq!(m["p2"].last_ok_ms, 0, "从未成功过就该是 0——界面据此只合并成一行灰字");

    // dormant 由循环的 `Wait` 传进来，不在这里再推一遍阀值
    assert!(m["p3"].dormant, "已休眠要能传到前端，否则它只能拿 fails 阀值再推一遍");
}

/// 重启后不能把「曾经同步成功过」丢掉。
///
/// 🔴 这条盯的是一个真开过的 bug（2026-09-09）：`last_ok_ms` 本来只存在
/// `SyncCtx.last` 那张**内存**表里，而那张表每次启动都是空的。
/// 于是上面那条测试盯住的区分（没开机 vs 刚坏）**每次重启后都静默失效**：
/// 知识库那条提示把已经同步过的设备说成「还没连上 2 台」。
#[test]
fn test_启动时把上次成功时间种回内存表() {
    use super::service::seed_last_ok;
    use crate::data_store::device::Device;
    use std::collections::HashMap;
    use std::sync::Mutex;

    let dev = |id: &str, ok: i64| Device {
        node_id: id.to_string(),
        name: id.to_string(),
        paired_at: String::new(),
        transport: String::new(),
        conn_state: String::new(),
        last_seen: 0,
        relay_addr: String::new(),
        sync_cursor_ms: 0,
        last_ok_ms: ok,
        paused: false,
    };

    let last: Mutex<HashMap<String, LastSync>> = Mutex::new(HashMap::new());
    seed_last_ok(&last, &[dev("p1", 5_000), dev("p2", 0)]);

    {
        let m = last.lock().unwrap();
        assert_eq!(m["p1"].last_ok_ms, 5_000, "持久化的成功时间没种进来");
        assert_eq!(m["p1"].peer, "p1");
        // ❗ `at_ms` 必须还是 0：它是「上次**尝试**」，而本进程一次都没试过。
        //   写上了界面的 `newest` 就会成立 ⇒ 顶上一句「已与 p1 同步·刚刚」。
        assert_eq!(m["p1"].at_ms, 0, "at_ms 不能被种——那会谎报成「刚刚同步过」");
        assert!(!m.contains_key("p2"), "从未成功过的不必建空条目");
    }

    // 种完之后再失败一次：这才是真正要保的联合行为——
    // 界面应该看到「连不上 p1（多久之前还好好的）」，而不是「还没连上」。
    record_into(&last, "p1", Outcome::Failed("网络不通".to_string()), 2, 30, false);
    let m = last.lock().unwrap();
    assert_eq!(
        m["p1"].last_ok_ms, 5_000,
        "种过之后失败仍不能抹掉它——否则重启后第一次失败就又变回「从未成功过」"
    );
    assert!(m["p1"].fails > 0);
}

/// 明文包（A3：招呼 / 配对握手）的判据。
///
/// 单独一个模块而不是塞进 `presence_tests`：那里面全是**地址公告**的判据，
/// 而这一组测的是「同一个端口上的另一类包」，两者的不变量完全不同
/// （最要紧的一条：明文包**不查是否已配对**）。
#[cfg(test)]
mod presence_plain_tests {
    use super::tmp_dir;
    use crate::sync::identity::NodeIdentity;
    use crate::sync::presence::{
        build, build_kind, hello_packet, Extras, Heard, Nearby, PlainPacket, PresenceApp,
        PresenceTable, WireKind, NAME_MAX_CHARS,
    };
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::sync::{Arc, Mutex};

    const T0: i64 = 1_757_000_000_000;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, last))
    }

    fn paired(ids: Vec<String>) -> impl Fn(&str) -> bool {
        move |id| ids.iter().any(|x| x == id)
    }

    fn nobody(_: &str) -> bool {
        false
    }

    /// 把包里的某个 JSON 字段删掉，模拟**旧版本**（没有该字段）发的包。
    fn strip(packet: &[u8], key: &str) -> Vec<u8> {
        let mut v: serde_json::Value = serde_json::from_slice(packet).unwrap();
        v.as_object_mut().unwrap().remove(key);
        serde_json::to_vec(&v).unwrap()
    }

    /// 改一个**参与签名**的字段（端口），模拟被篡改的包。
    fn tamper_port(packet: &[u8], port: u16) -> Vec<u8> {
        let mut v: serde_json::Value = serde_json::from_slice(packet).unwrap();
        v.as_object_mut()
            .unwrap()
            .insert("port".into(), serde_json::Value::from(port));
        serde_json::to_vec(&v).unwrap()
    }

    /// 🔴 全组最要紧的一条：**附近设备按定义就是还没配对的邻居**。
    ///
    /// 地址表那条路在验签之前就把未配对设备拦掉了（`if !is_paired { Unpaired }`），
    /// 而那正是「同网段任何人乱发都能把表灌满」的唯一入口。明文包走另一条路：
    /// 不查 `is_paired`，但也**一个字都不进地址表**。
    #[test]
    fn test_招呼包未配对也收得到但一个字都不入地址表() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_me")).unwrap();
        let packet = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::Hello,
            41234,
            T0,
            Extras::hello("办公室台式机"),
        )
        .unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        let heard = table.hear(&packet, ip(20), &me.node_id(), &nobody, T0 + 100);

        assert_eq!(
            heard,
            Heard::Plain(PlainPacket {
                kind: WireKind::Hello,
                node_id: a.node_id(),
                name: "办公室台式机".to_string(),
                pk: String::new(),
                to_id: String::new(),
                ts: T0,
                src: SocketAddr::new(ip(20), 41234),
            })
        );
        assert!(
            table.live(T0 + 100).is_empty(),
            "明文包绝不能进地址表：那正是「未配对不入表」这条不变量要挡的事"
        );
        assert!(table.addrs_of(&a.node_id(), T0 + 100).is_empty());
    }

    /// 握手包同样不查 `is_paired`，且公钥与目标都要能原样拿出来。
    #[test]
    fn test_握手包带上公钥与目标() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_pk_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_pk_me")).unwrap();
        let pk = "ab".repeat(32);
        let packet = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::PinReq,
            41234,
            T0,
            Extras::to(&me.node_id(), &pk),
        )
        .unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        match table.hear(&packet, ip(21), &me.node_id(), &nobody, T0) {
            Heard::Plain(p) => {
                assert_eq!(p.kind, WireKind::PinReq);
                assert_eq!(p.pk, pk, "公钥要能原样传给 X25519 协商");
                assert_eq!(p.to_id, me.node_id(), "定向包要能认出是给谁的");
                assert_eq!(p.name, "", "握手包不带名字");
            }
            other => panic!("应当收成明文包，实际 {:?}", other),
        }
    }

    /// 🔴 兼容性：**旧版本发的包里没有 `kind`**，必须按地址公告（`Addr`）处理。
    ///
    /// 反了的话（默认值不是 `Addr`），升级过渡期所有旧对端的地址公告都会被
    /// 判成另一种包而丢掉——局域网发现整个失效，而这一点在界面上完全看不出来。
    #[test]
    fn test_老包没有kind字段时按地址公告收下() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_old_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_old_me")).unwrap();
        let old = strip(&build(&a, PresenceApp::Rc, 41234, T0).unwrap(), "kind");

        let table = PresenceTable::new(PresenceApp::Rc);
        let known = paired(vec![a.node_id()]);
        assert_eq!(
            table.hear(&old, ip(20), &me.node_id(), &known, T0 + 100),
            Heard::Fresh {
                node_id: a.node_id(),
                addr: SocketAddr::new(ip(20), 41234),
                returned: true,
                legacy: false,
            },
            "没有 kind 的老包 = 地址公告，收下并学地址（老行为一模一样）"
        );
    }

    /// 明文包**必须带用途标识**：`None` 只可能是中间人抹掉的。
    ///
    /// 与地址公告相反（那里读得进没有 `app` 的旧包）。差别有理由：
    /// 旧版本根本不发明文包，所以这里挡不到任何真实对端；
    /// 而把一份用途不明的包当本套收下，正是 09-17 那次串台污染的老路。
    #[test]
    fn test_明文包没有用途标识就拒() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_noapp_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_noapp_me")).unwrap();
        let noapp = strip(
            &build_kind(
                &a,
                PresenceApp::Rc,
                WireKind::Hello,
                41234,
                T0,
                Extras::hello("x"),
            )
            .unwrap(),
            "app",
        );

        let table = PresenceTable::new(PresenceApp::Rc);
        match table.hear(&noapp, ip(20), &me.node_id(), &nobody, T0) {
            Heard::Bad(why) => assert!(why.contains("用途标识"), "要说清是缺什么，实际：{}", why),
            other => panic!("应当拒掉，实际 {:?}", other),
        }
    }

    /// 串台在明文这条路上同样要认得出来（否则 rc 的招呼包会进 kb 的附近表）。
    #[test]
    fn test_明文包串台也认得出() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_wrong_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_wrong_me")).unwrap();
        let rc_hello = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::Hello,
            41234,
            T0,
            Extras::hello("台式机"),
        )
        .unwrap();

        let kb_table = PresenceTable::new(PresenceApp::Kb);
        assert_eq!(
            kb_table.hear(&rc_hello, ip(20), &me.node_id(), &nobody, T0),
            Heard::WrongApp {
                claimed: PresenceApp::Rc
            },
            "知识库同步那套不该收远程电脑的招呼包"
        );
    }

    /// 签名照旧要验——它挡的是「冒名宣告别人的 node_id」，
    /// 没有它，同网段的人能让用户看到一台名字对得上、指纹却是别人的设备。
    #[test]
    fn test_明文包签名对不上就拒() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_sig_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_sig_me")).unwrap();
        // 端口参与签名：改了它签名就不对
        let bad = tamper_port(
            &build_kind(
                &a,
                PresenceApp::Rc,
                WireKind::Hello,
                41234,
                T0,
                Extras::hello("x"),
            )
            .unwrap(),
            9999,
        );

        let table = PresenceTable::new(PresenceApp::Rc);
        match table.hear(&bad, ip(20), &me.node_id(), &nobody, T0) {
            Heard::Bad(why) => assert!(why.contains("签名"), "要说清是签名不过，实际：{}", why),
            other => panic!("应当拒掉，实际 {:?}", other),
        }
    }

    /// 超窗的明文包照丢。没有这条，一份几个月前的招呼包可以随时把列表刷出一台
    /// 早就不在的机器。
    #[test]
    fn test_明文包超窗就丢() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_win_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_win_me")).unwrap();
        let hello = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::Hello,
            41234,
            T0,
            Extras::hello("x"),
        )
        .unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        match table.hear(&hello, ip(20), &me.node_id(), &nobody, T0 + 121_000) {
            Heard::OutOfWindow { skew_ms, .. } => assert_eq!(skew_ms, 121_000),
            other => panic!("超窗该丢，实际 {:?}", other),
        }
    }

    /// 组播会回环，自己的招呼包要认出来（不然列表里会多一台自己）。
    #[test]
    fn test_自己发的招呼包判成自己的() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_mine_a")).unwrap();
        let hello = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::Hello,
            41234,
            T0,
            Extras::hello("我"),
        )
        .unwrap();
        let table = PresenceTable::new(PresenceApp::Rc);
        assert_eq!(
            table.hear(&hello, ip(20), &a.node_id(), &nobody, T0),
            Heard::Mine
        );
    }

    /// 名字是**对方自报、不可信**的字符串，会一路进到界面上，所以两头都要卡：
    /// 长度截断 + 去掉控制字符。
    #[test]
    fn test_自报的名字被截断且不含控制字符() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_name_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_name_me")).unwrap();
        let long = format!("{}\n\t{}", "办".repeat(60), "台式机");
        let hello = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::Hello,
            41234,
            T0,
            Extras::hello(&long),
        )
        .unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        match table.hear(&hello, ip(20), &me.node_id(), &nobody, T0) {
            Heard::Plain(p) => {
                assert_eq!(
                    p.name.chars().count(),
                    NAME_MAX_CHARS,
                    "超长名字要截断到上限"
                );
                assert!(
                    !p.name.chars().any(|c| c.is_control()),
                    "控制字符（换行 / 制表）不能带进界面，实际：{:?}",
                    p.name
                );
            }
            other => panic!("应当收成明文包，实际 {:?}", other),
        }
    }

    /// 处理器能拿到源地址（附近列表要显示「局域网」那一栏），
    /// 且**没注册处理器时要说得出没人接**——静默丢弃比报错难查一个量级。
    #[test]
    fn test_明文包派发给注册过的处理器() {
        let a = NodeIdentity::load_or_create(&tmp_dir("plain_disp_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("plain_disp_me")).unwrap();
        let hello = build_kind(
            &a,
            PresenceApp::Rc,
            WireKind::Hello,
            41234,
            T0,
            Extras::hello("台式机"),
        )
        .unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        let got: Arc<Mutex<Vec<PlainPacket>>> = Arc::new(Mutex::new(Vec::new()));
        let got2 = got.clone();
        table.on_plain(Arc::new(move |p: &PlainPacket| {
            got2.lock().unwrap().push(p.clone());
        }));

        let Heard::Plain(p) = table.hear(&hello, ip(20), &me.node_id(), &nobody, T0) else {
            panic!("应当收成明文包");
        };
        assert!(table.dispatch_plain(&p), "注册过就该有人接");
        assert_eq!(got.lock().unwrap().as_slice(), &[p]);
    }

    #[test]
    fn test_没注册处理器时明说没人接() {
        let table = PresenceTable::new(PresenceApp::Kb);
        let p = PlainPacket {
            kind: WireKind::Hello,
            node_id: "a".repeat(64),
            name: "x".to_string(),
            pk: String::new(),
            to_id: String::new(),
            ts: T0,
            src: SocketAddr::new(ip(20), 41234),
        };
        assert!(
            !table.dispatch_plain(&p),
            "知识库同步那套没注册处理器，调用方据此留一条 debug"
        );
    }

    /// 🔴 **用生产函数造包**，而不是像组里其余用例那样现造。
    ///
    /// 它钉的是「发的那一侧真的接上了」。2026-09-17 首版的事故：
    /// 本文件九条用例全过、`cargo test` 1455 条全绿，而「附近的设备」
    /// **永远是空的**——因为那些测试里的招呼包全是自己 `build_kind` 现造的，
    /// 而 `presence::spawn` 里**根本没有发送路径**。
    /// 改用 `hello_packet`（`spawn` 用的就是它）之后，谁删了那个函数本用例先编译不过。
    #[test]
    fn test_生产函数造的招呼包能被附近表收下() {
        let a = NodeIdentity::load_or_create(&tmp_dir("hello_prod_a")).unwrap();
        let me = NodeIdentity::load_or_create(&tmp_dir("hello_prod_me")).unwrap();

        let packet = hello_packet(&a, PresenceApp::Rc, 41234, "办公室台式机", T0).unwrap();

        let table = PresenceTable::new(PresenceApp::Rc);
        let heard = table.hear(&packet, ip(31), &me.node_id(), &nobody, T0 + 100);
        let Heard::Plain(p) = heard else {
            panic!("招呼包应当判成明文包，实际：{:?}", heard);
        };
        assert_eq!(p.kind, WireKind::Hello);
        assert_eq!(p.name, "办公室台式机");

        // 收下之后要进附近表——那才是「附近的设备」列表的数据源。
        let nearby = Nearby::new();
        assert!(
            nearby.note(&p.node_id, &p.name, p.src, T0 + 100),
            "首次听到一台 = 新发现，要报 true 好让调用方只在跃变时记日志"
        );
        let list = nearby.list(T0 + 100);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "办公室台式机");
        assert_eq!(list[0].node_id, a.node_id());
    }

    /// 🔴 守卫：`presence::spawn` 里必须**真的**在周期发招呼包。
    ///
    /// 这条测不了行为（`spawn` 要起线程、发真组播，单测里碰不得），所以退一步
    /// 断言「发的那段代码还在」。**它不是形式主义**：2026-09-17 的首版就是
    /// 收包侧全写完（`hear_plain` / `Nearby` / 上面九条用例）、发包侧一行没有，
    /// 而当时 1455 条测试全绿。删掉那段时这条会红，逼人回答
    /// 「那『附近的设备』靠什么出现」。
    ///
    /// 另一道更早的防线是结构性的：`PresenceStart::hello_name` 是**必填字段**，
    /// 新建一套 presence 的人会被编译器逼着表态发不发招呼。
    #[test]
    fn test_守卫_spawn_里真的在周期发招呼包() {
        let src = include_str!("presence/mod.rs");
        assert!(
            src.contains("hello_packet("),
            "`presence::spawn` 里必须造招呼包——没有它「附近的设备」永远是空的"
        );
        assert!(
            src.contains("send_all(announce_port, &packet)"),
            "造出来的招呼包必须真的发出去"
        );
        assert!(
            src.contains("HELLO_INTERVAL_SECS"),
            "招呼包是周期心跳，不是发一次就完"
        );
    }

    /// 招呼间隔与附近表 TTL 必须相称（`HELLO_INTERVAL_SECS` 的注释里承诺了这条）。
    ///
    /// TTL 要是**整数倍**才行：否则会有一段时间「下一份心跳还没来、记录已经被
    /// 剪掉」，邻居在列表里一闪一闪——而这种抖动在界面上看像是「对方网络不稳」，
    /// 极难往回追到两个常量。
    #[test]
    fn test_招呼间隔与附近表_TTL_相称() {
        use crate::sync::presence::{HELLO_INTERVAL_SECS, NEARBY_TTL_MS};
        let interval_ms = HELLO_INTERVAL_SECS as i64 * 1000;
        assert_eq!(
            NEARBY_TTL_MS % interval_ms,
            0,
            "TTL（{}ms）必须是招呼间隔（{}ms）的整数倍",
            NEARBY_TTL_MS,
            interval_ms
        );
        assert!(
            NEARBY_TTL_MS / interval_ms >= 3,
            "TTL 至少要容得下丢 2 份心跳，当前只容得下 {} 份",
            NEARBY_TTL_MS / interval_ms
        );
    }
}
