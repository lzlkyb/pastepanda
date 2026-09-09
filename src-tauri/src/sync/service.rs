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
    backoff_secs, jittered_secs, Admit, Coordinator, HoldErr, BUSY_RETRY_SECS,
    DORMANT_AFTER_FAILS, DORMANT_POLL_SECS, HEARTBEAT_SECS, IDLE_CHECK_SECS, JITTER_SECS,
    MIN_SESSION_GAP_SECS, WRITE_COALESCE_MAX_SECS, WRITE_COALESCE_SECS,
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
    /// 单篇导入失败的条数。与 `missing_files` 同等对待——
    /// 只进日志的话，界面照旧显示「同步完成」，那正是本字段要挡的事。
    pub import_failed: usize,
    /// 对端时钟超前太多。非 `None` 意味着本机之后赢不过那台机器。
    pub clock_too_far_ahead_ms: Option<i64>,
    /// 这一轮新落盘的附件数（W1）。只是个正向信息，给面板一个属实的东西可显。
    pub assets_landed: usize,
    /// 这一轮整桶重对账的桶数（W2）。非 0 = 发现了分叉并已经在修。
    ///
    /// ❗ 要能看到它，否则「每个心跳都报同一个桶分叉」这种修不好的状态
    /// 从外面完全看不出来。渲染在 `KbSyncStatusBar`（info 调）。
    pub diverged_buckets: usize,
    /// 🔴 本机这边**没搬出去**的附件数（源图被清过 / 超过上限）。
    ///
    /// 与 `missing_files` 同类，但方向相反：它是**发送侧**才知道的事。
    /// 对端只会看到一张断图且无从分辨，所以必须在这边显示。
    pub assets_skipped: usize,
    /// 连续失败次数；0 = 上一次是成功的。
    pub fails: u32,
    /// 失败原因（`fails > 0` 时有）。
    pub error: Option<String>,
    /// 大约多久之后再试 / 再同步（秒）。界面上该显示这个而不是写死 30：
    /// 它含拖动（[`jittered_secs`]），写死了盯着表的人会觉得程序坏了。
    pub next_in_secs: u64,
    /// 上一次**真的同步成功**的时间；0 = 从来没成功过。
    ///
    /// 🔴 不能用 [`Self::at_ms`] 代替：那一个**失败时也在刷**（它是「上次尝试」）。
    /// 一台机器 10:00 同步成功、12:00 开始连不上，那个 10:00 就被盖没了——
    /// 于是界面无法区分「对方一直没开机」与「上午还好好的现在坏了」，
    /// 而这两件事对用户的意义完全不同。
    pub last_ok_ms: i64,
    /// 已进休眠（连续失败够多，不再定时拨）。
    ///
    /// ❗ 由循环里已经算好的 [`Wait`] 直接得出，**不让前端拿
    /// `fails >= DORMANT_AFTER_FAILS` 再推一遍**——那就是两处口径，
    /// 阀值一改界面就静默地说错话。
    pub dormant: bool,
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
    /// 把**休眠中**的对端循环叫醒（见 [`sleep_or_wake`]）。
    ///
    /// 两个叫醒源：① 组播里听到了某台已配对设备的公告；② 用户点了「立即同步」
    /// （或新配上一台）。
    ///
    /// 🔴 **只对长睡生效**。源 ① 是每份公告都发（间隔 15 秒，不是「刚回来」事件），
    /// 所以 [`peer_loop`] 里只有 `dormant` 那一支才听它；对正常周期也听的话，
    /// 退避阶梯与心跳节奏会被整个废掉。详细理由写在 `peer_loop` 里。
    ///
    /// ❗ 不按对端分开：`notify_waiters()` 把所有在长睡的都叫起来。
    /// 每对端一个 `Notify` 要多一张表与一套生命周期管理，不值。
    ///
    /// 🔴 这儿原来写的是「多拨几次无害」——**那句话在 >4 台时已经不成立**（W6）。
    /// 拓扑是配对图：8 台互配 = 本机 7 条循环，一次广播就是 7 个会话同时开。
    /// 广播本身没改（改成按对端仍然不值），改的是另外两处：
    /// [`super::coordinate::MAX_CONCURRENT_SESSIONS`] 卡住同时跑的总数，
    /// [`coalesce_writes`] 把连续编辑合成一次。
    pub wake: Arc<tokio::sync::Notify>,
    /// 「本机写了笔记」的信号（方案 B）。来自 `DataStore::write_signal()`，
    /// 而那个信号挂在 HLC 发号处——全项目刷 `updated_ms` 的唯一出口，
    /// 所以**不可能漏掉任何一条写入路径**（不靠给二十个命令逐个加通知）。
    /// 只在 [`idle_wait`] 里听；退避与忙碌等待**不听**。
    pub wrote: Arc<tokio::sync::Notify>,
    /// 当前有循环的对端。拦重复起用（两条循环会白拨）。
    peers: std::sync::Mutex<std::collections::HashSet<String>>,
    /// 每个对端最近一次的结果。给界面看，见 [`LastSync`]。
    last: std::sync::Mutex<HashMap<String, LastSync>>,
    /// 「有人拿着我发出的邀请来敲门」的待确认队列（见 [`super::join`]）。
    /// 与 [`SyncService`] 共一份，所以关开关不会把拒绝名单弄丢。
    pub joins: Arc<super::join::JoinRequests>,
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

/// 拨完之后该怎么等。把四种策略写成类型，而不是 `(u64, bool)`：
/// 「这一觉能不能被叫醒」改错了不会报错，只会开始疯狂拨号。
enum Wait {
    /// 同步成功后：脏了就拨，否则睡到心跳。见 [`idle_wait`]。
    Idle,
    /// 退避阶梯：上一拨**失败了**。固定时长、不听叫醒。
    Fixed(u64),
    /// 没轮到本机（对端在忙 / 本机并发闸满）。短延迟后再来。
    ///
    /// 🔴 必须与 [`Wait::Fixed`] 分开，虽然两者都只是「睡 n 秒」：
    /// `Fixed` 会把 `want_digest` 清掉（刚失败过，不是核对账的时候），
    /// 而「没轮到」**根本没拨出去过**——清掉就把 `peer_loop` 起手那个
    /// 「第一拨带摘要」（W2）给弄丢了。
    ///
    /// 加了全局并发闸之后这不再是罕见路径：开机时 N 条循环一起拨，
    /// 只有 [`super::coordinate::MAX_CONCURRENT_SESSIONS`] 条能进去，
    /// 其余每一条的**头一拨**都会落在这儿。
    Busy(u64),
    /// 长睡，听叫醒（对端回来 / 手动同步）。
    Dormant(u64),
}

impl Wait {
    /// 给界面看的「大约多久后再试」。
    ///
    /// ❗ `Idle` 报心跳上限而不是 `IDLE_CHECK_SECS`：后者只是本地检查的节奏，
    /// 报它会让界面写着「5 秒后同步」而实际上没改动就不会同步。
    fn secs_hint(&self) -> u64 {
        match self {
            Wait::Idle => HEARTBEAT_SECS,
            Wait::Fixed(s) | Wait::Busy(s) | Wait::Dormant(s) => *s,
        }
    }
}

/// 同步成功之后的等待：**脏了就拨，否则睡到心跳**。
///
/// # 🔴 为何不再固定 30 秒一轮
///
/// 两台设备各自每 30 秒拨对方一次 = 一对设备平均每 15 秒一次完整会话，
/// 而绝大多数会话两边都没改过东西——纯浪费（对走中继的对端还是跨境流量）。
///
/// # 为何只看本机脏不看对端
///
/// 因为**两台都在拨**：A 改了 A 拨 B、B 改了 B 拨 A，一次会话把两个方向都搬完。
/// 所以不需要知道对端脏不脏，也不需要变更通知协议。
/// 覆盖不到的那几种（对端改完拨不通、又没有组播）由 `HEARTBEAT_SECS` 兜底。
///
/// 返回值见 [`Woke`]（除了「该不该退出」，还告诉调用方**为何**醒的）。
async fn idle_wait(
    ctx: &SyncCtx,
    peer: &str,
    // 上一拨没推动游标（见 `peer_loop` 里 `cursor_stalled` 的注释）。
    cursor_stalled: bool,
) -> Woke {
    // 去抖：刚同步完就先压一段。这一段**不听写入信号**，
    // 否则连续敲键盘时会变成边打字边拨号。
    if !sleep_or_stop(&ctx.stop, MIN_SESSION_GAP_SECS).await {
        return Woke::Stop;
    }
    let deadline = now_ms() + jittered_secs(HEARTBEAT_SECS, JITTER_SECS, now_ms() as u64) as i64 * 1000;
    // 让下面那条 warn 每次 `idle_wait` 只报一次：本循环每 `IDLE_CHECK_SECS`（5 秒）
    // 转一圈，不扣的话一直到心跳会刷几百条。
    let mut warned_stalled = false;
    loop {
        match dirty_for(ctx, peer) {
            // 🔴 脏但上一拨游标没动 ⇒ **不走快通道**，改等心跳。
            //    否则就是 13 秒一拨的自我维持循环（详细理由在 `peer_loop`）。
            //    不静默（规则 #15.3）：这个状态意味着有东西**永远落不地**，
            //    光退避不报的话，现象就只剩「同步看着在跑但某篇永远不同步」。
            Ok(true) if cursor_stalled => {
                if !warned_stalled {
                    warned_stalled = true;
                    log::warn!(
                        "[Sync] 与 {} 仍有待同步的变更，但上一拨游标没有推动——\
                         有条目反复落不地。改为等心跳，不再密集重试。",
                        &peer[..8.min(peer.len())]
                    );
                }
            }
            // 有东西要发 → 先过一个合并窗口再拨（W6 止血第三条）
            Ok(true) => {
                return if coalesce_writes(
                    &ctx.stop,
                    &ctx.wrote,
                    Duration::from_secs(WRITE_COALESCE_SECS),
                    Duration::from_secs(WRITE_COALESCE_MAX_SECS),
                )
                .await
                {
                    Woke::Dirty
                } else {
                    Woke::Stop
                }
            }
            Ok(false) => {}
            // 查不了库就当脏（宁可多拨一次，不能因为一次 SQL 错就把同步停了）。
            Err(e) => {
                log::warn!("[Sync] 脏检查失败，本轮当作有变更：{}", e);
                return Woke::Dirty;
            }
        }
        if now_ms() >= deadline {
            return Woke::Heartbeat; // 到心跳了，无论如何同一次
        }
        let left = ((deadline - now_ms()) / 1000).max(1) as u64;
        // 这一段听 `wake`（对端回来 / 手动同步）与写入信号（方案 B）。
        if !sleep_idle(ctx, IDLE_CHECK_SECS.min(left)).await {
            return Woke::Stop;
        }
    }
}

/// [`idle_wait`] 为何醒了。它只多做一件事：决定下一拨要不要带分桶摘要（W2）。
enum Woke {
    /// 开关关了 / 这台设备被移除，循环该结束。
    Stop,
    /// 有东西变了。只搬增量，**不对摘要**——这种会话可能几十秒一次。
    Dirty,
    /// 心跳到点。两边本来都没改过东西，正是**顺手对一次摘要**的时候：
    /// 这一轮本就没东西可搬，摘要那点开销不与任何真实工作抢时间。
    Heartbeat,
}

/// 本机还有没有东西要发给这台对端。
///
/// ❗ 游标每次都从**库里**读而不缓存在循环里：对端主动拨过来完成的同步
/// （`serve` 那条路）也会推游标，缓存的话本循环看不到，于是会以为自己还脏、
/// 白拨一次。
fn dirty_for(ctx: &SyncCtx, peer: &str) -> Result<bool, String> {
    let cursor = match ctx.store.device_get(peer)? {
        Some(d) => d.sync_cursor_ms,
        // 名单里已经没这台了（刚被忘记）——当作不脏，循环下一圈会因 `has_peer` 退出。
        None => return Ok(false),
    };
    ctx.store.has_changes_since(cursor)
}

/// 读一台对端的同步游标。读不到（刚被忘记 / SQL 错）当 0。
///
/// 存在的理由只有一条：[`peer_loop`] 要能判「上一拨到底有没有推动游标」。
fn cursor_of(ctx: &SyncCtx, peer: &str) -> i64 {
    ctx.store
        .device_get(peer)
        .ok()
        .flatten()
        .map(|d| d.sync_cursor_ms)
        .unwrap_or(0)
}

/// 一个对端的循环：拨 → 成功就等到「有活干」 → 失败就退避。
pub async fn peer_loop(ctx: Arc<SyncCtx>, peer: String) {
    let short = &peer[..8.min(peer.len())];
    let mut fails: u32 = 0;
    // 🔴 第一拨就带摘要（W2）：上一次可能是崩在会话中间的，
    // 而那正是两边游标已推、内容却分叉的典型成因。
    let mut want_digest = true;
    while ctx.running.load(Ordering::SeqCst) && has_peer(&ctx, &peer) {
        let cursor_before = cursor_of(&ctx, &peer);
        let outcome = dial_once(&ctx, &peer, want_digest).await;
        // 🔴 拨完立刻量一次：游标没动 + 仍然「脏」就是一个**自我维持的循环**，
        //    必须退避（2026-09-07 新增）。已经验实的一条路径：
        //      一篇笔记在对端没标签、本机有 ⇒ 导入时 `parsed.tags.is_empty()`
        //      守卫跳过不清本地标签 ⇒ `same_version` 比标签得 false
        //      ⇒ `note_unsettled` ⇒ `session.rs` 把游标夹在这篇之前（永久）
        //      ⇒ `dirty_for` 恒真 ⇒ 每 13 秒（MIN_SESSION_GAP 10 + 合并窗口 3）
        //         拨一次、每次重传游标之后全部内容——比它取代的固定心跳（600 秒）差 46 倍。
        //
        //    ❗ 这条护栏**不依赖**那个标签 bug 被修好：任何其它「永远落不地」
        //      的成因（>10MiB 的笔记、对端手里有本机已 purge 的笔记…）都会走到同一步。
        // 这一拨拨完之后游标**没有推动**。看 `idle_wait` 里对它的用法。
        let cursor_stalled = cursor_of(&ctx, &peer) == cursor_before;
        // 四种睡法写成显式的（而不是一个 `bool`），因为「谁能被叫醒」是这段
        // 最容易改错的地方，而改错了不报错、只是开始疯狂拨号（已经发生过一次）。
        //
        // 🔴 `Wait::Fixed` / `Wait::Busy`（退避阶梯 / 没轮到本机）**绝不听叫醒**。
        //    叫醒源里有「本机写了笔记」与「对端回来了」，它们与「上一拨刚失败」
        //    没有关系——听了就等于把退避阶梯抹掉：一台拒绝本机的设备（游标 0，
        //    永远是“脏”的）会被每几秒拨一次。
        let wait = match &outcome {
            Outcome::Synced(_) => {
                fails = 0;
                Wait::Idle
            }
            Outcome::Busy(why) => {
                // 不是故障，不动退避计数，也不清 `want_digest`（见 [`Wait::Busy`]）
                log::debug!("[Sync] {} 这次没轮到我们：{}", short, why);
                Wait::Busy(BUSY_RETRY_SECS)
            }
            // 对端明确说不认识本机。重试再多次也不会变——要变得对面的人去确认，
            // 所以直接进长间隔，不走退避阶梯。
            Outcome::Refused(why) => {
                fails += 1;
                log::warn!(
                    "[Sync] {} 拒绝了本机（{}）——它那边还没把这台加回去。\
                     不再频繁重试，{} 秒后看一眼；它一上线或你点「立即同步」会立刻叫醒",
                    short,
                    why,
                    DORMANT_POLL_SECS
                );
                let _ = ctx.store.device_mark_offline(&peer);
                Wait::Dormant(DORMANT_POLL_SECS)
            }
            Outcome::Failed(why) => {
                fails += 1;
                // 🔴 连续失败够多之后进休眠。改之前退避封顶 60 秒且**永不放弃**，
                //   一个永远回不来的对端就是每分钟一次、永远下去；而听不到它组播时
                //   那一拨走的是 n0 公共 relay（真实跨国流量）。
                let dormant = fails >= DORMANT_AFTER_FAILS;
                let w = if dormant { DORMANT_POLL_SECS } else { backoff_secs(fails) };
                if fails == DORMANT_AFTER_FAILS {
                    // 只在**刚进休眠那一次**说清楚，之后不再刷屏。
                    log::warn!(
                        "[Sync] 与 {} 连续失败 {} 次，转入休眠：不再定时重拨，\
                         改为等它的组播公告或你点「立即同步」（另每 {} 秒一次兜底重试）：{}",
                        short,
                        fails,
                        DORMANT_POLL_SECS,
                        why
                    );
                } else if !dormant {
                    log::warn!(
                        "[Sync] 与 {} 同步失败（连续第 {} 次），{} 秒后重试：{}",
                        short,
                        fails,
                        w,
                        why
                    );
                }
                // 休眠期间不再每次都刷一条 warn：每半小时一条无用日志只会把真问题淹了。
                let _ = ctx.store.device_mark_offline(&peer);
                if dormant {
                    Wait::Dormant(w)
                } else {
                    Wait::Fixed(w)
                }
            }
        };
        // dormant 从循环刚算好的 `wait` 取，不另写一遍阀值判定
        record_into(
            &ctx.last,
            &peer,
            outcome,
            fails,
            wait.secs_hint(),
            matches!(wait, Wait::Dormant(_)),
        );
        let alive = match wait {
            // 脏了就拨、否则睡到心跳。空闲时不再固定 30 秒一轮——
            // 那一轮里两边都没改过东西，整个会话是纯浪费。
            Wait::Idle => match idle_wait(&ctx, &peer, cursor_stalled).await {
                Woke::Stop => false,
                Woke::Dirty => {
                    want_digest = false;
                    true
                }
                Woke::Heartbeat => {
                    want_digest = true;
                    true
                }
            },
            // 退避重试：上一拨刚失败，不是核对账的时候（失败多半是网络问题，
            // 多算一遍摘要只是白烧）。
            Wait::Fixed(s) => {
                want_digest = false;
                sleep_or_stop(&ctx.stop, s).await
            }
            // 🔴 没轮到本机：**不动 `want_digest`**。这一拨根本没发出去，
            //    清掉的话，开机时被并发闸挡下的那几台就永远拿不到
            //    「第一拨带摘要」（W2）——而那正是上次崩在会话中间后
            //    发现分叉的唯一机会，错过了就要等到下一次心跳（最多 690 秒）。
            Wait::Busy(s) => sleep_or_stop(&ctx.stop, s).await,
            // 从长睡里醒来：与对端已经很久没说过话，正是分叉最可能积起来的时候。
            Wait::Dormant(s) => {
                want_digest = true;
                sleep_or_wake(&ctx, s).await
            }
        };
        if !alive {
            break;
        }
    }
    log::info!("[Sync] {} 的同步循环已停止", short);
}

/// 把一次会话的结果记下来给界面看。
///
/// ❗「对端在忙」**不覆盖**上一次的结果：那既不是成功也不是失败，
/// 覆盖掉的话界面上刚才那次成功的统计会被一条「在忙」冲没。
/// 只接那张表而不是整个 `SyncCtx`：它本来也只用 `ctx.last`，
/// 而换成表之后它就能单测了——`last_ok_ms` 不被失败覆盖这条不钉住的话，
/// 以后有人在 `Failed` 分支里顺手添一行 `e.last_ok_ms = now_ms()` 就把
/// 「没开机 vs 刚坏」的区分静默地废掉了。
pub(super) fn record_into(
    last: &std::sync::Mutex<HashMap<String, LastSync>>,
    peer: &str,
    outcome: Outcome,
    fails: u32,
    next_in_secs: u64,
    dormant: bool,
) {
    let mut m = match last.lock() {
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
                    import_failed: r.applied.import_failed,
                    clock_too_far_ahead_ms: r.applied.clock_too_far_ahead_ms,
                    assets_landed: r.applied.assets_landed,
                    diverged_buckets: r.diverged_buckets,
                    assets_skipped: r.assets_skipped,
                    fails: 0,
                    error: None,
                    next_in_secs,
                    // 成功这一刻就是「上次真的同步成功」
                    last_ok_ms: now_ms(),
                    dormant: false,
                },
            );
        }
        // 🔴 对端明确拒绝：界面上要说**人能看懂的原因**，不是那串
        //   `读帧长度失败：connection lost（closed by peer: not paired (code 1)）`。
        //   这正是用户报的「配对上了却直接离线」那个局面里，界面唯一能告诉他的事。
        //   原始错误不丢，它在日志里（peer_loop 那条 warn）。
        Outcome::Refused(_) => {
            let e = m.entry(peer.to_string()).or_default();
            e.peer = peer.to_string();
            e.at_ms = now_ms();
            e.fails = fails;
            e.error = Some(
                "对方还没把这台设备加回去——到那台机器的「知识库同步」里确认连接请求（要核对指纹）"
                    .to_string(),
            );
            e.next_in_secs = next_in_secs;
            // ❗ 不动 `last_ok_ms`：失败不能把「曾经成功过」这件事抹掉
            e.dormant = dormant;
        }
        Outcome::Failed(why) => {
            let e = m.entry(peer.to_string()).or_default();
            e.peer = peer.to_string();
            e.at_ms = now_ms();
            e.fails = fails;
            e.error = Some(why);
            e.next_in_secs = next_in_secs;
            // ❗ 同上：`last_ok_ms` 保留
            e.dormant = dormant;
        }
    }
}

/// 这个对端还应该有循环吗（「忘记此设备」之后就不应该了）。
fn has_peer(ctx: &SyncCtx, peer: &str) -> bool {
    ctx.peers.lock().map(|p| p.contains(peer)).unwrap_or(false)
}

pub(super) enum Outcome {
    Synced(Box<session::SessionReport>),
    /// 对端拒了（在忙 / 保留了它自己那个会话）。
    Busy(String),
    /// 对端**明确说不认识本机**（`not paired`）。
    ///
    /// 🔴 与 [`Outcome::Failed`] 分开是因为两者的重试价值完全不同：
    /// 「网络到不了」重试可能会好，而「对方没把本机加回去」重试一万次也不会变——
    /// 它要等的是**对面的人去点一下确认**。全锅烩成 Failed 的后果是：
    /// 既白烧一上午 relay 流量，界面上又只显一个不解释原因的「离线」。
    Refused(String),
    Failed(String),
}

async fn dial_once(ctx: &SyncCtx, peer: &str, want_digest: bool) -> Outcome {
    // 本机也要先拿槽：不然本机的两条路径（周期拨号与刚收到的入连接）
    // 会同时对同一个库跑 apply。
    let _hold = match ctx.coord.try_hold(peer) {
        Ok(h) => h,
        Err(HoldErr::PeerBusy) => {
            return Outcome::Busy("本机已有一个到它的会话在跑".into())
        }
        // 全局并发闸满（W6 止血）。这**不是故障**：走 `Outcome::Busy` 就不动
        // 退避计数、也不覆盖界面上上一次的结果，`BUSY_RETRY_SECS` 秒后再来。
        // 当成失败的后果是一台正常设备被退到 300 秒一拨，而它只是排了一下队。
        Err(HoldErr::GateFull) => {
            // ❗ 报上限而不是 `free_slots()`：后者是拿完错误才读的，
            //   那一瞬可能已经有人释放了，于是印出「已达上限（还剩 1 个）」这种自相矛盾的话。
            return Outcome::Busy(format!(
                "本机同时进行的同步已达上限（{} 个）",
                ctx.coord.limit()
            ))
        }
    };
    let to = match target(ctx, peer) {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    match session::dial_session(&ctx.store, &ctx.endpoint, peer, to, want_digest).await {
        Ok(r) => {
            let _ = ctx
                .store
                .device_mark_online(peer, transport_of(ctx, peer), now_ms());
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
        // 对端明说「还没配对」——重试改变不了任何事，得等对面的人去确认。
        // ❗ 与下一条的先后不重要（两者字样不重叠），但必须在兜底 `Failed` 之前。
        Err(e) if is_not_paired_reject(&e) => Outcome::Refused(e),
        // 对端按 §6.8 保留了它自己那个会话 —— 它会把两边的东西都搬完，
        // 所以这里什么都不用做，短延迟之后再看一眼就行。
        Err(e) if is_busy_reject(&e) => Outcome::Busy(e),
        Err(e) => Outcome::Failed(e),
    }
}

/// 这一次握手算走的哪条路：组播里有它的新鲜地址就是 `lan`，否则 `wan`。
///
/// ❗ 拨出与接入两条路径共用同一个判据（规则 #11）。接入那边原来写死成 `lan`，
/// 于是对端从外网打洞进来时徽章会说「局域网」。
///
/// 🔴 它的结果与 `presence.live()` 是**同一份事实的两个投影**：
/// `wan` 等价于「不在 `live` 里」。所以前端**绝不能**拿 `live` 当在线判据
/// 而又去渲染「外网」标签——那两个条件互斥，标签永远不会出现，
/// 而 WAN 对端会一律显示离线。完整说明在 `src/lib/kbOnline.ts`。
fn transport_of(ctx: &SyncCtx, peer: &str) -> &'static str {
    if ctx.presence.addrs_of(peer, now_ms()).is_empty() {
        "wan"
    } else {
        "lan"
    }
}

/// 对端明确回了「还没配对」。
///
/// 字样来自 [`serve`] 里那句 `session::reject(&w, "not paired")`，
/// 经 `session::explain` 从 `close_reason()` 里捧回错误串。
///
/// 🔴 它能生效的前提就是 `explain`——在那之前，这一类拒绝在拨号方看到的
/// 只有 `connection lost`（quinn 的 Display 不插值内层错误）。
pub fn is_not_paired_reject(err: &str) -> bool {
    err.contains("not paired")
}

/// 对端的关闭原因里带这些字样就是「在忙」，不是故障。
///
/// ❗ 靠字符串认，是因为 iroh 的应用层关闭原因就是一串字节，
/// 而给「忙」单独定一个错误码要动线格式。这里的字样与
/// [`super::coordinate::Coordinator::admit`] 给出的理由一一对应，改一处要改两处。
pub fn is_busy_reject(err: &str) -> bool {
    err.contains("正在向你发起同步")
        || err.contains("让位")
        || err.contains("稍后重试")
        // ❗ 「对方已记下敲门、等用户确认」也算「在忙」而不是故障：
        //   走退避阶梯的话会退到 60 秒，用户刚在对面点完确认还要再等一分钟。
        || err.contains(super::join::REJECT_PENDING)
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
            // 🔴 不能直接拒了事。配对本来是单边的：只有粘贴方写 `devices` 表，
            //   生成邀请码那一台在这里永远 `is_paired == false`，于是把对方每一次
            //   连接都拒掉——**两台机器从来没连通过**，而界面上写着「已配对 · 离线」。
            //   邀请门开着时改成记一条待确认，由用户核对指纹后放行。
            //   完整理由与已知取舍见 `sync::join` 模块注释。
            let now = now_ms();
            if super::join::door_open(&ctx.store, now) && ctx.joins.knock(&peer, now) {
                // ❗ 仍然拒这一次连接：用户还没确认，现在放进来就等于自动放行。
                //   理由用 `REJECT_PENDING`，对端会识别它并短延迟重试。
                session::reject(&w, super::join::REJECT_PENDING);
                log::info!("[Sync] {} 敲门了，已记入待确认（等用户核对指纹）", short);
            } else {
                // 只是没配对，不是攻击：ALPN 对得上说明对方也是 PastePanda
                session::reject(&w, "not paired");
                log::info!("[Sync] {} 还没配对，已拒绝", short);
            }
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
            // ❗ 不能写死 "lan"（改之前就是）：入连接也可能是对端从外网打洞
            //   或过中继过来的，那时徽章会说「局域网」而它根本不在本局域网。
            let _ = ctx
                .store
                .device_mark_online(&peer, transport_of(&ctx, &peer), now_ms());
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

/// 脏了之后的**合并窗口**：等到「`quiet` 这么长时间内没有新写入」再放行。
///
/// # 为什么需要它（W6 止血第三条，2026-09-07）
///
/// 写入信号是**广播**的（一个 `Notify` 叫醒全部对端循环），而
/// [`MIN_SESSION_GAP_SECS`] 只挡得住**单个对端**连着拨。
/// 连续编辑一分钟、身边 7 台设备，就是每台拨 5~6 次、共三十几个会话，
/// 而其中真正需要送出去的只有最后那一版。
///
/// # 两条边界
///
/// - **封顶** `max`：一直在写也不能无限期不同步。没它就是把「合并」做成「饿死」。
/// - 🔴 **不听 `ctx.wake`**。看着它很像该听（「立即同步」应该不等窗口），
///   但 `wake` 同时是组播公告的出口——局域网里每台已配对设备每 15 秒
///   就会把它打一次。听了的话窗口在局域网上几乎立刻被短路，整个合并形同虚设。
///   代价：用户正在连续打字时点「立即同步」，最多等 `max`。
///   那一刻他本来就还在改，而换来的是平时不会白拨三十几次。
///
/// 参数收 `&Notify` 而不是 `&SyncCtx`，同 [`sleep_or_stop`]：为了能单测。
///
/// ❗ 两个窗口收 [`Duration`] 而不是秒数，也不直接读常量：
/// 测试可以用毫秒级的值把整条行为跑完，不用真睡 3 秒，
/// 也就不用为了 `tokio::time::pause()` 去开 tokio 的 `test-util`
/// （`features = ["full"]` **不含**它）。
///
/// 返回 `false` = 开关关了，该退出。
pub async fn coalesce_writes(
    stop: &tokio::sync::Notify,
    wrote: &tokio::sync::Notify,
    quiet: Duration,
    max: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + max;
    loop {
        let calm = tokio::select! {
            _ = tokio::time::sleep(quiet) => true,
            // 还在写 → 重新计窗口
            _ = wrote.notified() => false,
            _ = stop.notified() => return false,
        };
        if calm || tokio::time::Instant::now() >= deadline {
            return true;
        }
    }
}

/// 同 [`sleep_or_stop`]，但**多一个叫醒源**：`ctx.wake`。
///
/// 🔴 休眠（[`DORMANT_POLL_SECS`] = 半小时）必须能被提前打断，否则就从
/// 「浪费资源」变成了「对端回来了却要等半小时」——后者更难受。
/// 两个叫醒源见 [`SyncCtx::wake`]。
///
/// ❗ `stop` 与 `wake` 的区别：前者返回 `false`（该退出了），后者返回 `true`
/// （马上再拨一次）。弄反了就是「对端一上线反而把循环关了」。
async fn sleep_or_wake(ctx: &SyncCtx, secs: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => true,
        _ = ctx.wake.notified() => true,
        _ = ctx.stop.notified() => false,
    }
}

/// 空闲等待里的一小段睡。除了 `wake`，还听**本机写了笔记**（方案 B）。
///
/// ❗ 写入信号只是「去重新查一下脏不脏」，**不是**「马上拨」——
/// 导入远端笔记时它也会响（见 `HlcClock::wrote`），而那种时候精确脏检查
/// 会告诉我们不脏。两者分工：信号管「何时去看」，脏检查管「该不该拨」。
async fn sleep_idle(ctx: &SyncCtx, secs: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => true,
        _ = ctx.wake.notified() => true,
        _ = ctx.wrote.notified() => true,
        _ = ctx.stop.notified() => false,
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
    /// 待确认的敲门（见 [`super::join`]）。
    ///
    /// ❗ 放在**服务**上而不是 `SyncCtx` 里：`SyncCtx` 会随开关重建，
    /// 而拒绝名单不该因为用户关一下再开就清空。`SyncCtx` 里那个字段
    /// 是从这里克隆过去的同一份。
    joins: Arc<super::join::JoinRequests>,
}

impl SyncService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前待确认的敲门。**不看开关**：关掉开关时队列已经被 `stop()` 清了，
    /// 这里再判一次只会多一处要同步的事实。
    pub fn pending_joins(&self, now_ms: i64) -> Vec<super::join::JoinRequest> {
        self.joins.list(now_ms)
    }

    /// 放行一条敲门（用户核对完指纹点了确认）。
    pub fn take_join(&self, node_id: &str) -> bool {
        self.joins.take(node_id)
    }

    /// 拒绝一条敲门。本次进程内不再为它弹。
    pub fn deny_join(&self, node_id: &str) {
        self.joins.deny(node_id);
    }

    /// 把所有**休眠中**的对端循环叫醒（见 [`SyncCtx::wake`]）。
    ///
    /// 没在跑就是空操作——不报错：调用方（手动同步 / 新配对 / 听到组播）
    /// 都不关心同步服务此刻在不在。
    pub async fn wake_all(&self) {
        if let Some(ctx) = self.inner.lock().await.as_ref() {
            ctx.wake.notify_waiters();
        }
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
        self.start_on(store, app_dir, enabled, relay, super::presence::PORT)
            .await
    }

    /// 同上，但可以指定地址宣告的监听端口。**测试传 0**，免得并行的测试抢 5008。
    pub async fn start_on(
        &self,
        store: DataStore,
        app_dir: &std::path::Path,
        enabled: bool,
        relay: bool,
        presence_port: u16,
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
            wake: Arc::new(tokio::sync::Notify::new()),
            wrote: store.write_signal(),
            peers: std::sync::Mutex::new(std::collections::HashSet::new()),
            last: std::sync::Mutex::new(HashMap::new()),
            // ❗ 从服务上克隆而不是新建：关开关会重建 `SyncCtx`，
            //   新建的话拒绝名单会跟着清空，关一下再开就又开始弹同一台被拒过的机器。
            joins: self.joins.clone(),
            // false：让 presence 自己那个 CAS 能成功，见字段注释
            presence_running: Arc::new(AtomicBool::new(false)),
        });

        // ❗ 先把可能失败的读库做完，再起任何后台任务。
        // 反过来的话：这里 `?` 提前返回 → `*guard = Some(ctx)` 没执行 →
        // 但两个后台任务各自握着 `Arc<SyncCtx>` 继续跑，`stop()` 再也摸不到它们，
        // 端口 5008 与 iroh 端点被无主线程占着——又一条僵尸路径。
        let known = store.device_list()?;

        let paired_store = store.clone();
        // ❗ 只克隆 `wake` 而不是整个 `ctx`：宣告线程比 `SyncCtx` 活得长时
        //   抱着一个 Arc<SyncCtx> 会把端点与数据库句柄一起吊住，而它只需要叫醒。
        let wake = ctx.wake.clone();
        super::presence::spawn(
            true,
            ctx.presence.clone(),
            me.clone(),
            port,
            Arc::new(move |id: &str| matches!(paired_store.device_get(id), Ok(Some(_)))),
            // 听到已配对设备的公告 = 它回来了 → 把休眠中的循环叫起来。
            // 不看 `id`：`notify_waiters()` 本来就是广播式的（理由见
            // `SyncCtx::wake` 的注释；多拨出来的量现在由全局并发闸卡着）。
            Arc::new(move |_id: &str| wake.notify_waiters()),
            ctx.presence_running.clone(),
            presence_port,
        );

        // ❗ 扫掉上一次崩溃残留的会话暂存目录（里面是**明文笔记**）。
        //   放在这儿而不是定时跑：残留只会在“上一次进程死了”时产生，
        //   而那之后必然有一次启动。只读一遍 `%TEMP%` 的顶层，不递归。
        session::sweep_stale_scratch();

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
            // 待确认队列也清：关掉开关后那几条敲门已经无从确认（没人在监听了），
            // 留着只会让界面显一条点下去也连不上的请求。拒绝名单不清（见 `JoinRequests::clear`）。
            ctx.joins.clear();
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
        // ❗ 新配上一台时顺手把其它在休眠的叫醒：典型场景是「对面刚确认完」，
        //   而本机那条循环可能刚因为被拒多次而睡下。
        self.wake_all().await;
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
        // ❗ 顺手把休眠中的循环叫醒。用户点「立即同步」的意思就是「现在试」，
        //   只拨这一台而把其它睡着的留在那里，下一次还得再点一遍。
        ctx.wake.notify_waiters();
        // 🔴 手动同步带上分桶摘要（W2）。用户去点这个按钮，大多数时候正是
        // 因为他觉得两边不一样了——而「两边不一样但游标都推过了」正是摘要要治的那一种；
        // 不带的话他点一千次也只是反复拨一个空增量。
        match dial_once(&ctx, node_id, true).await {
            // 「对端在忙」不是失败：它那边正在把两边的东西都搬完
            Outcome::Synced(_) | Outcome::Busy(_) => Ok(()),
            // 对端明确拒了：把真正的原因告诉用户，而不是只说「失败」。
            // 这条往上报的字符串会直接弹成 toast（见 `useKbSync.syncNow`）。
            Outcome::Refused(_) => Err(
                "对方还没把这台设备加回去。请到那台机器的「知识库同步」里确认连接请求（要核对指纹）"
                    .to_string(),
            ),
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
