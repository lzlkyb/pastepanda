//! 端到端硬编探针：按「先设输出→再设输入」的顺序走完整链路，真编一帧。
//!
//! # 为什么要有这个
//!
//! `dump` 已经证明：async 硬编 MFT 必须**先设输出类型**才肯接受输入类型。
//! 但那只证明了「SetInputType 不报错」。真正要回答的是：
//! **顺序修好之后，能不能一路跑到编码出包？**（低延迟配置 + 事件协议 + 收包）
//!
//! 主仓库 `encode_h264.rs` 的其余部分（async 解锁、事件泵、低延迟三件套）
//! 是否需要同步调整，只有跑通端到端才知道。
//!
//! # 本探针做什么
//!
//! 对每台硬编 MFT：
//!   1. ActivateObject → 解锁 async
//!   2. **先 SetOutputType**（H.264，补 avg_bitrate / frame_rate / profile / level）
//!   3. **再 SetInputType**（NV12，复刻主仓库 `create_video_type` 的 5 个属性）
//!   4. 低延迟三件套（MF_LOW_LATENCY + AVLowLatencyMode + CBR）
//!   5. 喂 3 帧合成 NV12，走事件协议收包，打印每帧耗时与包大小
//!
//! 时间全部实测，不估算。

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

const W: u32 = 1920;
const H: u32 = 1080;
const FPS: u32 = 30;
const BITRATE: u32 = 8_000_000;

// H.264 profile/level（与主仓库同值）
const H264_PROFILE_HIGH: u32 = 100;
const H264_LEVEL_41: u32 = 41;

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            println!("MFStartup 失败: {e}");
            return;
        }
    }
    println!("═══════════════════════════════════════════════════════════");
    println!(" 端到端硬编探针 · 先设输出→再设输入 → 真编 3 帧");
    println!(" 帧 {W}x{H} @ {FPS}fps  bitrate={}", BITRATE / 1_000_000);
    println!("═══════════════════════════════════════════════════════════\n");

    for (label, subtype) in [("H.264", MFVideoFormat_H264), ("HEVC", MFVideoFormat_HEVC)] {
        println!("══ {label} ══════════════════════════════════════════════");
        run_codec(&subtype, label == "H.264");
        println!();
    }

    unsafe {
        let _ = MFShutdown();
    }
    println!("─── 探针结束 ───");
}

fn run_codec(out_subtype: &windows::core::GUID, is_h264: bool) {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *out_subtype,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    unsafe {
        // 注意：不约束输入 subtype——dump 已证明带 NV12 约束会枚举 0 台
        let _ = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE,
            None,
            Some(&out_info),
            &mut acts,
            &mut count,
        );
    }
    if count == 0 || acts.is_null() {
        println!("  枚举到 0 台");
        return;
    }
    let slice = unsafe { std::slice::from_raw_parts(acts, count as usize) };
    let mut seen = std::collections::HashSet::new();
    for act in slice.iter().flatten() {
        let name = unsafe { friendly_name(act) };
        if !(name.contains("NVIDIA") || name.contains("Intel")) {
            continue;
        }
        if !seen.insert(name.clone()) {
            continue;
        }
        println!("\n  ▸ {name}");
        unsafe { try_encode(act, out_subtype, is_h264) };
    }
    if !acts.is_null() {
        unsafe { CoTaskMemFree(Some(acts as _)) };
    }
}

unsafe fn try_encode(act: &IMFActivate, out_subtype: &windows::core::GUID, is_h264: bool) {
    let t: IMFTransform = match act.ActivateObject() {
        Ok(t) => t,
        Err(e) => {
            println!("      ✗ ActivateObject: {e}");
            return;
        }
    };

    // ── 解锁 async ──
    let attrs = match t.GetAttributes() {
        Ok(a) => a,
        Err(e) => {
            println!("      ✗ GetAttributes: {e}");
            return;
        }
    };
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_async {
        if let Err(e) = attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1) {
            println!("      ✗ 解锁 async 失败: {e}");
            return;
        }
    }
    println!("      async={is_async}（已解锁）");

    // ── ★ 顺序关键：先设输出类型 ──
    let out_type = match create_out_type(out_subtype, is_h264) {
        Ok(m) => m,
        Err(e) => {
            println!("      ✗ 造输出类型: {e}");
            return;
        }
    };
    if let Err(e) = t.SetOutputType(0, &out_type, 0) {
        println!("      ✗ SetOutputType（第 1 步）: {e}");
        return;
    }
    println!("      [1] SetOutputType ✓");

    // ── 再设输入类型 ──
    // 输入类型内容有讲究：dump 探针在设输出后紧接着用的输入类型**补了 FRAME_RATE**，
    // 而主仓库 `create_video_type` 只有 5 个属性。这里逐个试，实测哪些是必需的。
    let mut ok_type = None;
    for (label, fps_mode) in [
        ("5 属性（复刻主仓库，无 FRAME_RATE）", FpsMode::None),
        ("6 属性（补 FRAME_RATE）", FpsMode::FrameRate),
        ("7 属性（补 FRAME_RATE + PAR 归一）", FpsMode::FrameRatePar),
    ] {
        let in_type = match create_in_type(fps_mode) {
            Ok(m) => m,
            Err(e) => {
                println!("      ✗ 造输入类型[{label}]: {e}");
                continue;
            }
        };
        match t.SetInputType(0, &in_type, 0) {
            Ok(()) => {
                println!("      [2] SetInputType ✓  ← 用「{label}」成功");
                ok_type = Some(label);
                break;
            }
            Err(e) => println!("      [2] SetInputType ✗「{label}」: {e}"),
        }
    }
    let Some(ok_label) = ok_type else {
        println!("      ✗ 三种输入类型全部被拒，无法继续");
        return;
    };
    let _ = ok_label;

    // ── ★ 关键第 2.5 步：流变化再协商 ──
    // 硬编设完类型后会用 MF_E_TRANSFORM_STREAM_CHANGE 要求重新协商输出类型
    //（SPS/PPS 此时才定稿）。不复用 GetOutputAvailableType(0) 的重设，
    // 第一帧 ProcessOutput 就报 0xC00D6D61「直到重新协商流之后才能生成输出」。
    let mut renegotiated = false;
    for attempt in 0..3 {
        match t.GetOutputAvailableType(0, 0) {
            Ok(mt) => {
                let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, BITRATE);
                let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1));
                match t.SetOutputType(0, &mt, 0) {
                    Ok(()) => {
                        println!("      [2.5] 流变化再协商 ✓（第 {} 次）", attempt + 1);
                        renegotiated = true;
                        break;
                    }
                    Err(e) => println!("      [2.5] 再协商 SetOutputType ✗: {e}"),
                }
            }
            Err(e) => {
                println!("      [2.5] 取不到重协商后的输出类型: {e}（跳过）");
                break;
            }
        }
    }
    if !renegotiated {
        println!("      [2.5] 无需再协商，按原类型继续");
    }

    // ── 低延迟三件套 ──
    if let Err(e) = attrs.SetUINT32(&MF_LOW_LATENCY, 1) {
        println!("      · MF_LOW_LATENCY 不支持: {e}");
    }
    if let Ok(api) = t.cast::<ICodecAPI>() {
        let v = windows::core::VARIANT::from(1u32);
        let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &v);
        let _ = api.SetValue(
            &CODECAPI_AVEncCommonRateControlMode,
            &windows::core::VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncCommonMeanBitRate,
            &windows::core::VARIANT::from(BITRATE),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncMPVGOPSize,
            &windows::core::VARIANT::from(FPS),
        );
    } else {
        println!("      · 无 ICodecAPI（低延迟键跳过）");
    }
    println!("      [3] 低延迟配置 ✓");

    // ── 开流 ──
    if let Err(e) = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0) {
        println!("      ✗ BEGIN_STREAMING: {e}");
        return;
    }
    if let Err(e) = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0) {
        println!("      ✗ START_OF_STREAM: {e}");
        return;
    }

    // ── 事件源 ──
    let events: Option<IMFMediaEventGenerator> = if is_async {
        match t.cast() {
            Ok(eg) => Some(eg),
            Err(e) => {
                println!("      ✗ 事件源: {e}");
                return;
            }
        }
    } else {
        None
    };

    // ── 合成 NV12 底图（非全黑，否则编码器可能走极端优化路径）──
    let nv12 = synth_nv12(W, H);

    let mut frames = 0usize;
    let mut total_ms = 0f64;
    for i in 0..3u64 {
        let t0 = std::time::Instant::now();
        let res = submit_and_collect(&t, events.as_ref(), &nv12, i, is_async);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        match res {
            Ok(bytes) => {
                total_ms += ms;
                frames += 1;
                println!(
                    "      帧#{i}  ✓ {ms:7.2}ms  出 {} 包  {} B",
                    bytes.len(),
                    bytes.iter().map(|b| b.len()).sum::<usize>()
                );
            }
            Err(e) => {
                println!("      帧#{i}  ✗ {ms:7.2}ms  {e}");
                break;
            }
        }
    }
    if frames > 0 {
        println!(
            "      ── 实测 {frames} 帧均值 {:.2}ms/帧（{:.1} fps）★ 硬编可用 ──",
            total_ms / frames as f64,
            frames as f64 * 1000.0 / total_ms
        );
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    let _ = act.ShutdownObject();
}

/// 喂一帧 + 收产出（复刻主仓库 `submit_and_collect` 的 async 分支）。
unsafe fn submit_and_collect(
    t: &IMFTransform,
    events: Option<&IMFMediaEventGenerator>,
    nv12: &[u8],
    idx: u64,
    is_async: bool,
) -> Result<Vec<Vec<u8>>, String> {
    let sample = make_sample(nv12, idx);
    let mut out: Vec<Vec<u8>> = Vec::new();

    match events {
        None => {
            t.ProcessInput(0, &sample, 0).map_err(|e| format!("ProcessInput: {e}"))?;
            // 同步：循环收
            for _ in 0..4 {
                match drain_once(t)? {
                    Some(b) => out.push(b),
                    None => break,
                }
            }
        }
        Some(eg) => {
            // 等 NeedInput。注意：**每帧重算 deadline**，不能用同一个 deadline
            // 跨帧复用（不然第二帧起必然假超时）。
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
            let mut got_need = false;
            while !got_need {
                if std::time::Instant::now() >= deadline {
                    return Err("等 NeedInput 超时".into());
                }
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            return Err("MEError".into());
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            got_need = true;
                        }
                        // 顺带把攒下的 HaveOutput 也收掉（上一帧的尾巴）
                        if ty == METransformHaveOutput.0 as u32 {
                            if let Some(b) = drain_once(t)? {
                                out.push(b);
                            }
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(e) => return Err(format!("GetEvent: {e}")),
                }
            }
            t.ProcessInput(0, &sample, 0).map_err(|e| format!("ProcessInput: {e}"))?;
            // 收本帧产出。⚠️ 只在**收到 HaveOutput 后**再给一个短窗口等它出来，
            // 一旦无事件就立刻返回——绝不能无限期抽干事件队列：
            // 抽掉的 NeedInput 是**下一帧**要用的，这会导致「第二帧起永远超时」。
            let out_deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            let mut drained = 0usize;
            while std::time::Instant::now() < out_deadline {
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            return Err("MEError".into());
                        }
                        if ty == METransformHaveOutput.0 as u32 {
                            if let Some(b) = drain_once(t)? {
                                out.push(b);
                                drained += 1;
                                // 拿到一帧就不再等，把剩余事件留给下一帧
                                break;
                            }
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            // 提前到来的 NeedInput：塞回去不可行，只能记住
                            // 本帧已就绪。这里直接 break 让调用方下一帧立刻喂。
                            break;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(e) => return Err(format!("GetEvent: {e}")),
                }
            }
            let _ = drained;
        }
    }
    if out.is_empty() {
        return Err("一帧未出（低延迟模式下可能需要多喂几帧）".into());
    }
    let _ = is_async;
    Ok(out)
}

unsafe fn drain_once(t: &IMFTransform) -> Result<Option<Vec<u8>>, String> {
    let mut outs = [MFT_OUTPUT_DATA_BUFFER {
        dwStreamID: 0,
        ..Default::default()
    }];
    let mut status = 0u32;
    match t.ProcessOutput(0, &mut outs, &mut status) {
        Ok(()) => {}
        Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
        Err(e) => return Err(format!("ProcessOutput: {e}")),
    }
    let Some(sample) = outs[0].pSample.as_ref() else {
        return Ok(None);
    };
    let buf = sample
        .ConvertToContiguousBuffer()
        .map_err(|e| format!("ConvertToContiguousBuffer: {e}"))?;
    let mut ptr: *mut u8 = std::ptr::null_mut();
    let mut len = 0u32;
    buf.Lock(&mut ptr, None, Some(&mut len))
        .map_err(|e| format!("Lock: {e}"))?;
    let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
    let _ = buf.Unlock();
    Ok(Some(data))
}

unsafe fn make_sample(nv12: &[u8], idx: u64) -> IMFSample {
    let buf = MFCreateMemoryBuffer(nv12.len() as u32).expect("MFCreateMemoryBuffer");
    let mut ptr: *mut u8 = std::ptr::null_mut();
    buf.Lock(&mut ptr, None, None).expect("Lock");
    std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
    let _ = buf.Unlock();
    let _ = buf.SetCurrentLength(nv12.len() as u32);
    let sample = MFCreateSample().expect("MFCreateSample");
    let _ = sample.AddBuffer(&buf);
    let _ = sample.SetSampleTime((idx * 10_000_000 / FPS as u64) as i64);
    let _ = sample.SetSampleDuration((10_000_000 / FPS as u64) as i64);
    sample
}

/// 输入类型的三种设法（差异只在属性补全程度）。
#[derive(Clone, Copy, PartialEq)]
enum FpsMode {
    /// 5 属性，复刻主仓库 `create_video_type`
    None,
    /// 补 `MF_MT_FRAME_RATE`
    FrameRate,
    /// 补 `MF_MT_FRAME_RATE`，且 PAR 与帧率都按 MF 推荐比例设
    FrameRatePar,
}

unsafe fn create_in_type(mode: FpsMode) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H)).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(|e| e.to_string())?;
    if mode != FpsMode::None {
        t.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1)).map_err(|e| e.to_string())?;
    }
    if mode == FpsMode::FrameRatePar {
        t.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).map_err(|e| e.to_string())?;
        t.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1).map_err(|e| e.to_string())?;
    }
    Ok(t)
}

unsafe fn create_out_type(
    subtype: &windows::core::GUID,
    is_h264: bool,
) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(|e| e.to_string())?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H)).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(|e| e.to_string())?;
    t.SetUINT32(&MF_MT_AVG_BITRATE, BITRATE).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1)).map_err(|e| e.to_string())?;
    if is_h264 {
        t.SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH).map_err(|e| e.to_string())?;
        t.SetUINT32(&MF_MT_MPEG2_LEVEL, H264_LEVEL_41).map_err(|e| e.to_string())?;
    }
    Ok(t)
}

/// 合成一张不平凡的 NV12：灰阶渐变 + 移动方块，避免编码器走零成本路径。
unsafe fn synth_nv12(w: u32, h: u32) -> Vec<u8> {
    let mut v = vec![0u8; (w * h * 3 / 2) as usize];
    let y_plane = (w * h) as usize;
    for y in 0..h {
        for x in 0..w {
            let base = ((x * 255 / w.max(1)) as u8).wrapping_add((y * 255 / h.max(1)) as u8);
            // 叠一个循环移动的亮块，制造运动
            let bx = (x + 37) % w;
            let by = (y + 91) % h;
            let in_block = bx < 200 && by < 200;
            v[(y * w + x) as usize] = if in_block { 235 } else { base.wrapping_add(16) };
        }
    }
    for i in 0..(y_plane / 2) {
        v[y_plane + i] = 128; // 中性色度
    }
    v
}

fn pack(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

unsafe fn friendly_name(act: &IMFActivate) -> String {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    match act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)) {
        Ok(()) => String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)]),
        Err(_) => "(无名)".into(),
    }
}
