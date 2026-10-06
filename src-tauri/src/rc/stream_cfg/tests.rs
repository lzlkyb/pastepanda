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
    for q in [
        "uhd", "uhd60", "ultra", "sharp", "balanced", "smooth", "auto", "fps60", "fps120",
        "fps144", "fps165",
    ] {
        assert!(s.set_quality(q).is_ok(), "{q} 应合法");
    }
    let err = s.set_quality("4k").expect_err("未定义的档位必须被拒");
    assert_eq!(
        err,
        "画质档只能是 auto / uhd / uhd60 / ultra / sharp / balanced / smooth / fps60 / fps120 / fps144 / fps165"
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
    // 🔴 user 显式钉 100：本测试只验证 auto 分层判据，不掺默认 200（那个在
    // `码率倍率默认200_与自动缩放相乘_越界被拒` 里钉）
    let s = c();
    s.set_user_bitrate_pct(100).expect("合法");
    s.set_peer_rtt(10);
    s.note_stream_health(10, 60, 0);
    assert_eq!(s.bitrate_scale(), 40);
    // 只有 RTT 时不受 loss 影响（未采样 = 0 = 满速）
    let s2 = c();
    s2.set_user_bitrate_pct(100).expect("合法");
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
    s.set_user_bitrate_pct(100).expect("合法"); // 只测 auto 分层，见 loss 同款注释
    assert_eq!(s.set_peer_rtt(200), 40);
    assert_eq!(s.bitrate_scale(), 40);
}

#[test]
fn 码率倍率默认200_与自动缩放相乘_越界被拒() {
    let s = c();
    // 🔴 默认 200（2026-10-02 用户拍板「最高档起步，弱网自动降」）：
    // 未测通不能按高速 LAN 起步；收到健康样本后尊重默认倍率。
    assert_eq!(s.bitrate_scale(), 25, "未知链路保守起播");
    s.set_user_bitrate_pct(200).unwrap();
    assert_eq!(s.bitrate_scale(), 25, "倍率不能绕过未知链路保护");
    s.set_peer_rtt(10);
    assert_eq!(s.bitrate_scale(), 200, "健康链路恢复默认倍率");
    // 弱网自动压回：40% × 200% = 80%——抬天花板但弱网保护不被绕过
    s.set_peer_rtt(300);
    assert_eq!(s.bitrate_scale(), 80);
    // 显式选 100（跟随链路）：回到 auto 本身，旧默认降级为显式选项
    s.set_user_bitrate_pct(100).expect("合法");
    assert_eq!(s.bitrate_scale(), 40);
    // 健康链路 auto=100 × 200% = 200（清晰优先）
    s.set_user_bitrate_pct(200).expect("合法");
    s.set_peer_rtt(10);
    s.note_stream_health(10, -1, 0);
    assert_eq!(s.bitrate_scale(), 200);
    // 局域网满速 × 50% = 省带宽一半
    s.set_user_bitrate_pct(50).expect("合法");
    assert_eq!(s.bitrate_scale(), 50);
    // 越界拒绝且不改状态
    assert!(s.set_user_bitrate_pct(49).is_err());
    assert!(s.set_user_bitrate_pct(201).is_err());
    assert_eq!(s.bitrate_scale(), 50, "被拒就不能留下半截改动");
    // 新会话复位：上一场的用户倍率不带走，回归默认 200
    s.reset_from_cfg(super::super::video::EncodeProfile::default(), true, false, StreamCodec::Auto, false);
    s.set_peer_rtt(300);
    assert_eq!(s.bitrate_scale(), 80, "复位后回到默认 200 × 弱网 40%");
}

/// 🔴 雪崩倍率旁路（2026-10-03）：帧龄 EMA 破秒 = 队列单调积累（08:22 真机
/// 会话帧龄一路涨到 46s），200%×15%=30% 的「底线」照样把队列灌死——硬保护
/// 不该被「清晰优先」乘回去。断言序列按 α=1/2 EMA 逐步推算。
#[test]
fn 帧龄破秒雪崩时绕过用户倍率() {
    let s = c();
    s.set_user_bitrate_pct(200).expect("合法");
    s.set_peer_rtt(10);
    s.set_peer_queue_ms(2000);
    s.set_peer_queue_ms(2000);
    assert_eq!(
        s.bitrate_scale(),
        15,
        "破秒区只听链路的（queue>500 档 = 15%），倍率不参与"
    );
    // 2000 → (2000+100)/2 = 1050，仍在破秒区
    s.set_peer_queue_ms(100);
    assert_eq!(s.bitrate_scale(), 15);
    // 1050 → 575 → 337 → 218：回到 1s 内，倍率恢复参与（45% × 200%）
    s.set_peer_queue_ms(100);
    s.set_peer_queue_ms(100);
    s.set_peer_queue_ms(100);
    assert_eq!(s.bitrate_scale(), 90, "队列回到 1s 内恢复 45%×200%");
    // 218 →(×10 EMA)→ 收敛到 10：健康链路 100% × 200%
    for _ in 0..12 {
        s.set_peer_queue_ms(10);
    }
    assert_eq!(s.bitrate_scale(), 200);
}

#[test]
fn 会话初始化会重置推流参数() {
    let s = c();
    s.set_scope("primary").expect("合法");
    s.set_codec("jpeg").expect("合法");
    s.reset_from_cfg(super::super::video::EncodeProfile::default(), true, false, StreamCodec::Auto, false);
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

// ── 时钟偏差校准（2026-09-27 重做：NTP 式 min-RTT 过滤）──

/// 回归钉：旧实现 `rtt > 300ms 一律丢弃` ⇒ 持续 ~560ms 的内网全程收不到
/// 任何样本，「画面龄」被两机时钟差（隔离内网可漂到秒级）污染。
/// 重做后高 RTT 样本照样立锚。
#[test]
fn skew_高rtt样本也参与校准() {
    let s = c();
    s.note_clock_skew(1_900, 560);
    assert_eq!(s.clock_skew_ms(), 1_900, "首个可信样本直接立锚");
}

#[test]
fn skew_只信接近历史最快的往返() {
    let s = c();
    s.note_clock_skew(10, 40); // 历史最快 40ms，立锚
    // 突刺样本：rtt 990 远超 min+100，纯排队产物，必须整条拒
    s.note_clock_skew(910, 990);
    assert_eq!(s.clock_skew_ms(), 10);
    s.note_clock_skew(14, 200); // 200 > 40+100 → 拒
    assert_eq!(s.clock_skew_ms(), 10);
    s.note_clock_skew(14, 100); // 100 ≤ 140 → 收，EMA (10*7+14*3)/10
    assert_eq!(s.clock_skew_ms(), 11);
}

/// 初始锚可能歪（首样本误差 ±rtt/2），隔离内网时钟也会漂：连续拒绝到
/// 上限必须丢锚重来，否则坏锚永远无法被修正。
#[test]
fn skew_坏锚在连续离群后重锚() {
    let s = c();
    s.note_clock_skew(2_000, 50); // 坏锚
    for _ in 0..20 {
        s.note_clock_skew(40, 50); // 与锚差 >150，连续离群
    }
    assert_eq!(s.clock_skew_ms(), 0, "20 连拒后坏锚应被丢弃");
    s.note_clock_skew(40, 50);
    assert_eq!(s.clock_skew_ms(), 40, "重锚后新样本立锚");
}

#[test]
fn skew_路径持续变慢不能永远锁住旧锚() {
    let s = c();
    s.note_clock_skew(1_056, 40);
    for _ in 0..20 {
        s.note_clock_skew(2, 500);
    }
    assert_eq!(s.clock_skew_ms(), 0, "RTT 过滤的连续拒绝也必须触发重锚");
    s.note_clock_skew(2, 500);
    assert_eq!(s.clock_skew_ms(), 2, "新路径上的样本必须能重新校准");
}

#[test]
fn skew_偶发慢样本不应清掉健康锚() {
    let s = c();
    s.note_clock_skew(10, 40);
    for _ in 0..30 {
        s.note_clock_skew(900, 990);
        s.note_clock_skew(10, 40);
    }
    assert_eq!(s.clock_skew_ms(), 10);
}

// ── NetHint 档位滞回（2026-09-27）──

#[test]
fn rtt_hint_稳态不发提示() {
    // 内网稳态 6~17ms：永远停在档位 0，一个 NetHint 都不该发
    for ema in [6i64, 9, 14, 17, 50, 99] {
        assert_eq!(rtt_hint_tier(0, ema), (0, false), "ema {ema} 不该跨档");
    }
}

#[test]
fn rtt_hint_尖刺不跨档_持续才跨() {
    // 单个 1200ms 尖刺会把 EMA 抬一拍，但抬不到 140 就回落 → 不跨档
    assert_eq!(rtt_hint_tier(0, 130), (0, false));
    // 持续劣化到 140+ 才升档
    assert_eq!(rtt_hint_tier(0, 150), (1, true));
}

#[test]
fn rtt_hint_边界滞回() {
    // 档位 1 内来回走动：不跨档
    assert_eq!(rtt_hint_tier(1, 100), (1, false));
    assert_eq!(rtt_hint_tier(1, 200), (1, false));
    // 升到档位 2 需要 ≥280（不是 200）；降回档位 0 需要 <80（不是 100）
    assert_eq!(rtt_hint_tier(1, 270), (1, false));
    assert_eq!(rtt_hint_tier(1, 290), (2, true));
    assert_eq!(rtt_hint_tier(1, 85), (1, false));
    assert_eq!(rtt_hint_tier(1, 75), (0, true));
    // 档位 2 退回需要 <160（不是 200）
    assert_eq!(rtt_hint_tier(2, 180), (2, false));
    assert_eq!(rtt_hint_tier(2, 150), (1, true));
}

// ── P3.2 带宽估计 → 码率缩放 ──

#[test]
fn bw_码率缩放分档() {
    assert_eq!(bitrate_scale_for_bw(0), 100, "未采样不约束");
    assert_eq!(bitrate_scale_for_bw(1_000), 25);
    assert_eq!(bitrate_scale_for_bw(4_000), 50);
    assert_eq!(bitrate_scale_for_bw(10_000), 75);
    assert_eq!(bitrate_scale_for_bw(50_000), 100);
    assert_eq!(bitrate_scale_for_bw(-5), 100, "负值按未采样处理");
}

#[test]
fn bw_采样后参与三信号取min() {
    let s = c();
    s.set_user_bitrate_pct(100).expect("合法"); // 只测 auto 分层，见 loss 同款注释
    s.note_stream_health(10, 0, 1_000); // RTT 好、丢包 0、带宽估计只有 1Mbps
    assert_eq!(
        s.bitrate_scale(),
        25,
        "带宽窄必须压住码率，RTT/丢包再健康也不放行"
    );
    // 恢复带宽 → 回满速（EMA 上升需要几拍）
    for _ in 0..12 {
        s.note_stream_health(10, 0, 50_000);
    }
    assert_eq!(s.bitrate_scale(), 100);
}


// ── 2026-09-28：帧龄快速码控（AP 队列 in-band 观测）────────────────────────

#[test]
fn 排队压力分段_90ms内不约束_超500砍到15() {
    assert_eq!(super::bitrate_scale_for_queue(0), 100); // 未采样不约束
    assert_eq!(super::bitrate_scale_for_queue(-50), 100); // 异常样本不约束
    assert_eq!(super::bitrate_scale_for_queue(90), 100);
    assert_eq!(super::bitrate_scale_for_queue(91), 70);
    assert_eq!(super::bitrate_scale_for_queue(180), 70);
    assert_eq!(super::bitrate_scale_for_queue(300), 45);
    assert_eq!(super::bitrate_scale_for_queue(500), 25);
    assert_eq!(super::bitrate_scale_for_queue(501), 15);
}

#[test]
fn 排队压力EMA_升快降慢() {
    let s = c();
    s.set_peer_rtt(10);
    s.set_user_bitrate_pct(100).expect("合法"); // 只测 auto 分层，见 loss 同款注释
    s.set_peer_queue_ms(170);
    assert_eq!(s.bitrate_scale(), 70); // 170ms → 立刻压
    // 队列暴涨：升 α=1/2——两拍就到位大半
    s.set_peer_queue_ms(600);
    s.set_peer_queue_ms(600);
    let after_up = s.bitrate_scale();
    assert!(after_up <= 25, "持续高压必须深压，得到 {after_up}%");
    // 队列回落：降 α=1/2（发起端已 EMA 过，这里只轻度平滑——两层慢速叠加
    // 会把码率钉死几十秒，见 set_peer_queue_ms 注释）
    s.set_peer_queue_ms(10);
    assert!(s.bitrate_scale() >= after_up, "回落必须开始恢复");
    for _ in 0..8 {
        s.set_peer_queue_ms(10);
    }
    assert_eq!(s.bitrate_scale(), 100, "稳态后应满血");
}

#[test]
fn 帧粒度丢包反馈_与本端丢包取max() {
    let s = c();
    s.set_peer_rtt(10);
    // 本端 0 丢包，对端反馈 80‰ → 应按 80‰ 的档位压
    s.note_peer_frame_loss(80);
    let with_hint = s.bitrate_scale();
    assert!(with_hint < 100, "帧反馈 80‰ 必须压码率，得到 {with_hint}%");
    // 本端 conn 级丢包更高 → 取更糟的那个
    s.note_stream_health(10, 200, 0);
    assert!(s.bitrate_scale() <= with_hint);
    // 0/负值 = 无样本，不许清掉已有反馈
    let s2 = c();
    s2.note_peer_frame_loss(300);
    s2.note_peer_frame_loss(0);
    s2.note_peer_frame_loss(-1);
    assert!(s2.bitrate_scale() < 100);
}

#[test]
fn 视频数据报放行判据_未采样保守_采样达标才开() {
    use super::video_dgram_allowed;
    // 未采样（0，含全部中继路径）= 不放行：默认可靠流，防数据报灌爆链路
    // （2026-10-02 19:05 会话实测：中继路径 rtt 恒 0，降级判据失明，
    //  视频数据报把桌面↔中继连接堵死，pong/控制帧/JPEG 流全出不去）
    assert!(!video_dgram_allowed(0, 0));
    assert!(!video_dgram_allowed(0, 500));
    // 局域网：采样到达且快 → 放行（~1s 内完成切换）
    assert!(video_dgram_allowed(5, 0));
    assert!(video_dgram_allowed(120, 80));
    // 公网直连：RTT 越线不放行（18:15 会话 886ms 数据报全丢）
    assert!(!video_dgram_allowed(300, 0));
    assert!(!video_dgram_allowed(886, 10));
    // 丢包越线同样不放行
    assert!(!video_dgram_allowed(50, 150));
    assert!(video_dgram_allowed(50, 149));
    // 边界钉住：299 放行、300 不放
    assert!(video_dgram_allowed(299, 0));
    assert!(!video_dgram_allowed(300, 0));
}

/// 🔴 起播宽限的信号源（2026-10-03）：`peer_net_seen` 必须**两路都置位**
/// （SetBitratePct 与 NetHint 各一条路），且**每场会话清零**——否则
/// ① 某条路不置位 → 宽限只能等满，倍率永远开不对；
/// ② 换场不清 → 新会话宽限被上一场残留立刻收闸，回到老 bug。
#[test]
fn 对端发言信号_两路置位_每场清零() {
    let s = c();
    assert!(!s.peer_net_seen(), "会话建立时默认没收到过");
    // 第一路：SetBitratePct（倍率偏好）
    s.set_user_bitrate_pct(150).expect("150 合法");
    assert!(s.peer_net_seen(), "倍率偏好到了就算对端发言");
    // 换场清零（reset_from_cfg 的参数与起播宽限无关，随便挑合法的）
    s.reset_from_cfg(
        super::super::video::EncodeProfile::default(),
        false,
        false,
        StreamCodec::Auto,
        true,
    );
    assert!(!s.peer_net_seen(), "换场必须清零");
    // 第二路：NetHint（RTT 上报）单独也能置位
    s.set_peer_rtt(20);
    assert!(s.peer_net_seen(), "链路信息到了也算对端发言");
    // 越界倍率被拒 = 没写入成功，但拒绝发生在 store 之前，
    // 所以此刻仍应保持 false（上一次 reset 之后只有被拒的尝试）
    let s2 = c();
    assert!(s2.set_user_bitrate_pct(300).is_err(), "300 越界被拒");
    assert!(!s2.peer_net_seen(), "被拒的倍率不算对端发言");
}
/// 会话 RTT 下限的守卫（2026-10-05 中继死循环）：只有「安静样本」能定锚，
/// 高于下限每次只收敛 1/4。拥塞尖峰一旦能把下限抬到自己头上，
/// 超额延迟判据当场失明——这条就是防那个。
#[test]
fn rtt下限_只认安静样本_尖峰只收敛四分之一() {
    // 没收到过帧龄上报（旧对端）→ 下限永不建立，行为退回绝对 RTT
    assert_eq!(next_rtt_floor(0, 600, false, 70, 0), 0, "无帧龄上报不能定锚");
    // 首个安静样本直接立锚
    assert_eq!(next_rtt_floor(0, 600, true, 70, 0), 600);
    // 队列/丢包任一不安静 → 下限不动（反棘轮的核心）
    assert_eq!(next_rtt_floor(600, 2_600, true, 1_035, 0), 600, "排队样本不能抬下限");
    assert_eq!(next_rtt_floor(600, 2_600, true, 40, 60), 600, "丢包样本不能抬下限");
    assert_eq!(next_rtt_floor(600, 0, true, 40, 0), 600, "非正值不算样本");
    // 安静但更慢：只升 1/4（LAN→中继这类迁移不能拿一两个样本重锚）
    assert_eq!(next_rtt_floor(600, 1_000, true, 40, 0), 700);
    // 低于下限立即生效（抢回直连不能等收敛）
    assert_eq!(next_rtt_floor(600, 30, true, 40, 0), 30);
}

/// 🔴 中继会话（传播 ~600ms、零丢包、帧龄 70ms）不再被当成拥塞：
/// 2026-10-05 实测这条路径上码率被砍到 25%×200% = 50%，字看不清。
/// 建下限后超额=0 走全速；真排队时超额照涨，保护不失效。
/// 最后一段是旧对端回退——去掉 floor 那行，前两段会红。
#[test]
fn 中继固有延迟不砍码率_旧对端保守回退() {
    let s = c();
    s.set_peer_queue_ms(70); // 帧龄必须先到（inbound.rs 的顺序契约）
    assert_eq!(s.set_peer_rtt(600), 200, "600ms 全是传播 → 超额 0 → 全速×默认倍率");
    // 排队尖峰：floor 收敛到 725，超额 375ms → 40% 档 × 200% = 80%
    assert_eq!(s.set_peer_rtt(1_100), 80, "比安静时刻慢 500ms 必须还砍得动");
    s.set_peer_queue_ms(2_000); // EMA 升到 1035 → 雪崩熔断，倍率不参与
    assert_eq!(s.set_peer_rtt(2_600), 15, "帧龄破秒只听链路的");
    let legacy = c();
    assert_eq!(legacy.set_peer_rtt(600), 50, "没有安静样本可依据时不许放开");
}

/// 自动档与码控同口径看超额延迟：中继固有传播持续 20s 也不该把梯子
/// 踩到 smooth（实测正是这样糊掉文字的）；旧对端没有安静样本，
/// 仍按绝对延迟降档——第二段是反例，判据改回绝对 RTT 它不会红，
/// 但第一段会。
#[test]
fn 自动档看超额延迟_中继传播不踩档() {
    let base = 1_758_000_000_000i64;
    let s = c();
    s.set_quality("auto").expect("合法");
    s.set_peer_queue_ms(70);
    s.set_peer_rtt(600); // 建立下限：600ms 全是传播
    for i in 0..40i64 {
        s.auto_note_frame(10_000, base + i * 500);
    }
    // 第一段的旧期望（停在 balanced）本身就是那处哨兵缺陷的化石：`rtt_ms > 0`
    // 在超额口径下 = 「必须比本场安静时刻更慢才准升档」，于是固有传播这条路
    // 永远攒不满保持窗。修好后超额 0ms + 零丢包 + 帧龄 70ms 就该拿到升档资格
    // —— 这正是用户要的「换到好链路画质自己回来」。
    assert_eq!(s.auto_tier_name(), "sharp", "固有延迟不该降档，且干净链路要能升档");

    let legacy = c();
    legacy.set_quality("auto").expect("合法");
    legacy.set_peer_rtt(600); // 无帧龄上报 → 超额 = 绝对 600ms
    for i in 0..40i64 {
        legacy.auto_note_frame(10_000, base + i * 500);
    }
    assert_eq!(legacy.auto_tier_name(), "smooth", "无安静样本时按绝对延迟照降");
}
