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
    // 装配走 `shell`（唯一一份字段表）：过去这里手抄 21 个字段，
    // 加一位就编译不过，而编译错误会被当成「代码问题」而不是「测试该跟着走」。
    let enc = H264SessionEncoder::shell(
        VideoCodec::H264,
        None,
        bitrate_for_width(1920),
        120,
        100,
        false,
    );
    // 1080p120：8M × 2.6 = 20.8M——不是 ×2.6² 的 54M
    assert_eq!(enc.scaled_bitrate(), 20_800_000);
    // 弱网缩放 40% 也要真的压到位
    let mut scaled = enc;
    scaled.scale_pct = 40;
    assert_eq!(scaled.scaled_bitrate(), 8_320_000);
}

// 🔴 再审计 B5（2026-09-25）守卫单测：见 session.rs 底部的
// `码率缩放变更的时间冷却`（判据函数是 session 模块私有，测试就近放）。

/// 🔴 起播按**当前倍率**开（2026-10-03 真机教训）：过去恒按 100% 开，
/// 发起端 `SetBitratePct`（默认 200）约 0.9s 后才到 → `apply_bitrate_scale`
/// 必然再触发一次全链重开（MFT/NVENC 两次初始化、重开周期内帧全丢）。
/// 打开时吃进倍率后，起播后第一圈 apply 同值**不得**标记重开。
#[test]
fn 起播按倍率开_同值不再重开() {
    // 倍率 200：真机（MF 可用）会真开；无 MF 的机器回落 unavailable，
    // 两条路 scale_pct 都必须记录为 200（收口见 `shell`）。
    let mut enc = H264SessionEncoder::try_open_with_scale(VideoCodec::H264, 1920, 1080, 60, 200);
    assert_eq!(enc.scale_pct(), 200);
    // 1080p60 @200% = 8M × 1.6（60fps 因子）× 2.0 = 25.6M，与 scaled_bitrate 同口径
    assert_eq!(enc.scaled_bitrate(), 25_600_000);
    // 起播后第一圈 try_hardware_path 就会 apply 一次当前倍率——同值不得重开
    enc.apply_bitrate_scale(200);
    assert!(!enc.reopen_needed, "同值不得触发全链重开");
    // 越域缩放被 clamp 进 10–300：300 是**真变更**，仍要重开（这条别丢）
    enc.apply_bitrate_scale(999);
    assert_eq!(enc.scale_pct(), 300);
    assert!(enc.reopen_needed, "真变更仍要重开");
    // clamp 下限同样吃进来（弱网 5% 之类的越界值不能绕过 10 的底线）
    let low = H264SessionEncoder::try_open_with_scale(VideoCodec::H264, 1920, 1080, 30, 3);
    assert_eq!(low.scale_pct(), 10, "越下界被 clamp 到 10");
}

/// 🔴 甲-1/3/4（Issue #19，2026-10-12）：连败阶梯必须是「换引擎，不换协议」。
///
/// 事故形状：硬编坏但没崩的机器上，连败门槛是 **60** —— 1fps 环境里整整一分钟
/// 每帧都在白试同一个坏编码器（`编码重开 131`），熔断后永久只剩 GDI 全帧 JPEG，
/// ≈0.2–1.4fps 幻灯片。业界五家无一例外把「静图幻灯片」放在最后一档，前三档
/// 是软编 H.264（对照文档 `docs/硬编熔断降级-GitHub业界做法对照-2026-10-12.md` §0）。
///
/// 判据只有 [`encode_fail_verdict`] 一份，这里钉住它的四档边界；
/// `inbound/video.rs` 不许自己数帧（规则 11.1）。
#[test]
fn 硬编连败阶梯_三帧换软编_软编再三帧才熔断() {
    // 未定罪硬编档：门槛前一帧仍「同引擎再试」，到点就换引擎
    assert_eq!(
        encode_fail_verdict(ENC_FAIL_TO_SOFTWARE - 1, false),
        FailVerdict::RetrySameEngine
    );
    assert_eq!(encode_fail_verdict(ENC_FAIL_TO_SOFTWARE, false), FailVerdict::SwitchToSoftware);
    // 已定罪（当前在软编档）：换档判据必须彻底闭嘴，否则「软编→软编」反复翻烧饼
    assert_eq!(
        encode_fail_verdict(ENC_FAIL_FUSE - 1, true),
        FailVerdict::RetrySameEngine,
        "已定罪后不得再判换档"
    );
    assert_eq!(encode_fail_verdict(ENC_FAIL_FUSE, true), FailVerdict::Fuse);
    assert_eq!(encode_fail_verdict(99, true), FailVerdict::Fuse);
    // 钉住「不再是 60」：这条一旦被人改回大数，Issue #19 的幻灯片就无声复发
    assert!(
        ENC_FAIL_TO_SOFTWARE <= 5,
        "换引擎门槛回到 60 量级 = 一分钟白试坏编码器（RustDesk/scrcpy 均为 3）"
    );
    assert!(ENC_FAIL_FUSE <= 5, "熔断门槛同理，冷却重试已经兜住误判");
}

/// 🔴 甲-1/3/4 的状态机：换档即重开、成功清零连败但**不复位定罪**、
/// 定罪后 SetCodec 只认 H.264。
///
/// `note_encode_ok` 不清 `hw_broken` 是有意的会话级单向取舍（RustDesk
/// `encoder.disable()` 同款）——瞬态好转就重探硬编，等于把刚换到的软编再打回
/// 坏引擎。真正的重探留给冷却期满后的重建，那里读的是会话上的 `enc_hw_broken`。
#[test]
fn 连败驱动状态_换档即重开_成功后清零但不复位定罪() {
    let mut enc = H264SessionEncoder::shell(VideoCodec::H264, None, bitrate_for_width(1920), 30, 100, false);
    // 硬编档三连败 ⇒ 定罪 + 归零 + 标记重开（下一帧按软编档选型）
    // 计数在判决**之前**自增，所以前 N-1 帧还是 Retry，第 N 帧才换引擎。
    for i in 1..ENC_FAIL_TO_SOFTWARE {
        assert_eq!(
            enc.note_encode_fail(),
            FailVerdict::RetrySameEngine,
            "第 {i} 帧不得提前定罪（门槛 {ENC_FAIL_TO_SOFTWARE}）"
        );
    }
    assert_eq!(
        enc.note_encode_fail(),
        FailVerdict::SwitchToSoftware,
        "到点必须换引擎，不许继续白试硬编"
    );
    assert!(enc.hw_broken, "第 3 帧必须定罪硬编档");
    assert_eq!(enc.enc_fail_streak, 0, "换档后软编档自己数自己的连败");
    assert!(enc.reopen_needed, "换引擎必须重开编码器");
    // 软编档出帧成功 ⇒ 计数清零，但定罪保持
    enc.reopen_needed = false;
    enc.note_encode_ok();
    assert_eq!(enc.enc_fail_streak, 0);
    assert!(enc.hw_broken, "成功不得洗清硬编定罪（会话内单向）");
    assert!(enc.uses_software_encoder(), "丙：可见性口径与定罪同源");
    // 软编档再三连败 ⇒ 才熔断（同样：前 N-1 帧仍在同一引擎上重试）
    for i in 1..ENC_FAIL_FUSE {
        assert_eq!(
            enc.note_encode_fail(),
            FailVerdict::RetrySameEngine,
            "软编档第 {i} 帧不得提前熔断"
        );
    }
    assert_eq!(
        enc.note_encode_fail(),
        FailVerdict::Fuse,
        "软编档到点必须熔断（调用方据此停掉逐帧重开）"
    );
    // 定罪会话拒绝 HEVC/AV1：本机唯一可达的软编 MFT 是 H.264，
    // FF 的 AV1 候选链全是硬件编码器，放行=每圈「打不开→一帧 JPEG」。
    for c in [VideoCodec::Hevc, VideoCodec::Av1] {
        enc.reopen_needed = false;
        enc.set_codec(c);
        assert_eq!(enc.codec(), VideoCodec::H264, "{c:?} 在硬编已定罪的会话里不得生效");
        assert!(!enc.reopen_needed, "被拒绝的切换不得标记重开");
    }
    // H.264 内部换 fps 仍然照走（别把门关上到连正常换档都不干活）
    enc.set_fps(60);
    assert!(enc.reopen_needed);
}

/// 🔴 乙-3（2026-10-12，学 RustDesk 1.5.0 `latest_quality().is_custom()`）：
/// **锁档时不为改码率重开编码器**。
///
/// Issue #19 现场的另一半：实际生效档是锁档 ultra，而本机驱动不支持热改码率 ⇒
/// 拥塞控制器每一拍的预算差异都变成一次全链重开（3 分钟 30 次流重建 +
/// 编码重开 131）。锁档语义就是「用户指定的画质优先」，那就保持开档码率，
/// 只把「为什么没跟上去」说一次。自动档的行为一个字不许变（骤降仍要重开）。
#[test]
fn 锁档不改码率_自动档骤降照旧重开() {
    let before = {
        let e = H264SessionEncoder::shell(VideoCodec::H264, None, bitrate_for_width(1920), 30, 100, false);
        e.scaled_bitrate()
    };
    let target = before / 3;

    // 锁档（auto_enabled = false ⇒ allowed = false）
    let mut locked = H264SessionEncoder::shell(VideoCodec::H264, None, bitrate_for_width(1920), 30, 100, false);
    locked.set_bitrate_reopen_allowed(false);
    locked.apply_bitrate_budget(target);
    assert!(!locked.reopen_needed, "锁档不得为码率重开 —— 每次重开是几百 ms 空窗");
    assert_eq!(locked.scaled_bitrate(), before, "锁档保持开档时的码率");
    assert!(locked.bitrate_lock_noticed, "必须说过一次（规则 15.3：不许静默失败）");
    // 第二拍不得重复告警：标志位一旦置上就不要再走那条 warn
    locked.apply_bitrate_budget(before / 4);
    assert!(!locked.reopen_needed);

    // 自动档：同样的骤降必须真的重开（安全网不能把正常路径一起砍掉）
    let mut auto = H264SessionEncoder::shell(VideoCodec::H264, None, bitrate_for_width(1920), 30, 100, false);
    auto.apply_bitrate_budget(target);
    assert!(auto.reopen_needed, "自动档骤降仍要重开");
    assert_eq!(auto.scaled_bitrate(), target, "自动档必须真的把预算吃进去");
    assert!(!auto.bitrate_lock_noticed, "自动档不该有锁档告警");
}
