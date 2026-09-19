//! 局域网「6 位数字」配对（A3）：两端各显示同一个数字，**各自点一次确认**，配对才算数。
//!
//! # 为什么 6 位数字够用
//!
//! 直接把密钥换成 6 位数字是错的（100 万种可能，抓一个包就能离线爆破）。
//! 这里用的是蓝牙 SSP / Signal 安全码那一套：真密钥由两端**现场**协商
//! （X25519，32 字节，从不上网），6 位数字只是那把共享值的摘要。
//! 中间人插足会让两端算出**不同**的共享值 → 两个数字对不上 → 用户当场发现。
//! 完整论证在 [`crate::lan_pair`] 的模块头，本文件**复用**它的
//! [`PendingPair`] 与 [`verify_pin`]，不重写一遍。
//!
//! # 🔴 与邀请码那条路的关系
//!
//! 邀请码是**兜底**：不在同一局域网时只能靠带外渠道搬一串码。这条局域网路径
//! 把「搬字符串」整个消掉——但两条路的**信任建立强度不同**，别混着看：
//!
//! | | 邀请码 | 本文件（6 位数字） |
//! |---|---|---|
//! | 中间人挡得住吗 | **挡不住**（码是自签的，攻击者换成自己那份照样验过） | **挡得住**（换公钥 → 两端数字不同） |
//! | 用户要做的事 | 复制、粘贴、跨屏核对指纹 | 对一眼数字、点一次确认 |
//!
//! 所以这里不是「为了少几步而降低安全性」，反而是这条路上**唯一**真正能挡住
//! 主动替换的机制。
//!
//! # 🔴 为什么两端都要点确认，而不是一端
//!
//! 数字只有**放在一起比**才有意义。若只要一端确认，那么被发起方（也就是
//! 真正被写进信任的那一侧）可以完全不看数字——而攻击者替换公钥时，
//! 恰恰需要「有一端没看」。两端各点一次，攻击者就必须同时骗过两双眼睛。
//!
//! 「谁先点都行」：先点的一侧只是把会话标记成已确认，等对方那边也点上才落库
//! （见 [`commit_allowed`]）。这条也是给用户看的原话，写在 `RcPairPin.tsx` 里。

use crate::data_store::DataStore;
use crate::lan_pair::{PairRole, PendingPair};
use crate::sync::presence::WireKind;
use serde::Serialize;
use std::sync::Mutex;

/// 一轮配对最多撑多久（秒）。**复用** `lan_pair` 的那个 60，
/// 两套「附近设备配对」用同一个数字，用户不会看到两种行为。
pub use crate::lan_pair::PAIR_WINDOW_SECS;

/// 多久没收到对方回应就重发一次（毫秒）。
///
/// UDP 会丢包，而配对只有一次机会（60 秒窗口）。1.5 秒是「明显早于用户开始怀疑」
/// 与「不至于把组播刷爆」之间的折中。
///
/// ❗ 重发**由界面开着的那个轮询驱动**（[`Pairs::due_resend`] 的调用方是
/// `rc_nearby_status`）。界面关着就不重发——这是刻意的：没有人在看的配对
/// 本来就不该继续往后推（用户已经走开了）。
const RESEND_MS: i64 = 1_500;

/// 一次状态推进之后该发出去的包。
///
/// 换成枚举而**不是直接在这里发包**：本模块只管状态机（可无网络单测），
/// 「怎么发」在 `rc/discovery.rs`。
#[derive(Debug, Clone, PartialEq)]
pub enum Outgoing {
    /// 什么都不用发。
    None,
    /// 发一份定向握手包。
    Packet {
        kind: WireKind,
        peer_id: String,
        pk: String,
    },
}

/// 给界面看的当前配对（`rc_nearby_status` 返回里的一项）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PairPrompt {
    pub peer_id: String,
    /// 对方**自报**的名字（可自称）。界面上要与指纹一起显示。
    pub peer_name: String,
    /// 6 位数字；空串 = 还在等对方的公钥（界面显示「正在与对方核对…」）。
    pub pin: String,
    /// 本端是不是发起方。只用来决定文案（「已向对方发出请求」/「对方想与你配对」）。
    pub initiator: bool,
    /// 本端已点确认。
    pub me_ok: bool,
    /// 对方已回「我这侧也确认了」。
    pub peer_ok: bool,
    pub started_ms: i64,
}

/// 刚配对成功的那一台，供完成屏显示（「已与 X 配对 / 立刻发起远程」）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Done {
    pub peer_id: String,
    pub peer_name: String,
    /// 本端是不是发起方。
    ///
    /// ❗ 完成屏的文案分两套（发起方有「立刻发起远程」，被配对方要说明
    /// 「每次仍需要你点头」），而这个字段**只能由后端给**：`pair` 在落库的那一刻
    /// 就被清掉了，界面再想从 [`PairPrompt::initiator`] 推，就得赌自己在上一次轮询里
    /// 恰好看到过它——两端确认可能落在同一次 2 秒轮询的间隙里。
    pub initiator: bool,
    pub at_ms: i64,
}

/// 一次「本端确认」的结局。
#[derive(Debug, Clone, PartialEq)]
pub enum Confirmed {
    /// 本端点了确认，但对方还没点——等他。
    Waiting { peer_id: String },
    /// 两端都确认了：**已经写进 `rc_devices`**。
    Committed { peer_id: String, peer_name: String },
    /// 会话已过期（或被取消），这次确认落空。
    Gone,
}

/// 一轮进行中的配对。
struct Session {
    /// ❗ 复用 `lan_pair` 的会话：临时密钥生成、X25519 协商、pin 摘要、
    /// 60 秒有效期都在那边，已经不重写第二遍。
    pair: PendingPair,
    initiator: bool,
    /// 对方已回「我这侧也确认了」。
    peer_ok: bool,
    started_ms: i64,
    /// 上一次往对方发握手包的时刻（重传判据）。
    last_sent_ms: i64,
}

impl Session {
    fn prompt(&self) -> PairPrompt {
        PairPrompt {
            peer_id: self.pair.peer_id.clone(),
            peer_name: self.pair.peer_name.clone(),
            pin: self.pair.pin.clone(),
            initiator: self.initiator,
            me_ok: self.pair.confirmed,
            peer_ok: self.peer_ok,
            started_ms: self.started_ms,
        }
    }

    /// 6 位数字算出来了吗（= 双方公钥都到手）。
    fn pin_ready(&self) -> bool {
        self.pair.shared.is_some()
    }

    /// 这一轮过期了吗。**按毫秒判**（本模块统一用毫秒）。
    ///
    /// 🔴 这里刻意**不调** [`PendingPair::expired`]：那个函数的时间戳是**秒**
    /// （`lan_pair` 全模块都是秒），而 rc 这边一路都是毫秒。混着用会把
    /// 「60 秒的窗口」当成「60 毫秒」——任何两次间隔超过 60ms 的操作都被判过期。
    /// 2026-09-17 写这一版时真踩到了：`同一台重复请求时复用会话数字不变`
    /// 那条测试第一次就是被这个坑掉的（两端数字莫名其妙不一样，因为中间
    /// 悄悄重建了会话）。判据只留这一处，单位只有一个。
    fn expired(&self, now_ms: i64) -> bool {
        now_ms - self.started_ms > PAIR_WINDOW_SECS * 1000
    }
}

/// 什么情况下允许写 `rc_devices`。
///
/// 抽成**纯函数**是为了能在无网络、无库的环境下把这条不变量钉死
/// （规则 11.1：需要运行环境的部分与纯判断分开）。
///
/// # 🔴 这里没有「两端数字相同」这一条，不是漏了
///
/// 系统验不了它——「两端看到的数字一样」只有用户的眼睛能确认，而那正是
/// 「各自点一次确认」这一步存在的全部意义。函数名说的是**谁确认了**，
/// 不是**数字对不对**，免得后人以为这里该补一个比较。
pub fn commit_allowed(me_ok: bool, peer_ok: bool, pin_ready: bool, expired: bool) -> bool {
    me_ok && peer_ok && pin_ready && !expired
}

/// 该不该重发、重发哪一种。纯函数（时间由调用方传入）。
///
/// 两种要重发的情况：
/// - **发起方还没拿到对方的公钥**（`pin_req` 丢了）→ 重发 `pin_req`
/// - **本端确认了、对方还没确认**（`pin_ok` 丢了）→ 重发 `pin_ok`
///
/// ❗ 已经拿到双方公钥、且本端还没点确认的**不重发**：那时球在用户手里
/// （他在看数字），不是网络问题。
pub fn should_resend(
    initiator: bool,
    pin_ready: bool,
    me_ok: bool,
    peer_ok: bool,
    last_sent_ms: i64,
    now_ms: i64,
) -> Option<WireKind> {
    if now_ms - last_sent_ms < RESEND_MS {
        return None;
    }
    if initiator && !pin_ready {
        return Some(WireKind::PinReq);
    }
    if me_ok && !peer_ok {
        return Some(WireKind::PinOk);
    }
    None
}

/// 本机当前的配对会话 + 最近一次成功。
pub struct Pairs {
    store: DataStore,
    cur: Mutex<Option<Session>>,
    done: Mutex<Option<Done>>,
}

impl Pairs {
    pub fn new(store: DataStore) -> Self {
        Self {
            store,
            cur: Mutex::new(None),
            done: Mutex::new(None),
        }
    }

    /// 本端发起：开一个会话，把「该发 `pin_req`」告诉调用方。
    ///
    /// 同一时刻只允许一轮配对（同 `lan_pair` 的理由：两个数字同时弹出来，
    /// 用户分不清谁是谁）。已经有会话时**先清掉旧的**——发起是用户的显式动作，
    /// 按最后一次意图走比拒绝更符合预期。
    ///
    /// ❗ 不带「本机名字」参数：那是**发出去的那份包**要填的字段
    /// （ [`Outgoing`] 只管状态机、不管线上格式），由发送方补齐。
    pub fn start(
        &self,
        peer_id: &str,
        peer_name: &str,
        now_ms: i64,
    ) -> Result<(PairPrompt, Outgoing), String> {
        if peer_id.is_empty() {
            return Err("没选中要配对的设备".to_string());
        }
        let s = Session {
            pair: PendingPair::start(
                peer_id,
                &fallback_name(peer_id, peer_name),
                PairRole::Initiator,
                to_secs(now_ms),
            )?,
            initiator: true,
            peer_ok: false,
            started_ms: now_ms,
            last_sent_ms: now_ms,
        };
        let out = Outgoing::Packet {
            kind: WireKind::PinReq,
            peer_id: peer_id.to_string(),
            pk: s.pair.my_pk.clone(),
        };
        let prompt = s.prompt();
        *self.cur.lock().unwrap_or_else(|p| p.into_inner()) = Some(s);
        Ok((prompt, out))
    }

    /// 收到对方的 `pin_req`：开一个会话并**立刻**算得出数字（公钥随包到了）。
    ///
    /// 返回 `None` = 这一份不该理（正在与另一台配对，或对方公钥是垃圾）。
    pub fn on_req(
        &self,
        peer_id: &str,
        peer_name: &str,
        peer_pk: &str,
        now_ms: i64,
    ) -> Option<(PairPrompt, Outgoing)> {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = guard.as_mut() {
            if s.expired(now_ms) {
                // 过期会话不算数：当作没有，下面重建一个。
                *guard = None;
            } else if s.pair.peer_id != peer_id {
                // 正在与另一台配对。**不动**当前会话——用户正看着那边的数字。
                return None;
            } else {
                // 同一台重复发 `pin_req`，可能有两种来由：
                // ① UDP 重传；② **两边几乎同时点了「配对」**，各自都以为自己是发起方。
                // 两种都靠同一手处理：用对方的公钥把协商补完（没补过才补），
                // 再把我的公钥回过去。**绝不新开会话**——重新协商会让数字变掉，
                // 用户刚看到的数字一转眼就对不上了。
                if !s.pin_ready() {
                    s.pair.accept_peer_key(peer_pk).ok()?;
                }
                let out = Outgoing::Packet {
                    kind: WireKind::PinResp,
                    peer_id: peer_id.to_string(),
                    pk: s.pair.my_pk.clone(),
                };
                return Some((s.prompt(), out));
            }
        }
        let mut s = Session {
            pair: PendingPair::start(
                peer_id,
                &fallback_name(peer_id, peer_name),
                PairRole::Responder,
                to_secs(now_ms),
            )
            .ok()?,
            initiator: false,
            peer_ok: false,
            started_ms: now_ms,
            last_sent_ms: now_ms,
        };
        // 协商失败（对方公钥格式不对）就当没这回事——不能留一个永远算不出数字的会话。
        s.pair.accept_peer_key(peer_pk).ok()?;
        let out = Outgoing::Packet {
            kind: WireKind::PinResp,
            peer_id: peer_id.to_string(),
            pk: s.pair.my_pk.clone(),
        };
        let prompt = s.prompt();
        *guard = Some(s);
        Some((prompt, out))
    }

    /// 收到对方的 `pin_resp`：完成协商，数字这时才出得来。
    ///
    /// 返回 `true` = 收下了（调用方据此通知界面「数字来了」）。
    pub fn on_resp(&self, peer_id: &str, peer_pk: &str, now_ms: i64) -> bool {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        let Some(s) = guard.as_mut() else {
            return false;
        };
        if s.pair.peer_id != peer_id || !s.initiator || s.pin_ready() {
            return false;
        }
        if s.expired(now_ms) {
            return false;
        }
        s.pair.accept_peer_key(peer_pk).is_ok()
    }

    /// 收到对方的 `pin_ok`：他那侧也点过确认了。
    ///
    /// 返回 `Some(Confirmed)` = 该落库了（本端也确认过时），调用方拿去写库。
    pub fn on_ok(&self, peer_id: &str, now_ms: i64) -> Option<Confirmed> {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        let s = guard.as_mut()?;
        if s.pair.peer_id != peer_id || s.expired(now_ms) {
            return None;
        }
        s.peer_ok = true;
        if commit_allowed(s.pair.confirmed, s.peer_ok, s.pin_ready(), false) {
            let id = s.pair.peer_id.clone();
            let name = s.pair.peer_name.clone();
            let initiator = s.initiator;
            *guard = None;
            return Some(self.commit(&id, &name, initiator, now_ms));
        }
        None
    }

    /// 本端点了「两边一样，确认」。返回 `Outgoing` 让调用方把 `pin_ok` 发出去。
    pub fn confirm(&self, now_ms: i64) -> (Confirmed, Outgoing) {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        let Some(s) = guard.as_mut() else {
            return (Confirmed::Gone, Outgoing::None);
        };
        if s.expired(now_ms) {
            *guard = None;
            return (Confirmed::Gone, Outgoing::None);
        }
        s.pair.confirmed = true;
        let id = s.pair.peer_id.clone();
        let out = Outgoing::Packet {
            kind: WireKind::PinOk,
            peer_id: id.clone(),
            pk: String::new(),
        };
        if commit_allowed(s.pair.confirmed, s.peer_ok, s.pin_ready(), false) {
            let name = s.pair.peer_name.clone();
            let initiator = s.initiator;
            *guard = None;
            return (self.commit(&id, &name, initiator, now_ms), Outgoing::None);
        }
        (Confirmed::Waiting { peer_id: id }, out)
    }

    /// 取消（本端按钮，或对方取消后这边的收尾）。已落库的不受影响。
    pub fn cancel(&self, peer_id: &str) -> bool {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(s) if s.pair.peer_id == peer_id => {
                *guard = None;
                true
            }
            _ => false,
        }
    }

    /// 当前会话。**顺带做过期清理**：没有人在等的话，不该让一个 60 秒前的
    /// 会话继续挂在界面上（用户看到的是一个永远不动的数字）。
    pub fn prompt(&self, now_ms: i64) -> Option<PairPrompt> {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = guard.as_ref() {
            if s.expired(now_ms) {
                log::info!(
                    "[RC] 与 {} 的配对会话超时（{} 秒），已作废",
                    short_id(&s.pair.peer_id),
                    PAIR_WINDOW_SECS
                );
                *guard = None;
                return None;
            }
        }
        guard.as_ref().map(|s| s.prompt())
    }

    /// 界面轮询时顺手重发（见 [`should_resend`]）。没到点返回 [`Outgoing::None`]。
    pub fn due_resend(&self, now_ms: i64) -> Outgoing {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        let Some(s) = guard.as_mut() else {
            return Outgoing::None;
        };
        let Some(kind) = should_resend(
            s.initiator,
            s.pin_ready(),
            s.pair.confirmed,
            s.peer_ok,
            s.last_sent_ms,
            now_ms,
        ) else {
            return Outgoing::None;
        };
        s.last_sent_ms = now_ms;
        Outgoing::Packet {
            kind,
            peer_id: s.pair.peer_id.clone(),
            pk: if kind == WireKind::PinReq {
                s.pair.my_pk.clone()
            } else {
                String::new()
            },
        }
    }

    /// 会话归零（通道停了、或本机换了一套配对）。
    pub fn clear(&self) {
        if let Ok(mut g) = self.cur.lock() {
            *g = None;
        }
    }

    /// 最近一次配对成功（完成屏用）。`take` 语义：读完即清，不会反复弹。
    pub fn take_done(&self) -> Option<Done> {
        self.done.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    /// 落库：**两台机器各自写自己那份** `rc_devices`。
    ///
    /// `initiator` 当成参数传进来而不是在会话里现取：两个调用点都在调本函数**之前**
    /// 就把会话从 `cur` 里摘掉了（不然过期会话会被下一次 `on_ok` 再落一次库），
    /// 所以这几个字段必须在摘掉之前一起取出来——`peer_id` / `peer_name` 也是这个道理。
    ///
    /// 写失败不清洗用户：错误往上报，会话已经结束了（再点确认没意义）。
    fn commit(&self, peer_id: &str, peer_name: &str, initiator: bool, now_ms: i64) -> Confirmed {
        if let Err(e) = self.store.rc_device_pair(peer_id, peer_name) {
            log::error!(
                "[RC] 与 {} 的配对核对通过，但写入设备列表失败：{}",
                short_id(peer_id),
                e
            );
            return Confirmed::Gone;
        }
        log::info!(
            "[RC] 已与 {}（{}）完成局域网配对——两端数字核对一致",
            short_id(peer_id),
            peer_name
        );
        *self.done.lock().unwrap_or_else(|p| p.into_inner()) = Some(Done {
            peer_id: peer_id.to_string(),
            peer_name: peer_name.to_string(),
            initiator,
            at_ms: now_ms,
        });
        Confirmed::Committed {
            peer_id: peer_id.to_string(),
            peer_name: peer_name.to_string(),
        }
    }
}

/// node_id 前 8 位，日志与兜底名字用（全 64 位太长，日志里没人读）。
fn short_id(node_id: &str) -> String {
    node_id.chars().take(8).collect()
}

/// 毫秒 → 秒。
///
/// 🔴 只用于**喂给 `lan_pair` 的结构体**：那个模块的时间戳全是秒
/// （`NearbyDevice.last_seen`、`PendingPair.started_at`），而 rc 这边一路都是毫秒。
/// 转换收口在这一个函数里，别散在各调用点——散着写的结果就是把 60 秒的窗口
/// 当成 60 毫秒（2026-09-17 真踩到，见 [`Session::expired`] 的注释）。
fn to_secs(ms: i64) -> i64 {
    ms / 1000
}

/// 对方自报的名字为空时退回短指纹——**别在列表里留一个空白行**。
///
/// 名单来自对方的招呼包，而「对方还没发过招呼包，却先收到了它的 `pin_req`」
/// 是可能发生的（招呼包丢了）。这时至少让人看到 `abababab` 这样一串能对上
/// 设备列表里指纹的东西，而不是一片空白。
fn fallback_name(peer_id: &str, peer_name: &str) -> String {
    if peer_name.trim().is_empty() {
        short_id(peer_id)
    } else {
        peer_name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> DataStore {
        DataStore::new(":memory:").expect("open store")
    }

    const T0: i64 = 1_757_000_000_000;

    /// 🔴 全组最要紧的一条：**两端拿到同一个公钥，数字就必须一样**。
    /// 这就是「用户对一眼数字」能成立的全部前提。
    #[test]
    fn 走完一轮握手两端数字一致且是六位() {
        let a = Pairs::new(store());
        let b = Pairs::new(store());
        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!("发起方要发 pin_req");
        };
        // B 收到 pin_req
        let (pb, out_b) = b
            .on_req("aa", "台式机", &pk_a, T0 + 10)
            .expect("应答方要接");
        assert_eq!(pb.pin.len(), 6, "数字从第一次就能显示（公钥随包到了）");
        let Outgoing::Packet {
            kind: k, pk: pk_b, ..
        } = out_b
        else {
            panic!("应答方要回 pin_resp");
        };
        assert_eq!(k, WireKind::PinResp);
        // A 收到 pin_resp
        assert!(a.on_resp("bb", &pk_b, T0 + 20), "协商要成功");

        assert_eq!(
            a.prompt(T0 + 20).unwrap().pin,
            b.prompt(T0 + 20).unwrap().pin,
            "两端数字必须一样——不一样用户就会点取消，而这是唯一能挡住中间人的机制"
        );
    }

    /// 中间人换了公钥 → 两端算出**不同**的共享值 → 数字对不上。
    /// 这一条是「6 位数字能挡主动替换」的证明；它红了就说明整条路的安全前提没了。
    #[test]
    fn 有人换过公钥时两端数字必须不同() {
        let a = Pairs::new(store());
        let b = Pairs::new(store());
        let 中间人 = Pairs::new(store());

        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!("要发 pin_req");
        };
        // 中间人把自己的一份会话起起来，拿到自己的公钥
        let (_, mitm_out) = 中间人.start("cc", "谁", T0).unwrap();
        let Outgoing::Packet { pk: mitm_pk, .. } = mitm_out else {
            panic!("要发 pin_req");
        };

        // B 以为收到的是 A 的公钥，其实是中间人的
        let (pb, _) = b.on_req("aa", "台式机", &mitm_pk, T0 + 10).unwrap();
        let _ = pk_a;
        // A 侧拿到 B 的真实公钥
        let pk_b = {
            let g = b.cur.lock().unwrap();
            g.as_ref().unwrap().pair.my_pk.clone()
        };
        assert!(a.on_resp("bb", &pk_b, T0 + 20));

        let pa = a.prompt(T0 + 20).unwrap();
        assert_eq!(pb.pin.len(), 6);
        assert_ne!(
            pa.pin, pb.pin,
            "被换了公钥之后两端数字必须不同——相同就说明这层防护是假的"
        );
    }

    /// 单独一端点确认**不能**落库。两端各点一次才算数。
    #[test]
    fn 只有一端确认时不落库() {
        let s = store();
        let a = Pairs::new(s.clone());
        let b = Pairs::new(store());
        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!()
        };
        let (_, out_b) = b.on_req("aa", "台式机", &pk_a, T0).unwrap();
        let Outgoing::Packet { pk: pk_b, .. } = out_b else {
            panic!()
        };
        assert!(a.on_resp("bb", &pk_b, T0));

        // A 先点确认：等对方
        let (res, out) = a.confirm(T0 + 1);
        assert_eq!(
            res,
            Confirmed::Waiting {
                peer_id: "bb".to_string()
            }
        );
        assert!(matches!(
            out,
            Outgoing::Packet {
                kind: WireKind::PinOk,
                ..
            }
        ));
        assert!(
            s.rc_device_get("bb").unwrap().is_none(),
            "一端点了确认就落库 = 被加入信任的那一侧根本没看过数字"
        );

        // B 点确认（它那侧数字已经出来了）
        let (res_b, _) = b.confirm(T0 + 2);
        assert_eq!(
            res_b,
            Confirmed::Waiting {
                peer_id: "aa".to_string()
            }
        );

        // A 收到 B 的 pin_ok → 这下该落库了
        assert_eq!(
            a.on_ok("bb", T0 + 3),
            Some(Confirmed::Committed {
                peer_id: "bb".to_string(),
                peer_name: "笔记本".to_string()
            })
        );
        assert!(
            s.rc_device_get("bb").unwrap().is_some(),
            "两端都确认过就该写进设备列表"
        );
    }

    /// 反过来也成立：先收到对方的 `pin_ok`，本端点确认时当场落库。
    #[test]
    fn 先收到对方确认时本端点确认当场落库() {
        let s = store();
        let a = Pairs::new(s.clone());
        let b = Pairs::new(store());
        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!()
        };
        let (_, out_b) = b.on_req("aa", "台式机", &pk_a, T0).unwrap();
        let Outgoing::Packet { pk: pk_b, .. } = out_b else {
            panic!()
        };
        assert!(a.on_resp("bb", &pk_b, T0));

        b.confirm(T0 + 1);
        // A 先收到对方的 pin_ok（A 自己还没点）
        assert_eq!(a.on_ok("bb", T0 + 2), None, "本端没确认，还不该落库");
        assert!(s.rc_device_get("bb").unwrap().is_none());

        let (res, out) = a.confirm(T0 + 3);
        assert_eq!(
            res,
            Confirmed::Committed {
                peer_id: "bb".to_string(),
                peer_name: "笔记本".to_string()
            }
        );
        assert_eq!(out, Outgoing::None, "落库了就不用再发 pin_ok");
        assert!(s.rc_device_get("bb").unwrap().is_some());
    }

    /// 超时的会话：确认落空、界面也不再显示。
    #[test]
    fn 会话超时就不认了() {
        let a = Pairs::new(store());
        a.start("bb", "笔记本", T0).unwrap();
        let late = T0 + (PAIR_WINDOW_SECS + 1) * 1000;
        assert_eq!(a.prompt(late), None, "超时的会话不该继续挂在界面上");
        assert_eq!(a.confirm(late).0, Confirmed::Gone);
    }

    /// 🔴 窗口的单位是**秒**，换算成毫秒时才判得对。
    ///
    /// 这条是给「把 60 秒当成 60 毫秒」那个坑立的钉子（`Session::expired` 的注释
    /// 记着它当时怎么暴露的：两端数字莫名其妙不一样）。它红了 = 单位又混了。
    #[test]
    fn 毫秒时间戳下窗口仍然按秒算() {
        let a = Pairs::new(store());
        a.start("bb", "笔记本", T0).unwrap();
        // 59 秒：还在
        assert!(
            a.prompt(T0 + 59_000).is_some(),
            "59 秒没过期——写成毫秒判的话这里就已经被清掉了"
        );
        // 61 秒：过期
        assert!(a.prompt(T0 + 61_000).is_none(), "61 秒该过期");
    }

    /// 同一台重复发 `pin_req`（UDP 重传）要**复用**会话，不能重新协商
    /// ——重新协商会让数字变掉，用户刚看到的数字一转眼就对不上。
    #[test]
    fn 同一台重复请求时复用会话数字不变() {
        let a = Pairs::new(store());
        let b = Pairs::new(store());
        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!()
        };
        let (p1, _) = b.on_req("aa", "台式机", &pk_a, T0).unwrap();
        let (p2, out2) = b.on_req("aa", "台式机", &pk_a, T0 + 100).unwrap();
        assert_eq!(p1.pin, p2.pin, "重传不能让数字变");
        assert!(matches!(
            out2,
            Outgoing::Packet {
                kind: WireKind::PinResp,
                ..
            }
        ));
    }

    /// 正在与 A 配对时，C 来敲门**不该**把 A 的会话顶掉（用户正看着 A 的数字）。
    #[test]
    fn 正在配对时别人来敲门不打断() {
        let b = Pairs::new(store());
        let a = Pairs::new(store());
        let c = Pairs::new(store());
        let (_, oa) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = oa else {
            panic!()
        };
        let (pa, _) = b.on_req("aa", "台式机", &pk_a, T0).unwrap();

        let (_, oc) = c.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_c, .. } = oc else {
            panic!()
        };
        assert!(b.on_req("cc", "另一台", &pk_c, T0 + 10).is_none());
        assert_eq!(
            b.prompt(T0 + 10).unwrap().peer_id,
            "aa",
            "当前会话必须还是 A 的"
        );
        assert_eq!(b.prompt(T0 + 10).unwrap().pin, pa.pin);
    }

    /// 对方公钥格式不对（被篡改成垃圾）时不要留一个永远算不出数字的会话。
    #[test]
    fn 对方公钥是垃圾时不留会话() {
        let b = Pairs::new(store());
        assert!(b.on_req("aa", "台式机", "这不是公钥", T0).is_none());
        assert!(b.prompt(T0).is_none(), "不能留一个永远算不出数字的会话");
    }

    /// 判据本身（纯函数）：四条都得成立。
    #[test]
    fn 落库判据四条缺一不可() {
        assert!(commit_allowed(true, true, true, false));
        assert!(!commit_allowed(false, true, true, false), "本端没确认");
        assert!(!commit_allowed(true, false, true, false), "对方没确认");
        assert!(!commit_allowed(true, true, false, false), "公钥还没到手");
        assert!(!commit_allowed(true, true, true, true), "会话过期了");
    }

    /// 重传判据（纯函数）：只有「公钥没到手」与「我确认了他没确认」两种该重发。
    #[test]
    fn 重传判据只在两种情况下为真() {
        // 发起方还没拿到对方公钥 → 重发 pin_req
        assert_eq!(
            should_resend(true, false, false, false, T0, T0 + RESEND_MS),
            Some(WireKind::PinReq)
        );
        // 本端确认了、对方没确认 → 重发 pin_ok
        assert_eq!(
            should_resend(true, true, true, false, T0, T0 + RESEND_MS),
            Some(WireKind::PinOk)
        );
        // 球在用户手里（数字已经显示、本端还没点确认）→ 不重发
        assert_eq!(
            should_resend(true, true, false, false, T0, T0 + RESEND_MS),
            None
        );
        // 两端都确认完了 → 不重发
        assert_eq!(
            should_resend(true, true, true, true, T0, T0 + RESEND_MS),
            None
        );
        // 还没到重传间隔 → 不重发
        assert_eq!(
            should_resend(true, false, false, false, T0, T0 + RESEND_MS - 1),
            None
        );
        // 应答方不重发 pin_req（它一开始就有对方的公钥）
        assert_eq!(
            should_resend(false, false, false, false, T0, T0 + RESEND_MS),
            None
        );
    }

    /// 取消之后会话就没了，界面不该再显示数字。
    #[test]
    fn 取消之后不再有会话() {
        let a = Pairs::new(store());
        a.start("bb", "笔记本", T0).unwrap();
        assert!(a.cancel("bb"));
        assert!(a.prompt(T0 + 1).is_none());
        assert_eq!(a.confirm(T0 + 1).0, Confirmed::Gone);
    }

    /// 落库成功之后完成屏能拿到「刚配了谁」，而且**只拿到一次**。
    #[test]
    fn 完成屏信息读一次就清() {
        let s = store();
        let a = Pairs::new(s.clone());
        let b = Pairs::new(store());
        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!()
        };
        let (_, out_b) = b.on_req("aa", "台式机", &pk_a, T0).unwrap();
        let Outgoing::Packet { pk: pk_b, .. } = out_b else {
            panic!()
        };
        assert!(a.on_resp("bb", &pk_b, T0));
        a.confirm(T0 + 1);
        a.on_ok("bb", T0 + 2);

        let d = a.take_done().expect("应该有完成信息");
        assert_eq!(d.peer_id, "bb");
        assert_eq!(d.peer_name, "笔记本");
        assert_eq!(d.at_ms, T0 + 2);
        assert!(d.initiator, "A 是发起方（它 start 的）");
        assert!(a.take_done().is_none(), "读完即清，不能反复弹完成屏");
        assert!(s.rc_device_get("bb").unwrap().is_some());
    }

    /// 🔴 完成屏的文案靠 `initiator` 分流，而它**只能由后端给**。
    ///
    /// 落库那一刻 `pair` 就被清掉了，界面再想从 `PairPrompt` 推就得赌自己在上一次
    /// 轮询里恰好看到过它——两端确认可能落在同一次 2 秒轮询的间隙里。
    /// 这条把「应答方那边它是 false」钉住：反了的话被配对方会被劝去「立刻发起远程」。
    #[test]
    fn 完成屏能分清谁是发起方() {
        let a = Pairs::new(store());
        let b = Pairs::new(store());
        // B 侧也叫 "bb"（它眼里对端才是 aa），两边各自记自己那份
        let (_, out) = a.start("bb", "笔记本", T0).unwrap();
        let Outgoing::Packet { pk: pk_a, .. } = out else {
            panic!()
        };
        let (_, out_b) = b.on_req("aa", "台式机", &pk_a, T0).unwrap();
        let Outgoing::Packet { pk: pk_b, .. } = out_b else {
            panic!()
        };
        assert!(a.on_resp("bb", &pk_b, T0));

        // B（应答方）先点确认 → 等 A
        b.confirm(T0 + 1);
        // A 收到 B 的 pin_ok，但 A 自己还没点 → 还不落库
        assert_eq!(a.on_ok("bb", T0 + 2), None);
        // A 点确认 → A 落库
        a.confirm(T0 + 3);
        // B 收到 A 的 pin_ok → B 落库
        b.on_ok("aa", T0 + 4);

        let da = a.take_done().expect("A 应该有完成信息");
        assert!(da.initiator, "A 点的是「配对」，它是发起方");
        assert_eq!(da.peer_id, "bb");

        let db = b.take_done().expect("B 应该有完成信息");
        assert!(!db.initiator, "B 是被请求的那一侧");
        assert_eq!(db.peer_id, "aa");
    }

    /// 自己跟自己（同 node_id）不该能配起来——组播会回环，这是必然出现的一份包。
    #[test]
    fn 空对端id直接被拒() {
        let a = Pairs::new(store());
        assert!(a.start("", "", T0).is_err());
    }

    /// 没名字的邻居用短指纹兜底，列表里不留空白。
    #[test]
    fn 没名字时用短指纹兜底() {
        let a = Pairs::new(store());
        let (p, _) = a.start(&"ab".repeat(6), "", T0).unwrap();
        assert_eq!(p.peer_name, "abababab");
        assert_eq!(p.peer_name.len(), 8);
    }
}
