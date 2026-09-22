//! 无人值守准入：一次性接入码（uno_admit）与固定密码（pass_admit）。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

impl RcService {
    /// 无人值守接入码准入（Q2 方案 B）。验码 → 建会话 → 落白名单 →
    /// （可选）开免确认 → 消费一次。任何一步不过都不碰待验表。
    ///
    /// 与免确认直连（方案 D）的差别在**信任的来源**：那边的信任是用户提前
    /// 逐台点过头（rc_devices.trusted），这里的信任是「此刻有人在场生成了
    /// 一个 15 分钟的码，并把码交到了对方手里」——所以验码通过后**必须落
    /// 白名单**（与现场配对同一张表），让这台设备从此受横幅/历史/禁止/免确认
    /// 的常规管理，而不是留在某个隐形的旁门里。
    ///
    /// # 🔴 消费时机的顺序不变量
    ///
    /// [`Self::uno`] 的 `verify` 只判不消费；`consume` 只在会话真的建立之后调。
    /// 反过来（验完就消费）的话，「码对、但本机正忙」会把一次有效的接入烧掉，
    /// 对端看到的是自相矛盾的「码没错但连不上」。
    ///
    /// # 🔴 落白名单也在会话真的建立之后（2026-09-22 审计 D1）
    ///
    /// 旧实现把 [DataStore::rc_device_pair] 放在 `establish_inbound_with` **之前**，
    /// 于是「码对但本机忙 / 本机已关「允许被远程」/ 该设备被拉黑」这些失败路径
    /// 全都先往 `rc_devices` 里写了一行——对方在你的设备列表里凭空出现了，
    /// 而它一次会话都没建立过。更坏的是它顺带堵不住多设备：`verify` 只判不消费，
    /// 未 `consume` 之前同一个码可被**多台**设备命中，每命中一台就先写一行，
    /// 一次接入被洗成 N 台白名单设备。写库点后移到 Ok 分支后，失败路径零副作用。
    ///
    /// `pub(super)`：`rc::tests` 要直接打这条路径（与 `pass_admit` 同一理由）。
    pub(in crate::rc) fn uno_admit(
        &self,
        peer: &str,
        requested: Capability,
        code: &str,
        now_ms: i64,
    ) -> UnoAdmit {
        let short = &peer[..8.min(peer.len())];
        // 红线先行：未启用 = 一律拒，且**不**泄露「码对不对」（用同一句门禁话）。
        if !self.enabled() {
            return UnoAdmit::Denied(
                Gate::Disabled.deny_reason().to_string(),
                Gate::Disabled.deny_code().to_string(),
            );
        }
        let Some(grant) = self.uno.verify(code, now_ms) else {
            return UnoAdmit::Denied("接入码无效或已过期".into(), "uno_invalid".into());
        };
        // 逐台禁止优先于码：用户明确拉黑过的设备，一张新码不该替他翻案。
        if self.device_deny().get(peer).copied().unwrap_or(false) {
            return UnoAdmit::Denied(
                Gate::DeviceDenied.deny_reason().to_string(),
                Gate::DeviceDenied.deny_code().to_string(),
            );
        }
        // 设备名先算好（后面落白名单要用）。此刻无从核对真名——对方自报名要等
        // 招呼包——所以给可读的占位。
        let name = {
            let n = self.peer_name(peer);
            if n.is_empty() {
                "新设备".to_string()
            } else {
                n
            }
        };
        // 申请档超过码授予的档 → 压到码的档（Accept 会把真实档回给对端，
        // 对端 UI 就按「只看」渲染，与既有提权流程一致）。
        let cap = if requested.allowed_by(grant.capability) {
            requested
        } else {
            grant.capability
        };
        let established = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            // Credential：白名单行还没写（D1），信任由刚验过的码提供。
            self.establish_inbound_with(&mut inner, peer, name.clone(), cap, InboundTrust::Credential)
        };
        match established {
            Ok(_) => {
                // 🔴 白名单落在这里（而不是验码之后）：见上方 D1 注释。
                // 失败则**回滚刚建立的会话**——准入要么全成、要么全不成。
                // 保留「回滚」而不是「留着会话只记日志」，是因为后者会让对端
                // 连上一个「本机设备列表里不存在的设备」，且 `uno_store_error`
                // 这个稳定错误码与前端文案会变成死码（`src/lib/rcDeny.ts:116`）。
                if let Err(e) = self.store.rc_device_pair(peer, &name) {
                    // 存储错误原文只进日志；deny 话术回给一个**未通过认证**的连接，
                    // 不该携带本机路径/IO 细节（2026-09-19 审查）。
                    log::error!("[RC] {short} 接入码准入写设备列表失败，回滚会话：{e}");
                    self.rollback_inbound(peer);
                    return UnoAdmit::Denied(
                        "对方暂时无法处理该接入码".into(),
                        "uno_store_error".into(),
                    );
                }
                // 🔴 免确认在**会话真的建立之后**才落库：若在 establish 之前写，
                // 「码有效但本机正忙」的失败会留下一个 trusted=true 的设备——
                // 码是一次性的，免确认却是永久的，等于把一次性码洗成常驻后门
                // （2026-09-19 审查发现的 P1）。白名单同理，见上。
                if grant.also_trust {
                    if let Err(e) = self.set_device_trust(peer, true) {
                        log::warn!("[RC] {short} 接入码连入后开免确认失败：{e}");
                    }
                }
                self.uno.consume(&grant.hash);
                log::info!(
                    "[RC] {short} 通过无人值守接入码连入（{}）",
                    cap.as_str()
                );
                UnoAdmit::Admitted
            }
            Err(e) => {
                log::warn!("[RC] {short} 接入码有效但建立会话失败：{e}");
                UnoAdmit::Denied(e, "busy".into())
            }
        }
    }

    /// 固定密码准入（Q2 方案 C）。顺序刻意与 [`Self::uno_admit`] 同构：
    /// 红线 → 政策 → 闸 → 验密 → 逐台禁止 → 落白名单 → 建会话。
    ///
    /// 与验码路径的四个差别：
    /// 1. 验密**之前**先过防爆破闸（[`Self::pass_gate`]）。验密本身要花本机
    ///    CPU/内存（Argon2id 19 MiB、几十毫秒），先闸后验同时按住「无限慢速
    ///    爆破」与「拿验密烤 CPU」两种玩法；
    /// 2. 局域网政策在闸之前：`wan=false`（默认）时非局域网来路直接拒。
    ///    判据由调用方用 `path_kind::of_conn` 对**活连接**实测后传入
    ///    （抽成 `is_lan` 参数也让 `rc/tests.rs` 能直接打这条路径）；
    /// 3. 验密通过即清闸档——建会话失败不算失败（他没在爆破，不该吃退避）；
    /// 4. 没有「消费」语义：密码可反复用，泄露后的止损 = 一键全局关闭 + 换密码。
    ///
    /// # 🔴 与验码共用同一条信任落点
    ///
    /// 验密通过 = 该设备写入 rc_devices（与现场配对同一张表），受横幅/历史/
    /// 禁止/免确认的常规管理。**不**自动开免确认——「知道密码」与「这台设备
    /// 可信」必须保持分离（`unop.rs` 模块注释，设计稿威胁表第三行）。
    ///
    /// 落白名单的时机与验码路径**同构**：都在会话真的建立之后（D1，见
    /// [`Self::uno_admit`] 的模块注释）。旧实现在这里先写库再建会话，
    /// 「密码对但本机忙」同样会留下一行凭空多出来的设备。
    pub(in crate::rc) fn pass_admit(
        &self,
        peer: &str,
        requested: Capability,
        pass: &str,
        is_lan: bool,
        now_ms: i64,
    ) -> UnoAdmit {
        let short = &peer[..8.min(peer.len())];
        // 红线先行：未启用 = 一律拒，且不泄露密码对不对（与验码同一句话术）。
        if !self.enabled() {
            return UnoAdmit::Denied(
                Gate::Disabled.deny_reason().to_string(),
                Gate::Disabled.deny_code().to_string(),
            );
        }
        let Some(cfg) = unop::cfg_from(&self.cfg()) else {
            return UnoAdmit::Denied("对方未开启固定密码接入".into(), "uno_pass_off".into());
        };
        // 局域网政策（设计稿第四条）：默认仅局域网。中继 / 公网打洞都算跨网。
        if !cfg.wan && !is_lan {
            log::info!("[RC] {short} 密码接入被拒：来路非局域网，且本机未开「允许跨网」");
            return UnoAdmit::Denied(
                "对方的固定密码只允许同一局域网内使用（跨网需对方显式打开）".into(),
                "uno_pass_wan".into(),
            );
        }
        // 先查闸，后验密。
        match self.pass_gate.check(peer, now_ms) {
            unop::GateCheck::Wait(ms) => {
                log::info!("[RC] {short} 密码接入被限速：还需等 {ms}ms");
                return UnoAdmit::Denied(
                    format!("尝试过于频繁，请约 {} 秒后再试", (ms + 999) / 1000),
                    "uno_pass_throttled".into(),
                );
            }
            unop::GateCheck::Ok => {}
        }
        if !unop::verify(&cfg.phc, pass) {
            self.pass_gate.record_failure(peer, now_ms);
            log::info!("[RC] {short} 固定密码错误");
            return UnoAdmit::Denied("接入密码不正确".into(), "uno_pass_invalid".into());
        }
        // 验过了就清档：下面的失败（忙/写库）不是爆破，不该让他吃退避。
        self.pass_gate.record_success(peer);
        // 逐台禁止优先于密码：用户明确拉黑过的设备，密码不该替他翻案。
        if self.device_deny().get(peer).copied().unwrap_or(false) {
            return UnoAdmit::Denied(
                Gate::DeviceDenied.deny_reason().to_string(),
                Gate::DeviceDenied.deny_code().to_string(),
            );
        }
        // 设备名先算好（落白名单要用）。先占位，等对方自报真名。
        let name = {
            let n = self.peer_name(peer);
            if n.is_empty() {
                "新设备".to_string()
            } else {
                n
            }
        };
        // 申请档超过密码档 → 压档（配置损坏时按只看兜底，不放开）。
        let grant = cfg.capability().unwrap_or(Capability::View);
        let cap = if requested.allowed_by(grant) {
            requested
        } else {
            grant
        };
        let established = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            // Credential：白名单行还没写（D1），信任由刚验过的密码提供。
            self.establish_inbound_with(&mut inner, peer, name.clone(), cap, InboundTrust::Credential)
        };
        match established {
            Ok(_) => {
                // 🔴 白名单落在会话真的建立之后（D1，理由见 `uno_admit`）。
                // 失败同样回滚会话，保住 `uno_pass_store_error` 这条错误契约、
                // 也避免「对端连上了、本机设备列表里却没有它」。
                if let Err(e) = self.store.rc_device_pair(peer, &name) {
                    // 存储错误原文只进日志；deny 话术不携带本机路径/IO 细节。
                    log::error!("[RC] {short} 密码准入写设备列表失败，回滚会话：{e}");
                    self.rollback_inbound(peer);
                    return UnoAdmit::Denied(
                        "对方暂时无法处理该接入请求".into(),
                        "uno_pass_store_error".into(),
                    );
                }
                log::info!("[RC] {short} 通过固定密码连入（{}）", cap.as_str());
                UnoAdmit::Admitted
            }
            Err(e) => {
                log::warn!("[RC] {short} 密码正确但建立会话失败：{e}");
                UnoAdmit::Denied(e, "busy".into())
            }
        }
    }
}
