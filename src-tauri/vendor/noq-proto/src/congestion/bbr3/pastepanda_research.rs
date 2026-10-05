// Reproduced against unmodified noq-proto 1.2.0 before backporting.
use super::*;

#[test]
fn first_completed_ack_updates_bandwidth() {
    let mut bbr = Bbr3::new(Arc::new(Bbr3Config::default()), 1200);
    let base = Instant::now();
    let rtt = RttEstimator::new(Duration::from_millis(10));
    bbr.on_packet_sent(base, 1200, 0, SpaceKind::Data);
    bbr.on_ack(
        base + Duration::from_millis(10),
        base,
        1200,
        0,
        SpaceKind::Data,
        false,
        &rtt,
    );
    bbr.on_end_acks(
        base + Duration::from_millis(10),
        0,
        false,
        Some(0),
        SpaceKind::Data,
    );
    assert!(
        (bbr.max_bw - 120_000.0).abs() < 1.0,
        "completed ACK must fold 1200B/10ms into this ACK's model: {}",
        bbr.max_bw
    );
}

#[test]
fn first_measured_rtt_replaces_startup_placeholder() {
    let mut bbr = Bbr3::new(Arc::new(Bbr3Config::default()), 1200);
    let base = Instant::now();
    let rtt = RttEstimator::new(Duration::from_millis(40));
    bbr.on_packet_sent(base, 1200, 0, SpaceKind::Data);
    bbr.on_ack(
        base + Duration::from_millis(40),
        base,
        1200,
        0,
        SpaceKind::Data,
        true,
        &rtt,
    );
    bbr.on_end_acks(
        base + Duration::from_millis(40),
        0,
        true,
        Some(0),
        SpaceKind::Data,
    );
    let expected = STARTUP_PACING_GAIN * bbr.initial_cwnd as f64 / 0.040;
    assert!(
        (bbr.pacing_rate - expected).abs() < 1.0,
        "first RTT must replace 1ms placeholder: actual={}, expected={expected}",
        bbr.pacing_rate
    );
}

#[test]
fn first_probe_rtt_packets_are_capacity_limited_samples() {
    let mut bbr = Bbr3::new(Arc::new(Bbr3Config::default()), 1200);
    let base = Instant::now();
    bbr.state = BbrState::ProbeBw(ProbeBwSubstate::Cruise);
    bbr.full_bw_reached = true;
    bbr.min_rtt = Duration::from_millis(10);
    bbr.bw = 1_000_000.0;
    bbr.max_bw = 1_000_000.0;
    bbr.delivered = 1200;
    bbr.inflight = 4800;
    bbr.probe_rtt_expired = true;
    bbr.check_probe_rtt(base);
    assert_eq!(bbr.state, BbrState::ProbeRtt);
    bbr.on_packet_sent(base + Duration::from_millis(1), 1200, 1, SpaceKind::Data);
    assert!(
        bbr.packets[SpaceKind::Data as usize]
            .back()
            .unwrap()
            .is_app_limited,
        "ProbeRTT's self-imposed low rate must not replace measured path capacity"
    );
}
