//! FFmpeg 动态加载层：DLL 加载 + 符号表 + 结构体偏移定义。
//!
//! 从 `probe/rc-ff`（2026-09-24 已实测跑通三后端）收编进主工程。三条铁律不变：
//!
//! 1. 🔴 **LoadLibrary 动态加载，绝不静态导入** —— 静态导入会把 avcodec-63.dll
//!    写进 PE Import Directory，Windows loader 在**进程启动时**解析它：文件缺失
//!    （升级残留/杀软/磁盘满）的结果是「整个 app 打不开」而不是「硬件编码不可用」
//!    （与否决掉的打包口径 B 同一坑，见 docs §3.8.8）。
//! 2. 🔴 **结构体偏移全部由 C 编译器实测**（`D:/AItool/ffbuild/offsetof_probe.c`，
//!    FFmpeg 9.0.2 / libavcodec 63），不是读头文件推的。`AVCodecContext` 864 字节里
//!    要写的字段散布在 12…692，「手抄前缀」必错。运行时还有一层
//!    「写字段 → `av_opt_get_int` 读回」的双向自校验兜底（见 [`super`]）。
//! 3. 🔴 **符号只声明真正要调的** —— 每多一个符号就多一处版本耦合。

use std::ffi::{c_char, c_void, CString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

// ── kernel32：永远在位，静态链接它不构成「可选依赖」问题 ─────────────────────
#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(path: *const u16, hfile: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn GetLastError() -> u32;
}

/// 把**被加载 DLL 自身所在目录**加入其依赖搜索路径。
/// 这是 avcodec-63.dll 找到同目录 libvpl-2.dll 的唯一原因（默认搜索顺序不含它）。
const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
/// 让 System32 / 应用目录等标准位置对**依赖**也生效（否则 DLL_LOAD_DIR 是唯一路径）。
const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;

/// 一个已加载的 DLL。句柄加载后只读（GetProcAddress 线程安全），
/// 进程内常驻不卸载（存在 [`super::ffi_state`] 的 `OnceLock` 里，Drop 不会执行）。
pub struct Dll {
    handle: *mut c_void,
    name: String,
}

// 句柄加载后只读，且常驻不卸载 —— 跨线程共享安全。
unsafe impl Send for Dll {}
unsafe impl Sync for Dll {}

impl Dll {
    pub fn load(path: &Path) -> Result<Self, String> {
        let abs = std::fs::canonicalize(path)
            .map_err(|e| format!("DLL 路径不存在或不可访问：{}（{e}）", path.display()))?;
        // canonicalize 在 Windows 上给出 \\?\ 前缀，LoadLibraryExW 能吃下
        let wide: Vec<u16> = abs
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
        };
        if handle.is_null() {
            let err = unsafe { GetLastError() };
            return Err(format!(
                "LoadLibraryExW 失败：{}（GetLastError={err}；{}）",
                abs.display(),
                explain_loader_error(err)
            ));
        }
        Ok(Self {
            handle,
            name: abs
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
        })
    }

    /// 解析符号。失败信息要能直接指向「版本不匹配」而不是干瘪的 not found。
    pub fn sym<T>(&self, name: &str) -> Result<T, String> {
        let cname = CString::new(name).expect("符号名不含 NUL");
        let p = unsafe { GetProcAddress(self.handle, cname.as_ptr() as *const u8) };
        if p.is_null() {
            return Err(format!(
                "符号缺失：{}!{}（DLL 版本不匹配？本 DLL 由 FFmpeg 9.0.2 / libavcodec 63 构建）",
                self.name, name
            ));
        }
        // 函数指针与 *mut c_void 同为 8 字节；T 必须是 extern fn 指针类型。
        Ok(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) })
    }
}

fn explain_loader_error(code: u32) -> &'static str {
    match code {
        126 => "ERROR_MOD_NOT_FOUND：依赖 DLL 找不到（分发目录缺 libvpl-2.dll 等？）",
        127 => "ERROR_PROC_NOT_FOUND：依赖 DLL 里找不到需要的导出",
        193 => "ERROR_BAD_EXE_FORMAT：位数/架构不匹配（x64 进程加载了 x86 DLL？）",
        5 => "ERROR_ACCESS_DENIED：被占用或权限不足",
        _ => "见 Windows 系统错误码表",
    }
}

// ── 结构体定义（偏移 = offsetof_probe.c 实测，改版本必须重跑它）─────────────

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

/// 与 `libavcodec/avcodec.h` 的 `AVCodecContext` 同大小同布局（只暴露我们写的偏移）。
///
/// ⚠️ 只在 `avcodec_alloc_context3` 返回的**堆对象**上通过引用使用，
/// 绝不 Copy/Move 它的值（会丢掉 padding 之外的字段）。
#[repr(C)]
pub struct AVCodecContext {
    _pad000: [u8; 12],
    pub codec_type: i32, // offset 12
    _pad016: [u8; 8],
    pub codec_id: i32, // offset 24
    _pad028: [u8; 28],
    pub bit_rate: i64, // offset 56
    pub flags: i32,    // offset 64
    _pad068: [u8; 16],
    pub time_base: AVRational, // offset 84
    _pad092: [u8; 8],
    pub framerate: AVRational, // offset 100
    /// 编码器自报的流水线延迟（帧）。⚠️ 实测不可信（nvenc 报 0、真实第 3 帧出包），
    /// 只当参考，判延迟一律用真实出包。
    pub delay: i32, // offset 108
    pub width: i32,  // offset 112
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
    pub rc_max_rate: i64, // offset 464（qsv 落 CBR 的唯一入口，见 super）
    _pad472: [u8; 184],
    pub thread_count: i32, // offset 656
    _pad660: [u8; 28],
    pub profile: i32, // offset 688
    pub level: i32,   // offset 692
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
    /// `AVPictureType`（c_int）。force_key 的实现：下一帧置 `AV_PICTURE_TYPE_I`。
    pub pict_type: i32, // offset 120
    _pad124: [u8; 12],
    pub pts: i64, // offset 136
    _pad144: [u8; 8],
    pub time_base: AVRational, // offset 152
    _tail: [u8; 264],          // 160..424
}

/// 与 `libavcodec/packet.h` 的 `AVPacket` 同大小同布局（只暴露要读的字段）。
#[repr(C)]
pub struct AVPacket {
    pub buf: *mut c_void,  // offset 0
    pub pts: i64,          // offset 8
    pub dts: i64,          // offset 16
    pub data: *mut u8,     // offset 24
    pub size: i32,         // offset 32
    pub stream_index: i32, // offset 36
    pub flags: i32,        // offset 40
    _pad044: [u8; 4],
    pub side_data: *mut c_void, // offset 48
    pub side_data_elems: i32,   // offset 56
    _tail: [u8; 44],            // 60..104
}

// ── 常量（来源：offsetof_probe 输出 / FFmpeg 头文件，逐一对上）──────────────
const AV_NUM_DATA_POINTERS: usize = 8;
pub const AV_PIX_FMT_NV12: i32 = 23;
pub const AVMEDIA_TYPE_VIDEO: i32 = 0;
pub const AV_CODEC_ID_H264: i32 = 27;
/// `AV_CODEC_ID_HEVC`（枚举实际值 172，非 H264+1；2026-09-24 用真头文件编译探针取得）。
pub const AV_CODEC_ID_HEVC: i32 = 172;
pub const AV_PICTURE_TYPE_I: i32 = 1;
pub const AV_PKT_FLAG_KEY: i32 = 1;
/// `AVERROR(EAGAIN)`：输出还没准备好 / 输入暂不接收。**不是错误**，是流程信号。
pub const AVERROR_EAGAIN: i32 = -11;
/// `AVERROR_EOF`：已 flush 完。
pub const AVERROR_EOF: i32 = -541_478_725;
/// `AV_LOG_ERROR`：把 FFmpeg 自带日志压到只剩错误（默认 INFO 会刷屏）。
const AV_LOG_ERROR: i32 = 16;

// ── 编译期钉死：任一处 padding 算错，这里立刻编不过 ─────────────────────────
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
    assert!(offset_of!(AVFrame, pict_type) == 120);
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

// ── 符号表 ──────────────────────────────────────────────────────────────────

/// 不透明类型：只要指针，从不访问字段（`AVCodec` 布局不保证稳定）。
#[repr(C)]
pub struct AVCodec {
    _opaque: [u8; 0],
}

type Fn0<R> = unsafe extern "C" fn() -> R;
type Fn1<A, R> = unsafe extern "C" fn(A) -> R;
type Fn2<A, B, R> = unsafe extern "C" fn(A, B) -> R;
type Fn3<A, B, C, R> = unsafe extern "C" fn(A, B, C) -> R;
type Fn4<A, B, C, D, R> = unsafe extern "C" fn(A, B, C, D) -> R;

/// FFmpeg C API 的函数指针聚合。字段声明顺序 = Drop 顺序：
/// **avcodec 必须先于 avutil 卸载**（avcodec 的清理会踩 avutil）。
/// 实际上本层常驻进程不卸载，这条只是保住正确性余量。
pub struct Ff {
    #[allow(dead_code)]
    avcodec_dll: Dll,
    #[allow(dead_code)]
    avutil_dll: Dll,

    // ── libavutil ──
    pub av_log_set_level: Fn1<i32, ()>,
    pub av_strerror: Fn3<i32, *mut c_char, usize, i32>,
    pub av_frame_alloc: Fn0<*mut AVFrame>,
    pub av_frame_free: Fn1<*mut *mut AVFrame, ()>,
    pub av_frame_make_writable: Fn1<*mut AVFrame, i32>,
    pub av_frame_get_buffer: Fn2<*mut AVFrame, i32, i32>,
    pub av_opt_set: Fn4<*mut c_void, *const c_char, *const c_char, i32, i32>,
    pub av_opt_get_int: Fn4<*mut c_void, *const c_char, i32, *mut i64, i32>,

    // ── libavcodec ──
    pub avcodec_version: Fn0<u32>,
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

// 字段全是函数指针 + 只读句柄，跨线程共享安全。
unsafe impl Send for Ff {}
unsafe impl Sync for Ff {}

impl Ff {
    /// 从 `dir` 加载 avutil + avcodec 并解析全部符号。
    /// 依赖项先加载（avcodec 需要 avutil）。
    pub(crate) fn load(dir: &Path) -> Result<Self, String> {
        let avutil_dll = Dll::load(&dir.join("avutil-61.dll"))?;
        let avcodec_dll = Dll::load(&dir.join("avcodec-63.dll"))?;

        macro_rules! s {
            ($dll:expr, $name:ident) => {
                $dll.sym(stringify!($name))?
            };
        }

        let ff = Self {
            av_log_set_level: s!(avutil_dll, av_log_set_level),
            av_strerror: s!(avutil_dll, av_strerror),
            av_frame_alloc: s!(avutil_dll, av_frame_alloc),
            av_frame_free: s!(avutil_dll, av_frame_free),
            av_frame_make_writable: s!(avutil_dll, av_frame_make_writable),
            av_frame_get_buffer: s!(avutil_dll, av_frame_get_buffer),
            av_opt_set: s!(avutil_dll, av_opt_set),
            av_opt_get_int: s!(avutil_dll, av_opt_get_int),
            avcodec_version: s!(avcodec_dll, avcodec_version),
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
        };
        unsafe { (ff.av_log_set_level)(AV_LOG_ERROR) };
        Ok(ff)
    }

    /// FFmpeg 错误码 → 人话。所有 FFI 返回值都必须经它翻译，
    /// 否则日志里只剩 `-22` 这种看不出所以然的东西。
    pub fn err_str(&self, code: i32) -> String {
        let mut buf = [0i8; 256];
        unsafe {
            (self.av_strerror)(code, buf.as_mut_ptr() as *mut c_char, buf.len());
        }
        let s = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr() as *const c_char) };
        s.to_string_lossy().into_owned()
    }
}

/// DLL 所在目录探测：env 覆盖 > 打包/开发各候选。返回第一个含 avcodec-63.dll 的目录。
///
/// 候选说明：
/// - env `PASTEPANDA_FF_DLL_DIR`：开发/测试时显式指到 `D:/AItool/ffbuild/stripdist`；
/// - `exe_dir/ffmpeg`：打包形态（tauri.conf.json `resources/ffmpeg/* → resources/ffmpeg`，
///   Windows 上 resource_dir = exe 所在目录）；
/// - `exe_dir/resources/ffmpeg`：tauri dev 把 resources 复制到 target 时的形态。
pub(crate) fn dll_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("PASTEPANDA_FF_DLL_DIR") {
        let p = PathBuf::from(&d);
        if p.join("avcodec-63.dll").exists() {
            return Ok(p);
        }
        log::warn!("[RC] PASTEPANDA_FF_DLL_DIR={d} 里没有 avcodec-63.dll，忽略");
    }
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("拿不到当前 exe 路径：{e}"))?
        .parent()
        .ok_or("exe 路径无父目录")?
        .to_path_buf();
    for cand in [
        exe_dir.join("ffmpeg"),
        exe_dir.join("resources").join("ffmpeg"),
        exe_dir.clone(),
    ] {
        if cand.join("avcodec-63.dll").exists() {
            return Ok(cand);
        }
    }
    Err("未找到 FFmpeg DLL 目录（avcodec-63.dll）——FF 硬编后端不可用".into())
}
