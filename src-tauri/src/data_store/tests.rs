use super::*;

/// 创建内存数据库的 DataStore（每个测试独立隔离）
// pub(super)：tests_view.rs（字段视图的用例）是兄弟模块，得用同一对辅助函数。
// 另写一份的后果是两边造的测试数据不一致，而差异很难被发现（规则 #11）。
pub(super) fn make_store() -> DataStore {
    DataStore::new(":memory:").expect("无法创建内存数据库")
}

/// 创建一条测试用的 HistoryItem
pub(super) fn make_item(id: &str, text: &str, time: &str, item_type: &str) -> HistoryItem {
    let md5_hash = format!("{:x}", Md5::new().chain_update(text.as_bytes()).finalize());
    let pinyin_initials = compute_pinyin_initials(text);
    HistoryItem {
        id: id.to_string(),
        text: text.to_string(),
        time: time.to_string(),
        item_type: item_type.to_string(),
        content: String::new(),
        pinned: false,
        source: "clipboard".to_string(),
        workspace: "默认".to_string(),
        md5: Some(md5_hash),
        pinyin_initials: Some(pinyin_initials),
        group_id: None,
        source_icon: None,
        content_type: None,
        ocr_text: None,
        tags: Vec::new(),
    }
}

// ============================================================
// DataStore::new() 测试
// ============================================================

#[test]
fn test_new_memory_db() {
    let store = make_store();
    let config = store.get_config().unwrap();
    assert!(config.is_object());
}

#[test]
fn test_new_file_db() {
    let dir = std::env::temp_dir().join("pastepanda_test_new_file");
    let _ = std::fs::create_dir_all(&dir);
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();
    // 先清理
    let _ = std::fs::remove_file(path_str);
    let store = DataStore::new(path_str).expect("创建文件数据库失败");
    let config = store.get_config().unwrap();
    assert!(config.is_object());
    // 验证 db 文件存在
    assert!(db_path.exists());
    // 清理
    drop(store);
    let _ = std::fs::remove_file(path_str);
    let _ = std::fs::remove_dir_all(&dir);
}

// ============================================================
// insert_history + get_history 测试
// ============================================================

#[test]
fn test_insert_and_get_history() {
    let store = make_store();
    let item = make_item("test-1", "Hello World", "2024-01-01 10:00:00", "text");
    store.insert_history(&item).unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "test-1");
    assert_eq!(result[0].text, "Hello World");
}

#[test]
fn test_insert_multiple_items() {
    let store = make_store();
    for i in 1..=5 {
        let item = make_item(
            &format!("test-{}", i),
            &format!("Item {}", i),
            &format!("2024-01-01 10:00:0{}", i),
            "text",
        );
        store.insert_history(&item).unwrap();
    }
    let result = store.get_history("默认", "all", "", 0, 50).unwrap();
    assert_eq!(result.len(), 5);
}

#[test]
fn test_insert_or_replace() {
    let store = make_store();
    let item1 = make_item("dup-id", "Original", "2024-01-01 10:00:00", "text");
    store.insert_history(&item1).unwrap();

    let item2 = make_item("dup-id", "Updated", "2024-01-01 11:00:00", "text");
    store.insert_history(&item2).unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].text, "Updated");
}

// ============================================================
// get_history 分页、过滤、搜索测试
// ============================================================

#[test]
fn test_get_history_pagination() {
    let store = make_store();
    for i in 1..=10 {
        let item = make_item(
            &format!("page-{}", i),
            &format!("Item {}", i),
            &format!("2024-01-01 10:00:{:02}", i),
            "text",
        );
        store.insert_history(&item).unwrap();
    }
    // 取前 3 条
    let page1 = store.get_history("默认", "all", "", 0, 3).unwrap();
    assert_eq!(page1.len(), 3);
    // 取第 4-6 条
    let page2 = store.get_history("默认", "all", "", 3, 3).unwrap();
    assert_eq!(page2.len(), 3);
    assert_ne!(page1[0].id, page2[0].id);
}

#[test]
fn test_get_history_filter_pinned() {
    let store = make_store();
    let mut pinned = make_item("pin-1", "Pinned", "2024-01-01 10:00:00", "text");
    pinned.pinned = true;
    store.insert_history(&pinned).unwrap();

    let normal = make_item("norm-1", "Normal", "2024-01-01 09:00:00", "text");
    store.insert_history(&normal).unwrap();

    let result = store.get_history("默认", "pinned", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "pin-1");
}

#[test]
fn test_get_history_filter_type() {
    let store = make_store();
    store
        .insert_history(&make_item("t1", "Text", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("i1", "Image", "2024-01-01 10:00:00", "image"))
        .unwrap();
    store
        .insert_history(&make_item("f1", "File", "2024-01-01 10:00:00", "file"))
        .unwrap();

    let text_items = store.get_history("默认", "text", "", 0, 10).unwrap();
    assert_eq!(text_items.len(), 1);
    assert_eq!(text_items[0].item_type, "text");

    let image_items = store.get_history("默认", "image", "", 0, 10).unwrap();
    assert_eq!(image_items.len(), 1);
    assert_eq!(image_items[0].item_type, "image");
}

#[test]
fn test_image_filter_includes_rich() {
    // 图文混排归入「图片」筛选（两者都是带图内容，不单独占顶部标签页）。
    // 这个口径现在散在 5 处查询里（get_history / search_history / 两个计数 /
    // 深度清理条件），靠这条测试盯住主路径不跑偏。
    let store = make_store();
    store
        .insert_history(&make_item("t1", "纯文本", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("i1", "[图片] 10x10", "2024-01-01 11:00:00", "image"))
        .unwrap();
    store
        .insert_history(&make_item("r1", "图文内容", "2024-01-01 12:00:00", "rich"))
        .unwrap();

    // 「图片」应同时筛出 image 与 rich
    let images = store.get_history("默认", "image", "", 0, 10).unwrap();
    assert_eq!(images.len(), 2, "图片筛选应包含图文混排");
    assert!(images.iter().any(|i| i.item_type == "image"));
    assert!(images.iter().any(|i| i.item_type == "rich"));

    // 「文本」不应被污染
    let texts = store.get_history("默认", "text", "", 0, 10).unwrap();
    assert_eq!(texts.len(), 1);
    assert_eq!(texts[0].item_type, "text");

    // 标签页上的计数必须与筛选结果一致，否则数字与列表对不上
    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.image_count, 2, "计数口径应与筛选一致");
}

#[test]
fn test_get_history_search() {
    let store = make_store();
    store
        .insert_history(&make_item("s1", "Hello World", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("s2", "Goodbye", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("s3", "Rust Programming", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let result = store.get_history("默认", "all", "Hello", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].text, "Hello World");

    let result2 = store.get_history("默认", "all", "xyz", 0, 10).unwrap();
    assert_eq!(result2.len(), 0);
}

#[test]
fn test_get_history_workspace_isolation() {
    let store = make_store();
    let mut item1 = make_item("ws1", "Default WS", "2024-01-01 10:00:00", "text");
    item1.workspace = "默认".to_string();
    store.insert_history(&item1).unwrap();

    let mut item2 = make_item("ws2", "Other WS", "2024-01-01 10:00:00", "text");
    item2.workspace = "其他".to_string();
    store.insert_history(&item2).unwrap();

    let default_result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(default_result.len(), 1);
    assert_eq!(default_result[0].id, "ws1");

    let other_result = store.get_history("其他", "all", "", 0, 10).unwrap();
    assert_eq!(other_result.len(), 1);
    assert_eq!(other_result[0].id, "ws2");
}

#[test]
fn test_get_history_limit_cap() {
    let store = make_store();
    for i in 1..=10 {
        store
            .insert_history(&make_item(
                &format!("cap-{}", i),
                &format!("Item {}", i),
                &format!("2024-01-01 10:00:{:02}", i),
                "text",
            ))
            .unwrap();
    }
    // limit 被限制在 500，实际数据只有 10 条
    let result = store.get_history("默认", "all", "", 0, 1000).unwrap();
    assert_eq!(result.len(), 10);
}

// ============================================================
// get_recent_items 测试
// ============================================================

#[test]
fn test_get_recent_items() {
    let store = make_store();
    for i in 1..=5 {
        store
            .insert_history(&make_item(
                &format!("rec-{}", i),
                &format!("Recent {}", i),
                &format!("2024-01-01 10:00:{:02}", i),
                "text",
            ))
            .unwrap();
    }
    let result = store.get_recent_items(3).unwrap();
    assert_eq!(result.len(), 3);
    // 应该是最新的在前
    assert_eq!(result[0].id, "rec-5");
}

#[test]
fn test_get_recent_items_empty() {
    let store = make_store();
    let result = store.get_recent_items(5).unwrap();
    assert!(result.is_empty());
}

// ============================================================
// update_history 测试
// ============================================================

#[test]
fn test_update_history() {
    let store = make_store();
    store
        .insert_history(&make_item("upd-1", "Original", "2024-01-01 10:00:00", "text"))
        .unwrap();

    store.update_history("upd-1", "Modified").unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].text, "Modified");
    // md5 和 pinyin_initials 应该也更新了
    assert_ne!(result[0].md5, None);
    assert_ne!(result[0].pinyin_initials, None);
}

#[test]
fn test_update_history_not_found() {
    let store = make_store();
    let err = store
        .update_history("nonexistent", "text")
        .unwrap_err();
    assert!(err.contains("不存在"));
}

// ============================================================
// find_latest_by_md5 测试
// ============================================================

#[test]
fn test_find_latest_by_md5_found() {
    let store = make_store();
    let item = make_item("md5-1", "Duplicate Content", "2024-01-01 10:00:00", "text");
    let md5 = item.md5.clone().unwrap();
    store.insert_history(&item).unwrap();

    let found = store.find_latest_by_md5(&md5, "默认", "text").unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().id, "md5-1");
}

#[test]
fn test_find_latest_by_md5_not_found() {
    let store = make_store();
    let found = store.find_latest_by_md5("nonexistent_md5", "默认", "text").unwrap();
    assert!(found.is_none());
}

/// 回归：rich/doc 类型记录必须能被对应类型查到（此前 SQL 硬编码 type='text'，
/// 导致图文/文档的智能合并永远不命中、反复复制反复入库）。
#[test]
fn test_find_latest_by_md5_by_type() {
    let store = make_store();
    let rich = make_item("rich-1", "图文内容", "2024-01-01 10:00:00", "rich");
    let md5 = rich.md5.clone().unwrap();
    store.insert_history(&rich).unwrap();

    // 用 rich 类型能找到
    let found = store.find_latest_by_md5(&md5, "默认", "rich").unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().item_type, "rich");

    // 用 text 类型查不到（类型隔离，不能误合并到文本记录）
    let found_text = store.find_latest_by_md5(&md5, "默认", "text").unwrap();
    assert!(found_text.is_none());
}

#[test]
fn test_find_latest_by_md5_returns_latest() {
    let store = make_store();
    let text = "Same Content";
    let md5_hash = format!("{:x}", Md5::new().chain_update(text.as_bytes()).finalize());

    let mut item1 = make_item("dup-1", text, "2024-01-01 10:00:00", "text");
    item1.md5 = Some(md5_hash.clone());
    store.insert_history(&item1).unwrap();

    let mut item2 = make_item("dup-2", text, "2024-01-01 11:00:00", "text");
    item2.md5 = Some(md5_hash.clone());
    store.insert_history(&item2).unwrap();

    let found = store
        .find_latest_by_md5(&md5_hash, "默认", "text")
        .unwrap()
        .unwrap();
    assert_eq!(found.id, "dup-2"); // 应该返回时间更新的那条
}

#[test]
fn test_find_latest_by_md5_workspace_isolated() {
    let store = make_store();
    let mut item = make_item("ws-1", "Cross WS Content", "2024-01-01 10:00:00", "text");
    let md5 = item.md5.clone().unwrap();
    item.workspace = "其他工作区".to_string();
    store.insert_history(&item).unwrap();

    // 不同 workspace 下不应命中
    let found = store.find_latest_by_md5(&md5, "默认", "text").unwrap();
    assert!(found.is_none());
    // 相同 workspace 下应命中
    let found = store.find_latest_by_md5(&md5, "其他工作区", "text").unwrap();
    assert!(found.is_some());
}

// ============================================================
// update_history_time 测试
// ============================================================

#[test]
fn test_update_history_time() {
    let store = make_store();
    store
        .insert_history(&make_item("time-1", "Content", "2024-01-01 10:00:00", "text"))
        .unwrap();

    store
        .update_history_time("time-1", "2024-06-01 12:00:00", TimeBump::ResaveOnly)
        .unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].time, "2024-06-01 12:00:00");
}

/// `TimeBump` 的两个分支必须真的不同（B2 前置）。
///
/// 钉这条的理由：`update_history_time` 有 10 个调用点，其中两个是编辑器 Ctrl+S。
/// 若哪天有人把分支判断抹了、改成无条件 +1，「重复复制」信号会被按保存次数污染得彻底不可用，
/// 而这种污染**不会报任何错**。
#[test]
fn test_update_history_time_recopy_count() {
    let store = make_store();
    store
        .insert_history(&make_item("rc-1", "Content", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let count = || -> i64 {
        store
            .lock_conn()
            .query_row(
                "SELECT recopy_count FROM history WHERE id = 'rc-1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };

    assert_eq!(count(), 0, "刚入库应为 0");

    // 编辑器重复保存两次：时间变了，但不算重复复制
    store
        .update_history_time("rc-1", "2024-01-02 10:00:00", TimeBump::ResaveOnly)
        .unwrap();
    store
        .update_history_time("rc-1", "2024-01-03 10:00:00", TimeBump::ResaveOnly)
        .unwrap();
    assert_eq!(count(), 0, "ResaveOnly 不能计数");

    // 真的被重复采集三次
    for d in 4..7 {
        store
            .update_history_time("rc-1", &format!("2024-01-0{} 10:00:00", d), TimeBump::Recapture)
            .unwrap();
    }
    assert_eq!(count(), 3, "Recapture 每次 +1");
}

/// 搜索命中要同时写 `search_hit_count` 与 `search_hit_at`（B2 前置）。
///
/// 钉这条是因为 `bump_search_hits` 里参数占位符从 `?2` 开始（`?1` 给时间）——
/// 这种差一位的绑定错误不会报错，只会安静地一条都更新不到。
#[test]
fn test_search_hit_records_time() {
    let store = make_store();
    store
        .insert_history(&make_item("sh-1", "Rust 的 Pin", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let hits = store.get_history("默认", "all", "Pin", 0, 10).unwrap();
    assert_eq!(hits.len(), 1, "该搜得到");

    let (n, at): (i64, Option<String>) = store
        .lock_conn()
        .query_row(
            "SELECT search_hit_count, search_hit_at FROM history WHERE id = 'sh-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(n, 1, "命中次数 +1");
    assert!(at.is_some(), "命中时间必须写上");
}

/// `note_touch` 只能改 `last_access_at`，**不能碰 `updated_at`**（B2 前置）。
///
/// 钉这条的理由：笔记列表按 `updated_at` 降序。若 touch 沾上了 `updated_at`，
/// 随便点开一条旧笔记就会把它顶到最前，看起来像「自己乱跳」而不像 bug。
#[test]
fn test_note_touch_does_not_bump_updated_at() {
    let store = make_store();
    let note = store.note_create(None, "旧笔记", "很久没看了").unwrap();

    store.note_touch(&note.id);

    let (updated, access): (String, Option<String>) = store
        .lock_conn()
        .query_row(
            "SELECT updated_at, last_access_at FROM notes WHERE id = ?1",
            [&note.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();

    assert_eq!(updated, note.updated_at, "updated_at 不能被改");
    assert!(access.is_some(), "last_access_at 必须写上");
}

// ============================================================
// delete_history 测试
// ============================================================

#[test]
fn test_delete_single_history() {
    let store = make_store();
    store
        .insert_history(&make_item("del-1", "To Delete", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("keep-1", "Keep", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let count = store
        .delete_history(&["del-1".to_string()])
        .unwrap();
    assert_eq!(count, 1);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "keep-1");
}

#[test]
fn test_delete_multiple_history() {
    let store = make_store();
    for i in 1..=5 {
        store
            .insert_history(&make_item(
                &format!("del-{}", i),
                &format!("Item {}", i),
                "2024-01-01 10:00:00",
                "text",
            ))
            .unwrap();
    }
    let ids: Vec<String> = (1..=3).map(|i| format!("del-{}", i)).collect();
    let count = store.delete_history(&ids).unwrap();
    assert_eq!(count, 3);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 2);
}

#[test]
fn test_delete_history_empty_list() {
    let store = make_store();
    let count = store.delete_history(&[]).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_delete_nonexistent() {
    let store = make_store();
    let count = store
        .delete_history(&["no-such-id".to_string()])
        .unwrap();
    assert_eq!(count, 0);
}

// ── 删除时清理关联图片文件（图文混排 rich 类型引入，顺带修复 image 类型同样的遗留问题） ──

#[test]
fn test_delete_image_item_removes_file() {
    let store = make_store();
    let dir = std::env::temp_dir().join(format!("pastepanda_del_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let img_path = dir.join("pic.png");
    std::fs::write(&img_path, b"fake png bytes").unwrap();

    let item = HistoryItem {
        content: img_path.to_string_lossy().to_string(),
        ..make_item("img-1", "[图片] 10x10", "2024-01-01 10:00:00", "image")
    };
    store.insert_history(&item).unwrap();
    assert!(img_path.exists());

    store.delete_history(&["img-1".to_string()]).unwrap();
    assert!(!img_path.exists(), "删除唯一引用该图片的记录后，文件应被清理");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_delete_image_item_keeps_file_if_still_referenced() {
    // 同一张图片被两条记录共用（按内容 hash 去重后的真实情况）——
    // 删其中一条不应该连带删掉另一条还在用的图片。
    let store = make_store();
    let dir = std::env::temp_dir().join(format!("pastepanda_del_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let img_path = dir.join("shared.png");
    std::fs::write(&img_path, b"shared png bytes").unwrap();

    let item1 = HistoryItem {
        content: img_path.to_string_lossy().to_string(),
        ..make_item("img-a", "[图片] 10x10", "2024-01-01 10:00:00", "image")
    };
    let item2 = HistoryItem {
        content: img_path.to_string_lossy().to_string(),
        ..make_item("img-b", "[图片] 10x10", "2024-01-01 11:00:00", "image")
    };
    store.insert_history(&item1).unwrap();
    store.insert_history(&item2).unwrap();

    store.delete_history(&["img-a".to_string()]).unwrap();
    assert!(img_path.exists(), "img-b 还引用着这张图，不应被删除本次删除的 img-a 误删文件");

    store.delete_history(&["img-b".to_string()]).unwrap();
    assert!(!img_path.exists(), "最后一条引用也删除后，文件才真正清理");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_delete_rich_item_removes_embedded_images() {
    let store = make_store();
    let dir = std::env::temp_dir().join(format!("pastepanda_del_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let img1 = dir.join("a1b2c3.png");
    let img2 = dir.join("d4e5f6.png");
    std::fs::write(&img1, b"img1").unwrap();
    std::fs::write(&img2, b"img2").unwrap();

    let html = format!(
        "<p>前文</p><img src=\"file:///{}\"><img src=\"file:///{}\"><p>后文</p>",
        img1.to_string_lossy().replace('\\', "/"),
        img2.to_string_lossy().replace('\\', "/")
    );
    let item = HistoryItem {
        content: html,
        ..make_item("rich-1", "前文 后文", "2024-01-01 10:00:00", "rich")
    };
    store.insert_history(&item).unwrap();

    store.delete_history(&["rich-1".to_string()]).unwrap();
    assert!(!img1.exists(), "rich 记录删除后，内嵌的图片1应被清理");
    assert!(!img2.exists(), "rich 记录删除后，内嵌的图片2应被清理");

    let _ = std::fs::remove_dir_all(&dir);
}

// ============================================================
// toggle_pin 测试
// ============================================================

#[test]
fn test_toggle_pin_off_to_on() {
    let store = make_store();
    store
        .insert_history(&make_item("pin-1", "Toggle", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let new_state = store.toggle_pin("pin-1").unwrap();
    assert!(new_state);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert!(result[0].pinned);
}

#[test]
fn test_toggle_pin_on_to_off() {
    let store = make_store();
    let mut item = make_item("pin-2", "Toggle", "2024-01-01 10:00:00", "text");
    item.pinned = true;
    store.insert_history(&item).unwrap();

    let new_state = store.toggle_pin("pin-2").unwrap();
    assert!(!new_state);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert!(!result[0].pinned);
}

// ============================================================
// clear_history + get_history_before_cleanup 测试
// ============================================================

#[test]
fn test_clear_history_with_days() {
    let store = make_store();
    // 插入一条 100 天前的记录
    let past = chrono::Local::now() - chrono::Duration::days(100);
    let past_str = past.format("%Y-%m-%d %H:%M:%S").to_string();
    store
        .insert_history(&make_item("old-1", "Old", &past_str, "text"))
        .unwrap();

    // 插入一条今天的记录
    let today_str = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    store
        .insert_history(&make_item("new-1", "New", &today_str, "text"))
        .unwrap();

    // 清理 30 天前的
    let deleted = store
        .get_history_before_cleanup("默认", Some(30))
        .unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].id, "old-1");

    let count = store.clear_history("默认", Some(30)).unwrap();
    assert_eq!(count, 1);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "new-1");
}

#[test]
fn test_clear_history_no_days_safe() {
    let store = make_store();
    store
        .insert_history(&make_item("s-1", "Safe", "2024-01-01 10:00:00", "text"))
        .unwrap();

    // None 或 0 天不删除任何记录
    let count = store.clear_history("默认", None).unwrap();
    assert_eq!(count, 0);

    let count2 = store.clear_history("默认", Some(0)).unwrap();
    assert_eq!(count2, 0);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
}

#[test]
fn test_clear_history_preserves_pinned() {
    let store = make_store();
    let past = chrono::Local::now() - chrono::Duration::days(100);
    let past_str = past.format("%Y-%m-%d %H:%M:%S").to_string();

    let mut pinned_item = make_item("pin-old", "Pinned Old", &past_str, "text");
    pinned_item.pinned = true;
    store.insert_history(&pinned_item).unwrap();

    let normal_old = make_item("norm-old", "Normal Old", &past_str, "text");
    store.insert_history(&normal_old).unwrap();

    let count = store.clear_history("默认", Some(30)).unwrap();
    assert_eq!(count, 1); // 只删除了未置顶的

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "pin-old");
}

// ============================================================
// get_stats 测试
// ============================================================

#[test]
fn test_get_stats_basic() {
    let store = make_store();
    store
        .insert_history(&make_item("s1", "Text 1", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("s2", "Image 1", "2024-01-01 10:00:00", "image"))
        .unwrap();
    store
        .insert_history(&make_item("s3", "File 1", "2024-01-01 10:00:00", "file"))
        .unwrap();

    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.total, 3);
    assert_eq!(stats.text_count, 1);
    assert_eq!(stats.image_count, 1);
    assert_eq!(stats.file_count, 1);
}

#[test]
fn test_get_stats_pinned() {
    let store = make_store();
    let mut item = make_item("p1", "Pinned", "2024-01-01 10:00:00", "text");
    item.pinned = true;
    store.insert_history(&item).unwrap();
    store
        .insert_history(&make_item("n1", "Normal", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.pinned, 1);
}

#[test]
fn test_get_stats_today() {
    let store = make_store();
    let today_str = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    store
        .insert_history(&make_item("today-1", "Today", &today_str, "text"))
        .unwrap();

    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.today, 1);
}

#[test]
fn test_get_stats_empty() {
    let store = make_store();
    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.total, 0);
    assert_eq!(stats.pinned, 0);
    assert_eq!(stats.today, 0);
}

// ============================================================
// get_stats_detail 测试
// ============================================================

#[test]
fn test_get_stats_detail_daily_and_hours() {
    let store = make_store();
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let yesterday = (now - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();

    // 今天 2 条（10 时 / 14 时），昨天 1 条（23 时）
    store
        .insert_history(&make_item("d1", "A", &format!("{} 10:00:00", today), "text"))
        .unwrap();
    store
        .insert_history(&make_item("d2", "B", &format!("{} 14:30:00", today), "image"))
        .unwrap();
    store
        .insert_history(&make_item("d3", "C", &format!("{} 23:00:00", yesterday), "file"))
        .unwrap();

    let detail = store.get_stats_detail("默认").unwrap();
    assert_eq!(detail.total, 3);
    assert_eq!(detail.today, 2);
    assert_eq!(detail.yesterday, 1);
    assert_eq!(detail.text_count, 1);
    assert_eq!(detail.image_count, 1);
    assert_eq!(detail.file_count, 1);

    // daily：7 天升序，末位为今天，缺日补 0
    assert_eq!(detail.daily.len(), 7);
    assert_eq!(detail.daily[6].date, today);
    assert_eq!(detail.daily[6].count, 2);
    assert_eq!(detail.daily[5].date, yesterday);
    assert_eq!(detail.daily[5].count, 1);
    assert_eq!(detail.daily[0].count, 0);

    // hours：恒 24 槽，计数落在对应时段
    assert_eq!(detail.hours.len(), 24);
    assert_eq!(detail.hours[10], 1);
    assert_eq!(detail.hours[14], 1);
    assert_eq!(detail.hours[23], 1);
    assert_eq!(detail.hours[0], 0);
}

#[test]
fn test_get_stats_detail_sources_top5() {
    let store = make_store();
    // 6 个来源，计数 6..1，应只保留 Top 5 且按计数降序
    for (i, count) in (1..=6).rev().enumerate() {
        let source = format!("App{}", i + 1);
        for j in 0..count {
            let mut item = make_item(
                &format!("s{}-{}", i, j),
                &format!("text {}-{}", i, j),
                "2024-01-01 10:00:00",
                "text",
            );
            item.source = source.clone();
            store.insert_history(&item).unwrap();
        }
    }

    let detail = store.get_stats_detail("默认").unwrap();
    assert_eq!(detail.sources.len(), 5);
    assert_eq!(detail.sources[0].source, "App1");
    assert_eq!(detail.sources[0].count, 6);
    assert_eq!(detail.sources[4].source, "App5");
    assert_eq!(detail.sources[4].count, 2);
}

#[test]
fn test_get_stats_detail_empty() {
    let store = make_store();
    let detail = store.get_stats_detail("默认").unwrap();
    assert_eq!(detail.total, 0);
    assert_eq!(detail.today, 0);
    assert_eq!(detail.yesterday, 0);
    assert_eq!(detail.daily.len(), 7);
    assert!(detail.daily.iter().all(|d| d.count == 0));
    assert_eq!(detail.hours, vec![0u32; 24]);
    assert!(detail.sources.is_empty());
}

// ============================================================
// get_config + save_config 测试
// ============================================================

#[test]
fn test_save_and_get_config() {
    let store = make_store();
    let config = serde_json::json!({
        "hotkey": "Ctrl+Shift+V",
        "auto_strip": true,
        "max_history": 1000,
    });
    store.save_config(&config).unwrap();

    let loaded = store.get_config().unwrap();
    assert_eq!(loaded["hotkey"], "Ctrl+Shift+V");
    assert_eq!(loaded["auto_strip"], true);
    assert_eq!(loaded["max_history"], 1000);
}

#[test]
fn test_save_config_overwrites() {
    let store = make_store();
    let config1 = serde_json::json!({"key": "value1"});
    store.save_config(&config1).unwrap();

    let config2 = serde_json::json!({"key": "value2"});
    store.save_config(&config2).unwrap();

    let loaded = store.get_config().unwrap();
    assert_eq!(loaded["key"], "value2");
}

#[test]
fn test_save_config_string_value() {
    let store = make_store();
    let config = serde_json::json!({"theme": "dark"});
    store.save_config(&config).unwrap();

    let loaded = store.get_config().unwrap();
    assert_eq!(loaded["theme"], "dark");
}

#[test]
fn test_get_config_empty() {
    let store = make_store();
    let config = store.get_config().unwrap();
    assert!(config.as_object().unwrap().is_empty());
}

// ============================================================
// import_history 测试
// ============================================================

#[test]
fn test_import_history_new() {
    let store = make_store();
    let items = vec![
        make_item("imp-1", "Import 1", "2024-01-01 10:00:00", "text"),
        make_item("imp-2", "Import 2", "2024-01-01 10:00:01", "text"),
    ];
    let count = store.import_history(&items).unwrap();
    assert_eq!(count, 2);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 2);
}

#[test]
fn test_import_history_duplicate() {
    let store = make_store();
    store
        .insert_history(&make_item("imp-1", "Original", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let items = vec![make_item("imp-1", "Duplicate", "2024-01-01 11:00:00", "text")];
    let count = store.import_history(&items).unwrap();
    assert_eq!(count, 0); // INSERT OR IGNORE 跳过重复

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].text, "Original");
}

#[test]
fn test_import_history_empty() {
    let store = make_store();
    let count = store.import_history(&[]).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_import_history_restores_tags() {
    // 回归：原 import_history 完全忽略 item.tags，导致帮助页教的迁移路径
    // （导出 JSON → 新电脑导入）必然丢掉所有标签
    let store = make_store();
    let mut item = make_item("imp-tag-1", "tagged", "2024-01-01 10:00:00", "text");
    item.tags = vec![Tag {
        id: "src-tag-1".to_string(),
        name: "源机标签".to_string(),
        color: "#123456".to_string(),
        source: "manual".to_string(),
        created_at: "2024-01-01 09:00:00".to_string(),
    }];

    let count = store.import_history(&[item]).unwrap();
    assert_eq!(count, 1);

    // 标签本身应被建出来，颜色沿用源机的
    let tags = store.get_tags().unwrap();
    let created = tags
        .iter()
        .find(|t| t.name == "源机标签")
        .expect("导入后应创建同名标签");
    assert_eq!(created.color, "#123456");

    // 关联应写入，且能随历史记录一起读出
    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    let imported = result
        .iter()
        .find(|i| i.id == "imp-tag-1")
        .expect("导入的记录应存在");
    assert_eq!(imported.tags.len(), 1, "导入后标签关联丢了");
    assert_eq!(imported.tags[0].name, "源机标签");
}

#[test]
fn test_import_history_reuses_existing_tag_color() {
    // 策略 (a)：按名匹配同名标签时复用本机标签，不覆盖用户在本机调过的颜色
    let store = make_store();
    let local = store.create_tag("共名标签", "#AAAAAA").unwrap();

    let mut item = make_item("imp-tag-2", "tagged2", "2024-01-01 10:00:00", "text");
    item.tags = vec![Tag {
        id: "src-tag-2".to_string(),
        name: "共名标签".to_string(),
        color: "#BBBBBB".to_string(), // 源机颜色不同，应被忽略
        source: "manual".to_string(),
        created_at: "2024-01-01 09:00:00".to_string(),
    }];
    store.import_history(&[item]).unwrap();

    let tags = store.get_tags().unwrap();
    let same_name: Vec<_> = tags.iter().filter(|t| t.name == "共名标签").collect();
    assert_eq!(same_name.len(), 1, "同名标签不应重复创建");
    assert_eq!(same_name[0].color, "#AAAAAA", "不应覆盖本机已有标签的颜色");
    assert_eq!(same_name[0].id, local.id, "应复用本机标签 id");

    // 关联指向本机那个标签
    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    let imported = result.iter().find(|i| i.id == "imp-tag-2").unwrap();
    assert_eq!(imported.tags.len(), 1);
    assert_eq!(imported.tags[0].id, local.id);
}

#[test]
fn test_import_history_nulls_dangling_group_id() {
    // 回归：history.group_id 无外键约束，直接写入源机 group_id 会产生悬空引用——
    // 这些记录计入总数却在任何分组下都看不到（「未分组」按 IS NULL 判定），且永无清理机会
    let store = make_store();
    let mut item = make_item("imp-grp-1", "orphan", "2024-01-01 10:00:00", "text");
    item.group_id = Some("本机不存在的分组id".to_string());
    store.import_history(&[item]).unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    let imported = result.iter().find(|i| i.id == "imp-grp-1").unwrap();
    assert_eq!(imported.group_id, None, "本机不存在的分组应置 NULL，而非写入悬空引用");
}

#[test]
fn test_import_history_keeps_existing_group_id() {
    // 与上一条成对：分组在本机确实存在时不能被误置 NULL
    let store = make_store();
    let group = store.create_group("已有分组", "#FF0000", "📁").unwrap();

    let mut item = make_item("imp-grp-2", "in group", "2024-01-01 10:00:00", "text");
    item.group_id = Some(group.id.clone());
    store.import_history(&[item]).unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    let imported = result.iter().find(|i| i.id == "imp-grp-2").unwrap();
    assert_eq!(imported.group_id, Some(group.id));
}

// ============================================================
// Snippet CRUD 测试
// ============================================================

#[test]
fn test_add_snippet() {
    let store = make_store();
    let id = store
        .add_snippet("Test Snippet", "This is content")
        .unwrap();
    assert!(!id.is_empty());

    let snippets = store.get_snippets().unwrap();
    assert_eq!(snippets.len(), 1);
    assert_eq!(snippets[0].name, "Test Snippet");
    assert_eq!(snippets[0].content, "This is content");
}

#[test]
fn test_add_multiple_snippets() {
    let store = make_store();
    store.add_snippet("S1", "Content 1").unwrap();
    store.add_snippet("S2", "Content 2").unwrap();
    store.add_snippet("S3", "Content 3").unwrap();

    let snippets = store.get_snippets().unwrap();
    assert_eq!(snippets.len(), 3);
}

#[test]
fn test_update_snippet() {
    let store = make_store();
    let id = store.add_snippet("Original", "Original content").unwrap();

    store
        .update_snippet(&id, "Updated", "Updated content", "tag1")
        .unwrap();

    let snippets = store.get_snippets().unwrap();
    assert_eq!(snippets[0].name, "Updated");
    assert_eq!(snippets[0].content, "Updated content");
    assert_eq!(snippets[0].tag, "tag1");
}

#[test]
fn test_delete_snippet() {
    let store = make_store();
    let id = store.add_snippet("To Delete", "Content").unwrap();
    assert_eq!(store.get_snippets().unwrap().len(), 1);

    store.delete_snippet(&id).unwrap();
    assert_eq!(store.get_snippets().unwrap().len(), 0);
}

#[test]
fn test_get_snippets_empty() {
    let store = make_store();
    let snippets = store.get_snippets().unwrap();
    assert!(snippets.is_empty());
}

// ============================================================
// get_all_history 测试
// ============================================================

#[test]
fn test_get_all_history() {
    let store = make_store();
    for i in 1..=50 {
        store
            .insert_history(&make_item(
                &format!("all-{}", i),
                &format!("All {}", i),
                &format!("2024-01-01 10:{:02}:{:02}", i / 2, i % 60),
                "text",
            ))
            .unwrap();
    }
    let result = store.get_all_history("默认").unwrap();
    assert_eq!(result.len(), 50);
}

#[test]
fn test_get_all_history_empty() {
    let store = make_store();
    let result = store.get_all_history("默认").unwrap();
    assert!(result.is_empty());
}

// ============================================================
// Group CRUD 测试
// ============================================================

#[test]
fn test_create_group() {
    let store = make_store();
    let group = store
        .create_group("Work", "#FF0000", "briefcase")
        .unwrap();
    assert_eq!(group.name, "Work");
    assert_eq!(group.color, "#FF0000");
    assert_eq!(group.icon, "briefcase");
    assert!(!group.id.is_empty());
}

#[test]
fn test_get_groups() {
    let store = make_store();
    store.create_group("A", "#111", "a").unwrap();
    store.create_group("B", "#222", "b").unwrap();

    let groups = store.get_groups().unwrap();
    assert_eq!(groups.len(), 2);
}

#[test]
fn test_get_groups_empty() {
    let store = make_store();
    let groups = store.get_groups().unwrap();
    assert!(groups.is_empty());
}

#[test]
fn test_update_group() {
    let store = make_store();
    let group = store.create_group("Old", "#000", "old").unwrap();
    store
        .update_group(&group.id, "New", "#FFF", "new")
        .unwrap();

    let groups = store.get_groups().unwrap();
    assert_eq!(groups[0].name, "New");
    assert_eq!(groups[0].color, "#FFF");
    assert_eq!(groups[0].icon, "new");
}

#[test]
fn test_update_group_not_found() {
    let store = make_store();
    let err = store
        .update_group("nonexistent", "Name", "#000", "icon")
        .unwrap_err();
    assert!(err.contains("不存在"));
}

#[test]
fn test_delete_group() {
    let store = make_store();
    let group = store.create_group("To Delete", "#000", "trash").unwrap();
    store.delete_group(&group.id).unwrap();
    assert_eq!(store.get_groups().unwrap().len(), 0);
}

#[test]
fn test_delete_group_clears_history_group_id() {
    let store = make_store();
    let group = store.create_group("G", "#000", "g").unwrap();

    let mut item = make_item("gh-1", "Grouped", "2024-01-01 10:00:00", "text");
    item.group_id = Some(group.id.clone());
    store.insert_history(&item).unwrap();

    store.delete_group(&group.id).unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].group_id, None);
}

#[test]
fn test_reorder_groups() {
    let store = make_store();
    let g1 = store.create_group("First", "#111", "1").unwrap();
    let g2 = store.create_group("Second", "#222", "2").unwrap();
    let g3 = store.create_group("Third", "#333", "3").unwrap();

    // 反转顺序
    store
        .reorder_groups(&[g3.id.clone(), g2.id.clone(), g1.id.clone()])
        .unwrap();

    let groups = store.get_groups().unwrap();
    assert_eq!(groups[0].id, g3.id);
    assert_eq!(groups[1].id, g2.id);
    assert_eq!(groups[2].id, g1.id);
}

#[test]
fn test_reorder_groups_empty() {
    let store = make_store();
    store.reorder_groups(&[]).unwrap();
}

#[test]
fn test_move_to_group() {
    let store = make_store();
    let group = store.create_group("Target", "#000", "folder").unwrap();
    store
        .insert_history(&make_item("mg-1", "Move me", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let count = store
        .move_to_group(&["mg-1".to_string()], Some(&group.id))
        .unwrap();
    assert_eq!(count, 1);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].group_id, Some(group.id));
}

#[test]
fn test_move_to_group_null() {
    let store = make_store();
    let group = store.create_group("G", "#000", "g").unwrap();
    let mut item = make_item("mg-2", "Ungroup me", "2024-01-01 10:00:00", "text");
    item.group_id = Some(group.id.clone());
    store.insert_history(&item).unwrap();

    let count = store
        .move_to_group(&["mg-2".to_string()], None)
        .unwrap();
    assert_eq!(count, 1);

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].group_id, None);
}

// ============================================================
// Tag CRUD 测试
// ============================================================

#[test]
fn test_create_tag() {
    let store = make_store();
    let tag = store.create_tag("Important", "#FF0000").unwrap();
    assert_eq!(tag.name, "Important");
    assert_eq!(tag.color, "#FF0000");
    assert_eq!(tag.source, "manual");
    assert!(!tag.id.is_empty());
}

#[test]
fn test_get_tags() {
    let store = make_store();
    store.create_tag("A", "#111").unwrap();
    store.create_tag("B", "#222").unwrap();

    let tags = store.get_tags().unwrap();
    assert_eq!(tags.len(), 2);
}

#[test]
fn test_get_tags_empty() {
    let store = make_store();
    let tags = store.get_tags().unwrap();
    assert!(tags.is_empty());
}

#[test]
fn test_update_tag() {
    let store = make_store();
    let tag = store.create_tag("Old", "#000").unwrap();
    store.update_tag(&tag.id, "New", "#FFF").unwrap();

    let tags = store.get_tags().unwrap();
    assert_eq!(tags[0].name, "New");
    assert_eq!(tags[0].color, "#FFF");
}

#[test]
fn test_update_tag_not_found() {
    let store = make_store();
    let err = store
        .update_tag("nonexistent", "Name", "#000")
        .unwrap_err();
    assert!(err.contains("不存在"));
}

#[test]
fn test_delete_tag() {
    let store = make_store();
    let tag = store.create_tag("To Delete", "#000").unwrap();
    store.delete_tag(&tag.id).unwrap();
    assert_eq!(store.get_tags().unwrap().len(), 0);
}

// ============================================================
// Tag-Item 关联测试
// ============================================================

#[test]
fn test_set_item_tags() {
    let store = make_store();
    store
        .insert_history(&make_item("tagged-1", "Tagged", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let tag = store.create_tag("TestTag", "#000").unwrap();

    store
        .set_item_tags("tagged-1", &[tag.id.clone()])
        .unwrap();

    let result = store
        .get_items_with_tags(&["tagged-1".to_string()])
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].1.len(), 1);
    assert_eq!(result[0].1[0].name, "TestTag");
}

#[test]
fn test_set_item_tags_replaces() {
    let store = make_store();
    store
        .insert_history(&make_item("tagged-2", "Tagged", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let tag1 = store.create_tag("T1", "#111").unwrap();
    let tag2 = store.create_tag("T2", "#222").unwrap();

    store
        .set_item_tags("tagged-2", &[tag1.id.clone()])
        .unwrap();
    store
        .set_item_tags("tagged-2", &[tag2.id.clone()])
        .unwrap();

    let result = store
        .get_items_with_tags(&["tagged-2".to_string()])
        .unwrap();
    assert_eq!(result[0].1.len(), 1);
    assert_eq!(result[0].1[0].name, "T2");
}

#[test]
fn test_add_item_tags() {
    let store = make_store();
    store
        .insert_history(&make_item("add-tag-1", "Item", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let tag1 = store.create_tag("T1", "#111").unwrap();
    let tag2 = store.create_tag("T2", "#222").unwrap();

    let count = store
        .add_item_tags(&["add-tag-1".to_string()], &[tag1.id.clone(), tag2.id.clone()])
        .unwrap();
    assert_eq!(count, 2);

    let result = store
        .get_items_with_tags(&["add-tag-1".to_string()])
        .unwrap();
    assert_eq!(result[0].1.len(), 2);
}

#[test]
fn test_remove_item_tags() {
    let store = make_store();
    store
        .insert_history(&make_item("rem-tag-1", "Item", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let tag = store.create_tag("T1", "#111").unwrap();
    store
        .set_item_tags("rem-tag-1", &[tag.id.clone()])
        .unwrap();

    let count = store
        .remove_item_tags(&["rem-tag-1".to_string()], &[tag.id.clone()])
        .unwrap();
    assert_eq!(count, 1);

    let result = store
        .get_items_with_tags(&["rem-tag-1".to_string()])
        .unwrap();
    assert!(result.is_empty());
}

#[test]
fn test_get_items_with_tags_empty_ids() {
    let store = make_store();
    let result = store.get_items_with_tags(&[]).unwrap();
    assert!(result.is_empty());
}

#[test]
fn test_get_items_with_tags_no_tags() {
    let store = make_store();
    store
        .insert_history(&make_item("no-tag", "No tags", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let result = store
        .get_items_with_tags(&["no-tag".to_string()])
        .unwrap();
    assert!(result.is_empty());
}

// ============================================================
// Tags loaded into HistoryItem 测试
// ============================================================

#[test]
fn test_tags_loaded_in_get_history() {
    let store = make_store();
    store
        .insert_history(&make_item("tl-1", "With tags", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let tag = store.create_tag("MyTag", "#FF0000").unwrap();
    store
        .set_item_tags("tl-1", &[tag.id.clone()])
        .unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].tags.len(), 1);
    assert_eq!(result[0].tags[0].name, "MyTag");
}

#[test]
fn test_tags_loaded_in_get_all_history() {
    let store = make_store();
    store
        .insert_history(&make_item("tl-2", "With tags", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let tag = store.create_tag("AllTag", "#000").unwrap();
    store
        .set_item_tags("tl-2", &[tag.id.clone()])
        .unwrap();

    let result = store.get_all_history("默认").unwrap();
    assert_eq!(result[0].tags.len(), 1);
}

// ============================================================
// Auto Tags 测试
// ============================================================

#[test]
fn test_ensure_auto_tags() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();

    let tags = store.get_tags().unwrap();
    // 应该有 32 个自动标签种子
    assert_eq!(tags.len(), 32);
    // 全部 source 为 "auto"
    assert!(tags.iter().all(|t| t.source == "auto"));
    // 类型标识必须在标签体系里（而不是卡片上写死的徽标），
    // 否则点不了筛选、也不会出现在筛选标签列表里。
    // 流程图 / 文档是后补的：种子表里没有的名字，resolve_auto_tag_ids 会静默跳过，
    // 「文档」因此一直在 push 但从来没落到过卡片上。
    for name in ["图文", "流程图", "文档"] {
        assert!(tags.iter().any(|t| t.name == name), "缺少类型标签种子: {}", name);
    }
}

#[test]
fn test_ensure_auto_tags_idempotent() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();
    store.ensure_auto_tags().unwrap();

    let tags = store.get_tags().unwrap();
    assert_eq!(tags.len(), 32); // 不应重复插入
}

#[test]
fn test_resolve_auto_tag_ids() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();

    let ids = store
        .resolve_auto_tag_ids(&["代码".to_string(), "JavaScript".to_string()])
        .unwrap();
    assert_eq!(ids.len(), 2);
}

#[test]
fn test_resolve_auto_tag_ids_unknown_label() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();

    let ids = store
        .resolve_auto_tag_ids(&["不存在的标签".to_string()])
        .unwrap();
    assert!(ids.is_empty());
}

#[test]
fn test_all_classify_main_labels_resolve() {
    // 回归：classify() 输出的每个主标签都必须能解析到种子标签，
    // 防止识别结果被 resolve_auto_tag_ids 静默丢弃（邮箱/电话/颜色/文件路径/Markdown 曾缺失）
    let store = make_store();
    store.ensure_auto_tags().unwrap();

    let main_labels: Vec<String> = [
        "邮箱", "电话", "颜色", "文件路径", "数字", "JSON", "纯文本", "链接",
        "Markdown", "HTML", "配置文件", "表格", "命令行", "日志", "密钥", "代码",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    let ids = store.resolve_auto_tag_ids(&main_labels).unwrap();
    assert_eq!(ids.len(), main_labels.len(), "存在未种子化的主标签: 期望 {} 个，实际解析 {} 个", main_labels.len(), ids.len());
}

#[test]
fn test_add_history_tags() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();
    store
        .insert_history(&make_item("auto-1", "Code here", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let ids = store
        .resolve_auto_tag_ids(&["代码".to_string()])
        .unwrap();
    store.add_history_tags("auto-1", &ids).unwrap();

    let result = store
        .get_items_with_tags(&["auto-1".to_string()])
        .unwrap();
    assert_eq!(result[0].1.len(), 1);
}

#[test]
fn test_add_history_tags_empty() {
    let store = make_store();
    store
        .add_history_tags("any-id", &[])
        .unwrap();
}

#[test]
fn test_confirm_auto_tags() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();
    store
        .insert_history(&make_item("confirm-1", "Code", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let ids = store
        .resolve_auto_tag_ids(&["代码".to_string()])
        .unwrap();
    store.add_history_tags("confirm-1", &ids).unwrap();

    store.confirm_auto_tags("confirm-1").unwrap();

    let result = store
        .get_items_with_tags(&["confirm-1".to_string()])
        .unwrap();
    assert!(result[0].1.iter().all(|t| t.source == "manual"));
}

// ============================================================
// compute_pinyin_initials 测试
// ============================================================

#[test]
fn test_pinyin_initials_chinese() {
    let initials = compute_pinyin_initials("你好世界");
    assert_eq!(initials, "NHSJ");
}

#[test]
fn test_pinyin_initials_mixed() {
    let initials = compute_pinyin_initials("Hello 世界");
    // "Hello" 不是中文不产生拼音，只有"世界"→"SJ"
    assert_eq!(initials, "SJ");
}

#[test]
fn test_pinyin_initials_empty() {
    let initials = compute_pinyin_initials("");
    assert!(initials.is_empty());
}

#[test]
fn test_pinyin_initials_pure_ascii() {
    let initials = compute_pinyin_initials("Hello World");
    assert!(initials.is_empty());
}

#[test]
fn test_pinyin_initials_truncated() {
    // 超过 50 个中文字符应截断
    let long_text = "一".repeat(100);
    let initials = compute_pinyin_initials(&long_text);
    assert_eq!(initials.len(), 50);
}

// ============================================================
// AI 用量明细账测试
// ============================================================

fn usage_entry(action: &str, p: u32, c: u32, cost: f64) -> AiUsageEntry {
    AiUsageEntry {
        action_id: action.to_string(),
        provider: "deepseek".to_string(),
        model: "deepseek-chat".to_string(),
        prompt_tokens: p,
        completion_tokens: c,
        cost_usd: cost,
        cached: false,
        latency_ms: 120,
        ok: true,
        error: None,
    }
}

#[test]
fn test_ai_usage_log_has_no_content_column() {
    // 这是条红线：明细表里不得出现任何能装下剪贴板内容的字段。
    // 一旦有人为了"方便排查"加个 input/output/text 列，这个测试要立刻拦住。
    let store = make_store();
    let conn = store.lock_conn();
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('ai_usage_log')")
        .unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    assert!(!cols.is_empty(), "表没建起来");
    for forbidden in ["text", "content", "input", "output", "prompt", "reply", "result"] {
        assert!(
            !cols.iter().any(|c| c == forbidden),
            "ai_usage_log 出现了内容字段 `{}`——明细账绝不能变成第二份剪贴板历史",
            forbidden
        );
    }
}

#[test]
fn test_ai_usage_today_counts_billable_separately() {
    let store = make_store();
    // 2 次真实计费
    store.ai_usage_add(&usage_entry("ai-translate", 100, 50, 0.01));
    store.ai_usage_add(&usage_entry("ai-translate", 100, 50, 0.01));
    // 1 次缓存命中（免费）
    store.ai_usage_add(&AiUsageEntry {
        cached: true,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0.0,
        ..usage_entry("ai-translate", 0, 0, 0.0)
    });
    // 1 次失败（免费）
    store.ai_usage_add(&AiUsageEntry {
        ok: false,
        error: Some("鉴权失败".to_string()),
        ..usage_entry("ai-summarize", 0, 0, 0.0)
    });

    let d = store.ai_usage_today();
    assert_eq!(d.calls, 4, "总条数含缓存与失败");
    assert_eq!(d.billable_calls, 2, "只有真实计费的才算 billable");
    assert_eq!(d.cached_calls, 1);
    assert_eq!(d.failed_calls, 1);
    assert_eq!(d.prompt_tokens, 200);
    assert_eq!(d.completion_tokens, 100);
    assert!((d.cost_usd - 0.02).abs() < 1e-9);
}

#[test]
fn test_ai_usage_empty_day_is_zero_not_error() {
    // "今天还没用过"不是异常，不能让它把面板整个打不开
    let store = make_store();
    let d = store.ai_usage_today();
    assert_eq!(d.calls, 0);
    assert_eq!(d.cost_usd, 0.0);
    assert!(store.ai_usage_recent(50).unwrap().is_empty());
    assert!(store.ai_usage_daily(7).unwrap().is_empty());
    assert!(store.ai_usage_by_action(7).unwrap().is_empty());
}

#[test]
fn test_ai_usage_recent_is_newest_first_and_keeps_error() {
    let store = make_store();
    store.ai_usage_add(&usage_entry("ai-translate", 10, 5, 0.001));
    store.ai_usage_add(&AiUsageEntry {
        ok: false,
        error: Some("请求超时（60 秒）".to_string()),
        ..usage_entry("ai-summarize", 0, 0, 0.0)
    });

    let rows = store.ai_usage_recent(50).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].entry.action_id, "ai-summarize", "应为时间倒序");
    assert!(!rows[0].entry.ok);
    assert!(rows[0].entry.error.as_deref().unwrap().contains("超时"));
    assert_eq!(rows[1].entry.action_id, "ai-translate");
    assert!(rows[1].entry.error.is_none());
}

#[test]
fn test_ai_usage_long_error_is_truncated() {
    // 服务商的错误体可能很长，整个存进来毫无必要
    let store = make_store();
    store.ai_usage_add(&AiUsageEntry {
        ok: false,
        error: Some("啊".repeat(5000)),
        ..usage_entry("ai-rewrite", 0, 0, 0.0)
    });
    let rows = store.ai_usage_recent(1).unwrap();
    let stored = rows[0].entry.error.as_deref().unwrap();
    assert!(
        stored.chars().count() <= 301,
        "错误信息未截断，实际 {} 字",
        stored.chars().count()
    );
}

#[test]
fn test_ai_usage_by_action_sorted_by_cost() {
    let store = make_store();
    store.ai_usage_add(&usage_entry("ai-translate", 10, 5, 0.001));
    store.ai_usage_add(&usage_entry("ai-explain-code", 500, 500, 0.05));
    store.ai_usage_add(&usage_entry("ai-translate", 10, 5, 0.001));

    let by = store.ai_usage_by_action(7).unwrap();
    assert_eq!(by.len(), 2);
    assert_eq!(by[0].action_id, "ai-explain-code", "花费最多的排最前");
    assert_eq!(by[1].action_id, "ai-translate");
    assert_eq!(by[1].calls, 2);
}

#[test]
fn test_ai_usage_clear_and_purge() {
    let store = make_store();
    store.ai_usage_add(&usage_entry("ai-translate", 10, 5, 0.001));

    // 保留期内的记录不该被清掉
    assert_eq!(store.ai_usage_purge(90).unwrap(), 0);
    assert_eq!(store.ai_usage_today().calls, 1);

    // 用户一键删除
    assert_eq!(store.ai_usage_clear().unwrap(), 1);
    assert_eq!(store.ai_usage_today().calls, 0);
}

// ============================================================
// 自定义 AI 动作
// ============================================================

fn custom_action(name: &str, template: &str) -> CustomAction {
    CustomAction {
        id: String::new(),
        name: name.to_string(),
        description: String::new(),
        icon: "sparkles".to_string(),
        template: template.to_string(),
        max_tokens: 500,
        content_types: vec![],
        enabled: true,
        sort_order: 0,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

#[test]
fn test_custom_action_roundtrip() {
    let store = make_store();
    let mut a = custom_action("写 commit", "根据 diff 写：{{内容}}");
    a.content_types = vec!["code".to_string(), "text".to_string()];
    let id = store.ai_custom_action_save(&a).unwrap();
    assert!(!id.is_empty());

    let list = store.ai_custom_actions().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "写 commit");
    assert_eq!(list[0].max_tokens, 500);
    assert_eq!(list[0].content_types, vec!["code", "text"], "类型要能原样读回");
    assert!(list[0].enabled);
    assert!(!list[0].created_at.is_empty());
}

#[test]
fn test_custom_action_duplicate_name_rejected() {
    // 两个同名动作在变换中心里根本分不清，必须在保存时就拦住
    let store = make_store();
    store
        .ai_custom_action_save(&custom_action("润色", "{{内容}}"))
        .unwrap();
    let err = store
        .ai_custom_action_save(&custom_action("润色", "另一个 {{内容}}"))
        .unwrap_err();
    assert!(err.contains("润色"), "报错要点出是哪个名字：{}", err);
    assert!(!err.contains("UNIQUE"), "不该把 SQLite 的英文原文抛给用户");
}

#[test]
fn test_custom_action_update_keeps_id_and_allows_same_name() {
    let store = make_store();
    let id = store
        .ai_custom_action_save(&custom_action("提取待办", "{{内容}}"))
        .unwrap();

    let mut edit = custom_action("提取待办", "改过的 {{内容}}");
    edit.id = id.clone();
    edit.enabled = false;
    // 改自己时不该被自己的名字挡住
    let same = store.ai_custom_action_save(&edit).unwrap();
    assert_eq!(same, id);

    let got = store.ai_custom_action(&id).unwrap().unwrap();
    assert_eq!(got.template, "改过的 {{内容}}");
    assert!(!got.enabled);
    assert_eq!(store.ai_custom_actions().unwrap().len(), 1, "不该多出一条");
}

#[test]
fn test_custom_action_name_length_and_empty() {
    let store = make_store();
    assert!(store
        .ai_custom_action_save(&custom_action("   ", "{{内容}}"))
        .unwrap_err()
        .contains("不能为空"));

    let long = "字".repeat(MAX_ACTION_NAME_CHARS + 1);
    assert!(store
        .ai_custom_action_save(&custom_action(&long, "{{内容}}"))
        .unwrap_err()
        .contains("最长"));
}

#[test]
fn test_custom_action_max_tokens_clamped() {
    // 填 0 会让回答直接空掉，填 999999 只是白花钱
    let store = make_store();
    let mut a = custom_action("夹逼", "{{内容}}");
    a.max_tokens = 0;
    let id = store.ai_custom_action_save(&a).unwrap();
    assert!(store.ai_custom_action(&id).unwrap().unwrap().max_tokens >= 50);

    let mut b = custom_action("夹逼2", "{{内容}}");
    b.max_tokens = 999_999;
    let id2 = store.ai_custom_action_save(&b).unwrap();
    assert!(store.ai_custom_action(&id2).unwrap().unwrap().max_tokens <= 4000);
}

#[test]
fn test_custom_action_new_ones_go_last_and_reorder_works() {
    let store = make_store();
    let a = store.ai_custom_action_save(&custom_action("A", "{{内容}}")).unwrap();
    let b = store.ai_custom_action_save(&custom_action("B", "{{内容}}")).unwrap();
    let c = store.ai_custom_action_save(&custom_action("C", "{{内容}}")).unwrap();

    let names: Vec<String> = store
        .ai_custom_actions()
        .unwrap()
        .into_iter()
        .map(|x| x.name)
        .collect();
    assert_eq!(names, vec!["A", "B", "C"], "新建的应排在最后");

    store
        .ai_custom_actions_reorder(&[c.clone(), a.clone(), b.clone()])
        .unwrap();
    let after: Vec<String> = store
        .ai_custom_actions()
        .unwrap()
        .into_iter()
        .map(|x| x.name)
        .collect();
    assert_eq!(after, vec!["C", "A", "B"]);
}

// ============================================================
// 动作使用日志（action_events）测试
// ============================================================

#[test]
fn test_custom_action_delete_and_missing_id() {
    let store = make_store();
    let id = store.ai_custom_action_save(&custom_action("待删", "{{内容}}")).unwrap();
    store.ai_custom_action_delete(&id).unwrap();
    assert!(store.ai_custom_action(&id).unwrap().is_none());
    // 删不存在的不报错（幂等）
    store.ai_custom_action_delete("不存在").unwrap();

    // 改一个已经被删掉的，要给出能看懂的提示而不是静默成功
    let mut ghost = custom_action("幽灵", "{{内容}}");
    ghost.id = id;
    assert!(store
        .ai_custom_action_save(&ghost)
        .unwrap_err()
        .contains("已经不存在"));
}

fn action_event(action: &str, ct: &str, app: &str, hour: i32, outcome: &str) -> ActionEvent {
    ActionEvent {
        action_id: action.to_string(),
        content_type: ct.to_string(),
        source_app: app.to_string(),
        hour,
        outcome: outcome.to_string(),
        history_id: None,
        // v6.15 X3 埋点字段：测试不关心，一律 None
        paste_index: None,
        target_cat: None,
    }
}

/// 带 history_id 的事件（粘贴信号回写用）
fn paste_event(history_id: &str, ct: &str) -> ActionEvent {
    ActionEvent {
        action_id: ACTION_ID_PASTE.to_string(),
        content_type: ct.to_string(),
        source_app: "Chrome".to_string(),
        hour: 10,
        outcome: OUTCOME_PASTED.to_string(),
        history_id: Some(history_id.to_string()),
        // v6.15 X3 埋点字段：测试不关心，一律 None
        paste_index: None,
        target_cat: None,
    }
}

#[test]
fn test_action_events_table_has_no_content_column() {
    // 与 ai_usage_log 同一条红线：事件表里不得出现任何能装下剪贴板内容的字段。
    // 一旦有人为了"方便排查"加个 input/output/text 列，这个测试要立刻拦住。
    let store = make_store();
    let conn = store.lock_conn();
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('action_events')")
        .unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    assert!(!cols.is_empty(), "表没建起来");
    for forbidden in ["text", "content", "input", "output", "prompt", "reply", "result"] {
        assert!(
            !cols.iter().any(|c| c == forbidden),
            "action_events 出现了内容字段 `{}`——事件日志绝不能变成第二份剪贴板历史",
            forbidden
        );
    }
}

#[test]
fn test_action_event_add_and_stats() {
    let store = make_store();
    store.action_event_add(&action_event("sql-in", "text", "VSCode", 10, OUTCOME_COPIED));
    store.action_event_add(&action_event("sql-in", "text", "VSCode", 10, OUTCOME_COPIED));
    store.action_event_add(&action_event("ai-translate", "text", "Chrome", 21, OUTCOME_PASTED));

    let s = store.action_event_stats(30);
    assert_eq!(s.total, 3);
    assert_eq!(s.copied, 2);
    assert_eq!(s.pasted, 1);
    assert_eq!(s.abandoned, 0);
    // top_actions 按次数降序：sql-in 2 次 > ai-translate 1 次
    assert_eq!(s.top_actions.len(), 2);
    assert_eq!(s.top_actions[0].action_id, "sql-in");
    assert_eq!(s.top_actions[0].count, 2);
    assert_eq!(s.top_actions[1].action_id, "ai-translate");
}

#[test]
fn test_action_event_stats_empty_day_is_zero_not_error() {
    // "还没用过"不是异常，不能让设置页整个打不开
    let store = make_store();
    let s = store.action_event_stats(7);
    assert_eq!(s.total, 0);
    assert_eq!(s.copied, 0);
    assert_eq!(s.pasted, 0);
    assert!(s.top_actions.is_empty());
}

#[test]
fn test_action_event_clear_and_purge() {
    let store = make_store();
    store.action_event_add(&action_event("sql-in", "text", "VSCode", 10, OUTCOME_COPIED));

    // 保留期内的记录不该被清掉
    assert_eq!(store.action_event_purge(90).unwrap(), 0);
    assert_eq!(store.action_event_stats(30).total, 1);

    // 用户一键删除（红线②）
    assert_eq!(store.action_event_clear().unwrap(), 1);
    assert_eq!(store.action_event_stats(30).total, 0);
}

#[test]
fn test_action_event_purge_removes_old() {
    let store = make_store();
    // 直接插入一条 100 天前的旧事件（保留期 90 天）
    {
        let conn = store.lock_conn();
        let old = (chrono::Local::now() - chrono::Duration::days(100))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        conn.execute(
            "INSERT INTO action_events (created_at, action_id, content_type, source_app, hour, outcome)
             VALUES (?1, 'old-action', 'text', 'VSCode', 10, 'copied')",
            params![old],
        )
        .unwrap();
    }
    store.action_event_add(&action_event("new-action", "text", "VSCode", 10, OUTCOME_COPIED));

    assert_eq!(store.action_event_purge(90).unwrap(), 1, "只清掉 100 天前那条");
    assert_eq!(store.action_event_stats(30).total, 1);
}

// ============================================================
// v6.1：个性化权重聚合 + 负反馈
// ============================================================

#[test]
fn test_action_event_with_history_id_round_trip() {
    let store = make_store();
    store.action_event_add(&paste_event("h-1", "text"));
    // history_id 已写入（SQL 层面验证），且不破坏既有红线（无内容字段）
    let conn = store.lock_conn();
    let hid: String = conn
        .query_row(
            "SELECT history_id FROM action_events WHERE action_id = 'paste'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hid, "h-1");
}

#[test]
fn test_action_recommend_weights_aggregates_and_excludes_paste() {
    let store = make_store();
    // sql-in 在 json 内容上被复制 2 次、粘贴 1 次 → 权重 3
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 10, OUTCOME_COPIED));
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 10, OUTCOME_COPIED));
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 11, OUTCOME_PASTED));
    // abandoned 不该加权
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 12, OUTCOME_ABANDONED));
    // 别的类型 / 别的动作
    store.action_event_add(&action_event("ai-translate", "text", "Chrome", 10, OUTCOME_COPIED));
    // 粘贴哨兵必须被排除——否则"粘贴很多"会被当成"这个动作常用"
    store.action_event_add(&paste_event("h-1", "json"));
    store.action_event_add(&paste_event("h-2", "json"));

    let weights = store.action_recommend_weights(30);
    let sql_in_json = weights
        .iter()
        .find(|w| w.action_id == "sql-in" && w.content_type == "json")
        .expect("应有 sql-in×json 权重");
    assert_eq!(sql_in_json.count, 3, "copied+pasted 计入，abandoned 不计");
    let ai_tr = weights
        .iter()
        .find(|w| w.action_id == "ai-translate")
        .expect("应有 ai-translate 权重");
    assert_eq!(ai_tr.count, 1);
    assert!(
        !weights.iter().any(|w| w.action_id == ACTION_ID_PASTE),
        "粘贴哨兵必须排除在权重外"
    );
}

#[test]
fn test_action_recommend_weights_empty_is_not_error() {
    let store = make_store();
    assert!(store.action_recommend_weights(30).is_empty());
}

#[test]
fn test_action_dismiss_add_is_idempotent() {
    let store = make_store();
    store.action_dismiss_add("ai-translate", "text");
    store.action_dismiss_add("ai-translate", "text"); // 重复 = 幂等
    store.action_dismiss_add("ai-translate", ""); // 全局不推荐（空类型）
    store.action_dismiss_add("sql-in", "json");

    let list = store.action_dismissals().unwrap();
    assert_eq!(list.len(), 3);
    assert!(
        list.iter()
            .any(|d| d.action_id == "ai-translate" && d.content_type == "text")
    );
    assert!(
        list.iter()
            .any(|d| d.action_id == "ai-translate" && d.content_type.is_empty())
    );
}

#[test]
fn test_action_learnings_clear_clears_both() {
    let store = make_store();
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 10, OUTCOME_COPIED));
    store.action_dismiss_add("ai-translate", "text");

    let n = store.action_event_clear().unwrap();
    assert_eq!(n, 1);
    let n2 = store.action_dismissals_clear().unwrap();
    assert_eq!(n2, 1);
    assert!(store.action_dismissals().unwrap().is_empty());
}

// ============================================================
// v6.14 常用置顶（正向偏好）
// ============================================================

#[test]
fn test_action_pin_add_is_idempotent() {
    let store = make_store();
    store.action_pin_add("sql-in", "");
    store.action_pin_add("sql-in", ""); // 重复 = 幂等
    store.action_pin_add("json_format", "");

    let list = store.action_pins().unwrap();
    assert_eq!(list.len(), 2, "重复置顶不应该多出一条");
    assert!(list.iter().all(|p| p.content_type.is_empty()), "本版只有全局置顶");
}

/// 置顶必须顺手清掉该动作的「不再推荐」，否则会出现
/// “它在常用组里、又同时被标为不推荐”的矛盾状态。
#[test]
fn test_action_pin_add_clears_dismissals_of_same_action() {
    let store = make_store();
    store.action_dismiss_add("sql-in", "text");
    store.action_dismiss_add("sql-in", ""); // 同一动作的另一个维度
    store.action_dismiss_add("ai-translate", "text"); // 别的动作，不该被误删

    store.action_pin_add("sql-in", "");

    let left = store.action_dismissals().unwrap();
    assert_eq!(left.len(), 1, "只应删掉 sql-in 的全部 dismiss：{:?}", left);
    assert_eq!(left[0].action_id, "ai-translate", "别的动作的 dismiss 不能被误删");
}

/// 回归：`action_pin_remove` 用**精确匹配**，不能像 `action_dismiss_remove`
/// 那样把空串当通配符——空串在这里是一个**真实取值**（= 全局置顶）。
/// 不这么做的后果得等到支持按内容类型置顶时才爆：
/// “取消全局置顶”会连带删掉所有按类型的置顶。
#[test]
fn test_action_pin_remove_is_exact_not_wildcard() {
    let store = make_store();
    store.action_pin_add("sql-in", ""); // 全局
    store.action_pin_add("sql-in", "json"); // 按类型（本版 UI 不用，但存结构支持）

    let n = store.action_pin_remove("sql-in", "").unwrap();
    assert_eq!(n, 1, "只应删掉全局那一条");

    let left = store.action_pins().unwrap();
    assert_eq!(left.len(), 1, "按类型的置顶必须还在：{:?}", left);
    assert_eq!(left[0].content_type, "json");
}

/// 置顶是用户**显式设的偏好**，不是学习产物，
/// 不能被“清空全部学习记录”连带删掉（同 `action_prefs`）。
#[test]
fn test_learnings_clear_does_not_touch_pins() {
    let store = make_store();
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 10, OUTCOME_COPIED));
    store.action_dismiss_add("ai-translate", "text");
    store.action_pin_add("sql-in", "");

    store.action_event_clear().unwrap();
    store.action_dismissals_clear().unwrap();

    let pins = store.action_pins().unwrap();
    assert_eq!(pins.len(), 1, "清学习记录不得动置顶（那是用户手动设的）");
}

// ============================================================
// v6.1 自我净化：按价值豁免过期清理
// ============================================================

/// 造一条 N 天前的记录（过期候选）
fn make_old_item(id: &str, days: i64) -> HistoryItem {
    let t = (chrono::Local::now() - chrono::Duration::days(days))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    make_item(id, &format!("Old {id}"), &t, "text")
}

#[test]
fn test_value_preserve_tagged_not_expired() {
    let store = make_store();
    let tagged = make_old_item("tag-old", 100);
    let plain = make_old_item("plain-old", 100);
    store.insert_history(&tagged).unwrap();
    store.insert_history(&plain).unwrap();

    // 给 tagged 打标签（tags + history_tags）
    {
        let conn = store.lock_conn();
        conn.execute(
            "INSERT INTO tags (id, name, color, source, created_at)
             VALUES ('tg1', '重要', '#ff0000', 'manual', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO history_tags (history_id, tag_id, source) VALUES ('tag-old', 'tg1', 'manual')",
            [],
        )
        .unwrap();
    }

    let count = store.clear_history_with_undo("默认", Some(30)).unwrap().0;
    assert_eq!(count, 1, "只有无价值的 plain-old 被清，打标签的豁免");
    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "tag-old");
}

#[test]
fn test_value_preserve_pasted_not_expired() {
    let store = make_store();
    let pasted = make_old_item("past-old", 100);
    let plain = make_old_item("plain-old", 100);
    store.insert_history(&pasted).unwrap();
    store.insert_history(&plain).unwrap();

    // pasted 被粘贴过（action_events 带 history_id + outcome='pasted'）
    store.action_event_add(&paste_event("past-old", "text"));

    let count = store.clear_history_with_undo("默认", Some(30)).unwrap().0;
    assert_eq!(count, 1, "被粘贴过的豁免，只有 plain-old 被清");
    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "past-old");
}

#[test]
fn test_value_preserve_searched_not_expired() {
    let store = make_store();
    let searched = make_old_item("hit-old", 100);
    let plain = make_old_item("plain-old", 100);
    store.insert_history(&searched).unwrap();
    store.insert_history(&plain).unwrap();

    // searched 被搜索命中过
    store
        .lock_conn()
        .execute(
            "UPDATE history SET search_hit_count = search_hit_count + 1 WHERE id = 'hit-old'",
            [],
        )
        .unwrap();

    let count = store.clear_history_with_undo("默认", Some(30)).unwrap().0;
    assert_eq!(count, 1, "被搜索命中过的豁免，只有 plain-old 被清");
    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "hit-old");
}

#[test]
fn test_value_preserve_unvalued_all_cleared() {
    let store = make_store();
    store.insert_history(&make_old_item("a-old", 100)).unwrap();
    store.insert_history(&make_old_item("b-old", 100)).unwrap();

    let count = store.clear_history_with_undo("默认", Some(30)).unwrap().0;
    assert_eq!(count, 2, "没有价值的过期记录照常全清");
}

#[test]
fn test_count_expired_matches_clear_with_preserve() {
    // 一致性约定：设置页的"过期计数"必须 = 实际清理数（豁免后都只算无价值条目）
    let store = make_store();
    let tagged = make_old_item("tag-old", 100);
    let plain = make_old_item("plain-old", 100);
    store.insert_history(&tagged).unwrap();
    store.insert_history(&plain).unwrap();
    {
        let conn = store.lock_conn();
        conn.execute(
            "INSERT INTO tags (id, name, color, source, created_at)
             VALUES ('tg2', '重要', '#ff0000', 'manual', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO history_tags (history_id, tag_id, source) VALUES ('tag-old', 'tg2', 'manual')",
            [],
        )
        .unwrap();
    }

    let counted = store.count_expired_history("默认", 30).unwrap();
    assert_eq!(counted, 1, "计数只算无价值的 plain-old");

    let cleared = store.clear_history_with_undo("默认", Some(30)).unwrap().0;
    assert_eq!(cleared, counted, "计数 = 实际清理数");
}

#[test]
fn test_preserve_toggle_off_clears_valued() {
    // 开关关闭 → 退回旧行为：高价值（打标签/粘贴过/搜索命中）也参与过期清理
    let store = make_store();
    // 关掉「保护常用内容」
    store
        .save_config(&serde_json::json!({ "preserve_valued_content": false }))
        .unwrap();

    let tagged = make_old_item("tag-old", 100);
    let pasted = make_old_item("past-old", 100);
    let searched = make_old_item("hit-old", 100);
    store.insert_history(&tagged).unwrap();
    store.insert_history(&pasted).unwrap();
    store.insert_history(&searched).unwrap();
    {
        let conn = store.lock_conn();
        conn.execute(
            "INSERT INTO tags (id, name, color, source, created_at)
             VALUES ('tg3', '重要', '#ff0000', 'manual', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO history_tags (history_id, tag_id, source) VALUES ('tag-old', 'tg3', 'manual')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE history SET search_hit_count = 1 WHERE id = 'hit-old'",
            [],
        )
        .unwrap();
    }
    store.action_event_add(&paste_event("past-old", "text"));

    let counted = store.count_expired_history("默认", 30).unwrap();
    assert_eq!(counted, 3, "开关关闭时高价值也算过期");

    let cleared = store.clear_history_with_undo("默认", Some(30)).unwrap().0;
    assert_eq!(cleared, 3);
    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result.len(), 0, "全部清空");
}

#[test]
fn test_search_hit_count_increments_on_search() {
    let store = make_store();
    store
        .insert_history(&make_item("find-me", "unique-keyword-xyz", "2026-01-01 10:00:00", "text"))
        .unwrap();

    // 带搜索词的查询命中后计数 +1
    let result = store.search_history("默认", "unique-keyword", "all", "", "", "all", &[], 10).unwrap();
    assert_eq!(result.len(), 1);

    let hit: i32 = store
        .lock_conn()
        .query_row(
            "SELECT search_hit_count FROM history WHERE id = 'find-me'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hit, 1);
}

// ============================================================
// v6.2 场景权重：来源+时段感知
// ============================================================

#[test]
fn test_hour_bucket_and_source_cat() {
    use crate::data_store::{hour_bucket, source_cat};
    assert_eq!(hour_bucket(10), "work");
    assert_eq!(hour_bucket(17), "work");
    assert_eq!(hour_bucket(18), "evening");
    assert_eq!(hour_bucket(23), "evening");
    assert_eq!(hour_bucket(0), "night");
    assert_eq!(hour_bucket(8), "night");

    assert_eq!(source_cat("VS Code"), "ide");
    assert_eq!(source_cat("Chrome"), "browser");
    assert_eq!(source_cat("Terminal"), "terminal");
    assert_eq!(source_cat("微信"), "chat");
    assert_eq!(source_cat("不知名应用"), "other");
}

#[test]
fn test_action_scene_weights_aggregates() {
    let store = make_store();
    // 工作时间（10 点）在 VS Code 复制 json → sql-in
    store.action_event_add(&action_event("sql-in", "json", "VS Code", 10, OUTCOME_COPIED));
    store.action_event_add(&action_event("sql-in", "json", "VS Code", 11, OUTCOME_COPIED));
    // 晚间（21 点）在 Chrome 复制 text → ai-translate
    store.action_event_add(&action_event("ai-translate", "text", "Chrome", 21, OUTCOME_COPIED));
    // 同一场景不同 app 合并（Edge 也归 browser）
    store.action_event_add(&action_event("ai-translate", "text", "Edge", 22, OUTCOME_PASTED));
    // paste 哨兵排除
    store.action_event_add(&paste_event("h-1", "json"));

    let scenes = store.action_scene_weights(30);
    let sql_ide = scenes
        .iter()
        .find(|s| s.action_id == "sql-in" && s.hour_bucket == "work" && s.source_cat == "ide")
        .expect("应聚合出 sql-in×work×ide");
    assert_eq!(sql_ide.count, 2);

    let tr_browser = scenes
        .iter()
        .find(|s| s.action_id == "ai-translate" && s.hour_bucket == "evening" && s.source_cat == "browser")
        .expect("Chrome+Edge 应合并为 browser");
    assert_eq!(tr_browser.count, 2);

    assert!(
        !scenes.iter().any(|s| s.action_id == ACTION_ID_PASTE),
        "粘贴哨兵必须排除在场景权重外"
    );
}

// ============================================================
// v6.4 D 搜索：FTS5 全文索引（中文 bigram）
// ============================================================

#[test]
fn test_to_ngram_chinese_mixed() {
    use crate::data_store::history::to_ngram;
    // 中文 → 每个中文字符的单字 + 相邻二字 bigram（顺序：先单字后 bigram）
    assert_eq!(to_ngram("上周"), "上 上周 周");
    // 中英混排 → ASCII 段原样
    assert_eq!(to_ngram("API文档"), "API 文 文档 档");
    // 3 字 → 单字 + 相邻 bigram
    assert_eq!(to_ngram("复制粘贴"), "复 复制 制 制粘 粘 粘贴 贴");
    // 空串
    assert_eq!(to_ngram(""), "");
}

#[test]
fn test_fts_search_chinese_hit() {
    let store = make_store();
    store
        .insert_history(&make_item("f1", "上周复制的那个API文档地址", "2026-08-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("f2", "这是一条无关的英语内容 hello world", "2026-08-01 11:00:00", "text"))
        .unwrap();

    // 中文关键词走 FTS5 bigram 命中
    let items = store
        .search_history("默认", "复制", "all", "", "", "all", &[], 10)
        .unwrap();
    assert!(items.iter().any(|i| i.id == "f1"), "中文「复制」应命中 f1");

    // 中英混合关键词
    let items = store
        .search_history("默认", "API文档", "all", "", "", "all", &[], 10)
        .unwrap();
    assert!(items.iter().any(|i| i.id == "f1"), "「API文档」应命中 f1");

    // 不相关词不命中
    let items = store
        .search_history("默认", "无关词", "all", "", "", "all", &[], 10)
        .unwrap();
    assert!(!items.iter().any(|i| i.id == "f1"));
}

#[test]
fn test_fts_delete_removes_index() {
    let store = make_store();
    store
        .insert_history(&make_item("f3", "要删除的临时内容", "2026-08-01 12:00:00", "text"))
        .unwrap();
    assert!(!store
        .search_history("默认", "临时内容", "all", "", "", "all", &[], 10)
        .unwrap()
        .is_empty());

    store.delete_history(&["f3".to_string()]).unwrap();
    assert!(store
        .search_history("默认", "临时内容", "all", "", "", "all", &[], 10)
        .unwrap()
        .is_empty(), "删除后 FTS 索引应同步移除");
}

#[test]
fn test_fts_fallback_like_on_special_chars() {
    let store = make_store();
    store
        .insert_history(&make_item("f4", "含(括号)的内容片段", "2026-08-01 13:00:00", "text"))
        .unwrap();

    // 括号是 FTS5 MATCH 语法字符 → fts_safe=false → 回退 LIKE 仍能命中
    let items = store
        .search_history("默认", "(括号", "all", "", "", "all", &[], 10)
        .unwrap();
    assert!(items.iter().any(|i| i.id == "f4"), "特殊字符查询应回退 LIKE 命中");
}

// ============================================================
// X1 B2：自定义动作链（chain_defs 表）
// ============================================================

fn chain_def(name: &str, steps: &[&str]) -> ChainDef {
    ChainDef {
        id: String::new(),
        name: name.to_string(),
        description: String::new(),
        steps: steps
            .iter()
            .map(|t| ChainStepDef {
                transform_id: t.to_string(),
                risk: "local".to_string(),
                label: String::new(),
                condition: None,
            })
            .collect(),
        sort_order: 0,
        created_at: String::new(),
        updated_at: String::new(),
        // 下面两个是后端读出时单向置位的状态（步骤 JSON 已损坏），入参永远是默认值
        steps_corrupted: false,
        steps_raw: String::new(),
    }
}

#[test]
fn test_chain_roundtrip() {
    let store = make_store();
    let id = store
        .chain_save(&chain_def("报错处理", &["strip", "mask-sensitive"]))
        .unwrap();
    assert!(!id.is_empty());

    let list = store.chains().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "报错处理");
    assert_eq!(list[0].steps.len(), 2);
    assert_eq!(list[0].steps[1].transform_id, "mask-sensitive");
    assert_eq!(list[0].steps[0].risk, "local", "risk 要能原样读回");
}

#[test]
fn test_chain_duplicate_name_rejected() {
    // 两条同名链在运行器里分不清，必须在保存时就拦住
    let store = make_store();
    store.chain_save(&chain_def("清洗", &["strip"])).unwrap();
    let err = store.chain_save(&chain_def("清洗", &["upper"])).unwrap_err();
    assert!(err.contains("清洗"), "报错要点出是哪个名字：{}", err);
    assert!(!err.contains("UNIQUE"), "不该把 SQLite 的英文原文抛给用户");
}

#[test]
fn test_chain_empty_or_oversized_steps_rejected() {
    let store = make_store();
    assert!(
        store.chain_save(&chain_def("空链", &[])).unwrap_err().contains("至少"),
        "空步骤链必须被拦"
    );
    let many: Vec<&str> = vec!["strip"; MAX_CHAIN_STEPS + 1];
    let err = store.chain_save(&chain_def("超长", &many)).unwrap_err();
    assert!(err.contains("最多"), "超步数必须被拦：{}", err);
}

#[test]
fn test_chain_bad_risk_rejected() {
    let store = make_store();
    let mut c = chain_def("坏风险", &["strip"]);
    c.steps[0].risk = "hack".to_string();
    let err = store.chain_save(&c).unwrap_err();
    assert!(err.contains("风险"), "非法 risk 必须被拦：{}", err);
}

/// 回归（③）：步骤 JSON 解析失败不能伪装成"空链"。
///
/// 以前 `steps_from_json` 用 `unwrap_or_default()`，于是损坏链仍出现在列表里、
/// 运行时什么都不做、也没报错；用户打开再保存又被"至少要有 1 个步骤"拦住
/// ——既不能用、也不能就地改好，只能删掉重建。
#[test]
fn test_chain_corrupt_steps_flagged_not_silently_empty() {
    let store = make_store();
    let id = store.chain_save(&chain_def("坏链", &["strip"])).unwrap();
    {
        // 模拟"手工改库"/"未来字段调整"：transform_id 是必需字段，缺了整体解析失败
        let conn = store.lock_conn();
        conn.execute(
            "UPDATE chain_defs SET steps = ?2 WHERE id = ?1",
            params![id, r#"[{"risk":"local","label":"去空白"}]"#],
        )
        .unwrap();
    }

    let list = store.chains().unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].steps.is_empty(), "解析不出步骤，确实拿不到可用的 steps");
    assert!(
        list[0].steps_corrupted,
        "必须把「已损坏」标出来，不能和「没步骤」长得一模一样"
    );
    assert!(
        list[0].steps_raw.contains("去空白"),
        "原始 JSON 要留着供用户照着重建，实际：{:?}",
        list[0].steps_raw
    );
}

/// 正常链不能被误标为损坏（上一条的反面：别把守卫做成全面报警）。
#[test]
fn test_chain_normal_steps_not_flagged_corrupted() {
    let store = make_store();
    store.chain_save(&chain_def("正常链", &["strip", "upper"])).unwrap();
    let list = store.chains().unwrap();
    assert_eq!(list[0].steps.len(), 2);
    assert!(!list[0].steps_corrupted);
    assert!(list[0].steps_raw.is_empty(), "没损坏就不必重复带一份原文");
}

/// 回归（④）：INSERT/UPDATE 撞到 UNIQUE 索引时，不能把 SQLite 英文原文抛给用户。
///
/// `test_chain_duplicate_name_rejected` 盖的是"重名守卫"那条路；但守卫本身是一条
/// COUNT 查询，它也会失败，而"检查 → INSERT"之间又有 TOCTOU 窗口。这条直接拿
/// 一个**真实的** UNIQUE 错误去验证兜底翻译，把契约钉在那条路径上。
#[test]
fn test_chain_unique_violation_translated_to_chinese() {
    let store = make_store();
    store.chain_save(&chain_def("清洗", &["strip"])).unwrap();

    // 绕过重名守卫，直接撞 UNIQUE 索引——守卫查询失败 / 并发时走的就是这条路
    let err = {
        let conn = store.lock_conn();
        conn.execute(
            "INSERT INTO chain_defs
                (id, name, description, steps, sort_order, created_at, updated_at)
             VALUES ('other-id', '清洗', '', '[]', 9, '2026-08-10 00:00:00', '2026-08-10 00:00:00')",
            [],
        )
        .unwrap_err()
    };
    let msg = super::chains::map_chain_save_err(err, "清洗");
    assert!(!msg.contains("UNIQUE"), "不该把 SQLite 的英文原文抛给用户：{}", msg);
    assert!(msg.contains("清洗"), "报错要点出是哪个名字：{}", msg);
}

/// 非 UNIQUE 的真错误不能被误报为"重名"（否则用户改名字永远修不好）。
#[test]
fn test_chain_non_unique_error_keeps_original_message() {
    let store = make_store();
    let err = {
        let conn = store.lock_conn();
        conn.execute("INSERT INTO chain_defs_not_exist (id) VALUES ('x')", [])
            .unwrap_err()
    };
    let msg = super::chains::map_chain_save_err(err, "无关名字");
    assert!(msg.contains("保存动作链失败"), "应走通用分支：{}", msg);
    assert!(!msg.contains("换个名字"), "不能把不相关的错误说成重名：{}", msg);
}

#[test]
fn test_chain_delete_and_reorder() {
    let store = make_store();
    let a = store.chain_save(&chain_def("A链", &["strip"])).unwrap();
    let b = store.chain_save(&chain_def("B链", &["upper"])).unwrap();

    store.chains_reorder(&[b.clone(), a.clone()]).unwrap();
    let list = store.chains().unwrap();
    assert_eq!(list[0].id, b, "重排后 B 在前");
    assert_eq!(list[1].id, a);

    store.chain_delete(&a).unwrap();
    let list = store.chains().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, b);
}

#[test]
fn test_chain_update_keeps_id_and_allows_same_name() {
    let store = make_store();
    let id = store.chain_save(&chain_def("邮件链", &["strip"])).unwrap();

    let mut edit = chain_def("邮件链", &["strip", "mask-sensitive"]);
    edit.id = id.clone();
    // 改自己时不该被自己的名字挡住
    let same = store.chain_save(&edit).unwrap();
    assert_eq!(same, id);

    let got = store.chains().unwrap().pop().unwrap();
    assert_eq!(got.steps.len(), 2, "步骤更新应生效");
    assert_eq!(store.chains().unwrap().len(), 1, "不该多出一条");
}



// ============================================================
// M3 偏好学习：ai_feedback + action_prefs
// ============================================================

fn fb(action: &str, outcome: &str) -> AiFeedback {
    AiFeedback {
        action_id: action.to_string(),
        content_type: "text".to_string(),
        outcome: outcome.to_string(),
        result_hash: "hash1".to_string(),
    }
}

#[test]
fn test_ai_feedback_stats_aggregates_and_edit_rate() {
    let store = make_store();
    // 4 次调用：2 次直接复制(accepted) + 2 次改过(edited)
    store.ai_feedback_add(&fb("ai-translate", FEEDBACK_ACCEPTED));
    store.ai_feedback_add(&fb("ai-translate", FEEDBACK_ACCEPTED));
    store.ai_feedback_add(&fb("ai-translate", FEEDBACK_EDITED));
    store.ai_feedback_add(&fb("ai-translate", FEEDBACK_EDITED));
    // 另一个动作只 1 次
    store.ai_feedback_add(&fb("ai-summarize", FEEDBACK_ACCEPTED));

    let stats = store.ai_feedback_stats(30).unwrap();
    assert_eq!(stats.len(), 2);
    let t = stats.iter().find(|s| s.action_id == "ai-translate").unwrap();
    assert_eq!(t.total, 4);
    assert_eq!(t.accepted, 2);
    assert_eq!(t.edited, 2);
    assert!((t.edit_rate - 0.5).abs() < 1e-9, "edit_rate 应为 0.5：{}", t.edit_rate);
}

#[test]
fn test_ai_feedback_ignores_unknown_outcome() {
    let store = make_store();
    store.ai_feedback_add(&fb("ai-translate", "weird"));
    assert_eq!(store.ai_feedback_stats(30).unwrap().len(), 0, "非法 outcome 不入库");
}

#[test]
fn test_ai_feedback_clear_and_days_window() {
    let store = make_store();
    store.ai_feedback_add(&fb("ai-translate", FEEDBACK_EDITED));
    let n = store.ai_feedback_clear().unwrap();
    assert_eq!(n, 1);
    assert_eq!(store.ai_feedback_stats(30).unwrap().len(), 0);
}

#[test]
fn test_action_pref_roundtrip_and_clear() {
    let store = make_store();
    // 未设置 → 空串
    assert_eq!(store.action_pref_get("ai-translate").unwrap(), "");

    store.action_pref_set("ai-translate", "译文更简洁").unwrap();
    assert_eq!(store.action_pref_get("ai-translate").unwrap(), "译文更简洁");

    // 空串 = 清除
    store.action_pref_set("ai-translate", "  ").unwrap();
    assert_eq!(store.action_pref_get("ai-translate").unwrap(), "");

    // prefs_all
    store.action_pref_set("ai-translate", "A").unwrap();
    store.action_pref_set("ai-summarize", "B").unwrap();
    let all = store.action_prefs_all().unwrap();
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|r| r.action_id == "ai-summarize" && r.preference == "B"));
}

// ============================================================
// 偏好自荐：pref_signals + pref_signal_done
// ============================================================

/// 白名单是“只落标签不落内容”这条红线的**唯一**保障，必须有测试盯。
///
/// 假设前端有 bug，把用户改过的正文当“特征”传上来——它必须落不进表，
/// 否则这张表就变成了用户不知情的第二份剪贴板历史。
#[test]
fn test_pref_signal_rejects_non_whitelisted_feature() {
    let store = make_store();
    let bogus = vec![
        "这是用户改过的译文正文，不应该落库".to_string(),
        "SHORTER".to_string(), // 大小写不对也不算
        "".to_string(),
    ];
    for _ in 0..5 {
        store.pref_signal_add("ai-translate", &bogus);
    }
    assert!(
        store.pref_signal_top("ai-translate").unwrap().is_none(),
        "非白名单特征不得入表，更不得攒成建议"
    );
}

#[test]
fn test_pref_signal_needs_min_count() {
    let store = make_store();
    let f = vec!["shorter".to_string()];
    // 差一次不提议——一两次改动是偶然，不是习惯
    for _ in 0..(crate::data_store::PREF_SIGNAL_MIN_COUNT - 1) {
        store.pref_signal_add("ai-translate", &f);
    }
    assert!(store.pref_signal_top("ai-translate").unwrap().is_none());

    store.pref_signal_add("ai-translate", &f);
    let top = store.pref_signal_top("ai-translate").unwrap().expect("达阈后应该有建议");
    assert_eq!(top.feature, "shorter");
    assert_eq!(top.count, crate::data_store::PREF_SIGNAL_MIN_COUNT);
}

#[test]
fn test_pref_signal_top_picks_strongest_and_is_per_action() {
    let store = make_store();
    for _ in 0..3 {
        store.pref_signal_add("ai-translate", &vec!["shorter".to_string()]);
    }
    for _ in 0..5 {
        store.pref_signal_add("ai-translate", &vec!["dropped_greeting".to_string()]);
    }
    // 同一动作上取次数最多的那个
    let top = store.pref_signal_top("ai-translate").unwrap().unwrap();
    assert_eq!(top.feature, "dropped_greeting");
    assert_eq!(top.count, 5);
    // 别的动作不受影响（偏好是按动作存的）
    assert!(store.pref_signal_top("ai-rewrite").unwrap().is_none());
}

#[test]
fn test_pref_signal_done_stops_suggesting() {
    let store = make_store();
    for _ in 0..4 {
        store.pref_signal_add("ai-translate", &vec!["shorter".to_string()]);
    }
    assert!(store.pref_signal_top("ai-translate").unwrap().is_some());

    // 用户否决（或接受）后不再提
    store.pref_signal_done("ai-translate", "shorter").unwrap();
    assert!(
        store.pref_signal_top("ai-translate").unwrap().is_none(),
        "已处理的 (动作,特征) 不得重复提议"
    );

    // 但同一动作的**另一个方向**仍能提——否决的是那一条，不是整个动作
    for _ in 0..3 {
        store.pref_signal_add("ai-translate", &vec!["dropped_markdown".to_string()]);
    }
    let top = store.pref_signal_top("ai-translate").unwrap().unwrap();
    assert_eq!(top.feature, "dropped_markdown");
}

#[test]
fn test_pref_signal_done_rejects_invalid() {
    let store = make_store();
    assert!(store.pref_signal_done("ai-translate", "不存在的特征").is_err());
    assert!(store.pref_signal_done("", "shorter").is_err());
}

#[test]
fn test_pref_signal_clear_also_resets_done() {
    let store = make_store();
    for _ in 0..3 {
        store.pref_signal_add("ai-translate", &vec!["shorter".to_string()]);
    }
    store.pref_signal_done("ai-translate", "shorter").unwrap();

    let n = store.pref_signal_clear().unwrap();
    assert_eq!(n, 3, "返回的是删掉的信号数");

    // 清空后重新攒——用户说“忘掉你学到的”就应该真回到初始状态，
    // 包括允许重新提议（否则清空反而永久封死了这条建议）
    for _ in 0..3 {
        store.pref_signal_add("ai-translate", &vec!["shorter".to_string()]);
    }
    assert!(
        store.pref_signal_top("ai-translate").unwrap().is_some(),
        "清空后应允许重新提议"
    );
}

#[test]
fn test_pref_signal_purge_keeps_done_marks() {
    let store = make_store();
    for _ in 0..3 {
        store.pref_signal_add("ai-translate", &vec!["shorter".to_string()]);
    }
    store.pref_signal_done("ai-translate", "shorter").unwrap();

    // retain_days 很大 → 什么都不清
    assert_eq!(store.pref_signal_purge(3650).unwrap(), 0);

    // 否决标记不跟着过期：重新攒够也不应该又开始提
    for _ in 0..5 {
        store.pref_signal_add("ai-translate", &vec!["shorter".to_string()]);
    }
    assert!(
        store.pref_signal_top("ai-translate").unwrap().is_none(),
        "否决应该是永久的，不能隔一阵重新骚扰"
    );
}

// ============================================================
// M5-1 内容记忆：summarize_text + history_summaries
// ============================================================

#[test]
fn test_summarize_text_extracts_domain_email_body() {
    use crate::data_store::summarize_text;
    let s = summarize_text("参考 https://www.github.com/a/b 和 http://docs.rs/rmcp，联系 alice@example.com");
    assert!(s.contains("github.com"), "去 www 的域名：{}", s);
    assert!(s.contains("docs.rs"));
    assert!(s.contains("alice@example.com"));
    assert!(s.contains("正文："));
}

#[test]
fn test_summarize_text_plain_body_only() {
    use crate::data_store::summarize_text;
    let s = summarize_text("这是一段普通的中文文本，没有链接也没有邮箱。");
    assert!(!s.contains("域名："), "不应有域名段");
    assert!(!s.contains("邮箱："), "不应有邮箱段");
    assert!(s.contains("正文："));
}

#[test]
fn test_summarize_text_empty() {
    use crate::data_store::summarize_text;
    assert!(summarize_text("").is_empty());
    assert!(summarize_text("   \n  ").is_empty());
}

#[test]
fn test_history_summary_ensure_and_read() {
    let store = make_store();
    store
        .insert_history(&make_item("m1", "文档 https://docs.rs/rmcp 的用法", "2026-08-10 10:00:00", "text"))
        .unwrap();
    // insert_history 内已同步生成摘要（M5-1 接入）
    let s = store.history_summary("m1").unwrap();
    assert!(s.contains("docs.rs"), "插入时生成的摘要应含域名：{}", s);

    // 幂等：再 ensure 一次不报错
    store.history_summary_ensure("m1", "新文本 https://x.com").unwrap();
    let s2 = store.history_summary("m1").unwrap();
    assert!(s2.contains("x.com"), "ensure 应更新摘要：{}", s2);
}

#[test]
fn test_history_summary_skips_secret() {
    let store = make_store();
    // 密钥内容不生成摘要（指纹也不留）
    store
        .insert_history(&make_item("sec1", concat!("sk-", "abcdef1234567890abcdef1234567890"), "2026-08-10 10:00:00", "text"))
        .unwrap();
    assert_eq!(store.history_summary("sec1").unwrap(), "", "敏感内容不记摘要");
}

#[test]
fn test_history_summaries_backfill_and_clear() {
    let store = make_store();
    // 直接插入（模拟存量历史，无摘要）
    store
        .insert_history(&make_item("b1", "https://example.com/page", "2026-08-01 10:00:00", "text"))
        .unwrap();
    // 手动删掉摘要模拟"存量未回填"（insert 已自动生成，这里清掉再回填验证）
    store.history_summaries_clear().unwrap();

    let n = store.history_summaries_backfill(100).unwrap();
    assert_eq!(n, 1, "应回填 1 条：{n}");
    assert!(store.history_summary("b1").unwrap().contains("example.com"));

    // 清空
    let c = store.history_summaries_clear().unwrap();
    assert_eq!(c, 1);
    assert_eq!(store.history_summaries_count().unwrap(), 0, "清空后计数为 0");
    // 清空后不自动补存量
    assert_eq!(store.history_summaries_backfill(100).unwrap(), 0, "清空后不补存量");
}

// ============================================================
// M5-2 语义向量：cosine_sim + 存取 + pending + 清空联动
// ============================================================

#[test]
fn test_cosine_sim_basics() {
    use crate::data_store::cosine_sim;
    // 相同向量 → 1
    let a = [1.0f32, 0.0, 0.0];
    assert!((cosine_sim(&a, &a) - 1.0).abs() < 1e-6);
    // 正交 → 0
    let b = [0.0f32, 1.0, 0.0];
    assert!((cosine_sim(&a, &b)).abs() < 1e-6);
    // 相反 → -1
    let c = [-1.0f32, 0.0, 0.0];
    assert!((cosine_sim(&a, &c) + 1.0).abs() < 1e-6);
    // 维度不一致 / 空 → 0
    assert_eq!(cosine_sim(&a, &[1.0, 0.0]), 0.0);
    assert_eq!(cosine_sim(&[], &[]), 0.0);
    // 归一化后余弦 = 点积
    let x = [3.0f32, 4.0];
    let y = [1.0f32, 0.0];
    assert!((cosine_sim(&x, &y) - 0.6).abs() < 1e-6);
}

#[test]
fn test_vector_encode_decode_roundtrip() {
    use crate::data_store::{decode_vec, encode_vec};
    let v = vec![0.5f32, -1.25, 3.75, 0.0, 42.0];
    let bytes = encode_vec(&v);
    assert_eq!(bytes.len(), v.len() * 4);
    assert_eq!(decode_vec(&bytes), v);
}

#[test]
fn test_semantic_vector_set_count_pending_search() {
    let store = make_store();
    // 两条历史，insert 时生成摘要
    store
        .insert_history(&make_item("s1", "参考 https://docs.rs/rmcp 的用法", "2026-08-10 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("s2", "买菜的清单：西红柿 鸡蛋 牛奶", "2026-08-10 10:05:00", "text"))
        .unwrap();

    // pending = 有摘要无向量的（2 条）
    let pending = store.semantic_vector_pending(10).unwrap();
    assert_eq!(pending.len(), 2);

    // 向量化 s1
    let v1 = vec![1.0f32, 0.0, 0.0];
    store.semantic_vector_set("s1", "test-model", &v1).unwrap();
    assert_eq!(store.semantic_vectors_count().unwrap(), 1);
    // pending 只剩 s2
    let pending = store.semantic_vector_pending(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].0, "s2");

    // s2 用不同向量；搜索用与 s1 相近的向量 → s1 命中
    store
        .semantic_vector_set("s2", "test-model", &vec![0.9f32, 0.1, 0.0])
        .unwrap();
    let hits = store.semantic_search_vectors(&vec![0.99f32, 0.01, 0.0], 5).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].0, "s1", "s1 应与查询向量更接近");
    assert!(hits[0].1 > hits[1].1, "分数应降序");
    // 命中带 created_at（join history）
    assert!(!hits[0].2.is_empty());
}

#[test]
fn test_semantic_clear_follows_summaries_clear() {
    let store = make_store();
    store
        .insert_history(&make_item("c1", "https://example.com/page", "2026-08-10 10:00:00", "text"))
        .unwrap();
    store
        .semantic_vector_set("c1", "test-model", &vec![1.0f32, 0.0])
        .unwrap();
    assert_eq!(store.semantic_vectors_count().unwrap(), 1);

    // 清空摘要 → 向量一并清空（红线②：删摘要 = 删向量）
    let n = store.history_summaries_clear().unwrap();
    assert_eq!(n, 1);
    assert_eq!(store.semantic_vectors_count().unwrap(), 0);
}

// ============================================================
// M6-2 画像原料聚合：profile_raw_stats
// ============================================================

#[test]
fn test_profile_raw_stats_aggregates() {
    let store = make_store();
    // 造两条动作事件：developer 倾向（解释代码 + json 格式化）
    use crate::data_store::action_events::ActionEvent;
    store.action_event_add(&ActionEvent {
        action_id: "ai-explain-code".to_string(),
        content_type: "code".to_string(),
        source_app: "vscode".to_string(),
        hour: 10,
        outcome: "copied".to_string(),
        history_id: None,
        // v6.15 X3 埋点字段：测试不关心，一律 None
        paste_index: None,
        target_cat: None,
    });
    store.action_event_add(&ActionEvent {
        action_id: "json_format".to_string(),
        content_type: "json".to_string(),
        source_app: "vscode".to_string(),
        hour: 10,
        outcome: "pasted".to_string(),
        history_id: None,
        // v6.15 X3 埋点字段：测试不关心，一律 None
        paste_index: None,
        target_cat: None,
    });

    let raw = store.profile_raw_stats(30).unwrap();
    assert_eq!(raw.total_events, 2);
    assert!(raw.action_counts.iter().any(|(a, c)| a == "ai-explain-code" && *c == 1));
    assert!(raw.content_type_counts.iter().any(|(ct, c)| ct == "code" && *c == 1));
    // 时段：10 点 → hour_counts 有 (10, 2)
    assert!(raw.hour_counts.iter().any(|(h, c)| *h == 10 && *c == 2));
}

#[test]
fn test_profile_raw_stats_excludes_paste_sentinel() {
    let store = make_store();
    // paste 哨兵不应计入画像统计
    use crate::data_store::action_events::ActionEvent;
    store.action_event_add(&ActionEvent {
        action_id: "paste".to_string(),
        content_type: "text".to_string(),
        source_app: "".to_string(),
        hour: 9,
        outcome: "pasted".to_string(),
        history_id: None,
        // v6.15 X3 埋点字段：测试不关心，一律 None
        paste_index: None,
        target_cat: None,
    });
    let raw = store.profile_raw_stats(30).unwrap();
    assert_eq!(raw.total_events, 0, "paste 哨兵不计入画像");
}

// ============================================================
// V3-B 程序性记忆：sequence_mining
// ============================================================

#[test]
fn test_sequence_mining_finds_repeated_pattern() {
    let store = make_store();
    use crate::data_store::action_events::ActionEvent;
    // 同样的两段式流程出现 4 次：解释代码 → 提取要点
    for _ in 0..4 {
        store.action_event_add(&ActionEvent {
            action_id: "ai-explain-code".to_string(),
            content_type: "code".to_string(),
            source_app: "".to_string(),
            hour: 10,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
        store.action_event_add(&ActionEvent {
            action_id: "ai-extract-points".to_string(),
            content_type: "code".to_string(),
            source_app: "".to_string(),
            hour: 10,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
    }

    let pats = store.sequence_mining(30, 3, 4).unwrap();
    assert!(
        pats.iter().any(|p| p.actions == ["ai-explain-code", "ai-extract-points"]),
        "应挖出 解释代码→提取要点：{:?}",
        pats.iter().map(|p| &p.actions).collect::<Vec<_>>()
    );
    let p = pats
        .iter()
        .find(|p| p.actions == ["ai-explain-code", "ai-extract-points"])
        .unwrap();
    assert_eq!(p.count, 4);
    assert!(!p.last_used.is_empty(), "应记录最后一次使用时间");
}

#[test]
fn test_sequence_mining_ignores_taps_and_sentinel() {
    let store = make_store();
    use crate::data_store::action_events::ActionEvent;
    // 连点 8 次同一动作（手抖/重复触发）→ 不应挖出 [a,a] 模式
    for _ in 0..8 {
        store.action_event_add(&ActionEvent {
            action_id: "ai-translate".to_string(),
            content_type: "text".to_string(),
            source_app: "".to_string(),
            hour: 9,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
    }
    // paste 哨兵不计入
    store.action_event_add(&ActionEvent {
        action_id: "paste".to_string(),
        content_type: "text".to_string(),
        source_app: "".to_string(),
        hour: 9,
        outcome: "pasted".to_string(),
        history_id: None,
        // v6.15 X3 埋点字段：测试不关心，一律 None
        paste_index: None,
        target_cat: None,
    });

    let pats = store.sequence_mining(30, 3, 4).unwrap();
    assert!(pats.is_empty(), "连续重复与哨兵都不应产生模式：{:?}", pats);
}

#[test]
fn test_sequence_mining_below_threshold() {
    let store = make_store();
    use crate::data_store::action_events::ActionEvent;
    // 只出现 2 次，低于阈值 3 → 不返回
    for _ in 0..2 {
        store.action_event_add(&ActionEvent {
            action_id: "ai-summarize".to_string(),
            content_type: "text".to_string(),
            source_app: "".to_string(),
            hour: 11,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
        store.action_event_add(&ActionEvent {
            action_id: "ai-reply-draft".to_string(),
            content_type: "text".to_string(),
            source_app: "".to_string(),
            hour: 11,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
    }
    assert!(store.sequence_mining(30, 3, 4).unwrap().is_empty());
}

/// 用指定的 created_at 插一条动作事件。
///
/// 为什么不用 `action_event_add`：它只会写"现在"，而序列挖掘的时间边界判定
/// 必须能造出**跨天**与**同一分钟**两种间隔。现有三条序列测试都在同一瞬间
/// 连续插入，结构上无法暴露跨会话拼接的问题。
fn insert_action_event_at(store: &DataStore, created_at: &str, action_id: &str, hour: i64) {
    let conn = store.lock_conn();
    conn.execute(
        "INSERT INTO action_events (created_at, action_id, content_type, source_app, hour, outcome)
         VALUES (?1, ?2, 'text', '', ?3, 'copied')",
        params![created_at, action_id, hour],
    )
    .unwrap();
}

/// 日期字符串：今天往前 n 天的 `YYYY-MM-DD`。
fn day_ago(n: i64) -> String {
    (chrono::Local::now() - chrono::Duration::days(n))
        .format("%Y-%m-%d")
        .to_string()
}

/// 转移表：连着做够次数就计入，且分次数可靠。
#[test]
fn test_sequence_transitions_counts_pairs() {
    let store = make_store();
    let day = day_ago(1);
    // 四次「解释代码 → 提取要点」，每对隔一小时（对内 30 秒，没跨会话）
    for h in 10..14 {
        insert_action_event_at(&store, &format!("{} {:02}:00:00", day, h), "ai-explain-code", h);
        insert_action_event_at(&store, &format!("{} {:02}:00:30", day, h), "ai-extract-points", h);
    }

    let ts = store.sequence_transitions(30, 3).unwrap();
    let hit = ts
        .iter()
        .find(|t| t.from == "ai-explain-code" && t.to == "ai-extract-points")
        .unwrap_or_else(|| panic!("应挖出该转移，实际：{:?}", ts));
    assert_eq!(hit.count, 4);
    // 反向对在顺序上也出现了 3 次（上一对的尾 → 下一对的头），
    // 但那中间隔了一小时，跨了会话间隔——不能算。
    assert!(
        !ts.iter()
            .any(|t| t.from == "ai-extract-points" && t.to == "ai-explain-code"),
        "跨会话的反向拼接不能成为转移：{:?}",
        ts
    );
}

/// 转移表与 `sequence_mining` 共用同一套规则：跨天伪相邻一律不算。
///
/// 单独再验一遍而不是“反正共用了 SessionBreaks”：两个函数现在是共享取数，
/// 但循环里的连续性判定是各写一遍的——漏写一行就会静默地把跨天对算进去。
#[test]
fn test_sequence_transitions_rejects_cross_day_pair() {
    let store = make_store();
    for i in 0..4 {
        let evening = day_ago(8 - i);
        let morning = day_ago(7 - i);
        insert_action_event_at(&store, &format!("{} 18:00:00", evening), "ai-weekly-report", 18);
        insert_action_event_at(&store, &format!("{} 09:00:00", morning), "ai-explain-code", 9);
    }
    // 防空跑：事件必须真的在 30 天窗口内，否则下面的 is_empty() 什么也没验到
    assert_eq!(store.action_event_stats(30).total, 8);
    assert!(
        store.sequence_transitions(30, 3).unwrap().is_empty(),
        "跨天的伪相邻不能成为转移"
    );
}

/// 转移表：低于阈值不返回，自转移（手抖重复）不计。
#[test]
fn test_sequence_transitions_threshold_and_self_loop() {
    let store = make_store();
    let day = day_ago(1);
    // A→B 只出现 2 次（< 3）
    for h in 10..12 {
        insert_action_event_at(&store, &format!("{} {:02}:00:00", day, h), "ai-summarize", h);
        insert_action_event_at(&store, &format!("{} {:02}:00:30", day, h), "ai-reply-draft", h);
    }
    // 同一动作连点 6 次（相邻自转移 5 次，足够过阈值，但不应计入）
    for i in 0..6 {
        insert_action_event_at(&store, &format!("{} 15:00:{:02}", day, i * 5), "ai-translate", 15);
    }

    let ts = store.sequence_transitions(30, 3).unwrap();
    assert!(
        !ts.iter().any(|t| t.from == "ai-summarize"),
        "出现 2 次低于阈值 3，不应返回：{:?}",
        ts
    );
    assert!(
        !ts.iter().any(|t| t.from == t.to),
        "自转移是手抖重复，不是习惯：{:?}",
        ts
    );
}

/// 回归（①）：跨天的两个动作**不**构成序列。
///
/// 这是本轮最严重的一条：以前滑动窗口只看动作顺序、不看时间，所以
/// 「下班前最后跑周报」+「次日开工首个解释代码」会被拼成一个合法的 [A,B] 窗口，
/// 攒够 min_count 后运行器顶部就会冒出「发现你的高频操作：生成周报 → 解释代码」
/// ——而这两步他从来没连着做过。
#[test]
fn test_sequence_mining_rejects_cross_day_pair() {
    let store = make_store();
    // 4 次“每天收工跑周报 → 次日开工解释代码”：顺序上相邻，但隔了 15 小时
    for i in 0..4 {
        let evening = day_ago(8 - i);
        let morning = day_ago(7 - i);
        insert_action_event_at(&store, &format!("{} 18:00:00", evening), "ai-weekly-report", 18);
        insert_action_event_at(&store, &format!("{} 09:00:00", morning), "ai-explain-code", 9);
    }

    // 防此条测试“空跑”：若事件根本没插进去 / 掉到统计窗口外，
    // 下面的 is_empty() 也会“通过”，但什么都没验证到。
    assert_eq!(
        store.action_event_stats(30).total,
        8,
        "8 条事件必须真的在 30 天统计窗口内，否则下面的断言是空跑"
    );

    let pats = store.sequence_mining(30, 3, 4).unwrap();
    assert!(
        pats.is_empty(),
        "跨天的“伪相邻”不能成为序列（修之前这里会挖出 [周报, 解释代码] × 4），\
         实际挖出：{:?}",
        pats.iter().map(|p| (&p.actions, p.count)).collect::<Vec<_>>()
    );
}

/// 回归（①反面）：同一分钟内连续的动作仍然构成序列。
///
/// 间隔闸不能把真序列一起切死。同时验证：每对之间隔了一小时，所以反向的
/// [B,A]（跨对拼接）即使在顺序上出现 3 次，也不得被当成模式。
#[test]
fn test_sequence_mining_accepts_same_minute_pair() {
    let store = make_store();
    let day = day_ago(1);
    for h in 10..14 {
        insert_action_event_at(&store, &format!("{} {:02}:00:00", day, h), "ai-explain-code", h);
        insert_action_event_at(&store, &format!("{} {:02}:00:30", day, h), "ai-extract-points", h);
    }

    let pats = store.sequence_mining(30, 3, 4).unwrap();
    let p = pats
        .iter()
        .find(|p| p.actions == ["ai-explain-code", "ai-extract-points"])
        .unwrap_or_else(|| {
            panic!(
                "同一分钟内的连续动作必须仍然构成序列，实际：{:?}",
                pats.iter().map(|p| &p.actions).collect::<Vec<_>>()
            )
        });
    assert_eq!(p.count, 4);
    assert!(!p.last_used.is_empty(), "last_used 要指到真存在的那次连续操作");
    assert!(
        !pats
            .iter()
            .any(|p| p.actions == ["ai-extract-points", "ai-explain-code"]),
        "隔了 1 小时的跨对拼接不能算模式：{:?}",
        pats.iter().map(|p| (&p.actions, p.count)).collect::<Vec<_>>()
    );
}

/// 回归（②）：`abandoned` 不计入 action_counts / total_events。
///
/// 漏了 outcome 过滤的后果：用户**反复尝试又放弃**的动作会抬高角色权重，
/// 还抬高 sample_events / confidence——越放弃，画像越“自信”。
#[test]
fn test_profile_raw_stats_excludes_abandoned() {
    let store = make_store();
    store.action_event_add(&action_event("ai-polish", "text", "Word", 10, OUTCOME_COPIED));
    store.action_event_add(&action_event("ai-polish", "text", "Word", 10, OUTCOME_PASTED));
    // 同一个动作反复尝试又放弃 3 次
    for _ in 0..3 {
        store.action_event_add(&action_event("ai-polish", "text", "Word", 10, OUTCOME_ABANDONED));
    }

    let raw = store.profile_raw_stats(30).unwrap();
    let c = raw
        .action_counts
        .iter()
        .find(|(a, _)| a == "ai-polish")
        .map(|(_, c)| *c)
        .unwrap_or(0);
    assert_eq!(c, 2, "只计 copied + pasted，abandoned 不计入动作频率");
    assert_eq!(raw.total_events, 2, "abandoned 不能抬高样本量 / 置信度");
    assert_eq!(
        raw.content_type_counts
            .iter()
            .find(|(ct, _)| ct == "text")
            .map(|(_, c)| *c)
            .unwrap_or(0),
        2,
        "内容类型分布同样要排除 abandoned"
    );
}

/// 不变量（②）：`action_counts` 与 `hour_counts` 的 WHERE 必须完全一致。
///
/// 命令层算时段百分比时用 `total_events`（= action_counts 求和）做分母、
/// `hour_counts` 做分子；两条 WHERE 一旦错位，时段占比之和就不再是 100%。
/// （注：total_events 是分母，hour_counts 是分子。）
#[test]
fn test_profile_raw_stats_hour_counts_match_total_events() {
    let store = make_store();
    store.action_event_add(&action_event("ai-polish", "text", "Word", 9, OUTCOME_COPIED));
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 14, OUTCOME_PASTED));
    store.action_event_add(&action_event("sql-in", "json", "VSCode", 14, OUTCOME_ABANDONED));
    store.action_event_add(&paste_event("h-1", "text"));

    let raw = store.profile_raw_stats(30).unwrap();
    let hour_sum: u32 = raw.hour_counts.iter().map(|(_, c)| *c).sum();
    assert_eq!(
        hour_sum, raw.total_events,
        "hour_counts 总和必须等于 total_events（否则时段百分比的分母对不上）：\
         hour_counts={:?}, total_events={}",
        raw.hour_counts, raw.total_events
    );
}

// ============================================================
// v6.8：粘性数据（活跃日历 / 连续周数 / 成就 / 里程碑）
// ============================================================

/// 在指定天数前插入一条 action_event（直接 SQL 指定 created_at）
fn insert_event_on(store: &DataStore, days_ago: i64, action: &str, ct: &str) {
    let ts = (chrono::Local::now() - chrono::Duration::days(days_ago))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let conn = store.lock_conn();
    conn.execute(
        "INSERT INTO action_events (created_at, action_id, content_type, source_app, hour, outcome)
         VALUES (?1, ?2, ?3, 'Test', 10, 'copied')",
        params![ts, action, ct],
    )
    .unwrap();
}

fn insert_usage(store: &DataStore, action_id: &str) {
    store.ai_usage_add(&AiUsageEntry {
        action_id: action_id.to_string(),
        provider: "test".to_string(),
        model: "test".to_string(),
        prompt_tokens: 1,
        completion_tokens: 1,
        cost_usd: 0.0,
        cached: false,
        latency_ms: 0,
        ok: true,
        error: None,
    });
}

fn insert_chain(store: &DataStore, id: &str) {
    let conn = store.lock_conn();
    conn.execute(
        "INSERT INTO chain_defs (id, name, description, steps, sort_order, created_at, updated_at)
         VALUES (?1, ?1, '', '[]', 0, datetime('now'), datetime('now'))",
        params![id],
    )
    .unwrap();
}

#[test]
fn test_sticky_empty() {
    let store = make_store();
    let s = store.sticky_stats();
    assert_eq!(s.calendar.len(), 84, "日历必须是完整 84 天");
    assert!(s.calendar.iter().all(|d| d.count == 0));
    assert_eq!(s.active_days, 0);
    assert_eq!(s.active_week_streak, 0);
    assert_eq!(s.history_count, 0);
    assert!(s.first_history_at.is_none());
    assert_eq!(s.custom_chain_count, 0);
    assert!(!s.ai_used && !s.tool_used && !s.triage_used && !s.profile_exported && !s.profile_refined);
}

#[test]
fn test_sticky_calendar_and_streak() {
    let store = make_store();
    // 今天 + 昨天 + 前天
    insert_event_on(&store, 0, "ai-summarize", "text");
    insert_event_on(&store, 1, "sql-in", "text");
    insert_event_on(&store, 2, "json_format", "json");
    // 连续三周活跃（本周 / 上周 / 上上周，7 天步长落点同星期几）
    insert_event_on(&store, 0, "mask-sensitive", "text");
    insert_event_on(&store, 7, "mask-sensitive", "text");
    insert_event_on(&store, 14, "mask-sensitive", "text");

    let s = store.sticky_stats();
    assert_eq!(s.calendar.len(), 84);
    // 今天/昨天/前天 + 上周同日 + 上上周同日（streak 用），都在 84 天窗口内
    assert_eq!(s.active_days, 5, "3 个近期日 + 2 个周间隔日");
    // 今天 count = 2（ai-summarize + mask-sensitive）
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let today_entry = s.calendar.iter().find(|d| d.date == today).unwrap();
    assert_eq!(today_entry.count, 2);
    // 最后一天是今天
    assert_eq!(s.calendar.last().unwrap().date, today);
    assert_eq!(s.active_week_streak, 3, "本周/上周/上上周连续活跃");
}

#[test]
fn test_sticky_streak_breaks_with_gap() {
    let store = make_store();
    // 本周 + 上上周（上周缺）→ 连续中断，streak 只算本周 = 1
    insert_event_on(&store, 0, "a", "text");
    insert_event_on(&store, 14, "a", "text");
    let s = store.sticky_stats();
    assert_eq!(s.active_week_streak, 1, "上周缺口 → 连续中断");
}

#[test]
fn test_sticky_achievements_and_milestones() {
    let store = make_store();
    // 成就布尔：AI 用过 / 生成工具用过 / 排错链跑过 / 画像精炼过
    insert_usage(&store, "ai-translate");
    insert_usage(&store, "ai-sql-generate");
    insert_usage(&store, "profile-refine");
    insert_event_on(&store, 0, "error-triage", "chain");
    insert_event_on(&store, 0, "profile-export", "");
    // 自定义链 2 条
    insert_chain(&store, "chain-a");
    insert_chain(&store, "chain-b");
    // history 3 条（第一条是过去时间 → first_history_at 应取最早）
    store
        .insert_history(&make_item("h-old", "最早", "2026-01-05 09:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("h-mid", "中间", "2026-02-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("h-new", "最近", "2026-08-01 11:00:00", "text"))
        .unwrap();

    let s = store.sticky_stats();
    assert!(s.ai_used, "ai_translate 在 ai_usage_log → ai_used");
    assert!(s.tool_used, "ai-sql-generate 在 ai_usage_log → tool_used");
    assert!(s.triage_used, "error-triage/chain 在 action_events → triage_used");
    assert!(s.profile_exported, "profile-export 在 action_events → exported");
    assert!(s.profile_refined, "profile-refine 在 ai_usage_log → refined");
    assert_eq!(s.custom_chain_count, 2);
    assert_eq!(s.history_count, 3);
    assert_eq!(s.first_history_at.as_deref(), Some("2026-01-05 09:00:00"));
}

#[test]
fn test_sticky_ai_used_via_action_events() {
    let store = make_store();
    // 只在 action_events 里出现过 AI 动作（如通过变换枢纽触发的 ai-merge-polish）
    insert_event_on(&store, 0, "ai-merge-polish", "code");
    let s = store.sticky_stats();
    assert!(s.ai_used);
    assert!(!s.tool_used, "ai-merge-polish 不是生成工具");
}

// ============================================================
// v6.9：免费额度（签到 / 兑换 / 计量）
// ============================================================

/// 把账本签到日期直接改成 N 天前（模拟连续签到 / 断签）
fn set_sign_date(store: &DataStore, days_ago: i64) {
    let ts = (chrono::Local::now() - chrono::Duration::days(days_ago))
        .format("%Y-%m-%d")
        .to_string();
    let conn = store.lock_conn();
    conn.execute("UPDATE ai_quota SET sign_date=?1 WHERE id=1", params![ts])
        .unwrap();
}

#[test]
fn test_quota_init() {
    let store = make_store();
    let q = store.quota_get().unwrap();
    assert_eq!(q.granted, crate::data_store::quota::INITIAL_GRANT);
    assert_eq!(q.sign_added, 0);
    assert_eq!(q.remaining, 100_000);
    assert!(q.can_sign);
    assert_eq!(q.sign_streak, 0);
    assert!(!q.device_id.is_empty());
    // device_id 幂等：再次读取同 id
    let q2 = store.quota_get().unwrap();
    assert_eq!(q2.device_id, q.device_id);
    assert_eq!(q2.granted, q.granted);
}

#[test]
fn test_quota_sign_rewards_streak() {
    let store = make_store();
    // 第 1 天：2 万
    let r1 = store.quota_sign().unwrap();
    assert!(r1.ok);
    assert_eq!(r1.reward, crate::data_store::quota::SIGN_BASE);
    assert_eq!(r1.streak, 1);
    // 同一天重复签到被拒
    let dup = store.quota_sign().unwrap();
    assert!(!dup.ok);

    // 模拟昨天签过 → 第 2 天：3 万
    set_sign_date(&store, 1);
    let r2 = store.quota_sign().unwrap();
    assert_eq!(r2.streak, 2);
    assert_eq!(r2.reward, 30_000);

    // 第 3 天：4 万
    set_sign_date(&store, 1);
    let r3 = store.quota_sign().unwrap();
    assert_eq!(r3.streak, 3);
    assert_eq!(r3.reward, 40_000);

    // 第 4 天起封顶 5 万
    set_sign_date(&store, 1);
    let r4 = store.quota_sign().unwrap();
    assert_eq!(r4.streak, 4);
    assert_eq!(r4.reward, 50_000);

    // 断签：昨天没签（改到 3 天前）→ 重置 streak=1，2 万
    set_sign_date(&store, 3);
    let r5 = store.quota_sign().unwrap();
    assert_eq!(r5.streak, 1);
    assert_eq!(r5.reward, 20_000);
}

#[test]
fn test_quota_sign_capped_at_1m() {
    let store = make_store();
    store.quota_get().unwrap(); // 先触发账本初始化，UPDATE 才会命中行
    // 把签到累计推到接近上限：90 万 - 2 万 = 88 万
    let conn = store.lock_conn();
    conn.execute("UPDATE ai_quota SET sign_added=?1, granted=?2 WHERE id=1",
        params![880_000i64, 980_000i64]).unwrap();
    drop(conn);
    // 再签到：应得 2 万但只剩 2 万空间 → 实际 2 万（此时满 90 万 = 100 万总）
    let r = store.quota_sign().unwrap();
    assert!(r.ok);
    assert_eq!(r.reward, 20_000);
    let q = store.quota_get().unwrap();
    assert_eq!(q.granted, 1_000_000);
    // 再签到：无空间 → 0 到账但 streak 照常
    set_sign_date(&store, 1);
    let r2 = store.quota_sign().unwrap();
    assert!(r2.ok);
    assert_eq!(r2.reward, 0);
    assert_eq!(r2.streak, 2);
}

#[test]
fn test_quota_redeem_ok_and_idempotent() {
    let store = make_store();
    let secret = crate::data_store::quota::redeem_secret();
    let code = crate::data_store::quota::generate_redeem_code("GRP1", 100_000, "20300101", &secret);
    let before = store.quota_get().unwrap().granted;
    let r = store.quota_redeem(&code).unwrap();
    assert!(r.ok);
    assert_eq!(r.amount, 100_000);
    let after = store.quota_get().unwrap().granted;
    assert_eq!(after, before + 100_000);
    // 重复兑换被拒（幂等）
    let dup = store.quota_redeem(&code).unwrap();
    assert!(!dup.ok);
    assert_eq!(store.quota_get().unwrap().granted, after);
}

#[test]
fn test_quota_redeem_invalid_or_expired() {
    let store = make_store();
    let secret = crate::data_store::quota::redeem_secret();
    // 坏码
    assert!(!store.quota_redeem("P1-XXXX-YYYY").unwrap().ok);
    // 签名错误
    let bad = "P1-ABCD10000020300101-deadbeef";
    assert!(!store.quota_redeem(bad).unwrap().ok);
    // 过期码
    let expired = crate::data_store::quota::generate_redeem_code("GRP1", 10_000, "20200101", &secret);
    assert!(!store.quota_redeem(&expired).unwrap().ok);
    // 面额为 0 的码
    let zero = crate::data_store::quota::generate_redeem_code("GRP1", 0, "20300101", &secret);
    assert!(!store.quota_redeem(&zero).unwrap().ok);
    // 兑换失败不改变余额
    let q = store.quota_get().unwrap();
    assert_eq!(q.granted, crate::data_store::quota::INITIAL_GRANT);
}

#[test]
fn test_quota_spend_and_daily_cap() {
    let store = make_store();
    store.quota_get().unwrap(); // 触发初始化
    store.quota_spend(1_000).unwrap();
    let q = store.quota_get().unwrap();
    assert_eq!(q.spent, 1_000);
    assert_eq!(q.remaining, 100_000 - 1_000);
    assert_eq!(q.today_spent, 1_000);
    // 余额不足
    {
        let conn = store.lock_conn();
        conn.execute("UPDATE ai_quota SET granted=500 WHERE id=1", []).unwrap();
    }
    assert!(store.quota_spend(501).is_err());
    assert!(store.quota_spend(500).is_ok());
    // 每日上限
    {
        let conn = store.lock_conn();
        conn.execute("UPDATE ai_quota SET granted=100000000, today_spent=?1 WHERE id=1",
            params![99_999i64]).unwrap();
    }
    assert!(store.quota_spend(2).is_err(), "超过每日 10 万上限");
}

#[test]
fn test_redeem_code_roundtrip_verify() {
    use crate::data_store::quota::{generate_redeem_code, verify_redeem_code};
    let secret = crate::data_store::quota::redeem_secret();
    let code = generate_redeem_code("TEST", 50_000, "20300101", &secret);
    let p = verify_redeem_code(&code, &secret).unwrap();
    assert_eq!(p.batch, "TEST");
    assert_eq!(p.amount, 50_000);
    assert_eq!(p.expiry, "20300101");
    // 大小写不敏感
    assert!(verify_redeem_code(&code.to_lowercase(), &secret).is_some());
    // 篡改 payload → 验签失败
    let tampered = format!("{}-{}", "P1", {
        let payload = "TEST05000020300101";
        let sig = payload; // 占位
        sig
    });
    assert!(verify_redeem_code(&tampered, &secret).is_none());
}

/// G2 测试抓到的真实 bug 回归:同批次批量生成必须序号递增、码唯一;
/// 客户端验签对带序号的 22 位码必须通过。
#[test]
fn test_redeem_seq_uniqueness() {
    use crate::data_store::quota::{generate_redeem_code_seq, verify_redeem_code};
    let secret = crate::data_store::quota::redeem_secret();
    let codes: Vec<String> = (1..=5)
        .map(|i| generate_redeem_code_seq("GRP1", i, 100_000, "20300101", &secret))
        .collect();
    // 5 个码必须两两不同
    for i in 0..codes.len() {
        for j in i + 1..codes.len() {
            assert_ne!(codes[i], codes[j], "序号 {} 与 {} 的码重复", i + 1, j + 1);
        }
    }
    // 每个码都可验签、批次/面额/有效期正确
    for c in &codes {
        let p = verify_redeem_code(c, &secret).expect("带序号码必须可验签");
        assert_eq!(p.batch, "GRP1");
        assert_eq!(p.amount, 100_000);
        assert_eq!(p.expiry, "20300101");
    }
    // 旧 18 位格式(无序号)仍兼容
    let old = crate::data_store::quota::generate_redeem_code("GRP1", 100_000, "20300101", &secret);
    let p = verify_redeem_code(&old, &secret).expect("旧 18 位码必须仍可验签");
    assert_eq!(p.amount, 100_000);
}

#[test]
fn test_quota_check_states() {
    use crate::data_store::quota::{DAILY_SPEND_CAP, QuotaBlock};
    let store = make_store();
    store.quota_get().unwrap(); // 触发初始化
    // 初始：可调用
    assert_eq!(store.quota_check(), Ok(()));
    // 每日上限：今日已用 = cap → DailyCap
    {
        let conn = store.lock_conn();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        conn.execute(
            "UPDATE ai_quota SET today=?1, today_spent=?2 WHERE id=1",
            params![today, DAILY_SPEND_CAP as i64],
        )
        .unwrap();
    }
    assert_eq!(store.quota_check(), Err(QuotaBlock::DailyCap));
    // 余额 0 → Exhausted
    {
        let conn = store.lock_conn();
        conn.execute("UPDATE ai_quota SET granted=0, today_spent=0 WHERE id=1", [])
            .unwrap();
    }
    assert_eq!(store.quota_check(), Err(QuotaBlock::Exhausted));
    // 恢复后可调用
    {
        let conn = store.lock_conn();
        conn.execute("UPDATE ai_quota SET granted=1000 WHERE id=1", []).unwrap();
    }
    assert_eq!(store.quota_check(), Ok(()));
}

// ============================================================
// v6.10 测试规划 G3/G4：画像聚合与序列挖掘边界用例
// ============================================================

#[test]
fn test_profile_raw_stats_empty() {
    let store = make_store();
    let raw = store.profile_raw_stats(30).unwrap();
    assert_eq!(raw.total_events, 0);
    assert!(raw.action_counts.is_empty());
    assert!(raw.content_type_counts.is_empty());
    assert!(raw.hour_counts.is_empty());
    // 窗口=0 不应 panic(容错返回空)
    let raw0 = store.profile_raw_stats(0).unwrap();
    assert_eq!(raw0.total_events, 0);
}

#[test]
fn test_profile_raw_stats_window_truncation() {
    let store = make_store();
    // 两天前的事件:30 天窗口应计入,但 1 天窗口应排除
    let conn = store.lock_conn();
    let ts = (chrono::Local::now() - chrono::Duration::days(2))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    conn.execute(
        "INSERT INTO action_events (created_at, action_id, content_type, source_app, hour, outcome)
         VALUES (?1, 'ai-summarize', 'text', '', 10, 'copied')",
        params![ts],
    ).unwrap();
    drop(conn);
    let w30 = store.profile_raw_stats(30).unwrap();
    assert_eq!(w30.total_events, 1);
    let w1 = store.profile_raw_stats(1).unwrap();
    assert_eq!(w1.total_events, 0, "1 天窗口应排除 2 天前事件");
}

#[test]
fn test_sequence_mining_long_sequence_stable() {
    let store = make_store();
    use crate::data_store::action_events::ActionEvent;
    // 超长同模式序列(50 轮):不应 panic、应稳定找到模式、无重复计数爆表
    for _ in 0..50 {
        store.action_event_add(&ActionEvent {
            action_id: "ai-translate".to_string(),
            content_type: "text".to_string(),
            source_app: "".to_string(),
            hour: 10,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
        store.action_event_add(&ActionEvent {
            action_id: "ai-copy-polish".to_string(),
            content_type: "text".to_string(),
            source_app: "".to_string(),
            hour: 10,
            outcome: "copied".to_string(),
            history_id: None,
            // v6.15 X3 埋点字段：测试不关心，一律 None
            paste_index: None,
            target_cat: None,
        });
    }
    let seqs = store.sequence_mining(30, 3, 4).unwrap();
    // 50 轮 > 阈值,至少出现一次模式;结果数量有上限(不爆表)
    assert!(!seqs.is_empty());
    assert!(seqs.len() <= 10, "序列建议有数量上限(实现 truncate(10))");
}

// ============================================================
// 图片 OCR 缓存（image_ocr_cache）测试
// ============================================================

#[test]
fn test_ocr_text_set_get_and_upsert() {
    let store = make_store();
    // 未识别过 → None（区别于「识别过但无文字」的空串）
    assert_eq!(store.get_ocr_text("C:\\img\\a.png").unwrap(), None);

    // 写入 → 命中
    store.set_ocr_text("C:\\img\\a.png", "hello world").unwrap();
    assert_eq!(
        store.get_ocr_text("C:\\img\\a.png").unwrap(),
        Some("hello world".to_string())
    );

    // 空串 → 识别过但无文字（同样命中，防止反复重试）
    store.set_ocr_text("C:\\img\\b.png", "").unwrap();
    assert_eq!(store.get_ocr_text("C:\\img\\b.png").unwrap(), Some(String::new()));

    // 覆盖写 → upsert 生效（不产生第二行）
    store.set_ocr_text("C:\\img\\a.png", "updated").unwrap();
    assert_eq!(
        store.get_ocr_text("C:\\img\\a.png").unwrap(),
        Some("updated".to_string())
    );
}

#[test]
fn test_ocr_texts_batch_query() {
    let store = make_store();
    store.set_ocr_text("p1", "text one").unwrap();
    store.set_ocr_text("p2", "").unwrap();

    let map = store
        .get_ocr_texts(&["p1".to_string(), "p2".to_string(), "p3".to_string()])
        .unwrap();
    assert_eq!(map.get("p1").map(String::as_str), Some("text one"));
    assert_eq!(map.get("p2").map(String::as_str), Some(""));
    assert!(!map.contains_key("p3"), "未识别过的路径不应出现在结果里");

    // 空输入直接返回空表（避免 IN () 语法错误）
    assert!(store.get_ocr_texts(&[]).unwrap().is_empty());
}

#[test]
fn test_history_query_backfills_ocr_text() {
    let store = make_store();
    // 图片条目：content 是图片路径
    let mut img = make_item("img-1", "[图片] 100x100", "2024-01-01 10:00:00", "image");
    img.content = "C:\\img\\shot.png".to_string();
    store.insert_history(&img).unwrap();

    // 文本条目：与图片条目混在一起，验证只有 image 类型被回填
    let txt = make_item("txt-1", "hello", "2024-01-01 11:00:00", "text");
    store.insert_history(&txt).unwrap();

    // 未识别前：图片条目 ocr_text 为 None
    let before = store.get_history("默认", "all", "", 0, 100).unwrap();
    assert_eq!(
        before.iter().find(|i| i.id == "img-1").unwrap().ocr_text,
        None
    );

    // 识别入库后：get_history 回填 ocr_text（含空串）
    store.set_ocr_text("C:\\img\\shot.png", "识别出的文字").unwrap();
    let after = store.get_history("默认", "all", "", 0, 100).unwrap();
    let hit = after.iter().find(|i| i.id == "img-1").unwrap();
    assert_eq!(hit.ocr_text.as_deref(), Some("识别出的文字"));
    // 文本条目不受影响
    assert_eq!(after.iter().find(|i| i.id == "txt-1").unwrap().ocr_text, None);
}

#[test]
fn test_search_history_backfills_ocr_text() {
    let store = make_store();
    let mut img = make_item("img-1", "[图片] 100x100", "2024-01-01 10:00:00", "image");
    img.content = "C:\\img\\shot.png".to_string();
    store.insert_history(&img).unwrap();
    store.set_ocr_text("C:\\img\\shot.png", "报销单 2024-07").unwrap();

    // 搜索命中（content LIKE 命中文件名）
    let items = store.search_history("默认", "shot", "all", "", "", "", &[], 100).unwrap();
    let hit = items.iter().find(|i| i.id == "img-1").unwrap();
    assert_eq!(hit.ocr_text.as_deref(), Some("报销单 2024-07"));
}

// ============================================================
// 图片 OCR 文本接入全文检索（FTS）
// ============================================================

/// 识别晚于入库：图片先进历史，OCR 文本后到。
/// 后到的文本必须回写 FTS，否则截图里的字永远搜不到。
#[test]
fn test_ocr_text_searchable_after_recognition() {
    let store = make_store();
    let mut img = make_item("img-1", "[图片] 800x600", "2024-01-01 10:00:00", "image");
    // 真实路径是 md5 文件名，本身没有检索价值
    img.content = "C:\\img\\0039a52c11e99d4c9faeba55f9d1d1a2.png".to_string();
    store.insert_history(&img).unwrap();

    store
        .set_ocr_text(&img.content, "季度营收报表 2026 财务部")
        .unwrap();

    let hits = store
        .search_history("默认", "季度营收", "all", "", "", "all", &[], 50)
        .unwrap();
    assert_eq!(hits.len(), 1, "OCR 文本里的词应能搜到这张图");
    assert_eq!(hits[0].id, "img-1");
}

/// 重新识别后旧文本不能残留在索引里（否则搜旧词还能搜到已被更正的图）。
#[test]
fn test_ocr_reindex_replaces_old_text() {
    let store = make_store();
    let mut img = make_item("img-1", "[图片] 800x600", "2024-01-01 10:00:00", "image");
    img.content = "C:\\img\\a.png".to_string();
    store.insert_history(&img).unwrap();

    store.set_ocr_text(&img.content, "错误识别的旧文字").unwrap();
    store.set_ocr_text(&img.content, "更正后的新文字").unwrap();

    let new_hits = store
        .search_history("默认", "更正后", "all", "", "", "all", &[], 50)
        .unwrap();
    assert_eq!(new_hits.len(), 1, "新文本应可搜到");

    let old_hits = store
        .search_history("默认", "错误识别", "all", "", "", "all", &[], 50)
        .unwrap();
    assert!(old_hits.is_empty(), "旧 OCR 文本不应残留在索引里");
}

/// 非图片条目的 content（文件路径）仍要能搜到——只有 image 改喂 OCR 文本。
#[test]
fn test_file_path_still_searchable_for_non_image() {
    let store = make_store();
    let mut f = make_item("file-1", "receivablebill_his.xml", "2024-01-01 10:00:00", "file");
    f.content = "D:\\work\\receivablebill_his.xml".to_string();
    store.insert_history(&f).unwrap();

    let hits = store
        .search_history("默认", "receivablebill", "all", "", "", "all", &[], 50)
        .unwrap();
    assert_eq!(hits.len(), 1, "文件路径检索不受 OCR 改动影响");
    assert_eq!(hits[0].id, "file-1");
}

/// 存量回填：升级前识别过的图片（文本已在 image_ocr_cache、但索引里没有）也要能搜到。
#[test]
fn test_backfill_indexes_existing_ocr_cache() {
    let store = make_store();
    let mut img = make_item("img-1", "[图片] 800x600", "2024-01-01 10:00:00", "image");
    img.content = "C:\\img\\legacy.png".to_string();
    store.insert_history(&img).unwrap();

    // 直接写缓存表，**绕开 set_ocr_text** —— 模拟升级前就已经识别过的存量数据
    {
        let conn = store.lock_conn();
        conn.execute(
            "INSERT INTO image_ocr_cache (image_path, full_text, updated_at) VALUES (?1, ?2, 'x')",
            rusqlite::params![&img.content, "存量识别文本"],
        )
        .unwrap();
    }

    assert!(
        store
            .search_history("默认", "存量识别", "all", "", "", "all", &[], 50)
            .unwrap()
            .is_empty(),
        "回填前搜不到（缓存里有文本，但索引里没有）"
    );

    let n = {
        let conn = store.lock_conn();
        DataStore::backfill_ocr_fts_on(&conn).unwrap()
    };
    assert_eq!(n, 1, "应回填 1 条");

    let hits = store
        .search_history("默认", "存量识别", "all", "", "", "all", &[], 50)
        .unwrap();
    assert_eq!(hits.len(), 1, "回填后应可搜到");
    assert_eq!(hits[0].id, "img-1");
}

// ============================================================
// history_fts 索引正确性（v6.18 修：三个一直被 warn 吞掉的 bug）
// ============================================================

/// 某个 MATCH 在 history_fts 里命中几行
fn fts_match_count(store: &DataStore, kw: &str) -> i64 {
    let conn = store.lock_conn();
    conn.query_row(
        "SELECT COUNT(*) FROM history_fts WHERE history_fts MATCH ?1",
        [crate::data_store::history::to_ngram(kw)],
        |r| r.get(0),
    )
    .unwrap_or(-1)
}

#[test]
fn test_fts_index_receives_new_items() {
    let store = make_store();
    store
        .insert_history(&make_item("n1", "季度营收报表", "2024-01-01 10:00:00", "text"))
        .unwrap();

    // 新条目必须进索引。此前 sync_fts_upsert 用的是 UPSERT，而 FTS5 虚拟表不支持
    // ON CONFLICT —— 语句每次都报错、被 log::warn 吞掉，于是首次建表回填之后
    // 新增的内容从来没进过索引，搜索一直静默退回 LIKE。
    assert_eq!(fts_match_count(&store, "季度营收"), 1);
}

#[test]
fn test_fts_index_cleared_on_delete() {
    let store = make_store();
    store
        .insert_history(&make_item("d1", "待删除的机密备注", "2024-01-01 10:00:00", "text"))
        .unwrap();
    assert_eq!(fts_match_count(&store, "机密备注"), 1, "前置：先得进索引");

    store.delete_history(&["d1".to_string()]).unwrap();

    // 删了就必须从索引里消失。外部内容表时代这条 DELETE 要回读 history 的原始列，
    // 必然失败且被 `let _ =` 吞掉 —— 残留的 token 会在 SQLite 复用 rowid 后
    // 命中新条目（已删内容的文字出现在别人身上）。
    assert_eq!(fts_match_count(&store, "机密备注"), 0);
}

#[test]
fn test_fts_index_replaces_old_text_on_update() {
    let store = make_store();
    store
        .insert_history(&make_item("u1", "原始内容甲", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store.update_history("u1", "改写后内容乙").unwrap();

    // 改写后旧文本不该还能被搜到（UPSERT 失败的年代这里两条都是 0，测不出问题；
    // 改成 DELETE + INSERT 后才真正有「替换」语义）
    assert_eq!(fts_match_count(&store, "原始内容"), 0, "旧文本必须从索引里消失");
    assert_eq!(fts_match_count(&store, "改写后内容"), 1, "新文本必须进索引");
}

#[test]
fn test_fts_external_content_table_is_rebuilt_on_open() {
    let dir = std::env::temp_dir().join(format!("pastepanda_fts_mig_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("clipboard.db");
    let db_path = db.to_string_lossy().to_string();

    // 造一个 v6.18 之前的库：history 有数据，history_fts 是外部内容表。
    {
        let store = DataStore::new(&db_path).unwrap();
        store
            .insert_history(&make_item("m1", "旧库里的季度报表", "2024-01-01 10:00:00", "text"))
            .unwrap();
        let conn = store.lock_conn();
        conn.execute_batch(
            "DROP TABLE IF EXISTS history_fts;
             CREATE VIRTUAL TABLE history_fts USING fts5(
                text, pinyin, content, content='history', content_rowid='rowid');",
        )
        .unwrap();
        // 模拟旧代码「每次启动都全量回填」造成的重复累积：
        // 外部内容表上同一 rowid 可以反复 INSERT 且**不报错**（常规表会 constraint failed），
        // 所以旧库里同一条内容会有 N 份 token，N = 启动次数。
        let rowid: i64 = conn
            .query_row("SELECT rowid FROM history WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        for _ in 0..3 {
            conn.execute(
                "INSERT INTO history_fts (rowid, text, pinyin, content) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![rowid, crate::data_store::history::to_ngram("旧库里的季度报表"), "", ""],
            )
            .unwrap();
        }
    }

    // 重新打开 → 应识别出旧结构、DROP 重建、并全量回填
    let store = DataStore::new(&db_path).unwrap();
    {
        let conn = store.lock_conn();
        // 重建后 COUNT(*) 必须可查（外部内容表上它会报 no such column: T.pinyin，
        // 而旧代码 .unwrap_or(0) 把这个错误吞成 0 —— 于是回填判据恒真、每次启动都全量重跑）
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_fts", [], |r| r.get(0))
            .expect("重建后 COUNT(*) 必须可查");
        assert_eq!(n, 1, "回填后索引应恰好一行，不再有重复累积");
    }
    // 旧库存量内容重建后仍可搜到
    assert_eq!(fts_match_count(&store, "季度报表"), 1);

    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_fts_syncs_rows_with_null_pinyin() {
    let store = make_store();
    store
        .insert_history(&make_item("p1", "拼音列为空的内容", "2024-01-01 10:00:00", "text"))
        .unwrap();
    {
        let conn = store.lock_conn();
        // 真实库里 1214 条有 195 条 pinyin_initials 是 NULL。旧实现用
        // r.get::<_, String> 读它 → 取值报错 → 整条同步失败、只留一行 warn，
        // 于是这 16% 的内容从来没进过索引。
        conn.execute("UPDATE history SET pinyin_initials = NULL WHERE id = 'p1'", [])
            .unwrap();
        // 必须先清索引：insert_history 已经用非 NULL 的拼音同步过一次了，
        // 不清的话那条旧记录还在，即使这次同步失败断言也照样通过（测不出问题）。
        conn.execute_batch("DELETE FROM history_fts;").unwrap();
        store.sync_fts_upsert(&conn, "p1");
    }
    assert_eq!(fts_match_count(&store, "拼音列为空"), 1);
}

#[test]
fn test_fts_backfill_covers_null_pinyin_rows() {
    let store = make_store();
    store
        .insert_history(&make_item("b1", "回填也要认空拼音", "2024-01-01 10:00:00", "text"))
        .unwrap();
    let n = {
        let conn = store.lock_conn();
        conn.execute("UPDATE history SET pinyin_initials = NULL WHERE id = 'b1'", [])
            .unwrap();
        conn.execute_batch("DELETE FROM history_fts;").unwrap();
        DataStore::backfill_history_fts_on(&conn).unwrap()
    };
    assert_eq!(n, 1, "空拼音的行也要算进回填条数");
    assert_eq!(fts_match_count(&store, "空拼音"), 1);
}

#[test]
fn test_fts_delete_clears_backfilled_rows() {
    // 与 test_fts_index_cleared_on_delete 的区别：那条的行是经 insert 时的单条同步
    // 进索引的，本条的行是经**回填**进去的。两条路径都得守——万一将来只改坏回填、
    // 没改坏同步，只有这条会红。（bug 2 当初就发生在「回填进得去、删除删不掉」这个组合上。）
    let store = make_store();
    store
        .insert_history(&make_item("k1", "经回填进索引的内容", "2024-01-01 10:00:00", "text"))
        .unwrap();
    {
        let conn = store.lock_conn();
        conn.execute_batch("DELETE FROM history_fts;").unwrap();
        DataStore::backfill_history_fts_on(&conn).unwrap();
    }
    assert_eq!(fts_match_count(&store, "经回填进"), 1, "前置：回填要能进索引");

    store.delete_history(&["k1".to_string()]).unwrap();
    assert_eq!(fts_match_count(&store, "经回填进"), 0);
}

#[test]
fn test_fts_empty_index_is_refilled_on_next_open() {
    // 迁移是 DROP → CREATE → 回填三步，**不在一个事务里**。若进程在回填完成前挂掉，
    // 下次打开必须自愈（fts_count == 0 → 重新回填）；否则索引会长期空着，
    // 搜索静默退回 LIKE 全表扫，而用户看不到任何异常。
    let dir = std::env::temp_dir().join(format!("pastepanda_fts_heal_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("clipboard.db").to_string_lossy().to_string();

    {
        let store = DataStore::new(&db_path).unwrap();
        store
            .insert_history(&make_item("h1", "中断后要能自愈", "2024-01-01 10:00:00", "text"))
            .unwrap();
        // 模拟「DROP/CREATE 完成但回填没跑完就退出」后的状态：表在、索引空
        let conn = store.lock_conn();
        conn.execute_batch("DELETE FROM history_fts;").unwrap();
    }

    let store = DataStore::new(&db_path).unwrap();
    assert_eq!(fts_match_count(&store, "要能自愈"), 1);

    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_fts_rebuild_leaves_migration_record() {
    // 一次性迁移必须在库里留痕。原因是实测发现的：env_logger 在 RUST_LOG 未设时
    // 默认只放行 error，全项目 170 个 warn / 128 个 info 从来没有输出到任何地方——
    // 那三个 history_fts bug 唯一的报错渠道就是 log::warn!，所以能长期不被发现。
    // 迁移跑过没跑过、跑了几次，只能靠这张表追溯。
    //
    // 同一 name 允许多行：**重复出现本身就是诊断信号**。旧版"每次启动都全量回填"
    // 这个 bug，如果当时有这张表，会直接表现为几十行同名记录。
    let dir = std::env::temp_dir().join(format!("pastepanda_fts_rec_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("clipboard.db").to_string_lossy().to_string();

    {
        let store = DataStore::new(&db_path).unwrap();
        store
            .insert_history(&make_item("r1", "留痕测试内容", "2024-01-01 10:00:00", "text"))
            .unwrap();
        let conn = store.lock_conn();
        conn.execute_batch(
            "DROP TABLE IF EXISTS history_fts;
             CREATE VIRTUAL TABLE history_fts USING fts5(
                text, pinyin, content, content='history', content_rowid='rowid');",
        )
        .unwrap();
    }

    let store = DataStore::new(&db_path).unwrap();
    let conn = store.lock_conn();
    let (name, detail): (String, String) = conn
        .query_row(
            "SELECT name, detail FROM schema_migrations
             WHERE name = 'history_fts_rebuild' ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("重建后必须留下一条 history_fts_rebuild 记录");
    assert_eq!(name, "history_fts_rebuild");
    // detail 要能回答「回填了多少行」，否则记录了也诊断不了
    assert!(detail.contains("rows=1"), "detail 应含回填行数，实际: {}", detail);

    drop(conn);
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

// ============================================================
// 知识库笔记（notes / note_tags / notes_fts）测试
// 规划 §8.1 2️⃣ 建表 + §7 L1 第三路检索
// ============================================================

#[test]
fn test_note_crud_roundtrip() {
    let store = make_store();
    let n = store
        .note_create(Some("h1"), "会议记录", "今天讨论了 API 设计")
        .unwrap();
    assert!(!n.id.is_empty());
    // 新建时 created_at 与 updated_at 必须相同（同一个 ?5 绑两次）
    assert_eq!(n.created_at, n.updated_at);

    let got = store.note_get(&n.id).unwrap().expect("刚建的笔记应该取得到");
    assert_eq!(got.title, "会议记录");
    assert_eq!(got.history_id.as_deref(), Some("h1"));
    assert_eq!(got.source_agent, "", "手动笔记的 source_agent 是空串（D13）");

    store.note_update(&n.id, "会议记录 v2", "改了正文").unwrap();
    let got = store.note_get(&n.id).unwrap().unwrap();
    assert_eq!(got.title, "会议记录 v2");
    assert_eq!(got.created_at, n.created_at, "created_at 不该被 update 改动");

    store.note_delete(&n.id).unwrap();
    assert!(store.note_get(&n.id).unwrap().is_none());
}

#[test]
fn test_soft_deleted_note_is_gone_from_every_entry_point() {
    // 这条用例就是 W1 选「`notes` 加 `deleted_at` 列」而不是另建 `notes_trash` 表的
    // **全部理由**。软删除的失败模式是静默的：漏掉任何一个查询入口，
    // 已删的笔记就只从那一个地方漏出来——不报错、不崩、看代码发现不了。
    // 新增笔记查询时，**这里也要添一行**（规则 #11.1）。
    let store = make_store();
    let f = store.folder_create("工作", None).unwrap();
    seed_candidate(&store, "h-del", "反复找回的内容", "2026-08-01 10:00:00", 5, false);
    let n = store
        .note_create(Some("h-del"), "会议记录", "灰度发布的注意事项")
        .unwrap();
    store.note_set_folder(&n.id, Some(&f.id)).unwrap();
    let opts = crate::data_store::NoteViewOpts::default();

    // 先钓住「删之前确实看得见」——否则下面那堆 assert 可能只是因为根本没建对。
    assert!(store.note_get(&n.id).unwrap().is_some());
    assert_eq!(store.note_count(), 1);
    assert_eq!(store.note_search("会议", "all", &[], 20).unwrap().len(), 1);
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 0);

    store.note_delete(&n.id).unwrap();

    // ① 单条读
    assert!(store.note_get(&n.id).unwrap().is_none(), "note_get");
    // ② 列表 / 计数 / 组头（都走 note_view_from_where）
    assert!(store.note_list("all", &[], 50, 0).unwrap().is_empty(), "note_list all");
    assert!(
        store.note_list(&f.id, &[], 50, 0).unwrap().is_empty(),
        "note_list 按文件夹"
    );
    assert!(
        store.note_list_view("all", &[], &opts, 50, 0).unwrap().is_empty(),
        "note_list_view"
    );
    assert_eq!(store.note_count(), 0, "note_count");
    // ③ FTS 检索
    assert!(store.note_search("会议", "all", &[], 20).unwrap().is_empty(), "note_search");
    // ④ 问答相关度（MCP 的 kb_search 走这条）
    assert!(
        store
            .note_search_relevant("灰度发布怎么做", "all", &[], &opts, 5)
            .unwrap()
            .is_empty(),
        "note_search_relevant"
    );
    // ⑤ 来源卡片反查
    assert!(store.note_by_history("h-del").unwrap().is_none(), "note_by_history");
    assert!(store.note_history_ids().unwrap().is_empty(), "note_history_ids");
    // ⑥ 文件夹侧栏计数与删除影响预览
    let tree = store.folder_list().unwrap();
    assert_eq!(tree[0].note_count, 0, "folder_list 的 note_count");
    assert_eq!(store.folder_delete_impact(&f.id).unwrap().1, 0, "folder_delete_impact");
    assert_eq!(store.folder_unfiled_count().unwrap(), 0, "folder_unfiled_count");
    // ⑦ 待沉淀区：笔记没了，卡片该变回候选
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 1, "kb_inbox 该把卡片收回去");

    // —— 但它必须还在回收站里，否则这一整套就只是把硬删换个写法
    let trash = store.note_list_deleted(50).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].id, n.id);
    assert!(trash[0].deleted_at.is_some(), "回收站里的条目必须带删除时间");
}

#[test]
fn test_note_restore_deleted_brings_it_back_including_search() {
    // 恢复必须重建 FTS。漏了的话笔记列表里回来了、搜却搜不到——
    // 比“没恢复”更难发现。
    let store = make_store();
    let n = store.note_create(None, "会议记录", "灰度发布").unwrap();
    store.note_delete(&n.id).unwrap();
    store.note_restore_deleted(&n.id).unwrap();

    assert!(store.note_get(&n.id).unwrap().is_some());
    assert_eq!(store.note_count(), 1);
    assert_eq!(
        store.note_search("灰度", "all", &[], 20).unwrap().len(),
        1,
        "恢复后必须能搜到"
    );
    assert!(store.note_list_deleted(50).unwrap().is_empty());
}

#[test]
fn test_soft_deleted_daily_note_does_not_block_a_new_one() {
    // W1 最尖的一根刺：`idx_notes_daily` 是 `(daily_date)` 上的**唯一**索引。
    // 软删的速记行还占着它的 daily_date，谓词不加 `AND deleted_at IS NULL` 的话，
    // 「删掉今天的速记 → 再按一次速记热键」会直接撞约束，速记彻底坑掉。
    let store = make_store();
    store
        .note_append_daily("2026-09-02", "10:00", None, "第一条")
        .unwrap();
    let old_id = store.note_list("daily", &[], 10, 0).unwrap()[0].id.clone();

    store.note_delete(&old_id).unwrap();
    assert!(
        store.note_daily_dates("2026-09").unwrap().is_empty(),
        "日历上不该再标这天有速记"
    );
    assert!(store.note_daily_earliest().unwrap().is_none());

    // 这一行就是全部重点：不改索引谓词时它会 UNIQUE constraint failed。
    store
        .note_append_daily("2026-09-02", "11:00", None, "第二条")
        .expect("删掉当天速记后，必须能重新建一条");

    let live = store.note_list("daily", &[], 10, 0).unwrap();
    assert_eq!(live.len(), 1, "当天只应有一条活的速记");
    assert_ne!(live[0].id, old_id, "该是新建的那条");
    assert!(
        live[0].content.contains("第二条") && !live[0].content.contains("第一条"),
        "不得往已删的速记里追加（那会写进去但永远看不到）"
    );

    // 日期被占了，恢复旧的必须报人话错误，而不是把裸 SQLite 报错扇出去。
    let err = store.note_restore_deleted(&old_id).unwrap_err();
    assert!(err.contains("2026-09-02"), "错误里要带上是哪天，实际为: {}", err);
}

#[test]
fn test_note_purge_is_the_only_hard_delete() {
    let store = make_store();
    let n = store.note_create(None, "临时", "随手记的").unwrap();
    store.note_delete(&n.id).unwrap();

    // 没进回收站的不得销毁（防的是将来把它接到外部写入上时一步平掉活笔记）
    let live = store.note_create(None, "活的", "别动我").unwrap();
    assert!(store.note_purge(&live.id).is_err(), "不在回收站就不能 purge");
    assert!(store.note_get(&live.id).unwrap().is_some());

    store.note_purge(&n.id).unwrap();
    assert!(store.note_list_deleted(50).unwrap().is_empty());
    assert!(store.note_restore_deleted(&n.id).is_err(), "销毁后无从恢复");
}

/// 把一条已软删的笔记的 `deleted_at` 往前拨。直写 SQL 是故意的：
/// 没有任何合法接口能造出「30 天前删的」，而超期清理必须被测到。
fn backdate_deleted_at(store: &DataStore, id: &str, stamp: &str) {
    store
        .lock_conn()
        .execute(
            "UPDATE notes SET deleted_at = ?2 WHERE id = ?1",
            rusqlite::params![id, stamp],
        )
        .unwrap();
}

#[test]
fn test_note_purge_all_empties_the_trash_and_spares_live_notes() {
    let store = make_store();
    let a = store.note_create(None, "删 A", "灰度发布").unwrap();
    let b = store.note_create(None, "删 B", "另一条").unwrap();
    let live = store.note_create(None, "活的", "别动我").unwrap();
    store.note_update(&a.id, "删 A", "灰度发布 v2").unwrap(); // 造一份快照
    store.note_delete(&a.id).unwrap();
    store.note_delete(&b.id).unwrap();

    assert_eq!(store.note_purge_all().unwrap(), 2, "返回销毁条数");
    assert!(store.note_list_deleted(50).unwrap().is_empty());
    assert!(
        store.note_revision_list(&a.id).unwrap().is_empty(),
        "清空也要级联掉历史"
    );
    // 活的那条一根汗毛都不能碰
    assert_eq!(store.note_count(), 1);
    assert!(store.note_get(&live.id).unwrap().is_some());
    assert_eq!(store.note_search("别动我", "all", &[], 20).unwrap().len(), 1);
}

#[test]
fn test_note_purge_expired_counts_from_deleted_at_not_updated_at() {
    // 这条钓的是 R3 的基准：一条很久以前写的、今天才删的笔记，
    // 应该还有完整的 30 天可以后悔。拿 `updated_at` 当基准的话它会被立即销毁。
    let store = make_store();
    let old = store.note_create(None, "早就删了", "x").unwrap();
    let fresh = store.note_create(None, "刚删的", "y").unwrap();
    store.note_delete(&old.id).unwrap();
    store.note_delete(&fresh.id).unwrap();
    backdate_deleted_at(&store, &old.id, "2020-01-01 00:00:00.000");

    assert_eq!(store.note_purge_expired(30).unwrap(), 1, "只该清掉超期的那条");
    let left = store.note_list_deleted(50).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, fresh.id, "刚删的必须还在");
}

#[test]
fn test_note_purge_expired_zero_days_is_the_escape_hatch() {
    // days = 0 是用户在设置里关掉自动清理。它是正常取值，
    // 不能报错，更不能被当成「0 天后到期」把回收站一次清光。
    let store = make_store();
    let n = store.note_create(None, "别动我", "x").unwrap();
    store.note_delete(&n.id).unwrap();
    backdate_deleted_at(&store, &n.id, "2020-01-01 00:00:00.000");

    assert_eq!(store.note_purge_expired(0).unwrap(), 0);
    assert_eq!(store.note_purge_expired(-1).unwrap(), 0);
    assert_eq!(store.note_list_deleted(50).unwrap().len(), 1, "一条都不能少");
}

#[test]
fn test_batch_purge_also_clears_the_fts_row() {
    // 批量路径不能照搬单条的「取 rowid 再删」写法，所以单钓一条：
    // 残留的索引行将来会被新笔记复用 rowid → 搜到一条已不存在的旧内容。
    let store = make_store();
    let n = store.note_create(None, "会议记录", "灰度发布").unwrap();
    let rowid: i64 = store
        .lock_conn()
        .query_row("SELECT rowid FROM notes WHERE id = ?1", [&n.id], |r| r.get(0))
        .unwrap();
    store.note_delete(&n.id).unwrap();
    store.note_purge_all().unwrap();

    let left: i64 = store
        .lock_conn()
        .query_row(
            "SELECT COUNT(*) FROM notes_fts WHERE rowid = ?1",
            [rowid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "批量销毁后 notes_fts 不得残留行");
}

// ============================================================
// MCP 调用审计（W3）
// ============================================================

#[test]
fn test_mcp_audit_roundtrip_and_client_roster() {
    let store = make_store();
    store
        .mcp_audit_log("claude-code/2.1", "kb_search", r#"{"query":"x"}"#, true, 2, &[
            "id-a".into(),
            "id-b".into(),
        ])
        .unwrap();
    store
        .mcp_audit_log("claude-code/2.1", "kb_read", r#"{"id":"id-a"}"#, true, 1, &["id-a".into()])
        .unwrap();
    store
        .mcp_audit_log("other-client/1.0", "kb_list", "{}", false, 0, &[])
        .unwrap();

    let rows = store.mcp_audit_list(10).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].tool, "kb_list", "时间倒序，最新的在前");
    assert!(!rows[0].ok, "失败的调用也要记——「试图读但没读成」也是信息");
    assert_eq!(rows[1].note_ids, "id-a");
    assert_eq!(rows[2].note_ids, "id-a,id-b", "多条命中逗号分隔");

    // 花名册不单存一份，就是对审计表 GROUP BY
    let clients = store.mcp_audit_clients().unwrap();
    assert_eq!(clients.len(), 2);
    let cc = clients.iter().find(|c| c.client == "claude-code/2.1").unwrap();
    assert_eq!(cc.calls, 2);
    assert!(cc.first_seen <= cc.last_seen);
}

#[test]
fn test_mcp_audit_never_stores_note_content() {
    // 🔴 这条钓的是 W3 的根本约束：审计只记 id，**不记正文**。
    // 记了就等于把知识库再抄一份到审计表里——体积与泄露面都翻倍，
    // 而且回收站清了、笔记删了，副本还留在这里。
    let store = make_store();
    let secret = "这是笔记正文里的敏感内容不该进审计表";
    let n = store.note_create(None, "会议记录", secret).unwrap();
    store
        .mcp_audit_log("c", "kb_read", &format!(r#"{{"id":"{}"}}"#, n.id), true, 1, &[n.id.clone()])
        .unwrap();

    let dump: String = store
        .lock_conn()
        .query_row(
            "SELECT group_concat(at || client || tool || args || note_ids, '|') FROM mcp_audit",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !dump.contains(secret),
        "审计表里不得出现笔记正文，实际内容: {}",
        dump
    );
    assert!(dump.contains(&n.id), "但必须记下 id，否则追溯不了读走的是哪几篇");
}

#[test]
fn test_mcp_audit_clear_and_purge() {
    let store = make_store();
    store.mcp_audit_log("c", "kb_list", "{}", true, 0, &[]).unwrap();
    store.mcp_audit_log("c", "kb_list", "{}", true, 0, &[]).unwrap();
    assert_eq!(store.mcp_audit_count(), 2);

    // days = 0 是用户关了自动清理的逃生口，不能被当成「0 天后到期」一次清光
    assert_eq!(store.mcp_audit_purge_expired(0).unwrap(), 0);
    assert_eq!(store.mcp_audit_count(), 2, "一条都不能少");

    // 红线②的「可删」
    assert_eq!(store.mcp_audit_clear().unwrap(), 2);
    assert_eq!(store.mcp_audit_count(), 0);
    assert!(store.mcp_audit_clients().unwrap().is_empty());
}

#[test]
fn test_note_history_id_can_be_null() {
    // 规划 §1.6 入口 #2：唯一与剪贴板无关的创建路径，history_id 必须可空
    let store = make_store();
    let n = store.note_create(None, "独立笔记", "跟剪贴板没关系").unwrap();
    let got = store.note_get(&n.id).unwrap().unwrap();
    assert!(got.history_id.is_none());
    // 且它不该出现在「已转过笔记的卡片」集合里
    assert!(store.note_history_ids().unwrap().is_empty());
}

#[test]
fn test_note_search_chinese_hits_fts() {
    // A 阶段验收原文：「中文与拼音关键词都能命中 notes_fts」。
    // 这条钉的是 to_ngram 的**双侧**预处理——漏掉任一侧中文就搜不到。
    let store = make_store();
    store.note_create(Some("h1"), "会议记录", "今天讨论了接口设计与灰度发布").unwrap();
    store.note_create(Some("h2"), "购物清单", "牛奶 面包").unwrap();

    // 二字词 = bigram 本身精确命中
    let hits = store.note_search("会议", "all", &[], 20).unwrap();
    assert_eq!(hits.len(), 1, "「会议」应只命中一条");
    assert_eq!(hits[0].title, "会议记录");

    // 正文里的词也要能命中（content 列也过了 to_ngram）
    let hits = store.note_search("灰度发布", "all", &[], 20).unwrap();
    assert_eq!(hits.len(), 1);

    // 不存在的词返回空，而不是全量
    assert!(store.note_search("量子隧穿", "all", &[], 20).unwrap().is_empty());
}

#[test]
fn test_note_search_pinyin_initials_hits_fts() {
    // 拼音首字母走 notes_fts 的第三列。compute_pinyin_initials 会大写，
    // 而 unicode61 分词两侧都折叠大小写，所以查小写也应命中。
    let store = make_store();
    store.note_create(Some("h1"), "会议记录", "正文").unwrap();

    assert_eq!(store.note_search("HYJL", "all", &[], 20).unwrap().len(), 1, "大写应命中");
    assert_eq!(store.note_search("hyjl", "all", &[], 20).unwrap().len(), 1, "小写也应命中");
}

#[test]
fn test_note_fts_syncs_on_update_and_delete() {
    // FTS5 不支持 UPSERT，同步走「先删后插」。这条钉住那条路径真的生效——
    // history_fts 曾因为用 ON CONFLICT 而首次回填之后再也没进过新内容。
    let store = make_store();
    let n = store.note_create(Some("h1"), "旧标题", "旧正文").unwrap();
    assert_eq!(store.note_search("旧标题", "all", &[], 20).unwrap().len(), 1);

    store.note_update(&n.id, "新标题", "新正文").unwrap();
    assert!(
        store.note_search("旧标题", "all", &[], 20).unwrap().is_empty(),
        "改标题后旧词不该还能搜到（说明只插没删）"
    );
    assert_eq!(store.note_search("新标题", "all", &[], 20).unwrap().len(), 1);

    store.note_delete(&n.id).unwrap();
    assert!(
        store.note_search("新标题", "all", &[], 20).unwrap().is_empty(),
        "删笔记后 FTS 行也要清掉（虚拟表没有外键，必须手动删）"
    );
}

#[test]
fn test_note_search_empty_keyword_returns_list() {
    let store = make_store();
    store.note_create(Some("h1"), "甲", "x").unwrap();
    store.note_create(Some("h2"), "乙", "y").unwrap();
    // 空关键词 = 列表，不是空结果（知识模式首屏就是这个语义）
    assert_eq!(store.note_search("   ", "all", &[], 20).unwrap().len(), 2);
}

#[test]
fn test_note_search_special_chars_do_not_panic() {
    // 带引号 / 星号 / NEAR 的查询词是 FTS5 MATCH 的语法雷区。
    // 这里只要求「不 panic、不返回 Err」——真炸了有 LIKE 回退兜着。
    let store = make_store();
    store.note_create(Some("h1"), "他说\"你好\"", "正文 *").unwrap();
    for kw in ["\"", "*", "NEAR(", "a OR", "^"] {
        assert!(store.note_search(kw, "all", &[], 20).is_ok(), "关键词 {:?} 不该报错", kw);
    }
}

#[test]
fn test_note_by_history_takes_latest() {
    let store = make_store();
    store.note_create(Some("h1"), "第一条", "a").unwrap();
    let second = store.note_create(Some("h1"), "第二条", "b").unwrap();
    // 一张卡可以转多条；角标只需知道「有没有」，取最新那条
    let got = store.note_by_history("h1").unwrap().unwrap();
    assert!(got.id == second.id || got.title == "第二条");
    assert!(store.note_by_history("不存在").unwrap().is_none());

    let ids = store.note_history_ids().unwrap();
    assert_eq!(ids, vec!["h1".to_string()], "DISTINCT 后应只有一个");
}

#[test]
fn test_note_list_orders_by_updated_desc_and_paginates() {
    let store = make_store();
    let a = store.note_create(Some("h1"), "A", "x").unwrap();
    store.note_create(Some("h2"), "B", "y").unwrap();
    store.note_create(Some("h3"), "C", "z").unwrap();

    // 这个 sleep 不是在遮掩不稳定，是在跨过**时钟分辨率**：
    // 内存 SQLite 快到能把上面 3 次插入跟下面那次 update 全跑在同一毫秒里，
    // 那样 updated_at 字符串完全相等，并列后按 rowid DESC 排 → C 在前。
    // 真实场景里人手编辑必然跨毫秒，所以这是测试环境的伪影、不是产品 bug。
    std::thread::sleep(std::time::Duration::from_millis(5));

    // 改 A → 它应该排到最前（按 updated_at DESC）
    store.note_update(&a.id, "A2", "x2").unwrap();

    let all = store.note_list("all", &[], 10, 0).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].title, "A2", "最近改的排最前");

    // 分页：规划 §3.2 估算笔记年化约 670 条，不能一次铺开
    let page = store.note_list("all", &[], 2, 0).unwrap();
    assert_eq!(page.len(), 2);
    let page2 = store.note_list("all", &[], 2, 2).unwrap();
    assert_eq!(page2.len(), 1);
    assert_eq!(store.note_count(), 3);
}

#[test]
fn test_note_tags_replace_semantics_and_cascade() {
    let store = make_store();
    let t1 = store.create_tag("架构", "#111").unwrap();
    let t2 = store.create_tag("待办", "#222").unwrap();
    let t3 = store.create_tag("归档", "#333").unwrap();
    let n = store.note_create(Some("h1"), "标题", "正文").unwrap();

    store.note_set_tags(&n.id, &[t1.id.clone(), t2.id.clone()]).unwrap();
    let got = store.note_get(&n.id).unwrap().unwrap();
    assert_eq!(got.tags.len(), 2);

    // 整体替换语义：再传一个新集合应覆盖而不是追加
    store.note_set_tags(&n.id, &[t3.id.clone()]).unwrap();
    let got = store.note_get(&n.id).unwrap().unwrap();
    assert_eq!(got.tags.len(), 1);
    assert_eq!(got.tags[0].name, "归档");

    let count_links = |id: &str| -> i64 {
        store
            .lock_conn()
            .query_row("SELECT COUNT(*) FROM note_tags WHERE note_id = ?1", [id], |r| r.get(0))
            .unwrap()
    };

    // W1：软删不触发 CASCADE，标签必须留着——否则从回收站恢复回来的笔记
    // 标签全掉了，而用户根本不会意识到是删那一下弄没的。
    store.note_delete(&n.id).unwrap();
    assert_eq!(count_links(&n.id), 1, "软删不得清标签关联");

    // 彻底销毁时才级联（PRAGMA foreign_keys=ON 必须真的生效）
    store.note_purge(&n.id).unwrap();
    assert_eq!(count_links(&n.id), 0, "销毁后 note_tags 关联行应被级联清掉");
}

#[test]
fn test_note_update_missing_id_is_not_silent() {
    // 规则 #15.3：改不存在的笔记是调用方 bug，必须报错而不是静默成功
    let store = make_store();
    assert!(store.note_update("不存在的id", "t", "c").is_err());
}

// ============================================================
// 待沉淀区（知识库 A 阶段 · 规划 §8.1 4️⃣）
// ============================================================

/// 插一张带指定信号的卡片。`hit` = search_hit_count，`pinned` = 是否收藏。
fn seed_candidate(store: &DataStore, id: &str, text: &str, time: &str, hit: i64, pinned: bool) {
    let mut item = make_item(id, text, time, "text");
    item.pinned = pinned;
    store.insert_history(&item).unwrap();
    // search_hit_count 是迁移加的列，insert_history 不管它，直接改
    store
        .lock_conn()
        .execute(
            "UPDATE history SET search_hit_count = ?1 WHERE id = ?2",
            rusqlite::params![hit, id],
        )
        .unwrap();
}

#[test]
fn test_kb_inbox_two_signals_and_threshold() {
    let store = make_store();
    // 找回 1 次：不够门槛（通路#2 要 >= 2）
    seed_candidate(&store, "h-hit1", "只找回一次", "2026-08-01 10:00:00", 1, false);
    // 找回 3 次：入选
    seed_candidate(&store, "h-hit3", "找回三次", "2026-08-02 10:00:00", 3, false);
    // 收藏但零找回：入选（通路#1，两个信号是 OR）
    seed_candidate(&store, "h-star", "只收藏", "2026-08-03 10:00:00", 0, true);

    let rows = store.kb_inbox_list("默认", 50, 0).unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.item.id.as_str()).collect();
    assert!(ids.contains(&"h-hit3"));
    assert!(ids.contains(&"h-star"));
    assert!(!ids.contains(&"h-hit1"), "找回 1 次不该入选（门槛是 2）");
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 2);

    // reason 在后端算好：收藏的是 star，其余是 research
    let star = rows.iter().find(|r| r.item.id == "h-star").unwrap();
    assert_eq!(star.reason, "star");
    let hit = rows.iter().find(|r| r.item.id == "h-hit3").unwrap();
    assert_eq!(hit.reason, "research");
    assert_eq!(hit.search_hit_count, 3);
}

#[test]
fn test_kb_inbox_excludes_items_with_notes() {
    // 排除 1：已有笔记的卡片退出候选。**这是虚拟视图的关键性质**——
    // 转完笔记候选自然消失，不需要任何清理任务。
    let store = make_store();
    seed_candidate(&store, "h1", "反复找回的内容", "2026-08-01 10:00:00", 5, false);
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 1);

    let n = store.note_create(Some("h1"), "标题", "正文").unwrap();
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 0, "已转笔记就不再是候选");

    // 删掉笔记又回到候选（同样是视图特性，无需额外逻辑）
    store.note_delete(&n.id).unwrap();
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 1);
}

#[test]
fn test_kb_inbox_dismiss_and_undismiss() {
    // 排除 2：用户说过「别烦我」的不再出现；撤销后回来。
    let store = make_store();
    seed_candidate(&store, "h1", "内容", "2026-08-01 10:00:00", 4, false);

    store.kb_inbox_dismiss("h1", "research").unwrap();
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 0);

    // 重复忽略同一条不能报错（INSERT OR REPLACE，不是 INSERT）
    store.kb_inbox_dismiss("h1", "star").unwrap();
    let reason: String = store
        .lock_conn()
        .query_row(
            "SELECT reason FROM kb_inbox_dismissed WHERE history_id = 'h1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(reason, "star", "reason 取最后一次");

    store.kb_inbox_undismiss("h1").unwrap();
    assert_eq!(store.kb_inbox_count("默认").unwrap(), 1, "撤销忽略后候选应回来");
}

#[test]
fn test_kb_inbox_order_by_hit_then_pasted() {
    // 排序：hit 降序 → 同分时有 pasted 的往前（A-28）。
    let store = make_store();
    seed_candidate(&store, "h-low", "弱信号", "2026-08-01 10:00:00", 2, false);
    seed_candidate(&store, "h-tie-a", "同分无pasted", "2026-08-02 10:00:00", 5, false);
    seed_candidate(&store, "h-tie-b", "同分有pasted", "2026-08-03 10:00:00", 5, false);
    seed_candidate(&store, "h-high", "强信号", "2026-08-04 10:00:00", 9, false);

    store
        .lock_conn()
        .execute(
            "INSERT INTO action_events (created_at, action_id, outcome, history_id)
             VALUES ('2026-08-05 10:00:00', 'paste', 'pasted', 'h-tie-b')",
            [],
        )
        .unwrap();

    let rows = store.kb_inbox_list("默认", 50, 0).unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.item.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["h-high", "h-tie-b", "h-tie-a", "h-low"],
        "应按 hit 降序，同分时 pasted 优先"
    );
    assert!(rows[1].recently_pasted, "h-tie-b 有 pasted 信号");
    assert!(!rows[2].recently_pasted);
}

#[test]
fn test_kb_inbox_pagination_is_stable() {
    // 分批拉取：全部同分时仍须有确定顺序，否则第二页会重复/跌页。
    let store = make_store();
    for i in 0..5 {
        seed_candidate(
            &store,
            &format!("h{i}"),
            "内容",
            &format!("2026-08-0{} 10:00:00", i + 1),
            3,
            false,
        );
    }
    let page1 = store.kb_inbox_list("默认", 2, 0).unwrap();
    let page2 = store.kb_inbox_list("默认", 2, 2).unwrap();
    let page3 = store.kb_inbox_list("默认", 2, 4).unwrap();
    let mut all: Vec<String> = Vec::new();
    for p in [&page1, &page2, &page3] {
        all.extend(p.iter().map(|r| r.item.id.clone()));
    }
    assert_eq!(all.len(), 5);
    let uniq: std::collections::HashSet<&String> = all.iter().collect();
    assert_eq!(uniq.len(), 5, "分页不得重复或漏条");
    // 同分时按时间倒序（最新在前）
    assert_eq!(all[0], "h4");
}

#[test]
fn test_kb_inbox_is_workspace_scoped() {
    // 候选是 history 卡片，而 history 全库按工作区隔离。
    // 不隔的话，别的工作区的候选会涌进来，而「查看原卡片」在记录模式里又找不到它。
    let store = make_store();
    seed_candidate(&store, "h-def", "默认区", "2026-08-01 10:00:00", 3, false);
    let mut other = make_item("h-other", "其他区", "2026-08-02 10:00:00", "text");
    other.workspace = "工作".to_string();
    store.insert_history(&other).unwrap();
    store
        .lock_conn()
        .execute(
            "UPDATE history SET search_hit_count = 9 WHERE id = 'h-other'",
            [],
        )
        .unwrap();

    assert_eq!(store.kb_inbox_count("默认").unwrap(), 1);
    assert_eq!(store.kb_inbox_count("工作").unwrap(), 1);
    let rows = store.kb_inbox_list("默认", 50, 0).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].item.id, "h-def");
}

// ============================================================
// 笔记文件夹（B1 #1）
// ============================================================

#[test]
fn test_folder_create_and_list_with_depth() {
    let store = make_store();
    let a = store.folder_create("工作", None).unwrap();
    let b = store.folder_create("NC 二开", Some(&a.id)).unwrap();
    let c = store.folder_create("单据模板", Some(&b.id)).unwrap();

    assert_eq!((a.depth, b.depth, c.depth), (1, 2, 3));

    // 逐层建到上限，再多一层就该报错。
    //
    // ❗ 不写死层数：原先这里断言 `err.contains("3 层")`，上限从 3 改到 4 时
    //   这一行就碎了——而它想验的是「错误文案说清了上限」，不是「上限恰好是 3」。
    let mut parent = c.id.clone();
    for i in 3..MAX_FOLDER_DEPTH {
        parent = store
            .folder_create(&format!("第{}层", i + 1), Some(&parent))
            .unwrap()
            .id;
    }
    let err = store.folder_create("太深了", Some(&parent)).unwrap_err();
    assert!(
        err.contains(&format!("{MAX_FOLDER_DEPTH} 层")),
        "错误该说清深度上限，实得：{err}"
    );

    let list = store.folder_list().unwrap();
    assert_eq!(list.len(), MAX_FOLDER_DEPTH as usize);
}

#[test]
fn test_folder_name_rules() {
    let store = make_store();
    // 空名 / 纯空白名拒掉
    assert!(store.folder_create("", None).is_err());
    assert!(store.folder_create("   ", None).is_err());

    let a = store.folder_create("工作", None).unwrap();
    // 同父下重名拒掉：否则树里两行完全一样，用户无法区分
    assert!(store.folder_create("工作", None).is_err());
    // 不同父下同名是合法的
    let b = store.folder_create("学习", None).unwrap();
    store.folder_create("工作", Some(&b.id)).unwrap();

    // 改名也走同一套校验，但不能把自己算成重名
    store.folder_rename(&a.id, "工作").unwrap();
    store.folder_rename(&a.id, "工作A").unwrap();
    assert!(store.folder_rename(&a.id, "学习").is_err(), "与兄弟同名应拒");
    assert!(store.folder_rename("不存在", "x").is_err());
}

#[test]
fn test_folder_move_rejects_cycle() {
    // 邻接表方案的头号风险：把父文件夹移进自己的后代，两边从根上断开，
    // 递归永远走不到 → 笔记不丢但永久看不见。
    let store = make_store();
    let a = store.folder_create("工作", None).unwrap();
    let b = store.folder_create("NC 二开", Some(&a.id)).unwrap();

    assert!(store.folder_move(&a.id, Some(&a.id)).is_err(), "移到自己应拒");
    assert!(
        store.folder_move(&a.id, Some(&b.id)).is_err(),
        "移到自己的子文件夹应拒（否则成孤岛子树）"
    );

    // 反方向是合法的：把子提到顶层
    store.folder_move(&b.id, None).unwrap();
    let list = store.folder_list().unwrap();
    let moved = list.iter().find(|f| f.id == b.id).unwrap();
    assert_eq!(moved.parent_id, None);
    assert_eq!(moved.depth, 1);
}

#[test]
fn test_folder_move_rejects_over_depth() {
    // 目标深度 + 自身子树高度 ≤ 上限。单看目标深度不够——
    // 把一个两层高的子树移到倒数第二层，结果就超了。
    //
    // ❗ 层数**跟着常量算**而不写死。原先这里写的是「2 + 2 = 4 > 3，拒」，
    //   上限从 3 抬到 4 的那一刻这条断言就从「该拒」变成了「该放」，测试直接红。
    //   （它想验的是「高度也算进去了」这个不变式，不是具体的 3。）
    let store = make_store();

    // 一条深到 `MAX-1` 的链（depth = 1..MAX-1）
    let mut chain: Vec<String> = Vec::new();
    let mut parent: Option<String> = None;
    for i in 0..(MAX_FOLDER_DEPTH - 1) {
        let f = store
            .folder_create(&format!("A{}", i + 1), parent.as_deref())
            .unwrap();
        parent = Some(f.id.clone());
        chain.push(f.id);
    }

    let sub1 = store.folder_create("X", None).unwrap();
    store.folder_create("Y", Some(&sub1.id)).unwrap(); // sub1 子树高 2

    // 移到最深那层（第 MAX-1 层）→ (MAX-1) + 2 = MAX+1，拒
    let too_deep = chain.last().unwrap().clone();
    let err = store.folder_move(&sub1.id, Some(&too_deep)).unwrap_err();
    assert!(err.contains("层"), "错误该说清层数，实得：{err}");

    // 移到第 MAX-2 层 → (MAX-2) + 2 = MAX，正好卡在上限上，合法
    let just_fits = chain[chain.len() - 2].clone();
    store.folder_move(&sub1.id, Some(&just_fits)).unwrap();
}

#[test]
fn test_folder_delete_keeps_notes_but_cascades_subfolders() {
    // 两个删除行为故意不同：子文件夹 CASCADE，笔记 SET NULL。
    // 删一个文件夹把里面笔记连坐是本功能最严重的可能故障。
    let store = make_store();
    let a = store.folder_create("工作", None).unwrap();
    let b = store.folder_create("NC 二开", Some(&a.id)).unwrap();
    let c = store.folder_create("单据模板", Some(&b.id)).unwrap();

    let n1 = store.note_create(None, "笔记1", "正文1").unwrap();
    let n2 = store.note_create(None, "笔记2", "正文2").unwrap();
    let n3 = store.note_create(None, "笔记3", "正文3").unwrap();
    store.note_set_folder(&n1.id, Some(&a.id)).unwrap();
    store.note_set_folder(&n2.id, Some(&b.id)).unwrap();
    store.note_set_folder(&n3.id, Some(&c.id)).unwrap();

    // 删除前的影响预览：2 个子文件夹、3 条笔记
    let (subs, notes) = store.folder_delete_impact(&a.id).unwrap();
    assert_eq!((subs, notes), (2, 3), "确认框要拿真数字去填");

    store.folder_delete(&a.id).unwrap();

    // 子文件夹全没了
    assert!(store.folder_list().unwrap().is_empty(), "子文件夹应级联删除");
    // 但三条笔记一条不少，全变未分类
    assert_eq!(store.note_count(), 3, "笔记绝不能随文件夹删");
    assert_eq!(store.folder_unfiled_count().unwrap(), 3);
    for id in [&n1.id, &n2.id, &n3.id] {
        assert_eq!(store.note_get(id).unwrap().unwrap().folder_id, None);
    }
}

#[test]
fn test_folder_note_count_includes_descendants() {
    // 侧栏计数必须含后代：不含的话点「工作」看到 1 条而侧栏写 3，
    // 用户会以为丢了（同待沉淀区「横幅 225 / 列表 200」的教训）。
    let store = make_store();
    let a = store.folder_create("工作", None).unwrap();
    let b = store.folder_create("NC", Some(&a.id)).unwrap();

    for (i, f) in [(&a.id, &a.id), (&b.id, &b.id), (&b.id, &b.id)]
        .iter()
        .enumerate()
    {
        let n = store
            .note_create(None, &format!("笔记{i}"), "正文")
            .unwrap();
        store.note_set_folder(&n.id, Some(f.0)).unwrap();
    }

    let list = store.folder_list().unwrap();
    let fa = list.iter().find(|f| f.id == a.id).unwrap();
    let fb = list.iter().find(|f| f.id == b.id).unwrap();
    assert_eq!(fa.note_count, 3, "父文件夹计数应含后代");
    assert_eq!(fb.note_count, 2);

    // 列表与计数同口径：选父文件夹拿到的条数 == 侧栏计数
    let rows = store.note_list(&a.id, &[], 50, 0).unwrap();
    assert_eq!(rows.len() as i64, fa.note_count);
    assert_eq!(store.note_count_filtered(&a.id, &[]).unwrap(), 3);
}

#[test]
fn test_note_list_folder_and_tag_is_intersection() {
    // 文件夹 × 标签 = 交集，不是并集。并集会让「选了更多条件反而结果更多」。
    let store = make_store();
    let f = store.folder_create("工作", None).unwrap();
    let t = store.create_tag("SQL", "#111").unwrap();

    let in_both = store.note_create(None, "两者都满足", "x").unwrap();
    let only_folder = store.note_create(None, "只在文件夹", "x").unwrap();
    let only_tag = store.note_create(None, "只有标签", "x").unwrap();

    store.note_set_folder(&in_both.id, Some(&f.id)).unwrap();
    store.note_set_folder(&only_folder.id, Some(&f.id)).unwrap();
    store.note_set_tags(&in_both.id, &[t.id.clone()]).unwrap();
    store.note_set_tags(&only_tag.id, &[t.id.clone()]).unwrap();

    let both = store.note_list(&f.id, &[t.id.clone()], 50, 0).unwrap();
    assert_eq!(both.len(), 1, "交集应只剩一条");
    assert_eq!(both[0].id, in_both.id);

    // 交集结果不得大于任一单选
    let by_folder = store.note_list(&f.id, &[], 50, 0).unwrap();
    let by_tag = store.note_list("all", &[t.id.clone()], 50, 0).unwrap();
    assert!(both.len() <= by_folder.len() && both.len() <= by_tag.len());

    // 未分类筛选
    let unfiled = store.note_list("unfiled", &[], 50, 0).unwrap();
    assert_eq!(unfiled.len(), 1);
    assert_eq!(unfiled[0].id, only_tag.id);
}

#[test]
fn test_note_search_respects_folder_filter() {
    // 选着文件夹搜索时，结果不得跳出当前范围。
    let store = make_store();
    let f = store.folder_create("工作", None).unwrap();
    let inside = store.note_create(None, "灵活部署笔记", "正文").unwrap();
    store.note_create(None, "灵活部署另一条", "正文").unwrap();
    store.note_set_folder(&inside.id, Some(&f.id)).unwrap();

    let all_hits = store.note_search("部署", "all", &[], 20).unwrap();
    assert_eq!(all_hits.len(), 2);

    let in_folder = store.note_search("部署", &f.id, &[], 20).unwrap();
    assert_eq!(in_folder.len(), 1, "搜索应受文件夹筛选限制");
    assert_eq!(in_folder[0].id, inside.id);
}

#[test]
fn test_note_set_folder_missing_target_errors() {
    // 规则 #15.3：归档不存在的笔记是调用方 bug，不能静默成功
    let store = make_store();
    assert!(store.note_set_folder("不存在", None).is_err());
    assert!(store.folder_delete("不存在").is_err());
}

// ============================================================
// 自动收录影子运行（知识库 A 阶段 · 规划 §8.1 5️⃣）
// ============================================================

/// 一段肯定超 200 字符的正文（形态门槛要求）。
fn long_text() -> String {
    "这是一段足够长的技术笔记内容。".repeat(20)
}

/// 插一张满足/不满足影子规则的卡片。`days_ago` 控制年龄门槛。
fn seed_shadow_item(store: &DataStore, id: &str, text: &str, hit: i64, days_ago: i64) {
    let time = (chrono::Local::now() - chrono::Duration::days(days_ago))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let item = make_item(id, text, &time, "text");
    store.insert_history(&item).unwrap();
    store
        .lock_conn()
        .execute(
            "UPDATE history SET search_hit_count = ?1 WHERE id = ?2",
            rusqlite::params![hit, id],
        )
        .unwrap();
}

#[test]
fn test_kb_shadow_four_thresholds() {
    let store = make_store();
    let long = long_text();

    // 全部满足：命中
    seed_shadow_item(&store, "ok", &long, 5, 30);
    // 强度不够（hit=4 < 5）
    seed_shadow_item(&store, "weak", &long, 4, 30);
    // 形态不够（正文太短）——挡掉那 64% 碎片
    seed_shadow_item(&store, "short", "很短的一句", 9, 30);
    // 太新（今天刚存）——挡掉「当下正在反复找」
    seed_shadow_item(&store, "fresh", &long, 9, 0);

    let ids: Vec<String> = store
        .kb_shadow_candidates("默认")
        .unwrap()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(ids, vec!["ok"], "四个门槛应全部生效，只有 ok 通过");
}

#[test]
fn test_kb_shadow_excludes_noted_and_dismissed() {
    let store = make_store();
    let long = long_text();
    seed_shadow_item(&store, "h-note", &long, 9, 30);
    seed_shadow_item(&store, "h-dismiss", &long, 9, 30);
    seed_shadow_item(&store, "h-keep", &long, 9, 30);

    store.note_create(Some("h-note"), "已有笔记", "正文").unwrap();
    store.kb_inbox_dismiss("h-dismiss", "research").unwrap();

    let ids: Vec<String> = store
        .kb_shadow_candidates("默认")
        .unwrap()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(ids, vec!["h-keep"], "已有笔记与已忽略的都该排除");
}

#[test]
fn test_kb_shadow_images_never_hit() {
    // 形态门槛只管文本类（规划那句「图片类看 OCR 字数」与它自己的结论句相矛，
    // 且声称要复用的通路#5 从未实现）。图片一律不命中，留在待沉淀区。
    let store = make_store();
    let time = (chrono::Local::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let img = make_item("img", &long_text(), &time, "image");
    store.insert_history(&img).unwrap();
    store
        .lock_conn()
        .execute("UPDATE history SET search_hit_count = 99 WHERE id = 'img'", [])
        .unwrap();

    assert!(
        store.kb_shadow_candidates("默认").unwrap().is_empty(),
        "图片卡片不应进自动收录候选（图片分支归 B2）"
    );
}

#[test]
fn test_kb_shadow_record_keeps_first_hit_at() {
    // first_hit_at 是「一周后看结果」的基准，每轮刷新就永远等不到一周。
    let store = make_store();
    let ids = vec!["h1".to_string()];

    store.kb_shadow_record(&ids).unwrap();
    let (first1, rounds1): (String, i64) = store
        .lock_conn()
        .query_row(
            "SELECT first_hit_at, hit_rounds FROM kb_autofile_shadow WHERE history_id = 'h1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(rounds1, 1);

    // 再跑一轮：轮数 +1，first_hit_at 不变
    store.kb_shadow_record(&ids).unwrap();
    let (first2, rounds2): (String, i64) = store
        .lock_conn()
        .query_row(
            "SELECT first_hit_at, hit_rounds FROM kb_autofile_shadow WHERE history_id = 'h1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(rounds2, 2, "重复命中应累加轮数而不是报错");
    assert_eq!(first1, first2, "first_hit_at 不得被后续轮次刷新");
}

#[test]
fn test_kb_shadow_precision_none_when_no_data() {
    // 「没数据」不能算成「准确率 0%」——后者会直接得出「B2 不开」的错结论。
    let store = make_store();
    let s = store.kb_shadow_stats().unwrap();
    assert_eq!(s.hits, 0);
    assert!(s.precision.is_none(), "无命中时 precision 必须是 None，不是 0.0");
    assert!(s.since.is_none());
}

#[test]
fn test_kb_shadow_precision_and_missed() {
    let store = make_store();
    let long = long_text();
    // 三条命中：其中两条用户后来真转了 → 准确率 2/3
    for id in ["a", "b", "c"] {
        seed_shadow_item(&store, id, &long, 9, 30);
    }
    let hit_ids: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
    store.kb_shadow_record(&hit_ids).unwrap();

    store.note_create(Some("a"), "笔记A", "正文").unwrap();
    store.note_create(Some("b"), "笔记B", "正文").unwrap();
    // 用户还转了一条规则根本没命中的 → 漏报 1
    seed_shadow_item(&store, "d", "短内容", 1, 0);
    store.note_create(Some("d"), "笔记D", "正文").unwrap();

    let s = store.kb_shadow_stats().unwrap();
    assert_eq!(s.hits, 3);
    assert_eq!(s.hits_converted, 2);
    assert_eq!(s.manual_total, 3, "用户一共手动转了 3 条");
    assert_eq!(s.missed, 1, "d 是用户转了但规则漏掉的");
    let p = s.precision.expect("有命中就应该有准确率");
    assert!((p - 2.0 / 3.0).abs() < 1e-9, "准确率应为 2/3，实得 {p}");

    // 红线②：可删
    let n = store.kb_shadow_clear().unwrap();
    assert_eq!(n, 3);
    assert_eq!(store.kb_shadow_stats().unwrap().hits, 0);
}

// ============================================================
// 版本快照 + 恢复（B1 #4 / D8）
// 逐条对应 design/PastePanda-版本快照-设计稿.html §7
// ============================================================

#[test]
fn test_revision_snapshots_old_version_on_each_change() {
    let store = make_store();
    let n = store.note_create(None, "标题", "第一版").unwrap();

    store.note_update(&n.id, "标题", "第二版").unwrap();
    store.note_update(&n.id, "标题", "第三版").unwrap();

    let revs = store.note_revision_list(&n.id).unwrap();
    assert_eq!(revs.len(), 2, "两次改动应留两份历史（当前版不在表里）");

    // 存的是**旧版本**：最新那份历史是第二次保存之前的内容
    let newest = store.note_revision_get(revs[0].id).unwrap().unwrap();
    assert_eq!(newest.content, "第二版");
    let oldest = store.note_revision_get(revs[1].id).unwrap().unwrap();
    assert_eq!(oldest.content, "第一版", "第一次编辑应保住刚建时的原始版");

    // 当前版只在 notes
    assert_eq!(store.note_get(&n.id).unwrap().unwrap().content, "第三版");
}

#[test]
fn test_revision_not_written_when_nothing_changed() {
    let store = make_store();
    let n = store.note_create(None, "标题", "正文").unwrap();
    let before = store.note_get(&n.id).unwrap().unwrap().updated_at;

    // 打开→直接保存：不写快照，**也不动 updated_at**
    store.note_update(&n.id, "标题", "正文").unwrap();

    assert!(store.note_revision_list(&n.id).unwrap().is_empty());
    assert_eq!(
        store.note_get(&n.id).unwrap().unwrap().updated_at,
        before,
        "没改却刷新 updated_at，会把这条笔记顶到列表最前"
    );
}

#[test]
fn test_revision_pruned_to_max() {
    let store = make_store();
    let n = store.note_create(None, "标题", "v0").unwrap();
    for i in 1..=25 {
        store.note_update(&n.id, "标题", &format!("v{i}")).unwrap();
    }

    let revs = store.note_revision_list(&n.id).unwrap();
    assert_eq!(revs.len(), MAX_REVISIONS as usize);

    // 留下的是最近 20 份：最新一份是 v24（第 25 次保存前的内容）
    let newest = store.note_revision_get(revs[0].id).unwrap().unwrap();
    assert_eq!(newest.content, "v24");
    let oldest = store.note_revision_get(revs[19].id).unwrap().unwrap();
    assert_eq!(oldest.content, "v5", "更早的应该已被裁掉");
}

/// W2 的核心保证：**模型连改 25 次，也挤不掉「它动手之前」那一份**。
///
/// 这条挂了就意味着写工具不能开——等于把唯一的后悔药交给模型销毁。
#[test]
fn test_anchor_survives_many_external_writes() {
    let store = make_store();
    let n = store.note_create(None, "标题", "人写的原始正文").unwrap();

    for i in 1..=25 {
        store
            .note_update_from(&n.id, "标题", &format!("模型第{i}版"), "agent:test")
            .unwrap();
    }

    let revs = store.note_revision_list(&n.id).unwrap();
    let anchors: Vec<_> = revs.iter().filter(|r| r.pinned).collect();
    assert_eq!(anchors.len(), 1, "每篇最多一份锚定");
    assert_eq!(
        store
            .note_revision_get(anchors[0].id)
            .unwrap()
            .unwrap()
            .content,
        "人写的原始正文",
        "锚定的必须是模型动手之前的原样"
    );

    // 锚定份不占 20 份配额：否则「保护历史」反而先吃掉一份历史
    assert_eq!(revs.len(), MAX_REVISIONS as usize + 1);
    assert!(
        revs.iter().filter(|r| !r.pinned).all(|r| r.source_agent == "agent:test"),
        "外部写入的每一版都该留下来源"
    );
}

/// 人工编辑**不**锚定：你自己改坏了本来就能自己改回来。
/// 它同时守着旧不变式：加了 pinned 列后，普通历史仍旧是「最近 20 份」。
#[test]
fn test_human_edits_never_anchor() {
    let store = make_store();
    let n = store.note_create(None, "标题", "v0").unwrap();
    for i in 1..=25 {
        store.note_update(&n.id, "标题", &format!("v{i}")).unwrap();
    }

    let revs = store.note_revision_list(&n.id).unwrap();
    assert_eq!(revs.len(), MAX_REVISIONS as usize);
    assert!(revs.iter().all(|r| !r.pinned), "人改的不该自动锚定");
    assert!(
        revs.iter().all(|r| r.source_agent.is_empty()),
        "人工编辑的来源必须是空串——界面靠它分辨谁改的"
    );
}

/// 手动锚定与解除（W2b）。解除后那一份**重新变成普通历史**，会正常被挤出。
#[test]
fn test_manual_pin_then_unpin() {
    let store = make_store();
    let n = store.note_create(None, "标题", "要保住的那一版").unwrap();
    store.note_update(&n.id, "标题", "下一版").unwrap();

    let target = store.note_revision_list(&n.id).unwrap()[0].id;
    store.note_revision_pin(target, true).unwrap();

    for i in 1..=25 {
        store.note_update(&n.id, "标题", &format!("v{i}")).unwrap();
    }
    let rev = store.note_revision_get(target).unwrap();
    assert!(rev.is_some(), "手动锚定的也不能被挤掉");
    assert!(rev.unwrap().pinned);

    store.note_revision_pin(target, false).unwrap();
    for i in 26..=50 {
        store.note_update(&n.id, "标题", &format!("v{i}")).unwrap();
    }
    assert!(
        store.note_revision_get(target).unwrap().is_none(),
        "解除锚定后应重新参与排队，否则「清除锚点」就只是个摆设"
    );

    // 不静默（规则 #15.3）
    assert!(store.note_revision_pin(999_999, true).is_err());
}

#[test]
fn test_restore_is_itself_undoable() {
    let store = make_store();
    let n = store.note_create(None, "标题", "第一版").unwrap();
    store.note_update(&n.id, "标题", "第二版").unwrap();

    let revs = store.note_revision_list(&n.id).unwrap();
    let restored = store.note_restore(revs[0].id).unwrap();
    assert_eq!(restored.content, "第一版");

    // 恢复前的内容进了历史 ⇒ 恢复可撤销
    let after = store.note_revision_list(&n.id).unwrap();
    assert_eq!(after.len(), 2);
    let top = store.note_revision_get(after[0].id).unwrap().unwrap();
    assert_eq!(top.content, "第二版", "恢复应先把当前版存成快照");

    // 撤销恢复：把刚才那份再恢复回来
    let back = store.note_restore(after[0].id).unwrap();
    assert_eq!(back.content, "第二版");
}

#[test]
fn test_restore_also_restores_title() {
    let store = make_store();
    let n = store.note_create(None, "原标题", "正文").unwrap();
    store.note_update(&n.id, "新标题", "新正文").unwrap();

    let revs = store.note_revision_list(&n.id).unwrap();
    let restored = store.note_restore(revs[0].id).unwrap();
    assert_eq!(restored.title, "原标题");
    assert_eq!(restored.content, "正文");
}

#[test]
fn test_deleting_note_cascades_revisions() {
    let store = make_store();
    let n = store.note_create(None, "标题", "v0").unwrap();
    store.note_update(&n.id, "标题", "v1").unwrap();
    assert_eq!(store.note_revision_list(&n.id).unwrap().len(), 1);

    // W1 后 `note_delete` 是**软删除**：历史快照必须原封不动地留着。
    // 这正是软删除的全部意义——硬删 + `ON DELETE CASCADE` 意味着
    // 一次误删就是笔记连 20 份历史一起没，而 M4 要把删除放给外部模型。
    store.note_delete(&n.id).unwrap();
    assert_eq!(
        store.note_revision_list(&n.id).unwrap().len(),
        1,
        "软删不得碰历史快照（否则回收站恢复出来的是个没有过去的壳）"
    );

    // 但外键本身必须真的生效（规划 §6 的 DDL 原本漏了它，设计稿 §0）：
    // 彻底销毁时历史要跟着没，否则它们会永久留在库里变孤儿行。
    store.note_purge(&n.id).unwrap();
    assert!(
        store.note_revision_list(&n.id).unwrap().is_empty(),
        "彻底销毁必须级联清掉历史"
    );
}

#[test]
fn test_restore_missing_revision_errors() {
    let store = make_store();
    // 不静默（规则 #15.3）
    assert!(store.note_restore(999_999).is_err());
    assert!(store.note_revision_get(999_999).unwrap().is_none());
}

// ============================================================
// Markdown 目录导出 / 导入（B1 #5 / D1）
// 逐条对应 design/PastePanda-MD导出导入-设计稿.html §7
// ============================================================

#[test]
fn test_md_frontmatter_escapes_risky_titles() {
    // 旧的 TS 版一处转义都没有，这类标题产出的是非法 YAML
    let n = mk_note_for_md("会议纪要: 8/29 评审", "正文", &["工作", "NC, 二开"]);
    let md = note_to_markdown(&n, true);

    assert!(md.contains(r#"title: "会议纪要: 8/29 评审""#), "含冒号必须加引号：{md}");
    // 块式列表：逗号在这里本来就安全（只有流式 `[a, b]` 会把它当分隔符），
    // 所以不需要加引号——真正要钉的是它能原样读回来（见下）。
    assert!(md.contains("tags:\n  - 工作\n  - NC, 二开"), "标签应是块式列表：{md}");
    assert!(md.contains("pastepanda_id: "));

    // 带逗号的标签读回来仍是**一个**标签——旧的 `tags: [a, b]` 写法在这里就碎成两个了
    let back = markdown_to_note(&md, "x");
    assert_eq!(back.tags, vec!["工作".to_string(), "NC, 二开".to_string()]);

    // 复制到剪贴板那份不写 id
    assert!(!note_to_markdown(&n, false).contains("pastepanda_id"));
}

#[test]
fn test_md_roundtrip_keeps_title_tags_body() {
    let n = mk_note_for_md("会议纪要: 8/29", "第一行\n\n[[某个链接]] 原样", &["工作"]);
    let md = note_to_markdown(&n, true);
    let back = markdown_to_note(&md, "文件名");

    assert_eq!(back.title, "会议纪要: 8/29");
    assert_eq!(back.tags, vec!["工作".to_string()]);
    assert_eq!(back.content, "第一行\n\n[[某个链接]] 原样", "wiki-link 必须一字不改");
    assert_eq!(back.id.as_deref(), Some(n.id.as_str()));
}

#[test]
fn test_md_parse_degrades_instead_of_failing() {
    // 没有 frontmatter：整文当正文，标题用文件名
    let p = markdown_to_note("# 直接是正文\n没有头", "我的笔记");
    assert_eq!(p.title, "我的笔记");
    assert!(p.content.starts_with("# 直接是正文"));
    assert!(p.id.is_none());

    // frontmatter 不闭合 ⇒ 同样降级，而不是报错中断整次导入
    let p2 = markdown_to_note("---\ntitle: 坏了\n正文没有结束标记", "兜底标题");
    assert_eq!(p2.title, "兜底标题");
    assert!(p2.content.contains("title: 坏了"), "整文都该当正文");

    // 认不出的字段不能弄挂解析（外部编辑器常加自己的字段）
    let p3 = markdown_to_note(
        "---\ntitle: 正常\ncssclass: foo\nunknown-thing: [1,2]\n---\n\n正文",
        "x",
    );
    assert_eq!(p3.title, "正常");
    assert_eq!(p3.content, "正文");
}

#[test]
fn test_md_parse_accepts_inline_tag_array() {
    // Obsidian 自己常写行内数组，旧版 noteToMarkdown 也是
    let p = markdown_to_note("---\ntitle: T\ntags: [工作, SQL]\n---\n\nbody", "x");
    assert_eq!(p.tags, vec!["工作".to_string(), "SQL".to_string()]);
}

#[test]
fn test_safe_file_stem_rules() {
    // Windows 非法字符
    assert_eq!(safe_file_stem("a/b:c*d", "id123456"), "a_b_c_d");
    // 空标题 / 纯非法字符 → 用 id 兜底，不能产出空文件名
    assert_eq!(safe_file_stem("", "id123456ff"), "无标题-id123456");
    assert_eq!(safe_file_stem("   ", "id123456ff"), "无标题-id123456");
    // 截长
    let long: String = "标".repeat(200);
    assert_eq!(safe_file_stem(&long, "x").chars().count(), 80);
    // Windows 不允许以点结尾
    assert_eq!(safe_file_stem("笔记...", "x"), "笔记");
}

/// 造一条带标签的笔记（只给 note_md 的纯函数用，不入库）。
fn mk_note_for_md(title: &str, content: &str, tags: &[&str]) -> Note {
    Note {
        id: "7c1f0000-1111-2222-3333-444455556666".to_string(),
        history_id: None,
        title: title.to_string(),
        content: content.to_string(),
        created_at: "2026-08-29 14:32:07.000".to_string(),
        updated_at: "2026-09-01 09:10:44.000".to_string(),
        source_agent: String::new(),
        folder_id: None,
        summary: None,
        daily_date: None,
        deleted_at: None,
        pinned: false,
        source_kind: None,
        group_key: None,
        tags: tags
            .iter()
            .map(|t| Tag {
                id: format!("tag-{t}"),
                name: t.to_string(),
                color: "#6B7280".to_string(),
                source: "manual".to_string(),
                created_at: "2026-08-29 14:32:07".to_string(),
            })
            .collect(),
    }
}

/// 造一个临时目录（项目没有 tempfile dev-dependency，用 uuid 自己拼一个）。
fn tmp_vault_dir(tag: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!(
        "pp-vault-{tag}-{}",
        uuid::Uuid::new_v4().to_string()
    ));
    std::fs::create_dir_all(&p).expect("建临时目录失败");
    p
}

#[test]
fn test_vault_export_then_import_roundtrip() {
    let dir = tmp_vault_dir("roundtrip");

    let src = make_store();
    let work = src.folder_create("工作笔记", None).unwrap();
    let sub = src.folder_create("NC 二开", Some(&work.id)).unwrap();

    let a = src.note_create(None, "会议纪要: 8/29", "第一行\n\n[[某链接]]").unwrap();
    src.note_set_folder(&a.id, Some(&sub.id)).unwrap();
    src.note_create(None, "未分类的一条", "正文").unwrap();

    let rep = src.note_export_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(rep.notes, 2);
    assert_eq!(rep.folders, 2);

    // 目录形状：文件夹树原样铺开，未分类落根目录
    assert!(dir.join("工作笔记").join("NC 二开").is_dir());
    assert!(dir.join("未分类的一条.md").is_file());
    // 标题里的 `:` 与 `/` 被换成 _，文件能建出来
    assert!(dir.join("工作笔记").join("NC 二开").join("会议纪要_ 8_29.md").is_file());

    // 导进一个全新的库
    let dst = make_store();
    let imp = dst.note_import_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(imp.created, 2);
    assert_eq!(imp.updated, 0);
    assert!(imp.failed.is_empty());

    // 标题、正文、文件夹层级都还原了（不靠文件名——文件名已被清洗）
    let notes = dst.note_list("all", &[], 50, 0).unwrap();
    let got = notes.iter().find(|n| n.title == "会议纪要: 8/29").expect("标题应从 frontmatter 还原");
    assert_eq!(got.content, "第一行\n\n[[某链接]]");
    let folders = dst.folder_list().unwrap();
    assert!(folders.iter().any(|f| f.name == "NC 二开" && f.depth == 2));

    // 说明页不当笔记导回来
    assert!(!notes.iter().any(|n| n.title.contains("导出说明")));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn test_vault_import_is_idempotent_and_never_deletes() {
    let dir = tmp_vault_dir("idem");
    let store = make_store();
    let n = store.note_create(None, "只有一条", "v1").unwrap();
    store.note_export_dir(dir.to_str().unwrap()).unwrap();

    // 导入前另外建一条：目录里没有它，导入后必须还在（合并 ≠ 同步）
    let keep = store.note_create(None, "目录里没有的", "别删我").unwrap();

    let first = store.note_import_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(first.created, 0, "id 命中应走更新，而不是再建一条");
    assert_eq!(first.updated, 1);

    let second = store.note_import_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(second.created, 0, "连导两次不该翻倍");

    assert!(store.note_get(&keep.id).unwrap().is_some(), "导入永远不删库里的笔记");
    assert_eq!(store.note_count(), 2);

    // 内容没变 ⇒ note_update 是空操作 ⇒ 不该攒出快照
    assert!(
        store.note_revision_list(&n.id).unwrap().is_empty(),
        "内容一样的导入不该多出快照"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn test_vault_import_updates_and_leaves_a_revision() {
    let dir = tmp_vault_dir("edit");
    let store = make_store();
    let n = store.note_create(None, "改我", "原正文").unwrap();
    store.note_export_dir(dir.to_str().unwrap()).unwrap();

    // 模拟用户在 Obsidian 里改了这个文件
    let f = dir.join("改我.md");
    let text = std::fs::read_to_string(&f).unwrap();
    std::fs::write(&f, text.replace("原正文", "在 Obsidian 里改过")).unwrap();

    let rep = store.note_import_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(rep.updated, 1);
    assert_eq!(store.note_get(&n.id).unwrap().unwrap().content, "在 Obsidian 里改过");

    // #4 联动：更新走 note_update，所以自动留下了导入前的版本
    let revs = store.note_revision_list(&n.id).unwrap();
    assert_eq!(revs.len(), 1);
    assert_eq!(store.note_revision_get(revs[0].id).unwrap().unwrap().content, "原正文");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn test_vault_import_skips_hidden_and_non_md() {
    let dir = tmp_vault_dir("skip");
    std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
    std::fs::write(dir.join(".obsidian").join("app.json"), "{}").unwrap();
    std::fs::write(dir.join("图.png"), [0u8, 1, 2]).unwrap();
    std::fs::write(dir.join("真笔记.md"), "---\ntitle: 真笔记\n---\n\n正文").unwrap();

    let store = make_store();
    let rep = store.note_import_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(rep.created, 1);
    assert!(rep.skipped >= 2, "隐藏目录与非 md 都该被跳过，实得 {}", rep.skipped);
    assert!(rep.failed.is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn test_vault_export_dedupes_same_title() {
    let dir = tmp_vault_dir("dup");
    let store = make_store();
    store.note_create(None, "同名", "第一条").unwrap();
    store.note_create(None, "同名", "第二条").unwrap();

    let rep = store.note_export_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(rep.notes, 2);
    // 不编号就互相覆盖、静默丢一条
    assert!(dir.join("同名.md").is_file());
    assert!(dir.join("同名 (2).md").is_file());

    std::fs::remove_dir_all(&dir).ok();
}

/// 导出侧必须清理**已删笔记留下的陈旧 `.md`**，否则下次导入会把它复活。
///
/// 这是一个真丢数据的回归用例，而且**不需要第二台机器**：导出侧以前从不删
/// 文件，于是「导出 → 删除 → 再导入」之后，删掉的笔记以一个新 id 回到列表里，
/// 而回收站里那条还在——用户看到两条一模一样的笔记。
#[test]
fn test_vault_export_prunes_stale_md_of_deleted_note() {
    let dir = tmp_vault_dir("prune");
    let store = make_store();
    let gone = store.note_create(None, "会被删掉", "正文一").unwrap();
    store.note_create(None, "留下来", "正文二").unwrap();

    let first = store.note_export_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(first.notes, 2);
    assert!(first.removed.is_empty(), "第一次导出没有陈旧文件可清");
    assert!(dir.join("会被删掉.md").is_file());

    store.note_delete(&gone.id).unwrap();

    let second = store.note_export_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(second.notes, 1);
    assert_eq!(second.removed.len(), 1, "已删笔记的旧文件必须被清掉");
    assert!(second.removed[0].contains("会被删掉"));
    assert!(!dir.join("会被删掉.md").exists());
    assert!(dir.join("留下来.md").is_file(), "活着的笔记不能被误删");

    std::fs::remove_dir_all(&dir).ok();
}

/// 清理只针对**带 `pastepanda_id`** 的文件。
///
/// 用户自己在 vault 里写的 `.md` 一律不动——导出说明页明确请他「把本目录当
/// vault 打开」，而删文件不可逆。漏删一个陈旧文件只是它下次被当墓碑跳过，
/// 误删一个用户的文件则拿不回来；两边代价不对等。
#[test]
fn test_vault_export_keeps_user_authored_md() {
    let dir = tmp_vault_dir("keep");
    let store = make_store();
    store.note_create(None, "库里的", "正文").unwrap();

    // 没有 frontmatter，也就没有 pastepanda_id
    std::fs::write(dir.join("我自己写的.md"), "# 随手记\n\n不是 PastePanda 导出的").unwrap();
    // frontmatter 有、但没有 id（比如从别处拿来的 Obsidian 笔记）
    std::fs::write(dir.join("别人的.md"), "---\ntitle: 别人的\n---\n\n正文").unwrap();

    let rep = store.note_export_dir(dir.to_str().unwrap()).unwrap();
    assert!(
        rep.removed.is_empty(),
        "没有 pastepanda_id 的文件一个都不能删，实得 {:?}",
        rep.removed
    );
    assert!(dir.join("我自己写的.md").is_file());
    assert!(dir.join("别人的.md").is_file());

    std::fs::remove_dir_all(&dir).ok();
}

/// 导入必须认出「这个 id 已经在回收站里」并**跳过**，而不是当新笔记建一条。
///
/// `note_get` 与 `find_note_by_title` 都带 `deleted_at IS NULL`，所以两级匹配都
/// 认不出软删的笔记——以前于是落到 `note_create`，把用户刚删的笔记复活成
/// 一条**新 id** 的笔记（而回收站里那条还在）。注意本例删完**没有重新导出**：
/// 手上那个 vault 就是陈旧的，导出侧的清理帮不上忙，必须导入侧自己兜住。
#[test]
fn test_vault_import_skips_note_in_trash() {
    let dir = tmp_vault_dir("trash");
    let store = make_store();
    let n = store.note_create(None, "删了又导回来", "正文").unwrap();
    store.note_export_dir(dir.to_str().unwrap()).unwrap();

    store.note_delete(&n.id).unwrap();
    assert_eq!(store.note_count(), 0);

    let rep = store.note_import_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(rep.created, 0, "不能把回收站里的笔记复活成一条新笔记");
    assert_eq!(rep.updated, 0, "也不能把正文写进一条还在回收站里的笔记");
    assert_eq!(rep.in_trash.len(), 1, "跳过了就必须报出来（规则 #15.3）");
    assert!(rep.in_trash[0].contains("删了又导回来"));
    assert_eq!(store.note_count(), 0, "库里不该多出任何笔记");

    // 原来那条还安安静静躺在回收站里，用户可以自己恢复
    let trashed = store.note_list_deleted(10).unwrap();
    assert_eq!(trashed.len(), 1);
    assert_eq!(trashed[0].id, n.id);

    std::fs::remove_dir_all(&dir).ok();
}

/// 深目录（超过 [`MAX_FOLDER_DEPTH`]）被平接，**且平接后的同名文件不能互相覆盖**。
///
/// 这是一个真丢数据的回归用例：以前 `A/B/C/D/x.md` 与 `A/B/C/E/x.md` 平接后
/// 都变成【文件夹 C + 标题 x】，第二个文件会命中第一个刚建出的笔记并
/// `note_update` **覆盖掉它的正文**——两篇不同的笔记导完只剩一篇，
/// 而报告显示「新增 1、更新 1」，数字看上去完全正常。
#[test]
fn test_vault_import_deep_dirs_flatten_without_overwriting() {
    let dir = tmp_vault_dir("deep");
    // 目录比上限深一层，最后两个兄弟目录平接后会落进同一个文件夹。
    //
    // ❗ 层数**跟着常量算**而不写死：上限从 3 改到 4 的那一刻，原先写死的
    //   `A/B/C/D` 就变成合法深度了——用例仍然绿，但它已经不再测平接（默默失效）。
    let mut base = dir.clone();
    for i in 0..MAX_FOLDER_DEPTH {
        base = base.join(format!("L{}", i + 1));
    }
    let d = base.join("D");
    let e = base.join("E");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::create_dir_all(&e).unwrap();
    // 两个文件同名同标题，但正文不同。外部 vault 没有 pastepanda_id，
    // 所以必然走【文件夹 + 标题】那一级匹配——也就是出事的那条路。
    std::fs::write(d.join("x.md"), "---\ntitle: x\n---\n\nD 里的内容").unwrap();
    std::fs::write(e.join("x.md"), "---\ntitle: x\n---\n\nE 里的内容").unwrap();

    let store = make_store();
    let rep = store.note_import_dir(dir.to_str().unwrap()).unwrap();

    // 核心断言：两篇都得进来。修之前这里是 created=1 / updated=1。
    assert_eq!(rep.created, 2, "两个不同源文件必须各建一条，不能互相覆盖");
    assert_eq!(rep.updated, 0);
    // 平接要有痕迹（以前这个降级完全不告知）
    assert_eq!(rep.flattened, 2, "两篇的目录都超了上限");
    // 上限要跟着报告发出去，否则前端只能写死数字
    assert_eq!(rep.max_depth, MAX_FOLDER_DEPTH);
    // 撞车的那一篇要报出相对路径（光报 `x.md` 用户分不出是哪个）
    assert_eq!(rep.collided.len(), 1, "第二个文件才算撞车，实得 {:?}", rep.collided);
    assert!(
        rep.collided[0].contains('/'),
        "撞车报告要带相对路径，实得 {:?}",
        rep.collided[0]
    );
    assert!(rep.failed.is_empty(), "平接不是失败，不该进 failed：{:?}", rep.failed);

    // 两份正文都在库里（这才是「没丢数据」的真正断言）
    let notes = store.note_list("all", &[], 50, 0).unwrap();
    assert!(notes.iter().any(|n| n.content.contains("D 里的内容")));
    assert!(notes.iter().any(|n| n.content.contains("E 里的内容")));

    // 深度封顶：只建到上限那一层，最深那对兄弟目录不会变成文件夹
    let folders = store.folder_list().unwrap();
    assert!(folders.iter().all(|f| f.depth <= MAX_FOLDER_DEPTH));
    assert!(!folders.iter().any(|f| f.name == "D" || f.name == "E"));

    std::fs::remove_dir_all(&dir).ok();
}

/// 单篇失败（这里用超大文件触发）**只让那一篇失败**，整次报告照旧返回。
///
/// 修两件事：
/// ① 以前这条路上**一个大小限制都没有**（裸 `read_to_string`）；
/// ② 以前中途任何一步出错都是 `?` 直接抛出，已累计的 created/updated 随之丢弃
///   ——用户只看到「导入失败」，但库里已经进了一批。
#[test]
fn test_vault_import_oversize_file_does_not_sink_the_whole_run() {
    let dir = tmp_vault_dir("oversize");
    std::fs::create_dir_all(&dir).unwrap();
    // 刚刚超过 10MB 上限
    let big = "a".repeat(10 * 1024 * 1024 + 64);
    std::fs::write(dir.join("大家伙.md"), &big).unwrap();
    std::fs::write(dir.join("正常的.md"), "---\ntitle: 正常的\n---\n\n正文").unwrap();

    let store = make_store();
    let rep = store.note_import_dir(dir.to_str().unwrap()).unwrap();

    // 正常的那篇照导，整次不被拖垮
    assert_eq!(rep.created, 1, "大文件不该拖垮其它文件");
    assert_eq!(rep.failed.len(), 1, "大文件要进 failed，实得 {:?}", rep.failed);
    // 失败条目要**带原因**，不能只给个文件名（规则 #15.3）
    assert!(
        rep.failed[0].contains("过大"),
        "失败原因要说得出是太大，实得 {:?}",
        rep.failed[0]
    );
    // 大文件没进库
    let notes = store.note_list("all", &[], 50, 0).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "正常的");

    std::fs::remove_dir_all(&dir).ok();
}

// ============================================================
// 笔记轻量 AI（B1 ＋轻量 AI）
// ============================================================

#[test]
fn test_parse_ai_tags_tolerates_model_chatter() {
    // 理想输出
    assert_eq!(parse_ai_tags("会议纪要, 发布计划, 回归测试"), vec!["会议纪要", "发布计划", "回归测试"]);
    // 中文逗号 / 顿号 / 分号
    assert_eq!(parse_ai_tags("前端、React；性能"), vec!["前端", "React", "性能"]);
    // 编号 + 换行 + # + 引号
    assert_eq!(
        parse_ai_tags("1. #前端\n2. \"React\"\n3. 性能优化"),
        vec!["前端", "React", "性能优化"]
    );
    // 开场白那行含冒号 ⇒ 丢掉，不能当标签写进去
    let r = parse_ai_tags("好的，标签如下：\n前端, React");
    assert_eq!(r, vec!["前端", "React"], "带冒号的开场白必须被丢掉，实得 {r:?}");
}

#[test]
fn test_parse_ai_tags_drops_junk_and_caps() {
    // 一句话当标签 → 超长丢掉
    let long = "这是一个非常长的句子模型把它当成了标签";
    assert!(parse_ai_tags(long).is_empty());
    // 去重（大小写不敏感）
    assert_eq!(parse_ai_tags("React, react, REACT"), vec!["React"]);
    // 最多 5 个
    assert_eq!(parse_ai_tags("a,b,c,d,e,f,g").len(), 5);
    // 完全解析不出就返回空，而不是塞垃圾
    assert!(parse_ai_tags("").is_empty());
}

#[test]
fn test_ai_tags_are_appended_and_marked() {
    let store = make_store();
    let n = store.note_create(None, "标题", "正文").unwrap();

    // 用户先手打一个标签
    let manual = store.create_tag("我打的", "#000000").unwrap();
    store.note_set_tags(&n.id, &[manual.id.clone()]).unwrap();

    let added = store.note_add_ai_tags(&n.id, "前端, 我打的, React").unwrap();
    // 「我打的」已存在 ⇒ 不算新增，也不能被降级成 ai
    assert_eq!(added, vec!["前端".to_string(), "React".to_string()]);

    let tags = store.note_get(&n.id).unwrap().unwrap().tags;
    assert_eq!(tags.len(), 3, "AI 标签是追加，不能把用户手打的抹掉");

    // 来源标记：AI 的标 ai，用户的仍是 manual
    let conn_check = store.note_get(&n.id).unwrap().unwrap();
    assert!(conn_check.tags.iter().any(|t| t.name == "我打的"));
}

#[test]
fn test_summary_write_clear_and_roundtrip() {
    let store = make_store();
    let n = store.note_create(None, "标题", "正文").unwrap();
    assert!(store.note_get(&n.id).unwrap().unwrap().summary.is_none(), "新建笔记不该有摘要");

    let before = store.note_get(&n.id).unwrap().unwrap().updated_at;
    store.note_set_summary(&n.id, Some("一句话摘要")).unwrap();
    let got = store.note_get(&n.id).unwrap().unwrap();
    assert_eq!(got.summary.as_deref(), Some("一句话摘要"));
    assert_eq!(got.updated_at, before, "写摘要不该把笔记顶到列表最前");

    // 清空存空串，与「从未生成」的 NULL 区分
    store.note_set_summary(&n.id, Some("")).unwrap();
    assert_eq!(store.note_get(&n.id).unwrap().unwrap().summary.as_deref(), Some(""));

    // 导出 → 导入往返带上 summary
    store.note_set_summary(&n.id, Some("会议要点")).unwrap();
    let note = store.note_get(&n.id).unwrap().unwrap();
    let md = note_to_markdown(&note, true);
    assert!(md.contains("summary: 会议要点"), "frontmatter 应带 summary：{md}");
    assert_eq!(markdown_to_note(&md, "x").summary.as_deref(), Some("会议要点"));
}
