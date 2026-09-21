//! 硬编 MFT 的**选型与探测**（2026-09-21 从 `encode_h264.rs` 拆出）。
//!
//! # 为什么单独一个文件
//!
//! 这里是「哪个编码器能用」的全部逻辑：枚举 → 排序 → 逐台试编 → 交出干净实例，
//! 外加媒体类型/sample 的构造工具。它与「编码器怎么用」（`MfH264Encoder` 的
//! open/encode/drain）是两种完全不同的变更理由——前者随显卡与驱动演进，
//! 后者随 MF 协议演进。拆开之前，`encode_h264.rs` 里 460 余行是这块。
//!
//! # 🔴 三条实测约束（改这里之前必读，来源 `probe/rc-mft-type`）
//!
//! 1. **枚举不能带 NV12 输入约束**。硬编 MFT 全是 async，在设输出类型之前
//!    `GetInputAvailableType` 返回空 → 带 NV12 约束的 `MFTEnumEx` 枚举 **0 台**。
//! 2. **不能盲取 `slice[0]`**。本机实测 H.264 枚举序是
//!    `[0] Intel QSV（✗ 首帧挂死）`、`[1] NVIDIA NVENC（✓ 7ms/帧）`——盲取必失败。
//! 3. **试编探测与正式使用必须是两个独立实例**。`probe_encodable` 会设类型、
//!    开流、喂帧；把探测过的实例交出去，`open_inner` 就在一个「已跑过流」的
//!    transform 上重新协商类型，行为未定义。
//!
//! 对外暴露 `create_h264_mft`（选型主入口）与一组媒体类型/sample 构造工具；
//! `open_inner`（`encode_h264.rs`）与它一起完成「开一台编码器」。

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;

use super::encode_h264::{
    bitrate_for_width, h264_level_for, mf_err, VideoCodec, H264_PROFILE_HIGH,
};

/// 试编探测用的固定尺寸/帧率。
///
/// 用固定值而非调用方真实分辨率：探测只回答「这台能不能出包」，
/// 与目标分辨率无关；固定值也让多台 MFT 的探测耗时可比。
const PROBE_W: u32 = 1920;
const PROBE_H: u32 = 1080;
const PROBE_FPS: u32 = 30;

/// 提取 D3D11 设备所在 DXGI 适配器的 LUID（打包成 u64：High<<32 | Low）。
/// 提不到（异常驱动）返回 None，调用方退回「枚举第一个」的旧行为。
pub(super) fn adapter_luid_of(device: &ID3D11Device) -> Option<u64> {
    use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGIAdapter};
    unsafe {
        let dxgi: IDXGIDevice = device.cast().ok()?;
        let adapter: IDXGIAdapter = dxgi.GetAdapter().ok()?;
        let desc = adapter.GetDesc().ok()?;
        Some(((desc.AdapterLuid.HighPart as i64 as u64) << 32) | desc.AdapterLuid.LowPart as u64)
    }
}

/// 挑一台可用的硬编 MFT 并 ActivateObject 返回。
///
/// ⚠️ 2026-09-21 三处修正（探针 `probe/rc-mft-type` 实测，逐条有数据）：
/// ① **枚举不能带 NV12 输入约束**。硬编 MFT 全是 async，在设输出类型之前
///    `GetInputAvailableType` 返回空 → 带 NV12 约束的 `MFTEnumEx` 枚举 **0 台**。
///    `pick` 探针验证：去掉输入约束后 H.264/HEVC 各枚举到 3 台。
/// ② **不能盲取 `slice[0]`**。实测 H.264 枚举顺序是
///    `[0] Intel QSV H.264（✗ 首帧挂死）`、`[1] NVIDIA NVENC H.264（✓ 7ms/帧）`——
///    盲取第一个必失败。改为**按序试编**：每台真喂几帧，第一台能出包的就用。
/// ③ 试编成本只在**开编码器时**付一次（约几十 ms），不是每帧，可以接受。
pub(super) unsafe fn create_h264_mft(prefer_adapter: Option<u64>, codec: VideoCodec) -> Result<IMFTransform, String> {
    let pick_t0 = std::time::Instant::now();
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *codec.mf_subtype(),
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    // 硬件 MFT 多为 async：不能只用 HARDWARE|SYNCMFT（会枚举 0 个掉进软编）
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
            None, // ← 不带输入约束（见上方 ①）
            Some(&out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            break;
        }
    }
    if count == 0 || acts.is_null() {
        return Err(format!("无 {} MFT", codec.as_str()));
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);

    // 候选排序：LUID 匹配的排最前（混合显卡零拷贝路径需要同适配器），其余按枚举序。
    // 去重按原始指针：`IMFActivate` 的 clone 只是 AddRef 同一 COM 对象，
    // 指针相等即同一个 MFT。
    let mut order: Vec<IMFActivate> = Vec::new();
    if let Some(want) = prefer_adapter {
        for a in slice.iter().flatten() {
            if a.GetUINT64(&MFT_ENUM_ADAPTER_LUID).map(|v| v == want).unwrap_or(false) {
                order.push(a.clone());
            }
        }
        if order.is_empty() {
            log::warn!("[RC] 没有 LUID 匹配的编码 MFT，退回枚举顺序");
        }
    }
    for a in slice.iter().flatten() {
        let dup = order
            .iter()
            .any(|c| std::ptr::eq(c.as_raw(), a.as_raw()));
        if !dup {
            order.push(a.clone());
        }
    }
    CoTaskMemFree(Some(acts as _));

    // 逐台试编：第一台真能出包的才返回
    //
    // 🔴 诊断探针（2026-09-21）：选型过程过去在日志里是**隐形的**——只知道
    // 「硬编没启用」，不知道试了几台、每台为何失败、花了多久。2026-09-21
    // 排查「H.264 从未启用」时，正是这三条信息的缺失让定位绕了远路。
    // 现在把每台的试编结果记进 `MftPickReport`，由 `perf` 模块渲染成一条
    // 可 grep 的日志（`grep 编码器选型`）。
    let mut report = super::perf::MftPickReport {
        candidates: order.len(),
        ..Default::default()
    };
    let mut tried = 0usize;
    for act in order.iter().take(6) {
        tried += 1;
        let name = friendly_name_of(act).unwrap_or_else(|| "(无名)".into());
        let probe_t0 = std::time::Instant::now();
        // 🔴 探测与使用**必须是两个独立实例**：`probe_encodable` 会设类型、
        // 开流、喂帧，若把探测用的实例直接交出去，`open_inner` 就在一个
        // 「已跑过流的」transform 上重新协商类型——行为未定义。
        // 多 ActivateObject 一次只是一次 COM 实例化，代价可忽略。
        let probe_inst = match act.ActivateObject::<IMFTransform>() {
            Ok(t) => t,
            Err(e) => {
                log::warn!("[RC] 编码器「{name}」ActivateObject 失败：{e}");
                report
                    .details
                    .push((format!("{name}（实例化失败）"), false, probe_t0.elapsed().as_millis() as u64));
                continue;
            }
        };
        if !probe_encodable(&probe_inst, codec) {
            let ms = probe_t0.elapsed().as_millis() as u64;
            log::warn!("[RC] 编码器「{name}」试编失败，尝试下一台");
            report.details.push((name.clone(), false, ms));
            continue;
        }
        let ms = probe_t0.elapsed().as_millis() as u64;
        report.details.push((name.clone(), true, ms));
        // 探测通过 → 另起一台干净的实例交给调用方
        match act.ActivateObject::<IMFTransform>() {
            Ok(clean) => {
                if tried > 1 {
                    log::info!(
                        "[RC] 跳过 {} 台不可用编码器，选中「{name}」",
                        tried - 1
                    );
                }
                report.tried = tried;
                report.skipped = tried.saturating_sub(1);
                report.chosen = name;
                report.pick_ms = pick_t0.elapsed().as_millis() as u64;
                log::info!("{}", super::perf::render_pick(&report));
                return Ok(clean);
            }
            Err(e) => {
                log::warn!("[RC] 编码器「{name}」二次实例化失败：{e}");
                report.details.push((format!("{name}（二次实例化失败）"), false, 0));
            }
        }
    }
    report.tried = tried;
    report.skipped = tried;
    report.pick_ms = pick_t0.elapsed().as_millis() as u64;
    log::warn!("{}", super::perf::render_pick(&report));
    Err(format!(
        "{} 的 {tried} 台硬编 MFT 全部试编失败",
        codec.as_str()
    ))
}

/// IMFActivate 的友好名（日志用）。
unsafe fn friendly_name_of(act: &IMFActivate) -> Option<String> {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len))
        .ok()
        .map(|_| {
            String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)])
        })
}

/// 试编探测：不改变 transform 的对外状态，只回答「这台 MFT 能不能一路出包」。
///
/// 为什么不能用「尝试设类型」代替：`pick` 探针实测 Intel QSV H.264 的
/// **设类型全部成功**，坏是坏在首帧 ProcessOutput（抛流变化后事件流挂死）——
/// 只有真喂一帧才暴露得出来。
/// 这里让 transform 走完完整的类型协商（顺序见 `open_inner`）再喂 2 帧，
/// 至少出 1 包才判可用。
pub(super) unsafe fn probe_encodable(t: &IMFTransform, codec: VideoCodec) -> bool {
    let (w, h, fps) = (PROBE_W, PROBE_H, PROBE_FPS);
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
    // 先输出后输入（顺序见 open_inner 的注释）
    let bitrate = bitrate_for_width(w);
    let Ok(out_type) = create_video_type(codec.mf_subtype(), w, h, fps) else {
        return false;
    };
    let _ = out_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
    if codec == VideoCodec::H264 {
        let _ = out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH);
        let _ = out_type.SetUINT32(&MF_MT_MPEG2_LEVEL, h264_level_for(w, h, fps));
    }
    if t.SetOutputType(0, &out_type, 0).is_err() {
        return false;
    }
    let Ok(in_type) = create_video_type(&MFVideoFormat_NV12, w, h, fps) else {
        return false;
    };
    if t.SetInputType(0, &in_type, 0).is_err() {
        return false;
    }
    // open 阶段的一次性再协商（NVIDIA 在这里抛流变化，见 open_inner 同段逻辑）
    for _ in 0..2 {
        let Ok(mt) = t.GetOutputAvailableType(0, 0) else {
            break;
        };
        let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
        let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps, 1));
        if t.SetOutputType(0, &mt, 0).is_ok() {
            break;
        }
    }
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    // 造一帧中性 NV12（灰阶渐变，避免编码器走「全黑零成本」路径给出假阳性）
    let need = (w * h * 3 / 2) as usize;
    let mut nv12 = vec![0u8; need];
    for (i, b) in nv12.iter_mut().take((w * h) as usize).enumerate() {
        *b = ((i as u32 * 7 / w.max(1)) % 200 + 16) as u8;
    }
    for b in nv12.iter_mut().skip((w * h) as usize) {
        *b = 128;
    }

    // async 走事件协议；同步直接 ProcessInput/ProcessOutput
    let events: Option<IMFMediaEventGenerator> = if is_async {
        t.cast().ok()
    } else {
        None
    };
    let mut got = 0usize;
    for idx in 0..2u64 {
        match probe_feed(t, events.as_ref(), &nv12, idx, need) {
            Ok(n) => got += n,
            Err(_) => break,
        }
        if got > 0 {
            break;
        }
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    got > 0
}

/// 试编喂一帧，返回收到的包数。
unsafe fn probe_feed(
    t: &IMFTransform,
    events: Option<&IMFMediaEventGenerator>,
    nv12: &[u8],
    idx: u64,
    need: usize,
) -> Result<usize, ()> {
    let Ok(sample) = make_sample(nv12, need, idx, PROBE_FPS) else {
        return Err(());
    };
    let mut got = 0usize;
    match events {
        None => {
            if t.ProcessInput(0, &sample, 0).is_err() {
                return Err(());
            }
            while let Ok(true) = drain_probe(t) {
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
                            match drain_probe(t) {
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

/// 试编收包，返回是否收到（错误直接吞掉——探测而已）。
unsafe fn drain_probe(t: &IMFTransform) -> Result<bool, ()> {
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

/// 取 MFT 自己给出的输出类型为基准，只改帧尺寸/帧率/码率/profile。
///
/// 为什么不能自造：探针实测 NVIDIA MFT 对自造的 2560×1440 输出类型报
/// `MF_E_DXGI_UNSUPPORTED_DEVICE (0xC00D6D76)`，而用 MFT 自己给的类型
/// （帧尺寸字段为 0，即「未指定」，由调用方填）改尺寸后立刻通过。
/// 用 MFT 给的类型还有个附赠好处：它带着厂商要求的其余属性
///（如 `MF_MT_MPEG2_PROFILE` 的默认值、色彩信息），不必我们猜。
pub(super) unsafe fn pick_output_type(
    t: &IMFTransform,
    codec: VideoCodec,
    w: u32,
    h: u32,
    fps: u32,
    bitrate: u32,
) -> Result<IMFMediaType, String> {
    // 找第一个 subtype 匹配的可用输出类型
    let mut base: Option<IMFMediaType> = None;
    for i in 0..16u32 {
        let Ok(mt) = t.GetOutputAvailableType(0, i) else {
            break;
        };
        let ok = mt
            .GetGUID(&MF_MT_SUBTYPE)
            .map(|g| g == *codec.mf_subtype())
            .unwrap_or(false);
        if ok {
            base = Some(mt);
            break;
        }
    }
    let mt = base.ok_or("MFT 没有该 subtype 的可用输出类型")?;
    // 只改我们关心的：帧尺寸 / 帧率 / 码率（其余保留 MFT 的原始设定）
    mt.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(mf_err)?;
    let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1));
    let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
    let _ = mt.SetUINT32(&MF_MT_INTERLACE_MODE, 2);
    // Q3：profile/level 只有 H.264 标注——HEVC MFT 强写 H.264 语义的这两个键会拒开
    if codec == VideoCodec::H264 {
        let _ = mt.SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH);
        let _ = mt.SetUINT32(&MF_MT_MPEG2_LEVEL, h264_level_for(w, h, fps));
    }
    Ok(mt)
}

/// 造视频媒体类型。⚠️ 2026-09-21：`fps` **必须**带上（探针 A/B 对照实测）——
/// 过去只设 5 个属性（major/subtype/interlace/frame_size/PAR），硬编 MFT 一律
/// 拒收，报 `MF_E_INVALIDTYPE (0xC00D36B4)`。补 `MF_MT_FRAME_RATE` 后
/// NVIDIA NVENC / Intel QSV 四台编码器全部接受。
pub(super) unsafe fn create_video_type(
    subtype: &windows::core::GUID,
    w: u32,
    h: u32,
    fps: u32,
) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(mf_err)?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(mf_err)?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(mf_err)?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(mf_err)?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(mf_err)?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32x2(1, 1))
        .map_err(mf_err)?;
    t.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1))
        .map_err(mf_err)?;
    Ok(t)
}

pub(super) fn pack_u32x2(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

pub(super) fn pack_ratio(n: u32, d: u32) -> u64 {
    pack_u32x2(n, d)
}

/// P1：把 NV12 GPU 纹理包装成编码器输入 sample（D3D11-aware MFT 用）。
pub(super) unsafe fn make_dxgi_sample(
    tex: &ID3D11Texture2D,
    idx: u64,
    fps: u32,
) -> Result<IMFSample, String> {
    let iid = <ID3D11Texture2D as Interface>::IID;
    let buf = MFCreateDXGISurfaceBuffer(&iid, tex, 0, false).map_err(mf_err)?;
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

pub(super) unsafe fn make_sample(nv12: &[u8], len: usize, idx: u64, fps: u32) -> Result<IMFSample, String> {
    let buf = MFCreateMemoryBuffer(len as u32).map_err(mf_err)?;
    {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut max = 0u32;
        let mut cur = 0u32;
        buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
            .map_err(mf_err)?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, len);
        }
        buf.SetCurrentLength(len as u32).map_err(mf_err)?;
        buf.Unlock().map_err(mf_err)?;
    }
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

pub(super) unsafe fn lock_buf(buf: &IMFMediaBuffer) -> Result<Vec<u8>, String> {
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut max = 0u32;
    let mut cur = 0u32;
    buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
        .map_err(mf_err)?;
    let n = if cur > 0 { cur as usize } else { max as usize };
    let mut out = vec![0u8; n];
    if !data.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(data, out.as_mut_ptr(), n);
    }
    buf.Unlock().map_err(mf_err)?;
    Ok(out)
}