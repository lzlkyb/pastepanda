//! Single durable capture draft. Receipts distinguish our retries from arbitrary UUID collisions.
use super::*;
use rusqlite::OptionalExtension;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileKnowledgeDraft {
    pub id: String,
    pub revision: u32,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
}

pub(super) fn init_mobile_knowledge_draft_schema(conn: &Connection) -> rusqlite::Result<()> {
    // Keep the old draft table intact; missing rows naturally restore old drafts as unclassified.
    conn.execute_batch("CREATE TABLE IF NOT EXISTS mobile_knowledge_draft_category (
        draft_id TEXT PRIMARY KEY REFERENCES mobile_knowledge_draft(id) ON DELETE CASCADE,
        folder_id TEXT, tag_ids TEXT NOT NULL);")
}

impl DataStore {
    fn mobile_draft_on(conn: &Connection) -> Result<Option<MobileKnowledgeDraft>, String> {
        conn.query_row(
            "SELECT d.id,d.revision,d.title,d.content,d.updated_at,c.folder_id,COALESCE(c.tag_ids,'[]') FROM mobile_knowledge_draft d LEFT JOIN mobile_knowledge_draft_category c ON c.draft_id=d.id WHERE d.slot=1",
            [],
            |r| {
                Ok(MobileKnowledgeDraft {
                    id: r.get(0)?,
                    revision: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    updated_at: r.get(4)?,
                    folder_id: r.get(5)?,
                    tag_ids: serde_json::from_str(&r.get::<_, String>(6)?).map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e)))?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn mobile_knowledge_draft_get(&self) -> Result<Option<MobileKnowledgeDraft>, String> {
        Self::mobile_draft_on(&self.lock_conn())
    }

    pub fn mobile_knowledge_draft_put(
        &self,
        draft: &MobileKnowledgeDraft,
    ) -> Result<MobileKnowledgeDraft, String> {
        if uuid::Uuid::parse_str(&draft.id).is_err() || draft.revision == 0 {
            return Err("草稿身份或版本无效".into());
        }
        let conn = self.lock_conn();
        let conn = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let committed: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mobile_knowledge_commits WHERE draft_id=?)",
                [&draft.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if committed {
            return Err("这条草稿已经保存，请新建记录".into());
        }
        if let Some(old) = Self::mobile_draft_on(&conn)? {
            if old.id != draft.id {
                return Err("另有未完成草稿，请先恢复或丢弃".into());
            }
            if old.revision > draft.revision
                || (old.revision == draft.revision
                    && (old.title != draft.title || old.content != draft.content || old.folder_id != draft.folder_id || old.tag_ids != draft.tag_ids))
            {
                return Err("草稿已更新，请保留当前内容并重新读取".into());
            }
            if old.revision == draft.revision {
                return Ok(old);
            }
        }
        let mut stored = draft.clone();
        stored.updated_at = super::note::note_now();
        conn.execute("INSERT INTO mobile_knowledge_draft(slot,id,revision,title,content,updated_at) VALUES (1,?1,?2,?3,?4,?5) ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,title=excluded.title,content=excluded.content,updated_at=excluded.updated_at",
            params![stored.id, stored.revision, stored.title, stored.content, stored.updated_at]).map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO mobile_knowledge_draft_category(draft_id,folder_id,tag_ids) VALUES(?1,?2,?3) ON CONFLICT(draft_id) DO UPDATE SET folder_id=excluded.folder_id,tag_ids=excluded.tag_ids",
            params![stored.id,stored.folder_id,serde_json::to_string(&stored.tag_ids).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        conn.commit().map_err(|e| e.to_string())?;
        Ok(stored)
    }

    pub fn mobile_knowledge_draft_clear(&self, id: &str, revision: u32) -> Result<(), String> {
        let conn = self.lock_conn();
        if let Some(old) = Self::mobile_draft_on(&conn)? {
            if old.id != id || old.revision != revision {
                return Err("草稿已更新，未丢弃新内容".into());
            }
            conn.execute("DELETE FROM mobile_knowledge_draft WHERE slot=1", [])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn mobile_knowledge_draft_commit(&self, id: &str, revision: u32) -> Result<Note, String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let receipt: Option<u32> = tx
            .query_row(
                "SELECT revision FROM mobile_knowledge_commits WHERE draft_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(saved_revision) = receipt {
            if saved_revision != revision {
                return Err("这条记录已保存为其他版本，未覆盖笔记".into());
            }
            drop(tx);
            drop(conn);
            return self
                .note_get(id)?
                .ok_or_else(|| "已保存的笔记已被移除，不会重新创建".into());
        }
        let draft = Self::mobile_draft_on(&tx)?.ok_or("没有可保存的草稿")?;
        if draft.id != id || draft.revision != revision {
            return Err("草稿已更新，请先保存最新草稿".into());
        }
        if draft.title.trim().is_empty() && draft.content.trim().is_empty() {
            return Err("请先写下记录内容".into());
        }
        // A collision errors at INSERT; existing notes are never modified. This uses the
        // common insertion/index path inside the same transaction as receipt and cleanup.
        let title = if draft.title.trim().is_empty() {
            draft
                .content
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().chars().take(32).collect::<String>())
                .unwrap_or_else(|| "新记录".to_string())
        } else {
            draft.title.trim().to_string()
        };
        Self::mobile_knowledge_validate_category_on(&tx, &draft.folder_id, &draft.tag_ids)?;
        self.note_insert_on(&tx, Some(id), None, &title, &draft.content, "", false)?;
        self.mobile_knowledge_category_on(&tx, id, &draft.folder_id, &draft.tag_ids)?;
        tx.execute(
            "INSERT INTO mobile_knowledge_commits(draft_id,revision) VALUES (?,?)",
            params![id, revision],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM mobile_knowledge_draft WHERE slot=1 AND id=?",
            [id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        self.note_get(id)?.ok_or_else(|| "保存结果无法读取".into())
    }
}
