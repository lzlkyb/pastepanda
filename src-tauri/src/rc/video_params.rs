//! Platform-independent codec names and bitrate policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
    /// AV1: Windows FF hardware candidates, Mac FFmpeg/SVT software encoder.
    Av1,
}
impl VideoCodec {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
        }
    }
    pub fn of_str(s: &str) -> Option<Self> {
        match s {
            "h264" => Some(Self::H264),
            "hevc" => Some(Self::Hevc),
            "av1" => Some(Self::Av1),
            _ => None,
        }
    }
}

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

/// Protocol metadata always carries a codec family, never a decoder parameter
/// string. Mac native encoders provide avc1/hev1; Windows provides family names.
pub(crate) fn wire_codec_label(codec: &str) -> Option<&'static str> {
    match codec {
        "jpeg" => Some("jpeg"),
        "h264" => Some("h264"),
        "hevc" => Some("hevc"),
        "av1" => Some("av1"),
        c if c.starts_with("avc1.") && c.len() == 11 => Some("h264"),
        c if c.starts_with("hev1.") && c.len() < 64 => Some("hevc"),
        c if c.starts_with("av01.") && c.len() < 64 => Some("av1"),
        _ => None,
    }
}

#[cfg(test)]
mod wire_codec_tests {
    use super::*;
    #[test]
    fn every_producer_uses_the_same_wire_family() {
        for (native, family) in [
            ("avc1.64002a", "h264"),
            ("hev1.1.6.L120.B0", "hevc"),
            ("av01.0.08M.08", "av1"),
            ("av1", "av1"),
            ("jpeg", "jpeg"),
        ] {
            assert_eq!(wire_codec_label(native), Some(family));
            assert_eq!(wire_codec_label(family), Some(family));
        }
        assert_eq!(wire_codec_label("unknown"), None);
    }
    #[test]
    fn mac_software_av1_fps_budget_does_not_change_native_video() {
        assert_eq!(mac_encoder_fps(VideoCodec::Av1, 165), 30);
        assert_eq!(mac_encoder_fps(VideoCodec::Av1, 15), 15);
        assert_eq!(mac_encoder_fps(VideoCodec::H264, 165), 165);
        assert_eq!(mac_encoder_fps(VideoCodec::Hevc, 120), 120);
        assert_eq!(mac_encoder_fps(VideoCodec::Av1, 0), 1);
    }
}

pub fn fps_bitrate_factor(fps: u32) -> u64 {
    match fps {
        0..=30 => 100,
        31..=60 => 160,
        61..=120 => 260,
        121..=144 => 300,
        _ => 335,
    }
}

pub fn bitrate_for(width: u32, fps: u32) -> u32 {
    ((bitrate_for_width(width) as u64 * fps_bitrate_factor(fps)) / 100) as u32
}

/// Packet contract shared by Media Foundation and VideoToolbox producers.
#[derive(Debug)]
pub struct VideoPacket {
    pub at_ms: i64,
    pub data: Vec<u8>,
    pub key: bool,
    pub width: u32,
    pub height: u32,
}

/// Match Mac stream capture cadence to its supported native encoder range.
pub(crate) fn mac_capture_fps(interval_ms: u64) -> u32 {
    crate::rc::pace::want_fps_for(interval_ms, false, true).min(60)
}

pub(crate) fn mac_encoder_fps(codec: VideoCodec, fps: u32) -> u32 {
    fps.max(1)
        .min(if codec == VideoCodec::Av1 { 30 } else { 165 })
}
