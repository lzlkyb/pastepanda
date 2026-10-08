//! 录屏会话：一条**不经网络**的本地采集循环（区别于 rc/inbound 的推流管线）。
//!
//! 结构：`start()` 起一条专用线程跑「DXGI 抓帧 → 裁剪 → 缩放 → 硬编 → SinkWriter
//! 写 MP4」；音频（系统环回 / 麦克风）在另一条线程泵出 s16 并 AAC 编码，经
//! mpsc 交给主循环 mux。全局单会话槽 `ACTIVE`——录制中再触发录屏热键 = 停止。
//!
//! 取舍（设计稿 §7 已声明，三期 2026-10-06 修订）：编码参数会话开始时定死；
//! 静止画面不写重复帧——**时间轴按提交帧号驱动**（`已提交帧数 × 1000 / fps`，
//! 经 `set_capture_at` 喂给编码器），跳帧/暂停天然压缩、播放端时长连续；
//! 指针经 DXGI 元数据合成进帧（rec/pointer.rs），指针变化也算「有帧」；
//! 抓帧连续失败（锁屏 / 显示器关闭）→ 自动落盘停止并上报，不静默丢帧。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::rc::audio::{AacEncoder, LoopbackCapture, MicCapture};
use crate::rc::dxgi::DxgiPool;
use crate::rc::encode_h264::H264SessionEncoder;

use super::events;
use super::hooks::{self, RecEvent};
use super::pointer::{self, PtrDraw, Ripple};
use super::quality::{self, RecQuality};
use super::sink::{extract_parameter_sets, sink_params, RecSink, SinkParams};

/// 单条 mpsc 消息容量上限（音频线程每 10ms 泵一小段，远用不满）。
const AUDIO_MSG_CAP: usize = 256;

#[derive(Clone, Debug)]
pub struct RecOpts {
    /// 选区矩形（虚拟屏物理像素坐标）。
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub quality: RecQuality,
    pub sys_audio: bool,
    pub mic_audio: bool,
    /// 点击高亮烧帧（四期 1.3；设置页开关，默认开）。
    pub click_highlight: bool,
    /// sidecar 事件轨道 `.events.json`（四期 1.3；默认开）。
    pub event_sidecar: bool,
}

pub struct RecStatus {
    pub recording: bool,
    pub finalizing: bool,
    /// true = 暂停中（不录内容、不计时）。
    pub paused: bool,
    pub path: Option<String>,
    /// 录制时长（扣除暂停段；毫秒）。
    pub elapsed_ms: u64,
    /// 已写入的媒体字节（视频+音频裸流；控制条体积显示）。
    pub bytes: u64,
    /// 画质档 key（控制条展示用；无会话为 None）。
    pub quality: Option<String>,
}

struct Active {
    stop: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    /// 暂停旗：会话线程与音频线程各持一份克隆（true = 不抓不编不喂音频）。
    pause: Arc<AtomicBool>,
    path: PathBuf,
    started: Instant,
    quality: RecQuality,
    /// 已写入媒体字节（sink 注入同一计数器；控制条每秒轮询 rec_status 读）。
    bytes: Arc<AtomicU64>,
    /// 暂停累计（elapsed 口径）；`paused_since = Some` 表示正在暂停中。
    paused_total_ms: u64,
    paused_since: Option<Instant>,
    /// 标记时刻热键的入口（四期 1.3）：sidecar 关闭时为 None（Mark 无处可记）。
    events: Option<std::sync::mpsc::SyncSender<hooks::RecEvent>>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

/// 最近一次会话的参数——「重录上次区域」的数据源。与 ACTIVE 生命周期不同：
/// 停止后仍在，只被下一次 start 覆盖。
static LAST_SESSION: Mutex<Option<RecOpts>> = Mutex::new(None);

/// 最近一次会话参数（托盘「重录上次区域」显示与 open_rerecord 用）。
pub fn last_opts() -> Option<RecOpts> {
    LAST_SESSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// 开始录制。输出路径由命令层决定好传入；同名冲突已由命令层规避。
pub fn start(app: AppHandle, opts: RecOpts, out_path: PathBuf) -> Result<(), String> {
    let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_some() {
        return Err("已有录制在进行".into());
    }
    // 事件轨通道（四期 1.3）：钩子线程 / 标记热键 → 会话主循环。
    let (ev_tx, ev_rx) = mpsc::sync_channel::<hooks::RecEvent>(64);
    let active = Active {
        stop: Arc::new(AtomicBool::new(false)),
        discard: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(AtomicBool::new(false)),
        path: out_path.clone(),
        started: Instant::now(),
        quality: opts.quality,
        bytes: Arc::new(AtomicU64::new(0)),
        paused_total_ms: 0,
        paused_since: None,
        events: if opts.event_sidecar { Some(ev_tx.clone()) } else { None },
    };
    let stop = active.stop.clone();
    let discard = active.discard.clone();
    let pause = active.pause.clone();
    let bytes = active.bytes.clone();
    *slot = Some(active);
    drop(slot);
    *LAST_SESSION.lock().unwrap_or_else(|p| p.into_inner()) = Some(opts.clone());
    std::thread::Builder::new()
        .name("rec-session".into())
        .spawn(move || {
            // 🔴 后端权威收尾（2026-10-06 实录踩坑）：无论正常结束、丢弃、失败还是
            // panic，都由后端清槽 + destroy 选区/控制条窗——收尾绝不依赖覆盖层自己的
            // JS（它一旦失灵，全屏透明置顶窗就是桌面级陷阱，Esc/按钮全是死路）。
            // 错误信息只走 toast / HUD（rec-done 的 hud 通路 / emit_failed）。
            let app_after = app.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_record(app, opts, out_path, stop, discard, pause, bytes, ev_tx, ev_rx)
            }));
            if result.is_err() {
                emit_failed(&app_after, "录制会话异常崩溃，已中止");
            }
            clear_active(); // 正常路径已清过，这里幂等兜底（含 panic 路径）
            super::close_windows(&app_after);
        })
        .map_err(|e| {
            clear_active(); // 线程没起来：槽必须立刻还回去，否则永远「已有录制在进行」
            format!("起录制线程失败：{e}")
        })?;
    Ok(())
}

/// 标记时刻（四期 1.3）：全局热键入口。仅录制中有效；sidecar 关闭时静默
/// （Mark 无处可记，四期只记录不展示——五期渲染时间线刻度）。
pub fn send_mark() {
    let slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(tx) = slot.as_ref().and_then(|a| a.events.as_ref()) {
        let _ = tx.try_send(RecEvent::Mark);
    }
}

/// 请求停止（discard=true = 落盘后删除，即「取消并丢弃」）。
/// 收尾在会话线程内异步完成，结果经 `rec-done` / `rec-failed` 事件上报。
pub fn stop(discard: bool) -> Result<(), String> {
    let slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    match slot.as_ref() {
        Some(a) => {
            a.discard.store(discard, Ordering::SeqCst);
            a.stop.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => Err("没有进行中的录制".into()),
    }
}

/// 暂停/继续（控制条按钮）。幂等：重复设置同一状态按成功处理；
/// 收尾中拒绝。时间轴是**提交驱动**的（视频按提交帧号、音频按喂入样本数），
/// 暂停 = 两侧同时停喂 → 时间轴自然冻结，续录无缝接上，产物不含暂停段。
pub fn set_paused(app: &AppHandle, paused: bool) -> Result<(), String> {
    let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(a) = slot.as_mut() else {
        return Err("没有进行中的录制".into());
    };
    if a.stop.load(Ordering::SeqCst) {
        return Err("正在收尾，不能暂停".into());
    }
    if a.paused_since.is_some() == paused {
        return Ok(());
    }
    if paused {
        a.paused_since = Some(Instant::now());
        a.pause.store(true, Ordering::SeqCst);
    } else {
        if let Some(t) = a.paused_since.take() {
            a.paused_total_ms += t.elapsed().as_millis() as u64;
        }
        a.pause.store(false, Ordering::SeqCst);
    }
    // 事件是状态真相的第二读口（热键/HUD 暂停在四期接入）——控制条据它同步。
    let _ = app.emit("rec-paused", serde_json::json!({ "paused": paused }));
    Ok(())
}

pub fn status() -> RecStatus {
    let slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    match slot.as_ref() {
        Some(a) => {
            let paused = a.paused_since.is_some();
            let mut elapsed = a.started.elapsed().as_millis() as u64;
            if let Some(t) = a.paused_since {
                elapsed -= t.elapsed().as_millis() as u64;
            }
            RecStatus {
                recording: !a.stop.load(Ordering::SeqCst),
                finalizing: a.stop.load(Ordering::SeqCst),
                paused,
                path: Some(a.path.display().to_string()),
                elapsed_ms: elapsed.saturating_sub(a.paused_total_ms),
                bytes: a.bytes.load(Ordering::Relaxed),
                quality: Some(a.quality.as_str().to_string()),
            }
        }
        None => RecStatus {
            recording: false,
            finalizing: false,
            paused: false,
            path: None,
            elapsed_ms: 0,
            bytes: 0,
            quality: None,
        },
    }
}

/// 主窗是否藏着（托盘/热键发起录屏时主窗往往不可见）。
/// 可见 = 沿用主窗 toast；隐藏 = HUD 轻浮窗承接（规则 15.1 同一可见性域）。
fn main_hidden(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| {
            // 最小化的窗 is_visible 仍为 true——但用户看不见，必须按隐藏算（P2，二期审查）
            !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false)
        })
        .unwrap_or(true)
}

fn emit_failed(app: &AppHandle, msg: &str) {
    log::warn!("[Rec] {msg}");
    let hud = main_hidden(app);
    let _ = app.emit("rec-failed", serde_json::json!({ "message": msg, "hud": hud }));
    if hud {
        super::open_hud_window(app, &serde_json::json!({ "ok": false, "message": msg }));
    }
}

/// 清空会话槽。🔴 主循环之前任何 `return` 都必须先调它——槽泄漏 = 之后
/// 永远「已有录制在进行」、状态永远 finalizing、控制条永远「正在写入」。
fn clear_active() {
    ACTIVE.lock().unwrap_or_else(|p| p.into_inner()).take();
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn run_record(
    app: AppHandle,
    opts: RecOpts,
    path: PathBuf,
    stop: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    bytes: Arc<AtomicU64>,
    ev_tx: mpsc::SyncSender<RecEvent>,
    ev_rx: mpsc::Receiver<RecEvent>,
) {
    let started_at = Instant::now();
    // ── 1. 抓首帧（拿虚拟屏画布尺寸；锁屏/禁屏时 DXGI 拿不到帧）──
    let mut pool = DxgiPool::new();
    let first = loop {
        if stop.load(Ordering::SeqCst) {
            // 用户在首帧前就取消了：没写盘、没文件，按「已丢弃」收场——
            // 必须清槽 + 发事件，否则覆盖层（穿透中）和控制条都会卡死
            clear_active();
            let _ = app.emit(
                "rec-discarded",
                serde_json::json!({ "path": path.display().to_string() }),
            );
            return;
        }
        match pool.grab(true, -1) {
            Ok(Some((w, h, _))) => break (w, h),
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                clear_active();
                emit_failed(&app, &format!("屏幕捕获不可用：{e}"));
                return;
            }
        }
        if started_at.elapsed() > Duration::from_secs(5) {
            clear_active();
            emit_failed(&app, "5 秒内没有抓到首帧（屏幕未点亮或捕获被占用）");
            return;
        }
    };
    let (vw, vh) = first;

    // ── 2. 选区钳位（虚拟屏画布坐标系）──
    let (sx, sy, _, _) = virtual_screen_origin();
    let (rx, ry, rw, rh) = quality::clamp_rect(opts.x - sx, opts.y - sy, opts.w, opts.h, vw, vh);
    let sp = sink_params(opts.quality, rw, rh);

    // ── 2.5 事件轨（四期 1.3）：双开关全关 = 不装钩子（平时零钩子零开销）──
    // guard 活到会话线程结束（Drop = 停泵 + 卸钩），钩子随会话装卸。
    let _hooks = if opts.click_highlight || opts.event_sidecar {
        Some(hooks::start_hooks(ev_tx))
    } else {
        drop(ev_tx);
        None
    };
    let mut recorder = events::SidecarRecorder::new(opts.event_sidecar);
    // 活跃涟漪：上限 8 条（规则 8 最坏界；400ms 生命期 + 正常点击频率远到不了）
    let mut ripples: Vec<Ripple> = Vec::new();

    // ── 3. 编码器（内部含 BGRA→NV12；HEVC 打不开自动回落 H.264）──
    // 质量导向码控（三期 1.3）：录制写本地文件，PeakConstrainedVBR——静态桌面
    // 码率自然下沉、突发画面不糊；rc 推流的 CBR+低延迟口径不适用这里。
    let mut enc = H264SessionEncoder::try_open_for_file(
        opts.quality.codec(),
        sp.width,
        sp.height,
        sp.fps,
        sp.bitrate,
    );
    if !enc.available() {
        clear_active();
        emit_failed(&app, "没有可用的硬件编码器（录屏不提供软编兜底）");
        return;
    }

    // ── 4. 音频线程（先起，回报 cfg；主循环开 sink 时要 ASC）──
    // 两线程共用的墙钟零点：音频内容的 0 点与视频首帧时刻都记在它上面，
    // 差值就是 mux 时的位移（音画对齐，见 av_shift）。
    let axis_t0 = Instant::now();
    let (aud_tx, aud_rx) = mpsc::sync_channel::<AudioMsg>(AUDIO_MSG_CAP);
    let mut audio_cfg = spawn_audio(&opts, aud_tx, axis_t0, pause.clone());

    // ── 5. 主循环 ──
    let frame_dur = Duration::from_nanos(1_000_000_000 / sp.fps.max(1) as u64);
    let mut sink: Option<RecSink> = None;
    let mut scaler = pastepanda_rc_scale::BgraScaler::default();
    let mut crop_buf: Vec<u8> = Vec::new();
    let mut grab_fail_streak = 0u32;
    let mut enc_fail_streak = 0u32;
    let mut next_frame = Instant::now();
    let mut frames_written: u64 = 0;
    // 提交编码的帧数——时间轴的驱动源（`已提交帧数 × 1000 / fps`），也是
    // rec-done 时长的口径（静止跳帧/暂停不提交 → 时长自然收缩，播放端连续）。
    let mut frames_submitted: u64 = 0;
    // 中途故障不边走边报：记原因 → 收尾按结局发**一条**事件
    // （旧实现故障点发 rec-failed、收尾再发 rec-done，主窗双 toast 自相矛盾）
    let mut interrupted: Option<String> = None;
    // 音画对齐：视频轴 0 = 首帧编码时刻，音频轴 0 = 采集 Start 时刻（音频线程
    // 记在 axis_t0 相对轴上，开 sink 时取回）。0 点差决定位移哪条轨（只推迟不回拨）。
    let mut video_encode0_set = false;
    let mut video_encode0_ms: u64 = 0;
    let mut video_shift_ms: i64 = 0;
    let mut audio_shift_ms: i64 = 0;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // 暂停（三期 1.4）：不抓不编——提交驱动时间轴自然冻结；只 drain 音频
        // 心跳防通道积压。续录无需补帧：静屏上的画面冻结本就是真实内容。
        // 🔴 节奏锚点必须跟着推进：next_frame 停在暂停前，长暂停会积累巨量
        // 「帧距债」，续录后循环会以无节流最高速抓帧编码把债还完。
        if pause.load(Ordering::SeqCst) {
            // 暂停段的事件丢弃：该段不进视频，涟漪与 sidecar 都不属于它
            while ev_rx.try_recv().is_ok() {}
            drain_audio(&mut sink, &aud_rx, audio_shift_ms);
            next_frame = Instant::now();
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        // 事件轨 drain（四期 1.3）：打点用当前视频时间轴——暂停/静止跳帧时
        // 时间冻结，涟漪起点与编码画面严格对齐（不会在静止段偷偷走完）。
        loop {
            match ev_rx.try_recv() {
                Ok(ev) => {
                    let t = frames_submitted * 1000 / u64::from(sp.fps.max(1));
                    let canvas = match &ev {
                        RecEvent::Click { x, y, .. } => Some((x - sx - rx, y - sy - ry)),
                        _ => None,
                    };
                    recorder.record(&ev, canvas, t);
                    if let (true, Some((cx, cy))) = (opts.click_highlight, canvas) {
                        if ripples.len() >= 8 {
                            ripples.remove(0);
                        }
                        ripples.push(Ripple { x: cx, y: cy, start_ms: t });
                    }
                }
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
            }
        }
        // 音频 mux（无音频轨时立刻返回）
        drain_audio(&mut sink, &aud_rx, audio_shift_ms);
        // 节奏：静止时 DXGI 30ms 超时自然降频，画面一动立即出帧
        if next_frame > Instant::now() {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        next_frame += frame_dur;
        match pool.grab_rec() {
            Err(e) => {
                grab_fail_streak += 1;
                if grab_fail_streak >= 45 {
                    // 锁屏 / 显示器全黑 / 驱动异常：落盘已录部分，收尾统一上报
                    interrupted = Some(format!(
                        "屏幕捕获中断（锁屏或显示器关闭），已保留已录部分：{e}"
                    ));
                    break;
                }
            }
            Ok(None) => { /* 静止且指针没动：跳帧，时间轴由编码器步进，时长连续 */ }
            Ok(Some(((vw2, vh2, bgra), ptr))) => {
                if (vw2, vh2) != (vw, vh) {
                    interrupted = Some("录制中分辨率变化（接显示器/改缩放），已保留已录部分".into());
                    break;
                }
                crop_into(bgra, vw, rx, ry, rw, rh, &mut crop_buf);
                // 涟漪（四期 1.3）：画在指针**之前**（光标保持最上层）、裁剪后
                // 缩放前（跟内容一起缩放）。时间基 = 本帧时间戳（提交帧数驱动）。
                let frame_t = frames_submitted * 1000 / u64::from(sp.fps.max(1));
                ripples.retain(|r| frame_t.saturating_sub(r.start_ms) < pointer::RIPPLE_DURATION_MS);
                if opts.click_highlight && !ripples.is_empty() {
                    pointer::draw_ripples(&mut crop_buf, rw, rh, &ripples, frame_t);
                }
                // 指针合成（三期 1.2）：画在**裁剪后、缩放前**——跟内容一起缩放。
                // 坐标 = 桌面绝对 − 虚拟屏原点 − 区域原点 = 画布系（crop 从
                // 虚拟画布 (rx,ry) 起裁，指针与点击涟漪同口径）。None =
                // 光标不在任何可复制输出上，本帧不画。
                // 🔴 2026-10-07 修 P0：旧代码少了 − rx/− ry，区域录制时指针被
                // 画出画布外（偏移 = 区域原点）——全屏录制（rx=ry=0）恰好掩盖。
                if let Some(p) = ptr.as_ref() {
                    pointer::draw_pointer(
                        &mut crop_buf,
                        rw,
                        rh,
                        &PtrDraw {
                            x: p.x - sx - rx,
                            y: p.y - sy - ry,
                            hot_x: p.hot_x,
                            hot_y: p.hot_y,
                            kind: p.kind,
                            w: p.w,
                            h: p.h,
                            pitch: p.pitch,
                            data: &p.data,
                        },
                    );
                }
                let src = if (rw, rh) != (sp.width, sp.height) {
                    match scaler.resize(&crop_buf, rw, rh, sp.width, sp.height) {
                        Ok(s) => s.to_vec(),
                        Err(e) => {
                            interrupted = Some(format!("画面缩放失败：{e}"));
                            break;
                        }
                    }
                } else {
                    std::mem::take(&mut crop_buf)
                };
                if !video_encode0_set {
                    video_encode0_set = true;
                    video_encode0_ms =
                        Instant::now().saturating_duration_since(axis_t0).as_millis() as u64;
                }
                // 时间轴（三期 1.1）：按**提交帧号**驱动编码器时间戳——不驱动它
                // at_ms 恒 0，整条视频时间轴塌在 0 上（存量 P0，rec 从未接过
                // 帧龄时间轴）。同一帧的全部包（SPS/PPS+IDR）落同一时刻。
                enc.set_capture_at((frames_submitted * 1000 / sp.fps.max(1) as u64) as i64);
                match enc.encode_bgra(&src, sp.width, sp.height) {
                    Err(e) => {
                        enc_fail_streak += 1;
                        log::warn!("[Rec] 编码失败（{enc_fail_streak}/5）：{e}");
                        if enc_fail_streak >= 5 {
                            interrupted = Some(format!("视频编码连续失败，已保留已录部分：{e}"));
                            break;
                        }
                    }
                    Ok(packets) => {
                        enc_fail_streak = 0;
                        frames_submitted += 1;
                        if packets.is_empty() {
                            continue;
                        }
                        if sink.is_none() {
                            // 首（批）帧：提参数集 → 开 sink（等音频 cfg 至多 800ms；
                            // ready 通道一次性消费，开不成也不再重试）
                            let seq = extract_parameter_sets(sp.hevc, &packets[0].data);
                            if seq.is_empty() {
                                continue; // 参数集还没出（首包可能只有 IDR 前导），下一帧再试
                            }
                            match open_sink(&path, &sp, audio_cfg.take(), bytes.clone()) {
                                Ok((s, audio_start_ms)) => {
                                    sink = Some(s);
                                    // 两轴 0 点差 → 晚开的那条轨整体推迟差值（不回拨）；
                                    // 无音频轨（0 = 无锚点）时视频轴保持原样
                                    let (vs, ash) = if audio_start_ms == 0 {
                                        (0, 0)
                                    } else if audio_start_ms > video_encode0_ms {
                                        (0, (audio_start_ms - video_encode0_ms) as i64)
                                    } else {
                                        ((video_encode0_ms - audio_start_ms) as i64, 0)
                                    };
                                    video_shift_ms = vs;
                                    audio_shift_ms = ash;
                                }
                                Err(e) => {
                                    interrupted = Some(format!("创建 MP4 封装失败：{e}"));
                                    break;
                                }
                            }
                        }
                        if let Some(s) = sink.as_mut() {
                            let mut write_err = None;
                            for p in &packets {
                                if let Err(e) = s.write_video(p.at_ms + video_shift_ms, &p.data) {
                                    write_err = Some(e);
                                    break;
                                }
                                frames_written += 1;
                            }
                            if let Some(e) = write_err {
                                interrupted = Some(format!("写入视频帧失败，已保留已录部分：{e}"));
                                break;
                            }
                        }
                    }
                }
                crop_buf = src; // 复用容量（mem::take 后归还）
            }
        }
    }

    // ── 6. 收尾：drain 音频余量 → Finalize → 按结局发**一条**事件 ──
    drop(scaler);
    let mut sink = sink;
    drain_audio(&mut sink, &aud_rx, audio_shift_ms);
    // 音频线程可能还有最后一段：给它一点时间自然排空
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        if matches!(drain_audio(&mut sink, &aud_rx, audio_shift_ms), DrainResult::Idle) {
            break;
        }
    }
    drop(enc);
    let finalize_result = sink.as_mut().map(|s| s.finalize());
    drop(sink);

    // 会话槽先清：完成事件到达前 status() 已不再报「录制中」
    clear_active();

    if discard.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&path);
        // sidecar 一并清掉（正常丢弃时还没写出，防御残留）
        let _ = std::fs::remove_file(events::sidecar_path(&path));
        let _ = app.emit("rec-discarded", serde_json::json!({ "path": path.display().to_string() }));
        return;
    }
    // 时长按编码器时间轴（提交帧数×帧长）：不含首帧等待与暂停段，与播放器
    // 显示的时长一致。frames_written 是**包数**（SPS/PPS 会多出一两个），不能当帧数用。
    let duration_ms = frames_submitted * 1000 / sp.fps.max(1) as u64;
    match finalize_result {
        Some(Ok(())) => {
            let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let hud = main_hidden(&app);
            // sidecar（四期 1.3）：写失败附注进 note，不吞不卡主流程（规则 15.3）
            let mut note = interrupted.clone();
            if opts.event_sidecar {
                if let Err(e) = recorder.write(
                    &path,
                    duration_ms,
                    (sx + rx, sy + ry, rw, rh),
                    (sp.width, sp.height, sp.fps),
                ) {
                    log::warn!("[Rec] sidecar 写入失败：{e}");
                    note = Some(match note {
                        Some(m) => format!("{m}；事件文件写入失败：{e}"),
                        None => format!("事件文件写入失败：{e}"),
                    });
                }
            }
            let _ = app.emit(
                "rec-done",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "bytes": bytes,
                    "duration_ms": duration_ms,
                    "frames": frames_written,
                    // 中途故障落盘的部分保存：主窗 toast 附注一句说明，不另发 rec-failed
                    "note": note,
                    // 主窗藏着时消息由 HUD 轻浮窗承接，主窗 toast 据此闭嘴（双通路互斥）
                    "hud": hud,
                }),
            );
            if hud {
                super::open_hud_window(
                    &app,
                    &serde_json::json!({
                        "ok": true,
                        "path": path.display().to_string(),
                        "bytes": bytes,
                        "duration_ms": duration_ms,
                        "quality": opts.quality.as_str(),
                        "note": note,
                    }),
                );
            }
        }
        Some(Err(e)) => {
            let msg = match interrupted {
                Some(m) => format!("{m}；写文件收尾失败：{e}"),
                None => format!("写文件收尾失败：{e}"),
            };
            emit_failed(&app, &msg);
        }
        None => {
            // sink 没开成 / 一帧没写：MF 可能已建出半截文件，一并清掉；
            // 用户主动停止的按「已丢弃」报（没保存任何东西，不算失败）
            let _ = std::fs::remove_file(&path);
            if stop.load(Ordering::SeqCst) {
                let _ = app.emit(
                    "rec-discarded",
                    serde_json::json!({ "path": path.display().to_string() }),
                );
            } else {
                emit_failed(&app, &interrupted.unwrap_or_else(|| "没有写入任何画面".into()));
            }
        }
    }
}

// ── 音频 ────────────────────────────────────────────────────────────────

/// 音频线程 → 主循环的消息：编好的 AAC 帧（cfg 走独立的 ready 通道）。
/// 空包是心跳：没人收 = 主循环已退，音频线程据此退出。
enum AudioMsg {
    Packets(Vec<crate::rc::audio::AacPacket>),
}

/// 音频 cfg 就绪消息。`start_ms` = 音频**内容** 0 点（采集 Start 完成）在
/// `axis_t0` 相对轴上的位置，供主循环对齐视频轴（无锚点/无音源时为 0）。
#[derive(Clone)]
struct AudioReady {
    sr: u32,
    ch: u32,
    asc: Vec<u8>,
    start_ms: u64,
}

/// 起音频线程：泵系统环回（可选）与麦克风（可选），重采样对齐后混音，AAC 编码。
/// 返回「cfg 就绪」的接收端（None = 两个音源都没开）。
fn spawn_audio(
    opts: &RecOpts,
    tx: mpsc::SyncSender<AudioMsg>,
    axis_t0: Instant,
    pause: Arc<AtomicBool>,
) -> Option<std::sync::mpsc::Receiver<AudioReady>> {
    if !opts.sys_audio && !opts.mic_audio {
        return None;
    }
    let (ready_tx, ready_rx) = mpsc::channel::<AudioReady>();
    let sys = opts.sys_audio;
    let mic = opts.mic_audio;
    std::thread::Builder::new()
        .name("rec-audio".into())
        .spawn(move || run_audio(sys, mic, tx, ready_tx, axis_t0, pause))
        .ok()?;
    Some(ready_rx)
}

#[allow(clippy::too_many_lines)]
fn run_audio(
    sys: bool,
    mic: bool,
    tx: mpsc::SyncSender<AudioMsg>,
    ready_tx: mpsc::Sender<AudioReady>,
    axis_t0: Instant,
    pause: Arc<AtomicBool>,
) {
    // 本线程自持 COM（采集与编码都要求）
    let com_owned = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
        .is_ok()
    };
    let mut loopback = if sys { LoopbackCapture::new().ok() } else { None };
    let mut microphone = if mic { MicCapture::new().ok() } else { None };
    // 音频内容 0 点 = 采集 Start 完成（在 ::new 内）。记在 spawn 相对轴上，
    // 与视频首帧编码时刻同轴相减就是 mux 位移。
    let audio_start_ms =
        Instant::now().saturating_duration_since(axis_t0).as_millis() as u64;
    // 静音保活锚：音频轴（pts = 已喂样本数）已推进到的墙钟点。无真声期间按
    // 墙钟缺口补静音（见循环内），真声到来即重锚——补多少、轴走多少，不凭空加速。
    let mut fill_t = Instant::now();
    if sys && loopback.is_none() {
        log::warn!("[Rec] 系统声音采集不可用（无播放设备），本次录制无系统声");
    }
    if mic && microphone.is_none() {
        log::warn!("[Rec] 麦克风采集不可用，本次录制无麦克风声");
    }
    if loopback.is_none() && microphone.is_none() {
        // 两个音源都没起来：音轨放弃（画面照录，asc 空 = sink 不开音频轨）
        let _ = ready_tx.send(AudioReady { sr: 0, ch: 0, asc: Vec::new(), start_ms: 0 });
        if com_owned {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
        return;
    }
    // 基准采样率 = 环回（主轨）；只有麦克风时用麦克风的
    let base_sr = loopback.as_ref().map_or_else(
        || microphone.as_ref().map_or(48_000, |m| m.sample_rate()),
        |l| l.sample_rate(),
    );
    // 麦克风重采样状态（线性插值需要跨调用保留的小数相位）
    let mut mic_pos = 0.0f64;
    let mut encoder = match AacEncoder::open(base_sr) {
        Ok(e) => Some(e),
        Err(e) => {
            log::warn!("[Rec] AAC 编码器不可用，本次无音轨：{e}");
            let _ = ready_tx.send(AudioReady { sr: 0, ch: 0, asc: Vec::new(), start_ms: 0 });
            if com_owned {
                unsafe { windows::Win32::System::Com::CoUninitialize() };
            }
            return;
        }
    };
    let enc_cfg = encoder
        .as_ref()
        .map_or_else(
            || crate::rc::audio::AudioCfg { sr: base_sr, ch: 2, asc: Vec::new(), br: 128 },
            |e| e.cfg(),
        );
    let cfg = AudioReady { sr: enc_cfg.sr, ch: enc_cfg.ch, asc: enc_cfg.asc, start_ms: audio_start_ms };
    // cfg 延后到**首个成功编码**再回报（见循环内）：open_sink 一收到 cfg 就开
    // 音轨，编码器「开得成、编不出」的残废态绝不能让它开出一条永远空的音轨。
    let mut cfg_sent = false;

    loop {
        // 没人收（主循环已退）就退
        if tx.send(AudioMsg::Packets(Vec::new())).is_err() {
            break;
        }
        let paused = pause.load(Ordering::SeqCst);
        let mut pcm: Vec<i16> = Vec::new();
        if let Some(l) = loopback.as_mut() {
            let (data, broken) = l.pump();
            if broken {
                log::warn!("[Rec] 系统声音设备失效，剩余录制无系统声");
                loopback = None;
            } else if !paused {
                pcm = data;
            }
            // 暂停时照泵不照收：设备缓冲持续清空，续录才不会涌出暂停期的陈旧音频
        }
        if let Some(m) = microphone.as_mut() {
            let (data, broken) = m.pump();
            if broken {
                log::warn!("[Rec] 麦克风设备失效，剩余录制无麦克风");
                microphone = None;
            } else if !paused && !data.is_empty() {
                let aligned = if m.sample_rate() != base_sr {
                    resample_linear(&data, m.sample_rate(), base_sr, &mut mic_pos)
                } else {
                    data
                };
                if pcm.is_empty() {
                    pcm = aligned;
                } else {
                    pcm = mix_s16(&pcm, &aligned);
                }
            }
        }
        if paused {
            // AAC pts 按已喂样本数累计：暂停不喂 = 音频时间轴与视频轴同步冻结。
            // 锚点跟着墙钟走：续录从「现在」起补，不把暂停段补成静音。
            fill_t = Instant::now();
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        if pcm.is_empty() {
            // 🔴 静音保活（0xC00D4A45 实录踩坑）：WASAPI 环回在「完全没有声音
            // 在放」时可以整场零包（音频引擎停摆不产渲染），AAC 编码器零输入
            // → 音轨 0 样本 → MP4 sink Finalize 写不出 moov（样本描述要从流内
            // 自取）→ 保存失败。按墙钟缺口补静音：轴照走，真声来了无缝衔接。
            let frames = silence_fill_frames(fill_t.elapsed(), base_sr);
            if frames == 0 {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            fill_t += Duration::from_secs_f64(frames as f64 / f64::from(base_sr));
            pcm = vec![0i16; frames * 2];
        } else {
            fill_t = Instant::now();
        }
        if let Some(e) = encoder.as_mut() {
            match e.encode(&pcm) {
                Ok(packets) => {
                    if !cfg_sent {
                        cfg_sent = true;
                        let _ = ready_tx.send(cfg.clone());
                    }
                    if !packets.is_empty() && tx.send(AudioMsg::Packets(packets)).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    log::warn!("[Rec] AAC 编码失败，剩余录制无音轨：{err}");
                    encoder = None;
                    if !cfg_sent {
                        // 首编即挂：回报空 cfg 让主循环走「只录画面」，别留空音轨
                        cfg_sent = true;
                        let _ = ready_tx.send(AudioReady {
                            sr: 0,
                            ch: 0,
                            asc: Vec::new(),
                            start_ms: 0,
                        });
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    drop(encoder);
    if com_owned {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[derive(PartialEq)]
enum DrainResult {
    Drained,
    Idle,
}

/// 收干音频通道：逐帧 write_audio（带音画位移）。返回是否本次真的处理到了数据。
fn drain_audio(
    sink: &mut Option<RecSink>,
    rx: &mpsc::Receiver<AudioMsg>,
    audio_shift_ms: i64,
) -> DrainResult {
    // ready 通道在 open_sink 时一次性取走，这里只收 packets
    let mut any = false;
    loop {
        match rx.try_recv() {
            Ok(AudioMsg::Packets(pkts)) => {
                if pkts.is_empty() {
                    continue; // 心跳空包
                }
                any = true;
                if let Some(s) = sink.as_mut() {
                    if !s.has_audio() {
                        // 只录画面：包照收（通道必须排空，否则音频线程 send 阻塞），
                        // 不写也不刷「无音频轨」警告
                        continue;
                    }
                    let mut err = None;
                    for p in &pkts {
                        if let Err(e) = s.write_audio(p.pts_ms as i64 + audio_shift_ms, &p.data) {
                            err = Some(e);
                            break;
                        }
                    }
                    if let Some(e) = err {
                        log::warn!("[Rec] 写音频帧失败（继续录画面）：{e}");
                    }
                }
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => break,
        }
    }
    if any { DrainResult::Drained } else { DrainResult::Idle }
}

/// 打开 MP4 封装并取回音频轴 0 点（无音频轨为 0 = 主循环不做位移）。
/// 等音频 cfg（线程里 AacEncoder::open 一般几十 ms 内完成）。
/// 注：参数集只作「首关键帧已出」的门卫（调用方检查），不再喂给 sink——
/// pass-through 类型带 SEQUENCE_HEADER 必被拒（见 sink.rs 模块头）。
fn open_sink(
    path: &Path,
    sp: &SinkParams,
    audio: Option<mpsc::Receiver<AudioReady>>,
    bytes: Arc<AtomicU64>,
) -> Result<(RecSink, u64), String> {
    let (audio_tuple, audio_start_ms) = match audio {
        Some(rx) => match rx.recv_timeout(Duration::from_millis(800)) {
            Ok(c) if c.sr > 0 && !c.asc.is_empty() => (Some((c.sr, c.ch)), c.start_ms),
            _ => {
                log::warn!("[Rec] 音频轨未就绪，本次只录画面");
                (None, 0)
            }
        },
        None => (None, 0),
    };
    // sink 只要采样率/声道数：esds 由它自造，喂 ASC 反而写不出标头（sink.rs 铁律 ④）
    let sink = RecSink::open(path, sp.width, sp.height, sp.fps, sp.hevc, audio_tuple, sp.bitrate, bytes)?;
    Ok((sink, audio_start_ms))
}

// ── 纯函数（可单测）────────────────────────────────────────────────────

/// 虚拟屏原点（画布坐标 = 桌面坐标 − 原点）。
fn virtual_screen_origin() -> (i32, i32, i32, i32) {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        (x, y, w, h)
    }
}

/// BGRA 帧内裁剪（行 memcpy）。`(x, y)` 为画布内相对坐标，调用方已钳位。
fn crop_into(src: &[u8], src_w: u32, x: i32, y: i32, w: u32, h: u32, out: &mut Vec<u8>) {
    let need = (w as usize) * (h as usize) * 4;
    out.clear();
    out.resize(need, 0);
    let x = x.max(0) as usize;
    let y = y.max(0) as usize;
    let row = w as usize * 4;
    let stride = src_w as usize * 4;
    for r in 0..h as usize {
        let s = (y + r) * stride + x * 4;
        out[r * row..(r + 1) * row].copy_from_slice(&src[s..s + row]);
    }
}

/// 逐样本相加混音（s16，饱和 clamp）。短的一路按零补齐。
fn mix_s16(a: &[i16], b: &[i16]) -> Vec<i16> {
    let n = a.len().max(b.len());
    (0..n)
        .map(|i| {
            let s = a.get(i).copied().unwrap_or(0) as i32 + b.get(i).copied().unwrap_or(0) as i32;
            s.clamp(i16::MIN as i32, i16::MAX as i32) as i16
        })
        .collect()
}

/// 线性插值重采样（s16 立体声 interleaved）。相位跨调用保留，保证连续拼接不爆音。
fn resample_linear(input: &[i16], from_sr: u32, to_sr: u32, phase: &mut f64) -> Vec<i16> {
    if input.is_empty() || from_sr == 0 || to_sr == 0 || from_sr == to_sr {
        return input.to_vec();
    }
    let frames = input.len() / 2;
    if frames < 2 {
        return Vec::new();
    }
    let ratio = f64::from(from_sr) / f64::from(to_sr);
    let mut out = Vec::with_capacity(((frames as f64) / ratio) as usize * 2 + 2);
    let step = ratio;
    let mut pos = *phase;
    while pos + 1.0 < frames as f64 {
        let i0 = pos.floor() as usize;
        let frac = pos - i0 as f64;
        let f = i0.min(frames - 2);
        for ch in 0..2 {
            let s0 = f32::from(input[f * 2 + ch]);
            let s1 = f32::from(input[(f + 1) * 2 + ch]);
            out.push((s0 + (s1 - s0) * frac as f32) as i16);
        }
        pos += step;
    }
    *phase = pos - pos.floor();
    out
}

/// 静音保活补帧量：距音频轴锚点的墙钟 gap → 应补的**每声道**帧数（向下取整）。
/// 纯函数可单测；调用侧「补多少、锚点推进多少」，pts 轴在无真声期间严格按墙钟走。
fn silence_fill_frames(gap: Duration, sr: u32) -> usize {
    (gap.as_secs_f64() * f64::from(sr)) as usize
}

/// 供 mod.rs re-export（commands 用）。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 混音_饱和不溢出() {
        assert_eq!(mix_s16(&[30_000, 10], &[30_000, -5]), &[i16::MAX, 5]);
        assert_eq!(mix_s16(&[-30_000], &[-30_000]), &[i16::MIN]);
        assert_eq!(mix_s16(&[100], &[100, 50, 50]), &[200, 50, 50]);
    }

    #[test]
    fn 裁剪_行拷贝正确() {
        // 4×2 BGRA 源，裁 (2,0)-(4,2)
        let mut src = Vec::new();
        for i in 0..8 {
            src.extend_from_slice(&[i as u8, 0, 0, 255]);
        }
        let mut out = Vec::new();
        crop_into(&src, 4, 2, 0, 2, 2, &mut out);
        assert_eq!(out.len(), 2 * 2 * 4);
        // 第 0 行取像素 2、3；第 1 行取像素 6、7
        assert_eq!(&out[0..4], &[2, 0, 0, 255]);
        assert_eq!(&out[4..8], &[3, 0, 0, 255]);
        assert_eq!(&out[8..12], &[6, 0, 0, 255]);
        assert_eq!(&out[12..16], &[7, 0, 0, 255]);
    }

    #[test]
    fn 重采样_同率直通_变率长度正确() {
        let input: Vec<i16> = (0..480i32).flat_map(|i| [i as i16, -i as i16]).collect();
        assert_eq!(resample_linear(&input, 48_000, 48_000, &mut 0.0), input);
        // 44100 → 48000：同样时长在更高采样率下样本**变多**，输出 ≈ 输入 × 48000/44100
        let out = resample_linear(&input, 44_100, 48_000, &mut 0.0);
        // input 是 480 **帧**（960 个 s16 元素）；44.1k 的时长在 48k 下帧数 ×1.088
        let expect = 480f64 * (48_000f64 / 44_100f64);
        assert!(((out.len() / 2) as f64 - expect).abs() < 2.0, "{} vs {}", out.len() / 2, expect);
    }

    #[test]
    fn 静音保活_墙钟缺口换算帧数() {
        // 守卫（0xC00D4A45 静音场踩坑）：补帧 = 墙钟缺口 × 采样率（floor）——
        // 补多少、锚点推进多少，pts 轴在无真声期间严格按墙钟走，真声衔接不失速。
        assert_eq!(silence_fill_frames(Duration::from_millis(100), 48_000), 4_800);
        assert_eq!(silence_fill_frames(Duration::from_millis(100), 44_100), 4_410);
        // 微 gap 不足 1 帧不补（floor），下一轮凑够再说
        assert_eq!(silence_fill_frames(Duration::from_micros(10), 48_000), 0);
        assert_eq!(silence_fill_frames(Duration::ZERO, 48_000), 0);
    }
}
