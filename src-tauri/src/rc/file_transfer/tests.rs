//! `file_transfer.rs` 的单元测试（原样平移）。

use super::*;

#[test]
fn 完成态必须字节数一致() {
    let (st, err) = TxOutcome::Done.finish(100, 100);
    assert_eq!(st, TaskState::Done);
    assert!(err.is_none());
    // 短文件不得假 Done（P1-5）
    let (st, err) = TxOutcome::Done.finish(50, 100);
    assert_eq!(st, TaskState::Failed);
    assert!(err.unwrap().contains("不一致"));
}

#[test]
fn rename绝不覆盖已有文件() {
    let dir = std::env::temp_dir().join(format!("pp-rename-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join("a.bin.pppart");
    let dest = dir.join("a.bin");
    std::fs::write(&part, b"new").unwrap();
    std::fs::write(&dest, b"old").unwrap();
    let r = rename_no_overwrite(&part, &dest);
    assert!(r.is_err(), "目标存在时不得覆盖");
    assert_eq!(std::fs::read(&dest).unwrap(), b"old", "旧文件必须原样");
    assert!(part.exists(), "part 应保留，便于换名重试");
    // 目标空闲时成功，且 part 消失
    let dest2 = dir.join("b.bin");
    std::fs::write(&part, b"new").unwrap();
    rename_no_overwrite(&part, &dest2).unwrap();
    assert_eq!(std::fs::read(&dest2).unwrap(), b"new");
    assert!(!part.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 收尾冲突时递增换名() {
    let dir = std::env::temp_dir().join(format!("pp-final-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join("报告.zip.pppart");
    std::fs::write(&part, b"payload").unwrap();
    std::fs::write(dir.join("报告.zip"), b"existing").unwrap();
    let name = finalize_recv_name(&part, &dir, "报告.zip").unwrap();
    assert_ne!(name, "报告.zip", "冲突时必须换名");
    assert_eq!(std::fs::read(dir.join("报告.zip")).unwrap(), b"existing");
    assert_eq!(std::fs::read(dir.join(&name)).unwrap(), b"payload");
    assert!(!part.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// 桌面测试也守住手机的取值口：不能再猜包名/存储根目录，推送与取回必须同源。
#[test]
fn android接收目录必须由系统提供且所有入口同源() {
    let transfer = include_str!("../file_transfer.rs");
    let boot = include_str!("../../lib.rs");
    let commands = include_str!("../../commands/rc_file.rs");
    let api = include_str!("api.rs");
    assert!(!transfer.contains("EXTERNAL_STORAGE"));
    assert!(!transfer.contains("/storage/emulated/0"));
    assert!(boot.contains("handle.path().download_dir()"));
    assert!(boot.contains("rc::file_transfer::init_android_receive_dir(dir)"));
    assert!(commands.contains("file_transfer::effective_receive_dir(&config)"));
    assert!(api.contains("file_transfer::effective_receive_dir(&cfg)"));
}

// ── 收尾关闭时序（2026-10-11 真机截断）─────────────────────────────────
//
// 现场：一批两个文件，第 1 个（3.5 MB）`已接收`，第 2 个（45 KB）
// `接收 rc.log.1 未完成：读流出错：connection lost（closed by peer: done (code 0)）`。
// 发送端把最后一个字节 `finish()` 之后立刻 `conn.close(0, "done")`，QUIC 走的是
// 立即关闭（RFC 9000 §10.2）：还没发出去的 STREAM 帧连同未确认的重传队列一起作废。
// 下面三组用例分别钉住「危险是真的」「等了就没事」「生产代码确实在等」。

use iroh::{Endpoint, EndpointAddr};

/// 两个真端点、一条真连接（配方同 `rc/media/tests.rs`：`bound_sockets()` 给的是
/// 通配地址，必须改写成 127.0.0.1 才能拨）。
///
/// 接收侧把流接收窗口抬到 8 MiB（默认 1.25 MB）：不然「发完但对端一行都没读」
/// 这个状态根本造不出来——`write_all` 会卡在流控上，反而把竞态等没了。
async fn endpoint_pair(
    roomy_receiver: bool,
) -> (Endpoint, Endpoint, Connection, Connection) {
    let bind = |roomy: bool| async move {
        let mut builder = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![b"rc-file-test".to_vec()]);
        if roomy {
            // iroh 把 noq 的 TransportConfig 包在 Arc 里，只能走 builder
            let tc = iroh::endpoint::QuicTransportConfig::builder()
                .stream_receive_window((8 * 1024 * 1024u32).into())
                .build();
            builder = builder.transport_config(tc);
        }
        builder.bind().await.unwrap()
    };
    let dialer = bind(false).await;
    let listener = bind(roomy_receiver).await;
    let mut socket = listener.bound_sockets()[0];
    socket.set_ip("127.0.0.1".parse().unwrap());
    let addr = EndpointAddr::new(listener.id()).with_ip_addr(socket);
    let (conn, accepted) = tokio::join!(
        dialer.connect(addr, b"rc-file-test"),
        async { listener.accept().await.unwrap().await.unwrap() }
    );
    (dialer, listener, conn.unwrap(), accepted)
}

fn payload() -> Vec<u8> {
    vec![0xa5u8; 512 * 1024]
}

/// 读尽一条流；返回（收到的字节数, 是否以干净的 FIN 结束）。
async fn drain(mut recv: RecvStream) -> (usize, bool) {
    let mut got = 0usize;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match recv.read(&mut buf).await {
            Ok(Some(0)) | Ok(None) => return (got, true),
            Ok(Some(n)) => got += n,
            Err(_) => return (got, false),
        }
    }
}

/// 改前为红的取证：不等对方的收尾信号就关连接，对方拿不到完整文件。
///
/// 这条**不是**在测我们的代码，是在测「为什么必须有那段代码」——它把
/// `wait_peer_stream_end` 存在的理由变成断言。哪天 noq 改成优雅关闭，这条会
/// 变红，那时再删掉它和它保护的那段等待。
#[tokio::test]
async fn closing_right_after_finish_loses_the_unread_tail() {
    let (_dialer, _listener, writer_conn, reader_conn) = endpoint_pair(true).await;
    let want = payload().len();
    let writer = tokio::spawn(async move {
        let conn = writer_conn;
        let (mut s, _r) = conn.open_bi().await.unwrap();
        s.write_all(&payload()).await.unwrap();
        s.finish().unwrap();
        conn.close(0u32.into(), b"done"); // 旧收尾：一个确认都不等
    });
    let accepted = tokio::time::timeout(Duration::from_secs(10), reader_conn.accept_bi()).await;
    // `Ok(Err(_))` 与超时都按「连流都没送达」算：512 KB 全被那次立即关闭抹掉了，
    // 比「丢尾巴」更狠，同样是这条用例要钉住的东西。
    let (got, clean) = match accepted {
        Ok(Ok((_s, recv))) => drain(recv).await,
        _ => (0usize, false),
    };
    let _ = writer.await;
    assert!(
        got < want || !clean,
        "立即关闭居然也收全了（{got}/{want}, clean={clean}）：竞态窗口这次没踩中"
    );
}

/// 改后为绿：写侧等到对方的 FIN 才关，读侧收全且以干净 FIN 结束。
#[tokio::test]
async fn waiting_for_peer_eof_before_close_delivers_everything() {
    let (_dialer, _listener, writer_conn, reader_conn) = endpoint_pair(true).await;
    let want = payload().len();
    let writer = tokio::spawn(async move {
        let conn = writer_conn;
        let (mut s, mut r) = conn.open_bi().await.unwrap();
        s.write_all(&payload()).await.unwrap();
        s.finish().unwrap();
        let confirmed = wait_peer_stream_end(&mut r).await;
        conn.close(0u32.into(), b"done");
        confirmed
    });
    let (mut s, recv) = tokio::time::timeout(Duration::from_secs(10), reader_conn.accept_bi())
        .await
        .unwrap()
        .unwrap();
    let (got, clean) = tokio::time::timeout(Duration::from_secs(10), drain(recv))
        .await
        .expect("读流挂住");
    // 读方收完 → finish 自己那半，这正是写侧在等的信号（同 serve_push 的收尾）
    let _ = s.finish();
    let confirmed = tokio::time::timeout(Duration::from_secs(10), writer)
        .await
        .expect("写侧没等到收尾信号")
        .unwrap();
    assert_eq!(got, want, "字节必须收全");
    assert!(clean, "必须以 FIN 结束，不能是 connection lost");
    assert!(confirmed, "写侧应当真的看到对方 FIN");
}

/// 旧版对端不发收尾信号时不能干等：连接一断，等待立刻以 false 返回。
/// （超时那一档由 `RECEIPT_WAIT_SECS` 兜底，不在测试里空等 15 秒。）
#[tokio::test]
async fn wait_peer_stream_end_gives_up_as_soon_as_the_connection_dies() {
    let (_dialer, _listener, peer_conn, our_conn) = endpoint_pair(true).await;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    // 「旧版对端」：开流、灌数据，**从不 finish 自己的半流**，收到信号就关连接。
    // 用 oneshot 而不是 sleep 排序：不靠时序侥幸，也不给 CI 留抖动。
    let peer = tokio::spawn(async move {
        let conn = peer_conn;
        let (mut s, _r) = conn.open_bi().await.unwrap();
        s.write_all(&payload()).await.unwrap();
        rx.await.ok();
        conn.close(3u32.into(), b"legacy");
    });
    let (_s, mut recv) = tokio::time::timeout(Duration::from_secs(10), our_conn.accept_bi())
        .await
        .unwrap()
        .unwrap();
    tx.send(()).unwrap();
    let started = std::time::Instant::now();
    let confirmed = wait_peer_stream_end(&mut recv).await;
    let elapsed = started.elapsed();
    let _ = peer.await;
    assert!(!confirmed, "连接已断，不能声称对方收完");
    assert!(
        elapsed < Duration::from_secs(5),
        "旧版对端不该让本机空等一整个超时档（实际 {elapsed:?}）"
    );
}

/// 机器查不到的那半：生产代码有没有真的在等。
///
/// 上面两条用例只证明「等」这件事有效；如果有人在 `run_send_batch` 里把等待删掉，
/// 它们照样全绿。这条源码守卫才是「明天被人删掉，bug 会不会无声复发」的答案。
#[test]
fn every_file_close_waits_for_the_receipt_signal() {
    // 只看代码，不看注释：注释里提一句 `wait_peer_stream_end` 不该让守卫满意，
    // 反过来注释里解释「原先那句 stop 为什么不能用」也不该让守卫误红。
    let transfer = code_only(include_str!("transfer.rs"));
    let serve = code_only(include_str!("serve.rs"));
    let helper = code_only(include_str!("../file_transfer.rs"));
    let transfer = transfer.as_str();
    let serve = serve.as_str();
    let helper = helper.as_str();

    // 等待本身必须有超时上限，不能变成无限挂起的后台任务
    assert!(
        helper.contains("RECEIPT_WAIT_SECS") && helper.contains("wait_peer_stream_end"),
        "收尾等待必须收口在带超时的 wait_peer_stream_end 里"
    );

    // ① 推送：每个文件发完 → 等收尾；批次末尾那句 close 之前已经等过全部文件
    let batch = between(
        transfer,
        "async fn run_send_batch",
        "conn.close(0u32.into(), b\"done\")",
    );
    assert!(
        batch.contains("wait_peer_stream_end(&mut recv)"),
        "run_send_batch 必须在关连接前等对方的收尾信号"
    );
    assert!(
        batch.contains("send_bytes(&self, &mut send"),
        "守卫锚点漂了：等待必须挂在 send_bytes 之后"
    );

    // ② 取回：读方 finish 自己那半，再等对方关连接（顺序反了就又变成抢先 close）
    let pull = between(transfer, "async fn run_pull_inner", "conn.close(0u32.into()");
    let finish_at = pull
        .find("send.finish()")
        .expect("run_pull_inner 必须 finish 自己的半流（对方的等待靠它）");
    let closed_at = pull
        .find("conn.closed()")
        .expect("run_pull_inner 必须等对方关连接，而不是抢先 close");
    assert!(finish_at < closed_at, "先信号后等待，反了就是抢先关闭");

    // ③ 取回的被写侧：serve_pull 发完要等，且不许再用 stop 把对方的半流 reset 掉
    let serve_pull = between(serve, "async fn serve_pull", "async fn write_head");
    assert!(
        serve_pull.contains("wait_peer_stream_end(&mut recv)"),
        "serve_pull 返回后 handle_file_conn 立刻 close，不等就是截断"
    );
    assert!(
        !serve_pull.contains("recv.stop("),
        "stop 会 reset 对方正在收尾的半流"
    );

    // ④ 推送的读方：serve_push 收尾那句 finish 是发送端唯一的凭据
    let serve_push = between(serve, "async fn serve_push", "async fn serve_pull");
    assert!(
        serve_push.contains("let _ = send.finish();"),
        "serve_push 不再 finish 半流 = 发送端只能干等超时"
    );
}

/// 截断报错的人话档：对端拿批次收尾理由（`done`）主动关连接时，不许把
/// 「读流出错：connection lost（closed by peer: done (code 0)）」这种网络故障
/// 口吻报给用户——2026-10-11 真机上用户正是被它引去查网络的。
///
/// 两个收尾现场（收推送 `serve_push` / 收取回 `run_pull_inner`）都必须走
/// 收口的 `explain_recv_err`：第 3 个读流报错点被人新写出来时若直接拼
/// `service::explain`，守卫不拦它——判据本身在 `peer_closed_batch_end`，
/// 这条守卫钉的是「已知现场不许漏接」。
#[test]
fn truncation_by_peer_batch_close_is_explained_in_plain_words() {
    let helper = code_only(include_str!("../file_transfer.rs"));
    let serve = code_only(include_str!("serve.rs"));
    let transfer = code_only(include_str!("transfer.rs"));

    // 判据与改写收口成一个来源（AGENTS 规则 11.1 的同款纪律）
    assert!(
        helper.contains("fn peer_closed_batch_end") && helper.contains("fn explain_recv_err"),
        "判据与改写必须收口在 file_transfer.rs 的 explain_recv_err"
    );
    assert!(
        serve.contains("explain_recv_err("),
        "serve_push 收尾必须走 explain_recv_err"
    );
    assert!(
        transfer.contains("explain_recv_err("),
        "run_pull 收尾必须走 explain_recv_err"
    );
    // 人话档要给出可执行的出路，不许只是换个说法
    assert!(
        helper.contains("对方重发可自动续传"),
        "报错文案必须告诉用户出路（断点保留、重发续传）"
    );
}

/// 去掉行注释，只留代码。守卫判的是「有没有真的调用」，不是「有没有提到」。
fn code_only(src: &str) -> String {
    src.lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 取 `from` 之后、`from` 之后**首次**出现的 `to` 之间的片段。
fn between<'a>(src: &'a str, from: &str, to: &str) -> &'a str {
    let a = src.find(from).unwrap_or_else(|| panic!("源码里找不到锚点 {from}"));
    let rest = &src[a..];
    let b = rest
        .find(to)
        .unwrap_or_else(|| panic!("{from} 之后找不到 {to}"));
    &rest[..b]
}
