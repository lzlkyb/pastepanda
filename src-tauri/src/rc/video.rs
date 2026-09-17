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

/// 画质档（被控端编码参数）。
///
/// 方案 A「伪 4K」：`ultra` 编码宽 **2560**（约 2.5K），不是原生 4K；
/// 真 4K 主屏硬编见规划文档 R5（方案 B）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeProfile {
    pub max_w: u32,
    pub interval_ms: u64,
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
                interval_ms: 120,
                q_min: 45,
                q_max: 85,
                q_default: 70,
                adapt_down: 350_000,
                adapt_up: 80_000,
            },
            "ultra" => Self {
                max_w: 2560,
                interval_ms: 180,
                q_min: 50,
                q_max: 85,
                q_default: 72,
                adapt_down: 700_000,
                adapt_up: 150_000,
            },
            // uhd：主屏硬编走原生分辨率；JPEG 兜底仍按 2.5K 控带宽（R5.B）
            "uhd" => Self {
                max_w: 2560,
                interval_ms: 100,
                q_min: 55,
                q_max: 85,
                q_default: 75,
                adapt_down: 800_000,
                adapt_up: 180_000,
            },
            "smooth" => Self {
                max_w: 960,
                interval_ms: 160,
                q_min: 25,
                q_max: 55,
                q_default: 40,
                adapt_down: 150_000,
                adapt_up: 30_000,
            },
            // balanced（默认）
            _ => Self {
                max_w: TARGET_MAX_W,
                interval_ms: 200,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameCodec {
    Jpeg,
    H264,
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
    /// 编码类型：JPEG 或 H.264 Annex-B。
    pub codec: FrameCodec,
    /// H.264 关键帧。
    pub key: bool,
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
    }

    pub fn apply_monitor(&mut self, monitor: i32) {
        self.monitor = monitor;
        self.virtual_screen = monitor < 0 && self.virtual_screen;
        self.last_rgb = None;
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
    pub frame: VideoFrame,
}

fn is_jpeg_magic(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == 0xFF && b[1] == 0xD8
}

fn is_json_magic(b: &[u8]) -> bool {
    b.first() == Some(&b'{')
}

/// 发起端合成后再编码给前端用的简单路径（无脏矩形状态）。
pub fn encode_rgba_to_jpeg_simple(width: u32, height: u32, rgba: &[u8]) -> Result<VideoFrame, String> {
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
        let (w, h, rgba) = if state.monitor >= 0 {
            crate::screenshot::capture_monitor_rgba(state.monitor)?
        } else if state.virtual_screen {
            crate::screenshot::capture_virtual_screen_rgba()?
        } else {
            crate::screenshot::capture_primary_screen_rgba()?
        };
        encode_rgba(state, w as u32, h as u32, &rgba)
    }
}

/// RGBA → 降采样 →（脏矩形或整帧）JPEG。
pub fn encode_rgba(
    state: &mut EncoderState,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<Encoded, String> {
    if width == 0 || height == 0 {
        return Err("空画面".into());
    }
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("像素数据构造失败")?;
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

    state.frame_idx = state.frame_idx.wrapping_add(1);
    let force_key = state.frame_idx % KEYFRAME_EVERY == 1;

    // 与上一帧比脏块
    let dirty: Option<DirtyRect> = if force_key {
        state.last_rgb = Some((tw, th, rgb_bytes.clone()));
        None
    } else if let Some((lw, lh, last)) = state.last_rgb.as_ref() {
        if *lw == tw && *lh == th {
            match find_dirty_rect(last, rgb_bytes, tw, th) {
                DirtyOutcome::Static => {
                    // 静止：跳过本帧（调用方不发送）
                    return Ok(Encoded {
                        rect: Some(DirtyRect { x: 0, y: 0, w: 0, h: 0 }),
                        frame: VideoFrame {
                            width: 0,
                            height: 0,
                            jpeg: Vec::new(),
                            at_ms: chrono::Utc::now().timestamp_millis(),
                            full: false,
                            rect: None,
                            codec: FrameCodec::Jpeg,
                            key: false,
                        },
                    });
                }
                DirtyOutcome::Full => {
                    state.last_rgb = Some((tw, th, rgb_bytes.clone()));
                    None
                }
                DirtyOutcome::Rect(r) => {
                    state.last_rgb = Some((tw, th, rgb_bytes.clone()));
                    Some(r)
                }
            }
        } else {
            state.last_rgb = Some((tw, th, rgb_bytes.clone()));
            None
        }
    } else {
        state.last_rgb = Some((tw, th, rgb_bytes.clone()));
        None
    };

    let jpeg_rgb;
    let out_w;
    let out_h;
    if let Some(r) = dirty {
        let crop = crop_rgb(rgb_bytes, tw, th, r)?;
        jpeg_rgb = crop;
        out_w = r.w;
        out_h = r.h;
    } else {
        jpeg_rgb = rgb_bytes.clone();
        out_w = tw;
        out_h = th;
    }

    let mut buf = Vec::with_capacity(64 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, state.quality)
        .write_image(&jpeg_rgb, out_w, out_h, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG 编码失败：{e}"))?;
    if buf.len() > MAX_JPEG_BYTES {
        return Err(format!("JPEG 帧过大（{} 字节）", buf.len()));
    }
    state.adapt(buf.len());
    Ok(Encoded {
        rect: dirty,
        frame: VideoFrame {
            width: out_w,
            height: out_h,
            jpeg: buf,
            at_ms: chrono::Utc::now().timestamp_millis(),
            full: dirty.is_none(),
            rect: dirty,
            codec: FrameCodec::Jpeg,
            key: dirty.is_none(),
        },
    })
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
                }
            }
            if n == 0 {
                continue;
            }
            let avg = (sum / n) as u8;
            if avg >= TILE_DIFF_THRESHOLD {
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
    pub fn apply(&mut self, rect: Option<DirtyRect>, jpeg: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
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

/// 发送 H.264：先 JSON 元数据，再 Annex-B 裸流。
pub async fn write_h264(
    s: &mut iroh::endpoint::SendStream,
    data: &[u8],
    key: bool,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if data.is_empty() {
        return Err("空 H.264 包".into());
    }
    let meta = serde_json::json!({
        "t": "h264",
        "key": key,
        "w": width,
        "h": height,
        "n": data.len(),
    });
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
    /// R4：H.264 Annex-B 包 + 元数据。
    H264 {
        key: bool,
        width: u32,
        height: u32,
        data: Vec<u8>,
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
        }))
    } else if is_json_magic(&buf) {
        // h264 元数据后还跟一包裸流
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
            if v.get("t").and_then(|x| x.as_str()) == Some("h264") {
                let key = v.get("key").and_then(|x| x.as_bool()).unwrap_or(false);
                let width = v.get("w").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let height = v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let n = v.get("n").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
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
}
