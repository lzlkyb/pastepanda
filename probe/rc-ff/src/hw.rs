//! hwaccel 探针（批 3 前置实验）：D3D11 设备共享 + 纹理直喂 nvenc。
//!
//! 🔴 探针**没做过**的真未知量，六个阶段逐一定钉：
//!   S1  D3D11 设备自建（模拟主工程 dxgi 路径的设备形态）
//!   S2  **设备共享**：`av_hwdevice_ctx_alloc(D3D11VA)` + 手填
//!        `AVD3D11VADeviceContext.device` + `av_hwdevice_ctx_init` ——
//!        `d3d11va_device_create` 只会自建设备，收外部指针只有这条路
//!   S3  frames 池（NV12 / BGRA）：池纹理的 bind flags 是什么
//!   S4  nvenc D3D11-NV12：CPU→GPU upload（`av_hwframe_transfer_data`）逐帧计时
//!   S5  nvenc D3D11-BGRA：BGRA 纹理直喂（真零拷贝的输入格式，无需 swscale）
//!   S6  **外部纹理包装**：主工程 dxgi 复制纹理的形态（data[0]=texture,
//!        data[1]=subResourceIndex），正/负对照（有无 RENDER_TARGET bind）
//!
//! 判据：与 MF GPU 基线（1440p=10.08 / 1080p=7.15 ms/帧）和 FF CPU 路径
//! （nvenc 1440p screen 6.29 ms）比，回答「批 3 值不值得做、按什么形态做」。
//!
//! 🔴 零依赖纪律不变：不引 windows crate。D3D11 只声明一个
//!    `D3D11CreateDevice`；COM 调用走 vtable 下标（QueryInterface=0、AddRef=1、
//!    Release=2、CreateTexture2D=5 —— ID3D11Device 的固定槽位）。

use crate::api::Ff;
use crate::types::*;
use anyhow::{bail, Result};
use std::ffi::{c_void, CString};
use std::time::Instant;

// ── D3D11 常量（minwin / d3d11.h）───────────────────────────────────────────
const D3D_DRIVER_TYPE_HARDWARE: u32 = 1;
const D3D11_CREATE_DEVICE_BGRA_SUPPORT: u32 = 0x20;
const D3D11_CREATE_DEVICE_VIDEO_SUPPORT: u32 = 0x800;
const D3D11_SDK_VERSION: u32 = 7;
// 🔴 DXGI 常量取证：Windows Kits 10.0.26100.0/shared/dxgiformat.h（勿凭记忆写，
//    曾把 NV12 记成 65，真实 103 —— 引发 user-texture mismatch 之谜）
const DXGI_FORMAT_NV12: u32 = 103;
const DXGI_FORMAT_B8G8R8A8_UNORM: u32 = 87;
const D3D11_BIND_RENDER_TARGET: u32 = 0x20;
const D3D11_BIND_UNORDERED_ACCESS: u32 = 0x80;
const D3D11_BIND_SHADER_RESOURCE: u32 = 0x8;

#[link(name = "d3d11")]
extern "system" {
    fn D3D11CreateDevice(
        adapter: *mut c_void,
        driver_type: u32,
        software: *mut c_void,
        flags: u32,
        feature_levels: *const u32,
        num_feature_levels: u32,
        sdk_version: u32,
        device: *mut *mut c_void,
        feature_level: *mut u32,
        immediate_context: *mut *mut c_void,
    ) -> i32;
}

/// COM vtable 取函数指针：slot 0=QueryInterface 1=AddRef 2=Release。
/// ID3D11Device：3=CreateBuffer 4=CreateTexture1D **5=CreateTexture2D**。
unsafe fn com_slot(obj: *mut c_void, slot: usize) -> *mut c_void {
    let vt = *(obj as *const *mut *mut c_void);
    *vt.add(slot)
}

unsafe fn com_add_ref(obj: *mut c_void) {
    let f: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(com_slot(obj, 1));
    f(obj);
}

#[repr(C)]
struct D3d11TexDesc {
    width: u32,
    height: u32,
    mip_levels: u32,
    array_size: u32,
    format: u32,
    sample_desc: [u32; 2],
    usage: u32,
    bind_flags: u32,
    cpu_access_flags: u32,
    misc_flags: u32,
}

unsafe fn create_tex(
    device: *mut c_void,
    w: i32,
    h: i32,
    dxgi_format: u32,
    bind_flags: u32,
    array_size: u32,
) -> Result<*mut c_void> {
    let desc = D3d11TexDesc {
        width: w as u32,
        height: h as u32,
        mip_levels: 1,
        array_size,
        format: dxgi_format,
        sample_desc: [1, 0],
        usage: 0, // D3D11_USAGE_DEFAULT
        bind_flags,
        cpu_access_flags: 0,
        misc_flags: 0,
    };
    let f: unsafe extern "system" fn(*mut c_void, *const D3d11TexDesc, *const c_void, *mut *mut c_void) -> i32 =
        std::mem::transmute(com_slot(device, 5));
    let mut tex: *mut c_void = std::ptr::null_mut();
    let hr = f(device, &desc, std::ptr::null(), &mut tex);
    if hr < 0 {
        bail!("CreateTexture2D 失败 hr=0x{hr:08X}");
    }
    Ok(tex)
}

// ── 编码器（D3D11 输入版，镜像 enc.rs 的 open/offsets 校验）─────────────────

struct HwEnc {
    ctx: *mut AVCodecContext,
    pkt: *mut AVPacket,
    frames_in: u64,
}

const AV_OPT_SEARCH_CHILDREN: i32 = 1;

impl HwEnc {
    /// nvenc + D3D11 帧。`frames_ref` 必须在 open **之前** init 完
    ///（nvenc_open 在 open2 里就按 frames_ctx 的 sw_format 决定 NVENC buffer 格式）。
    unsafe fn open_nvenc_d3d11(ff: &Ff, frames_ref: *mut AVBufferRef, fps: i32, bitrate: i64) -> Result<Self> {
        let cname = CString::new("h264_nvenc")?;
        let codec = (ff.avcodec_find_encoder_by_name)(cname.as_ptr());
        if codec.is_null() {
            bail!("找不到 h264_nvenc");
        }
        let ctx = (ff.avcodec_alloc_context3)(codec);
        if ctx.is_null() {
            bail!("avcodec_alloc_context3 返回 NULL");
        }
        let c = &mut *ctx;
        c.codec_type = AVMEDIA_TYPE_VIDEO;
        c.width = (*(*frames_ref).data.cast::<AVHWFramesContext>()).width;
        c.height = (*(*frames_ref).data.cast::<AVHWFramesContext>()).height;
        c.pix_fmt = AV_PIX_FMT_D3D11;
        c.time_base = AVRational::new(1, fps);
        c.framerate = AVRational::new(fps, 1);
        c.bit_rate = bitrate;
        c.gop_size = fps * 2;
        c.max_b_frames = 0;
        c.thread_count = 1;
        // 🔴 D3D11 输入的关键一格：编码器按 hw_frames_ctx 找纹理池
        c.hw_frames_ctx = (ff.av_buffer_ref)(frames_ref).cast::<c_void>();
        let mut me = Self { ctx, pkt: std::ptr::null_mut(), frames_in: 0 };
        me.verify_layout(ff)?;
        for (k, v) in [("preset", "p4"), ("tune", "ll"), ("rc", "cbr"), ("rc-lookahead", "0"), ("zerolatency", "1")] {
            let (ck, cv) = (CString::new(k)?, CString::new(v)?);
            let r = (ff.av_opt_set)(ctx.cast::<c_void>(), ck.as_ptr(), cv.as_ptr(), AV_OPT_SEARCH_CHILDREN);
            if r < 0 {
                println!("    (nvenc 不认 {k}={v}: {})", ff.err_str(r));
            }
        }
        let r = (ff.avcodec_open2)(ctx, codec, std::ptr::null_mut());
        if r < 0 {
            bail!("open2(h264_nvenc D3D11)：{}", ff.err_str(r));
        }
        me.pkt = (ff.av_packet_alloc)();
        Ok(me)
    }

    /// 写字段 → AVOption 读回（同 enc.rs，防偏移抄错）。
    unsafe fn verify_layout(&self, ff: &Ff) -> Result<()> {
        for (opt, want, field) in [("b", (*self.ctx).bit_rate, "bit_rate"), ("g", (*self.ctx).gop_size as i64, "gop_size")] {
            let ck = CString::new(opt)?;
            let mut got: i64 = -12345;
            let r = (ff.av_opt_get_int)(self.ctx.cast::<c_void>(), ck.as_ptr(), 0, &mut got);
            if r < 0 || got != want {
                bail!("偏移自校验失败：{field} 写 {want} 读 {got}（{r}）");
            }
        }
        Ok(())
    }
}

impl Drop for HwEnc {
    fn drop(&mut self) {
        // 进程级探针：不逐一释放（与 enc.rs 的探针形态一致，避免引入清理顺序噪音）
    }
}

unsafe fn drain(ff: &Ff, enc: &HwEnc, first_packet_frame: &mut Option<u64>) -> Result<usize> {
    let mut n = 0usize;
    loop {
        let r = (ff.avcodec_receive_packet)(enc.ctx, enc.pkt);
        if r == AVERROR_EAGAIN || r == AVERROR_EOF {
            break;
        }
        if r < 0 {
            bail!("receive_packet: {}", ff.err_str(r));
        }
        if (*enc.pkt).size > 0 {
            if first_packet_frame.is_none() {
                *first_packet_frame = Some(enc.frames_in);
            }
            n += 1;
        }
        (ff.av_packet_unref)(enc.pkt);
    }
    Ok(n)
}

// ── 阶段实现 ───────────────────────────────────────────────────────────────

#[repr(C)]
struct Guid { d0: u32, d1: u16, d2: u16, d3: [u8; 8] }

#[link(name = "dxgi")]
extern "system" {
    fn CreateDXGIFactory1(riid: *const Guid, factory: *mut *mut c_void) -> i32;
}

/// 适配器信息 + NV12 bind 能力。
struct AdapterInfo {
    adapter: *mut c_void,
    vendor_id: u32,
    desc: String,
    nv12_rt: bool,
    nv12_dec_srv: bool,
    fl: u32,
}

unsafe fn enumerate_adapters() -> Result<Vec<AdapterInfo>> {
    let iid = Guid { d0: 0x770a_ae78, d1: 0xf26f, d2: 0x4dba, d3: [0xa8,0x29,0x25,0x3c,0x83,0xd1,0xb3,0x87] };
    let mut factory: *mut c_void = std::ptr::null_mut();
    let r = CreateDXGIFactory1(&iid, &mut factory);
    if r < 0 {
        bail!("CreateDXGIFactory1 hr=0x{r:08X}");
    }
    let mut out: Vec<AdapterInfo> = Vec::new();
    for i in 0..8u32 {
        // IDXGIFactory::EnumAdapters = vtable slot 7
        let f: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> i32 =
            std::mem::transmute(com_slot(factory, 7));
        let mut ad: *mut c_void = std::ptr::null_mut();
        if f(factory, i, &mut ad) < 0 || ad.is_null() {
            break;
        }
        // GetDesc = slot 8。DXGI_ADAPTER_DESC：Description[128]WCHAR，VendorId@256，DeviceId@260
        #[repr(C)]
        struct AdDesc { description: [u16; 128], vendor_id: u32, device_id: u32, _rest: [u32; 10] }
        let g: unsafe extern "system" fn(*mut c_void, *mut AdDesc) -> i32 =
            std::mem::transmute(com_slot(ad, 8));
        let mut d = AdDesc { description: [0; 128], vendor_id: 0, device_id: 0, _rest: [0; 10] };
        g(ad, &mut d);
        let len = d.description.iter().position(|&c| c == 0).unwrap_or(128);
        let desc = String::from_utf16_lossy(&d.description[..len]);
        let desc = desc.clone();
        // 该卡上建临时设备测 NV12 bind 能力（FL11_0 / FL11_1 都测）
        let mut cap = String::new();
        for (fl_name, fl) in [("11.0", 0xb000u32), ("11.1", 0xb100u32)] {
            let dev = match create_device_on_fl(ad, fl) {
                Ok(d) => d,
                Err(e) => {
                    cap.push_str(&format!("  [FL{fl_name}: 建设备失败 {e}]"));
                    continue;
                }
            };
            // CheckFormatSupport = ID3D11Device vtable slot 29（官方能力位，不做经验猜测）
            let cfs: unsafe extern "system" fn(*mut c_void, u32, *mut u32) -> i32 =
                std::mem::transmute(com_slot(dev, 29));
            let mut sup: u32 = 0;
            let hr = cfs(dev, DXGI_FORMAT_NV12, &mut sup);
            com_release(dev);
            if hr < 0 {
                cap.push_str(&format!("  [FL{fl_name}: CheckFormatSupport hr=0x{hr:08X}]"));
                continue;
            }
            // D3D11_FORMAT_SUPPORT: SHADER_LOAD=0x800 SHADER_SAMPLE=0x1000
            // RENDER_TARGET=0x100 VIDEO_DECODER=0x2000 TEXTURE2D=0x40
            let rt = sup & 0x100 != 0;
            let ds = sup & 0x2000 != 0 && sup & 0x800 != 0;
            cap.push_str(&format!("  [FL{fl_name}: 支持位=0x{sup:04X} RT={} DEC|SRV={}]", if rt {"✓"} else {"✗"}, if ds {"✓"} else {"✗"}));
            out.push(AdapterInfo { adapter: ad, vendor_id: d.vendor_id, desc: desc.clone(), nv12_rt: rt, nv12_dec_srv: ds, fl });
        }
        println!("    VID {:04X}  {}  {}", d.vendor_id, desc, cap);
    }
    Ok(out)
}

unsafe fn com_release(obj: *mut c_void) {
    let f: unsafe extern "system" fn(*mut c_void) -> i32 = std::mem::transmute(com_slot(obj, 2));
    f(obj);
}

/// 在指定适配器上建 D3D11 设备（DRIVER_TYPE_UNKNOWN）。
unsafe fn create_device_on(adapter: *mut c_void) -> Result<*mut c_void> {
    create_device_on_fl(adapter, 0xb000)
}

unsafe fn create_device_on_fl(adapter: *mut c_void, fl: u32) -> Result<*mut c_void> {
    let mut device: *mut c_void = std::ptr::null_mut();
    let mut imctx: *mut c_void = std::ptr::null_mut();
    let levels = [fl];
    let hr = D3D11CreateDevice(
        adapter, 0 /*D3D_DRIVER_TYPE_UNKNOWN*/, std::ptr::null_mut(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        levels.as_ptr(), 1, D3D11_SDK_VERSION, &mut device, std::ptr::null_mut(), &mut imctx,
    );
    if hr < 0 {
        bail!("D3D11CreateDevice hr=0x{hr:08X}");
    }
    Ok(device)
}

/// S1/S2：枚举适配器 → 选卡（优先 NVIDIA，nvenc 所在）→ hwdevice 共享。
unsafe fn stage_device(
    ff: &Ff,
) -> Result<(*mut c_void, *mut c_void, *mut AVBufferRef)> {
    println!("  适配器清单（NV12 bind 能力逐卡实测）：");
    let adapters = enumerate_adapters()?;
    let mut keep: Vec<AdapterInfo> = Vec::new();
    for a in adapters {
        println!(
            "    VID {:04X}  {}  NV12+RT:{}  NV12+DEC|SRV:{}",
            a.vendor_id, a.desc,
            if a.nv12_rt { "✓" } else { "✗" },
            if a.nv12_dec_srv { "✓" } else { "✗" }
        );
        keep.push(a);
    }
    // 选卡：优先 NVIDIA（0x10DE，nvenc 在它上面），其次任意能建设备的卡
    let chosen = keep
        .iter()
        .find(|a| a.vendor_id == 0x10DE)
        .or_else(|| keep.first())
        .ok_or_else(|| anyhow::anyhow!("没有任何可用适配器"))?;
    println!("  选定适配器：{}（VID {:04X}）", chosen.desc, chosen.vendor_id);
    let adapter = chosen.adapter;
    let device = create_device_on(adapter)?;
    let mut imctx: *mut c_void = std::ptr::null_mut();
    // 取立即上下文（GetImmediateContext = ID3D11Device vtable slot 10）
    let g: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) =
        std::mem::transmute(com_slot(device, 10));
    g(device, &mut imctx);

    let dev_ref = (ff.av_hwdevice_ctx_alloc)(AV_HWDEVICE_TYPE_D3D11VA);
    if dev_ref.is_null() {
        bail!("av_hwdevice_ctx_alloc 返回 NULL");
    }
    let dev_ctx = (*dev_ref).data.cast::<AVHWDeviceContext>();
    if (*dev_ctx).type_ != AV_HWDEVICE_TYPE_D3D11VA {
        bail!("hwdevice type={} ≠ D3D11VA({AV_HWDEVICE_TYPE_D3D11VA})", (*dev_ctx).type_);
    }
    let d3d = (*dev_ctx).hwctx.cast::<AVD3D11VADeviceContext>();
    com_add_ref(device); // init/uninit 语义上会持有引用；探针不 free，保余量
    (*d3d).device = device;
    (*d3d).device_context = imctx;
    (*d3d).bind_flags = 0; // 🔴 不设：bind 由用户纹理自己带（设备级 bind 对 NV12 是毒药）
    let r = (ff.av_hwdevice_ctx_init)(dev_ref);
    if r < 0 {
        bail!("av_hwdevice_ctx_init: {}", ff.err_str(r));
    }
    println!("  设备共享 OK：device={:p} 未被 init 改写", (*d3d).device);
    if (*d3d).device != device {
        bail!("init 后 device 指针被改写 —— 共享语义不成立");
    }
    Ok((device, imctx, dev_ref))
}

/// S3：frames 池。返回 frames_ref。
unsafe fn stage_frames(ff: &Ff, device: *mut c_void, dev_ref: *mut AVBufferRef, sw_format: i32, w: i32, h: i32) -> Result<*mut AVBufferRef> {
    // 经验矩阵：这台设备对 NV12/BGRA 各 bind 组合的真实支持（NVENC 要 RT）。
    let dxgi = if sw_format == AV_PIX_FMT_NV12 { DXGI_FORMAT_NV12 } else { DXGI_FORMAT_B8G8R8A8_UNORM };
    let combos: [(&str, u32); 5] = [
        ("SRV", D3D11_BIND_SHADER_RESOURCE),
        ("RT", D3D11_BIND_RENDER_TARGET),
        ("RT|SRV", D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE),
        ("DEC|SRV", 0x200 | D3D11_BIND_SHADER_RESOURCE),
        ("无", 0),
    ];
    for (name, flags) in combos {
        match create_tex(device, w, h, dxgi, flags, 4) {
            Ok(_) => println!("    CreateTexture2D({name}) OK"),
            Err(e) => println!("    CreateTexture2D({name}) 失败：{e}"),
        }
    }
    let frames_ref = (ff.av_hwframe_ctx_alloc)(dev_ref);
    if frames_ref.is_null() {
        bail!("av_hwframe_ctx_alloc 返回 NULL");
    }
    let fc = (*frames_ref).data.cast::<AVHWFramesContext>();
    (*fc).format = AV_PIX_FMT_D3D11;
    (*fc).sw_format = sw_format;
    (*fc).width = w;
    (*fc).height = h;
    (*fc).initial_pool_size = 4;
    // 🔴 用户自带纹理路径：FFmpeg 内部建纹理在 NV12 上 E_INVALIDARG 已解——
    //   NVIDIA 对 NV12 纹理 bind 有硬约束，只有 DEC|SRV(0x208) 能建
    //   （RT/SRV/RT|SRV/无 全 E_INVALIDARG，实测矩阵见上）。
    //   此路径文档明示：调用方建好 texture array（ArraySize=initial_pool_size），
    //   FFmpeg 只 GetDesc + 包装 —— 主工程接入的正确形态（纹理生命周期归我们管）。
    //   bind 按 sw_format 选：NV12=DEC|SRV；BGRA=RT。
    let tex_bind = if sw_format == AV_PIX_FMT_NV12 {
        0x200 | D3D11_BIND_SHADER_RESOURCE
    } else {
        D3D11_BIND_RENDER_TARGET
    };
    let tex = create_tex(device, w, h, dxgi, tex_bind, 4)?;
    let fh = (*fc).hwctx.cast::<AVD3D11VAFramesContext>();
    (*fh).texture = tex;
    let r = (ff.av_hwframe_ctx_init)(frames_ref);
    if r < 0 {
        // 诊断：GetDesc 我们的纹理 vs FFmpeg ctx 字段逐项对比
        let g: unsafe extern "system" fn(*mut c_void, *mut D3d11TexDesc) =
            std::mem::transmute(com_slot((*fh).texture, 10));
        let mut td = D3d11TexDesc { width: 0, height: 0, mip_levels: 0, array_size: 0, format: 0, sample_desc: [0; 2], usage: 0, bind_flags: 0, cpu_access_flags: 0, misc_flags: 0 };
        g((*fh).texture, &mut td);
        println!("    诊断：tex GetDesc {}x{} fmt={} bind=0x{:X}", td.width, td.height, td.format, td.bind_flags);
        println!("    诊断：FFmpeg ctx format={} sw_format={} {}x{} pool_size={}",
            (*fc).format, (*fc).sw_format, (*fc).width, (*fc).height, (*fc).initial_pool_size);
        // 🔴 决定性取证：wrapper = D3D11VAFramesContext
        //   p(24B)@0 + nb_surfaces@24 + nb_surfaces_used@28 + format@32 + staging@40
        // s->format 是 FFmpeg 从 ctx->sw_format 解出的 d3d_format，mismatch 比较用的就是它。
        let s_fmt = std::ptr::read_volatile(fh.byte_add(32).cast::<u32>());
        let raw_sw = std::ptr::read_volatile(fc.byte_add(64).cast::<i32>());
        println!("    诊断：wrapper s->format(fh+32)={} raw fc+64(sw_format)={} hwctx={:p}", s_fmt, raw_sw, (*fc).hwctx);
        bail!("av_hwframe_ctx_init: {}", ff.err_str(r));
    }
    println!(
        "  frames 池 {}x{} sw={} OK",
        w, h, sw_format
    );
    let mut f = (ff.av_frame_alloc)();
    let r = (ff.av_hwframe_get_buffer)(frames_ref, f, 0);
    if r < 0 {
        bail!("av_hwframe_get_buffer: {}", ff.err_str(r));
    }
    println!(
        "    get_buffer：data[0]={:p} data[1]={:p}（data[1] 应为纹理数组下标）",
        (*f).data[0], (*f).data[1]
    );
    (ff.av_frame_unref)(f);
    (ff.av_frame_free)(&mut f);
    Ok(frames_ref)
}

/// S4/S5：upload 路径计时（CPU sw 帧 → transfer_data → GPU 编码）。
unsafe fn stage_upload(
    ff: &Ff,
    frames_ref: *mut AVBufferRef,
    sw_format: i32,
    name: &str,
    w: i32,
    h: i32,
    fps: i32,
    n: usize,
) -> Result<()> {
    println!("  ── {name} ──");
    let mut enc = HwEnc::open_nvenc_d3d11(ff, frames_ref, fps, 8_000_000)?;
    // CPU 源帧（一次填充，逐帧复用：计时目标是上传+编码，不是填充）
    let mut cpu = (ff.av_frame_alloc)();
    (*cpu).format = sw_format;
    (*cpu).width = w;
    (*cpu).height = h;
    let r = (ff.av_frame_get_buffer)(cpu, 32);
    if r < 0 {
        bail!("av_frame_get_buffer(cpu): {}", ff.err_str(r));
    }
    // 渐变填充（与 CPU 路径探针同款）
    let ls = (*cpu).linesize[0] as usize;
    let bpp = if sw_format == AV_PIX_FMT_BGRA { 4 } else { 1 };
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = y * ls + x * bpp;
            let v = ((x * 7 + y * 13) % 251) as u8;
            *(*cpu).data[0].add(i) = v;
            if sw_format == AV_PIX_FMT_BGRA {
                *(*cpu).data[0].add(i + 1) = v;
                *(*cpu).data[0].add(i + 2) = v.wrapping_add(37);
                *(*cpu).data[0].add(i + 3) = 255;
            }
        }
    }
    if sw_format == AV_PIX_FMT_NV12 {
        let uv = (*cpu).data[1];
        for y in 0..(h / 2) as usize {
            for x in 0..w as usize {
                *uv.add(y * (*cpu).linesize[1] as usize + x) = 128;
            }
        }
    }

    let mut hw_frame = (ff.av_frame_alloc)();
    let mut first: Option<u64> = None;
    let mut total_transfer = 0u128;
    let mut total_encode = 0u128;
    let mut total_pkts = 0usize;
    for i in 0..n {
        let t0 = Instant::now();
        let r = (ff.av_hwframe_get_buffer)(frames_ref, hw_frame, 0);
        if r < 0 {
            bail!("get_buffer: {}", ff.err_str(r));
        }
        let r = (ff.av_hwframe_transfer_data)(hw_frame, cpu, 0);
        if r < 0 {
            bail!("transfer_data(CPU→GPU): {}", ff.err_str(r));
        }
        (*hw_frame).pts = i as i64;
        let t1 = Instant::now();
        let r = (ff.avcodec_send_frame)(enc.ctx, hw_frame);
        if r == AVERROR_EAGAIN {
            let _ = drain(ff, &enc, &mut first)?;
            let r2 = (ff.avcodec_send_frame)(enc.ctx, hw_frame);
            if r2 < 0 && r2 != AVERROR_EAGAIN {
                bail!("send_frame(重试): {}", ff.err_str(r2));
            }
        } else if r < 0 {
            bail!("send_frame: {}", ff.err_str(r));
        }
        let pkts = drain(ff, &enc, &mut first)?;
        (ff.av_frame_unref)(hw_frame);
        total_transfer += (t1 - t0).as_micros();
        total_encode += t1.elapsed().as_micros();
        total_pkts += pkts;
        enc.frames_in += 1;
    }
    println!(
        "    {n} 帧：get+transfer 平均 {} µs/帧，send+drain 平均 {} µs/帧，出 {total_pkts} 包，首包@第 {:?} 帧",
        total_transfer / n as u128,
        total_encode / n as u128,
        first
    );
    (ff.av_frame_free)(&mut hw_frame);
    (ff.av_frame_free)(&mut cpu);
    Ok(())
}

/// S6：外部纹理包装（主工程 dxgi 复制纹理的形态）。
unsafe fn stage_wrap(
    ff: &Ff,
    device: *mut c_void,
    frames_ref: *mut AVBufferRef,
    w: i32,
    h: i32,
    fps: i32,
    n: usize,
) -> Result<()> {
    println!("  ── 外部 NV12 纹理 + RENDER_TARGET（正对照）──");
    let tex = create_tex(device, w, h, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, 1)?;
    run_wrapped(ff, frames_ref, tex, w, h, fps, n)?;

    println!("  ── 外部 NV12 纹理，无 RENDER_TARGET（负对照，预期注册失败）──");
    let tex2 = create_tex(device, w, h, DXGI_FORMAT_NV12, D3D11_BIND_SHADER_RESOURCE, 1)?;
    match run_wrapped(ff, frames_ref, tex2, w, h, fps, n) {
        Ok(_) => println!("    ⚠️ 无 RT bind 也能编 —— NVENC 不强制该 flag（负对照推翻预期）"),
        Err(e) => println!("    预期内失败：{e}"),
    }
    Ok(())
}

unsafe fn run_wrapped(
    ff: &Ff,
    frames_ref: *mut AVBufferRef,
    tex: *mut c_void,
    w: i32,
    h: i32,
    fps: i32,
    n: usize,
) -> Result<()> {
    let mut enc = HwEnc::open_nvenc_d3d11(ff, frames_ref, fps, 8_000_000)?;
    let mut f = (ff.av_frame_alloc)();
    (*f).format = AV_PIX_FMT_D3D11;
    (*f).width = w;
    (*f).height = h;
    (*f).hw_frames_ctx = (ff.av_buffer_ref)(frames_ref);
    (*f).data[0] = tex as *mut u8;
    (*f).data[1] = std::ptr::null_mut(); // subResourceIndex = 0
    (*f).buf[0] = (ff.av_buffer_create)(tex as *mut u8, 0, None, std::ptr::null_mut(), 0);
    let mut first: Option<u64> = None;
    let t = Instant::now();
    let mut pkts = 0usize;
    for i in 0..n {
        (*f).pts = i as i64;
        let r = (ff.avcodec_send_frame)(enc.ctx, f);
        if r == AVERROR_EAGAIN {
            let _ = drain(ff, &enc, &mut first)?;
            let r2 = (ff.avcodec_send_frame)(enc.ctx, f);
            if r2 < 0 {
                bail!("send_frame(重试): {}（包装纹理可能没注册上）", ff.err_str(r2));
            }
        } else if r < 0 {
            bail!("send_frame: {}（包装纹理可能没注册上）", ff.err_str(r));
        }
        pkts += drain(ff, &enc, &mut first)?;
        enc.frames_in += 1;
    }
    println!(
        "    {n} 帧（同一纹理重复送）平均 {} µs/帧，出 {pkts} 包，首包@第 {:?} 帧",
        t.elapsed().as_micros() / n as u128,
        first
    );
    (ff.av_frame_free)(&mut f);
    Ok(())
}

/// 批 3 hwaccel 探针入口（`--hw`）。
pub fn run(ff: &Ff, w: i32, h: i32, fps: i32, n: usize) -> Result<()> {
    println!("=== S1/S2 D3D11 设备 + hwdevice 共享 ===");
    let (device, _imctx, dev_ref) = unsafe { stage_device(ff)? };

    println!("=== S3 frames 池 ===");
    let nv12_pool = unsafe { stage_frames(ff, device, dev_ref, AV_PIX_FMT_NV12, w, h)? };
    let bgra_pool = unsafe { stage_frames(ff, device, dev_ref, AV_PIX_FMT_BGRA, w, h)? };

    println!("=== S4/S5 nvenc D3D11 upload 路径（{w}x{h}）===");
    let r = unsafe { stage_upload(ff, nv12_pool, AV_PIX_FMT_NV12, "S4 NV12 upload", w, h, fps, n) };
    if let Err(e) = r {
        println!("    NV12 upload 失败：{e}");
    }
    let r = unsafe { stage_upload(ff, bgra_pool, AV_PIX_FMT_BGRA, "S5 BGRA upload", w, h, fps, n) };
    if let Err(e) = r {
        println!("    BGRA upload 失败：{e}");
    }

    println!("=== S6 外部纹理包装（{w}x{h}）===");
    let r = unsafe { stage_wrap(ff, device, nv12_pool, w, h, fps, n) };
    if let Err(e) = r {
        println!("    外部包装失败：{e}");
    }
    Ok(())
}
