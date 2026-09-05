//! 同步编排的**执行层**（M6）。把决策（[`super::coordinate`]）、会话
//! （[`super::session`]）、地址（[`super::presence`]）接成能自己跑的循环。
//!
//! # 三种循环
//!
//! | | 几条 | 干什么 |
//! |---|---|---|
//! | [`accept_loop`] | 1（端点级） | 收入连接，判是否收下，然后**交给独立任务**去跑 |
//! | [`peer_loop`] | 每个已配对设备 1 条 | 周期性主动拨那一台 |
//! | [`super::presence::spawn`] | 1 | 喊自己的地址、听别人的 |
//!
//! 这三条都由 [`SyncService`] 起与停 —— 它是前端唯一的入口。
//!
//! 多设备就是每对端一条独立状态机 —— 天然全网状，不需要额外的拓扑概念。
//!
//! # 🔴 accept 之后必须立刻交出去
//!
//! `accept_loop` 只做「接下来、开一个任务、马上回去接下一个」。
//! 要是在 accept 循环里把会话跑完，那么让位时的那点等待
//! （[`super::coordinate::YIELD_WAIT`]）会**卡住所有其它对端**的入连接。
//!
//! # 失败分两类，别混
//!
//! - **连不上**（对端没开机、地址过期、网络断）→ 走退避阶梯 5→10→30→60 秒
//! - **对端在忙 / 让位**（[`Admit::Reject`]）→ **不退避**，短延迟重试
//!
//! 混在一起的后果是：两台机器刚好同时拨了一次，之后就被退到 60 秒一次——
//! 而那本来只是一次正常碰撞。

use super::coordinate::{
    backoff_secs, jittered_secs, Admit, Coordinator, BUSY_RETRY_SECS, JITTER_SECS, PERIOD_SECS,
};
use super::presence::PresenceTable;
use super::session;
use crate::data_store::DataStore;
use iroh::{Endpoint, EndpointAddr};
use std::str::FromStr;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 最近一次会话的结果摘要（每个对端一份）。
///
/// 🔴 这些数字**后端本来就在算**（`ApplyReport`），之前只进日志。
/// 不给界面看的话，`skipped_older` / `conflicts` /
/// `clock_too_far_ahead_ms` 就是**纯粹的静默数据损失**（规则 #15.3）。
///
/// 不用 Tauri 事件推而是放在内存里等前端拉：面板本来就在 5 秒轮询，
/// 而一旦 `sync/` 里出现 `AppHandle`，lib test 二进制就启动即挂
/// （见 `DataStore` 的文档：`ProcessPrng` 那个坑）。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct LastSync {
    pub peer: String,
    /// 本机记录这一次结果的时刻（epoch 毫秒）。
    pub at_ms: i64,
    pub created: i64,
    pub updated: i64,
    pub deleted: usize,
    /// 后写胜里输掉的那一边的条数。它是那个静默丢弃的**唯一痕迹**。
    pub skipped_older: usize,
    pub conflicts: usize,
    pub missing_files: usize,
    /// 对端时钟超前太多。非 `None` 意味着本机之后赢不过那台机器。
    pub clock_too_far_ahead_ms: Option<i64>,
    /// 连续失败次数；0 = 上一次是成功的。
    pub fails: u32,
    /// 失败原因（`fails > 0` 时有）。
    pub error: Option<String>,
    /// 大约多久之后再试 / 再同步（秒）。界面上该显示这个而不是写死 30：
    /// 它含拖动（[`jittered_secs`]），写死了盯着表的人会觉得程序坏了。
    pub next_in_secs: u64,
}

/// 循环们共用的一份东西。
pub struct SyncCtx {
    pub store: DataStore,
    pub endpoint: Endpoint,
    pub presence: Arc<PresenceTable>,
    pub coord: Arc<Coordinator>,
    pub running: Arc<AtomicBool>,
    /// 关开关时把正在 sleep 的循环叫醒。见 [`sleep_or_stop`]。
    pub stop: Arc<tokio::sync::Notify>,
    /// 当前有循环的对端。拦重复起用（两条循环会白拨）。
    peers: std::sync::Mutex<std::collections::HashSet<String>>,
    /// 每个对端最近一次的结果。给界面看，见 [`LastSync`]。
    last: std::sync::Mutex<HashMap<String, LastSync>>,
    /// 🔴 地址宣告线程**自己的**停止标志，与 [`Self::running`] 分开。
    ///
    /// 不能共用一个：[`super::presence::spawn`] 进门要做
    /// `compare_exchange(false, true)` 防并发双线程，而 `running` 建出来就是
    /// `true`，共用的话那个 CAS 必然失败、宣告压根起不来。
    ///
    /// ❗ 但**必须由 `stop()` 一起清掉**。第一版这里传的是一个
    /// `Arc::new(AtomicBool::new(false))` 临时值、没人持有，后果有两层：
    /// ① `stop()` 之后宣告线程还在组播上喊本机地址；
    /// ② 关掉再打开时端口 5008 仍被那个僵尸线程占着，`bind_listener` 失败，
    ///    只留一条 warning 就退出——**地址发现静默死掉，而开关看着是开的**。
    presence_running: Arc<AtomicBool>,
}

/// 连上之后等对端开流的上限。见 [`serve`]：连上却不开流的对端
/// 不能无限期地占着一个任务。
pub const OPEN_STREAM_TIMEOUT: Duration = Duration::from_secs(10);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 把一个 `node_id` 加上已知地址拼成可拨的目标。
///
/// 地址来源按优先级：
/// 1. [`PresenceTable`] 里当前听得见的（局域网，最准——那是真能到达我们的源 IP）
/// 2. 什么都没有时给一个**只有 id 的**目标：交给 iroh 的 relay / 地址发现
///    （要联网，见 `transport` 模块文档）
fn target(ctx: &SyncCtx, peer: &str) -> Result<EndpointAddr, String> {
    let id = iroh::EndpointId::from_str(peer).map_err(|e| format!("node_id 解不开：{}", e))?;
    let mut addr = EndpointAddr::new(id);
    for sock in ctx.presence.addrs_of(peer, now_ms()) {
        addr = addr.with_ip_addr(sock);
    }
    Ok(addr)
}

/// 一个对端的循环：拨 → 成功就等一个带抖动的周期 → 失败就退避。
pub async fn peer_loop(ctx: Arc<SyncCtx>, peer: String) {
    let short = &peer[..8.min(peer.len())];
    let mut fails: u32 = 0;
    while ctx.running.load(Ordering::SeqCst) && has_peer(&ctx, &peer) {
        let outcome = dial_once(&ctx, &peer).await;
        let wait = match &outcome {
            Outcome::Synced(_) => {
                fails = 0;
                jittered_secs(PERIOD_SECS, JITTER_SECS, now_ms() as u64)
            }
            Outcome::Busy(why) => {
                // 不是故障，不动退避计数
                log::debug!("[Sync] {} 这次没轮到我们：{}", short, why);
                BUSY_RETRY_SECS
            }
            Outcome::Failed(why) => {
                fails += 1;
                let w = backoff_secs(fails);
                log::warn!(
                    "[Sync] 与 {} 同步失败（连续第 {} 次），{} 秒后重试：{}",
                    short,
                    fails,
                    w,
                    why
                );
                let _ = ctx.store.device_mark_offline(&peer);
                w
            }
        };
        record(&ctx, &peer, outcome, fails, wait);
        if !sleep_or_stop(&ctx.stop, wait).await {
            break;
        }
    }
    log::info!("[Sync] {} 的同步循环已停止", short);
}

/// 把一次会话的结果记下来给界面看。
///
/// ❗「对端在忙」**不覆盖**上一次的结果：那既不是成功也不是失败，
/// 覆盖掉的话界面上刚才那次成功的统计会被一条「在忙」冲没。
fn record(ctx: &SyncCtx, peer: &str, outcome: Outcome, fails: u32, next_in_secs: u64) {
    let mut m = match ctx.last.lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    match outcome {
        Outcome::Busy(_) => {
            if let Some(e) = m.get_mut(peer) {
                e.next_in_secs = next_in_secs;
            }
        }
        Outcome::Synced(r) => {
            m.insert(
                peer.to_string(),
                LastSync {
                    peer: peer.to_string(),
                    at_ms: now_ms(),
                    created: r.applied.created,
                    updated: r.applied.updated,
                    deleted: r.applied.deleted,
                    skipped_older: r.applied.skipped_older,
                    conflicts: r.applied.conflicts,
                    missing_files: r.applied.missing_files,
                    clock_too_far_ahead_ms: r.applied.clock_too_far_ahead_ms,
                    fails: 0,
                    error: None,
                    next_in_secs,
                },
            );
        }
        Outcome::Failed(why) => {
            let e = m.entry(peer.to_string()).or_default();
            e.peer = peer.to_string();
            e.at_ms = now_ms();
            e.fails = fails;
            e.error = Some(why);
            e.next_in_secs = next_in_secs;
        }
    }
}

/// 这个对端还应该有循环吗（「忘记此设备」之后就不应该了）。
fn has_peer(ctx: &SyncCtx, peer: &str) -> bool {
    ctx.peers.lock().map(|p| p.contains(peer)).unwrap_or(false)
}

enum Outcome {
    Synced(Box<session::SessionReport>),
    /// 对端拒了（在忙 / 保留了它自己那个会话）。
    Busy(String),
    Failed(String),
}

async fn dial_once(ctx: &SyncCtx, peer: &str) -> Outcome {
    // 本机也要先拿槽：不然本机的两条路径（周期拨号与刚收到的入连接）
    // 会同时对同一个库跑 apply。
    let Some(_hold) = ctx.coord.try_hold(peer) else {
        return Outcome::Busy("本机已有一个到它的会话在跑".into());
    };
    let to = match target(ctx, peer) {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    match session::dial_session(&ctx.store, &ctx.endpoint, peer, to).await {
        Ok(r) => {
            let transport = if ctx.presence.addrs_of(peer, now_ms()).is_empty() {
                "wan"
            } else {
                "lan"
            };
            let _ = ctx.store.device_mark_online(peer, transport, now_ms());
            log::info!(
                "[Sync] 与 {} 同步完成：收 {} 篇 / 更新 {} 篇 / 删 {} 篇 / 冲突 {} 处 / {} 字节",
                &peer[..8.min(peer.len())],
                r.applied.created,
                r.applied.updated,
                r.applied.deleted,
                r.applied.conflicts,
                r.recv_bytes
            );
            Outcome::Synced(Box::new(r))
        }
        // 对端按 §6.8 保留了它自己那个会话 —— 它会把两边的东西都搬完，
        // 所以这里什么都不用做，短延迟之后再看一眼就行。
        Err(e) if is_busy_reject(&e) => Outcome::Busy(e),
        Err(e) => Outcome::Failed(e),
    }
}

/// 对端的关闭原因里带这些字样就是「在忙」，不是故障。
///
/// ❗ 靠字符串认，是因为 iroh 的应用层关闭原因就是一串字节，
/// 而给「忙」单独定一个错误码要动线格式。这里的字样与
/// [`super::coordinate::Coordinator::admit`] 给出的理由一一对应，改一处要改两处。
fn is_busy_reject(err: &str) -> bool {
    err.contains("正在向你发起同步") || err.contains("让位") || err.contains("稍后重试")
}

/// 收入连接的循环。只接、然后立刻交给独立任务。
pub async fn accept_loop(ctx: Arc<SyncCtx>) {
    while ctx.running.load(Ordering::SeqCst) {
        // 🔴 必须与停止信号一起 select：`accept` 是一直等着的，
        // 光看 `running` 的话开关关掉之后这个循环会永远卡在这儿。
        let conn = tokio::select! {
            r = super::transport::accept_conn(&ctx.endpoint) => match r {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[Sync] 接入连接失败：{}", e);
                    continue;
                }
            },
            _ = ctx.stop.notified() => break,
        };
        // 🔴 只接到握手为止，**开流也要交给独立任务**：ALPN 是公开的，
        // 没配对的人也连得上，只要它连上之后不开双向流，`accept_bi` 就一直挂着，
        // 堵死的是**所有其它设备**的入连接。
        let ctx2 = ctx.clone();
        tokio::spawn(async move { serve(ctx2, conn).await });
    }
    log::info!("[Sync] 入连接循环已停止");
}

async fn serve(ctx: Arc<SyncCtx>, conn: iroh::endpoint::Connection) {
    let peer = conn.remote_id().to_string();
    let short = &peer[..8.min(peer.len())];

    // 连上却迟迟不开流的，等一小会儿就放掉——它占的只是这一个任务，不再堵别人
    let w = match tokio::time::timeout(
        OPEN_STREAM_TIMEOUT,
        super::transport::accept_streams(conn),
    )
    .await
    {
        Ok(Ok(w)) => w,
        Ok(Err(e)) => {
            log::warn!("[Sync] {} 开流失败：{}", short, e);
            return;
        }
        Err(_) => {
            log::warn!(
                "[Sync] {} 连上之后 {} 秒没开流，已放弃",
                short,
                OPEN_STREAM_TIMEOUT.as_secs()
            );
            return;
        }
    };
    let paired = matches!(ctx.store.device_get(&peer), Ok(Some(_)));

    let hold = match ctx.coord.admit(&peer, paired).await {
        Admit::Ok(h) => h,
        Admit::NotPaired => {
            // 只是没配对，不是攻击：ALPN 对得上说明对方也是 PastePanda
            session::reject(&w, "not paired");
            log::info!("[Sync] {} 还没配对，已拒绝", short);
            return;
        }
        Admit::Reject(why) => {
            session::reject(&w, &why);
            log::debug!("[Sync] 拒了 {} 这次入连接：{}", short, why);
            return;
        }
    };
    debug_assert_eq!(hold.peer(), peer);

    match session::run_accepted(&ctx.store, w, &peer).await {
        Ok(r) => {
            let _ = ctx.store.device_mark_online(&peer, "lan", now_ms());
            log::info!(
                "[Sync] {} 发起的同步完成：收 {} 篇 / 更新 {} 篇 / 冲突 {} 处",
                short,
                r.applied.created,
                r.applied.updated,
                r.applied.conflicts
            );
        }
        Err(e) => log::warn!("[Sync] {} 发起的同步失败：{}", short, e),
    }
}

/// 睡一会儿，但**开关一关就立刻醒**。返回 `false` = 该退出了。
///
/// 🔴 不能直接 `sleep(secs)`：退避到顶是 60 秒，用户关掉开关却要等最多一分钟
/// 才真的停下来——界面上就是「明明关了还在同步」。
///
/// 参数收的是 `&Notify` 而不是 `&SyncCtx`，纯粹为了能单测：
/// 不然测这一条就得先绑一个 iroh 端点。
pub async fn sleep_or_stop(stop: &tokio::sync::Notify, secs: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => true,
        _ = stop.notified() => false,
    }
}

/// 前端拿到的那个把手。放进 `tauri::State`。
///
/// # 为什么需要它
///
/// 上一版只有一个 `spawn(enabled, ctx)` 自由函数，于是有两个洞：
///
/// 🔴 **① 开关关不掉。** `running` 那个 `AtomicBool` 建在调用处，
/// 之后**没有任何地方持有它**——用户把开关拨回去，循环照跑。
///
/// 🔴 **② 新配对的设备要重启才生效。** `spawn` 是启动时读一次 `device_list`、
/// 每台起一条循环。配对之后那台**不会有循环**。
/// 这在配对界面上是致命的：用户配完，界面上什么都不动，看起来就是坏的。
///
/// 两个洞都是「画界面时才发现」的——后端自测跑得通，是因为测试里从来没有
/// 「先起服务、再配对」这个顺序。
#[derive(Default)]
pub struct SyncService {
    inner: tokio::sync::Mutex<Option<Arc<SyncCtx>>>,
}

impl SyncService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 起。已经在跑就什么都不做（幂等，前端可以放心重复调）。
    ///
    /// 🔴 开关判断在**函数里面**，同 [`super::presence::spawn`]：
    /// 调用方拿不到「绕过开关」的写法。关着时留一行日志说明原因（规则 #15.3）。
    pub async fn start(
        &self,
        store: DataStore,
        app_dir: &std::path::Path,
        enabled: bool,
        relay: bool,
    ) -> Result<(), String> {
        if !enabled {
            log::info!(
                "[Sync] 知识库同步开关（{}）是关的，不启动同步",
                super::presence::ENABLE_KEY
            );
            return Ok(());
        }
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let me = Arc::new(super::identity::NodeIdentity::load_or_create(app_dir)?);
        let endpoint = super::transport::bind(&me, relay).await?;

        // ❗ 只取端口，**不取 IP**：`bound_sockets()` 给的是通配 `0.0.0.0`，
        //   拨它必然超时（探针阶段栽过）。IP 由对端从我们的源地址取，
        //   见 `presence` 模块说明②。
        let port = endpoint
            .bound_sockets()
            .first()
            .map(|s| s.port())
            .ok_or("端点没有绑到任何端口")?;

        let ctx = Arc::new(SyncCtx {
            store: store.clone(),
            endpoint,
            presence: Arc::new(PresenceTable::new()),
            coord: Arc::new(Coordinator::new(me.node_id())),
            running: Arc::new(AtomicBool::new(true)),
            stop: Arc::new(tokio::sync::Notify::new()),
            peers: std::sync::Mutex::new(std::collections::HashSet::new()),
            last: std::sync::Mutex::new(HashMap::new()),
            // false：让 presence 自己那个 CAS 能成功，见字段注释
            presence_running: Arc::new(AtomicBool::new(false)),
        });

        // ❗ 先把可能失败的读库做完，再起任何后台任务。
        // 反过来的话：这里 `?` 提前返回 → `*guard = Some(ctx)` 没执行 →
        // 但两个后台任务各自握着 `Arc<SyncCtx>` 继续跑，`stop()` 再也摸不到它们，
        // 端口 5008 与 iroh 端点被无主线程占着——又一条僵尸路径。
        let known = store.device_list()?;

        let paired_store = store.clone();
        super::presence::spawn(
            true,
            ctx.presence.clone(),
            me.clone(),
            port,
            Arc::new(move |id: &str| matches!(paired_store.device_get(id), Ok(Some(_)))),
            ctx.presence_running.clone(),
        );

        tokio::spawn(accept_loop(ctx.clone()));
        for d in &known {
            start_peer(&ctx, &d.node_id);
        }
        log::info!(
            "[Sync] 同步已启动，端点端口 {}，已配对设备 {} 台",
            port,
            known.len()
        );
        *guard = Some(ctx);
        Ok(())
    }

    /// 停。循环会**立刻**醒（不等满退避），端点随之关闭。
    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(ctx) = guard.take() {
            ctx.running.store(false, Ordering::SeqCst);
            // ❗ 宣告线程是独立标志，漏了它就会留一个占着端口 5008 的僵尸
            ctx.presence_running.store(false, Ordering::SeqCst);
            ctx.stop.notify_waiters();
            ctx.endpoint.close().await;
            log::info!("[Sync] 同步已停止");
        }
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// 为一台**刚配对**的设备补一条循环。
    ///
    /// 🔴 配对成功之后必须调这个，否则那台设备要等下次启动才会被同步——
    /// 而用户刚配完正盯着界面看。
    ///
    /// 幂等：重复配同一台不会起两条循环（两条循环会白拨，虽然会话槽挡得住）。
    pub async fn add_peer(&self, node_id: &str) -> Result<(), String> {
        let guard = self.inner.lock().await;
        let Some(ctx) = guard.as_ref() else {
            // 开关关着时配对是允许的，只是现在不起循环；开开关时会从 device_list 读到
            return Ok(());
        };
        start_peer(ctx, node_id);
        Ok(())
    }

    /// 不再为某台设备跑循环（「忘记此设备」时调）。
    pub async fn drop_peer(&self, node_id: &str) {
        let guard = self.inner.lock().await;
        if let Some(ctx) = guard.as_ref() {
            if let Ok(mut p) = ctx.peers.lock() {
                p.remove(node_id);
            }
            // ❗ 地址也要清：不清会留一条永不刷新也永不被覆盖的僵尸地址
            ctx.presence.forget(node_id);
        }
    }

    /// 给测试用：拿到当前那份地址宣告停止标志。
    ///
    /// 存在的理由很具体——「`stop()` 有没有把宣告线程也关掉」这件事
    /// 从外面完全看不出来（`stop()` 之后 `ctx` 就被 take 走了），
    /// 而它第一版恰恰就是漏的。
    #[cfg(test)]
    pub async fn presence_flag(&self) -> Option<Arc<AtomicBool>> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|c| c.presence_running.clone())
    }

    /// 当前组播里听得见的对端。没在跑就是空——而不是报错：
    /// 界面上「开关关着」与「一台都不在线」本来就该长得一样。
    pub async fn live_peers(&self) -> Vec<String> {
        let guard = self.inner.lock().await;
        match guard.as_ref() {
            Some(c) => c.presence.live(now_ms()),
            None => Vec::new(),
        }
    }

    /// 每个对端最近一次的结果。没在跑就是空。
    pub async fn last_syncs(&self) -> Vec<LastSync> {
        let guard = self.inner.lock().await;
        let Some(c) = guard.as_ref() else {
            return Vec::new();
        };
        let mut v: Vec<LastSync> = match c.last.lock() {
            Ok(m) => m.values().cloned().collect(),
            Err(p) => p.into_inner().values().cloned().collect(),
        };
        // 取负值而不是 `sort_by(b.cmp(a))`：同效，且 clippy 不反对
        v.sort_by_key(|x| -x.at_ms);
        v
    }

    /// 当前有几条对端循环。给测试与界面用。
    pub async fn peer_count(&self) -> usize {
        let guard = self.inner.lock().await;
        guard
            .as_ref()
            .and_then(|c| c.peers.lock().ok().map(|p| p.len()))
            .unwrap_or(0)
    }

    /// 立刻跟某台同步一次（界面上那个「立即同步」）。
    pub async fn sync_now(&self, node_id: &str) -> Result<(), String> {
        let ctx = {
            let guard = self.inner.lock().await;
            guard.as_ref().cloned().ok_or("知识库同步没有在运行")?
        };
        match dial_once(&ctx, node_id).await {
            // 「对端在忙」不是失败：它那边正在把两边的东西都搬完
            Outcome::Synced(_) | Outcome::Busy(_) => Ok(()),
            Outcome::Failed(why) => Err(why),
        }
    }
}

/// 起一条对端循环，已有就不重复起。
fn start_peer(ctx: &Arc<SyncCtx>, node_id: &str) {
    match ctx.peers.lock() {
        Ok(mut p) => {
            if !p.insert(node_id.to_string()) {
                return;
            }
        }
        Err(_) => return,
    }
    tokio::spawn(peer_loop(ctx.clone(), node_id.to_string()));
}
