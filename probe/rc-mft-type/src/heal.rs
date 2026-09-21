//! 运行时流变化自愈探针（2026-09-21）。独立工程。
//!
//! # 背景
//!
//! `e2e` 探针发现：Intel QSV 那一路**不在 open 阶段**抛流变化，而是在
//! **首帧的 ProcessOutput** 才抛 `MF_E_TRANSFORM_STREAM_CHANGE (0xC00D6D61)`。
//! 主仓库刚据此在 `submit_and_collect` 里加了运行时兜底：
//! 捕获该错 → `renegotiate_output()` → `rebuild_sample()` 重喂同一帧 → 重试。
//!
//! # 本探针要回答
//!
//! 这条自愈路径**真的能把 Intel 救回来吗**？具体验证：
//!   1. 首帧 ProcessOutput 抛 0xC00D6D61（复现）
//!   2. 按 `GetOutputAvailableType(0)` 重设输出类型 → 能否成功
//!   3. **重喂同一帧**（不重设输入类型）→ 能否出包
//!   4. 之后连续几帧是否恢复正常节奏
//!
//! 第 3 步是关键：如果重协商后**必须重设输入类型**，那主仓库的实现就还差一步。
//! 不用猜，跑一遍就知道。

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

const W: u32 = 1920;
const H: u32 = 1080;
const FPS: u32 = 30;
const BITRATE: u32 = 8_000_000;
const H264_PROFILE_HIGH: u32 = 100;
const H264_LEVEL_41: u32 = 41;

/// 流变化错误码：MF_E_TRANSFORM_STREAM_CHANGE
const MF_E_TRANSFORM_STREAM_CHANGE_CODE: i32 = 0xC00D6D61u32 as i32;

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            println!("MFStartup 失败: {e}");
            return;
        }
    }
    println!("═══════════════════════════════════════════════════════════");
    println!(" 运行时流变化自愈验证 · 首帧报错 → 再协商 → 重喂");
    println!(" 帧 {W}x{H} @ {FPS}fps");
    println!("═══════════════════════════════════════════════════════════\n");

    for (label, subtype, is_h264) in [
        ("H.264", MFVideoFormat_H264, true),
        ("HEVC", MFVideoFormat_HEVC, false),
    ] {
        println!("══ {label} ══════════════════════════════════════════════");
        run(&subtype, is_h264);
        println!();
    }

    unsafe {
        let _ = MFShutdown();
    }
    println!("─── 探针结束 ───");
}

fn run(out_subtype: &windows::core::GUID, is_h264: bool) {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *out_subtype,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    unsafe {
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
        unsafe { try_heal(act, out_subtype, is_h264) };
    }
    if !acts.is_null() {
        unsafe { CoTaskMemFree(Some(acts as _)) };
    }
}

unsafe fn try_heal(act: &IMFActivate, out_subtype: &windows::core::GUID, is_h264: bool) {
    let t: IMFTransform = match act.ActivateObject() {
        Ok(t) => t,
        Err(e) => {
            println!("      ✗ ActivateObject: {e}");
            return;
        }
    };
    let attrs = match t.GetAttributes() {
        Ok(a) => a,
        Err(e) => {
            println!("      ✗ GetAttributes: {e}");
            return;
        }
    };
    if attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false)
    {
        let _ = attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
    }

    // open：先输出后输入（e2e 已验证的正确顺序）
    let out_type = match create_out_type(out_subtype, is_h264) {
        Ok(m) => m,
        Err(e) => {
            println!("      ✗ 造输出类型: {e}");
            return;
        }
    };
    if let Err(e) = t.SetOutputType(0, &out_type, 0) {
        println!("      ✗ SetOutputType: {e}");
        return;
    }
    let in_type = match create_in_type() {
        Ok(m) => m,
        Err(e) => {
            println!("      ✗ 造输入类型: {e}");
            return;
        }
    };
    if let Err(e) = t.SetInputType(0, &in_type, 0) {
        println!("      ✗ SetInputType: {e}");
        return;
    }
    println!("      open 类型协商 ✓");

    // 低延迟配置
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    if let Ok(api) = t.cast::<ICodecAPI>() {
        let _ = api.SetValue(
            &CODECAPI_AVLowLatencyMode,
            &windows::core::VARIANT::from(1u32),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncCommonMeanBitRate,
            &windows::core::VARIANT::from(BITRATE),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncMPVGOPSize,
            &windows::core::VARIANT::from(FPS),
        );
    }

    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    let eg: IMFMediaEventGenerator = match t.cast() {
        Ok(e) => e,
        Err(e) => {
            println!("      ✗ 事件源: {e}");
            return;
        }
    };

    let nv12 = synth_nv12(W, H);
    let mut healed = false;

    // 模拟主仓库 submit_and_collect：喂帧 → 收；若遇 0xC00D6D61 则自愈重试
    for idx in 0..6u64 {
        match feed_frame(&t, &eg, &nv12, idx) {
            Ok(n) => {
                println!("      帧#{idx} ✓ 出 {n} 包  {} B", if n > 0 { "" } else { "（空）" });
            }
            Err((code, msg)) => {
                if code == MF_E_TRANSFORM_STREAM_CHANGE_CODE {
                    println!("      帧#{idx} 捕获流变化 0xC00D6D61 → 触发自愈");
                    // ★ 复刻 renegotiate_output()
                    let mut ok = false;
                    for _ in 0..2 {
                        let Ok(mt) = t.GetOutputAvailableType(0, 0) else {
                            break;
                        };
                        let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, BITRATE);
                        let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1));
                        if t.SetOutputType(0, &mt, 0).is_ok() {
                            ok = true;
                            break;
                        }
                    }
                    if !ok {
                        println!("        ✗ 再协商失败，自愈无法继续");
                        break;
                    }
                    println!("        再协商 SetOutputType ✓");
                    // ★ 先复刻 rebuild_sample()：重喂**同一帧**
                    match feed_frame(&t, &eg, &nv12, idx) {
                        Ok(n) => {
                            println!("        重喂同一帧 ✓ 出 {n} 包 ★ 自愈成功（沿用原实例）");
                            healed = true;
                        }
                        Err(_) => {
                            println!("        重喂同一帧 ✗ 事件流已死");
                            // ★★ 关键分流：改用「重开编码器」而不是沿用实例
                            if let Some((t2, eg2)) = reopen(act, out_subtype, is_h264) {
                                // ⚠️ 重开后**首帧可能仍报流变化/空包**——所以判据
                                // 不是「第 1 帧出包」，而是「连续 3 帧里有帧出包」。
                                let mut got = 0usize;
                                for j in idx..(idx + 4) {
                                    match feed_frame(&t2, &eg2, &nv12, j) {
                                        Ok(k) if k > 0 => {
                                            got += k;
                                            println!("          帧#{j} ✓ 出 {k} 包");
                                        }
                                        Ok(_) => println!("          帧#{j} · 空包"),
                                        Err((c3, m3)) => {
                                            println!("          帧#{j} ✗ ({c3:#X}) {m3}")
                                        }
                                    }
                                }
                                if got > 0 {
                                    println!(
                                        "        ★ 重开编码器后连续出包（共 {got} 包）← 该类 MFT 必须重开"
                                    );
                                    healed = true;
                                } else {
                                    println!("        ✗ 重开后 4 帧仍无产出");
                                }
                                let _ = t2
                                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
                                break;
                            } else {
                                println!("        重开编码器 ✗ 打不开");
                            }
                        }
                    }
                } else {
                    println!("      帧#{idx} ✗ ({code:#X}) {msg}");
                    break;
                }
            }
        }
    }
    if healed {
        println!("      ── 结论：该 MFT 的运行时自愈路径成立 ★ ──");
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    let _ = act.ShutdownObject();
}

/// 重开一台全新 encoder（完整走一遍 open 协商），返回 (transform, 事件源)。
unsafe fn reopen(
    act: &IMFActivate,
    out_subtype: &windows::core::GUID,
    is_h264: bool,
) -> Option<(IMFTransform, IMFMediaEventGenerator)> {
    let t: IMFTransform = act.ActivateObject().ok()?;
    let attrs = t.GetAttributes().ok()?;
    if attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false)
    {
        let _ = attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
    }
    let out_type = create_out_type(out_subtype, is_h264).ok()?;
    t.SetOutputType(0, &out_type, 0).ok()?;
    let in_type = create_in_type().ok()?;
    t.SetInputType(0, &in_type, 0).ok()?;
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    if let Ok(api) = t.cast::<ICodecAPI>() {
        let _ = api.SetValue(
            &CODECAPI_AVLowLatencyMode,
            &windows::core::VARIANT::from(1u32),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncCommonMeanBitRate,
            &windows::core::VARIANT::from(BITRATE),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncMPVGOPSize,
            &windows::core::VARIANT::from(FPS),
        );
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    let eg: IMFMediaEventGenerator = t.cast().ok()?;
    Some((t, eg))
}

/// 喂一帧并收包。返回 (包数) 或 (错误码, 消息)。
unsafe fn feed_frame(
    t: &IMFTransform,
    eg: &IMFMediaEventGenerator,
    nv12: &[u8],
    idx: u64,
) -> Result<usize, (i32, String)> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
    let mut got_need = false;
    while !got_need {
        if std::time::Instant::now() >= deadline {
            return Err((0, "等 NeedInput 超时".into()));
        }
        match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
            Ok(ev) => {
                let ty = ev.GetType().unwrap_or(0);
                if ty == MEError.0 as u32 {
                    return Err((0, "MEError".into()));
                }
                if ty == METransformNeedInput.0 as u32 {
                    got_need = true;
                }
            }
            Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(e) => return Err((e.code().0, format!("GetEvent: {e}"))),
        }
    }
    let sample = match make_sample(nv12, idx) {
        Ok(s) => s,
        Err(e) => return Err((0, e)),
    };
    if let Err(e) = t.ProcessInput(0, &sample, 0) {
        return Err((e.code().0, format!("ProcessInput: {e}")));
    }
    // 收集输出
    let out_deadline = std::time::Instant::now() + std::time::Duration::from_millis(800);
    let mut n = 0usize;
    while std::time::Instant::now() < out_deadline {
        match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
            Ok(ev) => {
                let ty = ev.GetType().unwrap_or(0);
                if ty == MEError.0 as u32 {
                    return Err((0, "MEError".into()));
                }
                if ty == METransformHaveOutput.0 as u32 {
                    match drain_once(t) {
                        Ok(Some(_)) => {
                            n += 1;
                            break;
                        }
                        Ok(None) => {}
                        Err((c, m)) => return Err((c, m)),
                    }
                }
                if ty == METransformNeedInput.0 as u32 {
                    break;
                }
            }
            Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(e) => return Err((e.code().0, format!("GetEvent: {e}"))),
        }
    }
    Ok(n)
}

unsafe fn drain_once(t: &IMFTransform) -> Result<Option<Vec<u8>>, (i32, String)> {
    let mut outs = [MFT_OUTPUT_DATA_BUFFER {
        dwStreamID: 0,
        ..Default::default()
    }];
    let mut status = 0u32;
    match t.ProcessOutput(0, &mut outs, &mut status) {
        Ok(()) => {}
        Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
        Err(e) => return Err((e.code().0, format!("ProcessOutput: {e}"))),
    }
    let Some(sample) = outs[0].pSample.as_ref() else {
        return Ok(None);
    };
    let buf = sample
        .ConvertToContiguousBuffer()
        .map_err(|e| (e.code().0, format!("ConvertToContiguousBuffer: {e}")))?;
    let mut ptr: *mut u8 = std::ptr::null_mut();
    let mut len = 0u32;
    buf.Lock(&mut ptr, None, Some(&mut len))
        .map_err(|e| (e.code().0, format!("Lock: {e}")))?;
    let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
    let _ = buf.Unlock();
    Ok(Some(data))
}

unsafe fn make_sample(nv12: &[u8], idx: u64) -> Result<IMFSample, String> {
    let buf = MFCreateMemoryBuffer(nv12.len() as u32).map_err(|e| e.to_string())?;
    let mut ptr: *mut u8 = std::ptr::null_mut();
    buf.Lock(&mut ptr, None, None).map_err(|e| e.to_string())?;
    std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
    let _ = buf.Unlock();
    let _ = buf.SetCurrentLength(nv12.len() as u32);
    let sample = MFCreateSample().map_err(|e| e.to_string())?;
    sample.AddBuffer(&buf).map_err(|e| e.to_string())?;
    let _ = sample.SetSampleTime((idx * 10_000_000 / FPS as u64) as i64);
    let _ = sample.SetSampleDuration((10_000_000 / FPS as u64) as i64);
    Ok(sample)
}

unsafe fn create_in_type() -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H)).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1)).map_err(|e| e.to_string())?;
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

unsafe fn synth_nv12(w: u32, h: u32) -> Vec<u8> {
    let mut v = vec![0u8; (w * h * 3 / 2) as usize];
    let y_plane = (w * h) as usize;
    for y in 0..h {
        for x in 0..w {
            let base = ((x * 255 / w.max(1)) as u8).wrapping_add((y * 255 / h.max(1)) as u8);
            let bx = (x + 37) % w;
            let by = (y + 91) % h;
            v[(y * w + x) as usize] = if bx < 200 && by < 200 {
                235
            } else {
                base.wrapping_add(16)
            };
        }
    }
    for i in 0..(y_plane / 2) {
        v[y_plane + i] = 128;
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
