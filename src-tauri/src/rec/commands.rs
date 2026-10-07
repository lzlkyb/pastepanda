//! 录屏的 Tauri 命令层：入参校验、输出路径决定、会话启停、窗口编排。
//! 业务判定都在 `session` / `quality` / `sink`，这里只做装配（规则 7 分层）。

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use super::events;
use super::quality::{output_file_name, RecQuality};
use super::session::{self, RecOpts};
use super::scan;
use super::trim;
use super::{close_windows, open_control_window, open_preview_window, open_selector_window};
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
/// 同时恢复交互——建窗时是整窗穿透（create_selector），就绪即放开并抢焦点。
#[tauri::command]
pub fn rec_ready(app: AppHandle) {
    super::mark_ready();
    if let Some(w) = app.get_webview_window(super::SELECT_LABEL) {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.set_focus();
    }
}

/// 真正开始录制（选区窗倒计时结束 → 前端调用）。成功后开控制条窗。
/// 🔴 必须是 async：同步命令跑在**主线程**，而 open_control_window 的
/// builder.build() 要派发到事件循环并阻塞等结果——主线程自己等自己 = 死锁，
/// 症状是倒计时永远停在 1（recStart 永不返回）、随后一切关窗命令全部失灵
/// （2026-10-06 实录踩坑）。async 命令跑在运行时线程，build 派发回主线程安全等待。
#[tauri::command]
pub async fn rec_start(
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
    // 事件轨开关（四期 1.3）：开始录制那一刻定死，录制中改设置不影响本场
    let cfg = store.get_config().unwrap_or_default();
    let opts = RecOpts {
        x: req.x,
        y: req.y,
        w: req.w,
        h: req.h,
        quality,
        sys_audio: req.sys_audio,
        mic_audio: req.mic_audio,
        click_highlight: cfg.get("rec_click_highlight").and_then(|v| v.as_bool()).unwrap_or(true),
        event_sidecar: cfg.get("rec_event_sidecar").and_then(|v| v.as_bool()).unwrap_or(true),
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

/// 暂停/继续（控制条按钮；幂等，收尾中拒绝）。时间轴提交驱动，暂停段不进产物。
#[tauri::command]
pub fn rec_pause(app: AppHandle, paused: bool) -> Result<(), String> {
    session::set_paused(&app, paused)
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
        "paused": s.paused,
        "path": s.path,
        "elapsedMs": s.elapsed_ms,
        "bytes": s.bytes,
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

/// 校验「保存目录里的一段录屏产物」并转成 PathBuf——关键帧 / 裁剪 / 预览
/// 三个命令的同一个路径闸（规则 11.1 收口，防任意路径读/写）。
fn validated_rec_path(
    app: &AppHandle,
    store: &State<'_, DataStore>,
    path: &str,
) -> Result<PathBuf, String> {
    let dir = save_dir(app, store)?;
    let p = PathBuf::from(path);
    scan::validate_rec_path(&dir, &p)?;
    Ok(p)
}

/// 视频轨关键帧索引（播放域毫秒）——预览窗时间轴的吸附刻度。
#[tauri::command]
pub fn rec_keyframes(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<serde_json::Value, String> {
    let p = validated_rec_path(&app, &store, &path)?;
    let kf = trim::scan_keyframes(&p)?;
    Ok(serde_json::json!({
        "durationMs": kf.duration_ms,
        "keyframesMs": kf.keyframes_ms,
    }))
}

/// 关键帧对齐无损剪切（后端再按宁多勿少吸附一次）：产物落**新文件**
/// （原名 + `_剪`，冲突加序号），原文件不动。返回实际入出点（吸附后）。
#[tauri::command]
pub fn rec_trim(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
    in_ms: u64,
    out_ms: u64,
) -> Result<serde_json::Value, String> {
    let src = validated_rec_path(&app, &store, &path)?;
    let dir = src.parent().ok_or("路径异常（无父目录）")?.to_path_buf();
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("文件名异常")?
        .to_string();
    let mut dst = dir.join(format!("{stem}_剪.mp4"));
    let mut n = 2;
    while dst.exists() {
        dst = dir.join(format!("{stem}_剪{n}.mp4"));
        n += 1;
    }
    let (bytes, in_m, out_m) = trim::trim(&src, in_ms, out_ms, &dst)?;
    // sidecar 跟着剪：事件重映射进 [in, out)，落「_剪」同名 .events.json
    events::write_sidecar_for_trim(&src, &dst, in_m, out_m);
    Ok(serde_json::json!({
        "path": dst.to_string_lossy(),
        "bytes": bytes,
        "inMs": in_m,
        "outMs": out_m,
    }))
}

/// 打开预览裁剪窗（HUD「✂ 预览」/ 最近录制行尾 ✂ 共用入口）。
/// <video> 走 asset 协议读文件，产物目录在 $APPDATA 外——按次放行资产白名单。
#[tauri::command]
pub fn rec_open_preview(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<(), String> {
    let p = validated_rec_path(&app, &store, &path)?;
    if !p.exists() {
        return Err("文件不存在（已被移动或删除？）".into());
    }
    app.asset_protocol_scope()
        .allow_file(&p)
        .map_err(|e| format!("媒体白名单放行失败：{e}"))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    open_preview_window(
        &app,
        serde_json::json!({ "path": p.to_string_lossy(), "name": name, "bytes": bytes }),
    );
    Ok(())
}

/// 预览窗挂载后取数据（一次性消费；None = 已被重开的窗取走）。
#[tauri::command]
pub fn rec_preview_take() -> Option<serde_json::Value> {
    super::take_preview_data()
}

/* ── GIF 导出（四期 1.5）：单任务串行，行内进度轮询 + 可取消 ── */

/// 启动导出（产物 = 同名 .gif，覆盖旧导出；原 mp4 不动）。
#[tauri::command]
pub fn rec_gif_start(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<(), String> {
    let p = validated_rec_path(&app, &store, &path)?;
    if !p.exists() {
        return Err("文件不存在（已被移动或删除？）".into());
    }
    super::gif::start(p)
}

/// 查询导出状态（前端对在跑任务每 500ms 轮询）。
#[tauri::command]
pub fn rec_gif_status(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<serde_json::Value, String> {
    let p = validated_rec_path(&app, &store, &path)?;
    let s = super::gif::status(&p);
    Ok(serde_json::json!({
        "running": s.running,
        "percent": s.percent,
        "donePath": s.done_path,
        "error": s.error,
    }))
}

/// 取消当前导出（丢弃半成品）。
#[tauri::command]
pub fn rec_gif_cancel() -> Result<(), String> {
    super::gif::cancel();
    Ok(())
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
