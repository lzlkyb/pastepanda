use super::*;
use iroh::{Endpoint, EndpointAddr};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

async fn pair() -> (Endpoint, Endpoint, Connection, Connection) {
    let bind = || {
        Endpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![b"rc-media-test".to_vec()])
            .bind()
    };
    let a = bind().await.unwrap();
    let b = bind().await.unwrap();
    let mut socket = b.bound_sockets()[0];
    socket.set_ip("127.0.0.1".parse().unwrap());
    let address = EndpointAddr::new(b.id()).with_ip_addr(socket);
    let (send, recv) = tokio::join!(a.connect(address, b"rc-media-test"), async {
        b.accept().await.unwrap().await.unwrap()
    });
    (a, b, send.unwrap(), recv)
}

#[tokio::test]
async fn reset_discards_unread_backlog_and_next_stream_arrives() {
    let (_a, _b, send, recv) = pair().await;
    let mut old = send.open_uni().await.unwrap();
    old.write_all(&vec![42; 128 * 1024]).await.unwrap();
    let mut abandoned = recv.accept_uni().await.unwrap();
    discard_stream(&mut Some(old));
    let mut next = send.open_uni().await.unwrap();
    next.write_all(b"fresh").await.unwrap();
    next.finish().unwrap();
    let mut fresh = tokio::time::timeout(Duration::from_secs(2), recv.accept_uni()).await.unwrap().unwrap();
    assert_eq!(fresh.read_to_end(100).await.unwrap(), b"fresh");
    // RESET 可能晚于已到达的缓冲区；读尽之后必须报错，不能默默继续 FIN。
    assert!(tokio::time::timeout(Duration::from_secs(2), abandoned.read_to_end(256 * 1024)).await.unwrap().is_err());
}

#[tokio::test]
async fn route_accepts_audio_and_replacement_while_old_video_is_stalled() {
    let (_a, _b, send, recv) = pair().await;
    let live = Arc::new(AtomicBool::new(true));
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    let video_tx = tx.clone();
    let worker_live = live.clone();
    let worker = tokio::spawn(async move {
        route(recv, || worker_live.load(Ordering::Relaxed),
            move |_, _| { let tx = tx.clone(); async move { tx.send("audio").await.unwrap(); } },
            move |mut stream, _| { let tx = video_tx.clone(); async move {
                let mut b = [0; 1];
                if stream.read_exact(&mut b).await.is_ok() { tx.send("video").await.unwrap(); }
            } }).await;
    });
    let mut old = send.open_uni().await.unwrap();
    super::super::video::write_vhdr(&mut old, "h264").await.unwrap();
    let mut audio = send.open_uni().await.unwrap();
    audio.write_all(b"PPAUD1\x02\0\0\0{}").await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap(), Some("audio"));
    let mut next = send.open_uni().await.unwrap();
    super::super::video::write_vhdr(&mut next, "h264").await.unwrap();
    next.write_all(&[1]).await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap(), Some("video"));
    live.store(false, Ordering::Relaxed);
    tokio::time::timeout(Duration::from_secs(2), worker).await.unwrap().unwrap();
}

#[tokio::test]
async fn jpeg_metadata_and_payload_keep_order_through_media_router() {
    use crate::rc::video::{DirtyRect, Encoded, FrameCodec, Incoming, VideoFrame};
    let (_a, _b, send, recv) = pair().await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let worker = tokio::spawn(async move {
        route(recv, || true, |_, _| async {}, move |mut stream, codec| {
            let tx = tx.clone();
            async move {
                assert_eq!(codec, "jpeg");
                let mut kinds = Vec::new();
                for _ in 0..3 {
                    match crate::rc::video::read_incoming(&mut stream).await.unwrap() {
                        Incoming::Control(bytes) => {
                            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                            kinds.push(value["t"].as_str().unwrap().to_owned());
                            if value["t"] == "vts" {
                                assert_eq!(value["ts"], 1234);
                                assert_eq!(value["cap"], 2);
                                assert_eq!(value["enc"], 3);
                            }
                        }
                        Incoming::Jpeg(frame) => { assert_eq!(frame.jpeg, [255, 216, 255, 217]); kinds.push("jpeg".into()); }
                        _ => panic!("JPEG 流不应被误判为 H.264"),
                    }
                }
                tx.send(kinds).await.unwrap();
            }
        }).await;
    });
    let rect = DirtyRect { x: 1, y: 2, w: 64, h: 64 };
    let frame = Encoded { rect: Some(rect), refine: false, frame: VideoFrame {
        width: 64, height: 64, jpeg: vec![255, 216, 255, 217], at_ms: 1234,
        full: false, rect: Some(rect), codec: FrameCodec::Jpeg, key: true, cap_ms: 2, enc_ms: 3,
    }};
    let mut stream = send.open_uni().await.unwrap();
    crate::rc::video::write_vhdr(&mut stream, "jpeg").await.unwrap();
    crate::rc::video::write_jpeg_frame(&mut stream, &frame).await.unwrap();
    let kinds = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    assert_eq!(kinds, ["vrect", "vts", "jpeg"]);
    worker.abort();
    let _ = worker.await;
}

#[test]
fn relay_is_not_permanently_capped_after_measurement() {
    assert_eq!(scale_for_path(200, 10, true), 200);
    assert_eq!(scale_for_path(200, 0, false), 25);
}

#[test]
fn media_feedback_is_optional_for_older_peers() {
    let old = r#"{"kind":"net_hint","rtt_ms":100}"#;
    let ev: crate::rc::input::InputEvent = serde_json::from_str(old).unwrap();
    assert!(matches!(ev, crate::rc::input::InputEvent::NetHint { media: None, .. }));
}

