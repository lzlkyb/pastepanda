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
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials
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

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let items = stmt
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
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(items)
    }

    /// 获取最近 N 条记录（按时间倒序，用于托盘菜单快速预览）
    pub fn get_recent_items(&self, limit: u32) -> Result<Vec<HistoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials
                 FROM history ORDER BY time DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let items = stmt
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
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(items)
    }

    pub fn insert_history(&self, item: &HistoryItem) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO history (id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials
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
                })
            },
        );
        match result {
            Ok(item) => Ok(Some(item)),
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
        let mut stmt = conn.prepare(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials
             FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
        ).map_err(|e| e.to_string())?;
        let rows = stmt
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
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn clear_history(&self, workspace: &str, before_days: Option<u32>) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // 安全保护：before_days 为 None 或 0 时不删除任何记录
        // 避免因参数传递错误（如类型不匹配导致反序列化为 None）而误删全部数据
        let days = match before_days {
            Some(d) if d > 0 => d,
            _ => return Ok(0),
        };
        let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();
        let count = conn
            .execute(
                "DELETE FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
                params![workspace, cutoff_str],
            )
            .map_err(|e| e.to_string())?;
        Ok(count as u32)
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
        let mut count = 0u32;
        for item in items {
            let result = conn.execute(
                "INSERT OR IGNORE INTO history (id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                ],
            );
            if let Ok(n) = result {
                count += n as u32;
            }
        }
        Ok(count)
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
        let mut stmt = conn
            .prepare(
                "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials
                 FROM history WHERE workspace = ?1 ORDER BY time DESC",
            )
            .map_err(|e| e.to_string())?;
        let items = stmt
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
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(items)
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
