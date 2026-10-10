//! Article captures have their own durable queue; they never occupy the note-editor draft slot.
use super::*;
use rusqlite::OptionalExtension;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex, MutexGuard},
};

static IMAGE_PINS: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(crate) struct ArticleImagePin(String);
pub(crate) fn pin_article_image(filename: &str) -> ArticleImagePin {
    *article_image_pins().entry(filename.into()).or_default() += 1;
    ArticleImagePin(filename.into())
}
pub(super) fn article_image_pins() -> MutexGuard<'static, HashMap<String, usize>> {
    IMAGE_PINS.lock().unwrap_or_else(|e| e.into_inner())
}
impl Drop for ArticleImagePin {
    fn drop(&mut self) {
        let mut pins = article_image_pins();
        if let Some(count) = pins.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                pins.remove(&self.0);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileArticleImage {
    pub url: String,
    pub local: Option<String>,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileArticle {
    pub id: String,
    pub revision: u32,
    pub url: String,
    pub title: String,
    pub author: String,
    pub html: String,
    pub body: String,
    pub remarks: String,
    pub folder_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub images: Vec<MobileArticleImage>,
    pub error: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub note_id: Option<String>,
    pub duplicate_note_id: Option<String>,
    pub saved_link_only: bool,
    pub baseline_title: String,
    pub baseline_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileArticleFields {
    pub revision: u32,
    pub title: String,
    pub body: String,
    pub remarks: String,
    pub folder_id: Option<String>,
    pub tag_ids: Vec<String>,
}

pub(super) fn init_mobile_article_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS mobile_article_tasks (
        id TEXT PRIMARY KEY, note_id TEXT, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS mobile_article_note ON mobile_article_tasks(note_id);
        CREATE TABLE IF NOT EXISTS mobile_article_sources (
        url_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES mobile_article_tasks(id));
        CREATE TABLE IF NOT EXISTS mobile_article_assets (
        task_id TEXT NOT NULL REFERENCES mobile_article_tasks(id) ON DELETE CASCADE,
        filename TEXT NOT NULL, PRIMARY KEY(task_id,filename));
        CREATE INDEX IF NOT EXISTS mobile_article_asset_filename ON mobile_article_assets(filename);")
}

/// Preserve access/identity query parameters; only fragments and query ordering are irrelevant.
pub(crate) fn article_url_key(input: &str) -> Result<String, String> {
    let mut url = url::Url::parse(input.trim()).map_err(|_| "请粘贴完整文章链接")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || input.len() > 2048
    {
        return Err("只支持公开的 http/https 文章链接".into());
    }
    url.set_fragment(None);
    let mut query: Vec<_> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    query.sort();
    if !query.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(query);
    }
    Ok(url.to_string())
}

fn task_on(conn: &Connection, id: &str) -> Result<MobileArticle, String> {
    let payload: String = conn
        .query_row(
            "SELECT payload FROM mobile_article_tasks WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "这条待收集文章已不可用")?;
    serde_json::from_str(&payload).map_err(|_| "文章收集记录无法读取".into())
}
fn write_on(conn: &Connection, task: &MobileArticle) -> Result<(), String> {
    let payload = serde_json::to_string(task).map_err(|e| e.to_string())?;
    // A savepoint works inside note transactions as well as standalone draft writes.
    // The indexed ownership rows must commit with the task to protect shared image files.
    conn.execute_batch("SAVEPOINT article_write")
        .map_err(|e| e.to_string())?;
    let result = (|| -> rusqlite::Result<()> {
        conn.execute("INSERT INTO mobile_article_tasks(id,note_id,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,note_id=excluded.note_id",params![task.id,task.note_id,payload])?;
        conn.execute(
            "DELETE FROM mobile_article_assets WHERE task_id=?",
            [&task.id],
        )?;
        for image in &task.images {
            if let Some(name) = image
                .local
                .as_deref()
                .and_then(|v| v.strip_prefix("pp-asset:"))
            {
                conn.execute(
                    "INSERT OR IGNORE INTO mobile_article_assets(task_id,filename) VALUES (?,?)",
                    params![task.id, name],
                )?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("RELEASE article_write")
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO article_write; RELEASE article_write");
            Err(e.to_string())
        }
    }
}
fn note_text_on(conn: &Connection, id: &str) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT title,content FROM notes WHERE id=? AND deleted_at IS NULL",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}
fn article_content(task: &MobileArticle, link_only: bool) -> String {
    let mut content = format!(
        "> 来源：{}\n> {}",
        task.author.replace(['\r', '\n'], " "),
        task.url
    );
    if !link_only {
        content.push_str(&format!("\n\n{}", task.body));
    } else {
        content.push_str("\n\n仅保存了来源链接，正文尚未保存在手机。");
    }
    if !task.remarks.trim().is_empty() {
        content.push_str(&format!("\n\n## 我的备注\n\n{}", task.remarks));
    }
    content
}

impl DataStore {
    pub fn mobile_article_discard(&self, id: &str, revision: u32) -> Result<(), String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM mobile_article_tasks WHERE id=?)", [id], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        // Deletion may have committed before an IPC reply was lost. An exact-id
        // retry acknowledges that result without touching a replacement task.
        if !exists { return Ok(()); }
        let task = task_on(&tx, id)?;
        // A lost save receipt must never turn discard into deletion of a saved
        // article's metadata. The original note/share are outside this transaction.
        if task.note_id.is_some() || task.duplicate_note_id.is_some() {
            return Err("这篇文章已经保存，请保留原笔记并退出".into());
        }
        if task.revision != revision {
            return Err("文章收集已更新，请核对后再次确认放弃".into());
        }
        tx.execute("DELETE FROM mobile_article_assets WHERE task_id=?", [id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM mobile_article_sources WHERE task_id=?", [id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM mobile_article_tasks WHERE id=?", [id])
            .map_err(|e| e.to_string())?;
        // Delayed fetches check task_on before writing; removing identity here
        // prevents their result from recreating a user-discarded queue entry.
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn mobile_article_get(&self, id: &str) -> Result<MobileArticle, String> {
        task_on(&self.lock_conn(), id)
    }
    pub fn mobile_article_for_note(&self, id: &str) -> Result<Option<MobileArticle>, String> {
        let conn = self.lock_conn();
        let payload = conn
            .query_row(
                "SELECT payload FROM mobile_article_tasks WHERE note_id=? LIMIT 1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        payload
            .map(|p| serde_json::from_str(&p).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn mobile_article_pending(&self) -> Result<Vec<MobileArticle>, String> {
        let conn = self.lock_conn();
        let rows=conn.prepare("SELECT payload FROM mobile_article_tasks WHERE note_id IS NULL AND json_extract(payload,'$.duplicate_note_id') IS NULL ORDER BY rowid DESC LIMIT 20").map_err(|e|e.to_string())?.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let mut tasks = Vec::new();
        for row in rows {
            let task: MobileArticle = serde_json::from_str(&row).map_err(|e| e.to_string())?;
            if task.note_id.is_none() && task.duplicate_note_id.is_none() {
                tasks.push(task);
            }
        }
        Ok(tasks)
    }
    pub fn mobile_article_begin(&self, url: &str) -> Result<MobileArticle, String> {
        let key = article_url_key(url)?;
        let conn = self.lock_conn();
        if let Some(id) = conn
            .query_row(
                "SELECT task_id FROM mobile_article_sources WHERE url_key=?",
                [&key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return task_on(&conn, &id);
        }
        let count:i64=conn.query_row("SELECT COUNT(*) FROM mobile_article_tasks WHERE json_extract(payload,'$.note_id') IS NULL AND json_extract(payload,'$.duplicate_note_id') IS NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if count >= 20 {
            return Err("已有20条待收集文章，请先保存已有内容".into());
        }
        let task = MobileArticle {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            url: url.trim().into(),
            title: String::new(),
            author: String::new(),
            html: String::new(),
            body: String::new(),
            remarks: String::new(),
            folder_id: None,
            tag_ids: Vec::new(),
            images: Vec::new(),
            error: String::new(),
            source_ids: Vec::new(),
            note_id: None,
            duplicate_note_id: None,
            saved_link_only: false,
            baseline_title: String::new(),
            baseline_content: String::new(),
        };
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        write_on(&tx, &task)?;
        tx.execute(
            "INSERT INTO mobile_article_sources(url_key,task_id) VALUES (?,?)",
            params![key, task.id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(task)
    }
    pub fn mobile_article_put(
        &self,
        id: &str,
        fields: &MobileArticleFields,
    ) -> Result<MobileArticle, String> {
        if fields.title.len() > 2000
            || fields.body.len() > 1024 * 1024
            || fields.remarks.len() > 200_000
            || fields.tag_ids.len() > 100
        {
            return Err("文章或备注过长，请缩短后重试".into());
        }
        let conn = self.lock_conn();
        let mut task = task_on(&conn, id)?;
        if fields.revision != task.revision {
            return Err("文章收集已更新，请重新读取后重试".into());
        }
        task.title = fields.title.clone();
        task.body = fields.body.clone();
        task.remarks = fields.remarks.clone();
        task.folder_id = fields.folder_id.clone();
        task.tag_ids = fields.tag_ids.clone();
        if !task.body.is_empty() {
            task.html.clear();
        }
        task.revision += 1;
        write_on(&conn, &task)?;
        Ok(task)
    }
    pub fn mobile_article_bind_source(
        &self,
        id: &str,
        source: &str,
    ) -> Result<MobileArticle, String> {
        if source.is_empty() || source.len() > 200 {
            return Err("分享身份无效".into());
        }
        let conn = self.lock_conn();
        let mut task = task_on(&conn, id)?;
        if !task.source_ids.iter().any(|v| v == source) {
            if task.source_ids.len() >= 20 {
                return Err("这篇文章待清理的分享过多，请先保存已有收集".into());
            }
            task.source_ids.push(source.into());
            task.revision += 1;
            write_on(&conn, &task)?;
        }
        Ok(task)
    }
    pub fn mobile_article_ack_sources(
        &self,
        id: &str,
        sources: &[String],
    ) -> Result<MobileArticle, String> {
        let conn = self.lock_conn();
        let mut task = task_on(&conn, id)?;
        task.source_ids.retain(|v| !sources.contains(v));
        task.revision += 1;
        write_on(&conn, &task)?;
        Ok(task)
    }
    /// A reply from an earlier fetch cannot replace fields saved by a later interaction.
    pub fn mobile_article_fetched(
        &self,
        expected: &MobileArticle,
        mut fetched: MobileArticle,
    ) -> Result<MobileArticle, String> {
        let conn = self.lock_conn();
        let current = task_on(&conn, &expected.id)?;
        if current.revision != expected.revision {
            return Err("文章收集已更新，已保留当前内容".into());
        }
        let key = article_url_key(&fetched.url)?;
        let other = conn
            .query_row(
                "SELECT task_id FROM mobile_article_sources WHERE url_key=?",
                [&key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(other) = other.filter(|v| v != &fetched.id) {
            let old = task_on(&conn, &other)?;
            if let Some(note) = old
                .note_id
                .filter(|id| note_text_on(&conn, id).ok().flatten().is_some())
            {
                fetched.duplicate_note_id = Some(note);
            }
        } else {
            conn.execute(
                "INSERT OR IGNORE INTO mobile_article_sources(url_key,task_id) VALUES (?,?)",
                params![key, fetched.id],
            )
            .map_err(|e| e.to_string())?;
        }
        fetched.revision = current.revision + 1;
        write_on(&conn, &fetched)?;
        Ok(fetched)
    }
    pub fn mobile_article_save(
        &self,
        id: &str,
        revision: u32,
        link_only: bool,
    ) -> Result<Note, String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut task = task_on(&tx, id)?;
        if task.duplicate_note_id.is_some() {
            return Err("这篇文章已收藏，请查看已有笔记".into());
        }
        // Redirects may meet while both captures are still pending. Re-check and claim
        // the final URL in the same transaction that creates the note.
        let key = article_url_key(&task.url)?;
        if task.note_id.is_none() {
            let owner = tx
                .query_row(
                    "SELECT task_id FROM mobile_article_sources WHERE url_key=?",
                    [&key],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(owner) = owner.filter(|v| v != id) {
                let other = task_on(&tx, &owner)?;
                if let Some(note) = other
                    .note_id
                    .filter(|n| note_text_on(&tx, n).ok().flatten().is_some())
                {
                    task.duplicate_note_id = Some(note);
                    task.revision += 1;
                    write_on(&tx, &task)?;
                    tx.commit().map_err(|e| e.to_string())?;
                    return Err("这篇文章已收藏，请查看已有笔记".into());
                }
            }
        }
        let content = article_content(&task, link_only);
        let title = if task.title.trim().is_empty() {
            task.url.clone()
        } else {
            task.title.trim().into()
        };
        if let Some(note_id) = &task.note_id {
            let Some((current_title, current_content)) = note_text_on(&tx, note_id)? else {
                return Err("原笔记已删除，请先在回收站核对".into());
            };
            // Idempotent retry also covers a successfully committed reply that never reached UI.
            if !task.saved_link_only
                || (task.baseline_title == title
                    && task.baseline_content == content
                    && current_title == title
                    && current_content == content)
            {
                let saved_id = note_id.clone();
                drop(tx);
                drop(conn);
                return self
                    .note_get(&saved_id)?
                    .ok_or_else(|| "原笔记已不可用".into());
            }
            if current_title != task.baseline_title || current_content != task.baseline_content {
                return Err("原笔记已被修改，未覆盖正文或备注。请查看已有笔记".into());
            }
        }
        if task.revision != revision {
            return Err("收集内容已更新，请保存最新内容".into());
        }
        if !link_only && task.body.trim().is_empty() {
            return Err("尚未取得可读正文，可以仅存链接".into());
        }
        Self::mobile_knowledge_validate_category_on(&tx, &task.folder_id, &task.tag_ids)?;
        let note_id = match &task.note_id {
            Some(note_id) => {
                self.note_update_on(&tx, note_id, &title, &content, "")?;
                note_id.clone()
            }
            None => {
                self.note_insert_on(&tx, None, None, &title, &content, "", false)?
                    .id
            }
        };
        self.mobile_knowledge_category_on(&tx, &note_id, &task.folder_id, &task.tag_ids)?;
        task.note_id = Some(note_id.clone());
        task.saved_link_only = link_only;
        task.baseline_title = title;
        task.baseline_content = content;
        task.html.clear();
        task.revision += 1;
        write_on(&tx, &task)?;
        tx.execute("INSERT INTO mobile_article_sources(url_key,task_id) VALUES (?,?) ON CONFLICT(url_key) DO UPDATE SET task_id=excluded.task_id",params![key,task.id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        self.note_get(&note_id)?
            .ok_or_else(|| "保存结果暂时无法读取，请重试核对".into())
    }
    /// Only replace the exact image token; current user text/classification stays untouched.
    pub fn mobile_article_image_saved(
        &self,
        id: &str,
        index: usize,
        url: &str,
        local: &str,
        bytes: usize,
    ) -> Result<MobileArticle, String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut task = task_on(&tx, id)?;
        let image = task.images.get(index).ok_or("图片已经变化")?;
        if image.url != url {
            return Err("图片已经变化，未修改另一张图片".into());
        }
        let old = image.local.as_deref().unwrap_or(url);
        let pattern = regex::Regex::new(&format!(
            r"(!\[[^\]\n]*\]\()<?{escaped}>?\)",
            escaped = regex::escape(old)
        ))
        .map_err(|e| e.to_string())?;
        let replace = |content: &str| {
            pattern
                .replace_all(content, format!("${{1}}{})", local))
                .into_owned()
        };
        task.body = replace(&task.body);
        if let Some(note_id) = &task.note_id {
            let (title, content) = note_text_on(&tx, note_id)?.ok_or("原笔记已删除")?;
            if !pattern.is_match(&content) {
                return Err("这张图片已从笔记中移除，没有修改正文".into());
            }
            let updated = replace(&content);
            self.note_update_on(&tx, note_id, &title, &updated, "")?;
            task.baseline_title = title;
            task.baseline_content = updated;
        }
        task.images[index].local = Some(local.into());
        task.images[index].bytes = bytes;
        task.revision += 1;
        write_on(&tx, &task)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(task)
    }
}
