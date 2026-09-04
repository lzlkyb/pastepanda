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
//! # W2：锚定份永不被裁
//!
//! `MAX_REVISIONS = 20` 加上「每次写都裁一次」意味着：**连续 21 次修改就能
//! 把一篇笔记的真实历史全挤没**，而那只需「修改」一个权限。所以写工具之前
//! 必须先有锚定：每篇笔记被外部首次写入前的那一张自动锚住，永不被挤掉。
//!
//! # 排序与裁剪都用 `id DESC`，不用 `created_at`
//!
//! 时间戳是字符串且只到毫秒，同一毫秒内保存两次就排不稳；`AUTOINCREMENT` 的 id 天然单调。
//! （索引 `idx_note_rev(note_id, created_at)` 仍按规划保留：它真正服务的是 `note_id` 过滤。）

use super::note::note_now;
use super::*;

/// 每篇笔记保留多少份**普通**历史（规划 D8）。写成常量而不是设置项：
/// 个人规模下多一个设置项的价值不如多一条笔记。
///
/// W2 后它不再是每篇的总上限：锚定份不占这个配额（见 `prune_revisions_on`）。
pub const MAX_REVISIONS: i64 = 20;

/// 一份完整快照（预览时才拉）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRevision {
    pub id: i64,
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
    /// 锚定中：永不被 [`DataStore::prune_revisions_on`] 裁掉（W2）。
    pub pinned: bool,
    /// 这一版是谁改出来的。`""` = 你自己改的；非空形如 `agent:claude-code`。
    pub source_agent: String,
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
    /// 锚定中。列表里要标出来：它是不会被挤没的那一份。
    pub pinned: bool,
    /// 改动来源。空 = 人工。
    pub source_agent: String,
}

impl DataStore {
    /// 这一张快照该不该锚住（W2）。
    ///
    /// 口径：**每篇笔记被外部首次写入前的那一张，每篇最多一份**。
    /// 快照拍的是 UPDATE **之前**的内容，所以锚住的恰好是「模型动手之前的原样」。
    ///
    /// 为何把触发条件绑在「来源不是人」上，而不是另传一个 `anchor: bool`：
    /// 后者意味着 M5 每一个写入入口都得记得传 `true`，漏一个就是静默失去保护
    /// （规则 #11.1：新增分支必须找全同类调用点）。绑在 `source` 上则是：
    /// 只要写入注明了来源，保护就自动生效，漏不了。
    ///
    /// 「最多一份」不靠额外的状态位：这篇有没有锚定行，本身就是「首次」的定义。
    fn should_anchor_on(
        conn: &rusqlite::Connection,
        note_id: &str,
        source: &str,
    ) -> rusqlite::Result<bool> {
        if source.is_empty() {
            return Ok(false); // 人亲自改的不锚：你自己改坏了本来就能自己改回来
        }
        let has_anchor: i64 = conn.query_row(
            "SELECT COUNT(*) FROM note_revisions WHERE note_id = ?1 AND pinned = 1",
            [note_id],
            |r| r.get(0),
        )?;
        Ok(has_anchor == 0)
    }

    /// 把当前的 notes 行拍成一份快照。笔记不存在时返回 `false`（调用方自己报错）。
    ///
    /// 只在同一个事务里被 `note_update` / `note_restore` 调用，所以收 `&Connection`
    /// 而不是自己锁（再锁一次就是死锁）。
    pub(super) fn snapshot_note_on(
        conn: &rusqlite::Connection,
        note_id: &str,
        source: &str,
    ) -> rusqlite::Result<bool> {
        let pinned = Self::should_anchor_on(conn, note_id, source)?;
        let n = conn.execute(
            "INSERT INTO note_revisions (note_id, title, content, created_at, pinned, source_agent)
             SELECT id, title, content, ?2, ?3, ?4 FROM notes WHERE id = ?1",
            rusqlite::params![note_id, note_now(), pinned, source],
        )?;
        Ok(n > 0)
    }

    /// 裁到最近 [`MAX_REVISIONS`] 份。每次快照后调一次，所以最多只会多出一行。
    ///
    /// 不变式（W2）：**最近 20 份普通历史 + 所有锚定份**。两个 `pinned = 0` 都必需：
    /// 外层那个让锚定份永不被删；子查询那个让锚定份不占配额——否则锚一份就把
    /// 普通历史的容量删成 19，「保护历史」反而先吃掉一份历史。
    ///
    /// 锚定份总数没设上限：自动锚定本身就是每篇最多一份（见 `should_anchor_on`），
    /// 其余均来自用户手动锚定——拒绝用户手动保留自己的版本只会显得莫名其妙。
    pub(super) fn prune_revisions_on(
        conn: &rusqlite::Connection,
        note_id: &str,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "DELETE FROM note_revisions
             WHERE note_id = ?1
               AND pinned = 0
               AND id NOT IN (
                 SELECT id FROM note_revisions
                 WHERE note_id = ?1 AND pinned = 0 ORDER BY id DESC LIMIT ?2
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
                "SELECT id, title, created_at, LENGTH(content), pinned, source_agent
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
                    pinned: r.get(4)?,
                    source_agent: r.get(5)?,
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
            "SELECT id, note_id, title, content, created_at, pinned, source_agent
             FROM note_revisions WHERE id = ?1",
            [rev_id],
            |r| {
                Ok(NoteRevision {
                    id: r.get(0)?,
                    note_id: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    created_at: r.get(4)?,
                    pinned: r.get(5)?,
                    source_agent: r.get(6)?,
                })
            },
        ) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 手动锚定 / 解除锚定一份快照（W2b）。
    ///
    /// **锚点只能手动清除，不自动过期**。存储代价有界且很小（每篇一份纯文本），
    /// 而任何自动释放都会重新开一个窗口——而这个机制要防的恰好就是「慢慢搞破」。
    /// 按时间过期（如 30 天）与设计目的直接相左。
    ///
    /// 解除后那一份**不会立即消失**，而是重新变成普通历史，在后继编辑中正常被挤出。
    /// （界面得把这一句说清楚：否则用户看到的是「点了没反应，过一阵它自己不见了」。）
    pub fn note_revision_pin(&self, rev_id: i64, pinned: bool) -> Result<(), String> {
        let conn = self.lock_conn();
        let n = conn
            .execute(
                "UPDATE note_revisions SET pinned = ?2 WHERE id = ?1",
                rusqlite::params![rev_id, pinned],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            // 不静默（规则 #15.3）：锚一个不存在的版本是调用方的 bug。
            return Err("版本不存在".to_string());
        }
        Ok(())
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
            // 来源传空：从历史里恢复只可能是人点的（模型没有这个工具），
            // 所以既不该记成外部改动，也不该触发锚定。
            if !Self::snapshot_note_on(&tx, &note_id, "").map_err(|e| e.to_string())? {
                return Err(format!("笔记不存在: {}", note_id));
            }
            tx.execute(
                // M6-P2：恢复旧版本是一次新的修改（不是回到过去），
                // 所以 updated_ms 取**现在**而不是那个快照的时间——
                // 否则对端会认为它旧于自己手里的版本，把用户刚做的恢复覆盖掉。
                "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4, \
                 updated_ms = MAX(?5, updated_ms + 1) WHERE id = ?1",
                rusqlite::params![note_id, title, content, note_now(), super::note::now_ms()],
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
