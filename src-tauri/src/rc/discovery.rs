//! 局域网配对：附近设备列表 + 明文包收发（A3 的接线层）。
//!
//! # 分工
//!
//! | 谁 | 管什么 |
//! |---|---|
//! | `sync::presence::{Nearby, PlainPacket}` | 收包、判包合法、攒「附近的设备」 |
//! | `rc::pin::Pairs` | 一轮配对的状态机（X25519 协商、6 位数字、什么时候落库） |
//! | 本文件 | 把两者接起来：收到什么包该喂给谁、该回什么包、怎么发出去 |
//! | `rc/service.rs` | 起通道时 [`Discovery::arm`]，停通道时 [`Discovery::disarm`] |
//!
//! 单独一个文件是因为它**既不属于收包层也不属于状态机**：本文件里唯一会变的
//! 东西是「包怎么进怎么出」，而那两个模块各有各的变更理由。
//!
//! # 🔴 为什么不能直接把 presence 的地址表当「附近设备」
//!
//! 那张表在验签之前就把未配对设备拦掉了（见 `sync::presence::Nearby` 的模块头），
//! 所以它里面**根本不会**有未配对的邻居。附近设备走的是明文招呼包那条独立通道。

use crate::data_store::DataStore;
use crate::rc::join::RcJoins;
use crate::rc::pin::{Confirmed, Done, Outgoing, PairPrompt, PinOkIn, Pairs};
use crate::sync::identity::NodeIdentity;
use crate::sync::presence::{self, Extras, Nearby, Neighbor, PlainPacket, PresenceApp, WireKind};
use std::sync::{Arc, Mutex};

/// 「这台机器已经配过对了」的判据。由调用方给（通常是查 `rc_devices` ∪ `devices`），
/// 这样本模块不依赖库，单测不用起库。
pub type PairedFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 发一份握手包要的上下文。
///
/// 收成结构体：这里有两个 `u16`（`endpoint_port` / `group_port`），
/// 位置参数下写反编译器不报错，只会「对端照着错端口拨号」——同 `PresenceStart` 的教训。
#[derive(Clone)]
struct Armed {
    me: Arc<NodeIdentity>,
    /// 本机 iroh **端点**端口（写进包，供对端拨号）。
    endpoint_port: u16,
    /// 本套 presence 的组播端口（包发往这里，也是本机在听的那个）。
    group_port: u16,
    /// 本机设备名：握手包随包自报给对方，对方拿它写进设备列表。
    ///
    /// ❗ 不靠「对方恰好听过我的招呼包」——招呼包会丢，而设备列表里留个空白名字
    /// 是最难解释的一种残缺。
    my_name: String,
}

pub struct Discovery {
    joins: Arc<RcJoins>,
    is_paired: PairedFn,
    nearby: Arc<Nearby>,
    pairs: Arc<Pairs>,
    /// 通道没起来时是 `None`：这时发不出包（**不是**静默失败，见 [`Discovery::send`]）。
    armed: Mutex<Option<Armed>>,
}

impl Discovery {
    /// `is_paired` 由调用方给（`rc_devices` ∪ `devices`），本模块不依赖库——
    /// 这样「怎么判已配对」只有一处定义，收包侧（presence）与界面侧（列表过滤）
    /// 用的是同一个闭包，不会出现「表里有、列表里没有」这种对不上的现象。
    pub fn new(store: DataStore, joins: Arc<RcJoins>, is_paired: PairedFn) -> Arc<Self> {
        Arc::new(Self {
            joins,
            is_paired,
            nearby: Nearby::new(),
            pairs: Arc::new(Pairs::new(store)),
            armed: Mutex::new(None),
        })
    }

    /// 通道起来之后挂上「怎么发」。幂等（重复调只覆盖同一份上下文）。
    pub fn arm(&self, me: Arc<NodeIdentity>, endpoint_port: u16, group_port: u16, my_name: String) {
        *self.armed.lock().unwrap_or_else(|p| p.into_inner()) = Some(Armed {
            me,
            endpoint_port,
            group_port,
            my_name,
        });
    }

    /// 通道停了。清会话与附近表，**不清设备列表**（那是落库的东西，与通道无关）。
    pub fn disarm(&self) {
        *self.armed.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.pairs.clear();
        self.nearby.clear();
    }

    /// 本机 node_id（发不出去包时给空串，只用于判「这包是不是给我的」）。
    fn my_node_id(&self) -> String {
        self.armed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|a| a.me.node_id())
            .unwrap_or_default()
    }

    /// 拼握手包的附加字段。`armed` 由调用方在**已持锁**状态下传入——
    /// 这里再 `self.armed.lock()` 会自锁（`std::sync::Mutex` 不可重入）。
    fn make_extras(&self, out: &Outgoing, armed: &Armed, now: i64) -> Option<Extras> {
        let Outgoing::Packet { kind, peer_id, pk } = out else {
            return None;
        };
        // PinOk 必须带「知道 X25519 shared」的附加证明（P1-1）。
        // 证明绑定的 ts 必须与**整包**的 ts 一致——所以在这里、和 build_kind
        // 用同一个 `now`，不能各算各的。
        let ok_proof = if *kind == WireKind::PinOk {
            Some(self.pairs.pin_ok_proof_for(&armed.me.node_id(), now)?)
        } else {
            None
        };
        Some(Extras {
            // 名字随包自报（对方写设备列表用）。招呼包之外也带上，见 `Armed::my_name`。
            name: Some(armed.my_name.clone()),
            // ❗ 只有握手那两种包带公钥。`pin_ok` 不带：它只是「我这侧确认了」，
            //   带一把空公钥会让对方的解析路径多一个「空 = 没带还是真的空」的分支。
            pk: if *kind == WireKind::PinOk {
                None
            } else {
                Some(pk.clone())
            },
            to_id: Some(peer_id.clone()),
            ok_proof,
        })
    }

    /// 发一份握手包。
    ///
    /// 🔴 失败**必须**往上报：调用它的都是用户刚点过的动作（发起 / 确认），
    /// 静默失败的表现是「对方一直没动静」，那是最难查的一类（规则 15.3）。
    fn send(&self, out: &Outgoing) -> Result<(), String> {
        let Outgoing::Packet { kind, .. } = out else {
            return Ok(()); // Outgoing::None
        };
        let (packet, group_port) = {
            let armed = self.armed.lock().unwrap_or_else(|p| p.into_inner());
            let armed = armed
                .as_ref()
                .ok_or("远程通道还没起来，局域网配对发不出去")?;
            let now = now_ms();
            let extras = self
                .make_extras(out, armed, now)
                .ok_or("配对包缺少必要字段，发不出去（PinOk 必须带证明）")?;
            let packet = presence::build_kind(
                &armed.me,
                PresenceApp::Rc,
                *kind,
                armed.endpoint_port,
                now,
                extras,
            )?;
            (packet, armed.group_port)
        };
        presence::send_all(group_port, &packet)
    }

    /// 附近设备（未配对的邻居）。已配对的不列——他们已经在设备列表里了。
    pub fn neighbors(&self, now_ms: i64) -> Vec<Neighbor> {
        self.nearby
            .list(now_ms)
            .into_iter()
            .filter(|n| !(self.is_paired)(&n.node_id))
            .collect()
    }

    pub fn prompt(&self, now_ms: i64) -> Option<PairPrompt> {
        self.pairs.prompt(now_ms)
    }

    /// 刚配对成功的那一台（完成屏）。**读完即清**，不会反复弹。
    pub fn take_done(&self) -> Option<Done> {
        self.pairs.take_done()
    }

    /// presence 收到的明文包入口（注册在 `PresenceTable::on_plain` 上）。
    pub fn handle_plain(&self, p: &PlainPacket) {
        let now = now_ms();
        let me = self.my_node_id();
        match p.kind {
            // 表已经分流过 `Addr`，这里不该出现；真出现说明 `hear` 的判据被改了。
            WireKind::Addr => log::debug!("[RC] 附近设备收到了地址公告，按设计不该走到这里"),

            WireKind::Hello => {
                if (self.is_paired)(&p.node_id) {
                    return; // 已配对的不进「附近」，否则列表与设备列表会重复
                }
                let is_new = self.nearby.note(&p.node_id, &p.name, p.src, now);
                if is_new {
                    // 只在**跃变**时记一条：招呼包是 5 秒一份的心跳
                    // （`lan_pair::HELLO_INTERVAL_SECS`），每份都记会刷屏。
                    log::info!(
                        "[RC] 附近发现设备 {}（{}，{}）",
                        short(&p.node_id),
                        if p.name.is_empty() {
                            "未命名"
                        } else {
                            &p.name
                        },
                        p.src
                    );
                }
            }

            WireKind::PinReq => {
                // 定向包：不是给我的就别理（组播上人人都收得到）。
                if p.to_id != me {
                    return;
                }
                if (self.is_paired)(&p.node_id) {
                    // 对方以为我们没配对（它那边的记录丢了？）。回一个应答把两边
                    // 拉回一致比沉默有用——但**不**重新弹窗，用户看不到任何东西。
                    log::info!(
                        "[RC] {} 又发来一次配对请求，但两边已经是配对状态了——忽略",
                        short(&p.node_id)
                    );
                    return;
                }
                if self.joins.is_denied(&p.node_id, now) {
                    // 🔴 拒绝冷却期内**不弹窗**：用户点过「取消」就是「别再来问我」。
                    //   要重新发起得等冷却过去（或用邀请码那条路）。
                    log::info!(
                        "[RC] 忽略 {} 的配对请求：本机此前拒绝过它，还在冷却期内",
                        short(&p.node_id)
                    );
                    return;
                }
                match self.pairs.on_req(&p.node_id, &p.name, &p.pk, now) {
                    Some((_prompt, out)) => {
                        if let Err(e) = self.send(&out) {
                            log::warn!("[RC] 回应配对请求失败：{}", e);
                        }
                        emit_changed();
                    }
                    // `None` = 正在与另一台配对 / 对方公钥是垃圾。都值得在日志里说清。
                    None => log::info!(
                        "[RC] 没接 {} 的配对请求（正在与另一台配对，或它给的公钥不可用）",
                        short(&p.node_id)
                    ),
                }
            }

            WireKind::PinResp => {
                if p.to_id != me {
                    return;
                }
                if self.pairs.on_resp(&p.node_id, &p.pk, now) {
                    // 数字这时才出得来，界面必须立刻显示（用户等着看它）。
                    emit_changed();
                }
            }

            WireKind::PinOk => {
                if p.to_id != me {
                    return;
                }
                // P1-1：证明材料与包内字段一起交给状态机；无/错 proof 会被拒。
                let req = PinOkIn {
                    peer_id: p.node_id.clone(),
                    my_node_id: me,
                    ts: p.ts,
                    ok_proof: p.ok_proof.clone(),
                };
                if let Some(confirmed) = self.pairs.on_ok(req, now) {
                    self.after_commit(&confirmed);
                }
            }
        }
    }

    /// 本端点了「配对」。返回的 `prompt.pin` 多半是空的（在等对方的公钥）。
    pub fn pair_start(&self, peer_id: &str, now_ms: i64) -> Result<PairPrompt, String> {
        // 🔴 **必须在附近列表里**才允许发起。两个理由：
        // ① 列表 20 秒刷新一次，用户点的那一行可能已经过期——那时对方多半
        //    已经关掉/换网，闷头发一个组播包只会得到一个永远等不到回应的数字框；
        // ② 它顺带堵住「界面凭一个凭空造的 node_id 发起配对」这条口子。
        let name = self
            .neighbors(now_ms)
            .into_iter()
            .find(|n| n.node_id == peer_id)
            .map(|n| n.name)
            .ok_or("这台设备已经不在附近了（列表每 20 秒刷新一次，请等它重新出现）")?;
        let (prompt, out) = self.pairs.start(peer_id, &name, now_ms)?;
        if let Err(e) = self.send(&out) {
            // ❗ 发失败就**不要留下一个假会话**：界面上会显示一个永远等不到回应的
            //   数字框，而真实原因是本机压根没发出去。
            self.pairs.cancel(peer_id);
            return Err(e);
        }
        Ok(prompt)
    }

    /// 本端点了「两边一样，确认」。
    pub fn confirm(&self, now_ms: i64) -> Result<Confirmed, String> {
        let (res, out) = self.pairs.confirm(now_ms);
        // `pin_ok` 发不出去时**仍要报告**：本端已经确认了，但对方不知道，
        // 用户看到的是「一直等他」——得让他知道可以点取消重来。
        if let Err(e) = self.send(&out) {
            log::warn!("[RC] 告诉对方「我这侧确认了」失败：{}", e);
            return Err(format!("没能通知对方你已确认：{}", e));
        }
        if let Confirmed::Committed { .. } = &res {
            self.after_commit(&res);
        }
        Ok(res)
    }

    /// 取消。本端是被请求的那一侧才记「拒绝冷却」——
    /// 拒绝的意思是「别再来问我」，而发起方取消只是「我不发了」，
    /// 不该让对方以后连敲门都敲不动。
    pub fn cancel(&self, now_ms: i64) -> bool {
        let Some(p) = self.pairs.prompt(now_ms) else {
            return false;
        };
        let ok = self.pairs.cancel(&p.peer_id);
        if ok && !p.initiator {
            self.joins.deny(&p.peer_id, now_ms);
        }
        ok
    }

    /// 界面轮询时顺手重传（见 `pin::should_resend`）。
    ///
    /// 重传失败**不报错**：它本来就是为了兜丢包，报错只会让界面上多一条
    /// 用户无法处理的提示。下一轮轮询还会再试。
    pub fn tick(&self, now_ms: i64) {
        let out = self.pairs.due_resend(now_ms);
        if out == Outgoing::None {
            return;
        }
        if let Err(e) = self.send(&out) {
            log::debug!("[RC] 配对包重传失败（下一轮还会再试）：{}", e);
        }
    }

    /// 落库之后：把这一台从「附近」里拿掉，告诉界面，**并立刻宣告一次自己的地址**。
    fn after_commit(&self, confirmed: &Confirmed) {
        let Confirmed::Committed { peer_id, .. } = confirmed else {
            return;
        };
        self.nearby.forget(peer_id);
        // 之前可能有它留下的敲门记录（邀请码那条路），配对成了就一起清掉。
        self.joins.take(peer_id);
        self.announce_now();
        emit_changed();
    }

    /// 立刻发一份自己的**地址公告**，不等下一个 15 秒周期。
    ///
    /// 🔴 为什么配对成功后必须喊这一嗓子：地址表**只收已配对设备**
    /// （`table::hear` 里 `is_paired` 那关在验签之前），而「已配对」是刚刚这一刻
    /// 才成立的 ⇒ 两端各自那份地址表里都还没有对方（按常规要等对方下一个 15 秒
    /// 周期的公告）。这段时间里点完成屏上的「立刻发起远程」，`RcService` 建出来的
    /// 是一个**只有 node_id、没有 IP 的 `EndpointAddr`**（`EndpointAddr::new(id)`
    /// 拼上一个空的 `addrs_of`）⇒ iroh 回落 n0 公共中继：同一局域网的两台机器
    /// 绕一次云端，慢，relay 不可达时直接失败。
    ///
    /// # 谁需要这一嗓子
    ///
    /// 只有**发起方**：完成屏上的「立刻发起远程」按 `RcPairDone.canStart =
    /// done.initiator` 只长在它那一侧，而它要拨的是被发起方的地址。
    /// 时序正好对得上——
    ///
    /// 1. 发起方确认 ⇒ 先发 `pin_ok`（`confirm` 里 `send` 在前），再喊自己那份；
    /// 2. 被发起方收到 `pin_ok` ⇒ 这一刻才落库（`Pairs::on_ok`），随即喊它那份；
    /// 3. 发起方早在第 1 步就落库了，所以第 2 步那份**一定能进**它的地址表。
    ///
    /// ❗ 反向不保证：第 1 步那份可能赶在被发起方落库**之前**到达，被判成
    /// `Heard::Unpaired` 丢掉（UDP 同组播组两份包没有跨套接字的全序保证）。
    /// 不修：被发起方那侧没有「立刻发起远程」这个按钮，最多等下一个 15 秒周期，
    /// 而它要远程也只能自己走设备列表——那时早就过了。真想修就得在这里排一个
    /// 延迟重发，为一个不存在的按钮引入一个定时器不划算。
    ///
    /// 失败只记 debug：这一份只是**提前**喊，下一个周期照旧会喊。
    fn announce_now(&self) {
        // ❗ 取完参数就**放开锁**再发包，同 [`Discovery::send`]：公告要逐块网卡发，
        //   握着 `armed` 发等于让并发的 `send` / `arm` 一起等在这上面。
        //
        //   两个 `u16` 直接填进 `Announce` 的**命名字段**，不从元组里按位置取——
        //   位置参数下写反 `endpoint_port` / `group_port` 编译器不报错（同 `Armed` 的教训）。
        let (me, ann) = {
            let armed = self.armed.lock().unwrap_or_else(|p| p.into_inner());
            // 通道没起来时也没有地址可喊（`arm` 之前 `send` 一样会拒）。
            let Some(a) = armed.as_ref() else {
                return;
            };
            (
                a.me.clone(),
                presence::Announce {
                    app: PresenceApp::Rc,
                    endpoint_port: a.endpoint_port,
                    group_port: a.group_port,
                    now_ms: now_ms(),
                },
            )
        };
        if let Err(e) = presence::announce_once(&me, ann) {
            log::debug!("[RC] 配对后立刻宣告地址失败（下一个周期还会喊）：{}", e);
        }
    }
}

fn short(node_id: &str) -> String {
    node_id.chars().take(8).collect()
}

fn now_ms() -> i64 {
    super::service::now_ms()
}

/// 通知界面「配对状态变了」。
///
/// 走 `rc-session-changed`（`RcService::emit_pair_changed`）：配对是 rc 状态的一部分，
/// 而前端**已经在**监听这个事件并重读状态。为此新加一个事件要同时改
/// `lib.rs` 的注册和前端的事件表，两处都得记得改——收益对不上。
fn emit_changed() {
    if let Some(svc) = super::global() {
        svc.emit_pair_changed();
    }
}

#[cfg(test)]
mod tests {
    /// 🔴 守卫：落库之后**真的**补喊了一次地址公告。
    ///
    /// 钉的是「工具写好了、没人调」这一类事故——2026-09-17 的招呼包就是栽在这上面
    /// （`hello_packet` 收包侧全写完、发包侧一行没接，1455 条单测全绿，而「附近的
    /// 设备」永远是空的）。本处同理：`announce_now` 定义留在本文件里，`after_commit`
    /// 要是不调它，编译照过、行为却退回「配对完立刻发起远程必然绕中继」，
    /// 而这条**只有双机手测才看得见**（见 `docs/远程电脑-双机手测清单` §7.5）。
    ///
    /// 所以这里同时要求**有定义**且**调用落在 `after_commit` 里**。
    /// 用带缩进的整体串匹配，避免匹配到下面这句断言的字符串字面量本身。
    #[test]
    fn test_守卫_落库后真的补喊了一次地址公告() {
        // 🔴 行尾无关：Windows 上 rustfmt/编辑器会把文件切成 CRLF，
        // 下面按「整串匹配」的守卫在 CRLF 文件里永远找不到调用点——
        // 守卫本身没坏，坏的是对行尾做了假设。先归一再匹配。
        let src = include_str!("discovery.rs").replace("\u{d}\u{a}", "\u{a}");
        assert!(
            src.contains("fn announce_now(&self)"),
            "`announce_now` 的定义没了——配对完立刻发起远程会退回绕中继"
        );
        let call = "\n        self.announce_now();\n";
        let Some(call_at) = src.find(call) else {
            panic!("`announce_now` 有定义但没有调用；配对完立刻发起远程会退回绕中继");
        };
        let commit_at = src
            .find("fn after_commit")
            .expect("`after_commit` 还在（本用例按它的位置判调用点）");
        assert!(
            call_at > commit_at,
            "补喊要挂在落库之后那条路径上（`after_commit` 里），而不是别处顺手调一下"
        );
    }
}
