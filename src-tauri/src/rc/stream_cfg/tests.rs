//! `stream_cfg.rs` 的单元测试（从原文件尾部的 mod tests 原样平移）。

use super::*;

fn c() -> StreamCfg {
    StreamCfg::new()
}

#[test]
fn 范围_virtual_抓整屏() {
    let s = c();
    s.set_scope("virtual").expect("virtual 合法");
    let o = s.snapshot();
    assert!(o.virtual_screen);
    assert_eq!(o.monitor, -1);
}

#[test]
fn 范围_primary_抓主屏() {
    let s = c();
    s.set_scope("primary").expect("primary 合法");
    let o = s.snapshot();
    assert!(!o.virtual_screen);
    assert_eq!(o.monitor, -1);
}

#[test]
fn 范围_monitor编号合法时落到具体显示器() {
    let s = c();
    s.set_scope("monitor:1").expect("monitor:1 合法");
    let o = s.snapshot();
    assert!(!o.virtual_screen, "指定显示器就不该再走整屏");
    assert_eq!(o.monitor, 1);
}

#[test]
fn 范围_monitor负号被拒且不改状态() {
    let s = c();
    s.set_scope("monitor:0").expect("先设一个合法值");
    let err = s.set_scope("monitor:-1").expect_err("负数必须被拒");
    assert_eq!(err, "显示器编号不能为负");
    assert_eq!(s.snapshot().monitor, 0, "被拒就不能留下半截改动");
}

#[test]
fn 范围_monitor非数字被拒() {
    let s = c();
    let err = s.set_scope("monitor:x").expect_err("非数字必须被拒");
    assert_eq!(err, "显示器编号无效，应为 monitor:0 / monitor:1…");
}

#[test]
fn 范围_乱字符串被拒() {
    let s = c();
    assert!(s.set_scope("").is_err());
    assert!(s.set_scope("Monitor:0").is_err(), "大小写敏感，不做兜底");
    assert!(s.set_scope("all").is_err());
}

#[test]
fn 画质五档加auto合法其余被拒() {
    let s = c();
    for q in ["uhd", "uhd60", "ultra", "sharp", "balanced", "smooth", "auto"] {
        assert!(s.set_quality(q).is_ok(), "{q} 应合法");
    }
    let err = s.set_quality("4k").expect_err("未定义的档位必须被拒");
    assert_eq!(
        err,
        "画质档只能是 auto / uhd / uhd60 / ultra / sharp / balanced / smooth / fps60 / fps120"
    );
}

#[test]
fn 编码只认_jpeg_h264_hevc() {
    let s = c();
    assert!(s.set_codec("jpeg").is_ok());
    assert!(s.snapshot().force_jpeg(), "jpeg ⇒ 强制本会话走 JPEG");
    assert!(s.set_codec("h264").is_ok());
    assert!(!s.snapshot().force_jpeg(), "h264 ⇒ 放开 H.264");
    assert!(s.set_codec("hevc").is_ok());
    assert_eq!(
        s.snapshot().codec,
        StreamCodec::Hevc,
        "hevc ⇒ 硬编 HEVC（打不开自动回落 H.264）"
    );
    let err = s.set_codec("vp9").expect_err("只认三种编码");
    assert_eq!(err, "编码只能是 jpeg / h264 / hevc");
}

#[test]
fn 没收到过任何输入时不暂停() {
    let s = c();
    // 会话刚开始，last_activity 还是 0：不管「现在」多大都不该暂停，
    // 否则首个心跳还没到就被判死。
    assert!(!s.should_pause(1_700_000_000_000));
}

#[test]
fn 超过心跳超时才暂停() {
    let s = c();
    s.touch_activity(1_000);
    assert!(!s.should_pause(1_000 + 3_500), "正好等于阈值不算超时");
    assert!(s.should_pause(1_000 + 3_501), "超出 1ms 就该暂停");
    s.touch_activity(1_000 + 3_501);
    assert!(!s.should_pause(1_000 + 3_501), "刷新活跃后立刻恢复");
}

#[test]
fn rtt_负数归零() {
    let s = c();
    s.note_rtt(-5);
    assert_eq!(s.rtt_ms(), 0);
    s.note_rtt(37);
    assert_eq!(s.rtt_ms(), 37);
}

#[test]
fn loss_码率缩放分档() {
    assert_eq!(bitrate_scale_for_loss(0), 100);
    assert_eq!(bitrate_scale_for_loss(9), 100);
    assert_eq!(bitrate_scale_for_loss(15), 80);
    assert_eq!(bitrate_scale_for_loss(30), 60);
    assert_eq!(bitrate_scale_for_loss(70), 40);
    assert_eq!(bitrate_scale_for_loss(200), 25);
    // RTT 满速但丢包高 → 取更差的那条
    let s = c();
    s.set_peer_rtt(10);
    s.note_stream_health(10, 60);
    assert_eq!(s.bitrate_scale(), 40);
    // 只有 RTT 时不受 loss 影响（未采样 = 0 = 满速）
    let s2 = c();
    s2.set_peer_rtt(300);
    assert_eq!(s2.bitrate_scale(), 40, "rtt 200~399 档 = 40%");
}

#[test]
fn rtt_码率缩放分档() {
    assert_eq!(bitrate_scale_for_rtt(0), 100);
    assert_eq!(bitrate_scale_for_rtt(30), 100);
    assert_eq!(bitrate_scale_for_rtt(80), 80);
    assert_eq!(bitrate_scale_for_rtt(150), 60);
    assert_eq!(bitrate_scale_for_rtt(250), 40);
    assert_eq!(bitrate_scale_for_rtt(800), 25);
    let s = c();
    assert_eq!(s.set_peer_rtt(200), 40);
    assert_eq!(s.bitrate_scale(), 40);
}

#[test]
fn 码率倍率与自动缩放相乘_越界被拒() {
    let s = c();
    // 默认 100：与既有行为完全一致（不干预）
    assert_eq!(s.set_peer_rtt(300), 40);
    assert_eq!(s.bitrate_scale(), 40);
    // 乘法语义：弱网 40% × 用户 200% = 80%（抬天花板但仍在保护内）
    s.set_user_bitrate_pct(200).expect("合法");
    assert_eq!(s.bitrate_scale(), 80);
    // 局域网满速 × 50% = 省带宽一半
    s.set_peer_rtt(10);
    s.note_stream_health(10, -1);
    s.set_user_bitrate_pct(50).expect("合法");
    assert_eq!(s.bitrate_scale(), 50);
    // 越界拒绝且不改状态
    assert!(s.set_user_bitrate_pct(49).is_err());
    assert!(s.set_user_bitrate_pct(201).is_err());
    assert_eq!(s.bitrate_scale(), 50, "被拒就不能留下半截改动");
    // 新会话复位：上一场的用户倍率不带走
    s.reset_from_cfg(super::super::video::EncodeProfile::default(), true, false, StreamCodec::Auto);
    s.set_peer_rtt(300);
    assert_eq!(s.bitrate_scale(), 40, "复位后回到纯自动缩放");
}

#[test]
fn 会话初始化会重置推流参数() {
    let s = c();
    s.set_scope("primary").expect("合法");
    s.set_codec("jpeg").expect("合法");
    s.reset_from_cfg(super::super::video::EncodeProfile::default(), true, false, StreamCodec::Auto);
    let o = s.snapshot();
    assert!(o.virtual_screen, "由配置决定");
    assert_eq!(o.monitor, -1);
    assert!(!o.force_jpeg(), "新会话不该继承上一会话的强制 JPEG");
}

#[test]
fn 配置缺省时画质回落自动_范围抓整屏() {
    let empty = serde_json::json!({});
    assert!(virtual_screen_from_cfg(&empty), "缺省就是抓整屏");
    assert_eq!(
        profile_from_cfg(&empty),
        super::super::video::EncodeProfile::of_name("balanced"),
        "auto 解析成 balanced 的编码参数起跑"
    );
    assert!(auto_from_cfg(&empty), "缺省档就是自动");
}

#[test]
fn 配置里写了_primary_才不抓整屏() {
    assert!(!virtual_screen_from_cfg(
        &serde_json::json!({ CFG_CAPTURE_SCOPE: "primary" })
    ));
    assert!(virtual_screen_from_cfg(
        &serde_json::json!({ CFG_CAPTURE_SCOPE: "virtual" })
    ));
    assert!(virtual_screen_from_cfg(
        &serde_json::json!({ CFG_CAPTURE_SCOPE: "monitor:1" })
    ));
}

/// 🔴 锁序回归（设计审查抓到的阻塞项）：
/// `auto_note_frame` 由**推流任务**每帧调用、`set_quality` 由**输入读取任务**
/// 调用，两条链路真并发。两者的 `opts` / `auto` 取锁顺序必须一致，
/// 否则就是 ABBA 死锁。锁序被改回去时，这条测试会**卡到超时**而不是给出
/// 漂亮的红——那正是死锁的形状，别把它当成机器慢。
#[test]
fn 自动判档与改档并发不死锁() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let s = Arc::new(StreamCfg::new());
    s.set_quality("auto").expect("合法");
    s.set_peer_rtt(300);

    let w = {
        let s = Arc::clone(&s);
        std::thread::spawn(move || {
            for i in 0..4_000i64 {
                s.auto_note_frame(400_000, 1_758_000_000_000 + i);
            }
        })
    };
    let q = {
        let s = Arc::clone(&s);
        std::thread::spawn(move || {
            for _ in 0..4_000 {
                // 与 auto_note_frame 抢同一对锁，且方向相反（opts → auto）
                s.set_quality("sharp").expect("合法");
                s.set_quality("auto").expect("合法");
            }
        })
    };

    let deadline = Instant::now() + Duration::from_secs(30);
    while !w.is_finished() || !q.is_finished() {
        assert!(
            Instant::now() < deadline,
            "两个任务在 30s 内没跑完 → opts/auto 的取锁顺序不一致（ABBA 死锁）"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    w.join().expect("推流侧线程");
    q.join().expect("输入侧线程");
}

/// 会话收尾必须复位自动档：`enabled` 留在 true、`tier` 停在末档的话，
/// `status()` 会在会话结束后继续报「生效档 = 流畅」这种不存在的档位。
#[test]
fn 会话收尾复位自动档() {
    let s = c();
    s.set_quality("auto").expect("合法");
    s.set_peer_rtt(300);
    for i in 0..24i64 {
        s.auto_note_frame(10_000, 1_758_000_000_000 + i * 1000);
    }
    assert_eq!(s.auto_tier_name(), "smooth", "先降到低档，制造待复位的残留");
    assert!(s.auto_enabled());

    s.auto_reset();
    assert!(!s.auto_enabled(), "复位后自动档必须关掉");
    assert_eq!(
        s.auto_tier_name(),
        "balanced",
        "档位回到初态（AutoTier::off），不留上一场的痕迹"
    );
}
