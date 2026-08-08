//! 用户自定义的 AI 动作。
//!
//! **为什么是独立表而不是 `config` 表**：`save_config()` 每次调用都会跑一遍
//! `backup_config()`，把全量配置写一份到 `config_backups/` 并保留 10 份。
//! 编辑动作是高频操作，进去就会把那 10 个备份位全冲成无意义的相邻快照。
//!
//! **分层**：这里只管存取与结构性约束（非空、长度、重名）。
//! “模板里必须有 {{内容}}”、“不能与内置动作重名”这两条属于 AI 层的知识，
//! 放在命令层校验，不把 `crate::ai` 拖进数据层。

use super::*;

/// 名称上限（字符）。不能太长——它要摆在变换中心的卡片上。
pub const MAX_ACTION_NAME_CHARS: usize = 24;
/// 描述上限（字符）。
pub const MAX_ACTION_DESC_CHARS: usize = 60;

/// 一个用户自定义的 AI 动作。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAction {
    /// 空字符串表示新建（由后端生成 uuid）。
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    /// 提示词模板，必含内容占位符（在命令层校验）。
    pub template: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// 适用的内容类型；空 = 不限。
    #[serde(default)]
    pub content_types: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_icon() -> String {
    "sparkles".to_string()
}
fn default_max_tokens() -> u32 {
    2000
}
fn default_true() -> bool {
    true
}

/// 内容类型在库里存成逗号分隔的一行。
///
/// 不开关联表：取值只有十来个、从不单独查询，一张表能解决的事不必拆成两张。
fn join_types(v: &[String]) -> String {
    v.iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

fn split_types(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

impl DataStore {
    /// 全部自定义动作，按用户排序。含已停用的（界面要展示）。
    pub fn ai_custom_actions(&self) -> Result<Vec<CustomAction>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, icon, template, max_tokens,
                        content_types, enabled, sort_order, created_at, updated_at
                 FROM ai_custom_actions ORDER BY sort_order ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CustomAction {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    icon: r.get(3)?,
                    template: r.get(4)?,
                    max_tokens: r.get::<_, i64>(5)? as u32,
                    content_types: split_types(&r.get::<_, String>(6)?),
                    enabled: r.get::<_, i64>(7)? != 0,
                    sort_order: r.get::<_, i64>(8)? as i32,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 按 id 取一个。调用时要拿模板，走它。
    pub fn ai_custom_action(&self, id: &str) -> Result<Option<CustomAction>, String> {
        Ok(self.ai_custom_actions()?.into_iter().find(|a| a.id == id))
    }

    /// 新建或更新。`id` 为空则新建，返回最终的 id。
    ///
    /// 只做结构性校验；模板内容的校验在命令层（见模块头部说明）。
    pub fn ai_custom_action_save(&self, action: &CustomAction) -> Result<String, String> {
        let name = action.name.trim();
        if name.is_empty() {
            return Err("动作名称不能为空".to_string());
        }
        if name.chars().count() > MAX_ACTION_NAME_CHARS {
            return Err(format!("名称最长 {} 个字符", MAX_ACTION_NAME_CHARS));
        }
        let desc = action.description.trim();
        if desc.chars().count() > MAX_ACTION_DESC_CHARS {
            return Err(format!("描述最长 {} 个字符", MAX_ACTION_DESC_CHARS));
        }
        // 太小会把回答截断，太大只是白花钱
        let max_tokens = action.max_tokens.clamp(50, 4000);

        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let types = join_types(&action.content_types);

        // 重名单独拦：靠 UNIQUE 索引报错的话，用户看到的是 SQLite 的英文原文
        let dup: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_custom_actions WHERE name = ?1 AND id <> ?2",
                params![name, action.id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if dup > 0 {
            return Err(format!("已经有一个叫“{}”的动作了，换个名字吧", name));
        }

        if action.id.trim().is_empty() {
            let id = uuid::Uuid::new_v4().to_string();
            // 新建的排在最后
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ai_custom_actions",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            conn.execute(
                "INSERT INTO ai_custom_actions
                    (id, name, description, icon, template, max_tokens,
                     content_types, enabled, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    id,
                    name,
                    desc,
                    action.icon.trim(),
                    action.template,
                    max_tokens,
                    types,
                    action.enabled as i32,
                    next,
                    now,
                ],
            )
            .map_err(|e| format!("保存自定义动作失败：{}", e))?;
            Ok(id)
        } else {
            let n = conn
                .execute(
                    "UPDATE ai_custom_actions SET name = ?2, description = ?3, icon = ?4,
                        template = ?5, max_tokens = ?6, content_types = ?7, enabled = ?8,
                        updated_at = ?9
                     WHERE id = ?1",
                    params![
                        action.id,
                        name,
                        desc,
                        action.icon.trim(),
                        action.template,
                        max_tokens,
                        types,
                        action.enabled as i32,
                        now,
                    ],
                )
                .map_err(|e| format!("保存自定义动作失败：{}", e))?;
            if n == 0 {
                return Err("这个动作已经不存在了，可能在另一处被删掉".to_string());
            }
            Ok(action.id.clone())
        }
    }

    pub fn ai_custom_action_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM ai_custom_actions WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 按给定顺序重排。传进来的 id 列表就是新顺序。
    pub fn ai_custom_actions_reorder(&self, ids: &[String]) -> Result<(), String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE ai_custom_actions SET sort_order = ?2 WHERE id = ?1",
                params![id, i as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
