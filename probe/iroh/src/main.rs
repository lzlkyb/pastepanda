//! M6 传输层探针（2026-09-04）。**独立工程，不进 pastePanda 的依赖树。**
//!
//! 教训来自 M3：那次探针只扫了静态库符号就标 PASS，实际没跑过一次推理。
//! 所以这里**真的建两个节点、真的连一次、真的收发一个字节**。
//!
//! # 验的是什么
//!
//! 「完全离线的局域网里 iroh 能不能连上」。
//!
//! 关键是**怎么模拟离线**——不能去拔用户的网线。做法是把所有依赖外网的东西
//! 全部显式关掉：
//!
//! | 关掉 | 为什么它会联网 |
//! |---|---|
//! | `RelayMode::Disabled` | 转发服务器在 n0 那边 |
//! | `clear_address_lookup()` | 🔴 **这条最容易漏**：iroh 1.1 的三个地址发现服务（`PkarrPublisher` / `PkarrResolver` / `DnsAddressLookup`）**全都走 n0 的 DNS**。iroh 1.1 **没有内置 mDNS / 局域网发现**。所以「关了 relay」≠「不联网」 |
//!
//! 两个都关掉之后，对端地址只能由我们自己给——而那正是邀请码里
//! `addrs` 字段的用途。这个探针同时验证了那个字段是必需的，不是可选的。

use anyhow::{Context, Result};
use std::net::SocketAddr;
use iroh::{
    endpoint::{presets, RelayMode},
    Endpoint, EndpointAddr, SecretKey,
};

const ALPN: &[u8] = b"pastepanda-sync/0";

/// 造一个「假装没网」的端点。
async fn offline_endpoint(seed: [u8; 32]) -> Result<Endpoint> {
    Endpoint::builder(presets::Minimal)
        // 用固定种子而不是 generate()：这正是 P1 存的那 32 字节，
        // 顺带验证「我们的身份能直接喂给 iroh」这个假设。
        .secret_key(SecretKey::from_bytes(&seed))
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .clear_address_lookup()
        .bind()
        .await
        .context("绑定端点失败")
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("== M6 传输层探针 · iroh 1.1.0 ==\n");

    let listener = offline_endpoint([7u8; 32]).await?;
    let dialer = offline_endpoint([9u8; 32]).await?;

    let target_id = listener.id();
    let socks = listener.bound_sockets();
    println!("接受端 id   = {}", target_id);
    println!("接受端 socket = {:?}", socks);
    println!("拨号端 id   = {}\n", dialer.id());

    // 只给 IP 地址，不给 relay url、不靠任何发现服务。
    //
    // 🔴 `bound_sockets()` 返回的是**通配地址**（`0.0.0.0` / `[::]`），
    //    往通配地址拨号必然超时——第一版就这么写的，失败信息看起来像
    //    「iroh 连不上」，实际是探针自己的 bug。换成回环再连。
    let mut addr = EndpointAddr::new(target_id);
    for s in &socks {
        let dialable = match s.ip() {
            std::net::IpAddr::V4(v4) if v4.is_unspecified() => {
                SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, s.port()))
            }
            std::net::IpAddr::V6(v6) if v6.is_unspecified() => {
                SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, s.port()))
            }
            _ => *s,
        };
        addr = addr.with_ip_addr(dialable);
    }
    println!("拨号用地址 = {:?}
", addr.ip_addrs().collect::<Vec<_>>());
    anyhow::ensure!(!addr.is_empty(), "拿不到本机 socket，探针无法继续");

    // 接受侧
    //
    // 🔴 **必须 clone 而不是 move**：`Endpoint` 一 drop 就关连接，
    //    而 `send.finish()` 只标记流结束、**不等数据真正发出去**。
    //    第一版把 listener move 进 task，task 一返回端点就没了，
    //    于是拨号端读回声时拿到「connection lost / timed out」——
    //    看起来像 iroh 的问题，实际是探针自己把端点提前关了。
    let listener_for_task = listener.clone();
    let accept_task = tokio::spawn(async move {
        let listener = listener_for_task;
        let incoming = listener.accept().await.context("没有连接进来")?;
        let conn = incoming.await.context("握手失败")?;
        let (mut send, mut recv) = conn.accept_bi().await.context("开流失败")?;
        let mut buf = [0u8; 5];
        recv.read_exact(&mut buf).await.context("读失败")?;
        send.write_all(&buf).await.context("回写失败")?;
        send.finish().context("收尾失败")?;
        // 🔴 `finish()` 只标记流结束，**不等对端收到**。这里必须等对端主动关连接，
        //    否则接受侧一返回就 drop 掉自己那份 Connection，拨号端读到
        //    「closed by peer」。debug 版靠时序侥幸能过、release 版直接暴露——
        //    这类关闭时序 bug 只在优化后才现形，所以 release 也必须跑一遍。
        conn.closed().await;
        Ok::<_, anyhow::Error>(String::from_utf8_lossy(&buf).to_string())
    });

    // 拨号侧
    let conn = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        dialer.connect(addr, ALPN),
    )
    .await
    .context("🔴 连接超时 —— 离线局域网直连不成立")?
    .context("🔴 连接失败 —— 离线局域网直连不成立")?;

    let (mut send, mut recv) = conn.open_bi().await.context("开流失败")?;
    send.write_all(b"hello").await?;
    send.finish()?;

    let mut back = [0u8; 5];
    recv.read_exact(&mut back).await.context("回声读失败")?;
    // 读完了再关：这一步是接受侧 `conn.closed()` 的唤醒信号。
    conn.close(0u32.into(), b"done");
    let got = accept_task.await??;
    // 端点在这之后才允许 drop（见上面 clone 的注释）。
    drop(listener);
    println!("接受端收到：{}", got);
    println!("拨号端回声：{}", String::from_utf8_lossy(&back));

    println!("\n✅ 离线直连成立：relay 关闭 + 地址发现全关，仅凭 IP:port 连通并收发成功。");
    println!("   → 结论：局域网不依赖 n0 的任何服务，但**地址必须我们自己提供**");
    println!("     （邀请码的 addrs 字段是必需的，iroh 1.1 不带 mDNS）。");
    Ok(())
}
