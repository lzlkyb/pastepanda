//! 事件聚合（G3）后端的用例。
//!
//! 两件事：
//! ① `time_bound` 把 `time_filter` 翻成 SQL 边界——**原先这段 match 在
//!   `get_history` 与 `count_history` 里各写了一遍**，本次加 `range:`
//!   时顺带收口（规则 #11）；
//! ② `history_recent_meta` 给事件下拉拉最近 N 条元信息。

use super::history::{time_bound, TimeBound};
use super::tests::{make_item, make_store};
use super::DataStore;

fn insert_at(store: &DataStore, id: &str, time: &str) {
    let mut it = make_item(id, "正文", time, "text");
    it.source = "Edge".to_string();
    store.insert_history(&it).unwrap();
}

// ============================================================
// time_bound
// ============================================================

#[test]
fn test_time_bound_all_and_unknown_are_none() {
    assert!(matches!(time_bound("all"), TimeBound::None));
    assert!(matches!(time_bound(""), TimeBound::None));
    // 未知值不筛，与原行为一致（原来是 `_ => String::new()`）
    assert!(matches!(time_bound("乱写的"), TimeBound::None));
}

#[test]
fn test_time_bound_since_variants() {
    assert!(matches!(time_bound("today"), TimeBound::Since(_)));
    assert!(matches!(time_bound("week"), TimeBound::Since(_)));
    assert!(matches!(time_bound("month"), TimeBound::Since(_)));
}

#[test]
fn test_time_bound_range() {
    match time_bound("range:2026-09-04 14:31:00~2026-09-04 15:26:59") {
        TimeBound::Between(a, b) => {
            assert_eq!(a, "2026-09-04 14:31:00");
            assert_eq!(b, "2026-09-04 15:26:59");
        }
        other => panic!("应该解成 Between，实得 {:?}", other),
    }
}

#[test]
fn test_time_bound_malformed_range_falls_back_to_none() {
    // 🔴 残缺的 range 退回「不筛」而不是报错或空结果：
    // 它是展示层筛选，值由本项目自己构造（`eventRangeValue`），
    // 真出现残缺就是代码 bug；此时把列表清空比不筛更难排查。
    assert!(matches!(time_bound("range:"), TimeBound::None));
    assert!(matches!(time_bound("range:只有一边"), TimeBound::None));
    assert!(matches!(time_bound("range:~缺起"), TimeBound::None));
    assert!(matches!(time_bound("range:缺止~"), TimeBound::None));
}

// ============================================================
// range: 端到端
// ============================================================
//
// 走 `search_history` 而不是 `get_history`——后者**根本没有 time_filter 参数**
// （它是列表分页加载，只按 workspace/filter/search 取）。
// 事件筛选走的正是搜索路径，与前端 `searchHistory` 对应。

#[test]
fn test_search_history_range_is_inclusive_both_ends() {
    let store = make_store();
    insert_at(&store, "before", "2026-09-04 14:30:59");
    insert_at(&store, "start", "2026-09-04 14:31:00");
    insert_at(&store, "mid", "2026-09-04 15:00:00");
    insert_at(&store, "end", "2026-09-04 15:26:00");
    insert_at(&store, "after", "2026-09-04 15:26:01");

    let rows = store
        .search_history(
            "默认",
            "", // 无关键词——事件筛选就是这个场景
            "all",
            "range:2026-09-04 14:31:00~2026-09-04 15:26:00",
            "",
            "all",
            &[],
            100,
        )
        .unwrap();
    let mut ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    ids.sort_unstable();
    // 起止两端都包含：事件的首尾条目本身就属于这个事件
    assert_eq!(ids, vec!["end", "mid", "start"]);
}

// ============================================================
// history_recent_meta
// ============================================================

#[test]
fn test_history_recent_meta_limit_and_order() {
    let store = make_store();
    insert_at(&store, "a", "2026-09-01 09:00:00");
    insert_at(&store, "b", "2026-09-02 09:00:00");
    insert_at(&store, "c", "2026-09-03 09:00:00");

    // 取最近两条（按时间倒序截），但**返回时升序**——分段要升序
    let rows = store.history_recent_meta(2).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["b", "c"],
        "该取最近的两条（b/c）而不是最早的两条，且升序返回"
    );
}

#[test]
fn test_history_recent_meta_caps_limit() {
    let store = make_store();
    insert_at(&store, "a", "2026-09-01 09:00:00");
    // 上限夹住：下拉只需最近几百条，传个巨数不该把全库拉出来
    assert_eq!(store.history_recent_meta(u32::MAX).unwrap().len(), 1);
}
