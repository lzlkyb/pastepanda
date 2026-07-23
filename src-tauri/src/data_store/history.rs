use super::*;

impl DataStore {
    pub fn get_history(
        &self,
        workspace: &str,
        filter: &str,
        search: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<HistoryItem>, String> {
        let conn = self.lock_conn();

        let mut sql = String::from(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
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
            sql.push_str(" AND (text LIKE ? ESCAPE '\\' OR pinyin_initials LIKE ? ESCAPE '\\')");
            let search_pattern = format!("%{}%", escape_like_pattern(search));
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
                        source_icon: row.get(11)?,
                        content_type: row.get(12)?,
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
        let conn = self.lock_conn();
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
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
                        source_icon: row.get(11)?,
                        content_type: row.get(12)?,
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
        let conn = self.lock_conn();
        // 修复 C10：INSERT OR REPLACE 在主键冲突时执行 DELETE+INSERT，
        // 会触发 history_tags 的 ON DELETE CASCADE，静默清空该记录的全部标签。
        // 改为 ON CONFLICT(id) DO UPDATE 原地更新，不删行、不触发级联。
        conn.execute(
            "INSERT INTO history (id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                text = excluded.text,
                time = excluded.time,
                type = excluded.type,
                content = excluded.content,
                pinned = excluded.pinned,
                source = excluded.source,
                workspace = excluded.workspace,
                md5 = excluded.md5,
                pinyin_initials = excluded.pinyin_initials,
                group_id = excluded.group_id,
                source_icon = excluded.source_icon,
                content_type = excluded.content_type",
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
                item.source_icon,
                item.content_type,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新历史记录的文本内容（编辑对话框用）— 同时更新 md5、拼音和 content_type
    pub fn update_history(&self, id: &str, text: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let md5_hash = format!("{:x}", Md5::new().chain_update(text.as_bytes()).finalize());
        let pinyin_initials = compute_pinyin_initials(text);
        let labels = crate::content_classifier::ContentClassifier::new().classify(text);
        let content_type = crate::content_classifier::ContentClassifier::content_type_from_labels(&labels);
        let affected = conn
            .execute(
                "UPDATE history SET text = ?1, md5 = ?2, pinyin_initials = ?3, content_type = ?5 WHERE id = ?4",
                params![text, md5_hash, pinyin_initials, id, content_type],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err("记录不存在".to_string());
        }
        Ok(())
    }

    /// 查找与给定 md5 相同的最近一条文本记录（用于智能合并重复内容）
    /// 修复 Low：增加 workspace 过滤，避免跨工作区误合并
    pub fn find_latest_by_md5(
        &self,
        md5: &str,
        workspace: &str,
    ) -> Result<Option<HistoryItem>, String> {
        let conn = self.lock_conn();
        let result = conn.query_row(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history WHERE md5 = ?1 AND type = 'text' AND workspace = ?2
             ORDER BY time DESC LIMIT 1",
            params![md5, workspace],
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
                    source_icon: row.get(11)?,
                    content_type: row.get(12)?,
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
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE history SET time = ?1 WHERE id = ?2",
            params![new_time, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_history(&self, ids: &[String]) -> Result<u32, String> {
        let conn = self.lock_conn();
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
        let conn = self.lock_conn();
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
        let conn = self.lock_conn();
        // 安全保护：before_days 为 None 或 0 时返回空列表
        let days = match before_days {
            Some(d) if d > 0 => d,
            _ => return Ok(Vec::new()),
        };
        let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn.prepare(
                "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
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
                        source_icon: row.get(11)?,
                        content_type: row.get(12)?,
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
        let conn = self.lock_conn();
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

    /// 清理历史并返回被删记录（用于撤销）。
    /// 修复 Low：原实现在命令层分两次加锁（先读后删），读写之间存在竞态窗口
    /// （期间 pin 状态变化/记录增删会导致撤销快照与实际删除不一致）。
    /// 此方法在同一把连接锁内完成 读取→加载标签→事务删除，保证原子一致。
    pub fn clear_history_with_undo(
        &self,
        workspace: &str,
        before_days: Option<u32>,
    ) -> Result<(u32, Vec<HistoryItem>), String> {
        // 安全保护：before_days 为 None 或 0 时不删除任何记录
        let days = match before_days {
            Some(d) if d > 0 => d,
            _ => return Ok((0, Vec::new())),
        };
        let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();

        let conn = self.lock_conn();

        // 1. 读取即将被删除的记录
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn.prepare(
                "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
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
                        source_icon: row.get(11)?,
                        content_type: row.get(12)?,
                        tags: Vec::new(),
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };

        // 2. 在同一连接上内联加载标签（不能再调用 self.load_tags_into_items，
        //    它会重复加锁导致死锁）
        if !items.is_empty() {
            let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
            let placeholders: Vec<String> =
                ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
            let sql = format!(
                "SELECT ht.history_id, t.id, t.name, t.color, COALESCE(ht.source, 'manual'), t.created_at
                 FROM history_tags ht
                 JOIN tags t ON t.id = ht.tag_id
                 WHERE ht.history_id IN ({})
                 ORDER BY t.name ASC",
                placeholders.join(","),
            );
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
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
            let mut tag_map: std::collections::HashMap<String, Vec<Tag>> =
                std::collections::HashMap::new();
            for row in rows {
                if let Ok((history_id, tag)) = row {
                    tag_map.entry(history_id).or_default().push(tag);
                }
            }
            drop(stmt);
            for item in items.iter_mut() {
                if let Some(tags) = tag_map.get(&item.id) {
                    item.tags = tags.clone();
                }
            }
        }

        // 3. 事务删除
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
        let result = conn.execute(
            "DELETE FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
            params![workspace, cutoff_str],
        );
        match result {
            Ok(count) => {
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                Ok((count as u32, items))
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK;").ok();
                Err(e.to_string())
            }
        }
    }

    /// 获取全部历史记录（用于导出，无分页限制）
    pub fn get_all_history(&self, workspace: &str) -> Result<Vec<HistoryItem>, String> {
        let conn = self.lock_conn();
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
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
                        source_icon: row.get(11)?,
                        content_type: row.get(12)?,
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

    pub fn import_history(&self, items: &[HistoryItem]) -> Result<u32, String> {
        // 修复 Low：导入条数上限，防止超大导入文件耗尽内存/撑爆数据库
        const MAX_IMPORT_ITEMS: usize = 50_000;
        if items.len() > MAX_IMPORT_ITEMS {
            return Err(format!(
                "导入失败：条数 {} 超过上限 {}，请拆分后重试",
                items.len(),
                MAX_IMPORT_ITEMS
            ));
        }

        let conn = self.lock_conn();

        // 显式事务：批量导入要么全成功要么全回滚
        conn.execute_batch("BEGIN;").map_err(|e| e.to_string())?;

        let result = (|| -> Result<u32, String> {
            let mut count = 0u32;
            for item in items {
                let affected = conn
                    .execute(
                        "INSERT OR IGNORE INTO history (id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                            item.source_icon,
                            item.content_type,
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

    /// 批量加载 items 的标签并填充到 tags 字段
    pub(crate) fn load_tags_into_items(&self, items: &mut [HistoryItem]) -> Result<(), String> {
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
}
