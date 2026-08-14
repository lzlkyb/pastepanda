use crate::data_store::{DataStore, HistoryItem, SidebarCounts, Stats, StatsDetail};
use rusqlite::params;
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

    let hash = crate::hashing::content_md5(&text);
    let pinyin_initials = compute_pinyin_initials(&text);
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let labels = ContentClassifier::new().classify(&text);
    let target_workspace = if workspace.is_empty() {
        "默认".to_string()
    } else {
        workspace
    };

    // 智能合并：同一内容重复保存（编辑器 Ctrl+S 多次、内容未变）只更新时间不新建，
    // 与剪贴板捕获的 text 合并口径一致（内容变化 → md5 变 → 自然新建，不会丢新内容）
    if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, &target_workspace, "text") {
        store.update_history_time(&existing.id, &now_str).ok();
        log::info!(
            "[Markdown 编辑器] 智能合并重复保存 (id={})",
            existing.id
        );
        return Ok(());
    }

    let item = HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        text: text.clone(),
        time: now_str,
        item_type: "text".to_string(),
        content: String::new(),
        pinned: false,
        source: "Markdown 编辑器".to_string(),
        workspace: target_workspace,
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

/// 将流程图编辑器产出的内容作为新记录写入剪贴板历史。
/// diagram 以 item_type="diagram" 入库，nodes/edges/direction 的 JSON 放在 content 字段，
/// text 字段放可搜索的纯文本（节点标签拼接），便于 FTS 检索。
/// 智能合并：相同内容（md5 相同，同 workspace、同类型）重复保存只更新时间不新建，
/// 与剪贴板捕获 / Markdown 编辑器合并口径一致。
#[tauri::command]
pub fn insert_diagram_history(
    app: tauri::AppHandle,
    store: State<DataStore>,
    content: String,
    text: String,
    workspace: String,
) -> Result<String, String> {
    use crate::data_store::compute_pinyin_initials;
    let hash = crate::hashing::content_md5(&content);
    let pinyin_initials = compute_pinyin_initials(&text);
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let target_workspace = if workspace.is_empty() {
        "默认".to_string()
    } else {
        workspace
    };

    // 空图不参与 md5 合并：空文档的 content 恒为 {"version":1,"nodes":[],"edges":[]}，
    // md5 也就恒定，每次「新建流程图」都会命中上一条空记录、返回同一个 id，
    // 双开两个新建窗口时两边 sourceId 相同，保存会互相覆盖。
    let is_empty_doc = serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.get("nodes").and_then(|n| n.as_array()).map(|a| a.is_empty()))
        .unwrap_or(false);
    if !is_empty_doc {
        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, &target_workspace, "diagram") {
            store.update_history_time(&existing.id, &now_str).ok();
            let _ = app.emit(
                "history-item-updated",
                serde_json::json!({ "id": existing.id, "content": content, "text": text }),
            );
            return Ok(existing.id);
        }
    }

    let item = HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        text: text.clone(),
        time: now_str,
        item_type: "diagram".to_string(),
        content,
        pinned: false,
        // source 是「从哪个应用来的」，不是内容类型。
        // 原先写死了 "流程图"，会在卡片上以来源徽标的形式与「微信 / Chrome」并排，
        // 语义错位，还会污染按来源筛选与使用日志统计（logPasteEvent / useActionEventLog 都拿 item.source）。
        // 类型标识已改走下方的「流程图」自动标签。
        //
        // 但也不能留空串：前端是 `{item.source && <SourceBadge/>}`，空串会让流程图卡片的
        // 来源位独独缺一块，又是另一种不一致。填 "PastePanda"：它本就是**已有的取值**
        // （从 PastePanda 自身窗口复制时抓到的就是这个窗口标题，库里已有 text/image/rich 三类共二十多条），
        // 而流程图确实就是在本应用里产生的——既不撞类型语义，也与现有数据对齐。
        source: "PastePanda".to_string(),
        workspace: target_workspace,
        md5: Some(hash),
        pinyin_initials: Some(pinyin_initials),
        group_id: None,
        source_icon: None,
        content_type: Some("diagram".to_string()),
        tags: Vec::new(),
    };
    store.insert_history(&item)?;
    // 类型标识必须走标签体系（同 rich 的「图文」、doc 的「文档」）：
    // 只有标签才能点击筛选、才会出现在筛选标签列表里、才能被用户统一管理。
    // 写在 insert 之后：worker 要按 history_id 写 history_tags，记录得先存在。
    crate::clipboard_monitor::enqueue_auto_tags(
        app.clone(),
        item.id.clone(),
        vec!["流程图".to_string()],
    );
    let _ = app.emit("clipboard-changed", serde_json::json!({ "item": item }));
    Ok(item.id)
}

/// 更新流程图记录（item_type="diagram"）的内容与可搜索文本。
///
/// 修复「新建流程图点击保存报错记录不存在」：
/// 此前流程图保存复用了 `update_history_rich`，而该函数第 668 行仅查询 `type = 'rich'` 的记录，
/// 但 `insert_diagram_history` 把流程图存成了 `item_type="diagram"`，导致更新时 SELECT 查不到 → 报“记录不存在”。
/// 流程图内容是其 JSON（nodes/edges），不是 HTML 富文本，因此独立建一条按 `type='diagram'` 定位的更新路径，
/// 仅更新 content/text/md5/pinyin_initials（content_type 锁定为 'diagram'）。
#[tauri::command]
pub fn update_diagram_history(
    app: tauri::AppHandle,
    store: State<DataStore>,
    id: String,
    content: String,
    text: String,
) -> Result<(), String> {
    use crate::data_store::compute_pinyin_initials;
    let hash = crate::hashing::content_md5(&content);
    let pinyin_initials = compute_pinyin_initials(&text);
    let conn = store.lock_conn();
    let affected = conn
        .execute(
            "UPDATE history SET content = ?1, text = ?2, md5 = ?3, pinyin_initials = ?4, content_type = 'diagram' WHERE id = ?5 AND type = 'diagram'",
            params![content, text, hash, pinyin_initials, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("记录不存在".to_string());
    }
    store.sync_fts_upsert(&conn, &id);
    drop(conn);
    let _ = app.emit(
        "history-item-updated",
        serde_json::json!({ "id": id, "content": content, "text": text }),
    );
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
