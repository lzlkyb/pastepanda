//! 笔记文件夹命令层（B1 #1）。
//!
//! 只转发，校验（防环 / 深度 / 重名）全在 `data_store::note_folder`。
//! **UI 会把非法目标从菜单里去掉，但后端仍是权威**——导入（#5）与将来的
//! MCP 写入（M4）不走 UI，靠前端拦等于没拦。
//!
//! 🔴 红线：无 AI。

use crate::data_store::{DataStore, NoteFolder, MAX_FOLDER_DEPTH};
use tauri::State;

/// 全部文件夹（平表，带 depth 与含后代的 note_count）。前端自己建 parent→children。
#[tauri::command]
pub fn folder_list(store: State<DataStore>) -> Result<Vec<NoteFolder>, String> {
    store.folder_list()
}

/// 未分类笔记数（侧栏内置项）。
#[tauri::command]
pub fn folder_unfiled_count(store: State<DataStore>) -> Result<i64, String> {
    store.folder_unfiled_count()
}

/// 深度上限。给前端判「还能不能建子文件夹 / 能不能移进去」用。
///
/// 为何从后端拿而不是前端写个 3：两边各存一份，改一边就会出现「菜单里能选、
/// 点下去报错」或反之。
#[tauri::command]
pub fn folder_max_depth() -> i64 {
    MAX_FOLDER_DEPTH
}

/// 删除前的影响预览：`[子文件夹数, 会变未分类的笔记数]`。
///
/// 确认框必须拿真数字去填。写泛泛的「相关内容可能受影响」用户无法据此决定。
#[tauri::command]
pub fn folder_delete_impact(store: State<DataStore>, id: String) -> Result<(i64, i64), String> {
    store.folder_delete_impact(&id)
}

/// 新建文件夹。`parentId` 为空 = 顶层。
#[tauri::command]
pub fn folder_create(
    store: State<DataStore>,
    name: String,
    parent_id: Option<String>,
) -> Result<NoteFolder, String> {
    store.folder_create(&name, parent_id.as_deref())
}

/// 重命名。
#[tauri::command]
pub fn folder_rename(store: State<DataStore>, id: String, name: String) -> Result<(), String> {
    store.folder_rename(&id, &name)
}

/// 移动。`newParent` 为空 = 移到顶层。三道防环/防超深校验在 store 里。
#[tauri::command]
pub fn folder_move(
    store: State<DataStore>,
    id: String,
    new_parent: Option<String>,
) -> Result<(), String> {
    store.folder_move(&id, new_parent.as_deref())
}

/// 删除。子文件夹随之删，**笔记不删**（变未分类）。
#[tauri::command]
pub fn folder_delete(store: State<DataStore>, id: String) -> Result<(), String> {
    store.folder_delete(&id)
}

/// 给笔记归档。`folderId` 为空 = 移回未分类。
#[tauri::command]
pub fn note_set_folder(
    store: State<DataStore>,
    note_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    store.note_set_folder(&note_id, folder_id.as_deref())
}
