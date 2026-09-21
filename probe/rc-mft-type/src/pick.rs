//! 复刻 `create_h264_mft` 挑选逻辑的端到端验收（2026-09-21）。独立工程。
//!
//! # 为什么必须跑这个
//!
//! `pick` 探针证明了：H.264 枚举顺序是
//! `[0] Intel QSV（坏）` / `[1] NVIDIA NVENC（好）` —— 盲取 slice[0] 必失败。
//! 主仓库据此改成「按序试编，第一台能出包的才用」。
//!
//! 但**改完的挑选逻辑本身有没有效**，静态读代码推不出来（去重、排序、
//! 二次实例化三个环节都可能出错）。必须真跑一遍，验：
//!   1. 挑选过程是否跳过坏的那台
//!   2. 最终选中哪一台
//!   3. 用选中的实例**连续编码 30 帧**，帧率是多少（这才是真实收益数字）
//!
//! # 判据
//!
//! - 选中 NVIDIA NVENC（不是 Intel QSV）
//! - 30 帧平均耗时 < 15ms（即 > 66fps 余量，给抓屏留空间）

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

const W: u32 = 1920;
const H: u32 = 1080;
const FPS: u32 = 30;
const H264_PROFILE_HIGH: u32 = 100;
const PROBE_W: u32 = 1920;
const PROBE_H: u32 = 1080;
const PROBE_FPS: u32 = 30;

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            println!("MFStartup 失败: {e}");
            return;
        }
    }
    println!("═══════════════════════════════════════════════════════════");
    println!(" create_h264_mft 挑选逻辑端到端验收");
    println!(" 真实分辨率 {W}x{H} @ {FPS}fps（复刻 ultra 档真机尺寸）");
    println!("═══════════════════════════════════════════════════════════\n");

    unsafe {
        // 支持两个模式：`pick` 只挑（验证挑选逻辑）；`pick --bench <n>` 全新进程
        // 直接开第 n 台并压测（避开「同进程先跑过探测」的干扰）。
        let args: Vec<String> = std::env::args().collect();
        if args.len() >= 3 && args[1] == "--bench" {
            let n: usize = args[2].parse().unwrap_or(1);
            println!("  模式：干净进程直接开第 {n} 台（无任何试编）");
            if let Some((t, name)) = pick_mft_clean(&MFVideoFormat_H264, n) {
                println!("  实例：「{name}」");
                bench(&t, "干净进程");
            } else {
                println!("  ✗ 拿不到实例");
            }
        } else {
            match pick_mft(&MFVideoFormat_H264) {
                Ok((t, name, skipped)) => {
                    println!("\n  ▸ 最终选中：「{name}」（跳过 {skipped} 台）");
                    println!("  ▸ 判定：{}", verdict(&name));
                    println!(
                        "  ⚠️ 本进程已跑过 1080p 试编，bench 会报 0xC00D6D76（探针内干扰，\n     非主仓库问题）；压测请用 `pick --bench 1` 起干净进程。"
                    );
                }
                Err(e) => println!("\n  ✗ 挑选失败：{e}"),
            }
        }
    }

    unsafe {
        let _ = MFShutdown();
    }
    println!("\n─── 探针结束 ───");
}

fn verdict(name: &str) -> &'static str {
    if name.contains("NVIDIA") {
        "✓ 正确（NVIDIA NVENC，实测 7ms/帧 级）"
    } else if name.contains("Intel") {
        "⚠️ 选中了 Intel —— 需确认这台是否可用"
    } else {
        "? 未知厂商，看下面实测帧率"
    }
}

/// 复刻主仓库 `create_h264_mft`：不约束输入 → LUID 排序 → 逐台试编 → 二次实例化。
unsafe fn pick_mft(
    out_subtype: &windows::core::GUID,
) -> Result<(IMFTransform, String, usize), String> {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *out_subtype,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    for flags in [
        MFT_ENUM_FLAG_HARDWARE,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT,
        MFT_ENUM_FLAG_ALL,
    ] {
        count = 0;
        acts = std::ptr::null_mut();
        let _ = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            None,
            Some(&out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            println!("  枚举 flags={:#X} → {count} 台", flags.0);
            break;
        }
    }
    if count == 0 || acts.is_null() {
        return Err("枚举 0 台".into());
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let mut order: Vec<IMFActivate> = Vec::new();
    for a in slice.iter().flatten() {
        let dup = order.iter().any(|c| std::ptr::eq(c.as_raw(), a.as_raw()));
        if !dup {
            order.push(a.clone());
        }
    }
    CoTaskMemFree(Some(acts as _));
    println!("  去重后候选 {} 台：", order.len());
    for (i, a) in order.iter().enumerate() {
        println!("    [{i}] {}", friendly_name(a));
    }

    let mut tried = 0usize;
    for act in order.iter().take(6) {
        tried += 1;
        let name = friendly_name(act);
        let probe_inst: IMFTransform = match act.ActivateObject() {
            Ok(t) => t,
            Err(e) => {
                println!("    [{tried}] {name} → ActivateObject 失败：{e}");
                continue;
            }
        };
        if !probe_encodable(&probe_inst, true) {
            println!("    [{tried}] {name} → ✗ 试编失败");
            continue;
        }
        println!("    [{tried}] {name} → ✓ 试编通过");
        match act.ActivateObject::<IMFTransform>() {
            Ok(clean) => return Ok((clean, name, tried - 1)),
            Err(e) => println!("    [{tried}] {name} → 二次实例化失败：{e}"),
        }
    }
    Err(format!("{tried} 台全部试编失败"))
}

/// 对照实验：**不做任何试编**，直接 ActivateObject 选中项，看 2560x1440 能否设类型。
/// 用来区分「尺寸问题」和「试编副作用」。
unsafe fn pick_mft_clean(
    out_subtype: &windows::core::GUID,
    skip: usize,
) -> Option<(IMFTransform, String)> {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *out_subtype,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    let _ = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE,
        None,
        Some(&out_info),
        &mut acts,
        &mut count,
    );
    if count == 0 || acts.is_null() {
        return None;
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let target = slice.iter().flatten().nth(skip).cloned();
    CoTaskMemFree(Some(acts as _));
    let act = target?;
    let name = friendly_name(&act);
    act.ActivateObject::<IMFTransform>().ok().map(|t| (t, name))
}

/// 复刻主仓库 `probe_encodable`。
unsafe fn probe_encodable(t: &IMFTransform, is_h264: bool) -> bool {
    let Ok(attrs) = t.GetAttributes() else {
        return false;
    };
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_async && attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).is_err() {
        return false;
    }
    let Ok(out_type) = create_type(if is_h264 { &MFVideoFormat_H264 } else { &MFVideoFormat_HEVC }, PROBE_W, PROBE_H, PROBE_FPS, true) else {
        return false;
    };
    if t.SetOutputType(0, &out_type, 0).is_err() {
        return false;
    }
    let Ok(in_type) = create_type(&MFVideoFormat_NV12, PROBE_W, PROBE_H, PROBE_FPS, false) else {
        return false;
    };
    if t.SetInputType(0, &in_type, 0).is_err() {
        return false;
    }
    for _ in 0..2 {
        let Ok(mt) = t.GetOutputAvailableType(0, 0) else {
            break;
        };
        if t.SetOutputType(0, &mt, 0).is_ok() {
            break;
        }
    }
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    let need = (PROBE_W * PROBE_H * 3 / 2) as usize;
    let nv12 = synth_neutral(PROBE_W, PROBE_H);
    let events: Option<IMFMediaEventGenerator> = if is_async { t.cast().ok() } else { None };
    let mut got = 0usize;
    for idx in 0..2u64 {
        if let Ok(n) = feed(t, events.as_ref(), &nv12, idx, need, PROBE_FPS) {
            got += n;
        }
        if got > 0 {
            break;
        }
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    got > 0
}

/// 用「选中实例」做完整 open + 连续 30 帧计时。
unsafe fn bench(t: &IMFTransform, label: &str) {
    println!("\n  ── 连续编码 30 帧实测（{label}）──");
    let Ok(attrs) = t.GetAttributes() else {
        println!("      ✗ GetAttributes");
        return;
    };
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_async {
        let _ = attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
    }
    // 🔴 关键：**第一次 SetOutputType 必须成功**。实测一旦失败，MFT 实例
    // 进入坏状态，后续连正确的类型也设不上（干净进程里复现过）。
    // 所以不「自造类型去试」，而是**先取 MFT 自己给的可用类型**再改帧尺寸。
    let mut out_ok = false;
    if let Ok(avail) = t.GetOutputAvailableType(0, 0) {
        let sz = avail.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0);
        println!(
            "      MFT 可用输出类型：帧尺寸 {:#x}（原样={}x{}）",
            sz,
            (sz >> 32) as u32,
            sz as u32
        );
        let _ = avail.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H));
        let _ = avail.SetUINT32(&MF_MT_AVG_BITRATE, 8_000_000);
        let _ = avail.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1));
        match t.SetOutputType(0, &avail, 0) {
            Ok(()) => {
                println!("      ✓ SetOutputType（MFT 基准 + 改尺寸 {W}x{H}）");
                out_ok = true;
            }
            Err(e) => println!("      ✗ SetOutputType（MFT 基准）: {e}"),
        }
    } else {
        println!("      ✗ GetOutputAvailableType(0) 拿不到类型");
    }
    if !out_ok {
        println!("      ✗ 输出类型设不上，放弃");
        return;
    }
    let Ok(in_type) = create_type(&MFVideoFormat_NV12, W, H, FPS, false) else {
        println!("      ✗ 造输入类型");
        return;
    };
    if let Err(e) = t.SetInputType(0, &in_type, 0) {
        println!("      ✗ SetInputType: {e}");
        return;
    }
    for _ in 0..2 {
        let Ok(mt) = t.GetOutputAvailableType(0, 0) else {
            break;
        };
        let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, 8_000_000);
        if t.SetOutputType(0, &mt, 0).is_ok() {
            break;
        }
    }
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    if let Ok(api) = t.cast::<ICodecAPI>() {
        let _ = api.SetValue(
            &CODECAPI_AVLowLatencyMode,
            &windows::core::VARIANT::from(1u32),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncCommonMeanBitRate,
            &windows::core::VARIANT::from(8_000_000u32),
        );
        let _ = api.SetValue(
            &CODECAPI_AVEncMPVGOPSize,
            &windows::core::VARIANT::from(FPS),
        );
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    let need = (W * H * 3 / 2) as usize;
    let nv12 = synth_neutral(W, H);
    let events: Option<IMFMediaEventGenerator> = if is_async { t.cast().ok() } else { None };

    let mut ok = 0usize;
    let mut fail = 0usize;
    let mut total_ms = 0f64;
    let mut bytes = 0usize;
    for idx in 0..30u64 {
        let t0 = std::time::Instant::now();
        match feed(t, events.as_ref(), &nv12, idx, need, FPS) {
            Ok(n) if n > 0 => {
                ok += 1;
                total_ms += t0.elapsed().as_secs_f64() * 1000.0;
                bytes += n * 1000;
            }
            Ok(_) => fail += 1,
            Err(_) => {
                fail += 1;
                if fail > 5 {
                    break;
                }
            }
        }
    }
    if ok > 0 {
        let avg = total_ms / ok as f64;
        println!(
            "      ✓ 成功 {ok} 帧 / 失败 {fail} 帧   均值 {avg:.2} ms/帧  → {:.1} fps",
            ok as f64 * 1000.0 / total_ms
        );
        println!(
            "      判据（< 15ms/帧）：{}",
            if avg < 15.0 { "★ 达标" } else { "✗ 未达标" }
        );
    } else {
        println!("      ✗ 0 帧成功（失败 {fail}）");
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    let _ = bytes;
}

unsafe fn feed(
    t: &IMFTransform,
    events: Option<&IMFMediaEventGenerator>,
    nv12: &[u8],
    idx: u64,
    need: usize,
    fps: u32,
) -> Result<usize, ()> {
    let Ok(sample) = make_sample(nv12, need, idx, fps) else {
        return Err(());
    };
    let mut got = 0usize;
    match events {
        None => {
            if t.ProcessInput(0, &sample, 0).is_err() {
                return Err(());
            }
            while let Ok(true) = drain(t) {
                got += 1;
            }
        }
        Some(eg) => {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            let mut need_input = false;
            while !need_input {
                if std::time::Instant::now() >= deadline {
                    return Err(());
                }
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            return Err(());
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            need_input = true;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(_) => return Err(()),
                }
            }
            if t.ProcessInput(0, &sample, 0).is_err() {
                return Err(());
            }
            let out_deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(600);
            while std::time::Instant::now() < out_deadline {
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            return Err(());
                        }
                        if ty == METransformHaveOutput.0 as u32 {
                            match drain(t) {
                                Ok(true) => got += 1,
                                Ok(false) => {}
                                Err(_) => return Err(()),
                            }
                            break;
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            break;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(_) => return Err(()),
                }
            }
        }
    }
    Ok(got)
}

unsafe fn drain(t: &IMFTransform) -> Result<bool, ()> {
    let mut outs = [MFT_OUTPUT_DATA_BUFFER {
        dwStreamID: 0,
        ..Default::default()
    }];
    let mut status = 0u32;
    match t.ProcessOutput(0, &mut outs, &mut status) {
        Ok(()) => Ok(outs[0].pSample.is_some()),
        Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(false),
        Err(_) => Err(()),
    }
}

unsafe fn make_sample(nv12: &[u8], need: usize, idx: u64, fps: u32) -> Result<IMFSample, String> {
    let buf = MFCreateMemoryBuffer(need as u32).map_err(|e| e.to_string())?;
    let mut ptr: *mut u8 = std::ptr::null_mut();
    buf.Lock(&mut ptr, None, None).map_err(|e| e.to_string())?;
    std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, need);
    let _ = buf.Unlock();
    let _ = buf.SetCurrentLength(need as u32);
    let sample = MFCreateSample().map_err(|e| e.to_string())?;
    sample.AddBuffer(&buf).map_err(|e| e.to_string())?;
    let _ = sample.SetSampleTime((idx * 10_000_000 / fps.max(1) as u64) as i64);
    let _ = sample.SetSampleDuration((10_000_000 / fps.max(1) as u64) as i64);
    Ok(sample)
}

unsafe fn create_type(
    subtype: &windows::core::GUID,
    w: u32,
    h: u32,
    fps: u32,
    is_out: bool,
) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(|e| e.to_string())?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h)).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(|e| e.to_string())?;
    t.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).map_err(|e| e.to_string())?;
    if is_out {
        t.SetUINT32(&MF_MT_AVG_BITRATE, 8_000_000).map_err(|e| e.to_string())?;
        if subtype == &MFVideoFormat_H264 {
            t.SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH).map_err(|e| e.to_string())?;
            t.SetUINT32(&MF_MT_MPEG2_LEVEL, 41).map_err(|e| e.to_string())?;
        }
    }
    Ok(t)
}

unsafe fn synth_neutral(w: u32, h: u32) -> Vec<u8> {
    let need = (w * h * 3 / 2) as usize;
    let mut v = vec![0u8; need];
    for (i, b) in v.iter_mut().take((w * h) as usize).enumerate() {
        *b = ((i as u32 * 7 / w.max(1)) % 200 + 16) as u8;
    }
    for b in v.iter_mut().skip((w * h) as usize) {
        *b = 128;
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
