//! R0 门禁与状态机单测（不起网络、不起 tauri）。

use crate::data_store::DataStore;
use crate::rc::protocol::{Capability, SessionPhase};
use crate::rc::service::{PeerHostAudio, RcService, UnoAdmit};
use crate::rc::session::{gate_inbound, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED};

fn store() -> DataStore {
    DataStore::new(":memory:").expect("open store")
}

fn set_cfg(store: &DataStore, key: &str, val: serde_json::Value) {
    let mut c = store.get_config().unwrap_or_default();
    c.as_object_mut().unwrap().insert(key.to_string(), val);
    store.save_config(&c).unwrap();
}

/// 守卫单测的「锚点 + 窗口」截取：`src[start..start+len]`，但把结束点**对齐到
/// 字符边界**。
///
/// 🔴 为什么需要它：这些守卫用固定**字节**窗口圈住一段函数体，而被圈的源码里
/// 有中文（一个字 3 字节）。窗口尾端落在多字节字符中间时会直接
/// `byte index … is not a char boundary` **panic**——2026-09-22 实测：给
/// `approve_inbound` 加了几行（合法改动）就炸了 `守卫_approve_inbound会elevate同步设备`。
/// 窗口本来只是「大致划个范围」，往前收最多 3 字节不影响断言语义，
/// 但把「改无关代码就炸」这类假失败去掉了。
fn window(src: &str, start: usize, len: usize) -> &str {
    let mut end = (start + len).min(src.len());
    while end > start && !src.is_char_boundary(end) {
        end -= 1;
    }
    &src[start..end]
}

#[test]
fn default_rejects_everything() {
    let s = store();
    let svc = RcService::new(s.clone());
    assert!(!svc.enabled());
    assert_eq!(svc.max_capability(), Capability::View);
    // 无会话时 require_active 必须失败
    assert!(svc.require_active().is_err());
    assert!(!svc.must_show_banner());
}

#[test]
fn settings_roundtrip() {
    let s = store();
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    set_cfg(&s, CFG_CAPABILITY, serde_json::json!("control"));
    let mut deny = serde_json::Map::new();
    deny.insert("peer-a".into(), serde_json::Value::Bool(true));
    set_cfg(&s, CFG_DEVICE_DENY, serde_json::Value::Object(deny));

    let svc = RcService::new(s);
    assert!(svc.enabled());
    assert_eq!(svc.max_capability(), Capability::Control);
    assert!(svc.device_deny().get("peer-a").copied().unwrap_or(false));
}

#[tokio::test]
async fn request_without_rc_pair_fails() {
    let s = store();
    // 只做**同步**配对，不做远程配对——远程必须走 rc_devices
    s.device_pair(&"aa".repeat(32), "同步机", "").unwrap();
    let svc = RcService::new(s);
    let err = svc
        .request_session(&"aa".repeat(32), Capability::View, None, None)
        .await
        .unwrap_err();
    assert!(err.contains("远程配对") || err.contains("通道"), "{err}");
}

#[tokio::test]
async fn request_rc_paired_but_no_transport() {
    let s = store();
    s.rc_device_pair(&"bb".repeat(32), "远程机").unwrap();
    let svc = RcService::new(s);
    // 有配对 → needs_channel 为真，但通道尚未 start
    assert!(svc.needs_channel());
    assert!(!svc.enabled(), "发起不依赖「允许被远程」");
    let err = svc
        .request_session(&"bb".repeat(32), Capability::View, None, None)
        .await
        .unwrap_err();
    assert!(err.contains("通道未启动"), "{err}");
    assert!(svc.require_active().is_err());
}

#[tokio::test]
async fn request_with_uno_code_skips_pairing_gate() {
    // Q2 方案 B：带无人值守接入码的发起，目标机器**本来就未配对**——
    // 老的配对门必须让位，卡点后移到「通道未启动」（对端验码发生在拨通之后）。
    let s = store();
    let svc = RcService::new(s.clone());
    let err = svc
        .request_session(&"cc".repeat(32), Capability::Control, Some("AB2C-3DEF".into()), None)
        .await
        .unwrap_err();
    assert!(err.contains("通道未启动"), "带码不该死在配对门：{err}");
    // 对照组：同一台机器，不带码 → 老门照旧拦下
    let err = svc
        .request_session(&"cc".repeat(32), Capability::Control, None, None)
        .await
        .unwrap_err();
    assert!(err.contains("远程配对"), "{err}");
    // 空串视同没带码，不绕门
    let err = svc
        .request_session(&"cc".repeat(32), Capability::Control, Some("  ".into()), None)
        .await
        .unwrap_err();
    assert!(err.contains("远程配对"), "{err}");
}

#[test]
fn needs_channel_when_paired_without_being_remoted() {    let s = store();
    assert!(!RcService::new(s.clone()).needs_channel());
    s.rc_device_pair(&"cc".repeat(32), "甲").unwrap();
    let svc = RcService::new(s.clone());
    assert!(svc.needs_channel(), "有远程配对就该起通道（发起）");
    assert!(!svc.enabled());
    // 打开被控后同样需要通道
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    let svc2 = RcService::new(s);
    assert!(svc2.needs_channel());
}

#[test]
fn needs_channel_when_only_sync_paired() {
    // B9：仅同步配对、无远程配对、未开被控 → 仍要起通道，
    // 否则用户看得见设备（source="sync"）却发不起。
    let s = store();
    s.device_pair(&"ff".repeat(32), "同步机", "").unwrap();
    let svc = RcService::new(s);
    assert!(!svc.enabled(), "发起不依赖「允许被远程」");
    assert!(
        svc.needs_channel(),
        "仅同步配对也要起通道（发起），否则列得出却发不起"
    );
}

#[test]
fn sync_pair_grants_remote_trust() {
    // 方案 A：同步配对 → 可直接远程；远程配对 → 不自动进同步
    let s = store();
    let peer = "dd".repeat(32);
    s.device_pair(&peer, "同步机", "").unwrap();
    let svc = RcService::new(s.clone());
    assert!(svc.has_remote_trust(&peer), "同步配对应有远程信任");
    assert!(matches!(s.rc_device_get(&peer), Ok(None)), "尚未 elevate");
    // elevate 幂等写入 rc_devices
    svc.elevate_from_sync(&peer).unwrap();
    assert!(matches!(s.rc_device_get(&peer), Ok(Some(_))));
    // 反向：仅有 rc_devices 不应出现在同步 devices
    let only_rc = "ee".repeat(32);
    s.rc_device_pair(&only_rc, "远程机").unwrap();
    assert!(matches!(s.device_get(&only_rc), Ok(None)));
    assert!(RcService::new(s).has_remote_trust(&only_rc));
}

#[test]
fn approve_without_pending_fails() {
    let s = store();
    let svc = RcService::new(s);
    assert!(svc.approve_inbound("peer").is_err());
    assert!(svc.deny_inbound("peer").is_err());
}

#[tokio::test]
async fn end_without_session_fails() {
    let s = store();
    let svc = RcService::new(s);
    assert!(svc.end_session("x").await.is_err());
}

#[test]
fn inbound_gate_matrix_in_service_config() {
    // 服务未开 → Disabled
    let s = store();
    let svc = RcService::new(s.clone());
    let g = gate_inbound(
        svc.enabled(),
        svc.max_capability(),
        &svc.device_deny(),
        "p",
        true,
        Capability::View,
        false,
    );
    assert_eq!(g, crate::rc::session::Gate::Disabled);

    // 开了但能力不够
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    set_cfg(&s, CFG_CAPABILITY, serde_json::json!("view"));
    let svc = RcService::new(s);
    let g = gate_inbound(
        svc.enabled(),
        svc.max_capability(),
        &svc.device_deny(),
        "p",
        true,
        Capability::Control,
        false,
    );
    assert_eq!(g, crate::rc::session::Gate::CapabilityTooHigh);
}

#[test]
fn phase_idle_by_default() {
    let s = store();
    let svc = RcService::new(s);
    let st = svc.status();
    assert!(st.session.is_none());
    assert!(st.pending.is_empty());
    assert_eq!(st.session.map(|x| x.phase), None);
    let _ = SessionPhase::Idle;
}

// —— C8(b)：剪贴板 pull 的等待判定 ——
//
// 要防的是「跨会话串剪贴板」：上一个会话超时后**迟到**的回包会把 clip_seq
// 顶上去，如果只看 seq，本次 pull 就会误以为数据到了，把别的会话的剪贴板
// 内容当作本次结果返回。所以判定必须同时认「会话代」。

mod clip_wait {
    use crate::rc::clipboard::{clip_wait_decision, ClipWait};

    #[test]
    fn takes_when_seq_advanced() {
        assert_eq!(clip_wait_decision(0, 0, 5, 4), ClipWait::Take);
    }

    #[test]
    fn keeps_waiting_when_seq_unchanged() {
        assert_eq!(clip_wait_decision(0, 0, 4, 4), ClipWait::KeepWaiting);
    }

    #[test]
    fn abandons_on_session_switch_even_if_seq_advanced() {
        // 核心用例：seq 涨了（5 > 4）但会话已换 → 绝不能 Take
        assert_eq!(clip_wait_decision(1, 0, 5, 4), ClipWait::Abandon);
    }

    #[test]
    fn abandons_on_session_switch_even_without_reply() {
        assert_eq!(clip_wait_decision(7, 6, 2, 2), ClipWait::Abandon);
    }

    #[test]
    fn abandon_wins_over_take() {
        // 会话已切换时，不管 seq 怎么变，都必须是 Abandon
        for seq_now in [0u64, 1, 4, 5, 100] {
            assert_eq!(
                clip_wait_decision(2, 1, seq_now, 4),
                ClipWait::Abandon,
                "seq_now={seq_now} 时被 seq 抢判了"
            );
        }
    }

    #[test]
    fn take_requires_strictly_greater_seq() {
        // seq 相等说明回包还没来；写成 >= 会在「上一次 pull 的回包」上误判
        assert_eq!(clip_wait_decision(3, 3, 9, 9), ClipWait::KeepWaiting);
    }
}

// —— B3：被控端要能收到「对端改了画面范围」 ——

mod scope_notice {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn notify_callback_receives_scope() {
        let svc = RcService::new(store());
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = got.clone();
        svc.set_scope_notify(Arc::new(move |scope: &str| {
            sink.lock().unwrap().push(scope.to_string());
        }));

        svc.emit_scope_changed("primary");
        svc.emit_scope_changed("monitor:1");

        // 原样透传，不能被吞掉或改写——前端靠它拼「改成了 X」的提示
        assert_eq!(
            *got.lock().unwrap(),
            vec!["primary".to_string(), "monitor:1".to_string()]
        );
    }

    #[test]
    fn no_callback_is_not_a_panic() {
        // 没注册回调（例如单测/无 GUI 环境）时调用不能崩
        let svc = RcService::new(store());
        svc.emit_scope_changed("virtual");
    }

    #[test]
    fn local_scope_change_does_not_notify() {
        // 本机自己在设置页改范围（set_stream_scope）不该触发「对端改了」提示，
        // 否则被控端会被自己点的操作弹一条误导性通知。
        let svc = RcService::new(store());
        let hits = Arc::new(Mutex::new(0usize));
        let sink = hits.clone();
        svc.set_scope_notify(Arc::new(move |_s: &str| {
            *sink.lock().unwrap() += 1;
        }));

        svc.set_stream_scope("primary").expect("合法 scope");
        svc.set_stream_scope("monitor:0").expect("合法 scope");

        assert_eq!(*hits.lock().unwrap(), 0, "本机改范围不应通知被控提示");
    }
}

/// 会话生命周期（实现在 `session.rs` 的 `impl RcService`）。
///
/// 这里用「直接塞 `inner.session`」构造最小状态，不走真实握手——
/// 测的是收口逻辑本身，不是门禁（门禁在别处已有覆盖）。
mod lifecycle {
    use super::*;
    use crate::rc::session::Session;

    fn active_session(id: &str, phase: SessionPhase) -> Session {
        Session {
            id: id.to_string(),
            peer: "peer-a".to_string(),
            peer_name: "设备A".to_string(),
            capability: Capability::Control,
            phase,
            started_ms: crate::rc::service::now_ms(),
            granted: true,
        }
    }

    fn set_session(svc: &RcService, s: Session) {
        svc.inner.lock().unwrap_or_else(|p| p.into_inner()).session = Some(s);
    }

    /// B2 的顺序钉子：收口必须把被按住的键**真的**补发 up 并清空集合。
    ///
    /// 抓的回归形态：有人把收口改成「先清 session、再走 handle_inbound_input
    /// 补发」——那个时点 `session_capability()` 返 `None`，能力校验会拦掉释放，
    /// pressed 就不再是空的。直接调 `release_all` 的正确实现下它必为空。
    #[tokio::test]
    async fn end_session_releases_pressed_keys_and_clears_state() {
        let svc = RcService::new(store());
        set_session(&svc, active_session("s1", SessionPhase::OutboundActive));
        {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            g.press_key(0xA2); // VK_LCONTROL
            g.press_button(1);
        }
        assert!(!svc.pressed.lock().unwrap().is_empty(), "前置：确实按着键");

        svc.end_session("测试收口").await.expect("收口成功");

        assert!(
            svc.pressed.lock().unwrap().is_empty(),
            "收口必须补发 up 并清空按住集合（B2 顺序钉子）"
        );
        assert!(svc.require_active().is_err(), "收口后不该再有活跃会话");
        assert!(!svc.session_id_is("s1"));
        assert!(!svc.must_show_banner());
        assert!(
            svc.end_session("再收一次").await.is_err(),
            "没有会话时收口必须报错，不能静默成功"
        );
    }

    /// A2 的回归钉子：旧会话的收尾只能按 session id 命中，不能按 peer 误杀
    /// 同 peer 的新会话（「点重连画面闪一下又断」就是它）。
    #[tokio::test]
    async fn force_end_if_session_only_kills_matching_id() {
        let svc = RcService::new(store());
        set_session(&svc, active_session("s1", SessionPhase::OutboundActive));
        svc.pressed.lock().unwrap().press_key(0xA2);

        // 旧流任务拿着 s1 的 id 醒来，但当前会话已是 s2 ⇒ 必须不动
        set_session(&svc, active_session("s2", SessionPhase::OutboundActive));
        svc.force_end_if_session("s1", "画面流中断").await;
        assert!(
            svc.session_id_is("s2"),
            "旧 session id 的收口不得误杀同 peer 的新会话"
        );
        assert!(!svc.pressed.lock().unwrap().is_empty(), "没收口就不该补发");

        // id 匹配才真正收口
        svc.force_end_if_session("s2", "画面流中断").await;
        assert!(svc.require_active().is_err());
        assert!(svc.pressed.lock().unwrap().is_empty(), "真收口必须补发 up");
    }

    #[test]
    fn session_expired_only_counts_active_phases() {
        let svc = RcService::new(store());
        // started_ms = 0（1970 年）⇒ Active 相位必超 TTL
        let mut old = active_session("s1", SessionPhase::OutboundActive);
        old.started_ms = 0;
        set_session(&svc, old);
        assert!(svc.session_expired(), "Active 且远超 TTL 必须判过期");

        // Idle 相位不该判过期（收口判过期只对活会话有意义）
        let mut idle = active_session("s1", SessionPhase::Idle);
        idle.started_ms = 0;
        set_session(&svc, idle);
        assert!(!svc.session_expired());

        // 无会话 ⇒ 不过期
        svc.inner.lock().unwrap_or_else(|p| p.into_inner()).session = None;
        assert!(!svc.session_expired());
    }

    /// 在线判定三条证据：presence live / 正在开会话 / last_seen 未过期。
    ///
    /// 🔴 2026-09-21 重做：删掉了 `conn_state` 参数。新语义下「库里标过 online」
    /// **不再是证据**——那个字段只写 online 从不写 offline，读它必然假在线。
    #[test]
    fn is_rc_online_for_three_evidences() {
        use crate::rc::session::{is_rc_online_for, ONLINE_STALE_MS};
        use std::collections::HashSet;

        let now = 1_000_000i64;
        let mut live = HashSet::new();
        let peer = "p".repeat(64);

        // 1. presence 听得见 → 在线（哪怕 last_seen 是 0）
        live.insert(peer.clone());
        assert!(is_rc_online_for(&peer, 0, &live, None, now));
        live.clear();

        // 2. 正在开会话 → 在线（哪怕 last_seen 是 0、组播听不见）
        assert!(is_rc_online_for(&peer, 0, &live, Some(&peer), now));

        // 3. last_seen 未过期（跨网唯一线索）
        assert!(is_rc_online_for(&peer, now - ONLINE_STALE_MS, &live, None, now));
        assert!(is_rc_online_for(&peer, now - 1, &live, None, now));
        // 刚过窗口 1ms → 离线
        assert!(!is_rc_online_for(
            &peer,
            now - ONLINE_STALE_MS - 1,
            &live,
            None,
            now
        ));

        // last_seen=0（从未接触过）→ 离线，不能被"刚配对"骗过
        assert!(!is_rc_online_for(&peer, 0, &live, None, now));
        // 会话 peer 不是这台 → 不借力
        assert!(!is_rc_online_for(&peer, 0, &live, Some("other"), now));
        // 三条证据全缺（没有 live、会话不是它、last_seen 已过窗口）→ 离线
        assert!(!is_rc_online_for(
            &peer,
            now - ONLINE_STALE_MS - 1,
            &HashSet::new(),
            Some("other"),
            now
        ));
    }

    /// 🔴 回归守卫：判定**不允许**读回 `conn_state`。
    ///
    /// 这条守卫钉的是「2026-09-21 在线状态准确性修复」的核心不变量：
    /// `conn_state` 是个只写 online 从不写 offline 的脏字段，任何判定只要读它，
    /// 「假在线」就会从机制上回来。删掉 `is_rc_online_for` 的 `conn_state` 参数
    /// 只是手段，真正要守住的是「别再把它加回去」。
    #[test]
    fn 守卫_在线判定不得读conn_state() {
        let src = include_str!("session.rs");
        let start = src
            .find("pub fn is_rc_online_for(")
            .expect("找不到 is_rc_online_for");
        let body = super::window(src, start, 1400);
        assert!(
            !body.contains("conn_state"),
            "is_rc_online_for 不得再碰 conn_state——那个字段只写 online 从不写 offline，\
             读它必然产生假在线。要判断在线请用 live_ids / session_peer / last_seen 三条证据。"
        );
    }

    /// 🔴 回归守卫：`rc_device_touch` 的 **offline 分支必须有调用点**。
    ///
    /// 这是本 bug 的根本成因：只有写 online 的路径，没有写 offline 的路径，
    /// 状态位一旦置真就永不复位。守卫泛型地钉住「两个方向都得有人调」——
    /// 将来有人删掉 offline 写回，这条会立刻红。
    #[test]
    fn 守卫_offline写回路径存在() {
        // 扫整个 rc/ 目录的源码（用多个 include_str! 拼起来）
        let sources = [
            ("session.rs", include_str!("session.rs")),
            ("inbound.rs", include_str!("inbound.rs")),
            ("outbound.rs", include_str!("outbound.rs")),
            ("service.rs", include_str!("service.rs")),
        ];
        let all: String = sources.iter().map(|(_, s)| *s).collect();
        assert!(
            all.contains("rc_device_touch(peer, false)")
                || all.contains("rc_device_touch(&peer, false)")
                || all.contains("rc_device_touch(&self.peer, false)")
                || all.contains("rc_device_touch(peer,false)"),
            "必须有地方调 rc_device_touch(x, false) 把设备标回离线——\
             否则 conn_state 只写 online 不写 offline，假在线必然复现。\
             已知调用点：end_session / outbound 断链收口 / inbound 收口。"
        );
    }

    /// 四档可达性：live / recent / seen / never（设计稿）。
    #[test]
    fn rc_presence_level_four_tiers() {
        use crate::rc::session::{rc_presence_level, RcPresence, ONLINE_STALE_MS};
        use std::collections::HashSet;

        let now = 10_000_000i64;
        let peer = "abc";
        let mut live = HashSet::new();

        assert_eq!(
            rc_presence_level(peer, 0, &live, None, now),
            RcPresence::Never
        );

        live.insert(peer.to_string());
        assert_eq!(
            rc_presence_level(peer, 0, &live, None, now),
            RcPresence::Live
        );
        live.clear();

        assert_eq!(
            rc_presence_level(peer, 0, &live, Some(peer), now),
            RcPresence::Live
        );

        assert_eq!(
            rc_presence_level(peer, now - ONLINE_STALE_MS, &live, None, now),
            RcPresence::Recent
        );
        assert_eq!(
            rc_presence_level(peer, now - ONLINE_STALE_MS - 1, &live, None, now),
            RcPresence::Seen
        );
        // 会话 peer 不是这台，且 last_seen=0 → Never
        assert_eq!(
            rc_presence_level(peer, 0, &live, Some("other"), now),
            RcPresence::Never
        );
    }

    /// 🔴 回归：会话收口**不得清 `last_seen`**（否则「上次在线」永远显示不出来）。
    ///
    /// # 2026-09-21 修正（在线状态准确性修复）
    ///
    /// 旧版本这条测试的名字叫 `end_session_keeps_peer_online_and_last_seen`，
    /// 断言「收口后 conn_state 仍是 online」。那个断言来自上一轮的修复：
    /// 当时 `rc_device_touch(x, false)` 会**顺带把 last_seen 清 0**，导致设备
    /// 永远显示离线——为了绕开它，只好改调 `touch(true)`，于是收口不再标离线。
    ///
    /// 后果就是假在线：`conn_state` 只写 online 从不写 offline，一旦置真永不复位。
    ///
    /// 现在把两件事拆开了：`rc_device_mark_offline` **只动 conn_state、不动 last_seen**。
    /// 所以「保留 last_seen」和「标离线」不再互相冲突——两个正确行为可以同时做。
    ///
    /// ❗ 本测试守的是**下半条**（last_seen 必须保留）。上半条（收口后应为 offline）
    /// 由 `end_session_marks_offline_and_keeps_last_seen` 守。
    #[tokio::test]
    async fn end_session_keeps_last_seen() {
        let s = store();
        let peer = "bb".repeat(32);
        s.rc_device_pair(&peer, "对端").unwrap();
        // 先标成在线（模拟 presence / 上次会话）
        s.rc_device_touch(&peer, true).unwrap();
        let before = s.rc_device_get(&peer).unwrap().unwrap();
        assert_eq!(before.conn_state, "online");
        assert!(before.last_seen > 0);

        let svc = RcService::new(s.clone());
        let mut sess = active_session("s1", SessionPhase::OutboundActive);
        sess.peer = peer.clone();
        set_session(&svc, sess);
        svc.end_session("测试收口").await.expect("收口成功");

        let after = s.rc_device_get(&peer).unwrap().unwrap();
        assert!(
            after.last_seen >= before.last_seen && after.last_seen > 0,
            "收口必须保留 last_seen，不能清 0——它是「上次在线是什么时候」，\
             界面靠它显示「上次在线：3 小时前」"
        );
    }

    /// 🔴 回归：会话收口**必须把设备标回 offline**（补平「只写 online 不写 offline」）。
    ///
    /// 这是 2026-09-21 在线状态修复的核心不变量之一。缺失它 = `conn_state`
    /// 只置位不复位 = 假在线必然复现。
    #[tokio::test]
    async fn end_session_marks_offline_and_keeps_last_seen() {
        let s = store();
        let peer = "cc".repeat(32);
        s.rc_device_pair(&peer, "对端").unwrap();
        s.rc_device_touch(&peer, true).unwrap();
        let before = s.rc_device_get(&peer).unwrap().unwrap();

        let svc = RcService::new(s.clone());
        let mut sess = active_session("s1", SessionPhase::OutboundActive);
        sess.peer = peer.clone();
        set_session(&svc, sess);
        svc.end_session("测试收口").await.expect("收口成功");

        let after = s.rc_device_get(&peer).unwrap().unwrap();
        assert_eq!(
            after.conn_state, "offline",
            "会话收口必须标 offline——否则 conn_state 只写 online 不写 offline，\
             状态位永不复位，假在线必然复现"
        );
        assert_eq!(
            after.last_seen, before.last_seen,
            "标 offline 不得动 last_seen（rc_device_mark_offline 只改 conn_state）——\
             否则「上次在线」显示不出来"
        );
    }
}

// ===== 邀请门 × 邀请码：口径唯一（2026-09-17） =====
// 「门与码同宽」那条钉在 `commands/rc.rs` 里（常量定义处，模块是私有的）。

/// 配对成功即关门：一份邀请只该消耗一次。
///
/// 码里带的是「node_id + 名字」、**不是一次性 nonce** ⇒ 同一份码在窗口内可被反复使用。
/// 所以「配完就关门」比「把窗口调短」更管用。
#[test]
fn test_配对成功即关门() {
    const T: i64 = 1_788_500_000_000;
    let s = store();
    let svc = RcService::new(s.clone());
    let peer = "cd".repeat(32);
    s.rc_device_pair(&peer, "对端").unwrap();

    crate::rc::join::open_door(&s, T + 60_000).unwrap();
    assert!(crate::rc::join::door_open(&s, T), "开门后应开着");

    // 已配对时 approve 走的是「幂等刷新名字」那条分支，同样必须关门
    svc.approve_join(&peer, "对端").unwrap();
    assert!(
        !crate::rc::join::door_open(&s, T),
        "放行一台之后门就该关上——否则同一份码还能再配第三台"
    );
}

/// 🔴 「未配对对端来敲门」的判据必须分出**四种**结果，而不是一句「尚未远程配对」。
///
/// 修复前：除「门开着且敲门成功」外全部塌缩成 `not_paired`，
/// 而用户实际撞到的**几乎总是窗口过期**——那句话指不到
/// 「回去重新生成一个」这个唯一正确的动作。这条用例是那个 bug 的守卫。
#[test]
fn test_敲门被拒要说清是哪一种() {
    use crate::rc::join::{deny_unpaired, KnockDenial};

    // ① 没开被控 → 先去开开关
    assert_eq!(
        deny_unpaired(false, true, false),
        Some(KnockDenial::Disabled)
    );
    // ② 窗口过期（门已关）→ 回去重新生成一份码。这是最常见的那一档。
    assert_eq!(
        deny_unpaired(true, false, false),
        Some(KnockDenial::DoorClosed)
    );
    // ③ 拒绝冷却期 → 说明对方拒过，别再干等
    assert_eq!(deny_unpaired(true, true, true), Some(KnockDenial::Denied));
    // ④ 都正常 → 记入待确认
    assert_eq!(deny_unpaired(true, true, false), None);

    // 优先级：前一条比后一条更能解释用户的处境，所以先报它。
    assert_eq!(
        deny_unpaired(false, false, true),
        Some(KnockDenial::Disabled),
        "既没开被控、窗口又过期时，该说的是「去把开关打开」"
    );
    assert_eq!(
        deny_unpaired(true, false, true),
        Some(KnockDenial::DoorClosed),
        "窗口过期比冷却期更能解释处境：码本来就作废了"
    );
}

/// 三档拒绝的 code 是**跨前后端的契约**（`src/lib/rcDeny.ts` 的 `BY_CODE` 靠它分档）。
/// 改字符串 = 前端静默退回「远程申请未成功」这个兜底档，所以在这里钉住。
#[test]
fn test_敲门被拒的code不能改() {
    use crate::rc::join::KnockDenial;
    assert_eq!(KnockDenial::Disabled.code(), "disabled");
    assert_eq!(KnockDenial::DoorClosed.code(), "invite_door_closed");
    assert_eq!(KnockDenial::Denied.code(), "pair_denied");
    // 文案是给**对端**看的（他是发起方），所以一律「对方…」
    for d in [
        KnockDenial::Disabled,
        KnockDenial::DoorClosed,
        KnockDenial::Denied,
    ] {
        assert!(
            d.reason().starts_with("对方"),
            "回给对端的话要站对端立场：{}",
            d.reason()
        );
    }
}
/// 关门后可以再开（用户重新生成一份码）；但「开门」不会把已开得更久的窗口缩短。
#[test]
fn test_门可重开且不缩短已开的窗口() {
    const T: i64 = 1_788_500_000_000;
    let s = store();

    crate::rc::join::close_door(&s).unwrap();
    assert!(!crate::rc::join::door_open(&s, T), "关着的门不该自己开");

    crate::rc::join::open_door(&s, T + 60_000).unwrap();
    assert!(crate::rc::join::door_open(&s, T));

    // 再开一次但更短：后一次不该把前一次的窗口提前关上
    crate::rc::join::open_door(&s, T + 1_000).unwrap();
    assert!(
        crate::rc::join::door_open(&s, T + 30_000),
        "重复开门时窗口被缩短了——用户会莫名其妙地被提前关在门外"
    );
}

/// 🔴 回归钉（tmp_b1 实测命中）：对**未配对**的 id 设免确认必须拒绝——旧行为
/// 凭空写一行「同步设备」并让 `has_remote_trust` 变 true = 绕过 SAS 配对放白名单。
#[test]
fn test_免确认只能开在已配对设备上() {
    let s = store();
    let svc = RcService::new(s.clone());
    let e = svc.set_device_trust("unknown-id-xyz", true).unwrap_err();
    assert!(e.contains("尚未与本机配对"), "{}", e);
    assert!(
        s.rc_device_get("unknown-id-xyz").unwrap().is_none(),
        "拒绝的同时不许写行"
    );
    assert!(!svc.has_remote_trust("unknown-id-xyz"));
}

// —— Q6：免确认设备断线自动重连 ——

#[test]
fn test_非免确认设备断线不安排自动重连() {
    // store 里没有这台设备的 rc_devices 行 → device_trusted = false。
    // 逐次确认的设备自动重连 = 自动反复敲对方的门，绝不能默默发起。
    let svc = std::sync::Arc::new(RcService::new(store()));
    svc.begin_auto_reconnect("peer-no-trust", "对方".to_string(), Capability::View);
    assert!(
        svc.status().reconnecting.is_none(),
        "未开免确认就不能进入重连状态"
    );
}

#[test]
fn test_免确认设备断线会进入重连状态() {
    let s = store();
    // 配对行 + trusted=true 才算免确认（与「免确认只能开在已配对设备上」同一前提）
    s.rc_device_pair("peer-trusted", "对端机").unwrap();
    s.rc_device_trust_set("peer-trusted", true).unwrap();
    let svc = std::sync::Arc::new(RcService::new(s));
    svc.begin_auto_reconnect("peer-trusted", "对端机".to_string(), Capability::View);
    let info = svc.status().reconnecting.expect("应进入重连状态");
    assert_eq!(info.peer, "peer-trusted");
    assert_eq!(info.max, 3);
    assert!(!info.gave_up);
}

// ── Q8 静止精修的运动判定（motion_verdict 纯函数）──────────────────────────

use crate::rc::inbound::{motion_verdict, MotionVerdict};

/// 🔴 精修强制出的 IDR 不能把自己当成「画面动了」——那是 re-arm 死循环
/// （静止画面每 ~330ms 一个 IDR）的成因，2026-09-19 审查发现的 P1。
#[test]
fn 关键帧不参与运动判定_精修IDR不重新武装() {
    assert_eq!(
        motion_verdict(true, 100_000, 500_000),
        MotionVerdict::Ignore,
        "关键帧无论多大都不是「动了」"
    );
    // 基准未建立：首个非关键帧负责建立（算动帧）
    assert_eq!(motion_verdict(false, 0, 1), MotionVerdict::Moving);
    // 动帧判据：≥ 基准/6
    assert_eq!(motion_verdict(false, 60_000, 10_000), MotionVerdict::Moving);
    assert_eq!(
        motion_verdict(false, 60_000, 9_999),
        MotionVerdict::Static,
        "跳块 P 帧只有基准零头 ⇒ 静止"
    );
}

/// 🔴 发送端序号从 1 起：sq=0 是「旧对端无序号」的保留值。曾从 0 起会让
/// 会话第一个流关键帧被接收端跳过锚定，首 GOP 画面全部滞留（首帧后冻 ~1s）。
#[test]
fn 发送端序号从1起且回绕跳过0() {
    use crate::rc::vid_dgram::VidDgramSender;
    let mut s = VidDgramSender::new();
    assert_eq!(s.take_seq(), 1, "第一个帧的序号是 1，不是 0");
    assert_eq!(s.take_seq(), 2);
}

// ── Q2 方案 C：固定密码准入（pass_admit）────────────────────────────
// UnoAdmit 是 service 的私有枚举；这里只断言**可观测状态**（会话、白名单、
// 闸），与「黑盒用户会看到什么」对齐。

use crate::rc::unop::{self, GateCheck};

const T0: i64 = 1_757_000_000_000;

fn pass_store(wan: bool, cap: Capability) -> (DataStore, String) {
    let s = store();
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    // 机器全局能力上限给到可控：pass_admit 里密码档与机器档是两级独立压档，
    // 这里固定机器档，让用例只考察密码档那一层（压档用例见下）。
    set_cfg(&s, CFG_CAPABILITY, serde_json::json!("control"));
    let cfg = unop::hash_password("s3cret-密码", T0, cap, wan).unwrap();
    set_cfg(&s, unop::CFG_KEY, serde_json::to_value(&cfg).unwrap());
    (s, cfg.phc)
}

#[test]
fn pass_admit_正确密码自动配对并建会话() {
    let (s, _) = pass_store(true, Capability::Control);
    let svc = RcService::new(s.clone());
    let peer = "ab".repeat(32);
    // wan=true：非局域网来路也放行（跨网显式打开的设计就是干这个的）
    svc.pass_admit(&peer, Capability::Control, " s3cret-密码 ", false, T0 + 1);
    let st = svc.status();
    let sess = st.session.expect("密码正确要建会话");
    assert_eq!(sess.peer, peer);
    assert_eq!(sess.phase, SessionPhase::InboundActive);
    assert_eq!(sess.capability, Capability::Control);
    // 落白名单（与现场配对同一张表）
    assert!(matches!(s.rc_device_get(&peer), Ok(Some(_))));
    // 闸清档：密码对了不算失败
    assert_eq!(svc.pass_gate.check(&peer, T0 + 1), GateCheck::Ok);
}

#[test]
fn pass_admit_错密码拒_记失败_不落白名单() {
    let (s, _) = pass_store(true, Capability::Control);
    let svc = RcService::new(s.clone());
    let peer = "ac".repeat(32);
    svc.pass_admit(&peer, Capability::Control, "错密码", true, T0 + 1);
    assert!(svc.status().session.is_none(), "错密码不得建会话");
    assert!(matches!(s.rc_device_get(&peer), Ok(None)), "错密码不得落白名单");
    // 闸记了一次失败：立刻再试要吃退避
    assert!(matches!(svc.pass_gate.check(&peer, T0 + 1), GateCheck::Wait(_)));
}

#[test]
fn pass_admit_五连错后锁死_密码对了也进不来() {
    let (s, _) = pass_store(true, Capability::Control);
    let svc = RcService::new(s.clone());
    let peer = "ad".repeat(32);
    for i in 0..5 {
        // 间隔拉开到退避之外（i*70s > 60s 封顶），确保拦下的是「锁」不是「退避」
        svc.pass_admit(&peer, Capability::Control, "错密码", true, T0 + i * 70_000);
    }
    let st = svc.status();
    assert!(st.session.is_none());
    // 锁定期内给正确密码：闸先于验密，照样拒
    let after = T0 + 4 * 70_000 + 1000;
    assert!(matches!(svc.pass_gate.check(&peer, after), GateCheck::Wait(_)));
    svc.pass_admit(&peer, Capability::Control, "s3cret-密码", true, after);
    assert!(svc.status().session.is_none(), "锁定期内正确密码也不放行");
    assert!(matches!(s.rc_device_get(&peer), Ok(None)));
}

#[test]
fn pass_admit_默认仅局域网_跨网未开直接拒() {
    let (s, _) = pass_store(false, Capability::Control); // wan=false（默认）
    let svc = RcService::new(s);
    let peer = "ae".repeat(32);
    // 密码对，但来路是打洞/中继（is_lan=false）→ 拒
    svc.pass_admit(&peer, Capability::Control, "s3cret-密码", false, T0 + 1);
    assert!(svc.status().session.is_none());
    // 对照：局域网来路 → 放行
    let peer2 = "af".repeat(32);
    svc.pass_admit(&peer2, Capability::Control, "s3cret-密码", true, T0 + 2);
    assert!(svc.status().session.is_some(), "局域网内正确密码要放行");
}

#[test]
fn pass_admit_压档_能力档超上限压到密码档() {
    let (s, _) = pass_store(true, Capability::View); // 密码档 = 只看
    let svc = RcService::new(s);
    let peer = "b0".repeat(32);
    svc.pass_admit(&peer, Capability::Control, "s3cret-密码", true, T0 + 1);
    let sess = svc.status().session.expect("验密要过");
    assert_eq!(
        sess.capability,
        Capability::View,
        "申请可控但密码只授只看 → 压档"
    );
}

#[test]
fn pass_admit_逐台禁止优先于密码() {
    let (s, _) = pass_store(true, Capability::Control);
    let peer = "b1".repeat(32);
    let mut deny = serde_json::Map::new();
    deny.insert(peer.clone(), serde_json::Value::Bool(true));
    set_cfg(&s, CFG_DEVICE_DENY, serde_json::Value::Object(deny));
    let svc = RcService::new(s.clone());
    svc.pass_admit(&peer, Capability::Control, "s3cret-密码", true, T0 + 1);
    assert!(svc.status().session.is_none(), "拉黑设备凭密码也进不来");
    assert!(matches!(s.rc_device_get(&peer), Ok(None)));
}

#[test]
fn pass_admit_红线未开被控一律拒() {
    let (s, _) = pass_store(true, Capability::Control);
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(false));
    let svc = RcService::new(s);
    let peer = "b2".repeat(32);
    svc.pass_admit(&peer, Capability::Control, "s3cret-密码", true, T0 + 1);
    assert!(svc.status().session.is_none(), "rc_enabled 红线先于一切凭证");
}

#[test]
fn status_未开启时uno_pass为空_开启后只投影不含哈希() {
    let (s, phc) = pass_store(true, Capability::Control);
    let svc = RcService::new(s);
    let info = svc.status().uno_pass.expect("开启后要有投影");
    assert_eq!(info.cap, "control");
    assert!(info.wan);
    assert_eq!(info.since_ms, T0);
    // 🔴 投影里不允许出现 PHC 串的任何片段
    let json = serde_json::to_string(&info).unwrap();
    assert!(!json.contains("argon2id"), "投影不得泄露 PHC 串");
    assert!(!phc.is_empty()); // 用掉变量，防止被当死代码
}

// ── G3 音频：三因子与跨会话保持 ───────────────────────────────────────

/// 音频出不出声 = 对端申请了 && 对端此刻没关 && **本机没静音**，三者取与。
///
/// 这段语义最容易被后续改动悄悄改错（例如把「本机静音」实现成对端开关的另一个
/// 镜像），所以逐组合钉死——尤其「本机静音后，对端再关再开也解不开」这条。
#[cfg(target_os = "windows")]
#[test]
fn audio_wanted_三因子() {
    let svc = RcService::new(store());
    // 默认全否：对端没申请 → 不出声
    assert!(!svc.audio_wanted());

    // 对端申请了、双方都开着 → 出声
    svc.audio_set_peer_wants(true);
    assert!(svc.audio_wanted());

    // 对端在会话里关掉自己 → 不出声；关回去 → 恢复
    svc.set_audio_muted(true);
    assert!(!svc.audio_wanted());
    svc.set_audio_muted(false);
    assert!(svc.audio_wanted());

    // 本机静音 → 一票否决（对端开着也不出声）
    svc.set_audio_local_mute(true);
    assert!(!svc.audio_wanted());
    assert!(svc.audio_local_mute());

    // 🔴 对端再关一次又开回来，仍然不出声——本机的否决不由对端动作解开
    svc.set_audio_muted(true);
    svc.set_audio_muted(false);
    assert!(!svc.audio_wanted(), "本机静音只有本机能解");

    // 本机自己恢复 → 才出声
    svc.set_audio_local_mute(false);
    assert!(svc.audio_wanted());
}

/// 本机静音**跨会话保持**：`audio_reset` 收口的是对端申请位 / 对端开关 / 收流缓冲，
/// 不该顺手把用户的隐私开关解开（那等于每来一个人就自动放行一次）。
#[cfg(target_os = "windows")]
#[test]
fn 本机静音跨会话保持() {
    let svc = RcService::new(store());
    svc.audio_set_peer_wants(true);
    svc.set_audio_local_mute(true);

    svc.audio_reset();

    assert!(!svc.audio_peer_wants(), "对端申请位该被会话收口清掉");
    assert!(
        svc.audio_local_mute(),
        "本机静音不该被会话收口解开（隐私开关不做自动回退）"
    );
    assert!(!svc.audio_wanted(), "收口后没有新申请，仍不出声");
}

/// G3-B：对端报来的主机音频状态是**本会话**的事实，会话收口即作废——
/// 不然下一场会话会带着上一场的「对方已静音」显示出来（对端可能早就改回来了）。
#[cfg(target_os = "windows")]
#[test]
fn 对端音频状态随会话收口作废() {
    let svc = RcService::new(store());
    assert!(svc.peer_host_audio().is_none(), "默认没收到过（旧对端也恒 None）");

    svc.set_peer_host_audio(PeerHostAudio {
        local_mute: true,
        spk_mute: true,
        err: None,
    });
    let got = svc.peer_host_audio().expect("刚写入的该读得到");
    assert!(got.local_mute && got.spk_mute);

    svc.audio_reset();
    assert!(svc.peer_host_audio().is_none(), "会话收口要清，否则串到下一场");
}

/// G3-C：「对端静音了本机扬声器」的标记同样只属于本会话。
///
/// 它与「扬声器此刻是否静音」是两回事——本机用户自己按静音键**不会**置位
/// （我们不监听系统静音变化），所以它只回答「对端做过这个动作且没人撤销」，
/// 正是横幅提示与「恢复外放」按钮的显示条件。
#[cfg(target_os = "windows")]
#[test]
fn 对端静音标记只由对端动作驱动且随会话清掉() {
    let svc = RcService::new(store());
    assert!(!svc.spk_muted_by_peer(), "默认没有");

    svc.set_spk_muted_by_peer(true);
    assert!(svc.spk_muted_by_peer());
    // 本机一键恢复的语义 = 清掉标记（提示与按钮随之收起）
    svc.set_spk_muted_by_peer(false);
    assert!(!svc.spk_muted_by_peer());

    svc.set_spk_muted_by_peer(true);
    svc.audio_reset();
    assert!(!svc.spk_muted_by_peer(), "会话收口该清（那是本会话的事实）");
}

// ===== 2026-09-20 全量审计（docs/远程电脑-全量审计-2026-09-20.md）修复守卫 =====

/// P1-1：`audio_reset` 必须接进 `end_session`——否则被控端的 audio_muted /
/// spk_muted_by_peer 跨会话残留，下一场会话静默无声且无任何提示。
/// 这正是 wiring-gap 的形态：函数有、测试有、生产路径没人调。
#[test]
fn 守卫_end_session_真的调了audio_reset() {
    let src = include_str!("session.rs");
    assert!(
        src.contains("self.audio_reset()"),
        "end_session 没调 audio_reset——被控端音频状态会跨会话泄漏（P1-1）"
    );
}

/// P1-2：批准等待循环里，超时判定必须在 decision **之后**——
/// 批准落在最后 <200ms 窗口时，先按超时 deny 会造出没有看门者的僵尸会话。
#[test]
fn 守卫_批准循环_超时判定在decision之后() {
    let src = include_str!("service.rs");
    let loop_body = src
        .split("let deadline = now_ms() + 120_000;")
        .nth(1)
        .expect("批准等待循环不见了");
    let head = &loop_body[..loop_body.find("fn ").unwrap_or(loop_body.len())];
    let decision_pos = head.find("let decision").expect("decision 读取不见了");
    let timeout_pos = head
        .find("now_ms() > deadline")
        .expect("超时判定不见了");
    assert!(
        timeout_pos > decision_pos,
        "超时判定在 decision 读取之前（P1-2 复发）——批准落在超时窗口里会造僵尸会话"
    );
}

/// P2-1：同一 peer 双连接敲门时推流任务只能有一个——
/// Inner 上的 inbound_streaming 标记必须存在且在建立/收口两处维护。
#[test]
fn 守卫_双敲门推流所有权标记接线() {
    let svc = include_str!("service.rs");
    let ses = include_str!("session.rs");
    assert!(
        svc.contains("inbound_streaming") && ses.contains("inbound_streaming"),
        "inbound_streaming 标记没接线（P2-1 复发）——双连接批准后会 spawn 两个推流任务"
    );
}

/// 守卫：send_input 免 Control 白名单（2026-09-20 拍板）。
/// 只看可 AudioOn；SetCaptureScope 必须要求 Control。
#[test]
fn 守卫_send_input_只看可AudioOn_不得改画面范围() {
    let src = include_str!("service.rs");
    let start = src
        .find("pub async fn send_input")
        .expect("找不到 send_input");
    let body = &src[start..src[start..]
        .find("clear_outbound_link")
        .map(|i| start + i)
        .unwrap_or(src.len())];
    assert!(
        body.contains("InputEvent::AudioOn"),
        "只看会话应能发送 AudioOn（收系统声音）"
    );
    assert!(
        !body.contains("InputEvent::SetCaptureScope"),
        "SetCaptureScope 不得出现在免 Control 白名单里（只看不得改采集范围）"
    );
}

/// 守卫：文件通道准入只认 rc_devices（B-b），同步配对须先 elevate。
#[test]
fn 守卫_文件通道门禁只认rc_devices() {
    let src = include_str!("file_transfer.rs");
    assert!(
        src.contains("self.is_rc_paired(&peer)"),
        "handle_file_conn 的 paired 参数应来自 is_rc_paired，而不是 has_remote_trust 并集"
    );
}

/// 守卫：入站 input 必须先校验 session peer（防旧连接迟到输入）。
#[test]
fn 守卫_入站输入先校验会话peer() {
    let src = include_str!("inbound.rs");
    let start = src
        .find("pub(super) async fn handle_inbound_input")
        .expect("找不到 handle_inbound_input");
    let body = window(src, start, 900);
    assert!(
        body.contains("session_is(SessionPhase::InboundActive, peer)"),
        "handle_inbound_input 入口必须按 peer 校验 InboundActive 会话"
    );
}

/// 守卫：批准入站会话会 elevate 同步设备写入 rc_devices（B-b）。
#[test]
fn 守卫_approve_inbound会elevate同步设备() {
    let src = include_str!("service.rs");
    // 🔴 用「下一个函数」当结束锚点，不用 `start + N` 固定字节窗口：
    //    固定窗口会因为函数体变长而悄悄把要断言的这行挤出窗口（安静地假绿），
    //    也会因切进中文多字节字符直接 panic（2026-09-22 实测）。
    //    函数边界是稳定锚点，断言范围还更精确。
    let start = src
        .find("pub fn approve_inbound")
        .expect("找不到 approve_inbound");
    let body = &src[start..];
    let end = body
        .find("pub fn deny_inbound")
        .expect("找不到 deny_inbound（approve_inbound 之后的结束锚点）");
    let body = &body[..end];
    assert!(
        body.contains("elevate_from_sync"),
        "approve_inbound 成功后必须 elevate_from_sync"
    );
}

/// 守卫：dial_file 必须带超时（C-3）。
#[test]
fn 守卫_dial_file带超时() {
    let src = include_str!("file_transfer.rs");
    assert!(
        src.contains("connect_timeout") && src.contains("timeout(Duration::from_secs(15)"),
        "dial_file 缺少 15s 超时"
    );
}

/// 守卫：批传 open_bi 失败不得静默中断（C-4）。
#[test]
fn 守卫_批传开流失败落task() {
    let src = include_str!("file_transfer.rs");
    let start = src.find("async fn run_send_batch").expect("run_send_batch");
    let body = window(src, start, 2200);
    assert!(
        body.contains("TaskState::Failed") && body.contains("items[idx..]"),
        "run_send_batch 开流失败路径必须为剩余文件落 Failed task"
    );
}

/// 守卫：caps 必须上报 dgram_input（R3）；旧对端缺字段 → 发起端提示升级。
///
/// ⚠️ 2026-09-21：`send_caps_frame` 已从 `inbound.rs` 搬到 `inbound_tasks.rs`，
/// 本守卫的 `include_str!` 目标随之更新——**搬家不是理由删掉守卫**，
/// 而是跟着改成扫新家，否则「字段丢了」这件事会重新变成无人看守。
#[test]
fn 守卫_caps上报dgram_input() {
    let inbound_tasks = include_str!("inbound_tasks.rs");
    assert!(
        inbound_tasks.contains("\"dgram_input\": true")
            || inbound_tasks.contains("\"dgram_input\":true"),
        "send_caps_frame 必须带上 dgram_input: true，否则新被控端也会被误判为旧版"
    );
    let outbound = include_str!("outbound.rs");
    assert!(
        outbound.contains("dgram_input"),
        "outbound 解析 caps 时必须读 dgram_input（缺省 false = 旧版）"
    );
    let service = include_str!("service.rs");
    assert!(
        service.contains("peer_dgram_input"),
        "RcStatus 必须暴露 peer_dgram_input，前端升级提示才有数据源"
    );
}
// ── 2026-09-22 审计 D1 / D12 回归钉 ──────────────────────────────────

/// 🔴 D1：白名单必须落在**会话真的建立之后**。
///
/// 旧实现先落白名单再建会话，于是「密码对、但本机正忙」这种失败也留下了一行
/// `rc_devices`——那台设备一次会话都没建立过，却已经出现在你的设备列表里，
/// 还带着 `has_remote_trust = true`（此后可被当成已配对设备再敲门）。
#[test]
fn pass_admit_建会话失败时设备不入白名单() {
    let (s, _) = pass_store(true, Capability::Control);
    let svc = RcService::new(s.clone());
    let a = "ab".repeat(32);
    let b = "cd".repeat(32);
    // 第一台正常连入：会话建立 + 落白名单（同时证明凭证路径确实走得通——
    // 没有「信任绕过白名单」这条入参，这一步会死在「设备未配对」）
    assert!(matches!(
        svc.pass_admit(&a, Capability::Control, "s3cret-密码", true, T0 + 1),
        UnoAdmit::Admitted
    ));
    assert_eq!(svc.status().session.expect("第一台要建会话").peer, a);
    assert!(s.rc_device_get(&a).unwrap().is_some(), "连入成功要落白名单");
    // 第二台：密码同样正确，但本机已有会话 → establish 失败 → 不许留白名单行
    assert!(
        !matches!(
            svc.pass_admit(&b, Capability::Control, "s3cret-密码", true, T0 + 2),
            UnoAdmit::Admitted
        ),
        "本机忙时必须拒"
    );
    assert!(
        s.rc_device_get(&b).unwrap().is_none(),
        "会话没建立就不该落白名单——对方会凭空出现在设备列表里"
    );
    assert!(!svc.has_remote_trust(&b));
}

/// 🔴 D1（码路径）：`verify` 只判不消费，未 `consume` 之前一个码可被**多台**
/// 设备命中。旧实现的写库点在验码之后，于是每命中一台就写一行白名单——
/// 一次接入被洗成 N 台「已配对设备」。写库点后移后失败路径零副作用。
#[test]
fn uno_admit_建会话失败时设备不入白名单() {
    let s = store();
    set_cfg(&s, CFG_ENABLED, serde_json::Value::Bool(true));
    set_cfg(&s, CFG_CAPABILITY, serde_json::json!("control"));
    let svc = RcService::new(s.clone());
    let a = "ab".repeat(32);
    let b = "cd".repeat(32);
    // unlimited=true：窗口内可反复命中，正是考察「一个码洗多台」的场景
    let code = svc
        .uno
        .generate(T0, 900_000, true, Capability::View, false)
        .expect("生成接入码");
    assert!(matches!(
        svc.uno_admit(&a, Capability::View, &code, T0 + 1),
        UnoAdmit::Admitted
    ));
    assert!(s.rc_device_get(&a).unwrap().is_some(), "连入成功要落白名单");
    // 第二台拿同一个码，但本机已被占用 → 拒，且一行都不许留
    assert!(
        !matches!(
            svc.uno_admit(&b, Capability::View, &code, T0 + 2),
            UnoAdmit::Admitted
        ),
        "本机忙时必须拒"
    );
    assert!(
        s.rc_device_get(&b).unwrap().is_none(),
        "会话没建立就不该落白名单"
    );
    assert!(!svc.has_remote_trust(&b));
}

/// 🔴 D12：一轮重连的落地判据只认**本 id 且已 Active** 的会话。
///
/// 旧行为是「`request_session` 回 `Ok` 即视为成功」——而它是非阻塞的，
/// 落一个 `OutboundPending` 就返回，于是第一圈永远「成功」、重试与 `gave_up`
/// 不可达。网络拨号在单测里跑不起来，所以这里钉住判据本身。
#[tokio::test]
async fn 重连落地判据_只认本id的active会话() {
    let (s, _) = pass_store(true, Capability::Control);
    let svc = RcService::new(s.clone());
    // 槽位为空 = 拨号失败后 `request_session` 的错误分支留下的状态 → 不算落地
    assert!(!svc.reconnect_round_settled_with("sess-none", 1, 1).await);
    // 造一场 InboundActive 会话当替身
    let peer = "ab".repeat(32);
    assert!(matches!(
        svc.pass_admit(&peer, Capability::View, "s3cret-密码", true, T0 + 1),
        UnoAdmit::Admitted
    ));
    let id = svc.status().session.expect("要有会话").id;
    assert!(
        svc.reconnect_round_settled_with(&id, 1, 1).await,
        "本 id 且 Active 才算落地"
    );
    assert!(
        !svc.reconnect_round_settled_with("别人的会话", 1, 1).await,
        "别人的会话槽不算我的落地"
    );
}
