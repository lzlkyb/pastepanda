use super::*;

impl DataStore {
    // ===== 分组 CRUD =====

    pub fn get_groups(&self) -> Result<Vec<Group>, String> {
        let conn = self.lock_conn();
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
        // 校验分组名：trim 后非空，最长 50 个字符（用 chars().count() 数字符数而非字节数，避免中文被误判）
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("分组名不能为空".to_string());
        }
        if trimmed.chars().count() > 50 {
            return Err("分组名最长 50 个字符".to_string());
        }
        let conn = self.lock_conn();
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
        // 校验分组名：trim 后非空，最长 50 个字符
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("分组名不能为空".to_string());
        }
        if trimmed.chars().count() > 50 {
            return Err("分组名最长 50 个字符".to_string());
        }
        let conn = self.lock_conn();
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
        let conn = self.lock_conn();
        // 改用 RAII 事务（unchecked_transaction）：手写 BEGIN/COMMIT 若 COMMIT 本身失败不会
        // ROLLBACK，事务会永久挂在共享连接上；Transaction 在 drop 时若未 commit 成功会自动 ROLLBACK
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
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
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK，无需手动调用
                Err(e)
            }
        }
    }

    pub fn reorder_groups(&self, ids: &[String]) -> Result<(), String> {
        let conn = self.lock_conn();
        // 改用 RAII 事务：COMMIT 失败不回滚会导致事务永久卡在共享连接上，drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
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
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
                Err(e)
            }
        }
    }

    pub fn move_to_group(&self, history_ids: &[String], group_id: Option<&str>) -> Result<u32, String> {
        let conn = self.lock_conn();
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
}
