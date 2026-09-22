// ── Q8 静止精修的运动判定（motion_verdict 纯函数）──────────────────────────

use crate::rc::inbound::{motion_verdict, MotionVerdict};

/// 🔴 精修强制出的 IDR 不能把自己当成「画面动了」——那是 re-arm 死循环
/// （静止画面每 ~330ms 一个 IDR）的成因，2026-09-19 审查发现的 P1。
#[test]
fn 关键帧不参与运动判定_精修IDR不重新武装() {
    assert_eq!(
        motion_verdict(true, 100_000, 500_000),
        MotionVerdict::Ignore,
        "关键帧无论多大都不是「动了」"
    );
    // 基准未建立：首个非关键帧负责建立（算动帧）
    assert_eq!(motion_verdict(false, 0, 1), MotionVerdict::Moving);
    // 动帧判据：≥ 基准/6
    assert_eq!(motion_verdict(false, 60_000, 10_000), MotionVerdict::Moving);
    assert_eq!(
        motion_verdict(false, 60_000, 9_999),
        MotionVerdict::Static,
        "跳块 P 帧只有基准零头 ⇒ 静止"
    );
}

/// 🔴 发送端序号从 1 起：sq=0 是「旧对端无序号」的保留值。曾从 0 起会让
/// 会话第一个流关键帧被接收端跳过锚定，首 GOP 画面全部滞留（首帧后冻 ~1s）。
#[test]
fn 发送端序号从1起且回绕跳过0() {
    use crate::rc::vid_dgram::VidDgramSender;
    let mut s = VidDgramSender::new();
    assert_eq!(s.take_seq(), 1, "第一个帧的序号是 1，不是 0");
    assert_eq!(s.take_seq(), 2);
}
