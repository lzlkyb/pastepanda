use super::*;

/// 标签表的时间戳。
///
/// 🔴 **不用 `note::note_now()`**：那个带毫秒（`%.3f`），而 `tags.created_at`
/// 从建表起就是无毫秒格式。同一列里混两种格式，字符串比大小会在秒相同时
/// 让带毫秒的那条永远赢——LWW 就此偏向「后来才写的那种格式」，而不是后写的那次改动。
///
/// 收口成一处（规则 #11）：本文件原先三处各写一遍同样的 format 字面量。
pub(super) fn tag_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

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

    /// **被活笔记用到**的标签名（去重、按名排序）。
    ///
    /// 🔴 **不是 [`Self::get_tags`]**。`tags` 是剪贴板与知识库的**共用表**：
    /// 真库（2026-09-05）共 38 个标签，被笔记用到的只有 5 个，
    /// 其余全是剪贴板内容分类器打的自动标签（`CSS` / `ENV` / `邮箱` ……）。
    ///
    /// 凡是「描述知识库」的场合都得用这一条。历史上 MCP 的 `kb_folders`
    /// 用的是 `get_tags()`，于是对模型报「标签（38 个）……」外加一条
    /// 「`Java`/`java` 疑似重复，另一个下面的笔记会被漏掉」——
    /// 而那两个标签下一篇笔记都没有，模型拿它去筛只会得到空结果。
    ///
    /// 去重是必需的：同一个标签打在多篇上会出多行，
    /// 而 [`crate::similar::find_dups`] 会把它自己跟自己归成一组「重复」。
    pub fn note_tag_names(&self) -> Result<Vec<String>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(
                "SELECT DISTINCT t.name FROM tags t
                 JOIN note_tags nt ON nt.tag_id = t.id
                 JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
                 ORDER BY t.name",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
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
        let now = tag_now();
        conn.execute(
            // M6-P3：updated_at 与 created_at 同值。
            "INSERT INTO tags (id, name, color, source, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'manual', ?4, ?4)",
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
                // M6-P3：标签改名/改色都要留时间戳，否则同步时无从判断谁更新。
                "UPDATE tags SET name = ?1, color = ?2, updated_at = ?4 WHERE id = ?3",
                params![name, color, id, tag_now()],
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
        for (history_id, tag) in rows.flatten() {
            map.entry(history_id).or_default().push(tag);
        }
        Ok(map.into_iter().collect())
    }

    // ===== 自动标签（AI 智能分类） =====

    /// 确保自动标签种子数据存在（首次启动时插入）。
    ///
    /// 🔴 种子分成两张表（2026-09-08，色彩规范 §5.5），因为它们的
    /// **颜色性质不同**，将来的改动规则也不同：
    ///
    /// - [`SEMANTIC_TAGS`]：身份色。该与前端 `CONTENT_TYPE_META` 对齐，
    ///   取值归 `HUE`（前端 `src/lib/palette.ts`）管。
    /// - [`BRAND_TAGS`]：品牌色。外部事实，**不参与主题、不参与哈希、不可替换**。
    ///
    /// ❗ 本次拆分**一个色值都没改**。下面那个已知不一致需要单独一轮（含数据迁移）：
    ///
    /// **同一个概念在前后端取两个色**——17 个可比概念里 14 个不一致。
    /// 例：「电话」图标是 `#F59E0B`（琥珀）而标签是 `#16A34A`（绿）；
    /// 「Markdown」图标是 #6366F1、标签是 #84CC16。两者**在同一张卡片上同时可见**。
    ///
    /// 🔴 不能在这里顺手改：下面是 `INSERT OR IGNORE`，
    /// 改种子**只对全新安装生效**，已有库的标签颜色一个不会变——
    /// 那只会让新旧安装分叉，比现在更糟。
    pub fn ensure_auto_tags(&self) -> Result<(), String> {
        /// 身份色：这是哪一类内容。应与前端 `CONTENT_TYPE_META` 同源。
        const SEMANTIC_TAGS: [(&str, &str, &str); 18] = [
            ("auto-code", "代码", "#8B5CF6"),
            // 图文混排：走自动标签而不是卡片上写死的徽标，这样才能与其它标签
            // 统一管理：点卡片上的标签可筛选、也会出现在筛选标签列表里
            ("auto-rich", "图文", "#D97706"),
            // 流程图 / 文档：同上，类型标识走标签体系。
            //
            // 这两行是补的：`resolve_auto_tag_ids` 按 name 查、查不到就跳过，
            // 所以种子表里没的名字**发了 TagJob 也是静默失效**——
            // 「文档」一直在 process_doc 里 push 着，但从来没真正落到过卡片上。
            // 流程图的色与前端 contentTypes.ts 里 diagram 的 #0EA5E9 保持一致。
            ("auto-diagram", "流程图", "#0EA5E9"),
            ("auto-doc", "文档", "#A21CAF"),
            ("auto-link", "链接", "#10B981"),
            ("auto-json", "JSON", "#F97316"),
            ("auto-config", "配置文件", "#14B8A6"),
            ("auto-log", "日志", "#78716C"),
            ("auto-table", "表格", "#84CC16"),
            ("auto-command", "命令行", "#A855F7"),
            ("auto-secret", "密钥", "#DC2626"),
            ("auto-number", "数字", "#0EA5E9"),
            ("auto-plaintext", "纯文本", "#6B7280"),
            ("auto-email", "邮箱", "#3B82F6"),
            ("auto-phone", "电话", "#F59E0B"),
            ("auto-color", "颜色", "#EC4899"),
            ("auto-filepath", "文件路径", "#06B6D4"),
            ("auto-markdown", "Markdown", "#6366F1"),
        ];

        /// 品牌色：语言与配置格式的**官方 logo 色**。
        ///
        /// 🔴 铁律：**不参与主题、不参与哈希、不可替换。**
        /// 把 Python 蓝 `#3776AB` 换成 `HUE` 里某个“差不多的蓝”，
        /// 它就不再是「Python」了——这类色的价值全在于认出来。
        ///
        /// ❗ 所以它们也不归 `HUE` 管。前端 `CONTENT_TYPE_META` 里给
        /// HTML 定的 `HUE.red` 反而是错的：这里的 `#E34F26` 才是 HTML5 官方色。
        const BRAND_TAGS: [(&str, &str, &str); 14] = [
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

        // 一次性迁移（2026-09-08，色彩规范 §5.7）：把已建的身份标签对齐到前端。
        //
        // 🔴 背景：同一个概念在前后端取两个色，16 个可比概念里 **13 个不一致**，
        //    而两者**在同一张卡片上同时可见**（图标走 `CONTENT_TYPE_META`，
        //    标签走这张种子表）。例：一条电话号码图标琥珀、标签绿。
        //
        // ❗ 上面那个 `INSERT OR IGNORE` **改不到已存在的行**，
        //    所以光改种子只对全新安装生效——那反而让新旧安装分叉。必须配迁移。
        //
        // 🔴 按**旧值**匹配而不是无条件覆盖：现在确实没有改标签颜色的界面
        //    （`updateTag` 没人调），但写成「种子永远赢」就是一个每次启动都跑的
        //    覆盖行为——将来真加了改色功能，用户的修改会被静默抹掉。
        //    按旧值匹配自带幂等：跑过一次后再也匹配不上。
        const COLOR_REALIGN: [(&str, &str, &str); 13] = [
            ("auto-code", "#6366F1", "#8B5CF6"),
            ("auto-link", "#06B6D4", "#10B981"),
            ("auto-json", "#F59E0B", "#F97316"),
            ("auto-config", "#10B981", "#14B8A6"),
            ("auto-log", "#6B7280", "#78716C"),
            ("auto-table", "#8B5CF6", "#84CC16"),
            ("auto-command", "#EF4444", "#A855F7"),
            ("auto-number", "#14B8A6", "#0EA5E9"),
            ("auto-plaintext", "#9CA3AF", "#6B7280"),
            ("auto-email", "#2563EB", "#3B82F6"),
            ("auto-phone", "#16A34A", "#F59E0B"),
            ("auto-filepath", "#EA580C", "#06B6D4"),
            ("auto-markdown", "#84CC16", "#6366F1"),
        ];

        let conn = self.lock_conn();

        let mut realigned = 0usize;
        for (id, old, new) in &COLOR_REALIGN {
            match conn.execute(
                "UPDATE tags SET color = ?3 WHERE id = ?1 AND color = ?2",
                params![id, old, new],
            ) {
                Ok(n) => realigned += n,
                // 不阻断启动：标签颜色不值得拿整个应用能不能开去换。
                Err(e) => log::warn!("[DataStore] 标签色对齐失败 {}（不阻断）: {}", id, e),
            }
        }
        if realigned > 0 {
            log::info!("[DataStore] 自动标签色对齐前端：{} 个", realigned);
        }

        for (id, name, color) in SEMANTIC_TAGS.iter().chain(BRAND_TAGS.iter()) {
            conn.execute(
                // M6-P3：补 updated_at。
                // 🔴 顺带修一个既有 bug：原来用 `datetime('now')`，那是 **UTC**，
                //    而本文件其它写入点用本地时间——同一列里混了两个时区，
                //    自动标签的 created_at 比手动标签整整早 8 小时。
                "INSERT OR IGNORE INTO tags (id, name, color, source, created_at, updated_at)                  VALUES (?1, ?2, ?3, 'auto', ?4, ?4)",
                params![id, name, color, tag_now()],
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
