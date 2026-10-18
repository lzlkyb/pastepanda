use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("pastepanda-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn db(&self) -> PathBuf {
        self.0.join("clipboard.db")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn storage_files_include_wal_and_attachments_exactly_once() {
    let f = Fixture::new();
    for (name, n) in [
        ("clipboard.db", 32),
        ("clipboard.db-wal", 8),
        ("clipboard.db-shm", 4),
        ("config.json", 7),
    ] {
        fs::write(f.0.join(name), vec![0; n]).unwrap();
    }
    fs::create_dir_all(f.0.join("images/nested")).unwrap();
    fs::write(f.0.join("images/a.png"), [0; 10]).unwrap();
    fs::write(f.0.join("images/nested/b.png"), [0; 20]).unwrap();
    fs::create_dir(f.0.join("thumbnails")).unwrap();
    fs::write(f.0.join("thumbnails/a.png"), [0; 6]).unwrap();
    let fast = overview(&f.db(), &ReadTask::default(), false).unwrap();
    assert_eq!(fast.database_bytes, 44);
    assert_eq!(fast.total_bytes, 51);
    assert!(!fast.complete);
    let full = overview(&f.db(), &ReadTask::default(), true).unwrap();
    assert_eq!(full.total_bytes, 87);
    assert_eq!(full.database_bytes, 44);
    assert!(full.complete);
    assert_eq!(
        full.files
            .iter()
            .find(|e| e.name == "images")
            .unwrap()
            .bytes,
        30
    );
    assert_eq!(
        full.files
            .iter()
            .find(|e| e.name == "config.json")
            .unwrap()
            .category,
        "other"
    );
}

#[test]
fn storage_missing_database_and_cancelled_tasks_never_report_zero_success() {
    let f = Fixture::new();
    assert!(overview(&f.db(), &ReadTask::default(), true).is_err());
    fs::write(f.db(), [0; 32]).unwrap();
    let task = ReadTask::default();
    task.cancel();
    assert!(overview(&f.db(), &task, true).unwrap_err().contains("取消"));
    assert!(database_usage(&f.db(), &task).unwrap_err().contains("取消"));
}

#[test]
fn storage_discovers_new_tables_groups_real_fts_shadows_and_assigns_indexes_once() {
    let f = Fixture::new();
    let writer = Connection::open(f.db()).unwrap();
    writer
        .execute_batch(
            "CREATE TABLE future_table(id TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX future_value ON future_table(value);
        INSERT INTO future_table VALUES ('a', 'hello');
        CREATE VIRTUAL TABLE search USING fts5(content);
        INSERT INTO search VALUES ('hello world');
        CREATE TABLE search_custom(id INTEGER);",
        )
        .unwrap();
    let report = database_usage(&f.db(), &ReadTask::default()).unwrap();
    assert!(report.size_supported, "bundled SQLite must provide DBSTAT");
    let names: Vec<_> = report.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names.len(), 3);
    assert!(names.contains(&"future_table"));
    assert!(names.contains(&"search_custom"));
    let future = report
        .tables
        .iter()
        .find(|t| t.name == "future_table")
        .unwrap();
    assert!(
        future.index_bytes.unwrap() >= 8192,
        "explicit and auto primary-key indexes must both count"
    );
    let search = report.tables.iter().find(|t| t.name == "search").unwrap();
    assert!(search.internal_tables.contains(&"search_data".into()));
    assert!(!search.internal_tables.contains(&"search_custom".into()));
    let assigned: u64 = report
        .tables
        .iter()
        .map(|t| t.table_bytes.unwrap() + t.index_bytes.unwrap())
        .sum();
    assert_eq!(
        assigned + report.free_bytes + report.other_bytes.unwrap(),
        report.page_bytes
    );
}

#[test]
fn storage_inspection_keeps_database_unchanged_and_preserves_table_names() {
    let f = Fixture::new();
    let writer = Connection::open(f.db()).unwrap();
    writer.execute_batch("CREATE TABLE \"odd\"\"table\"(id INTEGER, title TEXT); INSERT INTO \"odd\"\"table\" VALUES (1,'private body');").unwrap();
    let before = fs::read(f.db()).unwrap();
    let report = database_usage(&f.db(), &ReadTask::default()).unwrap();
    assert_eq!(report.tables[0].name, "odd\"table");
    assert_eq!(before, fs::read(f.db()).unwrap());
}

#[test]
fn storage_empty_database_retains_structure_size() {
    let f = Fixture::new();
    let writer = Connection::open(f.db()).unwrap();
    writer
        .execute_batch("CREATE TABLE history(id TEXT);")
        .unwrap();
    let report = database_usage(&f.db(), &ReadTask::default()).unwrap();
    assert!(report.page_bytes > 0);
    assert!(report.tables[0].table_bytes.unwrap() > 0);
}

#[cfg(windows)]
#[test]
fn storage_junctions_are_not_followed_outside_app_data() {
    let f = Fixture::new();
    fs::write(f.db(), [0; 8]).unwrap();
    let external = Fixture::new();
    fs::write(external.0.join("private"), [0; 100]).unwrap();
    let link = f.0.join("images");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&external.0)
        .output()
        .unwrap();
    assert!(status.status.success(), "junction fixture failed");
    let report = overview(&f.db(), &ReadTask::default(), true).unwrap();
    fs::remove_dir(&link).unwrap();
    assert_eq!(report.total_bytes, 8);
    assert!(!report.complete);
    assert!(report
        .files
        .iter()
        .find(|e| e.name == "images")
        .unwrap()
        .error
        .is_some());
}
