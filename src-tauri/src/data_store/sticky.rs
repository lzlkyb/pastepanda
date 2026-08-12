//! 粘性数据聚合（v6.8）：活跃日历 / 连续周数 / 成就判定原料 / 里程碑原料。
//!
//! 与画像同构：**只返回统计值**（日期、次数、布尔、条数），不含任何内容文本。
//! 数据源全部是现有表：
//! - `action_events` —— 活跃日历（保留 90 天，窗口取 84 天 = 12 周）
//! - `history`        —— 累计条目数、最早一条时间（"使用开始日"，里程碑用）
//! - `chain_defs`     —— 自定义链数（成就）
//! - `ai_usage_log`   —— 用过 AI / 生成工具 / 画像精炼（这些 aiRun 直调不记 action_events）

use super::*;

/// 活跃日历的一天（date = "YYYY-MM-DD"，count = 当天事件数，0 表示无活跃）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDay {
    pub date: String,
    pub count: u32,
}

/// 粘性数据一次取全：活跃轨迹 + 成就 + 里程碑原料。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyStats {
    /// 最近 12 周（84 天）逐日活跃，从 83 天前到今天升序
    pub calendar: Vec<CalendarDay>,
    /// 连续活跃周数（截至本周；本周无记录则为 0，从本周起往前数）
    pub active_week_streak: u32,
    /// 84 天内有事件的天数
    pub active_days: u32,
    /// history 现存条目数（"累计复制"的本地近似——数据全在本机）
    pub history_count: u32,
    /// 最早一条复制的本地时间（"使用开始日"，安装周年里程碑用）
    pub first_history_at: Option<String>,
    /// 自定义链条数（成就「方法论之父」）
    pub custom_chain_count: u32,
    /// 用过 AI（ai_usage_log 或 action_events 里存在 ai-* 动作）
    pub ai_used: bool,
    /// 用过生成工具（ai-regex-generate / ai-sql-generate，成就「结构化人生」）
    pub tool_used: bool,
    /// 跑过排错流水线（action_events 里 error-triage 链，成就「我会排错」）
    pub triage_used: bool,
    /// 导出过画像（action_events 里 profile-export 事件，成就「可移植的灵魂」）
    pub profile_exported: bool,
    /// 画像做过 AI 精炼（成就「画像觉醒」）
    pub profile_refined: bool,
}

/// 活跃日历窗口天数（12 周；action_events 保留 90 天，窗口在保留期内）
pub const CALENDAR_DAYS: i64 = 84;
/// 连续周数扫描上限（往前看 20 周足够覆盖 12 周成就阈值）
const STREAK_SCAN_WEEKS: i64 = 20;

impl DataStore {
    /// 聚合粘性数据。查不到一律返回零值/None——"还没开始用"不是错误。
    pub fn sticky_stats(&self) -> StickyStats {
        let (calendar, active_week_streak, active_days) = self.sticky_calendar();
        StickyStats {
            calendar,
            active_week_streak,
            active_days,
            history_count: self.history_count_all(),
            first_history_at: self.history_first_at(),
            custom_chain_count: self.chain_count_all(),
            ai_used: self.usage_exists("ai-%", None) || self.action_like_exists("ai-%"),
            tool_used: self.usage_exists("ai-regex-generate", Some("ai-sql-generate")),
            triage_used: self.action_exists("error-triage", "chain"),
            profile_exported: self.action_exists("profile-export", ""),
            profile_refined: self.usage_exists("profile-refine", None),
        }
    }

    /// 活跃日历 + 连续周数（一个连接内完成，全部收进块作用域防重入死锁）。
    fn sticky_calendar(&self) -> (Vec<CalendarDay>, u32, u32) {
        let (map, weeks) = {
            let conn = self.lock_conn();
            let since = (chrono::Local::now() - chrono::Duration::days(CALENDAR_DAYS - 1))
                .format("%Y-%m-%d 00:00:00")
                .to_string();

            // 逐日计数
            let map: std::collections::HashMap<String, u32> = {
                let mut stmt = match conn.prepare(
                    "SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c
                     FROM action_events WHERE created_at >= ?1 GROUP BY d",
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[Sticky] 日历查询失败：{}", e);
                        return (Vec::new(), 0, 0);
                    }
                };
                stmt.query_map(params![since], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
            };

            // 按周去重的活跃周集合。
            //
            // 键 = **该周周一的日期**（YYYY-MM-DD），不再用 `%Y-%W` 这种“年+周序号”。
            // 旧写法在跳年会错位：循环里每轮 `cursor -= 7 天` 后取 %W，
            // 2026-01-01（周四，%W = "2026-00"）往前 7 天到 2025-12-25（%W = "2025-51"），
            // **跳过了 "2025-52"（12-29~31）** —— 用户在那三天活跃却 12-22~25 不活跃时，
            // 连续周数会被错误中断。改用周一日期后，两边算的都是同一个绝对日期，
            // 也不再依赖 SQLite 与 chrono 对 %W 编号规则的一致性。
            //
            // SQL 侧：%w 是 0~6（周日=0），距周一的天数 = (%w + 6) % 7。
            let weeks: std::collections::HashSet<String> = {
                let since_weeks =
                    (chrono::Local::now() - chrono::Duration::days(STREAK_SCAN_WEEKS * 7))
                        .format("%Y-%m-%d 00:00:00")
                        .to_string();
                let mut stmt = match conn.prepare(
                    "SELECT DISTINCT date(created_at, '-' || ((strftime('%w', created_at) + 6) % 7) || ' days') AS w
                     FROM action_events WHERE created_at >= ?1",
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[Sticky] 周聚合失败：{}", e);
                        return (Vec::new(), 0, 0);
                    }
                };
                stmt.query_map(params![since_weeks], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default()
            };

            (map, weeks)
        };

        // 补全 84 天（无记录 count=0），保证前端拿到的就是完整网格
        let mut calendar = Vec::with_capacity(CALENDAR_DAYS as usize);
        let mut day = chrono::Local::now().date_naive() - chrono::Duration::days(CALENDAR_DAYS - 1);
        for _ in 0..CALENDAR_DAYS {
            let key = day.format("%Y-%m-%d").to_string();
            calendar.push(CalendarDay {
                date: key.clone(),
                count: map.get(&key).copied().unwrap_or(0),
            });
            day += chrono::Duration::days(1);
        }
        let active_days = calendar.iter().filter(|d| d.count > 0).count() as u32;

        // 从本周往前数连续有记录的周。
        // cursor 先对齐到本周周一，之后每轮 -7 天仍落在周一，与 SQL 侧的键同构。
        let mut streak = 0u32;
        let today = chrono::Local::now().date_naive();
        let mut cursor = today
            - chrono::Duration::days(
                chrono::Datelike::weekday(&today).num_days_from_monday() as i64
            );
        for _ in 0..STREAK_SCAN_WEEKS {
            let key = cursor.format("%Y-%m-%d").to_string();
            if weeks.contains(&key) {
                streak += 1;
            } else {
                break;
            }
            cursor -= chrono::Duration::days(7);
        }

        (calendar, streak, active_days)
    }

    fn history_count_all(&self) -> u32 {
        self.lock_conn()
            .query_row("SELECT COUNT(*) FROM history", [], |r| {
                r.get::<_, i64>(0).map(|v| v as u32)
            })
            .unwrap_or(0)
    }

    fn history_first_at(&self) -> Option<String> {
        self.lock_conn()
            .query_row("SELECT MIN(time) FROM history", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .ok()
            .flatten()
    }

    fn chain_count_all(&self) -> u32 {
        self.lock_conn()
            .query_row("SELECT COUNT(*) FROM chain_defs", [], |r| {
                r.get::<_, i64>(0).map(|v| v as u32)
            })
            .unwrap_or(0)
    }

    /// ai_usage_log 里是否存在指定 action_id（pattern 支持 LIKE 通配；alt 为第二个候选）
    fn usage_exists(&self, pattern: &str, alt: Option<&str>) -> bool {
        let conn = self.lock_conn();
        let r = match alt {
            Some(a) => conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_usage_log WHERE action_id IN (?1, ?2))",
                params![pattern, a],
                |r| r.get::<_, i64>(0),
            ),
            None => conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_usage_log WHERE action_id LIKE ?1)",
                params![pattern],
                |r| r.get::<_, i64>(0),
            ),
        };
        r.map(|v| v > 0).unwrap_or(false)
    }

    /// action_events 里是否存在指定 (action_id, content_type)
    fn action_exists(&self, action_id: &str, content_type: &str) -> bool {
        self.lock_conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM action_events WHERE action_id = ?1 AND content_type = ?2)",
                params![action_id, content_type],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v > 0)
            .unwrap_or(false)
    }

    /// action_events 里是否存在匹配 pattern 的 action_id（兜底：动作经变换枢纽触发时
    /// 只记事件不记 ai_usage_log 的情况）
    fn action_like_exists(&self, pattern: &str) -> bool {
        self.lock_conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM action_events WHERE action_id LIKE ?1)",
                params![pattern],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v > 0)
            .unwrap_or(false)
    }
}
