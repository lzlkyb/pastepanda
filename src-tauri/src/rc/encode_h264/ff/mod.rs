//! FFmpeg 硬编后端（路线 F）：把 FFmpeg 的 **pull 模型**映射成主工程的
//! `encode_nv12(&NV12) -> Vec<H264Packet>` push 模型。
//!
//! 从 `probe/rc-ff` 收编（2026-09-24 三后端实测跑通，数据见 docs §3.8.9）：
//! 1080p 下 qsv 4.1~4.8 ms/帧、nvenc 6.3~9.2 ms/帧（MF 基线 7.15）。
//!
//! 🔴 **范围（方案 A+，批 2 起支持 HEVC）**：CPU NV12 路径，H264 / HEVC 双标准
//! （候选链各一套，见 [`candidates`]）。GPU 零拷贝不给 FF
//!（hwaccel FFI 是未探明区域，见 docs §7.2 批 3）。
//!
//! push→pull 垫层语义（实测判据）：
//! - NVENC 显式关闭输出等待；是否逐输入出包由硬件回归验证，不靠自报 delay
//! - `send` 返回 ≠ 包已出；EAGAIN 是流控不是错误；B 帧=0 下无需 EOF flush
//!   （会话性重开直接丢弃流水线残帧，与 MF 路径行为一致）
//! - `ctx->delay` 自报不可信，判延迟一律用真实出包

use self::ffi::{
    dll_dir, AVMEDIA_TYPE_VIDEO, AVERROR_EAGAIN, AVERROR_EOF, AV_CODEC_ID_AV1, AV_CODEC_ID_H264, AV_CODEC_ID_HEVC,
    AV_PICTURE_TYPE_I, AV_PIX_FMT_NV12, AV_PKT_FLAG_KEY, AVCodecContext, AVFrame, AVPacket,
    AVRational, Ff,
};
use super::{H264Packet, VideoCodec};
use std::ffi::{c_void, CString};
use std::sync::OnceLock;

mod ffi;

/// `AV_OPT_SEARCH_CHILDREN`：在 ctx 自己的 AVOption 表查不到时，下钻到**子对象**
/// （编码器 `priv_data`）。`preset`/`tune`/`rc` 全是私有 option，传 0 会全部
/// **静默失败**（探针首轮 22.4ms/帧就是默认 preset 的假成绩）。
const AV_OPT_SEARCH_CHILDREN: i32 = 1;

/// 进程级符号表缓存。**失败也缓存**：DLL 目录缺失/损坏属环境问题，
/// 每次会话重开都重试只会刷日志（MF 侧同等故障靠 streak 熔断，语义一致）。
static FF: OnceLock<Result<Ff, String>> = OnceLock::new();

fn ff() -> Result<&'static Ff, String> {
    FF.get_or_init(|| {
        let dir = dll_dir()?;
        let t = std::time::Instant::now();
        let ff = Ff::load(&dir)?;
        let v = unsafe { (ff.avcodec_version)() };
        log::info!(
            "[RC] FFmpeg 后端符号加载完成（{}，libavcodec {}.{}/加载+解析 {:?}）",
            dir.display(),
            v >> 16,
            (v & 0xFF00) >> 8,
            t.elapsed()
        );
        Ok(ff)
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// 编码器私有参数集（`AV_OPT_SEARCH_CHILDREN` 下发）。
type PrivOpts = &'static [(&'static str, &'static str)];

/// 编码器候选：**顺序即探测顺序**。nvenc 最快失败且机器保有量最大放最前；
/// qsv 建会话 1.4~1.7s 放最后（只在前面全失败时才付这笔钱）；amf 需 A 卡。
type Candidate = (&'static str, PrivOpts, bool);

fn private_options(cand: &Candidate) -> impl Iterator<Item = (&'static str, &'static str)> {
    let nvenc = cand.0.ends_with("_nvenc");
    // zerolatency 只禁止重排序；FFmpeg 默认仍缓存输出。在低 fps 下等待后续
    // 采集会放大帧龄，也会拖住静止精修。所有 NVENC 标准统一覆盖输出等待。
    cand.1.iter().copied().chain([("delay", "0")].into_iter().filter(move |_| nvenc))
}

/// (编码器名, 私有参数, cbr_align)
const H264_CANDIDATES: [Candidate; 3] = [
    (
        "h264_nvenc",
        // P2.2 intra-refresh（2026-09-27）：滚动 I 宏块带代替整帧 IDR，拖动时
        // 码率曲线变平（IDR 尖峰正是拥塞塌窗的引信）。不支持的 DLL/驱动由
        // av_opt_set 的非致命路径忽略；与 ForceKeyFrame 并存（损坏恢复仍可
        // 强制整帧 IDR）。
        // NVENC 默认把强制 I 帧当作普通 intra；新接收流必须用 IDR 才能恢复。
        &[("preset", "p4"), ("tune", "ll"), ("rc", "cbr"), ("rc-lookahead", "0"), ("zerolatency", "1"), ("intra-refresh", "1"), ("forced-idr", "1")],
        false,
    ),
    ("h264_qsv", &[("preset", "veryfast"), ("look_ahead", "0"), ("async_depth", "1")], true),
    ("h264_amf", &[("usage", "lowlatency"), ("quality", "speed"), ("rc", "cbr")], false),
];

/// HEVC 同序同名族（hevc_nvenc / hevc_qsv / hevc_amf）。私有参数与 H264 侧
/// 同名同值——个别不被接受的项由 `av_opt_set` 的非致命路径兜底（debug 日志）。
const HEVC_CANDIDATES: [Candidate; 3] = [
    (
        "hevc_nvenc",
        &[("preset", "p4"), ("tune", "ll"), ("rc", "cbr"), ("rc-lookahead", "0"), ("zerolatency", "1"), ("intra-refresh", "1"), ("forced-idr", "1")],
        false,
    ),
    ("hevc_qsv", &[("preset", "veryfast"), ("look_ahead", "0"), ("async_depth", "1")], true),
    ("hevc_amf", &[("usage", "lowlatency"), ("quality", "speed"), ("rc", "cbr")], false),
];

/// P2.3：AV1 硬编候选（nvenc Turing+ / qsv / amf）。MF 无 AV1，AV1 只走 FF。
const AV1_CANDIDATES: [Candidate; 3] = [
    (
        "av1_nvenc",
        &[("preset", "p4"), ("tune", "ll"), ("rc", "cbr"), ("rc-lookahead", "0")],
        false,
    ),
    ("av1_qsv", &[("preset", "veryfast"), ("async_depth", "1")], true),
    ("av1_amf", &[("usage", "lowlatency"), ("quality", "speed")], false),
];

/// P2.3：AV1 硬编可用性（DLL 是否编入了 av1_nvenc/qsv/amf 之一）。进程内缓存。
/// 探测便宜：只查 find_encoder_by_name，不实例化编码器。
pub fn av1_hw_available() -> bool {
    static AV1: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AV1.get_or_init(|| {
        let Ok(ff) = ff() else {
            return false;
        };
        AV1_CANDIDATES.iter().any(|(name, _, _)| {
            let Ok(cname) = std::ffi::CString::new(*name) else {
                return false;
            };
            !(unsafe { (ff.avcodec_find_encoder_by_name)(cname.as_ptr()) }).is_null()
        })
    })
}

fn candidates(codec: VideoCodec) -> &'static [Candidate] {
    match codec {
        VideoCodec::H264 => &H264_CANDIDATES,
        VideoCodec::Hevc => &HEVC_CANDIDATES,
        VideoCodec::Av1 => &AV1_CANDIDATES,
    }
}

/// 目标流标准 → 期望写进 `ctx->codec_id` 的值（偏移自校验用）。
fn codec_id_of(codec: VideoCodec) -> i32 {
    match codec {
        VideoCodec::H264 => AV_CODEC_ID_H264,
        VideoCodec::Hevc => AV_CODEC_ID_HEVC,
        VideoCodec::Av1 => AV_CODEC_ID_AV1,
    }
}

/// FFmpeg 编码器封装（H264 / HEVC，CPU NV12 路径）。接口镜像
/// [`super::MfH264Encoder`] 的 CPU 路径（同样一个类型吃两种标准）。
pub struct FfEncoder {
    ctx: *mut AVCodecContext,
    frame: *mut AVFrame,
    pkt: *mut AVPacket,
    width: i32,
    height: i32,
    frames_in: u64,
    /// force_key 请求：下一帧 pict_type 置 I（弱网花屏自愈）。
    /// `Cell`：`force_key()` 须保持 `&self`（调用方 `as_ref()` 链），MF 同款语义。
    force_next_idr: std::cell::Cell<bool>,
    dynamic_bitrate: bool,
}

// FF 句柄常驻 + 会话任务串行访问（与 MfH264Encoder 同一约定）。
unsafe impl Send for FfEncoder {}

impl FfEncoder {
    /// 按候选链打开：nvenc → qsv → amf。全部失败返回合并错误。
    ///
    /// 只接 CPU NV12 路径（GPU 零拷贝仍 MF 专属，批 3 才探 hwaccel）。
    pub(in crate::rc) fn open(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        Self::open_mode(codec, width, height, fps, bitrate, false)
    }

    /// 本地录制档（rec/）：峰值受限 VBR——峰值 2×均值、qsv 不再强落 CBR
    ///（rc_max_rate > bit_rate 时 qsvenc 按 VBR 推导）、码率缓冲放宽到 1s
    /// （实时 200ms VBV 会掐掉文件录制的突发画质）。
    pub(in crate::rc) fn open_file(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        Self::open_mode(codec, width, height, fps, bitrate, true)
    }

    fn open_mode(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        vbr: bool,
    ) -> Result<Self, String> {
        let ff = ff()?;
        let mut errs = Vec::new();
        for cand in candidates(codec) {
            match Self::open_one(ff, cand, codec, width, height, fps, bitrate, vbr) {
                Ok(me) => {
                    log::info!(
                        "[RC] FFmpeg 后端选定 {}（{}x{} {}fps {}kbps，候选链其余候选：{}）",
                        cand.0, width, height, fps, bitrate / 1000,
                        if errs.is_empty() { "无".into() } else { errs.join("；") }
                    );
                    return Ok(me);
                }
                Err(e) => {
                    log::debug!("[RC] FFmpeg 候选 {} 打不开：{e}", cand.0);
                    errs.push(format!("{}: {e}", cand.0));
                }
            }
        }
        Err(format!("FFmpeg 三候选全部打不开（{width}x{height} {fps}fps）：{}", errs.join("；")))
    }

    fn open_one(
        ff: &Ff,
        cand: &Candidate,
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        vbr: bool,
    ) -> Result<Self, String> {
        let (codec_name, _, cbr_align) = *cand;
        let cname = CString::new(codec_name).map_err(|_| "编码器名含 NUL")?;
        let codec_def = unsafe { (ff.avcodec_find_encoder_by_name)(cname.as_ptr()) };
        if codec_def.is_null() {
            return Err(format!("本 DLL 未编入 {codec_name}"));
        }
        let ctx = unsafe { (ff.avcodec_alloc_context3)(codec_def) };
        if ctx.is_null() {
            return Err("avcodec_alloc_context3 返回 NULL".into());
        }
        let mut me = Self {
            ctx,
            frame: std::ptr::null_mut(),
            pkt: std::ptr::null_mut(),
            width: width as i32,
            height: height as i32,
            frames_in: 0,
            force_next_idr: std::cell::Cell::new(false),
            dynamic_bitrate: cand.0.ends_with("_nvenc"),
        };
        let (w, h, fp) = (width as i32, height as i32, fps.max(1) as i32);
        unsafe {
            let c = &mut *ctx;
            c.codec_type = AVMEDIA_TYPE_VIDEO;
            c.width = w;
            c.height = h;
            c.pix_fmt = AV_PIX_FMT_NV12;
            // time_base 与 framerate 必须都设：nvenc/qsv 各读一个，
            // 只设一个时另一个是 0/1，产出的 pts 全为 0（时间轴塌掉）。
            c.time_base = AVRational::new(1, fp);
            c.framerate = AVRational::new(fp, 1);
            c.bit_rate = bitrate as i64;
            // 峰值：实时档 = 均值（CBR 口径）；录制档 = 2×均值（突发不糊、静态下沉）。
            let peak = if vbr { bitrate.saturating_mul(2) as i64 } else { bitrate as i64 };
            if cand.0.ends_with("_nvenc") {
                // 默认 VBV 可积攒数秒；桌面实时媒体只给 200ms 码率缓冲。
                c.rc_max_rate = peak;
                c.rc_buffer_size = if vbr {
                    bitrate.max(16_000) as i32
                } else {
                    (bitrate / 5).max(16_000) as i32
                };
            }
            if cbr_align {
                // 🔴 qsv 落 CBR 的唯一入口：rc_max_rate == bit_rate
                //（qsvenc.c:570 select_rc_mode 由公共字段推导，无 rc_mode 私有选项）。
                // 录制档刻意 max > mean ⇒ qsv 按公共字段推导出 VBR。
                c.rc_max_rate = peak;
            }
            // 🔴 再审计 P3-12（2026-09-25）：GOP = fps×1（1s），与 MF 侧
            // `GoPSize=1s`（mf.rs）同口径。曾是 ×2（2s）：解码断链又没等到
            // ForceKeyFrame 时要花 2s 等自然 GOP，弱网花屏时间翻倍。
            c.gop_size = fp; // 1 秒一个关键帧
            c.max_b_frames = 0; // 低延迟：B 帧是延迟的主要来源
            c.thread_count = 1; // 远控单帧延迟优先，不要帧级并行
        }

        // 🔴 结构体偏移自校验（open2 之前）：我们按 #[repr(C)] 偏移写字段，
        // FFmpeg 按它编译进去的偏移读回 —— 两条来源不同，能真正测出抄错没有。
        me.verify_layout(ff, &[
            ("b", bitrate as i64, "bit_rate"),
            ("g", fp as i64, "gop_size"),
            ("bf", 0, "max_b_frames"),
        ])?;
        let cid = unsafe { (*ctx).codec_id };
        let expect_id = codec_id_of(codec);
        if cid != expect_id {
            return Err(format!(
                "ctx->codec_id={cid} ≠ {}({expect_id}) —— codec_id 偏移可能写错",
                codec.as_str()
            ));
        }

        // 恢复 IDR 和输出等待是实时推流的必要条件；其余兼容性参数允许回落。
        for (k, v) in private_options(cand) {
            let (ck, cv) = (CString::new(k).map_err(|_| "参数名含 NUL")?, CString::new(v).map_err(|_| "参数值含 NUL")?);
            let r = unsafe { (ff.av_opt_set)(ctx as *mut c_void, ck.as_ptr(), cv.as_ptr(), AV_OPT_SEARCH_CHILDREN) };
            if r < 0 {
                if k == "forced-idr" || k == "delay" {
                    return Err(format!("{codec_name} 不支持实时推流所需的 {k}={v}：{}", ff.err_str(r)));
                }
                log::debug!("[RC] 参数 {k}={v} 不被 {codec_name} 接受：{}", ff.err_str(r));
            }
        }

        let r = unsafe { (ff.avcodec_open2)(ctx, codec_def, std::ptr::null_mut()) };
        if r < 0 {
            return Err(format!("open2({codec_name} {w}x{h} {}kbps)：{}", bitrate / 1000, ff.err_str(r)));
        }

        // frame：一次分配、逐帧复用
        let frame = unsafe { (ff.av_frame_alloc)() };
        if frame.is_null() {
            return Err("av_frame_alloc 返回 NULL".into());
        }
        me.frame = frame;
        unsafe {
            (*frame).format = AV_PIX_FMT_NV12;
            (*frame).width = w;
            (*frame).height = h;
        }
        let r = unsafe { (ff.av_frame_get_buffer)(frame, 32) };
        if r < 0 {
            return Err(format!("av_frame_get_buffer({w}x{h}) 失败：{} —— 偏移可能写错", ff.err_str(r)));
        }
        let ls_y = unsafe { (*frame).linesize[0] };
        if ls_y < w {
            return Err(format!("linesize[0]={ls_y} < width={w} —— AVFrame 偏移可能写错"));
        }
        let pkt = unsafe { (ff.av_packet_alloc)() };
        if pkt.is_null() {
            return Err("av_packet_alloc 返回 NULL".into());
        }
        me.pkt = pkt;
        Ok(me)
    }

    /// 写字段 → AVOption 读回比对。任一不符即失败（**不能带着错偏移继续**）。
    fn verify_layout(&self, ff: &Ff, expect: &[(&str, i64, &str)]) -> Result<(), String> {
        for (opt, want, field) in expect {
            let ck = CString::new(*opt).map_err(|_| "option 名含 NUL")?;
            let mut got: i64 = -12345;
            let r = unsafe { (ff.av_opt_get_int)(self.ctx as *mut c_void, ck.as_ptr(), 0, &mut got) };
            if r < 0 {
                return Err(format!("自校验：AVOption「{opt}」读不出来（{}）", ff.err_str(r)));
            }
            if got != *want {
                return Err(format!(
                    "🔴 结构体偏移写错：{field} 写了 {want}，FFmpeg 读到 {got}。重跑 offsetof_probe.c 核对 ffi.rs"
                ));
            }
        }
        Ok(())
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width as u32, self.height as u32)
    }

    /// NVENC 在逐帧编码时读取 AVCodecContext 的码率并发起 reconfigure。
    /// QSV/AMF 未经动态重配验证，留给会话层稳定窗口重开。
    pub fn set_bitrate(&mut self, bps: u32) -> bool {
        if !self.dynamic_bitrate { return false; }
        let Ok(ff) = ff() else { return false; };
        for (key, value) in [("b", bps), ("maxrate", bps), ("bufsize", (bps / 5).max(16_000))] {
            let key = CString::new(key).unwrap();
            let value = CString::new(value.to_string()).unwrap();
            if unsafe { (ff.av_opt_set)(self.ctx.cast(), key.as_ptr(), value.as_ptr(), 0) } < 0 { return false; }
        }
        true
    }

    /// 请求下一帧强制 IDR。返回是否受理（FF 侧经 `pict_type` 恒可用）。
    pub fn force_key(&self) -> bool {
        self.force_next_idr.set(true);
        true
    }

    /// 送一帧 NV12（连续布局：Y 平面紧跟交错 UV 平面，主工程 `nv12_buf` 就是这个形态）。
    pub fn encode_nv12(&mut self, nv12: &[u8]) -> Result<Vec<H264Packet>, String> {
        let ff = ff()?;
        let (w, h) = (self.width as usize, self.height as usize);
        let need = w * h * 3 / 2;
        if nv12.len() < need {
            return Err(format!("NV12 缓冲过小：{} < {need}（{w}x{h}）", nv12.len()));
        }
        // 上一帧可能还被编码器内部队列引用（nvenc 异步），改写前必须确保 buffer 独占。
        let r = unsafe { (ff.av_frame_make_writable)(self.frame) };
        if r < 0 {
            return Err(format!("av_frame_make_writable: {}", ff.err_str(r)));
        }
        // 🔴 再审计 B3（2026-09-25）：副作用必须等 send 成功才生效——
        // `frames_in` 自增与 IDR 请求消费过去都在 push 之前完成，第二次
        // EAGAIN 静默丢帧时（见 `push`）pts 出现空洞、force_key 凭空蒸发。
        // 现改为：帧号与 pict_type 仍按当前值写入（send 需要它们），但
        // `frames_in` 只在 push 成功后自增；失败时把 IDR 请求退回，
        // 下一帧重用同一 pts 重试。
        let wanted_idr = self.force_next_idr.replace(false);
        unsafe {
            let f = &mut *self.frame;
            let (ls_y, ls_uv) = (f.linesize[0] as usize, f.linesize[1] as usize);
            let src = nv12.as_ptr();
            if ls_y == w {
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
                    std::ptr::copy_nonoverlapping(src.add(w * h + y * w), f.data[1].add(y * ls_uv), w);
                }
            }
            f.pts = self.frames_in as i64;
            f.pict_type = if wanted_idr {
                AV_PICTURE_TYPE_I
            } else {
                0 // AV_PICTURE_TYPE_NONE：交给编码器
            };
        }
        match self.push(ff) {
            Ok(packets) => {
                self.frames_in += 1;
                Ok(packets)
            }
            Err(e) => {
                // 帧没进编码器（FFmpeg 语义：send 出错时帧不被消费）：
                // pts 不前进（下一帧重用），IDR 请求退回等下次受理。
                self.force_next_idr.set(wanted_idr);
                Err(e)
            }
        }
    }

    /// send → EAGAIN 时 drain 后重试一次 → drain 出全部包。
    fn push(&mut self, ff: &Ff) -> Result<Vec<H264Packet>, String> {
        let mut r = unsafe { (ff.avcodec_send_frame)(self.ctx, self.frame) };
        if r == AVERROR_EAGAIN {
            // 输入队列满：先掏空已产出包再重试（低延迟配置下罕见，但不处理会静默丢帧）
            let mut packets = self.drain(ff)?;
            r = unsafe { (ff.avcodec_send_frame)(self.ctx, self.frame) };
            // 🔴 再审计 B3（2026-09-25）：第二次仍 EAGAIN = 掏空后编码器**还是不收**，
            // 这帧没进编码器。过去 `r != EAGAIN` 才报错、随后照常 return Ok——
            // 帧丢了但调用方以为成功。任何负返回（含 EAGAIN）都必须报错，
            // 让调用方按失败计数（熔断口径），而不是静默丢帧。
            if r < 0 {
                return Err(format!("avcodec_send_frame(重试): {}（{r}）", ff.err_str(r)));
            }
            packets.extend(self.drain(ff)?);
            return Ok(packets);
        }
        if r < 0 {
            return Err(format!("avcodec_send_frame: {}（{r}）", ff.err_str(r)));
        }
        self.drain(ff)
    }

    /// 拉空输出队列。EAGAIN=暂无输出、EOF=彻底结束，都不是错误。
    /// FFmpeg 输出已是 Annex-B（探针逐帧校验过 SPS/PPS/IDR 序列）。
    fn drain(&mut self, ff: &Ff) -> Result<Vec<H264Packet>, String> {
        let mut out = Vec::new();
        loop {
            let r = unsafe { (ff.avcodec_receive_packet)(self.ctx, self.pkt) };
            if r == AVERROR_EAGAIN || r == AVERROR_EOF {
                break;
            }
            if r < 0 {
                return Err(format!("avcodec_receive_packet: {}（{r}）", ff.err_str(r)));
            }
            // 先把要的字段拷出来，再 unref —— unref 之后指针内容不可再读。
            let taken = unsafe {
                let p = &*self.pkt;
                let taken = if p.data.is_null() || p.size <= 0 {
                    None
                } else {
                    Some((
                        std::slice::from_raw_parts(p.data, p.size as usize).to_vec(),
                        p.flags,
                    ))
                };
                (ff.av_packet_unref)(self.pkt);
                taken
            };
            if let Some((data, flags)) = taken {
                out.push(H264Packet {
                    at_ms: 0, // 会话层按无 B 帧的输出顺序回填采集时刻。
                    data,
                    key: flags & AV_PKT_FLAG_KEY != 0,
                    width: self.width as u32,
                    height: self.height as u32,
                });
            }
        }
        Ok(out)
    }
}

impl Drop for FfEncoder {
    fn drop(&mut self) {
        // 符号表常驻进程（FF OnceLock），这里只释放编码器自有对象。
        if let Ok(ff) = ff() {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvenc_output_wait_is_disabled_for_every_codec_and_future_candidates() {
        for codec in [VideoCodec::H264, VideoCodec::Hevc, VideoCodec::Av1] {
            for cand in candidates(codec) {
                let delay = private_options(cand).filter(|(key, _)| *key == "delay").last();
                assert_eq!(delay, cand.0.ends_with("_nvenc").then_some(("delay", "0")));
            }
        }
        assert_eq!(private_options(&("future_nvenc", &[("delay", "2")], false)).last(), Some(("delay", "0")));
    }

    #[test]
    #[ignore = "需要本机 NVENC，验证输出等待而非仅核对参数"]
    fn nvenc_outputs_each_input_without_waiting_for_the_next_capture() {
        for codec in [VideoCodec::H264, VideoCodec::Hevc] {
            let mut enc = FfEncoder::open_one(ff().unwrap(), &candidates(codec)[0], codec, 960, 540, 10, 400_000, false).unwrap();
            let mut pixels = vec![128; 960 * 540 * 3 / 2];
            for n in 0..12 {
                pixels[..128].fill((32 + n * 12) as u8);
                let packets = enc.encode_nv12(&pixels).unwrap();
                assert_eq!(packets.len(), 1, "{} 第 {} 次输入仍在等待下一次采集", codec.as_str(), n + 1);
                assert!(!packets[0].data.is_empty());
            }
        }
    }

    #[test]
    fn ff_dynamic_bitrate_changes_actual_packets_without_reopening() {
        if dll_dir().is_err() { return; }
        let mut enc = FfEncoder::open(VideoCodec::H264, 1280, 720, 30, 4_000_000).unwrap();
        if !enc.dynamic_bitrate { return; } // QSV/AMF 采用稳定窗口重开。
        let ctx = enc.ctx;
        let mut pixels = vec![128; 1280 * 720 * 3 / 2];
        let mut seed = 73u32;
        let mut encode_window = |enc: &mut FfEncoder| {
            let mut bytes = 0usize;
            for frame in 0..120 {
                // 移动块而非每像素白噪声：后者在 QP 上限也可能超过目标码率，
                // 会把压缩能力下限误判为动态重配失效。
                for y in 0..45 {
                    for x in 0..80 {
                        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
                        for dy in 0..16 {
                            pixels[(y * 16 + dy) * 1280 + x * 16..(y * 16 + dy) * 1280 + x * 16 + 16]
                                .fill(seed as u8);
                        }
                    }
                }
                for packet in enc.encode_nv12(&pixels).unwrap() {
                    if frame >= 30 { bytes += packet.data.len(); }
                }
            }
            bytes
        };
        let high = encode_window(&mut enc);
        assert!(enc.set_bitrate(800_000));
        let low = encode_window(&mut enc);
        let mut fresh = FfEncoder::open(VideoCodec::H264, 1280, 720, 30, 800_000).unwrap();
        let fresh_low = encode_window(&mut fresh);
        eprintln!("dynamic bitrate: high={high}B low={low}B fresh={fresh_low}B");
        assert_eq!(enc.ctx, ctx, "动态改码率不能重建编码器");
        assert!(low * 2 < high, "目标下降 80% 后实际出包量必须明显下降");
        assert!(low.abs_diff(fresh_low) < fresh_low / 4,
            "动态修改后的出包量应接近同码率新编码器，不能只看相对旧预算下降");
    }

    /// 真机冒烟（H264/HEVC 各跑一遍）：加载 DLL → 候选链打开 → 编 5 帧渐变
    /// NV12 → 首包必须是 Annex-B。DLL 目录缺失时 skip（CI/无硬件环境不红）。
    /// 开发机跑法：`PASTEPANDA_FF_DLL_DIR=D:/AItool/ffbuild/stripdist cargo test ff_smoke`
    fn smoke(codec: VideoCodec) {
        let (w, h, fps) = (320u32, 240u32, 30u32);
        let mut enc = match FfEncoder::open(codec, w, h, fps, 800_000) {
            Ok(e) => e,
            Err(e) => {
                let no_dll = dll_dir().is_err();
                assert!(
                    no_dll,
                    "FF 后端 {} 打不开但 DLL 目录存在，应查明原因：{e}",
                    codec.as_str()
                );
                eprintln!("skip（无 FFmpeg DLL，环境不支持）：{e}");
                return;
            }
        };
        assert_eq!(enc.size(), (w, h));
        // 渐变 NV12：够编出真实码流，又不会高熵到拖慢测试
        let mut nv12 = vec![0u8; (w * h * 3 / 2) as usize];
        for (i, b) in nv12.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        // 该冒烟也覆盖 QSV/AMF 回落；NVENC 的逐输入出包另由硬件回归钉住。
        let mut first: Option<H264Packet> = None;
        let mut total = 0usize;
        for _ in 0..5 {
            let pkts = enc.encode_nv12(&nv12).expect("编码失败");
            total += pkts.len();
            if first.is_none() {
                first = pkts.into_iter().next();
            }
        }
        assert!(total > 0, "5 帧一个包都没出");
        let p = first.expect("5 帧内没有任何包");
        let annexb = p.data.starts_with(&[0, 0, 0, 1]) || p.data.starts_with(&[0, 0, 1]);
        assert!(
            annexb,
            "输出必须是 Annex-B（首包首字节 {:?}）",
            &p.data[..4.min(p.data.len())]
        );
        // 重建接收流后必须拿到可独立解码的 IDR；只受理请求不代表恢复成功。
        assert!(enc.force_key());
        let mut recovered = None;
        for _ in 0..8 {
            for packet in enc.encode_nv12(&nv12).expect("恢复帧编码失败") {
                if packet.key {
                    recovered = Some(packet);
                }
            }
        }
        let recovered = recovered.expect("force_key 后 8 帧内没有恢复关键帧");
        if codec == VideoCodec::H264 {
            assert!(recovered.data.windows(4).any(|b| b[..3] == [0, 0, 1] && b[3] & 0x1f == 5),
                "H264 恢复关键帧必须包含 IDR NAL，普通 I 帧不能启动新解码器");
        }
    }

    #[test]
    fn ff_smoke_h264() {
        smoke(VideoCodec::H264);
    }

    #[test]
    fn ff_smoke_hevc() {
        smoke(VideoCodec::Hevc);
    }
}
