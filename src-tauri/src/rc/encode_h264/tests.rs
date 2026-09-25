//! `encode_h264.rs` 的单元测试（原样平移）。

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
fn q4_4k60_h264_level必须抬到52() {
    // 4K60 = 32400 MB/帧 × 60 ≈ 194 万 MB/s：L5.1（983040）超规格约一倍
    assert_eq!(h264_level_for(3840, 2160, 60), 52);
    // 4K30 仍是 L5.1；1080p120 仍 5.1（D4）；1440p60 曾按 L5.0 超规格 → 5.1
    assert_eq!(h264_level_for(3840, 2160, 30), 51);
    assert_eq!(h264_level_for(1920, 1080, 120), 51);
    assert_eq!(h264_level_for(2560, 1440, 60), 51);
    // 低档不降级：1080p30 保持 4.2（兼容性优先，只升不降）
    assert_eq!(h264_level_for(1920, 1080, 30), 42);
    // 前端解码串同口径（Q4 的 uhd60 H.264 兜底路径）
    assert_eq!(webcodecs_codec_str(3840, 2160, 60), "avc1.640034");
}

#[test]
fn q3_hevc解码串与标准名() {
    // level 按 luma 采样率取最小覆盖档（2026-09-19 审查 P2：旧二分把
    // 1080p60/1440p 压进 L4.0 的 66.7M MaxLumaSr，超规格 1.9~3.3 倍）
    assert_eq!(
        webcodecs_hevc_str(1920, 1080, 30),
        "hev1.1.6.L120.B0",
        "1080p30=62.2M ≤ L4.0 的 66.7M"
    );
    assert_eq!(
        webcodecs_hevc_str(1920, 1080, 60),
        "hev1.1.6.L123.B0",
        "1080p60=124M 超 L4.0，落 L4.1"
    );
    assert_eq!(
        webcodecs_hevc_str(2560, 1440, 60),
        "hev1.1.6.L150.B0",
        "1440p60=221M 落 L5.0"
    );
    assert_eq!(
        webcodecs_hevc_str(3840, 2160, 30),
        "hev1.1.6.L150.B0",
        "4K30=249M 落 L5.0"
    );
    assert_eq!(
        webcodecs_hevc_str(3840, 2160, 60),
        "hev1.1.6.L153.B0",
        "4K60=498M 落 L5.1"
    );
    assert_eq!(
        webcodecs_hevc_str(3840, 2160, 0),
        "hev1.1.6.L153.B0",
        "fps 未指定按 60 兜最坏——不能把解码端配在流规格之下"
    );
    assert_eq!(VideoCodec::of_str("hevc"), Some(VideoCodec::Hevc));
    assert_eq!(VideoCodec::of_str("h264"), Some(VideoCodec::H264));
    assert_eq!(VideoCodec::of_str("vp9"), None);
    assert_eq!(VideoCodec::H264.as_str(), "h264");
    assert_eq!(VideoCodec::Hevc.mf_subtype(), &MFVideoFormat_HEVC);
}

#[test]
fn level_and_bitrate_follow_resolution() {
    assert_eq!(h264_level_for(1280, 720, 30), 40);
    assert_eq!(h264_level_for(1920, 1080, 30), 42);
    assert_eq!(h264_level_for(3840, 2160, 30), 51);
    // 审查 D4：高帧率必须抬 level——1080p120 超出 L4.2 宏块率 87%
    assert_eq!(h264_level_for(1920, 1080, 120), 51);
    assert_eq!(h264_level_for(1920, 1080, 60), 42, "1080p60 在 L4.2 内");
    // 2026-09-22：fps144/165 档（1080p144≈1.17M、1080p165≈1.35M MB/s）超出
    // L5.1（983040），宏块率校验必须自动抬到 L5.2——写错就是超规格流。
    assert_eq!(h264_level_for(1920, 1080, 144), 52);
    assert_eq!(h264_level_for(1920, 1080, 165), 52);
    assert_eq!(webcodecs_codec_str(3840, 2160, 30), "avc1.640033");
    assert_eq!(webcodecs_codec_str(1920, 1080, 120), "avc1.640033");
    assert_eq!(webcodecs_codec_str(1920, 1080, 165), "avc1.640034", "L5.2=0x34");
    assert!(bitrate_for_width(3840) >= 20_000_000);
    // 审查 D3：码率随帧率抬升——fps120 不能沿用 30fps 的表
    assert_eq!(fps_bitrate_factor(30), 100);
    assert_eq!(fps_bitrate_factor(60), 160);
    assert_eq!(fps_bitrate_factor(120), 260);
    // 2026-09-22：144/165 沿斜率外推（每 +60fps +100 点）
    assert_eq!(fps_bitrate_factor(144), 300);
    assert_eq!(fps_bitrate_factor(165), 335);
    assert_eq!(bitrate_for(1920, 30), bitrate_for_width(1920));
    assert!(bitrate_for(1920, 120) >= bitrate_for_width(1920) * 2);
}

/// 🔴 帧率因子只乘一次（2026-09-19 审查 P1）：base_bitrate 是 30fps 标定的
/// 宽度基准，scaled_bitrate 在其上乘帧率因子与缩放。曾几何时 try_open 把
/// bitrate_for(width, fps)（已含因子）存进 base_bitrate，任何一次重开
/// （RTT 缩放 / SetBitratePct / 换档）都会把帧率因子乘第二次：
/// 1080p120 应 20.8Mbps，实际 54Mbps，弱网降到 40% 也压不下来。
#[test]
fn 码率基准的帧率因子只乘一次() {
    let enc = H264SessionEncoder {
        enc: None,
        codec: VideoCodec::H264,
        scale_pct: 100,
        base_bitrate: bitrate_for_width(1920),
        fps: 120,
        gpu_mode: false,
        reopen_needed: false,
        gpu_fail_streak: 0,
        hevc_fail_streak: 0,
        hevc_broken: false,
        nv12_buf: Vec::new(),
        last_scale_change: None,
    };
    // 1080p120：8M × 2.6 = 20.8M——不是 ×2.6² 的 54M
    assert_eq!(enc.scaled_bitrate(), 20_800_000);
    // 弱网缩放 40% 也要真的压到位
    let mut scaled = enc;
    scaled.scale_pct = 40;
    assert_eq!(scaled.scaled_bitrate(), 8_320_000);
}

// 🔴 再审计 B5（2026-09-25）守卫单测：见 session.rs 底部的
// `码率缩放变更的时间冷却`（判据函数是 session 模块私有，测试就近放）。
