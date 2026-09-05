//! 每日整理（H3）后端查询的用例。
//!
//! 只有一个函数 [`DataStore::history_day_meta`]，但它有两条必须钉住的约束：
//! ① **只查五列**——不碰 `text` 与 `content`（图片的 `content` 是 base64，
//!   一天几百条拉出来就是几十 MB）；这同时也是隐私约束：行为层零内容。
//! ② **按 `time` 列过滤**——规划原文写的是 `created_at`，而 `history` 根本没那一列。

use super::tests::{make_item, make_store};
use super::DataStore;

/// 造一条指定时间与来源的历史。
fn insert_at(store: &DataStore, id: &str, time: &str, source: &str, item_type: &str) {
    let mut it = make_item(id, "正文内容", time, item_type);
    it.source = source.to_string();
    store.insert_history(&it).unwrap();
}

#[test]
fn test_history_day_meta_only_that_day() {
    let store = make_store();
    insert_at(&store, "a", "2026-09-04 09:00:00", "Edge", "text");
    insert_at(&store, "b", "2026-09-04 23:59:59", "Edge", "text");
    insert_at(&store, "c", "2026-09-03 23:59:59", "Edge", "text");
    insert_at(&store, "d", "2026-09-05 00:00:00", "Edge", "text");

    let rows = store.history_day_meta("2026-09-04").unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["a", "b"], "只要当天，且含头含尾两个边界");
}

#[test]
fn test_history_day_meta_sorted_ascending() {
    let store = make_store();
    insert_at(&store, "late", "2026-09-04 17:00:00", "Edge", "text");
    insert_at(&store, "early", "2026-09-04 09:00:00", "Edge", "text");

    let rows = store.history_day_meta("2026-09-04").unwrap();
    // 升序返回：分段本来就要升序，在 SQL 里排比前端再排一遍便宜。
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["early", "late"]
    );
}

#[test]
fn test_history_day_meta_carries_five_columns() {
    let store = make_store();
    let mut it = make_item("x", "正文", "2026-09-04 09:00:00", "image");
    it.source = "a.java - Eclipse IDE".to_string();
    it.content_type = Some("markdown".to_string());
    store.insert_history(&it).unwrap();

    let r = &store.history_day_meta("2026-09-04").unwrap()[0];
    assert_eq!(r.id, "x");
    assert_eq!(r.time, "2026-09-04 09:00:00");
    assert_eq!(r.source, "a.java - Eclipse IDE", "原始窗口标题原样返回");
    assert_eq!(r.item_type, "image");
    assert_eq!(r.content_type.as_deref(), Some("markdown"));
}

#[test]
fn test_history_day_meta_source_kept_raw_not_normalized() {
    // 🔴 归一化在**前端**做（`cleanSourceName`）。
    // 后端再做一套就是两套规则，而映射表只存在于前端。
    let store = make_store();
    insert_at(&store, "x", "2026-09-04 09:00:00", "某文档 - 记事本", "text");
    assert_eq!(store.history_day_meta("2026-09-04").unwrap()[0].source, "某文档 - 记事本");
}

#[test]
fn test_history_day_meta_empty_day() {
    let store = make_store();
    insert_at(&store, "a", "2026-09-04 09:00:00", "Edge", "text");
    assert!(store.history_day_meta("2026-01-01").unwrap().is_empty());
}

#[test]
fn test_history_day_meta_rejects_bad_date() {
    // 日期直接拼进 LIKE 模式，必须先校形式。
    // 不校的话传 `%` 进来就能把整库拉出来（参数绑定防不了 LIKE 通配符）。
    let store = make_store();
    insert_at(&store, "a", "2026-09-04 09:00:00", "Edge", "text");
    assert!(store.history_day_meta("%").is_err());
    assert!(store.history_day_meta("2026-9-4").is_err(), "位数不对也拒");
    assert!(store.history_day_meta("").is_err());
}
