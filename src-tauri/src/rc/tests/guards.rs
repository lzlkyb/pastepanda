// ===== 2026-09-20 全量审计（docs/远程电脑-全量审计-2026-09-20.md）修复守卫 =====
//
// ⚠️ 这些守卫用 include_str! 扫**源码文本**。生产文件搬家（如 service.rs 拆成
// service/ 目录）时，路径必须跟着改——**搬家不是理由删掉守卫**，而是跟着扫新家。

use super::window;

/// P1-1：`audio_reset` 必须接进 `end_session`——否则被控端的 audio_muted /
/// spk_muted_by_peer 跨会话残留，下一场会话静默无声且无任何提示。
/// 这正是 wiring-gap 的形态：函数有、测试有、生产路径没人调。
#[test]
fn 守卫_end_session_真的调了audio_reset() {
    let src = include_str!("../session.rs");
    assert!(
        src.contains("self.audio_reset()"),
        "end_session 没调 audio_reset——被控端音频状态会跨会话泄漏（P1-1）"
    );
}

/// P1-2：批准等待循环里，超时判定必须在 decision **之后**——
/// 批准落在最后 <200ms 窗口时，先按超时 deny 会造出没有看门者的僵尸会话。
#[test]
fn 守卫_批准循环_超时判定在decision之后() {
    let src = include_str!("../service.rs");
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
    let svc = include_str!("../service.rs");
    let ses = include_str!("../session.rs");
    assert!(
        svc.contains("inbound_streaming") && ses.contains("inbound_streaming"),
        "inbound_streaming 标记没接线（P2-1 复发）——双连接批准后会 spawn 两个推流任务"
    );
}

/// 守卫：send_input 免 Control 白名单（2026-09-20 拍板）。
/// 只看可 AudioOn；SetCaptureScope 必须要求 Control。
#[test]
fn 守卫_send_input_只看可AudioOn_不得改画面范围() {
    let src = include_str!("../service.rs");
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
    let src = include_str!("../file_transfer.rs");
    assert!(
        src.contains("self.is_rc_paired(&peer)"),
        "handle_file_conn 的 paired 参数应来自 is_rc_paired，而不是 has_remote_trust 并集"
    );
}

/// 守卫：入站 input 必须先用**同源快照**校验 session peer（防旧连接迟到输入 + TOCTOU）。
#[test]
fn 守卫_入站输入先校验会话peer() {
    let src = include_str!("../inbound.rs");
    let start = src
        .find("pub(super) async fn handle_inbound_input")
        .expect("找不到 handle_inbound_input");
    // 函数很长（流控组注释多），用「到文件里下一处 fn 的近似」不如直接扫到 inject
    let inject_at = src[start..]
        .find("let r = inject(")
        .map(|i| start + i)
        .expect("找不到 inject 调用");
    let body = &src[start..inject_at];
    assert!(
        body.contains("session_snapshot_for(peer)"),
        "handle_inbound_input 入口必须一次加锁取快照（P1-2），不得 session_is + session_capability 两次加锁"
    );
    assert!(
        body.contains("snap.capability") || body.contains("snap.phase"),
        "能力校验必须与 peer 判定同源（同一快照）"
    );
    assert!(
        body.contains("session_peer_unchanged"),
        "注入前必须复核 peer 未变（P1-2），否则快照到注入之间的切换窗口仍可被打"
    );
}

/// 守卫：会话快照必须 peer/phase/capability 同源。
#[test]
fn 守卫_会话快照peer与能力同源() {
    let ses = include_str!("../session.rs");
    let start = ses.find("pub fn snapshot").expect("找不到 Session::snapshot");
    let body = window(ses, start, 300);
    assert!(
        body.contains("self.peer") && body.contains("self.phase") && body.contains("self.capability"),
        "snapshot 必须从同一条 Session 取 peer/phase/capability（同源）"
    );
    let svc = include_str!("../service.rs");
    let start = svc
        .find("pub(super) fn session_snapshot_for")
        .expect("找不到 session_snapshot_for");
    let body = window(svc, start, 500);
    assert!(
        body.contains("s.snapshot()"),
        "session_snapshot_for 必须走 Session::snapshot，禁止三字段各读各的"
    );
    assert!(
        body.contains("s.peer != peer"),
        "快照必须先钉 peer，防止拿到别人会话的能力"
    );
}

/// 守卫：剪贴板 48KB 量纲必须统一为「编码后 JSON 字节」（P1-12）。
#[test]
fn 守卫_剪贴板量纲统一JSON字节() {
    let svc = include_str!("../service.rs");
    assert!(
        svc.contains("fn clip_payload_ok") && svc.contains("fn clip_push_json_bytes"),
        "必须收口 clip_payload_ok / clip_push_json_bytes"
    );
    // 三处都走 clip_payload_ok
    let push_at = svc
        .find("pub async fn push_clipboard")
        .expect("push_clipboard");
    let push_body = window(svc, push_at, 600);
    assert!(
        push_body.contains("clip_payload_ok"),
        "push_clipboard 必须走 clip_payload_ok"
    );
    let inbound = include_str!("../inbound.rs");
    let start = inbound
        .find("pub(super) async fn handle_inbound_input")
        .expect("handle_inbound_input");
    let body = &inbound[start..];
    assert!(
        body.contains("clip_push_json_bytes") && body.contains("clip_pull_json_bytes"),
        "入站 push/pull 都必须按编码后 JSON 字节卡"
    );
    assert!(
        body.contains("clip_payload_ok"),
        "入站必须走 clip_payload_ok，禁止再直接比 text.len()"
    );
    assert!(
        !body.contains("text.len() > CLIPBOARD_MAX_JSON_BYTES")
            && !body.contains("t.len() > CLIPBOARD_MAX_JSON_BYTES"),
        "禁止 raw text 长度与 JSON 字节混用（P1-12）"
    );
}

/// 守卫：BruteGate 满表逐出必须跳过锁定条目（P2-1）。
#[test]
fn 守卫_BruteGate逐出跳过锁定() {
    let src = include_str!("../unop.rs");
    let start = src
        .find("pub fn record_failure")
        .expect("找不到 record_failure");
    let body = window(src, start, 700);
    assert!(
        body.contains("locked_until_ms"),
        "record_failure 逐出前必须过滤 locked_until_ms（P2-1）"
    );
}

/// 守卫：pin_ok 必须验附加证明（P1-1）。
#[test]
fn 守卫_pin_ok必须验附加证明() {
    let pin = include_str!("../pin.rs");
    assert!(
        pin.contains("fn pin_ok_proof") && pin.contains("fn verify_pin_ok_proof"),
        "必须有 pin_ok_proof / verify_pin_ok_proof"
    );
    let start = pin.find("pub fn on_ok").expect("找不到 on_ok");
    let body = window(pin, start, 900);
    assert!(
        body.contains("verify_pin_ok_proof"),
        "on_ok 必须先验 ok_proof"
    );
    let wire = include_str!("../../sync/presence/wire.rs");
    assert!(
        wire.contains("ok_proof"),
        "Wire 必须带 ok_proof 字段（serde default/optional）"
    );
    // 签名仍只盖 node_id|port|ts——扩了会废掉互通
    let sign_at = wire.find("fn signing_bytes").expect("signing_bytes");
    let sign_body = window(wire, sign_at, 400);
    assert!(
        sign_body.contains("node_id") && sign_body.contains("port") && sign_body.contains("ts"),
        "signing_bytes 仍只签 node_id|port|ts"
    );
    assert!(
        !sign_body.contains("kind") && !sign_body.contains("ok_proof"),
        "不得把 kind/ok_proof 塞进 signing_bytes（会破坏旧版互通）"
    );
}

/// 剪贴板上限纯函数：边界必须恰好卡在 JSON 字节。
#[test]
fn 剪贴板上限_按JSON字节卡() {
    use crate::rc::service::{clip_payload_ok, clip_push_json_bytes, CLIPBOARD_MAX_JSON_BYTES};

    assert!(clip_payload_ok(0));
    assert!(clip_payload_ok(CLIPBOARD_MAX_JSON_BYTES));
    assert!(!clip_payload_ok(CLIPBOARD_MAX_JSON_BYTES + 1));

    // 中文：raw 字符数远小于 JSON 字节——这就是 P1-12 的量纲陷阱
    let zh = "中".repeat(10_000); // 3 万 UTF-8 字节，JSON 里还带转义/信封
    let raw = zh.len();
    let json = clip_push_json_bytes(&zh);
    assert!(
        json > raw,
        "JSON 编码后必须 ≥ raw（envelope + 可能的转义）：raw={raw} json={json}"
    );
    // raw 未超线但 JSON 因信封超线 → 必须拒（按 JSON 判）
    let almost_raw = "a".repeat(CLIPBOARD_MAX_JSON_BYTES - 20);
    let almost_json = clip_push_json_bytes(&almost_raw);
    assert!(
        almost_json > CLIPBOARD_MAX_JSON_BYTES,
        "raw 未超但 JSON 超限时量纲必须是 JSON：raw={} json={almost_json}",
        almost_raw.len()
    );
    assert!(!clip_payload_ok(almost_json));
    // 留足信封余量的 raw 应能过
    let safe_raw = "a".repeat(CLIPBOARD_MAX_JSON_BYTES - 256);
    assert!(clip_payload_ok(clip_push_json_bytes(&safe_raw)));
}

/// 会话快照纯函数：三字段同源。
#[test]
fn 会话快照_三字段同源() {
    use crate::rc::protocol::{Capability, SessionPhase};
    use crate::rc::session::Session;

    let s = Session {
        id: "id1".into(),
        peer: "peer-A".into(),
        peer_name: "甲".into(),
        capability: Capability::Control,
        phase: SessionPhase::InboundActive,
        started_ms: 1,
        granted: true,
    };
    let snap = s.snapshot();
    assert_eq!(snap.peer, "peer-A");
    assert_eq!(snap.phase, SessionPhase::InboundActive);
    assert_eq!(snap.capability, Capability::Control);
}

/// 守卫：批准入站会话会 elevate 同步设备写入 rc_devices（B-b）。
#[test]
fn 守卫_approve_inbound会elevate同步设备() {
    let src = include_str!("../service.rs");
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
    let src = include_str!("../file_transfer.rs");
    assert!(
        src.contains("connect_timeout") && src.contains("timeout(Duration::from_secs(15)"),
        "dial_file 缺少 15s 超时"
    );
}

/// 守卫：批传 open_bi 失败不得静默中断（C-4）。
#[test]
fn 守卫_批传开流失败落task() {
    let src = include_str!("../file_transfer.rs");
    let start = src.find("async fn run_send_batch").expect("run_send_batch");
    let body = window(src, start, 2200);
    assert!(
        body.contains("TaskState::Failed") && body.contains("items[idx..]"),
        "run_send_batch 开流失败路径必须为剩余文件落 Failed task"
    );
}

/// 守卫：COM Drop 必须先放引用再 CoUninitialize（P1-3）。
#[test]
fn 守卫_COM释放先于Uninit() {
    for (name, src) in [
        ("encode_h264.rs", include_str!("../encode_h264.rs")),
        ("audio.rs", include_str!("../audio.rs")),
    ] {
        let start = src.find("fn release_com").unwrap_or_else(|| panic!("{name} 缺 release_com"));
        // 取 release_com 到 impl Drop 之间的函数体
        let body = &src[start..];
        let end = body
            .find("impl Drop")
            .unwrap_or_else(|| panic!("{name} release_com 后找不到 impl Drop"));
        let body = &body[..end];
        let pos_clear = body
            .find("transform = None")
            .unwrap_or_else(|| panic!("{name} release_com 未置空 transform"));
        let pos_uninit = body
            .find("CoUninitialize")
            .unwrap_or_else(|| panic!("{name} release_com 缺 CoUninitialize"));
        assert!(
            pos_clear < pos_uninit,
            "{name}: 必须先放 COM 字段再 CoUninitialize（顺序反了是悬垂释放）"
        );
    }
}

/// 守卫：deny_file 不得关整条连接（P2-5，多文件批次）。
#[test]
fn 守卫_deny_file只关流不关连接() {
    let src = include_str!("../file_transfer.rs");
    let start = src.find("async fn deny_file").expect("deny_file");
    let end = src[start..]
        .find("\n}")
        .map(|i| start + i)
        .expect("deny_file end");
    let body = &src[start..end];
    assert!(
        !body.contains("conn.close"),
        "deny_file 不得 conn.close——单文件拒绝会杀掉整批后续文件"
    );
    assert!(
        body.contains("send.finish()"),
        "deny_file 必须 finish 当前 bi-stream"
    );
}

/// 守卫：入站剪贴板必须走 spawn_blocking（P2-4），禁止在 async 里 thread::sleep。
#[test]
fn 守卫_入站剪贴板走spawn_blocking() {
    let input = include_str!("../input.rs");
    assert!(
        input.contains("fn set_clipboard_text_async")
            && input.contains("spawn_blocking"),
        "必须提供 spawn_blocking 包装"
    );
    let inbound = include_str!("../inbound.rs");
    assert!(
        inbound.contains("set_clipboard_text_async") && inbound.contains("get_clipboard_text_async"),
        "handle_inbound_input 必须调用 async 包装，而不是同步 sleep 版本"
    );
    // 同步版不得再被 async 路径直接调用
    let start = inbound
        .find("pub(super) async fn handle_inbound_input")
        .expect("handle_inbound_input");
    let body = window(inbound, start, 4000);
    assert!(
        !body.contains("set_clipboard_text(") && !body.contains("get_clipboard_text()"),
        "handle_inbound_input 不得直接调同步剪贴板（会占 tokio worker）"
    );
}

/// 守卫：音频通道必须有界（P2-3），不得 unbounded。
#[test]
fn 守卫_音频通道有界() {
    let inbound_tasks = include_str!("../inbound_tasks.rs");
    assert!(
        inbound_tasks.contains("mpsc::channel::<super::audio::AudioOut>"),
        "音频队列必须是有界 channel"
    );
    assert!(
        !inbound_tasks.contains("unbounded_channel"),
        "禁止 unbounded_channel——无背压会把包堆到 OOM"
    );
    let audio = include_str!("../audio.rs");
    assert!(
        audio.contains("fn try_push_audio") && audio.contains("try_send"),
        "生产侧必须 try_send 满则丢包，禁止无限 send"
    );
}

/// 守卫：收尾改名不得用会覆盖目标的 rename（P1-4）。
#[test]
fn 守卫_收尾改名不覆盖() {
    let src = include_str!("../file_transfer.rs");
    assert!(
        src.contains("fn rename_no_overwrite") && src.contains("hard_link"),
        "收尾必须用 hard_link（目标存在则失败）而不是会覆盖的 rename"
    );
    let recv = src
        .find("async fn recv_bytes")
        .expect("recv_bytes");
    let body = window(src, recv, 2500);
    assert!(
        body.contains("metadata") && body.contains("plan.offset"),
        "recv_bytes 必须用磁盘长度复核 plan.offset"
    );
}

/// 守卫：file_busy 不得与 task_start 分两把锁（P2-6 TOCTOU）。
#[test]
fn 守卫_入站accept原子占位() {
    let ft = include_str!("../file_transfer.rs");
    assert!(
        ft.contains("try_reserve_peer"),
        "handle_file_conn 必须 try_reserve_peer 占位"
    );
    let fs = include_str!("../file_state.rs");
    let start = fs.find("pub(crate) fn try_reserve_peer").expect("try_reserve_peer");
    let body = window(fs, start, 600);
    assert!(
        body.contains("peer_busy_inner") && body.contains("peers.insert"),
        "try_reserve_peer 必须在同一临界区内查 busy 并占位"
    );
}

/// 守卫：caps 必须上报 dgram_input（R3）；旧对端缺字段 → 发起端提示升级。
///
/// ⚠️ 2026-09-21：`send_caps_frame` 已从 `inbound.rs` 搬到 `inbound_tasks.rs`，
/// 本守卫的 `include_str!` 目标随之更新——**搬家不是理由删掉守卫**，
/// 而是跟着改成扫新家，否则「字段丢了」这件事会重新变成无人看守。
#[test]
fn 守卫_caps上报dgram_input() {
    let inbound_tasks = include_str!("../inbound_tasks.rs");
    assert!(
        inbound_tasks.contains("\"dgram_input\": true")
            || inbound_tasks.contains("\"dgram_input\":true"),
        "send_caps_frame 必须带上 dgram_input: true，否则新被控端也会被误判为旧版"
    );
    let outbound = include_str!("../outbound.rs");
    assert!(
        outbound.contains("dgram_input"),
        "outbound 解析 caps 时必须读 dgram_input（缺省 false = 旧版）"
    );
    let service = include_str!("../service.rs");
    assert!(
        service.contains("peer_dgram_input"),
        "RcStatus 必须暴露 peer_dgram_input，前端升级提示才有数据源"
    );
}

/// os 自报的**接线守卫**：协议里加了字段 ≠ 接上了。
///
/// 两处必须成对——被控端发 `Accept` 时带上本机系统，控制端收 `Accept` 时写库。
/// 只做前者 = 白传；只做后者 = 永远收不到。收发都在网络循环里（`handle_inbound_conn`
/// 的等待循环 + `request_session` 的读帧），单测跑不起来，所以照本项目既有做法
/// （见 `守卫_caps上报dgram_input`）用 `include_str!` 钉住源码里的接线。
#[test]
fn 守卫_accept_自报os两端接线成对() {
    let service = include_str!("../service.rs");
    assert!(
        service.contains("local_os_label"),
        "被控端发 Accept 时必须带上本机系统（否则对端永远拿不到）"
    );
    assert!(
        service.contains("rc_device_note_os"),
        "控制端收到 Accept 后必须把 os 写进设备行（否则协议的字段白传）"
    );
}

/// Win11 判据：22000 是分界，且**不能退化成读 ProductName**。
///
/// 真机是 Win10 还是 Win11 由注册表决定，跑不了「换台机器再试」，
/// 所以判据抽成纯函数（`rc::os_label_from_build`）在这里钉住边界。
#[cfg(target_os = "windows")]
#[test]
fn win11_判据看build不看productname() {
    use crate::rc::os_label_from_build;

    // 边界 21999 ↔ 22000：21999 是 Win10 的末代 build，22000 是首个 Win11 正式版
    assert_eq!(os_label_from_build("21999"), "Windows 10");
    assert_eq!(os_label_from_build("22000"), "Windows 11");
    assert_eq!(os_label_from_build("19045"), "Windows 10", "Win10 22H2");
    assert_eq!(os_label_from_build("22631"), "Windows 11", "Win11 23H2");
    assert_eq!(os_label_from_build("26100"), "Windows 11", "Win11 24H2");
    // 空白 / 解不开 → 不带版本号，不编
    assert_eq!(os_label_from_build(""), "Windows");
    assert_eq!(os_label_from_build("abc"), "Windows");
    assert_eq!(os_label_from_build("  22631  "), "Windows 11", "前后空白要容错");

    // 源码守卫：判据读 build，不读 ProductName
    let module = include_str!("../mod.rs");
    assert!(
        module.contains("CurrentBuildNumber"),
        "Win11 判据必须读 CurrentBuildNumber"
    );
    assert!(
        !module.contains(r#"get_value("ProductName")"#),
        "Win11 判据不得读 ProductName——Win11 上它照样返回「Windows 10」"
    );
}

/// 本机自报的标签必须是真值：非空，Windows 上属 Windows 系列。
#[test]
fn os_label_非空且前缀正确() {
    let label = crate::rc::local_os_label();
    assert!(
        !label.trim().is_empty(),
        "采不到也只能退到「Windows」这类真值，不能是空白"
    );
    #[cfg(target_os = "windows")]
    assert!(
        label.starts_with("Windows"),
        "Windows 上应报 Windows 系列，实得 {label}"
    );
}
