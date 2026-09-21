//! 硬编 MFT 的输入/输出类型全貌探针（2026-09-21）。独立工程。
//!
//! # 前一个探针的结论
//!
//! `rc-mft-type` 证明：自造 NV12 输入类型（补不补 FRAME_RATE 都一样）都被拒，
//! 且 `GetInputAvailableType` 遍历拿不到 **任何 NV12 输入类型**。
//! 而 `rc-encode` 证明硬编 MFT **确实存在**（Intel QSV + NVIDIA NVENC）。
//!
//! 矛盾点：MFT 存在，但 `MFTEnumEx(HARDWARE)` 要求 `guidSubtype=NV12` 的输入
//! 还能枚举出来，而它自己又不提供 NV12 输入类型？
//!
//! # 本探针要回答
//!
//! 1. 这些 MFT 通过 `GetInputAvailableType` 暴露的**全部**输入子类型是什么？
//!    （不预设 NV12，逐个打印）——若暴露的是 BGRA/RGB32，说明主仓库喂错了格式。
//! 2. 输出类型有哪些？
//! 3. 带 `MF_SA_D3D11_AWARE` 属性的 MFT 是否需要**先设输出类型**才能设输入类型？
//!    （MF 的经典约束：某些 MFT 要求先 SetOutputType）
//! 4. 用 `MFT_ENUM_FLAG_TRANSCODE_ONLY` 或同时要求输出类型时会怎样？

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
    println!(" 硬编 MFT 类型全貌探针");
    println!("═══════════════════════════════════════════════════════════\n");

    // 两个方向：宽松枚举（不带 subtype 约束）拿到全部 MFT
    for (label, subtype) in [("H.264", MFVideoFormat_H264), ("HEVC", MFVideoFormat_HEVC)] {
        println!("══ {label} ══════════════════════════════════════════════");
        dump_mfts(&subtype, &["NVIDIA", "Intel"]);
        println!();
    }

    unsafe {
        let _ = MFShutdown();
    }
    println!("─── 探针结束 ───");
}

fn dump_mfts(out_subtype: &GUID, keywords: &[&str]) {
    // 不带输入 subtype 约束——把所有能出这个输出格式的编码器都拿来
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
            None, // ← 关键：不约束输入格式
            Some(&out_info),
            &mut acts,
            &mut count,
        );
    }
    if count == 0 || acts.is_null() {
        println!("  枚举到 0 台（不带输入约束也一样）");
        return;
    }
    let slice = unsafe { std::slice::from_raw_parts(acts, count as usize) };
    let mut seen = std::collections::HashSet::new();
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
        if !keywords.iter().any(|k| name.contains(k)) {
            continue;
        }
        if !seen.insert(name.clone()) {
            continue;
        }
        println!("\n  ▸ {name}");
        unsafe {
            let t: IMFTransform = match act.ActivateObject() {
                Ok(t) => t,
                Err(e) => {
                    println!("      ✗ ActivateObject: {e}");
                    continue;
                }
            };
            let attrs = t.GetAttributes().ok();
            let is_async = attrs
                .as_ref()
                .and_then(|a| a.GetUINT32(&MF_TRANSFORM_ASYNC).ok())
                .map(|v| v != 0)
                .unwrap_or(false);
            if is_async {
                if let Some(a) = &attrs {
                    let _ = a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
                }
            }
            let aware = attrs
                .as_ref()
                .and_then(|a| a.GetUINT32(&MF_SA_D3D11_AWARE).ok())
                .map(|v| v != 0)
                .unwrap_or(false);
            println!("      async={is_async}  d3d11_aware={aware}");

            // 输入可用类型全览
            print!("      输入类型: ");
            let mut any = false;
            for i in 0..24u32 {
                let Ok(mt) = t.GetInputAvailableType(0, i) else {
                    break;
                };
                any = true;
                let st = mt.GetGUID(&MF_MT_SUBTYPE).map(gname).unwrap_or("?".into());
                print!("{st} ");
            }
            if !any {
                print!("(一个都没有)");
            }
            println!();

            // 输出可用类型全览
            print!("      输出类型: ");
            let mut any = false;
            for i in 0..24u32 {
                let Ok(mt) = t.GetOutputAvailableType(0, i) else {
                    break;
                };
                any = true;
                let st = mt.GetGUID(&MF_MT_SUBTYPE).map(gname).unwrap_or("?".into());
                print!("{st} ");
            }
            if !any {
                print!("(一个都没有)");
            }
            println!();

            // 输出类型里有没有 NV12？（有的 MFT 输入输出都是 NV12）
            // 逐个试：把输出子类型设为目标格式，看能否成功；再试输入
            test_output_then_input(&t, out_subtype);

            let _ = act.ShutdownObject();
        }
    }
    if !acts.is_null() {
        unsafe { CoTaskMemFree(Some(acts as _)) };
    }
}

/// MF 经典约束：部分 MFT 必须先 SetOutputType 才允许 SetInputType。
/// 逐个试可用的输出类型，设成功后立刻试 NV12 输入。
unsafe fn test_output_then_input(t: &IMFTransform, out_subtype: &GUID) {
    println!("      ── 先设输出→再设输入（MF 常见约束）──");
    let mut tried = 0;
    for i in 0..8u32 {
        let Ok(mt) = t.GetOutputAvailableType(0, i) else {
            break;
        };
        if mt.GetGUID(&MF_MT_SUBTYPE).map(|g| g != *out_subtype).unwrap_or(true) {
            continue;
        }
        if tried >= 2 {
            break;
        }
        tried += 1;
        // 补分辨率/帧率
        let _ = mt.SetUINT64(&MF_MT_FRAME_SIZE, ((W as u64) << 32) | H as u64);
        let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, 8_000_000);
        let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1);
        match t.SetOutputType(0, &mt, 0) {
            Ok(()) => {
                println!("        输出类型 #{i} 设置 ✓");
                // 立刻试 NV12 输入（补全属性）
                match set_nv12_input(t) {
                    Ok(()) => println!("          再设 NV12 输入 ✓ ✓ ✓  ← 正确修法！"),
                    Err(e) => println!("          再设 NV12 输入 ✗ {e}"),
                }
            }
            Err(e) => println!("        输出类型 #{i} 设置 ✗ {e}"),
        }
        let _ = t.SetOutputType(0, None, 0);
    }
    if tried == 0 {
        println!("        没有该输出格式的可用类型");
    }
}

unsafe fn set_nv12_input(t: &IMFTransform) -> Result<(), String> {
    let mt = MFCreateMediaType().map_err(|e| e.to_string())?;
    mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(|e| e.to_string())?;
    mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
        .map_err(|e| e.to_string())?;
    mt.SetUINT32(&MF_MT_INTERLACE_MODE, 2)
        .map_err(|e| e.to_string())?;
    mt.SetUINT64(&MF_MT_FRAME_SIZE, ((W as u64) << 32) | H as u64)
        .map_err(|e| e.to_string())?;
    mt.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, ((1u64) << 32) | 1)
        .map_err(|e| e.to_string())?;
    mt.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1)
        .map_err(|e| e.to_string())?;
    t.SetInputType(0, &mt, 0).map_err(|e| e.to_string())
}

fn gname(g: GUID) -> String {
    let known: [(GUID, &str); 8] = [
        (MFVideoFormat_NV12, "NV12"),
        (MFVideoFormat_YUY2, "YUY2"),
        (MFVideoFormat_ARGB32, "ARGB32"),
        (MFVideoFormat_RGB32, "RGB32"),
        (MFVideoFormat_H264, "H264"),
        (MFVideoFormat_HEVC, "HEVC"),
        (MFVideoFormat_H264_ES, "H264_ES"),
        (MFVideoFormat_MJPG, "MJPG"),
    ];
    for (k, n) in known {
        if k == g {
            return n.into();
        }
    }
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        g.data1, g.data2, g.data3, g.data4[0], g.data4[1],
        g.data4[2], g.data4[3], g.data4[4], g.data4[5], g.data4[6], g.data4[7]
    )
}
