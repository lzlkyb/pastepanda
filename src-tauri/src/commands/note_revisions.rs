//! 笔记版本快照命令层（B1 #4 / D8）。
//!
//! 只转发。快照本身不在这里触发——它在 `note_update` / `note_restore` 内部随写入发生，
//! 不给前端留「手动存一份」的口子：那会让两边各有一套什么时候该快照的判断。
//!
//! 🔴 红线：无 AI。快照只进本机 SQLite。

use crate::data_store::{DataStore, Note, NoteRevision, NoteRevisionMeta};
use tauri::State;

/// 一篇笔记的历史列表，新在前。**不含当前版、不带全文**。
#[tauri::command]
pub fn note_revision_list(
    store: State<DataStore>,
    note_id: String,
) -> Result<Vec<NoteRevisionMeta>, String> {
    store.note_revision_list(&note_id)
}

/// 取单份快照的全文（预览时才拉）。
#[tauri::command]
pub fn note_revision_get(
    store: State<DataStore>,
    rev_id: i64,
) -> Result<Option<NoteRevision>, String> {
    store.note_revision_get(rev_id)
}

/// 恢复到指定快照，返回恢复后的笔记。
///
/// 内部会**先把当前版存成一份快照**，所以恢复可撤销。
#[tauri::command]
pub fn note_restore(store: State<DataStore>, rev_id: i64) -> Result<Note, String> {
    store.note_restore(rev_id)
}
