use super::*;

impl DataStore {
    pub fn add_snippet(&self, name: &str, content: &str) -> Result<String, String> {
        // 校验片段标题：trim 后非空，最长 100 个字符（用 chars().count() 数字符数而非字节数，避免中文被误判）
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("片段标题不能为空".to_string());
        }
        if trimmed_name.chars().count() > 100 {
            return Err("片段标题最长 100 个字符".to_string());
        }
        // 校验片段内容长度：防止前端把整条剪贴板内容（可能几十 MB）当片段写入，
        // 导致 get_snippets 一次性把所有片段全文通过 IPC 返回造成 UI 永久冻结
        if content.chars().count() > 100_000 {
            return Err("片段内容过长，最多 100000 个字符".to_string());
        }
        let conn = self.lock_conn();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR REPLACE INTO snippets (id, name, content) VALUES (?1, ?2, ?3)",
            params![id, name, content],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn get_snippets(&self) -> Result<Vec<Snippet>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, content, tag, copy_count, last_used_at FROM snippets ORDER BY rowid DESC",
            )
            .map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], |row| {
                Ok(Snippet {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    content: row.get(2)?,
                    tag: row.get::<_, String>(3).unwrap_or_default(),
                    copy_count: row.get::<_, i64>(4).unwrap_or(0),
                    last_used_at: row.get::<_, Option<String>>(5).unwrap_or(None),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(items)
    }

    /// 记录片段被使用（复制）：累加 copy_count 并更新 last_used_at
    pub fn use_snippet(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "UPDATE snippets SET copy_count = copy_count + 1, last_used_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_snippet(
        &self,
        id: &str,
        name: &str,
        content: &str,
        tag: &str,
    ) -> Result<(), String> {
        // 校验片段标题：trim 后非空，最长 100 个字符
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("片段标题不能为空".to_string());
        }
        if trimmed_name.chars().count() > 100 {
            return Err("片段标题最长 100 个字符".to_string());
        }
        // 校验片段内容长度：同 add_snippet，防止超大内容写入导致 get_snippets IPC 返回卡死 UI
        if content.chars().count() > 100_000 {
            return Err("片段内容过长，最多 100000 个字符".to_string());
        }
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE snippets SET name = ?1, content = ?2, tag = ?3 WHERE id = ?4",
            params![name, content, tag, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
