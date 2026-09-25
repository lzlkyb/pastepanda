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
//! - nvenc 恒 2 帧流水线延迟（流式发送**无累积**，滞后 ≤2 帧间隔）；qsv 1:1
//! - `send` 返回 ≠ 包已出；EAGAIN 是流控不是错误；B 帧=0 下无需 EOF flush
//!   （会话性重开直接丢弃流水线残帧，与 MF 路径行为一致）
//! - `ctx->delay` 自报不可信，判延迟一律用真实出包

use self::ffi::{
    dll_dir, AVMEDIA_TYPE_VIDEO, AVERROR_EAGAIN, AVERROR_EOF, AV_CODEC_ID_H264, AV_CODEC_ID_HEVC,
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

/// (编码器名, 私有参数, cbr_align)
const H264_CANDIDATES: [Candidate; 3] = [
    (
        "h264_nvenc",
        &[("preset", "p4"), ("tune", "ll"), ("rc", "cbr"), ("rc-lookahead", "0"), ("zerolatency", "1")],
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
        &[("preset", "p4"), ("tune", "ll"), ("rc", "cbr"), ("rc-lookahead", "0"), ("zerolatency", "1")],
        false,
    ),
    ("hevc_qsv", &[("preset", "veryfast"), ("look_ahead", "0"), ("async_depth", "1")], true),
    ("hevc_amf", &[("usage", "lowlatency"), ("quality", "speed"), ("rc", "cbr")], false),
];

fn candidates(codec: VideoCodec) -> &'static [Candidate] {
    match codec {
        VideoCodec::H264 => &H264_CANDIDATES,
        VideoCodec::Hevc => &HEVC_CANDIDATES,
    }
}

/// 目标流标准 → 期望写进 `ctx->codec_id` 的值（偏移自校验用）。
fn codec_id_of(codec: VideoCodec) -> i32 {
    match codec {
        VideoCodec::H264 => AV_CODEC_ID_H264,
        VideoCodec::Hevc => AV_CODEC_ID_HEVC,
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
        let ff = ff()?;
        let mut errs = Vec::new();
        for cand in candidates(codec) {
            match Self::open_one(ff, cand, codec, width, height, fps, bitrate) {
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
    ) -> Result<Self, String> {
        let (codec_name, extra, cbr_align) = *cand;
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
            if cbr_align {
                // 🔴 qsv 落 CBR 的唯一入口：rc_max_rate == bit_rate
                //（qsvenc.c:570 select_rc_mode 由公共字段推导，无 rc_mode 私有选项）
                c.rc_max_rate = bitrate as i64;
            }
            c.gop_size = fp * 2; // 2 秒一个关键帧
            c.max_b_frames = 0; // 低延迟：B 帧是延迟的主要来源
            c.thread_count = 1; // 远控单帧延迟优先，不要帧级并行
        }

        // 🔴 结构体偏移自校验（open2 之前）：我们按 #[repr(C)] 偏移写字段，
        // FFmpeg 按它编译进去的偏移读回 —— 两条来源不同，能真正测出抄错没有。
        me.verify_layout(ff, &[
            ("b", bitrate as i64, "bit_rate"),
            ("g", (fp * 2) as i64, "gop_size"),
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

        // 后端私有参数：设不上只 debug 日志（三个后端 option 集不同，不致命）。
        for (k, v) in extra {
            let (ck, cv) = (CString::new(*k).map_err(|_| "参数名含 NUL")?, CString::new(*v).map_err(|_| "参数值含 NUL")?);
            let r = unsafe { (ff.av_opt_set)(ctx as *mut c_void, ck.as_ptr(), cv.as_ptr(), AV_OPT_SEARCH_CHILDREN) };
            if r < 0 {
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
            f.pict_type = if self.force_next_idr.replace(false) {
                AV_PICTURE_TYPE_I
            } else {
                0 // AV_PICTURE_TYPE_NONE：交给编码器
            };
        }
        self.frames_in += 1;
        self.push(ff)
    }

    /// send → EAGAIN 时 drain 后重试一次 → drain 出全部包。
    fn push(&mut self, ff: &Ff) -> Result<Vec<H264Packet>, String> {
        let mut r = unsafe { (ff.avcodec_send_frame)(self.ctx, self.frame) };
        if r == AVERROR_EAGAIN {
            // 输入队列满：先掏空已产出包再重试（低延迟配置下罕见，但不处理会静默丢帧）
            let mut packets = self.drain(ff)?;
            r = unsafe { (ff.avcodec_send_frame)(self.ctx, self.frame) };
            if r < 0 && r != AVERROR_EAGAIN {
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
        // ⚠️ nvenc 恒 2 帧流水线延迟（探针实测首包@第 3 帧）—— 不能按帧断言出包，
        // 只能验「5 帧内出了包 + 包是 Annex-B」。
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
        // force_key 受理路径（弱网花屏自愈的接口契约）
        assert!(enc.force_key());
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
