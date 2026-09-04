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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
}

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
        let wait = match dial_once(&ctx, &peer).await {
            Outcome::Synced => {
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
        if !sleep_or_stop(&ctx.stop, wait).await {
            break;
        }
    }
    log::info!("[Sync] {} 的同步循环已停止", short);
}

/// 这个对端还应该有循环吗（「忘记此设备」之后就不应该了）。
fn has_peer(ctx: &SyncCtx, peer: &str) -> bool {
    ctx.peers.lock().map(|p| p.contains(peer)).unwrap_or(false)
}

enum Outcome {
    Synced,
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
            Outcome::Synced
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
        let w = tokio::select! {
            r = super::transport::accept(&ctx.endpoint) => match r {
                Ok(w) => w,
                Err(e) => {
                    log::warn!("[Sync] 接入连接失败：{}", e);
                    continue;
                }
            },
            _ = ctx.stop.notified() => break,
        };
        let ctx2 = ctx.clone();
        tokio::spawn(async move { serve(ctx2, w).await });
    }
    log::info!("[Sync] 入连接循环已停止");
}

async fn serve(ctx: Arc<SyncCtx>, w: super::transport::Wire) {
    let peer = w.conn.remote_id().to_string();
    let short = &peer[..8.min(peer.len())];
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
        });

        let paired_store = store.clone();
        super::presence::spawn(
            true,
            ctx.presence.clone(),
            me.clone(),
            port,
            Arc::new(move |id: &str| matches!(paired_store.device_get(id), Ok(Some(_)))),
            Arc::new(AtomicBool::new(false)),
        );

        tokio::spawn(accept_loop(ctx.clone()));
        let known = store.device_list()?;
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
            Outcome::Synced | Outcome::Busy(_) => Ok(()),
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
