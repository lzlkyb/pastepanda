use md5::{Digest, Md5};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

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

// ===== 数据存储 =====

pub struct DataStore {
    conn: Mutex<Connection>,
    path: String,
}

impl DataStore {
    pub fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        let db_path = path.to_string();

        // 创建表
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL DEFAULT '',
                time TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                workspace TEXT NOT NULL DEFAULT '默认',
                md5 TEXT,
                pinyin_initials TEXT
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
                log::warn!("[DataStore] 添加 pinyin_initials 列失败: {}", e);
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
                log::warn!("[DataStore] 添加 snippets.tag 列失败: {}", e);
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
                log::warn!("[DataStore] 添加 group_id 列失败: {}", e);
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
                log::warn!("[DataStore] 添加 tags.source 列失败: {}", e);
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
                log::warn!("[DataStore] 添加 history_tags.source 列失败: {}", e);
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

    pub fn get_history(
        &self,
        workspace: &str,
        filter: &str,
        search: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<HistoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut sql = String::from(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id
             FROM history WHERE workspace = ?1",
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(workspace.to_string())];

        if filter == "pinned" {
            sql.push_str(" AND pinned = 1");
        } else if filter != "all" {
            sql.push_str(" AND type = ?");
            params_vec.push(Box::new(filter.to_string()));
        }

        if !search.is_empty() {
            sql.push_str(" AND (text LIKE ? OR pinyin_initials LIKE ?)");
            let search_pattern = format!("%{}%", search);
            params_vec.push(Box::new(search_pattern.clone()));
            params_vec.push(Box::new(search_pattern));
        }

        sql.push_str(" ORDER BY pinned DESC, time DESC LIMIT ? OFFSET ?");
        params_vec.push(Box::new(limit.min(500))); // 单次查询上限 500 条
        params_vec.push(Box::new(offset));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let result: Vec<HistoryItem> = stmt
                .query_map(param_refs.as_slice(), |row| {
                    Ok(HistoryItem {
                        id: row.get(0)?,
                        text: row.get(1)?,
                        time: row.get(2)?,
                        item_type: row.get(3)?,
                        content: row.get(4)?,
                        pinned: row.get::<_, i32>(5)? != 0,
                        source: row.get(6)?,
                        workspace: row.get(7)?,
                        md5: row.get(8)?,
                        pinyin_initials: row.get(9)?,
                        group_id: row.get(10)?,
                        tags: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };
        drop(conn);
        self.load_tags_into_items(&mut items)?;

        Ok(items)
    }

    /// 获取最近 N 条记录（按时间倒序，用于托盘菜单快速预览）
    pub fn get_recent_items(&self, limit: u32) -> Result<Vec<HistoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id
                     FROM history ORDER BY time DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let result: Vec<HistoryItem> = stmt
                .query_map(params![limit], |row| {
                    Ok(HistoryItem {
                        id: row.get(0)?,
                        text: row.get(1)?,
                        time: row.get(2)?,
                        item_type: row.get(3)?,
                        content: row.get(4)?,
                        pinned: row.get::<_, i32>(5)? != 0,
                        source: row.get(6)?,
                        workspace: row.get(7)?,
                        md5: row.get(8)?,
                        pinyin_initials: row.get(9)?,
                        group_id: row.get(10)?,
                        tags: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };
        drop(conn);
        self.load_tags_into_items(&mut items)?;
        Ok(items)
    }

    pub fn insert_history(&self, item: &HistoryItem) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO history (id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                item.id,
                item.text,
                item.time,
                item.item_type,
                item.content,
                item.pinned as i32,
                item.source,
                item.workspace,
                item.md5,
                item.pinyin_initials,
                item.group_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新历史记录的文本内容（编辑对话框用）— 同时更新 md5 和拼音
    pub fn update_history(&self, id: &str, text: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let md5_hash = format!("{:x}", Md5::new().chain_update(text.as_bytes()).finalize());
        let pinyin_initials = compute_pinyin_initials(text);
        let affected = conn
            .execute(
                "UPDATE history SET text = ?1, md5 = ?2, pinyin_initials = ?3 WHERE id = ?4",
                params![text, md5_hash, pinyin_initials, id],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err("记录不存在".to_string());
        }
        Ok(())
    }

    /// 查找与给定 md5 相同的最近一条文本记录（用于智能合并重复内容）
    pub fn find_latest_by_md5(&self, md5: &str) -> Result<Option<HistoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id
             FROM history WHERE md5 = ?1 AND type = 'text'
             ORDER BY time DESC LIMIT 1",
            params![md5],
            |row| {
                Ok(HistoryItem {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    time: row.get(2)?,
                    item_type: row.get(3)?,
                    content: row.get(4)?,
                    pinned: row.get::<_, i32>(5)? != 0,
                    source: row.get(6)?,
                    workspace: row.get(7)?,
                    md5: row.get(8)?,
                    pinyin_initials: row.get(9)?,
                    group_id: row.get(10)?,
                    tags: Vec::new(),
                })
            },
        );
        drop(conn);
        match result {
            Ok(mut item) => {
                self.load_tags_into_items(std::slice::from_mut(&mut item))?;
                Ok(Some(item))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 更新记录的 time 为当前时间（智能合并用：重复内容只更新时间戳）
    pub fn update_history_time(&self, id: &str, new_time: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE history SET time = ?1 WHERE id = ?2",
            params![new_time, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_history(&self, ids: &[String]) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // 显式事务：批量删除要么全成功要么全回滚
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = (|| {
            let placeholders: Vec<String> = ids
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 1))
                .collect();
            let sql = format!(
                "DELETE FROM history WHERE id IN ({})",
                placeholders.join(",")
            );
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = ids
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();
            let count = conn
                .execute(&sql, param_refs.as_slice())
                .map_err(|e| e.to_string())?;
            Ok(count as u32)
        })();
        match result {
            Ok(count) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(count)
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e)
            }
        }
    }

    pub fn toggle_pin(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE history SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;

        let pinned: bool = conn
            .query_row(
                "SELECT pinned FROM history WHERE id = ?1",
                params![id],
                |row| row.get::<_, i32>(0),
            )
            .map(|p| p != 0)
            .map_err(|e| e.to_string())?;

        Ok(pinned)
    }

    /// 获取即将被清理的记录（用于撤销支持）
    pub fn get_history_before_cleanup(
        &self,
        workspace: &str,
        before_days: Option<u32>,
    ) -> Result<Vec<HistoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // 安全保护：before_days 为 None 或 0 时返回空列表
        let days = match before_days {
            Some(d) if d > 0 => d,
            _ => return Ok(Vec::new()),
        };
        let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn.prepare(
                "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id
                 FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
            ).map_err(|e| e.to_string())?;
            let result: Vec<HistoryItem> = stmt
                .query_map(params![workspace, cutoff_str], |row| {
                    Ok(HistoryItem {
                        id: row.get(0)?,
                        text: row.get(1)?,
                        time: row.get(2)?,
                        item_type: row.get(3)?,
                        content: row.get(4)?,
                        pinned: row.get::<_, i32>(5)? != 0,
                        source: row.get(6)?,
                        workspace: row.get(7)?,
                        md5: row.get(8)?,
                        pinyin_initials: row.get(9)?,
                        group_id: row.get(10)?,
                        tags: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };
        drop(conn);
        self.load_tags_into_items(&mut items)?;
        Ok(items)
    }

    pub fn clear_history(&self, workspace: &str, before_days: Option<u32>) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // 安全保护：before_days 为 None 或 0 时不删除任何记录
        let days = match before_days {
            Some(d) if d > 0 => d,
            _ => return Ok(0),
        };
        let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();

        // 显式事务：批量清理要么全成功要么全回滚
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = conn.execute(
            "DELETE FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
            params![workspace, cutoff_str],
        );
        match result {
            Ok(count) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(count as u32)
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e.to_string())
            }
        }
    }

    pub fn get_stats(&self, workspace: &str) -> Result<Stats, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let total: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let pinned: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND pinned = 1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
        let today: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND time LIKE ?2",
                params![workspace, format!("{}%", today_str)],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let text_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type = 'text'",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let image_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type = 'image'",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let file_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type = 'file'",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let earliest_time: Option<String> = conn
            .query_row(
                "SELECT MIN(time) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 估算数据库文件大小 (KB)
        let db_size_bytes = std::fs::metadata(self.path.clone())
            .map(|m| m.len())
            .unwrap_or(0);
        let db_size_kb = db_size_bytes as f64 / 1024.0;

        Ok(Stats {
            total,
            pinned,
            today,
            text_count,
            image_count,
            file_count,
            earliest_time,
            db_size_kb,
        })
    }

    pub fn get_config(&self) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM config")
            .map_err(|e| e.to_string())?;

        let mut map = serde_json::Map::new();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            if let Ok((key, value)) = row {
                // 尝试解析 JSON 值，否则作为字符串
                let json_val =
                    serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value));
                map.insert(key, json_val);
            }
        }

        Ok(serde_json::Value::Object(map))
    }

    pub fn save_config(&self, config: &serde_json::Value) -> Result<(), String> {
        // 先备份当前配置（写入前备份，保留最近 10 个版本）
        let _ = self.backup_config();

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if let serde_json::Value::Object(map) = config {
            for (key, value) in map {
                let value_str = match value {
                    serde_json::Value::String(s) => s.clone(),
                    _ => serde_json::to_string(value).unwrap_or_default(),
                };
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                    params![key, value_str],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// 备份当前配置到备份文件（自动轮换，保留最近 10 个备份）
    fn backup_config(&self) -> Result<(), String> {
        let backup_dir = std::path::Path::new(&self.path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("config_backups");

        // 创建备份目录
        if !backup_dir.exists() {
            std::fs::create_dir_all(&backup_dir)
                .map_err(|e| format!("无法创建配置备份目录: {}", e))?;
        }

        // 序列化当前配置
        let config = self.get_config()?;
        let backup_json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("序列化配置失败: {}", e))?;

        // 写入临时文件 + 原子 rename（防止写入中途崩溃损坏备份）
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_name = format!("config_{}.json", timestamp);
        let backup_path = backup_dir.join(&backup_name);
        let tmp_path = backup_dir.join(format!(".{}.tmp", backup_name));

        std::fs::write(&tmp_path, &backup_json)
            .map_err(|e| format!("写入配置备份临时文件失败: {}", e))?;
        std::fs::rename(&tmp_path, &backup_path)
            .map_err(|e| format!("重命名配置备份文件失败: {}", e))?;

        // 轮换：删除超过 10 个的旧备份
        if let Ok(entries) = std::fs::read_dir(&backup_dir) {
            let mut backups: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("config_")
                        && e.file_name().to_string_lossy().ends_with(".json")
                })
                .filter_map(|e| {
                    let modified = e.metadata().ok()?.modified().ok()?;
                    Some((e.path(), modified))
                })
                .collect();
            // 按修改时间降序排列，保留最新的 10 个
            backups.sort_by(|a, b| b.1.cmp(&a.1));
            for (path, _) in backups.iter().skip(10) {
                let _ = std::fs::remove_file(path);
            }
        }

        log::info!("[DataStore] 配置已备份: {}", backup_path.display());
        Ok(())
    }

    pub fn import_history(&self, items: &[HistoryItem]) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // 显式事务：批量导入要么全成功要么全回滚
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;

        let result = (|| -> Result<u32, String> {
            let mut count = 0u32;
            for item in items {
                let affected = conn
                    .execute(
                        "INSERT OR IGNORE INTO history (id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        params![
                            item.id,
                            item.text,
                            item.time,
                            item.item_type,
                            item.content,
                            item.pinned as i32,
                            item.source,
                            item.workspace,
                            item.md5,
                            item.pinyin_initials,
                            item.group_id,
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                count += affected as u32;
            }
            Ok(count)
        })();

        match result {
            Ok(count) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(count)
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e)
            }
        }
    }

    pub fn add_snippet(&self, name: &str, content: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR REPLACE INTO snippets (id, name, content) VALUES (?1, ?2, ?3)",
            params![id, name, content],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn get_snippets(&self) -> Result<Vec<Snippet>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, content, tag FROM snippets ORDER BY rowid DESC")
            .map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], |row| {
                Ok(Snippet {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    content: row.get(2)?,
                    tag: row.get::<_, String>(3).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(items)
    }

    pub fn update_snippet(
        &self,
        id: &str,
        name: &str,
        content: &str,
        tag: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE snippets SET name = ?1, content = ?2, tag = ?3 WHERE id = ?4",
            params![name, content, tag, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 获取全部历史记录（用于导出，无分页限制）
    pub fn get_all_history(&self, workspace: &str) -> Result<Vec<HistoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id
                     FROM history WHERE workspace = ?1 ORDER BY time DESC",
                )
                .map_err(|e| e.to_string())?;
            let result: Vec<HistoryItem> = stmt
                .query_map(params![workspace], |row| {
                    Ok(HistoryItem {
                        id: row.get(0)?,
                        text: row.get(1)?,
                        time: row.get(2)?,
                        item_type: row.get(3)?,
                        content: row.get(4)?,
                        pinned: row.get::<_, i32>(5)? != 0,
                        source: row.get(6)?,
                        workspace: row.get(7)?,
                        md5: row.get(8)?,
                        pinyin_initials: row.get(9)?,
                        group_id: row.get(10)?,
                        tags: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };
        drop(conn);
        self.load_tags_into_items(&mut items)?;
        Ok(items)
    }

    // ===== 分组 CRUD =====

    pub fn get_groups(&self) -> Result<Vec<Group>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, color, icon, sort_order, created_at FROM groups ORDER BY sort_order ASC")
            .map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], |row| {
                Ok(Group {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    icon: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(items)
    }

    pub fn create_group(&self, name: &str, color: &str, icon: &str) -> Result<Group, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        // 获取最大 sort_order
        let max_order: i32 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), -1) FROM groups", [], |row| row.get(0))
            .unwrap_or(-1);
        let sort_order = max_order + 1;
        conn.execute(
            "INSERT INTO groups (id, name, color, icon, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, color, icon, sort_order, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(Group {
            id,
            name: name.to_string(),
            color: color.to_string(),
            icon: icon.to_string(),
            sort_order,
            created_at: now,
        })
    }

    pub fn update_group(&self, id: &str, name: &str, color: &str, icon: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE groups SET name = ?1, color = ?2, icon = ?3 WHERE id = ?4",
                params![name, color, icon, id],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err("分组不存在".to_string());
        }
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            // 将该分组的记录的 group_id 置为 NULL
            conn.execute(
                "UPDATE history SET group_id = NULL WHERE group_id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
            // 删除分组
            conn.execute("DELETE FROM groups WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e)
            }
        }
    }

    pub fn reorder_groups(&self, ids: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            for (i, id) in ids.iter().enumerate() {
                conn.execute(
                    "UPDATE groups SET sort_order = ?1 WHERE id = ?2",
                    params![i as i32, id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e)
            }
        }
    }

    pub fn move_to_group(&self, history_ids: &[String], group_id: Option<&str>) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let placeholders: Vec<String> = history_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 2))
            .collect();
        let sql = format!(
            "UPDATE history SET group_id = ?1 WHERE id IN ({})",
            placeholders.join(",")
        );
        let mut param_refs: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];
        param_refs.push(Box::new(group_id.map(|s| s.to_string())));
        for id in history_ids {
            param_refs.push(Box::new(id.clone()));
        }
        let params: Vec<&dyn rusqlite::types::ToSql> = param_refs.iter().map(|p| p.as_ref()).collect();
        let affected = conn.execute(&sql, params.as_slice()).map_err(|e| e.to_string())?;
        Ok(affected as u32)
    }

    // ===== 标签 CRUD =====

    pub fn get_tags(&self) -> Result<Vec<Tag>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, color, COALESCE(source, 'manual'), created_at FROM tags ORDER BY name ASC")
            .map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    source: row.get::<_, String>(3).unwrap_or_else(|_| "manual".to_string()),
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(items)
    }

    pub fn create_tag(&self, name: &str, color: &str) -> Result<Tag, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "INSERT INTO tags (id, name, color, source, created_at) VALUES (?1, ?2, ?3, 'manual', ?4)",
            params![id, name, color, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(Tag {
            id,
            name: name.to_string(),
            color: color.to_string(),
            source: "manual".to_string(),
            created_at: now,
        })
    }

    pub fn update_tag(&self, id: &str, name: &str, color: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE tags SET name = ?1, color = ?2 WHERE id = ?3",
                params![name, color, id],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err("标签不存在".to_string());
        }
        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM history_tags WHERE tag_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e)
            }
        }
    }

    pub fn set_item_tags(&self, history_id: &str, tag_ids: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            // 先删除旧关联
            conn.execute(
                "DELETE FROM history_tags WHERE history_id = ?1",
                params![history_id],
            )
            .map_err(|e| e.to_string())?;
            // 插入新关联
            for tag_id in tag_ids {
                conn.execute(
                    "INSERT OR IGNORE INTO history_tags (history_id, tag_id) VALUES (?1, ?2)",
                    params![history_id, tag_id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e)
            }
        }
    }

    pub fn add_item_tags(&self, history_ids: &[String], tag_ids: &[String]) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut count = 0u32;
        for history_id in history_ids {
            for tag_id in tag_ids {
                let affected = conn
                    .execute(
                        "INSERT OR IGNORE INTO history_tags (history_id, tag_id) VALUES (?1, ?2)",
                        params![history_id, tag_id],
                    )
                    .map_err(|e| e.to_string())?;
                count += affected as u32;
            }
        }
        Ok(count)
    }

    pub fn remove_item_tags(&self, history_ids: &[String], tag_ids: &[String]) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let placeholders_h: Vec<String> = history_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let placeholders_t: Vec<String> = tag_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1 + history_ids.len()))
            .collect();
        let sql = format!(
            "DELETE FROM history_tags WHERE history_id IN ({}) AND tag_id IN ({})",
            placeholders_h.join(","),
            placeholders_t.join(","),
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];
        for id in history_ids {
            params_vec.push(Box::new(id.clone()));
        }
        for id in tag_ids {
            params_vec.push(Box::new(id.clone()));
        }
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let affected = conn.execute(&sql, param_refs.as_slice()).map_err(|e| e.to_string())?;
        Ok(affected as u32)
    }

    pub fn get_items_with_tags(&self, history_ids: &[String]) -> Result<Vec<(String, Vec<Tag>)>, String> {
        if history_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let placeholders: Vec<String> = history_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let sql = format!(
            "SELECT ht.history_id, t.id, t.name, t.color, COALESCE(ht.source, 'manual'), t.created_at
             FROM history_tags ht
             JOIN tags t ON t.id = ht.tag_id
             WHERE ht.history_id IN ({})
             ORDER BY t.name ASC",
            placeholders.join(","),
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];
        for id in history_ids {
            params_vec.push(Box::new(id.clone()));
        }
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Tag {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        color: row.get(3)?,
                        source: row.get::<_, String>(4).unwrap_or_else(|_| "manual".to_string()),
                        created_at: row.get(5)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut map: std::collections::HashMap<String, Vec<Tag>> = std::collections::HashMap::new();
        for row in rows {
            if let Ok((history_id, tag)) = row {
                map.entry(history_id).or_default().push(tag);
            }
        }
        Ok(map.into_iter().collect())
    }

    /// 批量加载 items 的标签并填充到 tags 字段
    fn load_tags_into_items(&self, items: &mut [HistoryItem]) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        let tags_map = self.get_items_with_tags(&ids)?;
        let tag_map: std::collections::HashMap<String, Vec<Tag>> = tags_map.into_iter().collect();
        for item in items.iter_mut() {
            if let Some(tags) = tag_map.get(&item.id) {
                item.tags = tags.clone();
            }
        }
        Ok(())
    }

    // ===== 自动标签（AI 智能分类） =====

    /// 确保自动标签种子数据存在（首次启动时插入）
    pub fn ensure_auto_tags(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let auto_tags: [(&str, &str, &str); 20] = [
            // 主类别
            ("auto-code", "代码", "#6366F1"),
            ("auto-link", "链接", "#06B6D4"),
            ("auto-json", "JSON", "#F59E0B"),
            ("auto-config", "配置文件", "#10B981"),
            ("auto-log", "日志", "#6B7280"),
            ("auto-table", "表格", "#8B5CF6"),
            ("auto-command", "命令行", "#EF4444"),
            ("auto-secret", "密钥", "#DC2626"),
            ("auto-number", "数字", "#14B8A6"),
            ("auto-plaintext", "纯文本", "#9CA3AF"),
            // 代码语言
            ("auto-lang-python", "Python", "#3776AB"),
            ("auto-lang-javascript", "JavaScript", "#F7DF1E"),
            ("auto-lang-typescript", "TypeScript", "#3178C6"),
            ("auto-lang-rust", "Rust", "#DEA584"),
            ("auto-lang-java", "Java", "#ED8B00"),
            ("auto-lang-go", "Go", "#00ADD8"),
            ("auto-lang-sql", "SQL", "#4479A1"),
            ("auto-lang-html", "HTML", "#E34F26"),
            ("auto-lang-css", "CSS", "#1572B6"),
            ("auto-lang-shell", "Shell", "#4EAA25"),
        ];
        for (id, name, color) in &auto_tags {
            conn.execute(
                "INSERT OR IGNORE INTO tags (id, name, color, source, created_at) VALUES (?1, ?2, ?3, 'auto', datetime('now'))",
                params![id, name, color],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 根据标签名列表查找对应的标签 ID（用于自动分类结果写入数据库）
    pub fn resolve_auto_tag_ids(&self, labels: &[String]) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for label in labels {
            let result: Result<String, _> = conn.query_row(
                "SELECT id FROM tags WHERE name = ?1 AND source = 'auto'",
                params![label],
                |row| row.get(0),
            );
            if let Ok(id) = result {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    /// 为历史记录批量添加标签（自动分类使用）
    pub fn add_history_tags(&self, history_id: &str, tag_ids: &[String]) -> Result<(), String> {
        if tag_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for tag_id in tag_ids {
            conn.execute(
                "INSERT OR IGNORE INTO history_tags (history_id, tag_id, source) VALUES (?1, ?2, 'auto')",
                params![history_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 将指定记录的所有自动标签转为手动标签（用户确认）
    /// 只影响当前记录的 history_tags.source，不影响其他记录
    pub fn confirm_auto_tags(&self, history_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE history_tags SET source = 'manual' WHERE history_id = ?1 AND source = 'auto'",
            params![history_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub tag: String,
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

// ===== 测试 =====

#[cfg(test)]
mod tests {
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

        let found = store.find_latest_by_md5(&md5).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "md5-1");
    }

    #[test]
    fn test_find_latest_by_md5_not_found() {
        let store = make_store();
        let found = store.find_latest_by_md5("nonexistent_md5").unwrap();
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

        let found = store.find_latest_by_md5(&md5_hash).unwrap().unwrap();
        assert_eq!(found.id, "dup-2"); // 应该返回时间更新的那条
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
        // 应该有 20 个自动标签种子
        assert_eq!(tags.len(), 20);
        // 全部 source 为 "auto"
        assert!(tags.iter().all(|t| t.source == "auto"));
    }

    #[test]
    fn test_ensure_auto_tags_idempotent() {
        let store = make_store();
        store.ensure_auto_tags().unwrap();
        store.ensure_auto_tags().unwrap();

        let tags = store.get_tags().unwrap();
        assert_eq!(tags.len(), 20); // 不应重复插入
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
}
