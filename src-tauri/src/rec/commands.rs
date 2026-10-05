//! 录屏的 Tauri 命令层：入参校验、输出路径决定、会话启停、窗口编排。
//! 业务判定都在 `session` / `quality` / `sink`，这里只做装配（规则 7 分层）。

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use super::quality::{output_file_name, RecQuality};
use super::session::{self, RecOpts};
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

/// 输出路径：config `rec_save_dir` 优先；默认 `视频\PastePanda\`。
/// 同名冲突追加 `_2`、`_3`…（一秒内连续两次录制不再互相覆盖）。
fn decide_output_path(app: &AppHandle, store: &State<'_, DataStore>) -> Result<PathBuf, String> {
    let config = store.get_config().unwrap_or_default();
    let custom = config
        .get("rec_save_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let dir = match custom {
        Some(d) => d,
        None => app
            .path()
            .video_dir()
            .map_err(|e| format!("定位「视频」目录失败：{e}"))?
            .join("PastePanda"),
    };
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
