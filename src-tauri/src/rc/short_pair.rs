//! 双方各交换八位码后，借现有 iroh 地址发现会合；不维护短码查询表。
//! 只有两人都输入对方的码，才会派生本次临时端点并开始联网。

use iroh::{endpoint::presets, Endpoint, EndpointAddr, SecretKey};
use serde::{Deserialize, Serialize};

use crate::sync::identity::{self, NodeIdentity};
use crate::sync::transport::{accept_conn, read_frame, write_frame};

const ALPN: &[u8] = b"pastepanda-rc-short/1";

#[derive(Serialize, Deserialize)]
struct Hello {
    node_id: String,
    name: String,
    addr: EndpointAddr,
    signature: Vec<u8>,
}

pub fn valid_code(code: &str) -> bool {
    code.len() == 8 && code.bytes().all(|b| b.is_ascii_digit())
}

/// 两码的顺序与输入方无关；较小的码负责监听，较大的码负责拨号。
fn pair_secret(a: &str, b: &str) -> Result<SecretKey, String> {
    if !valid_code(a) || !valid_code(b) || a == b {
        return Err("请输入对方的八位配对码，不能使用自己的码".into());
    }
    let (low, high) = if a < b { (a, b) } else { (b, a) };
    let input = format!("pastepanda-rc-short-pair-v1:{low}:{high}");
    let digest = ring::digest::digest(&ring::digest::SHA256, input.as_bytes());
    let seed: [u8; 32] = digest.as_ref().try_into().map_err(|_| "生成临时身份失败")?;
    Ok(SecretKey::from_bytes(&seed))
}

/// 单枚 8 位码会合的域分离标签。
///
/// 🔴 **不能与两码版共用前缀**：同一枚码在两套里派生出同一个临时身份的话，
/// 「出示方/输入方」这层角色分离就被抹掉了——两个不同流程的用户会撞进同一条
/// 临时通道，而单码方案的全部安全假设都建立在「这条通道只有我们俩」上。
const DOMAIN_PIN_ONE: &str = "pastepanda-rc-pin-pair-one-v1";

/// 单枚 8 位码 + 角色 → 临时端点密钥（`exchange_pin` 用）。
///
/// 角色必须由**用户动作**决定（出示方监听、输入方拨号），不能由码决定：
/// 单码方案里两端手上是同一枚码，必须有个与码无关的东西把两边分开。
/// 代价是「谁监听谁拨号」不再像两码版那样按大小序自动判定，而是 UI 点下
/// 去的那一下就定了——所以调用方必须如实传 `listen`，传反了两端永远连不上。
pub fn pair_secret_pin(code: &str, listen: bool) -> Result<SecretKey, String> {
    if !valid_code(code) {
        return Err("配对码必须是 8 位数字".into());
    }
    let input = format!(
        "{DOMAIN_PIN_ONE}:{code}:{}",
        if listen { "listen" } else { "dial" }
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, input.as_bytes());
    let seed: [u8; 32] = digest
        .as_ref()
        .try_into()
        .map_err(|_| "生成临时身份失败")?;
    Ok(SecretKey::from_bytes(&seed))
}

fn signed_message(
    own: &str,
    peer: &str,
    id: &str,
    name: &str,
    addr: &EndpointAddr,
) -> Result<Vec<u8>, String> {
    let (low, high) = if own < peer { (own, peer) } else { (peer, own) };
    let mut message =
        format!("pastepanda-rc-short-hello-v1:{low}:{high}:{id}:{name}:").into_bytes();
    message.extend(serde_json::to_vec(addr).map_err(|e| format!("编码设备地址失败：{e}"))?);
    Ok(message)
}

fn my_hello(
    me: &NodeIdentity,
    own: &str,
    peer: &str,
    name: &str,
    addr: EndpointAddr,
) -> Result<Hello, String> {
    let node_id = me.node_id();
    if addr.id.to_string() != node_id {
        return Err("本机设备身份与远程端点不一致".into());
    }
    let name: String = name.trim().chars().take(60).collect();
    let signature = me.sign(&signed_message(own, peer, &node_id, &name, &addr)?)?;
    Ok(Hello {
        node_id,
        name,
        addr,
        signature,
    })
}

fn verify_hello(
    hello: Hello,
    own: &str,
    peer: &str,
) -> Result<(String, String, EndpointAddr), String> {
    if hello.addr.id.to_string() != hello.node_id {
        return Err("对方设备身份与地址不一致".into());
    }
    identity::verify(
        &hello.node_id,
        &signed_message(own, peer, &hello.node_id, &hello.name, &hello.addr)?,
        &hello.signature,
    )?;
    if hello.name.chars().count() > 60 {
        return Err("对方设备名过长".into());
    }
    Ok((
        hello.node_id,
        if hello.name.trim().is_empty() {
            "新设备".into()
        } else {
            hello.name
        },
        hello.addr,
    ))
}

async fn send_hello(send: &mut iroh::endpoint::SendStream, hello: &Hello) -> Result<(), String> {
    let bytes = serde_json::to_vec(hello).map_err(|e| format!("编码设备身份失败：{e}"))?;
    write_frame(send, &bytes).await
}

async fn receive_hello(
    recv: &mut iroh::endpoint::RecvStream,
    own: &str,
    peer: &str,
) -> Result<(String, String, EndpointAddr), String> {
    let bytes = read_frame(recv).await?;
    let hello: Hello = serde_json::from_slice(&bytes).map_err(|_| "对方设备身份格式无效")?;
    verify_hello(hello, own, peer)
}

/// 返回经临时会合通道交换的永久设备身份；信任仍由双方的 PairCheck 确认。
/// 起临时端点并等它连上公共中继。两码版与单码版的监听侧共用。
async fn bind_temp(secret: SecretKey) -> Result<Endpoint, String> {
    let temp = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| format!("启动临时配对通道失败：{e}"))?;
    tokio::time::timeout(std::time::Duration::from_secs(20), temp.online())
        .await
        .map_err(|_| "临时配对通道未能连接公共发现网络，请检查网络后重试".to_string())?;
    Ok(temp)
}

/// 上线 + 生成 Hello + 算截止时间。两条流程的前半段完全一样，收口在这里，
/// 免得「超时口径」「本机名截断」这类细节在两版之间悄悄分叉。
async fn prepare(
    endpoint: Endpoint,
    me: &NodeIdentity,
    own: &str,
    peer: &str,
    expires_at: i64,
) -> Result<(Endpoint, Hello, tokio::time::Instant), String> {
    tokio::time::timeout(std::time::Duration::from_secs(20), endpoint.online())
        .await
        .map_err(|_| "本机远程通道未能连接公共中继，请检查网络后重试".to_string())?;
    let hello = my_hello(
        me,
        own,
        peer,
        &crate::rc::local_device_name(),
        endpoint.addr(),
    )?;
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_millis(
            (expires_at - chrono::Utc::now().timestamp_millis()).max(1) as u64,
        );
    Ok((endpoint, hello, deadline))
}

/// 监听侧的全部握手。**两码版与单码版共用同一份**：这一半正是挡中间人的地方
/// （收到的公钥要等于连接对端、Hello 签名要验得过），分成两份必然有一边漏修。
async fn run_listener(
    temp: &Endpoint,
    own: &str,
    peer: &str,
    hello: &Hello,
    deadline: tokio::time::Instant,
) -> Result<(String, String, EndpointAddr), String> {
    tokio::time::timeout_at(deadline, async {
        let conn = accept_conn(temp).await?;
        let remote_id = conn.remote_id().to_string();
        let (mut send, mut recv) = conn
            .accept_bi()
            .await
            .map_err(|e| format!("配对开流失败：{e}"))?;
        let (node_id, name, addr) = receive_hello(&mut recv, own, peer).await?;
        if node_id != remote_id {
            return Err("对方设备身份与连接身份不一致".into());
        }
        send_hello(&mut send, hello).await?;
        let ack = read_frame(&mut recv).await?;
        if ack != b"ok" {
            return Err("对方未确认设备身份".into());
        }
        send.finish().map_err(|e| format!("配对收尾失败：{e}"))?;
        tokio::time::timeout(std::time::Duration::from_secs(8), send.stopped())
            .await
            .map_err(|_| "等待对方接收配对确认超时".to_string())?
            .map_err(|e| format!("对方未接收配对确认：{e}"))?;
        Ok((node_id, name, addr))
    })
    .await
    .map_err(|_| "等待对方确认超时，请重新交换配对码".to_string())?
}

/// 拨号侧的全部握手。`listener_pk` 是从码派生的临时公钥——拨号方据此算出
/// 对端地址，不需要任何查询表。
async fn run_dialer(
    endpoint: &Endpoint,
    listener_pk: iroh::PublicKey,
    own: &str,
    peer: &str,
    hello: &Hello,
    deadline: tokio::time::Instant,
) -> Result<(String, String, EndpointAddr), String> {
    // 两边都内置同一组 n0 中继地址；直接尝试这些路径，避免临时身份还没发布到
    // DNS/Pkarr 时只有 EndpointId 却没有可拨地址。
    let mut addr = EndpointAddr::new(listener_pk);
    for relay in iroh::defaults::prod::default_relay_map().urls::<Vec<_>>() {
        addr = addr.with_relay_url(relay);
    }
    let mut last_error = String::new();
    let conn = loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "等待对方确认超时，请重新交换配对码。最近一次连接：{last_error}"
            ));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(8), endpoint.connect(addr.clone(), ALPN))
            .await
        {
            Ok(Ok(conn)) => break conn,
            Ok(Err(error)) => last_error = error.to_string(),
            Err(_) => last_error = "连接超时".into(),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    };
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("配对开流失败：{e}"))?;
    send_hello(&mut send, hello).await?;
    let result = receive_hello(&mut recv, own, peer).await;
    if result.is_ok() {
        write_frame(&mut send, b"ok").await?;
        send.finish()
            .map_err(|e| format!("确认配对身份失败：{e}"))?;
        recv.read_to_end(0)
            .await
            .map_err(|e| format!("等待对方完成配对确认失败：{e}"))?;
    }
    result
}

pub async fn exchange(
    endpoint: Endpoint,
    me: &NodeIdentity,
    own: &str,
    peer: &str,
    expires_at: i64,
) -> Result<(String, String, EndpointAddr), String> {
    let secret = pair_secret(own, peer)?;
    let (endpoint, hello, deadline) = prepare(endpoint, me, own, peer, expires_at).await?;
    if own < peer {
        let temp = bind_temp(secret).await?;
        let result = run_listener(&temp, own, peer, &hello, deadline).await;
        temp.close().await;
        result
    } else {
        run_dialer(&endpoint, secret.public(), own, peer, &hello, deadline).await
    }
}

/// 单枚 8 位码会合（2026-09-29）。
///
/// 与 [`exchange`] 的区别只有两处：临时身份由**一枚码 + 角色**派生，以及
/// 「谁监听谁拨号」由 `listen` 显式指定而不是按码的大小序。其余的信任链
/// （永久身份签名、地址与身份一致性、生成方确认 + 指纹）完全共用同一份实现。
///
/// 🔴 **安全等级明示**：会合通道的认证强度 = 这一枚码的熵（8 位十进制 ≈ 27 bit），
/// 比两码版 ≈ 53 bit 低一倍，比 PP1 邀请码的 128 位身份低 101 倍。换来的是
/// 用户只记一个数。超出会合之后的一切（写白名单、连会话）都不受影响。
/// 改这里之前先读模块头与 `docs/` 里 RC 配对的说明，别把这条当细节。
pub async fn exchange_pin(
    endpoint: Endpoint,
    me: &NodeIdentity,
    code: &str,
    listen: bool,
    expires_at: i64,
) -> Result<(String, String, EndpointAddr), String> {
    let secret = pair_secret_pin(code, listen)?;
    // 两端签的都是 (code, code)：`signed_message` 内部按大小序归一，相等时两侧
    // 拼出逐字节相同的串，签名因此可验。
    let (endpoint, hello, deadline) = prepare(endpoint, me, code, code, expires_at).await?;
    if listen {
        let temp = bind_temp(secret).await?;
        let result = run_listener(&temp, code, code, &hello, deadline).await;
        temp.close().await;
        result
    } else {
        run_dialer(&endpoint, secret.public(), code, code, &hello, deadline).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sides_derive_one_temporary_identity() {
        let a = pair_secret("00123456", "98765432").unwrap();
        let b = pair_secret("98765432", "00123456").unwrap();
        assert_eq!(a.public(), b.public());
        assert_ne!(
            a.public(),
            pair_secret("00123457", "98765432").unwrap().public()
        );
        assert!(pair_secret("00123456", "00123456").is_err());
        assert!(!valid_code("1234567A"));
    }

    /// 单码版的角色分离：监听方与拨号方必须派生出**一对**能互相找到的临时身份。
    /// 这条红了说明两端算不到同一个地址——表现是拨号方永远连不上，而错误信息
    /// 只会是「等待对方确认超时」，在现场几乎无法定位。
    #[test]
    fn 单码版监听方与拨号方派生出一对可会合的身份() {
        let listen = pair_secret_pin("41820620", true).unwrap();
        let dial = pair_secret_pin("41820620", false).unwrap();
        // 两端用的是同一枚码，但角色不同 → 两个不同身份
        assert_ne!(listen.public(), dial.public());
        // 同一角色必须稳定（两端各算各的，结果要对上）
        assert_eq!(listen.public(), pair_secret_pin("41820620", true).unwrap().public());
        assert_eq!(dial.public(), pair_secret_pin("41820620", false).unwrap().public());
        // 另一位码不可能撞进这条通道
        assert_ne!(listen.public(), pair_secret_pin("41820621", true).unwrap().public());
        assert_ne!(dial.public(), pair_secret_pin("41820621", false).unwrap().public());
    }

    /// 🔴 域分离：同一枚码不能在两套流程里派生出同一个临时身份，否则
    /// 「出示方/输入方」这层角色分离被抹掉，两个不同流程的用户会撞进同一条通道。
    #[test]
    fn 单码版与两码版的派生域不重叠() {
        let pin = pair_secret_pin("41820620", true).unwrap().public();
        let two = pair_secret("00123456", "98765432").unwrap().public();
        assert_ne!(pin, two);
        // 单码版自己两个角色之间也不能相等（否则监听即拨号自己）
        assert_ne!(
            pair_secret_pin("41820620", true).unwrap().public(),
            pair_secret_pin("41820620", false).unwrap().public()
        );
    }

    #[test]
    fn 单码版拒绝非八位数字() {
        assert!(pair_secret_pin("4182062", true).is_err());
        assert!(pair_secret_pin("4182062A", false).is_err());
        assert!(pair_secret_pin("", true).is_err());
    }

    /// 手动验收用：走真正的 n0 中继，不能作为离线 CI 的默认门禁。
    #[tokio::test]
    #[ignore = "requires public n0 relay"]
    async fn two_endpoints_exchange_real_identities() {
        let root =
            std::env::temp_dir().join(format!("pastepanda-short-pair-{}", uuid::Uuid::new_v4()));
        let a_dir = root.join("a");
        let b_dir = root.join("b");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::create_dir_all(&b_dir).unwrap();
        let a = NodeIdentity::load_or_create(&a_dir).unwrap();
        let b = NodeIdentity::load_or_create(&b_dir).unwrap();
        let a_ep = Endpoint::builder(presets::N0)
            .secret_key(a.iroh_secret())
            .alpns(vec![b"rc/1".to_vec()])
            .bind()
            .await
            .unwrap();
        let b_ep = Endpoint::builder(presets::N0)
            .secret_key(b.iroh_secret())
            .alpns(vec![b"rc/1".to_vec()])
            .bind()
            .await
            .unwrap();
        let expires = chrono::Utc::now().timestamp_millis() + 35_000;
        let (from_a, from_b) = tokio::join!(
            exchange(a_ep.clone(), &a, "11111111", "22222222", expires),
            exchange(b_ep.clone(), &b, "22222222", "11111111", expires),
        );
        let (a_peer, _, b_addr) = from_a.unwrap();
        let (b_peer, _, _) = from_b.unwrap();
        assert_eq!(a_peer, b.node_id());
        assert_eq!(b_peer, a.node_id());
        let (dial, accept) = tokio::join!(a_ep.connect(b_addr, b"rc/1"), accept_conn(&b_ep));
        assert_eq!(dial.unwrap().remote_id().to_string(), b.node_id());
        assert_eq!(accept.unwrap().remote_id().to_string(), a.node_id());
        a_ep.close().await;
        b_ep.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
