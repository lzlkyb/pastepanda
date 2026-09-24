//! 编码器封装：把 FFmpeg 的 **pull 模型**映射成主工程要的 **push 模型**。
//!
//! 🔴 **本文件是接入 F 唯一真正未知的一块**（其余都是机械搬运）。
//!
//! FFmpeg 的编码 API 是拉模型：
//! ```text
//!   avcodec_send_frame(ctx, frame)     推输入；输入队列满 → AVERROR(EAGAIN)
//!   avcodec_receive_packet(ctx, pkt)   拉输出；暂时没输出 → AVERROR(EAGAIN)
//! ```
//! 而主工程现有接口是推模型：
//! ```text
//!   H264SessionEncoder::encode_bgra(&[u8], w, h) -> Result<Vec<H264Packet>>
//! ```
//! 两者之间要垫一层「一帧入 → 若干包出」。本文件就是那层，并**分阶段计时**，
//! 好回答三个必须实测的问题：
//!   1. 首次 send 后能不能立刻拿到首包？（软编 MFT 有过 17 帧累积延迟的教训）
//!   2. 稳态单帧耗时是多少、花在哪？（主工程的编码预算量级是 4.2ms）
//!   3. 一帧到底出几个包？（决定 `Vec<H264Packet>` 这个返回类型够不够用）

use crate::api::Ff;
use crate::types::*;
use anyhow::{bail, Result};
use std::ffi::{c_void, CString};

/// `AV_OPT_SEARCH_CHILDREN`：在 ctx 自己的 AVOption 表里找不到时，下钻到**子对象**
/// （编码器的 `priv_data` / `priv_class`）。`preset` / `tune` / `rc` / `look_ahead`
/// 这类后端私有参数全靠它，传 0 会全部静默失败。
const AV_OPT_SEARCH_CHILDREN: i32 = 1;

/// 一个编码输出包。字段与主工程的 `H264Packet` 同口径（`data` 是 Annex-B）。
#[derive(Debug, Clone)]
pub struct Packet {
    pub data: Vec<u8>,
    pub key: bool,
    #[allow(dead_code)] // 探针不校验时间轴，但留着便于日后查 pts 断裂
    pub pts: i64,
}

/// 打开参数。三个后端的参数名不一样，所以「通用字段」走结构体、
/// 「后端特有」走 `extra`（设不上只记 warning，不致命）。
pub struct EncoderOpts<'a> {
    pub codec_name: &'a str,
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub bitrate: i64,
    /// I 帧间隔（帧）。主工程按 2 秒一个关键帧。
    pub gop: i32,
    /// 形如 `[("preset", "p4"), ("tune", "ll")]`。三个后端参数名不同，
    /// 设不上只 warning —— 不能因为一个后端不认 `rc-lookahead` 就整体失败。
    pub extra: Vec<(&'static str, &'static str)>,
    /// 🔴 设 `rc_max_rate = bit_rate` ⇒ FFmpeg qsv 的 `select_rc_mode`
    /// （qsvenc.c:628）才会落 **CBR**；否则 bit_rate 被解读成 VBR 目标，
    /// 平坦内容实测只出 0.9 Mbps（NVENC 同内容 12.6 Mbps）。
    /// 只对 qsv 开：nvenc/amf 用各自私有 `rc` 选项表达 CBR。
    pub cbr_align: bool,
}

/// 一次 send 之后的产出，以及**分阶段**耗时。
///
/// 🔴 分阶段是刻意的：合并成一个数只能说「慢」，分开了才能判
/// 「是拷贝慢 / 是编码慢 / 还是同步等待慢」—— 三者的对策完全不同，成本也差很远。
pub struct Step {
    pub packets: Vec<Packet>,
    /// 「取可写缓冲 + 逐行填 NV12」的耗时（纯 CPU 拷贝，可优化）
    pub fill_us: u128,
    /// `avcodec_send_frame` 本身
    pub send_us: u128,
    /// drain（receive_packet 循环）——**包含等编码器出结果的同步等待**
    pub drain_us: u128,
}

pub struct FfEncoder<'a> {
    ff: &'a Ff,
    ctx: *mut AVCodecContext,
    frame: *mut AVFrame,
    pkt: *mut AVPacket,
    pub width: i32,
    pub height: i32,
    pub frames_in: u64,
    pub packets_out: u64,
    /// 由 open 时读回的 `ctx->delay` —— 编码器**自报**的流水线延迟（帧）。
    /// ⚠️ 实测它与真实首包延迟不一致（nvenc 报 0、实测 3 帧才出首包），
    /// 所以只当参考，判据一律用真实出包。
    pub delay: i32,
}

impl<'a> FfEncoder<'a> {
    pub fn open(ff: &'a Ff, o: &EncoderOpts<'_>) -> Result<Self> {
        let cname = CString::new(o.codec_name)?;
        let codec = unsafe { (ff.avcodec_find_encoder_by_name)(cname.as_ptr()) };
        if codec.is_null() {
            bail!("找不到编码器「{}」（本 DLL 是否启用了它？）", o.codec_name);
        }
        let ctx = unsafe { (ff.avcodec_alloc_context3)(codec) };
        if ctx.is_null() {
            bail!("avcodec_alloc_context3 返回 NULL");
        }
        let me = Self {
            ff,
            ctx,
            frame: std::ptr::null_mut(),
            pkt: std::ptr::null_mut(),
            width: o.width,
            height: o.height,
            frames_in: 0,
            packets_out: 0,
            delay: -1,
        };

        unsafe {
            let c = &mut *ctx;
            c.codec_type = AVMEDIA_TYPE_VIDEO;
            c.width = o.width;
            c.height = o.height;
            c.pix_fmt = AV_PIX_FMT_NV12;
            // time_base 与 framerate 必须都设：nvenc/qsv 会各自读一个，
            // 只设一个时另一个是 0/1，产出的 pts 全为 0（时间轴塌掉）。
            c.time_base = AVRational::new(1, o.fps);
            c.framerate = AVRational::new(o.fps, 1);
            c.bit_rate = o.bitrate;
            if o.cbr_align {
                c.rc_max_rate = o.bitrate; // offset 464，断言见 types.rs
            }
            c.gop_size = o.gop;
            c.max_b_frames = 0; // 低延迟：B 帧是延迟的主要来源
            c.thread_count = 1; // 远控单帧延迟优先，不要帧级并行
        }

        // 🔴 **结构体偏移自校验**（必须在 open2 之前，因为它会读这些字段）：
        // 我们**直接写字段**（走 `#[repr(C)]` 的偏移），再让 **FFmpeg 自己的
        // AVOption** 读回来（走 FFmpeg 编译进去的 offsetof）。两条路径的偏移
        // 来源不同，所以能真正测出我们抄错没有 —— 只写不读是测不出来的。
        me.verify_layout(&[
            ("b", o.bitrate, "bit_rate"),
            ("g", o.gop as i64, "gop_size"),
            ("bf", 0, "max_b_frames"),
        ])?;

        // ctx->codec_id 由 alloc_context3 填 —— 顺手验证 codec_id 偏移（24）没写错。
        let cid = unsafe { (*ctx).codec_id };
        if cid != AV_CODEC_ID_H264 {
            bail!("ctx->codec_id={cid}，不是 H264({AV_CODEC_ID_H264}) —— codec_id 偏移可能写错");
        }

        // 后端特有参数：设不上不是错误（三个后端 option 集不同）。
        //
        // 🔴 search_flags 必须是 `AV_OPT_SEARCH_CHILDREN`：`preset`/`tune`/`rc`
        // 是**编码器私有**的 option（挂在 `priv_data` 的 AVClass 上），传 0
        // 只在 `AVCodecContext` 自己的表里查 ⇒ 全部静默「Option not found」。
        // **首轮实测就踩了这个**：nvenc 跑的是默认 preset，量出来的 22.4ms/帧
        // 根本不能代表目标配置。这类"设了但没生效"是本项目最需要防的形态。
        for (k, v) in &o.extra {
            let (ck, cv) = (CString::new(*k)?, CString::new(*v)?);
            let r = unsafe {
                (ff.av_opt_set)(
                    ctx as *mut c_void,
                    ck.as_ptr(),
                    cv.as_ptr(),
                    AV_OPT_SEARCH_CHILDREN,
                )
            };
            if r < 0 {
                println!(
                    "    · 参数 {}={} 不被 {} 接受（忽略）：{}",
                    k,
                    v,
                    o.codec_name,
                    ff.err_str(r)
                );
            }
        }

        let r = unsafe { (ff.avcodec_open2)(ctx, codec, std::ptr::null_mut()) };
        if r < 0 {
            bail!(
                "avcodec_open2({}, {}x{}, {}kbps) 失败：{}",
                o.codec_name,
                o.width,
                o.height,
                o.bitrate / 1000,
                ff.err_str(r)
            );
        }

        let mut me = me;
        me.delay = unsafe { (*ctx).delay };

        // frame：一次分配、逐帧复用（4K 每帧 12MB，不能每帧 new）
        let frame = unsafe { (ff.av_frame_alloc)() };
        if frame.is_null() {
            bail!("av_frame_alloc 返回 NULL");
        }
        me.frame = frame;
        unsafe {
            (*frame).format = AV_PIX_FMT_NV12;
            (*frame).width = o.width;
            (*frame).height = o.height;
        }
        // 若 width/height/format 的偏移写错，这里会失败或分配出畸形 buffer
        let r = unsafe { (ff.av_frame_get_buffer)(frame, 32) };
        if r < 0 {
            bail!(
                "av_frame_get_buffer({}x{} NV12) 失败：{} —— 结构体偏移可能写错了",
                o.width,
                o.height,
                ff.err_str(r)
            );
        }
        // 读回 linesize 交叉验证：NV12 的 Y 行宽必须 >= width
        let ls_y = unsafe { (*frame).linesize[0] };
        if ls_y < o.width {
            bail!(
                "linesize[0]={ls_y} < width={} —— AVFrame 偏移可能写错了",
                o.width
            );
        }

        let pkt = unsafe { (ff.av_packet_alloc)() };
        if pkt.is_null() {
            bail!("av_packet_alloc 返回 NULL");
        }
        me.pkt = pkt;
        Ok(me)
    }

    /// 直接写字段 → 用 AVOption 读回比对。任一不符即中止（**不能带着错偏移继续**）。
    fn verify_layout(&self, expect: &[(&str, i64, &str)]) -> Result<()> {
        for (opt, want, field) in expect {
            let ck = CString::new(*opt)?;
            let mut got: i64 = -12345;
            let r =
                unsafe { (self.ff.av_opt_get_int)(self.ctx as *mut c_void, ck.as_ptr(), 0, &mut got) };
            if r < 0 {
                bail!(
                    "自校验失败：AVOption「{}」读不出来（{}）—— 该 option 名不对？",
                    opt,
                    self.ff.err_str(r)
                );
            }
            if got != *want {
                bail!(
                    "🔴 结构体偏移写错：我们往 {field} 写了 {want}，FFmpeg 按它自己的偏移读到 {got}。\
                     请重新跑 offsetof_probe.c 核对 src/types.rs 的 padding。"
                );
            }
        }
        Ok(())
    }

    /// 送一帧 NV12（**连续布局**：Y 平面紧跟交错的 UV 平面，主工程 nv12_buf 就是这个形态）。
    pub fn encode_nv12(&mut self, nv12: &[u8]) -> Result<Step> {
        let (w, h) = (self.width as usize, self.height as usize);
        let need = w * h * 3 / 2;
        if nv12.len() < need {
            bail!("NV12 缓冲过小：{} < {}（{}x{}）", nv12.len(), need, w, h);
        }
        let ff = self.ff;
        let t_fill = std::time::Instant::now();
        // 上一帧可能还被编码器引用（nvenc 异步、FFmpeg 侧有帧队列），
        // 不 make_writable 直接写会是数据竞争；代价是被引用时会重新分配缓冲。
        let r = unsafe { (ff.av_frame_make_writable)(self.frame) };
        if r < 0 {
            bail!("av_frame_make_writable: {}", ff.err_str(r));
        }
        unsafe {
            let f = &mut *self.frame;
            let (ls_y, ls_uv) = (f.linesize[0] as usize, f.linesize[1] as usize);
            let src = nv12.as_ptr();
            if ls_y == w {
                // 行宽正好等于宽度：一次 memcpy
                std::ptr::copy_nonoverlapping(src, f.data[0], w * h);
            } else {
                for y in 0..h {
                    std::ptr::copy_nonoverlapping(src.add(y * w), f.data[0].add(y * ls_y), w);
                }
            }
            if ls_uv == w {
                std::ptr::copy_nonoverlapping(src.add(w * h), f.data[1], w * (h / 2));
            } else {
                for y in 0..(h / 2) {
                    std::ptr::copy_nonoverlapping(
                        src.add(w * h + y * w),
                        f.data[1].add(y * ls_uv),
                        w,
                    );
                }
            }
            f.pts = self.frames_in as i64;
        }
        let fill_us = t_fill.elapsed().as_micros();
        self.frames_in += 1;
        self.push(self.frame, fill_us)
    }

    /// 冲刷尾部（送 NULL frame）。B 帧/带延迟流水线的编码器在收尾时才会吐出剩余包。
    pub fn flush(&mut self) -> Result<Step> {
        self.push(std::ptr::null(), 0)
    }

    fn push(&mut self, frame: *const AVFrame, fill_us: u128) -> Result<Step> {
        let ff = self.ff;
        let t0 = std::time::Instant::now();
        let mut r = unsafe { (ff.avcodec_send_frame)(self.ctx, frame) };
        let send_us = t0.elapsed().as_micros();

        let mut packets = Vec::new();
        let t1 = std::time::Instant::now();
        // 输入队列满：先把已产出的包掏空，再重试一次 send
        // （低延迟配置下通常不触发，但触发时不处理会静默丢帧）
        if r == AVERROR_EAGAIN {
            packets.extend(self.drain()?);
            r = unsafe { (ff.avcodec_send_frame)(self.ctx, frame) };
        }
        if r < 0 && r != AVERROR_EAGAIN {
            bail!("avcodec_send_frame: {}（{}）", ff.err_str(r), r);
        }
        packets.extend(self.drain()?);
        Ok(Step {
            packets,
            fill_us,
            send_us,
            drain_us: t1.elapsed().as_micros(),
        })
    }

    /// 拉空输出队列。`EAGAIN` 是"暂无输出"、`EOF` 是"彻底结束"，**两者都不是错误**。
    fn drain(&mut self) -> Result<Vec<Packet>> {
        let ff = self.ff;
        let mut out = Vec::new();
        loop {
            let r = unsafe { (ff.avcodec_receive_packet)(self.ctx, self.pkt) };
            if r == AVERROR_EAGAIN || r == AVERROR_EOF {
                break;
            }
            if r < 0 {
                bail!("avcodec_receive_packet: {}（{}）", ff.err_str(r), r);
            }
            unsafe {
                let p = &*self.pkt;
                if p.data.is_null() || p.size <= 0 {
                    // 空包：unref 后继续，别把它当有效帧交出去
                    (ff.av_packet_unref)(self.pkt);
                    continue;
                }
                let data = std::slice::from_raw_parts(p.data, p.size as usize).to_vec();
                out.push(Packet {
                    data,
                    key: p.flags & AV_PKT_FLAG_KEY != 0,
                    pts: p.pts,
                });
                (ff.av_packet_unref)(self.pkt);
            }
            self.packets_out += 1;
        }
        Ok(out)
    }

    /// 给外部（main）读 `ctx->bit_rate` —— 交叉验证自校验结论用。
    pub fn ctx_bit_rate(&self) -> i64 {
        unsafe { (*self.ctx).bit_rate }
    }
}

impl Drop for FfEncoder<'_> {
    fn drop(&mut self) {
        let ff = self.ff;
        unsafe {
            if !self.pkt.is_null() {
                (ff.av_packet_free)(&mut self.pkt);
            }
            if !self.frame.is_null() {
                (ff.av_frame_free)(&mut self.frame);
            }
            if !self.ctx.is_null() {
                (ff.avcodec_free_context)(&mut self.ctx);
            }
        }
    }
}

/// Annex-B 起始码扫描：校验输出真的是 Annex-B（不是 AVCC 的 4 字节长度前缀）。
/// 返回 (NAL 类型列表, 是否以参数集开头)。
pub fn scan_annex_b(data: &[u8]) -> (Vec<u8>, bool) {
    let mut nals = Vec::new();
    let mut i = 0usize;
    let mut has_start_code = false;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            has_start_code = true;
            let hdr = i + 3;
            if hdr < data.len() {
                nals.push(data[hdr] & 0x1F);
            }
            i = hdr;
        } else if i + 4 <= data.len()
            && data[i] == 0
            && data[i + 1] == 0
            && data[i + 2] == 0
            && data[i + 3] == 1
        {
            has_start_code = true;
            let hdr = i + 4;
            if hdr < data.len() {
                nals.push(data[hdr] & 0x1F);
            }
            i = hdr;
        } else {
            i += 1;
        }
    }
    let starts_with_param = nals.first().is_some_and(|t| matches!(t, 7 | 8 | 9));
    (nals, has_start_code && starts_with_param)
}

/// NAL 类型 → 名字（H.264 常见几种），日志里比数字好读。
pub fn nal_name(t: u8) -> &'static str {
    match t {
        1 => "非IDR切片",
        5 => "IDR切片",
        6 => "SEI",
        7 => "SPS",
        8 => "PPS",
        9 => "AUD",
        _ => "其他",
    }
}

/// 测试图形态。
///
/// 🔴 这两个形态的耗时差是判「19ms 是编码器的锅，还是我给的内容太狠」的关键。
/// 只测一种必得出错误结论：
/// - `Entropy`：逐像素随机 = 编码压力**上界**（真实屏幕达不到，硬件编码器最恨它）
/// - `Screen`：16×16 块内同色、块间随机 = 模拟「大量平坦区 + 突变边缘」的 UI/文字画面
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pattern {
    Entropy,
    Screen,
}

impl Pattern {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "entropy" => Some(Self::Entropy),
            "screen" => Some(Self::Screen),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Entropy => "entropy（逐像素随机，压力上界）",
            Self::Screen => "screen（块状平坦+突变边缘，近似 UI）",
        }
    }
}

/// 合成 NV12 测试图。
pub fn make_test_nv12(w: usize, h: usize, seed: u32, pat: Pattern) -> Vec<u8> {
    let mut buf = vec![0u8; w * h * 3 / 2];
    let mut s = seed | 1;
    let mut next = move || {
        // xorshift32：够随机、零依赖
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s
    };
    match pat {
        Pattern::Entropy => {
            for p in buf.iter_mut() {
                *p = (next() >> 24) as u8;
            }
        }
        Pattern::Screen => {
            // Y：16×16 块内同色，块色随机
            for by in 0..h.div_ceil(16) {
                for bx in 0..w.div_ceil(16) {
                    let v = (next() >> 24) as u8;
                    for y in (by * 16)..(by * 16 + 16).min(h) {
                        let row = &mut buf[y * w..y * w + w];
                        let x0 = bx * 16;
                        let x1 = (x0 + 16).min(w);
                        row[x0..x1].fill(v);
                    }
                }
            }
            // UV：按相邻两行 Y 平均（同色块得到中性色，近似真实 4:2:0）
            for y in 0..h / 2 {
                for x in 0..w {
                    let a = buf[(2 * y) * w + x] as u32;
                    let b = buf[(2 * y + 1) * w + x] as u32;
                    buf[w * h + y * w + x] = ((a + b + 1) / 2) as u8;
                }
            }
        }
    }
    buf
}

/// 确认 buffer 不是全零（防止"编了个空图还很开心"）。
pub fn non_zero_ratio(buf: &[u8]) -> f64 {
    if buf.is_empty() {
        return 0.0;
    }
    buf.iter().filter(|b| **b != 0).count() as f64 / buf.len() as f64
}
