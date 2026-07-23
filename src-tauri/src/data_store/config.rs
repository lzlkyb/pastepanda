use super::*;

impl DataStore {
    pub fn get_stats(&self, workspace: &str) -> Result<Stats, String> {
        let conn = self.lock_conn();

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
        let conn = self.lock_conn();
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

        let mut conn = self.lock_conn();
        if let serde_json::Value::Object(map) = config {
            // 修复 M15：事务包裹全部配置键写入，保证 all-or-nothing，
            // 避免中途失败时配置处于半写状态
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (key, value) in map {
                let value_str = match value {
                    serde_json::Value::String(s) => s.clone(),
                    _ => serde_json::to_string(value).unwrap_or_default(),
                };
                tx.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                    params![key, value_str],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
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
}
