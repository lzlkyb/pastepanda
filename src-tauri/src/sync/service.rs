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
    pub store: Arc<DataStore>,
    pub endpoint: Endpoint,
    pub presence: Arc<PresenceTable>,
    pub coord: Arc<Coordinator>,
    pub running: Arc<AtomicBool>,
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
    while ctx.running.load(Ordering::SeqCst) {
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
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
    log::info!("[Sync] {} 的同步循环已停止", short);
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
        let w = match super::transport::accept(&ctx.endpoint).await {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[Sync] 接入连接失败：{}", e);
                continue;
            }
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

/// 起全套循环。
///
/// 🔴 开关判断在**函数里面**，和 [`super::presence::spawn`] 一样：
/// 调用方拿不到「绕过开关」的写法。关着时留一行日志说明原因（规则 #15.3）。
pub fn spawn(enabled: bool, ctx: Arc<SyncCtx>) {
    if !enabled {
        log::info!(
            "[Sync] 知识库同步开关（{}）是关的，不启动同步循环",
            super::presence::ENABLE_KEY
        );
        return;
    }
    if ctx
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let peers = match ctx.store.device_list() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[Sync] 读已配对设备失败，同步没起来：{}", e);
            ctx.running.store(false, Ordering::SeqCst);
            return;
        }
    };
    log::info!("[Sync] 同步循环启动，已配对设备 {} 台", peers.len());
    tokio::spawn(accept_loop(ctx.clone()));
    for d in peers {
        tokio::spawn(peer_loop(ctx.clone(), d.node_id));
    }
}
