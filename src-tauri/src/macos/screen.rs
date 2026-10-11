//! ScreenCaptureKit adapter. Physical coordinates use the primary display scale.
use crate::screenshot::{MonitorInfo, ScreenCapture};
extern "C" {
    fn pp_mac_monitors(output: *mut *mut u8, length: *mut usize) -> i32;
    fn pp_mac_capture_display(
        display: u32,
        width: u32,
        height: u32,
        output: *mut *mut u8,
        length: *mut usize,
    ) -> i32;
    fn pp_mac_free(memory: *mut std::ffi::c_void);
    fn pp_mac_screen_scale() -> f64;
    fn pp_mac_display_hz(display: u32) -> u32;
    fn pp_mac_cursor(x: *mut i32, y: *mut i32);
}
struct NativeBytes(*mut u8);
impl Drop for NativeBytes {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { pp_mac_free(self.0.cast()) }
        }
    }
}
fn read_native(call: impl FnOnce(*mut *mut u8, *mut usize) -> i32) -> Result<Vec<u8>, String> {
    let mut output = std::ptr::null_mut();
    let mut length = 0;
    let status = call(&mut output, &mut length);
    let owned = NativeBytes(output);
    if status != 0 {
        return Err(match status {
        2 => "无法读取屏幕。请在系统设置 → 隐私与安全性 → 屏幕录制中允许 PastePanda，然后重启应用",
        4 => "Mac 屏幕采集超时，请重试",
        6 => "屏幕图像超出安全尺寸限制",
        7 => "屏幕采集不能在主线程运行",
        8 => "当前截图适配需要 macOS 12.3 或更高版本",
        _ => "Mac 屏幕采集失败，请检查权限并重启应用",
    }.into());
    }
    if owned.0.is_null() || length == 0 || length > 256 * 1024 * 1024 {
        return Err("屏幕数据无效".into());
    }
    Ok(unsafe { std::slice::from_raw_parts(owned.0, length) }.to_vec())
}
#[derive(serde::Deserialize)]
pub(crate) struct NativeMonitor {
    #[serde(flatten)]
    pub monitor: MonitorInfo,
    #[serde(rename = "displayId")]
    pub display_id: u32,
    pub scale: f64,
}
pub(crate) fn native_monitors() -> Result<Vec<NativeMonitor>, String> {
    let list: Vec<NativeMonitor> =
        serde_json::from_slice(&read_native(|p, n| unsafe { pp_mac_monitors(p, n) })?)
            .map_err(|e| format!("显示器信息无效: {e}"))?;
    if list.is_empty()
        || list.len() > 32
        || list
            .iter()
            .any(|m| m.display_id == 0 || !m.scale.is_finite() || m.scale <= 0.)
    {
        return Err("显示器信息无效".into());
    }
    Ok(list)
}
pub(crate) fn fingerprint(list: &[NativeMonitor]) -> Vec<(u32, i32, i32, i32, i32, u64)> {
    list.iter()
        .map(|m| {
            (
                m.display_id,
                m.monitor.x,
                m.monitor.y,
                m.monitor.w,
                m.monitor.h,
                m.scale.to_bits(),
            )
        })
        .collect()
}
pub fn monitors() -> Result<Vec<MonitorInfo>, String> {
    Ok(native_monitors()?.into_iter().map(|m| m.monitor).collect())
}
pub fn desktop() -> Result<super::screen_layout::Rect, String> {
    super::screen_layout::bounds(&monitors()?)
}
pub fn primary() -> Result<MonitorInfo, String> {
    monitors()?
        .into_iter()
        .find(|m| m.primary)
        .ok_or("未找到主显示器".into())
}
pub fn primary_scale() -> f64 {
    let scale = unsafe { pp_mac_screen_scale() };
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}
pub fn cursor() -> (i32, i32) {
    let (mut x, mut y) = (0, 0);
    unsafe {
        pp_mac_cursor(&mut x, &mut y);
    }
    (x, y)
}
pub fn capture(x: i32, y: i32, w: i32, h: i32) -> Result<ScreenCapture, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ImageEncoder,
    };
    let native = native_monitors()?;
    let list: Vec<MonitorInfo> = native.iter().map(|m| m.monitor.clone()).collect();
    let region = super::screen_layout::Rect { x, y, w, h };
    let frame = super::screen_layout::compose(&list, region, |m| {
        let source = native
            .iter()
            .find(|n| n.monitor.index == m.index)
            .ok_or("显示器已移除")?;
        let png = read_native(|p, n| unsafe {
            pp_mac_capture_display(source.display_id, m.w as u32, m.h as u32, p, n)
        })?;
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|e| format!("截图解码失败: {e}"))?;
        Ok(img.to_rgba8())
    })?;
    if fingerprint(&native) != fingerprint(&native_monitors()?) {
        return Err("显示器布局或缩放已变化，请重新截图".into());
    }
    let mut output = Vec::new();
    PngEncoder::new_with_quality(&mut output, CompressionType::Fast, FilterType::Up)
        .write_image(&frame, w as u32, h as u32, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("截图编码失败: {e}"))?;
    Ok(ScreenCapture {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(output)),
        origin_x: x,
        origin_y: y,
        width: w,
        height: h,
    })
}
pub fn capture_screen() -> Result<ScreenCapture, String> {
    let region = desktop()?;
    capture(region.x, region.y, region.w, region.h)
}

pub fn window_rects() -> Result<Vec<crate::screenshot::SnapRect>, String> {
    extern "C" {
        fn pp_mac_window_rects(output: *mut *mut u8, length: *mut usize) -> i32;
    }
    let rects: Vec<crate::screenshot::SnapRect> =
        serde_json::from_slice(&read_native(|p, n| unsafe { pp_mac_window_rects(p, n) })?)
            .map_err(|e| format!("窗口信息无效: {e}"))?;
    let screen = desktop()?;
    Ok(rects
        .into_iter()
        .filter_map(|r| {
            let x = r.x.max(screen.x);
            let y = r.y.max(screen.y);
            let right =
                (i64::from(r.x) + i64::from(r.w)).min(i64::from(screen.x) + i64::from(screen.w));
            let bottom =
                (i64::from(r.y) + i64::from(r.h)).min(i64::from(screen.y) + i64::from(screen.h));
            (right > i64::from(x) && bottom > i64::from(y)).then(|| crate::screenshot::SnapRect {
                x,
                y,
                w: (right - i64::from(x)) as i32,
                h: (bottom - i64::from(y)) as i32,
            })
        })
        .collect())
}
pub fn window_at(x: i32, y: i32) -> Result<Option<crate::screenshot::SnapTargets>, String> {
    let rect = window_rects()?.into_iter().find(|r| {
        x >= r.x
            && y >= r.y
            && i64::from(x) < i64::from(r.x) + i64::from(r.w)
            && i64::from(y) < i64::from(r.y) + i64::from(r.h)
    });
    Ok(rect.map(|r| crate::screenshot::SnapTargets { win: r, ctrl: r }))
}

/// Canonical pixels are converted to AppKit points explicitly. A spanning
/// window's own backing scale can change when most of it lies on another screen.
pub fn place_window(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let scale = primary_scale();
    window
        .set_size(tauri::LogicalSize::new(
            f64::from(w) / scale,
            f64::from(h) / scale,
        ))
        .map_err(|e| e.to_string())?;
    position_window(window, x, y)
}
pub fn position_window(window: &tauri::WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    let scale = primary_scale();
    window
        .set_position(tauri::LogicalPosition::new(
            f64::from(x) / scale,
            f64::from(y) / scale,
        ))
        .map_err(|e| e.to_string())
}

pub(crate) fn display_hz(display: u32) -> u32 {
    unsafe { pp_mac_display_hz(display) }
}
