//! R4.1 — Media Foundation 硬件 H.264 编码器。
//!
//! 优先硬件 MFT；不可用则整段会话回退 JPEG。输入 NV12，输出 Annex-B。
//!
//! R5.B：profile 用 **High(100)**，level 随分辨率抬升（最高 5.1 覆盖 4K@30），
//! 码率按宽查表。打开尺寸跟抓屏走，不再写死 1280×720。

#![cfg(target_os = "windows")]

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};

/// H.264 High profile（MF_MT_MPEG2_PROFILE）。
pub const H264_PROFILE_HIGH: u32 = 100;

/// 按编码宽高选 H.264 level（MF_MT_MPEG2_LEVEL）。
/// 5.1 覆盖 4K@30；更小画面用更低 level，兼容性更好。
pub fn h264_level_for(width: u32, height: u32) -> u32 {
    let (w, h) = (width.max(1), height.max(1));
    if w >= 3200 || h >= 1800 {
        51 // 4K
    } else if w >= 2560 || h >= 1440 {
        50
    } else if w >= 1920 || h >= 1080 {
        42
    } else {
        40
    }
}

/// WebCodecs `codec` 字符串（前端同口径）：High + level hex。
/// 例：2160p → `avc1.640033`（High@5.1）。
pub fn webcodecs_codec_str(width: u32, height: u32) -> String {
    let level = h264_level_for(width, height);
    format!("avc1.64{:04x}", level)
}

/// 按编码宽度选目标码率（bit/s）。4K 局域网给足带宽，避免糊成马赛克。
pub fn bitrate_for_width(width: u32) -> u32 {
    match width {
        w if w >= 3200 => 22_000_000,
        w if w >= 2560 => 14_000_000,
        w if w >= 1920 => 8_000_000,
        w if w >= 1600 => 5_000_000,
        w if w >= 1200 => 3_000_000,
        _ => 1_500_000,
    }
}

pub struct H264Packet {
    pub data: Vec<u8>,
    pub key: bool,
    pub width: u32,
    pub height: u32,
}

pub struct MfH264Encoder {
    transform: IMFTransform,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    frame_idx: u64,
    com_owned: bool,
    pending: Vec<H264Packet>,
}

fn mf_err(e: windows::core::Error) -> String {
    format!("MF：{e}")
}

impl MfH264Encoder {
    pub fn open(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self, String> {
        unsafe {
            let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            static INIT: std::sync::Once = std::sync::Once::new();
            static INIT_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            INIT.call_once(|| {
                let r = MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL);
                INIT_OK.store(r.is_ok(), std::sync::atomic::Ordering::SeqCst);
            });
            if !INIT_OK.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("MFStartup 失败".into());
            }

            let w = (width & !1).max(64);
            let h = (height & !1).max(64);

            let transform = create_h264_mft()?;

            let in_type = create_video_type(&MFVideoFormat_NV12, w, h)?;
            transform.SetInputType(0, &in_type, 0).map_err(mf_err)?;

            let out_type = create_video_type(&MFVideoFormat_H264, w, h)?;
            out_type
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                .map_err(mf_err)?;
            out_type
                .SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1))
                .map_err(mf_err)?;
            out_type
                .SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
                .map_err(mf_err)?;
            // High profile + 按分辨率选 level（4K 必须 >3.1）
            out_type
                .SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH)
                .map_err(mf_err)?;
            out_type
                .SetUINT32(&MF_MT_MPEG2_LEVEL, h264_level_for(w, h))
                .map_err(mf_err)?;
            transform.SetOutputType(0, &out_type, 0).map_err(mf_err)?;

            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(mf_err)?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(mf_err)?;

            Ok(Self {
                transform,
                width: w,
                height: h,
                fps: fps.max(1),
                bitrate,
                frame_idx: 0,
                com_owned,
                pending: Vec::new(),
            })
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn encode_nv12(&mut self, nv12: &[u8]) -> Result<Vec<H264Packet>, String> {
        unsafe {
            let need = (self.width * self.height * 3 / 2) as usize;
            if nv12.len() < need {
                return Err(format!("NV12 不足 {} < {}", nv12.len(), need));
            }
            let sample = make_sample(nv12, need, self.frame_idx, self.fps)?;
            self.frame_idx += 1;
            self.transform.ProcessInput(0, &sample, 0).map_err(mf_err)?;
            self.drain()?;
            Ok(std::mem::take(&mut self.pending))
        }
    }

    unsafe fn drain(&mut self) -> Result<(), String> {
        loop {
            let od = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                ..Default::default()
            };
            let mut status = 0u32;
            let mut outs = [od];
            let hr = self.transform.ProcessOutput(0, &mut outs, &mut status);
            if hr.is_err() {
                break;
            }
            if let Some(sample) = outs[0].pSample.as_ref() {
                if let Ok(buf) = sample.ConvertToContiguousBuffer() {
                    if let Ok(bytes) = lock_buf(&buf) {
                        let key = match sample.GetUINT32(&MFSampleExtension_CleanPoint) {
                            Ok(v) => v != 0,
                            Err(_) => self.pending.is_empty(),
                        };
                        self.pending.push(H264Packet {
                            data: to_annex_b(&bytes),
                            key,
                            width: self.width,
                            height: self.height,
                        });
                    }
                }
            }
        }
        Ok(())
    }
}

impl Drop for MfH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        if self.com_owned {
            unsafe { CoUninitialize() };
        }
    }
}

unsafe fn create_h264_mft() -> Result<IMFTransform, String> {
    let in_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    // 硬件 MFT 多为 async：不能只用 HARDWARE|SYNCMFT（会枚举 0 个掉进软编）
    for flags in [
        MFT_ENUM_FLAG_HARDWARE,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT,
        MFT_ENUM_FLAG_ALL,
    ] {
        count = 0;
        acts = std::ptr::null_mut();
        let _ = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            Some(&in_info),
            Some(&out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            break;
        }
    }
    if count == 0 || acts.is_null() {
        return Err("无 H.264 MFT".into());
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let first = slice[0]
        .clone()
        .ok_or("MFT activate 为空")?;
    CoTaskMemFree(Some(acts as _));
    first
        .ActivateObject::<IMFTransform>()
        .map_err(|e| format!("ActivateObject：{e}"))
}

unsafe fn create_video_type(subtype: &windows::core::GUID, w: u32, h: u32) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(mf_err)?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(mf_err)?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(mf_err)?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(mf_err)?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(mf_err)?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32x2(1, 1))
        .map_err(mf_err)?;
    Ok(t)
}

fn pack_u32x2(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

fn pack_ratio(n: u32, d: u32) -> u64 {
    pack_u32x2(n, d)
}

unsafe fn make_sample(nv12: &[u8], len: usize, idx: u64, fps: u32) -> Result<IMFSample, String> {
    let buf = MFCreateMemoryBuffer(len as u32).map_err(mf_err)?;
    {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut max = 0u32;
        let mut cur = 0u32;
        buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
            .map_err(mf_err)?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, len);
        }
        buf.SetCurrentLength(len as u32).map_err(mf_err)?;
        buf.Unlock().map_err(mf_err)?;
    }
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

unsafe fn lock_buf(buf: &IMFMediaBuffer) -> Result<Vec<u8>, String> {
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut max = 0u32;
    let mut cur = 0u32;
    buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
        .map_err(mf_err)?;
    let n = if cur > 0 { cur as usize } else { max as usize };
    let mut out = vec![0u8; n];
    if !data.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(data, out.as_mut_ptr(), n);
    }
    buf.Unlock().map_err(mf_err)?;
    Ok(out)
}

fn to_annex_b(raw: &[u8]) -> Vec<u8> {
    if raw.len() >= 4 && raw[0] == 0 && raw[1] == 0 && raw[2] == 0 && raw[3] == 1 {
        return raw.to_vec();
    }
    if raw.len() >= 3 && raw[0] == 0 && raw[1] == 0 && raw[2] == 1 {
        return raw.to_vec();
    }
    let mut out = Vec::with_capacity(raw.len() + 32);
    let mut i = 0usize;
    while i + 4 <= raw.len() {
        let n = u32::from_be_bytes([raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]) as usize;
        i += 4;
        if n == 0 || i + n > raw.len() {
            break;
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&raw[i..i + n]);
        i += n;
    }
    if out.is_empty() {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(raw);
    }
    out
}

/// 会话包装：open 失败则标记不可用，调用方走 JPEG。
pub struct H264SessionEncoder {
    enc: Option<MfH264Encoder>,
    /// 当前码率缩放百分比（25–100），由 RTT 自适应写入。
    scale_pct: u32,
    base_bitrate: u32,
}

// windows-rs COM 指针非 Send；本进程 MTA + 会话任务串行访问。
unsafe impl Send for H264SessionEncoder {}
unsafe impl Send for MfH264Encoder {}

impl H264SessionEncoder {
    /// 按目标分辨率打开；码率由宽度决定（可覆盖）。
    pub fn try_open(width: u32, height: u32, fps: u32) -> Self {
        Self::try_open_with_bitrate(width, height, fps, bitrate_for_width(width))
    }

    pub fn try_open_with_bitrate(width: u32, height: u32, fps: u32, bitrate: u32) -> Self {
        match MfH264Encoder::open(width, height, fps, bitrate) {
            Ok(e) => Self {
                enc: Some(e),
                scale_pct: 100,
                base_bitrate: bitrate,
            },
            Err(e) => {
                log::warn!("[RC] H.264 不可用，回退 JPEG：{e}");
                Self {
                    enc: None,
                    scale_pct: 100,
                    base_bitrate: bitrate,
                }
            }
        }
    }

    pub fn available(&self) -> bool {
        self.enc.is_some()
    }

    pub fn scale_pct(&self) -> u32 {
        self.scale_pct
    }

    /// RTT 自适应：按百分比缩码率。变化 <15% 不重开（避免 thrashing）。
    /// 返回 true 表示编码器已按新码率重开。
    pub fn apply_bitrate_scale(&mut self, scale_pct: u32) -> bool {
        let scale = scale_pct.clamp(25, 100);
        if scale == self.scale_pct {
            return false;
        }
        if scale.abs_diff(self.scale_pct) < 15 && self.enc.is_some() {
            return false;
        }
        self.scale_pct = scale;
        let Some(enc) = self.enc.as_ref() else {
            return false;
        };
        let (w, h) = enc.size();
        let fps = enc.fps();
        let br = (self.base_bitrate as u64 * scale as u64 / 100).max(400_000) as u32;
        match MfH264Encoder::open(w, h, fps, br) {
            Ok(e) => {
                log::info!("[RC] H.264 码率调整为 {br} bps（{scale}%）");
                self.enc = Some(e);
                true
            }
            Err(e) => {
                log::warn!("[RC] 调整码率失败，保持原编码器：{e}");
                self.scale_pct = 100;
                false
            }
        }
    }

    /// 输入 BGRA。分辨率变化会按**新尺寸**重开编码器（含码率/level）。
    pub fn encode_bgra(&mut self, bgra: &[u8], w: u32, h: u32) -> Result<Vec<H264Packet>, String> {
        let Some(enc) = self.enc.as_mut() else {
            return Err("无 H.264 编码器".into());
        };
        let (ew, eh) = enc.size();
        if ew != (w & !1).max(64) || eh != (h & !1).max(64) {
            // 尺寸变了：基础码率按新宽重算，再叠当前缩放
            self.base_bitrate = bitrate_for_width(w);
            let br = (self.base_bitrate as u64 * self.scale_pct as u64 / 100).max(400_000) as u32;
            *enc = MfH264Encoder::open(w, h, enc.fps(), br)?;
        }
        let nv12 = super::dxgi::bgra_to_nv12(bgra, w, h)?;
        enc.encode_nv12(&nv12)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avcc_to_annexb() {
        let avcc = [0u8, 0, 0, 3, 0x65, 0x11, 0x22];
        let b = to_annex_b(&avcc);
        assert_eq!(&b[0..4], &[0, 0, 0, 1]);
        assert_eq!(&b[4..], &[0x65, 0x11, 0x22]);
    }

    #[test]
    fn already_annexb() {
        let raw = [0u8, 0, 0, 1, 0x67, 0x42];
        assert_eq!(to_annex_b(&raw), raw.to_vec());
    }

    #[test]
    fn level_and_bitrate_follow_resolution() {
        assert_eq!(h264_level_for(1280, 720), 40);
        assert_eq!(h264_level_for(1920, 1080), 42);
        assert_eq!(h264_level_for(3840, 2160), 51);
        assert!(bitrate_for_width(3840) >= 20_000_000);
        assert_eq!(webcodecs_codec_str(3840, 2160), "avc1.640033");
    }
}