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
//!
//! # 🔴 P1-1：`pin_ok` 必须带共享秘密证明
//!
//! 线上签名只盖 `node_id|port|ts`（`presence::wire::signing_bytes` **不能扩**，
//! 扩了会废掉与旧版的互通——那里的模块注释有论证）。于是中间人可以**偷换
//! `kind`/`to_id`**：拿任意一份合法签名包改成 `pin_ok`，冒充「他那侧也确认了」，
//! 在本端已点过确认时把设备提前写进信任表。
//!
//! 对策是给 `WireKind::PinOk` 加**附加证明** `ok_proof` =
//! HMAC-SHA256(X25519 shared 派生值, `"pin-ok"|node_id|to_id|ts`)：
//! 不知道 shared 就算不出来。接收端 [`Pairs::on_ok`] **只认带合法 proof 的**，
//! 无 proof / 错 proof 一律不置 `peer_ok` ⇒ [`commit_allowed`] 进不去。
//!
//! **残余风险（有意不覆盖）**：`PinReq`/`PinResp` 的 `pk` 仍在签名外，中间人
//! 仍可偷换公钥。那条路的检测靠两端 6 位数字人眼核对（SAS）——系统验不了
//! 「两端显示的数字一样」，这是本方案的边界，不是遗漏。

use crate::data_store::DataStore;
use crate::lan_pair::{hex, hkdf32, PairRole, PendingPair};
use crate::sync::presence::WireKind;
use serde::Serialize;
use std::sync::Mutex;

/// 一轮配对最多撑多久（秒）。**复用** `lan_pair` 的那个 60，
/// 两套「附近设备配对」用同一个数字，用户不会看到两种行为。
pub use crate::lan_pair::PAIR_WINDOW_SECS;

/// 🔴 P1-7（2026-09-23 审计）：完成屏（[`Done`]）的多重可读窗口（毫秒）。
///
/// 60 秒不是随手取的：与配对窗口 `PAIR_WINDOW_SECS` 同长——用户在配对流程里
/// 最迟 60 秒就该走完了（成功屏正是那一步的收尾），再晚看到的就是旧闻。
/// 单位用毫秒是因为读侧传进来的 `now_ms` 是毫秒；写成一个 `* 1000` 的表达式
/// 反倒多出一次换算、多一处能写错的地方。
pub const DONE_VISIBLE_MS: i64 = 60_000;

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
    /// 🔴 P3-1（2026-09-25 审计）：两端核对都过了，但**本机写入设备列表失败**。
    ///
    /// 旧实现把它折叠成 `Gone`（「落空」）——可实际是个**半状态**：会话已清、
    /// 本端的 `pin_ok` 仍会送达（对端多半已配好），唯独本机没落库。界面按
    /// 「落空」处理会让用户以为什么都没发生。单独成变体后，调用方据此报
    /// 可行动的错误（见 `discovery::confirm` 的映射话术）。
    StoreFailed { peer_id: String, peer_name: String },
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

/// 本机当前的配对会话 + 最近一次成功。
pub struct Pairs {
    store: DataStore,
    cur: Mutex<Option<Session>>,
    done: Mutex<Option<Done>>,
    /// 🔴 再审计 A2（2026-09-25）：commit 分支的 pin_ok 在**会话已清**之后才由
    /// discovery 发出，而证明要等发包那一刻才算（绑定发包 ts，见 make_extras）。
    /// 落库那一刻把 `(peer_id, shared)` 暂存到这个一次性槽位，
    /// [`Self::pin_ok_proof_for`] 在会话路由落空时消费它。没被消费（发包失败）
    /// 就留到下一次配对 `start()` 清掉——旧 shared 算出的证明对新对端必然
    /// 验不过，无安全影响。
    just_committed: Mutex<Option<(String, Vec<u8>)>>,
}

impl Pairs {
    pub fn new(store: DataStore) -> Self {
        Self {
            store,
            cur: Mutex::new(None),
            done: Mutex::new(None),
            just_committed: Mutex::new(None),
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
        // 上一轮 commit 留下的一次性证明材料随新会话作废（见 just_committed 注释）
        *self
            .just_committed
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
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
    /// # 🔴 P1-1：先验 `ok_proof`，再谈确认
    ///
    /// 签名只盖 `node_id|port|ts`（`wire::signing_bytes` 不能扩），中间人可
    /// 偷换 `kind`/`to_id` 冒充 `pin_ok`。所以：
    /// 1. 没 shared（还没协商完）→ 不认；
    /// 2. 无 proof / 错 proof → **不置 `peer_ok`**，`commit_allowed` 进不去；
    /// 3. 验过才置 `peer_ok`，后续与原先一致。
    ///
    /// 返回 `Some(Confirmed)` = 该落库了（本端也确认过时），调用方拿去写库。
    pub fn on_ok(&self, req: PinOkIn, now_ms: i64) -> Option<Confirmed> {
        let mut guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        let s = guard.as_mut()?;
        if s.pair.peer_id != req.peer_id || s.expired(now_ms) {
            return None;
        }
        let shared = s.pair.shared.as_ref()?;
        if !verify_pin_ok_proof(
            shared,
            &req.peer_id,
            &req.my_node_id,
            req.ts,
            &req.ok_proof,
        ) {
            log::warn!(
                "[RC] 伪造或过期的 pin_ok 证明，已拒绝（{}）",
                short_id(&req.peer_id)
            );
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

    /// 发送侧：算一份 `pin_ok` 证明（与 [`discovery`] 发包时同一时刻、同一材料）。
    ///
    /// `me_node_id` 是**发信人**（本机），`to_id` 取当前会话的对端。
    /// 没 shared 时返回 `None`——那种会话本就不该发 `pin_ok`，调用方应报错。
    pub fn pin_ok_proof_for(&self, me_node_id: &str, ts: i64) -> Option<String> {
        let guard = self.cur.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = guard.as_ref() {
            if let Some(shared) = s.pair.shared.as_ref() {
                return Some(pin_ok_proof(shared, me_node_id, &s.pair.peer_id, ts));
            }
        }
        drop(guard);
        // 🔴 再审计 A2：会话路由落空（commit 分支已清会话）→ 消费一次性暂存的
        // 证明材料。这是 commit 场景下 pin_ok 能带出合法证明的唯一来源。
        let mut stash = self
            .just_committed
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let (peer_id, shared) = stash.take()?;
        Some(pin_ok_proof(&shared, me_node_id, &peer_id, ts))
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
            // 🔴 再审计 A2：证明材料一次性暂存——会话马上要清，而 pin_ok 的证明
            // 要等 discovery 发包那一刻才算（绑定发包 ts）。没有这一步，commit
            // 分支返回的包在 make_extras 里算不出证明，A2 的修复就白修。
            if let Some(shared) = s.pair.shared.clone() {
                *self.just_committed.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some((id.clone(), shared));
            }
            *guard = None;
            // 对端落库依赖「收到我的 pin_ok」——我先点、他的 pin_ok 先到把我这侧
            // 推进 commit 时，他那边还在等我的回包。曾返回 `Outgoing::None` 把刚
            // 构造的包吞掉：对端干等 60s 超时，重试配对又被「已配对——忽略」挡死
            // （只有我落了库）。他自己落库走的是 `on_ok` 收到我的 pin_ok 那条路，
            // 与这里不重复。
            return (self.commit(&id, &name, initiator, now_ms), out);
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

    /// 最近一次配对成功（完成屏用）。
    ///
    /// 🔴 P1-7（2026-09-23 审计）：从「读完即清」改成「**读而不清 + 到点自灭**」。
    ///
    /// # 为什么原来的 take 是错的
    ///
    /// 这个槽有**两个并发读者**：主窗口的配对页和工作台的远程设置页各自的轮询
    /// （`rc_nearby_status` 在两边都被周期调用）。take 语义下第一个读者把
    /// `done` 拿走，第二个读者从此再也看不到成功屏——用户的感受是
    /// 「明明提示配对成功了，那个『立刻发起远程』的界面却再也没出现过」，
    /// 而且**是否出现取决于哪个窗口先读到**，无法复现。
    ///
    /// # 为什么不干脆不清
    ///
    /// 那样更坏：`done` 是「刚刚配对成功」这个**瞬时事实**，永久可读会让用户
    /// 十分钟后打开设置页又弹一次「已与 X 配对 / 立刻发起远程」，像是刚才配过一次。
    /// 所以给一个可见窗口：[`DONE_VISIBLE_MS`] 内多次可读（幂等），过期后
    /// 读到即清。谁先读到不再影响另一个读者 —— 这才是多窗口该有的语义。
    pub fn peek_done(&self, now_ms: i64) -> Option<Done> {
        let mut g = self.done.lock().unwrap_or_else(|p| p.into_inner());
        let d = g.as_ref()?;
        // 用 `>` 而不是 `>=`：正好卡在边界上还看得见（与 `nearby` 的邻居判据同口径）
        if now_ms - d.at_ms > DONE_VISIBLE_MS {
            *g = None;
            return None;
        }
        Some(d.clone())
    }

    /// 落库：**两台机器各自写自己那份** `rc_devices`。
    ///
    /// `initiator` 当成参数传进来而不是在会话里现取：两个调用点都在调本函数**之前**
    /// 就把会话从 `cur` 里摘掉了（不然过期会话会被下一次 `on_ok` 再落一次库），
    /// 所以这几个字段必须在摘掉之前一起取出来——`peer_id` / `peer_name` 也是这个道理。
    ///
    /// 写失败不清洗用户：错误往上报，会话已经结束了（再点确认没意义）。
    fn commit(&self, peer_id: &str, peer_name: &str, initiator: bool, now_ms: i64) -> Confirmed {
        match commit_outcome(self.store.rc_device_pair(peer_id, peer_name), peer_id, peer_name) {
            Ok((id, name)) => {
                *self.done.lock().unwrap_or_else(|p| p.into_inner()) = Some(Done {
                    peer_id: id,
                    peer_name: name,
                    initiator,
                    at_ms: now_ms,
                });
                Confirmed::Committed {
                    peer_id: peer_id.to_string(),
                    peer_name: peer_name.to_string(),
                }
            }
            Err((id, name)) => Confirmed::StoreFailed {
                peer_id: id,
                peer_name: name,
            },
        }
    }
}

/// 🔴 P3-1（2026-09-25 审计）：把落库结果折叠成 [`Confirmed`] 的分支
/// （纯函数，可无库单测）。拆出来是因为内存态 `DataStore` 没有可靠的
/// 「强制失败」开关——失败分支的形状（**绝不能**再返回 `Gone` 冒充落空）
/// 由单测在这里钉死。
fn commit_outcome(
    stored: Result<(), String>,
    peer_id: &str,
    peer_name: &str,
) -> Result<(String, String), (String, String)> {
    match stored {
        Ok(()) => {
            log::info!(
                "[RC] 已与 {}（{}）完成局域网配对——两端数字核对一致",
                short_id(peer_id),
                peer_name
            );
            Ok((peer_id.to_string(), peer_name.to_string()))
        }
        Err(e) => {
            log::error!(
                "[RC] 与 {} 的配对核对通过，但写入设备列表失败：{}",
                short_id(peer_id),
                e
            );
            Err((peer_id.to_string(), peer_name.to_string()))
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

mod proof;

pub use proof::*;

#[cfg(test)]
mod tests;