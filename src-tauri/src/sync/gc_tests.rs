//! 墓碑回收的行为钉子（W3）。
//!
//! 🔴 这是六项里最危险的一项：删早了的后果是**已删的笔记在对端复活**，
//! 而用户会以为是同步把垃圾又搬回来了。所以下面大多数条钉的是
//! 「什么时候**不能**删」，而不是「能删」。

use crate::data_store::DataStore;

const DAY_MS: i64 = 86_400_000;

fn store() -> DataStore {
    DataStore::new(":memory:").expect("建内存库失败")
}

/// 建一篇再删掉，返回（note_id, 墓碑的 local_ms）。
fn deleted_note(s: &DataStore, title: &str) -> (String, i64) {
    let n = s.note_create(None, title, "正文").unwrap();
    s.note_delete(&n.id).unwrap();
    let (_, _, local_ms) = s
        .note_tombstones_since(0)
        .unwrap()
        .into_iter()
        .find(|(id, _, _)| *id == n.id)
        .expect("删完该有墓碑");
    (n.id, local_ms)
}

fn tombstone_count(s: &DataStore) -> usize {
    s.note_tombstones_since(0).unwrap().len()
}

// ===== 两个条件各自单独拉得住 =====

#[test]
fn test_游标没过就不删() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    // 年龄条件完全满足（cutoff 很大），就看游标
    assert_eq!(s.tombstone_gc(local_ms, i64::MAX).unwrap(), 0);
    assert_eq!(tombstone_count(&s), 1);
}

#[test]
fn test_年龄不够就不删() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    // 游标条件完全满足（min_cursor 很大），就看年龄
    assert_eq!(s.tombstone_gc(i64::MAX, local_ms).unwrap(), 0);
    assert_eq!(tombstone_count(&s), 1);
}

#[test]
fn test_两个条件都满足才删() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    assert_eq!(s.tombstone_gc(local_ms + 1, local_ms + 1).unwrap(), 1);
    assert_eq!(tombstone_count(&s), 0);
}

/// 刻意保守一格：`local_ms == 最小游标` 的那条不删。
#[test]
fn test_正好等于游标时不删() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    assert_eq!(s.tombstone_gc(local_ms, local_ms + 1).unwrap(), 0);
}

// ===== 🔴 取最小游标，不是最大 =====

/// 取最大的后果：那台落后的设备永远收不到删除，笔记在它那边复活。
/// 这条同时盖住「忘记那台落后的设备」是卡死时的逃生口。
#[test]
fn test_只要有一台游标落后就不删_忘记它之后才能删() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    let (fast, slow) = ("a".repeat(64), "b".repeat(64));
    s.device_pair(&fast, "快的", "").unwrap();
    s.device_pair(&slow, "落后的", "").unwrap();
    s.device_advance_cursor(&fast, local_ms + 1).unwrap();
    // slow 的游标还是 0（从未同步过）

    // 年龄条件拉满：把「现在」推到一年后
    let far_future = local_ms + 365 * DAY_MS;
    assert_eq!(
        s.tombstone_purge_expired_at(30, far_future).unwrap(),
        0,
        "有一台设备还没收到这条删除，不能回收（否则笔记会在它那边复活）"
    );

    // 逃生口：忘记它之后它不在 devices 表里，自然不再计入
    assert!(s.device_forget(&slow).unwrap());
    assert_eq!(s.tombstone_purge_expired_at(30, far_future).unwrap(), 1);
}

#[test]
fn test_没配对任何设备时游标条件天然成立() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    // 一台都没配 → 没人要收这条删除，只看年龄
    assert_eq!(
        s.tombstone_purge_expired_at(30, local_ms + 365 * DAY_MS)
            .unwrap(),
        1
    );
}

/// 安全期 <= 0 时一行都不删（同 `note_purge_expired` 的逃生口口径）。
#[test]
fn test_安全期为零时一行都不删() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    assert_eq!(
        s.tombstone_purge_expired_at(0, local_ms + 365 * DAY_MS)
            .unwrap(),
        0
    );
    assert_eq!(tombstone_count(&s), 1);
}

// ===== 🔴 回收不能改变对端看得到的东西 =====

/// 回收只删「所有设备都已收到」的那些，而导出用的是 `local_ms > 游标`——
/// 两者合起来就是：回收后任一对端能拿到的墓碑集合**逐条不变**。
///
/// 这一条不成立就意味着有对端丢了一条删除 → 那边笔记复活。
#[test]
fn test_回收后对端能拿到的墓碑集合不变() {
    let s = store();
    let (_, old_ms) = deleted_note(&s, "早删的");
    let (pending_id, new_ms) = deleted_note(&s, "后删的");
    assert!(new_ms > old_ms, "两条墓碑的 local_ms 该是递增的");

    // 对端的游标卡在两条之间：第一条已收到、第二条还没
    let peer = "c".repeat(64);
    s.device_pair(&peer, "对端", "").unwrap();
    s.device_advance_cursor(&peer, old_ms + 1).unwrap();
    let cursor = s.device_cursor(&peer);

    let before = s.note_tombstones_since(cursor).unwrap();
    let n = s
        .tombstone_purge_expired_at(30, new_ms + 365 * DAY_MS)
        .unwrap();
    let after = s.note_tombstones_since(cursor).unwrap();

    assert_eq!(n, 1, "已送达的那一条该被回收（否则这条测试什么都没验到）");
    assert_eq!(before, after, "回收改变了对端能拿到的墓碑集合");
    assert_eq!(after.len(), 1, "对端还没收到的那一条必须还在");
    assert_eq!(after[0].0, pending_id);
}

/// 回收不能把「脏不脏」的结论改了（方案 A 的脏检查靠它决定要不要拨号）。
#[test]
fn test_回收不影响脏检查() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    let peer = "d".repeat(64);
    s.device_pair(&peer, "对端", "").unwrap();
    s.device_advance_cursor(&peer, local_ms + 1).unwrap();
    let cursor = s.device_cursor(&peer);

    let before = s.has_changes_since(cursor).unwrap();
    s.tombstone_purge_expired_at(30, local_ms + 365 * DAY_MS)
        .unwrap();
    assert_eq!(
        s.has_changes_since(cursor).unwrap(),
        before,
        "回收把脏检查的结果改了"
    );
}

/// 墓碑**不在分桶摘要里**（W2），所以两台机器回收时间不同也不会凭空报分叉。
///
/// ❗ 如果哪天把墓碑加进摘要，这条会 red——那时候得先想清楚：
/// A 已回收、B 还没回收时，那个桶会**永远**对不上。
#[test]
fn test_回收不会让分桶摘要分叉() {
    let s = store();
    let (_, local_ms) = deleted_note(&s, "甲");
    let before = s.sync_bucket_digests().unwrap();
    let n = s
        .tombstone_purge_expired_at(30, local_ms + 365 * DAY_MS)
        .unwrap();
    assert_eq!(n, 1, "这一条的前提是墓碑真的被回收了");
    assert_eq!(
        s.sync_bucket_digests().unwrap(),
        before,
        "回收墓碑改变了分桶摘要 —— 两台机器回收时间不同就会永远报分叉"
    );
}

/// 还原笔记会把墓碑删掉（既有行为）—— 钉住它是因为回收与它同操一张表。
#[test]
fn test_还原笔记会清掉墓碑() {
    let s = store();
    let (id, _) = deleted_note(&s, "甲");
    assert_eq!(tombstone_count(&s), 1);
    s.note_restore_deleted(&id).unwrap();
    assert_eq!(tombstone_count(&s), 0, "还原了却还留着删除意图，对端会把它又删掉");
}
