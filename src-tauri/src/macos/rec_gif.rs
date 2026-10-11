//! AVFoundation frames -> streaming GIF; only a completed export replaces the destination.
pub use super::gif_job::{cancel, status, GifStatus};
use std::{
    ffi::{c_void, CString},
    fs::{File, OpenOptions},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
extern "C" {
    fn pp_video_open(
        path: *const std::ffi::c_char,
        duration: *mut f64,
        status: *mut i32,
    ) -> *mut c_void;
    fn pp_video_close(handle: *mut c_void);
    fn pp_video_frame(
        handle: *mut c_void,
        seconds: f64,
        cancelled: extern "C" fn(*mut c_void) -> bool,
        context: *mut c_void,
        bytes: *mut *mut u8,
        length: *mut usize,
        width: *mut u32,
        height: *mut u32,
    ) -> i32;
    fn pp_mac_free(bytes: *mut c_void);
}
struct Decoder(*mut c_void);
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { pp_video_close(self.0) }
    }
}
struct NativeFrame(*mut u8);
impl Drop for NativeFrame {
    fn drop(&mut self) {
        unsafe { pp_mac_free(self.0.cast()) }
    }
}
struct TempOutput {
    path: PathBuf,
    committed: bool,
}
impl Drop for TempOutput {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
extern "C" fn is_cancelled(context: *mut c_void) -> bool {
    if context.is_null() {
        return true;
    }
    unsafe { (&*context.cast::<AtomicBool>()).load(Ordering::Relaxed) }
}
pub fn start(src: PathBuf) -> Result<(), String> {
    super::gif_job::start(src, run_export)
}
fn frame_count(duration: f64) -> Result<u64, String> {
    if !duration.is_finite() || duration <= 0.0 || duration > 86400.0 {
        return Err("视频时长无效或超过 GIF 导出上限（24 小时）".into());
    }
    Ok((duration * 12.0).ceil() as u64)
}
fn create_temp(src: &Path) -> Result<(TempOutput, File), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let name = src
        .file_name()
        .ok_or("视频路径缺少文件名")?
        .to_string_lossy();
    let path = src.with_file_name(format!(".{name}.{}.{stamp}.gif-part", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("创建 GIF 临时文件失败：{e}"))?;
    Ok((
        TempOutput {
            path,
            committed: false,
        },
        file,
    ))
}
fn run_export(src: &Path, cancel: &AtomicBool, percent: &Mutex<u8>) -> Result<PathBuf, String> {
    let source =
        CString::new(src.as_os_str().as_encoded_bytes()).map_err(|_| "视频路径包含无效字符")?;
    let (mut duration, mut code) = (0.0, 0);
    let decoder = Decoder(unsafe { pp_video_open(source.as_ptr(), &mut duration, &mut code) });
    if decoder.0.is_null() || code != 0 {
        return Err("Mac 视频无法读取，请检查文件是否完整".into());
    }
    let result = write_export(src, duration, cancel, percent, |seconds| {
        let (mut bytes, mut length, mut w, mut h) = (std::ptr::null_mut(), 0, 0, 0);
        let code = unsafe {
            pp_video_frame(
                decoder.0,
                seconds,
                is_cancelled,
                (cancel as *const AtomicBool).cast_mut().cast(),
                &mut bytes,
                &mut length,
                &mut w,
                &mut h,
            )
        };
        let owned = NativeFrame(bytes);
        if code != 0 {
            return Err(match code {
                7 => "已取消",
                8 => "Mac 视频解码超时，请重试",
                _ => "Mac 视频帧解码失败",
            }
            .into());
        }
        if bytes.is_null()
            || w == 0
            || h == 0
            || w > 480
            || h > 4096
            || length != w as usize * h as usize * 4
        {
            return Err("视频帧尺寸无效".into());
        }
        let rgba = unsafe { std::slice::from_raw_parts(owned.0, length) }.to_vec();
        Ok((w, h, rgba))
    });
    match result {
        Ok(dst) => Ok(dst),
        Err(error) if !cancel.load(Ordering::Relaxed) => {
            log::warn!("Mac GIF 系统解码失败，使用 H.264 软件解码：{error}");
            let mut frames = super::h264_frames::Frames::open(src)?;
            write_export(src, frames.duration, cancel, percent, |seconds| {
                frames.at(seconds)
            })
        }
        Err(error) => Err(error),
    }
}
fn write_export(
    src: &Path,
    duration: f64,
    cancel: &AtomicBool,
    percent: &Mutex<u8>,
    mut get_frame: impl FnMut(f64) -> Result<(u32, u32, Vec<u8>), String>,
) -> Result<PathBuf, String> {
    let total = frame_count(duration)?;
    let (mut temp, file) = create_temp(src)?;
    let mut output = Some(BufWriter::new(file));
    let mut encoder: Option<gif::Encoder<BufWriter<File>>> = None;
    let mut size = (0, 0);
    let mut previous: Option<(Vec<u8>, gif::Frame<'static>)> = None;
    for index in 0..total {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let (w, h, mut rgba) = get_frame(index as f64 / 12.0)?;
        if w == 0 || h == 0 || w > 480 || h > 4096 || rgba.len() != w as usize * h as usize * 4 {
            return Err("视频帧尺寸无效".into());
        }
        if encoder.is_some() {
            if size != (w, h) {
                return Err("视频尺寸发生变化，无法导出 GIF".into());
            }
        } else {
            size = (w, h);
            let mut writer = gif::Encoder::new(
                output.take().ok_or("GIF 输出已关闭")?,
                w as u16,
                h as u16,
                &[],
            )
            .map_err(|e| format!("GIF 初始化失败：{e}"))?;
            writer
                .set_repeat(gif::Repeat::Infinite)
                .map_err(|e| format!("GIF 循环设置失败：{e}"))?;
            encoder = Some(writer);
        }
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        let mut frame = if let Some((pixels, frame)) =
            previous.as_ref().filter(|(pixels, _)| pixels == &rgba)
        {
            let _ = pixels;
            frame.clone()
        } else {
            let frame = gif::Frame::from_rgba_speed(w as u16, h as u16, &mut rgba, 10);
            previous = Some((rgba.clone(), frame.clone()));
            frame
        };
        // Alternate centisecond delays so 12 fps doesn't drift to 12.5 fps.
        frame.delay = (((index + 1) * 100 / 12) - (index * 100 / 12)) as u16;
        frame.dispose = gif::DisposalMethod::Keep;
        encoder
            .as_mut()
            .ok_or("GIF 编码器未初始化")?
            .write_frame(&frame)
            .map_err(|e| format!("GIF 写入失败：{e}"))?;
        *percent.lock().unwrap_or_else(|p| p.into_inner()) = ((index + 1) * 99 / total) as u8;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".into());
    }
    let mut writer = encoder
        .ok_or("没有解出视频帧")?
        .into_inner()
        .map_err(|e| format!("GIF 收尾失败：{e}"))?;
    use std::io::Write;
    writer.flush().map_err(|e| format!("GIF 保存失败：{e}"))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|e| format!("GIF 落盘失败：{e}"))?;
    drop(writer);
    if cancel.load(Ordering::Relaxed) {
        return Err("已取消".into());
    }
    let dst = src.with_extension("gif");
    std::fs::rename(&temp.path, &dst).map_err(|e| format!("GIF 替换失败：{e}"))?;
    temp.committed = true;
    Ok(dst)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duration_and_frame_budget_reject_invalid_media() {
        for d in [0.0, -1.0, f64::NAN, f64::INFINITY, 86401.0] {
            assert!(frame_count(d).is_err());
        }
        assert_eq!(frame_count(1.0).unwrap(), 12);
        assert_eq!(frame_count(0.01).unwrap(), 1);
    }
    #[test]
    fn discarded_temporary_export_preserves_existing_gif() {
        let dir = std::env::temp_dir().join(format!(
            "pp-gif-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let src = dir.join("test.mp4");
        let dst = src.with_extension("gif");
        std::fs::write(&dst, b"existing").unwrap();
        let (temp, file) = create_temp(&src).unwrap();
        let part = temp.path.clone();
        drop(file);
        drop(temp);
        assert!(!part.exists());
        assert_eq!(std::fs::read(dst).unwrap(), b"existing");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn encoded_gif_has_correct_frames_delays_and_preserves_old_output_on_error() {
        let dir = std::env::temp_dir().join(format!(
            "pp-gif-write-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let src = dir.join("test.mp4");
        let cancel = AtomicBool::new(false);
        let progress = Mutex::new(0);
        let dst =
            write_export(&src, 1.0, &cancel, &progress, |_| Ok((2, 2, vec![255; 16]))).unwrap();
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut reader = options.read_info(File::open(&dst).unwrap()).unwrap();
        let (mut count, mut delay) = (0, 0);
        while let Some(frame) = reader.read_next_frame().unwrap() {
            count += 1;
            delay += frame.delay;
        }
        assert_eq!((count, delay), (12, 100));
        assert_eq!(*progress.lock().unwrap(), 99);
        let original = std::fs::read(&dst).unwrap();
        assert!(write_export(&src, 1.0, &cancel, &progress, |_| Err(
            "decoder unavailable".into()
        ))
        .is_err());
        assert_eq!(std::fs::read(&dst).unwrap(), original);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "requires PP_GIF_TEST_MP4 pointing to a disposable fixture"]
    fn real_recording_system_decoder_failure_exports_with_software_fallback() {
        let src = PathBuf::from(std::env::var("PP_GIF_TEST_MP4").expect("PP_GIF_TEST_MP4"));
        let duration = super::super::scan::mp4_duration_ms(&src).unwrap();
        let dst = run_export(&src, &AtomicBool::new(false), &Mutex::new(0)).unwrap();
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut reader = options.read_info(File::open(dst).unwrap()).unwrap();
        assert_eq!((reader.width(), reader.height()), (480, 270));
        let (mut count, mut delay) = (0u64, 0u64);
        while let Some(frame) = reader.read_next_frame().unwrap() {
            count += 1;
            delay += u64::from(frame.delay);
        }
        assert_eq!(count, ((duration as f64 / 1000.0) * 12.0).ceil() as u64);
        assert!((delay as i64 * 10 - duration as i64).abs() < 100);
    }
}
