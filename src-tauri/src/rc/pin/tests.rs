//! `pin.rs` 的单元测试（原样平移）。

use super::*;

fn store() -> DataStore {
    DataStore::new(":memory:").expect("open store")
}

const T0: i64 = 1_757_000_000_000;

/// 测试辅助：用**发送侧**会话算一份 pin_ok 证明（与 discovery 发送同源）。
fn pin_ok_proof_sender(sender: &Pairs, sender_node_id: &str, ts: i64) -> String {
    sender
        .pin_ok_proof_for(sender_node_id, ts)
        .expect("协商完成后必须能算出证明")
}

/// 测试辅助：填一份 [`PinOkIn`]。
fn ok_in(peer_id: &str, my_node_id: &str, ts: i64, ok_proof: &str) -> PinOkIn {
    PinOkIn {
        peer_id: peer_id.to_string(),
        my_node_id: my_node_id.to_string(),
        ts,
        ok_proof: ok_proof.to_string(),
    }
}

/// 走完 A→B 握手到「两边公钥齐、数字已出」。返回 (a, b)。
fn handshake() -> (Pairs, Pairs) {
    let a = Pairs::new(store());
    let b = Pairs::new(store());
    let (pa, out) = a.start("bb", "笔记本", T0).unwrap();
    let Outgoing::Packet { pk: pk_a, .. } = out else {
        panic!("发起方要发 pin_req");
    };
    assert_eq!(pa.pin.len(), 0, "发起方一开始还没有数字（在等对方公钥）");
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
    assert!(a.on_resp("bb", &pk_b, T0 + 20), "协商要成功");
    (a, b)
}

/// 🔴 全组最要紧的一条：**两端拿到同一个公钥，数字就必须一样**。
/// 这就是「用户对一眼数字」能成立的全部前提。
#[test]
fn 走完一轮握手两端数字一致且是六位() {
    let (a, b) = handshake();
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

    // A 收到 B 的 pin_ok（带合法证明）→ 这下该落库了
    let proof = pin_ok_proof_sender(&b, "bb", T0 + 3);
    assert_eq!(
        a.on_ok(ok_in("bb", "aa", T0 + 3, &proof), T0 + 3),
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
    let proof = pin_ok_proof_sender(&b, "bb", T0 + 2);
    assert_eq!(
        a.on_ok(ok_in("bb", "aa", T0 + 2, &proof), T0 + 2),
        None,
        "本端没确认，还不该落库"
    );
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

/// 落库成功之后完成屏能拿到「刚配了谁」，而且**窗口内每个读者都拿得到**。
///
/// 🔴 P1-7（2026-09-23 审计）：原名字是「读一次就清」——那条语义在有两个并发
/// 轮询者（主窗口 + 工作台）的界面下是错的，第二个读者永远看不到成功屏。
/// 窗口期到点自灭由 `完成屏超过可见窗口后不再重复弹` 钉住。
#[test]
fn 完成屏信息窗口内多重可读() {
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
    let proof = pin_ok_proof_sender(&b, "bb", T0 + 2);
    a.on_ok(ok_in("bb", "aa", T0 + 2, &proof), T0 + 2);

    let d = a.peek_done(T0 + 2).expect("应该有完成信息");
    assert_eq!(d.peer_id, "bb");
    assert_eq!(d.peer_name, "笔记本");
    assert_eq!(d.at_ms, T0 + 2);
    assert!(d.initiator, "A 是发起方（它 start 的）");
    // 🔴 P1-7：窗口内**读而不清**——主窗口与工作台两个轮询者都要看得见这一条
    assert!(
        a.peek_done(T0 + 2).is_some(),
        "同一窗口内第二次读必须还在（旧 take 语义下第二个读者永远看不到完成屏）"
    );
    assert!(s.rc_device_get("bb").unwrap().is_some());
}

/// 🔴 P1-7（2026-09-23 审计）：完成屏**到点自灭**。
///
/// 不清的话更坏：用户下次打开设置页还会再弹一次「已与 X 配对 / 立刻发起远程」，
/// 像是刚刚又配了一次。所以「多重可读」必须配一个窗口期。
#[test]
fn 完成屏超过可见窗口后不再重复弹() {
    let pairs = Pairs::new(store());
    *pairs.done.lock().unwrap() = Some(Done {
        peer_id: "bb".to_string(),
        peer_name: "笔记本".to_string(),
        initiator: true,
        at_ms: T0,
    });

    // 正好卡在边界上：还看得见（判据是严格 `>`）
    assert!(pairs.peek_done(T0 + DONE_VISIBLE_MS).is_some());
    // 越过窗口：读不到
    assert!(pairs.peek_done(T0 + DONE_VISIBLE_MS + 1).is_none());
    // 而且**读到时就当场清掉**——不是留着让下一个人继续读到旧闻
    assert!(
        pairs.done.lock().unwrap().is_none(),
        "过期后读到即清，槽里不该继续留着旧闻"
    );
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
    let proof_b = pin_ok_proof_sender(&b, "bb", T0 + 2);
    assert_eq!(a.on_ok(ok_in("bb", "aa", T0 + 2, &proof_b), T0 + 2), None);
    // 🔴 先把 A 那侧的 pin_ok 证明算出来：A 点确认时若两端都已确认会当场落库
    // 并清会话，之后就算不出 shared 证明了（测试里模拟「B 收到 A 的 pin_ok」）。
    let proof_a = pin_ok_proof_sender(&a, "aa", T0 + 4);
    // A 点确认 → A 落库
    a.confirm(T0 + 3);
    // B 收到 A 的 pin_ok → B 落库
    b.on_ok(ok_in("aa", "bb", T0 + 4, &proof_a), T0 + 4);

    let da = a.peek_done(T0 + 4).expect("A 应该有完成信息");
    assert!(da.initiator, "A 点的是「配对」，它是发起方");
    assert_eq!(da.peer_id, "bb");

    let db = b.peek_done(T0 + 4).expect("B 应该有完成信息");
    assert!(!db.initiator, "B 是被请求的那一侧");
    assert_eq!(db.peer_id, "aa");
}

/// 🔴 P1-1：伪造 pin_ok（无 proof / 错 proof）不得 `commit_allowed`。
#[test]
fn 伪造pin_ok无证明或错证明不得落库() {
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
    // A 已点确认，在等对方 pin_ok——此刻伪造最容易得手
    assert!(matches!(
        a.confirm(T0 + 1).0,
        Confirmed::Waiting { .. }
    ));

    // ① 无 proof：中间人偷换 kind 冒充 pin_ok 的典型形态
    assert_eq!(
        a.on_ok(ok_in("bb", "aa", T0 + 2, ""), T0 + 2),
        None,
        "无 proof 的 pin_ok 一律不认"
    );
    // ② 错 proof
    assert_eq!(
        a.on_ok(ok_in("bb", "aa", T0 + 2, "deadbeef"), T0 + 2),
        None,
        "错 proof 一律不认"
    );
    // ③ proof 与 ts 不绑：换 ts 后旧 proof 失效
    let proof = pin_ok_proof_sender(&b, "bb", T0 + 2);
    assert_eq!(
        a.on_ok(ok_in("bb", "aa", T0 + 2 + 1, &proof), T0 + 3),
        None,
        "proof 必须绑定包内 ts"
    );
    assert!(
        s.rc_device_get("bb").unwrap().is_none(),
        "伪造 pin_ok 绝不能落库"
    );

    // 合法 proof 才放行（B 真的点过确认）
    b.confirm(T0 + 4);
    let proof = pin_ok_proof_sender(&b, "bb", T0 + 5);
    assert!(
        matches!(
            a.on_ok(ok_in("bb", "aa", T0 + 5, &proof), T0 + 5),
            Some(Confirmed::Committed { .. })
        ),
        "合法证明必须能走完"
    );
    assert!(s.rc_device_get("bb").unwrap().is_some());
}

/// 证明纯函数：往返一致、分道不串、空 proof 拒。
#[test]
fn pin_ok_proof_往返与分道() {
    let shared = [7u8; 32];
    let p = pin_ok_proof(&shared, "aa", "bb", T0);
    assert!(verify_pin_ok_proof(&shared, "aa", "bb", T0, &p));
    assert!(!verify_pin_ok_proof(&shared, "aa", "bb", T0, ""), "空 proof 拒");
    assert!(!verify_pin_ok_proof(&shared, "aa", "bb", T0, "00"), "错 proof 拒");
    assert!(
        !verify_pin_ok_proof(&shared, "aa", "cc", T0, &p),
        "to_id 必须进绑定"
    );
    assert!(!verify_pin_ok_proof(&shared, "bb", "bb", T0, &p), "node_id 必须进绑定");
    assert!(!verify_pin_ok_proof(&shared, "aa", "bb", T0 + 1, &p), "ts 必须进绑定");
    let other = [8u8; 32];
    assert!(
        !verify_pin_ok_proof(&other, "aa", "bb", T0, &p),
        "不同 shared 算不出同一份证明"
    );
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
