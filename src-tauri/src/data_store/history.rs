use super::*;

/// v6.4 D 搜索：中文/混合文本 → 字符 bigram token 串（FTS5 预处理）。
///
/// FTS5 默认 unicode61 分词把 CJK 当成单个 token（整句一个词），中文搜索会完全失效。
/// 这里把中文字符拆成「单字 + 相邻二字 bigram」空格分隔：
/// - 索引侧与查询侧都走同一函数，2 字查询词 = bigram 本身精确命中；
/// - 3+ 字查询词拆成 bigram 组合（隐式 AND）命中；
/// - ASCII 字母数字连续段原样保留（unicode61 自己按边界切词），中英混排自然兼容。
///
/// 例：`上周API文档` → `上 周 上周 API 文 档 文档`
pub fn to_ngram(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut out: Vec<String> = Vec::with_capacity(n * 2);
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if is_cjk(c) {
            // 单字
            out.push(c.to_string());
            // 与下一个相邻中文字符组成 bigram
            if i + 1 < n && is_cjk(chars[i + 1]) {
                let mut pair = String::with_capacity(2);
                pair.push(c);
                pair.push(chars[i + 1]);
                out.push(pair);
            }
            i += 1;
        } else {
            // ASCII 字母数字连续段原样保留（unicode61 会按边界切词）
            let mut buf = String::new();
            while i < n && !is_cjk(chars[i]) {
                buf.push(chars[i]);
                i += 1;
            }
            out.push(buf);
        }
    }
    out.join(" ")
}

/// CJK 判定（含扩展区与全角符号近似处理）
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'   // 基本区
        | '\u{3400}'..='\u{4DBF}' // 扩展 A
        | '\u{F900}'..='\u{FAFF}' // 兼容区
        | '\u{20000}'..='\u{2A6DF}' // 扩展 B
    )
}

/// 判断查询词是否需要回退 LIKE（含 FTS5 MATCH 语法特殊字符）
fn fts_safe(query: &str) -> bool {
    !query
        .chars()
        .any(|c| matches!(c, '"' | '*' | '-' | ':' | '(' | ')' | '^' | '~' | '\\' | '[' | ']' | '{' | '}' | '+'))
}

/// 自我净化（v6.1）：高价值条目不参与过期清理，追加到过期清理的 WHERE 之后。
///
/// 三条高价值信号（路线图 v6.1「按价值清理」）：
/// - **被打过标签**（history_tags 有记录）——用户主动标注 = 有价值；
/// - **被粘贴过**（action_events 有 history_id 且 outcome='pasted'）——内容真正被用上；
/// - **被搜索命中过**（search_hit_count > 0）——用户找回来过。
///
/// 满足任一 → 永久保留，不参与过期清理。都没有 → 只是"过期的临时内容"，优先清。
/// 与 `clear_history_with_undo` 的 SELECT/DELETE、`count_expired_history` 共用，
/// 保证设置页"过期计数" = 实际清理数（该一致性有既有约定与注释约束）。
const VALUE_PRESERVE_SQL: &str = "
    AND id NOT IN (SELECT DISTINCT history_id FROM history_tags WHERE history_id IS NOT NULL)
    AND id NOT IN (SELECT DISTINCT history_id FROM action_events WHERE history_id IS NOT NULL AND outcome = 'pasted')
    AND COALESCE(search_hit_count, 0) = 0";

impl DataStore {
    /// 同步单条记录到 FTS 索引（insert/update 后调用）。失败只 warn，不阻断主流程。
    fn sync_fts_upsert(&self, conn: &rusqlite::Connection, id: &str) {
        let res = conn
            .query_row(
                "SELECT rowid, text, pinyin_initials, content FROM history WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )
            .and_then(|(rowid, text, pinyin, content)| {
                conn.execute(
                    "INSERT INTO history_fts (rowid, text, pinyin, content) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(rowid) DO UPDATE SET
                        text = excluded.text, pinyin = excluded.pinyin, content = excluded.content",
                    rusqlite::params![rowid, to_ngram(&text), to_ngram(&pinyin), to_ngram(&content)],
                )
            });
        if let Err(e) = res {
            log::warn!("[FTS] 索引同步失败 (id={}): {}", id, e);
        }
    }

    // 曾有一个单条 `sync_fts_delete`；删除路径统一走 `delete_history(&[String])`，
    // 它在同一个函数里批量清 history_fts（见下方 fts_delete_sql），故该方法从未被
    // 调用，已删。两条删除路径并存才是真隐患：漏走一条就意味着删掉的内容仍能被搜到。

    /// 读「保护常用内容」开关（v6.1）。默认 true：
    /// - 开：VALUE_PRESERVE_SQL 生效，高价值条目豁免过期清理；
    /// - 关：退回旧的「超期必清」（只看时间 + 置顶），隐私敏感用户可一键退回。
    /// 与前端 DEFAULT_CONFIG.preserve_valued_content 对齐（老库没有该 key 时按 true 兜底）。
    fn preserve_valued_enabled(&self) -> bool {
        self.get_config()
            .ok()
            .and_then(|c| c.get("preserve_valued_content").and_then(|v| v.as_bool()))
            .unwrap_or(true)
    }

    /// 按开关拼装豁免 SQL：开 → VALUE_PRESERVE_SQL；关 → 空串（无豁免）。
    fn preserve_sql(&self) -> String {
        if self.preserve_valued_enabled() {
            VALUE_PRESERVE_SQL.to_string()
        } else {
            String::new()
        }
    }
}

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
        } else if filter == "image" {
            // 图文混排归入「图片」筛选：两者都是带图内容，用户找图时希望一起看到。
            // 只想看图文时用「图文」自动标签精确筛（不单独占一个顶部标签页，避免拥挤）。
            sql.push_str(" AND type IN ('image', 'rich')");
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

        // v6.1 自我净化：简单搜索路径也记录命中（fire-and-forget）
        if !search.is_empty() && !items.is_empty() {
            let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
            let placeholders: Vec<String> =
                ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
            let sql = format!(
                "UPDATE history SET search_hit_count = search_hit_count + 1 WHERE id IN ({})",
                placeholders.join(","),
            );
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
            if let Err(e) = self.lock_conn().execute(&sql, param_refs.as_slice()) {
                log::warn!("[History] 搜索命中计数更新失败: {}", e);
            }
        }

        Ok(items)
    }

    /// v6.4 FTS5 快速路径：中文/混合关键词走全文索引（bigram 预处理），
    /// 远快于 LIKE 三字段全扫。失败/空结果返回 Err/空 Vec，由调用方回退 LIKE。
    fn try_search_fts(
        &self,
        workspace: &str,
        search: &str,
        filter: &str,
        time_filter: &str,
        source: &str,
        group_filter: &str,
        tag_ids: &[String],
        limit: u32,
    ) -> Result<Vec<HistoryItem>, ()> {
        let conn = self.lock_conn();

        let mut sql = String::from(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history WHERE workspace = ?1
             AND history.rowid IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?2)",
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(workspace.to_string()), Box::new(to_ngram(search))];

        // 以下过滤子句与 search_history 的 LIKE 版保持一致
        if filter == "pinned" {
            sql.push_str(" AND pinned = 1");
        } else if filter == "image" {
            sql.push_str(" AND type IN ('image', 'rich')");
        } else if filter != "all" {
            sql.push_str(" AND type = ?");
            params_vec.push(Box::new(filter.to_string()));
        }
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
        if !source.is_empty() {
            sql.push_str(" AND source = ?");
            params_vec.push(Box::new(source.to_string()));
        }
        if group_filter == "ungrouped" {
            sql.push_str(" AND group_id IS NULL");
        } else if group_filter != "all" && !group_filter.is_empty() {
            sql.push_str(" AND group_id = ?");
            params_vec.push(Box::new(group_filter.to_string()));
        }
        for tag_id in tag_ids {
            sql.push_str(" AND id IN (SELECT history_id FROM history_tags WHERE tag_id = ?)");
            params_vec.push(Box::new(tag_id.clone()));
        }
        sql.push_str(" ORDER BY pinned DESC, time DESC LIMIT ?");
        params_vec.push(Box::new(limit.min(1000)));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql).map_err(|_| ())?;
        let rows = stmt
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
            .map_err(|_| ())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
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
        // v6.4 FTS5 快速路径：命中即返回；空结果/出错（旧库无索引、语法异常）回退 LIKE。
        // ⚠️ 必须在 lock_conn() 之前调用 try_search_fts（它内部会 lock_conn；
        //     Mutex 不可重入，先锁再调会死锁——delete_history 踩过同一坑）。
        if !search.is_empty() && fts_safe(search) {
            if let Ok(fts_items) = self.try_search_fts(
                workspace,
                search,
                filter,
                time_filter,
                source,
                group_filter,
                tag_ids,
                limit,
            ) {
                if !fts_items.is_empty() {
                    // 搜索命中计数（独立取锁）
                    let ids: Vec<String> = fts_items.iter().map(|i| i.id.clone()).collect();
                    let placeholders: Vec<String> = ids
                        .iter()
                        .enumerate()
                        .map(|(i, _)| format!("?{}", i + 1))
                        .collect();
                    let sql = format!(
                        "UPDATE history SET search_hit_count = search_hit_count + 1 WHERE id IN ({})",
                        placeholders.join(","),
                    );
                    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                        ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
                    if let Err(e) = self.lock_conn().execute(&sql, param_refs.as_slice()) {
                        log::warn!("[History] 搜索命中计数更新失败: {}", e);
                    }
                    return Ok(fts_items);
                }
            }
        }

        let conn = self.lock_conn();

        let mut sql = String::from(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history WHERE workspace = ?1",
        );
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(workspace.to_string())];

        // 搜索关键词：text + 拼音首字母 + content（图片文件名 / 文件路径）+ 内容记忆摘要（M5-1）
        if !search.is_empty() {
            sql.push_str(
                " AND (text LIKE ? ESCAPE '\\' OR pinyin_initials LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'\
                 OR id IN (SELECT history_id FROM history_summaries WHERE summary LIKE ? ESCAPE '\\'))",
            );
            let pattern = format!("%{}%", escape_like_pattern(search));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern.clone()));
            params_vec.push(Box::new(pattern));
        }

        // 类型过滤
        if filter == "pinned" {
            sql.push_str(" AND pinned = 1");
        } else if filter == "image" {
            // 图文混排归入「图片」筛选：两者都是带图内容，用户找图时希望一起看到。
            // 只想看图文时用「图文」自动标签精确筛（不单独占一个顶部标签页，避免拥挤）。
            sql.push_str(" AND type IN ('image', 'rich')");
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

        // v6.1 自我净化：搜索命中即高价值信号（豁免过期清理）。
        // 对本次命中并返回的条目批量 +1，fire-and-forget（写失败不阻塞搜索本身）。
        if !search.is_empty() && !items.is_empty() {
            let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
            let placeholders: Vec<String> =
                ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
            let sql = format!(
                "UPDATE history SET search_hit_count = search_hit_count + 1 WHERE id IN ({})",
                placeholders.join(","),
            );
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
            if let Err(e) = self.lock_conn().execute(&sql, param_refs.as_slice()) {
                log::warn!("[History] 搜索命中计数更新失败: {}", e);
            }
        }

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
        // v6.4 FTS 索引同步（bigram 预处理在 sync_fts_upsert 内做）
        self.sync_fts_upsert(&conn, &item.id);
        // M5-1 内容记忆：同步生成检索摘要（纯规则、本地；敏感内容跳过）。
        // 写不进去不阻塞主流程（记账类操作）。
        if item.item_type == "text" && !item.text.is_empty() {
            let classifier = crate::content_classifier::ContentClassifier::new();
            if !classifier.is_secret(&item.text) {
                let summary = summarize_text(&item.text);
                if !summary.is_empty() {
                    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                    let _ = conn.execute(
                        "INSERT INTO history_summaries (history_id, summary, created_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(history_id) DO UPDATE SET summary = ?2",
                        params![item.id, summary, now],
                    );
                }
            }
        }
        Ok(())
    }

    /// 更新历史记录的文本内容（编辑对话框用）— 同时更新 md5、拼音和 content_type
    pub fn update_history(&self, id: &str, text: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let md5_hash = crate::hashing::content_md5(text);
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
        // v6.4 FTS 索引同步
        self.sync_fts_upsert(&conn, id);
        // 审查 #9：编辑文本后重建内容记忆摘要（旧摘要/派生向量作废）
        self.sync_summary(&conn, id, text);
        Ok(())
    }

    /// 内容记忆（M5-1）：为单条记录同步检索摘要。
    /// 文本变化（编辑/回写）后调用：先删旧摘要与派生向量，再按新文本重建；
    /// 敏感内容跳过；写失败不阻塞主流程（记账类操作）。
    fn sync_summary(&self, conn: &rusqlite::Connection, id: &str, text: &str) {
        let _ = conn.execute(
            "DELETE FROM history_summaries WHERE history_id = ?1",
            params![id],
        );
        let _ = conn.execute(
            "DELETE FROM semantic_vectors WHERE history_id = ?1",
            params![id],
        );
        if text.trim().is_empty() {
            return;
        }
        let classifier = crate::content_classifier::ContentClassifier::new();
        if classifier.is_secret(text) {
            return;
        }
        let summary = summarize_text(text);
        if summary.is_empty() {
            return;
        }
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let _ = conn.execute(
            "INSERT INTO history_summaries (history_id, summary, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(history_id) DO UPDATE SET summary = ?2",
            params![id, summary, now],
        );
    }

    /// 更新图文混排（rich）记录：同时写回 HTML 片段（content）与纯文本（text）。
    /// 与普通 text 类型不同，rich 的两个字段语义不同：content 是真实富文本（回写剪贴板用），
    /// text 是搜索/列表标题用的纯文本，必须一并更新，否则两者会逐渐不一致。
    /// md5 口径对齐采集侧与回写侧：都是 md5(HTML 片段字节)，不能用纯文本算，
    /// 否则粘贴抑制（防自粘贴回显）的 hash 匹配会永久失效。
    /// 保存后清理“编辑时被删掉的图片”：旧片段里有、新片段里没了的本地图片，
    /// 交给与删除记录共用的引用计数清理逻辑处理（仍被其它记录引用则不删）。
    pub fn update_history_rich(
        &self,
        id: &str,
        html_fragment: &str,
        plain_text: &str,
    ) -> Result<(), String> {
        let conn = self.lock_conn();
        let md5_hash = format!(
            "{:x}",
            Md5::new().chain_update(html_fragment.as_bytes()).finalize()
        );
        let pinyin_initials = compute_pinyin_initials(plain_text);

        // 先取旧片段，用于算出本次编辑丢掉的图片
        let old_content: String = conn
            .query_row(
                "SELECT content FROM history WHERE id = ?1 AND type = 'rich'",
                params![id],
                |row| row.get(0),
            )
            .map_err(|_| "记录不存在".to_string())?;

        let affected = conn
            .execute(
                "UPDATE history SET content = ?1, text = ?2, md5 = ?3, pinyin_initials = ?4 WHERE id = ?5",
                params![html_fragment, plain_text, md5_hash, pinyin_initials, id],
            )
            .map_err(|e| e.to_string())?;
        if affected == 0 {
            return Err("记录不存在".to_string());
        }
        // v6.4 FTS 索引同步（content 与 text 都变了）
        self.sync_fts_upsert(&conn, id);
        // 审查 #9：富文本编辑后同样重建内容记忆摘要（按纯文本）
        self.sync_summary(&conn, id, plain_text);

        // 算出“旧有、新无”的图片作为清理候选
        let old_imgs = Self::extract_local_image_files_from_rich_content(&old_content);
        let new_imgs: std::collections::HashSet<String> =
            Self::extract_local_image_files_from_rich_content(html_fragment)
                .into_iter()
                .collect();
        let dropped: Vec<String> = old_imgs
            .into_iter()
            .filter(|p| !new_imgs.contains(p))
            .collect();

        // 必须先释放 conn 锁：cleanup_orphaned_image_files 内部会再次 lock_conn()，
        // std::sync::Mutex 不可重入（同 delete_history 里踩过的那个死锁）。
        drop(conn);
        self.cleanup_orphaned_image_files(&dropped);
        Ok(())
    }

    /// 查找与给定 md5 相同的最近一条记录（智能合并重复内容，按类型精确匹配）。
    /// 修复：原实现 SQL 硬编码 type='text'，导致 rich/doc 类型记录永远查不到——
    /// process_doc 的合并形同虚设、process_rich 无法合并（图文/文档重复入库）。
    /// 修复 Low：增加 workspace 过滤，避免跨工作区误合并
    pub fn find_latest_by_md5(
        &self,
        md5: &str,
        workspace: &str,
        item_type: &str,
    ) -> Result<Option<HistoryItem>, String> {
        let conn = self.lock_conn();
        let result = conn.query_row(
            "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
             FROM history WHERE md5 = ?1 AND type = ?3 AND workspace = ?2
             ORDER BY time DESC LIMIT 1",
            params![md5, workspace, item_type],
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
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = ids
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();

            // 删除前先收集被删记录引用的本地图片文件路径（image 类型 content 就是图片路径，
            // rich 类型要从 HTML 片段里反推 file:// 引用）。提交事务后再判断是否真正删文件，
            // 避免事务回滚时文件已经被删了的不一致。
            let select_sql = format!(
                "SELECT type, content FROM history WHERE id IN ({})",
                placeholders.join(",")
            );
            let candidate_paths: Vec<String> = {
                let mut stmt = conn.prepare(&select_sql).map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(param_refs.as_slice(), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|e| e.to_string())?;
                let mut paths = Vec::new();
                for row in rows {
                    let (item_type, content) = row.map_err(|e| e.to_string())?;
                    match item_type.as_str() {
                        "image" if !content.is_empty() => paths.push(content),
                        "rich" => paths.extend(Self::extract_local_image_files_from_rich_content(&content)),
                        _ => {}
                    }
                }
                paths
            };

            // v6.4 先删 FTS 索引（须在主表 DELETE 前按 rowid 匹配——之后 rowid 就查不到了）
            let fts_delete_sql = format!(
                "DELETE FROM history_fts WHERE rowid IN (SELECT rowid FROM history WHERE id IN ({}))",
                placeholders.join(",")
            );
            let _ = conn.execute(&fts_delete_sql, param_refs.as_slice());

            // 审查 #9：内容记忆与历史生命周期级联 —— 摘要与派生向量随记录一起删，
            // 否则 semantic_vector_pending 会给已删条目的摘要补向量（白烧 embedding 预算）
            let _ = conn.execute(
                &format!(
                    "DELETE FROM history_summaries WHERE history_id IN ({})",
                    placeholders.join(",")
                ),
                param_refs.as_slice(),
            );
            let _ = conn.execute(
                &format!(
                    "DELETE FROM semantic_vectors WHERE history_id IN ({})",
                    placeholders.join(",")
                ),
                param_refs.as_slice(),
            );

            let delete_sql = format!(
                "DELETE FROM history WHERE id IN ({})",
                placeholders.join(",")
            );
            let count = conn
                .execute(&delete_sql, param_refs.as_slice())
                .map_err(|e| e.to_string())?;
            Ok((count as u32, candidate_paths))
        })();
        match result {
            Ok((count, candidate_paths)) => {
                tx.commit().map_err(|e| e.to_string())?;
                // 必须先释放 conn 锁（MutexGuard）再调用 cleanup_orphaned_image_files：
                // 它内部会再次 self.lock_conn()，而 std::sync::Mutex 不可重入，
                // 同线程重复加锁会永久阻塞（实测已复现这个死锁）。
                drop(conn);
                self.cleanup_orphaned_image_files(&candidate_paths);
                Ok(count)
            }
            Err(e) => {
                // tx 在此处离开作用域自动 ROLLBACK，无需手动调用
                Err(e)
            }
        }
    }

    /// 从 rich 类型 content（HTML 片段）里解析出本项目自己落盘的本地图片文件路径。
    /// 只处理 file:// 引用——那是 localize_html_images 采集时改写后的格式；
    /// 远程 http(s) 引用不是本地文件，不处理。
    fn extract_local_image_files_from_rich_content(content: &str) -> Vec<String> {
        crate::clipboard_monitor::extract_img_srcs(content)
            .into_iter()
            .filter(|src| src.starts_with("file:"))
            .filter_map(|src| {
                url::Url::parse(&src)
                    .ok()?
                    .to_file_path()
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .collect()
    }

    /// 事务提交后调用：逐个检查候选图片文件是否还被其它历史记录引用（同一张图片可能
    /// 被多条记录去重共享——image 类型按内容 hash 命名文件，rich 类型内嵌图片同理），
    /// 只有确认没有任何记录还引用时才真正删除磁盘文件，避免误删仍在使用的图片。
    fn cleanup_orphaned_image_files(&self, candidate_paths: &[String]) {
        if candidate_paths.is_empty() {
            return;
        }
        let conn = self.lock_conn();
        let mut seen = std::collections::HashSet::new();
        for path in candidate_paths {
            if !seen.insert(path.clone()) {
                continue; // 本批次里同路径去重，避免重复查询
            }
            // 用文件名（hash.ext）做子串匹配，而不是重新拼回完整 file:// URI：
            // rich content 里存的是正斜杠形式的 href，直接拼回去容易因转义/分隔符差异对不上；
            // 文件名本身是 128 位 hash + 扩展名，足够唯一，子串匹配安全且简单。
            let Some(file_name) = std::path::Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
            else {
                continue;
            };
            let like_pattern = format!("%{}%", escape_like_pattern(file_name));
            let still_referenced: bool = conn
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM history
                        WHERE (type = 'image' AND content = ?1)
                           OR (type = 'rich' AND content LIKE ?2 ESCAPE '\\')
                    )",
                    params![path.as_str(), like_pattern],
                    |row| row.get::<_, i32>(0),
                )
                .map(|n| n != 0)
                .unwrap_or(true); // 查询失败时保守起见当作仍被引用，不删文件

            if !still_referenced {
                if let Err(e) = std::fs::remove_file(path) {
                    log::warn!("[DataStore] 清理孤立图片文件失败 ({}): {}", path, e);
                }
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
        // 审查 #9：内容记忆级联 —— 摘要与派生向量随记录一起删
        let _ = conn.execute(
            "DELETE FROM history_summaries WHERE history_id IN
             (SELECT id FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2)",
            params![workspace, cutoff_str],
        );
        let _ = conn.execute(
            "DELETE FROM semantic_vectors WHERE history_id IN
             (SELECT id FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2)",
            params![workspace, cutoff_str],
        );
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

        // 自我净化豁免 SQL：必须在 lock_conn 之前算好——preserve_sql 内部
        // 会读 config（再锁一次），Mutex 不可重入，锁内调用会死锁。
        let preserve_sql = self.preserve_sql();

        let conn = self.lock_conn();

        // 1. 读取即将被删除的记录（v6.1 自我净化：开关开时高价值条目豁免）
        let mut items: Vec<HistoryItem> = {
            let sql = format!(
                "SELECT id, text, time, type, content, pinned, source, workspace, md5, pinyin_initials, group_id, source_icon, content_type
                 FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2{}",
                preserve_sql,
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
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

        // 3. 事务删除（v6.1 自我净化：与第 1 步同样的豁免条件，保证"预览数 = 删除数"）
        // 改用 RAII 事务：手写 COMMIT 失败不回滚会让事务永久挂在共享连接上，drop 时自动 ROLLBACK 可避免
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        // 审查 #9：内容记忆级联 —— 摘要与派生向量随记录一起删（条件与主表完全一致）
        let _ = conn.execute(
            &format!(
                "DELETE FROM history_summaries WHERE history_id IN
                 (SELECT id FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2{})",
                preserve_sql,
            ),
            params![workspace, cutoff_str],
        );
        let _ = conn.execute(
            &format!(
                "DELETE FROM semantic_vectors WHERE history_id IN
                 (SELECT id FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2{})",
                preserve_sql,
            ),
            params![workspace, cutoff_str],
        );
        let del_sql = format!(
            "DELETE FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2{}",
            preserve_sql,
        );
        let result = conn.execute(&del_sql, params![workspace, cutoff_str]);
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
        // 同 clear_history_with_undo：豁免 SQL 必须在加锁前算好（preserve_sql 内部会读 config）
        let preserve_sql = self.preserve_sql();
        let conn = self.lock_conn();
        let sql = format!(
            "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND pinned = 0 AND time < ?2{}",
            preserve_sql,
        );
        let count: i64 = conn
            .query_row(&sql, params![workspace, cutoff_str], |row| row.get(0))
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
                if t == "image" {
                    // 与顶部「图片」筛选口径一致：图文混排也算带图内容。
                    // 不统一的后果很别扭：用户选「图片」去清理，预览里看到的与实际删的不一致，
                    // 图文记录会被遗留下来。
                    sql.push_str(" AND type IN ('image', 'rich')");
                } else {
                    sql.push_str(" AND type = ?");
                    params_vec.push(Box::new(t.to_string()));
                }
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
