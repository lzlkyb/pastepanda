//! macOS container passthrough: supports AVAssetWriter B-frame/sample tables.
pub use crate::rec::trim_types::{snap, KeyframeIndex};
use std::{ffi::CString, path::Path};
#[allow(clippy::duplicate_mod)] // output.rs 是各录制器以 #[path] 自带的共享模块，各自实例化互不引用，刻意布局
#[path = "../rec/output.rs"]
mod output;
#[path = "../rec/trim_job.rs"]
mod trim_job;
pub use trim_job::{cancel as cancel_job, start as start_job, status as job_status, TrimJob};
extern "C" {
    fn pp_trim_index(path: *const std::ffi::c_char, bytes: *mut *mut u8, length: *mut usize)
        -> i32;
    fn pp_trim_export(
        src: *const std::ffi::c_char,
        dst: *const std::ffi::c_char,
        begin: u64,
        end: u64,
    ) -> i32;
    fn pp_mac_free(bytes: *mut std::ffi::c_void);
}
fn path_string(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| "录像路径包含无效字符".into())
}
fn error(code: i32) -> String {
    match code {
        3 => "录像索引超出支持范围",
        4 => "裁剪目标文件已存在，原文件未覆盖",
        5 => "Mac 裁剪超时，已取消；请缩短选段后重试",
        6 => "选段没有可用视频帧，未保存裁剪",
        _ => "Mac 录像无法读取或裁剪，请检查文件是否完整",
    }
    .into()
}
struct NativeBytes(*mut u8);
impl Drop for NativeBytes {
    fn drop(&mut self) {
        unsafe { pp_mac_free(self.0.cast()) }
    }
}
pub fn scan_keyframes(path: &Path) -> Result<KeyframeIndex, String> {
    let source = path_string(path)?;
    let (mut bytes, mut length) = (std::ptr::null_mut(), 0);
    let code = unsafe { pp_trim_index(source.as_ptr(), &mut bytes, &mut length) };
    let owned = NativeBytes(bytes);
    if code != 0 {
        return Err(error(code));
    }
    if owned.0.is_null() || length == 0 || length > 4 * 1024 * 1024 {
        return Err("Mac 裁剪索引无效".into());
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Index {
        duration_ms: u64,
        asset_duration_ms: u64,
        keyframes_ms: Vec<u64>,
    }
    let data: Index =
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(owned.0, length) })
            .map_err(|e| e.to_string())?;
    Ok(KeyframeIndex {
        duration_ms: data.duration_ms,
        keyframes_ms: data.keyframes_ms,
        warning: (data.asset_duration_ms > data.duration_ms.saturating_add(1000)).then(|| format!("视频轨只有 {:.2} 秒，文件总时长 {:.2} 秒；后续画面未录入。仅能裁剪已有视频，请用新版重新录制。", data.duration_ms as f64/1000.0, data.asset_duration_ms as f64/1000.0)),
        // AVFoundation 侧还没把 nominalFrameRate 带出来：前端据此把「逐帧」按钮
        // 置为不可用（而不是拿 1/30 假装准），见 RecPlayerControls 的 fps 分支。
        fps: None,
    })
}
pub fn trim(src: &Path, begin: u64, end: u64, dst: &Path) -> Result<(u64, u64, u64), String> {
    trim_with_job(src, begin, end, dst, None)
}
pub fn trim_with_job(
    src: &Path, begin: u64, end: u64, dst: &Path, job: Option<&TrimJob>,
) -> Result<(u64, u64, u64), String> {
    if let Some(job) = job { job.check_cancelled()?; }
    if begin >= end {
        return Err("选段为空（入点不早于出点）".into());
    }
    let index = scan_keyframes(src)?;
    let (begin, end) = snap(&index.keyframes_ms, index.duration_ms, begin, end);
    if begin >= end {
        return Err("选段没有可保留的视频".into());
    }
    let source = path_string(src)?;
    let (pending, file) = output::PendingOutput::new(dst, false)?;
    drop(file);
    // AVAssetExportSession requires an absent output URL; PendingOutput still owns cleanup.
    std::fs::remove_file(pending.temporary_path()).map_err(|e| format!("准备裁剪文件失败：{e}"))?;
    let temporary = path_string(pending.temporary_path())?;
    if let Some(job) = job { job.check_cancelled()?; }
    let code = unsafe {
        pp_trim_export(
            source.as_ptr(),
            temporary.as_ptr(),
            begin,
            end,
        )
    };
    // Native export is synchronous here: cancellation prevents publication after it returns.
    // No synthetic percentage is reported while AVAssetExportSession owns the work.
    if let Some(job) = job { job.check_cancelled()?; }
    if code != 0 { return Err(error(code)); }
    let file = std::fs::OpenOptions::new().write(true).open(pending.temporary_path())
        .map_err(|e| e.to_string())?;
    let bytes = file.metadata().map_err(|e| e.to_string())?.len();
    if bytes == 0 { return Err("裁剪文件为空".into()); }
    file.sync_all().map_err(|e| format!("保存裁剪失败：{e}"))?;
    drop(file);
    if let Some(job) = job { job.check_cancelled()?; }
    pending.commit()?;
    Ok((bytes, begin, end))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires PP_TRIM_TEST_MP4 real AVAssetWriter fixture"]
    fn real_b_frame_recording_exports_without_overwriting_source() {
        let source =
            std::path::PathBuf::from(std::env::var("PP_TRIM_TEST_MP4").expect("fixture path"));
        let before = std::fs::read(&source).unwrap();
        let index = scan_keyframes(&source).unwrap();
        assert!(index.duration_ms > 0 && !index.keyframes_ms.is_empty());
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let target = std::env::temp_dir().join(format!("pastepanda-trim-regression-{stamp}.mp4"));
        let result = trim(&source, 0, index.duration_ms, &target).unwrap();
        assert!(result.0 > 0 && scan_keyframes(&target).unwrap().duration_ms > 0);
        assert!(trim(&source, 0, index.duration_ms, &target).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), before);
        std::fs::remove_file(target).unwrap();
    }
}
