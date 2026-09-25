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
//! ## 排序口径（「今天该做什么」）
//!
//! 1. 今天速记（`daily_date == 今天`）里的待办排最前——立项 §2.5 拍板的
//!    「隐式到期日」：速记记在哪天，哪天就是它的到期日；
//! 2. 其余按笔记 `updated_ms` 降序（最近动过的优先）。
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
    /// 任务文字（`- [ ] ` 之后的部分，已 trim）
    pub text: String,
    pub done: bool,
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
    pub text: String,
    pub done: bool,
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
            out.push(ParsedTask { line: i, text, done });
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
    let rest = trimmed
        .strip_prefix(['-', '*', '+'])?
        .strip_prefix(' ')?
        .strip_prefix('[')?;
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

/// 翻转一行任务复选框的勾选态，**只动方括号里那一个字符**。
///
/// 缩进、bullet 字符、`[X]` 的原样性全保留——用户写的是 `- [X]`，回写就还是
/// `- [X]` 换成 `- [ ]`，不许悄悄改写别人的排版。
/// 返回 `None` = 这行不是任务行（调用方应视为行号漂移）。
pub fn flip_task_line(raw: &str) -> Option<String> {
    // 先验形状：bullet 后必须恰好一个空格接 `[`，mark 恒在 lead+3
    task_at(raw)?;
    let lead = raw.len() - raw.trim_start().len();
    let mark_idx = lead + 3; // bullet(1) + space(1) + '['(1)，全是 ASCII，必是字符边界
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
    let (text, _) = task_at(raw).ok_or(ToggleError::NotTask)?;
    if text != expected_text.trim() {
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

/// 全量算一份岛状态。**只读**（缓存是内部的加速结构，不对外可见）。
pub fn compute_island_state(
    store: &DataStore,
    cache: &TodoScanCache,
) -> Result<IslandState, String> {
    let index = store.note_active_task_index()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    let mut map = cache.0.lock().map_err(|_| "扫描缓存锁中毒")?;
    let alive: HashSet<&str> = index.iter().map(|(id, ..)| id.as_str()).collect();
    // 删掉的笔记（软删 / 彻底删）从缓存里清出去，别让它越积越大
    map.retain(|id, _| alive.contains(id.as_str()));

    let mut notes: Vec<ScanNote> = Vec::with_capacity(index.len());
    for (id, title, ms, daily) in &index {
        let tasks = match map.get(id) {
            // 标题一起比：改标题也会 bump updated_ms，但别赌——比一个字符串很便宜
            Some(c) if c.updated_ms == *ms && c.title == *title => c.tasks.clone(),
            _ => {
                let content = store.note_content_raw(id)?.unwrap_or_default();
                let parsed = parse_tasks(&content);
                map.insert(
                    id.clone(),
                    CachedNote { updated_ms: *ms, title: title.clone(), tasks: parsed.clone() },
                );
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
    // 汇总不碰缓存，先放锁
    drop(map);

    // 稳定排序：同 ms 的保持索引顺序（rowid），结果可复现
    notes.sort_by(|a, b| b.today_daily.cmp(&a.today_daily).then(b.updated_ms.cmp(&a.updated_ms)));

    let (mut total, mut done) = (0u32, 0u32);
    let mut pending: Vec<IslandTask> = Vec::new();
    let mut finished: Vec<IslandTask> = Vec::new();
    for n in &notes {
        for t in &n.tasks {
            total += 1;
            let item = IslandTask {
                note_id: n.id.clone(),
                note_title: n.title.clone(),
                line: t.line,
                text: t.text.clone(),
                done: t.done,
            };
            if t.done {
                done += 1;
                if finished.len() < MAX_LIST_TASKS {
                    finished.push(item);
                }
            } else if pending.len() < MAX_LIST_TASKS {
                pending.push(item);
            }
        }
    }
    let hint = pending
        .first()
        .map(|t| t.text.clone())
        .unwrap_or_else(|| if total > 0 { "全部完成".to_string() } else { String::new() });

    Ok(IslandState { total, done, hint, tasks: pending, done_tasks: finished })
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
    match compute_island_state(&store, &scan) {
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
    } else {
        crate::todo_island::hide_after(app, 1500);
    }
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
) -> Result<IslandState, String> {
    let state = compute_island_state(&store, &scan)?;
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
#[tauri::command]
pub fn todo_island_toggle_task(
    app: AppHandle,
    store: State<'_, DataStore>,
    note_id: String,
    line: usize,
    expected_text: String,
) -> Result<IslandState, String> {
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
        assert_eq!(ts[0], ParsedTask { line: 0, text: "买牛奶".into(), done: false });
        assert_eq!(ts[1], ParsedTask { line: 1, text: "已办".into(), done: true });
        assert_eq!(ts[2], ParsedTask { line: 2, text: "大写也算".into(), done: true });
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

        let st = compute_island_state(&store, &cache).unwrap();
        assert_eq!(st.total, 4, "total 是全库口径（含已完成）");
        assert_eq!(st.done, 1);
        assert_eq!(st.tasks.len(), 3);
        assert_eq!(st.tasks[0].text, "速记一", "今天的速记排最前");
        assert_eq!(st.hint, "速记一");

        // 勾掉普通一 → 重扫反映新状态（updated_ms 变了必须重扫，这是缓存正确性的根）
        let note = store.note_get(&st.tasks[1].note_id).unwrap().unwrap();
        let next = apply_toggle(&note.content, 0, "普通一").unwrap();
        store.note_update(&note.id, &note.title, &next).unwrap();
        let st2 = compute_island_state(&store, &cache).unwrap();
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
        let st = compute_island_state(&store, &cache).unwrap();
        assert_eq!(st.total, 1);
        assert_eq!(st.tasks[0].note_id, keep.id);

        // 软删恢复后回来
        store.note_restore_deleted(&gone.id).unwrap();
        let st2 = compute_island_state(&store, &cache).unwrap();
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
        let st = compute_island_state(&store, &cache).unwrap();
        assert_eq!(st.total as usize, MAX_LIST_TASKS + 10, "计数不给截断");
        assert_eq!(st.tasks.len(), MAX_LIST_TASKS, "列表给截断（payload 上限）");
    }
}
