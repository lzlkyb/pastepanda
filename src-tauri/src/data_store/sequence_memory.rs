//! data_store/sequence_memory.rs —— 程序性记忆（V3-B）。
//!
//! 从 action_events 挖掘**高频动作序列**：你常「复制报错 → 解释代码 → 提取要点」，
//! 这个重复出现的顺序就是"程序性记忆"——系统记得你惯常的多步操作，
//! 提示把它固化成动作链（M6-4）。
//!
//! 隐私边界（与红线②同构）：
//! - 只统计 action_id 的**顺序模式**，不含任何内容、来源应用、具体时间点；
//! - 只看"你常连着做哪几个动作"，从不看"你对什么内容做了这些动作"。

use std::collections::HashMap;

use rusqlite::params;

use super::DataStore;

/// 会话间隔上限（秒）：相邻两个事件的时间差超过它，就当成**两段互不相关的操作**，
/// 滑动窗口在这里断开。
///
/// 为什么必须有这道闸：窗口只看动作的先后顺序，不看时间。没有它的话，
/// 「周一下班前的最后一个动作」和「周三上班后的第一个动作」会被拼成一个合法的
/// `[A, B]` 窗口——用户只要有稳定的收尾/开工习惯（每天最后跑周报、次日首个解释代码），
/// 30 天里这个**他从来没连着做过**的跨天对就能攒够 `min_count`，被当成「高频操作序列」
/// 推荐给他。这类建议是根本不成立的，比不给建议更糟。
///
/// 为什么取 10 分钟：一次真实的多步流程里，用户要读 AI 的输出、切窗口、再粘贴，
/// 单步间隔到几分钟很正常（取 1~5 分钟会把这类真序列切断）；而真正的任务边界
/// （吃饭、下班、次日开工）都是小时级，离 10 分钟还差一个数量级，不会漏切。
const SESSION_GAP_SECS: i64 = 10 * 60;

/// 一条高频动作序列模式。
#[derive(Debug, Clone)]
pub struct SequencePattern {
    /// 按出现顺序的动作 id（2~4 步）。
    pub actions: Vec<String>,
    /// 最近 N 天内该连续序列出现的次数（重叠窗口计数）。
    pub count: u32,
    /// 该模式最后一次出现的时间（YYYY-MM-DD HH:MM:SS）。
    pub last_used: String,
}

impl DataStore {
    /// 挖掘高频动作序列。
    ///
    /// - `days`：统计窗口（默认 30 天）
    /// - `min_count`：至少出现几次才认为是"习惯"（默认 3）
    /// - `max_steps`：最长序列步数（2~4；X1 规划：超过 5 步难以排错）
    ///
    /// 返回按 count 降序、最多 10 条的模式。
    pub fn sequence_mining(
        &self,
        days: i64,
        min_count: u32,
        max_steps: usize,
    ) -> Result<Vec<SequencePattern>, String> {
        let max_steps = max_steps.clamp(2, 4);
        // 上界必须 clamp（与 profile_raw_stats 的 days.clamp(1, 365) 对齐）：
        // chrono::Duration::days() 传极大值会 panic。当前唯一调用点硬编码 30，
        // 这里只做一致性收敛，免得下一个调用方把参数透传给用户输入。
        let days = days.clamp(1, 365);
        let since = (chrono::Local::now() - chrono::Duration::days(days - 1))
            .format("%Y-%m-%d 00:00:00")
            .to_string();

        // 取数据要持锁，但**只在取数据期间持锁**：下面的 freq 统计 / 倒序扫描 / 排序
        // 全是纯内存计算，一条 SQL 都不发。整段握着锁的话，剪贴板监听线程的
        // action_event_add / insert_history（同一把 lock_conn，DataStore 是单连接 +
        // std Mutex）会被一起阻塞——用户打开动作链运行器的瞬间复制内容就会卡一下。
        let rows: Vec<(String, String)> = {
            let conn = self.lock_conn();
            // 按时间升序取动作序列（排除 paste 哨兵——"粘贴"是动作的结果不是意图）
            let mut stmt = conn
                .prepare(
                    "SELECT created_at, action_id FROM action_events
                     WHERE created_at >= ?1 AND action_id != ?2
                     ORDER BY created_at ASC, id ASC",
                )
                .map_err(|e| e.to_string())?;
            let out: Vec<(String, String)> = stmt
                .query_map(params![since, crate::data_store::ACTION_ID_PASTE], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            out
            // stmt 、conn（MutexGuard）随块结束立即释放
        };

        let actions: Vec<&str> = rows.iter().map(|(_, a)| a.as_str()).collect();
        if actions.len() < 2 {
            return Ok(vec![]);
        }
        let breaks = SessionBreaks::from_rows(&rows);

        // 滑动窗口统计连续子序列频率（重叠窗口计数，行为序列天然有交叠）
        let mut freq: HashMap<Vec<String>, u32> = HashMap::new();
        for w in 2..=max_steps.min(actions.len()) {
            for i in 0..=actions.len() - w {
                // 窗口内任意相邻两步跨了会话间隔 → 这根本不是一次连续操作，丢弃。
                // （哨兵被 SQL 排除、以及 filter_map 丢行，都会把本不相邻的动作
                //   在 actions 里拼成相邻；这道判定同时兜住那两种情况——被跳过的
                //   那段时间照样体现在两侧事件的时间差里。）
                if !breaks.is_continuous(i, w) {
                    continue;
                }
                let win = &actions[i..i + w];
                // 跳过全相同窗口（[a,a,a] 是手抖重复，不是习惯模式）
                if win.iter().all(|a| *a == win[0]) {
                    continue;
                }
                let key: Vec<String> = win.iter().map(|s| s.to_string()).collect();
                *freq.entry(key).or_insert(0) += 1;
            }
        }

        let mut out: Vec<SequencePattern> = freq
            .into_iter()
            .filter(|(_, c)| *c >= min_count)
            .map(|(actions, count)| {
                let last_used = find_last_occurrence(&actions, &rows, &breaks);
                SequencePattern {
                    actions,
                    count,
                    last_used,
                }
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then(b.actions.len().cmp(&a.actions.len())));
        out.truncate(10);
        Ok(out)
    }
}

/// 会话断点表：把"相邻两事件之间是不是断了"预先算成前缀和，
/// 让任意窗口的连续性判定降到 O(1)。
///
/// 为什么用前缀和而不是每个窗口重新逐对比：窗口数 × 步数 × 模式数乘起来不小，
/// 而时间戳解析（字符串 → NaiveDateTime）是里面最贵的一步，只能跑一遍。
struct SessionBreaks {
    /// `prefix[k]` = 前 k 个相邻对里的断点个数。长度与 rows 相同。
    prefix: Vec<u32>,
}

impl SessionBreaks {
    fn from_rows(rows: &[(String, String)]) -> Self {
        // created_at 的格式全库统一为本地时间的 "%Y-%m-%d %H:%M:%S"（无时区），
        // 所有行同一时区，所以直接用 NaiveDateTime 相减拿秒差就够了。
        let ts: Vec<Option<chrono::NaiveDateTime>> = rows
            .iter()
            .map(|(t, _)| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").ok())
            .collect();
        let mut prefix = Vec::with_capacity(rows.len());
        prefix.push(0u32);
        for k in 1..rows.len() {
            let broken = match (ts[k - 1], ts[k]) {
                (Some(a), Some(b)) => (b - a).num_seconds().abs() > SESSION_GAP_SECS,
                // 时间戳解析不出来时**保守地当作断开**：宁可少挖出一个模式，
                // 也不能凭空造一个用户没做过的序列。
                _ => true,
            };
            prefix.push(prefix[k - 1] + u32::from(broken));
        }
        Self { prefix }
    }

    /// 从下标 `i` 开始、长度 `w` 的窗口是不是一次连续操作（中间没有断点）。
    fn is_continuous(&self, i: usize, w: usize) -> bool {
        debug_assert!(w >= 1 && i + w <= self.prefix.len());
        self.prefix[i + w - 1] == self.prefix[i]
    }
}

/// 找 pattern 在事件序列中最后一次出现的时间（倒序匹配，取最早命中）。
///
/// 这里必须用**和挖掘时同一条**会话间隔规则：否则 last_used 会指到一次跨会话的
/// "伪相邻"上，界面上就成了"最近一次是昨天"——而那次根本没发生。
fn find_last_occurrence(
    pattern: &[String],
    rows: &[(String, String)],
    breaks: &SessionBreaks,
) -> String {
    if pattern.is_empty() || rows.len() < pattern.len() {
        return String::new();
    }
    for i in (0..=rows.len() - pattern.len()).rev() {
        if !breaks.is_continuous(i, pattern.len()) {
            continue;
        }
        let mut matched = true;
        for (k, p) in pattern.iter().enumerate() {
            if rows[i + k].1 != *p {
                matched = false;
                break;
            }
        }
        if matched {
            return rows[i + pattern.len() - 1].0.clone();
        }
    }
    String::new()
}
