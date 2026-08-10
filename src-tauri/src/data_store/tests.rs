use super::*;

/// 创建内存数据库的 DataStore（每个测试独立隔离）
fn make_store() -> DataStore {
    DataStore::new(":memory:").expect("无法创建内存数据库")
}

/// 创建一条测试用的 HistoryItem
fn make_item(id: &str, text: &str, time: &str, item_type: &str) -> HistoryItem {
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

    let found = store.find_latest_by_md5(&md5, "默认").unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().id, "md5-1");
}

#[test]
fn test_find_latest_by_md5_not_found() {
    let store = make_store();
    let found = store.find_latest_by_md5("nonexistent_md5", "默认").unwrap();
    assert!(found.is_none());
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
        .find_latest_by_md5(&md5_hash, "默认")
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
    let found = store.find_latest_by_md5(&md5, "默认").unwrap();
    assert!(found.is_none());
    // 相同 workspace 下应命中
    let found = store.find_latest_by_md5(&md5, "其他工作区").unwrap();
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
        .update_history_time("time-1", "2024-06-01 12:00:00")
        .unwrap();

    let result = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(result[0].time, "2024-06-01 12:00:00");
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
    // 应该有 30 个自动标签种子
    assert_eq!(tags.len(), 30);
    // 全部 source 为 "auto"
    assert!(tags.iter().all(|t| t.source == "auto"));
    // 图文混排的类型标识必须在标签体系里（而不是卡片上写死的徽标），
    // 否则点不了筛选、也不会出现在筛选标签列表里
    assert!(tags.iter().any(|t| t.name == "图文"));
}

#[test]
fn test_ensure_auto_tags_idempotent() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();
    store.ensure_auto_tags().unwrap();

    let tags = store.get_tags().unwrap();
    assert_eq!(tags.len(), 30); // 不应重复插入
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
            })
            .collect(),
        sort_order: 0,
        created_at: String::new(),
        updated_at: String::new(),
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
        .insert_history(&make_item("sec1", "sk-abcdef1234567890abcdef1234567890", "2026-08-10 10:00:00", "text"))
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
