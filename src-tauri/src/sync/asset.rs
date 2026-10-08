//! Explicit single-image transfer. It never exchanges note deltas or advances a cursor.
use super::{attach, transport};
use crate::data_store::DataStore;
use iroh::{Endpoint, EndpointAddr};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const ALPN: &[u8] = b"pastepanda-kb-asset/1";
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(90);
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetError {
    pub code: String,
    pub message: String,
}
impl AssetError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "已停止补齐图片")
    }
    pub fn io() -> Self {
        Self::new("io", "图片读写失败，请检查手机剩余空间后重试")
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct AssetReceipt {
    pub src: String,
    pub bytes: u64,
    pub peer: String,
    pub already_local: bool,
}
#[derive(Debug, Serialize, Deserialize)]
struct Request {
    note_id: String,
    name: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Response {
    Ok { bytes: u64 },
    Error { error: AssetError },
}

pub fn authorized(store: &DataStore, peer: &str) -> Result<(), AssetError> {
    let enabled = store
        .get_config()
        .ok()
        .and_then(|c| c.get(super::presence::ENABLE_KEY).and_then(|v| v.as_bool()))
        .unwrap_or(false);
    if !enabled {
        return Err(AssetError::new("sync_disabled", "请先开启知识库同步"));
    }
    match store.device_get(peer).map_err(|_| AssetError::io())? {
        None => Err(AssetError::new(
            "unauthorized",
            "这台电脑尚未获得知识库同步授权",
        )),
        Some(peer) if peer.paused => Err(AssetError::new("paused", "这台电脑的知识库同步已暂停")),
        Some(_) => Ok(()),
    }
}

pub fn reference(
    store: &DataStore,
    note_id: &str,
    src: &str,
) -> Result<attach::AssetRef, AssetError> {
    let portable = attach::to_portable(src);
    let name = portable
        .strip_prefix(attach::PORTABLE_SCHEME)
        .ok_or_else(|| AssetError::new("invalid", "只支持笔记内的应用图片"))?;
    let asset = parse_name(name)?;
    verify_note_reference(store, note_id, &asset)?;
    Ok(asset)
}
fn parse_name(name: &str) -> Result<attach::AssetRef, AssetError> {
    let Some((hash, ext)) = name.split_once('.') else {
        return Err(AssetError::new("invalid", "图片名称无效"));
    };
    if hash.len() != 32
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        || !crate::commands::ALLOWED_IMAGE_EXTENSIONS.contains(&ext)
        || name != name.to_ascii_lowercase()
    {
        return Err(AssetError::new("invalid", "图片名称无效"));
    }
    Ok(attach::AssetRef {
        hash: hash.into(),
        ext: ext.into(),
    })
}
fn verify_note_reference(
    store: &DataStore,
    id: &str,
    asset: &attach::AssetRef,
) -> Result<(), AssetError> {
    if id.len() > 128 {
        return Err(AssetError::new("invalid", "笔记标识无效"));
    }
    let note = store
        .note_get(id)
        .map_err(|_| AssetError::io())?
        .ok_or_else(|| AssetError::new("missing", "电脑上已找不到这篇笔记"))?;
    if !attach::scan_refs(&note.content).contains(asset) {
        return Err(AssetError::new(
            "missing",
            "这张图片已不在该笔记中，请先同步最新正文",
        ));
    }
    Ok(())
}
fn image_path(images: &Path, asset: &attach::AssetRef) -> Result<PathBuf, AssetError> {
    let root = images
        .canonicalize()
        .map_err(|_| AssetError::new("missing", "电脑上没有这张图片"))?;
    let path = images
        .join(asset.file_name())
        .canonicalize()
        .map_err(|_| AssetError::new("missing", "电脑上没有这张图片"))?;
    if path.parent() != Some(root.as_path()) {
        return Err(AssetError::new("invalid", "图片不在应用图片目录内"));
    }
    Ok(path)
}
fn validate(asset: &attach::AssetRef, bytes: &[u8]) -> Result<(), AssetError> {
    if bytes.is_empty() || bytes.len() as u64 > attach::MAX_ASSET_BYTES {
        return Err(AssetError::new(
            "too_large",
            "图片为空或超过10MB，请在电脑上缩小后重试",
        ));
    }
    if format!("{:x}", Md5::digest(bytes)) != asset.hash {
        return Err(AssetError::new("integrity", "图片内容校验失败，请重试"));
    }
    crate::commands::validate_image_bytes(bytes).map_err(|error| {
        let code = if error == crate::commands::ImageValidationError::ExcessiveDimensions {
            "too_large"
        } else { "invalid" };
        AssetError::new(code, &error.to_string())
    })?;
    Ok(())
}
pub async fn read_local(images: &Path, asset: &attach::AssetRef) -> Result<Vec<u8>, AssetError> {
    let path = image_path(images, asset)?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| AssetError::io())?;
    let meta = file.metadata().await.map_err(|_| AssetError::io())?;
    if !meta.is_file() || meta.len() > attach::MAX_ASSET_BYTES {
        return Err(AssetError::new("too_large", "图片超过10MB或不是普通文件"));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(attach::MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| AssetError::io())?;
    validate(asset, &bytes)?;
    Ok(bytes)
}
pub fn adopt(images: &Path, asset: &attach::AssetRef, bytes: &[u8]) -> Result<(), AssetError> {
    validate(asset, bytes)?;
    std::fs::create_dir_all(images).map_err(|_| AssetError::io())?;
    let root = images.canonicalize().map_err(|_| AssetError::io())?;
    let destination = root.join(asset.file_name());
    // A corrupt local copy must be repairable. Never follow an existing symlink
    // when replacing it; rename replaces the directory entry, not its target.
    let temp = crate::atomic_write::unique_tmp_path(&destination);
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(temp.clone());
    use std::io::Write;
    let mut file = std::fs::File::create(&temp).map_err(|_| AssetError::io())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| AssetError::io())?;
    drop(file);
    std::fs::rename(&temp, &destination).map_err(|_| AssetError::io())
}

pub async fn serve(
    store: &DataStore,
    mut wire: transport::Wire,
    peer: &str,
) -> Result<(), AssetError> {
    authorized(store, peer)?;
    let raw = transport::read_frame(&mut wire.recv)
        .await
        .map_err(|_| AssetError::io())?;
    let prepared = async {
        let request: Request =
            serde_json::from_slice(&raw).map_err(|_| AssetError::new("invalid", "图片请求无效"))?;
        let asset = parse_name(&request.name)?;
        verify_note_reference(store, &request.note_id, &asset)?;
        let images = store.images_dir().ok_or_else(AssetError::io)?;
        let bytes = read_local(&images, &asset).await?;
        authorized(store, peer)?;
        Ok::<_, AssetError>(bytes)
    }
    .await;
    let response = match &prepared {
        Ok(bytes) => Response::Ok {
            bytes: bytes.len() as u64,
        },
        Err(error) => Response::Error {
            error: error.clone(),
        },
    };
    let header = serde_json::to_vec(&response).map_err(|_| AssetError::io())?;
    transport::write_frame(&mut wire.send, &header)
        .await
        .map_err(|_| AssetError::io())?;
    if let Ok(bytes) = prepared {
        for chunk in bytes.chunks(CHUNK) {
            authorized(store, peer)?;
            tokio::time::timeout(transport::STALL_TIMEOUT, wire.send.write_all(chunk))
                .await
                .map_err(|_| AssetError::new("offline", "连接中断，请重试"))?
                .map_err(|_| AssetError::new("offline", "连接中断，请重试"))?;
        }
    }
    wire.send.finish().map_err(|_| AssetError::io())?;
    // Keep the authenticated connection alive until the receiver has drained it.
    let _ = tokio::time::timeout(transport::STALL_TIMEOUT, wire.send.stopped()).await;
    Ok(())
}

pub async fn fetch(
    ep: &Endpoint,
    to: EndpointAddr,
    peer: &str,
    id: &str,
    asset: &attach::AssetRef,
) -> Result<Vec<u8>, AssetError> {
    let conn = ep
        .connect(to, ALPN)
        .await
        .map_err(|e| connection_error(&e.to_string()))?;
    struct Close(iroh::endpoint::Connection);
    impl Drop for Close {
        fn drop(&mut self) {
            self.0.close(0u32.into(), b"asset transfer ended");
        }
    }
    let _close = Close(conn.clone());
    if conn.remote_id().to_string() != peer {
        return Err(AssetError::new("unauthorized", "电脑身份不匹配"));
    }
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|_| AssetError::new("offline", "无法连接电脑"))?;
    let request = serde_json::to_vec(&Request {
        note_id: id.into(),
        name: asset.file_name(),
    })
    .map_err(|_| AssetError::io())?;
    transport::write_frame(&mut send, &request)
        .await
        .map_err(|_| AssetError::new("offline", "无法向电脑请求图片"))?;
    send.finish().map_err(|_| AssetError::io())?;
    let header = transport::read_frame(&mut recv)
        .await
        .map_err(|_| stream_error(&conn))?;
    let response: Response = serde_json::from_slice(&header)
        .map_err(|_| AssetError::new("invalid", "电脑返回的图片信息无效"))?;
    let length = match response {
        Response::Ok { bytes } => bytes,
        Response::Error { error } => return Err(remote_error(&error.code)),
    };
    if length == 0 || length > attach::MAX_ASSET_BYTES {
        return Err(AssetError::new("too_large", "电脑返回的图片超过10MB或为空"));
    }
    let mut bytes = vec![0u8; length as usize];
    for chunk in bytes.chunks_mut(CHUNK) {
        tokio::time::timeout(transport::STALL_TIMEOUT, recv.read_exact(chunk))
            .await
            .map_err(|_| AssetError::new("offline", "图片传输中断，请重试"))?
            .map_err(|_| AssetError::new("offline", "图片未传完整，请重试"))?;
    }
    let mut extra = [0u8; 1];
    let end = tokio::time::timeout(transport::STALL_TIMEOUT, recv.read(&mut extra))
        .await
        .map_err(|_| AssetError::new("offline", "图片传输未结束，请重试"))?
        .map_err(|_| AssetError::new("offline", "图片传输中断，请重试"))?;
    if end.is_some() {
        return Err(AssetError::new("invalid", "图片长度不匹配"));
    }
    validate(asset, &bytes)?;
    Ok(bytes)
}
fn connection_error(message: &str) -> AssetError {
    if message.contains("support any known protocol")
        || message.contains("no application protocol")
        || message.contains("ALPN")
    {
        AssetError::new(
            "unsupported",
            "电脑版本暂不支持单张补齐，请更新电脑端或使用完整同步",
        )
    } else {
        AssetError::new("offline", "暂时无法连接电脑，请确认电脑在线后重试")
    }
}
fn stream_error(conn: &iroh::endpoint::Connection) -> AssetError {
    let reason = conn
        .close_reason()
        .map(|reason| reason.to_string())
        .unwrap_or_default();
    if reason.contains("asset busy") {
        return remote_error("busy");
    }
    if reason.contains("knowledge authorization required") {
        return remote_error("unauthorized");
    }
    if reason.contains("knowledge sync disabled") { return remote_error("sync_disabled"); }
    if reason.contains("knowledge peer paused") { return remote_error("paused"); }
    if reason.contains("sync cancelled") {
        return remote_error("cancelled");
    }
    AssetError::new("offline", "电脑未返回图片，请确认电脑在线后重试")
}
fn remote_error(code: &str) -> AssetError {
    // Peer-controlled messages never enter UI. Only known codes select local copy.
    match code {
        "sync_disabled" => AssetError::new(code, "电脑的知识库同步尚未开启"),
        "unauthorized" => AssetError::new(code, "电脑尚未授权这台手机访问知识库"),
        "paused" => AssetError::new(code, "电脑已暂停与这台手机的知识库同步"),
        "cancelled" => AssetError::cancelled(),
        "busy" => AssetError::new(code, "电脑正在处理其他图片，请稍后重试"),
        "missing" => AssetError::new(code, "电脑上已找不到这张图片或对应笔记，请先同步最新正文"),
        "too_large" => AssetError::new(code, "图片超过10MB或分辨率过高，请在电脑上缩小后重试"),
        "integrity" => AssetError::new(code, "电脑上的图片内容校验失败，请在电脑端修复"),
        "invalid" => AssetError::new(code, "电脑返回的图片无效或格式不支持"),
        _ => AssetError::new("io", "电脑暂时无法读取图片，请稍后重试"),
    }
}

#[cfg(test)]
#[path = "asset_tests.rs"]
mod tests;
