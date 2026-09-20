//! 远程协助画面帧（R1/R3）：截屏 → 降采样 → JPEG；R3 加脏矩形与自适应码率。
//!
//! 同一条 bi-stream：
//! - JSON 以 `{` 开头（信令 / 脏矩形元数据）
//! - JPEG 以 `FF D8` 开头（整帧或裁剪块）

use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder};
use std::sync::Mutex;

pub const MAX_JPEG_BYTES: usize = 2 * 1024 * 1024;
/// H.264 单包上限：4K 关键帧可 >2MB，放宽到 8MB（R5.B）。
pub const MAX_H264_BYTES: usize = 8 * 1024 * 1024;
pub const TARGET_MAX_W: u32 = 1280;
pub const JPEG_QUALITY_DEFAULT: u8 = 55;
pub const JPEG_QUALITY_MIN: u8 = 35;
pub const JPEG_QUALITY_MAX: u8 = 75;
/// 静止判定：每 64×64 块平均绝对差 < 此值视为未变。
const TILE: u32 = 64;
const TILE_DIFF_THRESHOLD: u8 = 8;
/// 脏块占比低于此值才发裁剪；否则整帧。
const DIRTY_RATIO_SEND: f32 = 0.35;
/// 强制关键帧间隔（帧数）。
const KEYFRAME_EVERY: u32 = 30;
/// 静止区高保真回补：画面静止持续这么久才发（一次性，直到画面再变）。
/// Q8：H264 路径的静止 IDR 精修（inbound.rs）也用这个阈值，两路口径一致。
pub(crate) const REFINE_AFTER_MS: i64 = 300;
/// 回补帧的 JPEG 质量——接近视觉无损，远小于 PNG。
const REFINE_QUALITY: u8 = 95;

/// 画质档（被控端编码参数）。
///
/// 方案 A「伪 4K」：`ultra` 编码宽 **2560**（约 2.5K），不是原生 4K；
/// 真 4K 主屏硬编见规划文档 R5（方案 B）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeProfile {
    pub max_w: u32,
    pub interval_ms: u64,
    /// Q3/Q4：本档位偏好的编码标准。true = 硬编 HEVC（打不开自动回落 H.264）。
    /// 目前只有 uhd60 置位：4K60 的 H.264 要 L5.2（解码端兼容性差），HEVC
    /// L5.1 即覆盖且同画质省约一半带宽。其余档位走 H.264（生态最稳）。
    pub hevc: bool,
    /// P1/G5：本档是否该走 D3D11 零拷贝路径。实际走不走还看「单输出」与「GPU 路径
    /// 是否已判死」——三条判据集中在 `inbound::want_zero_copy`。true 只给 fps120 与
    /// uhd60：CPU 管线每帧的读回 + 色彩转换在这两档吃不下（1080p60 CPU 能扛，不置位）。
    pub gpu: bool,
    pub q_min: u8,
    pub q_max: u8,
    pub q_default: u8,
    /// 自适应：近 8 帧均值超过此值则降 quality。
    pub adapt_down: usize,
    /// 自适应：近 8 帧均值低于此值则升 quality。
    pub adapt_up: usize,
}

impl EncodeProfile {
    /// 按档位名取 profile；未知名字回落 `balanced`。
    ///
    /// 🔴 刻意不叫 `from_str`：那会与 `std::str::FromStr::from_str` 撞名，
    /// 而本函数不做解析失败（恒返回 `Self`），语义不同，改名避免误用。
    pub fn of_name(s: &str) -> Self {
        match s {
            "sharp" => Self {
                max_w: 1920,
                interval_ms: 66,
                hevc: false,
                gpu: false,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            "ultra" => Self {
                max_w: 2560,
                interval_ms: 80,
                hevc: false,
                gpu: false,
                q_min: 50,
                q_max: 85,
                q_default: 72,
                adapt_down: 700_000,
                adapt_up: 150_000,
            },
            // uhd：主屏硬编走原生分辨率；JPEG 兜底仍按 2.5K 控带宽（R5.B）
            "uhd" => Self {
                max_w: 2560,
                interval_ms: 50,
                hevc: false,
                gpu: false,
                q_min: 55,
                q_max: 85,
                q_default: 75,
                adapt_down: 800_000,
                adapt_up: 180_000,
            },
            // uhd60（Q4/G5）：原生分辨率 60fps——4K 屏即 4K60。硬编专属体感档：
            // UI 门槛 = 硬件 MFT + HEVC MFT（4K60 的 H.264 要 L5.2，解码端
            // 兼容性差；HEVC L5.1 即覆盖，且同画质省一半带宽）。JPEG 兜底按 2.5K。
            // G5：本档也走 D3D11 零拷贝——4K 每帧 CPU 读回 + BGRA→NV12 转换
            // （约 33MB/帧 × 60）是 CPU 管线跑不到 60fps 的根本原因；抓取纹理
            // 不出显存才谈得上「持续 60」。单输出条件与 fps120 同一门控。
            "uhd60" => Self {
                max_w: 2560,
                interval_ms: 16,
                hevc: true,
                gpu: true,
                q_min: 55,
                q_max: 85,
                q_default: 75,
                adapt_down: 800_000,
                adapt_up: 180_000,
            },
            // fps60：高帧率档（硬编专属体感档）——16ms 节拍 + 提帧上限 60fps。
            // 1080p 全速；4K 硬编跑不满时由编码耗时自适应降频兜底（P1-7）。
            "fps60" => Self {
                max_w: 1920,
                interval_ms: 16,
                hevc: false,
                gpu: false,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            // fps120：高帧率+（P1 零拷贝档，G5 起与 uhd60 共用同一门控）——8ms 节拍。
            // CPU 管线跑不到这个节拍，跑不满时 pace_scale 自动降频
            //（8→16/24/32ms = 120/60/40/30fps）。
            // UI 门槛：单屏 + 硬件 MFT + D3D11 零拷贝路径 + 高刷屏，缺一不显示。
            "fps120" => Self {
                max_w: 1920,
                interval_ms: 8,
                hevc: false,
                gpu: true,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            "smooth" => Self {
                max_w: 960,
                interval_ms: 100,
                hevc: false,
                gpu: false,
                q_min: 25,
                q_max: 55,
                q_default: 40,
                adapt_down: 150_000,
                adapt_up: 30_000,
            },
            // balanced（默认）
            _ => Self {
                max_w: TARGET_MAX_W,
                interval_ms: 100,
                hevc: false,
                gpu: false,
                q_min: JPEG_QUALITY_MIN,
                q_max: JPEG_QUALITY_MAX,
                q_default: JPEG_QUALITY_DEFAULT,
                adapt_down: 220_000,
                adapt_up: 50_000,
            },
        }
    }
}

impl Default for EncodeProfile {
    fn default() -> Self {
        Self::of_name("balanced")
    }
}

impl EncodeProfile {
    /// P1/G5：本条会话是否走 D3D11 零拷贝路径。三条判据，缺一回落 CPU 管线：
    /// ① 档位本身吃不下 CPU 管线（`gpu`：fps120 的 8ms 节拍 / uhd60 的 4K60）；
    /// ② **单输出**——多屏拼接要在 GPU 侧跨屏合成，没有这条路（`dxgi::grab_gpu` 也拒）；
    /// ③ 本会话 GPU 路径没被判死（连续 3 次打不开或编码失败会置位）。
    ///
    /// 做成纯函数/方法是因为**判据错了不会崩**——只会静默跑 CPU 管线，表现为
    /// 「档位给了但跑不满」，这种问题在双机手测里极难定位（见 11.7 的教训）。
    pub fn wants_zero_copy(&self, virtual_screen: bool, gpu_disabled: bool) -> bool {
        self.gpu && !virtual_screen && !gpu_disabled
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameCodec {
    Jpeg,
    H264,
    /// Q3：HEVC Annex-B（Main profile）。与 H264 同一条「元数据 + 裸流」通道，
    /// 仅编码标准不同。
    Hevc,
}

impl FrameCodec {
    /// IPC 批量帧头里的 `codec u8`。前端 `parseFrameBatch` 按同一张表读。
    pub fn as_u8(self) -> u8 {
        match self {
            Self::Jpeg => 0,
            Self::H264 => 1,
            Self::Hevc => 2,
        }
    }

    pub fn of_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Jpeg),
            1 => Some(Self::H264),
            2 => Some(Self::Hevc),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub jpeg: Vec<u8>,
    pub at_ms: i64,
    /// true = 整帧；false = 仅更新区域（由 rect 描述）。
    pub full: bool,
    /// 脏矩形（整帧坐标系）；`full=true` 时为 None。
    pub rect: Option<DirtyRect>,
    /// 编码类型：JPEG / H.264 Annex-B / HEVC Annex-B（Q3）。
    pub codec: FrameCodec,
    /// H.264 关键帧。
    pub key: bool,
    /// P0-2 延迟分段：采集耗时（ms）。0 = 未统计。
    pub cap_ms: u16,
    /// P0-2 延迟分段：编码耗时（ms）。0 = 未统计。
    pub enc_ms: u16,
}

/// 脏矩形（降采样坐标系）。
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct DirtyRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// 自适应质量状态（被控端每会话一份）。
pub struct EncoderState {
    quality: u8,
    last_rgb: Option<(u32, u32, Vec<u8>)>,
    frame_idx: u32,
    recent_sizes: Vec<usize>,
    profile: EncodeProfile,
    /// true=虚拟屏；false=仅主屏（`monitor < 0` 时生效）。
    virtual_screen: bool,
    /// >=0 时抓指定显示器；-1 跟随 virtual_screen。
    monitor: i32,
    /// 最近一次画面真正变化（非回补帧）的时刻；0 = 尚无基准。
    last_change_ms: i64,
    /// 静止期高保真回补已发（画面再变才重置）。
    refined: bool,
}

impl EncoderState {
    pub fn new() -> Self {
        Self::with_profile(EncodeProfile::default(), true)
    }

    pub fn with_profile(profile: EncodeProfile, virtual_screen: bool) -> Self {
        Self {
            quality: profile.q_default,
            last_rgb: None,
            frame_idx: 0,
            recent_sizes: Vec::new(),
            profile,
            virtual_screen,
            monitor: -1,
            last_change_ms: 0,
            refined: false,
        }
    }

    pub fn quality(&self) -> u8 {
        self.quality
    }

    pub fn profile(&self) -> &EncodeProfile {
        &self.profile
    }

    pub fn virtual_screen_flag(&self) -> bool {
        self.virtual_screen
    }

    pub fn monitor(&self) -> i32 {
        self.monitor
    }

    /// 会话中远程改档：换 profile / 截取范围，质量回到新档默认。
    pub fn apply_profile(&mut self, profile: EncodeProfile, virtual_screen: bool) {
        self.profile = profile;
        self.virtual_screen = virtual_screen;
        self.monitor = -1;
        self.quality = profile.q_default;
        self.last_rgb = None;
        self.last_change_ms = 0;
        self.refined = false;
    }

    pub fn apply_monitor(&mut self, monitor: i32) {
        self.monitor = monitor;
        self.virtual_screen = monitor < 0 && self.virtual_screen;
        self.last_rgb = None;
        self.last_change_ms = 0;
        self.refined = false;
    }

    fn adapt(&mut self, size: usize) {
        self.recent_sizes.push(size);
        if self.recent_sizes.len() < 8 {
            return;
        }
        let avg: usize = self.recent_sizes.iter().sum::<usize>() / self.recent_sizes.len();
        self.recent_sizes.clear();
        // 阈值随档位走：ultra/清晰 画面更大，套用 1280 的 220KB 会一直误降质
        if avg > self.profile.adapt_down && self.quality > self.profile.q_min {
            self.quality = self.quality.saturating_sub(5).max(self.profile.q_min);
        } else if avg < self.profile.adapt_up && self.quality < self.profile.q_max {
            self.quality = (self.quality + 3).min(self.profile.q_max);
        }
    }
}

impl Default for EncoderState {
    fn default() -> Self {
        Self::new()
    }
}

/// 一帧编码结果：可能是整帧，也可能是脏矩形。
pub struct Encoded {
    /// 脏矩形时为 Some；整帧为 None。
    pub rect: Option<DirtyRect>,
    /// true = 静止期高保真回补帧（越看越清晰）；不计入码控统计。
    pub refine: bool,
    pub frame: VideoFrame,
}

fn is_jpeg_magic(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == 0xFF && b[1] == 0xD8
}

fn is_json_magic(b: &[u8]) -> bool {
    b.first() == Some(&b'{')
}

/// 发起端合成后再编码给前端用的简单路径（无脏矩形状态）。
pub fn encode_rgba_to_jpeg_simple(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<VideoFrame, String> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("像素数据构造失败")?;
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut buf = Vec::with_capacity(96 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 70)
        .write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG 编码失败：{e}"))?;
    Ok(VideoFrame {
        width,
        height,
        jpeg: buf,
        at_ms: chrono::Utc::now().timestamp_millis(),
        full: true,
        rect: None,
        codec: FrameCodec::Jpeg,
        key: true,
        cap_ms: 0,
        enc_ms: 0,
    })
}

/// 抓屏并编码（带脏矩形与自适应）。按 profile 选虚拟屏或主屏。
pub fn capture_and_encode(state: &mut EncoderState) -> Result<Encoded, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("远程画面目前仅支持 Windows".into())
    }
    #[cfg(target_os = "windows")]
    {
        // 采集时刻（epoch ms）：随帧带到发起端，前端据其算「画面链路延迟」。
        // 必须在抓屏**之前**取，把编码耗时排除在延迟口径之外。
        let ts = chrono::Utc::now().timestamp_millis();
        // P0-2 延迟分段：采集耗时单独记，前端 HUD 能看到「慢在抓还是慢在编」。
        let t0 = std::time::Instant::now();
        let (w, h, rgba) = if state.monitor >= 0 {
            crate::screenshot::capture_monitor_rgba(state.monitor)?
        } else if state.virtual_screen {
            crate::screenshot::capture_virtual_screen_rgba()?
        } else {
            crate::screenshot::capture_primary_screen_rgba()?
        };
        let cap_ms = t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
        // 🔴 所有权直传：抓屏函数产出的 Vec 直接进编码器，
        // 不再为 `&[u8]` 签名白白 clone 一份全屏（4K 一次就是 33MB）。
        let mut out = encode_rgba_ts(state, w as u32, h as u32, rgba, ts)?;
        out.frame.cap_ms = cap_ms;
        Ok(out)
    }
}

/// RGBA → 降采样 →（脏矩形或整帧）JPEG。
pub fn encode_rgba(
    state: &mut EncoderState,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<Encoded, String> {
    encode_rgba_ts(state, width, height, rgba.to_vec(), chrono::Utc::now().timestamp_millis())
}

pub fn encode_rgba_ts(
    state: &mut EncoderState,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    ts: i64,
) -> Result<Encoded, String> {
    if width == 0 || height == 0 {
        return Err("空画面".into());
    }
    let img = image::RgbaImage::from_raw(width, height, rgba).ok_or("像素数据构造失败")?;
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    let max_w = state.profile.max_w;
    let (tw, th) = if width > max_w {
        let th = ((height as u64 * max_w as u64) / width as u64).max(1) as u32;
        (max_w, th)
    } else {
        (width, height)
    };
    let resized = if (tw, th) != (width, height) {
        dyn_img.resize_exact(tw, th, FilterType::Triangle)
    } else {
        dyn_img
    };
    let rgb = resized.to_rgb8();
    let rgb_bytes = rgb.as_raw();
    let now = ts;

    state.frame_idx = state.frame_idx.wrapping_add(1);
    let force_key = state.frame_idx % KEYFRAME_EVERY == 1;

    // 与上一帧比脏块。先算出纯结论再改状态（last_rgb 的借用要跨过 match）。
    enum Compare {
        NoBaseline,
        Resized,
        Static,
        Full,
        Rect(DirtyRect),
    }
    let outcome = if force_key {
        Compare::Full
    } else if let Some((lw, lh, last)) = state.last_rgb.as_ref() {
        if *lw == tw && *lh == th {
            match find_dirty_rect(last, rgb_bytes, tw, th) {
                DirtyOutcome::Static => Compare::Static,
                DirtyOutcome::Full => Compare::Full,
                DirtyOutcome::Rect(r) => Compare::Rect(r),
            }
        } else {
            Compare::Resized
        }
    } else {
        Compare::NoBaseline
    };

    let mut refine_now = false;
    let dirty: Option<DirtyRect> = match outcome {
        Compare::Static => {
            // 静止跳帧（调用方不发送）；但静止持续超过阈值且还没回补过，
            // 就发一帧高保真整帧——「越看越清晰」（AnyDesk 式体验）。
            let since = now.saturating_sub(state.last_change_ms);
            if state.last_change_ms > 0 && !state.refined && since >= REFINE_AFTER_MS {
                refine_now = true;
                state.refined = true; // 一次性：画面再变才复位
                None
            } else {
                return Ok(Encoded {
                    rect: Some(DirtyRect {
                        x: 0,
                        y: 0,
                        w: 0,
                        h: 0,
                    }),
                    refine: false,
                    frame: VideoFrame {
                        width: 0,
                        height: 0,
                        jpeg: Vec::new(),
                        at_ms: ts,
                        full: false,
                        rect: None,
                        codec: FrameCodec::Jpeg,
                        key: false,
                        cap_ms: 0,
                        enc_ms: 0,
                    },
                });
            }
        }
        Compare::Rect(r) => {
            remember_last(state, tw, th, rgb_bytes);
            state.last_change_ms = now;
            state.refined = false;
            Some(r)
        }
        _ => {
            // 整帧（首次 / 尺寸变了 / 强制关键帧）：画面真变了
            remember_last(state, tw, th, rgb_bytes);
            state.last_change_ms = now;
            state.refined = false;
            None
        }
    };

    // 🔴 整帧路径直接借 `rgb` 的缓冲编码，不再 clone 一份全屏；
    // 只有脏矩形裁剪需要自有缓冲。
    let crop;
    let (jpeg_src, out_w, out_h): (&[u8], u32, u32) = if let Some(r) = dirty {
        crop = crop_rgb(rgb_bytes, tw, th, r)?;
        (&crop, r.w, r.h)
    } else {
        (rgb_bytes, tw, th)
    };

    let mut buf = Vec::with_capacity(64 * 1024);
    let enc_quality = if refine_now { REFINE_QUALITY } else { state.quality };
    // P0-2 延迟分段：JPEG 编码耗时单独记
    let enc_t0 = std::time::Instant::now();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, enc_quality)
        .write_image(jpeg_src, out_w, out_h, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG 编码失败：{e}"))?;
    let enc_ms = enc_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
    if buf.len() > MAX_JPEG_BYTES {
        return Err(format!("JPEG 帧过大（{} 字节）", buf.len()));
    }
    // 回补帧不计入码控：它是一次性的画质投资，按它降质会让正常帧跟着遭殃
    if !refine_now {
        state.adapt(buf.len());
    }
    Ok(Encoded {
        rect: dirty,
        refine: refine_now,
        frame: VideoFrame {
            width: out_w,
            height: out_h,
            jpeg: buf,
            at_ms: ts,
            full: dirty.is_none(),
            rect: dirty,
            codec: FrameCodec::Jpeg,
            key: dirty.is_none(),
            cap_ms: 0,
            enc_ms,
        },
    })
}

/// 把当前帧存为下一帧的比较基准。尺寸没变时复用旧缓冲，
/// 免掉每帧一次全屏 clone（原实现 2560 宽一帧白拷 ~20MB）。
fn remember_last(state: &mut EncoderState, tw: u32, th: u32, cur: &[u8]) {
    match state.last_rgb.as_mut() {
        Some((lw, lh, buf)) if *lw == tw && *lh == th => {
            buf.clear();
            buf.extend_from_slice(cur);
        }
        _ => state.last_rgb = Some((tw, th, cur.to_vec())),
    }
}

enum DirtyOutcome {
    Static,
    Full,
    Rect(DirtyRect),
}

fn find_dirty_rect(prev: &[u8], cur: &[u8], w: u32, h: u32) -> DirtyOutcome {
    let tiles_x = w.div_ceil(TILE);
    let tiles_y = h.div_ceil(TILE);
    let mut dirty_tiles = 0u32;
    let mut min_x = u32::MAX;
    let mut min_y = u32::MAX;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let x0 = tx * TILE;
            let y0 = ty * TILE;
            let x1 = (x0 + TILE).min(w);
            let y1 = (y0 + TILE).min(h);
            if tile_dirty(prev, cur, w, x0, y0, x1, y1) {
                dirty_tiles += 1;
                min_x = min_x.min(x0);
                min_y = min_y.min(y0);
                max_x = max_x.max(x1);
                max_y = max_y.max(y1);
            }
        }
    }
    if dirty_tiles == 0 {
        return DirtyOutcome::Static;
    }
    let total = tiles_x * tiles_y;
    let ratio = dirty_tiles as f32 / total.max(1) as f32;
    if ratio >= DIRTY_RATIO_SEND {
        return DirtyOutcome::Full;
    }
    // 外扩 1 块，减少接缝
    let pad = TILE;
    let x0 = min_x.saturating_sub(pad);
    let y0 = min_y.saturating_sub(pad);
    let x1 = (max_x + pad).min(w);
    let y1 = (max_y + pad).min(h);
    if x1 <= x0 || y1 <= y0 {
        return DirtyOutcome::Full;
    }
    DirtyOutcome::Rect(DirtyRect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

/// 单块差分判定：**整块平均差** ≥ 阈值才算脏（与逐像素扫全图的旧语义一致）。
///
/// 剪枝只做「不可能脏」的上界退出：剩余像素全取最大差（255×3）也够不着
/// 阈值时提前收。🔴 不能反向剪——曾写的是「当前和 ≥ 阈值×已扫数就判脏」，
/// 借口「均值只增不减」，可运行均值并不单调（后续小于均值的像素会拉低它）：
/// 块内第 1 个像素 d=100 就立即判脏，全块均值 0.39 本不该脏——微噪点块
/// 永久判脏，静止跳帧与 q95 精修静默失效（2026-09-19 审查 P2）。
fn tile_dirty(prev: &[u8], cur: &[u8], w: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> bool {
    let threshold = TILE_DIFF_THRESHOLD as u64;
    let max_d = (255u64) * 3;
    let total = ((x1 - x0) as u64) * ((y1 - y0) as u64);
    let mut sum = 0u64;
    let mut n = 0u64;
    for y in y0..y1 {
        let row = (y * w) as usize * 3;
        for x in x0..x1 {
            let i = row + (x as usize) * 3;
            if i + 2 >= prev.len() || i + 2 >= cur.len() {
                continue;
            }
            let d = (prev[i] as i32 - cur[i] as i32).abs()
                + (prev[i + 1] as i32 - cur[i + 1] as i32).abs()
                + (prev[i + 2] as i32 - cur[i + 2] as i32).abs();
            sum += d as u64;
            n += 1;
            // 上界剪枝（双向）：
            // 「必然脏」——已扫的差分和就算剩下全 0 也够阈值（拖动整窗时
            //   前几个大差像素就能退出，不必扫完全块）；
            // 「必然静」——剩下全取最大差也够不着阈值。
            // （被越界跳过的像素两头都不计入，等式仍成立。）
            if sum >= threshold * total {
                return true;
            }
            if sum + (total - n) * max_d < threshold * n {
                return false;
            }
        }
    }
    n > 0 && sum >= threshold * n
}

fn crop_rgb(rgb: &[u8], w: u32, h: u32, r: DirtyRect) -> Result<Vec<u8>, String> {
    if r.x + r.w > w || r.y + r.h > h || r.w == 0 || r.h == 0 {
        return Err("脏矩形越界".into());
    }
    let mut out = vec![0u8; (r.w * r.h * 3) as usize];
    for y in 0..r.h {
        let src = ((r.y + y) * w + r.x) as usize * 3;
        let dst = (y * r.w) as usize * 3;
        let n = (r.w as usize) * 3;
        if src + n > rgb.len() {
            return Err("裁剪越界".into());
        }
        out[dst..dst + n].copy_from_slice(&rgb[src..src + n]);
    }
    Ok(out)
}

/// 发起端合成器：整帧替换，脏块贴到缓冲上。
pub struct Compositor {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
}

impl Compositor {
    pub fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            rgb: Vec::new(),
        }
    }

    /// 应用一帧。返回是否产生了新的完整画面。
    pub fn apply(
        &mut self,
        rect: Option<DirtyRect>,
        jpeg: &[u8],
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let img = image::load_from_memory(jpeg).map_err(|e| format!("JPEG 解码失败：{e}"))?;
        let rgb = img.to_rgb8();
        match rect {
            None => {
                self.width = rgb.width();
                self.height = rgb.height();
                self.rgb = rgb.as_raw().clone();
            }
            Some(r) => {
                if self.rgb.is_empty() {
                    // 还没关键帧：忽略脏块
                    return Err("尚未收到关键帧".into());
                }
                if r.x + r.w > self.width || r.y + r.h > self.height {
                    return Err("脏矩形超出画布".into());
                }
                if rgb.width() != r.w || rgb.height() != r.h {
                    return Err("脏块尺寸与元数据不符".into());
                }
                let src = rgb.as_raw();
                for y in 0..r.h {
                    let src_i = (y * r.w) as usize * 3;
                    let dst_i = ((r.y + y) * self.width + r.x) as usize * 3;
                    let n = (r.w as usize) * 3;
                    if src_i + n > src.len() || dst_i + n > self.rgb.len() {
                        return Err("贴块越界".into());
                    }
                    self.rgb[dst_i..dst_i + n].copy_from_slice(&src[src_i..src_i + n]);
                }
            }
        }
        Ok((self.width, self.height, self.rgb.clone()))
    }
}

impl Default for Compositor {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn write_jpeg(s: &mut iroh::endpoint::SendStream, jpeg: &[u8]) -> Result<(), String> {
    if jpeg.is_empty() || jpeg.len() > MAX_JPEG_BYTES || !is_jpeg_magic(jpeg) {
        return Err("非法 JPEG 帧".into());
    }
    write_raw(s, jpeg).await
}

/// 发送 JPEG 帧的采集时间戳（JSON 控制帧），随后应跟 JPEG 数据。
/// 与 `write_dirty_meta` 同一语法位：都是「下一帧 JPEG 的元数据」。
/// P0-2：cap/enc = 采集/编码耗时（ms），发起端 HUD 分段显示。
pub async fn write_vts_meta(
    s: &mut iroh::endpoint::SendStream,
    ts: i64,
    cap_ms: u16,
    enc_ms: u16,
) -> Result<(), String> {
    let b = serde_json::to_vec(
        &serde_json::json!({ "t": "vts", "ts": ts, "cap": cap_ms, "enc": enc_ms }),
    )
    .map_err(|e| e.to_string())?;
    write_raw(s, &b).await
}

/// 发送脏矩形元数据（JSON），随后应跟一块 JPEG。
pub async fn write_dirty_meta(
    s: &mut iroh::endpoint::SendStream,
    r: DirtyRect,
) -> Result<(), String> {
    let meta = serde_json::json!({
        "t": "vrect",
        "x": r.x,
        "y": r.y,
        "w": r.w,
        "h": r.h,
    });
    let b = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    write_raw(s, &b).await
}

/// 发送 H.264/HEVC：先 JSON 元数据（带采集时间戳 ts），再 Annex-B 裸流。
///
/// 🔴 ts 必须传：前端据它算「画面链路延迟」（帧龄 = 展示时刻 - 采集时刻），
/// 丢了这个就只能拿发起端收包时刻充数，编码+网络那段延迟全被藏掉。
/// P0-2：cap/enc = 采集/编码耗时（ms），发起端 HUD 分段显示。
/// P2-1：sq = 帧序号（与数据报通道共用一把尺子）——走流的关键帧到达时，
/// 接收端按它重置数据报重组器，两条路才能无缝衔接。
/// Q3：hevc = true 时元数据带 `"c":"hevc"`——**逐帧**标注编码标准，前端据此
/// 选解码器；旧对端忽略未知字段（也解不了 HEVC，会走它自己的兜底）。
#[allow(clippy::too_many_arguments)]
pub async fn write_h264(
    s: &mut iroh::endpoint::SendStream,
    data: &[u8],
    key: bool,
    width: u32,
    height: u32,
    ts: i64,
    cap_ms: u16,
    enc_ms: u16,
    sq: u32,
    hevc: bool,
) -> Result<(), String> {
    if data.is_empty() {
        return Err("空 H.264 包".into());
    }
    let mut meta = serde_json::json!({
        "t": "h264",
        "key": key,
        "w": width,
        "h": height,
        "n": data.len(),
        "ts": ts,
        "cap": cap_ms,
        "enc": enc_ms,
        "sq": sq,
    });
    if hevc {
        meta["c"] = serde_json::Value::String("hevc".into());
    }
    let b = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    // 4K 关键帧可达数 MB，写停滞超时放宽到 60s（R5.B）
    let stall = if key {
        std::time::Duration::from_secs(60)
    } else {
        std::time::Duration::from_secs(30)
    };
    write_raw_stall(s, &b, stall).await?;
    write_raw_stall(s, data, stall).await
}

async fn write_raw(s: &mut iroh::endpoint::SendStream, bytes: &[u8]) -> Result<(), String> {
    write_raw_stall(s, bytes, std::time::Duration::from_secs(30)).await
}

async fn write_raw_stall(
    s: &mut iroh::endpoint::SendStream,
    bytes: &[u8],
    stall: std::time::Duration,
) -> Result<(), String> {
    // 分块 + 停滞超时：对端不读时流控窗口填满，裸 write_all 会永远阻塞，
    // 进而长期持有调用方持有的 `send.lock()`，把 `end_session`（取锁）一起挂死。
    const CHUNK: usize = 64 * 1024;
    let len = (bytes.len() as u32).to_be_bytes();
    stalled_write(s, &len, "写帧长度", stall).await?;
    for part in bytes.chunks(CHUNK) {
        stalled_write(s, part, "写帧内容", stall).await?;
    }
    Ok(())
}

/// 给一次 write_all 包停滞超时（30s 内一个字节都没动 = 中断）。错误信息指出是停滞而非普通 IO。
async fn stalled_write(
    s: &mut iroh::endpoint::SendStream,
    b: &[u8],
    what: &str,
    stall: std::time::Duration,
) -> Result<(), String> {
    tokio::time::timeout(stall, s.write_all(b))
        .await
        .map_err(|_| {
            format!(
                "{what}：{:.0}s 内停滞（对端未读取，已中断推流）",
                stall.as_secs()
            )
        })?
        .map_err(|e| format!("{what}失败：{e}"))
}

pub enum Incoming {
    Jpeg(VideoFrame),
    Control(Vec<u8>),
    /// R4：H.264/HEVC（Q3）Annex-B 包 + 元数据（ts = 被控端采集时刻，epoch ms；
    /// cap/enc = 采集/编码耗时 ms，P0-2 分段用；sq = 帧序号，P2-1 与数据报
    /// 通道共用——旧对端不发，值为 0 时按「无序号」处理；codec = 编码标准，
    /// Q3 起随帧标注）。
    H264 {
        key: bool,
        width: u32,
        height: u32,
        data: Vec<u8>,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
        sq: u32,
        codec: FrameCodec,
    },
}

pub async fn read_incoming(r: &mut iroh::endpoint::RecvStream) -> Result<Incoming, String> {
    let mut n = [0u8; 4];
    tokio::time::timeout(std::time::Duration::from_secs(30), r.read_exact(&mut n))
        .await
        .map_err(|_| "读帧超时".to_string())?
        .map_err(|e| format!("读帧长度失败：{e}"))?;
    let n = u32::from_be_bytes(n) as usize;
    if n == 0 || n > MAX_JPEG_BYTES {
        return Err(format!("帧长度不合法（{n}）"));
    }
    let mut buf = vec![0u8; n];
    tokio::time::timeout(std::time::Duration::from_secs(30), r.read_exact(&mut buf))
        .await
        .map_err(|_| "读帧内容超时".to_string())?
        .map_err(|e| format!("读帧内容失败：{e}"))?;

    if is_jpeg_magic(&buf) {
        Ok(Incoming::Jpeg(VideoFrame {
            width: 0,
            height: 0,
            jpeg: buf,
            at_ms: chrono::Utc::now().timestamp_millis(),
            full: true,
            rect: None,
            codec: FrameCodec::Jpeg,
            key: true,
            cap_ms: 0,
            enc_ms: 0,
        }))
    } else if is_json_magic(&buf) {
        // h264 元数据后还跟一包裸流
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
            if v.get("t").and_then(|x| x.as_str()) == Some("h264") {
                let key = v.get("key").and_then(|x| x.as_bool()).unwrap_or(false);
                let width = v.get("w").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let height = v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let n = v.get("n").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                let ts = v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0);
                let cap_ms = v.get("cap").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                let enc_ms = v.get("enc").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                let sq = v.get("sq").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                // Q3：编码标准随帧走（缺省 h264 = 旧对端）。前端按这个字段选解码器。
                let codec = match v.get("c").and_then(|x| x.as_str()) {
                    Some("hevc") => FrameCodec::Hevc,
                    _ => FrameCodec::H264,
                };
                if n == 0 || n > MAX_H264_BYTES {
                    return Err("h264 长度不合法".into());
                }
                let mut data = vec![0u8; n];
                tokio::time::timeout(std::time::Duration::from_secs(30), r.read_exact(&mut data))
                    .await
                    .map_err(|_| "读 h264 超时".to_string())?
                    .map_err(|e| format!("读 h264 失败：{e}"))?;
                return Ok(Incoming::H264 {
                    key,
                    width,
                    height,
                    data,
                    ts,
                    cap_ms,
                    enc_ms,
                    sq,
                    codec,
                });
            }
        }
        Ok(Incoming::Control(buf))
    } else {
        Err("无法识别的帧类型".into())
    }
}

/// 线程安全的最近帧槽（发起端）。
pub type FrameSlot = Mutex<Option<VideoFrame>>;

/// 发起端帧出站队列：前端按序批量取走。
///
/// 🔴 为什么不能沿用 `latest_frame` 槽的 latest-wins：
/// H.264 的 P 帧互相引用，丢一帧整条引用链就断了；JPEG 脏块帧丢一块画布就
/// 永久缺一块（直到下一个整帧）。所以帧必须**全序、不丢**地交给前端，
/// 槽位只留给旧命令 `rc_latest_frame` 兼容。
pub struct FrameOutbox {
    q: std::collections::VecDeque<VideoFrame>,
    /// 队列内帧字节总量（H.264 4K 关键帧单帧可达数 MB，光按条数卡
    /// 90 条 = 上百 MB；按字节再卡一道）。
    bytes: usize,
    /// true = 溢出时丢过 H.264 非 key 帧：引用链已断，后续 P 帧全部拦下，
    /// 直到下一个 key 帧（编码器 GOP ≤1s，最多冻结一秒）重新起链。
    corrupt: bool,
}

impl FrameOutbox {
    /// ≈3s@30fps。超限说明前端已经很久没来取（窗口隐藏 / 卡死），
    /// 继续攒只会让恢复后的第一帧延迟无限涨——丢帧断链好过无限延迟。
    pub const CAP: usize = 90;
    /// 字节上限 64MB（≈4K 关键帧 × 20 条）。到线就开始丢最旧的，
    /// 语义与条数溢出一致。
    pub const MAX_BYTES: usize = 64 * 1024 * 1024;

    pub fn new() -> Self {
        Self {
            q: std::collections::VecDeque::new(),
            bytes: 0,
            corrupt: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.q.is_empty()
    }

    pub fn push(&mut self, f: VideoFrame) {
        // 🔴 先弹旧再收新。断链判据看「逐出后的**新队头**」，不看被逐出的帧：
        // P 帧引用的是它的前一帧——被逐出的是谁无所谓，要紧的是活下来的新队头
        // 还有没有解码基准。曾判被逐出的帧：逐出 key 帧时新队头恰是引用它的
        // P 帧，引用链已断却不置 corrupt，花屏帧直发前端（2026-09-19 审查 P2）。
        while self.q.len() >= Self::CAP || (self.bytes >= Self::MAX_BYTES && !self.q.is_empty()) {
            match self.q.pop_front() {
                Some(d) => {
                    self.bytes -= d.jpeg.len();
                    if let Some(head) = self.q.front() {
                        if head.codec == FrameCodec::H264 && !head.key {
                            self.corrupt = true;
                        }
                    }
                }
                None => break,
            }
        }
        if self.corrupt {
            if f.codec == FrameCodec::H264 && !f.key {
                // 引用链已断的 P 帧解出来只能是花屏，拦下别发给前端
                return;
            }
            self.corrupt = false;
        }
        self.bytes += f.jpeg.len();
        self.q.push_back(f);
    }

    pub fn drain(&mut self) -> Vec<VideoFrame> {
        self.bytes = 0;
        self.q.drain(..).collect()
    }

    pub fn clear(&mut self) {
        self.q.clear();
        self.bytes = 0;
        self.corrupt = false;
    }
}

impl Default for FrameOutbox {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, r: u8, g: u8, b: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for _ in 0..w * h {
            v.extend_from_slice(&[r, g, b]);
        }
        v
    }

    fn to_rgba(rgb: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(rgb.len() / 3 * 4);
        for p in rgb.chunks_exact(3) {
            out.extend_from_slice(&[p[0], p[1], p[2], 255]);
        }
        out
    }

    #[test]
    fn static_frame_is_skipped() {
        let mut st = EncoderState::new();
        let w = 128u32;
        let h = 64u32;
        let mut rgba = Vec::new();
        for _ in 0..w * h {
            rgba.extend_from_slice(&[10, 20, 30, 255]);
        }
        let e1 = encode_rgba(&mut st, w, h, &rgba).unwrap();
        assert!(e1.frame.full);
        let e2 = encode_rgba(&mut st, w, h, &rgba).unwrap();
        assert!(e2.frame.jpeg.is_empty(), "静止第二帧应跳过");
    }

    #[test]
    fn 静止超过阈值发一次高保真回补帧() {
        let mut st = EncoderState::new();
        let w = 128u32;
        let h = 64u32;
        let mut rgba = Vec::new();
        for _ in 0..w * h {
            rgba.extend_from_slice(&[10, 20, 30, 255]);
        }
        let t0 = 1_758_000_000_000i64;
        let base = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0).unwrap();
        assert!(base.frame.full);
        // 静止 100ms：仍在阈值内 → 跳帧
        let skip = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0 + 100).unwrap();
        assert!(skip.frame.jpeg.is_empty());
        // 静止 400ms：发一次回补整帧
        let refine = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0 + 400).unwrap();
        assert!(refine.refine, "静止 400ms 应触发回补");
        assert!(refine.frame.full && !refine.frame.jpeg.is_empty());
        // 回补已发：继续静止不再发
        let again = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0 + 800).unwrap();
        assert!(again.frame.jpeg.is_empty(), "回补是一次性的");
        // 画面再变：回补标记复位
        for px in rgba.iter_mut().step_by(3) {
            *px = 200;
        }
        let chg = encode_rgba_ts(&mut st, w, h, rgba, t0 + 1200).unwrap();
        assert!(!chg.frame.jpeg.is_empty());
        assert!(!chg.refine);
    }

    /// G5：零拷贝门控（判据写错不崩，只会静默跑 CPU 管线——所以必须有单测钉住）。
    #[test]
    fn 零拷贝门控_只给高带宽档且要求单输出() {
        // uhd60（4K60）与 fps120（8ms 节拍）走零拷贝；1080p60 留在 CPU（扛得住）
        assert!(EncodeProfile::of_name("uhd60").wants_zero_copy(false, false));
        assert!(EncodeProfile::of_name("fps120").wants_zero_copy(false, false));
        for q in ["fps60", "uhd", "ultra", "sharp", "balanced", "smooth", "auto"] {
            assert!(
                !EncodeProfile::of_name(q).wants_zero_copy(false, false),
                "{q} 不该走零拷贝（CPU 管线够用）"
            );
        }
        // 多屏拼接：GPU 侧没有跨屏合成这条路
        assert!(!EncodeProfile::of_name("uhd60").wants_zero_copy(true, false));
        assert!(!EncodeProfile::of_name("fps120").wants_zero_copy(true, false));
        // 本会话 GPU 路径已被判死：两档都不再尝试
        assert!(!EncodeProfile::of_name("uhd60").wants_zero_copy(false, true));
        assert!(!EncodeProfile::of_name("fps120").wants_zero_copy(false, true));
    }

    #[test]
    fn ultra_profile_is_2560_wide() {
        let p = EncodeProfile::of_name("ultra");
        assert_eq!(p.max_w, 2560);
        assert!(p.adapt_down > EncodeProfile::of_name("balanced").adapt_down);
        // 超宽图应缩到 2560 而不是 4K
        let mut st = EncoderState::with_profile(p, true);
        let (w, h) = (3840u32, 2160u32);
        let rgb = solid(w, h, 30, 30, 30);
        let rgba = to_rgba(&rgb);
        let e = encode_rgba(&mut st, w, h, &rgba).unwrap();
        assert!(e.frame.full);
        assert_eq!(e.frame.width, 2560);
        assert_eq!(e.frame.height, 1440);
    }

    #[test]
    fn small_change_not_static() {
        let mut st = EncoderState::new();
        let w = 256u32;
        let h = 128u32;
        let mut a = solid(w, h, 50, 50, 50);
        let rgba_a = to_rgba(&a);
        let e0 = encode_rgba(&mut st, w, h, &rgba_a).unwrap();
        assert!(e0.frame.full && !e0.frame.jpeg.is_empty());
        // 改一整块 tile（64×64），保证超过块差阈值
        for y in 0..64u32 {
            for x in 0..64u32 {
                let i = ((y * w + x) * 3) as usize;
                a[i] = 220;
                a[i + 1] = 20;
                a[i + 2] = 20;
            }
        }
        let rgba_b = to_rgba(&a);
        let e = encode_rgba(&mut st, w, h, &rgba_b).unwrap();
        assert!(!e.frame.jpeg.is_empty(), "有改动不应跳过");
    }

    #[test]
    fn compositor_full() {
        let mut st = EncoderState::new();
        let w = 128u32;
        let h = 64u32;
        let rgb = solid(w, h, 0, 0, 0);
        let rgba = to_rgba(&rgb);
        let full = encode_rgba(&mut st, w, h, &rgba).unwrap();
        let mut comp = Compositor::new();
        let (cw, ch, buf) = comp.apply(None, &full.frame.jpeg).unwrap();
        assert_eq!(cw, w);
        assert_eq!(ch, h);
        assert_eq!(buf.len(), (w * h * 3) as usize);
    }

    fn h264_frame(key: bool) -> VideoFrame {
        VideoFrame {
            width: 64,
            height: 32,
            jpeg: vec![0xab; 16],
            at_ms: 0,
            full: true,
            rect: None,
            codec: FrameCodec::H264,
            key,
            cap_ms: 0,
            enc_ms: 0,
        }
    }

    #[test]
    fn outbox_溢出丢P帧后拦截到下一个key() {
        let mut ob = FrameOutbox::new();
        ob.push(h264_frame(true));
        // 塞满：全是 P 帧，溢出丢掉的也是 P 帧 ⇒ 引用链断了
        for _ in 0..(FrameOutbox::CAP + 10) {
            ob.push(h264_frame(false));
        }
        let got = ob.drain();
        // 溢出是「先弹旧、再判新」：断链标记落下时，正在入队的那个 P 帧也被拦下，
        // 所以队列里是 CAP-1 条而不是 CAP 条
        assert_eq!(got.len(), FrameOutbox::CAP - 1);
        // 断链后再来 P 帧：必须拦下，前端不能再收到解不出的花屏
        ob.push(h264_frame(false));
        assert!(ob.drain().is_empty(), "断链期间的 P 帧应被拦截");
        // key 帧重新起链
        ob.push(h264_frame(true));
        ob.push(h264_frame(false));
        let got = ob.drain();
        assert_eq!(got.len(), 2);
        assert!(got[0].key && !got[1].key);
    }

    #[test]
    fn outbox_溢出丢到key帧不算断链() {
        let mut ob = FrameOutbox::new();
        ob.push(h264_frame(true));
        // 队列里全是 key 帧时溢出：丢的 key 不破坏引用链，P 帧照常放行
        for _ in 0..(FrameOutbox::CAP + 10) {
            ob.push(h264_frame(true));
        }
        ob.push(h264_frame(false));
        let got = ob.drain();
        assert_eq!(got.len(), FrameOutbox::CAP);
        assert!(!got.last().unwrap().key);
        // JPEG 帧不受断链逻辑影响：来了就收
        let mut jpeg = h264_frame(true);
        jpeg.codec = FrameCodec::Jpeg;
        ob.clear();
        ob.push(jpeg.clone());
        ob.push(jpeg);
        assert_eq!(ob.drain().len(), 2);
    }

    /// 🔴 tile_dirty 的语义 = 整块平均差 ≥ 阈值（2026-09-19 审查 P2）：
    /// 曾把「当前前缀和 ≥ 阈值×已扫数」当判脏（均值只增不减是错的），
    /// 块内第 1 个像素 d=100 就判脏而全块均值 0.39——单像素噪声永久判脏。
    #[test]
    fn tile_dirty_单像素噪声不算脏_整块均值才算() {
        let w = 8u32;
        let mut prev = vec![100u8; (w * 8 * 3) as usize];
        let mut cur = prev.clone();
        // 单像素大差：早退逻辑曾当场判脏
        cur[0] = 200;
        assert!(!tile_dirty(&prev, &cur, w, 0, 0, 8, 8));
        // 半数像素中等差：均值 (30*32)/64 = 15 ≥ 8 ⇒ 脏
        for i in 0..(64 * 3 / 2) {
            cur[i] = prev[i] + 10;
        }
        assert!(tile_dirty(&prev, &cur, w, 0, 0, 8, 8));
        // 拖动整窗（全部大差）：必然脏剪枝生效，结果不变
        for i in 0..cur.len() {
            cur[i] = prev[i] ^ 0xff;
        }
        assert!(tile_dirty(&prev, &cur, w, 0, 0, 8, 8));
        let _ = &mut prev;
    }

    /// 🔴 断链判据看「逐出后的新队头」（2026-09-19 审查 P2）：key 被逐出、
    /// 新队头是引用它的 P 帧时必须置 corrupt——否则花屏帧直发前端。
    #[test]
    fn outbox_逐出key帧后新队头是P要置断链() {
        let mut ob = FrameOutbox::new();
        ob.push(h264_frame(true));
        for _ in 0..(FrameOutbox::CAP - 1) {
            ob.push(h264_frame(false));
        }
        // 队列满：这一推把队头的 key 挤出去，新队头是 P ⇒ 引用链断，
        // 本帧自身也因 corrupt 被拦
        ob.push(h264_frame(false));
        assert_eq!(
            ob.drain().len(),
            FrameOutbox::CAP - 1,
            "key 被逐出后断链置位，紧随的 P 帧不得入队"
        );
        // key 帧照常放行并清除断链——自愈通道还在
        ob.push(h264_frame(true));
        let got = ob.drain();
        assert_eq!(got.len(), 1);
        assert!(got[0].key);
    }
}
