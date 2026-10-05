//! 录屏会话：一条**不经网络**的本地采集循环（区别于 rc/inbound 的推流管线）。
//!
//! 结构：`start()` 起一条专用线程跑「DXGI 抓帧 → 裁剪 → 缩放 → 硬编 → SinkWriter
//! 写 MP4」；音频（系统环回 / 麦克风）在另一条线程泵出 s16 并 AAC 编码，经
//! mpsc 交给主循环 mux。全局单会话槽 `ACTIVE`——录制中再触发录屏热键 = 停止。
//!
//! 取舍（设计稿 §7 已声明）：编码参数会话开始时定死；静止画面不写重复帧
//! （DXGI 无新帧时跳过，时间戳走编码器内部单调时间轴，播放端时长连续）；
//! 抓帧连续失败（锁屏 / 显示器关闭）→ 自动落盘停止并上报，不静默丢帧。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::rc::audio::{AacEncoder, LoopbackCapture, MicCapture};
use crate::rc::dxgi::DxgiPool;
use crate::rc::encode_h264::H264SessionEncoder;

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
}

pub struct RecStatus {
    pub recording: bool,
    pub finalizing: bool,
    pub path: Option<String>,
    pub elapsed_ms: u64,
    /// 画质档 key（控制条展示用；无会话为 None）。
    pub quality: Option<String>,
}

struct Active {
    stop: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    path: PathBuf,
    started: Instant,
    quality: RecQuality,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

/// 开始录制。输出路径由命令层决定好传入；同名冲突已由命令层规避。
pub fn start(app: AppHandle, opts: RecOpts, out_path: PathBuf) -> Result<(), String> {
    let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_some() {
        return Err("已有录制在进行".into());
    }
    let active = Active {
        stop: Arc::new(AtomicBool::new(false)),
        discard: Arc::new(AtomicBool::new(false)),
        path: out_path.clone(),
        started: Instant::now(),
        quality: opts.quality,
    };
    let stop = active.stop.clone();
    let discard = active.discard.clone();
    *slot = Some(active);
    drop(slot);
    std::thread::Builder::new()
        .name("rec-session".into())
        .spawn(move || run_record(app, opts, out_path, stop, discard))
        .map_err(|e| format!("起录制线程失败：{e}"))?;
    Ok(())
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

pub fn status() -> RecStatus {
    let slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    match slot.as_ref() {
        Some(a) => RecStatus {
            recording: !a.stop.load(Ordering::SeqCst),
            finalizing: a.stop.load(Ordering::SeqCst),
            path: Some(a.path.display().to_string()),
            elapsed_ms: a.started.elapsed().as_millis() as u64,
            quality: Some(a.quality.as_str().to_string()),
        },
        None => RecStatus {
            recording: false,
            finalizing: false,
            path: None,
            elapsed_ms: 0,
            quality: None,
        },
    }
}

fn emit_failed(app: &AppHandle, msg: &str) {
    log::warn!("[Rec] {msg}");
    let _ = app.emit("rec-failed", serde_json::json!({ "message": msg }));
}

#[allow(clippy::too_many_lines)]
fn run_record(app: AppHandle, opts: RecOpts, path: PathBuf, stop: Arc<AtomicBool>, discard: Arc<AtomicBool>) {
    let started_at = Instant::now();
    // ── 1. 抓首帧（拿虚拟屏画布尺寸；锁屏/禁屏时 DXGI 拿不到帧）──
    let mut pool = DxgiPool::new();
    let first = loop {
        if stop.load(Ordering::SeqCst) {
            return; // 用户在首帧前就取消了：没写盘，直接退
        }
        match pool.grab(true, -1) {
            Ok(Some((w, h, _))) => break (w, h),
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                emit_failed(&app, &format!("屏幕捕获不可用：{e}"));
                return;
            }
        }
        if started_at.elapsed() > Duration::from_secs(5) {
            emit_failed(&app, "5 秒内没有抓到首帧（屏幕未点亮或捕获被占用）");
            return;
        }
    };
    let (vw, vh) = first;

    // ── 2. 选区钳位（虚拟屏画布坐标系）──
    let (sx, sy, _, _) = virtual_screen_origin();
    let (rx, ry, rw, rh) = quality::clamp_rect(opts.x - sx, opts.y - sy, opts.w, opts.h, vw, vh);
    let sp = sink_params(opts.quality, rw, rh);

    // ── 3. 编码器（内部含 BGRA→NV12；HEVC 打不开自动回落 H.264）──
    let mut enc = H264SessionEncoder::try_open_with_budget(
        opts.quality.codec(),
        sp.width,
        sp.height,
        sp.fps,
        sp.bitrate,
    );
    if !enc.available() {
        emit_failed(&app, "没有可用的硬件编码器（录屏不提供软编兜底）");
        return;
    }

    // ── 4. 音频线程（先起，回报 cfg；主循环开 sink 时要 ASC）──
    let (aud_tx, aud_rx) = mpsc::sync_channel::<AudioMsg>(AUDIO_MSG_CAP);
    let mut audio_cfg = spawn_audio(&opts, aud_tx);

    // ── 5. 主循环 ──
    let frame_dur = Duration::from_nanos(1_000_000_000 / sp.fps.max(1) as u64);
    let mut sink: Option<RecSink> = None;
    let mut scaler = pastepanda_rc_scale::BgraScaler::default();
    let mut crop_buf: Vec<u8> = Vec::new();
    let mut grab_fail_streak = 0u32;
    let mut enc_fail_streak = 0u32;
    let mut next_frame = Instant::now();
    let mut frames_written: u64 = 0;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // 音频 mux（无音频轨时立刻返回）
        drain_audio(&mut sink, &aud_rx);
        // 节奏：静止时 DXGI 30ms 超时自然降频，画面一动立即出帧
        if next_frame > Instant::now() {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        next_frame += frame_dur;
        match pool.grab(true, -1) {
            Err(e) => {
                grab_fail_streak += 1;
                if grab_fail_streak >= 45 {
                    // 锁屏 / 显示器全黑 / 驱动异常：落盘已录部分，明确上报
                    emit_failed(&app, &format!("屏幕捕获连续失败，已保存已录部分：{e}"));
                    break;
                }
            }
            Ok(None) => { /* 静止：跳帧，时间轴由编码器步进，时长连续 */ }
            Ok(Some((vw2, vh2, bgra))) => {
                if (vw2, vh2) != (vw, vh) {
                    emit_failed(&app, "录制中分辨率变了（接显示器/改缩放），已保存已录部分");
                    break;
                }
                crop_into(bgra, vw, rx, ry, rw, rh, &mut crop_buf);
                let src = if (rw, rh) != (sp.width, sp.height) {
                    match scaler.resize(&crop_buf, rw, rh, sp.width, sp.height) {
                        Ok(s) => s.to_vec(),
                        Err(e) => {
                            emit_failed(&app, &format!("缩放失败：{e}"));
                            break;
                        }
                    }
                } else {
                    std::mem::take(&mut crop_buf)
                };
                match enc.encode_bgra(&src, sp.width, sp.height) {
                    Err(e) => {
                        enc_fail_streak += 1;
                        log::warn!("[Rec] 编码失败（{enc_fail_streak}/5）：{e}");
                        if enc_fail_streak >= 5 {
                            emit_failed(&app, &format!("视频编码连续失败：{e}"));
                            break;
                        }
                    }
                    Ok(packets) => {
                        enc_fail_streak = 0;
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
                            match open_sink(&path, &sp, &seq, audio_cfg.take()) {
                                Ok(s) => sink = Some(s),
                                Err(e) => {
                                    emit_failed(&app, &e);
                                    break;
                                }
                            }
                        }
                        if let Some(s) = sink.as_mut() {
                            let mut write_err = None;
                            for p in &packets {
                                if let Err(e) = s.write_video(p.at_ms, &p.data) {
                                    write_err = Some(e);
                                    break;
                                }
                                frames_written += 1;
                            }
                            if let Some(e) = write_err {
                                emit_failed(&app, &format!("写视频帧失败：{e}"));
                                break;
                            }
                        }
                    }
                }
                crop_buf = src; // 复用容量（mem::take 后归还）
            }
        }
    }

    // ── 6. 收尾：drain 音频余量 → Finalize → 事件 ──
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    drop(scaler);
    let mut sink = sink;
    drain_audio(&mut sink, &aud_rx);
    // 音频线程可能还有最后一段：给它一点时间自然排空
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        if matches!(drain_audio(&mut sink, &aud_rx), DrainResult::Idle) {
            break;
        }
    }
    drop(enc);
    let finalize_result = sink.as_mut().map(|s| s.finalize());
    drop(sink);

    // 会话槽先清：完成事件到达前 status() 已不再报「录制中」
    ACTIVE.lock().unwrap_or_else(|p| p.into_inner()).take();

    if discard.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&path);
        let _ = app.emit("rec-discarded", serde_json::json!({ "path": path.display().to_string() }));
        return;
    }
    match finalize_result {
        Some(Ok(())) => {
            let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "rec-done",
                serde_json::json!({ "path": path.display().to_string(), "bytes": bytes, "duration_ms": elapsed_ms, "frames": frames_written }),
            );
        }
        Some(Err(e)) => emit_failed(&app, &format!("写文件收尾失败：{e}")),
        None => { /* 一帧都没写（选区确立后立刻停止）：文件可能不存在，按失败报 */ }
    }
}

// ── 音频 ────────────────────────────────────────────────────────────────

/// 音频线程 → 主循环的消息：编好的 AAC 帧（cfg 走独立的 ready 通道）。
enum AudioMsg {
    Packets(Vec<crate::rc::audio::AacPacket>),
}

#[derive(Clone)]
struct AudioReady {
    sr: u32,
    ch: u32,
    asc: Vec<u8>,
}

impl From<crate::rc::audio::AudioCfg> for AudioReady {
    fn from(c: crate::rc::audio::AudioCfg) -> Self {
        Self { sr: c.sr, ch: c.ch, asc: c.asc }
    }
}

/// 起音频线程：泵系统环回（可选）与麦克风（可选），重采样对齐后混音，AAC 编码。
/// 返回「cfg 就绪」的接收端（None = 两个音源都没开）。
fn spawn_audio(
    opts: &RecOpts,
    tx: mpsc::SyncSender<AudioMsg>,
) -> Option<std::sync::mpsc::Receiver<AudioReady>> {
    if !opts.sys_audio && !opts.mic_audio {
        return None;
    }
    let (ready_tx, ready_rx) = mpsc::channel::<AudioReady>();
    let sys = opts.sys_audio;
    let mic = opts.mic_audio;
    std::thread::Builder::new()
        .name("rec-audio".into())
        .spawn(move || run_audio(sys, mic, tx, ready_tx))
        .ok()?;
    Some(ready_rx)
}

#[allow(clippy::too_many_lines)]
fn run_audio(
    sys: bool,
    mic: bool,
    tx: mpsc::SyncSender<AudioMsg>,
    ready_tx: mpsc::Sender<AudioReady>,
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
    if sys && loopback.is_none() {
        log::warn!("[Rec] 系统声音采集不可用（无播放设备），本次录制无系统声");
    }
    if mic && microphone.is_none() {
        log::warn!("[Rec] 麦克风采集不可用，本次录制无麦克风声");
    }
    if loopback.is_none() && microphone.is_none() {
        // 两个音源都没起来：音轨放弃（画面照录，asc 空 = sink 不开音频轨）
        let _ = ready_tx.send(AudioReady { sr: 0, ch: 0, asc: Vec::new() });
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
            let _ = ready_tx.send(AudioReady { sr: 0, ch: 0, asc: Vec::new() });
            if com_owned {
                unsafe { windows::Win32::System::Com::CoUninitialize() };
            }
            return;
        }
    };
    let cfg = AudioReady::from(encoder.as_ref().map(|e| e.cfg()).unwrap_or(crate::rc::audio::AudioCfg { sr: base_sr, ch: 2, asc: Vec::new(), br: 128 }));
    let _ = ready_tx.send(cfg);

    loop {
        // 没人收（主循环已退）就退
        if tx.send(AudioMsg::Packets(Vec::new())).is_err() {
            break;
        }
        let mut pcm: Vec<i16> = Vec::new();
        if let Some(l) = loopback.as_mut() {
            let (data, broken) = l.pump();
            if broken {
                log::warn!("[Rec] 系统声音设备失效，剩余录制无系统声");
                loopback = None;
            }
            pcm = data;
        }
        if let Some(m) = microphone.as_mut() {
            let (data, broken) = m.pump();
            if broken {
                log::warn!("[Rec] 麦克风设备失效，剩余录制无麦克风");
                microphone = None;
            } else if !data.is_empty() {
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
        if pcm.is_empty() {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        if let Some(e) = encoder.as_mut() {
            match e.encode(&pcm) {
                Ok(packets) if !packets.is_empty() => {
                    if tx.send(AudioMsg::Packets(packets)).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(err) => {
                    log::warn!("[Rec] AAC 编码失败，剩余录制无音轨：{err}");
                    encoder = None;
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

/// 收干音频通道：Ready 记下 cfg（若 sink 未开，下一帧首帧路径会用），
/// Packets 逐帧 write_audio。返回是否本次真的处理到了数据。
fn drain_audio(sink: &mut Option<RecSink>, rx: &mpsc::Receiver<AudioMsg>) -> DrainResult {
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
                    let mut err = None;
                    for p in &pkts {
                        if let Err(e) = s.write_audio(p.pts_ms as i64, &p.data) {
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

fn open_sink(
    path: &Path,
    sp: &SinkParams,
    seq_header: &[u8],
    audio: Option<mpsc::Receiver<AudioReady>>,
) -> Result<RecSink, String> {
    // 等音频 cfg（线程里 AacEncoder::open 一般几十 ms 内完成）
    let audio_tuple: Option<(u32, u32, Vec<u8>)> = match audio {
        Some(rx) => match rx.recv_timeout(Duration::from_millis(800)) {
            Ok(c) if c.sr > 0 && !c.asc.is_empty() => Some((c.sr, c.ch, c.asc)),
            _ => {
                log::warn!("[Rec] 音频轨未就绪，本次只录画面");
                None
            }
        },
        None => None,
    };
    let audio_ref = audio_tuple.as_ref().map(|(sr, ch, asc)| (*sr, *ch, asc.as_slice()));
    RecSink::open(
        path,
        sp.width,
        sp.height,
        sp.fps,
        sp.hevc,
        seq_header,
        audio_ref,
        sp.bitrate,
    )
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
}
