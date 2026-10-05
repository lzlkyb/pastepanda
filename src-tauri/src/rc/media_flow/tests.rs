use super::*;
fn feedback(at: i64, bytes: u64, age: i64) -> MediaFeedback {
    MediaFeedback { received_at_ms: at, received_bytes: bytes, sample_ms: 200, age_ms: age, presented_at_ms: 0, display_delay_ms: None, receive_queue_ms: None }
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
    flow.feedback(1_000, &feedback(1, 50_000, 800), 8_000, 0);
    assert!(flow.kbps > 2_000);
    flow.feedback(2_000, &feedback(2, 20_000, 1_200), 8_000, 0);
    assert_eq!(flow.queue_ms, 400);
    assert!(flow.kbps <= 800);
}

#[test]
fn idle_desktop_is_not_measured_as_a_bandwidth_ceiling() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    for n in 1..20 { flow.feedback(n * 1_000, &feedback(n as i64, 100, 50), 8_000, 0); }
    assert_eq!(flow.kbps, 2_000);
}

#[test]
fn active_direct_stream_recovers_resolution_with_moderate_receive_jitter() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 400;
    assert_eq!(flow.resolution_limit(0), 1280);
    assert_eq!(flow.resolution_limit(5_000), 960);
    for n in 6..46 {
        // 满足当前预算的活动画面，额外队列稳定在真机观测的 63..98ms。
        let mut f = feedback(n as i64, flow.kbps as u64 * 25, 100);
        f.receive_queue_ms = Some(80);
        flow.feedback(n * 1_000, &f, 8_000, 0);
        flow.resolution_limit(n * 1_000);
    }
    assert!(flow.kbps >= 1_100, "稳定直连不应永久卡在低码率");
    assert_ne!(flow.max_width, 960, "满足恢复预算后须允许恢复文字分辨率");
    let before = flow.kbps;
    let mut f = feedback(46, before as u64 * 25, 100);
    f.receive_queue_ms = Some(160);
    flow.feedback(46_000, &f, 8_000, 0);
    assert!(flow.kbps < before, "真实队列超过降速阈值仍必须减速");
    let mut idle = Flow::default();
    idle.budget(false, 8_000);
    for n in 1..20 {
        let mut f = feedback(n as i64, 100, 100);
        f.receive_queue_ms = Some(80);
        idle.feedback(n * 1_000, &f, 8_000, 0);
    }
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
    flow.feedback(100, &feedback(2, 50_000, 50), 8_000, 0);
    assert_eq!(flow.pending_bytes, 0);
    assert_eq!(flow.admission(200, 50), Admission::Ready);
}

#[test]
fn late_feedback_cannot_regress_ack_or_retain_discarded_bytes() {
    let mut flow = Flow::default();
    flow.sent(1, 1, 10, 100);
    flow.discard(2, 0);
    flow.sent(3, 3, 20, 100);
    flow.feedback(4, &feedback(10, 100, 10), 8_000, 0);
    assert_eq!(flow.pending_bytes, 100);
    flow.feedback(5, &feedback(20, 100, 10), 8_000, 0);
    flow.feedback(6, &feedback(10, 100, 900), 8_000, 0);
    assert_eq!(flow.pending_bytes, 0);
    assert_eq!(flow.queue_ms, 0);
}

#[test]
fn ack_deadline_includes_complete_frame_serialization_on_a_slow_path() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.kbps = 400;
    flow.feedback(1, &feedback(1, 100, 800), 8_000, 0);
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
    flow.feedback(200, &feedback(10, 100, 30), 8_000, 0);
    flow.sent(300, 300, 20, 100);
    flow.discard(1_000, 0);
    flow.feedback(1_050, &feedback(20, 100, 900), 8_000, 0); // RESET 前的迟到反馈。
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
    flow.feedback(1_350, &feedback(1, 5_000, 900), 8_000, 0);
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
    let mut f = feedback(1, 5_000, 200);
    f.receive_queue_ms = Some(190);
    flow.feedback(700, &f, 8_000, 0);
    assert_ne!(flow.admission(770, 50), Admission::Reset,
        "ACK 70ms 前确认了新画面，中等抖动不该不断重开参考链");
    assert_eq!(flow.admission(1_400, 50), Admission::Reset,
        "ACK 停止后仍须及时回收，不能无限等待");
}

#[test]
fn fresh_feedback_cannot_hide_an_excessive_receiving_queue() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.kbps = 400;
    flow.sent(0, 0, 1, 5_000);
    flow.sent(100, 100, 2, 5_000);
    let mut f = feedback(1, 5_000, 1_000);
    f.receive_queue_ms = Some(1_000);
    flow.feedback(700, &f, 8_000, 0);
    assert_eq!(flow.admission(770, 50), Admission::Reset,
        "已有一秒额外积压，即使收到 ACK 也必须废弃旧画面");
}

#[test]
fn media_ack_allowance_cannot_follow_an_unbounded_queue() {
    let mut flow = Flow::default();
    flow.kbps = 400;
    flow.sent(0, 0, 1, 5_000);
    flow.feedback(20_000, &feedback(1, 5_000, 20_000), 8_000, 0);
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
    flow.feedback(690, &f, 8_000, 0);
    flow.sent(700, 700, 2, 5_000);
    // 真机：RTT 548ms、媒体 ACK 690ms、最后反馈已过去 839ms，
    // 接收额外队列仍仅 20ms。回程抖动不能直接当成参考链过期。
    assert_ne!(flow.admission(1_940, 548), Admission::Reset);
    f.received_at_ms = 2;
    flow.feedback(2_000, &f, 8_000, 0);
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
    flow.feedback(690, &f, 8_000, 0);
    flow.sent(700, 700, 2, 5_000);
    flow.sent(800, 800, 3, 5_000);
    f.received_at_ms = 2;
    f.receive_queue_ms = Some(400);
    flow.feedback(1_950, &f, 8_000, 0);
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
    flow.feedback(500, &feedback(1, 5_000, 500), 8_000, 0);
    flow.sent(600, 600, 2, 5_000);
    flow.sent(700, 700, 3, 5_000);
    flow.feedback(2_000, &feedback(2, 5_000, 1_400), 8_000, 0);
    assert_eq!(flow.queue_ms, 700); // 排除至多 200ms 的反馈采样相位差。
    assert_eq!(flow.admission(2_001, 500), Admission::Reset,
        "真实积压增大时，刚到的慢 ACK 也不能推迟过期链恢复");
}

#[test]
fn clock_reanchoring_does_not_invent_media_queue_pressure() {
    let mut flow = Flow::default();
    flow.budget(true, 8_000);
    flow.sent(0, 0, 1, 50_000);
    flow.feedback(1_000, &feedback(1, 50_000, 0), 8_000, 0);
    let before = flow.kbps;
    flow.sent(1_000, 1_000, 2, 50_000);
    flow.feedback(2_000, &feedback(2, 50_000, 1_300), 8_000, 0);
    assert_eq!(flow.queue_ms, 0, "真实交付耗时未增加，校准跳变不是积压");
    assert!(flow.kbps >= before);
}

#[test]
fn feedback_sampling_phase_is_not_congestion() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    flow.sent(0, 0, 1, 5_000);
    flow.feedback(50, &feedback(1, 5_000, 30), 8_000, 0);
    flow.sent(1_000, 1_000, 2, 5_000);
    flow.feedback(1_250, &feedback(2, 5_000, 30), 8_000, 0);
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
    flow.feedback(1_000, &first, 8_000, 0);
    assert_eq!(flow.queue_ms, 1_000);
    flow.sent(1_000, 1_000, 2, 5_000);
    first.received_at_ms = 2; // 旧客户端继续携带上一次绘制值。
    flow.feedback(2_000, &first, 8_000, 0);
    assert_eq!(flow.queue_ms, 0);
}

#[test]
fn relay_capacity_can_grow_and_direct_upgrade_reprobes() {
    let mut flow = Flow::default();
    for n in 1..30 {
        let budget = flow.budget(true, 8_000);
        flow.feedback(n * 1_000, &feedback(n as i64, budget as u64 * 25, 70), 8_000, 0);
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
    flow.feedback(1000, &f, 8_000, 0);
    assert_eq!(flow.queue_ms, 5);
}

#[test]
fn fps_hysteresis_prevents_encoder_reopen_at_bandwidth_boundary() {
    let mut flow = Flow::default();
    flow.budget(false, 8_000);
    assert_eq!(flow.fps_limit(false), 30);
    for rate in [2_900, 3_100, 2_700, 3_200] {
        flow.kbps = rate;
        assert_eq!(flow.fps_limit(false), 30);
    }
    flow.kbps = 2_000;
    assert_eq!(flow.fps_limit(false), 15);
    for rate in [2_900, 3_100, 2_700, 3_200] {
        flow.kbps = rate;
        assert_eq!(flow.fps_limit(false), 15);
    }
}

#[test]
fn fast_direct_path_preserves_explicit_high_fps_profiles() {
    let mut flow = Flow::default();
    flow.kbps = 10_000;
    assert_eq!(flow.fps_limit(false), 30);
    assert_eq!(flow.fps_limit(false), 165);
    flow.kbps = 7_500;
    assert_eq!(flow.fps_limit(false), 165, "高档也需滞回");
    assert_eq!(flow.fps_limit(true), 30, "中继仍限制到 30fps");
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
    assert_eq!(flow.resolution_limit(1_000), 1280);
    assert_eq!(flow.resolution_limit(5_000), 0);
}

#[test]
fn oversized_feedback_does_not_overflow_the_controller() {
    let mut flow = Flow::default();
    let mut f = feedback(1, u64::MAX, 20);
    f.sample_ms = 1;
    flow.feedback(1_000, &f, 8_000, 0);
    f.received_at_ms = 2;
    f.age_ms = i64::MAX;
    flow.feedback(2_000, &f, 8_000, 0);
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
            flow.feedback(now, &f, 8_000, 0);
        }
        if now < capture_due { continue; }
        match flow.admission(now, 80) {
            Admission::Reset => { flow.discard(now, 0); packets.clear(); wire_end = now; resets += 1; }
            Admission::Wait => continue,
            Admission::Ready => {
                let interval = 1_000u64 / flow.fps_limit(false) as u64;
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
    assert!(settled_max_queue <= 150, "收敛后仍累积了 {settled_max_queue}ms");
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
        flow.feedback(n * 1_000, &f, 8_000, loss);
        flow.resolution_limit(n * 1_000);
    }
    assert!(flow.kbps >= 2_800, "healthy lossy delivery remained at {}kbps", flow.kbps);
    assert_eq!(flow.max_width, 0, "desktop text must regain its source resolution");
    let before = flow.kbps;
    let mut congested = feedback(66, before as u64 * 25, 100);
    congested.receive_queue_ms = Some(120);
    flow.feedback(66_000, &congested, 8_000, 60);
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
    flow.queue_ms = 20;
    flow.discard(100, 0);
    assert_eq!(flow.kbps, 2_000, "ACK progressing, no loss, shallow queue must not shrink the budget");

    flow.last_feedback_ms = Some(90);
    flow.discard(100, 60);
    assert_eq!(flow.kbps, 1_400, "frame-granular loss is evidence");

    flow.queue_ms = 400;
    flow.last_feedback_ms = Some(90);
    flow.discard(100, 0);
    assert_eq!(flow.kbps, 980, "a deep receive queue is evidence");

    flow.queue_ms = 0;
    flow.last_feedback_ms = Some(90);
    flow.discard(1_200, 0);
    assert_eq!(flow.kbps, 686, "going ACK-blind is evidence");
}
