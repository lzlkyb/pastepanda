// —— C8(b)：剪贴板 pull 的等待判定 ——
//
// 要防的是「跨会话串剪贴板」：上一个会话超时后**迟到**的回包会把 clip_seq
// 顶上去，如果只看 seq，本次 pull 就会误以为数据到了，把别的会话的剪贴板
// 内容当作本次结果返回。所以判定必须同时认「会话代」。

use crate::rc::clipboard::{clip_wait_decision, ClipWait};

#[test]
fn takes_when_seq_advanced() {
    assert_eq!(clip_wait_decision(0, 0, 5, 4), ClipWait::Take);
}

#[test]
fn keeps_waiting_when_seq_unchanged() {
    assert_eq!(clip_wait_decision(0, 0, 4, 4), ClipWait::KeepWaiting);
}

#[test]
fn abandons_on_session_switch_even_if_seq_advanced() {
    // 核心用例：seq 涨了（5 > 4）但会话已换 → 绝不能 Take
    assert_eq!(clip_wait_decision(1, 0, 5, 4), ClipWait::Abandon);
}

#[test]
fn abandons_on_session_switch_even_without_reply() {
    assert_eq!(clip_wait_decision(7, 6, 2, 2), ClipWait::Abandon);
}

#[test]
fn abandon_wins_over_take() {
    // 会话已切换时，不管 seq 怎么变，都必须是 Abandon
    for seq_now in [0u64, 1, 4, 5, 100] {
        assert_eq!(
            clip_wait_decision(2, 1, seq_now, 4),
            ClipWait::Abandon,
            "seq_now={seq_now} 时被 seq 抢判了"
        );
    }
}

#[test]
fn take_requires_strictly_greater_seq() {
    // seq 相等说明回包还没来；写成 >= 会在「上一次 pull 的回包」上误判
    assert_eq!(clip_wait_decision(3, 3, 9, 9), ClipWait::KeepWaiting);
}
