//! Android sharing is an inbox, never a note-writing command. The frontend owns confirmation.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::Manager;
use md5::{Digest, Md5};
use std::io::Read;

#[derive(Clone, Deserialize, Serialize)]
pub struct KnowledgeIncoming {
    id: String,
    title: String,
    text: String,
    images: Vec<String>,
    status: String,
    message: String,
    created_at: u64,
}
#[derive(Deserialize, Serialize)]
pub struct KnowledgeInbox {
    items: Vec<KnowledgeIncoming>,
    processing: bool,
    #[serde(default)]
    notice: String,
    #[serde(default, rename = "openRequestId", skip_serializing_if = "String::is_empty")]
    open_request_id: String,
    #[serde(default, skip_serializing)]
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    staging_dir: String,
}
#[derive(Deserialize, Serialize)]
pub struct ShareReply {
    status: String,
    #[serde(default, rename = "incomingId")]
    incoming_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeOutgoing { title: String, text: String, #[serde(default)] image_sources: Vec<String> }
#[cfg(target_os = "android")]
pub struct KnowledgeShare<R: Runtime>(pub(crate) tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("knowledge-share").setup(|app, api| {
        #[cfg(target_os = "android")]
        app.manage(KnowledgeShare(api.register_android_plugin("com.pastepanda.app", "KnowledgeSharePlugin")?));
        let _ = (app, api); Ok(())
    }).build()
}

#[tauri::command]
pub async fn mobile_knowledge_share_list(app: AppHandle) -> Result<KnowledgeInbox, String> {
    #[cfg(target_os = "android")]
    {
        let mut inbox: KnowledgeInbox = app.state::<KnowledgeShare<tauri::Wry>>().0
            .run_mobile_plugin("listPending", ()).map_err(|_| "待收集内容读取失败")?;
        let images = app.path().app_data_dir().map_err(|_| "应用图片目录不可用")?.join("images");
        tauri::async_runtime::spawn_blocking(move || {
            let staging = PathBuf::from(&inbox.staging_dir);
            for item in &mut inbox.items {
                let mut promoted = Vec::new(); let mut failures = Vec::new();
                for source in &item.images {
                    match promote_image(&staging, &images, Path::new(source)) {
                        Ok(value) => promoted.push(value), Err(error) => failures.push(error),
                    }
                }
                item.images = promoted;
                if !failures.is_empty() {
                    item.status = if !item.images.is_empty() || !item.text.trim().is_empty() { "partial" } else { "error" }.into();
                    item.message = failures.join("；");
                }
            }
            inbox
        }).await.map_err(|_| "图片收集任务失败".to_string())
    }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Ok(KnowledgeInbox { items: vec![], processing: false, notice: String::new(), open_request_id: String::new(), staging_dir: String::new() }) }
}

#[tauri::command]
pub async fn mobile_knowledge_share_ack(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { app.state::<KnowledgeShare<tauri::Wry>>().0.run_mobile_plugin::<serde_json::Value>("acknowledge", serde_json::json!({ "id": id }))
        .map_err(|_| "待收集内容清理失败，请重试")?; Ok(()) }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, id); Err("系统收集仅手机端可用".into()) }
}

#[tauri::command]
pub async fn mobile_knowledge_share_pick_images(app: AppHandle) -> Result<ShareReply, String> {
    #[cfg(target_os = "android")]
    { app.state::<KnowledgeShare<tauri::Wry>>().0.run_mobile_plugin("pickImages", ())
        .map_err(|_| "图片选择失败，请重试".into()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err("系统图片选择仅手机端可用".into()) }
}

#[tauri::command]
pub async fn mobile_knowledge_share_send(app: AppHandle, outgoing: KnowledgeOutgoing) -> Result<ShareReply, String> {
    #[cfg(target_os = "android")]
    {
        let images = app.path().app_data_dir().map_err(|_| "应用图片目录不可用")?.join("images");
        let cache = app.path().app_cache_dir().map_err(|_| "分享目录不可用")?.join("knowledge-share-out");
        let args = tauri::async_runtime::spawn_blocking(move || prepare_outgoing(&images, &cache, outgoing))
            .await.map_err(|_| "分享准备失败")??;
        app.state::<KnowledgeShare<tauri::Wry>>().0.run_mobile_plugin("share", args)
            .map_err(|_| "无法打开系统分享面板".into())
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, outgoing); Err("系统分享仅手机端可用".into()) }
}

fn promote_image(staging: &Path, images: &Path, source: &Path) -> Result<String, String> {
    let root = staging.canonicalize().map_err(|_| "收集图片已失效，请重新分享")?;
    let source = source.canonicalize().map_err(|_| "收集图片已失效，请重新分享")?;
    if source.parent() != Some(root.as_path()) { return Err("图片不在收集目录内".into()); }
    let mut file = std::fs::File::open(&source).map_err(|_| "收集图片读取失败")?;
    if !file.metadata().map_err(|_| "图片信息读取失败")?.is_file() { return Err("不是普通图片文件".into()); }
    let mut bytes = Vec::new(); file.by_ref().take(crate::sync::attach::MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes).map_err(|_| "收集图片读取失败")?;
    if bytes.len() as u64 > crate::sync::attach::MAX_ASSET_BYTES { return Err("图片超过10MB".into()); }
    let (_, extension) = super::mobile_knowledge_image::validate_image_bytes(&bytes)?;
    let name = format!("{:x}.{extension}", Md5::digest(&bytes));
    std::fs::create_dir_all(images).map_err(|_| "图片目录创建失败")?;
    let target = images.join(&name);
    // Use a temporary sibling and atomic rename; a killed app cannot leave a truncated hash-addressed image.
    if !target.exists() {
        let temporary = images.join(format!("incoming-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, &bytes).map_err(|_| "图片保存失败")?;
        if std::fs::rename(&temporary, &target).is_err() {
            let _ = std::fs::remove_file(&temporary); return Err("图片保存失败，请检查手机存储空间后重试".into());
        }
    } else {
        super::mobile_knowledge_image::read_knowledge_image_bytes(images, &format!("pp-asset:{name}"))?;
    }
    Ok(format!("pp-asset:{name}"))
}

fn prepare_outgoing(images: &Path, cache: &Path, outgoing: KnowledgeOutgoing) -> Result<serde_json::Value, String> {
    if outgoing.text.len() > 800_000 || outgoing.title.len() > 2000 || outgoing.image_sources.len() > 8 {
        return Err("分享内容过大，请分段分享".into());
    }
    std::fs::create_dir_all(cache).map_err(|_| "分享目录创建失败")?;
    let mut paths = Vec::new();
    for src in &outgoing.image_sources {
        // The same content/path guard used by the reader validates every outgoing attachment.
        let (_, bytes) = super::mobile_knowledge_image::read_knowledge_image_bytes(images, src)?;
        let (_, extension) = super::mobile_knowledge_image::validate_image_bytes(&bytes)?;
        let name = format!("{:x}.{extension}", Md5::digest(&bytes));
        let target = cache.join(name);
        // Share exactly the validated bytes; a later path replacement cannot swap the attachment.
        std::fs::write(&target, bytes).map_err(|_| "分享图片准备失败")?;
        let path = target.to_string_lossy().into_owned();
        if !paths.contains(&path) { paths.push(path); }
    }
    // Keep current attachments available to the receiving app, and cap old shares at a further 80MB.
    let mut old: Vec<_> = std::fs::read_dir(cache).map_err(|_| "分享目录读取失败")?
        .filter_map(Result::ok).filter(|entry| !paths.contains(&entry.path().to_string_lossy().into_owned()))
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() { return None; }
            Some((entry.path(), meta.len(), meta.modified().ok()?))
        }).collect();
    old.sort_by_key(|item| item.2);
    let mut bytes: u64 = old.iter().map(|item| item.1).sum();
    for (path, size, _) in old {
        if bytes <= 80 * 1024 * 1024 { break; }
        if std::fs::remove_file(path).is_ok() { bytes = bytes.saturating_sub(size); }
    }
    Ok(serde_json::json!({ "title": outgoing.title, "text": outgoing.text, "imagePaths": paths }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf, PathBuf, Vec<u8>) {
        let root = std::env::temp_dir().join(format!("knowledge-share-{}", uuid::Uuid::new_v4()));
        let inbox = root.join("inbox"); let images = root.join("images");
        std::fs::create_dir_all(&inbox).unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        (root, inbox, images, bytes.into_inner())
    }
    #[test]
    fn mobile_knowledge_share_import_persists_independently_of_inbox_and_deduplicates() {
        let (root, inbox, images, bytes) = fixture(); let source = inbox.join("first.image");
        std::fs::write(&source, &bytes).unwrap();
        let reference = promote_image(&inbox, &images, &source).unwrap();
        assert!(reference.starts_with("pp-asset:")); assert!(reference.ends_with(".png"));
        assert_eq!(promote_image(&inbox, &images, &source).unwrap(), reference);
        std::fs::remove_file(source).unwrap();
        assert!(super::super::mobile_knowledge_image::read_knowledge_image(&images, &reference).is_ok());
        assert_eq!(std::fs::read_dir(&images).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mobile_knowledge_share_import_rejects_outside_files_and_fake_images() {
        let (root, inbox, images, bytes) = fixture(); let outside = root.join("private.image");
        std::fs::write(&outside, bytes).unwrap();
        assert!(promote_image(&inbox, &images, &outside).is_err());
        let fake = inbox.join("fake.image"); std::fs::write(&fake, b"private document").unwrap();
        assert!(promote_image(&inbox, &images, &fake).is_err());
        assert!(!images.exists()); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mobile_knowledge_share_import_blocks_oversized_compressed_dimensions_and_bytes() {
        let (root, inbox, images, _) = fixture(); let large = inbox.join("large.image");
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        std::fs::write(&large, bytes.into_inner()).unwrap();
        assert!(promote_image(&inbox, &images, &large).unwrap_err().contains("分辨率"));
        let file = std::fs::File::create(&large).unwrap(); file.set_len(crate::sync::attach::MAX_ASSET_BYTES + 1).unwrap();
        assert!(promote_image(&inbox, &images, &large).unwrap_err().contains("10MB"));
        drop(file); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mobile_knowledge_share_outgoing_validates_attachments_and_never_accepts_external_paths() {
        let (root, inbox, images, bytes) = fixture(); let source = inbox.join("photo.image");
        std::fs::write(&source, &bytes).unwrap(); let reference = promote_image(&inbox, &images, &source).unwrap();
        let cache = root.join("cache");
        let outgoing = |src: String| KnowledgeOutgoing { title: "测试".into(), text: "正文".into(), image_sources: vec![src] };
        let result = prepare_outgoing(&images, &cache, outgoing(reference.clone())).unwrap();
        assert_eq!(result["text"], "正文"); assert!(Path::new(result["imagePaths"][0].as_str().unwrap()).exists());
        let name = reference.trim_start_matches("pp-asset:");
        let local = images.join(name);
        let aliases = vec![reference.clone(), format!("images/{name}"), local.to_string_lossy().into_owned(), url::Url::from_file_path(&local).unwrap().to_string()];
        let aliases = prepare_outgoing(&images, &cache, KnowledgeOutgoing { title: "同一图片".into(), text: "正文".into(), image_sources: aliases }).unwrap();
        assert_eq!(aliases["imagePaths"].as_array().unwrap().len(), 1);
        assert_eq!(std::fs::read(aliases["imagePaths"][0].as_str().unwrap()).unwrap(), bytes);
        assert!(prepare_outgoing(&images, &cache, outgoing(format!("https://host/{}", reference))).is_err());
        assert!(prepare_outgoing(&images, &cache, outgoing(format!("pp-asset:../images/{}", reference.trim_start_matches("pp-asset:")))).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
