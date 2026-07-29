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

    /// 全量搜索：把全部筛选条件下推到 SQL，直接扫整表，
    /// 不依赖前端分页加载的内存窗口（修复"搜索只覆盖已加载记录"）。
    /// 语义与前端 getFilteredItems 保持一致：
    /// - search 同时匹配 text / pinyin_initials / content（U41：图片文件名、文件路径在 content）
    /// - 时间为左闭区间（time >= cutoff），today/week/month 与前端算法一致
    /// - 标签为 AND 逻辑（每个 tag 一个子查询）
    /// 结果按 置顶优先 + 时间倒序，设上限防止宽泛搜索整表返回。
    pub fn search_history(
        &self,
        workspace: &str,
        search: &str,
        filter: &str,
        time_filter: &str,
        source: &str,
        group_filter: &str,
        tag_ids: &[String],
        limit: u32,
    ) -> Result<Vec<HistoryItem>, String> {
        let conn = self.lock_conn();

        let mut sql = String::from(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history WHERE workspace = ?1",
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(workspace.to_string())];

        // 搜索关键词：text + 拼音首字母 + content（图片文件名 / 文件路径）
        if !search.is_empty() {
            sql.push_str(" AND (text LIKE ? ESCAPE '\\' OR pinyin_initials LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
            let pattern = format!("%{}%", escape_like_pattern(search));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern));
        }

        // 类型过滤
        if filter == "pinned" {
            sql.push_str(" AND pinned = 1");
        } else if filter != "all" {
            sql.push_str(" AND type = ?");
            params_vec.push(Box::new(filter.to_string()));
        }

        // 时间范围（左闭区间，与前端一致：today=今日零点 / week=7天 / month=30天）
        let cutoff_str = match time_filter {
            "today" => chrono::Local::now().format("%Y-%m-%d 00:00:00").to_string(),
            "week" => (chrono::Local::now() - chrono::Duration::days(7))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
            "month" => (chrono::Local::now() - chrono::Duration::days(30))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
            _ => String::new(),
        };
        if !cutoff_str.is_empty() {
            sql.push_str(" AND time >= ?");
            params_vec.push(Box::new(cutoff_str));
        }

        // 来源过滤
        if !source.is_empty() {
            sql.push_str(" AND source = ?");
            params_vec.push(Box::new(source.to_string()));
        }

        // 分组过滤
        if group_filter == "ungrouped" {
            sql.push_str(" AND group_id IS NULL");
        } else if group_filter != "all" && !group_filter.is_empty() {
            sql.push_str(" AND group_id = ?");
            params_vec.push(Box::new(group_filter.to_string()));
        }

        // 标签过滤（AND 逻辑）：每个 tag 一个 IN 子查询
        for tag_id in tag_ids {
            sql.push_str(" AND id IN (SELECT history_id FROM history_tags WHERE tag_id = ?)");
            params_vec.push(Box::new(tag_id.clone()));
        }

        sql.push_str(" ORDER BY pinned DESC, time DESC LIMIT ?");
        params_vec.push(Box::new(limit.min(1000))); // 上限，防止宽泛搜索整表返回

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
        // 改用 RAII 事务：手写 COMMIT 失败时不会 ROLLBACK，会让事务永久挂在共享连接上，drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
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
                tx.commit().map_err(|e| e.to_string())?;
                Ok(count)
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK，无需手动调用
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
        // 改用 RAII 事务：COMMIT 失败不回滚会导致事务永久挂在共享连接上，Transaction drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = conn.execute(
            "DELETE FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
            params![workspace, cutoff_str],
        );
        match result {
            Ok(count) => {
                tx.commit().map_err(|e| e.to_string())?;
                Ok(count as u32)
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
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
        // 改用 RAII 事务：手写 COMMIT 失败不回滚会让事务永久挂在共享连接上，drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = conn.execute(
            "DELETE FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
            params![workspace, cutoff_str],
        );
        match result {
            Ok(count) => {
                tx.commit().map_err(|e| e.to_string())?;
                Ok((count as u32, items))
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
                Err(e.to_string())
            }
        }
    }

    /// 统计当前会被清理策略命中的过期记录数（超过指定天数且未置顶）。
    /// SQL 条件与 clear_history_with_undo 完全一致，保证设置页展示的数量 = 实际清理数量。
    /// 前端内存列表是分页缓存（仅部分记录），不能用来全量统计。
    pub fn count_expired_history(&self, workspace: &str, before_days: u32) -> Result<u32, String> {
        if before_days == 0 {
            return Ok(0);
        }
        let cutoff = chrono::Local::now() - chrono::Duration::days(before_days as i64);
        let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();
        let conn = self.lock_conn();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2",
                params![workspace, cutoff_str],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count.max(0) as u32)
    }

    /// 深度清理：按组合条件统计匹配记录数（时间范围 / 类型 / 来源，自动跳过置顶）。
    /// WHERE 与 clear_history_conditions 共用 build_clean_where，保证统计数 = 实际清理数。
    pub fn count_history_conditions(
        &self,
        workspace: &str,
        before_days: Option<u32>,
        item_type: Option<String>,
        source: Option<String>,
    ) -> Result<u32, String> {
        let (where_clause, params_vec) = Self::build_clean_where(
            workspace,
            before_days,
            item_type.as_deref(),
            source.as_deref(),
        );
        let sql = format!("SELECT COUNT(*) FROM history{}", where_clause);
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let conn = self.lock_conn();
        let count: i64 = conn
            .query_row(&sql, param_refs.as_slice(), |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(count.max(0) as u32)
    }

    /// 深度清理：按组合条件删除记录并返回被删记录（用于撤销）。
    /// 与 clear_history_with_undo 相同的原子模式：同一连接锁内 读取→加载标签→事务删除。
    pub fn clear_history_conditions(
        &self,
        workspace: &str,
        before_days: Option<u32>,
        item_type: Option<String>,
        source: Option<String>,
    ) -> Result<(u32, Vec<HistoryItem>), String> {
        let (where_clause, params_vec) = Self::build_clean_where(
            workspace,
            before_days,
            item_type.as_deref(),
            source.as_deref(),
        );
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let conn = self.lock_conn();

        // 1. 读取即将被删除的记录
        let select_sql = format!(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history{}",
            where_clause
        );
        let mut items: Vec<HistoryItem> = {
            let mut stmt = conn.prepare(&select_sql).map_err(|e| e.to_string())?;
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
            let tag_param_refs: Vec<&dyn rusqlite::types::ToSql> =
                ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(tag_param_refs.as_slice(), |row| {
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

        // 3. 事务删除（与读取使用完全相同的 WHERE，保证一致性）
        let delete_sql = format!("DELETE FROM history{}", where_clause);
        // 改用 RAII 事务：COMMIT 失败时不回滚会让事务永久挂在共享连接上，Transaction drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = conn.execute(&delete_sql, param_refs.as_slice());
        match result {
            Ok(count) => {
                tx.commit().map_err(|e| e.to_string())?;
                Ok((count as u32, items))
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK
                Err(e.to_string())
            }
        }
    }

    /// 深度清理共用 WHERE 构建：workspace + pinned=0 + 可选(time < cutoff / type / source)。
    /// count 与 clear 必须共用此函数，保证"统计数 = 实际清理数"。
    fn build_clean_where(
        workspace: &str,
        before_days: Option<u32>,
        item_type: Option<&str>,
        source: Option<&str>,
    ) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
        let mut sql = String::from(" WHERE workspace = ?1 AND pinned = 0");
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(workspace.to_string())];

        if let Some(days) = before_days {
            if days > 0 {
                let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
                sql.push_str(" AND time < ?");
                params_vec.push(Box::new(cutoff.format("%Y-%m-%d %H:%M:%S").to_string()));
            }
        }
        if let Some(t) = item_type {
            if !t.is_empty() && t != "all" {
                sql.push_str(" AND type = ?");
                params_vec.push(Box::new(t.to_string()));
            }
        }
        if let Some(s) = source {
            if !s.is_empty() && s != "all" {
                sql.push_str(" AND source = ?");
                params_vec.push(Box::new(s.to_string()));
            }
        }
        (sql, params_vec)
    }

    /// 深度清理预览：返回命中清理条件的前 limit 条记录（按时间倒序），
    /// 供弹窗展开预览，让用户确认将要删除的内容。
    pub fn preview_history_conditions(
        &self,
        workspace: &str,
        before_days: Option<u32>,
        item_type: Option<String>,
        source: Option<String>,
        limit: u32,
    ) -> Result<Vec<HistoryItem>, String> {
        let (where_clause, params_vec) = Self::build_clean_where(
            workspace,
            before_days,
            item_type.as_deref(),
            source.as_deref(),
        );
        let sql = format!(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history{} ORDER BY time DESC LIMIT ?",
            where_clause
        );
        let mut params_vec = params_vec;
        params_vec.push(Box::new(limit.min(100)));
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let conn = self.lock_conn();
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
        // 改用 RAII 事务：手写 COMMIT 失败时不回滚，会让事务永久挂在共享连接上，drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        let result = (|| -> Result<u32, String> {
            // 修复：先取出本机已有的分组 id 集合。history.group_id 没有外键约束，直接写入源机的
            // group_id 会产生悬空引用：这些记录计入总数，但在任何分组下都看不到（「未分组」按
            // IS NULL 判定，不匹配它们），且永无清理机会。导出数据里只有 group_id 、没有分组名，
            // 无法重建分组，所以本机不存在时置 NULL（落入「未分组」，用户可见可整理）。
            let existing_group_ids: std::collections::HashSet<String> = {
                let mut stmt = conn
                    .prepare("SELECT id FROM groups")
                    .map_err(|e| e.to_string())?;
                let ids = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                ids
            };

            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            let mut count = 0u32;
            let mut dropped_group_refs = 0u32;

            for item in items {
                // 本机不存在该分组 → 置 NULL，避免写入永不可见的悬空引用
                let group_id = match &item.group_id {
                    Some(gid) if !existing_group_ids.contains(gid) => {
                        dropped_group_refs += 1;
                        None
                    }
                    other => other.clone(),
                };

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
                            group_id,
                            item.source_icon,
                            item.content_type,
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                count += affected as u32;

                // 修复：原实现完全忽略 item.tags，导致帮助页教的迁移路径（导出 JSON → 新电脑导入）
                // 必然丢掉所有标签。策略：按标签名匹配本机已有标签（tags.name 有 UNIQUE 约束），
                // 命中则复用、不覆盖本机颜色（保留用户在本机调过的配色）；不存在则新建。
                if item.tags.is_empty() {
                    continue;
                }
                // history_tags 对 history(id) 有外键：只有确认 item.id 这一行真存在才能写关联，
                // 否则外键约束会把整个导入事务打回。affected>0 必然已存在；==0 时可能是 id 已存在
                // （可写，相当于把备份里的标签合并回来），也可能是 md5 撞了另一条不同 id 的记录（不可写）。
                let row_exists = affected > 0
                    || conn
                        .query_row(
                            "SELECT 1 FROM history WHERE id = ?1",
                            params![item.id],
                            |_| Ok(()),
                        )
                        .is_ok();
                if !row_exists {
                    continue;
                }

                for tag in &item.tags {
                    let tag_name = tag.name.trim();
                    if tag_name.is_empty() {
                        continue;
                    }
                    let existing: Option<String> = conn
                        .query_row(
                            "SELECT id FROM tags WHERE name = ?1",
                            params![tag_name],
                            |r| r.get(0),
                        )
                        .ok();
                    let tag_id = match existing {
                        // 同名命中：直接复用本机标签，不改它的颜色
                        Some(id) => id,
                        None => {
                            // 本机无同名标签：优先沿用源机 id（便于同一台机器备份恢复时保持一致）；
                            // 若该 id 恰好与本机另一个标签撞了（OR IGNORE 返回 0），换新 uuid 重试
                            let mut new_id = tag.id.clone();
                            let inserted = conn
                                .execute(
                                    "INSERT OR IGNORE INTO tags (id, name, color, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                                    params![new_id, tag_name, tag.color, tag.source, now],
                                )
                                .map_err(|e| e.to_string())?;
                            if inserted == 0 {
                                new_id = uuid::Uuid::new_v4().to_string();
                                conn.execute(
                                    "INSERT INTO tags (id, name, color, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                                    params![new_id, tag_name, tag.color, tag.source, now],
                                )
                                .map_err(|e| e.to_string())?;
                            }
                            new_id
                        }
                    };
                    // 关联的 source 沿用标签自身的 source（auto/manual），导出数据里不带关联级 source
                    conn.execute(
                        "INSERT OR IGNORE INTO history_tags (history_id, tag_id, source) VALUES (?1, ?2, ?3)",
                        params![item.id, tag_id, tag.source],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }

            if dropped_group_refs > 0 {
                log::warn!(
                    "[DataStore] 导入：{} 条记录引用的分组在本机不存在，已置为未分组",
                    dropped_group_refs
                );
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

    /// 一次性补填迁移：为缺少 content_type 的文本行运行统一分类器回填。
    /// 分类逻辑在锁外执行（避免长时间持锁阻塞其他 DB 操作），仅更新阶段持锁。
    /// 返回补填的行数。
    pub fn backfill_content_types(&self) -> Result<usize, String> {
        // 1. 快速取出待补填行，立即释放锁
        let pending: Vec<(String, String)> = {
            let conn = self.lock_conn();
            let mut stmt = conn
                .prepare("SELECT id, text FROM history WHERE type = 'text' AND content_type IS NULL")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };

        if pending.is_empty() {
            return Ok(0);
        }

        // 2. 锁外分类（纯 CPU，<0.5ms/条）
        let classifier = crate::content_classifier::ContentClassifier::new();
        let classified: Vec<(String, &'static str)> = pending
            .iter()
            .map(|(id, text)| {
                let labels = classifier.classify(text);
                let ct = crate::content_classifier::ContentClassifier::content_type_from_labels(&labels);
                (id.clone(), ct)
            })
            .collect();

        // 3. 重新持锁，事务批量写入
        let conn = self.lock_conn();
        // 改用 RAII 事务：COMMIT 失败不回滚会让事务永久挂在共享连接上，Transaction drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = (|| {
            let mut count = 0usize;
            for (id, ct) in &classified {
                conn.execute(
                    "UPDATE history SET content_type = ?1 WHERE id = ?2",
                    params![ct, id],
                )
                .map_err(|e| e.to_string())?;
                count += 1;
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
}
