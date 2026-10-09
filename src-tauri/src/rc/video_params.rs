//! Platform-independent codec names and bitrate policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
    /// P2.3：AV1（FF 硬编专属；MF 无 AV1，open_chain 在 MF 前就拒绝）。
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
