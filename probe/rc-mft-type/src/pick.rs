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
use windows::Win32::Graphics::Direct3D::{D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

const W: u32 = 1920;
const H: u32 = 1080;
const FPS: u32 = 30;
const H264_PROFILE_HIGH: u32 = 100;
const PROBE_W: u32 = 1920;
const PROBE_H: u32 = 1080;
const PROBE_FPS: u32 = 30;

/// `--luid`（2026-09-23）：复刻主仓库 `create_h264_mft` 的「LUID 优先」排序。
/// 探针的 `pick_mft` 从不读 `MFT_ENUM_ADAPTER_LUID`，这是它与主仓库最后的差异。
static USE_LUID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `--sw`（2026-09-23）：只枚举**软件** MFT（排除 HARDWARE）。
///
/// 要回答的问题：真机硬编 3 台全败 ⇒ 落 JPEG。但主仓库 `create_h264_mft` 的
/// 枚举循环拿到第一台硬编就 `break`，`MFT_ENUM_FLAG_ALL`（含微软自带软编）
/// **从来没被走到** —— 这条路径至今没有任何实测数据。
/// 若软编 MFT 能试编出包，「全败 ⇒ JPEG」就有一条纯代码的兜底路。
static SW_ONLY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    unsafe {
        // `--sta`（2026-09-23）：复刻「线程已被 STA 初始化」的情形——此时
        // `CoInitializeEx(MTA)` 返回 RPC_E_CHANGED_MODE 且**不改变** apartment，
        // 而 async 硬件 MFT 在 STA 上可能直接 ActivateObject 失败（0x8000FFFF）。
        if args.iter().any(|a| a == "--sta") {
            println!("  ⚠️ COM apartment：STA（COINIT_APARTMENTTHREADED）");
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        } else {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        // `--badver`（2026-09-24）：复刻主程序 `mf.rs:39` 的
        // `MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL)` —— 传的是 **2**，
        // 而不是文档要求的 **MF_VERSION = 131184 = (2<<16)|112**。
        //
        // 这是「主程序 P0（run() 第一条语句）就失败 / 探针成功」在**进程入口**
        // 就已成立的**唯一已知代码差异**（P0 时 Tauri、webview、D3D 设备、
        // 抓屏会话全部尚不存在）。若本开关能让探针也失败 ⇒ 根因锁定，一行可修。
        let ver = if args.iter().any(|a| a == "--badver") {
            println!(
                "  ⚠️ MFStartup 版本参数 = MF_SDK_VERSION ({MF_SDK_VERSION})，复刻主程序\n"
            );
            MF_SDK_VERSION
        } else {
            MF_VERSION
        };
        if let Err(e) = MFStartup(ver, MFSTARTUP_FULL) {
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
        // `--probe-first`（2026-09-23）：复刻主仓库「先跑 gpu.rs 能力探测、再选型」
        // 的顺序，用来判定能力探测会不会污染同进程内后续的 MFT 实例化。
        if args.iter().any(|a| a == "--probe-both") {
            println!("  模式：复刻 caps() 的两次探测（H.264 + HEVC）→ 再跑完整选型\n");
            gpu_like_probe(&MFVideoFormat_H264);
            gpu_like_probe(&MFVideoFormat_HEVC);
        } else if args.iter().any(|a| a == "--probe-first") {
            println!("  模式：先跑 gpu.rs 能力探测（仅 H.264）→ 再跑完整选型\n");
            gpu_like_probe(&MFVideoFormat_H264);
        }
        // `--preload <a.dll,b.dll,…>`（2026-09-23）：把**主进程特有**的第三方 DLL
        // 先装进这个干净进程，再跑选型。
        //
        // 背景：真机「主程序 ✗ / 探针 ✓」已排除公寓、时序、flags、版本、启动方式，
        // 主程序在 `run()` 最早期（Tauri 都没构建）就已失败 ⇒ 只剩「进程内装了什么」
        // 这一个变量。而它没法靠外部观察证伪——只能把候选 DLL 搬进干净进程做对照，
        // 这是唯一能把它变成因果结论的手段。
        if let Some(i) = args.iter().position(|a| a == "--preload") {
            if let Some(list) = args.get(i + 1) {
                println!("  模式：预加载 {list}");
                for p in list.split(',') {
                    let p = p.trim();
                    let w: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
                    match windows::Win32::System::LibraryLoader::LoadLibraryW(
                        windows::core::PCWSTR(w.as_ptr()),
                    ) {
                        Ok(h) => println!("    ✓ {p} (hModule={:?})", h.0),
                        Err(e) => println!("    ✗ {p} → {:#010X}", e.code().0 as u32),
                    }
                }
                println!();
            }
        }
        if args.iter().any(|a| a == "--luid") {
            println!("  模式：复刻主仓库 LUID 优先排序\n");
            USE_LUID.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        // `--sw`（2026-09-23）：只枚举软件 MFT，验证「硬编全败」之后还有没有兜底。
        if args.iter().any(|a| a == "--sw") {
            println!("  模式：只枚举软件 MFT（排除 HARDWARE）\n");
            SW_ONLY.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        // `--gpu`（2026-09-23，B 方案）：给每台硬件 MFT 绑 D3D11 device manager
        // + 用 GPU 纹理喂帧，回答「QSV 是不是被错误的喂帧方式误判成不可用」。
        // `--d3d11`（2026-09-24）：先建 D3D11 device + DuplicateOutput（复刻主程序
        // `dxgi.rs:478` 的顺序）再 ActivateObject，验证「进程内已有 D3D 设备」
        // 是不是 NVENC 唯一激活失败的根因。加 `--no-dup` 只建设备、不建复制会话。
        if args.iter().any(|a| a == "--d3d11") {
            let with_dup = !args.iter().any(|a| a == "--no-dup");
            d3d11_first_mode(&MFVideoFormat_H264, with_dup);
        } else if args.iter().any(|a| a == "--gpu") {
            gpu_mode(&MFVideoFormat_H264);
        } else if args.iter().any(|a| a == "--enum2") {
            enum2_mode(&MFVideoFormat_H264);
        } else if args.len() >= 3 && args[1] == "--bench" {
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
    let flag_sets: [MFT_ENUM_FLAG; 3] = if SW_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
        // `--sw`：微软软编 MFT 是**同步** MFT，用 SYNCMFT 起手；ALL 仅作最后兜底。
        [
            MFT_ENUM_FLAG_SYNCMFT,
            MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT,
            MFT_ENUM_FLAG_ALL,
        ]
    } else {
        [
            MFT_ENUM_FLAG_HARDWARE,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT,
            MFT_ENUM_FLAG_ALL,
        ]
    };
    for flags in flag_sets {
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
    // `--luid`：复刻主仓库 `create_h264_mft` 的 LUID 优先排序。取第一台的 LUID 当目标，
    // 正好复刻「D3D11 设备建在 Intel iGPU 上 → Intel 排最前」的真机情形。
    if USE_LUID.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(want) = slice
            .iter()
            .flatten()
            .find_map(|a| a.GetUINT64(&MFT_ENUM_ADAPTER_LUID).ok())
        {
            println!("    [LUID] 目标 = {want:#x}（取第一台的）");
            for a in slice.iter().flatten() {
                if a.GetUINT64(&MFT_ENUM_ADAPTER_LUID)
                    .map(|v| v == want)
                    .unwrap_or(false)
                {
                    println!("    [LUID] {} 命中", friendly_name(a));
                    order.push(a.clone());
                }
            }
            if order.is_empty() {
                println!("    [LUID] 无命中，退回枚举序");
            }
        }
    }
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

/// 复刻主仓库 `probe_encodable`（2026-09-23 加失败点打印：`--sw` 下软编也
/// 试编失败，但布尔返回值把「哪一步失败」吞掉了 —— 6 个 `return false`
/// 长得一模一样，没有原因就无从下手）。
unsafe fn probe_encodable(t: &IMFTransform, is_h264: bool) -> bool {
    let Ok(attrs) = t.GetAttributes() else {
        println!("      · 失败点：GetAttributes");
        return false;
    };
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    println!("      · MF_TRANSFORM_ASYNC = {is_async}");
    if is_async && attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).is_err() {
        println!("      · 失败点：MF_TRANSFORM_ASYNC_UNLOCK 设置被拒");
        return false;
    }
    let Ok(out_type) = create_type(if is_h264 { &MFVideoFormat_H264 } else { &MFVideoFormat_HEVC }, PROBE_W, PROBE_H, PROBE_FPS, true) else {
        println!("      · 失败点：造输出媒体类型");
        return false;
    };
    if let Err(e) = t.SetOutputType(0, &out_type, 0) {
        println!("      · 失败点：SetOutputType → {e}");
        return false;
    }
    let Ok(in_type) = create_type(&MFVideoFormat_NV12, PROBE_W, PROBE_H, PROBE_FPS, false) else {
        println!("      · 失败点：造输入媒体类型 NV12");
        return false;
    };
    if let Err(e) = t.SetInputType(0, &in_type, 0) {
        println!("      · 失败点：SetInputType → {e}");
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
    // 2026-09-23（`--sw`）：抄主仓库 `open_inner` 的低延迟套件，量「软编在低延迟
    // 配置下初始延迟能降到几帧」。探针原先不设任何 ICodecAPI → 第 18 帧才出包
    // （@30fps ≈ 567ms，远程控制不可接受）。低延迟键能否生效，是「硬编全败时
    // 兜底到软编」这条路成不成立的最后一环。
    if SW_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
        match t.cast::<ICodecAPI>() {
            Ok(api) => {
                for (key, val, what) in [
                    (&CODECAPI_AVLowLatencyMode, 1u32, "AVLowLatencyMode=1"),
                    (&CODECAPI_AVEncMPVDefaultBPictureCount, 0, "BPictureCount=0"),
                    (&CODECAPI_AVEncVideoMaxNumRefFrame, 1, "MaxNumRefFrame=1"),
                    (&CODECAPI_AVEncMPVGOPSize, PROBE_FPS, "GoPSize=30"),
                ] {
                    let v = windows::core::VARIANT::from(val);
                    match api.SetValue(key, &v) {
                        Ok(()) => println!("        · ICodecAPI {what} ✓"),
                        Err(e) => println!("        · ICodecAPI {what} ✗ {e}"),
                    }
                }
            }
            Err(_) => println!("        · 软编 MFT 未暴露 ICodecAPI"),
        }
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    let need = (PROBE_W * PROBE_H * 3 / 2) as usize;
    let nv12 = synth_neutral(PROBE_W, PROBE_H);
    let events: Option<IMFMediaEventGenerator> = if is_async { t.cast().ok() } else { None };
    let mut got = 0usize;
    // 2026-09-23（`--sw`）：软编 MFT 默认会缓冲（GOP / B 帧），喂 2 帧很可能一直
    // 停在 NEED_MORE_INPUT —— 那不是「不能用」，只是「还没喂够」。喂到 30 帧再判。
    for idx in 0..30u64 {
        match feed(t, events.as_ref(), &nv12, idx, need, PROBE_FPS) {
            Ok(n) => {
                if n > 0 {
                    println!("      · 第 {} 帧出包 {n} 个", idx + 1);
                }
                got += n;
            }
            Err(()) => {
                println!("      · 第 {} 帧喂帧/出包报错（同步路径）", idx + 1);
                break;
            }
        }
        if got > 0 && !SW_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
    }
    if got == 0 {
        println!("      · 30 帧喂完仍无输出（类型协商全通过）");
    } else if SW_ONLY.load(std::sync::atomic::Ordering::Relaxed) {
        println!("      · 喂满 30 帧累计出包 {got} 个（量初始延迟 + 是否 1:1 稳定）");
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
            // 🔴 2026-09-23（`--sw`）：同步 MFT（微软软编）**要求调用方提供输出
            // sample**（`GetOutputStreamInfo` 不含 `MFT_OUTPUT_STREAM_PROVIDES_SAMPLES`），
            // 而硬编 async MFT 自己分配。原同步分支把 `pSample` 留空 ⇒ `ProcessOutput`
            // 恒失败 ⇒ 输出堆积 ⇒ 第 19 帧起 `ProcessInput` 报 `MF_E_NOTACCEPTING`。
            let osi = t.GetOutputStreamInfo(0).ok();
            let need_sample = osi
                .as_ref()
                .map(|i| (i.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) == 0)
                .unwrap_or(false);
            let cb = osi.as_ref().map(|i| i.cbSize).unwrap_or(0);
            println!("        · 输出流 cbSize={cb} · 需调用方提供 sample={need_sample}");
            if let Err(e) = t.ProcessInput(0, &sample, 0) {
                println!("        · ProcessInput 失败：{e}");
                return Err(());
            }
            loop {
                let mut outs = [MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    ..Default::default()
                }];
                if need_sample {
                    if let (Ok(buf), Ok(s)) = (MFCreateMemoryBuffer(cb.max(1)), MFCreateSample()) {
                        let _ = s.AddBuffer(&buf);
                        *outs[0].pSample = Some(s);
                    }
                }
                let mut status = 0u32;
                match t.ProcessOutput(0, &mut outs, &mut status) {
                    Ok(()) => {
                        if outs[0].pSample.is_some() {
                            got += 1;
                        } else {
                            break;
                        }
                    }
                    Err(e) => {
                        if e.code() != MF_E_TRANSFORM_NEED_MORE_INPUT {
                            println!("        · ProcessOutput → {e} (status={status:#X})");
                        }
                        break;
                    }
                }
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

/// 同 [`drain`]，但**保留错误码**（QSV 首帧失败的原因必须看得见，
/// `Err(())` 会把 `MF_E_TRANSFORM_STREAM_CHANGE` 与真正的故障混成一个样）。
unsafe fn drain_hr(t: &IMFTransform) -> Result<bool, windows::core::Error> {
    let mut outs = [MFT_OUTPUT_DATA_BUFFER {
        dwStreamID: 0,
        ..Default::default()
    }];
    let mut status = 0u32;
    match t.ProcessOutput(0, &mut outs, &mut status) {
        Ok(()) => Ok(outs[0].pSample.is_some()),
        Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(false),
        Err(e) => Err(e),
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

/// 复刻主仓库 `gpu.rs::hardware_mft_d3d11_aware(H.264)`（2026-09-23 的实现）：
/// 枚举 → 逐台 `ActivateObject` → 读 `MF_SA_D3D11_AWARE` → `ShutdownObject`；aware 则 break。
/// 它**自己独立枚举**一次，与随后的选型不是同一批 `IMFActivate`。
unsafe fn gpu_like_probe(subtype: &windows::core::GUID) {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *subtype,
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
        println!("  [探测] 枚举 0 台\n");
        return;
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let mut aware = false;
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
            println!("  [探测] {} → 实例化成功 · aware={hit}", friendly_name(a));
        } else {
            println!("  [探测] {} → ✗ 实例化失败", friendly_name(a));
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
    println!("  [探测] aware={aware}\n");
}

unsafe fn friendly_name(act: &IMFActivate) -> String {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    match act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)) {
        Ok(()) => String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)]),
        Err(_) => "(无名)".into(),
    }
}

// ══════════════ `--gpu`：D3D11 device manager + 纹理喂帧（B 方案验证） ══════════════
//
// 要回答的问题（2026-09-23）：
//   硬编 3 台里 Intel QSV 恒「ActivateObject 成功但首帧挂死」⇒ 被跳过 ⇒
//   本机唯一可用硬编只剩 NVIDIA ⇒ 而 NVENC 在「主显示器不接在 NVIDIA 适配器上」
//   的拓扑下激活恒失败（0x8000FFFF）⇒ 全败 ⇒ 落 JPEG。
//
//   社区判据（Roman Ryltsov / RustDesk / MS 文档）：
//   ① MFT 实例本身**不绑 GPU**，要靠 `MFT_MESSAGE_SET_D3D_MANAGER`
//      告诉它用哪块（参数里包着 D3D 设备，是 GPU 特定的）；
//   ② 「Intel MFT 喂首帧后 MEError、之后永不输出」的已知根因是
//      **建了多个 ID3D11Device** 或**喂帧方式不对**（系统内存 NV12）；
//      正确用法是同一个 device + GPU 纹理喂帧。
//
//   而主仓库 `probe_encodable` 与探针的试编**都在用系统内存 NV12** ——
//   等于从来没执行过「正确的 QSV 用法」。那么「QSV 不可用」这个判定本身就不成立。
//   本模式把判定重做一遍：绑 device manager + 纹理喂帧。
//
// 判据：QSV 能出包 ⇒ B 成立（纯代码，零注册表）；仍不出包 ⇒ 退回 A（写 GPU 首选项）。

unsafe fn gpu_mode(out_subtype: &windows::core::GUID) {
    println!("  模式：D3D11 device manager（MFT_MESSAGE_SET_D3D_MANAGER）+ GPU 纹理喂帧");
    println!("        对每台硬件 MFT 按它声明的 adapter LUID 建 device，绑管理器后喂纹理\n");
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
        println!("  ✗ 枚举 0 台硬件 MFT");
        return;
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let adapters = list_adapters();
    let mut ok_any = false;
    for (i, act) in slice.iter().flatten().enumerate() {
        let name = friendly_name(act);
        println!("\n  ── [{i}] {name} ──");
        // ⚠️ 2026-09-23 实测：`MFT_ENUM_ADAPTER_LUID` 在本机**3 台全为空**，
        // 而 DXGI 枚举序第一位是 **NVIDIA**、接显示器的 Intel 在第二位。
        // 若照「无 LUID 就取第一块」的写法，会给 QSV 绑上 NVIDIA 的 device
        // ⇒ `MFT_MESSAGE_SET_D3D_MANAGER` 直接 `E_INVALIDARG (0x80070057)`。
        // 改为**逐适配器尝试**：哪个能绑上且能出包就用哪个（MFT 自己会校验兼容性）。
        let want = act
            .GetUINT64(&MFT_ENUM_ADAPTER_LUID)
            .ok()
            .filter(|v| *v != 0);
        println!(
            "    · MFT_ENUM_ADAPTER_LUID = {}",
            match want {
                Some(l) => format!("{l:#018X}"),
                None => "（无，逐适配器探测）".into(),
            }
        );
        let mut order: Vec<usize> = (0..adapters.len()).collect();
        if let Some(w) = want {
            order.sort_by_key(|&k| if adapters[k].2 == w { 0 } else { 1 });
        }
        let mut settled = false;
        for k in order {
            let (ad, nm, luid) = &adapters[k];
            println!("    ▸ 尝试适配器「{nm}」luid={luid:#018X}");
            match gpu_try_on(act, out_subtype, ad, nm) {
                Ok(msg) => {
                    println!("      {msg}");
                    ok_any = true;
                    settled = true;
                    break;
                }
                Err(e) => println!("      ✗ {e}"),
            }
            // 换适配器必须用全新实例（旧实例已绑过 device manager，不能复用）
            let _ = act.ShutdownObject();
        }
        if !settled {
            println!("    ✗ 所有适配器均不可用");
        }
        let _ = act.ShutdownObject();
    }
    for a in slice.iter().flatten() {
        let _ = a.ShutdownObject();
    }
    CoTaskMemFree(Some(acts as _));
    println!(
        "\n  ▸ B 方案判定：{}",
        if ok_any {
            "✓ 至少一台在 GPU 路径下可出包 —— B 成立（无需写注册表）"
        } else {
            "✗ GPU 路径下仍无一台出包 —— 退回 A（写 GPU 首选项）"
        }
    );
}

/// 单台 MFT × 单个适配器：建 device → 绑 manager → 协商类型 → 喂 30 帧纹理。
unsafe fn gpu_try_on(
    act: &IMFActivate,
    out_subtype: &windows::core::GUID,
    adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter,
    dev_name: &str,
) -> Result<String, String> {
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::*;

    let t: IMFTransform = act
        .ActivateObject()
        .map_err(|e| format!("ActivateObject 失败：{e}"))?;
    let attrs = t.GetAttributes().map_err(|e| format!("GetAttributes：{e}"))?;
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_async {
        attrs
            .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
            .map_err(|e| format!("ASYNC_UNLOCK：{e}"))?;
    }

    let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut dev: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    D3D11CreateDevice(
        Some(adapter),
        D3D_DRIVER_TYPE_UNKNOWN,
        None,
        D3D11_CREATE_DEVICE_FLAG(
            D3D11_CREATE_DEVICE_BGRA_SUPPORT.0 | D3D11_CREATE_DEVICE_VIDEO_SUPPORT.0,
        ),
        Some(&levels),
        D3D11_SDK_VERSION,
        Some(&mut dev),
        None,
        Some(&mut ctx),
    )
    .map_err(|e| format!("D3D11CreateDevice（{dev_name}）：{e}"))?;
    let dev = dev.ok_or("D3D11 设备为空")?;
    let ctx = ctx.ok_or("D3D11 上下文为空")?;

    // 必须在 SetType 之前绑（MFT 以 D3D11 模式协商分配器）
    let mut token = 0u32;
    let mut mgr: Option<IMFDXGIDeviceManager> = None;
    MFCreateDXGIDeviceManager(&mut token, &mut mgr).map_err(|e| format!("DXGIDeviceManager：{e}"))?;
    let mgr = mgr.ok_or("DXGIDeviceManager 创建为空")?;
    mgr.ResetDevice(&dev, token)
        .map_err(|e| format!("ResetDevice：{e}"))?;
    let unk: windows::core::IUnknown = mgr.cast().map_err(|e| format!("cast：{e}"))?;
    t.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, unk.as_raw() as usize)
        .map_err(|e| format!("SET_D3D_MANAGER：{e}"))?;

    // 先输出后输入（硬编 async 在设输出类型前 GetInputAvailableType 返回空）
    let mut out_ok = false;
    if let Ok(avail) = t.GetOutputAvailableType(0, 0) {
        let _ = avail.SetUINT32(&MF_MT_AVG_BITRATE, 8_000_000);
        let _ = avail.SetUINT64(&MF_MT_FRAME_SIZE, pack(PROBE_W, PROBE_H));
        let _ = avail.SetUINT64(&MF_MT_FRAME_RATE, pack(PROBE_FPS, 1));
        out_ok = t.SetOutputType(0, &avail, 0).is_ok();
    }
    if !out_ok {
        let ot = create_type(out_subtype, PROBE_W, PROBE_H, PROBE_FPS, true)?;
        t.SetOutputType(0, &ot, 0)
            .map_err(|e| format!("SetOutputType：{e}"))?;
    }
    let it = create_type(&MFVideoFormat_NV12, PROBE_W, PROBE_H, PROBE_FPS, false)?;
    t.SetInputType(0, &it, 0)
        .map_err(|e| format!("SetInputType：{e}"))?;
    for _ in 0..2 {
        let Ok(mt) = t.GetOutputAvailableType(0, 0) else {
            break;
        };
        if t.SetOutputType(0, &mt, 0).is_ok() {
            break;
        }
    }
    println!("    · 类型协商 ✓");

    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    let tex = make_nv12_texture(&dev, &ctx, PROBE_W, PROBE_H)?;
    println!("    · NV12 纹理 ✓（{PROBE_W}x{PROBE_H}）");

    let eg: Option<IMFMediaEventGenerator> = if is_async { t.cast().ok() } else { None };
    let mut got = 0usize;
    let mut first_pkt: Option<usize> = None;
    let mut last_err = String::new();
    for idx in 0..30u64 {
        match feed_dxgi(&t, eg.as_ref(), &tex, idx, PROBE_FPS) {
            Ok(n) => {
                if n > 0 && first_pkt.is_none() {
                    first_pkt = Some(idx as usize + 1);
                    println!("      · 第 {} 帧出包 {n} 个", idx + 1);
                }
                got += n;
            }
            Err(e) => {
                println!("      · 第 {} 帧失败：{e}", idx + 1);
                last_err = e;
                break;
            }
        }
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    if got > 0 {
        Ok(format!(
            "✓ 通过：SET_D3D_MANAGER ✓ · 首包第 {} 帧 · 30 帧累计 {got} 包",
            first_pkt.unwrap_or(0)
        ))
    } else if last_err.is_empty() {
        Err("30 帧纹理喂完仍无输出（无报错）".into())
    } else {
        Err(format!("无输出 · 最后错误：{last_err}"))
    }
}

/// 枚举 DXGI 适配器（句柄 + 名称 + LUID）。
/// ⚠️ DXGI 的枚举序**不等于**「谁在驱动显示器」：本机第一位是 NVIDIA、
/// 第二位才是接了 1920×1080 主屏的 Intel。
// ══════════ `--d3d11`：复刻主程序「先建 D3D device 再激活 MFT」的顺序 ══════════
//
// 要回答的问题（2026-09-24）：
//   主程序 `PastePanda.exe` 在**无 GPU 偏好**时 NVENC 激活恒败 `0x8000FFFF`；
//   而同机同时段的 `pick.exe`（本探针）与 `ffmpeg.exe` 在同一适配器状态下**成功**。
//   逐一排除后剩下的差异只剩**进程内状态** —— 而两者最显著的状态差异是：
//
//     主程序：`dxgi.rs:478` 先在【默认适配器】`D3D11CreateDevice(None, HARDWARE)`
//             并 `DuplicateOutput` 建立抓屏会话，**之后**才 `ActivateObject`。
//     探针  ：`ActivateObject` 在前、建 device 在后（见 `gpu_try_on`），
//             或压根不建 device（默认 `pick` / `--enum2`）。
//
// 判据（三分对照，单变量）：
//   ① 不建 device  → 已知 ✓（默认模式）
//   ② 只建 device  → ？
//   ③ device + DuplicateOutput（= 主程序真实状态）→ ？
//   ③ ✗ 而 ① ✓ ⇒ **根因锁定为「进程内已存在 D3D11 设备/抓屏会话」**，纯代码可修。
//   ③ ✓         ⇒ 主程序的失败另有原因，需回到时间线采样（P0-P3）。
//
// `--no-dup`：只做 ②，把「设备存在」与「复制会话活着」两个变量分开。
unsafe fn d3d11_first_mode(out_subtype: &windows::core::GUID, with_dup: bool) {
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::*;

    println!(
        "  模式：复刻主程序顺序 —— 先在【默认适配器】建 D3D11 device{}，再 ActivateObject\n",
        if with_dup { " + DuplicateOutput" } else { "（不建复制会话）" }
    );

    // ── 步骤 1：建 D3D11 device。逐字复刻 `dxgi.rs:478`（None = 默认适配器）──
    let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut dev: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    match D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        None,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        Some(&levels),
        D3D11_SDK_VERSION,
        Some(&mut dev),
        None,
        Some(&mut ctx),
    ) {
        Ok(()) => println!("  ✓ 步骤1 D3D11CreateDevice(默认适配器) 成功"),
        Err(e) => {
            println!("  ✗ 步骤1 失败：{e}");
            return;
        }
    }
    let Some(dev) = dev else {
        println!("  ✗ device 为空");
        return;
    };

    // 这块 device 落在哪 —— 直接回答「主程序的默认适配器到底是哪一块」
    let mut dup_keep: Vec<IDXGIOutputDuplication> = Vec::new();
    if let Ok(dxgi_dev) = dev.cast::<IDXGIDevice>() {
        if let Ok(ad) = dxgi_dev.GetAdapter() {
            if let Ok(desc) = ad.GetDesc() {
                let nm: String = String::from_utf16_lossy(
                    &desc
                        .Description
                        .iter()
                        .take_while(|c| **c != 0)
                        .copied()
                        .collect::<Vec<u16>>(),
                );
                let l = ((desc.AdapterLuid.HighPart as i64 as u64) << 32)
                    | desc.AdapterLuid.LowPart as u64;
                println!("  ▸ 该 device 落在适配器「{nm}」luid={l:#018X}");
            }
            if with_dup {
                for i in 0..8u32 {
                    let Ok(out) = ad.EnumOutputs(i) else { break };
                    let Ok(out1) = out.cast::<IDXGIOutput1>() else {
                        continue;
                    };
                    match out1.DuplicateOutput(&dev) {
                        // ⚠️ 必须**留住** dup 对象：drop 掉等于关掉复制会话，
                        // 那这一步就没复刻到主程序的真实状态（DxgiPool 全程持有）。
                        Ok(dup) => {
                            println!("  ✓ 步骤2 DuplicateOutput[{i}] 成功（复制会话已建立且保持）");
                            dup_keep.push(dup);
                        }
                        Err(e) => println!("  ✗ 步骤2 DuplicateOutput[{i}] 失败：{e}"),
                    }
                }
                if dup_keep.is_empty() {
                    println!("  · 没有输出被复制（继续，但状态与主程序不完全等同）");
                }
            } else {
                println!("  · --no-dup：跳过 DuplicateOutput");
            }
        }
    }

    // ── 步骤 3：此刻才激活硬件 MFT（主程序失败的那一步）──
    println!("\n  ▸ 步骤3：在「已存在 D3D11 设备{}」的进程里逐台 ActivateObject",
        if dup_keep.is_empty() { "" } else { " + 活跃复制会话" });
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
        println!("  ✗ 枚举 0 台");
        return;
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let mut all_ok = true;
    for a in slice.iter().flatten() {
        let name = friendly_name(a);
        match a.ActivateObject::<IMFTransform>() {
            Ok(t) => {
                println!("    {name} ✓ 激活成功");
                let _ = t;
            }
            Err(e) => {
                all_ok = false;
                println!(
                    "    {name} ✗ ActivateObject 失败：{e}（{:#010X}）",
                    e.code().0 as u32
                );
            }
        }
        let _ = a.ShutdownObject();
    }
    CoTaskMemFree(Some(acts as _));
    println!(
        "\n  ▸ 判定：{}",
        if all_ok {
            "✓ 存在 D3D11 设备不阻止硬编激活 —— 主程序失败另有原因"
        } else {
            "✗ 复现了主程序的 ActivateObject 失败 —— 根因锁定为「进程内已有 D3D11 设备/抓屏会话」"
        }
    );
    drop(dup_keep);
}

unsafe fn list_adapters() -> Vec<(windows::Win32::Graphics::Dxgi::IDXGIAdapter, String, u64)> {
    use windows::Win32::Graphics::Dxgi::*;
    let mut out = Vec::new();
    let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
        println!("      · ✗ CreateDXGIFactory1 失败");
        return out;
    };
    let mut idx = 0u32;
    while let Ok(ad) = factory.EnumAdapters(idx) {
        if let Ok(desc) = ad.GetDesc() {
            let nm: String = String::from_utf16_lossy(
                &desc
                    .Description
                    .iter()
                    .take_while(|c| **c != 0)
                    .copied()
                    .collect::<Vec<u16>>(),
            );
            let l =
                ((desc.AdapterLuid.HighPart as i64 as u64) << 32) | desc.AdapterLuid.LowPart as u64;
            println!("      · DXGI[{idx}] {nm} · luid={l:#018X}");
            out.push((ad, nm, l));
        }
        idx += 1;
    }
    out
}

/// `--enum2`：用 `MFTEnum2` 按适配器 LUID 枚举硬件 MFT。
///
/// 动机（2026-09-23）：NVENC 的 `ActivateObject` 在「进程默认 GPU = iGPU」时恒败
/// `0x8000FFFF`（上一轮已用 `GpuPreference=1` 在 pick.exe 上逐字复刻）。
/// `MFTEnumEx` 是**全局**枚举，实例化时走进程默认适配器；`MFTEnum2` 能按
/// `MFT_ENUM_ADAPTER_LUID` **指定适配器**枚举 —— 若激活能成功，就是一条
/// 「纯代码、零注册表」的修法（主程序改用 MFTEnum2 按 dGPU LUID 枚举）。
unsafe fn enum2_mode(out_subtype: &windows::core::GUID) {
    println!("  模式：MFTEnum2 —— 按适配器 LUID 枚举硬件 MFT（对比 MFTEnumEx 的全局枚举）");
    println!("        目的：验证「指定适配器枚举」能否让 NVENC 激活成功（纯代码路）\n");
    let adapters = list_adapters();
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *out_subtype,
    };
    for (_, nm, luid) in &adapters {
        println!("\n  ── 适配器「{nm}」luid={luid:#018X} ──");
        let mut a: Option<IMFAttributes> = None;
        if MFCreateAttributes(&mut a, 2).is_err() {
            println!("    ✗ MFCreateAttributes");
            continue;
        }
        let a = match a {
            Some(x) => x,
            None => {
                println!("    ✗ 属性对象为空");
                continue;
            }
        };
        let _ = a.SetUINT64(&MFT_ENUM_ADAPTER_LUID, *luid);
        let mut count = 0u32;
        let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
        if let Err(e) = MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE,
            None,
            Some(&out_info),
            &a,
            &mut acts,
            &mut count,
        ) {
            println!("    ✗ MFTEnum2：{e}");
            continue;
        }
        if count == 0 || acts.is_null() {
            println!("    · 枚举 0 台");
            continue;
        }
        let slice = std::slice::from_raw_parts(acts, count as usize);
        for act in slice.iter().flatten() {
            let name = friendly_name(act);
            match act.ActivateObject::<IMFTransform>() {
                Ok(_t) => println!("    · {name} → ✓ ActivateObject 成功"),
                Err(e) => println!("    · {name} → ✗ ActivateObject 失败：{e}"),
            }
            let _ = act.ShutdownObject();
        }
        for act in slice.iter().flatten() {
            let _ = act.ShutdownObject();
        }
        CoTaskMemFree(Some(acts as _));
    }
    println!();
}

/// 建一张 NV12 纹理并填中性数据（编码器输入面）。
unsafe fn make_nv12_texture(
    dev: &ID3D11Device,
    ctx: &ID3D11DeviceContext,
    w: u32,
    h: u32,
) -> Result<ID3D11Texture2D, String> {
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    dev.CreateTexture2D(&desc, None, Some(&mut tex))
        .map_err(|e| format!("CreateTexture2D(NV12)：{e}"))?;
    let tex = tex.ok_or("纹理为空")?;
    // 填中性灰（Y=128 / UV=128，落在 16..235 安全区内）
    let nv12 = synth_neutral(w, h);
    ctx.UpdateSubresource(&tex, 0, None, nv12.as_ptr() as *const _, w, 0);
    println!("      · UpdateSubresource(NV12) 已调用（row_pitch={w}）");
    Ok(tex)
}

/// 用 GPU 纹理喂一帧（device manager 已绑），走与 MFT 匹配的协议。
unsafe fn feed_dxgi(
    t: &IMFTransform,
    eg: Option<&IMFMediaEventGenerator>,
    tex: &ID3D11Texture2D,
    idx: u64,
    fps: u32,
) -> Result<usize, String> {
    use windows::Win32::Media::MediaFoundation::MFCreateDXGISurfaceBuffer;

    let iid = <ID3D11Texture2D as Interface>::IID;
    let buf = MFCreateDXGISurfaceBuffer(&iid, tex, 0, false)
        .map_err(|e| format!("MFCreateDXGISurfaceBuffer：{e}"))?;
    let sample = MFCreateSample().map_err(|e| format!("MFCreateSample：{e}"))?;
    sample
        .AddBuffer(&buf)
        .map_err(|e| format!("AddBuffer：{e}"))?;
    let _ = sample.SetSampleTime((idx * 10_000_000 / fps.max(1) as u64) as i64);
    let _ = sample.SetSampleDuration((10_000_000 / fps.max(1) as u64) as i64);

    let mut got = 0usize;
    match eg {
        None => {
            let osi = t.GetOutputStreamInfo(0).ok();
            let need_sample = osi
                .as_ref()
                .map(|i| (i.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) == 0)
                .unwrap_or(false);
            let cb = osi.as_ref().map(|i| i.cbSize).unwrap_or(0);
            t.ProcessInput(0, &sample, 0)
                .map_err(|e| format!("ProcessInput：{e}"))?;
            loop {
                let mut outs = [MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    ..Default::default()
                }];
                if need_sample {
                    if let (Ok(b), Ok(s)) = (MFCreateMemoryBuffer(cb.max(1)), MFCreateSample()) {
                        let _ = s.AddBuffer(&b);
                        *outs[0].pSample = Some(s);
                    }
                }
                let mut status = 0u32;
                match t.ProcessOutput(0, &mut outs, &mut status) {
                    Ok(()) => {
                        if outs[0].pSample.is_some() {
                            got += 1;
                        } else {
                            break;
                        }
                    }
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                    Err(e) => return Err(format!("ProcessOutput：{e}")),
                }
            }
        }
        Some(eg) => {
            // ① 等 NeedInput（首帧给足时间）
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
            let mut need_input = false;
            while !need_input {
                if std::time::Instant::now() >= deadline {
                    return Err("等 METransformNeedInput 超时 2s".into());
                }
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            let st = ev.GetStatus().map(|h| h.0).unwrap_or(0);
                            return Err(format!("事件流 MEError（hr={st:#010X}）"));
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            need_input = true;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1))
                    }
                    Err(e) => return Err(format!("GetEvent：{e}")),
                }
            }
            // ② 喂
            t.ProcessInput(0, &sample, 0)
                .map_err(|e| format!("ProcessInput：{e}"))?;
            // ③ 收
            let out_deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(800);
            while std::time::Instant::now() < out_deadline {
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            let st = ev.GetStatus().map(|h| h.0).unwrap_or(0);
                            return Err(format!("MEError（hr={st:#010X}）"));
                        }
                        if ty == METransformHaveOutput.0 as u32 {
                            match drain_hr(t) {
                                Ok(true) => got += 1,
                                Ok(false) => {}
                                Err(e) => {
                                    if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                                        // 硬编（Intel 尤其）会在首帧才把 SPS/PPS 定稿并抛流变化。
                                        // 正确处置：按 MFT 自己给的可用类型重设一次再取包。
                                        println!("        · 流变化 {:#010X}，重设输出类型后重试",
                                            e.code().0 as u32);
                                        if let Ok(mt) = t.GetOutputAvailableType(0, 0) {
                                            let set = t.SetOutputType(0, &mt, 0).is_ok();
                                            println!("        · SetOutputType 重设 {}", if set { "✓" } else { "✗" });
                                        }
                                        match drain_hr(t) {
                                            Ok(true) => got += 1,
                                            Ok(false) => println!("        · 重设后仍无包"),
                                            Err(e2) => {
                                                return Err(format!("流变化自愈后仍失败：{e2}"))
                                            }
                                        }
                                    } else {
                                        return Err(format!("ProcessOutput：{e}"));
                                    }
                                }
                            }
                            break;
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            break;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1))
                    }
                    Err(e) => return Err(format!("GetEvent：{e}")),
                }
            }
        }
    }
    Ok(got)
}
