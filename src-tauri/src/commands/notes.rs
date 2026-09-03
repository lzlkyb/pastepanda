//! 笔记命令层（知识库 A 阶段 · 规划 §8.1 3️⃣）。
//!
//! 这一层**只做转发**，业务逻辑全在 `data_store::note`。之所以还是薄薄一层而不是
//! 让前端直接 invoke store：Tauri 命令是唯一的 IPC 边界，参数在这里从 `Option<String>`
//! 落成 `Option<&str>`，分页上限也在这里兜住。
//!
//! 🔴 红线（规划 §0）：本文件不含任何 AI 调用。笔记正文只进本机 SQLite 与本机 FTS，
//! 不出网。要给笔记加 AI 能力（摘要 / 打标签）是 B 阶段的事，且必须受 AI 总开关控制
//! （规则 #16），届时应新建独立文件，不要往这里塞。

use crate::data_store::{DataStore, Note, NoteGroupCount, NoteViewOpts};
use tauri::State;

/// 单次拉取上限。前端传多少都不能越过它——列表虚拟滚动一屏几十条，
/// 一次要上万条只可能是调用方写错了，静默照做会把整库读进内存。
const MAX_PAGE: u32 = 500;

/// 把前端传来的 limit 规范化：缺省 50，0 视为缺省，上限 `MAX_PAGE`。
fn clamp_limit(limit: Option<u32>) -> u32 {
    match limit {
        Some(n) if n > 0 => n.min(MAX_PAGE),
        _ => 50,
    }
}

/// 新建笔记。`history_id` 为空 = 与剪贴板无关的独立笔记。
///
/// 注意：**幂等不在这里**。「同一张卡片重复转笔记 → 打开已有那条」是入口的语义，
/// 由前端先调 `note_by_history` 判断（拿到的就是要编辑的那条，多一次 IPC 但少一次
/// 猜测）。若哪天需要后端保证唯一，那是加 UNIQUE 约束的事，不是在命令里查一遍。
#[tauri::command]
pub fn note_create(
    store: State<DataStore>,
    history_id: Option<String>,
    title: String,
    content: String,
) -> Result<Note, String> {
    store.note_create(history_id.as_deref(), &title, &content)
}

/// 改标题与正文。id 不存在会报错而非静默成功（规则 #15.3）。
#[tauri::command]
pub fn note_update(
    store: State<DataStore>,
    id: String,
    title: String,
    content: String,
) -> Result<(), String> {
    store.note_update(&id, &title, &content)
}

/// 删笔记。只删笔记，**不动来源卡片**（规划 §6 生命周期：两者互不牵连）。
#[tauri::command]
pub fn note_delete(store: State<DataStore>, id: String) -> Result<(), String> {
    store.note_delete(&id)
}

/// 切换置顶（B1）。返回切完之后的状态。
#[tauri::command]
pub fn note_toggle_pin(store: State<DataStore>, id: String) -> Result<bool, String> {
    store.note_toggle_pin(&id)
}

/// 回收站条数（侧栏计数用）。
#[tauri::command]
pub fn note_count_deleted(store: State<DataStore>) -> i64 {
    store.note_count_deleted()
}

/// 回收站列表，按删除时间倒序（W1）。
#[tauri::command]
pub fn note_list_deleted(store: State<DataStore>, limit: u32) -> Result<Vec<Note>, String> {
    store.note_list_deleted(limit)
}

/// 从回收站恢复。速记日期已被占时会报错（而非静默失败）。
#[tauri::command]
pub fn note_restore_deleted(store: State<DataStore>, id: String) -> Result<(), String> {
    store.note_restore_deleted(&id)
}

/// 从回收站彻底销毁（连历史快照一起，**不可恢复**）。
/// 前端必须先弹确认：这是笔记侧唯一一个真正不可逆的操作。
#[tauri::command]
pub fn note_purge(store: State<DataStore>, id: String) -> Result<(), String> {
    store.note_purge(&id)
}

/// 清空回收站（R4）。返回销毁条数，供前端提示用。
/// 同样不可恢复，前端必须先弹确认。
#[tauri::command]
pub fn note_purge_all(store: State<DataStore>) -> Result<usize, String> {
    store.note_purge_all()
}

/// 按给定天数算「回收站会被销毁多少条」，**不删任何东西**。
/// 设置页把保留天数改短时先调它，拿真数字去填二次确认。
#[tauri::command]
pub fn note_count_expired(store: State<DataStore>, days: i64) -> Result<i64, String> {
    store.note_count_expired(days)
}

/// 按 id 取一条（带标签）。不存在返回 `null`。
#[tauri::command]
pub fn note_get(store: State<DataStore>, id: String) -> Result<Option<Note>, String> {
    store.note_get(&id)
}

/// 记一笔「这条笔记被打开阅读了」（B2 前置，为 §8.3 #7 重现的「久未访问」攒数据）。
///
/// 无返回值、不报错——失败只在 Rust 侧记 warn，同 `action_event_log` 的口径。
/// 不写在 `note_get` 里：它被 note_ai / note_revision 内部调用，那不是用户在看。
#[tauri::command]
pub fn note_touch(store: State<DataStore>, id: String) {
    store.note_touch(&id);
}

/// 笔记列表，`updated_at` 降序。
///
/// `folderFilter`：`"all"` | `"unfiled"` | `<folder_id>`（照搬记录模式 `group_filter` 的约定）。
/// 缺省 `"all"`。`tagIds` 多个是 AND；与文件夹也是交集。
#[tauri::command]
pub fn note_list(
    store: State<DataStore>,
    folder_filter: Option<String>,
    tag_ids: Option<Vec<String>>,
    view: Option<NoteViewOpts>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Note>, String> {
    let view = validated_view(view);
    store.note_list_view(
        folder_filter.as_deref().unwrap_or("all"),
        &tag_ids.unwrap_or_default(),
        &view,
        clamp_limit(limit),
        offset.unwrap_or(0),
    )
}

/// 校视图选项，未知值记 warn 后退回默认（规则 #15.3：失败不静默）。
///
/// 退回而不报错：一个认不出的排序名不应该让整个笔记列表拉不出来。
/// 但日志里得有痕，否则前后端枚举写不一致时现象只是「排序没生效」，无从下手。
fn validated_view(view: Option<NoteViewOpts>) -> NoteViewOpts {
    let v = view.unwrap_or_default();
    const SORTS: [&str; 5] = ["", "updated", "created", "accessed", "title"];
    const GROUPS: [&str; 4] = ["", "folder", "month", "tag"];
    const TRI: [&str; 3] = ["", "yes", "no"];
    if !SORTS.contains(&v.sort.as_str()) {
        log::warn!("[Notes] 未知排序 `{}`，退回默认", v.sort);
    }
    if !GROUPS.contains(&v.group_by.as_str()) {
        log::warn!("[Notes] 未知分组 `{}`，退回不分组", v.group_by);
    }
    for (name, val) in [
        ("summary", &v.summary),
        ("fromCard", &v.from_card),
        ("tagged", &v.tagged),
    ] {
        if !TRI.contains(&val.as_str()) {
            log::warn!("[Notes] 筛选 {} 的值 `{}` 不是三态之一，当作不筛", name, val);
        }
    }
    // B4 时间范围。后端 `within_days()` 本身就是白名单（认不出就不筛），
    // 这里只负责把「前后端枚举写不一致」变成日志里的一条痕迹，
    // 否则现象只是「筛选没生效」，无从下手（同上面几条）。
    const WITHIN: [&str; 4] = ["", "7d", "30d", "90d"];
    if !WITHIN.contains(&v.updated_within.as_str()) {
        log::warn!(
            "[Notes] 时间范围 `{}` 不在白名单里，当作不筛",
            v.updated_within
        );
    }
    v
}

/// 当前筛选下的笔记总数。与 `note_list` 共用筛选构造，保证同口径。
#[tauri::command]
pub fn note_count_filtered(
    store: State<DataStore>,
    folder_filter: Option<String>,
    tag_ids: Option<Vec<String>>,
    view: Option<NoteViewOpts>,
) -> Result<i64, String> {
    store.note_count_filtered_view(
        folder_filter.as_deref().unwrap_or("all"),
        &tag_ids.unwrap_or_default(),
        &validated_view(view),
    )
}

/// 每个分组的真实条数（B2 #9）。不分组时返回空数组。
///
/// 组头的数字走这里而不是数前端已加载的行——否则就是「组头写 12 而实际 20」。
#[tauri::command]
pub fn note_group_counts(
    store: State<DataStore>,
    folder_filter: Option<String>,
    tag_ids: Option<Vec<String>>,
    view: Option<NoteViewOpts>,
) -> Result<Vec<NoteGroupCount>, String> {
    store.note_group_counts(
        folder_filter.as_deref().unwrap_or("all"),
        &tag_ids.unwrap_or_default(),
        &validated_view(view),
    )
}

/// 某张卡片对应的笔记（最新一条）。没转过返回 `null`。
///
/// 单卡片场景用它；**一屏卡片批量判断角标请用 `note_history_ids`**，
/// 别在列表里逐张调这个（几十次 IPC）。
#[tauri::command]
pub fn note_by_history(
    store: State<DataStore>,
    history_id: String,
) -> Result<Option<Note>, String> {
    store.note_by_history(&history_id)
}

/// 所有已转过笔记的 `history_id`，供卡片列表一次性算出哪些要显示 📝 角标。
#[tauri::command]
pub fn note_history_ids(store: State<DataStore>) -> Result<Vec<String>, String> {
    store.note_history_ids()
}

/// 搜笔记。中文走 bigram、英文走前缀匹配，FTS 失败自动降级 LIKE（见 note.rs）。
/// 关键词为空时返回列表首页，与 history 搜索框的行为一致。
#[tauri::command]
pub fn note_search(
    store: State<DataStore>,
    keyword: String,
    folder_filter: Option<String>,
    tag_ids: Option<Vec<String>>,
    view: Option<NoteViewOpts>,
    limit: Option<u32>,
) -> Result<Vec<Note>, String> {
    store.note_search_view(
        &keyword,
        folder_filter.as_deref().unwrap_or("all"),
        &tag_ids.unwrap_or_default(),
        &validated_view(view),
        clamp_limit(limit),
    )
}

/// 问答检索（B2 #10）：把一句自然语言问题按**相关度**换成几篇笔记。
///
/// 与 [`note_search`] 分开是必须的：那边是 AND 语义，一整句问题丢进去零命中是必然的
/// （理由见 `data_store::note::question_to_or_expr` 的注释）。
///
/// **不在这里拼 prompt、不调模型**：它只负责检索。出网那一步走现有 `ai_run`（内置动作
/// `ai-kb-qa`），那条路上才有开关门控 / 出网闸 / 预算 / 缓存 / 用量日志。
#[tauri::command]
pub fn note_search_relevant(
    store: State<DataStore>,
    question: String,
    folder_filter: Option<String>,
    tag_ids: Option<Vec<String>>,
    view: Option<NoteViewOpts>,
    limit: Option<u32>,
) -> Result<Vec<Note>, String> {
    store.note_search_relevant(
        &question,
        folder_filter.as_deref().unwrap_or("all"),
        &tag_ids.unwrap_or_default(),
        &validated_view(view),
        clamp_limit(limit),
    )
}

/// 整组替换笔记标签（传空数组 = 清空）。标签本体仍归 `tags` 表管。
#[tauri::command]
pub fn note_set_tags(
    store: State<DataStore>,
    note_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    store.note_set_tags(&note_id, &tag_ids)
}

/// 笔记总数。供知识模式空态判断与分页「还有更多」。
#[tauri::command]
pub fn note_count(store: State<DataStore>) -> i64 {
    store.note_count()
}
