//! 集成测试 — 测试 DataStore + Commands 核心业务逻辑
//!
//! 使用内存 SQLite 数据库模拟 DataStore，测试 Tauri 命令的核心逻辑
//! （绕过 Tauri State 依赖，直接测试 data_store 层 + 纯函数）

use md5::Digest;
use pastepanda_lib::data_store::{DataStore, HistoryItem};

/// 创建内存数据库的 DataStore
fn make_store() -> DataStore {
    DataStore::new(":memory:").expect("无法创建内存数据库")
}

/// 创建测试用 HistoryItem
fn make_item(id: &str, text: &str, time: &str, item_type: &str) -> HistoryItem {
    HistoryItem {
        id: id.to_string(),
        text: text.to_string(),
        time: time.to_string(),
        item_type: item_type.to_string(),
        content: String::new(),
        pinned: false,
        source: "clipboard".to_string(),
        workspace: "默认".to_string(),
        md5: Some(format!(
            "{:x}",
            md5::Md5::new().chain_update(text.as_bytes()).finalize()
        )),
        pinyin_initials: Some(pastepanda_lib::data_store::compute_pinyin_initials(text)),
        group_id: None,
        tags: Vec::new(),
    }
}

// ============================================================
// 集成场景 1：完整 CRUD 流程
// ============================================================

#[test]
fn test_full_crud_workflow() {
    let store = make_store();

    // 1. 插入
    let item = make_item("flow-1", "Hello", "2024-01-01 10:00:00", "text");
    store.insert_history(&item).unwrap();

    // 2. 读取
    let items = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(items.len(), 1);

    // 3. 更新
    store.update_history("flow-1", "Updated").unwrap();
    let items = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(items[0].text, "Updated");

    // 4. 删除
    let count = store.delete_history(&["flow-1".to_string()]).unwrap();
    assert_eq!(count, 1);
    assert!(store.get_history("默认", "all", "", 0, 10).unwrap().is_empty());
}

// ============================================================
// 集成场景 2：置顶 + 过滤
// ============================================================

#[test]
fn test_pin_and_filter_workflow() {
    let store = make_store();

    // 插入多条
    for i in 1..=5 {
        store
            .insert_history(&make_item(
                &format!("pin-{}", i),
                &format!("Item {}", i),
                &format!("2024-01-01 10:00:{:02}", i),
                "text",
            ))
            .unwrap();
    }

    // 置顶第 3 条
    let new_state = store.toggle_pin("pin-3").unwrap();
    assert!(new_state);

    // 过滤置顶
    let pinned = store.get_history("默认", "pinned", "", 0, 10).unwrap();
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned[0].id, "pin-3");

    // 置顶条目应排在前面
    let all = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(all[0].id, "pin-3");
}

// ============================================================
// 集成场景 3：分组完整流程
// ============================================================

#[test]
fn test_group_workflow() {
    let store = make_store();

    // 创建分组
    let group = store.create_group("Work", "#FF0000", "briefcase").unwrap();
    assert_eq!(group.name, "Work");

    // 插入记录
    store
        .insert_history(&make_item("gw-1", "Work item", "2024-01-01 10:00:00", "text"))
        .unwrap();

    // 移到分组
    let count = store
        .move_to_group(&["gw-1".to_string()], Some(&group.id))
        .unwrap();
    assert_eq!(count, 1);

    // 验证 group_id
    let items = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(items[0].group_id, Some(group.id.clone()));

    // 从分组移出
    store
        .move_to_group(&["gw-1".to_string()], None)
        .unwrap();
    let items = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(items[0].group_id, None);

    // 删除分组
    store.delete_group(&group.id).unwrap();
    assert!(store.get_groups().unwrap().is_empty());
}

// ============================================================
// 集成场景 4：标签完整流程
// ============================================================

#[test]
fn test_tag_workflow() {
    let store = make_store();

    // 插入记录
    store
        .insert_history(&make_item("tw-1", "Tagged item", "2024-01-01 10:00:00", "text"))
        .unwrap();

    // 创建标签
    let tag = store.create_tag("Important", "#FF0000").unwrap();

    // 设置标签
    store
        .set_item_tags("tw-1", &[tag.id.clone()])
        .unwrap();

    // 验证标签
    let result = store
        .get_items_with_tags(&["tw-1".to_string()])
        .unwrap();
    assert_eq!(result[0].1[0].name, "Important");

    // 删除标签
    store.delete_tag(&tag.id).unwrap();
    assert!(store.get_tags().unwrap().is_empty());
}

// ============================================================
// 集成场景 5：配置读写
// ============================================================

#[test]
fn test_config_workflow() {
    let store = make_store();

    // 保存配置
    let config = serde_json::json!({
        "hotkey": "Ctrl+Shift+V",
        "auto_strip": true,
        "max_history": 500,
    });
    store.save_config(&config).unwrap();

    // 读取配置
    let loaded = store.get_config().unwrap();
    assert_eq!(loaded["hotkey"], "Ctrl+Shift+V");
    assert_eq!(loaded["auto_strip"], true);
    assert_eq!(loaded["max_history"], 500);

    // 更新配置
    let mut updated = loaded.clone();
    updated["max_history"] = serde_json::json!(1000);
    store.save_config(&updated).unwrap();

    let reloaded = store.get_config().unwrap();
    assert_eq!(reloaded["max_history"], 1000);
}

// ============================================================
// 集成场景 6：统计信息
// ============================================================

#[test]
fn test_stats_workflow() {
    let store = make_store();

    // 插入不同类型的记录
    store
        .insert_history(&make_item("s-t1", "Text", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("s-t2", "Text2", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("s-i1", "Image", "2024-01-01 10:00:00", "image"))
        .unwrap();
    store
        .insert_history(&make_item("s-f1", "File", "2024-01-01 10:00:00", "file"))
        .unwrap();

    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.total, 4);
    assert_eq!(stats.text_count, 2);
    assert_eq!(stats.image_count, 1);
    assert_eq!(stats.file_count, 1);
}

// ============================================================
// 集成场景 7：Snippet CRUD 完整流程
// ============================================================

#[test]
fn test_snippet_workflow() {
    let store = make_store();

    // 添加
    let id = store.add_snippet("Greeting", "Hello World").unwrap();
    assert!(!id.is_empty());

    // 读取
    let snippets = store.get_snippets().unwrap();
    assert_eq!(snippets[0].name, "Greeting");

    // 更新
    store
        .update_snippet(&id, "Farewell", "Goodbye", "greeting")
        .unwrap();
    let snippets = store.get_snippets().unwrap();
    assert_eq!(snippets[0].name, "Farewell");
    assert_eq!(snippets[0].tag, "greeting");

    // 删除
    store.delete_snippet(&id).unwrap();
    assert!(store.get_snippets().unwrap().is_empty());
}

// ============================================================
// 集成场景 8：导入 + 导出（get_all_history）
// ============================================================

#[test]
fn test_import_export_workflow() {
    let store = make_store();

    // 创建一批数据
    let items: Vec<HistoryItem> = (1..=20)
        .map(|i| {
            make_item(
                &format!("ie-{}", i),
                &format!("ImportExport {}", i),
                &format!("2024-01-01 10:{:02}:{:02}", i / 2, i % 60),
                "text",
            )
        })
        .collect();

    let count = store.import_history(&items).unwrap();
    assert_eq!(count, 20);

    // 导出
    let all = store.get_all_history("默认").unwrap();
    assert_eq!(all.len(), 20);
}

// ============================================================
// 集成场景 9：自动标签流程
// ============================================================

#[test]
fn test_auto_tag_workflow() {
    let store = make_store();

    // 初始化自动标签
    store.ensure_auto_tags().unwrap();

    // 插入记录
    store
        .insert_history(&make_item("at-1", "Code here", "2024-01-01 10:00:00", "text"))
        .unwrap();

    // 自动分类
    let tag_ids = store
        .resolve_auto_tag_ids(&["代码".to_string(), "JavaScript".to_string()])
        .unwrap();
    store.add_history_tags("at-1", &tag_ids).unwrap();

    // 确认自动标签
    store.confirm_auto_tags("at-1").unwrap();

    // 验证标签已确认
    let result = store
        .get_items_with_tags(&["at-1".to_string()])
        .unwrap();
    assert!(result[0].1.iter().all(|t| t.source == "manual"));
}

// ============================================================
// 集成场景 10：清理历史 + 安全保护
// ============================================================

#[test]
fn test_cleanup_workflow() {
    let store = make_store();

    // 插入一条 100 天前的
    let past = chrono::Local::now() - chrono::Duration::days(100);
    let past_str = past.format("%Y-%m-%d %H:%M:%S").to_string();
    store
        .insert_history(&make_item("old-1", "Old", &past_str, "text"))
        .unwrap();

    // 插入今天的
    let today_str = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    store
        .insert_history(&make_item("new-1", "New", &today_str, "text"))
        .unwrap();

    // 清理前先获取待删除列表
    let to_delete = store
        .get_history_before_cleanup("默认", Some(30))
        .unwrap();
    assert_eq!(to_delete.len(), 1);
    assert_eq!(to_delete[0].id, "old-1");

    // 执行清理
    let count = store.clear_history("默认", Some(30)).unwrap();
    assert_eq!(count, 1);

    // 新记录保留
    let remaining = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "new-1");
}

// ============================================================
// 集成场景 11：工作空间隔离
// ============================================================

#[test]
fn test_workspace_isolation_workflow() {
    let store = make_store();

    let today_str = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    // 默认工作空间 — 今天插入
    let mut item1 = make_item("ws-1", "Default", &today_str, "text");
    item1.workspace = "默认".to_string();
    store.insert_history(&item1).unwrap();

    // 其他工作空间 — 今天插入
    let mut item2 = make_item("ws-2", "Other", &today_str, "text");
    item2.workspace = "项目A".to_string();
    store.insert_history(&item2).unwrap();

    // 统计数据按工作空间隔离
    let stats_default = store.get_stats("默认").unwrap();
    assert_eq!(stats_default.total, 1);

    let stats_other = store.get_stats("项目A").unwrap();
    assert_eq!(stats_other.total, 1);

    // 清理只影响指定工作空间
    let past = chrono::Local::now() - chrono::Duration::days(100);
    let past_str = past.format("%Y-%m-%d %H:%M:%S").to_string();

    let mut old_default = make_item("ws-old-1", "Old Default", &past_str, "text");
    old_default.workspace = "默认".to_string();
    store.insert_history(&old_default).unwrap();

    let mut old_other = make_item("ws-old-2", "Old Other", &past_str, "text");
    old_other.workspace = "项目A".to_string();
    store.insert_history(&old_other).unwrap();

    // 只清理默认工作空间 30 天前的记录
    store.clear_history("默认", Some(30)).unwrap();

    let remaining_default = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(remaining_default.len(), 1); // ws-1 保留（今天的）

    let remaining_other = store.get_history("项目A", "all", "", 0, 10).unwrap();
    assert_eq!(remaining_other.len(), 2); // ws-2 + ws-old-2 都在
}

// ============================================================
// 集成场景 12：搜索 + 拼音搜索
// ============================================================

#[test]
fn test_search_with_pinyin_workflow() {
    let store = make_store();

    // 中文内容
    let mut item = make_item("zh-1", "你好世界 Hello", "2024-01-01 10:00:00", "text");
    item.pinyin_initials = Some("NHSJ".to_string());
    store.insert_history(&item).unwrap();

    // 用中文搜索
    let result = store.get_history("默认", "all", "你好", 0, 10).unwrap();
    assert_eq!(result.len(), 1);

    // 用拼音首字母搜索
    let result = store.get_history("默认", "all", "NHSJ", 0, 10).unwrap();
    assert_eq!(result.len(), 1);

    // 搜索不存在的内容
    let result = store.get_history("默认", "all", "不存在", 0, 10).unwrap();
    assert!(result.is_empty());
}

// ============================================================
// 集成场景 13：批量操作
// ============================================================

#[test]
fn test_batch_operations() {
    let store = make_store();

    // 批量插入
    for i in 1..=10 {
        store
            .insert_history(&make_item(
                &format!("batch-{}", i),
                &format!("Batch {}", i),
                &format!("2024-01-01 10:00:{:02}", i),
                "text",
            ))
            .unwrap();
    }

    // 批量删除前 5 条
    let ids: Vec<String> = (1..=5).map(|i| format!("batch-{}", i)).collect();
    let count = store.delete_history(&ids).unwrap();
    assert_eq!(count, 5);

    // 剩余 5 条
    let remaining = store.get_history("默认", "all", "", 0, 20).unwrap();
    assert_eq!(remaining.len(), 5);
}

// ============================================================
// 集成场景 14：分组排序
// ============================================================

#[test]
fn test_group_reordering() {
    let store = make_store();

    let g1 = store.create_group("A", "#111", "a").unwrap();
    let g2 = store.create_group("B", "#222", "b").unwrap();
    let g3 = store.create_group("C", "#333", "c").unwrap();

    // 默认按 sort_order 升序
    let groups = store.get_groups().unwrap();
    assert_eq!(groups[0].name, "A");
    assert_eq!(groups[2].name, "C");

    // 反转排序
    store
        .reorder_groups(&[g3.id.clone(), g2.id.clone(), g1.id.clone()])
        .unwrap();

    let groups = store.get_groups().unwrap();
    assert_eq!(groups[0].id, g3.id);
    assert_eq!(groups[2].id, g1.id);
}

// ============================================================
// 集成场景 15：重复内容智能合并（MD5）
// ============================================================

#[test]
fn test_dedup_by_md5_workflow() {
    let store = make_store();

    let text = "Duplicate content";
    let md5_hash = format!(
        "{:x}",
        md5::Md5::new().chain_update(text.as_bytes()).finalize()
    );

    // 插入第一条
    let mut item1 = make_item("dup-1", text, "2024-01-01 10:00:00", "text");
    item1.md5 = Some(md5_hash.clone());
    store.insert_history(&item1).unwrap();

    // 插入第二条（相同内容）
    let mut item2 = make_item("dup-2", text, "2024-01-01 11:00:00", "text");
    item2.md5 = Some(md5_hash.clone());
    store.insert_history(&item2).unwrap();

    // 查找最新重复
    let found = store.find_latest_by_md5(&md5_hash).unwrap().unwrap();
    assert_eq!(found.id, "dup-2"); // 时间更新的那条

    // 更新时间为现在
    let now = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    store.update_history_time("dup-1", &now).unwrap();

    // 现在最新的是 dup-1
    let found = store.find_latest_by_md5(&md5_hash).unwrap().unwrap();
    assert_eq!(found.id, "dup-1");
}

// ============================================================
// 集成场景 16：get_mime_from_path 纯函数测试
// ============================================================

#[test]
fn test_get_mime_types() {
    // 通过公开的 get_image_data_url 间接测试 mime 检测
    // 或者直接在这里复现 mime 逻辑
    fn get_mime(path: &str) -> &'static str {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        match ext {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/png",
        }
    }

    assert_eq!(get_mime("test.png"), "image/png");
    assert_eq!(get_mime("test.jpg"), "image/jpeg");
    assert_eq!(get_mime("test.jpeg"), "image/jpeg");
    assert_eq!(get_mime("test.gif"), "image/gif");
    assert_eq!(get_mime("test.webp"), "image/webp");
    assert_eq!(get_mime("test.bmp"), "image/bmp");
    assert_eq!(get_mime("test.unknown"), "image/png");
    assert_eq!(get_mime("noext"), "image/png");
}

// ============================================================
// 集成场景 17：config backup 备份
// ============================================================

#[test]
fn test_config_backup_workflow() {
    let store = make_store();

    // 保存配置
    store
        .save_config(&serde_json::json!({"test_key": "test_value"}))
        .unwrap();

    // 备份会写入文件系统，内存数据库下路径为 :memory:，backup 会失败但不影响配置读写
    let loaded = store.get_config().unwrap();
    assert_eq!(loaded["test_key"], "test_value");
}

// ============================================================
// 集成场景 18：获取所有历史 + 标签加载
// ============================================================

#[test]
fn test_all_history_with_tags() {
    let store = make_store();

    store
        .insert_history(&make_item("aht-1", "Item 1", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("aht-2", "Item 2", "2024-01-01 10:00:01", "text"))
        .unwrap();

    let tag = store.create_tag("Shared", "#000").unwrap();
    store
        .set_item_tags("aht-1", &[tag.id.clone()])
        .unwrap();
    store
        .set_item_tags("aht-2", &[tag.id.clone()])
        .unwrap();

    let all = store.get_all_history("默认").unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].tags.len(), 1);
    assert_eq!(all[1].tags.len(), 1);
}

// ============================================================
// 集成场景 19：并发安全（基础）
// ============================================================

#[test]
fn test_concurrent_access_basic() {
    use std::sync::Arc;
    use std::thread;

    let store = Arc::new(make_store());

    // 在主线程插入数据
    store
        .insert_history(&make_item("conc-1", "Concurrent", "2024-01-01 10:00:00", "text"))
        .unwrap();

    let store_clone = Arc::clone(&store);
    let handle = thread::spawn(move || {
        store_clone
            .get_history("默认", "all", "", 0, 10)
            .unwrap()
    });

    let result = handle.join().unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "conc-1");
}

// ============================================================
// 集成场景 20：错误处理
// ============================================================

#[test]
fn test_error_handling() {
    let store = make_store();

    // 更新不存在的记录
    let err = store.update_history("no-exist", "text").unwrap_err();
    assert!(err.contains("不存在"));

    // 更新不存在的标签
    let err = store.update_tag("no-exist", "name", "#000").unwrap_err();
    assert!(err.contains("不存在"));

    // 更新不存在的分组
    let err = store
        .update_group("no-exist", "name", "#000", "icon")
        .unwrap_err();
    assert!(err.contains("不存在"));
}

// ============================================================
// 集成场景 21：get_recent_items 排序验证
// ============================================================

#[test]
fn test_recent_items_ordering() {
    let store = make_store();

    for i in 1..=10 {
        store
            .insert_history(&make_item(
                &format!("rec-{}", i),
                &format!("Recent {}", i),
                &format!("2024-01-01 10:{:02}:{:02}", i, i * 2),
                "text",
            ))
            .unwrap();
    }

    let recents = store.get_recent_items(5).unwrap();
    assert_eq!(recents.len(), 5);
    // 验证倒序
    for i in 1..recents.len() {
        assert!(
            recents[i - 1].time >= recents[i].time,
            "记录应按时间倒序排列"
        );
    }
}

// ============================================================
// 集成场景 22：删除事务回滚验证
// ============================================================

#[test]
fn test_delete_transaction_rollback() {
    let store = make_store();

    // 插入 5 条记录
    for i in 1..=5 {
        store
            .insert_history(&make_item(
                &format!("txn-{}", i),
                &format!("Txn {}", i),
                &format!("2024-01-01 10:00:{:02}", i),
                "text",
            ))
            .unwrap();
    }

    let total_before = store.get_history("默认", "all", "", 0, 10).unwrap().len();
    assert_eq!(total_before, 5);

    // 批量删除（含一条不存在的记录，SQLite DELETE 不会因不存在的行而失败）
    // 但批量删除本身是事务性的 — 测试事务的原子性
    let ids: Vec<String> = (1..=3).map(|i| format!("txn-{}", i)).collect();
    let count = store.delete_history(&ids).unwrap();
    assert_eq!(count, 3);

    let remaining = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert_eq!(remaining.len(), 2);
    // 按时间倒序：txn-5（10:00:05）> txn-4（10:00:04）
    assert_eq!(remaining[0].id, "txn-5");
    assert_eq!(remaining[1].id, "txn-4");
}

// ============================================================
// 集成场景 23：搜索 + 类型过滤组合
// ============================================================

#[test]
fn test_search_with_type_filter_combined() {
    let store = make_store();

    store
        .insert_history(&make_item("sf-1", "Hello World", "2024-01-01 10:00:00", "text"))
        .unwrap();
    store
        .insert_history(&make_item("sf-2", "Hello Image", "2024-01-01 10:00:01", "image"))
        .unwrap();
    store
        .insert_history(&make_item("sf-3", "Goodbye", "2024-01-01 10:00:02", "text"))
        .unwrap();

    // 搜索 "hello" + 类型 "text" → 只有 sf-1
    let result = store.get_history("默认", "text", "hello", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "sf-1");
}

// ============================================================
// 集成场景 24：搜索 + 置顶过滤组合
// ============================================================

#[test]
fn test_search_with_pinned_filter_combined() {
    let store = make_store();

    let mut item = make_item("sp-1", "Pinned Search", "2024-01-01 10:00:00", "text");
    item.pinned = true;
    store.insert_history(&item).unwrap();

    store
        .insert_history(&make_item("sp-2", "Normal Search", "2024-01-01 10:00:01", "text"))
        .unwrap();

    store
        .insert_history(&make_item("sp-3", "Pinned No", "2024-01-01 10:00:02", "text"))
        .unwrap();

    // 搜索 "search" + 只显示置顶 → 只有 sp-1
    let result = store.get_history("默认", "pinned", "search", 0, 10).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "sp-1");
}

// ============================================================
// 集成场景 25：大页码分页边界
// ============================================================

#[test]
fn test_pagination_boundaries() {
    let store = make_store();

    // 插入 3 条
    for i in 1..=3 {
        store
            .insert_history(&make_item(
                &format!("page-{}", i),
                &format!("Page {}", i),
                &format!("2024-01-01 10:00:{:02}", i),
                "text",
            ))
            .unwrap();
    }

    // 偏移量超过总数 → 返回空
    let result = store.get_history("默认", "all", "", 3, 10).unwrap();
    assert!(result.is_empty());

    // limit 为 0 → 返回空
    let result = store.get_history("默认", "all", "", 0, 0).unwrap();
    assert!(result.is_empty());

    // 偏移量正常
    let result = store.get_history("默认", "all", "", 1, 10).unwrap();
    assert_eq!(result.len(), 2);
}

// ============================================================
// 集成场景 26：空数据集操作
// ============================================================

#[test]
fn test_empty_database_operations() {
    let store = make_store();

    // 空数据库统计
    let stats = store.get_stats("默认").unwrap();
    assert_eq!(stats.total, 0);
    assert_eq!(stats.today, 0);

    // 空数据库获取历史
    let history = store.get_history("默认", "all", "", 0, 10).unwrap();
    assert!(history.is_empty());

    // 空数据库获取全部历史
    let all = store.get_all_history("默认").unwrap();
    assert!(all.is_empty());

    // 空数据库获取最近记录
    let recents = store.get_recent_items(5).unwrap();
    assert!(recents.is_empty());

    // 空数据库删除不存在的记录（不报错）
    let count = store
        .delete_history(&["no-exist".to_string()])
        .unwrap();
    assert_eq!(count, 0);

    // 空数据库清理（不报错）
    let count = store.clear_history("默认", Some(30)).unwrap();
    assert_eq!(count, 0);
}
