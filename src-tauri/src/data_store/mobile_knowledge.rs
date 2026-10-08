//! Bounded phone projections. Full Markdown is fetched only when a reader opens a note.
use super::*;
use rusqlite::OptionalExtension;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MobileNoteMeta {
    pub common: bool,
    pub last_access_at: Option<String>,
    pub reading_position: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileNoteSummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub updated_at: String,
    pub folder_id: Option<String>,
    pub folder_name: Option<String>,
    pub tags: Vec<Tag>,
    #[serde(flatten)]
    pub meta: MobileNoteMeta,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct MobileKnowledgeOptions {
    pub query: String,
    pub folder_filter: String,
    pub tag_ids: Vec<String>,
    pub view: String,
    pub offset: u32,
    pub exact_title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MobileKnowledgePage {
    pub items: Vec<MobileNoteSummary>,
    pub has_more: bool,
}

impl DataStore {
    pub fn mobile_knowledge_list(
        &self,
        options: &MobileKnowledgeOptions,
    ) -> Result<MobileKnowledgePage, String> {
        let conn = self.lock_conn();
        let (mut from, mut values) = Self::note_view_from_where(
            &options.folder_filter,
            &options.tag_ids,
            &NoteViewOpts::default(),
        );
        from = from.replacen(
            " FROM notes",
            " FROM notes LEFT JOIN mobile_note_state AS mobile ON mobile.note_id = notes.id",
            1,
        );
        match options.view.as_str() {
            "common" => from.push_str(" AND mobile.common = 1"),
            "recent" if options.query.trim().is_empty() => {
                from.push_str(" AND mobile.last_access_at IS NOT NULL")
            }
            "recent" => (),
            "all" | "" => (),
            _ => return Err("未知的知识库视图".into()),
        }
        if let Some(title) = &options.exact_title {
            from.push_str(" AND notes.title = ?");
            values.push(Box::new(title.clone()));
        }
        let query = options.query.trim();
        if !query.is_empty() {
            if query.chars().any(char::is_alphanumeric) {
                // Reuse desktop bigram/pinyin prefix parsing and its maintained index.
                // An ordinary zero-hit result must not trigger a whole-body LIKE scan.
                from.push_str(
                    " AND notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)",
                );
                values.push(Box::new(super::note::to_match_expr(query)));
            } else {
                // FTS discards punctuation; a punctuation-only search remains literal.
                from.push_str(
                    " AND (notes.title LIKE ? ESCAPE '\\' OR notes.content LIKE ? ESCAPE '\\')",
                );
                let pattern = format!("%{}%", escape_like_pattern(query));
                values.push(Box::new(pattern.clone()));
                values.push(Box::new(pattern));
            }
        }
        let excerpt = if query.is_empty() {
            "substr(notes.content,1,160)"
        } else {
            // This SELECT placeholder comes before the shared WHERE placeholders.
            values.insert(0, Box::new(query.to_string()));
            "substr(notes.content,max(1,instr(lower(notes.content),lower(?))-48),160)"
        };
        let order = if options.view == "recent" && query.is_empty() {
            "mobile.last_access_at DESC"
        } else {
            "notes.updated_ms DESC"
        };
        let sql = format!(
            "SELECT notes.id, notes.title, {excerpt}, notes.updated_at, notes.folder_id,
             COALESCE(mobile.common,0), mobile.last_access_at, COALESCE(mobile.reading_position,0),
             (SELECT name FROM note_folders WHERE id=notes.folder_id)
             {from} ORDER BY {order}, notes.id DESC LIMIT 21 OFFSET ?"
        );
        values.push(Box::new(options.offset));
        let refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|p| p.as_ref()).collect();
        let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut items = statement
            .query_map(refs.as_slice(), |r| {
                Ok(MobileNoteSummary {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    excerpt: r.get(2)?,
                    updated_at: r.get(3)?,
                    folder_id: r.get(4)?,
                    folder_name: r.get(8)?,
                    tags: Vec::new(),
                    meta: MobileNoteMeta {
                        common: r.get(5)?,
                        last_access_at: r.get(6)?,
                        reading_position: r.get(7)?,
                    },
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let has_more = items.len() > 20;
        items.truncate(20);
        for item in &mut items {
            item.tags = Self::load_note_tags_on(&conn, &item.id);
        }
        Ok(MobileKnowledgePage { items, has_more })
    }

    fn mobile_note_exists_on(conn: &Connection, id: &str) -> Result<(), String> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE id=? AND deleted_at IS NULL)",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            Ok(())
        } else {
            Err("本机未找到这条笔记".into())
        }
    }

    fn mobile_meta_on(conn: &Connection, id: &str) -> Result<MobileNoteMeta, String> {
        Self::mobile_note_exists_on(conn, id)?;
        conn.query_row(
            "SELECT common,last_access_at,reading_position FROM mobile_note_state WHERE note_id=?",
            [id],
            |r| {
                Ok(MobileNoteMeta {
                    common: r.get(0)?,
                    last_access_at: r.get(1)?,
                    reading_position: r.get(2)?,
                })
            },
        )
        .optional()
        .map(|m| m.unwrap_or_default())
        .map_err(|e| e.to_string())
    }

    pub fn mobile_knowledge_meta(&self, id: &str) -> Result<MobileNoteMeta, String> {
        Self::mobile_meta_on(&self.lock_conn(), id)
    }

    pub fn mobile_knowledge_set_common(
        &self,
        id: &str,
        common: bool,
    ) -> Result<MobileNoteMeta, String> {
        let conn = self.lock_conn();
        Self::mobile_note_exists_on(&conn, id)?;
        conn.execute("INSERT INTO mobile_note_state(note_id,common) VALUES (?1,?2) ON CONFLICT(note_id) DO UPDATE SET common=excluded.common", params![id, common]).map_err(|e| e.to_string())?;
        Self::mobile_meta_on(&conn, id)
    }

    pub fn mobile_knowledge_visit(
        &self,
        id: &str,
        position: f64,
    ) -> Result<MobileNoteMeta, String> {
        if !position.is_finite() || !(0.0..=1.0).contains(&position) {
            return Err("阅读位置无效".into());
        }
        let conn = self.lock_conn();
        Self::mobile_note_exists_on(&conn, id)?;
        let now = chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        conn.execute("INSERT INTO mobile_note_state(note_id,last_access_at,reading_position) VALUES (?1,?2,?3) ON CONFLICT(note_id) DO UPDATE SET last_access_at=excluded.last_access_at,reading_position=excluded.reading_position", params![id, now, position]).map_err(|e| e.to_string())?;
        Self::mobile_meta_on(&conn, id)
    }
}
