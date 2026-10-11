//! macOS container passthrough: supports AVAssetWriter B-frame/sample tables.
pub use crate::rec::trim_types::{snap, KeyframeIndex};
use std::{ffi::CString, path::Path};
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
    })
}
pub fn trim(src: &Path, begin: u64, end: u64, dst: &Path) -> Result<(u64, u64, u64), String> {
    if begin >= end {
        return Err("选段为空（入点不早于出点）".into());
    }
    let index = scan_keyframes(src)?;
    let (begin, end) = snap(&index.keyframes_ms, index.duration_ms, begin, end);
    if begin >= end {
        return Err("选段没有可保留的视频".into());
    }
    if dst.exists() {
        return Err(error(4));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = dst.with_file_name(format!(
        ".pastepanda-trim-{}-{stamp}.mp4",
        std::process::id()
    ));
    let code = unsafe {
        pp_trim_export(
            path_string(src)?.as_ptr(),
            path_string(&temporary)?.as_ptr(),
            begin,
            end,
        )
    };
    let finish = (|| {
        if code != 0 {
            return Err(error(code));
        }
        let bytes = temporary.metadata().map_err(|e| e.to_string())?.len();
        if bytes == 0 {
            return Err("裁剪文件为空".into());
        }
        // hard_link provides no-clobber publication even if another export wins the name race.
        std::fs::hard_link(&temporary, dst).map_err(|e| format!("保存裁剪失败：{e}"))?;
        Ok((bytes, begin, end))
    })();
    let _ = std::fs::remove_file(&temporary);
    finish
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
