//! 录屏画质档位——「档位 → 编码参数」的唯一口径（纯函数，无环境可单测）。
//!
//! 与远控的 `EncodeProfile` 分表：那是网络传输导向（码率受 RTT 自适应压缩），
//! 录屏是质量导向（写本地文件，码率只受体积约束）。共用底层
//! `bitrate_for_width`（30fps 标定）保证两套档位的同一分辨率基准码率一致。
//!
//! 分辨率缩放走「高度上限」而非固定宽：竖屏 / 超宽屏按高度钳制等比缩，
//! 宽高最后对齐偶数（H.264/HEVC 宏块要求，NV12 同）。

use crate::rc::encode_h264::{bitrate_for_width, fps_bitrate_factor, VideoCodec};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecQuality {
    /// 原分辨率 60fps，HEVC 优先，码率上浮——「原画」档。
    Original,
    /// 原分辨率 30fps，H.264——兼容性最好的默认档。
    High,
    /// 高度 ≤1080、30fps，H.264。
    Standard,
    /// 高度 ≤720、30fps，H.264——小体积。
    Smooth,
}

impl RecQuality {
    pub fn of_str(s: &str) -> Option<Self> {
        match s {
            "original" => Some(Self::Original),
            "high" => Some(Self::High),
            "standard" => Some(Self::Standard),
            "smooth" => Some(Self::Smooth),
            _ => None,
        }
    }

    /// config/前端用的 key（`of_str` 的逆）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::High => "high",
            Self::Standard => "standard",
            Self::Smooth => "smooth",
        }
    }

    pub fn fps(self) -> u32 {
        match self {
            Self::Original => 60,
            _ => 30,
        }
    }

    /// 目标编码标准。原画档 HEVC 优先（同码率画质更高），由
    /// `H264SessionEncoder` 的回落链兜底 HEVC 缺失的机器。
    pub fn codec(self) -> VideoCodec {
        match self {
            Self::Original => VideoCodec::Hevc,
            _ => VideoCodec::H264,
        }
    }

    /// 高度上限（原分辨率档不缩放）。`None` = 不缩。
    pub fn height_cap(self) -> Option<u32> {
        match self {
            Self::Original => None,
            Self::High => None,
            Self::Standard => Some(1080),
            Self::Smooth => Some(720),
        }
    }

    /// 基准码率（bit/s）：远控口径（`bitrate_for_width`，30fps 标定）× 帧率因子，
    /// 原画档再上浮 150%（60fps HEVC 大画面，参照 Moonlight 本地档给足）。
    pub fn bitrate(self, width: u32) -> u32 {
        let base = bitrate_for_width(width) as u64;
        let factor = fps_bitrate_factor(self.fps());
        let lift = match self {
            Self::Original => 250, // %：基准 × 2.5
            _ => 100,
        };
        ((base * factor * lift) / 10_000) as u32
    }
}

/// 档位 + 源尺寸 → 实际编码尺寸（等比、高度钳制、对齐偶数）。
///
/// 源宽高本身先钳成偶数（选区可能落在奇数像素上）再算缩放；
/// 缩放后不足 2px 的维度钳成 2（编不出 0 尺寸）。
pub fn encoded_size(quality: RecQuality, src_w: u32, src_h: u32) -> (u32, u32) {
    let w = src_w.max(2) & !1;
    let h = src_h.max(2) & !1;
    let Some(cap) = quality.height_cap() else {
        return (w, h);
    };
    if h <= cap {
        return (w, h);
    }
    let sw = ((w as u64) * (cap as u64) / (h as u64)).max(2) as u32 & !1;
    (sw, cap & !1)
}

/// 选区矩形钳成合法编码区域：尺寸 ≥2、对齐偶数、且不越出 `(max_w, max_h)` 边界。
/// `(x, y)` 允许为负吗——不允许：调用方保证选区已在虚拟屏坐标系内钳过位，
/// 这里只做防御（负数一律收到 0）。
pub fn clamp_rect(x: i32, y: i32, w: u32, h: u32, max_w: u32, max_h: u32) -> (i32, i32, u32, u32) {
    let w = (w.max(2) & !1).min(max_w.max(2) & !1);
    let h = (h.max(2) & !1).min(max_h.max(2) & !1);
    let x = x.clamp(0, (max_w as i32 - w as i32).max(0));
    let y = y.clamp(0, (max_h as i32 - h as i32).max(0));
    (x, y, w, h)
}

/// 输出文件名：`屏幕录制_2026-10-04_1530.mp4`（本地时区）。
pub fn output_file_name(now: chrono::DateTime<chrono::Local>) -> String {
    format!("屏幕录制_{}.mp4", now.format("%Y-%m-%d_%H%M%S"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 档位参数表() {
        assert_eq!(RecQuality::Original.fps(), 60);
        assert_eq!(RecQuality::Original.codec(), VideoCodec::Hevc);
        assert_eq!(RecQuality::High.codec(), VideoCodec::H264);
        assert_eq!(RecQuality::Standard.height_cap(), Some(1080));
        assert_eq!(RecQuality::of_str("original"), Some(RecQuality::Original));
        assert_eq!(RecQuality::of_str("nope"), None);
        // 2560 宽：基准 14M；原画 = 14M ×1.6 ×2.5 = 56M；高清 = 14M ×1.0 = 14M
        assert_eq!(RecQuality::Original.bitrate(2560), 56_000_000);
        assert_eq!(RecQuality::High.bitrate(2560), 14_000_000);
    }

    #[test]
    fn 编码尺寸_高度钳制与偶数对齐() {
        // 2560×1440 原画：不缩
        assert_eq!(encoded_size(RecQuality::Original, 2560, 1440), (2560, 1440));
        // 标准（≤1080）：2560×1440 → 1920×1080
        assert_eq!(encoded_size(RecQuality::Standard, 2560, 1440), (1920, 1080));
        // 流畅（≤720）
        assert_eq!(encoded_size(RecQuality::Smooth, 2560, 1440), (1280, 720));
        // 奇数源：先对齐偶数再算
        assert_eq!(encoded_size(RecQuality::Standard, 2559, 1439), (1920, 1080));
        // 竖屏 1080×1920 → 标准档高度钳 1080：宽等比 607→606（偶）
        assert_eq!(encoded_size(RecQuality::Standard, 1080, 1920), (606, 1080));
    }

    #[test]
    fn 选区钳位() {
        // 奇数宽高对齐偶数；越界钳回边界内
        assert_eq!(clamp_rect(10, 10, 101, 101, 2560, 1440), (10, 10, 100, 100));
        // 选区超过源尺寸：钳到源（偶数化）
        assert_eq!(clamp_rect(0, 0, 3000, 2000, 2560, 1440), (0, 0, 2560, 1440));
        // 负坐标收到 0
        assert_eq!(clamp_rect(-5, -5, 100, 100, 2560, 1440), (0, 0, 100, 100));
        // x/y 越过右/下边界时收进边界（宽 100 → x ≤ 2460）
        assert_eq!(clamp_rect(3000, 10, 100, 100, 2560, 1440), (2460, 10, 100, 100));
    }

    #[test]
    fn 文件名格式() {
        use chrono::TimeZone;
        let t = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 15, 30, 5)
            .unwrap();
        // 精确到秒：同名冲突由 commands 层追加 _2/_3 序号兜底
        assert_eq!(output_file_name(t), "屏幕录制_2026-10-04_153005.mp4");
    }
}
