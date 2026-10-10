//! Cocoa floating image windows; all Cocoa operations run on the main queue.
use std::{
    collections::BTreeMap,
    ffi::CString,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::Manager;
static WINDOWS: Mutex<BTreeMap<u64, (tauri::AppHandle, String)>> = Mutex::new(BTreeMap::new());
static NEXT: AtomicU64 = AtomicU64::new(1);
extern "C" {
    fn pp_pin_open(id: u64, path: *const std::ffi::c_char, callback: extern "C" fn(u64, u8))
        -> i32;
    fn pp_pin_action(id: u64, action: u8);
    fn pp_pin_feedback(id: u64, message: *const std::ffi::c_char);
}
extern "C" fn on_action(id: u64, action: u8) {
    let entry = {
        let mut windows = WINDOWS.lock().unwrap_or_else(|p| p.into_inner());
        if action == 255 {
            windows.remove(&id);
            return;
        }
        windows.get(&id).cloned()
    };
    let Some((app, path)) = entry else {
        return;
    };
    if action == 11 {
        crate::screenshot::open_editor_window(&app, path);
        return;
    }
    if action != 10 {
        return;
    }
    std::thread::spawn(move || {
        let result = (|| {
            let store = app.try_state::<crate::data_store::DataStore>();
            let cached = store
                .as_ref()
                .and_then(|s| s.get_ocr_text(&path).ok().flatten());
            let text = match cached {
                Some(text) => text,
                None => {
                    let text = crate::commands::ocr_full_text(&path)?;
                    if let Some(store) = store {
                        let _ = store.set_ocr_text(&path, &text);
                    }
                    text
                }
            };
            if text.trim().is_empty() {
                return Err("未识别到文字".to_string());
            }
            app.try_state::<crate::paste_engine::PasteEngine>()
                .ok_or("粘贴引擎未就绪".to_string())?
                .copy_only(&text)?;
            Ok::<_, String>(())
        })();
        let message = result.err().unwrap_or_else(|| "文字已复制".into());
        if let Ok(message) = CString::new(message) {
            unsafe {
                pp_pin_feedback(id, message.as_ptr());
            }
        }
    });
}
pub fn create_native_window(app: tauri::AppHandle, image_path: &str) -> Result<(), String> {
    crate::commands::check_image_decode_limits(std::path::Path::new(image_path))?;
    let path = CString::new(image_path).map_err(|_| "图片路径无效")?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    WINDOWS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id, (app, image_path.into()));
    let status = unsafe { pp_pin_open(id, path.as_ptr(), on_action) };
    if status != 0 {
        WINDOWS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        return Err("无法创建 Mac 贴图窗口".into());
    }
    Ok(())
}
fn matching(path: Option<&str>) -> Vec<u64> {
    WINDOWS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(_, (_, p))| path.is_none_or(|path| p == path))
        .map(|(id, _)| *id)
        .collect()
}
pub fn list_pinned_images() -> Vec<String> {
    WINDOWS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .map(|(_, p)| p.clone())
        .collect()
}
pub fn close_current_window() {
    for id in matching(None) {
        unsafe {
            pp_pin_action(id, 255);
        }
    }
}
pub fn close_pinned_by_path(path: &str) {
    for id in matching(Some(path)) {
        unsafe {
            pp_pin_action(id, 255);
        }
    }
}
pub fn transform_pinned_image_by_path(path: &str, action: u8) {
    if !(1..=4).contains(&action) {
        return;
    }
    for id in matching(Some(path)) {
        unsafe {
            pp_pin_action(id, action);
        }
    }
}
