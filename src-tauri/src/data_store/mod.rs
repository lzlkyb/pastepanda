mod history;
mod group;
mod tag;
mod snippet;
mod config;
#[cfg(test)]
mod tests;

use md5::{Digest, Md5};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// 判断是否为 SQLite "duplicate column name" 错误——ALTER TABLE ADD COLUMN 在列已存在时
/// （例如非首次启动的正常迁移场景）会报此错误，属于幂等场景，可安全忽略；
/// 其他错误（磁盘满、库损坏、权限等）则应视为真实失败并向上传播。
fn is_duplicate_column_error(e: &rusqlite::Error) -> bool {
    e.to_string().contains("duplicate column name")
}

/// 转义 LIKE 模式串中的通配符 `%`、`_` 以及转义符本身 `\`，
/// 需配合 SQL 中的 `ESCAPE '\\'` 子句使用，避免用户搜索文本中的 % / _ 被当作通配符解析。
pub(crate) fn escape_like_pattern(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ===== 数据模型 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub text: String,
    pub time: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub content: String,
    pub pinned: bool,
    pub source: String,
    pub workspace: String,
    pub md5: Option<String>,
    #[serde(default)]
    pub pinyin_initials: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    /// 来源应用真实图标文件名（存储在 source-icons/ 目录下）
    #[serde(default)]
    pub source_icon: Option<String>,
    /// 统一内容类型（由 ContentClassifier 在插入时计算）
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub sort_order: i32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default = "default_tag_source")]
    pub source: String, // "manual" | "auto"
    pub created_at: String,
}

fn default_tag_source() -> String {
    "manual".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total: u32,
    pub pinned: u32,
    pub today: u32,
    pub text_count: u32,
    pub image_count: u32,
    pub file_count: u32,
    pub earliest_time: Option<String>,
    pub db_size_kb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub copy_count: i64,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

// ===== 数据存储 =====

pub struct DataStore {
    pub(crate) conn: Mutex<Connection>,
    pub(crate) path: String,
}

impl DataStore {
    pub fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        let db_path = path.to_string();

        // 创建表
        conn.execute_batch(
            "            CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL DEFAULT '',
                time TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                workspace TEXT NOT NULL DEFAULT '默认',
                md5 TEXT,
                pinyin_initials TEXT,
                source_icon TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_history_workspace ON history(workspace);
            CREATE INDEX IF NOT EXISTS idx_history_time ON history(time);
            CREATE INDEX IF NOT EXISTS idx_history_pinned ON history(pinned);

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                tag TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                icon TEXT NOT NULL DEFAULT 'folder',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS history_tags (
                history_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                PRIMARY KEY (history_id, tag_id),
                FOREIGN KEY (history_id) REFERENCES history(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );",
        )?;

        // 数据库迁移：为旧数据库添加 pinyin_initials 列（如果不存在）
        let has_pinyin: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'pinyin_initials'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_pinyin {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN pinyin_initials TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] pinyin_initials 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 pinyin_initials 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 snippets 表添加 tag 列（如果不存在）
        let has_tag: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('snippets') WHERE name = 'tag'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_tag {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE snippets ADD COLUMN tag TEXT NOT NULL DEFAULT '';")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] snippets.tag 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 snippets.tag 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 snippets 表添加 copy_count / last_used_at 列（如果不存在）
        let has_copy_count: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('snippets') WHERE name = 'copy_count'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_copy_count {
            if let Err(e) = conn.execute_batch(
                "ALTER TABLE snippets ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 0;",
            ) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] snippets.copy_count 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 snippets.copy_count 列失败: {}", e);
                    return Err(e);
                }
            }
        }
        let has_last_used: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('snippets') WHERE name = 'last_used_at'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_last_used {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE snippets ADD COLUMN last_used_at TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] snippets.last_used_at 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 snippets.last_used_at 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history 表添加 group_id 列（如果不存在）
        let has_group_id: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'group_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_group_id {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN group_id TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] group_id 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 group_id 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 tags 表添加 source 列（如果不存在）
        let has_source: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name = 'source'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_source {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] tags.source 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 tags.source 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history 表添加 source_icon 列（如果不存在）
        let has_source_icon: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'source_icon'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_source_icon {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN source_icon TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] source_icon 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 source_icon 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history 表添加 content_type 列（如果不存在）
        let has_content_type: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'content_type'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_content_type {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN content_type TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] content_type 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 content_type 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history_tags 表添加 source 列（如果不存在）
        let has_ht_source: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history_tags') WHERE name = 'source'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_ht_source {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] history_tags.source 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 history_tags.source 列失败: {}", e);
                    return Err(e);
                }
            }
            // 将已有自动标签关联的 source 同步为 'auto'（通过 tags.source 判断）
            let _ = conn.execute_batch(
                "UPDATE history_tags SET source = 'auto'
                 WHERE tag_id IN (SELECT id FROM tags WHERE source = 'auto')
                   AND history_tags.source = 'manual';",
            );
        }

        // 启用 WAL 模式 + 性能/可靠性优化
        // WAL：写操作不阻塞读，并发更好，崩溃恢复更安全
        // synchronous=NORMAL：WAL 模式下足够安全，大幅提升写入性能
        // cache_size=-8000：8MB 缓存（负值表示 KB），减少磁盘 I/O
        // busy_timeout=5000：等待 5 秒而非立即返回 SQLITE_BUSY
        let pragmas = [
            "PRAGMA journal_mode=WAL;",
            "PRAGMA synchronous=NORMAL;",
            "PRAGMA cache_size=-8000;",
            "PRAGMA busy_timeout=5000;",
            "PRAGMA foreign_keys=ON;",
        ];
        for pragma in &pragmas {
            if let Err(e) = conn.execute_batch(pragma) {
                log::warn!("[DataStore] PRAGMA 设置失败 ({}): {}", pragma, e);
            }
        }

        Ok(Self {
            conn: Mutex::new(conn),
            path: db_path,
        })
    }

    /// 获取 DB 连接锁（容忍中毒 — Low 修复）。
    /// 若某持有者 panic 导致 Mutex 中毒，此后所有 lock() 都会永久失败，
    /// DB 访问将彻底瘫痪直到重启。rusqlite 单条语句具备原子性，panic 后
    /// 连接本身仍可用，因此直接 into_inner() 恢复。
    pub(crate) fn lock_conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// 计算文本的拼音首字母（仅中文字符）
pub fn compute_pinyin_initials(text: &str) -> String {
    let args = pinyin::Args::new();
    let pys = pinyin::lazy_pinyin(text, &args);
    let mut initials = String::new();
    for (i, py) in pys.iter().enumerate() {
        if i >= 50 {
            break;
        }
        if let Some(first) = py.chars().next() {
            if first.is_alphabetic() {
                initials.push(first.to_ascii_uppercase());
            }
        }
    }
    initials
}
