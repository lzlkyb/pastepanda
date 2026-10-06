//! 录屏的 Tauri 命令层：入参校验、输出路径决定、会话启停、窗口编排。
//! 业务判定都在 `session` / `quality` / `sink`，这里只做装配（规则 7 分层）。

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use super::quality::{output_file_name, RecQuality};
use super::session::{self, RecOpts};
use super::scan;
use super::{close_windows, open_control_window, open_selector_window};
use crate::data_store::DataStore;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecStartReq {
    /// 选区（虚拟屏物理像素）。
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub quality: String,
    pub sys_audio: bool,
    pub mic_audio: bool,
}

/// 热键 / 托盘 / 工具箱的统一入口：录制中 = 停止；否则开选区窗。
#[tauri::command]
pub fn rec_toggle(app: AppHandle) -> Result<(), String> {
    if session::status().recording {
        return session::stop(false).map_err(|e| e);
    }
    open_selector_window(&app);
    Ok(())
}

/// 选区窗前端挂载后调：撤销存活探针（rec/mod.rs 的世代判定）。
#[tauri::command]
pub fn rec_ready() {
    super::mark_ready();
}

/// 真正开始录制（选区窗倒计时结束 → 前端调用）。成功后开控制条窗。
#[tauri::command]
pub fn rec_start(
    app: AppHandle,
    store: State<'_, DataStore>,
    req: RecStartReq,
) -> Result<(), String> {
    if session::status().recording || session::status().finalizing {
        return Err("已有录制在进行".into());
    }
    // 画质档：非法值宁可报错也不默默换档（用户自选画质是硬需求）
    let quality = RecQuality::of_str(&req.quality)
        .ok_or_else(|| format!("未知画质档：{}", req.quality))?;
    if req.w < 16 || req.h < 16 {
        return Err("选区太小（至少 16×16）".into());
    }
    let opts = RecOpts {
        x: req.x,
        y: req.y,
        w: req.w,
        h: req.h,
        quality,
        sys_audio: req.sys_audio,
        mic_audio: req.mic_audio,
    };
    let path = decide_output_path(&app, &store)?;
    session::start(app.clone(), opts, path.clone())?;
    open_control_window(&app, (req.x, req.y, req.w, req.h));
    Ok(())
}

#[tauri::command]
pub fn rec_stop(discard: bool) -> Result<(), String> {
    session::stop(discard)
}

/// 虚拟屏物理几何（选区窗坐标换算基点；与截图 ScreenInfo 同口径 camelCase）。
#[tauri::command]
pub fn rec_virtual_screen() -> serde_json::Value {
    let (x, y, w, h) = super::virtual_screen_metrics();
    serde_json::json!({
        "originX": x,
        "originY": y,
        "width": w,
        "height": h,
    })
}

#[tauri::command]
pub fn rec_status() -> serde_json::Value {
    let s = session::status();
    serde_json::json!({
        "recording": s.recording,
        "finalizing": s.finalizing,
        "path": s.path,
        "elapsedMs": s.elapsed_ms,
        "quality": s.quality,
    })
}

#[tauri::command]
pub fn rec_close_windows(app: AppHandle) -> Result<(), String> {
    close_windows(&app);
    Ok(())
}

/// 「重录上次区域」（HUD 按钮 / 托盘）：沿用上次区域与参数直入倒计时。
#[tauri::command]
pub fn rec_rerecord(app: AppHandle) -> Result<(), String> {
    super::open_rerecord(&app)
}

/// 选区窗挂载后取重录计划（URL 带 mode=rerecord 才会调；一次性消费）。
#[tauri::command]
pub fn rec_take_rerecord() -> Option<serde_json::Value> {
    super::take_rerecord().map(|o| {
        serde_json::json!({
            "x": o.x, "y": o.y, "w": o.w, "h": o.h,
            "quality": o.quality.as_str(),
            "sysAudio": o.sys_audio, "micAudio": o.mic_audio,
        })
    })
}

/// HUD 窗挂载后取通知数据（一次性消费；None = 数据已被更新的窗取走）。
#[tauri::command]
pub fn rec_hud_take() -> Option<serde_json::Value> {
    super::take_hud_data()
}

/// 「最近录制」列表：扫保存目录最近 5 条（不入库）。
#[tauri::command]
pub fn rec_list_files(app: AppHandle, store: State<'_, DataStore>) -> Result<Vec<serde_json::Value>, String> {
    let dir = save_dir(&app, &store)?;
    Ok(scan::scan_recent(&dir, 5)
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "name": m.name, "path": m.path, "bytes": m.bytes, "durationMs": m.duration_ms,
            })
        })
        .collect())
}

/// 删除一个录制文件（路径校验：保存目录内 + 文件名白名单）。
#[tauri::command]
pub fn rec_delete_file(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<(), String> {
    let dir = save_dir(&app, &store)?;
    scan::delete_rec_file(&dir, Path::new(&path))
}

/// 用系统播放器打开录屏产物（同删除的白名单校验，防任意路径打开）。
#[tauri::command]
pub fn rec_open_file(app: AppHandle, store: State<'_, DataStore>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = save_dir(&app, &store)?;
    scan::validate_rec_path(&dir, Path::new(&path))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开失败：{e}"))
}

/// 资源管理器定位录屏产物（同上校验）。
#[tauri::command]
pub fn rec_reveal(app: AppHandle, store: State<'_, DataStore>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = save_dir(&app, &store)?;
    scan::validate_rec_path(&dir, Path::new(&path))?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| format!("定位失败：{e}"))
}

/// 输出目录：config `rec_save_dir` 优先；默认 `视频\PastePanda\`。
/// 列表 / 删除与落盘共用这一口径（规则 11.1 收口）。
fn save_dir(app: &AppHandle, store: &State<'_, DataStore>) -> Result<PathBuf, String> {
    let config = store.get_config().unwrap_or_default();
    let custom = config
        .get("rec_save_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    match custom {
        Some(d) => Ok(d),
        None => app
            .path()
            .video_dir()
            .map(|p| p.join("PastePanda"))
            .map_err(|e| format!("定位「视频」目录失败：{e}")),
    }
}

/// 输出路径：同名冲突追加 `_2`、`_3`…（一秒内连续两次录制不再互相覆盖）。
/// 目录不存在时先建（被清理过的目录不再让开录直接失败）。
fn decide_output_path(app: &AppHandle, store: &State<'_, DataStore>) -> Result<PathBuf, String> {
    let dir = save_dir(app, store)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建保存目录失败：{e}"))?;
    let stem = output_file_name(chrono::Local::now());
    let stem = stem.trim_end_matches(".mp4").to_string();
    let mut candidate = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}_{n}.mp4"));
        n += 1;
    }
    Ok(candidate)
}
