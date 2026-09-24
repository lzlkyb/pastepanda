//! WIC（Windows Imaging Component）JPEG 编码器探针（2026-09-24）。
//!
//! # 为什么量它
//!
//! `probe/rc-encode`（main.rs）实测：同样一张 2560x1440 高熵图，
//! `image` crate（**纯 Rust、无 SIMD**）编 JPEG **196.78 ms/帧**（上限 5.1 fps），
//! 与真机「JPEG 兜底整圈 190ms/帧」几乎一致 ⇒ 瓶颈在**编码器实现**。
//! 同一张图 libjpeg-turbo 只要 14.52 ms（13.6×），WIC 内存流 20.91 ms（9.4×）。
//!
//! # 本文件要回答的两个落地问题
//!
//! 主项目要把 JPEG 编码换成 WIC，还差两件事没定：
//! 1. **像素格式**：`SetPixelFormat` 是 in/out —— 传进去你想要的，返回实际接受的。
//!    若 WIC 接受 `24bppRGB`，主项目就能**零转换**把 `to_rgb8()` 的结果直接喂进去；
//!    若只接受 BGR，就得先转一趟（2560x1440x3 ≈ 11MB，白花 10~20ms）。
//! 2. **质量参数**：现有代码用 `quality: u8`（1~100），WIC 走 `IPropertyBag2` 的
//!    `ImageQuality`（0.0~1.0 f32）。要确认这条路真能设进去（而不是被静默忽略）。
//!
//! 用法：
//! ```text
//! cargo run --release --bin wic             # 单格式耗时（默认 24bppBGR，高熵图）
//! cargo run --release --bin wic -- --formats # 4 种像素格式 × 耗时 + 质量梯度 + 落盘验色
//! ```
//!
//! # 口径
//!
//! 图形内容与 `main.rs::build_test_image` **逐像素相同**（只取 RGB，去掉 alpha）。
//! ⚠️ 产物经 `InitializeFromFilename` 走**文件流**（内存流要读回数据会碰上
//! `&[u8]` noalias 与 WIC 落写的别名问题），因此耗时含 ~1MB 磁盘写；
//! 各格式之间**同法可比**，与内存流口径差 1~2ms。

use std::time::Instant;

use anyhow::{anyhow, Result};
use windows::core::{GUID, HSTRING, PWSTR, VARIANT};
use windows::Win32::Foundation::GENERIC_WRITE;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::{VARENUM, VT_R4, VT_UI1};

const W: u32 = 2560;
const H: u32 = 1440;
const ROUNDS: usize = 4;

/// 生成高熵图案，按给定通道序摆放（与 `main.rs::build_test_image` 同值）。
fn synth(w: u32, h: u32, bpp: usize, ri: usize, gi: usize, bi: usize) -> Vec<u8> {
    let mut buf = vec![0u8; (w * h * bpp as u32) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * bpp as u32) as usize;
            let r = (x.wrapping_mul(7).wrapping_add(y.wrapping_mul(3)) % 256) as u8;
            let g = ((x / 3).wrapping_add(y / 5) % 256) as u8;
            let b = ((x ^ y) % 256) as u8;
            buf[i + ri] = r;
            buf[i + gi] = g;
            buf[i + bi] = b;
            if bpp == 4 {
                buf[i + 3] = 255;
            }
        }
    }
    buf
}

/// 三色条（左红 / 中绿 / 右蓝），用于验证通道有没有被 WIC 弄反。
fn stripes(w: u32, h: u32, bpp: usize, ri: usize, gi: usize, bi: usize) -> Vec<u8> {
    let mut buf = vec![0u8; (w * h * bpp as u32) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * bpp as u32) as usize;
            let (r, g, b) = match x * 3 / w {
                0 => (255u8, 0u8, 0u8),
                1 => (0, 255, 0),
                _ => (0, 0, 255),
            };
            buf[i + ri] = r;
            buf[i + gi] = g;
            buf[i + bi] = b;
            if bpp == 4 {
                buf[i + 3] = 255;
            }
        }
    }
    buf
}

/// 经 `IPropertyBag2` 写 `ImageQuality`（0.0~1.0）。
///
/// 🔴 属性必须是**在 `CreateNewFrame` 拿到的那个 bag 上写、且赶在 `Initialize` 之前**；
/// 写晚了会被静默忽略（产物大小不变 = 没生效，是唯一的判据）。
unsafe fn set_quality(props: &IPropertyBag2, q: f32) -> Result<()> {
    let name = HSTRING::from("ImageQuality");
    let pb = PROPBAG2 {
        pstrName: PWSTR(name.as_ptr() as *mut u16),
        vt: VARENUM(VT_R4.0),
        ..Default::default()
    };
    let var = VARIANT::from(q);
    props.Write(1, &pb, &var)?;
    Ok(())
}

/// 编一帧 JPEG 到 `path`，返回（耗时 ms, 文件字节数, SetPixelFormat 实际接受的格式）。
unsafe fn encode(
    factory: &IWICImagingFactory,
    data: &[u8],
    w: u32,
    h: u32,
    stride: u32,
    desired: GUID,
    quality: Option<f32>,
    path: &str,
) -> Result<(f64, usize, GUID)> {
    let stream = factory.CreateStream()?;
    stream.InitializeFromFilename(&HSTRING::from(path), GENERIC_WRITE.0)?;

    let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
    encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;

    // ⚠️ CreateNewFrame 是 IWICBitmapEncoder 的方法，不在 factory 上。
    let mut frame_out: Option<IWICBitmapFrameEncode> = None;
    let mut props: Option<IPropertyBag2> = None;
    encoder.CreateNewFrame(&mut frame_out, &mut props)?;
    let frame_enc = frame_out.ok_or_else(|| anyhow!("CreateNewFrame 未返回 frame"))?;

    if let (Some(q), Some(p)) = (quality, props.as_ref()) {
        set_quality(p, q)?;
    }
    frame_enc.Initialize(props.as_ref())?;
    frame_enc.SetSize(w, h)?;

    // SetPixelFormat 是 in/out：返回的是**实际接受**的格式，数据必须按它来组织。
    let mut fmt = desired;
    frame_enc.SetPixelFormat(&mut fmt)?;

    let t0 = Instant::now();
    frame_enc.WritePixels(h, stride, data)?;
    frame_enc.Commit()?;
    encoder.Commit()?;
    let ms = t0.elapsed().as_secs_f64() * 1000.0;

    let bytes = std::fs::metadata(path)?.len() as usize;
    Ok((ms, bytes, fmt))
}

/// 走 4 轮、丢第 1 轮预热取中位数；只在 `--formats` 模式用（要看落盘产物）。
unsafe fn bench(
    factory: &IWICImagingFactory,
    data: &[u8],
    w: u32,
    h: u32,
    stride: u32,
    desired: GUID,
    quality: Option<f32>,
    tag: &str,
) -> Result<(f64, usize, GUID)> {
    let path = format!("_out_{tag}.jpg");
    let mut times = Vec::new();
    let mut bytes = 0usize;
    let mut actual = desired;
    for i in 0..ROUNDS {
        let (ms, n, fmt) = encode(factory, data, w, h, stride, desired, quality, &path)?;
        bytes = n;
        actual = fmt;
        if i > 0 {
            times.push(ms);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Ok((times[times.len() / 2], bytes, actual))
}

fn guid_eq(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

/// 把 `SetPixelFormat` 回写的实际格式翻译成人话——只印「✗ 被改掉了」是没用的，
/// 必须知道它被改成了**哪一个**，否则不知道该按什么序组织数据。
fn guid_name(g: &GUID) -> &'static str {
    let known: [(&str, &GUID); 4] = [
        ("24bppBGR", &GUID_WICPixelFormat24bppBGR),
        ("24bppRGB", &GUID_WICPixelFormat24bppRGB),
        ("32bppBGRA", &GUID_WICPixelFormat32bppBGRA),
        ("32bppRGBA", &GUID_WICPixelFormat32bppRGBA),
    ];
    known
        .iter()
        .find(|(_, k)| guid_eq(k, g))
        .map(|(n, _)| *n)
        .unwrap_or("(未知 GUID)")
}

/// `--formats`：4 种像素格式的耗时 + SetPixelFormat 实际回值 + 质量梯度。
unsafe fn run_formats(factory: &IWICImagingFactory) -> Result<()> {
    // (标签, 目标格式, 每像素字节, R/G/B 的字节偏移)
    let cases: [(&str, GUID, usize, usize, usize, usize); 4] = [
        ("24bppBGR", GUID_WICPixelFormat24bppBGR, 3, 2, 1, 0),
        ("24bppRGB", GUID_WICPixelFormat24bppRGB, 3, 0, 1, 2),
        ("32bppBGRA", GUID_WICPixelFormat32bppBGRA, 4, 2, 1, 0),
        ("32bppRGBA", GUID_WICPixelFormat32bppRGBA, 4, 0, 1, 2),
    ];

    println!("【A】像素格式矩阵（高熵图 {W}x{H}，默认质量）");
    println!("───────────────────────────────────────────────────────────");
    for (tag, fmt, bpp, ri, gi, bi) in cases {
        let data = synth(W, H, bpp, ri, gi, bi);
        let stride = W * bpp as u32;
        let (ms, bytes, actual) = bench(factory, &data, W, H, stride, fmt, None, tag)?;
        let kept = guid_eq(&actual, &fmt);
        println!(
            "  {tag:<10} {ms:>7.2} ms  {:>8.1} KB  {:.1} fps   请求 {tag} → 实际 {} {}",
            bytes as f64 / 1024.0,
            1000.0 / ms,
            guid_name(&actual),
            if kept { "✓" } else { "✗ 被改！数据必须按实际格式组织" }
        );
    }
    println!(
        "  ⚠️ 各格式耗时差异主要来自**图内容**（不同通道序的字节序列本身就是不同的图），\n\
         \x20    不是格式本身的开销。判据只看「实际格式」那一列。"
    );

    println!("\n【B】质量参数是否真生效（24bppBGR，看产物大小随质量单调变化）");
    println!("───────────────────────────────────────────────────────────");
    let data = synth(W, H, 3, 2, 1, 0);
    let stride = W * 3;
    for q in [0.3f32, 0.6, 0.8, 0.95] {
        let tag = format!("q{:02}", (q * 100.0) as u32);
        let (ms, bytes, _) =
            bench(factory, &data, W, H, stride, GUID_WICPixelFormat24bppBGR, Some(q), &tag)?;
        println!("  ImageQuality {q:<4} {ms:>7.2} ms  {:>8.1} KB", bytes as f64 / 1024.0);
    }

    println!("\n【C】通道正确性落盘（三色条 → _stripe_*.jpg，左红/中绿/右蓝）");
    println!("───────────────────────────────────────────────────────────");
    for (tag, fmt, bpp, ri, gi, bi) in [
        ("bgr", GUID_WICPixelFormat24bppBGR, 3, 2, 1, 0),
        ("rgb", GUID_WICPixelFormat24bppRGB, 3, 0, 1, 2),
    ] {
        let data = stripes(192, 96, bpp, ri, gi, bi);
        let path = format!("_stripe_{tag}.jpg");
        encode(factory, &data, 192, 96, 192 * bpp as u32, fmt, Some(0.9), &path)?;
        println!("  {path}  已写出（用 PIL 读回验证：左应 R≈255/G,B≈0）");
    }

    println!("\n【D】自己写 RGB→BGR 转换的成本（WIC 只吃 BGR，这趟躲不掉就得算进总账）");
    println!("───────────────────────────────────────────────────────────");
    let rgb = synth(W, H, 3, 0, 1, 2);
    let mut times = Vec::new();
    for i in 0..ROUNDS {
        let mut buf = rgb.clone(); // clone 放在计时外
        let t0 = Instant::now();
        for px in buf.chunks_exact_mut(3) {
            px.swap(0, 2);
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        std::hint::black_box(&buf);
        if i > 0 {
            times.push(ms);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "  逐像素 swap（chunks_exact_mut）：{:.2} ms / 帧（{:.1} MB 数据）",
        times[times.len() / 2],
        (W as f64 * H as f64 * 3.0) / 1024.0 / 1024.0
    );
    println!("  ⇒ 总成本 ≈ WIC 编码 + 这趟转换；若换 WIC 的 IWICFormatConverter 代劳，");
    println!("     省掉自写循环但多一趟 WIC 内部拷贝，两者量级相同，先按自写实现。");

    Ok(())
}

/// 【E】色度抽样能不能指定。
///
/// 动因：`image` crate 的 JpegEncoder **写死 4:2:2**（`screenshot.rs` 的注释记录过——
/// 它正是「截图文字边缘发虚带彩色镶边」那条反馈的来源之一），而 WIC 默认走 **4:2:0**
///（实测 SOF 采样因子 `id1=2x2`）。换 WIC 若是拿色度抽样换速度，就必须先把这一军：
/// WIC 支持 `JpegYCrCbSubsampling` 属性（420/422/440/444）。
unsafe fn run_subsampling(factory: &IWICImagingFactory) -> Result<()> {
    println!("\n【E】色度抽样能否指定（image crate 固定 4:2:2，WIC 默认疑为 4:2:0）");
    println!("───────────────────────────────────────────────────────────");
    let (w, h) = (512u32, 512u32);
    let data = synth(w, h, 3, 2, 1, 0);
    for (tag, sub) in [
        ("default", None),
        ("420", Some(1i32)),
        ("422", Some(2)),
        ("444", Some(3)),
    ] {
        let path = format!("_sub_{tag}.jpg");
        let stream = factory.CreateStream()?;
        stream.InitializeFromFilename(&HSTRING::from(path.as_str()), GENERIC_WRITE.0)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;

        let mut fo: Option<IWICBitmapFrameEncode> = None;
        let mut props: Option<IPropertyBag2> = None;
        encoder.CreateNewFrame(&mut fo, &mut props)?;
        let frame = fo.ok_or_else(|| anyhow!("CreateNewFrame 未返回 frame"))?;

        let mut wrote = false;
        if let (Some(p), Some(s)) = (props.as_ref(), sub) {
            let name = HSTRING::from("JpegYCrCbSubsampling");
            let pb = PROPBAG2 {
                pstrName: PWSTR(name.as_ptr() as *mut u16),
                vt: VARENUM(VT_UI1.0),
                ..Default::default()
            };
            wrote = p.Write(1, &pb, &VARIANT::from(s as u8)).is_ok();
        }
        frame.Initialize(props.as_ref())?;
        frame.SetSize(w, h)?;
        let mut fmt = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut fmt)?;

        let t0 = Instant::now();
        frame.WritePixels(h, w * 3, &data)?;
        frame.Commit()?;
        encoder.Commit()?;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let bytes = std::fs::metadata(&path)?.len();
        println!(
            "  {tag:<8} {ms:>6.2} ms  {:>7.1} KB  属性写入{}  → {path}",
            bytes as f64 / 1024.0,
            if sub.is_none() {
                "（未设）"
            } else if wrote {
                "成功"
            } else {
                "失败"
            }
        );
    }
    println!("  ⇒ 抽样方式看 SOF 段采样因子（id1=2x2 即 4:2:0），用解析脚本读回");
    Ok(())
}

fn main() -> Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let formats = std::env::args().any(|a| a == "--formats");

    println!("═══════════════════════════════════════════════════════════");
    println!(" WIC（系统自带）JPEG 编码器探针");
    println!(" 尺寸 {W}x{H}，图内容与 main.rs 探针逐像素相同");
    println!("═══════════════════════════════════════════════════════════\n");

    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;

        if formats {
            run_formats(&factory)?;
            run_subsampling(&factory)?;
        } else {
            let data = synth(W, H, 3, 2, 1, 0);
            let (ms, bytes, _) = bench(
                &factory,
                &data,
                W,
                H,
                W * 3,
                GUID_WICPixelFormat24bppBGR,
                None,
                "single",
            )?;
            println!(
                "  [实测] WIC 默认质量：{ms:.2} ms/帧  {:.1} KB  理论上限 {:.1} fps",
                bytes as f64 / 1024.0,
                1000.0 / ms
            );
            println!("\n  ── 对照（同一张图，同一质量）──");
            println!("    image crate（纯 Rust） q85 : 196.78 ms  1402.4 KB   5.1 fps");
            println!("    libjpeg-turbo（PIL） q85 :  14.52 ms   830.3 KB  68.9 fps");
        }
    }

    println!("\n─── 探针结束 ───");
    Ok(())
}
