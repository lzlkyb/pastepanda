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
    // 应该有 29 个自动标签种子
    assert_eq!(tags.len(), 29);
    // 全部 source 为 "auto"
    assert!(tags.iter().all(|t| t.source == "auto"));
}

#[test]
fn test_ensure_auto_tags_idempotent() {
    let store = make_store();
    store.ensure_auto_tags().unwrap();
    store.ensure_auto_tags().unwrap();

    let tags = store.get_tags().unwrap();
    assert_eq!(tags.len(), 29); // 不应重复插入
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
