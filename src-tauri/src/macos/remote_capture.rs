//! Session-owned ScreenCaptureKit stream; only the latest captured frame is retained.
use std::ffi::c_void;
extern "C" {
    fn pp_rc_host_ready() -> i32;
    fn pp_rc_capture_start(
        display: u32,
        width: u32,
        height: u32,
        fps: u32,
        timeout_ms: u32,
        exclude_own: bool,
        handle: *mut *mut c_void,
    ) -> i32;
    fn pp_rc_capture_frame(
        handle: *mut c_void,
        bytes: *mut *mut u8,
        length: *mut usize,
        width: *mut u32,
        height: *mut u32,
    ) -> i32;
    fn pp_rc_capture_stop(handle: *mut c_void);
    fn pp_mac_free(memory: *mut c_void);
}
fn result(code: i32) -> Result<(), String> {
    match code {
        0 => Ok(()),
        2 => Err("远程观看需要屏幕录制权限，请在系统设置中允许 PastePanda 后重开应用".into()),
        8 => Err("Mac 被控端需要 macOS 12.3 或更高版本".into()),
        9 => Err("Mac 被控端应用尚未就绪".into()),
        _ => Err("Mac 远程屏幕采集失败或超时".into()),
    }
}
pub fn require_host() -> Result<(), String> {
    result(unsafe { pp_rc_host_ready() })
}
struct DisplayCapture(*mut c_void);
// Native state is accessed exclusively on its serial capture queue; the Rust
// encoder owns this handle and calls frame through &mut self.
unsafe impl Send for DisplayCapture {}
impl DisplayCapture {
    fn start(
        display: u32,
        width: u32,
        height: u32,
        fps: u32,
        timeout_ms: u32,
        exclude_own: bool,
    ) -> Result<Self, String> {
        let mut handle = std::ptr::null_mut();
        result(unsafe {
            pp_rc_capture_start(
                display,
                width,
                height,
                fps,
                timeout_ms,
                exclude_own,
                &mut handle,
            )
        })?;
        if handle.is_null() {
            return Err("Mac 采集句柄无效".into());
        }
        Ok(Self(handle))
    }
    pub fn frame(&mut self) -> Result<(u32, u32, Vec<u8>), String> {
        require_host()?;
        let (mut bytes, mut length, mut w, mut h) = (std::ptr::null_mut(), 0, 0, 0);
        let status =
            unsafe { pp_rc_capture_frame(self.0, &mut bytes, &mut length, &mut w, &mut h) };
        struct Owned(*mut u8);
        impl Drop for Owned {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { pp_mac_free(self.0.cast()) }
                }
            }
        }
        let memory = Owned(bytes);
        result(status)?;
        if memory.0.is_null()
            || w == 0
            || h == 0
            || u64::from(w) * u64::from(h) > 40_000_000
            || length as u64 != u64::from(w) * u64::from(h) * 4
        {
            return Err("Mac 远程帧尺寸无效".into());
        }
        Ok((
            w,
            h,
            unsafe { std::slice::from_raw_parts(memory.0, length) }.to_vec(),
        ))
    }
}
impl Drop for DisplayCapture {
    fn drop(&mut self) {
        unsafe { pp_rc_capture_stop(self.0) }
    }
}
pub struct Capture {
    layout: Vec<crate::macos::screen::NativeMonitor>,
    sources: Vec<(i32, DisplayCapture)>,
    scope: (i32, bool, u32),
    region: crate::macos::screen_layout::Rect,
}
impl Capture {
    pub fn start(monitor: i32, virtual_screen: bool, fps: u32) -> Result<Self, String> {
        require_host()?;
        let layout = crate::macos::screen::native_monitors()?;
        let selected: Vec<_> = layout
            .iter()
            .filter(|m| {
                if monitor >= 0 {
                    m.monitor.index == monitor
                } else {
                    virtual_screen || m.monitor.primary
                }
            })
            .collect();
        if selected.is_empty() {
            return Err("未找到远控显示器".into());
        }
        let geometry: Vec<_> = selected.iter().map(|m| m.monitor.clone()).collect();
        let region = crate::macos::screen_layout::bounds(&geometry)?;
        region.validate(40_000_000)?;
        validate_source_budget(selected.iter().map(|m| &m.monitor))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut sources = Vec::new();
        for m in selected {
            sources.push((
                m.monitor.index,
                DisplayCapture::start(
                    m.display_id,
                    m.monitor.w as u32,
                    m.monitor.h as u32,
                    fps,
                    remaining_ms(deadline)?,
                    false,
                )?,
            ));
        }
        Ok(Self {
            layout,
            sources,
            scope: (monitor, virtual_screen, fps),
            region,
        })
    }
    pub fn start_region(
        region: crate::macos::screen_layout::Rect,
        fps: u32,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Self, String> {
        require_host()?;
        let layout = crate::macos::screen::native_monitors()?;
        let geometry: Vec<_> = layout.iter().map(|m| m.monitor.clone()).collect();
        crate::macos::screen_layout::validate_region(&geometry, region)?;
        region.validate(40_000_000)?;
        validate_source_budget(
            layout
                .iter()
                .filter(|m| region.intersect((&m.monitor).into()).is_some())
                .map(|m| &m.monitor),
        )?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut sources = Vec::new();
        for m in &layout {
            if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                return Err("录屏启动已取消".into());
            }
            if region.intersect((&m.monitor).into()).is_some() {
                sources.push((
                    m.monitor.index,
                    DisplayCapture::start(
                        m.display_id,
                        m.monitor.w as u32,
                        m.monitor.h as u32,
                        fps,
                        remaining_ms(deadline)?,
                        true,
                    )?,
                ));
            }
        }
        Ok(Self {
            layout,
            sources,
            scope: (-2, false, fps),
            region,
        })
    }
    pub fn matches(&self, monitor: i32, virtual_screen: bool, fps: u32) -> bool {
        self.scope == (monitor, virtual_screen, fps)
    }
    pub fn frame(&mut self) -> Result<(u32, u32, Vec<u8>), String> {
        if crate::macos::screen::fingerprint(&self.layout)
            != crate::macos::screen::fingerprint(&crate::macos::screen::native_monitors()?)
        {
            return Err("远控显示器布局或缩放已变化，请重新连接".into());
        }
        let selected: Vec<_> = self
            .layout
            .iter()
            .filter(|m| self.sources.iter().any(|s| s.0 == m.monitor.index))
            .map(|m| m.monitor.clone())
            .collect();
        let region = self.region;
        let frame = crate::macos::screen_layout::compose(&selected, region, |m| {
            let source = self
                .sources
                .iter_mut()
                .find(|s| s.0 == m.index)
                .ok_or("远控显示器已移除")?;
            let (w, h, bytes) = source.1.frame()?;
            image::RgbaImage::from_raw(w, h, bytes).ok_or("远控图像数据无效".into())
        })?;
        if crate::macos::screen::fingerprint(&self.layout)
            != crate::macos::screen::fingerprint(&crate::macos::screen::native_monitors()?)
        {
            return Err("远控显示器布局或缩放已变化，请重新连接".into());
        }
        Ok((frame.width(), frame.height(), frame.into_raw()))
    }
}
fn validate_source_budget<'a>(
    mut monitors: impl Iterator<Item = &'a crate::screenshot::MonitorInfo>,
) -> Result<(), String> {
    let total = monitors
        .try_fold(0_i64, |sum, m| {
            sum.checked_add(i64::from(m.w) * i64::from(m.h))
        })
        .ok_or("采集尺寸溢出")?;
    if total <= 0 || total > 40_000_000 {
        return Err("多屏总采集像素超出安全限制，请降低显示器分辨率或选择单屏".into());
    }
    Ok(())
}
fn remaining_ms(deadline: std::time::Instant) -> Result<u32, String> {
    let remaining = deadline
        .saturating_duration_since(std::time::Instant::now())
        .as_millis()
        .min(8000) as u32;
    if remaining == 0 {
        Err("多屏采集启动超时，请重试".into())
    } else {
        Ok(remaining)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_display_startups_share_one_deadline() {
        assert!(
            remaining_ms(std::time::Instant::now() - std::time::Duration::from_secs(1)).is_err()
        );
        assert!(
            remaining_ms(std::time::Instant::now() + std::time::Duration::from_secs(100)).unwrap()
                <= 8000
        );
    }
    #[test]
    fn native_errors_are_visible() {
        for code in [1, 2, 4, 7, 8, 9] {
            assert!(result(code).is_err());
        }
        assert!(result(0).is_ok());
    }
}

/// One display rendered by SCK directly at the encoder size. Geometry stays in
/// canonical desktop pixels; normalized remote input is independent of raster size.
pub struct SurfaceCapture {
    source: DisplayCapture,
    layout: Vec<crate::macos::screen::NativeMonitor>,
    options: (i32, u32, u32, u32),
}
impl SurfaceCapture {
    pub fn start(monitor: i32, w: u32, h: u32, fps: u32) -> Result<Self, String> {
        require_host()?;
        let layout = crate::macos::screen::native_monitors()?;
        let selected = layout
            .iter()
            .find(|m| {
                if monitor >= 0 {
                    m.monitor.index == monitor
                } else {
                    m.monitor.primary
                }
            })
            .ok_or("未找到远控显示器")?;
        let source = DisplayCapture::start(selected.display_id, w, h, fps, 8000, false)?;
        Ok(Self {
            source,
            layout,
            options: (monitor, w, h, fps),
        })
    }
    pub fn matches(&self, monitor: i32, w: u32, h: u32, fps: u32) -> bool {
        self.options == (monitor, w, h, fps)
    }
    pub fn check(&self) -> Result<(), String> {
        require_host()?;
        if crate::macos::screen::fingerprint(&self.layout)
            != crate::macos::screen::fingerprint(&crate::macos::screen::native_monitors()?)
        {
            return Err("远控显示器布局或缩放已变化，请重新连接".into());
        }
        Ok(())
    }
    pub(crate) fn handle(&self) -> *mut c_void {
        self.source.0
    }
    pub fn frame(&mut self) -> Result<(u32, u32, Vec<u8>), String> {
        self.check()?;
        self.source.frame()
    }
}
