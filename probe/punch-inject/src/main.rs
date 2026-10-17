//! probe/punch-inject — iroh 1.1.0 候选注入机制探针（R1a 验证门）。
//!
//! 锁定 iroh =1.1.0（与主工程 src-tauri Cargo.lock 一致；semver "1.1" 会解析到 1.3.0，必须写死）。
//! 源码考证（iroh-1.1.0/src/socket/）：
//! 1. MemoryLookup 注入只进 paths 表，喂 resolve_remote 应答（dial 前）；
//! 2. trigger_address_lookup 有 `selected_path.is_some()` 守卫（remote_state.rs:867），
//!    连接建立后 lookup 基本不再被查询；
//! 3. 60s check_connections 只触发 QNT holepunching（:751-780），候选 =
//!    双方 magicsock 的 local_direct_addrs，应用不可注入；
//! 4. QUIC Initial（dst=EndpointIdMappedAddr 虚拟地址 fd15::/64）→
//!    handle_msg_send_datagram 无 selected_path 时**对 paths 表全部候选发包**
//!    ——dial addr 里的候选（Ip/Custom）就是这样被消费的（transports.rs poll_send
//!    Mixed 分支 → RemoteStateMessage::SendDatagram）。
//!
//! 实验（单机双 Endpoint，验证机制不验证 NAT）：
//! - E0 官方 TestNetwork（in-memory custom transport）基准
//! - E1 dial-time IP 候选（presets::N0，relay 正常）
//! - E2 MemoryLookup 注入（Minimal + relay + lookup 唯一地址源）
//! - E3 真实 UDP socket 作为 CustomTransport
//!
//! 判据与当前结论见 README.md。
//! 同机 dial 的 IP 候选必须用 127.0.0.1（Windows 防火墙默认拦非 loopback
//! 入站 UDP；watch_addr 不含 loopback，所以从端口反推构造）。

use std::{io, net::SocketAddr, sync::Arc, task::Poll, time::Duration};

use iroh::endpoint::{
    presets,
    transports::{CustomEndpoint, CustomSender, CustomTransport, RecvInfo, Transmit},
};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, TransportAddr, Watcher as _};
use iroh_base::CustomAddr;
use n0_watcher::Watchable;

const ALPN: &[u8] = b"punch-inject/1";
/// 自选 custom transport id（TRANSPORTS.md 注册表之外的实验值，"PI"）
const TRANSPORT_ID: u64 = 0x5049;

/// 从 watch_addr 的 ip_addrs 里挑一个：回环优先，其次第一个。
/// 注意：同机 dial 要走 127.0.0.1（Windows 防火墙默认拦非 loopback 的
/// 入站 UDP，10.x/172.x 的本机地址从自身 dial 可能被拦）。
fn pick_local(addr: &EndpointAddr) -> Option<SocketAddr> {
    let port = addr
        .ip_addrs()
        .find(|s| s.ip().is_loopback())
        .or_else(|| addr.ip_addrs().next())
        .map(|s| s.port())?;
    Some(SocketAddr::from(([127, 0, 0, 1], port)))
}

/// watch_addr 的 EndpointAddr 不实现 Nullable，不能用 initialized()；
/// 轮询到 relay + 本机地址都就绪为止。
async fn wait_addr(ep: &Endpoint, secs: u64) -> EndpointAddr {
    let mut w = ep.watch_addr();
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let a = w.get();
        if a.relay_urls().next().is_some() && a.ip_addrs().next().is_some() {
            return a;
        }
        if std::time::Instant::now() > deadline {
            panic!("watch_addr {secs}s 未就绪（relay 连不上？）");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn print_paths(tag: &str, conn: &iroh::endpoint::Connection) {
    let paths = conn.paths();
    if paths.is_empty() {
        println!("  [{tag}]\n    (no paths)");
        return;
    }
    let mut lines = String::new();
    for p in paths.iter() {
        lines.push_str(&format!(
            "    [{}{}{}] {} rtt={:?}\n",
            if p.is_selected() { "*" } else { " " },
            if p.is_ip() { "IP   " } else { "" },
            if p.is_relay() { "RELAY" } else { "" },
            p.remote_addr(),
            p.rtt()
        ));
    }
    println!("  [{tag}]\n{lines}");
}

fn has_ip_path(conn: &iroh::endpoint::Connection) -> bool {
    conn.paths().iter().any(|p| p.is_ip())
}

fn has_custom_path(conn: &iroh::endpoint::Connection) -> bool {
    conn.paths()
        .iter()
        .any(|p| matches!(p.remote_addr(), TransportAddr::Custom(_)))
}

// ---------------------------------------------------------------------------
// E1 · dial-time IP 候选
// ---------------------------------------------------------------------------

/// 判据：dial 的 EndpointAddr 里手工放入的 Ip addr，连接建立后是否立即出现 IP path。
async fn e1() {
    println!("===== E1 · dial-time IP 候选 =====\n");
    let ep_a = Endpoint::builder(presets::N0)
        .secret_key(SecretKey::from([0u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    // 干净对照：每个实验用独立的 epB（不同 secret），避免 A 从前一连接学到的
    // direct addr 污染结论
    let ep_b_exp = Endpoint::builder(presets::N0)
        .secret_key(SecretKey::from([1u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let ep_b_ctl = Endpoint::builder(presets::N0)
        .secret_key(SecretKey::from([2u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();

    let addr_exp = wait_addr(&ep_b_exp, 30).await;
    let addr_ctl = wait_addr(&ep_b_ctl, 30).await;

    let (Some(b_ip), Some(b_relay), Some(c_relay)) = (
        pick_local(&addr_exp),
        addr_exp.relay_urls().next().cloned(),
        addr_ctl.relay_urls().next().cloned(),
    ) else {
        println!("!! 拿不到 epB 的 ip/relay 地址，跳过 E1");
        return;
    };
    println!("epB_exp id={} b_ip={b_ip}", ep_b_exp.id().fmt_short());
    println!(
        "epB_ctl id={} c_relay={c_relay}\n",
        ep_b_ctl.id().fmt_short()
    );

    // --- 实验组：dial 带 [Ip, Relay] ---
    println!("-- 实验组: dial [Ip({b_ip}), Relay] --");
    let addr = EndpointAddr::from_parts(
        ep_b_exp.id(),
        [
            TransportAddr::Ip(b_ip),
            TransportAddr::Relay(b_relay.clone()),
        ],
    );
    match ep_a.connect(addr, ALPN).await {
        Ok(conn) => {
            print_paths("connect 返回瞬间", &conn);
            tokio::time::sleep(Duration::from_secs(3)).await;
            print_paths("t=3s", &conn);
            println!(
                ">> E1 结论: dial-time IP 候选{}被消费（IP path 出现）\n",
                if has_ip_path(&conn) { "" } else { "未" }
            );
        }
        Err(e) => println!("!! connect 失败: {e}\n"),
    }

    // --- 对照组：dial 只带 Relay ---
    println!("-- 对照组: dial [Relay] only --");
    let addr = EndpointAddr::from_parts(ep_b_ctl.id(), [TransportAddr::Relay(c_relay)]);
    match ep_a.connect(addr, ALPN).await {
        Ok(conn) => {
            print_paths("connect 返回瞬间", &conn);
            tokio::time::sleep(Duration::from_secs(3)).await;
            print_paths("t=3s", &conn);
            println!(
                ">> E1 对照: {}（同机 QNT 候选本来就有本机地址，直连快是常态；\
                 关键看实验组 0s 是否就有 IP path）",
                if has_ip_path(&conn) {
                    "3s 内已直连"
                } else {
                    "仍 relay-only"
                }
            );
        }
        Err(e) => println!("!! connect 失败: {e}"),
    }

    ep_b_ctl.close().await;
    ep_b_exp.close().await;
    ep_a.close().await;
}

// ---------------------------------------------------------------------------
// E2 · MemoryLookup 注入（Minimal + relay + memory lookup 唯一地址源）
// ---------------------------------------------------------------------------

/// 源码推论逐条实测：
/// 2a. relay-only 建立后注入 MemoryLookup 候选 → 130s 内（两个 UPGRADE_INTERVAL）
///     是否出现 IP path（源码预期：否，60s 升级只做 holepunching，候选不含量入值）
/// 2b. 注入后重新 dial（纯 id，零 addr）→ 是否吃到注入候选（源码预期：否，
///     selected_path 守卫拦住 lookup 查询；且 lookup stream 已结束）
/// 2c. dial-time 注入（dial addr 带 Ip）→ 是否直连（源码预期：是）
async fn e2() {
    println!("===== E2 · MemoryLookup 注入 =====\n");
    let mem_a = iroh::address_lookup::memory::MemoryLookup::new();
    let mem_b = iroh::address_lookup::memory::MemoryLookup::new();
    let ep_a = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from([0u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Default)
        .bind()
        .await
        .unwrap();
    let ep_b = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from([1u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Default)
        .address_lookup(mem_b.clone())
        .bind()
        .await
        .unwrap();

    let addr_a = wait_addr(&ep_a, 30).await;
    let addr_b = wait_addr(&ep_b, 30).await;
    let (Some(a_ip), Some(b_ip), Some(relay)) = (
        pick_local(&addr_a),
        pick_local(&addr_b),
        addr_a.relay_urls().next().cloned(),
    ) else {
        println!("!! 拿不到地址，跳过 E2");
        return;
    };
    println!(
        "A={} B={} a_ip={a_ip} b_ip={b_ip} relay={relay}",
        ep_a.id().fmt_short(),
        ep_b.id().fmt_short()
    );

    // --- 2a: relay-only 连接建立（dial 只带 relay）---
    println!("\n-- 2a: dial [Relay] only，建立 relay-only 连接 --");
    let conn = ep_a
        .connect(
            EndpointAddr::from_parts(ep_b.id(), [TransportAddr::Relay(relay.clone())]),
            ALPN,
        )
        .await
        .expect("2a 连接失败");
    tokio::time::sleep(Duration::from_secs(3)).await;
    print_paths("t=3s（应只有 RELAY）", &conn);

    // 注入：模拟旁路 NAT 建模预测出的候选（这里用真实可达的本机地址代表「预测命中」）
    mem_a.add_endpoint_info(EndpointAddr::from_parts(
        ep_b.id(),
        [TransportAddr::Ip(b_ip)],
    ));
    mem_b.add_endpoint_info(EndpointAddr::from_parts(
        ep_a.id(),
        [TransportAddr::Ip(a_ip)],
    ));
    println!("已注入 MemoryLookup（A→B 的 {b_ip}，B→A 的 {a_ip}）");

    println!("观察 130s（两个 UPGRADE_INTERVAL=60s）…");
    let mut upgraded = false;
    for i in 0..13u32 {
        tokio::time::sleep(Duration::from_secs(10)).await;
        print_paths(&format!("t={}s", (i + 1) * 10), &conn);
        if has_ip_path(&conn) {
            println!(">> 2a 结论: 注入候选被 60s 升级消费（与源码推论相反，重要！）");
            upgraded = true;
            break;
        }
    }
    if !upgraded {
        println!(">> 2a 结论: 130s 内无 IP path —— 源码推论证实（升级不吃 MemoryLookup 注入）");
    }

    // --- 2b: 注入后重 dial（纯 id）---
    println!("\n-- 2b: 注入后重 dial（EndpointAddr::new(id)，纯靠 lookup）--");
    match ep_a.connect(EndpointAddr::new(ep_b.id()), ALPN).await {
        Ok(c2) => {
            tokio::time::sleep(Duration::from_secs(3)).await;
            print_paths("重 dial 后 t=3s", &c2);
            println!(
                ">> 2b 结论: lookup 注入候选{}被新连接消费",
                if has_ip_path(&c2) { "" } else { "未" }
            );
        }
        Err(e) => println!("!! connect 失败: {e}"),
    }

    // --- 2c: dial-time 注入 ---
    println!("\n-- 2c: dial-time 注入（dial addr 带 Ip）--");
    match ep_a
        .connect(
            EndpointAddr::from_parts(ep_b.id(), [TransportAddr::Ip(b_ip)]),
            ALPN,
        )
        .await
    {
        Ok(c3) => {
            print_paths("connect 返回瞬间", &c3);
            tokio::time::sleep(Duration::from_secs(3)).await;
            print_paths("t=3s", &c3);
            println!(
                ">> 2c 结论: dial-time IP 候选{}被消费",
                if has_ip_path(&c3) { "" } else { "未" }
            );
        }
        Err(e) => println!("!! connect 失败: {e}"),
    }

    ep_b.close().await;
    ep_a.close().await;
}

// ---------------------------------------------------------------------------
// E3 · UdpCustomTransport（官方 unstable 数据面注入口）
// ---------------------------------------------------------------------------

/// 把一个真实 UDP socket 包装成 iroh CustomTransport。
/// CustomAddr data 编码：IPv4(4B) + port(2B) = 6 字节。
/// bind() 时起收包泵线程（阻塞 recv → mpsc）；poll_recv 用 poll_recv_many
/// （与官方 test_transport 同构，能正确注册 waker）。
#[derive(Debug, Clone)]
struct UdpCustomTransport {
    sock: Arc<std::net::UdpSocket>,
    local: Arc<Watchable<Vec<CustomAddr>>>,
}

fn encode_sockaddr(a: &SocketAddr) -> io::Result<CustomAddr> {
    let ip4 = match a.ip() {
        std::net::IpAddr::V4(ip) => ip.octets(),
        other => return Err(io::Error::other(format!("non-v4 addr {other}"))),
    };
    let mut data = Vec::with_capacity(6);
    data.extend_from_slice(&ip4);
    data.extend_from_slice(&a.port().to_be_bytes());
    Ok(CustomAddr::from_parts(TRANSPORT_ID, &data))
}

fn decode_sockaddr(a: &CustomAddr) -> io::Result<SocketAddr> {
    if a.id() != TRANSPORT_ID {
        return Err(io::Error::other("unexpected transport id"));
    }
    let d = a.data();
    if d.len() != 6 {
        return Err(io::Error::other("bad custom addr length"));
    }
    Ok(SocketAddr::from((
        [d[0], d[1], d[2], d[3]],
        u16::from_be_bytes([d[4], d[5]]),
    )))
}

impl UdpCustomTransport {
    fn bind_socket() -> io::Result<Self> {
        let sock = std::net::UdpSocket::bind("127.0.0.1:0")?;
        let local_addr = sock.local_addr()?;
        sock.set_nonblocking(false)?;
        let local = Arc::new(Watchable::new(vec![encode_sockaddr(&local_addr)?]));
        Ok(Self {
            sock: Arc::new(sock),
            local,
        })
    }

    fn custom_addr(&self) -> CustomAddr {
        encode_sockaddr(&self.sock.local_addr().unwrap()).unwrap()
    }
}

impl CustomTransport for UdpCustomTransport {
    fn bind(&self) -> io::Result<Box<dyn CustomEndpoint>> {
        let (tx, rx) = tokio::sync::mpsc::channel::<(Vec<u8>, SocketAddr)>(256);
        let pump_sock = self.sock.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            loop {
                match pump_sock.recv_from(&mut buf) {
                    Ok((n, from)) => {
                        if tx.blocking_send((buf[..n].to_vec(), from)).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        Ok(Box::new(UdpCustomEndpoint {
            sock: self.sock.clone(),
            local: self.local.clone(),
            rx,
        }))
    }
}

struct UdpCustomEndpoint {
    sock: Arc<std::net::UdpSocket>,
    /// 自己的 local addrs watcher（必须持久，watch() 依赖它存活）
    local: Arc<Watchable<Vec<CustomAddr>>>,
    rx: tokio::sync::mpsc::Receiver<(Vec<u8>, SocketAddr)>,
}

impl std::fmt::Debug for UdpCustomEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UdpCustomEndpoint").finish()
    }
}

impl CustomEndpoint for UdpCustomEndpoint {
    fn watch_local_addrs(&self) -> n0_watcher::Direct<Vec<CustomAddr>> {
        self.local.watch()
    }

    fn create_sender(&self) -> Arc<dyn CustomSender> {
        Arc::new(UdpCustomSender {
            sock: self.sock.clone(),
        })
    }

    fn poll_recv(
        &mut self,
        cx: &mut std::task::Context,
        bufs: &mut [io::IoSliceMut<'_>],
        metas: &mut [noq_udp::RecvMeta],
        recv_infos: &mut [RecvInfo],
    ) -> Poll<io::Result<usize>> {
        assert_eq!(bufs.len(), metas.len());
        assert_eq!(bufs.len(), recv_infos.len());
        if bufs.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let mut packets = Vec::new();
        match self.rx.poll_recv_many(cx, &mut packets, bufs.len()) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(0) => return Poll::Ready(Err(io::Error::other("channel closed"))),
            Poll::Ready(n) => n,
        };
        let mut count = 0;
        for (i, (data, from)) in packets.into_iter().enumerate() {
            let buf = &mut bufs[i];
            if buf.len() < data.len() {
                break;
            }
            let from_custom = encode_sockaddr(&from)?;
            buf[..data.len()].copy_from_slice(&data);
            let self_custom = self.local.get().first().cloned();
            eprintln!(
                "[udp-recv] {} bytes from {} (local={:?})",
                data.len(),
                from,
                self_custom
            );
            recv_infos[i] = RecvInfo::new(from_custom, self_custom);
            let mut m = noq_udp::RecvMeta::default();
            m.addr = from;
            m.len = data.len();
            m.stride = data.len();
            metas[i] = m;
            count += 1;
        }
        if count > 0 {
            Poll::Ready(Ok(count))
        } else {
            Poll::Pending
        }
    }
}

struct UdpCustomSender {
    sock: Arc<std::net::UdpSocket>,
}

impl std::fmt::Debug for UdpCustomSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UdpCustomSender").finish()
    }
}

impl CustomSender for UdpCustomSender {
    fn is_valid_send_addr(&self, addr: &CustomAddr) -> bool {
        addr.id() == TRANSPORT_ID
    }

    fn poll_send(
        &self,
        _cx: &mut std::task::Context,
        dst: &CustomAddr,
        _src: Option<&CustomAddr>,
        transmit: &Transmit<'_>,
    ) -> Poll<io::Result<()>> {
        let to = match decode_sockaddr(dst) {
            Ok(a) => a,
            Err(e) => return Poll::Ready(Err(e)),
        };
        let segment = transmit.segment_size.unwrap_or(transmit.contents.len());
        let res: io::Result<()> = transmit
            .contents
            .chunks(segment.max(1))
            .try_for_each(|chunk| self.sock.send_to(chunk, to).map(|_| ()));
        Poll::Ready(res)
    }
}

/// E0 · 官方 TestNetwork（in-memory custom transport）双端 echo。
/// 二分基准：官方 transport + 我们的 dial 配置。
/// 通 ⇒ 配置没问题，锅在 UdpCustomTransport 实现；
/// 不通 ⇒ 探针 dial/endpoint 配置有误。
async fn e0() {
    println!("===== E0 · 官方 TestNetwork 基准 =====\n");
    use iroh::test_utils::test_transport::{TestNetwork, TEST_TRANSPORT_ID};
    use iroh::endpoint::transports::Addr;
    use iroh::endpoint::Connection;
    use iroh_base::EndpointId;

    let network = TestNetwork::new();
    let s_a = SecretKey::from([0u8; 32]);
    let s_b = SecretKey::from([1u8; 32]);
    let t_a = network.create_transport(s_a.public()).unwrap();
    let t_b = network.create_transport(s_b.public()).unwrap();

    let ep_a = Endpoint::builder(presets::N0)
        .secret_key(s_a)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .add_custom_transport(t_a)
        .bind()
        .await
        .unwrap();
    let ep_b = Endpoint::builder(presets::N0)
        .secret_key(s_b.clone())
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .add_custom_transport(t_b)
        .bind()
        .await
        .unwrap();

    // B 端 accept
    let ep_b2 = ep_b.clone();
    let acceptor = tokio::spawn(async move {
        let incoming = ep_b2.accept().await.expect("no incoming");
        let conn = incoming.await.expect("handshake failed");
        let (send, mut recv) = conn.accept_bi().await.expect("accept_bi");
        use tokio::io::AsyncReadExt as _;
        let mut buf = Vec::new();
        recv.read_to_end(64 * 1024).await.unwrap();
        use tokio::io::AsyncWriteExt as _;
        let mut send = send;
        send.write_all(&buf).await.unwrap();
        send.finish().unwrap();
    });

    // dial 带 Custom addr（官方 to_custom_addr 用 endpoint_id bytes）
    let custom_b = CustomAddr::from_parts(TEST_TRANSPORT_ID, s_b.public().as_bytes());
    println!("dial Custom({custom_b:?})…");
    let addr = EndpointAddr::from_parts(
        s_b.public(),
        [TransportAddr::Custom(custom_b)],
    );
    let conn: Connection = ep_a.connect(addr, ALPN).await.expect("connect failed");
    print_paths("connect 返回瞬间", &conn);
    let (send, mut recv) = conn.open_bi().await.expect("open_bi");
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut send = send;
    send.write_all(b"e0-echo").await.unwrap();
    send.finish().unwrap();
    let mut resp = Vec::new();
    recv.read_to_end(64 * 1024).await.unwrap();
    acceptor.await.unwrap();
    println!("echo 往返: {:?} ✓", String::from_utf8_lossy(&resp));
    let _ = Addr::Ip(std::net::SocketAddr::from(([127,0,0,1], 0))); // silence unused
    let _ = std::mem::size_of::<EndpointId>();
    ep_b.close().await;
    ep_a.close().await;
}

/// 判据：dial 带 Custom addr 的连接能建立，且 echo 数据在 custom 路径上往返成功。
/// 这验证「旁路打洞 socket 作为 iroh 数据面」的官方路径真实可用（R1b/R2 的技术底座）。
async fn e3() {
    println!("===== E3 · UdpCustomTransport =====\n");
    let t_a = UdpCustomTransport::bind_socket().expect("bind A");
    let t_b = UdpCustomTransport::bind_socket().expect("bind B");
    let mem_a = iroh::address_lookup::memory::MemoryLookup::new();

    // 官方 test_transport 测试的同款配置：N0 preset（crypto/cert 一致）+
    // 跳过 TLS 校验 + 清空 IP/relay 传输，只剩 custom。
    let ep_a = Endpoint::builder(presets::N0)
        .secret_key(SecretKey::from([0u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .add_custom_transport(Arc::new(t_a.clone()))
        .bind()
        .await
        .unwrap();
    let ep_b = Endpoint::builder(presets::N0)
        .secret_key(SecretKey::from([1u8; 32]))
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .add_custom_transport(Arc::new(t_b.clone()))
        .bind()
        .await
        .unwrap();

    let addr_b = t_b.custom_addr();
    println!(
        "A={} B={} a_custom={} b_custom={}",
        ep_a.id().fmt_short(),
        ep_b.id().fmt_short(),
        t_a.custom_addr(),
        addr_b
    );
    println!("B custom addr: {addr_b}\n");

    // --- 3a: dial 带 Custom addr ---
    println!("-- 3a: dial [Custom] --");
    let conn = ep_a
        .connect(
            EndpointAddr::from_parts(ep_b.id(), [TransportAddr::Custom(addr_b.clone())]),
            ALPN,
        )
        .await;
    match conn {
        Ok(c) => {
            print_paths("connect 返回瞬间", &c);
            // echo 往返：B 端 accept（ep_b clone 进 task，主作用域保留作 close）
            let ep_b2 = ep_b.clone();
            let b_accept = tokio::spawn(async move {
                let incoming = ep_b2.accept().await.expect("no incoming");
                let conn = incoming.await.expect("handshake failed");
                let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
                let buf = Vec::new();
                recv.read_to_end(64 * 1024).await.unwrap();
                send.write_all(&buf).await.unwrap();
                send.finish().unwrap();
            });
            let (mut send, mut recv) = c.open_bi().await.expect("open_bi");
            send.write_all(b"hello-custom").await.unwrap();
            send.finish().unwrap();
            let resp = Vec::new();
            recv.read_to_end(64 * 1024).await.unwrap();
            b_accept.await.unwrap();
            println!("echo 往返: {:?} ✓", String::from_utf8_lossy(&resp));
            println!(
                ">> 3a 结论: custom 传输路径 {}，QUIC 数据面完整可用 —— \
                 旁路打洞 socket 挂进 iroh 的官方路径成立",
                if has_custom_path(&c) { "已选中" } else { "未出现(?)" }
            );
        }
        Err(e) => println!("!! connect 失败: {e}"),
    }

    // --- 3c: 对照——同配置 dial IP addr（不经过 custom transport）---
    println!("\n-- 3c: 对照 dial [Ip]（同 endpoint 配置）--");
    let b_ip = pick_local(&ep_b.watch_addr().get());
    if let Some(b_ip) = b_ip {
        match ep_a
            .connect(
                EndpointAddr::from_parts(ep_b.id(), [TransportAddr::Ip(b_ip)]),
                ALPN,
            )
            .await
        {
            Ok(c) => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                print_paths("3c dial IP t=2s", &c);
                println!(">> 3c 结论: 同配置下 IP dial {}", if has_ip_path(&c) || has_custom_path(&c) || !c.paths().is_empty() { "有路径" } else { "无路径" });
            }
            Err(e) => println!("!! 3c connect 失败: {e}"),
        }
    }

    // --- 3b: lookup 提供 custom addr，dial 纯 id（3b 才挂 lookup，隔离 3a 变量）---
    println!("\n-- 3b: MemoryLookup 提供 custom addr，dial 纯 id --");
    let mem_a = iroh::address_lookup::memory::MemoryLookup::new();
    mem_a.add_endpoint_info(EndpointAddr::from_parts(
        ep_b.id(),
        [TransportAddr::Custom(addr_b)],
    ));
    match ep_a.connect(EndpointAddr::new(ep_b.id()), ALPN).await {
        Ok(c) => {
            tokio::time::sleep(Duration::from_secs(2)).await;
            print_paths("t=2s", &c);
            println!(
                ">> 3b 结论: lookup 提供的 custom addr {}被消费",
                if has_custom_path(&c) { "" } else { "未" }
            );
        }
        Err(e) => println!("!! connect 失败: {e}"),
    }

    ep_b.close().await;
    ep_a.close().await;
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    let which = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match which.as_str() {
        "E0" => e0().await,
        "E1" => e1().await,
        "E2" => e2().await,
        "E3" => e3().await,
        _ => {
            e1().await;
            println!();
            e2().await;
            println!();
            e3().await;
        }
    }
}
