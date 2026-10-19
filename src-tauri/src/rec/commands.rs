//! 录屏的 Tauri 命令层：入参校验、输出路径决定、会话启停、窗口编排。
//! 业务判定都在 `session` / `quality` / `sink`，这里只做装配（规则 7 分层）。

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::events;
use super::quality::{output_file_name, RecQuality};
use super::scan;
use super::session::{self, RecOpts};
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
        return session::stop(false);
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
    let quality = check_start_req(&req)?;
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
        click_highlight: cfg
            .get("rec_click_highlight")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        event_sidecar: cfg
            .get("rec_event_sidecar")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    };
    let path = decide_output_path(&app, &store)?;
    // 归零到「控制条出现」的这段就是用户眼里的「卡一下」：预热命中后应当是几十毫秒级，
    // 打点是为了让「还差多少」有数字，不是靠猜（规则 8）。
    let opened_at = std::time::Instant::now();
    session::start(app.clone(), opts, path.clone())?;
    if let Err(error) = open_control_window(&app, (req.x, req.y, req.w, req.h)) {
        // 控制条是停止入口；创建失败不能留下无出口的后台采集。保留已有内容。
        log::warn!("[Rec] {error}，停止并保存本次录制");
        session::stop(false)?;
        return Err(error);
    }
    log::info!("[Rec] rec_start 返回用时 {}ms", opened_at.elapsed().as_millis());
    Ok(())
}

/// Explicit device setup probe; availability is checked again by the recording worker.
#[tauri::command]
pub async fn rec_audio_check(sys_audio:bool,mic_audio:bool)->Result<serde_json::Value,String> {
    tauri::async_runtime::spawn_blocking(move||session::check_audio(sys_audio,mic_audio)).await.map_err(|error|format!("检查声音设备失败：{error}"))
}

/// 开录入参的公共校验（`rec_start` 与 `rec_prewarm` 同一套；规则 11.1：两处各写
/// 一遍，预热就会带着「start 会拒绝的参数」去开一个编码器）。
/// 画质与尺寸两处都必须同源——它们进的就是编码器键。
fn check_start_req(req: &RecStartReq) -> Result<RecQuality, String> {
    let quality =
        RecQuality::of_str(&req.quality).ok_or_else(|| format!("未知画质档：{}", req.quality))?;
    if req.w < 16 || req.h < 16 {
        return Err("选区太小（至少 16×16）".into());
    }
    Ok(quality)
}

/// 倒计时期间预热编码器（乙案，2026-10-11）：把「开硬件编码器」那 ≈2.8s 从
/// `rec_start` 挪进倒计时的 3 秒空档，归零时 `rec_start` 才能秒回。
/// 命令本身即刻返回——预热在工作线程上跑，前端不等它。
/// 预热失败/超时不影响正确性：正式路径照旧自行打开（见 `rec::prewarm`）。
#[tauri::command]
pub fn rec_prewarm(app: AppHandle, req: RecStartReq) -> Result<(), String> {
    let quality = check_start_req(&req)?;
    prewarm_encoder(&app, quality, &req)
}

#[cfg(windows)]
fn prewarm_encoder(app: &AppHandle, quality: RecQuality, req: &RecStartReq) -> Result<(), String> {
    // 画布尺寸这里只能取 GetSystemMetrics（DXGI 复制画布要等会话首帧）；
    // 两者不一致时键不命中，正式路径自行打开——是慢一次，不是错一次。
    let (ox, oy, cw, ch) = super::selector_screen_metrics(app)?;
    super::prewarm::request(super::prewarm::enc_key(
        quality,
        req.x,
        req.y,
        req.w,
        req.h,
        (ox, oy, cw.max(0) as u32, ch.max(0) as u32),
    ));
    Ok(())
}

/// Mac 无这一段开销（AVAssetWriter 不需要 MF 选型），预热留空操作让前端只有一条调用路径。
#[cfg(not(windows))]
fn prewarm_encoder(_app: &AppHandle, _quality: RecQuality, _req: &RecStartReq) -> Result<(), String> {
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
pub fn rec_virtual_screen(app: AppHandle) -> Result<serde_json::Value, String> {
    let (x, y, w, h) = super::selector_screen_metrics(&app)?;
    Ok(serde_json::json!({
        "originX": x,
        "originY": y,
        "width": w,
        "height": h,
    }))
}

#[tauri::command]
pub fn rec_status() -> serde_json::Value {
    let s = session::status();
    serde_json::json!({
        "recording": s.recording,
        "starting": s.starting,
        "finalizing": s.finalizing,
        "paused": s.paused,
        "path": s.path,
        "elapsedMs": s.elapsed_ms,
        "bytes": s.bytes,
        "quality": s.quality,
        "warnings":s.warnings, "sysAudio":s.sys_audio,"micAudio":s.mic_audio,
        "sysAudioActive":s.sys_audio_active,"micAudioActive":s.mic_audio_active,
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
pub fn rec_list_files(
    app: AppHandle,
    store: State<'_, DataStore>,
) -> Result<Vec<serde_json::Value>, String> {
    let dir = save_dir(&app, &store)?;
    Ok(scan::scan_recent(&dir, 5)?
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "name": m.name, "path": m.path, "bytes": m.bytes, "durationMs": m.duration_ms,"note":m.note,
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
pub fn rec_open_file(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = save_dir(&app, &store)?;
    scan::validate_rec_output_path(&dir, Path::new(&path))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开失败：{e}"))
}

/// 资源管理器定位录屏产物（同上校验）。
#[tauri::command]
pub fn rec_reveal(app: AppHandle, store: State<'_, DataStore>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = save_dir(&app, &store)?;
    scan::validate_rec_output_path(&dir, Path::new(&path))?;
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
pub async fn rec_keyframes(
    app: AppHandle,
    store: State<'_, DataStore>,
    path: String,
) -> Result<serde_json::Value, String> {
    let p = validated_rec_path(&app, &store, &path)?;
    let kf = tauri::async_runtime::spawn_blocking(move || trim::scan_keyframes(&p))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({
        "durationMs": kf.duration_ms,
        "keyframesMs": kf.keyframes_ms,
        "warning": kf.warning,
        "fps": kf.fps,
    }))
}

/// 关键帧对齐无损剪切（后端再按宁多勿少吸附一次）：产物落**新文件**
/// （原名 + `_剪`，冲突加序号），原文件不动。返回实际入出点（吸附后）。
#[tauri::command]
pub async fn rec_trim(
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
    let job=trim::start_job(&src)?;
    let _ = app.emit("rec-files-changed", ());
    let trim_source = src.clone();
    let trim_destination = dst.clone();
    let worker=job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(||trim::trim_with_job(&trim_source,in_ms,out_ms,&trim_destination,Some(&worker))))
            .unwrap_or_else(|_|Err("裁剪处理异常，原录像未修改".into()))
    }).await.unwrap_or_else(|error|Err(format!("裁剪任务失败：{error}")));
    if let Ok((_,start,end))=result.as_ref() {events::write_sidecar_for_trim(&src,&dst,*start,*end);}
    job.finish(&result,&dst);
    // A preview can be destroyed at any time; the main list receives all terminal states.
    let _ = app.emit("rec-files-changed", ());
    let (bytes,in_m,out_m)=result?;
    Ok(serde_json::json!({
        "path": dst.to_string_lossy(),
        "bytes": bytes,
        "inMs": in_m,
        "outMs": out_m,
    }))
}

#[tauri::command]
pub fn rec_trim_status(app:AppHandle,store:State<'_,DataStore>,path:String)->Result<serde_json::Value,String> {
    let source=validated_rec_path(&app,&store,&path)?;
    serde_json::to_value(trim::job_status(&source)).map_err(|error|error.to_string())
}
#[tauri::command]
pub fn rec_trim_cancel(app:AppHandle,store:State<'_,DataStore>,path:String)->Result<(),String> {
    let source=validated_rec_path(&app,&store,&path)?;
    trim::cancel_job(&source);
    let _ = app.emit("rec-files-changed", ());
    Ok(())
}

/// 打开预览裁剪窗（HUD「✂ 预览」/ 最近录制行尾 ✂ 共用入口）。
/// <video> 走 asset 协议读文件，产物目录在 $APPDATA 外——按次放行资产白名单。
#[tauri::command]
pub async fn rec_open_preview(
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
    )
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

/* ── 预览窗窗壳（2026-10-18：可缩放 + 三键 + 最大化态） ───────────────── */

/// 预览窗三键 + 最大化态查询。**走注入窗口而不是 JS 的 Window API**：
/// per-window ACL 是本项目一整类静默故障的来源（`src/lib/rcWindowOps.ts` 文件头
/// 的 2026-09-18 / 09-25 两次前科），自定义命令不经 ACL，失败以 String 返回。
/// 返回值 = 操作后的最大化状态，前端据此切换圆角与「还原」图标，不必再问一次。
#[tauri::command]
pub fn rec_preview_window(window: tauri::Window, op: String) -> Result<bool, String> {
    match op.as_str() {
        "minimize" => window.minimize().map_err(|e| format!("最小化窗口被拒绝：{e}"))?,
        "toggle-max" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| format!("还原窗口被拒绝：{e}"))?;
            } else {
                window.maximize().map_err(|e| format!("最大化窗口被拒绝：{e}"))?;
            }
        }
        "close" => window.close().map_err(|e| format!("关闭窗口被拒绝：{e}"))?,
        // 查询：resize / 系统最大化（双击标题栏、Win+↑）之后前端对不上状态时用
        "query" => {}
        other => return Err(format!("未知的窗口操作：{other}")),
    }
    // 关闭后窗口已失效：这里读不到就按「非最大化」回，不把收尾报成错误
    Ok(window.is_maximized().unwrap_or(false))
}

/// HUD 结果卡的高度上下限（逻辑像素）。
///
/// 上限 560：再高就不是「通知卡」而是一块面板，遮住的桌面比信息更值钱；
/// 超出部分交给卡片内部滚动（`.warn` 是唯一可压缩段）。
const HUD_MIN_H: f64 = 280.0;
const HUD_MAX_H: f64 = 560.0;

/// 内容高（逻辑像素）→ 窗口高（物理像素）。纯函数，便于单测倍数与夹取。
fn fit_height(logical: f64, scale: f64) -> u32 {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let value = if logical.is_finite() { logical } else { HUD_MIN_H };
    (value.clamp(HUD_MIN_H, HUD_MAX_H) * scale).round() as u32
}

/// 结果卡内容比窗口高时把 HUD 撑高（**底边不动，向上长**）。
///
/// 为什么不是固定 280：`note` 是运行时 warnings 的 `join("；")`，条数不固定；
/// 固定高度下多一条警告就会把「预览并裁剪 / 再录一次」推出视口——
/// 那是这张卡存在的理由（2026-10-18 实测：三条警告时内容 342 > 280）。
#[tauri::command]
pub fn rec_hud_fit(window: tauri::Window, height: f64) -> Result<(), String> {
    let target = fit_height(height, window.scale_factor().unwrap_or(1.0)) as i32;
    let size = window.outer_size().map_err(|e| format!("读取结果卡尺寸失败：{e}"))?;
    let current = i32::try_from(size.height).unwrap_or(0);
    // 差 1px 以内不折腾窗口：前端每次渲染都会量，抖动一次就够了
    if (current - target).abs() <= 1 {
        return Ok(());
    }
    let pos = window.outer_position().map_err(|e| format!("读取结果卡位置失败：{e}"))?;
    let bottom = pos.y + current;
    window
        .set_size(tauri::PhysicalSize::new(size.width, target.max(1) as u32))
        .map_err(|e| format!("调整结果卡高度被拒绝：{e}"))?;
    window
        .set_position(tauri::PhysicalPosition::new(pos.x, bottom - target))
        .map_err(|e| format!("调整结果卡位置被拒绝：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_window_command_runs_off_the_main_thread() {
        let declaration = include_str!("commands.rs").split("/// 打开预览裁剪窗").nth(1).unwrap().split("/// 预览窗挂载").next().unwrap();
        assert!(declaration.contains("pub async fn rec_open_preview("), "native webview construction must run off the Tauri main thread");
    }

    /// HUD 结果卡的高度必须跟着内容走：`note` 是运行时 warnings 的拼接，条数不固定。
    #[test]
    fn hud_fit_height_is_clamped_to_a_sane_range() {
        assert_eq!(fit_height(280.0, 1.0), 280);
        assert_eq!(fit_height(342.0, 1.0), 342);
        // 内容再长也只是一张卡；超出上限的部分交给卡片内部滚动
        assert_eq!(fit_height(900.0, 1.0), 560);
        assert_eq!(fit_height(10.0, 1.0), 280);
        // 125% 缩放下夹的是物理像素
        assert_eq!(fit_height(342.0, 1.25), 428);
        assert_eq!(fit_height(f64::NAN, 1.0), 280);
    }
}
