// ── Q2 方案 C：固定密码准入（pass_admit）────────────────────────────
// UnoAdmit 是 service 的私有枚举；这里只断言**可观测状态**（会话、白名单、
// 闸），与「黑盒用户会看到什么」对齐。

use super::{set_cfg, store};
use crate::data_store::DataStore;
use crate::rc::protocol::{Capability, SessionPhase};
use crate::rc::service::{RcService, UnoAdmit};
use crate::rc::session::{CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED};
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
