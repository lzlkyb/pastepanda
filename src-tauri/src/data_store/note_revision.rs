//! data_store/note_revision.rs —— 笔记的版本快照与恢复（D8 / B1 #4）。
//!
//! 设计稿：design/PastePanda-版本快照-设计稿.html。建表在 `mod.rs`。
//!
//! # 一句话口径：快照存的是「旧版本」
//!
//! `note_update` 在 UPDATE **之前**把当时的 notes 行拍一张。所以：
//!
//! - `note_revisions` 里永远不含「当前版」（当前版只在 `notes`）——不会多一份冗余副本；
//! - 第一次编辑自动保留了「刚转笔记时的原始版」，而那正是最容易后悔的一步。
//!
//! # 排序与裁剪都用 `id DESC`，不用 `created_at`
//!
//! 时间戳是字符串且只到毫秒，同一毫秒内保存两次就排不稳；`AUTOINCREMENT` 的 id 天然单调。
//! （索引 `idx_note_rev(note_id, created_at)` 仍按规划保留：它真正服务的是 `note_id` 过滤。）

use super::note::note_now;
use super::*;

/// 每篇笔记保留多少份历史（规划 D8）。写成常量而不是设置项：
/// 个人规模下多一个设置项的价值不如多一条笔记。
pub const MAX_REVISIONS: i64 = 20;

/// 一份完整快照（预览时才拉）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRevision {
    pub id: i64,
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
}

/// 列表行。**刻意不带全文**：一篇长笔记几十 KB，× 20 份 = 一次 IPC 拖几个 MB，
/// 而用户真正会看的只有选中的那一份。代价：点一行多发一次 IPC。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRevisionMeta {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    /// 正文字数（SQLite 的 `LENGTH()` 对 TEXT 数的就是字符）。给用户认出哪份用。
    pub char_count: i64,
}

impl DataStore {
    /// 把当前的 notes 行拍成一份快照。笔记不存在时返回 `false`（调用方自己报错）。
    ///
    /// 只在同一个事务里被 `note_update` / `note_restore` 调用，所以收 `&Connection`
    /// 而不是自己锁（再锁一次就是死锁）。
    pub(super) fn snapshot_note_on(
        conn: &rusqlite::Connection,
        note_id: &str,
    ) -> rusqlite::Result<bool> {
        let n = conn.execute(
            "INSERT INTO note_revisions (note_id, title, content, created_at)
             SELECT id, title, content, ?2 FROM notes WHERE id = ?1",
            rusqlite::params![note_id, note_now()],
        )?;
        Ok(n > 0)
    }

    /// 裁到最近 [`MAX_REVISIONS`] 份。每次快照后调一次，所以最多只会多出一行。
    pub(super) fn prune_revisions_on(
        conn: &rusqlite::Connection,
        note_id: &str,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "DELETE FROM note_revisions
             WHERE note_id = ?1
               AND id NOT IN (
                 SELECT id FROM note_revisions WHERE note_id = ?1 ORDER BY id DESC LIMIT ?2
               )",
            rusqlite::params![note_id, MAX_REVISIONS],
        )?;
        Ok(())
    }

    /// 一篇笔记的历史列表，新在前。**不含当前版**（当前版在 `notes`）。
    pub fn note_revision_list(&self, note_id: &str) -> Result<Vec<NoteRevisionMeta>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, created_at, LENGTH(content)
                 FROM note_revisions WHERE note_id = ?1 ORDER BY id DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([note_id], |r| {
                Ok(NoteRevisionMeta {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    created_at: r.get(2)?,
                    char_count: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    /// 取一份快照的全文。
    pub fn note_revision_get(&self, rev_id: i64) -> Result<Option<NoteRevision>, String> {
        let conn = self.lock_conn();
        match conn.query_row(
            "SELECT id, note_id, title, content, created_at FROM note_revisions WHERE id = ?1",
            [rev_id],
            |r| {
                Ok(NoteRevision {
                    id: r.get(0)?,
                    note_id: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    created_at: r.get(4)?,
                })
            },
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 恢复到指定快照。
    ///
    /// **先把当前版存成一份快照再覆盖**，所以恢复本身可撤销：
    /// 后悔了再从历史里恢复回刚才那份即可。
    pub fn note_restore(&self, rev_id: i64) -> Result<Note, String> {
        let note_id = {
            let conn = self.lock_conn();
            let (note_id, title, content): (String, String, String) = conn
                .query_row(
                    "SELECT note_id, title, content FROM note_revisions WHERE id = ?1",
                    [rev_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(|e| match e {
                    // 不静默（规则 #15.3）：恢复一个不存在的版本是调用方的 bug。
                    rusqlite::Error::QueryReturnedNoRows => "版本不存在".to_string(),
                    other => other.to_string(),
                })?;

            // 事务：快照与覆盖必须同生死。只快照不覆盖 = 历史里多了一份莫名其妙的重复版；
            // 只覆盖不快照 = 用户当前的内容直接没了，恢复不可撤销。
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            if !Self::snapshot_note_on(&tx, &note_id).map_err(|e| e.to_string())? {
                return Err(format!("笔记不存在: {}", note_id));
            }
            tx.execute(
                "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
                rusqlite::params![note_id, title, content, note_now()],
            )
            .map_err(|e| e.to_string())?;
            Self::prune_revisions_on(&tx, &note_id).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;

            Self::sync_notes_fts_on(&conn, &note_id);
            note_id
        }; // 先释锁：note_get 会再锁一次，不放就死锁

        self.note_get(&note_id)?
            .ok_or_else(|| format!("笔记不存在: {}", note_id))
    }
}
