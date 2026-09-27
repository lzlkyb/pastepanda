//! 远程协助的「邀请门」+ 敲门队列（方案 A）。
//!
//! 与 `sync::join` 同构，但是**独立的一扇门**：远程配对不依赖同步配对。
//! 生成 RC 邀请码 = 开门；门开着时陌生对端的 Request 记成待确认，用户核对指纹后
//! 写入 `rc_devices`。

use crate::data_store::DataStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 配置键：RC 邀请门开到什么时候（epoch 毫秒）。
pub const CFG_DOOR_UNTIL: &str = "rc_invite_open_until";

/// 一条 RC 敲门（对方想配对以便远程，或首次连上）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RcJoinRequest {
    pub node_id: String,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub tries: u32,
}

/// 双方交换配对码时，本机已明确粘贴的那一台。只存在本进程内；重启后需重新交换。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RcExchangeIntent {
    pub node_id: String,
    pub name: String,
    pub expires_at: i64,
    pub addr: Option<iroh::EndpointAddr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RcShortCode {
    pub code: String,
    pub expires_at: i64,
}

const KNOCK_TTL_MS: i64 = 10 * 60 * 1000;
/// 拒绝配对后的冷却：到点自动允许再敲门，避免一次误拒永久锁死。
const DENY_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Default)]
pub struct RcJoins {
    pending: Mutex<HashMap<String, RcJoinRequest>>,
    /// node_id → 拒绝生效到什么时候（epoch ms）。
    denied: Mutex<HashMap<String, i64>>,
    exchange: Mutex<Option<RcExchangeIntent>>,
    short_code: Mutex<Option<RcShortCode>>,
    short_active: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
}

pub struct RcShortAttempt(Arc<RcJoins>);

impl Drop for RcShortAttempt {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.short_active.lock() {
            *active = None;
        }
    }
}

impl RcJoins {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 码只留在内存里。重复打开页面时复用未过期的码，避免已发出的码突然失效。
    pub fn short_code(&self, now_ms: i64) -> Result<RcShortCode, String> {
        use ring::rand::{SecureRandom, SystemRandom};
        let mut guard = self.short_code.lock().map_err(|_| "配对状态暂时不可用")?;
        if let Some(code) = guard.as_ref().filter(|code| now_ms < code.expires_at) {
            return Ok(code.clone());
        }
        let rng = SystemRandom::new();
        let mut bytes = [0u8; 4];
        let value = loop {
            rng.fill(&mut bytes).map_err(|_| "生成配对码失败")?;
            let value = u32::from_le_bytes(bytes);
            // 拒绝尾部余数，保证所有八位码等概率。
            if value < (u32::MAX / 100_000_000) * 100_000_000 {
                break value % 100_000_000;
            }
        };
        let code = RcShortCode { code: format!("{value:08}"), expires_at: now_ms + 10 * 60 * 1000 };
        *guard = Some(code.clone());
        Ok(code)
    }

    pub fn valid_short_code(&self, code: &str, now_ms: i64) -> bool {
        self.short_code.lock().ok().and_then(|g| g.clone())
            .is_some_and(|current| current.code == code && now_ms < current.expires_at)
    }

    pub fn begin_short(self: &Arc<Self>) -> Result<(RcShortAttempt, tokio::sync::watch::Receiver<bool>), String> {
        let mut active = self.short_active.lock().map_err(|_| "配对状态暂时不可用")?;
        if active.is_some() {
            return Err("正在等待对方确认，请先完成或等本次配对超时".into());
        }
        let (sender, receiver) = tokio::sync::watch::channel(false);
        *active = Some(sender);
        Ok((RcShortAttempt(self.clone()), receiver))
    }

    pub fn cancel_short(&self) {
        if let Ok(active) = self.short_active.lock() {
            if let Some(sender) = active.as_ref() {
                let _ = sender.send(true);
            }
        }
    }

    pub fn clear_short_code(&self) {
        if let Ok(mut guard) = self.short_code.lock() {
            *guard = None;
        }
    }

    pub fn arm_exchange(&self, node_id: &str, name: &str, expires_at: i64) -> Result<(), String> {
        self.arm_exchange_addr(node_id, name, expires_at, None)
    }

    pub fn arm_exchange_addr(&self, node_id: &str, name: &str, expires_at: i64, addr: Option<iroh::EndpointAddr>) -> Result<(), String> {
        if addr.as_ref().is_some_and(|value| value.id.to_string() != node_id) {
            return Err("设备地址与身份不一致".into());
        }
        let mut g = self.exchange.lock().map_err(|_| "配对状态暂时不可用")?;
        *g = Some(RcExchangeIntent {
            node_id: node_id.to_string(),
            name: name.to_string(),
            expires_at,
            addr,
        });
        Ok(())
    }

    pub fn exchange_for(&self, node_id: &str, now_ms: i64) -> Option<RcExchangeIntent> {
        self.exchange
            .lock()
            .ok()?
            .as_ref()
            .filter(|intent| intent.node_id == node_id && now_ms < intent.expires_at)
            .cloned()
    }

    pub fn clear_exchange(&self, node_id: &str) {
        if let Ok(mut g) = self.exchange.lock() {
            if g.as_ref().is_some_and(|intent| intent.node_id == node_id) {
                *g = None;
            }
        }
    }

    /// 这台设备是否还在「拒绝冷却期」内。
    ///
    /// `pub` 是为了让 `service.rs` 能把判据交给纯函数 [`deny_unpaired`]
    /// ——原先它靠 `knock()` 返回 `false` 来反推「被拒过」，
    /// 而 `knock()` 返回 false 还有别的成因（`node_id` 为空），
    /// 两件事混在一个返回值里，正是错误文案分不出来的原因。
    pub fn is_denied(&self, node_id: &str, now_ms: i64) -> bool {
        let Ok(d) = self.denied.lock() else {
            return false;
        };
        matches!(d.get(node_id), Some(&until) if now_ms < until)
    }

    pub fn knock(&self, node_id: &str, now_ms: i64) -> bool {
        if node_id.is_empty() {
            return false;
        }
        if self.is_denied(node_id, now_ms) {
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
            .or_insert(RcJoinRequest {
                node_id: node_id.to_string(),
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
                tries: 1,
            });
        true
    }

    pub fn list(&self, now_ms: i64) -> Vec<RcJoinRequest> {
        let Ok(mut m) = self.pending.lock() else {
            return Vec::new();
        };
        m.retain(|_, r| now_ms - r.last_seen_ms <= KNOCK_TTL_MS);
        let mut v: Vec<RcJoinRequest> = m.values().cloned().collect();
        v.sort_by_key(|r| r.first_seen_ms);
        v
    }

    pub fn take(&self, node_id: &str) -> bool {
        self.pending
            .lock()
            .map(|mut m| m.remove(node_id).is_some())
            .unwrap_or(false)
    }

    pub fn deny(&self, node_id: &str, now_ms: i64) {
        self.take(node_id);
        if let Ok(mut d) = self.denied.lock() {
            d.insert(node_id.to_string(), now_ms + DENY_TTL_MS);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut m) = self.pending.lock() {
            m.clear();
        }
        if let Ok(mut g) = self.exchange.lock() {
            *g = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_blocks_then_expires() {
        let j = RcJoins::new();
        let now = 1_000_000i64;
        assert!(j.knock("peer", now));
        j.deny("peer", now);
        assert!(!j.knock("peer", now), "刚拒绝应挡住再敲门");
        assert!(j.knock("peer", now + DENY_TTL_MS + 1), "冷却结束后应允许");
    }

    #[test]
    fn knock_records_pending() {
        let j = RcJoins::new();
        let now = 5_000i64;
        assert!(j.knock("a", now));
        assert!(j.knock("a", now + 1), "重复敲门应刷新而不是失败");
        let list = j.list(now + 1);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].tries, 2);
        assert!(j.take("a"));
        assert!(j.list(now + 1).is_empty());
    }

    #[test]
    fn exchange_only_matches_the_pasted_peer_within_the_invite_window() {
        let j = RcJoins::new();
        j.arm_exchange("a", "甲", 10_000).unwrap();
        assert!(j.exchange_for("b", 9_000).is_none());
        assert_eq!(j.exchange_for("a", 9_000).unwrap().name, "甲");
        assert!(j.exchange_for("a", 10_000).is_none());
        j.clear_exchange("a");
        assert!(j.exchange_for("a", 9_000).is_none());
    }

    #[test]
    fn short_code_is_reused_until_expiry_and_only_one_attempt_can_run() {
        let joins = RcJoins::new();
        let first = joins.short_code(1_000).unwrap();
        assert_eq!(first.code.len(), 8);
        assert!(first.code.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(joins.short_code(2_000).unwrap(), first);
        assert!(joins.valid_short_code(&first.code, 2_000));
        let (attempt, cancelled) = joins.begin_short().unwrap();
        assert!(joins.begin_short().is_err());
        joins.cancel_short();
        assert!(*cancelled.borrow());
        drop(attempt);
        assert!(joins.begin_short().is_ok());
        assert!(!joins.valid_short_code(&first.code, first.expires_at));
        assert_ne!(joins.short_code(first.expires_at).unwrap().expires_at, first.expires_at);
    }
}

/// 未配对对端敲门时，本机该拿什么理由拒它。
///
/// 它之所以被拆成**独立的枚举 + 纯函数**（2026-09-17）：这几种成因原先塌缩成同一句
/// `not_paired`（「尚未远程配对」），而用户实际撞到的**几乎总是 [`DoorClosed`]**——
/// 那句话指不到「回去重新生成一个」这个唯一正确的动作。
/// 分成四档之后，前三档都必须能被单测钉住，而 accept 循环（网络）在单测里跑不起来，
/// 所以判据要抽成纯函数挂在这里。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnockDenial {
    /// 本机没开「允许被远程协助」（红线：未启用 = 零可见零请求零费用）。
    Disabled,
    /// 邀请窗口已关：要么过期，要么已经配对成功一次而提前关上。
    DoorClosed,
    /// 本机此前拒绝过它（多半是用户自己点的「拒绝」），还在冷却期。
    Denied,
}

impl KnockDenial {
    /// 回给**对端**的话。写给收这句话的人看——他是发起方，所以一律称「对方…」，
    /// 与 `Gate::deny_reason` 的既有约定一致（见 `rc/session.rs`）。
    pub fn reason(self) -> &'static str {
        match self {
            KnockDenial::Disabled => "对方未开启「允许被远程协助」",
            KnockDenial::DoorClosed => "对方的邀请窗口已过期",
            KnockDenial::Denied => "对方拒绝过本次配对请求",
        }
    }

    /// 稳定错误码：前端分档文案用（`src/lib/rcDeny.ts` 的 `BY_CODE`），**不要改字符串**。
    pub fn code(self) -> &'static str {
        match self {
            KnockDenial::Disabled => "disabled",
            KnockDenial::DoorClosed => "invite_door_closed",
            KnockDenial::Denied => "pair_denied",
        }
    }

    /// 本机日志里用的短标签（日志站本机立场，与 `reason()` 的「对方…」相反）。
    pub fn log_label(self) -> &'static str {
        match self {
            KnockDenial::Disabled => "本机未开启被控",
            KnockDenial::DoorClosed => "邀请窗口已关闭",
            KnockDenial::Denied => "在拒绝冷却期内",
        }
    }
}

/// 判据：未配对的对端来敲门，该拒还是该记入待确认。
///
/// `None` = 记入待确认（这一步有副作用，由调用方做）。
/// **顺序即优先级**：未开启 > 窗口已关 > 冷却期 —— 前一条比后一条更能解释用户的处境，
/// 所以先报它（例：既没开被控、窗口又过期时，该说的是「去把开关打开」）。
pub fn deny_unpaired(
    enabled: bool,
    door_open: bool,
    in_deny_cooldown: bool,
) -> Option<KnockDenial> {
    if !enabled {
        return Some(KnockDenial::Disabled);
    }
    if !door_open {
        return Some(KnockDenial::DoorClosed);
    }
    if in_deny_cooldown {
        return Some(KnockDenial::Denied);
    }
    None
}

/// 邀请门当前开到什么时候（epoch ms）。没开过或已关返回 0。
pub fn door_until(store: &DataStore) -> i64 {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(CFG_DOOR_UNTIL).and_then(|v| v.as_i64()))
        .unwrap_or(0)
}

/// 邀请门是否还开着。
pub fn door_open(store: &DataStore, now_ms: i64) -> bool {
    door_until(store) > now_ms
}

/// 开门到 `until_ms`（生成邀请码时调用）。已经开得更久就不缩短
/// （连着生两次邀请码时，后一次不该把前一次的窗口提前关上——同 `sync::join`）。
pub fn open_door(store: &DataStore, until_ms: i64) -> Result<(), String> {
    if door_until(store) >= until_ms {
        return Ok(());
    }
    write_door(store, until_ms)
}

/// 关门。**放行一台之后调**——配对完了就不该再敞着。
///
/// 🔴 这一条比「把窗口调短」更管用：码里带的是「node_id + 名字」、
/// **不是一次性 nonce**，所以同一份码在窗口内可以被反复使用。
/// 配对成功即关门，等于把「这份码还能用几次」压到 1。
/// （`sync::join` 早就是这个做法，rc 这边 2026-09-17 才补上。）
pub fn close_door(store: &DataStore) -> Result<(), String> {
    write_door(store, 0)
}

fn write_door(store: &DataStore, until_ms: i64) -> Result<(), String> {
    let mut config = store.get_config()?;
    // ❗ 不能 `if let Some(..)` 了事：配置不是对象时会静默跳过写入，
    //   而 `save_config` 照样返回 Ok（规则 #15.3）。同 `sync::join` 的写法。
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象，邀请窗口没能保存")?;
    obj.insert(
        CFG_DOOR_UNTIL.to_string(),
        serde_json::Value::from(until_ms),
    );
    store.save_config(&config)
}
