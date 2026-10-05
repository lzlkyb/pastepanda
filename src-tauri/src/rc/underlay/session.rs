use std::time::{Duration, Instant};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use tokio::net::{TcpListener, TcpStream};
use super::{config::{self, Hello, Offer, MAGIC}, runtime::{self, Runtime}};
use crate::sync::transport::{read_frame, write_frame};

type Error = Box<dyn std::error::Error + Send + Sync>;
const PUNCH_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) async fn run(conn: Connection, host: bool) -> Result<(), Error> {
    if host { host_run(conn).await } else { phone_run(conn).await }
}

async fn host_run(conn: Connection) -> Result<(), Error> {
    let start = Instant::now();
    let (mut send, mut recv) = tokio::time::timeout(PUNCH_TIMEOUT, conn.accept_bi()).await??;
    let _ = send.set_priority(crate::rc::media::CONTROL_PRIORITY);
    let hello: Hello = serde_json::from_slice(&tokio::time::timeout(Duration::from_secs(5), read_frame(&mut recv)).await??)?;
    if hello.magic != MAGIC || hello.port == 0 { return Err("备用承载能力不匹配".into()); }
    log::info!("[RC-UNDERLAY] 手机能力已收到，准备私有协调组件");
    let mut runtime = Runtime::new().await?;
    let seed = runtime::tcp_port()?;
    let rpc = runtime::tcp_port()?;
    runtime.spawn("seed", &config::seed(seed), runtime::tcp_port()?)?;
    let ep = crate::shared_ep::existing().ok_or("共享端点不可用")?;
    let port = ep.bound_sockets().iter().find(|a| a.is_ipv4()).ok_or("没有 IPv4 QUIC 套接字")?.port();
    let offer = Offer { magic: MAGIC.into(), network: format!("pp-{}", uuid::Uuid::new_v4()), secret: uuid::Uuid::new_v4().to_string(), port };
    let node = config::node(&offer, true, runtime::udp_port()?, seed, None).await;
    runtime.spawn("host", &node, rpc)?;
    write_frame(&mut send, &serde_json::to_vec(&offer)?).await?;
    log::info!("[RC-UNDERLAY] 协调参数已入控制优先级流，等待手机组件首包");
    // EasyTier 的 TCP peer 握手有自己的短超时。手机还未收到 Offer 时就连接
    // seed，会提前耗尽这个超时并静默关闭桥，随后手机永远拿不到有效协调。
    let seed_socket = connect_seed_after_remote_data(&mut recv, seed).await?;
    log::info!("[RC-UNDERLAY] 手机组件首包已收到，私有协调桥已接通");
    // 原生 connector 会自动重试；一条本地 TCP 关闭不能结束整个组件生命周期。
    let bridge = coordinate_host(conn.clone(), send, recv, seed_socket, seed, &offer, hello.port);
    let promote = async {
        tokio::time::timeout(PUNCH_TIMEOUT, async {
            loop {
                if runtime.peers(rpc).await.is_ok_and(|p| config::p2p_udp(&p)) { break; }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }).await?;
        let (mut ack, _) = conn.open_bi().await?;
        let _ = ack.set_priority(crate::rc::media::CONTROL_PRIORITY);
        write_frame(&mut ack, MAGIC.as_bytes()).await?;
        ack.finish()?;
        let _label = crate::sync::path_kind::register_underlay(conn.remote_id().to_string());
        // 该地址在手机端指向自己的 UDP 代理，只有确认 P2P 后才可达。
        // add_external_addr 刷新既有连接的 QNT 候选，手机作为 QUIC client
        // 验证并打开新 path；仅缓存 EndpointAddr 不会触发这次路径迁移。
        // N0 的 PkarrPublisher 默认只发布 relay，不公开这条会话内 localhost 候选。
        let _candidate = ExternalCandidate::add(ep.clone(), ([127, 0, 0, 1], hello.port).into()).await;
        log::info!("[RC-UNDERLAY] UDP 直连已确认，候选已加入原端点，耗时 {}ms", start.elapsed().as_millis());
        let mut misses = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            // RPC 超时或路由刷新的一次空快照不能直接杀掉正在承载媒体的组件。
            let connected = runtime.peers(rpc).await.is_ok_and(|p| config::p2p_udp(&p));
            if path_loss_confirmed(&mut misses, connected) {
                return Err::<(), Error>("备用 UDP 直连已失效，释放并回落原链路".into());
            }
        }
    };
    tokio::select! { r = bridge => r, r = promote => r }
}

async fn phone_run(conn: Connection) -> Result<(), Error> {
    let port = runtime::udp_port()?;
    let (mut send, mut recv) = conn.open_bi().await?;
    let _ = send.set_priority(crate::rc::media::CONTROL_PRIORITY);
    write_frame(&mut send, &serde_json::to_vec(&Hello { magic: MAGIC.into(), port })?).await?;
    let offer: Offer = serde_json::from_slice(&tokio::time::timeout(Duration::from_secs(30), read_frame(&mut recv)).await??)?;
    // 只允许本版本产生的固定格式，拒绝把不可信文本写进 TOML。
    if offer.magic != MAGIC || offer.port == 0 || !valid_token(&offer.network) || !valid_token(&offer.secret) {
        return Err("备用协调参数无效".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let mut runtime = Runtime::new().await?;
    let node = config::node(&offer, false, runtime::udp_port()?, listener.local_addr()?.port(), Some((port, offer.port))).await;
    runtime.spawn("phone", &node, runtime::tcp_port()?)?;
    log::info!("[RC-UNDERLAY] 手机应用权限下备用组件已启动，协调经原 QUIC 会话");
    let (socket, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await??;
    let bridge = coordinate_phone(conn.clone(), send, recv, socket, listener, &offer, port);
    let acknowledge = async {
        let (mut ack_send, mut ack_recv) = tokio::time::timeout(PUNCH_TIMEOUT, conn.accept_bi()).await??;
        let msg = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut ack_recv)).await??;
        if msg != MAGIC.as_bytes() { return Err::<(), Error>("备用直连确认无效".into()); }
        ack_send.finish()?;
        let _label = crate::sync::path_kind::register_underlay(conn.remote_id().to_string());
        log::info!("[RC-UNDERLAY] 对端已确认备用 UDP 直连，等待原 QUIC 路径迁移");
        std::future::pending::<Result<(), Error>>().await
    };
    tokio::select! { r = bridge => r, r = acknowledge => r }
}

async fn coordinate_host(
    conn: Connection, mut send: SendStream, mut recv: RecvStream, mut socket: TcpStream,
    seed: u16, offer: &Offer, phone_port: u16,
) -> Result<(), Error> {
    loop {
        let Err(error) = bridge(send, recv, socket).await else { return Ok(()); };
        log::warn!("[RC-UNDERLAY] 协调桥结束，保留组件等待重连：{error}");
        (send, recv) = tokio::time::timeout(PUNCH_TIMEOUT, conn.accept_bi()).await??;
        let _ = send.set_priority(crate::rc::media::CONTROL_PRIORITY);
        let hello: Hello = serde_json::from_slice(&tokio::time::timeout(Duration::from_secs(30), read_frame(&mut recv)).await??)?;
        if hello.magic != MAGIC || hello.port != phone_port { return Err("备用协调重连参数不匹配".into()); }
        write_frame(&mut send, &serde_json::to_vec(offer)?).await?;
        socket = connect_seed_after_remote_data(&mut recv, seed).await?;
        log::info!("[RC-UNDERLAY] 私有协调桥已重新接通");
    }
}

async fn coordinate_phone(
    conn: Connection, mut send: SendStream, mut recv: RecvStream, mut socket: TcpStream,
    listener: TcpListener, offer: &Offer, port: u16,
) -> Result<(), Error> {
    loop {
        let Err(error) = bridge(send, recv, socket).await else { return Ok(()); };
        log::warn!("[RC-UNDERLAY] 协调桥结束，保留组件等待重连：{error}");
        (socket, _) = tokio::time::timeout(PUNCH_TIMEOUT, listener.accept()).await??;
        (send, recv) = conn.open_bi().await?;
        let _ = send.set_priority(crate::rc::media::CONTROL_PRIORITY);
        write_frame(&mut send, &serde_json::to_vec(&Hello { magic: MAGIC.into(), port })?).await?;
        let next: Offer = serde_json::from_slice(&tokio::time::timeout(Duration::from_secs(30), read_frame(&mut recv)).await??)?;
        // 重试沿用同一获批会话的私有网络；不能偷偷换密钥或 UDP 目标。
        if next.magic != MAGIC || next.network != offer.network || next.secret != offer.secret || next.port != offer.port {
            return Err("备用协调重连参数不匹配".into());
        }
    }
}

struct ExternalCandidate { endpoint: std::sync::Arc<iroh::Endpoint>, address: std::net::SocketAddr }
impl ExternalCandidate {
    async fn add(endpoint: std::sync::Arc<iroh::Endpoint>, address: std::net::SocketAddr) -> Self {
        endpoint.add_external_addr(address).await;
        Self { endpoint, address }
    }
}
impl Drop for ExternalCandidate {
    fn drop(&mut self) {
        let endpoint = self.endpoint.clone();
        let address = self.address;
        tauri::async_runtime::spawn(async move {
            endpoint.remove_external_addr(&address).await;
            log::info!("[RC-UNDERLAY] 会话内 QNT 候选已撤回");
        });
    }
}

fn valid_token(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn path_loss_confirmed(misses: &mut u8, connected: bool) -> bool {
    *misses = if connected { 0 } else { misses.saturating_add(1) };
    *misses >= 3
}

async fn connect_seed(port: u16) -> Result<TcpStream, Error> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(socket) = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await { return socket; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.map_err(Into::into)
}

async fn connect_seed_after_remote_data(
    recv: &mut (impl tokio::io::AsyncRead + Unpin), port: u16,
) -> Result<TcpStream, Error> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut first = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(30), recv.read(&mut first)).await??;
    if n == 0 { return Err("手机在启动备用组件前关闭了协调流".into()); }
    let mut socket = connect_seed(port).await?;
    socket.write_all(&first[..n]).await?;
    Ok(socket)
}

async fn bridge(mut send: SendStream, mut recv: RecvStream, socket: TcpStream) -> Result<(), Error> {
    let (mut rd, mut wr) = socket.into_split();
    // 每次 connector 重连都用新 QUIC 流，旧流必须 RESET，避免旧握手积压串到下一次。
    let result: Result<(), Error> = tokio::select! {
        result = tokio::io::copy(&mut recv, &mut wr) => result.map_err(Into::into).and_then(|n| Err(format!("远端协调流关闭，接收 {n}B").into())),
        result = tokio::io::copy(&mut rd, &mut send) => result.map_err(Into::into).and_then(|n| Err(format!("本地组件 TCP 关闭，发送 {n}B").into())),
    };
    let _ = send.reset(0u32.into());
    let _ = recv.stop(0u32.into());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_injected_or_unbounded_coordination_tokens() {
        assert!(valid_token(&uuid::Uuid::new_v4().to_string()));
        for value in ["", "a\"\n[flags]\np2p_only=false", "abcdefghijklmnop/../../"] {
            assert!(!valid_token(value));
        }
        assert!(!valid_token(&"a".repeat(65)));
    }

    #[test]
    fn transient_status_query_failures_do_not_destroy_a_live_underlay() {
        let mut misses = 0;
        assert!(!path_loss_confirmed(&mut misses, false));
        assert!(!path_loss_confirmed(&mut misses, false));
        assert!(!path_loss_confirmed(&mut misses, true));
        assert_eq!(misses, 0);
        assert!(!path_loss_confirmed(&mut misses, false));
        assert!(!path_loss_confirmed(&mut misses, false));
        assert!(path_loss_confirmed(&mut misses, false));
    }

    #[tokio::test]
    async fn slow_offer_delivery_does_not_start_seed_handshake_early_or_lose_first_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let seed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = seed.local_addr().unwrap().port();
        let (mut reader, mut phone) = tokio::io::duplex(4096);
        let connect = tokio::spawn(async move { connect_seed_after_remote_data(&mut reader, port).await.unwrap() });
        assert!(tokio::time::timeout(Duration::from_millis(100), seed.accept()).await.is_err());
        phone.write_all(b"phone-handshake").await.unwrap();
        let (mut peer, _) = tokio::time::timeout(Duration::from_secs(2), seed.accept()).await.unwrap().unwrap();
        let mut received = [0; 15];
        peer.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"phone-handshake");
        drop(connect.await.unwrap());
    }

    #[tokio::test]
    async fn native_connector_retry_uses_fresh_stream_and_keeps_coordinator_alive() {
        use iroh::{endpoint::presets, Endpoint, EndpointAddr, RelayMode, TransportAddr};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let client = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
            .bind_addr((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap().bind().await.unwrap();
        let server = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled)
            .bind_addr((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap().alpns(vec![b"pp-retry-test".to_vec()]).bind().await.unwrap();
        let address = EndpointAddr::from_parts(server.id(), [TransportAddr::Ip(([127, 0, 0, 1], server.bound_sockets()[0].port()).into())]);
        let (phone, host) = tokio::join!(client.connect(address, b"pp-retry-test"), async { server.accept().await.unwrap().await });
        let (phone, host) = (phone.unwrap(), host.unwrap());
        let (mut phone_send, phone_recv) = phone.open_bi().await.unwrap();
        phone_send.write_all(b"x").await.unwrap();
        let (host_send, mut host_recv) = host.accept_bi().await.unwrap();
        host_recv.read_exact(&mut [0; 1]).await.unwrap();
        let seed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let seed_port = seed.local_addr().unwrap().port();
        let host_socket = TcpStream::connect(seed.local_addr().unwrap()).await.unwrap();
        let (mut seed_first, _) = seed.accept().await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = listener.local_addr().unwrap();
        let mut native_first = TcpStream::connect(local).await.unwrap();
        let (phone_socket, _) = listener.accept().await.unwrap();
        let offer = || Offer { magic: MAGIC.into(), network: "private-retry-network".into(), secret: "private-retry-secret".into(), port: 1234 };
        let host_task = tokio::spawn(async move {
            coordinate_host(host, host_send, host_recv, host_socket, seed_port, &offer(), 5678).await
        });
        let phone_task = tokio::spawn(async move {
            coordinate_phone(phone, phone_send, phone_recv, phone_socket, listener, &offer(), 5678).await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            native_first.write_all(b"old").await.unwrap();
            let mut old = [0; 3]; seed_first.read_exact(&mut old).await.unwrap();
            assert_eq!(&old, b"old");
            drop(native_first); // Native connector's first handshake timed out.
            let mut native_retry = TcpStream::connect(local).await.unwrap();
            native_retry.write_all(b"new-handshake").await.unwrap();
            let (mut seed_retry, _) = seed.accept().await.unwrap();
            let mut new = [0; 13]; seed_retry.read_exact(&mut new).await.unwrap();
            assert_eq!(&new, b"new-handshake", "新握手不能掺入旧流字节");
            seed_retry.write_all(b"reply").await.unwrap();
            let mut response = [0; 5]; native_retry.read_exact(&mut response).await.unwrap();
            assert_eq!(&response, b"reply");
            assert!(!host_task.is_finished() && !phone_task.is_finished());
        }).await.expect("首次 TCP 结束后必须自动重新接桥");
        host_task.abort(); phone_task.abort();
        let _ = tokio::join!(host_task, phone_task);
        client.close().await; server.close().await;
    }
}
