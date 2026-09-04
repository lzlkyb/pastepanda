//! wiki 链关系表（O-2 / M3-④）。
//!
//! # 为什么要落表
//!
//! 正文里 `[[标题]]` 一直是**原样保存不解析**的（`notes.content` 的注释，D7）。
//! 于是「谁引用了这一篇」只能全库扫正文——四个下游都要这个答案：
//! 反链面板、`[[` 补全的已存在提示、AM-9 的引用次数信号、O-9 的断链检查。
//!
//! **建一次，四家共用**（见总排期 §2 的裁决）。
//!
//! # 存的是标题，不是 id
//!
//! 与 `markdown::links` 同源，理由见那边的模块文档：
//! O-9 改名时靠字面 `REPLACE(content, '[[旧]]', '[[新]]')` 跟随，
//! 链表存 id 就与那套机制脱节了。
//!
//! 🔴 **解析目标时用精确标题匹配，不折大小写**。
//! 折了的话 `[[java]]` 会解析到笔记《Java》，而改名时那句 REPLACE 是大小写敏感的
//! ——链会**静默断掉**。AM-8 的近重复提示正好补这一面：
//! 它会告诉你库里有 `Java` / `java` 两个名字容易撞。

use super::DataStore;

/// 一条出链在库里的解析结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct OutLink {
    /// 方括号里的目标标题。
    pub target: String,
    /// 解析到的笔记 id；`None` = 断链（库里没有这个标题的活笔记）。
    pub to_id: Option<String>,
    pub line: i64,
}

/// 一条反链（谁引用了我）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackLink {
    pub from_id: String,
    pub from_title: String,
    pub line: i64,
}

impl DataStore {
    /// 重建这一篇的出链。**由 `sync_note_indexes_on` 统一调用，不要单独调。**
    ///
    /// 失败只 `warn`：链表是派生数据，重建不了不该让用户存不了笔记。
    /// 代价是反链暂时不准，下次保存这一篇就自愈。
    pub(super) fn sync_note_links_on(conn: &rusqlite::Connection, id: &str) {
        let content: String = match conn.query_row(
            "SELECT content FROM notes WHERE id = ?1",
            [id],
            |r| r.get(0),
        ) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[Links] 读不到正文，跳过重建 {}: {}", id, e);
                return;
            }
        };
        // 先删后插：链会被改掉、删掉，增量更新算不清。
        if let Err(e) = conn.execute("DELETE FROM note_links WHERE from_id = ?1", [id]) {
            log::warn!("[Links] 清旧链失败 {}: {}", id, e);
            return;
        }
        for l in crate::markdown::parse_links(&content) {
            if let Err(e) = conn.execute(
                "INSERT OR IGNORE INTO note_links (from_id, to_title, line) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, l.target, l.line as i64],
            ) {
                log::warn!("[Links] 写链失败 {} → {}: {}", id, l.target, e);
            }
        }
    }

    /// 首次建表时把全库的链补齐。**只在表刚建出来那一次跑。**
    ///
    /// 不做「表空就补」：本机库现在**一条 `[[ ]]` 都没有**（0/25 实测），
    /// 那样判的话每次启动都要全库扫一遍正文，而结果永远是空。
    pub(super) fn backfill_note_links_on(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
        let ids: Vec<String> = {
            let mut st = conn.prepare("SELECT id FROM notes")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.filter_map(Result::ok).collect()
        };
        let n = ids.len();
        for id in ids {
            Self::sync_note_links_on(conn, &id);
        }
        log::info!("[Links] 首次建表，已回填 {} 篇的出链", n);
        Ok(())
    }

    /// 这一篇引出去的链，带解析结果。断链的 `to_id` 是 `None`。
    pub fn note_links_out(&self, id: &str) -> Result<Vec<OutLink>, String> {
        let conn = self.lock_conn();
        // LEFT JOIN：断链也要返回——它正是 O-9 要报的那一类。
        // 目标必须是**活**笔记：指向回收站里那篇也算断（用户看不到它）。
        let mut st = conn
            .prepare(
                "SELECT l.to_title, l.line,
                        (SELECT n.id FROM notes n
                          WHERE n.title = l.to_title AND n.deleted_at IS NULL LIMIT 1)
                 FROM note_links l WHERE l.from_id = ?1 ORDER BY l.line",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([id], |r| {
                Ok(OutLink {
                    target: r.get(0)?,
                    line: r.get(1)?,
                    to_id: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// 谁引用了这一篇（反链）。
    pub fn note_backlinks(&self, id: &str) -> Result<Vec<BackLink>, String> {
        let conn = self.lock_conn();
        // 按本篇**当前**标题反查。改名时 O-9 会把别人正文里的 `[[旧]]` 重写成 `[[新]]`，
        // 而重写走的是 note_update → sync_note_indexes_on，链表跟着更新，所以这里读到的是新的。
        let mut st = conn
            .prepare(
                "SELECT l.from_id, f.title, l.line
                 FROM note_links l
                 JOIN notes f ON f.id = l.from_id AND f.deleted_at IS NULL
                 WHERE l.to_title = (SELECT title FROM notes WHERE id = ?1)
                   AND l.from_id <> ?1
                 ORDER BY f.title",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([id], |r| {
                Ok(BackLink {
                    from_id: r.get(0)?,
                    from_title: r.get(1)?,
                    line: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// 全库的断链：目标标题在活笔记里找不到。
    ///
    /// 返回 `(源笔记 id, 源标题, 目标标题)`。
    pub fn note_broken_links(&self) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(
                "SELECT l.from_id, f.title, l.to_title
                 FROM note_links l
                 JOIN notes f ON f.id = l.from_id AND f.deleted_at IS NULL
                 WHERE NOT EXISTS (
                     SELECT 1 FROM notes n WHERE n.title = l.to_title AND n.deleted_at IS NULL
                 )
                 ORDER BY f.title, l.to_title",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// 孤立笔记：既不引用别人，也没人引用它。
    ///
    /// ⚠ **孤立不是问题**，只是一个视角。本机库现在 25 篇全孤立（0 条 `[[ ]]`），
    /// 所以这个数在中文笔记场景下天然很高——不要拿它当「该整理了」的信号。
    pub fn note_orphans(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(
                "SELECT n.id, n.title FROM notes n
                 WHERE n.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM note_links l WHERE l.from_id = n.id)
                   AND NOT EXISTS (SELECT 1 FROM note_links l WHERE l.to_title = n.title)
                 ORDER BY n.title",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }
}
