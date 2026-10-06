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
    let src = include_str!("../session/lifecycle.rs");
    assert!(
        src.contains("self.audio_reset()"),
        "end_session 没调 audio_reset——被控端音频状态会跨会话泄漏（P1-1）"
    );
}

/// P1-2：批准等待循环里，超时判定必须在 decision **之后**——
/// 批准落在最后 <200ms 窗口时，先按超时 deny 会造出没有看门者的僵尸会话。
#[test]
fn 守卫_批准循环_超时判定在decision之后() {
    let src = include_str!("../service/inbound.rs");
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
    let svc = include_str!("../service/inbound.rs");
    let ses = include_str!("../session/lifecycle.rs");
    assert!(
        svc.contains("inbound_streaming") && ses.contains("inbound_streaming"),
        "inbound_streaming 标记没接线（P2-1 复发）——双连接批准后会 spawn 两个推流任务"
    );
}

/// 守卫：send_input 免 Control 白名单（2026-09-20 拍板）。
/// 只看可 AudioOn；SetCaptureScope 必须要求 Control。
#[test]
fn 守卫_send_input_只看可AudioOn_不得改画面范围() {
    let src = include_str!("../service/frames_clip.rs");
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
    let src = include_str!("../file_transfer/serve.rs");
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
    let svc = include_str!("../service/frames_clip.rs");
    let start = svc
        .find("fn session_snapshot_for")
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
    let svc = include_str!("../service/mod.rs");
    assert!(
        svc.contains("fn clip_payload_ok") && svc.contains("fn clip_push_json_bytes"),
        "必须收口 clip_payload_ok / clip_push_json_bytes"
    );
    // 三处都走 clip_payload_ok
    let push_src = include_str!("../service/frames_clip.rs");
    let push_at = push_src
        .find("pub async fn push_clipboard")
        .expect("push_clipboard");
    let push_body = window(push_src, push_at, 600);
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
    // 证明函数 2026-09-22 拆到 pin/proof.rs；on_ok 仍在 pin.rs。
    let proof = include_str!("../pin/proof.rs");
    assert!(
        proof.contains("fn pin_ok_proof") && proof.contains("fn verify_pin_ok_proof"),
        "必须有 pin_ok_proof / verify_pin_ok_proof"
    );
    let pin = include_str!("../pin.rs");
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
        display_name: String::new(),
        capability: Capability::Control,
        phase: SessionPhase::InboundActive,
        started_ms: 1,
        started_mono: 0,
        granted: true,
        bg_since_mono: 0,
    };
    let snap = s.snapshot();
    assert_eq!(snap.peer, "peer-A");
    assert_eq!(snap.phase, SessionPhase::InboundActive);
    assert_eq!(snap.capability, Capability::Control);
}

/// 守卫：批准入站会话会 elevate 同步设备写入 rc_devices（B-b）。
#[test]
fn 守卫_approve_inbound会elevate同步设备() {
    let src = include_str!("../service/inbound_accept.rs");
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
    let src = include_str!("../file_transfer/api.rs");
    assert!(
        src.contains("connect_timeout") && src.contains("timeout(Duration::from_secs(15)"),
        "dial_file 缺少 15s 超时"
    );
}

/// 守卫：批传 open_bi 失败不得静默中断（C-4）。
#[test]
fn 守卫_批传开流失败落task() {
    let src = include_str!("../file_transfer/transfer.rs");
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
        ("encode_h264/mf.rs", include_str!("../encode_h264/mf.rs")),
        ("audio/encode.rs", include_str!("../audio/encode.rs")),
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
///
/// 🔴 B6（2026-09-25 审计）改写：旧断言钉的「try_send 满则丢包」恰恰是缺陷
/// 本体——满时丢的是**最新**包（Cfg 被丢还会让对端变调），与「音频要新鲜」
/// 的设计注释相反。新断言钉的是修复后的不变量：队列来自 audio_channel() 的
/// 满丢最旧包装（pop_front 挤最旧 / push_back 保最新），容量仍是常量。
#[test]
fn 守卫_音频通道有界() {
    let inbound_tasks = include_str!("../inbound_tasks.rs");
    assert!(
        inbound_tasks.contains("super::audio::audio_channel()"),
        "音频队列必须来自 audio::audio_channel()（B6：有界 + 满丢最旧）"
    );
    assert!(
        !inbound_tasks.contains("unbounded_channel"),
        "禁止 unbounded_channel——无背压会把包堆到 OOM"
    );
    let audio = include_str!("../audio.rs");
    assert!(
        audio.contains("fn try_push_audio") && audio.contains("pop_front"),
        "生产侧必须满丢最旧（B6）：pop_front 挤掉最旧、push_back 保住最新"
    );
    assert!(
        audio.contains("AUDIO_CHAN_CAP"),
        "容量必须仍由常量 AUDIO_CHAN_CAP 决定，禁止无界堆积（P2-3）"
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
    let ft = include_str!("../file_transfer/serve.rs");
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
    let service = include_str!("../service/streaming.rs");
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
    // 两端分家（2026-09-22 service.rs 拆分）：发 os 在被控端 handle_inbound_conn
    // （service/inbound.rs），收 os 写库在发起端 dial_and_request（service/outbound.rs）。
    let host_side = include_str!("../service/inbound.rs");
    assert!(
        host_side.contains("local_os_label"),
        "被控端发 Accept 时必须带上本机系统（否则对端永远拿不到）"
    );
    let controller_side = include_str!("../service/outbound.rs");
    assert!(
        controller_side.contains("rc_device_note_os"),
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

/// 守卫：COM 公寓初始化必须走 `mft_diag::ensure_mta_quiet` 收口（2026-09-23）。
///
/// 背景：真机被控推流恒走 JPEG 兜底，NVIDIA 硬编报
/// `ActivateObject 失败 0x8000FFFF (E_UNEXPECTED)`，而**同机同参数的外部探针 ✓**。
/// 首要嫌疑是跑选型的 tokio worker 被别处（UIA）初始化成了 STA —— 此时
/// `CoInitializeEx(MTA)` 返回 `RPC_E_CHANGED_MODE`，公寓仍是 STA，代码却照常跑。
///
/// 这三处调用点过去分别用 `let _ = ...` 和 `.is_ok()` **丢弃返回值**，
/// 让「请求 MTA 被拒」在日志里完全隐形。验收标准按 AGENTS.md §11.1：
/// *第 4 个调用点被人新写出来时仍会走错 ⇒ 说明还没收口*。所以这里禁止
/// 这三个文件再直接出现 `CoInitializeEx`，必须经收口函数。
#[test]
fn 守卫_COM公寓初始化必须收口() {
    for (name, src) in [
        ("rc/gpu.rs", include_str!("../gpu.rs")),
        ("rc/dxgi.rs", include_str!("../dxgi.rs")),
        ("rc/encode_h264/mf.rs", include_str!("../encode_h264/mf.rs")),
    ] {
        assert!(
            src.contains("ensure_mta_quiet"),
            "{name} 的 COM 初始化必须走 mft_diag::ensure_mta_quiet（被拒时需留证据）"
        );
        // 只匹配**真实调用形式**（`CoInitializeEx(None, …)`）——注释里提到函数名是
        // 正常的，不该因此判红
        assert!(
            !src.contains("CoInitializeEx(None"),
            "{name} 仍直接调用 CoInitializeEx —— 返回值会被再次静默丢弃，改走 ensure_mta_quiet"
        );
    }
}

/// 丙-①：入站申请浮层（`rc/ask_pop.rs`）的**三处外部接线**必须同时存在。
///
/// 这三处全都是**静默失败**型：少一处，浮层照样弹得出来或干脆不弹，但没有任何
/// 报错指向真正的原因。
/// - `capabilities/*.json` 的 windows 名单：漏了 → 独立 webview 的 `listen()` /
///   `invoke()` 全被权限层拒，窗口白屏冻在首帧（待办岛实施方案 §5 记录过同一个坑）；
/// - `lib.rs` 的 `invoke_handler`：漏了 → `rc_ask_state` 报 command not found；
/// - `paste_engine::TOOL_WINDOW_LABELS`：漏了 → 有人敲门时那条置顶窗让
///   「自己的界面可见」判据为真 ⇒ 陈旧粘贴目标被续命。
#[test]
fn 守卫_入站浮层三处接线() {
    let caps = [
        (
            "capabilities/default.json",
            include_str!("../../../capabilities/default.json"),
        ),
        (
            "capabilities/desktop-plugins.json",
            include_str!("../../../capabilities/desktop-plugins.json"),
        ),
    ];
    for (name, src) in caps {
        assert!(
            src.contains("\"rc-ask\""),
            "{name} 的 windows 名单里没有 rc-ask —— 浮层收不到任何事件"
        );
    }
    let lib = include_str!("../../lib.rs");
    assert!(
        lib.contains("rc::ask_pop::rc_ask_state,") && lib.contains("rc::ask_pop::rc_ask_hide,"),
        "ask_pop 的两个命令没进 invoke_handler"
    );
    assert!(
        crate::paste_engine::PasteEngine::TOOL_WINDOW_LABELS.contains(&super::super::ask_pop::WINDOW_LABEL),
        "rc-ask 必须在工具窗排除表里，否则它会污染前台窗口判据"
    );
    // 丙-② 加了第二种形态（角标）之后，开关权整块收进 ask_pop：调用方只报「状态变了」。
    // 若有人把 on_change 换回按 pending 数开关的旧写法，角标就永远不会出现。
    assert!(
        lib.contains("rc::ask_pop::on_change("),
        "lib.rs 没接 on_change —— 桌面浮层不再随状态换档（丙-② 角标会消失）"
    );
}

/// 守卫：丙-③「暂停对方观看」的**五处接线成对**。
///
/// 这条功能的失败方式全是静默的：闸没接进推流循环 = 按了按钮画面照动；帧名两端
/// 写岔 = 发起端永远看不到「对方已暂停画面」；会话收口漏清位 = 下一场对端一进来
/// 就看见一张冻住的旧画面。跑不了双机联测，所以按本项目做法（见
/// `守卫_caps上报dgram_input`）用源码文本钉住接线。
#[test]
fn 守卫_画面暂停五处接线成对() {
    // ① 出帧闸门：推流主循环真的问了这个判据（没有它，按钮就只是个装饰）。
    let run = include_str!("../inbound/video_run.rs");
    assert!(
        run.contains("self.svc.video_paused()"),
        "推流主循环没有暂停闸 —— 按了「暂停对方观看」画面照旧推送"
    );
    // ② 会话开始清位：与 input_gate_begin 同一条理由（换场路径跳过全局复位）。
    let accept = include_str!("../service/inbound_accept.rs");
    assert!(
        accept.contains("self.video_pause_begin();"),
        "建立入站会话时没清暂停位 —— 上一场的暂停会漏进下一场"
    );
    // ③ 会话收口清位。
    let ses = include_str!("../session/lifecycle.rs");
    assert!(
        ses.contains("self.video_pause_reset();"),
        "会话收口没清暂停位 —— 结束会话后按钮仍停在「恢复对方观看」"
    );
    // ④ 帧名两端成对：被控端写 `vpause`，发起端分派 `vpause`。写岔不报错，
    //    只是发起端永远看不到告知（规则 15.1 的触发/反馈同域就断了）。
    let gate = include_str!("../service/video_pause.rs");
    let outbound = include_str!("../outbound.rs");
    assert!(
        gate.contains("\"t\": \"vpause\"") && outbound.contains("Some(\"vpause\")"),
        "vpause 控制帧的两端字面量不成对 —— 暂停状态到不了发起端眼前"
    );
    // ⑤ 命令注册 + 状态投影：前端两处数据源（被控端按钮 / 发起端告知）都得有字段。
    let lib = include_str!("../../lib.rs");
    assert!(
        lib.contains("commands::rc_video_pause_set,") || lib.contains("commands::rc_video_pause_set::"),
        "rc_video_pause_set 没进 invoke_handler —— 抽屉那颗按钮点了没反应"
    );
    let status = include_str!("../service/lifecycle.rs");
    assert!(
        status.contains("video_paused: self.video_paused()")
            && status.contains("peer_video_paused: self.peer_video_paused()"),
        "RcStatus 没投影 video_paused / peer_video_paused —— 两端 UI 都没有状态源"
    );
}

#[test]
fn 守卫_暂停先废弃媒体再停止出帧() {
    let run = include_str!("../inbound/video_run.rs");
    let reset = run.find("pipe.set_paused(self.svc.media_paused())")
        .expect("暂停只停止出帧，没有通知媒体 worker RESET 已排队的旧画面");
    assert!(reset < run.find("if bg_since > 0 {").unwrap());
    assert!(reset < run.find("if self.svc.should_pause_stream() {").unwrap());
    let pipe = include_str!("../inbound/media_pipe.rs");
    let writer = include_str!("../inbound/media.rs");
    // P0 重构后 worker 不再直接念 svc，而是走 writer 的 `paused()` 薄封装
    // （判据仍必须是媒体暂停口径，见下一条断言）。
    assert!(pipe.contains("if writer.paused() ||"));
    assert!(writer.contains("self.svc.media_paused()"));
}

/// 🔴 P0 的两条接线守卫（2026-10-06）：闸**不能阻塞生产者**，也**不能饿死控制面**。
///
/// 旧 `wait_media_capacity().await` 挡在采集圈前面，预算一低就「表现成帧率低」，
/// 控制器只看得到交付变慢 ⇒ 把自家断粮当成线路能力（自锁链的起点，调研文档 §8）。
/// 光标遥测走控制流、与媒体预算毫无竞争，排在闸后面就是「拥塞期间远端指针冻住」。
/// 两条都是改错顺序不报错、只默默变卡，所以按源码文本钉。
#[test]
fn 守卫_媒体闸不阻塞生产者也不饿死控制面() {
    let run = include_str!("../inbound/video_run.rs");
    let pipe = include_str!("../inbound/media_pipe.rs");
    assert!(
        !pipe.contains("async fn wait_media_capacity") && !run.contains("wait_media_capacity().await"),
        "媒体闸不许回到 await 阻塞式等待——生产者的节拍不能被发送侧预算停住"
    );
    // 取**最后一次**出现：第一次在 run() 开头（会话建立先报一次形状），
    // 循环体内那一次才是被测对象。
    let cursor = run.rfind("self.maybe_send_cursor().await")
        .expect("推流循环里没有光标遥测上报");
    let gate = run.find("match self.media_gate()").expect("推流循环没有问媒体闸");
    assert!(cursor < gate, "光标上报必须排在媒体闸之前，否则闸关闭期间远端指针冻结");
    assert!(
        run.find("if self.svc.media_paused() { continue; }").unwrap() < cursor,
        "隐私暂停必须先于光标上报（暂停期连指针形状都不算可看）"
    );
}

/// 守卫：「传输分 plane」视频独立通道的**七处接线**（2026-10-03）。
///
/// 协议位 → 手机上报 → 电脑解析 → spawn 透传 → InboundVideo 分流 → 专属流
/// 写路径 → 手机 accept 路由。任何一处被删，行为退化分两种：位断了 = 永远
/// 走旧共流形态（积压 90s 的病根回来）；accept 断了 = 位在但流没人收（对端
/// 「等待对方画面」）。按源码文本钉，搬家时同步改本测试的 include_str。
#[test]
fn 守卫_视频plane七处接线() {
    let protocol = include_str!("../protocol.rs");
    assert!(
        protocol.contains("video_plane: Option<bool>"),
        "Request 帧没有 video_plane 能力位 —— 传输分 plane 无从协商"
    );
    let outbound = include_str!("../outbound.rs");
    let service_outbound = include_str!("../service/outbound.rs");
    assert!(
        service_outbound.contains("video_plane: Some(true)"),
        "发起端 Request 没上报 video_plane —— 被控端永远不会拆视频流"
    );
    assert!(
        outbound.contains("self.spawn_media_acceptor()")
            && include_str!("../media.rs").contains("try_parse_vhdr")
            && include_str!("../outbound/media.rs").contains("handle_h264"),
        "发起端视频独立流接收循环缺失/不完整 —— 位在但流没人收（等待对方画面）"
    );
    let service_inbound = include_str!("../service/inbound.rs");
    assert!(
        service_inbound.contains("peer_video_plane"),
        "被控端没有解析 video_plane 位"
    );
    let inbound_accept = include_str!("../service/inbound_accept.rs");
    assert!(
        inbound_accept.contains("peer_video_plane"),
        "video_plane 位没有透传到 InboundVideo::try_new"
    );
    let video = include_str!("../inbound/video.rs");
    assert!(
        video.contains("send_via_video_plane")
            && video.contains("MELT_REBUILD_AFTER_MS")
            && include_str!("../inbound/media.rs").contains("write_vhdr"),
        "被控端专属流写路径/熔断重建缺失 —— 积压 90s 无法清账的病根还在"
    );
    let wire = include_str!("../video/wire.rs");
    assert!(
        wire.contains("PPVID1") && wire.contains("try_parse_vhdr"),
        "PPVID1 流头缺失 —— 手机端 accept 循环无法路由视频流"
    );
}

#[test]
fn 守卫_媒体单入口与JPEG能力不混用() {
    let router = include_str!("../media.rs");
    assert_eq!(router.matches("conn.accept_uni()").count(), 1);
    assert!(!include_str!("../outbound.rs").contains("accept_uni()"));
    assert!(include_str!("../protocol.rs").contains("media_plane: Option<bool>"));
    assert!(include_str!("../service/outbound.rs").contains("media_plane: Some(true)"));
    assert!(include_str!("../inbound/video_run.rs").contains("if self.peer_media_plane"));
    let sender = include_str!("../inbound/video.rs");
    assert!(!sender.contains("video_stream.take()"));
    assert!(!sender.contains("self.video_stream = None"));
    assert!(include_str!("../inbound/media.rs").contains("discard_stream(&mut self.video_stream)"));
}

/// 守卫：会话防休眠（`rc_keep_awake`，默认关）的**六处接线成对**（2026-10-04）。
///
/// 这条功能的失败方式全部静默，而且一半在本机界面**看不见**（防休眠生效/失效都不弹东西）：
/// 取锁点被删 = 开关切到「开」但机器照睡；守卫没做成 `InboundVideo` 的字段 = 会话结束后
/// 机器永远不睡（用户只会觉得 App 有毛病）；`SetThreadExecutionState` 的两处调用被搬到
/// spawn 外面 = 请求绑在 tokio worker 上、按哪条路退出都不清（**这套实现的全部理由**）。
/// 双机 + 换电源计划实测跑不了，按本项目做法用源码文本钉住接线。
#[test]
fn 守卫_会话防休眠六处接线成对() {
    // ① 取锁点：真的在推流启动时按配置取，且**只在这一处**取（别处再取一次就是第二套生命周期）。
    let video = include_str!("../inbound/video.rs");
    assert!(
        video.contains("if svc.keep_awake()")
            && video.contains("crate::rc::keep_awake::KeepAwake::start()"),
        "推流启动处没有按 rc_keep_awake 取锁 —— 开关是个假的"
    );
    assert_eq!(
        video.matches("KeepAwake::start()").count(),
        1,
        "KeepAwake::start() 出现两次以上 —— 两处取锁、只有一处随会话释放"
    );
    // ② 释放机制：守卫是 InboundVideo 的字段（`run(mut self)` 析构它）。退化成局部变量
    //    就等于「会话一开始就放掉」，功能整条白做。
    let inbound = include_str!("../inbound.rs");
    assert!(
        inbound.contains("_keep_awake: Option<crate::rc::keep_awake::KeepAwake>"),
        "防休眠守卫不是 InboundVideo 的字段 —— 不会随会话结束释放"
    );
    assert!(
        video.contains("_keep_awake: keep_awake,"),
        "try_new 没把守卫放进结构体 —— 取到的锁当场被丢"
    );
    // ③ 线程绑定：set 与 clear 必须都在那条命名线程的闭包里（请求绑调用线程，线程退出即清除）。
    let ka = include_str!("../keep_awake.rs");
    assert!(
        ka.contains(".name(\"rc-keep-awake\".into())"),
        "防休眠不再走专用线程 —— 请求会绑在 tokio worker 上，退出路径不可控"
    );
    assert!(
        ka.contains("ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED"),
        "必须同时按住系统休眠与显示器熄屏 —— 只保系统不睡时显示器一熄，DXGI 复制照样失败"
    );
    assert_eq!(
        ka.matches("SetThreadExecutionState(").count(),
        3,
        "SetThreadExecutionState 该有三处调用（设 / 探 / 释放）——多一处或少一处都要核对是否搬出了那条线程"
    );
    // 🔴 钉住 2026-10-04 修掉的**契约级误读**：MSDN 说成功返回的是「本线程**之前的**执行状态」，
    //    失败才是 NULL —— 当年按「返回 0 = 申请失败」判，把「之前没状态」读成了「申请被拒」。
    //    本机实测新进程首次调用返回 0x80000000（线程初值自带 ES_CONTINUOUS），所以那次没
    //    当场失效，但这个值随线程来路而变、拿它判成败从契约上就不成立，而且它永远分不出
    //    「两个位到底给没给」。判据必须是「再设一次同样的参数、拿回第一次设下的状态来验」。
    assert!(
        ka.contains("held.contains(ES_SYSTEM_REQUIRED)"),
        "防休眠不再用第二次调用返回的状态位判成败 —— 会退回「新线程返回 0 当成失败」那个空转 bug"
    );
    // 🔴 真正的机制不变量：**三处都必须在那条线程的闭包里**（请求绑调用线程）。
    // 用字节偏移判，不用跨行字面量——include_str! 读的是磁盘原字节，仓库以 CRLF 检出时
    // 任何含换行的判据都会变成假红。
    let spawn_at = ka
        .find(".spawn(move ||")
        .expect("防休眠必须走专用线程的 spawn 闭包");
    let first = ka.find("SetThreadExecutionState(").unwrap();
    let last = ka.rfind("SetThreadExecutionState(").unwrap();
    assert_ne!(first, last, "只找到一处 SetThreadExecutionState —— 设置/探测/释放三处至少少了一处");
    assert!(
        spawn_at < first && spawn_at < last,
        "有 SetThreadExecutionState 落在 spawn 之前/之外 —— 请求会绑在 tokio worker 上，会话结束没人清"
    );
    // ④ 默认关 + 唯一读取点：缺省判断只许存在于 cfg_keep_awake 一处。
    let svc = include_str!("../service/mod.rs");
    assert!(
        svc.contains("pub const CFG_KEEP_AWAKE_DEFAULT: bool = false"),
        "防休眠默认值不再是关 —— 它会按住用户机器的屏幕与电源计划"
    );
    let trust = include_str!("../service/trust.rs");
    assert!(
        trust.contains("super::cfg_keep_awake(&self.store)"),
        "RcService::keep_awake 不再转调唯一读取点"
    );
    // ⑤ 状态投影 + 命令注册 + 跨端字符串成对：前端行拿的是后端真值。
    assert!(
        include_str!("../service/lifecycle.rs").contains("keep_awake: self.keep_awake()"),
        "RcStatus 没投影 keep_awake —— 设置页那行没有状态源"
    );
    assert!(
        include_str!("../../lib.rs").contains("commands::rc_set_keep_awake,"),
        "rc_set_keep_awake 没进 invoke_handler —— 开关点了没反应"
    );
    let cmd = include_str!("../../commands/rc.rs");
    assert!(
        cmd.contains("#[cfg(target_os = \"windows\")]") && cmd.contains("会话防休眠只支持 Windows 被控端"),
        "非 Windows 必须**明确报错**，静默成功会让开关切到永远不生效的假状态"
    );
    let ts_cmd = include_str!("../../../../src/lib/api/rcCommands.ts");
    assert!(
        ts_cmd.contains("invoke(\"rc_set_keep_awake\", { enable })"),
        "前端 invoke 的命令名与后端对不上 —— 保存直接失败"
    );
    let ts_types = include_str!("../../../../src/lib/api/rcTypes.ts");
    assert!(
        ts_types.contains("keep_awake?: boolean"),
        "前端 RcStatus 没有 keep_awake 字段 —— 与后端投影脱节"
    );
}

/// 非 Windows：`KeepAwake::start()` 恒 `None`（能力是 Windows 电源 API 专属，
/// stub 不许假装成功）。Windows 上这条不适用——真机生效只能看会话日志。
#[cfg(not(target_os = "windows"))]
#[test]
fn 会话防休眠_非windows恒不保活() {
    assert!(
        crate::rc::keep_awake::KeepAwake::start().is_none(),
        "非 Windows 上不许产出守卫"
    );
}

/// 🔴 守卫：DXGI 熔断**必须带自动重开入口**（2026-10-06，「乙」的接线钉）。
///
/// 病根：`disabled` 是个只进不出的 bool——三处赋值、全仓零复位点，于是一次
/// `DuplicateOutput` 的瞬时 `E_ACCESSDENIED`（桌面态变化，自己会过去）就把整场
/// 判成 JPEG 兜底，实测兜了 25 分钟。这条退化和 2026-09-21 硬编熔断那次是同一个
/// 毛病，那次修完留下的教训是「熔断不许是一扇单向门」。
/// 跑不了真机（要恰好撞上桌面态切换），所以按源码文本钉住三个不变量：
/// ① 禁用赋值收口在 `note_disabled` 一处；② 两条 grab 入口在报「已禁用」之前
/// 必须先试 `maybe_revive`；③ 退避递进走纯函数不是硬编码。
#[test]
fn 守卫_DXGI熔断必须有自动重开入口() {
    let src = include_str!("../dxgi.rs");
    // ① 收口：绕过 note_disabled 的裸赋值 = 没有冷却时刻的熔断，永远醒不过来。
    assert_eq!(
        src.matches("self.disabled = true").count(),
        1,
        "又出现裸的 `self.disabled = true` —— 必须走 note_disabled，否则这次熔断排不上自动重试"
    );
    assert!(
        src.contains("fn note_disabled") && src.contains("fn maybe_revive"),
        "熔断/重开两个入口被拆掉了一个 —— 熔断又变回整场判死"
    );
    assert!(
        src.contains("self.retry_after = Some(now"),
        "note_disabled 不再排重试时刻 —— 只有退避没有重试等于没有退避"
    );
    assert!(
        src.contains("next_disable_retry_secs(self.retry_backoff_secs)"),
        "maybe_revive 失败后不再递进退避 —— 会退回每 5s 重建一次设备的抖动"
    );
    // ② 每条「已禁用」报错点前面必须紧跟同函数内的 maybe_revive 调用。
    // 用字节偏移判：仓库以 CRLF 检出，跨行字面量会假红。
    let mut from = 0usize;
    let mut sites = 0usize;
    while let Some(rel) = src[from..].find("DXGI 已禁用：") {
        let at = from + rel;
        let revive = src[..at]
            .rfind("self.maybe_revive()")
            .unwrap_or_else(|| panic!("报「DXGI 已禁用」的入口（偏移 {at}）没有先调 maybe_revive"));
        assert!(
            at - revive < 300,
            "maybe_revive 与禁用报错点相隔 {} 字节，多半已不在同一个入口函数里",
            at - revive
        );
        sites += 1;
        from = at + "DXGI 已禁用：".len();
    }
    assert_eq!(
        sites, 2,
        "CPU(grab) / GPU(grab_gpu) 两条入口的禁用报错点该有两处，实际 {sites} 处——少一条 = 那条路永不自动重开"
    );
}

/// 🔴 守卫：`[RC-PERF]` 的 `管线` 标签必须说真话（2026-10-06）。
///
/// 这条不是洁癖，是**误诊源头**：旧标签只判 `self.h264.is_some()`，而硬编对象在
/// 抓屏熔断后依然健在（只是再也喂不进去），于是整场 JPEG 的日志恒打
/// `管线 H264`。我拿它否掉了用户看到的实况，白绕了一轮。验收标准（AGENTS.md
/// §11.1）：新写一条兜底路径时若忘了置 `tick_jpeg`，标签还会说谎 ⇒ 所以钉住
/// 「每圈清零 + FallThrough 置位 + 标签与两个报告入口都经 pipeline_label」。
#[test]
fn 守卫_管线标签必须说真话() {
    let video = include_str!("../inbound/video.rs");
    let run = include_str!("../inbound/video_run.rs");
    // ① 标记生命周期：一圈一次，清在圈首、置在兜底臂。
    assert_eq!(
        run.matches("self.tick_jpeg = false").count(),
        1,
        "tick_jpeg 的清零点不止一处 —— 会在兜底之后被清掉，标签重新变成谎报"
    );
    assert_eq!(
        run.matches("self.tick_jpeg = true").count(),
        1,
        "tick_jpeg 的置位点不止一处 —— 硬编成功圈也可能被误标成兜底"
    );
    let fall = run
        .find("Step::FallThrough =>")
        .expect("推流循环没有 FallThrough（硬编没出帧）分支");
    let set = run
        .find("self.tick_jpeg = true")
        .expect("兜底分支不再置 tick_jpeg —— 标签抓不到 JPEG");
    assert!(
        set > fall && set - fall < 300,
        "tick_jpeg 的置位（偏移 {set}）不在 FallThrough 臂（偏移 {fall}）里 —— 兜底不会被标签抓到"
    );
    // ② 标签本体先看「这一圈编了什么」，再看编码器对象在不在。
    let label = video
        .find("fn pipeline_label")
        .expect("管线标签函数被删 —— 两个报告入口没有统一口径");
    let body = &video[label..];
    let gate = body
        .find("if self.tick_jpeg")
        .expect("pipeline_label 不再以 tick_jpeg 为首要判据 —— 会退回按 h264.is_some() 谎报");
    let why = body
        .find("JPEG（{why}）")
        .expect("兜底原因三档（无硬编/抓屏已熔断/单帧回退）被合并 —— 只剩「兜过底」这一个信息量");
    assert!(gate < why, "tick_jpeg 判据排在了兜底原因之后");
    assert!(
        body.contains("抓屏已熔断") && body.contains("单帧回退") && body.contains("无硬编"),
        "兜底三档原因缺一条 —— 现场分不出是没配、熔断还是单帧失败"
    );
    // ③ 汇总行与收尾行都必须经 pipeline_label，且不得再直接从 h264 对象推断。
    let extra = video
        .find("fn perf_extra")
        .expect("汇总行上下文入口被删");
    let extra_last = video
        .find("fn perf_extra_last")
        .expect("收尾行上下文入口被删");
    let head = &video[extra..extra_last];
    assert!(
        head.contains("self.pipeline_label()"),
        "汇总行的管线不再走 pipeline_label"
    );
    assert!(
        !head.contains("h264"),
        "perf_extra 里又出现直接读 h264 的判据 —— 那正是谎报 `管线 H264` 的写法"
    );
    assert!(
        video[extra_last..].contains("self.pipeline_label()"),
        "收尾行不再兜正空转圈 —— 末圈空转会把整场管线盖成「空转」"
    );
    // ④ 「没出帧」与「出帧但兜底」是两件事，标签必须能同时表达。
    assert!(
        head.contains("if !self.perf_last.produced"),
        "空转判定被删 —— 屏幕未变的圈会被算成兜底"
    );
}

/// 守卫：兜底计数必须出现在 **5s 汇总行**，不能只在收尾行露一次（2026-10-06）。
///
/// `JPEG_FALLBACK` / `CAPTURE_FAIL` 是进程级 static，过去只有会话收尾的
/// `counters::snapshot()` 打印它们——于是「兜了 25 分钟」这件事，中途在日志里
/// 一片安静，只有会话结束才看得到，而那正好是没人看的时候。累计口径还必须从
/// 本会话起点算（static 不随会话复位），否则第二场会话会显示第一场的账。
#[test]
fn 守卫_汇总行必须带兜底增量() {
    let perf = include_str!("../perf.rs");
    assert!(
        perf.contains("兜底 +") && perf.contains("抓屏失败 +"),
        "5s 汇总行不再打印兜底/抓屏失败增量 —— 中途看不见，只剩收尾那一行"
    );
    assert!(
        perf.contains("base_jpeg_fallback: jf") && perf.contains("base_capture_fail: cf"),
        "FrameStats 起点不再快照进程计数 —— 兜底累计会把上一场会话算进本场"
    );
    assert!(
        perf.contains("saturating_sub(self.base_jpeg_fallback)"),
        "本场累计不再减基线"
    );
    // 纯累计（无新增）时这段必须整段缺席，否则汇总行常年挂着「兜底 +0」噪声。
    assert!(
        perf.contains("if djf > 0 || dcf > 0"),
        "兜底段不再按「本区间有新增」门控"
    );
}
