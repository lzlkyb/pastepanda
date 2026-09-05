//! 每日整理（H3 行为层）的数据口。
//!
//! # 这里只有一个查询，没有表
//!
//! 规划 §5.4 原本要新建一张 `daily_brief` 表存整理结果。**已拍板不建**：
//! 行为层（统计 + 分段）任何时候都能从 `history` 重算，存下来只会多一份
//! 会与源数据不一致的快照，还得配一套清理策略。
//! 真正新产生的信息只有 AI 小结，而它存进已有的**当天速记**（`notes.daily_date`）。
//!
//! # 只查五列
//!
//! `id / time / source / type / content_type`。
//! **不碰 `text` 与 `content`**——两层理由：
//! ① 隐私：行为层零内容，连读都不读；
//! ② 性能：图片的 `content` 是 base64，一天几百条拉出来就是几十 MB。

use super::DataStore;

/// 分段与统计所需的全部字段。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DayMetaRow {
    pub id: String,
    /// `YYYY-MM-DD HH:MM:SS`。
    pub time: String,
    /// 🔴 **原始窗口标题，未归一化**。
    /// 归一化在前端由 `cleanSourceName` 做——映射表只存在于前端，
    /// 后端再做一套就是两套会漂的规则。
    pub source: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub content_type: Option<String>,
}

impl DataStore {
    /// 某一天的全部剪贴板条目元信息，**按时间升序**。
    ///
    /// `date` 必须是 `YYYY-MM-DD`。
    ///
    /// # 为什么要校日期形式
    ///
    /// 日期拼进的是 `LIKE` 模式，而**参数绑定防不住 `LIKE` 通配符**：
    /// 传一个 `%` 进来就能把整库拉出来。所以先校形式再查。
    ///
    /// # 按 `time` 而不是 `created_at`
    ///
    /// 规划 §5.1 写的是「按 `created_at` 过滤当天」，而 `history` 表根本没有那一列
    /// （2026-09-05 开工前核查查实）。它的时间列叫 `time`。
    pub fn history_day_meta(&self, date: &str) -> Result<Vec<DayMetaRow>, String> {
        if !is_iso_date(date) {
            return Err(format!("日期格式应为 YYYY-MM-DD，实际收到：{}", date));
        }
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(
                // 升序：分段本来就要升序，在 SQL 里排比拉回去再排便宜。
                "SELECT id, time, source, type, content_type FROM history
                 WHERE time LIKE ?1 ORDER BY time ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([format!("{}%", date)], |r| {
                Ok(DayMetaRow {
                    id: r.get(0)?,
                    time: r.get(1)?,
                    source: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    item_type: r.get(3)?,
                    content_type: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

/// 事件下拉一次拉多少条的上限。
///
/// 设计稿在「最近 300 条」上跑出 41 段，平均 7.3 条/段——下拉里 41 项已经偏多，
/// 再多人就找不到东西了。取 500 留一点余量，同时作为硬夹防止调用方传巨数把全库拉出来。
pub const RECENT_META_CAP: u32 = 500;

impl DataStore {
    /// 最近 `limit` 条的条目元信息，**返回时按时间升序**。
    ///
    /// 事件聚合（G3）的数据口。与 [`Self::history_day_meta`] 同一批五列，
    /// 区别只在「怎么圈定范围」：那边按天，这边按条数（事件会跨天）。
    ///
    /// ❗ **先倒序截再升序返**：要的是「最近的 N 条」，直接 `ORDER BY time ASC LIMIT N`
    /// 拿到的是全库最早的 N 条。而分段又要升序，所以包一层子查询。
    pub fn history_recent_meta(&self, limit: u32) -> Result<Vec<DayMetaRow>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(
                "SELECT id, time, source, type, content_type FROM (
                     SELECT id, time, source, type, content_type FROM history
                     ORDER BY time DESC LIMIT ?1
                 ) ORDER BY time ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([limit.min(RECENT_META_CAP)], |r| {
                Ok(DayMetaRow {
                    id: r.get(0)?,
                    time: r.get(1)?,
                    source: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    item_type: r.get(3)?,
                    content_type: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

/// 严格 `YYYY-MM-DD`：10 个字符、只允许数字与两个连字符。
///
/// 不用正则也不拉 chrono 解析：这里要拦的是 `%` 这类通配符与长短不对的串，
/// 不是「2026-02-31 存不存在」——后者查出来本来就是空，无害。
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}
