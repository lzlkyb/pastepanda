use super::model::{Photo, Pin, Rect, Snapshot};
use super::{model, photo_from_path, publish, window};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn clothesline_state() -> Snapshot {
    model().snapshot.clone()
}
#[tauri::command]
pub fn clothesline_ready(app: AppHandle) -> Result<(), String> {
    window::ready(&app)
}
#[tauri::command]
pub fn clothesline_report_error(app: AppHandle, message: String) -> Result<(), String> {
    app.emit("clothesline-error", message).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn clothesline_retry(app: AppHandle) -> Result<(), String> {
    window::retry(&app)
}
#[tauri::command]
pub fn clothesline_regions(regions: Vec<Rect>, dragging: bool) -> Result<(), String> {
    if regions.len() > 64 || regions.iter().any(|r| !r.valid()) {
        return Err("晾衣绳命中区域无效".into());
    }
    let mut m = model();
    m.regions = regions;
    m.dragging = dragging;
    Ok(())
}
#[tauri::command]
pub fn clothesline_remove(app: AppHandle, ids: Vec<String>) {
    model().remove(&ids);
    publish(&app);
}
#[tauri::command]
pub fn clothesline_restore(app: AppHandle, items: Vec<Photo>) -> Result<(), String> {
    for item in &items {
        crate::commands::validate_image_file_path(&item.path)?;
    }
    model().restore(items);
    window::ensure(&app);
    publish(&app);
    Ok(())
}
#[tauri::command]
pub fn clothesline_order(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    {
        let mut m = model();
        let mut remaining: std::collections::HashMap<_, _> = m.snapshot.items.iter().map(|p| (p.id.clone(), p.clone())).collect();
        let mut ordered = Vec::new();
        for id in ids {
            if let Some(photo) = remaining.remove(&id) {
                ordered.push(photo);
            }
        }
        ordered.extend(m.snapshot.items.iter().filter(|p| remaining.contains_key(&p.id)).cloned());
        m.snapshot.items = ordered;
    }
    publish(&app);
    Ok(())
}
#[tauri::command]
pub fn clothesline_idle(app: AppHandle) {
    if model().snapshot.items.is_empty() {
        window::hide(&app);
    }
}
#[tauri::command]
pub async fn clothesline_take(app: AppHandle, id: String, rect: Rect, drag: Option<bool>) -> Result<Pin, String> {
    let photo = {
        let m = model();
        if !m.snapshot.enabled {
            return Err("请先开启晾衣绳".into());
        }
        m.snapshot
            .items
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or("照片已离开绳子")?
    };
    #[cfg(windows)]
    {
        let creator = app.clone();
        let path = photo.path.clone();
        let pin = tokio::task::spawn_blocking(move || {
            crate::pinned_window::create_clothesline_pin(creator, &path, rect, drag.unwrap_or(false))
        })
        .await
        .map_err(|e| e.to_string())??;
        // 原生窗口创建确认以后才删绳上的记录。前端转场失败时也有可见贴图兜底。
        model().remove(&[id]);
        // 连续拖动等前端释放捕获后单独启动；准备期间照片仍在鼠标下跟随。
        publish(&app);
        let fallback = pin.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            let _ = crate::pinned_window::clothesline_pin_message(
                fallback.hwnd,
                fallback.generation,
                false,
                true,
            );
        });
        Ok(pin)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, photo, rect, drag);
        Err("当前平台暂不支持晾衣绳取挂".into())
    }
}
#[tauri::command]
pub fn clothesline_start_drag(app: AppHandle, pin: Pin, rect: Rect, held: bool, point: Option<[f64; 2]>) -> Result<Pin, String> {
    #[cfg(windows)]
    {
        crate::pinned_window::clothesline_land_transfer(&app, pin.hwnd, pin.generation, rect, held, point)?;
        crate::pinned_window::clothesline_pin_info(pin.hwnd, pin.generation)
    }
    #[cfg(not(windows))]
    { let _ = (app, pin, rect, held, point); Err("当前平台暂不支持贴图".into()) }
}
#[tauri::command]
pub fn clothesline_show_pin(pin: Pin) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::pinned_window::clothesline_pin_message(pin.hwnd, pin.generation, false, false)
    }
    #[cfg(not(windows))]
    {
        let _ = pin;
        Err("当前平台暂不支持贴图".into())
    }
}
#[tauri::command]
pub fn clothesline_close_pin(pin: Pin) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::pinned_window::clothesline_pin_message(pin.hwnd, pin.generation, true, false)
    }
    #[cfg(not(windows))]
    {
        let _ = pin;
        Err("当前平台暂不支持贴图".into())
    }
}
#[tauri::command]
pub fn clothesline_return_pin(
    app: AppHandle,
    pin: Pin,
    id: Option<String>,
    slot: Option<usize>,
) -> Result<Photo, String> {
    if !model().snapshot.enabled {
        return Err("请先开启晾衣绳".into());
    }
    #[cfg(windows)]
    {
        let current = crate::pinned_window::clothesline_pin_info(pin.hwnd, pin.generation)?;
        let mut photo = photo_from_path(&current.path)?;
        if let Some(id) = id {
            photo.id = id;
        }
        // 接收验证与原生关闭都成功才写绳记录，关闭精确到代际，不能误关同路径的其它贴图。
        crate::pinned_window::clothesline_pin_message(pin.hwnd, pin.generation, true, false)?;
        model().insert(photo.clone(), slot);
        window::ensure(&app);
        publish(&app);
        Ok(photo)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pin, id, slot);
        Err("当前平台暂不支持晾衣绳取挂".into())
    }
}
#[tauri::command]
pub async fn clothesline_hang_path(app: AppHandle, path: String) -> Result<(), String> {
    if !model().snapshot.enabled {
        return Err("请先在设置中开启晾衣绳".into());
    }
    photo_from_path(&path)?;
    // 面板挂回先确认可显示的缩略图，读取失败就保留原贴图。
    crate::commands::get_image_thumbnail(app.clone(), path.clone()).await?;
    window::ensure(&app);
    window::wait_ready(&app).await?;
    if !model().snapshot.enabled {
        return Err("晾衣绳已关闭，原贴图保留".into());
    }
    #[cfg(windows)]
    {
        let pin = crate::pinned_window::clothesline_pin_for_path(&path)?;
        // 旧条件是「不在桌面就只记记录、不播转场」。那个判据问的是「桌面是否被
        // 完全挡住」，而这里真正关心的是「绳窗口现在能不能看见」——常驻之后二者
        // 不再是一回事：微信在前台时桌面被挡着，但绳仍显示在露出的那部分桌面上。
        if !window::is_shown(&app) {
            clothesline_return_pin(app, pin, None, None)?;
            return Ok(());
        }
        let mut payload = serde_json::to_value(&pin).map_err(|e| e.to_string())?;
        payload["force"] = serde_json::Value::Bool(true);
        // 一键挂回也走同一转场与接收确认，不能由管理面板瞬间关掉源窗口。
        app.emit_to(window::LABEL, "clothesline-pin-drop", payload)
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        loop {
            if model().snapshot.items.iter().any(|p| p.path == path)
                && crate::pinned_window::clothesline_pin_info(pin.hwnd, pin.generation).is_err()
            {
                return Ok(());
            }
            if start.elapsed() > std::time::Duration::from_secs(6) {
                return Err("挂回未完成，请保留原贴图并重试".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    }
    #[cfg(not(windows))]
    {
        Err("当前平台暂不支持晾衣绳取挂".into())
    }
}
#[tauri::command]
pub fn clothesline_config(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    if !config.as_object().is_some_and(|m| {
        m.keys().all(|key| {
            [
                "clothesline",
                "clothesline_wind",
                "clothesline_locked",
                "clothesline_anchors",
            ]
            .contains(&key.as_str())
        })
    }) {
        return Err("无效的晾衣绳配置".into());
    }
    if config
        .get("clothesline_anchors")
        .is_some_and(|v| !v.is_null() && !super::model::valid_anchors(v))
    {
        return Err("无效的绳端点位置".into());
    }
    app.state::<crate::data_store::DataStore>()
        .save_config(&config)?;
    super::configure(&app, &config);
    Ok(())
}
