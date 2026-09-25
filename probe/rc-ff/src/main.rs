//! 探针入口 —— 验证「自建裁剪 FFmpeg DLL 在 Rust 里的接入形态」。
//!
//! 用法：
//! ```text
//! cargo run --release -- [--dll-dir <目录>] [--enc <名>] [--size <WxH>]
//!                        [--pattern entropy|screen] [--frames <n>] [--rounds <n>]
//!                        [--no-dll-dir]
//! ```
//! `--no-dll-dir` 关掉 `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`，用来复现
//! 「不加这个 flag 时 avcodec-63.dll 解析不了 libvpl-2.dll」——证明它是必需的，
//! 而不是"顺手加的保险"。

mod api;
mod dll;
mod enc;
mod hw;
mod types;

use api::Ff;
use enc::{make_test_nv12, nal_name, non_zero_ratio, scan_annex_b, EncoderOpts, FfEncoder, Pattern};
use std::path::PathBuf;

const DEFAULT_DLL_DIR: &str = "D:/AItool/ffbuild/stripdist";
const AVCODEC_DLL: &str = "avcodec-63.dll";
const AVUTIL_DLL: &str = "avutil-61.dll";
const ALL_ENCODERS: [&str; 3] = ["h264_nvenc", "h264_qsv", "h264_amf"];

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("见 main.rs 头部注释");
        return Ok(());
    }
    let dll_dir =
        PathBuf::from(arg_val(&args, "--dll-dir").unwrap_or_else(|| DEFAULT_DLL_DIR.into()));
    let dll_load_dir = !args.iter().any(|a| a == "--no-dll-dir");
    let frames: usize = arg_val(&args, "--frames")
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let rounds: usize = arg_val(&args, "--rounds")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let pat = arg_val(&args, "--pattern")
        .and_then(|s| Pattern::parse(&s))
        .unwrap_or(Pattern::Entropy);
    let (w, h) = arg_val(&args, "--size")
        .and_then(|s| {
            let (a, b) = s.split_once('x')?;
            Some((a.parse().ok()?, b.parse().ok()?))
        })
        .unwrap_or((2560i32, 1440i32));
    let encoders: Vec<String> = match arg_val(&args, "--enc") {
        Some(e) => vec![e],
        None => ALL_ENCODERS.iter().map(|s| s.to_string()).collect(),
    };

    println!("===== 加载 =====");
    println!("  DLL 目录     : {}", dll_dir.display());
    println!(
        "  DLL_LOAD_DIR : {}（{}）",
        if dll_load_dir { "开" } else { "关" },
        if dll_load_dir {
            "被加载 DLL 自身目录会进依赖搜索路径"
        } else {
            "复现模式：libvpl-2.dll 应找不到"
        }
    );
    let t_load = std::time::Instant::now();
    let ff = Ff::load(
        &dll_dir.join(AVCODEC_DLL),
        &dll_dir.join(AVUTIL_DLL),
        dll_load_dir,
    )?;
    println!(
        "  加载 + 解析 32 个符号耗时: {} µs",
        t_load.elapsed().as_micros()
    );

    unsafe { (ff.av_log_set_level)(32) } // AV_LOG_WARNING，别让 FFmpeg 刷屏
    let (ac_maj, ac_min, ac_mic) = Ff::version_triple(unsafe { (ff.avcodec_version)() });
    let (au_maj, au_min, au_mic) = Ff::version_triple(unsafe { (ff.avutil_version)() });
    println!("  libavcodec    : {ac_maj}.{ac_min}.{ac_mic}");
    println!("  libavutil     : {au_maj}.{au_min}.{au_mic}");
    println!(
        "  av_version_info: {}",
        unsafe { std::ffi::CStr::from_ptr((ff.av_version_info)()) }.to_string_lossy()
    );

    // 批 3 hwaccel 实验（--hw）：D3D11 设备共享 + 纹理直喂 nvenc，与 CPU 路径互斥
    if args.iter().any(|a| a == "--hw") {
        let fps = arg_val(&args, "--fps").and_then(|s| s.parse().ok()).unwrap_or(30i32);
        unsafe { (ff.av_log_set_level)(48) } // DEBUG：hwcontext 失败要看全上下文
        let r = hw::run(&ff, w, h, fps, frames);
        // 🔴 探针退出时 Drop（卸 avcodec/avutil + COM/nvenc session 清理交错）会段错误
        //   （S6 数据全部打完后 exit=139）。探针不追求优雅关闭，直接硬退绕过 Drop。
        let code = if r.is_ok() { 0 } else { 1 };
        std::process::exit(code);
    }
    println!(
        "  编码器名单    : {}",
        ALL_ENCODERS
            .iter()
            .map(|n| {
                let c = std::ffi::CString::new(*n).unwrap();
                let p = unsafe { (ff.avcodec_find_encoder_by_name)(c.as_ptr()) };
                format!("{n}={}", if p.is_null() { "✗" } else { "✓" })
            })
            .collect::<Vec<_>>()
            .join("  ")
    );

    // 输入：一旦生成就复用（不要每轮重造，避免把生成耗时混进编码耗时）
    let nv12 = make_test_nv12(w as usize, h as usize, 0x9E37_79B9, pat);
    println!(
        "\n===== 测试输入 =====\n  {w}x{h} NV12，{} B，非零占比 {:.1}%",
        nv12.len(),
        non_zero_ratio(&nv12) * 100.0
    );
    println!("  形态: {}", pat.as_str());

    let mut summary: Vec<Row> = Vec::new();
    for name in &encoders {
        match run_one(&ff, name, w, h, frames, rounds, &nv12) {
            Ok(r) => summary.push(r),
            Err(e) => {
                println!("\n===== {name} =====\n  ❌ {e}");
                summary.push(Row {
                    name: name.clone(),
                    ..Default::default()
                });
            }
        }
    }

    println!(
        "\n===== 汇总（{}x{}，{} 帧/轮 × {} 轮，{}）=====",
        w,
        h,
        frames,
        rounds,
        pat.as_str()
    );
    println!(
        "  {:<13}{:>7}{:>8}{:>9}{:>9}{:>9}{:>10}{:>9}{:>9}{:>7}",
        "编码器",
        "打开ms",
        "首包@帧",
        "准备ms",
        "send ms",
        "drain ms",
        "合计ms/帧",
        "p95ms",
        "最大ms",
        "关键帧"
    );
    for r in &summary {
        if !r.ok {
            println!("  {:<13}{:>7}", r.name, "失败");
            continue;
        }
        println!(
            "  {:<13}{:>7.0}{:>8}{:>9.2}{:>9.2}{:>9.2}{:>10.2}{:>9.2}{:>9.2}{:>7}",
            r.name,
            r.open_ms,
            if r.first_pkt_frame == 0 {
                "无".to_string()
            } else {
                r.first_pkt_frame.to_string()
            },
            r.fill_ms,
            r.send_ms,
            r.drain_ms,
            r.avg_ms,
            r.p95_ms,
            r.max_ms,
            r.keys
        );
    }
    println!("\n  输出码率（按 fps 折算，非按实测耗时）：");
    for r in &summary {
        if r.ok {
            println!(
                "    {:<13}{:>8.1} Mbps  （{} 帧共发 {} 包）",
                r.name,
                r.stream_kbps / 1000.0,
                r.frames,
                r.packets
            );
        }
    }
    println!("\n  判据参考：主工程远控的编码预算量级是 **4.2ms/帧**（fps240 档）；");
    println!("            30/60fps 档宽裕得多，但 send 是同步等待，直接进单帧延迟。");
    Ok(())
}

#[derive(Default)]
struct Row {
    name: String,
    ok: bool,
    open_ms: f64,
    first_pkt_frame: usize,
    fill_ms: f64,
    send_ms: f64,
    drain_ms: f64,
    avg_ms: f64,
    p95_ms: f64,
    max_ms: f64,
    stream_kbps: f64,
    keys: usize,
    frames: usize,
    packets: u64,
}

fn run_one(
    ff: &Ff,
    name: &str,
    w: i32,
    h: i32,
    frames: usize,
    rounds: usize,
    nv12: &[u8],
) -> anyhow::Result<Row> {
    println!("\n===== {name} =====");
    let fps = 30;
    // 码率按主工程的表取（bitrate_for_width）：2560 → 14Mbps（30fps 基准）
    let bitrate = if w >= 3200 {
        22_000_000
    } else if w >= 2560 {
        14_000_000
    } else {
        8_000_000
    };
    let opts = EncoderOpts {
        codec_name: name,
        width: w,
        height: h,
        fps,
        bitrate,
        gop: fps * 2,
        extra: extra_opts(name),
        // 只对 qsv 开（qsvenc.c select_rc_mode 的模式推导见 enc.rs 注释）；
        // nvenc/amf 的 CBR 走各自私有 `rc` 选项。
        cbr_align: name == "h264_qsv",
    };

    let t0 = std::time::Instant::now();
    let mut e = FfEncoder::open(ff, &opts)?;
    let open_ms = t0.elapsed().as_millis() as f64;
    println!("  打开成功，耗时 {open_ms:.1} ms");
    println!(
        "  自校验通过：直接写 bit_rate={} 后 AVOption「b」读回 {}；ctx->delay={}（自报值，仅参考）",
        bitrate,
        e.ctx_bit_rate(),
        e.delay
    );

    let (mut fills, mut sends, mut drains, mut totals) = (vec![], vec![], vec![], vec![]);
    let mut first_pkt_frame = 0usize;
    let mut total_bytes = 0usize;
    let mut keys = 0usize;
    let mut first_nals: Vec<u8> = Vec::new();
    let mut all_annex_b = true;
    let mut pkts_per_frame: Vec<usize> = Vec::new();

    for round in 0..rounds {
        if rounds > 1 {
            println!("  --- 第 {} 轮 ---", round + 1);
        }
        for i in 0..frames {
            let step = e.encode_nv12(nv12)?;
            fills.push(step.fill_us as f64 / 1000.0);
            sends.push(step.send_us as f64 / 1000.0);
            drains.push(step.drain_us as f64 / 1000.0);
            totals.push((step.fill_us + step.send_us + step.drain_us) as f64 / 1000.0);
            pkts_per_frame.push(step.packets.len());
            for p in &step.packets {
                if first_pkt_frame == 0 {
                    first_pkt_frame = i + 1;
                    let (nals, ok_prefix) = scan_annex_b(&p.data);
                    first_nals = nals;
                    println!(
                        "  首包出现在第 {} 帧，{} B，key={}，Annex-B 且带参数集={}",
                        i + 1,
                        p.data.len(),
                        p.key,
                        ok_prefix
                    );
                }
                let (_, ok_prefix) = scan_annex_b(&p.data);
                all_annex_b &= ok_prefix || !p.key; // 非关键帧不必带 SPS/PPS
                total_bytes += p.data.len();
                if p.key {
                    keys += 1;
                }
            }
        }
        let f = e.flush()?;
        for p in &f.packets {
            total_bytes += p.data.len();
            if p.key {
                keys += 1;
            }
        }
    }

    totals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = totals.iter().sum::<f64>() / totals.len() as f64;
    let p95 = totals[((totals.len() as f64 * 0.95) as usize).min(totals.len() - 1)];
    let max = *totals.last().unwrap();
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let stream_kbps = total_bytes as f64 * 8.0 * fps as f64 / (frames * rounds) as f64 / 1000.0;

    println!(
        "  NAL 序列（首包）: {}",
        first_nals
            .iter()
            .map(|t| format!("{}({t})", nal_name(*t)))
            .collect::<Vec<_>>()
            .join(" ")
    );
    println!(
        "  出包统计: {} 帧 → 包/帧 最少 {} 最多 {}，共 {} 包，关键帧 {} 个，总计 {} B",
        frames * rounds,
        pkts_per_frame.iter().min().copied().unwrap_or(0),
        pkts_per_frame.iter().max().copied().unwrap_or(0),
        e.packets_out,
        keys,
        total_bytes
    );
    println!(
        "  Annex-B 判定: {}",
        if all_annex_b {
            "✓ 全部是 Annex-B"
        } else {
            "✗ 有关键帧不是 Annex-B"
        }
    );

    Ok(Row {
        name: name.to_string(),
        ok: true,
        open_ms,
        first_pkt_frame,
        fill_ms: mean(&fills),
        send_ms: mean(&sends),
        drain_ms: mean(&drains),
        avg_ms: avg,
        p95_ms: p95,
        max_ms: max,
        stream_kbps,
        keys,
        frames: frames * rounds,
        packets: e.packets_out,
    })
}

/// 三个后端的低延迟参数名各不相同 —— **这里故意都试一遍**，
/// 探针会把「不被接受」的打出来，正好一次性摸清各后端的真实 option 集。
fn extra_opts(enc: &str) -> Vec<(&'static str, &'static str)> {
    match enc {
        "h264_nvenc" => vec![
            ("preset", "p4"),
            ("tune", "ll"),
            ("rc", "cbr"),
            ("rc-lookahead", "0"),
            ("zerolatency", "1"),
        ],
        "h264_qsv" => vec![
            ("preset", "veryfast"),
            ("look_ahead", "0"),
            ("async_depth", "1"),
            // 码控对齐走 cbr_align 开关（写结构体 rc_max_rate 字段）：
            // qsv 没有 rc_mode 私有选项，公共选项表也没有 rc_max_rate
            // （options_table.h 实测），只能写 AVCodecContext 结构体字段。
        ],
        "h264_amf" => vec![
            ("usage", "lowlatency"),
            ("quality", "speed"),
            ("rc", "cbr"),
        ],
        _ => vec![],
    }
}

fn arg_val(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
