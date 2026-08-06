use super::*;

impl DataStore {
    // ===== 标签 CRUD =====

    pub fn get_tags(&self) -> Result<Vec<Tag>, String> {
        let conn = self.lock_conn();
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
        // 校验标签名：trim 后非空，最长 50 个字符（用 chars().count() 数字符数而非字节数，避免中文被误判）
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("标签名不能为空".to_string());
        }
        if trimmed.chars().count() > 50 {
            return Err("标签名最长 50 个字符".to_string());
        }
        let conn = self.lock_conn();
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
        // 校验标签名：trim 后非空，最长 50 个字符
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("标签名不能为空".to_string());
        }
        if trimmed.chars().count() > 50 {
            return Err("标签名最长 50 个字符".to_string());
        }
        let conn = self.lock_conn();
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
        let conn = self.lock_conn();
        // 改用 RAII 事务：手写 COMMIT 失败时不会 ROLLBACK，会让事务永久挂在共享连接上，Drop 自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM history_tags WHERE tag_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK，无需手动调用
                Err(e)
            }
        }
    }

    pub fn set_item_tags(&self, history_id: &str, tag_ids: &[String]) -> Result<(), String> {
        let conn = self.lock_conn();
        // 改用 RAII 事务：COMMIT 失败不回滚会让事务永久卡在共享连接上，Transaction drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
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
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
                Err(e)
            }
        }
    }

    pub fn add_item_tags(&self, history_ids: &[String], tag_ids: &[String]) -> Result<u32, String> {
        let conn = self.lock_conn();
        // 改用 RAII 事务：手写 COMMIT 失败时不回滚，会让事务永久挂在共享连接上，drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = (|| -> Result<u32, String> {
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
        })();
        match result {
            Ok(count) => {
                tx.commit().map_err(|e| e.to_string())?;
                Ok(count)
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
                Err(e)
            }
        }
    }

    pub fn remove_item_tags(&self, history_ids: &[String], tag_ids: &[String]) -> Result<u32, String> {
        let conn = self.lock_conn();
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
        let conn = self.lock_conn();
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

    // ===== 自动标签（AI 智能分类） =====

    /// 确保自动标签种子数据存在（首次启动时插入）
    pub fn ensure_auto_tags(&self) -> Result<(), String> {
        let conn = self.lock_conn();
        let auto_tags: [(&str, &str, &str); 30] = [
            // 主类别
            ("auto-code", "代码", "#6366F1"),
            // 图文混排：走自动标签而不是卡片上写死的徽标，这样才能与其它标签
            // 统一管理：点卡片上的标签可筛选、也会出现在筛选标签列表里
            ("auto-rich", "图文", "#D97706"),
            ("auto-link", "链接", "#06B6D4"),
            ("auto-json", "JSON", "#F59E0B"),
            ("auto-config", "配置文件", "#10B981"),
            ("auto-log", "日志", "#6B7280"),
            ("auto-table", "表格", "#8B5CF6"),
            ("auto-command", "命令行", "#EF4444"),
            ("auto-secret", "密钥", "#DC2626"),
            ("auto-number", "数字", "#14B8A6"),
            ("auto-plaintext", "纯文本", "#9CA3AF"),
            ("auto-email", "邮箱", "#2563EB"),
            ("auto-phone", "电话", "#16A34A"),
            ("auto-color", "颜色", "#EC4899"),
            ("auto-filepath", "文件路径", "#EA580C"),
            ("auto-markdown", "Markdown", "#84CC16"),
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
            // 配置文件子格式（detect_config 返回的子标签，全屏代码编辑器据此选语言模式）
            ("auto-fmt-yaml", "YAML", "#CB171E"),
            ("auto-fmt-toml", "TOML", "#9C4221"),
            ("auto-fmt-env", "ENV", "#ECD53F"),
            ("auto-fmt-ini", "INI", "#7C8DA5"),
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
        let conn = self.lock_conn();
        let mut ids = Vec::new();
        for label in labels {
            // U-P0.6：不再限定 source='auto' —— tags.name 有 UNIQUE 约束，若用户提前手动建了
            // 与种子同名的标签，ensure_auto_tags 的 INSERT OR IGNORE 会因名称冲突而不写入
            // 该种子行，导致按 name+source='auto' 永远查不到。按 name 全局查找即可安全复用同一行。
            let result: Result<String, _> = conn.query_row(
                "SELECT id FROM tags WHERE name = ?1",
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
        let conn = self.lock_conn();
        // 改用 RAII 事务：COMMIT 失败时不回滚会导致事务永久挂在共享连接上，Transaction drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            for tag_id in tag_ids {
                conn.execute(
                    "INSERT OR IGNORE INTO history_tags (history_id, tag_id, source) VALUES (?1, ?2, 'auto')",
                    params![history_id, tag_id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
                Err(e)
            }
        }
    }

    /// 将指定记录的所有自动标签转为手动标签（用户确认）
    /// 只影响当前记录的 history_tags.source，不影响其他记录
    pub fn confirm_auto_tags(&self, history_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE history_tags SET source = 'manual' WHERE history_id = ?1 AND source = 'auto'",
            params![history_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
