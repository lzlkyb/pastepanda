use crate::data_store::{DataStore, HistoryItem, SidebarCounts, Stats, StatsDetail};
use tauri::{Emitter, Manager, State};

#[tauri::command]
pub fn get_history(
    store: State<DataStore>,
    workspace: String,
    filter: String,
    search: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<HistoryItem>, String> {
    store.get_history(&workspace, &filter, &search, offset, limit)
}

#[tauri::command]
pub fn insert_history(store: State<DataStore>, item: HistoryItem) -> Result<(), String> {
    store.insert_history(&item)
}

/// 更新历史记录（编辑对话框 / 全屏编辑器用）。
/// 写库成功后广播 `history-item-updated`，主窗口据此刷新对应卡片
/// （独立编辑器窗口与主窗口是不同的 React 实例，必须经事件同步）。
#[tauri::command]
pub fn update_history(
    app: tauri::AppHandle,
    store: State<DataStore>,
    id: String,
    text: String,
) -> Result<(), String> {
    store.update_history(&id, &text)?;
    let _ = app.emit(
        "history-item-updated",
        serde_json::json!({ "id": id, "text": text }),
    );
    Ok(())
}

/// 更新图文混排（rich）记录：同时回写 HTML 片段与纯文本。
/// 广播的事件载荷多带一个 content 字段（普通 text 记录只有 text），
/// 主窗口据此同时刷新卡片标题和富文本内容。
#[tauri::command]
pub fn update_history_rich(
    app: tauri::AppHandle,
    store: State<DataStore>,
    id: String,
    html_fragment: String,
    plain_text: String,
) -> Result<(), String> {
    store.update_history_rich(&id, &html_fragment, &plain_text)?;
    let _ = app.emit(
        "history-item-updated",
        serde_json::json!({ "id": id, "text": plain_text, "content": html_fragment }),
    );
    Ok(())
}

/// 将全屏编辑器编辑后的内容作为新文本记录写入剪贴板历史
/// （由设置开关 md_save_to_history 控制，从 .md 文件保存时调用）。
/// 写入后广播 `clipboard-changed`，主窗口监听器自动把新卡片 prepend 到列表顶部。
#[tauri::command]
pub fn insert_markdown_history(
    app: tauri::AppHandle,
    store: State<DataStore>,
    text: String,
    workspace: String,
) -> Result<(), String> {
    use crate::content_classifier::ContentClassifier;
    use crate::data_store::compute_pinyin_initials;
    use md5::{Digest, Md5};

    let hash = format!("{:x}", Md5::new().chain_update(text.as_bytes()).finalize());
    let pinyin_initials = compute_pinyin_initials(&text);
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let labels = ContentClassifier::new().classify(&text);
    let item = HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        text: text.clone(),
        time: now_str,
        item_type: "text".to_string(),
        content: String::new(),
        pinned: false,
        source: "Markdown 编辑器".to_string(),
        workspace: if workspace.is_empty() {
            "默认".to_string()
        } else {
            workspace
        },
        md5: Some(hash),
        pinyin_initials: Some(pinyin_initials),
        group_id: None,
        source_icon: None,
        content_type: Some(ContentClassifier::content_type_from_labels(&labels).to_string()),
        tags: Vec::new(),
    };
    store.insert_history(&item)?;
    let _ = app.emit("clipboard-changed", serde_json::json!({ "item": item }));
    Ok(())
}

#[tauri::command]
pub fn delete_history(
    app: tauri::AppHandle,
    store: State<DataStore>,
    ids: Vec<String>,
) -> Result<u32, String> {
    let n = store.delete_history(&ids)?;
    // 广播删除事件：删除可能来自快捷粘贴面板等独立窗口，它们与主窗口是不同的
    // React 实例，不发事件主窗口的列表与侧边栏计数会一直是脏的
    // （参照本文件 update_history 的做法）。主窗口自己删除时也会收到，
    // 前端按 id 过滤是幂等的，重复执行无副作用。
    let _ = app.emit(
        "history-items-deleted",
        serde_json::json!({ "ids": ids }),
    );
    Ok(n)
}

#[tauri::command]
pub fn toggle_pin(store: State<DataStore>, id: String) -> Result<bool, String> {
    store.toggle_pin(&id)
}

#[tauri::command]
pub fn clear_history(
    store: State<DataStore>,
    workspace: String,
    before_days: Option<u32>,
) -> Result<serde_json::Value, String> {
    // 修复 Low：单次原子操作完成 读取被删记录 + 删除，避免读写竞态
    let (count, deleted_items) = store.clear_history_with_undo(&workspace, before_days)?;
    Ok(serde_json::json!({
        "count": count,
        "deleted_items": deleted_items,
    }))
}

#[tauri::command]
pub fn count_expired_history(
    store: State<DataStore>,
    workspace: String,
    before_days: u32,
) -> Result<u32, String> {
    store.count_expired_history(&workspace, before_days)
}

/// 深度清理：按组合条件统计匹配记录数（时间范围 / 类型 / 来源，自动跳过置顶）。
/// JS 侧参数名为 camelCase：beforeDays / itemType（Tauri 默认重命名规则）。
#[tauri::command]
pub fn count_history_conditions(
    store: State<DataStore>,
    workspace: String,
    before_days: Option<u32>,
    item_type: Option<String>,
    source: Option<String>,
) -> Result<u32, String> {
    store.count_history_conditions(&workspace, before_days, item_type, source)
}

/// 深度清理：按组合条件删除并返回被删记录（用于撤销），返回结构与 clear_history 一致。
#[tauri::command]
pub fn clear_history_conditions(
    store: State<DataStore>,
    workspace: String,
    before_days: Option<u32>,
    item_type: Option<String>,
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    let (count, deleted_items) =
        store.clear_history_conditions(&workspace, before_days, item_type, source)?;
    Ok(serde_json::json!({
        "count": count,
        "deleted_items": deleted_items,
    }))
}

/// 深度清理预览：返回命中条件的前 limit 条记录，供弹窗确认删除内容。
#[tauri::command]
pub fn preview_history_conditions(
    store: State<DataStore>,
    workspace: String,
    before_days: Option<u32>,
    item_type: Option<String>,
    source: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistoryItem>, String> {
    store.preview_history_conditions(&workspace, before_days, item_type, source, limit.unwrap_or(50))
}

#[tauri::command]
pub fn get_config(store: State<DataStore>) -> Result<serde_json::Value, String> {
    store.get_config()
}

#[tauri::command]
pub fn save_config(
    store: State<DataStore>,
    config: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store.save_config(&config)?;

    // 刷新剪贴板监听器的 auto_strip 缓存，避免每次都锁数据库读取配置
    if let Some(monitor) = app.try_state::<crate::clipboard_monitor::ClipboardMonitor>() {
        let auto_strip = config
            .get("auto_strip")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        monitor.update_auto_strip_cache(auto_strip);

        // 修复 U36：刷新敏感内容防护缓存（默认关闭，与 lib.rs 和前端 DEFAULT_CONFIG 对齐）
        let skip_sensitive = config
            .get("skip_sensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let excluded_apps: Vec<String> = config
            .get("excluded_apps")
            .and_then(|v| v.as_str())
            .map(|s| {
                s.split(',')
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        monitor.update_sensitive_cache(skip_sensitive, excluded_apps);

        // P1 文档采集：刷新 doc_capture 缓存（默认开启）
        let doc_capture = config
            .get("doc_capture")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        monitor.update_doc_capture_cache(doc_capture);
    }

    Ok(())
}

#[tauri::command]
pub fn get_stats(store: State<DataStore>, workspace: String) -> Result<Stats, String> {
    store.get_stats(&workspace)
}

#[tauri::command]
pub fn get_stats_detail(
    store: State<DataStore>,
    workspace: String,
) -> Result<StatsDetail, String> {
    store.get_stats_detail(&workspace)
}

#[tauri::command]
pub fn get_sidebar_counts(
    store: State<DataStore>,
    workspace: String,
) -> Result<SidebarCounts, String> {
    store.get_sidebar_counts(&workspace)
}

/// 全量搜索：全部筛选条件下推到 SQL，扫整表返回命中记录（上限 1000）。
/// 参数名经 Tauri 默认规则在 JS 侧为 camelCase：timeFilter / groupFilter / tagIds。
#[tauri::command]
pub fn search_history(
    store: State<DataStore>,
    workspace: String,
    search: String,
    filter: String,
    time_filter: String,
    source: String,
    group_filter: String,
    tag_ids: Vec<String>,
    limit: u32,
) -> Result<Vec<HistoryItem>, String> {
    store.search_history(
        &workspace,
        &search,
        &filter,
        &time_filter,
        &source,
        &group_filter,
        &tag_ids,
        limit,
    )
}

/// 导入历史记录
#[tauri::command]
pub fn import_history(store: State<DataStore>, items: Vec<HistoryItem>) -> Result<u32, String> {
    store.import_history(&items)
}

/// 获取全部历史记录（用于导出）
#[tauri::command]
pub fn get_all_history(
    store: State<DataStore>,
    workspace: String,
) -> Result<Vec<HistoryItem>, String> {
    store.get_all_history(&workspace)
}
