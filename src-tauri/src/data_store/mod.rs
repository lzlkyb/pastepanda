mod history;
mod group;
mod tag;
mod snippet;
mod config;
mod ai_usage;
mod ai_action;
mod action_events;
#[cfg(test)]
mod tests;

pub use ai_usage::{
    AiUsageByAction, AiUsageDaily, AiUsageEntry, AiUsageLogRow, AI_USAGE_RETAIN_DAYS,
};
pub use ai_action::{CustomAction, MAX_ACTION_DESC_CHARS, MAX_ACTION_NAME_CHARS};
pub use action_events::{
    ActionEvent, ActionEventCount, ActionEventStats, ActionDismissal, ActionWeightRow,
    SceneWeightRow, ACTION_EVENTS_RETAIN_DAYS, ACTION_ID_PASTE, OUTCOME_ABANDONED,
    OUTCOME_COPIED, OUTCOME_PASTED, hour_bucket, source_cat,
};

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

/// 按天计数条目（近 7 天趋势图）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCount {
    pub date: String,
    pub count: u32,
}

/// 设置页「数据仪表盘」详细统计（get_stats_detail）：
/// 在基础统计之上增加昨日计数、近 7 天按天聚合、24 小时时段分布与来源 Top 5。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsDetail {
    pub total: u32,
    pub pinned: u32,
    pub today: u32,
    pub yesterday: u32,
    /// 近 7 天（含今天）升序，缺日补 0
    pub daily: Vec<DailyCount>,
    /// 0-23 时段复制计数（恒 24 槽）
    pub hours: Vec<u32>,
    pub text_count: u32,
    pub image_count: u32,
    pub file_count: u32,
    /// 来源 Top 5（按计数降序）
    pub sources: Vec<SourceCountEntry>,
    pub earliest_time: Option<String>,
    pub db_size_kb: f64,
}

/// 侧边栏聚合计数来源条目：某来源应用的记录数 + 代表性图标文件名
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCountEntry {
    pub source: String,
    pub count: u32,
    pub source_icon: Option<String>,
}

/// 侧边栏全量计数（GROUP BY 聚合，不依赖前端内存分页窗口）。
/// 前端侧边栏此前直接 filter 内存中已加载的分页窗口（初始 50 条、上限 500 条），
/// 导致计数随滚动变化、未加载的来源/分类不显示，与 TopBar 的 DB 计数互相矛盾。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarCounts {
    pub total: u32,
    pub pinned: u32,
    pub ungrouped: u32,
    pub sources: Vec<SourceCountEntry>,
    /// group_id → 记录数
    pub groups: std::collections::HashMap<String, u32>,
    /// tag_id → 记录数
    pub tags: std::collections::HashMap<String, u32>,
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
            );

            CREATE TABLE IF NOT EXISTS regex_rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                pattern TEXT NOT NULL,
                replacement TEXT NOT NULL DEFAULT '',
                flags TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                preset INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            -- AI 调用明细账。**没有内容字段，也不得加**（见 data_store/ai_usage.rs）。
            -- 它新建于 v6，不需要 ALTER 迁移：IF NOT EXISTS 就是幂等的。
            CREATE TABLE IF NOT EXISTS ai_usage_log (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at        TEXT    NOT NULL,
                action_id         TEXT    NOT NULL,
                provider          TEXT    NOT NULL,
                model             TEXT    NOT NULL,
                prompt_tokens     INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd          REAL    NOT NULL DEFAULT 0,
                cached            INTEGER NOT NULL DEFAULT 0,
                latency_ms        INTEGER NOT NULL DEFAULT 0,
                ok                INTEGER NOT NULL DEFAULT 1,
                error             TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);

            -- 用户自定义的 AI 动作（见 data_store/ai_action.rs）。
            -- 名称 UNIQUE：两个同名动作在变换中心里根本分不清。
            CREATE TABLE IF NOT EXISTS ai_custom_actions (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL UNIQUE,
                description   TEXT NOT NULL DEFAULT '',
                icon          TEXT NOT NULL DEFAULT 'sparkles',
                template      TEXT NOT NULL,
                max_tokens    INTEGER NOT NULL DEFAULT 2000,
                content_types TEXT NOT NULL DEFAULT '',
                enabled       INTEGER NOT NULL DEFAULT 1,
                sort_order    INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            -- 动作使用日志（见 data_store/action_events.rs）。
            -- **没有内容字段，也不得加**：这里只记「动作 + 类型 + 来源 + 时段 + 结果」，
            -- 存内容就等于多一份剪贴板历史。它是 v6.0 起一切学习能力的燃料。
            -- history_id 是 v6.1 迁移列（见下方 ALTER），粘贴信号回写用它关联到具体条目。
            CREATE TABLE IF NOT EXISTS action_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at   TEXT    NOT NULL,
                action_id    TEXT    NOT NULL,
                content_type TEXT    NOT NULL DEFAULT '',
                source_app   TEXT    NOT NULL DEFAULT '',
                hour         INTEGER NOT NULL DEFAULT 0,
                outcome      TEXT    NOT NULL,
                history_id   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_action_events_created ON action_events(created_at);
            CREATE INDEX IF NOT EXISTS idx_action_events_action ON action_events(action_id);

            -- 「不再推荐这个」负反馈（v6.1，见 data_store/action_events.rs）。
            -- (action_id, content_type) 主键去重：重复点不再推荐是幂等操作。
            CREATE TABLE IF NOT EXISTS action_dismissals (
                action_id    TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL,
                PRIMARY KEY (action_id, content_type)
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

        // 数据库迁移：为 action_events 添加 history_id 列（v6.1，粘贴信号回写关联用）
        let has_history_id: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('action_events') WHERE name = 'history_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_history_id {
            if let Err(e) = conn
                .execute_batch("ALTER TABLE action_events ADD COLUMN history_id TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] action_events.history_id 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 action_events.history_id 列失败: {}", e);
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

        // v6.4 D 搜索：FTS5 全文索引（外部内容表，rowid 关联）。索引内容在 Rust 侧做
        // 字符 bigram 预处理（to_ngram），中文才能被分词命中；增删改在 history.rs 同步。
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
                text, pinyin, content,
                content='history',
                content_rowid='rowid'
            );",
        )?;

        // 首次建表（或索引为空）时全量回填存量数据。回填失败只 warn，不阻断启动。
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_fts", [], |r| r.get(0))
            .unwrap_or(0);
        if fts_count == 0 {
            match conn.prepare("SELECT rowid, text, pinyin_initials, content FROM history") {
                Ok(mut stmt) => match stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                }) {
                    Ok(rows) => {
                        let mut backfilled = 0u32;
                        for row in rows {
                            if let Ok((rowid, text, pinyin, content)) = row {
                                let _ = conn.execute(
                                    "INSERT INTO history_fts (rowid, text, pinyin, content) VALUES (?1, ?2, ?3, ?4)",
                                    rusqlite::params![
                                        rowid,
                                        crate::data_store::history::to_ngram(&text),
                                        crate::data_store::history::to_ngram(&pinyin),
                                        crate::data_store::history::to_ngram(&content),
                                    ],
                                );
                                backfilled += 1;
                            }
                        }
                        if backfilled > 0 {
                            log::info!("[FTS] 已回填 {} 条历史记录到全文索引", backfilled);
                        }
                    }
                    Err(e) => log::warn!("[FTS] 存量回填查询失败: {}", e),
                },
                Err(e) => log::warn!("[FTS] 存量回填准备失败: {}", e),
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

        // 数据库迁移：为 history 添加 search_hit_count 列（v6.1 自我净化——
        // "被搜索命中过"是高价值信号，豁免过期清理；get_history 搜索时批量 +1）
        let has_search_hit: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'search_hit_count'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_search_hit {
            if let Err(e) = conn.execute_batch(
                "ALTER TABLE history ADD COLUMN search_hit_count INTEGER NOT NULL DEFAULT 0;",
            ) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] history.search_hit_count 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 history.search_hit_count 列失败: {}", e);
                    return Err(e);
                }
            }
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
