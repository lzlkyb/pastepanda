//! 硬编打不开的原因验证探针（2026-09-21）。独立工程，不进 pastePanda 依赖树。
//!
//! # 背景
//!
//! 真机日志：
//! ```text
//! [RC] 编码能力探测：h264_gpu=false hevc=false 主屏刷新=100Hz 显示器=1
//! [RC] h264 不可用，调用方回退：MF：没有为此流或其所依靠的流设置有效的类型。 (0xC00D6D60)
//! ```
//! 而前一个探针已证明 **Intel QSV + NVIDIA NVENC 的 H.264 硬编 MFT 都在**。
//! 所以 `0xC00D6D60`（`MF_E_INVALIDMEDIATYPE`）是**类型协商失败**，不是能力缺失。
//!
//! # 假设
//!
//! 主仓库 `encode_h264.rs:673` 的 `create_video_type` 从零造 NV12 输入类型，
//! 只设了 5 个属性（major / subtype / interlace / frame_size / PAR）——
//! **缺 `MF_MT_FRAME_RATE`**。而输出类型反而设了 frame_rate（第 306 行），
//! 这个不对称说明输入类型那一侧是疏漏。
//!
//! 硬编 MFT 往往用 `MF_MT_FRAME_RATE` 做码控基准，缺了就拒收。
//!
//! # 验法
//!
//! 对同一台 MFT，分别用两种方式设输入类型：
//!   A. 自造（复刻主仓库 `create_video_type`）→ 预期失败
//!   B. 补 `MF_MT_FRAME_RATE` → 预期成功
//!   C. 从 `GetInputAvailableType` 取基准再改分辨率 → 最稳
//!
//! 三条都真跑，谁成功谁就是正确修法。

use windows::core::GUID;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

const W: u32 = 2560;
const H: u32 = 1440;
const FPS: u32 = 30;

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            println!("MFStartup 失败: {e}");
            return;
        }
    }
    println!("═══════════════════════════════════════════════════════════");
    println!(" 硬编打不开原因验证 · 输入类型协商");
    println!(" 帧 {W}x{H} @ {FPS}fps  —— 复刻真机 virtual 模式尺寸");
    println!("═══════════════════════════════════════════════════════════\n");

    for (label, subtype) in [("H.264", MFVideoFormat_H264), ("HEVC", MFVideoFormat_HEVC)] {
        println!("── {label} ─────────────────────────────────────────────");
        test_on_mft(&subtype, &["NVIDIA", "Intel"]);
        println!();
    }

    unsafe {
        let _ = MFShutdown();
    }
    println!("─── 探针结束 ───");
}

/// 对匹配关键字的 MFT 逐个跑三种输入类型设法。
fn test_on_mft(subtype: &GUID, vendor_keywords: &[&str]) {
    let in_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *subtype,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    unsafe {
        let _ = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE,
            Some(&in_info),
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
    for act in slice.iter().flatten() {
        let name = unsafe {
            let mut buf = [0u16; 256];
            let mut len = 0u32;
            match act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)) {
                Ok(()) => {
                    String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)])
                }
                Err(_) => "(无名)".into(),
            }
        };
        // 只看我们要验的厂商
        if !vendor_keywords.iter().any(|k| name.contains(k)) {
            continue;
        }
        println!("\n  ▸ {name}");
        unsafe {
            let t: IMFTransform = match act.ActivateObject() {
                Ok(t) => t,
                Err(e) => {
                    println!("      ✗ ActivateObject 失败: {e}");
                    continue;
                }
            };
            // async MFT 必须解锁才能设类型
            let is_async = unlock_async(&t);
            println!("      async = {is_async}");

            // ── A. 复刻主仓库 create_video_type（缺 FRAME_RATE）──
            match set_input_from_scratch(&t, false) {
                Ok(()) => println!("      [A] 自造类型（缺 FRAME_RATE）  → ✓ 成功"),
                Err(e) => println!("      [A] 自造类型（缺 FRAME_RATE）  → ✗ {e}"),
            }
            // 每次失败后要清掉已设类型，避免污染下一轮
            let _ = t.SetInputType(0, None, 0);

            // ── B. 自造但补 FRAME_RATE ──
            match set_input_from_scratch(&t, true) {
                Ok(()) => println!("      [B] 自造类型（补 FRAME_RATE） → ✓ 成功   ★"),
                Err(e) => println!("      [B] 自造类型（补 FRAME_RATE） → ✗ {e}"),
            }
            let _ = t.SetInputType(0, None, 0);

            // ── C. 从可用类型取基准 ──
            match set_input_from_available(&t) {
                Ok(()) => println!("      [C] 取 MFT 可用类型为基准     → ✓ 成功   ★"),
                Err(e) => println!("      [C] 取 MFT 可用类型为基准     → ✗ {e}"),
            }
            let _ = t.SetInputType(0, None, 0);

            let _ = act.ShutdownObject();
        }
    }
    if !acts.is_null() {
        unsafe { CoTaskMemFree(Some(acts as _)) };
    }
}

/// 解锁 async MFT，返回是否 async。
unsafe fn unlock_async(t: &IMFTransform) -> bool {
    let Ok(attrs) = t.GetAttributes() else {
        return false;
    };
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_async {
        let _ = attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
    }
    is_async
}

fn pack(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

/// A/B：从零造 NV12 输入类型，可选是否补 FRAME_RATE。
unsafe fn set_input_from_scratch(t: &IMFTransform, with_fps: bool) -> Result<(), String> {
    let mt = MFCreateMediaType().map_err(|e| format!("MFCreateMediaType: {e}"))?;
    mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(|e| format!("major: {e}"))?;
    mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
        .map_err(|e| format!("subtype: {e}"))?;
    mt.SetUINT32(&MF_MT_INTERLACE_MODE, 2)
        .map_err(|e| format!("interlace: {e}"))?;
    mt.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H))
        .map_err(|e| format!("frame_size: {e}"))?;
    mt.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
        .map_err(|e| format!("par: {e}"))?;
    if with_fps {
        mt.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1))
            .map_err(|e| format!("frame_rate: {e}"))?;
    }
    t.SetInputType(0, &mt, 0)
        .map_err(|e| format!("SetInputType: {e}"))
}

/// C：从 MFT 的 GetInputAvailableType 取基准类型，改成目标分辨率后设回去。
unsafe fn set_input_from_available(t: &IMFTransform) -> Result<(), String> {
    // 找一个 NV12 的可用输入类型
    let mut chosen: Option<IMFMediaType> = None;
    for i in 0..16u32 {
        let Ok(mt) = t.GetInputAvailableType(0, i) else {
            break;
        };
        let is_nv12 = mt
            .GetGUID(&MF_MT_SUBTYPE)
            .map(|g| g == MFVideoFormat_NV12)
            .unwrap_or(false);
        if is_nv12 {
            // 找到第一个就够——它带着 MFT 自己要求的全套属性
            chosen = Some(mt);
            break;
        }
    }
    let Some(mt) = chosen else {
        return Err("没有 NV12 的可用输入类型".into());
    };
    // 只改分辨率/帧率，其余属性保留（这正是它比自造更稳的原因）
    mt.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H))
        .map_err(|e| format!("改 frame_size: {e}"))?;
    let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1));
    let _ = mt.SetUINT32(&MF_MT_INTERLACE_MODE, 2);
    t.SetInputType(0, &mt, 0)
        .map_err(|e| format!("SetInputType: {e}"))
}
