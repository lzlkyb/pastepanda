//! Phone-only local metadata and durable independent captures; no network or AI calls.
use crate::data_store::{
    DataStore, MobileKnowledgeDraft, MobileKnowledgeOptions, MobileKnowledgePage, MobileNoteMeta,
    Note,
};
use tauri::State;

#[tauri::command]
pub fn mobile_knowledge_list(
    store: State<DataStore>,
    options: MobileKnowledgeOptions,
) -> Result<MobileKnowledgePage, String> {
    store.mobile_knowledge_list(&options)
}
#[tauri::command]
pub fn mobile_knowledge_meta(
    store: State<DataStore>,
    id: String,
) -> Result<MobileNoteMeta, String> {
    store.mobile_knowledge_meta(&id)
}
#[tauri::command]
pub fn mobile_knowledge_set_common(
    store: State<DataStore>,
    id: String,
    common: bool,
) -> Result<MobileNoteMeta, String> {
    store.mobile_knowledge_set_common(&id, common)
}
#[tauri::command]
pub fn mobile_knowledge_visit(
    store: State<DataStore>,
    id: String,
    reading_position: f64,
) -> Result<MobileNoteMeta, String> {
    store.mobile_knowledge_visit(&id, reading_position)
}
#[tauri::command]
pub fn mobile_knowledge_draft_get(
    store: State<DataStore>,
) -> Result<Option<MobileKnowledgeDraft>, String> {
    store.mobile_knowledge_draft_get()
}
#[tauri::command]
pub fn mobile_knowledge_draft_put(
    store: State<DataStore>,
    draft: MobileKnowledgeDraft,
) -> Result<MobileKnowledgeDraft, String> {
    store.mobile_knowledge_draft_put(&draft)
}
#[tauri::command]
pub fn mobile_knowledge_draft_clear(
    store: State<DataStore>,
    id: String,
    revision: u32,
) -> Result<(), String> {
    store.mobile_knowledge_draft_clear(&id, revision)
}
#[tauri::command]
pub fn mobile_knowledge_draft_commit(
    store: State<DataStore>,
    id: String,
    revision: u32,
) -> Result<Note, String> {
    store.mobile_knowledge_draft_commit(&id, revision)
}
