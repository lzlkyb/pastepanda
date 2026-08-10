//! 用户自定义的动作链（X1 B2）。
//!
//! **为什么是独立表而不是 `config` 表**：理由同 `ai_custom_actions`——
//! `save_config()` 每次调用都会跑 `backup_config()` 全量备份并保留 10 份，
//! 编辑链是高频操作，进去就会把那 10 个备份位全冲成无意义的相邻快照。
//!
//! **分层**：这里只管存取与结构性约束（非空、长度、步骤数、步骤非空）。
//! 步骤引用的变换是否存在，由前端（变换注册表）在保存前校验——后端不认识前端注册表。

use super::*;

/// 名称上限（字符）。它要出现在运行器的链选择卡片上。
pub const MAX_CHAIN_NAME_CHARS: usize = 24;
/// 描述上限（字符）。
pub const MAX_CHAIN_DESC_CHARS: usize = 60;
/// 步骤数上限。X1 规划反证：链条超过 5 步就难以理解和排错，给 8 是留余量。
pub const MAX_CHAIN_STEPS: usize = 8;

/// 链中的一步：引用一个已注册变换。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainStepDef {
    pub transform_id: String,
    /// 风险标注：local / network / destructive。存下来供 UI 显示徽标。
    #[serde(default = "default_risk")]
    pub risk: String,
    /// 覆盖显示名（可选；缺省用变换自身的 label）
    #[serde(default)]
    pub label: String,
}

fn default_risk() -> String {
    "local".to_string()
}

/// 一条用户自定义链。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainDef {
    /// 空字符串表示新建（由后端生成 uuid）。
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 步骤 JSON 数组。存 JSON 而非关联表：步骤是“有序快照”，从不单独查询。
    #[serde(default)]
    pub steps: Vec<ChainStepDef>,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn steps_to_json(steps: &[ChainStepDef]) -> Result<String, String> {
    serde_json::to_string(steps).map_err(|e| format!("步骤序列化失败：{}", e))
}

fn steps_from_json(s: &str) -> Vec<ChainStepDef> {
    serde_json::from_str(s).unwrap_or_default()
}

impl DataStore {
    /// 全部自定义链，按用户排序。
    pub fn chains(&self) -> Result<Vec<ChainDef>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, steps, sort_order, created_at, updated_at
                 FROM chain_defs ORDER BY sort_order ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ChainDef {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    steps: steps_from_json(&r.get::<_, String>(3)?),
                    sort_order: r.get::<_, i64>(4)? as i32,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 新建或更新。`id` 为空则新建，返回最终的 id。
    pub fn chain_save(&self, chain: &ChainDef) -> Result<String, String> {
        let name = chain.name.trim();
        if name.is_empty() {
            return Err("链名称不能为空".to_string());
        }
        if name.chars().count() > MAX_CHAIN_NAME_CHARS {
            return Err(format!("名称最长 {} 个字符", MAX_CHAIN_NAME_CHARS));
        }
        let desc = chain.description.trim();
        if desc.chars().count() > MAX_CHAIN_DESC_CHARS {
            return Err(format!("描述最长 {} 个字符", MAX_CHAIN_DESC_CHARS));
        }
        if chain.steps.is_empty() {
            return Err("至少要有 1 个步骤".to_string());
        }
        if chain.steps.len() > MAX_CHAIN_STEPS {
            return Err(format!("步骤最多 {} 个（步骤太多难以排错）", MAX_CHAIN_STEPS));
        }
        for (i, step) in chain.steps.iter().enumerate() {
            if step.transform_id.trim().is_empty() {
                return Err(format!("第 {} 步没有选择变换", i + 1));
            }
            if !matches!(step.risk.as_str(), "local" | "network" | "destructive") {
                return Err(format!("第 {} 步的风险标注不合法", i + 1));
            }
        }

        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let steps = steps_to_json(&chain.steps)?;

        // 重名单独拦：UNIQUE 索引报错的话，用户看到的是 SQLite 的英文原文
        let dup: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chain_defs WHERE name = ?1 AND id <> ?2",
                params![name, chain.id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if dup > 0 {
            return Err(format!("已经有一条叫“{}”的链了，换个名字吧", name));
        }

        if chain.id.trim().is_empty() {
            let id = uuid::Uuid::new_v4().to_string();
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chain_defs",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            conn.execute(
                "INSERT INTO chain_defs
                    (id, name, description, steps, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![id, name, desc, steps, next, now],
            )
            .map_err(|e| format!("保存动作链失败：{}", e))?;
            Ok(id)
        } else {
            let n = conn
                .execute(
                    "UPDATE chain_defs SET name = ?2, description = ?3, steps = ?4,
                        updated_at = ?5
                     WHERE id = ?1",
                    params![chain.id, name, desc, steps, now],
                )
                .map_err(|e| format!("保存动作链失败：{}", e))?;
            if n == 0 {
                return Err("这条链已经不存在了，可能在另一处被删掉".to_string());
            }
            Ok(chain.id.clone())
        }
    }

    pub fn chain_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM chain_defs WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 按给定顺序重排。传进来的 id 列表就是新顺序。
    pub fn chains_reorder(&self, ids: &[String]) -> Result<(), String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE chain_defs SET sort_order = ?2 WHERE id = ?1",
                params![id, i as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
