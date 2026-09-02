//! 自动收录的影子运行（知识库 A 阶段 · 规划 §8.1 5️⃣ / §1.6 自动收录档）。
//!
//! **它不收录任何东西。** 只把「如果自动收录开着会收哪几条」记进 `kb_autofile_shadow`，
//! 一周后与用户实际手动转的集合对比算准确率。≥ 60% 才在 B2 真开。
//!
//! 为什么值得这么麻烦：**自动收录错一次用户就关掉了，没有第二次机会**。
//! 而三个阈值（5 / 200 / 7 天）全是拍的。一条 SQL + 一张表，把它从赌一把变成有证据的决定。
//!
//! 🔴 红线：无 AI。只数信号与长度，不读内容语义、不出网。
//! 🔴 红线②（使用日志可见可删）：本表记的是 history_id，**属于使用日志**，
//! 所以必须有读出口与清空入口（接在「系统学到了什么」面板）。

use super::*;

/// 阈值组合的指纹。**改了任何一个数就要改它**，否则新旧命中会混算准确率。
pub const RULE_VER: &str = "v1:hit5+len200+age7d";

/// 强度阈值。≥2 是 225 条（收件箱破产），≥5 是 36 条（§3.2 真实数据）。
const MIN_HIT: i64 = 5;

/// 形态阈值。挡掉那 **64% 不足 40 字符**的碎片。
const MIN_LEN: i64 = 200;

/// 年龄阈值（天）。挡掉「当下正在反复找」；跨周仍在找回 = 持久价值。
const MIN_AGE_DAYS: i64 = 7;

/// 影子运行的读出结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShadowStats {
    pub rule_ver: String,
    /// 规则一共命中过多少条（去重后）。
    pub hits: i64,
    /// 命中且**用户后来真的手动转了**的条数 = 真正例。
    pub hits_converted: i64,
    /// 用户手动转的总条数（有来源卡片的笔记）。
    pub manual_total: i64,
    /// 用户转了、但规则没命中的 = 漏报（说明还缺哪个信号维度）。
    pub missed: i64,
    /// 首次命中时间（算「一周后」的基准）。无记录时为空。
    pub since: Option<String>,
    /// 准确率 = hits_converted / hits。hits 为 0 时为 `None`（**不是 0**——
    /// 「没数据」与「准确率 0%」是两回事，当成 0 会直接得出「B2 不开」的错结论）。
    pub precision: Option<f64>,
}

impl DataStore {
    /// 算出本轮命中的候选（四个门槛 + 两个可 SQL 表达的排除）。
    ///
    /// 返回 `(history_id, text)`——text 给调用方做 **排除 3：`is_secret` 不命中**。
    /// 为何把 is_secret 留给命令层：它住在 `content_classifier`，而 data_store 不应
    /// 反向依赖分类器；且它是正则判定，SQL 里写不了。
    ///
    /// ❗ **形态门槛只管文本类（`LENGTH(text) >= 200`），图片一律不命中**。
    ///   规划 §1.6 那行写的是「图片类改看 OCR 字数 ≥ 阈值」，但同一段的量级估算
    ///   与结论又明写「图片那 17 条与短文本**不自动收录**，留在待沉淀区」——两句相矛。
    ///   取后者：① 它是结论句且与 11 条的量级估算一致；② 那个「OCR 字数阈值」声称
    ///   「复用通路#5、不用新写」，但**通路#5 归 B2、从未实现，无物可复用**。
    ///   图片分支与通路#5 一同归 B2。
    pub fn kb_shadow_candidates(&self, workspace: &str) -> Result<Vec<(String, String)>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                "SELECT h.id, h.text
                 FROM history h
                 WHERE h.workspace = ?1
                   AND COALESCE(h.search_hit_count, 0) >= ?2
                   AND h.type = 'text'
                   AND LENGTH(h.text) >= ?3
                   -- 必须带 'localtime'：h.time 存的是本地时间字符串，而 datetime('now') 是 UTC。
                   -- 不带的话在东八区会把阈值静默变成 7 天差 8 小时。
                   AND h.time <= datetime('now', 'localtime', ?4)
                   AND NOT EXISTS (
                       SELECT 1 FROM notes n WHERE n.history_id = h.id AND n.deleted_at IS NULL
                   )
                   AND NOT EXISTS (SELECT 1 FROM kb_inbox_dismissed d WHERE d.history_id = h.id)",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map(
                rusqlite::params![
                    workspace,
                    MIN_HIT,
                    MIN_LEN,
                    format!("-{MIN_AGE_DAYS} days")
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 记下本轮命中。已记过的只刷 `last_hit_at` 与 `hit_rounds`，
    /// **`first_hit_at` 不动**——它是「一周后看结果」的基准，每轮刷新就永远等不到一周。
    pub fn kb_shadow_record(&self, history_ids: &[String]) -> Result<(), String> {
        if history_ids.is_empty() {
            return Ok(());
        }
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in history_ids {
            tx.execute(
                "INSERT INTO kb_autofile_shadow
                     (history_id, rule_ver, first_hit_at, last_hit_at, hit_rounds)
                 VALUES (?1, ?2, ?3, ?3, 1)
                 ON CONFLICT(history_id, rule_ver) DO UPDATE SET
                     last_hit_at = ?3,
                     hit_rounds  = hit_rounds + 1",
                rusqlite::params![id, RULE_VER, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 读出准确率。只算**当前** `RULE_VER` 的命中（阈值改过就不能混算）。
    pub fn kb_shadow_stats(&self) -> Result<ShadowStats, String> {
        let conn = self.lock_conn();

        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_autofile_shadow WHERE rule_ver = ?1",
                [RULE_VER],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 命中 ∩ 用户手动转了。A 阶段无自动写入，所以「有笔记」等于「人手动转的」。
        let hits_converted: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_autofile_shadow s
                 WHERE s.rule_ver = ?1
                   AND EXISTS (
                       SELECT 1 FROM notes n
                       WHERE n.history_id = s.history_id AND n.deleted_at IS NULL
                   )",
                [RULE_VER],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let manual_total: i64 = conn
            .query_row(
                // 带 deleted_at：准确率的分母是「用户真的留下了的」，删掉的不算。
                "SELECT COUNT(DISTINCT history_id) FROM notes \
                 WHERE history_id IS NOT NULL AND deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 漏报：用户转了但规则没命中。这个数大 = 规则还缺信号维度（而非阈值太高）。
        let missed: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT n.history_id) FROM notes n
                 WHERE n.history_id IS NOT NULL
                   AND n.deleted_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM kb_autofile_shadow s
                       WHERE s.history_id = n.history_id AND s.rule_ver = ?1)",
                [RULE_VER],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let since: Option<String> = conn
            .query_row(
                "SELECT MIN(first_hit_at) FROM kb_autofile_shadow WHERE rule_ver = ?1",
                [RULE_VER],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        Ok(ShadowStats {
            rule_ver: RULE_VER.to_string(),
            hits,
            hits_converted,
            manual_total,
            missed,
            since,
            // hits=0 时给 None，不给 0.0（见字段注释）
            precision: if hits > 0 {
                Some(hits_converted as f64 / hits as f64)
            } else {
                None
            },
        })
    }

    /// 清空影子运行记录（红线②：使用日志用户可见**可删**）。
    ///
    /// 清全部 rule_ver 而不只清当前的：用户点「清空」的意思是「别存我的使用记录」，
    /// 而不是「只删当前阈值版本的那些」。
    pub fn kb_shadow_clear(&self) -> Result<usize, String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM kb_autofile_shadow", [])
            .map_err(|e| e.to_string())
    }
}
