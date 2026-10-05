use serde::{Deserialize, Serialize};

pub(super) const MAGIC: &str = "PPEZ3";
pub(super) const PHONE_IP: &str = "10.211.84.2";

#[derive(Serialize, Deserialize)]
pub(super) struct Hello { pub magic: String, pub port: u16 }
#[derive(Serialize, Deserialize)]
pub(super) struct Offer { pub magic: String, pub network: String, pub secret: String, pub port: u16 }

pub(super) async fn node(offer: &Offer, host: bool, listener: u16, seed: u16, proxy: Option<(u16, u16)>) -> String {
    let ip = if host { "10.211.84.1" } else { PHONE_IP };
    let stun = super::stun::config().await;
    let mut cfg = format!(
        "instance_name = \"pp-underlay\"\nipv4 = \"{ip}\"\nlisteners = [\"udp://0.0.0.0:{listener}\"]\n{stun}\
         [network_identity]\nnetwork_name = {:?}\nnetwork_secret = {:?}\n\
         [[peer]]\nuri = \"ws://127.0.0.1:{seed}\"\n\
         [flags]\nno_tun = true\ndisable_upnp = true\naccept_dns = false\nbind_device = false\n\
         relay_network_whitelist = \"\"\np2p_only = true\ndisable_sym_hole_punching = false\n", offer.network, offer.secret);
    if let Some((bind, remote)) = proxy {
        let target = if host { PHONE_IP } else { "10.211.84.1" };
        cfg.push_str(&format!("\n[[port_forward]]\nbind_addr = \"127.0.0.1:{bind}\"\ndst_addr = \"{target}:{remote}\"\nproto = \"udp\"\n"));
    }
    cfg
}

pub(super) fn seed(port: u16) -> String {
    // TCP 的总连接预算只有 2 秒，无法穿过已积压的中继；上游 WS 使用 20 秒预算。
    // WS 仍只监听 localhost，字节经已批准的原 QUIC 会话转发。
    format!("instance_name = \"pp-coordinator\"\nlisteners = [\"ws://127.0.0.1:{port}\"]\n\
        [network_identity]\nnetwork_name = \"seed-{}\"\nnetwork_secret = \"{}\"\n\
        [flags]\nno_tun = true\ndisable_upnp = true\naccept_dns = false\nbind_device = false\n\
        relay_network_whitelist = \"\"\nrelay_all_peer_rpc = true\n", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
}

// 只认指定虚拟对端的实际 P2P UDP 路径；协调器低 RTT/中继两跳都不算直连。
pub(super) fn p2p_udp(peers: &serde_json::Value) -> bool {
    peers.as_array().is_some_and(|rows| rows.iter().any(|row|
        row["ipv4"] == PHONE_IP && row["cost"] == "p2p" && row["tunnel_proto"] == "udp"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coordinator_or_relay_cannot_promote_media() {
        assert!(!p2p_udp(&serde_json::json!([{ "ipv4": PHONE_IP, "cost": "relay(2)", "tunnel_proto": "tcp", "lat_ms": "1" }])));
        assert!(!p2p_udp(&serde_json::json!([{ "ipv4": "10.211.84.3", "cost": "p2p", "tunnel_proto": "udp" }])));
        assert!(p2p_udp(&serde_json::json!([{ "ipv4": PHONE_IP, "cost": "p2p", "tunnel_proto": "udp" }])));
    }
    #[tokio::test]
    async fn isolated_node_never_enables_public_forwarding() {
        let o = Offer { magic: MAGIC.into(), network: "n".into(), secret: "s".into(), port: 4 };
        let c = node(&o, true, 1, 2, Some((3, 4))).await;
        assert!(c.contains("p2p_only = true"));
        assert!(c.contains("no_tun = true"));
        assert!(c.contains("relay_network_whitelist = \"\""));
        assert!(c.contains("bind_addr = \"127.0.0.1:3\""));
        assert!(c.contains("disable_upnp = true"));
        assert!(c.contains("uri = \"ws://127.0.0.1:2\""));
        assert!(seed(2).contains("listeners = [\"ws://127.0.0.1:2\"]"));
    }
}
