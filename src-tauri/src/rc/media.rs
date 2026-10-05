//! 单连接媒体流路由与发送预算。控制流独立，媒体流可整体废弃。

use iroh::endpoint::{Connection, RecvStream, SendStream};
use std::future::Future;
use std::time::Duration;

pub(crate) const CONTROL_PRIORITY: i32 = 10;
pub(crate) const MEDIA_PRIORITY: i32 = -10;
pub(crate) const WRITE_BUDGET: Duration = Duration::from_secs(2);

mod congestion;
pub(crate) use congestion::loss_pressure;
mod loss;
pub(crate) use loss::LossSampler;

/// 未测通路径不能按 LAN 起步；高速直连保留原节拍。
pub(crate) fn scale_for_path(scale: u32, rtt_ms: i64, relay: bool) -> u32 {
    let _ = relay;
    if rtt_ms <= 0 {
        scale.min(25)
    } else {
        scale
    }
}

pub(crate) enum Header {
    Video(String),
    Audio(Vec<u8>),
}

pub(crate) fn discard_stream(stream: &mut Option<SendStream>) {
    if let Some(mut old) = stream.take() {
        // Drop 会发送 FIN 并继续交付积压；只有 RESET 才能废弃旧画面。
        let _ = old.reset(0u32.into());
    }
}

async fn read_header(stream: &mut RecvStream) -> Option<Header> {
    let mut head = [0; 10];
    stream.read_exact(&mut head).await.ok()?;
    if &head[..6] != super::video::VIDEO_MAGIC && &head[..6] != b"PPAUD1" {
        return None;
    }
    let len = u32::from_le_bytes(head[6..].try_into().ok()?) as usize;
    if !(1..=4096).contains(&len) {
        return None;
    }
    let mut bytes = vec![0; head.len() + len];
    bytes[..head.len()].copy_from_slice(&head);
    stream.read_exact(&mut bytes[head.len()..]).await.ok()?;
    if &head[..6] == super::video::VIDEO_MAGIC {
        super::video::try_parse_vhdr(&bytes).map(Header::Video)
    } else {
        Some(Header::Audio(bytes))
    }
}

pub(crate) async fn route<A, V, AF, VF>(
    conn: Connection,
    alive: impl Fn() -> bool,
    audio: A,
    video: V,
) where
    A: Fn(RecvStream, Vec<u8>) -> AF,
    V: Fn(RecvStream, String) -> VF,
    AF: Future<Output = ()> + Send + 'static,
    VF: Future<Output = ()> + Send + 'static,
{
    let mut video_task = None;
    let mut audio_task = None;
    while alive() {
        let mut stream = tokio::select! {
            s = conn.accept_uni() => match s { Ok(s) => s, Err(_) => break },
            _ = tokio::time::sleep(Duration::from_millis(500)) => continue,
        };
        let header = tokio::time::timeout(Duration::from_secs(5), read_header(&mut stream)).await;
        if !alive() {
            break;
        }
        match header {
            Ok(Some(Header::Video(codec))) => {
                stop_reader(&mut video_task).await;
                video_task = Some(tokio::spawn(video(stream, codec)));
            }
            Ok(Some(Header::Audio(bytes))) => {
                stop_reader(&mut audio_task).await;
                audio_task = Some(tokio::spawn(audio(stream, bytes)));
            }
            _ => {}
        }
    }
    stop_reader(&mut video_task).await;
    stop_reader(&mut audio_task).await;
}

async fn stop_reader(task: &mut Option<tokio::task::JoinHandle<()>>) {
    if let Some(old) = task.take() {
        // 中止整个流并等待退出，禁止复用半包，也禁止旧 reader 覆盖新画面。
        old.abort();
        let _ = old.await;
    }
}

#[cfg(test)]
mod tests;
