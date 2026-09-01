//! 字段视图（B2 #9）的用例。
//!
//! 钉的全是**错了不报错**的地方——这些 SQL 写反了只会让结果静默变错：
//!
//! - `last_access_at IS NULL` 那一段：忘了它，从未打开过的笔记会排到**最前**；
//! - 「无摘要」的两个条件：只写一个会漏一半（NULL 与空串各一半）；
//! - 标签分组的 LEFT JOIN：写 INNER 会让无标签的笔记**整批消失**；
//! - `COUNT(DISTINCT id)`：写 `COUNT(*)` 会让面包屑的总数在标签分组下被抬高；
//! - 默认 opts：一旦不等于旧行为，就是静默改了所有人的列表。

use super::tests::{make_item, make_store};
use super::*;

fn view(sort: &str, group: &str) -> NoteViewOpts {
    NoteViewOpts {
        sort: sort.to_string(),
        group_by: group.to_string(),
        ..Default::default()
    }
}

/// 默认 opts 必须与旧 `note_list` 一字不差。这是整个 #9 的向后兼容底线。
#[test]
fn test_view_default_equals_legacy_list() {
    let store = make_store();
    for (i, t) in ["a", "b", "c"].iter().enumerate() {
        store.note_create(None, t, &format!("正文{}", i)).unwrap();
    }
    let legacy = store.note_list("all", &[], 10, 0).unwrap();
    let viewed = store
        .note_list_view("all", &[], &NoteViewOpts::default(), 10, 0)
        .unwrap();
    assert_eq!(
        legacy.iter().map(|n| &n.id).collect::<Vec<_>>(),
        viewed.iter().map(|n| &n.id).collect::<Vec<_>>(),
        "默认视图的顺序必须与旧行为一致"
    );
    // 不分组时组键必须是 None（前端靠它判要不要插组头）
    assert!(viewed.iter().all(|n| n.group_key.is_none()));
    assert!(store
        .note_group_counts("all", &[], &NoteViewOpts::default())
        .unwrap()
        .is_empty());
}

/// 「最近打开」：**从未打开过的排最后**，而不是排最前。
#[test]
fn test_view_sort_accessed_puts_never_opened_last() {
    let store = make_store();
    let a = store.note_create(None, "打开过的", "x").unwrap();
    let _b = store.note_create(None, "没打开过的", "y").unwrap();
    store.note_touch(&a.id);

    let rows = store.note_list_view("all", &[], &view("accessed", ""), 10, 0).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, a.id, "打开过的应该在最前");
    assert_eq!(rows[1].title, "没打开过的", "从未打开过的（NULL）必须排最后");
}

/// 「无摘要」要同时盖住 NULL 与空串两类。
#[test]
fn test_view_filter_summary_covers_null_and_empty() {
    let store = make_store();
    let has = store.note_create(None, "有摘要", "x").unwrap();
    let empty = store.note_create(None, "摘要是空串", "y").unwrap();
    let _never = store.note_create(None, "从未生成过", "z").unwrap();
    store.note_set_summary(&has.id, Some("一句摘要")).unwrap();
    // 空串而不是 None：这正是「生成过但用户清掉了」那一类，
    // 也是今日速记插入时写的值——只写 `IS NULL` 会把它漏掉。
    store.note_set_summary(&empty.id, Some("")).unwrap();

    let mut yes = view("", "");
    yes.summary = "yes".to_string();
    let rows = store.note_list_view("all", &[], &yes, 10, 0).unwrap();
    assert_eq!(rows.len(), 1, "只有真写了摘要的那条算有摘要");
    assert_eq!(rows[0].id, has.id);

    let mut no = view("", "");
    no.summary = "no".to_string();
    let rows = store.note_list_view("all", &[], &no, 10, 0).unwrap();
    assert_eq!(rows.len(), 2, "空串与 NULL 两类都算无摘要");
}

/// 标签分组：多标签的笔记出现在多个组；无标签的归入「无标签」而**不会消失**。
#[test]
fn test_view_group_by_tag_keeps_untagged() {
    let store = make_store();
    let t1 = store.create_tag("工作", "#111").unwrap();
    let t2 = store.create_tag("阅读", "#222").unwrap();
    let both = store.note_create(None, "两个标签", "x").unwrap();
    let _bare = store.note_create(None, "没标签", "y").unwrap();
    store
        .note_set_tags(&both.id, &[t1.id.clone(), t2.id.clone()])
        .unwrap();

    let rows = store.note_list_view("all", &[], &view("", "tag"), 20, 0).unwrap();
    let keys: Vec<String> = rows
        .iter()
        .map(|n| n.group_key.clone().unwrap_or_default())
        .collect();
    assert!(keys.contains(&"工作".to_string()));
    assert!(keys.contains(&"阅读".to_string()));
    assert!(
        keys.contains(&"无标签".to_string()),
        "LEFT JOIN 必须把无标签的笔记留下来（写 INNER 就会整批消失）"
    );
    // 同一条笔记在两个组里各出现一次 → 行数 3（两标签 + 一条无标签）
    assert_eq!(rows.len(), 3, "多标签的笔记会展成多行");

    // 面包屑的总数说的是「多少条笔记」不是「多少行」
    let total = store
        .note_count_filtered_view("all", &[], &view("", "tag"))
        .unwrap();
    assert_eq!(total, 2, "COUNT(DISTINCT id)：不能被 JOIN 抬成 3");
}

/// 组头条数必须与列表同口径（两边共用 `note_view_from_where`）。
#[test]
fn test_view_group_counts_match_list() {
    let store = make_store();
    let f = store.folder_create("工作", None).unwrap();
    for i in 0..3 {
        let n = store.note_create(None, &format!("在文件夹{}", i), "x").unwrap();
        store.note_set_folder(&n.id, Some(&f.id)).unwrap();
    }
    store.note_create(None, "未分类的", "y").unwrap();

    let counts = store.note_group_counts("all", &[], &view("", "folder")).unwrap();
    let map: std::collections::HashMap<String, i64> =
        counts.into_iter().map(|c| (c.key, c.count)).collect();
    assert_eq!(map.get("工作"), Some(&3));
    assert_eq!(map.get("未分类"), Some(&1), "folder_id 为 NULL 的组名要是「未分类」");
}

/// 待沉淀区：类型多选是**并集**；默认 opts 与旧行为一致。
#[test]
fn test_inbox_view_types_are_union() {
    let store = make_store();
    // search_hit_count >= 2 才进待沉淀（CANDIDATE_WHERE），所以先造信号
    for (id, ct) in [("c1", "code"), ("c2", "link"), ("c3", "text")] {
        let mut it = make_item(id, &format!("内容 {}", id), "2024-01-01 10:00:00", "text");
        it.content_type = Some(ct.to_string());
        store.insert_history(&it).unwrap();
        store
            .lock_conn()
            .execute(
                "UPDATE history SET search_hit_count = 5 WHERE id = ?1",
                [id],
            )
            .unwrap();
    }

    let all = store
        .kb_inbox_list_view("默认", &InboxViewOpts::default(), 50, 0)
        .unwrap();
    assert_eq!(all.len(), 3);
    let legacy = store.kb_inbox_list("默认", 50, 0).unwrap();
    assert_eq!(legacy.len(), 3, "默认 opts 与旧行为一致");

    let opts = InboxViewOpts {
        types: vec!["code".to_string(), "link".to_string()],
        ..Default::default()
    };
    let picked = store.kb_inbox_list_view("默认", &opts, 50, 0).unwrap();
    assert_eq!(picked.len(), 2, "选两个类型 = 这两类都要（并集）");
    assert_eq!(
        store.kb_inbox_count_view("默认", &opts).unwrap(),
        2,
        "横幅计数要跟筛选走，不能还报 3"
    );
}
