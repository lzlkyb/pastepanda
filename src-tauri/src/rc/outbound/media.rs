//! 单一 uni 接收入口，音视频各保留一个 reader；新视频流立即替换旧流。
use super::*;

impl OutboundVideo {
    pub(super) fn spawn_media_acceptor(&self) {
        let svc = self.svc.clone();
        let my_id = self.my_id.clone();
        let peer = self.peer.clone();
        let conn = self.conn.clone();
        let reasm = self.reasm.clone();
        tauri::async_runtime::spawn(async move {
            let audio_svc = svc.clone();
            let audio_id = my_id.clone();
            let video_svc = svc.clone();
            let video_id = my_id.clone();
            let video_conn = conn.clone();
            crate::rc::media::route(
                conn,
                || svc.session_id_is(&my_id),
                move |stream, header| {
                    receive_audio(audio_svc.clone(), audio_id.clone(), stream, header)
                },
                move |stream, codec| {
                    let svc = video_svc.clone();
                    let id = video_id.clone();
                    let peer = peer.clone();
                    let conn = video_conn.clone();
                    let reasm = reasm.clone();
                    async move {
                        let Some(mut reader) =
                            OutboundVideo::try_new(svc.clone(), &peer, stream, conn)
                        else {
                            return;
                        };
                        if reader.my_id != id {
                            return;
                        }
                        reader.reasm = reasm;
                        log::info!(
                            "[RC] 媒体视频流接通（{codec}，stream={}）",
                            reader.recv.id()
                        );
                        let mut first = true;
                        while let Ok(frame) = read_incoming(&mut reader.recv).await {
                            // 读可能跨越会话切换；旧会话不能向新帧池写入。
                            if !svc.session_id_is(&id) {
                                break;
                            }
                            let is_frame =
                                matches!(&frame, Incoming::Jpeg(_) | Incoming::H264 { .. });
                            match frame {
                                Incoming::Jpeg(f) => reader.handle_jpeg(f),
                                Incoming::H264 {
                                    key,
                                    width,
                                    height,
                                    data,
                                    ts,
                                    cap_ms,
                                    enc_ms,
                                    sq,
                                    codec,
                                } => reader.handle_h264(
                                    key, width, height, data, ts, cap_ms, enc_ms, sq, codec,
                                ),
                                Incoming::Control(bytes) => {
                                    // 媒体上只接收 JPEG 元数据，控制命令仍属于主流。
                                    if serde_json::from_slice::<serde_json::Value>(&bytes)
                                        .ok()
                                        .is_some_and(|v| {
                                            matches!(v["t"].as_str(), Some("vrect" | "vts"))
                                        })
                                    {
                                        reader.handle_control(&bytes);
                                    }
                                }
                            }
                            if first && is_frame {
                                first = false;
                                log::info!("[RC] 媒体首帧完整接收（{codec}，session={id}）");
                            }
                        }
                    }
                },
            )
            .await;
        });
    }
}

async fn receive_audio(
    svc: Arc<RcService>,
    id: String,
    mut stream: iroh::endpoint::RecvStream,
    header: Vec<u8>,
) {
    #[cfg(any(target_os = "windows",target_os="macos"))]
    {
        let Some((cfg, _)) = crate::rc::audio::try_parse_stream_header(&header) else {
            return;
        };
        if !svc.session_id_is(&id) {
            return;
        }
        svc.audio_begin(cfg);
        loop {
            let mut lb = [0; 4];
            if stream.read_exact(&mut lb).await.is_err() {
                break;
            }
            let n = u32::from_le_bytes(lb) as usize;
            if !(9..=64 * 1024).contains(&n) {
                break;
            }
            let mut body = vec![0; n];
            if stream.read_exact(&mut body).await.is_err() || !svc.session_id_is(&id) {
                break;
            }
            if body[0]!=1 {break;}
            svc.note_inbound();
            svc.audio_push(
                u64::from_le_bytes(body[1..9].try_into().unwrap()),
                body[9..].to_vec(),
            );
        }
    }
    #[cfg(not(any(target_os = "windows",target_os="macos")))]
    let _ = (svc, id, &mut stream, header);
}
