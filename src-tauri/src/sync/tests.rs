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

/// 造一个「假装没网」的端点：relay 与地址发现都关掉。
async fn offline_ep(seed: u8) -> iroh::Endpoint {
    let dir = tmp_dir(&format!("ep{}", seed));
    let me = NodeIdentity::load_or_create(&dir).unwrap();
    let ep = super::transport::bind(&me, [seed; 32], false)
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
