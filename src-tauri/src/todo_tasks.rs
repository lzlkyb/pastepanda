//! 待办扫描（灵动岛 B2）—— 把活笔记正文里的 GFM 复选框扫成岛的状态。
//!
//! ## 数据流（为什么推送收口在 Rust 而不是前端）
//!
//! 岛是独立 webview，拿不到主窗口的 zustand store；而「笔记正文变了」这件事
//! 的**全部源头**都在 Rust 侧（命令层 + MCP 写入 + 同步引擎）。所以：
//!
//! ```text
//! 任何写路径 ──► refresh_island(&app) ──► compute_island_state ─┬─► IslandStateCache（岛拉快照用）
//!                                                              └─► emit「todo-island-update」（岛收推送）
//! ```
//!
//! 前端（`islandBridge.ts`）只有**收**的份：mount 拉快照 + 订阅推送 +
//! `EVENT_SHOWN` 时重拉。没有第二处能往岛推状态，「显示 A、实际 B」的漂移
//! 从结构上不可能发生（实施方案 §5 #6 的目标，用更强的做法达成）。
//!
//! ## 已挂钩的写入点（规则 #11.1：加「某类特殊处理」必须找全同类调用点）
//!
//! | 路径 | 位置 |
//! |---|---|
//! | 命令层 | `commands/notes.rs` 的 create / update / delete / restore / purge / purge_all；`commands/note_daily.rs` 的 append_daily；`commands/note_revisions.rs` 的版本恢复；`commands/note_vault.rs` 的整库导入 |
//! | MCP 外部写入 | `mcp/source.rs` `AppKbSource` 的 create / update / append / delete / restore / edit_content |
//! | 同步引擎 | **无钩子**（`sync/engine.rs` 拿不到 AppHandle）——由岛 `EVENT_SHOWN` 重拉兜底：它走 `note_update`/`note_create` 落库且必然带新 `updated_ms`，扫描缓存的键一变就重扫，岛下次显示必是新数据 |
//!
//! ## 排序口径（「今天该做什么」，2026-09-25 起到期优先）
//!
//! 1. **有截止时间的排最前**，按到期时刻升序——「最紧的顶上去」（二期提醒拍板）；
//! 2. 没截止时间的维持原口径：今天速记（`daily_date == 今天`）排先——立项 §2.5
//!    拍板的「隐式到期日」；其余按笔记 `updated_ms` 降序（最近动过的优先）。
//!
//! `total` / `done` 是**全库**口径（进度环画的是整体完成度）；
//! `tasks` 只装未完成的、按上面排序、截到 [`MAX_LIST_TASKS`] 条。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::data_store::DataStore;
use crate::markdown::sections::fence_at;
use crate::todo_island::IslandState;

/// 岛展开列表的单条待办。
///
/// 契约镜像在 `src/lib/todo/types.ts`，两边字段名靠 `rename_all = "camelCase"` 对齐；
/// 改一边必须同步另一边——不匹配时 invoke 会**静默**拿到 undefined 形态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandTask {
    /// 所在笔记 id（勾选回写的定位键）
    pub note_id: String,
    /// 所在笔记标题（展开列表里区分「这条来自哪」）
    pub note_title: String,
    /// 正文中的行号，**0 起**（与 `annotate::Observation::line` 同一口径）
    pub line: usize,
    /// 任务文字（`- [ ] ` 之后的部分，**已剥掉 `@时间` 尾巴**——尾巴另行解析）
    pub text: String,
    pub done: bool,
    /// 截止时刻（本地时区 Unix 毫秒）。None = 没写截止时间。
    /// `serde(default)`：旧快照/旧前端没有这些字段，反序列化不能因此挂。
    #[serde(default)]
    pub due_ms: Option<i64>,
    /// false = 全天（没写 HH:mm）：只展示「今天到期」，**不弹提醒**
    #[serde(default)]
    pub due_has_time: bool,
    /// 展示用的时间文案（「今天 16:00」「9/28 9:00」）。None = 无截止时间
    #[serde(default)]
    pub due_label: Option<String>,
}

/// 展开列表的任务数上限。列表超高就滚（面板高度固定 240，设计稿 §5），
/// 这里卡的是 IPC payload：50 条已经远超一屏，再多是调用方（扫描）出了问题。
const MAX_LIST_TASKS: usize = 50;

// ===== 纯解析（无环境依赖，直接单测） =====

/// 一篇正文里扫出的任务行。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTask {
    /// 0 起行号（对 `content.split('\n')` 的下标）
    pub line: usize,
    /// 原始任务文字（含 `@时间` 尾巴——尾巴要原样回写在笔记正文里）
    pub text: String,
    pub done: bool,
    /// 剥掉尾巴后的展示文字（与 `text` 一起来自 [`due_tail`]，不重复解析）
    pub display: String,
    /// 尾巴里的时间（尚未结合「今天」换算成绝对时刻）
    pub due_raw: Option<DueRaw>,
}

// ===== 截止时间（二期提醒，甲案：岛即提醒） =====

use chrono::{Datelike, Timelike, TimeZone};

/// 解析后的截止时刻。`at_ms` 由 [`resolve_due`] 结合解析当天的「今天」算出
/// （关键字「明天」钉死成绝对日期，缓存隔天不漂移）。
#[derive(Debug, Clone, PartialEq)]
pub struct DueSpec {
    pub at_ms: i64,
    /// false = 全天（没写 HH:mm）：只展示不提醒
    pub has_time: bool,
}

/// 尾巴里的时间原始形态（不含「今天」语境，纯解析产物）。
#[derive(Debug, Clone, PartialEq)]
pub struct DueRaw {
    /// 关键字相对天数（今天 0 / 明天 1 / 后天 2）；数字日期为 None
    pub rel_day: Option<i64>,
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
    pub has_time: bool,
    pub hour: u32,
    pub minute: u32,
}

/// 把任务文字**尾部**的 `@时间` 剥出来（规则 #11.1 收口：展示文字的唯一定义）。
///
/// 恒返回 `(展示文字, Option<DueRaw>)`：没有合法尾巴时展示文字 = 原文。
/// **只认尾巴**：`@` 必须是「空白后」的独立段且延伸到行尾（1–2 个词）。
/// `交报告 @今天 16:00` → (`交报告`, Some)；`邮箱@example.com`、
/// `@今天 开完再说`（@后还有别的词）、`@13/45`（非法日期）一律原样返回 None。
/// 展示文字剥尾后不许为空（`@今天` 孤立成文 = 不是尾巴）。
/// 笔记正文**不回改**——语法在岛内是展示层约定，笔记里人也能读懂。
pub fn due_tail(text: &str) -> (String, Option<DueRaw>) {
    let none = || (text.to_string(), None);
    let t = text.trim_end();
    let Some(at) = t.rfind('@') else { return none() };
    // `@` 必须由空白引出（`邮箱@example.com` 的 @ 在词中，不算）
    if at == 0 || !t[..at].ends_with(char::is_whitespace) {
        return none();
    }
    let tail = &t[at + 1..];
    let mut words = tail.split_whitespace();
    let Some(date_w) = words.next() else { return none() };
    let time_w = words.next();
    if words.next().is_some() {
        return none(); // @后面还有第三段——那是正文，不是尾巴
    }
    let Some(mut raw) = parse_due_date(date_w) else { return none() };
    if let Some(w) = time_w {
        match parse_due_time(w) {
            Some((h, m)) => {
                raw.has_time = true;
                raw.hour = h;
                raw.minute = m;
            }
            // 时间**未遂**（`16：00` 已在上面兼容；`25:00`/`下午3点` 这类带数字的）
            // 降级成**全天日期**而不是整条作废——「连日期一起丢」会让用户以为
            // 提醒设好了实际什么都没有（审计 P3#20）。
            // 纯文字词（`下午再说`）不是时间未遂，是正文——整条尾巴按无效处理，
            // 与历史行为一致，不许把用户的话吞进日期里。
            None if w.chars().any(|c| c.is_ascii_digit()) => {}
            None => return none(),
        }
    }
    let display = t[..at].trim_end().to_string();
    if display.is_empty() {
        return none();
    }
    (display, Some(raw))
}

/// 日期词：`今天`/`明天`/`后天`、`9/26`、`09-26`、`2026-09-26`（`/` 同）。
fn parse_due_date(w: &str) -> Option<DueRaw> {
    let base = |rel: i64| {
        Some(DueRaw {
            rel_day: Some(rel),
            year: None,
            month: 0,
            day: 0,
            has_time: false,
            hour: 0,
            minute: 0,
        })
    };
    match w {
        "今天" => return base(0),
        "明天" => return base(1),
        "后天" => return base(2),
        _ => {}
    }
    let (y, rest) = match w.split_once(['-', '/']) {
        Some((a, b)) if a.len() == 4 => (a.parse::<i32>().ok(), b),
        Some(_) => (None, w), // 两位/一位开头：整段重新按 M-D 切
        _ => return None,
    };
    let (m, d) = match rest.split_once(['-', '/']) {
        Some((a, b)) => (a, b),
        None => return None,
    };
    let (month, day) = (m.parse::<u32>().ok()?, d.parse::<u32>().ok()?);
    if month == 0 || month > 12 || day == 0 || day > 31 {
        return None;
    }
    // 无年的 2/29 交给 from_ymd_opt 校验（平年拒认，宁可不提醒不误提醒）
    if let Some(y) = y {
        chrono::NaiveDate::from_ymd_opt(y, month, day)?;
    }
    Some(DueRaw {
        rel_day: None,
        year: y,
        month,
        day,
        has_time: false,
        hour: 0,
        minute: 0,
    })
}

/// 时间词：`H:mm` / `HH:mm`（16:00 / 9:30）。全角冒号 `16：00` 同样认——
/// 中文输入法打出来的尾巴不该因为冒号形状整条作废（审计 P3#20）。
fn parse_due_time(w: &str) -> Option<(u32, u32)> {
    let w = w.replace('：', ":");
    let (h, m) = w.split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    let (hour, minute) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (hour <= 23 && minute <= 59).then_some((hour, minute))
}

/// 结合「今天」把尾巴换算成绝对时刻。
///
/// 无年份数字日期早于今天 → 顺延到明年（`@1/1` 在 9 月写，指明年的 1/1）；
/// 平年 2/29 在 parse_due_date 已拒认。本地时区；DST 歧义时刻取最早解。
pub fn resolve_due(raw: &DueRaw, now: chrono::DateTime<chrono::Local>) -> Option<DueSpec> {
    let today = now.date_naive();
    let date = match raw.rel_day {
        Some(rel) => today + chrono::Duration::days(rel),
        None => {
            let y = raw.year.unwrap_or_else(|| {
                let this_year = today.year();
                let this = chrono::NaiveDate::from_ymd_opt(this_year, raw.month, raw.day);
                match this {
                    Some(d) if d >= today => this_year,
                    _ => this_year + 1,
                }
            });
            chrono::NaiveDate::from_ymd_opt(y, raw.month, raw.day)?
        }
    };
    let time = if raw.has_time {
        chrono::NaiveTime::from_hms_opt(raw.hour, raw.minute, 0)?
    } else {
        // 全天 = 当天 23:59:59：过完这一天才算过期，排序里排在当天有时间任务之后
        chrono::NaiveTime::from_hms_opt(23, 59, 59)?
    };
    use chrono::TimeZone;
    let ndt = chrono::NaiveDateTime::new(date, time);
    match chrono::Local.from_local_datetime(&ndt) {
        chrono::LocalResult::Single(v) | chrono::LocalResult::Ambiguous(v, _) => {
            Some(DueSpec { at_ms: v.timestamp_millis(), has_time: raw.has_time })
        }
        chrono::LocalResult::None => None,
    }
}

/// 截止时刻的展示文案。label 只依赖绝对日期与今天的关系，**每次刷新现算**
/// ——「今天」不会隔夜变成假话。
pub fn due_label(at_ms: i64, has_time: bool, now: chrono::DateTime<chrono::Local>) -> String {
    let date = chrono::Local.timestamp_millis_opt(at_ms).unwrap().date_naive();
    let today = now.date_naive();
    let time = || {
        let t = chrono::Local.timestamp_millis_opt(at_ms).unwrap().time();
        format!("{}:{:02}", t.hour(), t.minute())
    };
    match date {
        d if d == today => {
            if has_time { format!("今天 {}", time()) } else { "今天到期".to_string() }
        }
        d if d == today + chrono::Duration::days(1) => {
            if has_time { format!("明天 {}", time()) } else { "明天到期".to_string() }
        }
        d if d == today - chrono::Duration::days(1) => {
            if has_time { format!("昨天 {}", time()) } else { "昨天到期".to_string() }
        }
        d if d.year() == today.year() => {
            if has_time { format!("{}/{} {}", d.month(), d.day(), time()) } else { format!("{}/{} 到期", d.month(), d.day()) }
        }
        d => {
            if has_time { format!("{}.{}/{} {}", d.year(), d.month(), d.day(), time()) } else { format!("{}.{}/{} 到期", d.year(), d.month(), d.day()) }
        }
    }
}

/// 扫一篇正文里的所有 GFM 任务复选框。
///
/// ❗ **跳过代码块**：围栏判定复用 [`fence_at`]，与 outline / annotate 同一份
/// （实施方案 §6 风险 8）——代码里的 `- [ ]` 示例不许变成幽灵待办。
pub fn parse_tasks(content: &str) -> Vec<ParsedTask> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for (i, line) in content.split('\n').enumerate() {
        if let Some((ch, n)) = fence_at(line) {
            match fence {
                None => fence = Some((ch, n)),
                Some((fc, fl)) if fc == ch && n >= fl => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((text, done)) = task_at(line) {
            let (display, due_raw) = due_tail(&text);
            out.push(ParsedTask { line: i, text, done, display, due_raw });
        }
    }
    out
}

/// GFM 任务行识别。
///
/// **认**：`- [ ] 文字` / `- [x] 文字`（`*` / `+` 同）；`[X]` 大写也算（GFM 规定）；
///        0–3 空格缩进（缩进 4+ 是缩进代码块，与 GFM 同一条界）。
/// **不认**：`- [todo] 文字` —— 方括号里只有空格或 x/X 才是任务。这不是防御性
///        编程，是**已经躺在库里的数据**逼出来的：`- [todo]` 与类别行 100% 撞车
///        （`annotate.rs` 头部实测 3/3 全是复选框）；空文字（`- [ ]` 孤行）也跳过
///        ——没有可展示的东西，勾了也不知道勾的是什么。
fn task_at(line: &str) -> Option<(String, bool)> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return None; // 缩进代码块（GFM：4 空格起）
    }
    // 前缀两种（GFM 任务复选框允许挂在两类列表项上）：
    //   无序 `- `/`* `/`+ `；有序 `1. ` / `12) `（数字 1–9 位）。
    // 有序不认的话，用户用编号清单写的待办在岛上完全不可见（审计 P3#19）。
    let rest = match trimmed.strip_prefix(['-', '*', '+']) {
        Some(r) => r.strip_prefix(' ')?,
        None => strip_ordered_marker(trimmed)?,
    };
    let rest = rest.strip_prefix('[')?;
    let (mark, after) = rest.split_once(']')?;
    let done = match mark {
        " " => false,
        "x" | "X" => true,
        // `- [todo]`（类别行）、`- [1]`、`- []` 等，一律不是任务
        _ => return None,
    };
    // `]` 之后必须有空格再接文字（GFM）；`- [ ]文字` 连写不是任务
    let text = after.strip_prefix(' ')?.trim();
    if text.is_empty() {
        return None;
    }
    Some((text.to_string(), done))
}

/// 有序编号前缀：数字（1–9 位）+ `.` 或 `)` + 空格。`3.14 是圆周率`、
/// `2026-09-26 …` 这类以数字开头但不是列表项的行，切完数字后接不上
/// `.`/`)`+空格，自然落空。
fn strip_ordered_marker(s: &str) -> Option<&str> {
    let digits = s.len() - s.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || digits > 9 {
        return None;
    }
    s[digits..].strip_prefix(['.', ')'])?.strip_prefix(' ')
}

/// 翻转一行任务复选框的勾选态，**只动方括号里那一个字符**。
///
/// 缩进、bullet 字符、`[X]` 的原样性全保留——用户写的是 `- [X]`，回写就还是
/// `- [X]` 换成 `- [ ]`，不许悄悄改写别人的排版。
/// 返回 `None` = 这行不是任务行（调用方应视为行号漂移）。
pub fn flip_task_line(raw: &str) -> Option<String> {
    // 先验形状（bullet 与编号两种前缀都在 task_at 里认）
    task_at(raw)?;
    let lead = raw.len() - raw.trim_start().len();
    // mark = 行首后第一个 `]` 里那一个字符——按形状找，不按固定偏移数：
    // 编号前缀（`1. ` / `12) `）长度不定，`lead+3` 的老算法对它会翻错位置。
    let close = raw[lead..].find(']')? + lead;
    let mark_idx = close.checked_sub(1)?;
    // 保险丝：mark 前一个字符必须是 `[`（防 `]` 之前混进奇怪内容）；编号 9 位
    // + `. ` + `[` + mark + `]` 最长 13，超了绝不是任务行。
    if close - lead > 14 || !raw[..mark_idx].ends_with('[') {
        return None;
    }
    let new_mark = match raw[mark_idx..].chars().next()? {
        ' ' => 'x',
        'x' | 'X' => ' ',
        _ => return None,
    };
    Some(format!(
        "{}{}{}",
        &raw[..mark_idx],
        new_mark,
        &raw[mark_idx + 1..]
    ))
}

/// 勾选回写的失败形态（岛端据此决定「刷新」还是「提示」）。
#[derive(Debug, PartialEq)]
pub enum ToggleError {
    /// 行号越界——正文变短了（外部删了内容）
    OutOfRange,
    /// 该行已经不是任务行（外部把这行改掉了）
    NotTask,
    /// 还是任务行，但文字对不上——行号漂移（外部在前面增删了行，实施方案 §6 风险 6）
    TextDrift,
}

/// 把 `content` 第 `line` 行的任务翻个面。**纯函数**：校验 + 翻转，不碰库。
///
/// `expected_text` 是扫描时看到的任务文字。三重校验对应三种漂移：
/// 行还在但换了内容 → [`ToggleError::NotTask`]；行号挪了 → [`ToggleError::TextDrift`]。
/// 任何一种都**报错刷新**，绝不静默去改别的行（规则 #15.3）。
pub fn apply_toggle(content: &str, line: usize, expected_text: &str) -> Result<String, ToggleError> {
    let raw = content.split('\n').nth(line).ok_or(ToggleError::OutOfRange)?;
    let (raw_text, _) = task_at(raw).ok_or(ToggleError::NotTask)?;
    // expected_text 是岛里展示的文字（已剥 `@时间` 尾巴，见 due_tail）——比对走同一份剥尾
    let (display, _) = due_tail(&raw_text);
    if display != expected_text.trim() {
        return Err(ToggleError::TextDrift);
    }
    let flipped = flip_task_line(raw).ok_or(ToggleError::NotTask)?;
    // 校验全过之后才动手：只有第 line 行被换成翻转后的版本，其余行原样通过
    let mut parts: Vec<String> = content.split('\n').map(String::from).collect();
    parts[line] = flipped;
    Ok(parts.join("\n"))
}

// ===== 扫描缓存 =====

/// 单篇笔记的解析结果缓存。键是 `updated_ms`——内容没变就不再重扫正文。
#[derive(Debug, Clone)]
struct CachedNote {
    updated_ms: i64,
    title: String,
    tasks: Vec<ParsedTask>,
}

/// 扫描缓存（`manage` 进 Tauri 状态）。
///
/// 存在的理由：刷新跟着每次笔记变动跑，全库重扫是 O(总字节)（实施方案 §6 风险 5）。
/// 缓存把每次刷新的成本压到「一条索引查询 + 变了的那几篇的正文」。
#[derive(Default)]
pub struct TodoScanCache(Mutex<HashMap<String, CachedNote>>);

struct ScanNote {
    /// 今天的速记排最前（「隐式到期日 = 记在哪天」，立项 §2.5）
    today_daily: bool,
    updated_ms: i64,
    id: String,
    title: String,
    tasks: Vec<ParsedTask>,
}

/// 相对关键字（今天/明天/后天）到期点的**钉死缓存**（`manage` 进 Tauri 状态）。
///
/// 「@今天 16:00」第一次扫到时按当天解析并记进这里，之后隔夜/隔天重扫都用钉住的
/// 绝对时刻——否则每次刷新都用当天重解，「今天」每天漂移成新的到期点，提醒键
/// （含 due_ms）跟着换，同一条没勾的任务**每天重响一次**（审计 P2#3，与实施方案
/// §11.4「钉死成绝对日期」相反）。
///
/// 键 = `note_id:line:{due_raw原文}`——用户改了时间文字（今天→明天）就是新键，
/// 按当天重新钉，改期意图不受影响。任务消失的当轮 prune。
#[derive(Default)]
pub struct DuePinCache(Mutex<HashMap<String, DueSpec>>);

/// 全量算一份岛状态。**只读**（缓存是内部的加速结构，不对外可见）。
pub fn compute_island_state(
    store: &DataStore,
    cache: &TodoScanCache,
    pins: &DuePinCache,
) -> Result<IslandState, String> {
    let index = store.note_active_task_index()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    // 🔴 缓存锁只罩内存操作（retain + 快照 + 回填），**绝不跨 SQLite IO**——
    //    compute 在每次笔记写路径里被同步调（refresh_island），持锁跨 IO 会把
    //    首扫期间的所有写命令卡到扫描放锁（审计 P2#7）。代价是并发的两次 compute
    //    可能重复解析同一篇（幂等，无害）。
    let snapshot: HashMap<String, CachedNote> = {
        let mut map = cache.0.lock().map_err(|_| "扫描缓存锁中毒")?;
        let alive: HashSet<&str> = index.iter().map(|(id, ..)| id.as_str()).collect();
        // 删掉的笔记（软删 / 彻底删）从缓存里清出去，别让它越积越大
        map.retain(|id, _| alive.contains(id.as_str()));
        std::mem::take(&mut *map)
    };

    let mut notes: Vec<ScanNote> = Vec::with_capacity(index.len());
    let mut fresh: Vec<(String, CachedNote)> = Vec::new();
    for (id, title, ms, daily) in &index {
        let tasks = match snapshot.get(id) {
            // 标题一起比：改标题也会 bump updated_ms，但别赌——比一个字符串很便宜
            Some(c) if c.updated_ms == *ms && c.title == *title => c.tasks.clone(),
            _ => {
                let content = store.note_content_raw(id)?.unwrap_or_default();
                let parsed = parse_tasks(&content);
                fresh.push((
                    id.clone(),
                    CachedNote { updated_ms: *ms, title: title.clone(), tasks: parsed.clone() },
                ));
                parsed
            }
        };
        notes.push(ScanNote {
            today_daily: daily.as_deref() == Some(today.as_str()),
            updated_ms: *ms,
            id: id.clone(),
            title: title.clone(),
            tasks,
        });
    }
    // 回填缓存（纯内存，短临界区）
    {
        let mut map = cache.0.lock().map_err(|_| "扫描缓存锁中毒")?;
        for (id, c) in fresh {
            map.insert(id, c);
        }
    }

    // 稳定排序：同 ms 的保持索引顺序（rowid），结果可复现
    notes.sort_by(|a, b| b.today_daily.cmp(&a.today_daily).then(b.updated_ms.cmp(&a.updated_ms)));

    let (mut total, mut done) = (0u32, 0u32);
    let mut pending: Vec<IslandTask> = Vec::new();
    let mut finished: Vec<IslandTask> = Vec::new();
    // 截止时刻与展示文案在**每次刷新现算**（label 依赖「今天」，缓存会隔夜说假话）
    let now = chrono::Local::now();
    // 钉死账整轮只拿一次锁（纯内存操作）；本轮用到的键记下来，收账时 prune
    let mut pin_map = pins.0.lock().map_err(|_| "到期钉死缓存锁中毒")?;
    let mut used_pins: HashSet<String> = HashSet::new();
    for n in &notes {
        for t in &n.tasks {
            total += 1;
            let due: Option<DueSpec> = match &t.due_raw {
                None => None,
                // 数字日期本来就是绝对的，无需钉
                Some(raw) if raw.rel_day.is_none() => resolve_due(raw, now),
                Some(raw) => {
                    let key = format!("{}:{}:{:?}", n.id, t.line, raw);
                    used_pins.insert(key.clone());
                    match pin_map.get(&key) {
                        Some(pinned) => Some(pinned.clone()),
                        None => {
                            let spec = resolve_due(raw, now);
                            if let Some(s) = &spec {
                                pin_map.insert(key, s.clone());
                            }
                            spec
                        }
                    }
                }
            };
            let item = IslandTask {
                note_id: n.id.clone(),
                note_title: n.title.clone(),
                line: t.line,
                text: t.display.clone(),
                done: t.done,
                due_ms: due.as_ref().map(|d| d.at_ms),
                due_has_time: due.as_ref().is_some_and(|d| d.has_time),
                due_label: due.as_ref().map(|d| due_label(d.at_ms, d.has_time, now)),
            };
            if t.done {
                done += 1;
                if finished.len() < MAX_LIST_TASKS {
                    finished.push(item);
                }
            } else {
                // ❗ pending 先**不截断**——截断必须发生在排序之后（见下）
                pending.push(item);
            }
        }
    }
    // 钉死账 prune：本轮没出现的键（任务删了/改了时间文字）清出去
    pin_map.retain(|k, _| used_pins.contains(k));
    drop(pin_map);

    // 排序：默认「到期优先」（拍板 2026-09-25）——有截止时间的按时刻升序排最前；
    // 没时间的维持原口径（今天速记 → updated_ms 降序）。稳定排序，结果可复现。
    // `todo_island_due_sort=false`（设置页可关）= 回到创建顺序，让排序这种主观偏好有出口。
    let due_sort = store
        .get_config()
        .map(|c| c.get("todo_island_due_sort").and_then(|v| v.as_bool()).unwrap_or(true))
        .unwrap_or(true);
    if due_sort {
        pending.sort_by(|a, b| match (a.due_ms, b.due_ms) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
    }
    // 🔴 截断在排序**之后**：>50 条时被截掉的才是最不紧的那批。原来截在排序前，
    //    排第 51 位的「@今天 18:00」既不显示也不提醒（审计 P1#2）。
    //    （due_sort 关闭 + >50 条 = 按创建顺序保前 50，提醒只覆盖展示列表——
    //    设置项文案承诺的就是「按创建顺序显示」，这是该口径下的已知边界。）
    pending.truncate(MAX_LIST_TASKS);
    let hint = pending
        .first()
        .map(|t| t.text.clone())
        .unwrap_or_else(|| if total > 0 { "全部完成".to_string() } else { String::new() });

    // due_alert 不在这里填——注入收口在 todo_island::push_state / inject_remind
    Ok(IslandState { total, done, hint, tasks: pending, done_tasks: finished, due_alert: None })
}

// ===== 推送与命令 =====

/// 重扫一遍并把新状态推进岛。
///
/// 这是**所有**笔记写路径共用的唯一推送出口（见模块头部的挂钩表）。
/// 返回扫到的状态（`toggle` 等调用方可以顺手用）；store 未就绪或扫描失败
/// 返回 `None`——岛是反馈层，扫描挂了不许把主流程带挂。
pub fn refresh_island(app: &AppHandle) -> Option<IslandState> {
    let store = app.try_state::<DataStore>()?;
    let scan = app.try_state::<TodoScanCache>()?;
    let pins = app.try_state::<DuePinCache>()?;
    match compute_island_state(&store, &scan, &pins) {
        Ok(state) => {
            crate::todo_island::push_state(app, state.clone());
            apply_resident_visibility(app, &state);
            Some(state)
        }
        Err(e) => {
            log::warn!("[TodoIsland] 待办扫描失败: {e}");
            None
        }
    }
}

/// 常驻可见性（2026-09-24 用户拍板「本批转常驻」）：**有待办 → 在，全清 → 收**。
///
/// - pending > 0：`show`（幂等；已显示时只重定位，被全屏拦下时走复活轮询）；
/// - pending == 0：`hide_after(1500)` —— 给全清态留 1.5s 的可见时间再收。
///   岛本就没显示时 `hide` 是空操作；期间再来待办会被 `show` 的代次作废（B1 已验）。
///   前端全清流程也会发一次同样的请求，两边都幂等，重复无副作用。
fn apply_resident_visibility(app: &AppHandle, state: &IslandState) {
    let pending = state.total.saturating_sub(state.done);
    if pending > 0 {
        crate::todo_island::show(app);
    } else if matches!(
        crate::todo_island_stage::current_stage(),
        crate::todo_island_stage::IslandStage::Pill
            | crate::todo_island_stage::IslandStage::Peek
            | crate::todo_island_stage::IslandStage::Clear
    ) {
        crate::todo_island::hide_after(app, 1500);
    }
    // 展开态（list/compose）且剩 0 条：**不抢**——用户正在操作（审计：勾完最后
    // 一条列表被强制收走）。收起那一刻前端会按「剩 0 条」发延迟隐藏；鼠标离开
    // 6s 的闲置自收（前端）也会兜底收掉，不存在「空岛永久挂着」。
}

/// 拉一份**现算**的岛状态。岛 mount / 每次显示时调。
///
/// 与 `todo_island_state`（读缓存快照）的区别：这条会真扫一遍库，
/// 是同步引擎直写路径（无钩子）能被岛看到的唯一通道。
#[tauri::command]
pub fn todo_island_tasks(
    app: AppHandle,
    store: State<'_, DataStore>,
    scan: State<'_, TodoScanCache>,
    pins: State<'_, DuePinCache>,
) -> Result<IslandState, String> {
    let mut state = compute_island_state(&store, &scan, &pins)?;
    // 岛显示时的拉快照路径同样要带横幅（注入收口在 todo_island::inject_remind）
    if let Some(ledger) = app.try_state::<crate::todo_island::RemindLedger>() {
        crate::todo_island::inject_remind(&ledger, &mut state);
    }
    if let Some(cache) = app.try_state::<crate::todo_island::IslandStateCache>() {
        if let Ok(mut guard) = cache.0.lock() {
            *guard = Some(state.clone());
        }
    }
    Ok(state)
}

/// 勾选/取消一条待办。**写回走既有 `note_update`**（禁裸 SQL，实施方案 §5 #9：
/// 版本快照、`updated_ms`、同步可见性都是它顺带保证的）。
///
/// 行号漂移（`ToggleError`）在这里落成错误字符串返回，岛端据此整体刷新——
/// 不静默改别的行。成功后顺手把主窗口通知出去：若该笔记正在编辑器里开着且
/// 有未保存改动，用户需要知道库里的内容刚刚变了（实施方案 §6 风险 7）。
/// 勾选回写**串行锁**：读-改-写三步必须原子。岛端快速连点两条会并发读同一份
/// 正文、后写的整文覆盖先写的（丢勾选，审计 P2#6）。勾选是低频操作，全局串行
/// 没有争用之虞；锁中毒按恢复处理（它只管串行化，不保护不变量）。
static TOGGLE_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub fn todo_island_toggle_task(
    app: AppHandle,
    store: State<'_, DataStore>,
    note_id: String,
    line: usize,
    expected_text: String,
) -> Result<IslandState, String> {
    let _serial = TOGGLE_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let note = store
        .note_get(&note_id)?
        .ok_or_else(|| "笔记不存在，可能已被删除".to_string())?;
    let content = match apply_toggle(&note.content, line, &expected_text) {
        Ok(c) => c,
        Err(e) => {
            // 失败也要推一把：岛端刚做过乐观翻面，把库里的真实现状推过去，
            // 它的乐观标记会被对账逻辑丢掉、UI 自愈——而不是等下次显示（规则 #15.3）
            refresh_island(&app);
            return Err(format!("勾选失败（{e:?}）：笔记内容已被其它途径修改"));
        }
    };
    store.note_update(&note_id, &note.title, &content)?;
    let _ = app.emit_to("main", "todo-island-toggled", &note_id);
    refresh_island(&app).ok_or_else(|| "勾选已保存，但岛状态刷新失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- parse_tasks -----

    #[test]
    fn test_parse_basic_gfm_forms() {
        let ts = parse_tasks("- [ ] 买牛奶\n- [x] 已办\n- [X] 大写也算\n* [ ] 星号列表\n+ [ ] 加号列表");
        assert_eq!(ts.len(), 5);
        assert_eq!(
            ts[0],
            ParsedTask {
                line: 0,
                text: "买牛奶".into(),
                done: false,
                display: "买牛奶".into(),
                due_raw: None
            }
        );
        assert_eq!(
            ts[1],
            ParsedTask {
                line: 1,
                text: "已办".into(),
                done: true,
                display: "已办".into(),
                due_raw: None
            }
        );
        assert_eq!(
            ts[2],
            ParsedTask {
                line: 2,
                text: "大写也算".into(),
                done: true,
                display: "大写也算".into(),
                due_raw: None
            }
        );
        assert_eq!(ts[3].text, "星号列表");
        assert_eq!(ts[4].text, "加号列表");
    }

    #[test]
    fn test_parse_rejects_lookalikes() {
        // 这一批**一条都不许中**：类别行、空括号、缺空格、连写、纯勾孤行
        let ts = parse_tasks(
            "- [todo] 类别行撞车\n- [] 空括号\n- [1] 编号\n-[ ] 缺空格\n\
             - [ ]文字 连写\n* [] 星号空括\n- [ ]   \n- [x]",
        );
        assert!(ts.is_empty(), "形近语法全都不许被当成待办，实际扫出 {ts:?}");
    }

    #[test]
    fn test_parse_skips_code_fences() {
        let ts = parse_tasks(
            "- [ ] 真任务\n```rust\nlet s = \"- [ ] 代码里的假任务\";\n// - [ ] 注释里的也是\n```\n- [x] 第二个真任务",
        );
        assert_eq!(ts.len(), 2, "代码块里的复选框不是待办");
        assert_eq!(ts[0].line, 0);
        assert_eq!(ts[1].line, 5);
    }

    #[test]
    fn test_parse_skips_indented_code_block() {
        // 缩进 4+ = 缩进代码块（GFM），与 fence_at 的 3 空格界一致
        let ts = parse_tasks("- [ ] 真任务\n    - [ ] 缩进代码块里的\n-\t[ ] 制表缩进也拒");
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].line, 0);
    }

    #[test]
    fn test_parse_accepts_mild_indent_and_keeps_line_numbers() {
        let ts = parse_tasks("前文\n  - [ ] 两格缩进的嵌套子任务");
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].line, 1);
        assert_eq!(ts[0].text, "两格缩进的嵌套子任务");
    }

    #[test]
    fn test_parse_fence_rules_match_annotate() {
        // 围栏要「同字符 + 长度不小于开栏」才能闭栏——与 annotate 同一份 fence_at，
        // ````（4）按「不短于开栏」闭掉 ```（3）：第 3 行已在栏外（任务），
        // 第 4 行 ``` 重开栏、第 5 行在栏内。钉住行为级语义防日后换判定而不自知。
        let ts = parse_tasks("```\n- [ ] a\n````\n- [ ] 更长的反引号还在栏内\n```\n- [ ] 栏外");
        assert_eq!(ts.len(), 1, "闭栏后到重开栏之间的是任务，重开栏内的是代码");
        assert_eq!(ts[0].text, "更长的反引号还在栏内");
        assert_eq!(ts[0].line, 3);
    }

    // ----- flip_task_line / apply_toggle -----

    #[test]
    fn test_flip_preserves_layout_and_roundtrips() {
        for raw in ["- [ ] 买牛奶", "- [x] 已办", "  - [x] 缩进", "* [ ] 星号", "+ [x] 加号"] {
            let flipped = flip_task_line(raw).unwrap();
            let re = flip_task_line(&flipped).unwrap();
            assert_eq!(re, raw, "翻两次必须回到原样：{raw}");
            // 只动方括号里那一个字符
            let diff: Vec<_> = raw
                .chars()
                .zip(flipped.chars())
                .filter(|(a, b)| a != b)
                .collect();
            assert_eq!(diff.len(), 1, "翻转只许动一个字符：{raw} -> {flipped}");
        }
    }

    #[test]
    fn test_flip_uppercase_x_unchecks() {
        // [X] 取消后是空格；再勾上落回小写 x（GFM 里两者等价，不保形是接受的代价）
        assert_eq!(flip_task_line("- [X] 大写").as_deref(), Some("- [ ] 大写"));
    }

    #[test]
    fn test_flip_rejects_non_tasks() {
        assert!(flip_task_line("- [todo] 类别行").is_none());
        assert!(flip_task_line("普通文字").is_none());
        assert!(flip_task_line("- [ ]").is_none());
    }

    #[test]
    fn test_apply_toggle_ok_and_errors() {
        let content = "- [ ] 甲\n中间的普通行\n- [x] 乙";
        assert_eq!(apply_toggle(content, 0, "甲").unwrap(), "- [x] 甲\n中间的普通行\n- [x] 乙");
        assert_eq!(apply_toggle(content, 2, "乙").unwrap(), "- [ ] 甲\n中间的普通行\n- [ ] 乙");
        assert_eq!(apply_toggle(content, 9, "甲"), Err(ToggleError::OutOfRange));
        assert_eq!(apply_toggle(content, 1, "中间的普通行"), Err(ToggleError::NotTask));
        assert_eq!(apply_toggle(content, 0, "不是甲"), Err(ToggleError::TextDrift));
    }

    // ----- compute_island_state（真库集成路径） -----

    #[test]
    fn test_compute_counts_and_orders_and_caps() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        // 普通笔记：2 未完成 + 1 已完成
        store
            .note_create(None, "普通", "- [ ] 普通一\n- [x] 普通完\n- [ ] 普通二")
            .unwrap();
        // 今天的速记：1 未完成 —— 应排最前
        store.note_append_daily(&today, "08:00", None, "- [ ] 速记一").unwrap();

        let st = compute_island_state(&store, &cache, &DuePinCache::default()).unwrap();
        assert_eq!(st.total, 4, "total 是全库口径（含已完成）");
        assert_eq!(st.done, 1);
        assert_eq!(st.tasks.len(), 3);
        assert_eq!(st.tasks[0].text, "速记一", "今天的速记排最前");
        assert_eq!(st.hint, "速记一");

        // 勾掉普通一 → 重扫反映新状态（updated_ms 变了必须重扫，这是缓存正确性的根）
        let note = store.note_get(&st.tasks[1].note_id).unwrap().unwrap();
        let next = apply_toggle(&note.content, 0, "普通一").unwrap();
        store.note_update(&note.id, &note.title, &next).unwrap();
        let st2 = compute_island_state(&store, &cache, &DuePinCache::default()).unwrap();
        assert_eq!(st2.total, 4);
        assert_eq!(st2.done, 2, "勾选后 done 必须 +1");
        assert_eq!(st2.tasks.len(), 2);
    }

    #[test]
    fn test_compute_excludes_deleted_and_purged() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        let keep = store.note_create(None, "留", "- [ ] 留下的").unwrap();
        let gone = store.note_create(None, "删", "- [ ] 删掉的").unwrap();
        store.note_delete(&gone.id).unwrap();
        let st = compute_island_state(&store, &cache, &DuePinCache::default()).unwrap();
        assert_eq!(st.total, 1);
        assert_eq!(st.tasks[0].note_id, keep.id);

        // 软删恢复后回来
        store.note_restore_deleted(&gone.id).unwrap();
        let st2 = compute_island_state(&store, &cache, &DuePinCache::default()).unwrap();
        assert_eq!(st2.total, 2, "恢复后必须重新出现");
    }

    #[test]
    fn test_compute_caps_pending_list_but_counts_all() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        let mut body = String::new();
        for i in 0..(MAX_LIST_TASKS + 10) {
            body.push_str(&format!("- [ ] 任务{i}\n"));
        }
        store.note_create(None, "长单", &body).unwrap();
        let st = compute_island_state(&store, &cache, &DuePinCache::default()).unwrap();
        assert_eq!(st.total as usize, MAX_LIST_TASKS + 10, "计数不给截断");
        assert_eq!(st.tasks.len(), MAX_LIST_TASKS, "列表给截断（payload 上限）");
    }

    // ----- 截止时间（due_tail / resolve_due / due_label / 排序） -----

    /// 固定「今天」做解析，测出的是纯逻辑而非时钟
    fn today() -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(2026, 9, 25, 10, 0, 0).unwrap()
    }

    #[test]
    fn test_due_tail_all_formats() {
        let (d, r) = due_tail("交报告 @今天 16:00");
        assert_eq!(d, "交报告");
        let r = r.unwrap();
        assert!(r.has_time);
        assert_eq!(resolve_due(&r, today()).unwrap().at_ms,
            chrono::Local.with_ymd_and_hms(2026, 9, 25, 16, 0, 0).unwrap().timestamp_millis());

        // 明天 / 后天 / 无时间（全天）
        assert_eq!(due_tail("买牛奶 @明天").1.unwrap().rel_day, Some(1));
        let (d, r) = due_tail("扫 @后天 9:30");
        assert_eq!(d, "扫");
        let spec = resolve_due(&r.unwrap(), today()).unwrap();
        assert_eq!(spec.at_ms,
            chrono::Local.with_ymd_and_hms(2026, 9, 27, 9, 30, 0).unwrap().timestamp_millis());

        // 数字日期：M/D、MM-DD、带年；无年早于今天顺延明年
        assert_eq!(due_tail("x @9/28 9:00").1.unwrap().month, 9);
        assert_eq!(due_tail("x @09-28").1.unwrap().day, 28);
        assert_eq!(due_tail("x @2026-09-26 18:00").1.unwrap().year, Some(2026));
        let next_year = due_tail("x @1/1").1.unwrap();
        assert_eq!(resolve_due(&next_year, today()).unwrap().at_ms,
            chrono::Local.with_ymd_and_hms(2027, 1, 1, 23, 59, 59).unwrap().timestamp_millis(),
            "无年日期早于今天 → 顺延明年；全天 = 23:59:59");
    }

    #[test]
    fn test_due_tail_rejects() {
        for s in [
            "邮箱@example.com 记一下", // @ 在词中
            "@今天 开完再说",          // @在开头（展示文字为空）
            "交报告 @今天 下午再说",    // @后三个词
            "交报告 @13/45",           // 非法日期
            "交报告 @25:00",           // 非法时间
            "交报告 @今天25:00",       // 时间贴着日期没有空格 → 日期词整体非法
            "交报告",                  // 没有尾巴
        ] {
            let (d, r) = due_tail(s);
            assert!(r.is_none(), "{s} 不该认出尾巴");
            assert_eq!(d, s, "{s} 原文必须原样保留");
        }
    }

    #[test]
    fn test_due_label_forms() {
        let today5 = chrono::Local.with_ymd_and_hms(2026, 9, 25, 16, 0, 0).unwrap().timestamp_millis();
        assert_eq!(due_label(today5, true, today()), "今天 16:00");
        let tomorrow = chrono::Local.with_ymd_and_hms(2026, 9, 26, 23, 59, 59).unwrap().timestamp_millis();
        assert_eq!(due_label(tomorrow, false, today()), "明天到期");
        let eoy = chrono::Local.with_ymd_and_hms(2026, 12, 1, 9, 5, 0).unwrap().timestamp_millis();
        assert_eq!(due_label(eoy, true, today()), "12/1 9:05");
        let next_year = chrono::Local.with_ymd_and_hms(2027, 1, 2, 8, 0, 0).unwrap().timestamp_millis();
        assert_eq!(due_label(next_year, true, today()), "2027.1/2 8:00");
    }

    #[test]
    fn test_pending_sort_due_first() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        // 建库顺序：先建无时间的（updated_ms 更早），再建有时间的——到期优先必须盖过 updated_ms
        store.note_create(None, "普通", "- [ ] 无时间甲\n- [ ] 无时间乙").unwrap();
        store
            .note_create(None, "限时", "- [ ] 后天的事 @后天 9:00\n- [ ] 明天的事 @明天 8:00")
            .unwrap();
        let st = compute_island_state(&store, &cache, &DuePinCache::default()).unwrap();
        let texts: Vec<&str> = st.tasks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec!["明天的事", "后天的事", "无时间甲", "无时间乙"]);
        assert_eq!(st.tasks[0].due_label.as_deref(), Some("明天 8:00"));
        assert!(st.tasks[2].due_ms.is_none());
    }

    #[test]
    fn test_toggle_with_due_tail_roundtrip() {
        // 带尾巴的任务：岛里展示「交报告」，勾选比对走剥尾文字，正文尾巴原样保留
        let content = "- [ ] 交报告 @今天 16:00";
        let ts = parse_tasks(content);
        assert_eq!(ts[0].display, "交报告");
        let flipped = apply_toggle(content, 0, "交报告").unwrap();
        assert_eq!(flipped, "- [x] 交报告 @今天 16:00", "尾巴不许被改写");
        // 勾掉后（[x]），tail 解析照常
        let back = apply_toggle(&flipped, 0, "交报告").unwrap();
        assert_eq!(back, content, "往返还原");
    }

    // ----- 2026-09-25 审计修复的守卫 -----

    /// 🔴 P1#2 守卫：截断必须发生在到期排序**之后**——未完成 >50 条时，
    /// 带截止时间的任务哪怕写在最后也必须进列表、能被提醒挑选到。
    #[test]
    fn test_compute_truncates_after_due_sort() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        let pins = DuePinCache::default();
        let mut body = String::new();
        for i in 0..(MAX_LIST_TASKS - 5) {
            body.push_str(&format!("- [ ] 无期任务{i}\n"));
        }
        // 15 条带截止时间的排在正文最末（创建顺序里最靠后）
        for i in 0..15 {
            body.push_str(&format!("- [ ] 紧急任务{i} @明天 18:00\n"));
        }
        store.note_create(None, "长单", &body).unwrap();
        let st = compute_island_state(&store, &cache, &pins).unwrap();
        assert_eq!(st.tasks.len(), MAX_LIST_TASKS);
        let kept_due = st
            .tasks
            .iter()
            .filter(|t| t.text.starts_with("紧急任务"))
            .count();
        assert_eq!(kept_due, 15, "15 条到期任务必须全部进前 50（截断在排序后）");
        assert!(
            st.tasks.iter().take(15).all(|t| t.text.starts_with("紧急任务")),
            "到期优先：紧急任务必须占据列表最前"
        );
    }

    /// 🔴 P2#3 守卫：相对关键字（@明天）的到期点**钉死**在缓存里——重扫不得
    /// 按当天重新解析（否则每天漂移成新到期点、提醒键跟着换、每天重响）。
    #[test]
    fn test_pin_cache_stabilizes_relative_due() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        let pins = DuePinCache::default();
        store.note_create(None, "记", "- [ ] 交报告 @明天 18:00").unwrap();

        let st = compute_island_state(&store, &cache, &pins).unwrap();
        let due1 = st.tasks[0].due_ms.expect("相对关键字要有到期点");

        // 模拟「隔天重扫」：把钉死账改成哨兵值，再扫一次——若实现还在用当天
        // 重解，due_ms 会变回新解的值而不是哨兵
        const SENTINEL: i64 = 1_234_567_890_000;
        {
            let mut map = pins.0.lock().unwrap();
            for (_, v) in map.iter_mut() {
                *v = DueSpec { at_ms: SENTINEL, has_time: true };
            }
        }
        let st2 = compute_island_state(&store, &cache, &pins).unwrap();
        assert_eq!(
            st2.tasks[0].due_ms,
            Some(SENTINEL),
            "重扫必须用钉死的到期点，不得按当天重解"
        );
        assert_ne!(due1, SENTINEL, "哨兵必须与首扫值不同，否则测了个寂寞");
    }

    /// 钉死账的 prune：任务删了，对应的键不能留着（防长期挂机内存缓涨）。
    #[test]
    fn test_pin_cache_prunes_gone_tasks() {
        let store = DataStore::new(":memory:").expect("内存库");
        let cache = TodoScanCache::default();
        let pins = DuePinCache::default();
        let note = store.note_create(None, "记", "- [ ] 交报告 @明天 18:00").unwrap();
        compute_island_state(&store, &cache, &pins).unwrap();
        assert!(!pins.0.lock().unwrap().is_empty(), "首扫后应有钉死记录");

        store.note_delete(&note.id).unwrap();
        compute_island_state(&store, &cache, &pins).unwrap();
        assert!(pins.0.lock().unwrap().is_empty(), "任务没了，钉死账必须清出去");
    }

    /// P3#20 守卫：全角冒号时间可用；「时间未遂」（带数字的非法时间）降级成
    /// 全天日期；纯文字词（下午再说）是正文，整条尾巴照旧作废。
    #[test]
    fn test_due_tail_fullwidth_colon_and_degrade() {
        let (_, r) = due_tail("交报告 @今天 16：00");
        let r = r.expect("全角冒号必须能解析");
        assert!(r.has_time);
        assert_eq!((r.hour, r.minute), (16, 0));

        // 时间未遂：日期保留、降级全天（不再整条作废让提醒悄悄消失）
        let (d, r) = due_tail("交报告 @今天 下午3点");
        assert_eq!(d, "交报告");
        let r = r.expect("日期部分必须保留");
        assert!(!r.has_time, "时间未遂降级成全天");

        // 纯文字词是正文：整条尾巴无效，原文保留
        let (d, r) = due_tail("交报告 @今天 下午再说");
        assert!(r.is_none(), "纯文字词不是时间");
        assert_eq!(d, "交报告 @今天 下午再说");
    }

    /// P3#19 守卫：GFM 有序列表上的任务复选框要认、要能勾（岛看得见才谈得上提醒）。
    #[test]
    fn test_ordered_list_tasks_recognized_and_flippable() {
        assert_eq!(task_at("1. [ ] 甲").unwrap(), ("甲".to_string(), false));
        assert_eq!(task_at("12) [x] 乙").unwrap(), ("乙".to_string(), true));
        // 数字开头但不是列表项的行不许误认
        assert!(task_at("3.14 圆周率").is_none());
        assert!(task_at("2026-09-26 截止").is_none());
        assert!(task_at("1.[ ] 连写不是任务").is_none());
        assert!(task_at("1. [todo] 类别行").is_none());
        // 勾选回写走同一条路
        let content = "前言\n1. [ ] 甲\n后记";
        assert_eq!(apply_toggle(content, 1, "甲").unwrap(), "前言\n1. [x] 甲\n后记");
        assert_eq!(flip_task_line("12) [X] 乙").as_deref(), Some("12) [ ] 乙"));
    }
}
