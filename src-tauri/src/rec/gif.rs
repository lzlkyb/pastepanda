//! GIF 导出（四期 1.5）——MF SourceReader 解码 → 抽稀 12fps → NeuQuant 量化 →
//! `gif` crate 逐帧写，宽 ≤480、无限循环。**单任务串行**（一次一个导出，
//! 前端行内进度轮询 + 可取消——抽帧耗时可达数十秒，规则 9）。
//!
//! 解码选 MF 而非 FF：系统自带 H.264/HEVC 解码器（DXVA 加速），不加依赖路径；
//! 原始解码帧率全读（30/60fps），按时间戳落到 12fps 网格抽稀，原 mp4 只读不动。
//! 重复导出同名文件 = 覆盖（确定性优于堆 `_2`）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows::Win32::Media::MediaFoundation::{
    IMFSourceReader, MFCreateMediaType, MFCreateSourceReaderFromURL, MF_MT_DEFAULT_STRIDE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MFMediaType_Video, MFVideoFormat_HEVC,
    MFVideoFormat_RGB32, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READERF_ENDOFSTREAM,
};

use super::scan;

/// 导出参数（规格定死的档位，不做设置项）。
const TARGET_FPS: u64 = 12;
const TARGET_WIDTH: u32 = 480;
/// GIF 帧延迟单位是 10ms：1000/12 ≈ 83ms → 8 = 80ms（实际 12.5fps）。
const GIF_DELAY_UNITS: u16 = 8;

#[derive(Debug, Clone)]
pub struct GifStatus {
    pub running: bool,
    /// 0–99（100 由完成态表达）。
    pub percent: u8,
    /// 完成时的产物路径。
    pub done_path: Option<String>,
    /// 失败/取消的文案（"已取消"）。
    pub error: Option<String>,
}

struct GifJob {
    src: PathBuf,
    cancel: AtomicBool,
    percent: Mutex<u8>,
    /// true = 正在跑；结束（完成/失败/取消）后置 false 并填 result。
    running: AtomicBool,
    result: Mutex<GifStatus>,
}

static GIF_JOB: Mutex<Option<Arc<GifJob>>> = Mutex::new(None);

/// 当前导出状态（命令 rec_gif_status）。`src` 与在跑/已结束任务不匹配时返回空态。
pub fn status(src: &std::path::Path) -> GifStatus {
    let job = GIF_JOB.lock().unwrap_or_else(|p| p.into_inner()).clone();
    match job {
        Some(j) if j.running.load(Ordering::Relaxed) || j.src == src => {
            if j.running.load(Ordering::Relaxed) {
                GifStatus {
                    running: true,
                    percent: *j.percent.lock().unwrap_or_else(|p| p.into_inner()),
                    done_path: None,
                    error: None,
                }
            } else {
                j.result.lock().unwrap_or_else(|p| p.into_inner()).clone()
            }
        }
        _ => GifStatus { running: false, percent: 0, done_path: None, error: None },
    }
}

/// 启动导出。已有任务在跑时拒绝（单任务串行，「取消」才有明确语义）。
pub fn start(src: PathBuf) -> Result<(), String> {
    let mut slot = GIF_JOB.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = slot.as_ref() {
        if j.running.load(Ordering::Relaxed) {
            return Err("已有 GIF 导出在进行".into());
        }
    }
    let job = Arc::new(GifJob {
        src: src.clone(),
        cancel: AtomicBool::new(false),
        percent: Mutex::new(0),
        running: AtomicBool::new(true),
        result: Mutex::new(GifStatus { running: true, percent: 0, done_path: None, error: None }),
    });
    *slot = Some(job.clone());
    drop(slot);
    std::thread::Builder::new()
        .name("rec-gif".into())
        .spawn(move || {
            let outcome = run_export(&job.src, &job.cancel, &job.percent);
            let mut result = job.result.lock().unwrap_or_else(|p| p.into_inner());
            *result = match outcome {
                Ok(dst) => GifStatus {
                    running: false,
                    percent: 100,
                    done_path: Some(dst.display().to_string()),
                    error: None,
                },
                Err(e) => {
                    GifStatus { running: false, percent: 0, done_path: None, error: Some(e) }
                }
            };
            job.running.store(false, Ordering::Relaxed);
        })
        .map_err(|e| format!("起导出线程失败：{e}"))?;
    Ok(())
}

/// 取消当前导出（丢弃半成品）。无任务在跑 = no-op。
pub fn cancel() {
    let slot = GIF_JOB.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = slot.as_ref() {
        if j.running.load(Ordering::Relaxed) {
            j.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// 产物路径：同名 `.gif`。
fn dst_of(src: &std::path::Path) -> PathBuf {
    src.with_extension("gif")
}

/// CoInitializeEx 配平（本线程自有；模式同 sink.rs——错误路径也不能漏释放）。
struct ComGuard(bool);
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

fn run_export(
    src: &std::path::Path,
    cancel: &AtomicBool,
    percent: &Mutex<u8>,
) -> Result<PathBuf, String> {
    let com_owned = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
        .is_ok()
    };
    let _com = ComGuard(com_owned);
    unsafe { export_inner(src, cancel, percent) }
}

unsafe fn export_inner(
    src: &std::path::Path,
    cancel: &AtomicBool,
    percent: &Mutex<u8>,
) -> Result<PathBuf, String> {
    unsafe {
        crate::rc::encode_h264::ensure_mf_startup()?;

        let wide = windows::core::HSTRING::from(src.as_os_str());
        let reader: IMFSourceReader = MFCreateSourceReaderFromURL(&wide, None).map_err(mf_err)?;

        // 源尺寸（解码前）→ 输出类型 RGB32 直解到目标尺寸；DEFAULT_STRIDE 正值
        // 保证 top-down（MF RGB 默认 bottom-up，不设会上下翻转）。
        let native = reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .map_err(mf_err)?;
        let wh = native.GetUINT64(&MF_MT_FRAME_SIZE).map_err(mf_err)?;
        let (src_w, src_h) = ((wh >> 32) as u32, (wh & 0xFFFF_FFFF) as u32);
        if src_w == 0 || src_h == 0 {
            return Err("视频轨没有尺寸".into());
        }
        let tw = TARGET_WIDTH.min(src_w).max(16);
        let th = (((src_h as u64) * (tw as u64) / (src_w as u64)).max(16) & !1) as u32;

        let mt = MFCreateMediaType().map_err(mf_err)?;
        mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(mf_err)?;
        mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(mf_err)?;
        mt.SetUINT64(&MF_MT_FRAME_SIZE, ((tw as u64) << 32) | th as u64).map_err(mf_err)?;
        mt.SetUINT32(&MF_MT_DEFAULT_STRIDE, tw * 4).map_err(mf_err)?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &mt)
            .map_err(mf_err)?;

        // 进度估算总量（scan.rs 的 mvhd 解析；读不到就无进度，只有转圈）
        let total_ms = scan::mp4_duration_ms(src).unwrap_or(0);

        let dst = dst_of(src);
        let out = std::fs::File::create(&dst).map_err(|e| format!("创建 {}：{e}", dst.display()))?;
        let mut encoder =
            gif::Encoder::new(out, tw as u16, th as u16, &[]).map_err(|e| format!("GIF 编码器初始化：{e}"))?;
        encoder.set_repeat(gif::Repeat::Infinite).map_err(|e| format!("GIF 循环设置：{e}"))?;

        let mut scaler = pastepanda_rc_scale::BgraScaler::default();
        let mut next_tick_100: i64 = 0;
        let tick_100: i64 = 10_000_000 / TARGET_FPS as i64; // 1/12s（100ns 单位）
        let mut kept: u64 = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(encoder);
                let _ = std::fs::remove_file(&dst);
                return Err("已取消".into());
            }
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<windows::Win32::Media::MediaFoundation::IMFSample> = None;
            reader
                .ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut ts),
                    Some(&mut sample),
                )
                .map_err(mf_err)?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(s) = sample else { continue };
            // 不在 12fps 网格上的帧：直接丢（解码便宜，量化才贵）
            if ts < next_tick_100 {
                continue;
            }
            next_tick_100 += tick_100;
            if total_ms > 0 {
                let pct = ((((ts / 10_000).max(0) as u64).min(total_ms)) * 99 / total_ms) as u8;
                *percent.lock().unwrap_or_else(|p| p.into_inner()) = pct;
            }

            // BGRA(解码) → 缩放到 ≤480 → α=255 → NeuQuant → 索引帧
            let buf = s.ConvertToContiguousBuffer().map_err(mf_err)?;
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut max_len = 0u32;
            let mut cur_len = 0u32;
            buf.Lock(&mut data, Some(&mut max_len), Some(&mut cur_len)).map_err(mf_err)?;
            let bytes = if data.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(data, cur_len as usize).to_vec()
            };
            let _ = buf.Unlock();
            if bytes.len() < (tw * th * 4) as usize {
                return Err("解码帧不完整（尺寸不符）".into());
            }
            let scaled: Vec<u8> = if (tw, th) == (src_w, src_h) {
                bytes
            } else {
                scaler.resize(&bytes, src_w, src_h, tw, th)?.to_vec()
            };
            let mut rgba = scaled;
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 255;
            }
            // color_quant 1.1：new(samplefac, colors, pixels)，只读入参内部拷贝
            let nq = color_quant::NeuQuant::new(10, 256, &rgba);
            let palette: Vec<u8> = nq
                .color_map_rgba()
                .chunks_exact(4)
                .flat_map(|px| [px[0], px[1], px[2]])
                .collect();
            let indexed: Vec<u8> = rgba
                .chunks_exact(4)
                .map(|px| nq.index_of(px) as u8)
                .collect();
            let frame = gif::Frame {
                delay: GIF_DELAY_UNITS,
                dispose: gif::DisposalMethod::Keep,
                width: tw as u16,
                height: th as u16,
                palette: Some(palette),
                buffer: std::borrow::Cow::Owned(indexed),
                ..Default::default()
            };
            encoder.write_frame(&frame).map_err(|e| format!("GIF 写帧：{e}"))?;
            kept += 1;
        }
        drop(encoder);
        if kept == 0 {
            let _ = std::fs::remove_file(&dst);
            return Err("没有解出任何帧（文件损坏或不是录屏产物？）".into());
        }
        Ok(dst)
    }
}

fn mf_err(e: windows::core::Error) -> String {
    format!("MF：{e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 产物路径_同名gif() {
        let p = std::path::Path::new(r"C:\x\屏幕录制_a.mp4");
        assert_eq!(dst_of(p), std::path::PathBuf::from(r"C:\x\屏幕录制_a.gif"));
    }

    #[test]
    fn 视频流常量与状态空态() {
        assert_eq!(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0, -4);
        // 确认 HEVC 导入在（HEVC 录制档的解码依赖）
        let _ = MFVideoFormat_HEVC;
        let s = status(std::path::Path::new(r"C:\x\a.mp4"));
        assert!(!s.running && s.done_path.is_none() && s.error.is_none());
    }
}
