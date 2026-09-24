//! FFmpeg 结构体定义 —— **偏移全部由 C 编译器实测**，不是读头文件推的。
//!
//! 依据：`D:/AItool/ffbuild/offsetof_probe.c`（编译运行输出）：
//! ```text
//! sizeof(AVCodecContext)=864  sizeof(AVFrame)=424  sizeof(AVPacket)=104
//! AVCodecContext: codec_type=12 codec_id=24 bit_rate=56 flags=64 time_base=84
//!                 framerate=100 delay=108 width=112 height=116 pix_fmt=136
//!                 max_b_frames=200 gop_size=332 rc_buffer_size=448 rc_max_rate=464
//!                 thread_count=656 profile=688 level=692
//! AVFrame:        data=0 linesize=64 extended_data=96 width=104 height=108
//!                 format=116 pts=136 time_base=152
//! AVPacket:       buf=0 pts=8 dts=16 data=24 size=32 stream_index=36 flags=40
//! ```
//!
//! 🔴 **为什么不手抄头文件里的连续前缀**：`AVCodecContext` 的 864 字节里，我们要写的
//! 字段散布在 12…692 之间，中间夹着几百个用不到的字段。想「照抄到 gop_size 为止」
//! 等于要抄几百行且夹着一堆 `#if FF_API_*`；抄错一个类型就是静默读垃圾。
//! 唯一稳的做法是 **实测偏移 + padding + 编译期 `offset_of!` 断言**：
//! 偏移写错 = 编译不过，绝不静默。
//!
//! 🔴 **为什么不用 bindgen**：主工程只有 `tauri-build` 一个 build-dependency
//! （LIBCLANG 是 ocr-rs 的，不是我们的）。为一个可选功能把 bindgen + libclang
//! 变成主工程永久构建前置，代价高于收益。
//!
//! 🔴 **为什么结构体带 padding 而不是只写前缀**：`avcodec_alloc_context3` 返回的是
//! FFmpeg 自己分配的 864 字节对象。我们只写自己那几个偏移、其余原样不动 ——
//! 所以**不需要知道全部字段**，但**必须**保证前缀的 padding 加起来落在正确偏移上。

use std::ffi::c_void;

/// `AVRational`：有理数（time_base / framerate 都用它）。
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AVRational {
    pub num: i32,
    pub den: i32,
}

impl AVRational {
    pub const fn new(num: i32, den: i32) -> Self {
        Self { num, den }
    }
}

impl std::fmt::Display for AVRational {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.num, self.den)
    }
}

/// 与 `libavcodec/avcodec.h` 的 `AVCodecContext` 同大小同布局（只暴露我们写的偏移）。
///
/// ⚠️ 只在 `avcodec_alloc_context3` 返回的**堆对象**上使用，绝不复制/移动它的值
/// （那样会丢掉 padding 之外的字段，且 864 字节的 memcpy 毫无意义）。
#[repr(C)]
pub struct AVCodecContext {
    _pad000: [u8; 12],
    pub codec_type: i32, // offset 12
    _pad016: [u8; 8],
    pub codec_id: i32, // offset 24
    _pad028: [u8; 28],
    pub bit_rate: i64, // offset 56
    pub flags: i32, // offset 64
    _pad068: [u8; 16],
    pub time_base: AVRational, // offset 84
    _pad092: [u8; 8],
    pub framerate: AVRational, // offset 100
    /// 编码器自报的流水线延迟（帧）。**首包延迟问题的第一手证据** ——
    /// 软编 MFT 当年就是栽在 17 帧累积延迟上。
    pub delay: i32, // offset 108
    pub width: i32, // offset 112
    pub height: i32, // offset 116
    _pad120: [u8; 16],
    pub pix_fmt: i32, // offset 136
    _pad140: [u8; 60],
    pub max_b_frames: i32, // offset 200
    _pad204: [u8; 128],
    pub gop_size: i32, // offset 332
    _pad336: [u8; 112],
    pub rc_buffer_size: i32, // offset 448
    _pad452: [u8; 12],
    pub rc_max_rate: i64, // offset 464
    _pad472: [u8; 184],
    pub thread_count: i32, // offset 656
    _pad660: [u8; 28],
    pub profile: i32, // offset 688
    pub level: i32, // offset 692
    _tail: [u8; 168], // 696..864
}

/// 与 `libavutil/frame.h` 的 `AVFrame` 同大小同布局。
#[repr(C)]
pub struct AVFrame {
    pub data: [*mut u8; AV_NUM_DATA_POINTERS], // offset 0
    pub linesize: [i32; AV_NUM_DATA_POINTERS], // offset 64
    pub extended_data: *mut *mut u8,           // offset 96
    pub width: i32,                            // offset 104
    pub height: i32,                           // offset 108
    pub nb_samples: i32,                       // offset 112
    pub format: i32,                           // offset 116
    _pad120: [u8; 16],
    pub pts: i64, // offset 136
    _pad144: [u8; 8],
    pub time_base: AVRational, // offset 152
    _tail: [u8; 264],          // 160..424
}

/// 与 `libavcodec/packet.h` 的 `AVPacket` 同大小同布局（只暴露要读的字段）。
#[repr(C)]
pub struct AVPacket {
    pub buf: *mut c_void, // offset 0
    pub pts: i64,         // offset 8
    pub dts: i64,         // offset 16
    pub data: *mut u8,    // offset 24
    pub size: i32,        // offset 32
    pub stream_index: i32, // offset 36
    pub flags: i32,       // offset 40
    _pad044: [u8; 4],
    pub side_data: *mut c_void, // offset 48
    pub side_data_elems: i32,   // offset 56
    _tail: [u8; 44],            // 60..104
}

// ── 常量（来自 offsetof_probe 输出，必须逐一对上）──────────────────────────
pub const AV_NUM_DATA_POINTERS: usize = 8;
pub const AV_PIX_FMT_NV12: i32 = 23;
pub const AV_PIX_FMT_BGRA: i32 = 28;
pub const AV_PIX_FMT_YUV420P: i32 = 0;
pub const AVMEDIA_TYPE_VIDEO: i32 = 0;
pub const AV_CODEC_ID_H264: i32 = 27;
pub const AV_PKT_FLAG_KEY: i32 = 1;
/// `AVERROR(EAGAIN)`：输出还没准备好 / 输入暂不接收。**不是错误**，是流程信号。
pub const AVERROR_EAGAIN: i32 = -11;
/// `AVERROR_EOF`：已 flush 完。
pub const AVERROR_EOF: i32 = -541_478_725;

// ── 编译期钉死：任一处 padding 算错，这里立刻编不过 ──────────────────────
const _: () = {
    use std::mem::{offset_of, size_of};

    assert!(size_of::<AVCodecContext>() == 864);
    assert!(offset_of!(AVCodecContext, codec_type) == 12);
    assert!(offset_of!(AVCodecContext, codec_id) == 24);
    assert!(offset_of!(AVCodecContext, bit_rate) == 56);
    assert!(offset_of!(AVCodecContext, flags) == 64);
    assert!(offset_of!(AVCodecContext, time_base) == 84);
    assert!(offset_of!(AVCodecContext, framerate) == 100);
    assert!(offset_of!(AVCodecContext, delay) == 108);
    assert!(offset_of!(AVCodecContext, width) == 112);
    assert!(offset_of!(AVCodecContext, height) == 116);
    assert!(offset_of!(AVCodecContext, pix_fmt) == 136);
    assert!(offset_of!(AVCodecContext, max_b_frames) == 200);
    assert!(offset_of!(AVCodecContext, gop_size) == 332);
    assert!(offset_of!(AVCodecContext, rc_buffer_size) == 448);
    assert!(offset_of!(AVCodecContext, rc_max_rate) == 464);
    assert!(offset_of!(AVCodecContext, thread_count) == 656);
    assert!(offset_of!(AVCodecContext, profile) == 688);
    assert!(offset_of!(AVCodecContext, level) == 692);

    assert!(size_of::<AVFrame>() == 424);
    assert!(offset_of!(AVFrame, data) == 0);
    assert!(offset_of!(AVFrame, linesize) == 64);
    assert!(offset_of!(AVFrame, extended_data) == 96);
    assert!(offset_of!(AVFrame, width) == 104);
    assert!(offset_of!(AVFrame, height) == 108);
    assert!(offset_of!(AVFrame, format) == 116);
    assert!(offset_of!(AVFrame, pts) == 136);
    assert!(offset_of!(AVFrame, time_base) == 152);

    assert!(size_of::<AVPacket>() == 104);
    assert!(offset_of!(AVPacket, buf) == 0);
    assert!(offset_of!(AVPacket, pts) == 8);
    assert!(offset_of!(AVPacket, dts) == 16);
    assert!(offset_of!(AVPacket, data) == 24);
    assert!(offset_of!(AVPacket, size) == 32);
    assert!(offset_of!(AVPacket, stream_index) == 36);
    assert!(offset_of!(AVPacket, flags) == 40);
};
