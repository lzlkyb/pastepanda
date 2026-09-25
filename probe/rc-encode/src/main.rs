//! 远程控制编码链路探针（2026-09-21）。独立工程，不进 pastePanda 依赖树。
//!
//! # 验的是什么
//!
//! 真机日志（`pp-dev.log`）：
//! ```text
//! [RC] 编码能力探测：h264_gpu=false hevc=false 主屏刷新=100Hz 显示器=1
//! [RC] 编码跑不满档位间隔（EMA 1175/100ms），放大到 2x → 3x → 4x
//! ```
//! 单帧编码 1175ms → ≈0.85fps，与截图 1fps 吻合。机器是
//! i7-11800H + RTX 3050 Laptop + Intel UHD **双显卡**，而 RTX 3050 有 NVENC。
//! 所以 `h264_gpu=false` 是**可疑结论**，必须实测。
//!
//! # 教训（来自 M3/M6）
//!
//! 只扫静态符号就标 PASS 是自欺。这里的每一条结论都必须**真的调用过 API**。
//!
//! # 三个问题
//!
//! 1. **枚举**：本机有哪些 H.264 编码 MFT？各在哪个适配器（LUID）？是否 D3D11-aware？
//! 2. **能力**：MFT 能否 ActivateObject？是否 async？—— 这决定主仓库那句
//!    `henc.available()` 为什么返回 false。
//! 3. **拆解 1175ms**：同尺寸 BGRA 走 JPEG 编码要多久？
//!    若只要几十毫秒，则大头不在编码，而在抓屏或 BGRA→NV12 转换。

use anyhow::Result;
use windows::core::Interface;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

mod dup;
mod mfenc;

/// 采集尺寸：真机 `rc_capture_scope=virtual`（含副屏）是 2560 宽。
/// 探针用 1920x1080 作代表值，并额外报一组 2560x1440 供换算。
const FRAME_W: u32 = 1920;
const FRAME_H: u32 = 1080;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // 子命令：--mfenc = MF QvS 旋钮矩阵；--dup = DXGI 采集计时
    if args.iter().any(|a| a == "--mfenc") {
        return mfenc::run(&args);
    }
    if args.iter().any(|a| a == "--dup") {
        return dup::run(&args);
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
    }
    println!("═══════════════════════════════════════════════════════════");
    println!(" PastePanda 远程控制 · 编码链路探针");
    println!(" 帧尺寸 {FRAME_W}x{FRAME_H}（真机为 2560 宽虚拟屏）");
    println!("═══════════════════════════════════════════════════════════\n");

    probe_adapters();
    probe_encoders();
    probe_jpeg_cost();

    unsafe {
        let _ = MFShutdown();
    }
    println!("\n─── 探针结束 ───");
    Ok(())
}

/// 【1】DXGI 适配器清单 + LUID。双显卡机器最关键的信息。
fn probe_adapters() {
    println!("【1】DXGI 适配器清单（双显卡关键证据）");
    println!("───────────────────────────────────────────────────────────");
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(e) => {
                println!("  ✗ CreateDXGIFactory1 失败: {e}");
                return;
            }
        };
        let mut found = 0;
        for i in 0..6u32 {
            let Ok(ad) = factory.EnumAdapters1(i) else {
                break;
            };
            let Ok(desc) = ad.GetDesc1() else { continue };
            let name: String = desc
                .Description
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| char::from_u32(*c as u32).unwrap_or('?'))
                .collect();
            let luid =
                ((desc.AdapterLuid.HighPart as i64 as u64) << 32) | desc.AdapterLuid.LowPart as u64;
            let kind = if desc.Flags & 0x2 != 0 { "软件" } else { "硬件" };
            println!(
                "  [{i}] {name}\n      {kind}  LUID=0x{luid:016X}  Vendor=0x{:04X} Device=0x{:04X}",
                desc.VendorId, desc.DeviceId
            );
            found += 1;
        }
        if found == 0 {
            println!("  ✗ 未枚举到适配器");
        }
    }
    println!();
}

/// 【2】枚举全部 H.264 / HEVC 编码 MFT，报告 aware / LUID / async / 可用性。
fn probe_encoders() {
    println!("【2】H.264 / HEVC 编码 MFT 清单");
    println!("───────────────────────────────────────────────────────────");

    for (label, subtype) in [("H.264", MFVideoFormat_H264), ("HEVC", MFVideoFormat_HEVC)] {
        println!("\n  ── {label} ──");
        // 三种 flag 各枚举一次，看清「主仓库 HARDWARE 优先」在不同 flag 下的结果
        for (flag_name, flags) in [
            ("HARDWARE", MFT_ENUM_FLAG_HARDWARE),
            ("HARDWARE|SYNCMFT", MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT),
            ("ALL", MFT_ENUM_FLAG_ALL),
        ] {
            match enum_mfts(&subtype, flags) {
                Ok(list) if !list.is_empty() => {
                    println!("    [{flag_name}] {} 台", list.len());
                    for (i, e) in list.iter().enumerate() {
                        println!(
                            "      ({i}) aware={:<5} {:<22} LUID={:<18} async={:<5} {}",
                            e.aware, e.hw, e.luid, e.is_async, e.name
                        );
                    }
                }
                Ok(_) => println!("    [{flag_name}] 0 台"),
                Err(e) => println!("    [{flag_name}] 枚举失败: {e}"),
            }
        }
    }
    println!();
}

struct MftInfo {
    name: String,
    aware: bool,
    hw: String,
    luid: String,
    is_async: bool,
}

fn enum_mfts(subtype: &windows::core::GUID, flags: MFT_ENUM_FLAG) -> Result<Vec<MftInfo>> {
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
            flags,
            Some(&in_info),
            Some(&out_info),
            &mut acts,
            &mut count,
        );
    }
    if count == 0 || acts.is_null() {
        return Ok(Vec::new());
    }
    let slice = unsafe { std::slice::from_raw_parts(acts, count as usize) };
    let mut out = Vec::new();
    for act in slice.iter().flatten() {
        unsafe {
            let name = {
                // windows-0.58 的 GetString 要调用方给缓冲，自己封装一层
                let mut buf = [0u16; 256];
                let mut len = 0u32;
                match act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)) {
                    Ok(()) => String::from_utf16_lossy(
                        &buf[..(len as usize).min(buf.len()).saturating_sub(1)],
                    ),
                    Err(_) => "(无名)".to_string(),
                }
            };
            let aware = act
                .GetUINT32(&MF_SA_D3D11_AWARE)
                .map(|v| v != 0)
                .unwrap_or(false);
            let hw = act
                .GetUINT32(&MFT_ENUM_HARDWARE_VENDOR_ID_Attribute)
                .map(|v| format!("Vendor=0x{v:04X}"))
                .unwrap_or_else(|_| "非硬编".into());
            let luid = act
                .GetUINT64(&MFT_ENUM_ADAPTER_LUID)
                .map(|v| format!("0x{v:016X}"))
                .unwrap_or_else(|_| "无".into());
            // 只有 ActivateObject 成功才能查 async——这正是主仓库
            // `available()` 走的那一步
            let is_async = match act.ActivateObject::<IMFTransform>() {
                Ok(t) => t
                    .GetAttributes()
                    .ok()
                    .and_then(|a| a.GetUINT32(&MF_TRANSFORM_ASYNC).ok())
                    .map(|v| v != 0)
                    .unwrap_or(false),
                Err(_) => {
                    out.push(MftInfo {
                        name,
                        aware,
                        hw,
                        luid,
                        is_async: false,
                    });
                    let _ = act.ShutdownObject();
                    continue;
                }
            };
            out.push(MftInfo {
                name,
                aware,
                hw,
                luid,
                is_async,
            });
            let _ = act.ShutdownObject();
        }
    }
    unsafe {
        CoTaskMemFree(Some(acts as _));
    }
    Ok(out)
}

/// 【3】JPEG 编码耗时实测——用于拆解 1175ms 的构成。
fn probe_jpeg_cost() {
    println!("【3】JPEG 编码耗时实测（拆解 1175ms 的关键）");
    println!("───────────────────────────────────────────────────────────");

    for (w, h, tag) in [
        (FRAME_W, FRAME_H, "1920x1080"),
        (2560, 1440, "2560x1440（真机虚拟屏）"),
    ] {
        let Some(img) = build_test_image(w, h) else {
            println!("  ✗ {tag} 构造图像失败");
            continue;
        };
        println!("\n  [{tag}]");
        for quality in [40u8, 70, 85] {
            let mut times = Vec::new();
            let mut size = 0usize;
            for round in 0..4 {
                let t0 = std::time::Instant::now();
                let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024 * 1024);
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
                if enc.encode_image(&img).is_err() {
                    println!("    ✗ 质量 {quality} 编码失败");
                    break;
                }
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                if round > 0 {
                    times.push(ms);
                    size = buf.len();
                }
            }
            if times.is_empty() {
                continue;
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let med = times[times.len() / 2];
            println!(
                "    质量 {quality:>3}：{med:>8.2} ms/帧   {:>7.1} KB   理论上限 {:>5.1} fps",
                size as f64 / 1024.0,
                1000.0 / med
            );
        }
    }

    println!(
        "\n  说明：真机日志「EMA 1175ms」量的是**整个推流圈**\n\
         （抓屏 + BGRA→NV12 转换 + 编码 + 分片发送），上面只量 JPEG 编码本身。\n\
         两者的差值就是抓屏与色彩转换的开销——那是下一步要量的对象。"
    );
}

/// 造一张有真实纹理的测试图（纯色会让 JPEG 压缩过于容易，计时失真）。
fn build_test_image(w: u32, h: u32) -> Option<image::RgbaImage> {
    let mut buf = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            // 渐变 + 伪随机噪点，模拟桌面内容的复杂度
            let r = (x.wrapping_mul(7).wrapping_add(y.wrapping_mul(3)) % 256) as u8;
            let g = ((x / 3).wrapping_add(y / 5) % 256) as u8;
            let b = ((x ^ y) % 256) as u8;
            buf[i] = r;
            buf[i + 1] = g;
            buf[i + 2] = b;
            buf[i + 3] = 255;
        }
    }
    image::RgbaImage::from_raw(w, h, buf)
}

// 未使用的导入占位，避免 warning 噪音
#[allow(dead_code)]
fn _keep_types(_: IDXGIAdapter1) {}
