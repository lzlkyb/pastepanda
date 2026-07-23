//! Schema 迁移测试 — 验证 DataStore::new() 对旧版数据库的幂等升级
//!
//! 模拟从各历史版本升级：手动创建缺少新列的旧表结构，
//! 然后调用 DataStore::new() 触发迁移，验证列被正确添加。

use rusqlite::Connection;

/// 创建仅含 v1 基础列的 history 表（模拟最早版本）
fn create_v1_db(path: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE history (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL DEFAULT '',
            time TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text',
            content TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT '',
            workspace TEXT NOT NULL DEFAULT '默认',
            md5 TEXT
        );
        CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE snippets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            content TEXT NOT NULL
        );
        CREATE TABLE groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#3B82F6',
            icon TEXT NOT NULL DEFAULT 'folder',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL DEFAULT '#3B82F6',
            created_at TEXT NOT NULL
        );
        CREATE TABLE history_tags (
            history_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (history_id, tag_id)
        );",
    )
    .unwrap();
}

/// 检查某表是否包含指定列
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let count: i32 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = '{}'",
                table, column
            ),
            [],
            |row| row.get(0),
        )
        .unwrap();
    count > 0
}

#[test]
fn test_migration_adds_pinyin_initials() {
    let dir = std::env::temp_dir().join(format!("pp_mig_pinyin_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);
    // 验证旧表确实没有 pinyin_initials
    let conn = Connection::open(path_str).unwrap();
    assert!(!has_column(&conn, "history", "pinyin_initials"));
    drop(conn);

    // 触发迁移
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    let conn = Connection::open(path_str).unwrap();
    assert!(has_column(&conn, "history", "pinyin_initials"));
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_adds_group_id() {
    let dir = std::env::temp_dir().join(format!("pp_mig_group_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    let conn = Connection::open(path_str).unwrap();
    assert!(has_column(&conn, "history", "group_id"));
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_adds_source_icon() {
    let dir = std::env::temp_dir().join(format!("pp_mig_icon_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    let conn = Connection::open(path_str).unwrap();
    assert!(has_column(&conn, "history", "source_icon"));
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_adds_snippets_columns() {
    let dir = std::env::temp_dir().join(format!("pp_mig_snip_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    let conn = Connection::open(path_str).unwrap();
    assert!(has_column(&conn, "snippets", "tag"));
    assert!(has_column(&conn, "snippets", "copy_count"));
    assert!(has_column(&conn, "snippets", "last_used_at"));
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_adds_tags_source() {
    let dir = std::env::temp_dir().join(format!("pp_mig_tagsrc_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    let conn = Connection::open(path_str).unwrap();
    assert!(has_column(&conn, "tags", "source"));
    assert!(has_column(&conn, "history_tags", "source"));
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_idempotent_open_twice() {
    let dir = std::env::temp_dir().join(format!("pp_mig_idem_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);

    // 第一次打开：触发迁移
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    // 第二次打开：所有列已存在，不应报错
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    // 验证数据完整性
    let conn = Connection::open(path_str).unwrap();
    assert!(has_column(&conn, "history", "pinyin_initials"));
    assert!(has_column(&conn, "history", "group_id"));
    assert!(has_column(&conn, "history", "source_icon"));
    assert!(has_column(&conn, "snippets", "tag"));
    assert!(has_column(&conn, "snippets", "copy_count"));
    assert!(has_column(&conn, "snippets", "last_used_at"));
    assert!(has_column(&conn, "tags", "source"));
    assert!(has_column(&conn, "history_tags", "source"));
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_preserves_existing_data() {
    let dir = std::env::temp_dir().join(format!("pp_mig_data_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);

    // 插入旧数据
    let conn = Connection::open(path_str).unwrap();
    conn.execute(
        "INSERT INTO history (id, text, time, type, content, pinned, source, workspace, md5)
         VALUES ('h1', '测试文本', '2026-01-01 12:00:00', 'text', '', 0, 'test', '默认', 'abc123')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO snippets (id, name, content) VALUES ('s1', '片段1', '内容1')",
        [],
    )
    .unwrap();
    drop(conn);

    // 触发迁移
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();

    // 验证旧数据仍在且新列有默认值
    let items = store.get_history("默认", "all", "", 0, 50).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].text, "测试文本");
    assert_eq!(items[0].pinyin_initials, None); // 旧数据无拼音
    assert_eq!(items[0].group_id, None);

    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_migration_syncs_auto_tag_source() {
    let dir = std::env::temp_dir().join(format!("pp_mig_autotag_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");
    let path_str = db_path.to_str().unwrap();

    create_v1_db(path_str);

    // 手动添加 source 列到 tags（模拟中间版本）并插入自动标签
    let conn = Connection::open(path_str).unwrap();
    conn.execute_batch(
        "ALTER TABLE tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
         INSERT INTO tags (id, name, color, created_at, source) VALUES ('t1', '代码', '#3B82F6', '2026-01-01', 'auto');
         INSERT INTO history (id, text, time, type, content, pinned, source, workspace, md5)
             VALUES ('h1', 'code', '2026-01-01 12:00:00', 'text', '', 0, '', '默认', 'x');
         INSERT INTO history_tags (history_id, tag_id) VALUES ('h1', 't1');",
    )
    .unwrap();
    drop(conn);

    // 触发迁移：history_tags 应获得 source 列，且自动标签关联同步为 'auto'
    let store = pastepanda_lib::data_store::DataStore::new(path_str).unwrap();
    drop(store);

    let conn = Connection::open(path_str).unwrap();
    let source: String = conn
        .query_row(
            "SELECT source FROM history_tags WHERE history_id = 'h1' AND tag_id = 't1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(source, "auto");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}
