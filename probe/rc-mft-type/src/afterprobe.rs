//! afterprobe —— 验证「编码能力探测」是否破坏了**同一进程内**后续的 MFT 实例化
//! （2026-09-23）。独立工程，不进 pastePanda 依赖树。
//!
//! # 背景
//!
//! 本机被控推流时（`pp-dev.log` 12:19:01Z），`pick` 探针早已证明 NVIDIA NVENC
//! 可用（7ms/帧），但主仓库选型三台全败：
//! ```text
//! [RC] 编码能力探测：h264_gpu=true hevc=true 主屏刷新=60Hz 显示器=1
//! [RC] 编码器「Intel® Quick Sync Video H.264 Encoder MF」试编失败，尝试下一台
//! [RC] 编码器「NVIDIA H.264 Encoder MF」ActivateObject 失败：灾难性故障 (0x8000FFFF)
//! [RC] h264 不可用，调用方回退：h264 的 3 台硬编 MFT 全部试编失败
//! ```
//! 同机器、同驱动、同一时刻，`pick.exe`（独立进程）却能选中 NVIDIA。
//! 两点差异：① 主程序在选型**之前**跑了 `gpu.rs::hardware_mft_d3d11_aware`
//! （注释写「只查属性，不实例化」，实现却 `ActivateObject` + `ShutdownObject`）；
//! ② 探针从不 `ShutdownObject`。
//!
//! # 两个模式（**必须分两个进程跑**，同进程会互相污染）
//!
//! ```bash
//! cargo run --release --bin afterprobe              # T1 对照：直接实例化（= pick.exe）
//! cargo run --release --bin afterprobe -- --probe   # T2 复刻主程序：先探测再实例化
//! ```
//!
//! # 判据
//!
//! - T1 三台里 NVIDIA 应 ✓ —— 复刻 `pick.exe` 的成功，作为对照基线
//! - T2 里 NVIDIA ✗ → **根因确认**：探测阶段的 `ShutdownObject` 破坏了后续实例化
//! - 顺带打印「纯读 `IMFActivate::MF_SA_D3D11_AWARE`」能否读到值
//!   —— 能读到就是更好的修法（探测彻底不实例化，与注释一致）

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            println!("MFStartup 失败: {e}");
            return;
        }
    }
    let probe_first = std::env::args().any(|a| a == "--probe");
    println!("═══════════════════════════════════════════════════════════");
    if probe_first {
        println!(" afterprobe · T2：先「能力探测」→ 再实例化（复刻主程序）");
    } else {
        println!(" afterprobe · T1：干净进程直接实例化（复刻 pick.exe）");
    }
    println!("═══════════════════════════════════════════════════════════\n");

    unsafe {
        if probe_first {
            capability_probe();
        }
        activate_all("选型");
    }

    unsafe {
        let _ = MFShutdown();
    }
    println!("─── 探针结束 ───");
}

/// 枚举 H.264 硬编 MFT（照主仓库：不带输入约束，flags 逐级放宽）+ 去重。
unsafe fn enumerate_h264() -> Vec<IMFActivate> {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
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
        return Vec::new();
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
    order
}

/// 只对着故障点：`ActivateObject` 能不能起来（不试编、不 Shutdown）。
unsafe fn activate_all(label: &str) {
    let order = enumerate_h264();
    if order.is_empty() {
        println!("  [{label}] 枚举 0 台\n");
        return;
    }
    println!("  [{label}] 候选 {} 台：", order.len());
    for (i, a) in order.iter().enumerate() {
        let name = friendly_name(a);
        match a.ActivateObject::<IMFTransform>() {
            Ok(_t) => println!("    [{i}] {name} → ✓ ActivateObject 成功"),
            Err(e) => println!("    [{i}] {name} → ✗ ActivateObject 失败：{e}"),
        }
    }
    println!();
}

/// 原样复刻 `gpu.rs::hardware_mft_d3d11_aware`（2026-09-23 的实现）。
unsafe fn capability_probe() {
    println!("[探测] 复刻 gpu.rs::hardware_mft_d3d11_aware(H.264)\n");

    // ① 纯读 IMFActivate 属性、不实例化 —— 若读得到，就是更好的修法
    let order = enumerate_h264();
    println!("  ① 纯读 IMFActivate 的 MF_SA_D3D11_AWARE（不实例化）：");
    for (i, a) in order.iter().enumerate() {
        let v = match a.GetUINT32(&MF_SA_D3D11_AWARE) {
            Ok(v) => format!("{v}"),
            Err(e) => format!("读不到（{e}）"),
        };
        println!("    [{i}] {} → {v}", friendly_name(a));
    }
    println!();

    // ② 原样复刻：ActivateObject → 读属性 → ShutdownObject；aware 则 break
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
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
        println!("  ② 枚举 0 台，跳过\n");
        return;
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let mut aware = false;
    println!("  ② 复刻实现（ActivateObject + ShutdownObject）：");
    for a in slice.iter().flatten() {
        if let Ok(t) = a.ActivateObject::<IMFTransform>() {
            let hit = t
                .GetAttributes()
                .ok()
                .and_then(|at| at.GetUINT32(&MF_SA_D3D11_AWARE).ok())
                .map(|v| v != 0)
                .unwrap_or(false);
            if hit {
                aware = true;
            }
            println!("    {} → ✓ 实例化成功 · aware={hit}", friendly_name(a));
        } else {
            println!("    {} → ✗ 实例化失败", friendly_name(a));
        }
        let _ = a.ShutdownObject();
        if aware {
            break;
        }
    }
    for a in slice.iter().flatten() {
        let _ = a.ShutdownObject();
    }
    CoTaskMemFree(Some(acts as _));
    println!("  探测结果 aware={aware}\n");
}

unsafe fn friendly_name(act: &IMFActivate) -> String {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    match act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)) {
        Ok(()) => String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)]),
        Err(_) => "(无名)".into(),
    }
}
