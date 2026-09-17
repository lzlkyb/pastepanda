//! R0 门禁与状态机单测（不起网络、不起 tauri）。

use crate::data_store::DataStore;
use crate::rc::protocol::{Capability, SessionPhase};
use crate::rc::service::RcService;
use crate::rc::session::{gate_inbound, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED};

fn store() -> DataStore {
    DataStore::new(":memory:").expect("open store")
}

fn set_cfg(store: &DataStore, key: &str, val: serde_json::Value) {
    let mut c = store.get_config().unwrap_or_default();
    c.as_object_mut().unwrap().insert(key.to_string(), val);
    store.save_config(&c).unwrap();
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
        .request_session(&"aa".repeat(32), Capability::View)
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
        .request_session(&"bb".repeat(32), Capability::View)
        .await
        .unwrap_err();
    assert!(err.contains("通道未启动"), "{err}");
    assert!(svc.require_active().is_err());
}

#[test]
fn needs_channel_when_paired_without_being_remoted() {
    let s = store();
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

    /// 在线判定三条证据：presence live / 正在开会话 / last_seen 未过期的 online。
    #[test]
    fn is_rc_online_for_three_evidences() {
        use crate::rc::session::{is_rc_online_for, ONLINE_STALE_MS};
        use std::collections::HashSet;

        let now = 1_000_000i64;
        let mut live = HashSet::new();
        let peer = "p".repeat(64);

        // 1. presence 听得见 → 无论库里怎么说都在线
        live.insert(peer.clone());
        assert!(is_rc_online_for(&peer, "offline", 0, &live, None, now));
        live.clear();

        // 2. 正在开会话 → 无论库里怎么说都在线
        assert!(is_rc_online_for(&peer, "offline", 0, &live, Some(&peer), now));

        // 3. 库里 online 且 last_seen 未过期（跨网唯一线索）
        assert!(is_rc_online_for(
            &peer,
            "online",
            now - ONLINE_STALE_MS,
            &live,
            None,
            now
        ));
        assert!(!is_rc_online_for(
            &peer,
            "online",
            now - ONLINE_STALE_MS - 1,
            &live,
            None,
            now
        ));

        // 刚配对 / last_seen=0 的 online 是假的（进程被杀会定格 online）
        assert!(!is_rc_online_for(&peer, "online", 0, &live, None, now));
        // 会话 peer 不是这台 → 不借力
        assert!(!is_rc_online_for(&peer, "offline", 0, &live, Some("other"), now));
        // 库里 offline 且没 live → 离线
        assert!(!is_rc_online_for(&peer, "offline", now - 1, &live, None, now));
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

    /// 🔴 回归：会话收口**不得**把对端打成 offline、**不得**清 last_seen。
    /// 旧行为 touch(false) 导致「只要开过一次远程就永远显示离线」。
    #[tokio::test]
    async fn end_session_keeps_peer_online_and_last_seen() {
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
        assert_eq!(
            after.conn_state, "online",
            "收口后对端仍是 online——会话结束 ≠ 对端关机"
        );
        assert!(
            after.last_seen >= before.last_seen,
            "收口必须刷新或至少保留 last_seen，不能清 0"
        );
    }
}
