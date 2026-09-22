// ===== 邀请门 × 邀请码：口径唯一（2026-09-17） =====
// 「门与码同宽」那条钉在 `commands/rc.rs` 里（常量定义处，模块是私有的）。

use super::store;
use crate::rc::protocol::Capability;
use crate::rc::service::RcService;

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
