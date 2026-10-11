//! ScreenCaptureKit + AVAssetWriter session behind the shared recording UI.
pub use super::session_types::{RecOpts, RecStatus};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
static NEXT: AtomicU64 = AtomicU64::new(1);
static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static LAST: Mutex<Option<RecOpts>> = Mutex::new(None);
struct Active {
    token: u64,
    app: AppHandle,
    path: PathBuf,
    opts: RecOpts,
    starting: bool,
    stopping: bool,
    discard: bool,
    paused: bool,
    sidecar: super::events::SidecarRecorder,
    video_stop: Arc<AtomicBool>,
}
extern "C" {
    fn pp_rec_start(
        token: u64,
        json: *const u8,
        length: usize,
        callback: extern "C" fn(u64, i32, u64, u64),
        event_callback: extern "C" fn(u64, u32, u32, f64, f64, u64, u64),
    ) -> i32;
    fn pp_rec_stop(token: u64) -> i32;
    fn pp_rec_fail(token: u64, code: i32) -> i32;
    fn pp_rec_submit_rgba(
        token: u64,
        rgba: *const u8,
        length: usize,
        width: u32,
        height: u32,
    ) -> i32;
    fn pp_rec_mark(token: u64) -> i32;
    fn pp_rec_pause(token: u64, paused: bool) -> i32;
    fn pp_rec_progress(token: u64, frames: *mut u64, elapsed: *mut u64) -> i32;
}
fn error(code: i32) -> String {
    match code {
        2 => "录屏需要屏幕录制权限，请在系统设置中允许 PastePanda 后重启",
        3 => "录屏会话或输出文件已存在，请重新开始",
        4 => "Mac 屏幕采集失败或超时，请检查权限并重试",
        5 => "Mac 视频或音频编码失败",
        6 => "未捕获到有效视频帧，请检查屏幕录制权限",
        10 => "请在麦克风授权提示中允许 PastePanda，然后再次开始录制；如已拒绝，请在系统设置 → 隐私与安全 → 麦克风中开启",
        11 => "Mac 麦克风采集失败，请检查输入设备并重试",
        12 => "未找到可用麦克风，请连接输入设备或关闭麦克风选项",
        13 => "麦克风录制需要包含权限说明的 Mac 应用包，请打开 PastePanda.app 后重试",
        14 => "点击高亮帧处理失败，录制已停止",
        15 => "记录事件轨需要辅助功能权限，请在系统设置 → 隐私与安全 → 辅助功能中允许 PastePanda，再开始录制",
        16 => "无法监听录屏点击与按键，请检查系统权限",
        17 => "录制期间显示器布局或缩放发生变化，请重新开始",
        8 => "当前 Mac 录屏适配需要 macOS 13 或更高版本",
        _ => "Mac 录屏未能启动",
    }
    .into()
}
use super::mac_validation::validate;
pub fn start(app: AppHandle, opts: RecOpts, path: PathBuf) -> Result<(), String> {
    let monitors = crate::macos::screen::native_monitors()?;
    let geometry: Vec<_> = monitors.iter().map(|m| m.monitor.clone()).collect();
    let desktop = crate::macos::screen_layout::bounds(&geometry)?;
    validate(&opts, (desktop.x, desktop.y, desktop.w, desktop.h))?;
    let region = crate::macos::screen_layout::Rect {
        x: opts.x,
        y: opts.y,
        w: opts.w as i32,
        h: opts.h as i32,
    };
    crate::macos::screen_layout::validate_region(&geometry, region)?;
    let covering = monitors
        .iter()
        .find(|m| region.intersect((&m.monitor).into()) == Some(region));
    let external = covering.is_none();
    let source = covering
        .or_else(|| monitors.iter().find(|m| m.monitor.primary))
        .ok_or("未找到录制显示器")?;
    let scale = source.scale;
    let (w, h) = super::quality::encoded_size(opts.quality, opts.w, opts.h);
    let json=serde_json::to_vec(&serde_json::json!({"path":path,"x":opts.x,"y":opts.y,"sourceWidth":opts.w,"sourceHeight":opts.h,
        "displayId":source.display_id,"displayX":source.monitor.x,"displayY":source.monitor.y,"externalVideo":external,"width":w,"height":h,"fps":opts.quality.fps(),"bitrate":opts.quality.bitrate(w),"codec":opts.quality.codec().as_str(),"sysAudio":opts.sys_audio,"micAudio":opts.mic_audio,"scale":scale,"clickHighlight":opts.click_highlight,"eventSidecar":opts.event_sidecar}))
        .map_err(|e|format!("录屏参数编码失败: {e}"))?;
    let token = NEXT.fetch_add(1, Ordering::Relaxed);
    let video_stop = Arc::new(AtomicBool::new(false));
    {
        let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_some() {
            return Err("已有录制在进行".into());
        }
        *slot = Some(Active {
            token,
            app,
            path,
            opts: opts.clone(),
            starting: true,
            stopping: false,
            discard: false,
            paused: false,
            sidecar: super::events::SidecarRecorder::new(opts.event_sidecar),
            video_stop: video_stop.clone(),
        });
    }
    let capture = if external {
        match crate::rc::mac_capture::Capture::start_region(region, opts.quality.fps(), &video_stop)
        {
            Ok(capture) => Some(capture),
            Err(error) => {
                let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
                if slot.as_ref().is_some_and(|a| a.token == token) {
                    slot.take();
                }
                return Err(error);
            }
        }
    } else {
        None
    };
    if video_stop.load(Ordering::Acquire) {
        let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_some_and(|a| a.token == token) {
            slot.take();
        }
        return Err("录屏启动已取消".into());
    }
    let code = unsafe { pp_rec_start(token, json.as_ptr(), json.len(), completed, recorded_event) };
    let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    if code != 0 {
        if slot.as_ref().is_some_and(|a| a.token == token) {
            slot.take();
        }
        return Err(error(code));
    }
    let Some(active) = slot.as_mut().filter(|a| a.token == token) else {
        return Err("录屏启动期间已停止".into());
    };
    active.starting = false;
    if active.stopping {
        drop(slot);
        unsafe {
            pp_rec_stop(token);
        }
        return Err("录屏已取消".into());
    }
    drop(slot);
    if let Some(mut capture) = capture {
        let frame = match composite_frame(&mut capture, w, h) {
            Ok(frame) => frame,
            Err(message) => {
                unsafe {
                    pp_rec_fail(token, 17);
                }
                return Err(message);
            }
        };
        let code = unsafe { pp_rec_submit_rgba(token, frame.as_ptr(), frame.len(), w, h) };
        if code != 0 {
            unsafe {
                pp_rec_fail(token, code);
            }
            return Err(error(code));
        }
        let fps = opts.quality.fps().max(1);
        std::thread::Builder::new()
            .name("mac-rec-composite".into())
            .spawn(move || {
                let interval = std::time::Duration::from_secs_f64(1. / f64::from(fps));
                while !video_stop.load(Ordering::Acquire) {
                    let paused = ACTIVE
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .as_ref()
                        .is_some_and(|a| a.token == token && a.paused);
                    if paused {
                        std::thread::sleep(interval);
                        continue;
                    }
                    let start = std::time::Instant::now();
                    let frame = match composite_frame(&mut capture, w, h) {
                        Ok(frame) => frame,
                        Err(message) => {
                            log::warn!("Mac 多屏录制停止：{message}");
                            unsafe {
                                pp_rec_fail(
                                    token,
                                    if message.contains("布局或缩放") {
                                        17
                                    } else {
                                        4
                                    },
                                );
                            }
                            break;
                        }
                    };
                    if video_stop.load(Ordering::Acquire) {
                        break;
                    }
                    let code =
                        unsafe { pp_rec_submit_rgba(token, frame.as_ptr(), frame.len(), w, h) };
                    if code != 0 {
                        unsafe {
                            pp_rec_fail(token, code);
                        }
                        break;
                    }
                    std::thread::sleep(interval.saturating_sub(start.elapsed()));
                }
            })
            .map_err(|e| {
                unsafe {
                    pp_rec_fail(token, 4);
                }
                format!("无法启动多屏录制线程：{e}")
            })?;
    }
    *LAST.lock().unwrap_or_else(|p| p.into_inner()) = Some(opts);
    Ok(())
}
pub fn last_opts() -> Option<RecOpts> {
    LAST.lock().unwrap_or_else(|p| p.into_inner()).clone()
}
pub fn stop(discard: bool) -> Result<(), String> {
    let (token, starting) = {
        let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
        let a = slot.as_mut().ok_or("没有进行中的录制")?;
        if a.stopping {
            a.discard |= discard;
            return Ok(());
        }
        a.discard = discard;
        a.stopping = true;
        a.video_stop.store(true, Ordering::Release);
        (a.token, a.starting)
    };
    let code = unsafe { pp_rec_stop(token) };
    // A cancellation before native setup is applied by start once setup finishes.
    if code != 0 && !starting {
        if let Some(a) = ACTIVE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .filter(|a| a.token == token)
        {
            a.stopping = false;
            a.discard = false;
            return Err(error(code));
        }
    }
    Ok(())
}
pub fn set_paused(app: &AppHandle, paused: bool) -> Result<(), String> {
    let token = {
        let slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
        let a = slot.as_ref().ok_or("没有进行中的录制")?;
        if a.starting || a.stopping {
            return Err("正在启动或收尾，不能暂停".into());
        }
        a.token
    };
    let code = unsafe { pp_rec_pause(token, paused) };
    if code != 0 {
        return Err(error(code));
    }
    if let Some(a) = ACTIVE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
        .filter(|a| a.token == token)
    {
        a.paused = paused;
    }
    let _ = app.emit("rec-paused", serde_json::json!({"paused":paused}));
    Ok(())
}
pub fn send_mark() {
    let token = ACTIVE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|a| a.token);
    if let Some(token) = token {
        unsafe {
            pp_rec_mark(token);
        }
    }
}
extern "C" fn recorded_event(
    token: u64,
    kind: u32,
    code: u32,
    x: f64,
    y: f64,
    flags: u64,
    time: u64,
) {
    use super::event_types::{MouseBtn, RecEvent};
    let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(a) = slot.as_mut().filter(|a| a.token == token && !a.discard) else {
        return;
    };
    let (event, xy) = match kind {
        1 if x.is_finite()
            && y.is_finite()
            && x >= 0.
            && y >= 0.
            && x < f64::from(a.opts.w)
            && y < f64::from(a.opts.h) =>
        {
            let button = match code {
                0 => MouseBtn::Left,
                1 => MouseBtn::Right,
                2 => MouseBtn::Middle,
                _ => return,
            };
            (
                RecEvent::Click {
                    x: x as i32,
                    y: y as i32,
                    button,
                },
                Some((x as i32, y as i32)),
            )
        }
        2 => {
            let Some(combo) = super::mac_keys::combo(code, flags) else {
                return;
            };
            (RecEvent::Key { combo }, None)
        }
        3 => (RecEvent::Mark, None),
        _ => return,
    };
    a.sidecar.record(&event, xy, time);
}
pub fn status() -> RecStatus {
    let snapshot = ACTIVE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|a| {
            (
                a.token,
                a.path.clone(),
                a.opts.quality,
                a.starting,
                a.stopping,
                a.paused,
            )
        });
    let Some((token, path, quality, starting, stopping, paused)) = snapshot else {
        return RecStatus {
            recording: false,
            finalizing: false,
            paused: false,
            path: None,
            elapsed_ms: 0,
            bytes: 0,
            quality: None,
        };
    };
    let (mut frames, mut elapsed) = (0, 0);
    unsafe {
        pp_rec_progress(token, &mut frames, &mut elapsed);
    }
    RecStatus {
        recording: !starting && !stopping,
        finalizing: starting || stopping,
        paused,
        path: Some(path.display().to_string()),
        elapsed_ms: elapsed,
        bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        quality: Some(quality.as_str().into()),
    }
}
extern "C" fn completed(token: u64, code: i32, frames: u64, duration_ms: u64) {
    let active = {
        let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_none_or(|a| a.token != token) {
            return;
        }
        slot.take()
    };
    let Some(a) = active else {
        return;
    };
    a.video_stop.store(true, Ordering::Release);
    let result=std::thread::Builder::new().name("mac-rec-finish".into()).spawn(move||{
        super::close_windows(&a.app);
        if a.discard { if code == 0 || !a.starting {let _=std::fs::remove_file(&a.path);}return; }
        let hud=a.app.get_webview_window("main").map(|w|!w.is_visible().unwrap_or(false)||w.is_minimized().unwrap_or(false)).unwrap_or(true);
        if code!=0 {let message=error(code);let _=a.app.emit("rec-failed",serde_json::json!({"message":message,"hud":hud}));
            if hud {super::open_hud_window(&a.app,&serde_json::json!({"ok":false,"message":message}));}return;}
        let bytes=std::fs::metadata(&a.path).map(|m|m.len()).unwrap_or(0);
        let (w,h)=super::quality::encoded_size(a.opts.quality,a.opts.w,a.opts.h);
        let note=a.sidecar.write(&a.path,duration_ms,(a.opts.x,a.opts.y,a.opts.w,a.opts.h),(w,h,a.opts.quality.fps()))
            .err().or_else(||a.sidecar.warning().map(str::to_owned));
        let data=serde_json::json!({"path":a.path.display().to_string(),"bytes":bytes,"duration_ms":duration_ms,"frames":frames,"note":note,"hud":hud});
        let _=a.app.emit("rec-done",data.clone());
        if hud {super::open_hud_window(&a.app,&serde_json::json!({"ok":true,"path":a.path.display().to_string(),"bytes":bytes,"duration_ms":duration_ms,"note":note}));}
    });
    if let Err(e) = result {
        log::error!("Mac 录屏收尾通知失败: {e}");
    }
}

fn composite_frame(
    capture: &mut crate::rc::mac_capture::Capture,
    w: u32,
    h: u32,
) -> Result<Vec<u8>, String> {
    let (sw, sh, bytes) = capture.frame()?;
    if (sw, sh) == (w, h) {
        return Ok(bytes);
    }
    let frame = image::RgbaImage::from_raw(sw, sh, bytes).ok_or("录屏图像尺寸无效")?;
    Ok(image::imageops::resize(&frame, w, h, image::imageops::FilterType::Triangle).into_raw())
}
