use super::*;
fn feedback(at: i64, bytes: u64, age: i64) -> MediaFeedback {
    MediaFeedback { received_at_ms: at, received_bytes: bytes, sample_ms: 200, age_ms: age, presented_at_ms: 0, display_delay_ms: None, receive_queue_ms: None }
}

/// 新口径下拥塞证据只有一个来源：本端 send→ack 的超额延迟。这组 helper 用真实时序把它
/// 注入进去——第一拍只钉住传播基线（`backlog_ms` 记 0），之后每拍 `backlog_ms` 恰为
/// `backlog`。旧写法靠 `receive_queue_ms` 造假积压，那条路已降级为旁证（对端那个数从采集
/// 时刻起算，快路径上会虚高到 240..626ms；见
/// `docs/链路切换画质回升-业界源码对照-2026-10-06.md` §2.1）。
#[derive(Default)]
struct WireOpts {
    ceiling: u32,
    sample_ms: u64,
    peer_ms: Option<i64>,
    rtt_ms: i64,
}

fn wire(flow: &mut Flow, now: u64, backlog: i64, bytes: u64) {
    wire_opts(flow, now, backlog, bytes, &WireOpts { ceiling: 8_000, ..Default::default() });
}

fn wire_opts(flow: &mut Flow, now: u64, backlog: i64, bytes: u64, o: &WireOpts) {
    const BASE_MS: u64 = 500;
    let delay = BASE_MS + if flow.baseline_ack_ms == u64::MAX { 0 }
        else { FEEDBACK_MS + backlog.max(0) as u64 };
    let at = now as i64;
    flow.sent(now - delay, 0, at, bytes as usize);
    let mut f = feedback(at, bytes, 0);
    f.sample_ms = if o.sample_ms == 0 { FEEDBACK_MS } else { o.sample_ms };
    f.receive_queue_ms = o.peer_ms;
    flow.feedback(now, &f, o.ceiling, 0, o.rtt_ms);
}

#[test]
fn high_rtt_still_allows_a_continuous_window() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    for n in 0..20 {
        let now = n * 20;
        assert_eq!(flow.admission(now, 1_600), Admission::Ready);
        flow.sent(now, now, now as i64 + 1, 5_000);
    }
    assert_eq!(flow.pending.len(), 20); // 100KB 在途，未逐 32KB 停等。
}

#[test]
fn capture_work_consumes_the_pacing_interval() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    assert_eq!(flow.admission(0, 20), Admission::Ready);
    // 5KB / 400kbps = 100ms；其中采集、编码及入队已花掉 60ms。
    flow.sent(60, 0, 1, 5_000);
    assert_eq!(flow.admission(99, 20), Admission::Wait);
    assert_eq!(flow.admission(100, 20), Admission::Ready,
        "不能在 60ms 工作之后再等待完整 100ms，拖低到约 6fps");
}

#[test]
fn delayed_writes_keep_byte_debt_without_idle_burst_credit() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    // 同圈两包和异步晚返回不能覆盖前一包尚未用完的限速预算。
    flow.sent(60, 0, 1, 5_000);
    flow.sent(80, 0, 2, 5_000);
    assert_eq!(flow.admission(199, 20), Admission::Wait);
    assert_eq!(flow.admission(200, 20), Admission::Ready);
    // 静止一秒不积攒发送额度；恢复后仍按真实字节数等待。
    flow.sent(1_060, 1_000, 3, 5_000);
    assert_eq!(flow.admission(1_099, 20), Admission::Wait);
    assert_eq!(flow.admission(1_100, 20), Admission::Ready);
    // 即使来源时间意外超前，也不能引入未来时刻的无限等待。
    flow.sent(1_200, 9_000, 4, 5_000);
    assert_eq!(flow.next_ms, 1_300);
}

#[test]
fn extra_queue_reduces_budget_but_propagation_does_not() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.feedback(1_000, &feedback(1, 50_000, 800), 8_000, 0, 0);
    assert!(flow.kbps > 2_000);
    flow.feedback(2_000, &feedback(2, 20_000, 1_200), 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 400);
    assert!(flow.kbps <= 800);
}

#[test]
fn idle_desktop_is_not_measured_as_a_bandwidth_ceiling() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    for n in 1..20 { flow.feedback(n * 1_000, &feedback(n as i64, 100, 50), 8_000, 0, 0); }
    assert_eq!(flow.kbps, 2_000);
}

#[test]
fn active_direct_stream_recovers_resolution_with_moderate_wire_backlog() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 400;
    assert_eq!(flow.resolution_limit(0), 1280);
    assert_eq!(flow.resolution_limit(5_000), 960);
    for n in 6..66u64 {
        // 满足当前预算的活动画面，本端实测 send→ack 超额稳定在真机观测的 63..98ms。
        let bytes = flow.kbps as u64 * 25;
        wire(&mut flow, n * 1_000, 80, bytes);
        flow.resolution_limit(n * 1_000);
    }
    assert!(flow.kbps >= 1_100, "稳定直连不应永久卡在低码率");
    assert_ne!(flow.max_width, 960, "满足恢复预算后须允许恢复文字分辨率（升档须站满 7 秒）");
    let before = flow.kbps;
    wire(&mut flow, 66_000, 160, before as u64 * 25);
    assert!(flow.kbps < before, "本端口径的真实积压超过降速线仍必须减速");
    let mut idle = Flow::default();
    idle.budget(false, 8_000);
    for n in 1..20u64 { wire(&mut idle, n * 1_000, 80, 100); }
    assert_eq!(idle.kbps, 4_000, "静止画面的低流量不能触发盲目扩预算");
}

#[test]
fn bounded_window_discards_entire_reference_chain_and_recovers() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.sent(0, 0, 1, MAX_PENDING + 1);
    assert_eq!(flow.admission(1, 50), Admission::Reset);
    flow.discard(1, 0);
    assert_eq!(flow.admission(2, 50), Admission::Ready);
    flow.sent(2, 2, 2, 50_000);
    flow.feedback(100, &feedback(2, 50_000, 50), 8_000, 0, 0);
    assert_eq!(flow.pending_bytes, 0);
    assert_eq!(flow.admission(200, 50), Admission::Ready);
}

#[test]
fn late_feedback_cannot_regress_ack_or_retain_discarded_bytes() {
    let mut flow = Flow::default();
    flow.sent(1, 1, 10, 100);
    flow.discard(2, 0);
    flow.sent(3, 3, 20, 100);
    flow.feedback(4, &feedback(10, 100, 10), 8_000, 0, 0);
    assert_eq!(flow.pending_bytes, 100);
    flow.feedback(5, &feedback(20, 100, 10), 8_000, 0, 0);
    flow.feedback(6, &feedback(10, 100, 900), 8_000, 0, 0);
    assert_eq!(flow.pending_bytes, 0);
    assert_eq!(flow.queue_ms, 0);
}

#[test]
fn ack_deadline_includes_complete_frame_serialization_on_a_slow_path() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 400;
    flow.feedback(1, &feedback(1, 100, 800), 8_000, 0, 0);
    flow.sent(100, 100, 2, 100_000); // 400kbps 下仅序列化该帧就需 2 秒。
    assert_ne!(flow.admission(2_500, 1_600), Admission::Reset,
        "不能用小 ping 的 RTT 在完整恢复帧正常交付前 RESET");
    assert_eq!(flow.admission(4_201, 1_600), Admission::Reset,
        "恢复等待仍然有界，不能无限容忍无反馈");
}

#[test]
fn discarded_stream_feedback_cannot_shorten_recovery_startup() {
    let mut flow = Flow::default();
    flow.sent(0, 0, 10, 100);
    flow.feedback(200, &feedback(10, 100, 30), 8_000, 0, 0);
    flow.sent(300, 300, 20, 100);
    flow.discard(1_000, 0);
    flow.feedback(1_050, &feedback(20, 100, 900), 8_000, 0, 0); // RESET 前的迟到反馈。
    flow.sent(1_100, 1_100, 30, 100);
    assert_ne!(flow.admission(2_300, 500), Admission::Reset,
        "新的参考链需要重新起播，不能继承旧流的反馈状态");
    assert_eq!(flow.admission(3_700, 500), Admission::Reset);
}

#[test]
fn serialization_allowance_cannot_hide_tens_of_seconds_of_backlog() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    flow.sent(0, 0, 1, 1_000_000); // 理论序列化 20 秒，恢复等待仍只给最多 2 秒余量。
    assert_eq!(flow.admission(3_001, 500), Admission::Reset);
}

#[test]
fn progressing_media_ack_is_not_timed_out_using_a_smaller_ping_rtt() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    flow.sent(0, 0, 1, 5_000);
    flow.sent(100, 100, 2, 5_000);
    flow.feedback(1_350, &feedback(1, 5_000, 900), 8_000, 0, 0);
    assert_ne!(flow.admission(1_370, 500), Admission::Reset,
        "刚确认媒体交付，不能以更短的小 ping RTT 废弃正在推进的链");
    assert_eq!(flow.admission(3_201, 500), Admission::Reset,
        "媒体反馈停止后仍须有界恢复");
}

#[test]
fn recent_media_progress_with_moderate_jitter_does_not_restart_a_healthy_direct_stream() {
    // 真机直连 RTT 约 50ms，但 200ms 周期反馈有额外抖动。最后 ACK 仍在推进，
    // 最老帧刚过 650ms 不能被当作断链：重复 RESET 会把画质压到 400kbps。
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 400;
    flow.sent(0, 0, 1, 5_000);
    flow.sent(100, 100, 2, 5_000);
    flow.feedback(700, &feedback(1, 5_000, 200), 8_000, 0, 0);
    assert_ne!(flow.admission(770, 50), Admission::Reset,
        "ACK 70ms 前确认了新画面，中等抖动不该不断重开参考链");
    // 本端口径没有超额积压（这一拍只交付了一帧、基线就是它自己），放宽的是实测 ACK
    // 抖动预算；反馈真的停更后仍要在一个有界期限内回收。
    assert_ne!(flow.admission(2_500, 50), Admission::Reset);
    assert_eq!(flow.admission(2_601, 50), Admission::Reset,
        "ACK 停止后仍须及时回收，不能无限等待");
}

#[test]
fn measured_wire_backlog_cannot_hide_behind_a_fresh_ack() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 400;
    // 快路径先钉住传播基线：500ms 的 send→ack 是固有开销，不算积压。
    flow.sent(0, 0, 1, 5_000);
    flow.feedback(500, &feedback(1, 5_000, 0), 8_000, 0, 0);
    assert_eq!(flow.backlog_ms, 0);
    // 之后一帧上线 1700ms 才被确认（500 基线 + 200 采样窗 + 1000 真积压），
    // 后面还有一帧在途——即使 ACK 新鲜，这一秒积压也必须废弃旧画面。
    flow.sent(600, 600, 2, 5_000);
    flow.sent(700, 700, 3, 5_000);
    flow.feedback(2_300, &feedback(2, 5_000, 0), 8_000, 0, 0);
    assert_eq!(flow.backlog_ms, 1_000);
    assert_eq!(flow.admission(2_300, 50), Admission::Reset,
        "本端已测到一秒线上积压，即使刚收到 ACK 也必须废弃旧画面");
}

#[test]
fn media_ack_allowance_cannot_follow_an_unbounded_queue() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    flow.sent(0, 0, 1, 5_000);
    flow.feedback(20_000, &feedback(1, 5_000, 20_000), 8_000, 0, 0);
    flow.sent(20_000, 20_000, 2, 5_000);
    assert_eq!(flow.admission(23_101, 500), Admission::Reset,
        "一次极慢反馈不能把后续超时放宽到几十秒");
}

#[test]
fn healthy_relay_ack_jitter_does_not_discard_a_live_reference_chain() {
    let mut flow = Flow::default();
    flow.kbps = 500;
    flow.sent(0, 0, 1, 5_000);
    let mut f = feedback(1, 5_000, 350);
    f.receive_queue_ms = Some(20);
    flow.feedback(690, &f, 8_000, 0, 0);
    flow.sent(700, 700, 2, 5_000);
    // 真机：RTT 548ms、媒体 ACK 690ms、最后反馈已过去 839ms，
    // 接收额外队列仍仅 20ms。回程抖动不能直接当成参考链过期。
    assert_ne!(flow.admission(1_940, 548), Admission::Reset);
    f.received_at_ms = 2;
    flow.feedback(2_000, &f, 8_000, 0, 0);
    flow.sent(2_010, 2_010, 3, 5_000);
    assert_eq!(flow.admission(5_300, 548), Admission::Reset,
        "抖动预算不能让停止反馈的链无限存活");
}

#[test]
fn relay_ack_jitter_allowance_does_not_override_real_queue_or_byte_limits() {
    let mut flow = Flow::default();
    flow.kbps = 500;
    flow.sent(0, 0, 1, 5_000);
    let mut f = feedback(1, 5_000, 350);
    f.receive_queue_ms = Some(20);
    flow.feedback(690, &f, 8_000, 0, 0);
    flow.sent(700, 700, 2, 5_000);
    flow.sent(800, 800, 3, 5_000);
    f.received_at_ms = 2;
    f.receive_queue_ms = Some(400);
    flow.feedback(1_950, &f, 8_000, 0, 0);
    assert_eq!(flow.admission(1_951, 548), Admission::Reset);
    flow.discard(1_951, 0);
    flow.sent(1_952, 1_952, 4, MAX_PENDING + 1);
    assert_eq!(flow.admission(3_001, 548), Admission::Reset);
}

#[test]
fn growing_real_queue_still_discards_old_frames_with_fresh_feedback() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    flow.sent(0, 0, 1, 5_000);
    flow.feedback(500, &feedback(1, 5_000, 500), 8_000, 0, 0);
    flow.sent(600, 600, 2, 5_000);
    flow.sent(700, 700, 3, 5_000);
    flow.feedback(2_000, &feedback(2, 5_000, 1_400), 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 700); // 排除至多 200ms 的反馈采样相位差。
    assert_eq!(flow.admission(2_001, 500), Admission::Reset,
        "真实积压增大时，刚到的慢 ACK 也不能推迟过期链恢复");
}

#[test]
fn clock_reanchoring_does_not_invent_media_queue_pressure() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.sent(0, 0, 1, 50_000);
    flow.feedback(1_000, &feedback(1, 50_000, 0), 8_000, 0, 0);
    let before = flow.kbps;
    flow.sent(1_000, 1_000, 2, 50_000);
    flow.feedback(2_000, &feedback(2, 50_000, 1_300), 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 0, "真实交付耗时未增加，校准跳变不是积压");
    assert!(flow.kbps >= before);
}

#[test]
fn feedback_sampling_phase_is_not_congestion() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.sent(0, 0, 1, 5_000);
    flow.feedback(50, &feedback(1, 5_000, 30), 8_000, 0, 0);
    flow.sent(1_000, 1_000, 2, 5_000);
    flow.feedback(1_250, &feedback(2, 5_000, 30), 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 0);
    assert_eq!(flow.kbps, 4_000);
}

#[test]
fn receiver_queue_ignores_clock_calibration_but_detects_real_delay() {
    let mut receiver = Receiver::default();
    receiver.receive(1_000, 10_000, 100, 0);
    assert_eq!(receiver.take_feedback(1_200).unwrap().receive_queue_ms, Some(0));
    receiver.receive(2_000, 11_000, 100, 1_300); // 仅校准值改变。
    assert_eq!(receiver.take_feedback(2_200).unwrap().receive_queue_ms, Some(0));
    receiver.receive(3_500, 12_000, 100, 1_800); // 真实到达慢了 500ms。
    assert_eq!(receiver.take_feedback(3_700).unwrap().receive_queue_ms, Some(500));
}

#[test]
fn receiver_reanchors_propagation_only_when_the_path_changes() {
    let mut receiver = Receiver::default();
    receiver.set_path(false);
    receiver.receive(1_000, 10_000, 100, 20);
    receiver.set_path(true);
    receiver.receive(2_600, 11_000, 100, 620);
    assert_eq!(receiver.take_feedback(2_800).unwrap().receive_queue_ms, Some(0));
    receiver.set_path(true);
    receiver.receive(3_800, 12_000, 100, 820);
    assert_eq!(receiver.take_feedback(4_000).unwrap().receive_queue_ms, Some(200));
}

#[test]
fn lan_window_keeps_sending_until_the_first_periodic_ack() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    for n in 0..6 {
        let now = n * 33;
        assert_eq!(flow.admission(now, 20), Admission::Ready,
            "200ms 反馈周期前不能因窗口小于采样周期而断粮");
        flow.sent(now, now, now as i64 + 1, 16_500);
    }
}

#[test]
fn stale_display_delay_is_not_reused_by_later_feedback() {
    let mut receiver = Receiver::default();
    receiver.receive(0, 1, 100, 20);
    receiver.presented(1, 1_000);
    assert_eq!(receiver.take_feedback(1_000).unwrap().display_delay_ms, Some(1_000));
    receiver.receive(1_100, 2, 100, 20);
    assert_eq!(receiver.take_feedback(1_200).unwrap().display_delay_ms, None);
}

#[test]
fn repeated_presented_timestamp_cannot_replay_old_display_pressure() {
    let mut flow = Flow::default();
    flow.sent(0, 0, 1, 5_000);
    let mut first = feedback(1, 5_000, 30);
    first.presented_at_ms = 1;
    first.display_delay_ms = Some(1_000);
    flow.feedback(1_000, &first, 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 1_000);
    flow.sent(1_000, 1_000, 2, 5_000);
    first.received_at_ms = 2; // 旧客户端继续携带上一次绘制值。
    flow.feedback(2_000, &first, 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 0);
}

#[test]
fn relay_capacity_can_grow_and_direct_upgrade_reprobes() {
    let mut flow = Flow::default();
    for n in 1..30 {
        let budget = flow.budget(true, 8_000);
        flow.feedback(n * 1_000, &feedback(n as i64, budget as u64 * 25, 70), 8_000, 0, 0);
    }
    assert!(flow.kbps > 4_000);
    assert_eq!(flow.budget(false, 8_000), 4_000);
}

#[test]
fn receiver_feedback_is_bounded_and_tracks_display_progress() {
    let mut r = Receiver::default();
    r.receive(0, 1, 1_000, 20);
    r.receive(100, 2, 1_000, 20);
    r.presented(2, 110);
    r.receive(200, 3, 1_000, 20);
    let f = r.take_feedback(200).unwrap();
    assert_eq!(f.received_bytes, 3_000);
    assert_eq!(f.presented_at_ms, 2);
    assert_eq!(f.sample_ms, 200);
    assert_eq!(f.display_delay_ms, Some(10));
}

#[test]
fn lone_static_frame_gets_feedback_without_waiting_for_another_frame() {
    let mut r = Receiver::default();
    r.receive(1000, 7777, 100, 20);
    assert!(r.take_feedback(1100).is_none());
    assert_eq!(r.take_feedback(1200).unwrap().received_at_ms, 7777);
    assert!(!r.has_pending());
    assert!(r.take_feedback(1400).is_none());
}

#[test]
fn delayed_feedback_sampling_does_not_invent_decoder_backlog() {
    let mut flow = Flow::default();
    let mut f = feedback(1000, 50_000, 40);
    f.presented_at_ms = 800; // 上一次采样早 200ms，不代表绘制慢了 200ms。
    f.display_delay_ms = Some(5);
    flow.feedback(1000, &f, 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 5);
}

#[test]
fn fps_hysteresis_prevents_encoder_reopen_at_bandwidth_boundary() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    // 本测试只管带宽边界的滞回；升档时间门槛另有单测。
    flow.fps = 30;
    assert_eq!(flow.fps_limit(false, 0), 30);
    for rate in [2_900, 3_100, 2_700, 3_200] {
        flow.kbps = rate;
        assert_eq!(flow.fps_limit(false, 0), 30);
    }
    flow.kbps = 2_000;
    assert_eq!(flow.fps_limit(false, 0), 15);
    for rate in [2_900, 3_100, 2_700, 3_200] {
        flow.kbps = rate;
        assert_eq!(flow.fps_limit(false, 0), 15);
    }
}

#[test]
fn fast_direct_path_preserves_explicit_high_fps_profiles() {
    let mut flow = Flow::default();
    flow.kbps = 10_000;
    // 15→30 与 30→60 各要连续满 `UPGRADE_HOLD_MS`（降档不在本测试路径上）。
    assert_eq!(flow.fps_limit(false, 0), 15, "升档要先过时间门槛");
    assert_eq!(flow.fps_limit(false, 7_000), 30);
    assert_eq!(flow.fps_limit(false, 7_000), 30, "第二次升档重新计时");
    assert_eq!(flow.fps_limit(false, 14_000), 165);
    flow.kbps = 7_500;
    assert_eq!(flow.fps_limit(false, 14_000), 165, "高档也需滞回");
    assert_eq!(flow.fps_limit(true, 14_000), 30, "中继仍限制到 30fps");
}

#[test]
fn constrained_resolution_keeps_aspect_ratio_and_does_not_flap() {
    assert_eq!(scaled_dimensions(1920, 1080, 1280), (1280, 720));
    assert_eq!(scaled_dimensions(1024, 768, 1280), (1024, 768));
    assert_eq!(scaled_dimensions(1920, 1080, 0), (1920, 1080));
    let mut flow = Flow::default();
    flow.kbps = 1_000;
    assert_eq!(flow.resolution_limit(0), 1280);
    flow.kbps = 3_000;
    assert_eq!(flow.resolution_limit(0), 1280, "升档要先过时间门槛");
    assert_eq!(flow.resolution_limit(5_000), 1280, "门槛未满不弹回原分辨率");
    assert_eq!(flow.resolution_limit(7_000), 0, "满 7s 门槛后才升档");
}

#[test]
fn oversized_feedback_does_not_overflow_the_controller() {
    let mut flow = Flow::default();
    let mut f = feedback(1, u64::MAX, 20);
    f.sample_ms = 1;
    flow.feedback(1_000, &f, 8_000, 0, 0);
    f.received_at_ms = 2;
    f.age_ms = i64::MAX;
    flow.feedback(2_000, &f, 8_000, 0, 0);
    assert!(flow.kbps <= 8_000);
    assert_eq!(flow.delivered_kbps, u32::MAX);
}

#[test]
fn bandwidth_step_bounds_backlog_and_resumes_after_recovery() {
    // 可控的序列化链路模型；使用生产窗口/反馈控制器，不把它当真机吞吐证据。
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    let mut receiver = Receiver::default();
    let mut packets = VecDeque::<(u64, i64, usize)>::new();
    let mut feedbacks = VecDeque::<(u64, MediaFeedback)>::new();
    let mut wire_end = 0;
    let mut capture_due = 0;
    let mut weak_max_display_age = 0;
    let mut settled_max_queue = 0;
    let mut resets = 0;
    let mut recovered = 0;
    for now in (0u64..20_000).step_by(5) {
        let capacity = if (5_000..12_000).contains(&now) { 800 } else { 8_000 };
        while packets.front().is_some_and(|(due, _, _)| *due <= now) {
            let (_, at, bytes) = packets.pop_front().unwrap();
            receiver.receive(now, at, bytes, now as i64 - at + 1);
            receiver.presented(at, now + 5);
            if (5_000..12_000).contains(&now) {
                weak_max_display_age = weak_max_display_age.max(now as i64 - at + 6);
            }
        }
        if let Some(f) = receiver.take_feedback(now) { feedbacks.push_back((now + 40, f)); }
        while feedbacks.front().is_some_and(|(due, _)| *due <= now) {
            let (_, f) = feedbacks.pop_front().unwrap();
            flow.feedback(now, &f, 8_000, 0, 0);
        }
        if now < capture_due { continue; }
        match flow.admission(now, 80) {
            Admission::Reset => { flow.discard(now, 0); packets.clear(); wire_end = now; resets += 1; }
            // P0 口径：拿不到额度就丢帧并记账，**不阻塞生产者**。旧写法只 `continue`，
            // 于是这份仿真对 `note_drop` 那半判据天然瞎（丢帧证据从没被喂进去过）。
            Admission::Wait => { flow.note_drop(); continue; }
            Admission::Ready => {
                let interval = 1_000u64 / flow.fps_limit(false, now) as u64;
                let bytes = (flow.kbps as u64 * interval / 8) as usize;
                wire_end = wire_end.max(now) + (bytes as u64 * 8).div_ceil(capacity);
                packets.push_back((wire_end + 40, now as i64 + 1, bytes));
                flow.sent(now, now, now as i64 + 1, bytes);
                capture_due = now + interval;
                if (9_000..12_000).contains(&now) { settled_max_queue = settled_max_queue.max(wire_end - now); }
                if (12_000..15_000).contains(&now) { recovered += 1; }
            }
        }
    }
    // 骤降瞬间，旧预算下已交给网络的字节不可凭空撤回；RESET 的目的正是
    // 让这些过期帧不再显示。验收到达画面与收敛后的队列，不把废弃帧算成交付。
    assert!(resets > 0, "带宽骤降后必须废弃过期参考链");
    assert!(weak_max_display_age <= 1_000, "弱网仍显示了 {weak_max_display_age}ms 旧帧");
    // 收敛后线上仍留着的队列，峰值实测 415ms（旧口径 ≤150ms 是拿接收端上报定罪的）。
    // 证据换成**本端 send→ack 超额**后，它按设计减掉一整个反馈采样窗与会话内最快一次
    // 交付时延，在这个「RTT 不随排队上涨」的模型里就晚约 250ms 才定罪。仍然有界、仍在
    // 恢复期排空，不是累积不回头；换口径换来的收益见
    // `docs/链路切换画质回升-业界源码对照-2026-10-06.md` §1（v6 直连 52/52 拍传输层反对定罪、
    // 预算不再被钉在 400kbps 地板）。要把这份盲区收回来，正解是把证据换成「最老未确认帧
    // 的等待时长」，那是另一次口径手术，不在本次范围。
    assert!(settled_max_queue <= 450, "收敛后仍累积了 {settled_max_queue}ms");
    assert!(recovered >= 20, "恢复后的 3 秒仅发出 {recovered} 帧");
    assert!(flow.pending_bytes <= MAX_PENDING);
}

#[test]
fn healthy_delivery_with_loss_jitter_recovers_text_resolution() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 400;
    flow.resolution_limit(0);
    assert_eq!(flow.resolution_limit(5_000), 960);
    for n in 6..66 {
        // Attempt 11: 3..45ms receive queue, bounded render delay, intermittent 4..6% loss.
        // Delivered video meets its budget; those losses do not imply queue growth.
        let mut f = feedback(n as i64, flow.kbps as u64 * 25, 100);
        f.receive_queue_ms = Some(if n % 3 == 0 { 45 } else { 5 });
        f.presented_at_ms = n as i64;
        f.display_delay_ms = Some(50);
        let loss = if n % 3 == 0 { 60 } else { 10 };
        flow.feedback(n * 1_000, &f, 8_000, loss, 0);
        flow.resolution_limit(n * 1_000);
    }
    assert!(flow.kbps >= 2_800, "healthy lossy delivery remained at {}kbps", flow.kbps);
    assert_eq!(flow.max_width, 0, "desktop text must regain its source resolution");
    let before = flow.kbps;
    let mut congested = feedback(66, before as u64 * 25, 100);
    congested.receive_queue_ms = Some(120);
    flow.feedback(66_000, &congested, 8_000, 60, 0);
    assert!(flow.kbps < before, "loss with growing queue must still reduce the budget");
}
/// Ratchet guard (2026-10-05 relay session): RESET at 0‰ loss and a 20ms queue
/// pinned the budget at MIN_KBPS. Discarding stale frames is still correct;
/// shrinking capacity without evidence is not.
#[test]
fn discard_only_decays_the_budget_with_congestion_evidence() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 2_000;
    flow.last_feedback_ms = Some(90);
    flow.backlog_ms = 20;
    flow.discard(100, 0);
    assert_eq!(flow.kbps, 2_000, "ACK progressing, no loss, shallow backlog must not shrink the budget");

    flow.last_feedback_ms = Some(90);
    flow.discard(100, 60);
    assert_eq!(flow.kbps, 1_400, "frame-granular loss is evidence");

    flow.backlog_ms = 400;
    flow.last_feedback_ms = Some(90);
    flow.discard(100, 0);
    assert_eq!(flow.kbps, 980, "a deep receive queue is evidence");

    flow.backlog_ms = 0;
    flow.last_feedback_ms = Some(90);
    flow.discard(1_200, 0);
    assert_eq!(flow.kbps, 686, "going ACK-blind is evidence");
}

/// 2026-10-06 复测（§24）：中继会话的渲染管线稳态就有 100..160ms，而线上积压
/// （receive_queue）实测 0ms。旧口径把两者混进同一个 queue_ms，于是绘制延迟既触发
/// 降速（>150）又封住扩容（<60），预算被踩到 400kbps 地板后 100 秒涨不回去。
#[test]
fn render_delay_is_neither_congestion_nor_a_probe_blocker() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 800;
    let before = flow.kbps;
    for n in 1..5u64 {
        let mut f = feedback(n as i64, flow.kbps as u64 * 25, 100);
        f.receive_queue_ms = Some(0);
        f.presented_at_ms = n as i64 * 10;
        f.display_delay_ms = Some(140);
        flow.feedback(n * 1_000, &f, 8_000, 0, 0);
    }
    assert_eq!(flow.queue_ms, 140, "绘制延迟仍要在合并口径里可见（对端提示/诊断用）");
    assert_eq!(flow.backlog_ms, 0, "线上积压口径必须把它摘出去");
    assert!(flow.kbps > before, "稳态绘制延迟不许降速，也不许挡住扩窗探测，实际 {}kbps", flow.kbps);

    // 更慢的渲染客户端：绘制 400ms、线上零积压——旧口径在这里连缩四次预算。
    let mut slow = Flow::default();
    slow.budget(true, 8_000);
    slow.kbps = 2_000;
    for n in 1..5u64 {
        let mut f = feedback(n as i64 + 10, slow.kbps as u64 * 25, 100);
        f.receive_queue_ms = Some(0);
        f.presented_at_ms = n as i64 * 10;
        f.display_delay_ms = Some(400);
        slow.feedback(n * 1_000, &f, 8_000, 0, 0);
    }
    assert!(slow.kbps >= 2_000, "线上不排队就不该因为对面渲染慢而缩预算，实际 {}kbps", slow.kbps);
}

/// §23/§24 的真机中继形态：渲染管线固有 160ms、线上一条队列都没有。这份深度不能去
/// 收紧 ACK 期限——抖动预算被跳过后，慢但正常的交付就会判死，会话每 3 秒 RESET 一次。
#[test]
fn render_depth_does_not_forfeit_the_ack_jitter_allowance() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.sent(0, 0, 1, 200_000);
    let mut f = feedback(1_200, 200_000, 60);
    f.receive_queue_ms = Some(0);
    f.presented_at_ms = 1;
    f.display_delay_ms = Some(160);
    flow.feedback(1_400, &f, 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 160, "合并口径仍要对渲染深度可见");
    assert_eq!(flow.backlog_ms, 0);
    flow.sent(1_500, 1_500, 1_201, 200_000);
    assert_ne!(flow.admission(4_100, 100), Admission::Reset,
        "上一帧 1400ms 正常交付过，2600ms 帧龄不该被渲染缓冲判成断链");
}

/// 同一口径的另一半：反馈照常推进时，400ms 的渲染缓冲不能把「ACK 在走」判成停滞，
/// 那份停滞和超时帧龄凑在一起就是 RESET。
#[test]
fn render_depth_does_not_certify_a_stalled_ack() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.sent(0, 0, 100, 200_000);
    let mut f = feedback(50, 200_000, 60);
    f.receive_queue_ms = Some(0);
    f.presented_at_ms = 1;
    f.display_delay_ms = Some(400);
    flow.feedback(2_500, &f, 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 400);
    assert_eq!(flow.backlog_ms, 0);
    assert_ne!(flow.admission(2_500, 500), Admission::Reset,
        "反馈 0ms 前刚到、线上零积压，仅帧龄超期不该重开参考链");
}

/// 同一份渲染深度还不能进对端提示：`peer_queue` 喂的是自动档与倍率判据，
/// 把对面合成器的固有深度报成积压，就是 §23 里 1080p→720p→540p 的那两次降档。
#[test]
fn peer_hint_reports_wire_backlog_not_render_depth() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    let mut f = feedback(1, flow.kbps as u64 * 25, 60);
    f.receive_queue_ms = Some(0);
    f.presented_at_ms = 1;
    f.display_delay_ms = Some(400);
    flow.feedback(1_000, &f, 8_000, 0, 0);
    assert_eq!(flow.queue_ms, 400, "合并口径仍要在诊断里可见");
    assert_eq!(flow.feedback_queue(), Some(0), "对端提示只报线上积压");
}

/// 真积压平台：60..150ms 之间连续稳定 3 秒后允许重新探测，不留扩容死区。
#[test]
fn steady_relay_queue_is_not_a_bandwidth_ceiling() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 800;
    for n in 1..8u64 {
        let mut f = feedback(n as i64, flow.kbps as u64 * 25, 100);
        f.receive_queue_ms = Some(140);
        flow.feedback(n * 1_000, &f, 8_000, 0, 0);
    }
    assert!(flow.kbps > 800, "贴着预算的实测交付必须能重新扩窗，实际 {}kbps", flow.kbps);
}

/// 扩窗的门槛之一是「链路确实承得住这份预算」：交付包络只有预算五成时不能继续加，
/// 静止画面的低流量不是线路富余的证据（否则零积压会把预算一路顶到上限）。
#[test]
fn under_delivered_budget_is_not_headroom_for_a_probe() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 2_000;
    for n in 1..4u64 {
        let mut f = feedback(n as i64, flow.kbps as u64 * 12, 100);
        f.receive_queue_ms = Some(0);
        flow.feedback(n * 1_000, &f, 8_000, 0, 0);
    }
    assert_eq!(flow.kbps, 2_000, "交付包络只有预算五成时不许扩窗，实际 {}kbps", flow.kbps);
}

/// 真机中继复测抓到的失效形态：交付跟不上预算时，比值仍能常年停在 1.4 倍以上
/// （实测预算 6152 而交付 2562；75 拍里 18 拍 `delivered < 0.5×budget`，最坏
/// 3474/208、5085/752），且每秒 +10% 没有任何停下的理由。扩容门把比值封在
/// 1.25（BBR 的探测增益 5/4），交付跟上后包络随即抬升，恢复不受影响。
#[test]
fn the_ramp_never_drifts_past_a_quarter_above_delivered_capacity() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 1_000;
    let delivered = 4_535u64; // 现场实测的交付速率（kbps）
    for n in 1..40u64 {
        let mut f = feedback(n as i64, delivered * 25, 100);
        f.receive_queue_ms = Some(0);
        flow.feedback(n * 1_000, &f, 8_000, 0, 0);
        assert!(
            (flow.kbps as u64) * 4 <= delivered * 5,
            "第 {} 拍预算漂到交付能力的 {:.2} 倍（{}kbps）",
            n,
            flow.kbps as f64 / delivered as f64,
            flow.kbps
        );
    }
    assert_eq!(flow.kbps, (delivered * 5 / 4) as u32, "交付不动时预算应站定在 1.25 倍线上");

    // 反方向红线：交付随预算涨（真管子更宽）时不许被这条封顶冻住。
    let mut growing = Flow::default();
    growing.budget(true, 8_000);
    growing.kbps = 1_000;
    for n in 1..8u64 {
        let mut f = feedback(n as i64, growing.kbps as u64 * 25, 100);
        f.receive_queue_ms = Some(0);
        growing.feedback(n * 1_000, &f, 8_000, 0, 0);
    }
    assert!(growing.kbps > 1_000, "交付跟得上预算时必须继续扩窗，实际 {}kbps", growing.kbps);
}

/// 反方向红线：涨起来的真积压仍须在 2–3 秒内缩预算，不能因为「不看绝对值」
/// 变成永不降速。
#[test]
fn growing_queue_shrinks_the_budget_within_seconds() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 4_000;
    // 第一拍钉传播基线（超额 0），后三拍是本端实测的 send→ack 超额：130 → 170 → 210。
    for (n, queue) in [0i64, 130, 170, 210].iter().enumerate() {
        wire(&mut flow, (n as u64 + 1) * 1_000, *queue, 4_000 * 25);
    }
    assert!(flow.kbps < 4_000, "队列连续上涨必须缩预算，实际 {}kbps", flow.kbps);

    // 趋势单独成立的一拍：150ms 降速线还没破，但 200ms 内涨了 32ms。
    let mut trend = Flow::default();
    trend.budget(true, 8_000);
    trend.kbps = 2_000;
    for (n, queue) in [0i64, 118, 150].iter().enumerate() {
        wire(&mut trend, (n as u64 + 1) * 1_000, *queue, 2_000 * 25);
    }
    assert!(trend.kbps < 2_000, "积压正在上涨本身即证据，实际 {}kbps", trend.kbps);
}

/// `delivered` 只有在窗口正常、且队列深到能证明瓶颈在线路上时才可当上限：
/// 发送端断粮 2 秒的窗口给出 8kbps，拿它封顶是一次性踩死（旧口径 4000→400）。
#[test]
fn starved_sample_window_is_not_measured_as_capacity() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 4_000;
    // 深积压由本端测出（超额 400ms），同时发送端断粮 2 秒、交付只有 8kbps。
    let starved = WireOpts { ceiling: 8_000, sample_ms: 2_000, ..Default::default() };
    wire_opts(&mut flow, 1_000, 0, 2_000, &starved);
    wire_opts(&mut flow, 2_000, 400, 2_000, &starved);
    assert_eq!(flow.kbps, 3_200, "深队列仍要降，但不许被断粮窗口的低交付封顶");
}

/// 证据锚点必须跨 RESET 存活。上一版在 `discard` 里把 last_feedback_ms 抹成
/// None，而盲区判据对 None 恒真，于是第二次、第三次 RESET 自动算作拥塞证据
/// （实测 66% 的 RESET 带着 feedback_age=None 进来）。
#[test]
fn reset_storm_with_flowing_ack_is_not_congestion_evidence() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 2_000;
    flow.sent(0, 0, 1, 5_000);
    let mut f = feedback(1, 5_000, 60);
    f.receive_queue_ms = Some(20);
    flow.feedback(200, &f, 8_000, 0, 0);
    for n in 1..4u64 {
        flow.sent(n * 200, n * 200, n as i64 + 10, 5_000);
        flow.discard(n * 200 + 300, 0);
    }
    assert_eq!(flow.kbps, 2_000, "零丢包、浅队列、ACK 五个采样周期内刚到过的连续 RESET 不该缩预算");
}

/// 本次事故的正主：v6 直连段对端上报冲到 240..626ms 且逐拍大幅摆动，而同一时刻传输层
/// rtt=29ms、零丢包。旧口径拿它覆盖本端测量，于是 ×0.8 连斩把预算钉死在 400kbps 地板约
/// 5 分钟、312 秒内 0 次档位切换。现在它只留作旁证打印。
#[test]
fn peer_report_is_corroboration_only_and_never_convicts() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 4_000;
    for (n, peer) in [240i64, 380, 300, 626, 250, 620].iter().cycle().take(12).enumerate() {
        let o = WireOpts { ceiling: 8_000, peer_ms: Some(*peer), rtt_ms: 29, ..Default::default() };
        wire_opts(&mut flow, (n as u64 + 1) * 1_000, 0, 4_000 * 25, &o);
    }
    assert_eq!(flow.backlog_ms, 0, "本端口径没有超额积压");
    assert_eq!(flow.peer_queue_ms, 620, "对端的数仍要留着示警，只是不定罪");
    assert!(flow.kbps >= 4_000, "脏数逐拍涨 300ms 也不许砍预算，实际 {}kbps", flow.kbps);
    assert_eq!(flow.feedback_queue(), Some(0), "给对端的提示要说本端测到的线上积压");
}

/// app-limited 窗（交付明显低于预算）测的是画面不是管子：包络必须冻结而不是每秒 ×7/8 衰减。
/// 否则包络沉到实际低交付率，同时关掉扩窗门（`capacity ≥ 0.8×kbps`）与漂移帽
/// （`capacity×5/4`），预算一旦被压到地板就没有任何证据能抬回去（`tcp_bbr.c:799`）。
#[test]
fn app_limited_windows_freeze_the_capacity_envelope() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 4_000;
    wire(&mut flow, 1_000, 0, 4_000 * 25);
    assert!(!flow.app_limited, "满流窗不是 app-limited");
    assert_eq!(flow.capacity_kbps, 4_000);
    // 之后画面静止：每拍只交付 80kbps，连续 10 拍。
    for n in 2..12u64 { wire(&mut flow, n * 1_000, 0, 2_000); }
    assert!(flow.app_limited, "低交付窗必须标成 app-limited");
    assert_eq!(flow.capacity_kbps, 4_000, "包络必须冻结在已证明的管宽，实际 {}kbps", flow.capacity_kbps);
    assert_eq!(flow.kbps, 5_000, "饿死期预算该爬到包络的 1.25 倍（逃生门），而不是被抽干的包络帽死");
    // 画面重新动起来，扩窗仍要继续。
    for n in 12..18u64 { let bytes = flow.kbps as u64 * 25; wire(&mut flow, n * 1_000, 0, bytes); }
    assert!(flow.kbps > 5_000, "恢复活动后必须还能继续扩窗，实际 {}kbps", flow.kbps);
}

/// 甲的定罪式：传输层否认「网络在排队」（有 RTT 样本、低于降速线、零丢包）时，绝对深度
/// 不定罪——那高出来的部分是大帧自身的序列化时间，砍码率治不了它；但**逐拍上涨**仍定罪，
/// 因为相邻两拍同为满帧时，上涨只剩排队（见 docs §5甲）。
#[test]
fn clean_transport_vetoes_absolute_depth_but_not_a_rising_trend() {
    let o = WireOpts { ceiling: 8_000, rtt_ms: 29, ..Default::default() };

    // 上涨的一半：同为满帧的两拍之间又多排了 40ms，即使 rtt=29ms、零丢包也要缩预算。
    let mut rising = Flow::default();
    rising.budget(true, 8_000);
    rising.kbps = 4_000;
    for (n, backlog) in [0i64, 130, 170, 210].iter().enumerate() {
        wire_opts(&mut rising, (n as u64 + 1) * 1_000, *backlog, 4_000 * 25, &o);
    }
    assert!(rising.kbps < 4_000, "积压逐拍上涨仍是证据，实际 {}kbps", rising.kbps);

    // 深度的一半：抬到 400ms 的那一拍本身就是上涨，允许它定罪；之后积压不再动、传输层
    // 清白，就不许再拿绝对值连砍（真机 v6 直连 52/52 拍正是这个形状）。
    let mut deep = Flow::default();
    deep.budget(true, 8_000);
    deep.kbps = 4_000;
    wire(&mut deep, 1_000, 0, 4_000 * 25);
    wire_opts(&mut deep, 2_000, 400, 4_000 * 25, &o);
    deep.discard(2_500, 0);
    let after_ramp = deep.kbps;
    assert!(deep.backlog_ms > BACKLOG_DOWN_MS);
    for n in 3..11u64 { wire_opts(&mut deep, n * 1_000, 400, 4_000 * 25, &o); }
    assert!(deep.kbps >= after_ramp, "稳定深积压 + 传输层清白不该继续砍码率，实际 {} < {}", deep.kbps, after_ramp);
}

// ── P0–P4（2026-10-06 手术）───────────────────────────────────────────────
// 这一组全部走 `note_drop`，也就是 P0 拆掉阻塞闸之后生产端真实会发出的证据；
// 存量测试一律不丢帧，所以它们对这半条判据天然瞎（见记忆「守卫必须先喂反例」）。

/// P1 的正反两面：反馈窗被拉长（低帧率时必然）仍须判成 app-limited，包络仍须冻结。
/// 旧口径的第二半 `sample_ms ≤ 400` 恰好在这一形态上反噬成 false，于是 P2 之前的
/// 「每拍 ×7/8」继续把包络抽干（实测 870→444→236），扩窗门与漂移帽双双关死。
#[test]
fn a_stretched_quiet_window_is_still_app_limited_and_still_freezes_the_envelope() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 4_000;
    wire(&mut flow, 1_000, 0, 4_000 * 25);
    assert_eq!(flow.capacity_kbps, 4_000, "满流窗先把管宽证明出来");
    let long = WireOpts { ceiling: 8_000, sample_ms: 2_000, ..Default::default() };
    for n in 2..6u64 { wire_opts(&mut flow, n * 3_000, 0, 2_000, &long); }
    assert!(flow.app_limited, "窗口 2 秒 + 交付 8kbps：测的是画面不是管子");
    assert_eq!(flow.capacity_kbps, 4_000, "P2：包络没有每拍衰减这回事，实际 {}kbps", flow.capacity_kbps);
}

/// P0 换回来的那条证据必须有用：本窗被预算挡下过帧 ⇒ 需求确凿，不是 app-limited，
/// 而且这正是 P3 允许主动探测的唯一入场券。
#[test]
fn a_budget_dropped_frame_is_demand_not_app_limiting() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 4_000;
    flow.note_drop();
    wire(&mut flow, 1_000, 0, 2_000);
    assert!(flow.demand_limited, "丢帧证据要留在诊断里可见");
    assert!(!flow.app_limited, "被预算挡过帧的低交付窗不是 app-limited（需求没饱和）");

    // 反例（同一拍、同样的低交付，只是没丢帧）必须判反：否则这条证据等于没接上。
    let mut quiet = Flow::default();
    quiet.budget(true, 8_000);
    quiet.kbps = 4_000;
    wire(&mut quiet, 1_000, 0, 2_000);
    assert!(quiet.app_limited, "没丢过的帧不许冒充需求");
}

/// P3：确有需求（本窗丢过帧）+ 传输层清白 ⇒ 一次把预算翻倍去问线路。定标与出处见
/// `PROBE_COOLDOWN_MS`（WebRTC `probe_controller.cc:94`/`:572-573`）。
#[test]
fn demand_with_clean_transport_probes_the_budget_up_double() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 1_000;
    let o = WireOpts { ceiling: 8_000, rtt_ms: 29, ..Default::default() };
    flow.note_drop();
    wire_opts(&mut flow, 1_000, 0, 1_000 * 25, &o);
    assert_eq!(flow.kbps, 2_000, "探测该翻倍而不是每秒 +25%，实际 {}kbps", flow.kbps);

    // 冷却期内不许连续撞墙：同样的证据再来一拍，预算仍按探测走，但起点已经换过。
    let before = flow.kbps;
    flow.note_drop();
    wire_opts(&mut flow, 2_000, 0, before as u64 * 25, &o);
    assert_eq!(flow.kbps, before, "5 秒冷却内不重复探测，实际 {}kbps", flow.kbps);
}

/// 反方向红线（`tcp_bbr.c:788-799` 的 app-limited 语义）：静止画面 + 清白传输**不许**
/// 买探测——那份低交付只说明没人画画。
#[test]
fn a_quiet_screen_never_buys_a_probe() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 1_000;
    let o = WireOpts { ceiling: 8_000, rtt_ms: 29, ..Default::default() };
    wire_opts(&mut flow, 1_000, 0, 1_000 * 25, &o);
    assert!(flow.kbps < 2_000, "没丢帧时最多走 +25% 常规步进，实际 {}kbps", flow.kbps);
}

/// 探测失败只许挨一刀：保护窗内出现拥塞证据 ⇒ 回到探测起点。旧口径对膨胀后的值再乘
/// 0.8，等于一次试错白丢一档。
#[test]
fn a_failed_probe_falls_back_to_its_starting_point() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 1_000;
    let clean = WireOpts { ceiling: 8_000, rtt_ms: 29, ..Default::default() };
    flow.note_drop();
    wire_opts(&mut flow, 1_000, 0, 1_000 * 25, &clean);
    assert_eq!(flow.kbps, 2_000, "先探上去");

    // rtt 归零（传输层不再背书）+ 积压从 0 涨到 400ms ⇒ 这是探测撞墙的形状。
    flow.note_drop();
    wire(&mut flow, 2_000, 400, 2_000 * 25);
    assert_eq!(flow.kbps, 1_000, "探测失败回到起点，实际 {}kbps", flow.kbps);
}

/// P2 的下调必须是慢速 EWMA（`link_capacity_estimator.cc:39-40` α=0.05），单拍不许把
/// 包络一脚踩死；否则「一次抖动 + 一个低交付窗」就又造出一个自锁。
#[test]
fn one_congested_beat_does_not_crush_the_capacity_envelope() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 4_000;
    wire(&mut flow, 1_000, 0, 4_000 * 25);
    assert_eq!(flow.capacity_kbps, 4_000);
    // 拥塞定罪（rtt 盲区 + 积压 400ms）的同时交付只有 0kbps：预算照常砍，包络只挪 5%。
    // 两侧都要钉：只写下界的话，「拥塞也算 app-limited ⇒ 包络冻结」这种变异照样过关。
    wire(&mut flow, 2_000, 400, 0);
    assert_eq!(flow.capacity_kbps, 3_800, "包络单拍恰好挪 α=0.05（4000−200），实际 {}kbps", flow.capacity_kbps);
    assert!(flow.kbps < 4_000, "预算该降还是得降，实际 {}kbps", flow.kbps);
}

/// P2 的**残余地带**（P1 抓不到的那一半）：交付停在预算的六五到八成八之间时，这一窗
/// 既不算 app-limited 也没有拥塞证据，旧口径仍每拍 ×7/8 抽包络（4000→3500→3062→…）。
/// 只有这条守卫能杀掉「把衰减加回 else 分支」的变异——别的安静窗都走冻结分支。
#[test]
fn a_seventy_percent_window_does_not_dry_up_the_envelope() {
    let mut flow = Flow::default();
    flow.budget(true, 4_000);
    flow.kbps = 4_000;
    let o = WireOpts { ceiling: 4_000, ..Default::default() };
    wire_opts(&mut flow, 1_000, 0, 4_000 * 25, &o);
    assert_eq!(flow.capacity_kbps, 4_000, "满流窗先把管宽证明出来");
    for n in 2..6u64 { wire_opts(&mut flow, n * 1_000, 0, 2_800 * 25, &o); }
    assert!(!flow.app_limited, "交付是预算的 70%：这条走的是衰减分支，不是冻结分支");
    assert_eq!(flow.capacity_kbps, 4_000, "包络没有「每拍衰减」这回事，实际 {}kbps", flow.capacity_kbps);
    assert_eq!(flow.kbps, 4_000, "上限已经压住预算，本测只验包络");
}

/// P4 的判据与控制器同源（AGENTS 规则 11.1）：采集圈复位自适应降频用的必须是**同一个**
/// `transport_clear`。写第二遍的代价就是本轮那条自锁链——两处「链路干净」口径不一致。
#[test]
fn the_shared_transport_clear_predicate_is_the_only_door() {
    assert!(!transport_clear(0, 0), "没有 RTT 样本时传输层不背书（rtt=0 是哨兵值不是 0ms）");
    assert!(transport_clear(29, 0), "有样本、低于降速线、零丢包");
    assert!(!transport_clear(150, 0), "贴着降速线就不算清白");
    assert!(!transport_clear(29, 1), "一个千分点的丢包就不清白");
}

/// P0 的节拍锚：问门不再阻塞，但下一次来问的等待必须有下界（防忙等）也有上界
/// （字节窗满了没有时刻信号，只能按反馈周期回查）。
#[test]
fn the_gate_retry_is_bounded_by_one_feedback_cycle() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    assert_eq!(flow.gate_retry_ms(0), 8, "空闲时下界 8ms，不许变成忙等");
    // 100KB / 400kbps = 2 秒发送债务：债务再长也只在 200ms 处回查。
    flow.sent(0, 0, 1, 100_000);
    assert_eq!(flow.gate_retry_ms(10), 200);
}

/// 🔴 真机第一轮复测抓到的那个形态的**复合**回放（`.cache/bench-20261006/switch-v2/`：
/// v6 直连 rtt 22–63ms、`backlog=0`、`loss=0`，预算 2800kbps 七分钟一动不动，画面钉在
/// 最低档）。这条不是单元判据，是把 P1+P2+P3 串起来问一句「同一份日志重放到今天的
/// 控制器上，还会不会卡死」。旧口径在这份形状上必红：`sample_ms≤400` 让 app_limited
/// 恒 false ⇒ 包络 870→444→236 一路抽干 ⇒ 扩窗门与漂移帽双双关死。
#[test]
fn the_field_shape_that_stayed_at_2800kbps_for_seven_minutes_now_recovers() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 2_800;
    // 先把管子证明出来：一个满流、窗口正常的拍 ⇒ 包络 = 2800。
    wire(&mut flow, 1_000, 0, 2_800 * 25);
    assert_eq!(flow.capacity_kbps, 2_800);

    // 阶段一「安静型」：0.8fps 的反馈窗天然 1200ms，只交付 300kbps，传输层清白。
    let quiet = WireOpts { ceiling: 8_000, sample_ms: 1_200, rtt_ms: 29, ..Default::default() };
    let quiet_bytes = 300u64 * 1_200 / 8;
    for n in 2..8u64 {
        wire_opts(&mut flow, n * 1_000, 0, quiet_bytes, &quiet);
    }
    assert!(flow.app_limited, "长窗低交付必须判成 app-limited（P1 的正题）");
    assert_eq!(flow.capacity_kbps, 2_800, "包络不许被安静期抽干（P2 的正题）");
    assert!(flow.kbps > 2_800, "扩窗门要开着，实际 {}kbps", flow.kbps);
    assert!(flow.kbps <= 3_500, "仍受漂移帽 1.25×包络约束，实际 {}kbps", flow.kbps);

    // 阶段二「有需求型」：同样的低交付窗，但每窗都被预算挡下过一帧（P0 换回来的证据）
    // ⇒ 这不是画面少，是我们自己发不出去 ⇒ 探测翻倍（P3）。真机那七分钟里鼠标一直在动，
    // 属于这一型。
    for n in 8..10u64 {
        flow.note_drop();
        wire_opts(&mut flow, n * 1_000, 0, quiet_bytes, &quiet);
        assert!(!flow.app_limited, "有丢帧证据时不许再算 app-limited");
    }
    assert!(flow.kbps >= 5_000, "两次冷却到期的探测应把预算翻倍抬起来，实际 {}kbps", flow.kbps);
    assert!(flow.demand_limited, "需求证据要留在诊断里");
}

