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

use super::engine::{apply_delta, compute_delta_in, ApplyReport};
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
    /// 本机懂分桶摘要（W2）。
    ///
    /// 🔴 这个能力位存在的原因：协议版本没跟着升（不想强迫两台机器同时升级）。
    /// 于是旧版对端会把它当 `false`（serde 默认值）。不看这一位就直接发摘要帧的话，
    /// 本机会写出一个旧版永远不会读的帧，然后自己卡在读一个永远不来的帧上——**挂死**。
    #[serde(default)]
    digest_capable: bool,
    /// 本机希望这一轮对一次摘要（心跳 / 从长睡里醒来的会话）。
    ///
    /// ❗ 只要**一边**想就交换。两边各自按自己的心跳节拍走，要求同时想的话
    /// 几乎永远对不上，摘要就埋成了死代码。
    #[serde(default)]
    want_digest: bool,
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
    /// 本机这边没搬出去的附件数（见 [`super::engine::ExportReport`]）。
    pub assets_skipped: usize,
    /// 这一轮发现对不上、因而整桶重对账的桶数（W2）。
    ///
    /// ❗ 非 0 不是错，是「发现了分叉并已经在修」。但它该能被看到：
    /// 如果每个心跳会话都报同一个桶分叉，那就是修不好——不报出来的话
    /// 那个「每轮重发、永不收敛」的状态从外面看不出来。
    pub diverged_buckets: usize,
    pub applied: ApplyReport,
}

/// 主动发起一次会话。`to` 从 [`super::presence`] 或邀请码里的地址来。
/// `want_digest` = 这一轮要不要对一次分桶摘要（W2）。只有心跳与从长睡里
/// 醒来的会话给 `true`；每次本地改动触发的会话都算一遍的话，
/// 会把刚做完的「脏了才拨」那个成本优势吃掉一部分。
pub async fn dial_session(
    store: &DataStore,
    ep: &Endpoint,
    peer: &str,
    to: EndpointAddr,
    want_digest: bool,
) -> Result<SessionReport, String> {
    let w = transport::dial(ep, to).await?;
    // ❗ 先克隆一份连接句柄：`run` 会把 `w` 吃掉，而失败之后才需要问它
    //   「对端是不是主动关的、理由是什么」（见 `explain`）。
    //   Connection 内部是 Arc，克隆很便宜。
    let conn = w.conn.clone();
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
    run(store, w, &got, true, want_digest)
        .await
        .map_err(|e| explain(&conn, e))
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
    // ❗ 接入侧自己不提要摘要（它没有自己的心跳节拍），但拨号方提了就配合。
    //   判据写在 `run` 里：`mine.want || theirs.want`。
    run(store, w, &peer, false, false).await
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
    let conn = w.conn.clone();
    // ❗ 接入侧同 `accept_session`：自己不提要摘要，拨号方提了就配合。
    run(store, w, peer, false, false)
        .await
        .map_err(|e| explain(&conn, e))
}

/// 拒一个入连接。理由写进关闭原因里，对端日志里看得到（规则 #15.3）。
///
/// ❗ 理由能不能真的被对端读到，靠的是 [`explain`]——看那里的说明。
pub fn reject(w: &Wire, why: &str) {
    w.conn.close(1u32.into(), why.as_bytes());
}

/// 会话失败时，把**对端主动关闭的理由**拼进错误里。
///
/// # 🔴 为什么必须走 `close_reason()`，而不是看错误字符串
///
/// quinn 的 `ReadError::ConnectionLost` 的 Display **写死成 `"connection lost"`**
/// （`quinn-0.11.11/src/recv_stream.rs:548`），它**不插值内层的 `ConnectionError`**。
/// 于是对端 `conn.close(1, b"not paired")` 的理由在读流错误里**完全看不到**：
/// 2026-09-06 实测日志里只有 `读帧长度失败：connection lost`。
///
/// 直接后果：上层那套靠字符串认「在忙 / 让位」的判据
/// （[`super::service::is_busy_reject`]）**一直没生效过**——一次正常碰撞会被
/// 当成故障、走退避阶梯。这个函数就是把理由补回去的地方。
///
/// 不去 match 那个枚举而直接用 Display：
/// `ConnectionError::ApplicationClosed` 的 Display 是 `"closed by peer: {reason} (code N)"`
/// （`quinn-proto-0.11.16/src/connection/mod.rs:3871`），reason 就在里面，
/// 而这样可以省掉一条 iroh 内部错误类型的引用路径。
fn explain(conn: &iroh::endpoint::Connection, err: String) -> String {
    match conn.close_reason() {
        // 还没关（本地逻辑错误、超时等）就原样往上报。
        None => err,
        Some(e) => format!("{}（{}）", err, e),
    }
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
    want_digest: bool,
) -> Result<SessionReport, String> {
    let mine = Hello {
        v: PROTO_V,
        cursor_ms: store.device_cursor(peer),
        high_water_ms: store.sync_high_water_ms(),
        digest_capable: true,
        want_digest,
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

    // 🔴 只有**吸收成功**时才能用对端的高水位。
    //
    // 模块说明第 3 条「此后本机发的戳都 > H」靠的就是那次吸收。
    // 被拒时本机下界根本没抬，再把游标推到对端那个虚高的值，后果是：
    // `hlc_now()` 发的戳永远小于游标 → `note_changed_since(> since)` 永远空
    // → **本机之后的所有改动都不再发给那台设备**，而游标又是 MAX 不可回退的。
    // 界面上只会提示「对方时钟快」，不会说「已经停止发送」——静默且永久。
    let high_water = if clock_too_far.is_some() {
        mine.high_water_ms
    } else {
        mine.high_water_ms.max(theirs.high_water_ms)
    };

    // W2：分桶摘要。两边拿的是同两份摘要，而分叉集是它们的纯函数，
    // 所以两边算出来的 `diverged` 必然一样，不用再多一个「请求重发」帧。
    // 为何不能只一边做（单向修复不收敛）写在 `digest` 模块里。
    let diverged: Vec<u32> = if mine.digest_capable
        && theirs.digest_capable
        && (mine.want_digest || theirs.want_digest)
    {
        exchange_digests(store, &mut w).await?
    } else {
        Vec::new()
    };
    if !diverged.is_empty() {
        log::info!(
            "[Sync] 与 {} 有 {} 个桶对不上，这一轮把它们整桶重对账：{:?}",
            &peer[..8.min(peer.len())],
            diverged.len(),
            diverged
        );
    }

    let out = scratch("out");
    let inbox = scratch("in");
    let r = exchange(store, &mut w, since, &out, &inbox, send_first, &diverged).await;
    let _ = std::fs::remove_dir_all(&out);
    // ❗ `inbox` 也要在每条退出路径上删掉：里面是**明文笔记**，
    //   而失败会按 5→60 秒退避反复重试，残留会一直堆在 %TEMP%。
    let x = match r {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&inbox);
            return Err(e);
        }
    };

    let applied = apply_delta(store, &inbox, since);
    let _ = std::fs::remove_dir_all(&inbox);
    let mut applied = applied?;
    // hello 阶段被拒的时钟也要出现在报告里：apply 那一步再吸收一次会被同样拒掉，
    // 但如果对端这一轮没发任何东西，apply 里就压根不会走到吸收，信息会丢。
    if applied.clock_too_far_ahead_ms.is_none() {
        applied.clock_too_far_ahead_ms = clock_too_far;
    }

    // 游标只在这一整轮都成功之后才推。中途失败就让它留在原地，下一轮重来。
    //
    // 🔴 「有东西没落地」不能当成全部完成：`missing_files`（清单说有、文件没到）
    // 与导入失败的那几篇，推过游标就**再也不会被重发**。
    //
    // ❗ 但也**不能干脆不推**。游标钉在低位 `C` 时，真冲突的判据
    // `local > C && incoming > C` 会让任何一篇「本地改过、对端还是旧版」的笔记
    // **每轮生一份冲突副本**——就是 `705d6af` 修掉的那个风暴，换个门进来。
    //
    // 所以夹到「最小未落地戳 − 1」：已落地的过游标（不再重发、不再参与冲突判定），
    // 没落地的下一轮重来。`device_advance_cursor` 是 MAX-only，
    // 所以即使夹出一个比现有游标小的值，也只是不动，不会回退。
    let cap = applied
        .unsettled_min_ms
        .map(|m| m.saturating_sub(1))
        .unwrap_or(i64::MAX);
    store.device_advance_cursor(peer, high_water.min(cap))?;
    if applied.missing_files > 0 || applied.import_failed > 0 {
        log::warn!(
            "[Sync] 与 {} 这一轮有 {} 篇没传到 / {} 篇导入失败，游标夹在 {}，下一轮重来",
            &peer[..8.min(peer.len())],
            applied.missing_files,
            applied.import_failed,
            high_water.min(cap)
        );
    }

    Ok(SessionReport {
        peer: peer.to_string(),
        since_ms: since,
        high_water_ms: high_water,
        sent_bytes: x.sent,
        recv_bytes: x.recv,
        assets_skipped: x.assets_skipped,
        diverged_buckets: diverged.len(),
        applied,
    })
}

/// 只给测试用：把一段 hello JSON 解成 `(digest_capable, want_digest)`。
///
/// 🔴 存在的理由是那两个 `#[serde(default)]`——它们默认为 `false`
/// 是与旧版对端不挂死的**唯一保障**，而 [`Hello`] 是私有的，测试摸不到。
#[cfg(test)]
pub fn hello_from_json_for_test(s: &str) -> Result<(bool, bool), String> {
    let h: Hello = serde_json::from_str(s).map_err(|e| e.to_string())?;
    Ok((h.digest_capable, h.want_digest))
}

/// 互报分桶摘要，返回**两边会算出完全相同结果**的分叉桶列表。
///
/// 🔴 这里只用两份摘要算（纯函数），不做任何本地取舍。一旦两边算出不同的
/// 分叉集，修复就变成单向的，而单向修复不收敛（理由在 `digest` 模块）。
///
/// ❗ 写完再读，与 hello 同一个形状（不看 `send_first`）：16 个 u64 的 JSON
/// 就几百字节，远不到把发送窗口填满，不会像目录传输那样双向卡死。
async fn exchange_digests(store: &DataStore, w: &mut Wire) -> Result<Vec<u32>, String> {
    let mine = store.sync_bucket_digests()?;
    let bytes = serde_json::to_vec(&mine).map_err(|e| format!("序列化摘要失败：{}", e))?;
    transport::write_frame(&mut w.send, &bytes).await?;
    let raw = transport::read_frame(&mut w.recv).await?;
    let theirs: Vec<u64> = serde_json::from_slice(&raw).map_err(|_| "对端的分桶摘要解不开")?;
    Ok(super::digest::diverged(&mine, &theirs))
}

/// [`exchange`] 的结果。用结构而不是三元组：三个裸数字排在一起谁是谁看不出来。
struct Exchanged {
    sent: u64,
    recv: u64,
    assets_skipped: usize,
}

/// 算增量、写出去、收回来。抽出来是为了让上面那层无论成败都能清掉暂存目录。
async fn exchange(
    store: &DataStore,
    w: &mut Wire,
    since: i64,
    out: &std::path::Path,
    inbox: &std::path::Path,
    send_first: bool,
    buckets: &[u32],
) -> Result<Exchanged, String> {
    let delta = compute_delta_in(store, since, buckets)?;
    let exported = super::engine::write_delta(store, &delta, out)?;

    if send_first {
        let sent = transport::write_dir(&mut w.send, out).await?;
        w.send.finish().map_err(|e| format!("收尾失败：{}", e))?;
        let recv = transport::read_dir(&mut w.recv, inbox).await?;
        // 我们读完了对端的，说明对端也早就读完了我们的，不必再等 `closed()`
        w.conn.close(0u32.into(), b"done");
        Ok(Exchanged {
            sent,
            recv,
            assets_skipped: exported.assets_skipped,
        })
    } else {
        let recv = transport::read_dir(&mut w.recv, inbox).await?;
        let sent = transport::write_dir(&mut w.send, out).await?;
        w.send.finish().map_err(|e| format!("收尾失败：{}", e))?;
        // 🔴 这一侧最后发，必须等对端确认收到才放手：`finish()` 只标记流结束，
        // 不等数据真正送到（探针 README ③）。直接返回会把还在飞的数据掐掉。
        w.conn.closed().await;
        Ok(Exchanged {
            sent,
            recv,
            assets_skipped: exported.assets_skipped,
        })
    }
}

/// 一个空的暂存目录。用项目里现成的写法，不引 `tempfile`。
fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pp_session_{}_{}", tag, uuid::Uuid::new_v4()));
    let _ = std::fs::create_dir_all(&d);
    d
}
