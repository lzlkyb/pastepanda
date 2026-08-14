//! 粘贴栈的常用模板（P4）。
//!
//! **为什么是独立表**：理由同 `chains.rs`——`snippets`/`chain_defs` 都是独立表而非塞进
//! `config`，模板的存/删/载入是较高频操作，不该拖累 `config` 表的整体备份机制。
//!
//! **为什么存内容快照而不是引用 history_id**：设计稿明确过——保存时存的是独立拷贝，
//! 这样原 history 条目之后被自动清理策略删掉，模板依然完整可用（类似 `snippets` 表
//! 直接存 content，而不是引用 history）。

use super::*;

/// 模板名称上限（字符）。
pub const MAX_STACK_TEMPLATE_NAME_CHARS: usize = 30;
/// 模板条目数上限，与栈本身的 50 条上限对齐（模板不该比栈能装的还多）。
pub const MAX_STACK_TEMPLATE_ITEMS: usize = 50;

/// 模板里的一条内容快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackTemplateItem {
    pub item_type: String,
    pub text: String,
    #[serde(default)]
    pub content: String,
}

/// 一份常用模板。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackTemplate {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub items: Vec<StackTemplateItem>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub used_at: Option<String>,
}

fn items_to_json(items: &[StackTemplateItem]) -> Result<String, String> {
    serde_json::to_string(items).map_err(|e| format!("模板条目序列化失败：{}", e))
}

fn items_from_json(s: &str) -> Vec<StackTemplateItem> {
    // 解析失败只降级为空列表并记警告——模板不像动作链那样"步骤缺一步就跑不动"，
    // 展示层直接看到条目数为 0，不需要 chains.rs 那套 corrupted 标记的复杂度。
    serde_json::from_str(s).unwrap_or_else(|e| {
        log::warn!("[StackTemplate] 模板条目 JSON 解析失败：{}", e);
        Vec::new()
    })
}

impl DataStore {
    /// 全部模板，最近用过的排前面；从未用过的按创建时间新→旧排在后面。
    pub fn stack_templates(&self) -> Result<Vec<StackTemplate>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, items, created_at, used_at FROM stack_templates
                 ORDER BY used_at IS NULL, used_at DESC, created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let items_raw: String = r.get(2)?;
                Ok(StackTemplate {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    items: items_from_json(&items_raw),
                    created_at: r.get(3)?,
                    used_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 新建模板（模板只新建不改，重名走 UNIQUE 约束报错）。
    pub fn stack_template_save(
        &self,
        name: &str,
        items: &[StackTemplateItem],
    ) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("模板名称不能为空".to_string());
        }
        if name.chars().count() > MAX_STACK_TEMPLATE_NAME_CHARS {
            return Err(format!("名称最长 {} 个字符", MAX_STACK_TEMPLATE_NAME_CHARS));
        }
        if items.is_empty() {
            return Err("至少要有 1 条内容才能存为模板".to_string());
        }
        if items.len() > MAX_STACK_TEMPLATE_ITEMS {
            return Err(format!("模板最多 {} 条内容", MAX_STACK_TEMPLATE_ITEMS));
        }

        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let items_json = items_to_json(items)?;
        let id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO stack_templates (id, name, items, created_at, used_at)
             VALUES (?1, ?2, ?3, ?4, NULL)",
            params![id, name, items_json, now],
        )
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("UNIQUE constraint failed") {
                format!("已经有一个叫“{}”的模板了，换个名字吧", name)
            } else {
                format!("保存模板失败：{}", msg)
            }
        })?;
        Ok(id)
    }

    pub fn stack_template_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM stack_templates WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 载入模板时调用：更新 used_at，供列表显示"X 天前用过"。
    pub fn stack_template_touch(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "UPDATE stack_templates SET used_at = ?2 WHERE id = ?1",
            params![id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
