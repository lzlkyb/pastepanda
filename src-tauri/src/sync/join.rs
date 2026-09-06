//! 「有人拿着我发出的邀请来敲门」的待确认队列（2026-09-06）。
//!
//! # 要补的那个洞
//!
//! 配对本来是**单边**的：`kb_sync_pair` 只在**粘贴方**写 `devices` 表，
//! 生成邀请码那一台从头到尾不写自己的表。于是在生成方那边：
//!
//! - [`super::presence`] 把对方的公告当 `Unpaired` 丢掉，连地址都不记；
//! - [`super::service::serve`] 把对方的入连接当 `NotPaired` 拒掉；
//! - 设备列表永远是空的，而配对向导里那个「等对方粘贴」屏盯的正是
//!   设备列表长不长新条目——它是个**死循环**。
//!
//! 结果就是用户报的：两台机器从来没连通过，而界面上写着「已配对 · 离线」。
//!
//! # 怎么补
//!
//! 生成邀请码 = 打开一扇**有时限**的门（[`CFG_DOOR_UNTIL`]，与邀请码同一个 TTL）。
//! 门开着时，陌生对端连进来不再直接拒，而是记成一条**待确认**，
//! 由用户在界面上核对**指纹**后放行。放行才 `device_pair`。
//!
//! # 🔴 为什么不自动放行
//!
//! [`super::invite`] 的模块注释写得很清楚：签名只能证明「做码的人持有那把私钥」，
//! **证明不了这个码在传给你的路上没被换掉**，挡住替换的唯一办法是两端各自看指纹。
//! 而现在只有粘贴方核对了生成方的指纹，生成方从不核对对方——
//! 这道门补上，互相核对才算闭合。**自动放行等于把刚补上的那一半又拆掉。**
//!
//! # 🔴 为什么不校验对方出示的邀请码
//!
//! 那需要改 wire 协议（会话开场帧带一份 claim）。而它买到的只是**降噪**：
//! 让局域网邻居在门开着的那段时间里敲不了门。**安全性并不由它提供**，
//! 由用户核对指纹提供。所以先用时间窗，代价写在下面。
//!
//! ## 已知取舍（改之前先读）
//!
//! - 门开着时，**任何**能连到本机端点的 PastePanda 都能出现在待确认列表里
//!   （本机 node_id 在局域网组播里是公开的）。它能做到的只是让用户看到一条
//!   敲门记录；不核对指纹就点确认的人，在原设计里同样会被骗。
//! - 待确认列表里**没有对方的设备名**，只有指纹。这是**故意**的：
//!   [`super::session`] 的模块注释写着「少一个可自称的字段，就少一处要交叉核对的地方」，
//!   而设备名恰恰是可自称的。指纹绑在**已认证的连接身份**上，伪造不了。

use crate::data_store::DataStore;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// 配置里存「邀请门开到什么时候」的键（epoch 毫秒）。
pub const CFG_DOOR_UNTIL: &str = "kb_sync_invite_open_until";

/// 拒连时给对端的理由：本机已经记下这次敲门，正在等用户确认。
///
/// ❗ 它与 [`super::service::is_busy_reject`] 里的判据是**同一串**：
/// 对端靠它决定走**短延迟重试**而不是退避阶梯（最长 60 秒）——
/// 否则用户刚在这边点完确认，对面还要再等一分钟才连上。
pub const REJECT_PENDING: &str = "等待对方确认";

/// 一条敲门记录多久没再来就丢掉（毫秒）。
///
/// 对端被拒后会重试，所以只要它还在试，这条就一直新鲜；
/// 它真的不再来了（关机 / 用户放弃）就该从列表里消失，而不是挂到天荒地老。
pub const KNOCK_TTL_MS: i64 = 10 * 60 * 1000;

/// 一条待确认的敲门。
///
/// ❗ 只有 `node_id`——没有设备名。理由见模块头部「已知取舍」。
/// 界面上显示的指纹由前端用 `fingerprintOf(node_id)` 算，与对方机器上
/// 「本机指纹」显示的是同一串。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JoinRequest {
    pub node_id: String,
    /// 第一次敲门的 epoch 毫秒。
    pub first_seen_ms: i64,
    /// 最近一次敲门。过期判据用它。
    pub last_seen_ms: i64,
    /// 敲了几次。给界面看「它一直在试」。
    pub tries: u32,
}

/// 待确认队列 + 本次进程内的拒绝名单。
#[derive(Default)]
pub struct JoinRequests {
    pending: Mutex<HashMap<String, JoinRequest>>,
    /// 用户点过「拒绝」的。本次进程内不再记，防反复弹。
    /// 不落盘：拒绝是一次性的处置，持久化一份黑名单反而需要一个清理入口。
    denied: Mutex<HashSet<String>>,
}

impl JoinRequests {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 有人敲门。返回 `true` = 已记下（界面会看到）。
    ///
    /// 被用户拒过的直接返 `false`，调用方按普通「未配对」拒掉。
    pub fn knock(&self, node_id: &str, now_ms: i64) -> bool {
        if node_id.is_empty() {
            return false;
        }
        if self
            .denied
            .lock()
            .map(|d| d.contains(node_id))
            .unwrap_or(false)
        {
            return false;
        }
        let Ok(mut m) = self.pending.lock() else {
            return false;
        };
        m.entry(node_id.to_string())
            .and_modify(|r| {
                r.last_seen_ms = now_ms;
                r.tries += 1;
            })
            .or_insert(JoinRequest {
                node_id: node_id.to_string(),
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
                tries: 1,
            });
        true
    }

    /// 当前待确认的（顺手清掉不再敲的）。按首次敲门时间正序。
    pub fn list(&self, now_ms: i64) -> Vec<JoinRequest> {
        let Ok(mut m) = self.pending.lock() else {
            return Vec::new();
        };
        m.retain(|_, r| now_ms - r.last_seen_ms <= KNOCK_TTL_MS);
        let mut v: Vec<JoinRequest> = m.values().cloned().collect();
        v.sort_by_key(|r| r.first_seen_ms);
        v
    }

    /// 放行 / 处理完，从队列里拿掉。返回「原本在不在里面」。
    pub fn take(&self, node_id: &str) -> bool {
        self.pending
            .lock()
            .map(|mut m| m.remove(node_id).is_some())
            .unwrap_or(false)
    }

    /// 用户点了拒绝。拿出队列并记入拒绝名单。
    pub fn deny(&self, node_id: &str) {
        self.take(node_id);
        if let Ok(mut d) = self.denied.lock() {
            d.insert(node_id.to_string());
        }
    }

    /// 全都清掉（关开关时）。**不清拒绝名单**：
    /// 关一下再开就又开始弹同一台被拒过的机器，那不是用户要的。
    pub fn clear(&self) {
        if let Ok(mut m) = self.pending.lock() {
            m.clear();
        }
    }
}

// ===== 邀请门（落在配置里，重启不丢）=====

/// 门开到什么时候（epoch 毫秒）。没开过就是 0。
pub fn door_until(store: &DataStore) -> i64 {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(CFG_DOOR_UNTIL).and_then(|v| v.as_i64()))
        .unwrap_or(0)
}

/// 现在门开着吗。
pub fn door_open(store: &DataStore, now_ms: i64) -> bool {
    door_until(store) > now_ms
}

/// 开门到 `until_ms`。已经开得更久就不缩短
/// （连着生两次邀请码时，后一次不该把前一次的窗口提前关上）。
pub fn open_door(store: &DataStore, until_ms: i64) -> Result<(), String> {
    let cur = door_until(store);
    if cur >= until_ms {
        return Ok(());
    }
    write_door(store, until_ms)
}

/// 关门。放行一台之后调——配对完了就不该再敞着。
pub fn close_door(store: &DataStore) -> Result<(), String> {
    write_door(store, 0)
}

fn write_door(store: &DataStore, until_ms: i64) -> Result<(), String> {
    let mut config = store.get_config()?;
    // ❗ 不能 `if let Some(..)` 了事：配置不是对象时会静默跳过写入，
    //   而 `save_config` 照样返回 Ok（规则 #15.3）。同 `toggle_kb_sync` 的写法。
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象，邀请窗口没能保存")?;
    obj.insert(
        CFG_DOOR_UNTIL.to_string(),
        serde_json::Value::from(until_ms),
    );
    store.save_config(&config)
}
