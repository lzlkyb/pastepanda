//! Session-owned VideoToolbox AVC encoder; bounded Annex-B packets include SPS/PPS at IDR.
use std::ffi::{c_void, CStr};
extern "C" {
    fn pp_rc_capture_encode(
        capture: *mut c_void,
        encoder: *mut c_void,
        key: bool,
        output: *mut *mut u8,
        length: *mut usize,
        out_key: *mut bool,
        codec: *mut i8,
        capacity: usize,
    ) -> i32;
    fn pp_rc_video_open(
        hevc: bool,
        w: u32,
        h: u32,
        fps: u32,
        bitrate: u32,
        output: *mut *mut c_void,
    ) -> i32;
    fn pp_rc_video_encode(
        handle: *mut c_void,
        rgba: *const u8,
        length: usize,
        key: bool,
        output: *mut *mut u8,
        length_out: *mut usize,
        key_out: *mut bool,
        codec: *mut std::ffi::c_char,
        capacity: usize,
    ) -> i32;
    fn pp_rc_video_hardware_available(hevc: bool) -> i32;
    fn pp_rc_video_set_bitrate(handle: *mut c_void, bitrate: u32) -> i32;
    fn pp_rc_video_close(handle: *mut c_void);
    fn pp_mac_free(memory: *mut c_void);
}
struct Native(*mut c_void);
unsafe impl Send for Native {}
impl Drop for Native {
    fn drop(&mut self) {
        unsafe { pp_rc_video_close(self.0) }
    }
}
#[derive(Default)]
pub struct Encoder {
    native: Option<Native>,
    parameters: Option<(bool, u32, u32, u32, u32)>,
    surface: Option<crate::rc::mac_capture::SurfaceCapture>,
    av1: Option<crate::macos::av1::Encoder>,
    av1_failed: bool,
}
impl Encoder {
    fn prepare(
        &mut self,
        hevc: bool,
        w: u32,
        h: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<(), String> {
        if w == 0
            || h == 0
            || w % 2 != 0
            || h % 2 != 0
            || u64::from(w) * u64::from(h) > 8_388_608
            || fps == 0
            || fps > 165
        {
            return Err("Mac 远控编码尺寸或帧率无效".into());
        }
        let parameters = (hevc, w, h, fps, bitrate);
        if self
            .parameters
            .is_some_and(|p| (p.0, p.1, p.2, p.3) == (hevc, w, h, fps) && p.4 != bitrate)
        {
            if let Some(native) = &self.native {
                if unsafe { pp_rc_video_set_bitrate(native.0, bitrate) } == 0 {
                    self.parameters = Some(parameters);
                }
            }
        }
        if self.parameters != Some(parameters) {
            self.native = None;
            self.parameters = None;
            let mut handle = std::ptr::null_mut();
            let mut status = unsafe { pp_rc_video_open(hevc, w, h, fps, bitrate, &mut handle) };
            if status != 0 && hevc {
                status = unsafe { pp_rc_video_open(false, w, h, fps, bitrate, &mut handle) };
            }
            if status != 0 || handle.is_null() {
                return Err("Mac VideoToolbox 编码器不可用，回退 JPEG".into());
            }
            self.native = Some(Native(handle));
            self.parameters = Some(parameters);
        }
        Ok(())
    }
    pub fn encode(
        &mut self,
        requested: crate::rc::video_params::VideoCodec,
        rgba: &[u8],
        w: u32,
        h: u32,
        fps: u32,
        bitrate: u32,
        key: bool,
        at_ms: i64,
    ) -> Result<Option<(crate::rc::video_params::VideoPacket, String)>, String> {
        if rgba.len() as u64 != u64::from(w) * u64::from(h) * 4 {
            return Err("Mac 远控像素数据无效".into());
        }
        if requested == crate::rc::video_params::VideoCodec::Av1 && !self.av1_failed {
            let result = (|| {
                if self
                    .av1
                    .as_ref()
                    .is_none_or(|e| !e.matches(w, h, fps, bitrate))
                {
                    self.av1 = None;
                    self.av1 = Some(crate::macos::av1::Encoder::open(w, h, fps, bitrate)?);
                }
                self.native = None;
                self.parameters = None;
                self.av1.as_mut().unwrap().encode(rgba, key, at_ms)
            })();
            match result {
                Ok(packet) => return Ok(packet.map(|p| (p, "av1".into()))),
                Err(error) => {
                    log::warn!("[RC] {error}，本次 AV1 会话回退 H.264");
                    self.av1 = None;
                    self.av1_failed = true;
                }
            }
        } else if requested != crate::rc::video_params::VideoCodec::Av1 {
            self.av1 = None;
            self.av1_failed = false;
        }
        self.prepare(
            requested == crate::rc::video_params::VideoCodec::Hevc,
            w,
            h,
            fps,
            bitrate,
        )?;
        let (mut bytes, mut length, mut out_key) = (std::ptr::null_mut(), 0, false);
        let mut codec = [0_i8; 64];
        let status = unsafe {
            pp_rc_video_encode(
                self.native.as_ref().unwrap().0,
                rgba.as_ptr(),
                rgba.len(),
                key,
                &mut bytes,
                &mut length,
                &mut out_key,
                codec.as_mut_ptr(),
                codec.len(),
            )
        };
        read_packet(status, bytes, length, out_key, &codec, w, h, at_ms).map(Some)
    }
    pub fn suspend_surface(&mut self) {
        self.surface = None;
    }
    pub fn suspend(&mut self) {
        self.surface = None;
        self.native = None;
        self.parameters = None;
        self.av1 = None;
        self.av1_failed = false;
    }
    pub fn encode_screen(
        &mut self,
        monitor: i32,
        max_w: u32,
        high: bool,
        requested: crate::rc::video_params::VideoCodec,
        fps: u32,
        bitrate: u32,
        key: bool,
        at_ms: i64,
    ) -> Result<Option<(crate::rc::video_params::VideoPacket, String)>, String> {
        let list = crate::macos::screen::native_monitors()?;
        let selected = list
            .iter()
            .find(|m| {
                if monitor >= 0 {
                    m.monitor.index == monitor
                } else {
                    m.monitor.primary
                }
            })
            .ok_or("未找到远控显示器")?;
        if selected.monitor.w < 16 || selected.monitor.h < 16 {
            return Err("显示器尺寸无效".into());
        }
        let av1 = requested == crate::rc::video_params::VideoCodec::Av1;
        let fps = if av1 { fps.min(30) } else { fps };
        let (w, h) = surface_dimensions(
            selected.monitor.w as u32,
            selected.monitor.h as u32,
            if av1 { max_w.min(1920) } else { max_w },
            high || av1,
        );
        if self
            .surface
            .as_ref()
            .is_none_or(|s| !s.matches(monitor, w, h, fps))
        {
            self.surface = None;
            self.surface = Some(crate::rc::mac_capture::SurfaceCapture::start(
                monitor, w, h, fps,
            )?);
        }
        self.surface.as_ref().unwrap().check()?;
        if av1 {
            let (fw, fh, rgba) = self.surface.as_mut().unwrap().frame()?;
            return self.encode(requested, &rgba, fw, fh, fps, bitrate, key, at_ms);
        }
        self.av1 = None;
        self.av1_failed = false;
        self.prepare(
            requested == crate::rc::video_params::VideoCodec::Hevc,
            w,
            h,
            fps,
            bitrate,
        )?;
        let (mut bytes, mut length, mut out_key) = (std::ptr::null_mut(), 0, false);
        let mut codec = [0_i8; 64];
        let status = unsafe {
            pp_rc_capture_encode(
                self.surface.as_ref().unwrap().handle(),
                self.native.as_ref().unwrap().0,
                key,
                &mut bytes,
                &mut length,
                &mut out_key,
                codec.as_mut_ptr(),
                codec.len(),
            )
        };
        if status == 10 {
            return Ok(None);
        }
        read_packet(status, bytes, length, out_key, &codec, w, h, at_ms).map(Some)
    }
}
fn read_packet(
    status: i32,
    bytes: *mut u8,
    length: usize,
    out_key: bool,
    codec: &[i8; 64],
    w: u32,
    h: u32,
    at_ms: i64,
) -> Result<(crate::rc::video_params::VideoPacket, String), String> {
    struct Owned(*mut u8);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { pp_mac_free(self.0.cast()) }
            }
        }
    }
    let memory = Owned(bytes);
    if status != 0 || memory.0.is_null() || length == 0 || length > crate::rc::video::MAX_H264_BYTES
    {
        return Err(if status == 9 {
            "Mac 采集未提供可共享纹理，回退图片采集"
        } else {
            "Mac 视频编码失败，回退 JPEG"
        }
        .into());
    }
    let codec = unsafe { CStr::from_ptr(codec.as_ptr()) }
        .to_str()
        .map_err(|_| "Mac 编码标准无效")?
        .to_owned();
    if !(codec.starts_with("avc1.") && codec.len() == 11
        || codec.starts_with("hev1.") && codec.len() < 64)
    {
        return Err("Mac 编码标准无效".into());
    }
    Ok((
        crate::rc::video_params::VideoPacket {
            at_ms,
            data: unsafe { std::slice::from_raw_parts(memory.0, length) }.to_vec(),
            key: out_key,
            width: w,
            height: h,
        },
        codec,
    ))
}
pub(crate) fn surface_dimensions(w: u32, h: u32, max_w: u32, high: bool) -> (u32, u32) {
    let scale = (f64::from(max_w.max(2)) / f64::from(w))
        .min(if high { 1080. / f64::from(h) } else { 1. })
        .min(1.);
    (
        ((f64::from(w) * scale) as u32).max(2) & !1,
        ((f64::from(h) * scale) as u32).max(2) & !1,
    )
}

pub fn hardware_available(hevc: bool) -> bool {
    static AVC: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    static HEVC: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *(if hevc { &HEVC } else { &AVC })
        .get_or_init(|| unsafe { pp_rc_video_hardware_available(hevc) == 1 })
}

pub(crate) fn scope_support(monitor: i32, virtual_screen: bool) -> (u32, u32) {
    if virtual_screen && monitor < 0 || !hardware_available(false) {
        return (0, 0);
    }
    let Ok(list) = crate::macos::screen::native_monitors() else {
        return (0, 0);
    };
    let Some(selected) = list.iter().find(|m| {
        if monitor >= 0 {
            m.monitor.index == monitor
        } else {
            m.monitor.primary
        }
    }) else {
        return (0, 0);
    };
    let hz = crate::macos::screen::display_hz(selected.display_id);
    let high = crate::rc::video::HIGH_FPS_LADDER
        .iter()
        .find(|(_, _, min)| hz >= *min)
        .map(|(_, fps, _)| *fps)
        .unwrap_or(0);
    (hz, high)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portrait_and_landscape_high_frames_stay_inside_1080p_surface_budget() {
        assert_eq!(surface_dimensions(3840, 2160, 1920, true), (1920, 1080));
        assert_eq!(surface_dimensions(2160, 3840, 1920, true), (606, 1080));
        assert_eq!(surface_dimensions(3840, 2160, 3840, false), (3840, 2160));
    }
    #[test]
    fn unsupported_av1_size_falls_back_to_avc_and_stays_there() {
        if std::env::var_os("PASTEPANDA_TEST_AV1").is_none() {
            return;
        }
        assert!(crate::macos::av1::available());
        let mut encoder = Encoder::default();
        let pixels = vec![120; 32 * 32 * 4];
        for at in [0, 34] {
            let (packet, codec) = encoder
                .encode(
                    crate::rc::video_params::VideoCodec::Av1,
                    &pixels,
                    32,
                    32,
                    30,
                    1_000_000,
                    true,
                    at,
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                crate::rc::video_params::wire_codec_label(&codec),
                Some("h264")
            );
            assert!(packet.key && !packet.data.is_empty());
            assert!(encoder.av1_failed && encoder.av1.is_none());
        }
        encoder.suspend();
        assert!(encoder.native.is_none() && encoder.av1.is_none() && !encoder.av1_failed);
    }
}
