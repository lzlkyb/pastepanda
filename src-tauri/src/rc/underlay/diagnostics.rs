//! Keep timing labels, never persist native log payloads (which can include credentials).
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};

pub(super) const FILTER: &str = "off,easytier::common::stun=debug,easytier::connector::udp_hole_punch=info";

fn phase(line: &str) -> Option<&'static str> {
    let markers = if line.contains("easytier::common::stun:") {
        &[("finish udp nat type detect with another port", "nat-extra-check-finished"),
          ("finish udp nat type detect", "nat-check-finished")][..]
    } else if line.contains("easytier::connector::udp_hole_punch") {
        &[("found peer to do hole punching", "peer-scheduled"),
          ("udp hole punching listener started", "listener-ready"),
          ("send_punch_packet_easy_sym start", "predictive-probe"),
          ("try_punch_symmetric start", "random-probe"),
          ("failed to send punch packet for hard sym", "random-rpc-failed"),
          ("got hole punching packet with intreast tid", "probe-packet-received"),
          ("failed to connect with socket", "punched-socket-connect-failed"),
          ("failed to create udp hole punching listener", "listener-create-failed"),
          ("failed to add tunnel as server in hole punch listener", "server-tunnel-add-failed"),
          ("add client tunnel failed", "client-tunnel-add-failed"),
          ("hole punching get tunnel success", "tunnel-ready"),
          ("hole punching failed, no punch tunnel", "probe-missed"),
          ("hole punching failed, err:", "punch-operation-failed")][..]
    } else { return None; };
    markers.iter().find_map(|(marker, label)| line.contains(marker).then_some(*label))
}

pub(super) async fn drain(stderr: tokio::process::ChildStderr, role: String, start: Instant) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(label) = phase(&line) {
            log::info!("[RC-UNDERLAY-PHASE] role={role} phase={label} elapsed={}ms", start.elapsed().as_millis());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_credentials_and_addresses_are_never_returned_as_timing_labels() {
        assert_eq!(phase("network_secret=private"), None);
        assert_eq!(phase("unrelated: try_punch_symmetric start"), None);
        assert_eq!(phase("easytier::common::stun: finish udp nat type detect with another port private=secret"), Some("nat-extra-check-finished"));
        assert_eq!(phase("easytier::connector::udp_hole_punch::sym_to_cone: try_punch_symmetric start ip=10.0.0.1 secret=private"), Some("random-probe"));
        assert_eq!(phase("easytier::connector::udp_hole_punch: found peer to do hole punching peer_id=private"), Some("peer-scheduled"));
        assert_eq!(phase("easytier::connector::udp_hole_punch: hole punching get tunnel success"), Some("tunnel-ready"));
    }

    #[test]
    fn failure_stages_are_distinct_without_returning_native_payloads() {
        for (marker, label) in [
            ("failed to send punch packet for hard sym", "random-rpc-failed"),
            ("got hole punching packet with intreast tid", "probe-packet-received"),
            ("failed to connect with socket", "punched-socket-connect-failed"),
            ("failed to create udp hole punching listener", "listener-create-failed"),
            ("failed to add tunnel as server in hole punch listener", "server-tunnel-add-failed"),
            ("add client tunnel failed", "client-tunnel-add-failed"),
            ("hole punching failed, err:", "punch-operation-failed"),
        ] {
            assert_eq!(phase(&format!("easytier::connector::udp_hole_punch::common: {marker} ip=10.0.0.1 secret=private")), Some(label));
            assert_eq!(phase(&format!("unrelated: {marker} secret=private")), None);
        }
        // 开 common 的 info 只为接收命中标签；高频发送/原始包正文仍不返回。
        assert_eq!(phase("easytier::connector::udp_hole_punch::common: sending hole punching packet ip=10.0.0.1"), None);
        assert_eq!(phase("easytier::connector::udp_hole_punch::common: got raw packet bytes=private"), None);
        assert!(!FILTER.contains("udp_hole_punch::common=warn"));
    }
}
