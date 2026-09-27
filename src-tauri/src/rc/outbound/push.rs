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
    // 探针（2026-09-27）：控制端唯一的帧龄观测点——可靠流与数据报两路都过这里。
    // skew 用当前校准值；旧对端没带 ts 时 at_ms 是收包时刻，age≈0 属预期噪声。
    crate::rc::probe_out::note_frame(
        frame.at_ms,
        cap_ms,
        enc_ms,
        width,
        height,
        svc.clock_skew_ms(),
    );
    svc.set_frame(frame.clone());
    svc.push_outbox(frame);
}
