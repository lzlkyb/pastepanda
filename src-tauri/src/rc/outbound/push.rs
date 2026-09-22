//! H.264 帧入队（push_h264_frame：出站帧队列 + 统计）。

use super::*;

/// P2-1：H.264/HEVC（Q3）帧入池（可靠流与数据报两条路共用这一处路由）。
/// 编码标准随帧走：流路径来自元数据 `c` 字段，数据报路径来自分片头的
/// FLAG_HEVC 位——不做跨通道状态推断。
#[allow(clippy::too_many_arguments)]
pub(super) fn push_h264_frame(
    svc: &RcService,
    key: bool,
    width: u32,
    height: u32,
    data: Vec<u8>,
    ts: i64,
    cap_ms: u16,
    enc_ms: u16,
    codec: crate::rc::video::FrameCodec,
) {
    let frame = crate::rc::video::VideoFrame {
        width,
        height,
        jpeg: data,
        at_ms: if ts > 0 { ts } else { chrono::Utc::now().timestamp_millis() },
        full: true,
        rect: None,
        codec,
        key,
        cap_ms,
        enc_ms,
    };
    svc.set_frame(frame.clone());
    svc.push_outbox(frame);
}
