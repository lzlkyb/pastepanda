//! 一次同步会话（M6）。把 [`super::engine`] 与 [`super::transport`] 串成一次往返。
//!
//! ```text
//! hello 交换游标与高水位 → 各自算增量 → 互发目录 → 各自应用 → 游标推到高水位
//! ```
//!
//! # 🔴 为什么 hello 里要带「高水位」
//!
//! 一开始我只打算带游标。追第二轮会发生什么的时候发现一个真问题——
//! **游标推到哪儿是这一层最容易写错、错了又最不容易发现的地方。**
//!
//! 游标只能推到「已经确定发过的最大时间戳」。如果推成本机这一批的最大值，
//! 那么对端那一批（戳可能更大）导入之后就落在游标**之外**，
//! 下一轮会被当成本机的新东西再发一遍回去。回声本身还只是浪费，
//! 但接收侧的冲突判据是
//!
//! ```text
//! both_changed = 本地 > 游标 && 对端 > 游标
//! ```
//!
//! 回声那一批**两个条件都满足**，于是每一篇都会生成一份「冲突副本」，
//! 而且每一轮再生成一次。第一轮看不出来，第二轮开始炸。
//!
//! 反过来，如果直接把游标推到两边的最大值，又有另一个坑：
//! 会话进行期间本机刚改的那一篇，戳可能小于对端的最大值 →
//! 一推游标就**永久跳过它**，那是静默丢数据，比刷冲突副本严重得多。
//!
//! 解法是让两件事发生在正确的顺序上：
//!
//! 1. hello 里各报自己的 HLC 下界（[`DataStore::sync_high_water_ms`]，≥ 库里任何戳）；
//! 2. **收到 hello 就立刻吸收对端的下界**——在算自己的增量之前；
//! 3. 于是此后本机发的任何戳都 **>** 这一轮的高水位 `H = max(两边下界)`；
//! 4. 所以「戳 ≤ H」的东西全在这一轮的增量里，把游标推到 `H` 不会跳过任何东西。
//!
//! 两边都推到同一个 `H`，下一轮 `since` 就是 `H`，回声也就没了。
//!
//! # 顺带修掉的一条
//!
//! 上面第 4 条只在会话**成功走完**时成立。中途断了、或者一边推了游标另一边没推，
//! 下一轮 `since = min(两边游标)` 会退回去，回声照样出现。
//! 所以 [`super::engine::apply_delta`] 里加了一条兜底：
//! **内容与本地一模一样就直接跳过**，不导入也不算冲突。
//!
//! # `since` 取 `min` 而不是自己的游标
//!
//! 两边游标本该一样，但会话中途失败时会分叉。取小的那个：**宁可多发**。
//! 多发是幂等的（后写胜 + 上面那条内容相同拦截），少发是丢数据。
//!
//! # 身份从连接来，不从 hello 来
//!
//! hello 里**没有** `node_id` 字段。对端身份取自 iroh 已经认证过的连接
//! （`conn.remote_id()`，QUIC/TLS 用 ed25519 握手过的那个），
//! 而不是让对端在报文里自称。同 [`super::presence`] 不带设备名的道理：
//! 少一个可自称的字段，就少一处要交叉核对的地方。

use super::engine::{apply_delta, compute_delta, ApplyReport};
use super::transport::{self, Wire};
use crate::data_store::DataStore;
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 会话协议版本。对不上就**连不下去**，不猜。
pub const PROTO_V: u32 = 1;

/// 开场帧。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Hello {
    v: u32,
    /// 本机与这台对端上次同步到哪儿。
    cursor_ms: i64,
    /// 本机的 HLC 下界。见模块说明。
    high_water_ms: i64,
}

/// 一次会话的结果。
#[derive(Debug, Default)]
pub struct SessionReport {
    /// 对端 `node_id`（取自已认证的连接）。
    pub peer: String,
    /// 这一轮两边都从哪个时间点往后算增量。
    pub since_ms: i64,
    /// 这一轮之后两边的游标。
    pub high_water_ms: i64,
    pub sent_bytes: u64,
    pub recv_bytes: u64,
    pub applied: ApplyReport,
}

/// 主动发起一次会话。`to` 从 [`super::presence`] 或邀请码里的地址来。
pub async fn dial_session(
    store: &DataStore,
    ep: &Endpoint,
    peer: &str,
    to: EndpointAddr,
) -> Result<SessionReport, String> {
    let w = transport::dial(ep, to).await?;
    let got = w.conn.remote_id().to_string();
    if got != peer {
        // iroh 是按 EndpointId 认证的，连错人理论上连不上；
        // 真出现就说明我们对「地址属于谁」的记账错了，必须报出来。
        return Err(format!(
            "连上的不是想连的那台（想连 {}，实际 {}）",
            &peer[..8.min(peer.len())],
            &got[..8.min(got.len())]
        ));
    }
    run(store, w, &got, true).await
}

/// 等一个对端连进来并把会话走完。`is_paired` 决定收不收。
pub async fn accept_session(
    store: &DataStore,
    ep: &Endpoint,
    is_paired: &dyn Fn(&str) -> bool,
) -> Result<SessionReport, String> {
    let w = transport::accept(ep).await?;
    let peer = w.conn.remote_id().to_string();
    if !is_paired(&peer) {
        // 只是没配对，不是攻击：ALPN 对得上说明对方也是 PastePanda。
        reject(&w, "not paired");
        return Err(format!(
            "{} 还没配对，已拒绝这次连接",
            &peer[..8.min(peer.len())]
        ));
    }
    run(store, w, &peer, false).await
}

/// 把一个**已经接下来**的连接跑成一次会话。
///
/// [`accept_session`] 把「accept + 判配对 + 跑」包成一体，而编排层需要在
/// accept 之后、跑之前插一下（拿会话槽、碰撞让位），所以拆出这一半。
pub async fn run_accepted(
    store: &DataStore,
    w: Wire,
    peer: &str,
) -> Result<SessionReport, String> {
    run(store, w, peer, false).await
}

/// 拒一个入连接。理由写进关闭原因里，对端日志里看得到（规则 #15.3）。
pub fn reject(w: &Wire, why: &str) {
    w.conn.close(1u32.into(), why.as_bytes());
}

/// 会话主体。两端**只差发收顺序**：谁先发由 `send_first` 决定。
///
/// 🔴 顺序不能两边都一样：都先发的话，两个方向的流控窗口会同时填满，
/// 谁都不读 → 死锁。所以拨号方先发、接受方先收。
async fn run(
    store: &DataStore,
    mut w: Wire,
    peer: &str,
    send_first: bool,
) -> Result<SessionReport, String> {
    let mine = Hello {
        v: PROTO_V,
        cursor_ms: store.device_cursor(peer),
        high_water_ms: store.sync_high_water_ms(),
    };
    let bytes = serde_json::to_vec(&mine).map_err(|e| format!("序列化 hello 失败：{}", e))?;
    transport::write_frame(&mut w.send, &bytes).await?;
    let raw = transport::read_frame(&mut w.recv).await?;
    let theirs: Hello =
        serde_json::from_slice(&raw).map_err(|_| "对端的 hello 解不开（版本不兼容？）")?;
    if theirs.v != PROTO_V {
        return Err(format!(
            "同步协议版本对不上（本机 {}，对端 {}）。请把两台机器都升到同一个版本。",
            PROTO_V, theirs.v
        ));
    }

    // 🔴 吸收对端时钟，**在算自己的增量之前**。模块说明第 2、3 条靠这一步成立。
    let mut clock_too_far = None;
    match store.absorb_remote_clock(theirs.high_water_ms) {
        crate::sync::hlc::Absorb::Ok => {}
        crate::sync::hlc::Absorb::TooFarAhead { ahead_ms } => {
            log::warn!(
                "[Sync] 对端时钟比本机快 {} 毫秒，拒绝吸收。本机之后无法覆盖那台机器的笔记——请检查两台机器的系统时间。",
                ahead_ms
            );
            clock_too_far = Some(ahead_ms);
        }
    }

    let since = mine.cursor_ms.min(theirs.cursor_ms);
    let high_water = mine.high_water_ms.max(theirs.high_water_ms);

    let out = scratch("out");
    let inbox = scratch("in");
    let r = exchange(store, &mut w, since, &out, &inbox, send_first).await;
    let _ = std::fs::remove_dir_all(&out);
    let (sent, recv) = r?;

    let mut applied = apply_delta(store, &inbox, since)?;
    let _ = std::fs::remove_dir_all(&inbox);
    // hello 阶段被拒的时钟也要出现在报告里：apply 那一步再吸收一次会被同样拒掉，
    // 但如果对端这一轮没发任何东西，apply 里就压根不会走到吸收，信息会丢。
    if applied.clock_too_far_ahead_ms.is_none() {
        applied.clock_too_far_ahead_ms = clock_too_far;
    }

    // 游标只在这一整轮都成功之后才推。中途失败就让它留在原地，下一轮重来。
    store.device_advance_cursor(peer, high_water)?;

    Ok(SessionReport {
        peer: peer.to_string(),
        since_ms: since,
        high_water_ms: high_water,
        sent_bytes: sent,
        recv_bytes: recv,
        applied,
    })
}

/// 算增量、写出去、收回来。抽出来是为了让上面那层无论成败都能清掉暂存目录。
async fn exchange(
    store: &DataStore,
    w: &mut Wire,
    since: i64,
    out: &std::path::Path,
    inbox: &std::path::Path,
    send_first: bool,
) -> Result<(u64, u64), String> {
    let delta = compute_delta(store, since)?;
    super::engine::write_delta(store, &delta, out)?;

    if send_first {
        let sent = transport::write_dir(&mut w.send, out).await?;
        w.send.finish().map_err(|e| format!("收尾失败：{}", e))?;
        let recv = transport::read_dir(&mut w.recv, inbox).await?;
        // 我们读完了对端的，说明对端也早就读完了我们的，不必再等 `closed()`
        w.conn.close(0u32.into(), b"done");
        Ok((sent, recv))
    } else {
        let recv = transport::read_dir(&mut w.recv, inbox).await?;
        let sent = transport::write_dir(&mut w.send, out).await?;
        w.send.finish().map_err(|e| format!("收尾失败：{}", e))?;
        // 🔴 这一侧最后发，必须等对端确认收到才放手：`finish()` 只标记流结束，
        // 不等数据真正送到（探针 README ③）。直接返回会把还在飞的数据掐掉。
        w.conn.closed().await;
        Ok((sent, recv))
    }
}

/// 一个空的暂存目录。用项目里现成的写法，不引 `tempfile`。
fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pp_session_{}_{}", tag, uuid::Uuid::new_v4()));
    let _ = std::fs::create_dir_all(&d);
    d
}
