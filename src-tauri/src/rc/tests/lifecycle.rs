/// 会话生命周期（实现在 `session.rs` 的 `impl RcService`）。
///
/// 这里用「直接塞 `inner.session`」构造最小状态，不走真实握手——
/// 测的是收口逻辑本身，不是门禁（门禁在别处已有覆盖）。
use super::{store, window};
use crate::rc::protocol::{Capability, SessionPhase};
use crate::rc::service::RcService;
use crate::rc::session::Session;

fn active_session(id: &str, phase: SessionPhase) -> Session {
    Session {
        id: id.to_string(),
        peer: "peer-a".to_string(),
        peer_name: "设备A".to_string(),
        display_name: String::new(),
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

/// 方案 B（2026-09-23）：`status()` 投影时从配对表现查备注回填
/// `session.display_name`，改备注不用等下一场会话就能生效。
#[test]
fn status_投影时回填会话显示名_备注优先() {
    let svc = RcService::new(store());
    svc.store.rc_device_pair("peer-a", "DESKTOP-A").expect("配对");
    svc.store.rc_device_note_set("peer-a", "工作电脑").expect("起备注");
    set_session(&svc, active_session("s1", SessionPhase::OutboundActive));

    let s = svc.status().session.expect("会话在");
    assert_eq!(s.display_name, "工作电脑", "有备注 → 显示备注");
    assert_eq!(s.peer_name, "设备A", "自报名快照原样保留，不清不覆");

    // 清掉备注（写纯空白 = 清除）→ display_name 留空，前端回落自报名
    svc.store.rc_device_note_set("peer-a", "   ").expect("清备注");
    let s = svc.status().session.expect("会话在");
    assert_eq!(s.display_name, "", "没备注 → 空串，绝不编默认值");
}

/// 待确认申请（InboundKnock）同样要在投影时回填显示名——
/// 批准弹窗上的「谁在申请远程」不能继续喊改备注前的旧名字。
#[test]
fn status_投影时回填待确认申请的显示名() {
    let svc = RcService::new(store());
    svc.store.rc_device_pair("peer-a", "DESKTOP-A").expect("配对");
    svc.store.rc_device_note_set("peer-a", "工作电脑").expect("起备注");
    svc.inner
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .pending
        .push(crate::rc::service::InboundKnock {
            peer: "peer-a".into(),
            peer_name: "DESKTOP-A".into(),
            display_name: String::new(),
            capability: crate::rc::protocol::Capability::View,
            first_seen_ms: crate::rc::service::now_ms(),
        });

    let st = svc.status();
    assert_eq!(st.pending.len(), 1, "前置：一条待确认申请");
    assert_eq!(st.pending[0].display_name, "工作电脑");
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
    let src = include_str!("../session.rs");
    let start = src
        .find("pub fn is_rc_online_for(")
        .expect("找不到 is_rc_online_for");
    let body = window(src, start, 1400);
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
        ("session/lifecycle.rs", include_str!("../session/lifecycle.rs")),
        ("inbound.rs", include_str!("../inbound.rs")),
        ("outbound.rs", include_str!("../outbound.rs")),
        ("service/mod.rs", include_str!("../service/mod.rs")),
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
