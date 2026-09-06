//! 同步编排的**决策层**（M6）。谁拨、撞上了谁让位、失败等多久再试。
//!
//! 决策全是纯函数或本机内存状态，**不碰网络也不碰库**——
//! 这一层的正确性靠单测钉住，不靠跑两台机器碰运气。
//!
//! # 🔴 两边都拨，不做选举
//!
//! 曾经打算「只让 `node_id` 字典序小的那边拨」，零碰撞、行为确定。**那是错的。**
//!
//! 决定性理由是**可达性不对称**：企业/校园网里最常见的形态是
//! 「出站允许、入站阻断」。要是被选中的拨号方恰好在那种网络里，
//! 这一对设备**永远不同步**——而反方向本来是通的。
//! 选举等于把连通机会砍掉一半，且砍掉的那一半没有补救路径。
//! iroh 的打洞也是两边同时尝试成功率才高。
//!
//! 顺带一句：Syncthing 的 BEP 规范**通篇不规定谁发起连接**，
//! 只描述连接建立之后的流程；它的索引交换是对称的、块传输是拉式的
//! （"requesting missing or outdated blocks"）。那不是漏写，是设计——
//! **协议幂等，所以谁拨都行、撞了也不出错。**
//!
//! # 碰撞用确定性让位，不用随机退避
//!
//! 这个问题有写进 RFC 的现成解法。BGP 两个对端同时向对方开连接时
//! （RFC 4271 §6.8 Connection Collision Detection）：
//!
//! > The convention is to compare the BGP Identifiers of the peers involved
//! > in the collision and to retain only the connection initiated by the
//! > BGP speaker with the higher-valued BGP Identifier.
//!
//! 我们有天生的 identifier：`node_id`（公钥 hex）。规则照抄，见 [`resolve_collision`]。
//!
//! ❗ 这**不是**选举拨号方：谁都能拨，只有真撞上的那一刻才让位。连通性一分不丢。
//! 相比 CSMA/CD 那种随机抖动退避：能用，但白浪费一次往返而且可能反复相撞。
//! 手里有全序就不该掷骰子。
//!
//! # 让位不需要「掐掉自己的出会话」
//!
//! 一开始以为让位方得中途取消自己那个出会话（麻烦且危险）。其实不用：
//!
//! ```text
//! A(id 小) 拨 B，同时 B(id 大) 拨 A
//! B 的 accept 收到 A 的入连接 → KeepMine → 立刻拒
//! A 的出会话因此**自己就失败了**（对端拒了）
//! A 的 accept 收到 B 的入连接 → YieldToPeer → 等自己那个槽腾出来 → 接下 B 的
//! ```
//!
//! 也就是说 **KeepMine 一方的拒绝，就是 YieldToPeer 一方的取消信号**。
//! 让位方只需要等自己的槽被释放（[`YIELD_WAIT`]），不需要任何取消机制。
//!
//! 等不到怎么办（丢包、对端崩了）？超时之后连入连接一起拒掉，两边各自重试。
//! 有抖动在，活锁是有界且罕见的——这条是**明知的取舍**，不是漏洞。
//!
//! # 为什么还需要本机的会话槽
//!
//! `apply_delta` 里是「读本地戳 → 比较 → 导入」，**两个会话并发跑同一个库有 TOCTOU**。
//! 所以每个对端一把本机锁。锁只在本机、不进协议，不会造成跨机死锁。
//!
//! 🔴 入连接遇到槽被占时必须**立刻拒**或**按规则让位**，绝不能阻塞等待：
//! 阻塞的话 A 的出会话在等 B 的 accept，而 B 的 accept 阻塞在 B 自己的槽上
//! → 跨机死锁。这条与上面的让位规则是同一件事的两面。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 两次主动同步之间的基准间隔（秒）。
pub const PERIOD_SECS: u64 = 30;
/// 间隔的抖动幅度（秒）。加抖动是为了让碰撞**本来就少见**。
pub const JITTER_SECS: u64 = 10;
/// 连不上时的退避阶梯（秒）。到顶就一直用最后一档。
///
/// ❗ 末尾那个 300 是 2026-09-06 加的：原来封顶在 60 秒，而循环**永不放弃**，
/// 于是一个永远回不来的对端就变成每分钟一次、永远下去。局域网内无所谓，
/// 但听不到对端组播时 `target()` 会退到「只给 node_id」的兜底分支，
/// 那是走 **n0 公共 relay** 的真实跨国流量（2026-09-06 实测：每轮都在
/// 跟 `euc1-1.relay.n0.iroh.link` 握手）。
pub const BACKOFF_STEPS_SECS: [u64; 5] = [5, 10, 30, 60, 300];

/// 连续失败多少次之后进休眠（不再定时拨，只等明确信号叫醒）。
///
/// 20 次按阶梯算大约是 5+10+30+60+300×16 ≈ **1.5 小时**：
/// 这么久还没通，基本就不是「对端刚好在重启」。
///
/// 🔴 休眠不是「放弃这台设备」——它仍在名单里。只是不再盲拨：
/// 对端一回来（组播公告被听到）就会被当场叫醒，局域网下延迟是秒级的。
pub const DORMANT_AFTER_FAILS: u32 = 20;

/// 休眠时每一觉睡多久（秒）。
///
/// 不写成「无限等信号」的原因：叫醒信号（组播听到 / 手动同步）全都可能漏（丢包、
/// 对端只走 relay 根本不发组播）。留一个很稀的兜底心跳，最差也能自愈。
pub const DORMANT_POLL_SECS: u64 = 1800;
/// 「对端在忙」之后多久再试（秒）。**不走退避**——那不是故障。
pub const BUSY_RETRY_SECS: u64 = 2;
/// 让位方等自己的槽腾出来的上限。
pub const YIELD_WAIT: Duration = Duration::from_secs(3);

/// 撞上了谁留下。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Collision {
    /// 本机 id 更大 → 保留自己的出会话，拒掉这个入连接。
    KeepMine,
    /// 本机 id 更小 → 让给对端发起的那个会话。
    YieldToPeer,
}

/// 照 BGP RFC 4271 §6.8：比 identifier，保留 identifier **大**的一方发起的连接。
///
/// 这个函数必须是**反对称**的：任意一对 id，两边各自调用会得到相反的结论，
/// 于是恰好活一个会话。单测钉的就是这条性质。
///
/// `me == peer` 是连到自己身上，那是别处的 bug；这里返回 `KeepMine`,
/// 因为「让位给自己」会永远等不到。
pub fn resolve_collision(me: &str, peer: &str) -> Collision {
    if me > peer {
        Collision::KeepMine
    } else if me < peer {
        Collision::YieldToPeer
    } else {
        Collision::KeepMine
    }
}

/// 连续失败 `fails` 次之后等多久。`fails` 从 1 起算。
pub fn backoff_secs(fails: u32) -> u64 {
    let i = (fails.max(1) - 1) as usize;
    BACKOFF_STEPS_SECS[i.min(BACKOFF_STEPS_SECS.len() - 1)]
}

/// `base ± jitter`，由 `seed` 决定，落在 `[base-jitter, base+jitter]`。
///
/// 用确定性混淆而不是随机数：一是纯函数好测（边界不越界、不同 seed 会变），
/// 二是本项目不为了抖动去引一个随机数依赖。
/// 调用侧拿墙钟毫秒当 seed 就够散了。
pub fn jittered_secs(base: u64, jitter: u64, seed: u64) -> u64 {
    if jitter == 0 {
        return base;
    }
    // splitmix64 的混淆步骤，够散且没有依赖
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x >> 31;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    // 🔴 上下界各自夹好、再算跨度，不能写成
    //    `base.saturating_sub(jitter) + x % (jitter * 2 + 1)`。
    //    `base < jitter` 时那么写会把整个区间**平移**而不是夹住：
    //    base=3 / jitter=10 会拖出 [0,20]，上界远超 base+jitter=13。
    //    配置写错时那就是「同步间隔悄悄变成别的值」，靠单测钉住了。
    let low = base.saturating_sub(jitter);
    let high = base.saturating_add(jitter);
    low + x % (high - low + 1)
}

/// 一个对端的会话槽。
#[derive(Debug, Default)]
struct Slot {
    busy: AtomicBool,
    /// 槽被释放时通知等的人。让位方靠它。
    released: tokio::sync::Notify,
}

/// 占住一个槽。**析构即释放**，所以会话怎么退出（返回、`?`、panic）都不会漏。
#[derive(Debug)]
pub struct Hold {
    slot: Arc<Slot>,
    peer: String,
}

impl Hold {
    pub fn peer(&self) -> &str {
        &self.peer
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        self.slot.busy.store(false, Ordering::SeqCst);
        self.slot.released.notify_waiters();
    }
}

/// 入连接该怎么处理。
#[derive(Debug)]
pub enum Admit {
    /// 收下，并且槽已经拿到手。
    Ok(Hold),
    /// 不是已配对设备。
    NotPaired,
    /// 拒掉，理由给对端看。
    Reject(String),
}

/// 本机的会话编排状态。
pub struct Coordinator {
    me: String,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

impl Coordinator {
    pub fn new(my_node_id: String) -> Self {
        Self {
            me: my_node_id,
            slots: Mutex::new(HashMap::new()),
        }
    }

    fn slot(&self, peer: &str) -> Arc<Slot> {
        let mut m = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        m.entry(peer.to_string()).or_default().clone()
    }

    /// 试着占住某个对端的槽。占不住就返回 `None`——**不等**。
    pub fn try_hold(&self, peer: &str) -> Option<Hold> {
        let slot = self.slot(peer);
        slot.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Hold {
                slot,
                peer: peer.to_string(),
            })
    }

    /// 入连接来了：判配对、拿槽、撞上了按 §6.8 让位。整条规则收口在这儿。
    pub async fn admit(&self, peer: &str, is_paired: bool) -> Admit {
        if !is_paired {
            return Admit::NotPaired;
        }
        if let Some(h) = self.try_hold(peer) {
            return Admit::Ok(h);
        }
        // 槽被占着 = 本机正有一个到这个对端的出会话在跑 ⇒ 撞上了
        match resolve_collision(&self.me, peer) {
            Collision::KeepMine => {
                Admit::Reject("本机正在向你发起同步，且本机 node_id 更大（RFC 4271 §6.8）".into())
            }
            Collision::YieldToPeer => {
                // 让位：等自己那个出会话腾出槽。它会因为对端拒绝而很快失败。
                let slot = self.slot(peer);
                let waiter = slot.released.notified();
                if slot.busy.load(Ordering::SeqCst) {
                    // 🔴 先建 notified() 再看 busy：反过来的话，
                    // 两句之间释放的那一次通知会丢，于是白等满 YIELD_WAIT。
                    if tokio::time::timeout(YIELD_WAIT, waiter).await.is_err() {
                        return Admit::Reject(format!(
                            "让位给你，但本机那个出会话 {} 秒内没退出",
                            YIELD_WAIT.as_secs()
                        ));
                    }
                }
                match self.try_hold(peer) {
                    Some(h) => Admit::Ok(h),
                    None => Admit::Reject("让位后槽又被占了，请稍后重试".into()),
                }
            }
        }
    }
}
