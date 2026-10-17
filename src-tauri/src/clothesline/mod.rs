//! 晾衣绳会话与窗口桥。图片采集只读统一入库事件，不改变复制或截图出口。
mod commands;
mod desktop;
pub mod model;
mod window;
pub use commands::*;
use model::{Model, Photo};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Listener};
pub use window::{CaptureGuard, DragGuard};
pub use window::{pin_drag, pin_drag_cancel, restore_drag_pin, set_suspended};

static MODEL: OnceLock<Mutex<Model>> = OnceLock::new();
pub(crate) fn model() -> std::sync::MutexGuard<'static, Model> {
    MODEL
        .get_or_init(|| Mutex::new(Model::default()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}
pub(crate) fn publish(app: &AppHandle) {
    let snapshot = model().snapshot.clone();
    let _ = app.emit_to(window::LABEL, "clothesline-update", snapshot);
}
pub fn configure(app: &AppHandle, config: &serde_json::Value) {
    let keys = [
        "clothesline",
        "clothesline_wind",
        "clothesline_locked",
        "clothesline_anchors",
    ];
    if !keys.iter().any(|key| config.get(key).is_some()) {
        return;
    }
    model().configure(config);
    if !model().snapshot.enabled {
        window::disable(app);
    } else if !model().snapshot.items.is_empty() {
        window::ensure(app);
    }
    publish(app);
    let filtered: serde_json::Map<String, serde_json::Value> = keys
        .iter()
        .filter_map(|key| {
            config
                .get(key)
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect();
    let _ = app.emit(
        "clothesline-config-changed",
        serde_json::Value::Object(filtered),
    );
}
fn image_from_event(payload: &str) -> Option<crate::data_store::HistoryItem> {
    let payload: serde_json::Value = serde_json::from_str(payload).ok()?;
    // 复用 HistoryItem 的序列化协议（item_type 在事件中叫 type），避免手写字段名漂移。
    let item: crate::data_store::HistoryItem =
        serde_json::from_value(payload.get("item")?.clone()).ok()?;
    (item.item_type == "image").then_some(item)
}
pub fn init(app: &AppHandle, config: &serde_json::Value) {
    desktop::install(app);
    configure(app, config);
    let handle = app.clone();
    app.listen("clipboard-changed", move |event| {
        if !model().snapshot.enabled {
            return;
        }
        let Some(item) = image_from_event(event.payload()) else {
            return;
        };
        let key = format!("{}:{}", item.id, item.time);
        let id = item.id;
        let source = item.source;
        let handle = handle.clone();
        let path = item.content;
        // 解码和文件校验放后台；主采集事件不得被缩略图或建窗拖住。
        tauri::async_runtime::spawn_blocking(move || {
            if !model().snapshot.enabled {
                return;
            }
            let Ok((width, height)) =
                crate::commands::check_image_decode_limits(std::path::Path::new(&path))
            else {
                return;
            };
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "截图".into());
            let photo = Photo {
                id,
                path,
                name,
                source,
                width,
                height,
            };
            if model().collect(photo, key) {
                window::ensure(&handle);
                publish(&handle);
            }
        });
    });
}
pub(crate) fn photo_from_path(path: &str) -> Result<Photo, String> {
    let canonical = crate::commands::validate_image_file_path(path)?;
    let (width, height) = crate::commands::check_image_decode_limits(&canonical)?;
    Ok(Photo {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.into(),
        name: canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        source: "桌面贴图".into(),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_clipboard_event_routes_images_and_ignores_other_items() {
        // 使用生产事件的序列化器，防止手写夹具把字段名错误一起复制进测试。
        let mut item: crate::data_store::HistoryItem = serde_json::from_value(serde_json::json!({
            "id":"capture-1", "text":"[图片]", "time":"2026-10-12 15:07:00",
            "type":"image", "content":"C:/shots/a.png", "pinned":false,
            "source":"PastePanda", "workspace":"默认", "md5":null
        }))
        .unwrap();
        let payload = serde_json::to_string(&crate::clipboard_monitor::ClipboardChanged {
            item: item.clone(),
        })
        .unwrap();
        assert_eq!(
            image_from_event(&payload).map(|p| p.id),
            Some(item.id.clone())
        );
        item.item_type = "text".into();
        let payload =
            serde_json::to_string(&crate::clipboard_monitor::ClipboardChanged { item }).unwrap();
        assert!(image_from_event(&payload).is_none());
        assert!(image_from_event("invalid").is_none());
    }
}
