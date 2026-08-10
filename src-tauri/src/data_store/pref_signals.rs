//! 偏好信号（pref_signals）—— 偏好自荐的服务端。
//!
//! ## 它补的是哪一跳
//!
//! `ai_feedback` 能告诉你“这个动作的输出被改了 8/12 次”，但**改成了什么一无所知**——
//! 结果哈希只能去重，反推不出风格方向。所以光有 `ai_feedback`，系统只能提醒用户
//! “去手动写条偏好”，它自己什么也没学到。
//!
//! 这张表记的是**方向**：前端 `lib/prefLearn.ts` 在本地比对（原文, 改后），只产出
//! 一组**枚举特征标签**（如 `shorter` / `dropped_greeting`），这里只负责计数。
//! 攒够 {@link PREF_SIGNAL_MIN_COUNT} 次同方向 → 建议写成 `action_prefs`，
//! 之后由 `ai_run` 拼进 system prompt——闭环到此才真正合上。
//!
//! ## 为什么后端还要再校验一次白名单
//!
//! “只落标签不落内容”如果只靠前端自觉，那这条红线等于没有。
//! 命令层是唯一的写入闸门：任何不在 [`PREF_FEATURES`] 里的字符串**一律静默丢弃**。
//! 即使前端有 bug 把正文传上来，也落不进这张表。
//!
//! ## 与红线的关系
//!
//! - 红线①（学习只影响排序，永不自动执行）：本表只能导出一条**待确认的建议**，
//!   写不写进 `action_prefs` 由用户点；
//! - 红线②（可见可删 + 自动过期）：有 [`Self::pref_signal_clear`] 一键清空，
//!   且启动时跟 `ai_feedback` 同节奏过期。“你总把输出改短”本身就是习惯画像，
//!   不自动过期就等于永久留存。

use super::*;

/// 特征白名单。**必须与前端 `PrefFeature` 联合类型逐字一致。**
///
/// 写死而不做成配置：这是“用户这么改意味着什么”的产品判断，随版本更新。
pub const PREF_FEATURES: &[&str] = &[
    "shorter",
    "longer",
    "dropped_preamble",
    "dropped_greeting",
    "dropped_closing",
    "dropped_markdown",
    "formal_to_casual",
    "casual_to_formal",
];

/// 保留天数。与 `ai_feedback` / `action_events` 一致。
pub const PREF_SIGNAL_RETAIN_DAYS: u32 = 90;

/// 同一 (动作, 特征) 攒够几次才提议。**与前端 `PREF_SIGNAL_MIN_COUNT` 保持一致。**
pub const PREF_SIGNAL_MIN_COUNT: u32 = 3;

/// 一条“可以提议了”的信号。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefSignalTop {
    pub action_id: String,
    pub feature: String,
    pub count: u32,
}

impl DataStore {
    /// 记一批特征信号。
    ///
    /// **非法特征静默丢弃**（不报错）：这是记账路径，不能反过来卡住用户复制产物。
    /// 同理写不进去也不阻塞（跟 `ai_feedback_add` 一致）。
    pub fn pref_signal_add(&self, action_id: &str, features: &[String]) {
        let action_id = action_id.trim();
        if action_id.is_empty() || features.is_empty() {
            return;
        }
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        for f in features {
            let f = f.trim();
            // 白名单是唯一闸门——前端即使把正文传上来也落不进表
            if !PREF_FEATURES.contains(&f) {
                continue;
            }
            let _ = conn.execute(
                "INSERT INTO pref_signals (created_at, action_id, feature) VALUES (?1, ?2, ?3)",
                params![now, action_id, f],
            );
        }
    }

    /// 某动作上最强的一条信号（达到阈值、且未被“已处理”标记）。
    ///
    /// 只返回 top-1：同红线②的主动建议约束“只给 top-1，不给列表”——
    /// 给列表说明自己也不确定，那就不该主动提。
    pub fn pref_signal_top(&self, action_id: &str) -> Result<Option<PrefSignalTop>, String> {
        let conn = self.lock_conn();
        let row = conn
            .query_row(
                "SELECT s.feature, COUNT(*) AS n
                 FROM pref_signals s
                 WHERE s.action_id = ?1
                   AND NOT EXISTS (
                       SELECT 1 FROM pref_signal_done d
                       WHERE d.action_id = s.action_id AND d.feature = s.feature
                   )
                 GROUP BY s.feature
                 HAVING n >= ?2
                 ORDER BY n DESC, s.feature ASC
                 LIMIT 1",
                params![action_id.trim(), PREF_SIGNAL_MIN_COUNT],
                |r| {
                    Ok(PrefSignalTop {
                        action_id: action_id.trim().to_string(),
                        feature: r.get(0)?,
                        count: r.get::<_, i64>(1)? as u32,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    /// 标记一条 (动作, 特征) 已处理——接受与否决走同一条路径。
    ///
    /// 为何不分“接受过”和“拒绝过”：两者对“还要不要再问”的答案完全相同（都是不问）。
    /// 接受了就已经写进 `action_prefs`，再提就是重复；否决了更不能再提。
    /// 多一个状态字段只会多一堆分支，没有任何行为差异。
    pub fn pref_signal_done(&self, action_id: &str, feature: &str) -> Result<(), String> {
        let action_id = action_id.trim();
        let feature = feature.trim();
        if action_id.is_empty() || !PREF_FEATURES.contains(&feature) {
            return Err("无效的动作或特征".to_string());
        }
        let conn = self.lock_conn();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        conn.execute(
            "INSERT INTO pref_signal_done (action_id, feature, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(action_id, feature) DO UPDATE SET created_at = ?3",
            params![action_id, feature, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 清过期信号（启动时跑一次）。
    ///
    /// “已处理”标记**不跟着过期**：否决是用户的明确表态，不能因为 90 天没动
    /// 就把它忘掉然后重新开始骚扰——那正是主动建议最容易把人气跑的方式。
    pub fn pref_signal_purge(&self, retain_days: u32) -> Result<u32, String> {
        let conn = self.lock_conn();
        let cutoff = (chrono::Local::now() - chrono::Duration::days(retain_days.max(1) as i64))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let n = conn
            .execute("DELETE FROM pref_signals WHERE created_at < ?1", params![cutoff])
            .map_err(|e| e.to_string())?;
        Ok(n as u32)
    }

    /// 一键清空（红线②：用户可见可删）。连“已处理”标记一起清——
    /// 用户说“忘掉你学到的”就应该真的回到初始状态，包括允许重新提议。
    pub fn pref_signal_clear(&self) -> Result<u32, String> {
        let conn = self.lock_conn();
        let n = conn
            .execute("DELETE FROM pref_signals", [])
            .map_err(|e| e.to_string())?;
        let _ = conn.execute("DELETE FROM pref_signal_done", []);
        Ok(n as u32)
    }
}
