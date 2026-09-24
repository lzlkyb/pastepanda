//! FFmpeg C API 的函数指针聚合 —— 全部由 `GetProcAddress` 在运行时解析。
//!
//! 只声明**本探针真正要调**的函数（24 个）。刻意不做全量绑定：
//! 每多一个符号就多一处版本耦合，而接入 F 真正需要的就这些。
//!
//! 调用约定：x64 Windows 只有一种（Microsoft x64），`extern "C"` 与 `extern "system"`
//! 在此目标上等价，用 `"C"` 与 FFmpeg 头文件里的声明形式对应。

use crate::dll::Dll;
use crate::types::{AVCodecContext, AVFrame, AVPacket};
use anyhow::{Context, Result};
use std::ffi::{c_char, c_void, CStr};
use std::path::Path;

/// 不透明类型。我们只要它的指针，从不访问字段（`AVCodec` 的布局不保证稳定）。
#[repr(C)]
pub struct AVCodec {
    _opaque: [u8; 0],
}

// 函数指针类型别名：按下标数参数，末位是返回类型。
// （试过用 macro_rules 在类型位置拼 `fn(args) -> ret`，解析器不接受，改用别名更直白。）
type Fn0<R> = unsafe extern "C" fn() -> R;
type Fn1<A, R> = unsafe extern "C" fn(A) -> R;
type Fn2<A, B, R> = unsafe extern "C" fn(A, B) -> R;
type Fn3<A, B, C, R> = unsafe extern "C" fn(A, B, C) -> R;
type Fn4<A, B, C, D, R> = unsafe extern "C" fn(A, B, C, D) -> R;

pub struct Ff {
    // 🔴 字段声明顺序 = Drop 顺序。avcodec **依赖** avutil，
    // 所以必须先卸 avcodec 再卸 avutil，否则 avcodec 的清理代码会踩到已卸载的 avutil。
    #[allow(dead_code)]
    avcodec_dll: Dll,
    #[allow(dead_code)]
    avutil_dll: Dll,

    // ── libavutil ────────────────────────────────────────────────
    pub avutil_version: Fn0<u32>,
    pub av_version_info: Fn0<*const c_char>,
    pub av_log_set_level: Fn1<i32, ()>,
    pub av_strerror: Fn3<i32, *mut c_char, usize, i32>,
    pub av_frame_alloc: Fn0<*mut AVFrame>,
    pub av_frame_free: Fn1<*mut *mut AVFrame, ()>,
    pub av_frame_unref: Fn1<*mut AVFrame, ()>,
    pub av_frame_get_buffer: Fn2<*mut AVFrame, i32, i32>,
    /// 上一帧可能还被编码器内部队列引用（nvenc 异步），改写前必须确保 buffer 独占。
    pub av_frame_make_writable: Fn1<*mut AVFrame, i32>,
    pub av_opt_set_int: Fn4<*mut c_void, *const c_char, i64, i32, i32>,
    pub av_opt_get_int: Fn4<*mut c_void, *const c_char, i32, *mut i64, i32>,
    pub av_opt_set: Fn4<*mut c_void, *const c_char, *const c_char, i32, i32>,

    // ── libavcodec ───────────────────────────────────────────────
    pub avcodec_version: Fn0<u32>,
    pub avcodec_configuration: Fn0<*const c_char>,
    pub avcodec_get_name: Fn1<i32, *const c_char>,
    pub avcodec_find_encoder_by_name: Fn1<*const c_char, *const AVCodec>,
    pub avcodec_alloc_context3: Fn1<*const AVCodec, *mut AVCodecContext>,
    pub avcodec_free_context: Fn1<*mut *mut AVCodecContext, ()>,
    pub avcodec_open2: Fn3<*mut AVCodecContext, *const AVCodec, *mut c_void, i32>,
    pub avcodec_send_frame: Fn2<*mut AVCodecContext, *const AVFrame, i32>,
    pub avcodec_receive_packet: Fn2<*mut AVCodecContext, *mut AVPacket, i32>,
    pub av_packet_alloc: Fn0<*mut AVPacket>,
    pub av_packet_free: Fn1<*mut *mut AVPacket, ()>,
    pub av_packet_unref: Fn1<*mut AVPacket, ()>,
}

impl Ff {
    /// 加载两个自建 DLL 并解析全部符号。
    ///
    /// `dll_load_dir=true` 时用 `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`
    /// —— **这是必需的**：`avcodec-63.dll` 依赖同目录的 `libvpl-2.dll`，
    /// 而默认搜索顺序不含「被加载 DLL 所在目录」。传 false 可复现失败。
    pub fn load(avcodec_path: &Path, avutil_path: &Path, dll_load_dir: bool) -> Result<Self> {
        // 依赖项先加载（avcodec 需要 avutil）
        let avutil_dll = Dll::load(avutil_path, dll_load_dir)?;
        let avcodec_dll = Dll::load(avcodec_path, dll_load_dir)?;

        macro_rules! s {
            ($dll:expr, $name:ident) => {
                $dll
                    .sym(stringify!($name))
                    .with_context(|| format!("解析 {} 失败", stringify!($name)))?
            };
        }

        Ok(Self {
            avutil_version: s!(avutil_dll, avutil_version),
            av_version_info: s!(avutil_dll, av_version_info),
            av_log_set_level: s!(avutil_dll, av_log_set_level),
            av_strerror: s!(avutil_dll, av_strerror),
            av_frame_alloc: s!(avutil_dll, av_frame_alloc),
            av_frame_free: s!(avutil_dll, av_frame_free),
            av_frame_unref: s!(avutil_dll, av_frame_unref),
            av_frame_get_buffer: s!(avutil_dll, av_frame_get_buffer),
            av_frame_make_writable: s!(avutil_dll, av_frame_make_writable),
            av_opt_set_int: s!(avutil_dll, av_opt_set_int),
            av_opt_get_int: s!(avutil_dll, av_opt_get_int),
            av_opt_set: s!(avutil_dll, av_opt_set),

            avcodec_version: s!(avcodec_dll, avcodec_version),
            avcodec_configuration: s!(avcodec_dll, avcodec_configuration),
            avcodec_get_name: s!(avcodec_dll, avcodec_get_name),
            avcodec_find_encoder_by_name: s!(avcodec_dll, avcodec_find_encoder_by_name),
            avcodec_alloc_context3: s!(avcodec_dll, avcodec_alloc_context3),
            avcodec_free_context: s!(avcodec_dll, avcodec_free_context),
            avcodec_open2: s!(avcodec_dll, avcodec_open2),
            avcodec_send_frame: s!(avcodec_dll, avcodec_send_frame),
            avcodec_receive_packet: s!(avcodec_dll, avcodec_receive_packet),
            av_packet_alloc: s!(avcodec_dll, av_packet_alloc),
            av_packet_free: s!(avcodec_dll, av_packet_free),
            av_packet_unref: s!(avcodec_dll, av_packet_unref),

            avcodec_dll,
            avutil_dll,
        })
    }

    /// FFmpeg 错误码 → 人话。所有 FFI 调用的返回值都必须经它翻译，
    /// 否则日志里只剩 `-22` 这种看不出所以然的东西。
    pub fn err_str(&self, code: i32) -> String {
        let mut buf = [0i8; 256];
        unsafe {
            (self.av_strerror)(code, buf.as_mut_ptr() as *mut c_char, buf.len());
        }
        let s = unsafe { CStr::from_ptr(buf.as_ptr() as *const c_char) };
        s.to_string_lossy().into_owned()
    }

    /// 版本三元组（major, minor, micro）—— `AV_VERSION_*` 宏的展开。
    pub fn version_triple(v: u32) -> (u32, u32, u32) {
        (v >> 16, (v & 0x00FF_00) >> 8, v & 0xFF)
    }
}
