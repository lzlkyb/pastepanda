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

/// `MAX(sort_order)` 查失败时的兜底序号。
///
/// 为什么不用 0：链按 `sort_order ASC` 列，给 0 会让新链直接跳到列表最前面
/// （“刚建的链跑到置顶”对用户是无法解释的）。取一个足够大、又不会把
/// `sort_order`（i32）顶溢出的常量，让它排到最后；链的数量不可能接近这个量级。
const SORT_ORDER_FALLBACK: i64 = 9999;

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

    /// 步骤 JSON **解析失败**的标记（读出时由后端置位）。
    ///
    /// 为什么需要它：以前解析失败直接 `unwrap_or_default()` 变成空 `Vec`，于是
    /// "步骤坏了"和"没有步骤"在前端看起来完全一样：链仍出现在列表里、运行时
    /// 什么都不做、也没任何报错；用户想修就打开再保存，又被 `steps.is_empty()`
    /// 拦住报"至少要有 1 个步骤"——这条链既不能用、也不能就地改好。
    ///
    /// `skip_deserializing`：这是后端单向告知前端的状态，不接受从 `chain_save`
    /// 传进来的值（否则前端可以自称"我坏了"）。
    #[serde(skip_deserializing)]
    pub steps_corrupted: bool,
    /// 解析失败时保留的原始 JSON（正常时为空字符串）。
    ///
    /// 留着是为了让用户（或排错的人）看得到原来到底配的是哪几步，能照着重建；
    /// 丢掉的话损坏就是不可逆的。里面只有变换 id / 风险标注 / 显示名，无内容文本。
    #[serde(skip_deserializing)]
    pub steps_raw: String,
}

fn steps_to_json(steps: &[ChainStepDef]) -> Result<String, String> {
    serde_json::to_string(steps).map_err(|e| format!("步骤序列化失败：{}", e))
}

/// 解析步骤 JSON。**失败与空数组必须能区分**，所以返回 Result 而不是
/// `unwrap_or_default()`：`ChainStepDef.transform_id` 是必需字段（没有
/// `#[serde(default)]`），只要一处不合法，`Vec<ChainStepDef>` 整体解析就失败，
/// 而以前这一失败会默默退成空链（见 `ChainDef::steps_corrupted`）。
///
/// 当前版本读写都用 camelCase、自洽，所以不是现网 bug；风险在于
/// `ChainStepDef` 未来任何一次字段调整，或有人手工改库。
fn steps_from_json(s: &str) -> Result<Vec<ChainStepDef>, serde_json::Error> {
    serde_json::from_str(s)
}

/// 把 SQLite 的 UNIQUE 约束报错翻成中文（重名的**兜底**路径）。
///
/// 为什么光靠重名守卫不够：守卫本身是一条 COUNT 查询，它也会失败（库被外部
/// 锁住、schema 异常），而“检查 → INSERT”之间本来就有 TOCTOU 窗口。让 INSERT
/// 的错误分支也能认出 UNIQUE，比只把守卫改牢靠——它兜住**所有**竞态路径，
/// 用户不会看到 `UNIQUE constraint failed: chain_defs.name` 这种英文原文。
pub(super) fn map_chain_save_err(e: rusqlite::Error, name: &str) -> String {
    let msg = e.to_string();
    if msg.contains("UNIQUE constraint failed") {
        format!("已经有一条叫“{}”的链了，换个名字吧", name)
    } else {
        format!("保存动作链失败：{}", msg)
    }
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
                let id: String = r.get(0)?;
                let raw: String = r.get(3)?;
                // 解析失败时：标出来 + 留下原文 + 记一条 warn，
                // 而不是默默变成空链（那会弄出一条既不能用、也不能修的僵尸链）。
                let (steps, corrupted) = match steps_from_json(&raw) {
                    Ok(v) => (v, false),
                    Err(e) => {
                        log::warn!("[Chains] 链 {} 的步骤 JSON 解析失败：{}；原文：{}", id, e, raw);
                        (Vec::new(), true)
                    }
                };
                Ok(ChainDef {
                    id,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    steps,
                    sort_order: r.get::<_, i64>(4)? as i32,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                    steps_corrupted: corrupted,
                    steps_raw: if corrupted { raw } else { String::new() },
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

        // 重名单独拦：UNIQUE 索引报错的话，用户看到的是 SQLite 的英文原文。
        // 查询本身失败时**不能当作"不重名"继续走**（以前是 `unwrap_or(0)`）：
        // 那等于把守卫绕掉，直接撞到 INSERT 的 UNIQUE 索引。
        // （INSERT 分支另有 map_chain_save_err 兜底竞态，两道防线都要有。）
        let dup: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chain_defs WHERE name = ?1 AND id <> ?2",
                params![name, chain.id],
                |r| r.get(0),
            )
            .map_err(|e| {
                log::warn!("[Chains] 重名检查查询失败：{}", e);
                "现在无法校验链名是否重复，请稍后重试".to_string()
            })?;
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
                .unwrap_or_else(|e| {
                    // 纯展示影响，不值得为它拒绝保存；但也不能默默给 0（会置顶）。
                    log::warn!("[Chains] 取 MAX(sort_order) 失败，新链排到最后：{}", e);
                    SORT_ORDER_FALLBACK
                });
            conn.execute(
                "INSERT INTO chain_defs
                    (id, name, description, steps, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![id, name, desc, steps, next, now],
            )
            .map_err(|e| map_chain_save_err(e, name))?;
            Ok(id)
        } else {
            let n = conn
                .execute(
                    "UPDATE chain_defs SET name = ?2, description = ?3, steps = ?4,
                        updated_at = ?5
                     WHERE id = ?1",
                    params![chain.id, name, desc, steps, now],
                )
                .map_err(|e| map_chain_save_err(e, name))?;
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
    ///
    /// ⚠ **全仓库无任何调用方**（定义 / 命令注册 / 测试 / API 导出共 6 处命中，
    /// 前端零引用）。也就是说链排序功能对用户并不存在，`chains()` 里的
    /// `ORDER BY sort_order` 实际永远等价于按创建时间排。
    ///
    /// 以后真要接 UI，**先解决这两个隐患**（现在因为没人调才不痛）：
    /// ① `ids` 里不存在的 id 只是 UPDATE 影响 0 行，静默忽略，调用方无法得知
    ///   自己传了脏数据；
    /// ② **没出现在 `ids` 里**的现存链会保留旧 `sort_order`，而这里新分配的是
    ///   `0..n-1`——两边必然撞号，排序结果不可预测（同号时靠 created_at 兼职二路）。
    ///   要么要求传全量 id（并校验），要么在同一事务里把未列出的链统一推到后面。
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
