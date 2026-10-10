//! Phone edit commands deliberately preserve rejected errors for visible mobile feedback.
use crate::data_store::{DataStore, MobileKnowledgeEditDraft, MobileKnowledgeEditResult};
use tauri::State;

#[tauri::command]
pub fn mobile_knowledge_edit_get(
    store: State<DataStore>,
) -> Result<Option<MobileKnowledgeEditDraft>, String> {
    store.mobile_knowledge_edit_get()
}
#[tauri::command]
pub fn mobile_knowledge_edit_begin(
    store: State<DataStore>,
    note_id: String,
) -> Result<MobileKnowledgeEditDraft, String> {
    store.mobile_knowledge_edit_begin(&note_id)
}
#[tauri::command]
pub fn mobile_knowledge_edit_put(
    store: State<DataStore>,
    draft: MobileKnowledgeEditDraft,
) -> Result<MobileKnowledgeEditDraft, String> {
    store.mobile_knowledge_edit_put(&draft)
}
#[tauri::command]
pub fn mobile_knowledge_edit_commit(
    store: State<DataStore>,
    id: String,
    revision: u32,
) -> Result<MobileKnowledgeEditResult, String> {
    store.mobile_knowledge_edit_commit(&id, revision)
}
#[tauri::command]
pub fn mobile_knowledge_edit_copy(
    store: State<DataStore>,
    id: String,
    revision: u32,
) -> Result<MobileKnowledgeEditResult, String> {
    store.mobile_knowledge_edit_copy(&id, revision)
}
#[tauri::command]
pub fn mobile_knowledge_edit_clear(
    store: State<DataStore>,
    id: String,
    revision: u32,
) -> Result<(), String> {
    store.mobile_knowledge_edit_clear(&id, revision)
}
