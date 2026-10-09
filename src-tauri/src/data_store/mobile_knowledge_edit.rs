//! Durable phone edits: immutable base, transactional comparison, explicit independent copy.
use super::*;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileKnowledgeEditDraft {
    pub id: String,
    pub revision: u32,
    pub note_id: String,
    pub base_version: String,
    pub base_note: Note,
    pub title: String,
    pub content: String,
    pub folder_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MobileKnowledgeEditResult {
    Saved { note: Note, relinked: usize },
    Conflict { latest: Note },
    Deleted,
}

pub(super) fn init_mobile_knowledge_edit_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mobile_knowledge_edit_draft (
        slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mobile_knowledge_edit_commits (
        draft_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, note_id TEXT NOT NULL,
        kind TEXT NOT NULL, relinked INTEGER NOT NULL);",
    )
}

impl DataStore {
    fn mobile_edit_on(conn: &Connection) -> Result<Option<MobileKnowledgeEditDraft>, String> {
        let payload: Option<String> = conn
            .query_row(
                "SELECT payload FROM mobile_knowledge_edit_draft WHERE slot=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        payload
            .map(|p| serde_json::from_str(&p).map_err(|e| e.to_string()))
            .transpose()
    }

    fn mobile_edit_store_on(
        conn: &Connection,
        draft: &MobileKnowledgeEditDraft,
    ) -> Result<(), String> {
        let payload = serde_json::to_string(draft).map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO mobile_knowledge_edit_draft(slot,id,revision,payload) VALUES(1,?1,?2,?3)
            ON CONFLICT(slot) DO UPDATE SET id=excluded.id,revision=excluded.revision,payload=excluded.payload",
            params![draft.id, draft.revision, payload]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Read the row and its sync version under the same lock/transaction as comparison.
    fn mobile_edit_note_on(conn: &Connection, id: &str) -> Result<Option<(Note, String)>, String> {
        let sql = format!(
            "SELECT {}, updated_ms FROM notes WHERE id=? AND deleted_at IS NULL",
            super::note::NOTE_COLS
        );
        let row = conn
            .query_row(&sql, [id], |r| {
                Ok((super::note::row_to_note(r)?, r.get::<_, i64>(14)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((mut note, ms)) = row else {
            return Ok(None);
        };
        // Fail closed: a broken tag table must not look like an intentionally empty selection.
        note.tags = conn
            .prepare(
                "SELECT t.id,t.name,t.color,COALESCE(t.source,'manual'),t.created_at
            FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=? ORDER BY t.id",
            )
            .and_then(|mut s| {
                s.query_map([id], |r| {
                    Ok(Tag {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        color: r.get(2)?,
                        source: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        hash.update(ms.to_le_bytes());
        // Pin/summary/tag display changes are never overwritten by this editor and should
        // not manufacture a conflict. Include every editable field and the sync row version.
        let tag_ids: Vec<_> = note.tags.iter().map(|tag| &tag.id).collect();
        hash.update(
            serde_json::to_vec(&(
                &note.id,
                &note.title,
                &note.content,
                &note.folder_id,
                tag_ids,
            ))
            .map_err(|e| e.to_string())?,
        );
        Ok(Some((note, format!("{:x}", hash.finalize()))))
    }

    pub fn mobile_knowledge_edit_get(&self) -> Result<Option<MobileKnowledgeEditDraft>, String> {
        Self::mobile_edit_on(&self.lock_conn())
    }

    pub fn mobile_knowledge_edit_begin(
        &self,
        note_id: &str,
    ) -> Result<MobileKnowledgeEditDraft, String> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(draft) = Self::mobile_edit_on(&tx)? {
            if draft.note_id == note_id {
                return Ok(draft);
            }
            return Err("另有未完成的编辑，请先恢复或丢弃原草稿".into());
        }
        let (base_note, base_version) =
            Self::mobile_edit_note_on(&tx, note_id)?.ok_or("笔记已被移除，无法开始编辑")?;
        let draft = MobileKnowledgeEditDraft {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            note_id: note_id.into(),
            base_version,
            title: base_note.title.clone(),
            content: base_note.content.clone(),
            folder_id: base_note.folder_id.clone(),
            tag_ids: base_note.tags.iter().map(|t| t.id.clone()).collect(),
            base_note,
            updated_at: super::note::note_now(),
        };
        Self::mobile_edit_store_on(&tx, &draft)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(draft)
    }

    pub fn mobile_knowledge_edit_put(
        &self,
        draft: &MobileKnowledgeEditDraft,
    ) -> Result<MobileKnowledgeEditDraft, String> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let old = Self::mobile_edit_on(&tx)?.ok_or("编辑草稿已结束，请重新打开笔记")?;
        if old.id != draft.id
            || old.note_id != draft.note_id
            || old.base_version != draft.base_version
            || serde_json::to_value(&old.base_note).map_err(|e| e.to_string())?
                != serde_json::to_value(&draft.base_note).map_err(|e| e.to_string())?
        {
            return Err("编辑基础版本已改变，未覆盖当前草稿".into());
        }
        let same = old.title == draft.title
            && old.content == draft.content
            && old.folder_id == draft.folder_id
            && old.tag_ids == draft.tag_ids;
        if draft.revision < old.revision || (draft.revision == old.revision && !same) {
            return Err("草稿已更新，请保留当前内容并重新读取".into());
        }
        if draft.revision == old.revision {
            return Ok(old);
        }
        let mut stored = draft.clone();
        stored.updated_at = super::note::note_now();
        Self::mobile_edit_store_on(&tx, &stored)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(stored)
    }

    pub fn mobile_knowledge_edit_clear(&self, id: &str, revision: u32) -> Result<(), String> {
        let conn = self.lock_conn();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(draft) = Self::mobile_edit_on(&tx)? {
            if draft.id != id || draft.revision != revision {
                return Err("草稿已更新，未丢弃新内容".into());
            }
            tx.execute("DELETE FROM mobile_knowledge_edit_draft WHERE slot=1", [])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mobile_knowledge_edit_commit(
        &self,
        id: &str,
        revision: u32,
    ) -> Result<MobileKnowledgeEditResult, String> {
        self.mobile_edit_save(id, revision, false)
    }
    pub fn mobile_knowledge_edit_copy(
        &self,
        id: &str,
        revision: u32,
    ) -> Result<MobileKnowledgeEditResult, String> {
        self.mobile_edit_save(id, revision, true)
    }

    fn mobile_edit_save(
        &self,
        id: &str,
        revision: u32,
        copy: bool,
    ) -> Result<MobileKnowledgeEditResult, String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let kind = if copy { "copy" } else { "edit" };
        let receipt: Option<(u32,String,String,usize)> = tx.query_row(
            "SELECT revision,note_id,kind,relinked FROM mobile_knowledge_edit_commits WHERE draft_id=?", [id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
        ).optional().map_err(|e| e.to_string())?;
        if let Some((saved_revision, note_id, saved_kind, relinked)) = receipt {
            if revision != saved_revision || kind != saved_kind {
                return Err("该草稿已完成另一项保存，未重复创建或覆盖".into());
            }
            return Ok(match Self::mobile_edit_note_on(&tx, &note_id)? {
                Some((note, _)) => MobileKnowledgeEditResult::Saved { note, relinked },
                None => MobileKnowledgeEditResult::Deleted,
            });
        }
        let draft = Self::mobile_edit_on(&tx)?.ok_or("没有待保存的编辑草稿")?;
        if draft.id != id || draft.revision != revision {
            return Err("草稿已更新，请先保存最新草稿".into());
        }
        if draft.title.trim().is_empty() {
            return Err("MOBILE_EDIT_REJECTED:title_empty".into());
        }
        let current = Self::mobile_edit_note_on(&tx, &draft.note_id)?;
        if !copy {
            let Some((latest, version)) = current else {
                return Ok(MobileKnowledgeEditResult::Deleted);
            };
            if version != draft.base_version {
                return Ok(MobileKnowledgeEditResult::Conflict { latest });
            }
        }
        Self::mobile_knowledge_validate_category_on(&tx, &draft.folder_id, &draft.tag_ids)?;
        let (note_id, relinked) = if copy {
            // Copies must remain distinguishable in title-based wiki-link resolution.
            let title = format!("{}（手机副本）", draft.title.trim());
            let note = self.note_insert_on(&tx, None, None, &title, &draft.content, "", false)?;
            (note.id, 0)
        } else {
            let report =
                self.note_update_on(&tx, &draft.note_id, &draft.title, &draft.content, "")?;
            (draft.note_id.clone(), report.relinked)
        };
        self.mobile_knowledge_category_on(&tx, &note_id, &draft.folder_id, &draft.tag_ids)?;
        tx.execute("INSERT INTO mobile_knowledge_edit_commits(draft_id,revision,note_id,kind,relinked) VALUES(?,?,?,?,?)",
            params![id,revision,note_id,kind,relinked]).map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM mobile_knowledge_edit_draft WHERE slot=1 AND id=?",
            [id],
        )
        .map_err(|e| e.to_string())?;
        let (note, _) = Self::mobile_edit_note_on(&tx, &note_id)?.ok_or("保存结果无法读取")?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(MobileKnowledgeEditResult::Saved { note, relinked })
    }

    pub(super) fn mobile_knowledge_validate_category_on(
        conn: &Connection,
        folder_id: &Option<String>,
        tag_ids: &[String],
    ) -> Result<(), String> {
        if let Some(id) = folder_id {
            if !conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM note_folders WHERE id=?)",
                    [id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?
            {
                return Err("MOBILE_EDIT_REJECTED:folder_missing".into());
            }
        }
        for id in tag_ids {
            if !conn
                .query_row("SELECT EXISTS(SELECT 1 FROM tags WHERE id=?)", [id], |r| {
                    r.get::<_, bool>(0)
                })
                .map_err(|e| e.to_string())?
            {
                return Err("MOBILE_EDIT_REJECTED:tag_missing".into());
            }
        }
        Ok(())
    }

    pub(super) fn mobile_knowledge_category_on(
        &self,
        conn: &Connection,
        note_id: &str,
        folder_id: &Option<String>,
        tag_ids: &[String],
    ) -> Result<(), String> {
        let current_folder: Option<String> = conn
            .query_row("SELECT folder_id FROM notes WHERE id=?", [note_id], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let mut current = conn
            .prepare("SELECT tag_id FROM note_tags WHERE note_id=? ORDER BY tag_id")
            .and_then(|mut s| {
                s.query_map([note_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|e| e.to_string())?;
        let mut wanted = tag_ids.to_vec();
        wanted.sort();
        wanted.dedup();
        current.sort();
        if &current_folder == folder_id && current == wanted {
            return Ok(());
        }
        // Keep unchanged AI tag associations intact; only explicitly added tags become manual.
        for id in current.iter().filter(|id| !wanted.contains(id)) {
            conn.execute(
                "DELETE FROM note_tags WHERE note_id=? AND tag_id=?",
                params![note_id, id],
            )
            .map_err(|e| e.to_string())?;
        }
        for id in wanted.iter().filter(|id| !current.contains(id)) {
            conn.execute("INSERT INTO note_tags(note_id,tag_id,source,created_at,updated_at) VALUES(?,?,'manual',?3,?3)",
                params![note_id,id,super::note::note_now()]).map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE notes SET folder_id=?2,updated_ms=MAX(?3,updated_ms+1) WHERE id=?1",
            params![note_id, folder_id, self.hlc_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
