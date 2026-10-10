//! Manual missing-image retrieval uses knowledge authorization, never remote-control pairing.
use crate::sync::{
    asset::{AssetError, AssetReceipt},
    service::SyncService,
};
use tauri::State;

#[tauri::command]
pub async fn mobile_knowledge_asset_fetch(
    svc: State<'_, SyncService>,
    request_id: String,
    peer_id: String,
    note_id: String,
    src: String,
) -> Result<AssetReceipt, AssetError> {
    svc.fetch_asset(&request_id, &peer_id, &note_id, &src).await
}

#[tauri::command]
pub fn mobile_knowledge_asset_cancel(
    svc: State<SyncService>,
    request_id: String,
) -> Result<(), AssetError> {
    svc.cancel_asset(&request_id)
}
