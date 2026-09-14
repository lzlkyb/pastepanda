//! `sync::digest` 与分桶重对账的行为钉子（W2）。

use super::digest::{self, BUCKETS};
use super::engine::{apply_delta, compute_delta_in, write_delta};
use crate::data_store::DataStore;

fn store() -> DataStore {
    DataStore::new(":memory:").expect("建内存库失败")
}

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pp_w2_{}_{}", tag, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 把 `from` 的增量（`since` 之后 + 这些桶的全部）应到 `to`。
fn push(from: &DataStore, to: &DataStore, since: i64, buckets: &[u32], tag: &str) {
    let dir = tmp_dir(tag);
    let delta = compute_delta_in(from, since, buckets).expect("算增量失败");
    write_delta(from, &delta, &dir).expect("写增量失败");
    apply_delta(to, &dir, since).expect("应用增量失败");
    let _ = std::fs::remove_dir_all(&dir);
}

// ===== 纯函数 =====

#[test]
fn test_桶分布对任意字符都成立() {
    // uuid v4 的首位是 hex，但 vault 导入能带任意 id 进来——不能假设。
    for id in ["0abc", "f123", "中文开头的 id", "-开头", ""] {
        assert!(digest::bucket_of(id) < BUCKETS, "{} 算出了越界的桶", id);
    }
}

#[test]
fn test_递进顺序不同摘要也不同() {
    // 不是缺陷，是契约：FNV 不可交换，所以调用方必须 `ORDER BY id`。
    // 这条钉住它，以免以后有人把那个 ORDER BY 当冗余去掉。
    let a = digest::absorb(digest::absorb(digest::empty_bucket(), "x", 1), "y", 2);
    let b = digest::absorb(digest::absorb(digest::empty_bucket(), "y", 2), "x", 1);
    assert_ne!(a, b);
}

#[test]
fn test_拼接歧义不碰撞() {
    // 不加分隔符的话 ("ab", n) 与 ("a", m) 这类字节流会重叠。
    let x = digest::absorb(digest::empty_bucket(), "ab", 0);
    let y = digest::absorb(digest::empty_bucket(), "a", 0x62);
    assert_ne!(x, y);
}

#[test]
fn test_桶数对不上时当全部分叉() {
    // 按短的那个比会把尾部桶隐形跳过 —— 那是静默的不收敛。
    assert_eq!(digest::diverged(&[1, 2, 3], &[1, 2]), vec![0, 1, 2]);
}

// ===== 🔴 Rust 与 SQL 的分桶口径必须逐行一致 =====

/// 两处算得不一样不会报错：摘要按一种口径分桶、重发按另一种口径筛，
/// 于是分叉的桶永远补不齐，而每个心跳会话都重发一遍。
#[test]
fn test_sql分桶与_rust分桶一致() {
    let s = store();
    let mut ids = Vec::new();
    for i in 0..40 {
        ids.push(s.note_create(None, &format!("篇 {}", i), "正文").unwrap().id);
    }
    // 再塞几个非 uuid 形状的 id（vault 导入能带这种进来）
    for id in ["zzz-不是-uuid", "中文开头", "-dash"] {
        ids.push(s.note_create_keeping_id(id, "异形 id", "正文").unwrap().id);
    }

    // ❗ 不另走一条自己拼的 SQL，而是直接问**生产路径**：
    //   `note_changed_since_or_buckets(i64::MAX, &[k])` 里 `updated_ms > MAX`
    //   对所有行都不成立，于是只剩分桶条件在起作用。
    //   这比单独验一个表达式强：错在拼句子那一步也能抓到。
    let mut seen = 0usize;
    for k in 0..BUCKETS {
        let got = s
            .note_changed_since_or_buckets(i64::MAX, &[k])
            .expect("按桶查失败");
        for n in &got {
            assert_eq!(
                digest::bucket_of(&n.id),
                k,
                "SQL 把 id {} 归到了桶 {}，而 Rust 说是 {}",
                n.id,
                k,
                digest::bucket_of(&n.id)
            );
        }
        seen += got.len();
    }
    assert_eq!(
        seen,
        ids.len(),
        "按桶遍一遍没能盖全部笔记（有 id 落到了 0..BUCKETS 之外）"
    );
}

// ===== 摘要本身 =====

#[test]
fn test内容一样时没有桶分叉() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "正文").unwrap();
    push(&a, &b, 0, &[], "same");
    assert!(b.note_get(&n.id).unwrap().is_some());

    let (da, db) = (
        a.sync_bucket_digests().unwrap(),
        b.sync_bucket_digests().unwrap(),
    );
    assert_eq!(da.len(), BUCKETS as usize);
    assert!(
        digest::diverged(&da, &db).is_empty(),
        "同步完之后还报分叉：{:?} vs {:?}",
        da,
        db
    );
}

#[test]
fn test_只有改过的那个桶报分叉() {
    let (a, b) = (store(), store());
    for i in 0..30 {
        a.note_create(None, &format!("篇 {}", i), "正文").unwrap();
    }
    push(&a, &b, 0, &[], "one");
    assert!(digest::diverged(
        &a.sync_bucket_digests().unwrap(),
        &b.sync_bucket_digests().unwrap()
    )
    .is_empty());

    // 只在 A 这边改一篇
    let victim = a.note_changed_since(0).unwrap().remove(0);
    a.note_update(&victim.id, "甲改过", "新正文").unwrap();

    let diverged = digest::diverged(
        &a.sync_bucket_digests().unwrap(),
        &b.sync_bucket_digests().unwrap(),
    );
    assert_eq!(
        diverged,
        vec![digest::bucket_of(&victim.id)],
        "改一篇只应让它所在的那一个桶分叉"
    );
}

// ===== 🔴 W2 的存在理由：游标已推过的分叉能自愈 =====

/// 造一个「两边内容不同、而游标都已经推过去」的局面：
/// 普通增量（只看 `updated_ms > since`）什么都搛不到，分桶重对账能修好。
///
/// 这正是现有设计的窗口：能保证「正常路径收敛」，不能保证「异常之后收敛」。
#[test]
fn test_游标已推过的分叉普通增量修不了而重对账能修() {
    let (a, b) = (store(), store());
    let n = a.note_create(None, "甲", "A 的版本").unwrap();
    // 摘要只折 (id, updated_ms)，**不含正文**。两边若落在同一毫秒，
    // 内容不同也会摘要相同——CI（Linux）写入极快时会稳定复现。
    // 隔开 2ms，让分叉在摘要里可见。
    std::thread::sleep(std::time::Duration::from_millis(2));
    // B 拿同一个 id 建一篇不同内容的——就是分叉的形状
    b.note_create_keeping_id(&n.id, "甲", "B 的版本").unwrap();

    // 把游标推到两边所有戳之后（就是会话正常走完后的样子）
    let since = a
        .sync_high_water_ms()
        .max(b.sync_high_water_ms())
        .max(a.note_updated_ms(&n.id).unwrap())
        .max(b.note_updated_ms(&n.id).unwrap());

    // ① 普通增量：两边都算不出任何东西
    assert!(
        compute_delta_in(&a, since, &[]).unwrap().is_empty(),
        "普通增量不应该能看见这条分叉（那就不需要 W2 了）"
    );
    let diverged = digest::diverged(
        &a.sync_bucket_digests().unwrap(),
        &b.sync_bucket_digests().unwrap(),
    );
    // ② 但摘要能看见
    assert_eq!(diverged, vec![digest::bucket_of(&n.id)], "摘要没发现分叉");

    // ③ 把那个桶双向整桶重发一次（就是一次带摘要的会话做的事）
    push(&a, &b, since, &diverged, "heal_ab");
    push(&b, &a, since, &diverged, "heal_ba");

    assert!(
        digest::diverged(
            &a.sync_bucket_digests().unwrap(),
            &b.sync_bucket_digests().unwrap()
        )
        .is_empty(),
        "重对账之后两边还是分叉的"
    );
    // 后写胜：两边最终是同一份内容
    assert_eq!(
        a.note_get(&n.id).unwrap().unwrap().content,
        b.note_get(&n.id).unwrap().unwrap().content
    );
}

/// 🔴 重对账**不能**生冲突副本。
///
/// 它把 `updated_ms <= 游标` 的旧笔记又送一遍，而冲突判据是
/// `local > 游标 && incoming > 游标`——两边都不成立，所以应该走「内容相同就跳过」。
/// 这一条是 W2 能用的前提：不成立的话每次重对账都会生一批冲突副本。
#[test]
fn test_整桶重发不生冲突副本() {
    let (a, b) = (store(), store());
    for i in 0..20 {
        a.note_create(None, &format!("篇 {}", i), "正文").unwrap();
    }
    push(&a, &b, 0, &[], "pre");
    let since = a.sync_high_water_ms().max(b.sync_high_water_ms());

    // 把所有桶都当成分叉（最坏情况：全量重对账）
    let all: Vec<u32> = (0..BUCKETS).collect();
    let dir = tmp_dir("nodup");
    let delta = compute_delta_in(&a, since, &all).unwrap();
    assert_eq!(delta.notes.len(), 20, "整桶重发该把 20 篇都拉出来");
    write_delta(&a, &delta, &dir).unwrap();
    let rep = apply_delta(&b, &dir, since).unwrap();
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(rep.conflicts, 0, "重对账生了冲突副本");
    assert_eq!(rep.identical, 20, "内容完全相同，该全部计入回声拦截");
    assert_eq!(rep.created + rep.updated, 0, "重对账不应再写库");
}

/// 桶里拉回来的旧行不能抬高也不能拉低游标。
#[test]
fn test_整桶重发不动游标() {
    let a = store();
    a.note_create(None, "甲", "正文").unwrap();
    let since = a.sync_high_water_ms();
    let all: Vec<u32> = (0..BUCKETS).collect();
    let d = compute_delta_in(&a, since, &all).unwrap();
    assert!(!d.notes.is_empty(), "桶里该有东西");
    assert_eq!(d.cursor_ms, since, "重发旧行把游标改了");
}

// ===== 🔴 能力位：旧版对端不会把会话挂死 =====

/// 旧版的 hello 里没有新字段，必须反序列化成 `false`。
///
/// 它为 `true` 的后果不是功能失效，而是**挂死**：本机写出一个旧版永远
/// 不会读的摘要帧，然后自己卡在读一个永远不来的帧上。
#[test]
fn test_旧版hello的能力位默认为否() {
    let old = r#"{"v":1,"cursor_ms":5,"high_water_ms":9}"#;
    let h = super::session::hello_from_json_for_test(old).expect("旧版 hello 应该能解开");
    assert!(!h.0, "digest_capable 必须默认为 false，否则与旧版对端会挂死");
    assert!(!h.1, "want_digest 必须默认为 false");
}
