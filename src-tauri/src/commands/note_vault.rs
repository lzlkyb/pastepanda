//! 笔记 Markdown 目录导出 / 导入命令层（B1 #5 / D1）。
//!
//! 前端只负责用 dialog 选目录，把路径交过来；目录遍历、建子目录、写文件、
//! 解析与入库全在 Rust（设计稿 §1）。
//!
//! 🔴 红线：无 AI。

use crate::data_store::{DataStore, ExportReport, ImportReport};
use tauri::State;

/// 把全部笔记导出到指定目录（可直接当 Obsidian vault 打开）。
#[tauri::command]
pub fn note_export_dir(store: State<DataStore>, dir: String) -> Result<ExportReport, String> {
    store.note_export_dir(&dir)
}

/// 从指定目录导入。**合并语义：只新增与更新，永远不删库里的笔记。**
#[tauri::command]
pub fn note_import_dir(store: State<DataStore>, dir: String) -> Result<ImportReport, String> {
    store.note_import_dir(&dir)
}

/// 把一篇笔记拼成带 frontmatter 的 Markdown 全文（给「复制为 Markdown」用）。
///
/// **收标题/正文/标签而不是笔记 id**：用户可能正在改一篇还没保存的笔记，
/// 拿 id 去库里取就会复制出与屏幕上不一样的内容；新建的笔记更是没有 id。
/// 它与导出共用同一个生成函数体（规则 #11），只是不写 `pastepanda_id`——
/// 给人看的东西带一串 uuid 只是噪音。
#[tauri::command]
pub fn note_markdown(title: String, content: String, tags: Vec<String>) -> String {
    crate::data_store::to_markdown(crate::data_store::MdOut {
        title: &title,
        content: &content,
        tags: &tags,
        created: "",
        updated: "",
        id: None,
        // 剪贴板那份不带摘要：它是本地列表的展示字段，搬去别处没意义
        summary: "",
    })
}
