//! Android's packaged Linux static core cannot use Android's libc DNS resolver.
#[cfg(any(target_os = "android", test))]
use std::{future::Future, net::SocketAddr, time::Duration};

#[cfg(any(target_os = "android", test))]
const HOSTS: [&str; 3] = ["stun.miwifi.com", "stun.chat.bilibili.com", "stun.hitv.com"];

pub(super) async fn config() -> String {
    #[cfg(target_os = "android")]
    {
        let start = std::time::Instant::now();
        // These are the three hostname entries in the pinned core's default UDP list.
        // Resolve with the Android application libc, not the Linux child process.
        let servers = resolve_with(|host| async move {
            tokio::net::lookup_host((host, 3478)).await.map(|ips| ips.collect())
        }, Duration::from_secs(2)).await;
        log::info!("[RC-UNDERLAY-PHASE] role=phone phase=app-stun-resolved elapsed={}ms providers={}",
            start.elapsed().as_millis(), servers.as_ref().map_or(0, Vec::len));
        line(servers)
    }
    #[cfg(not(target_os = "android"))]
    String::new()
}

#[cfg(any(target_os = "android", test))]
async fn resolve_with<L, F>(lookup: L, timeout: Duration) -> Option<Vec<SocketAddr>>
where L: Fn(&'static str) -> F, F: Future<Output = std::io::Result<Vec<SocketAddr>>> {
    let lookup = &lookup;
    let query = |host| async move {
        tokio::time::timeout(timeout, lookup(host)).await.ok().and_then(Result::ok)
            .and_then(|ips| ips.into_iter().find(SocketAddr::is_ipv4))
    };
    let (a, b, c) = tokio::join!(query(HOSTS[0]), query(HOSTS[1]), query(HOSTS[2]));
    let mut servers = Vec::new();
    for ip in [a, b, c].into_iter().flatten() {
        if !servers.contains(&ip) { servers.push(ip); }
    }
    // Multiple destinations are needed to distinguish symmetric mappings. If DNS
    // cannot supply them, keep the core's original TXT/default discovery intact.
    (servers.len() >= 2).then_some(servers)
}

#[cfg(any(target_os = "android", test))]
fn line(servers: Option<Vec<SocketAddr>>) -> String {
    servers.map_or_else(String::new, |ips| format!("stun_servers = {}\n",
        serde_json::to_string(&ips.iter().map(ToString::to_string).collect::<Vec<_>>()).unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn android_lookup_is_parallel_and_core_receives_only_literal_ipv4() {
        let barrier = tokio::sync::Barrier::new(3);
        let servers = tokio::time::timeout(Duration::from_secs(1), resolve_with(|host| {
            let barrier = &barrier;
            async move {
                barrier.wait().await;
                let index = HOSTS.iter().position(|h| *h == host).unwrap() + 1;
                Ok(vec!["[::1]:3478".parse().unwrap(), format!("192.0.2.{index}:3478").parse().unwrap()])
            }
        }, Duration::from_millis(500))).await.unwrap();
        assert_eq!(line(servers), "stun_servers = [\"192.0.2.1:3478\",\"192.0.2.2:3478\",\"192.0.2.3:3478\"]\n");
    }

    #[tokio::test]
    async fn one_stalled_provider_does_not_delay_the_others_indefinitely() {
        let servers = resolve_with(|host| async move {
            if host == HOSTS[2] { return std::future::pending().await; }
            Ok(vec![if host == HOSTS[0] { "192.0.2.1:3478" } else { "192.0.2.2:3478" }.parse().unwrap()])
        }, Duration::from_millis(10)).await;
        assert_eq!(servers.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn missing_ipv4_or_duplicate_destination_preserves_default_discovery() {
        for ips in [vec![], vec!["[::1]:3478".parse().unwrap()], vec!["192.0.2.1:3478".parse().unwrap()]] {
            let servers = resolve_with(|_| std::future::ready(Ok(ips.clone())), Duration::from_millis(10)).await;
            assert_eq!(line(servers), "");
        }
    }
}
