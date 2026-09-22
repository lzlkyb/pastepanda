// ── 推流节拍判据（2026-09-22「拖动窗口卡顿 / 看不到窗口动画」那一批）─────
//
// 这些判据**错了不会崩**，只会静默跑错帧率（表现是「卡」而不是「错」），
// 所以每一条都要有回归钉。

use crate::rc::pace::{
    auto_key_due, boost_gap_ms, effective_interval_ms, next_period_ms, want_fps_for,
};
use std::time::{Duration, Instant};

/// 🔴 提帧上限从 33ms（30fps）降到 16ms（60fps）——原生桌面的窗口拖动与
/// 开关动画是 60fps，30fps 采样下 200ms 的关闭动画只剩 6 帧，看上去是跳变。
/// 回归钉：任何把普通档位提帧上限改回 30fps 的改动都会在这里红。
#[test]
fn 提帧上限到位60fps() {
    assert_eq!(boost_gap_ms(100), 16, "均衡档（静止 10fps）拖动时可到 60fps");
    assert_eq!(boost_gap_ms(80), 16, "超清档");
    assert_eq!(boost_gap_ms(66), 16, "清晰档");
    assert_eq!(boost_gap_ms(33), 16, "比上限慢的间隔照样被收到 16ms");
    assert_eq!(boost_gap_ms(16), 16, "fps60 档不变");
}

/// 档位本身比提帧上限更快时**跟随档位**，不被拖慢（fps120 档 8ms＝120fps）。
#[test]
fn 高帧率档不被提帧上限拖慢() {
    assert_eq!(boost_gap_ms(8), 8, "fps120 档保持 120fps");
    assert_eq!(boost_gap_ms(7), 7, "fps144 档");
    assert_eq!(boost_gap_ms(6), 6, "fps165 档");
    assert_eq!(boost_gap_ms(0), 0, "边界：0 不炸（调用方另有 max(1) 兜底）");
}

/// D6b：fps120 请求落到没有零拷贝路径的场景（多屏拼接 / GPU 已判死）时，
/// 节拍降回 16ms（fps60 体感）——UI 门控只挡正常路径，挡不住会话中途
/// 切范围 / 直连接口的请求。
#[test]
fn 无零拷贝时fps120降回60fps体感() {
    assert_eq!(effective_interval_ms(8, false, false), 8, "正常路径不动");
    assert_eq!(effective_interval_ms(8, true, false), 16, "虚拟屏（多屏拼接）");
    assert_eq!(effective_interval_ms(8, false, true), 16, "GPU 路径已判死");
    assert_eq!(
        effective_interval_ms(100, true, false),
        100,
        "普通档位不受 D6b 影响"
    );
}

/// 🔴 编码器 fps 必须按**提帧上限**算，不是按静止间隔算：
/// 编码器的样本时间戳是 `idx * 1e7 / fps` 严格步进的（`mft_pick::make_sample`），
/// 而拖动时真实帧率是提帧上限。两者不一致 ⇒ 真实出 60 帧/秒、编码器按
/// 30fps 分配每帧 bit ⇒ 实际码率被 CBR 限流、画面塌陷。
#[test]
fn 编码器fps跟提帧上限走() {
    assert_eq!(want_fps_for(100, false, false), 60, "均衡档拖动真实 60fps");
    assert_eq!(want_fps_for(80, false, false), 60, "超清档");
    assert_eq!(want_fps_for(66, false, false), 60, "清晰档");
    assert_eq!(want_fps_for(16, false, false), 60, "fps60 档");
    assert_eq!(want_fps_for(8, false, false), 120, "fps120 档");
    assert_eq!(want_fps_for(7, false, false), 144, "fps144 档");
    assert_eq!(want_fps_for(6, false, false), 165, "fps165 档");
    // 🔴 映射表回归钉：曾经「≤10 → 120」的一刀切会把 7ms/6ms 档也标成
    // 120fps——时间戳步进与 CBR 分配全错，表现是「不糊但码率浪费」。
    assert_ne!(want_fps_for(7, false, false), 120);
}

/// 2026-09-22 新增 fps144/fps165 档的 D6b 语义：无零拷贝路径时与 fps120
/// 同一处理——节拍降回 16ms，编码器 fps 也要看到降频（否则按 144fps 出
/// 时间戳而实际跑 60fps）。
#[test]
fn 高帧率144与165也要看到D6b降频() {
    assert_eq!(want_fps_for(7, true, false), 60, "虚拟屏 + fps144 降到 60");
    assert_eq!(want_fps_for(6, false, true), 60, "GPU 判死 + fps165 降到 60");
    assert_eq!(want_fps_for(7, false, false), 144, "正常路径仍是 144");
    assert_eq!(want_fps_for(6, false, false), 165, "正常路径仍是 165");
}

/// 🔴 判据分叉回归钉（2026-09-22 修）：`want_fps_for` 必须看到 D6b 降频后的
/// 有效节拍。曾经它只读档位原始间隔 ⇒ 虚拟屏 + fps120 场景下编码器按
/// 120fps 出时间戳、实际只跑 60fps，码控基准整体偏一倍。
#[test]
fn 编码器fps也要看到D6b降频() {
    assert_eq!(
        want_fps_for(8, true, false),
        60,
        "虚拟屏 + fps120：实际节拍被降回 16ms，fps 也要跟着降"
    );
    assert_eq!(want_fps_for(8, false, true), 60, "GPU 判死同理");
    assert_eq!(want_fps_for(8, false, false), 120, "正常路径仍是 120");
}

/// 🔴 C2 的 IDR 限频：数据报弃帧后主动要 IDR 能把自愈缩短一圈，但 IDR 是
/// 整帧大包——不限频就会「拥塞→弃帧→要 IDR→更拥塞」自激成风暴。
#[test]
fn 主动要IDR必须限频() {
    let now = Instant::now();
    assert!(auto_key_due(None, now, 500), "首次立刻允许");
    let just_now = now.checked_sub(Duration::from_millis(499)).unwrap();
    assert!(!auto_key_due(Some(just_now), now, 500), "未满门槛要拦住");
    let at_gate = now.checked_sub(Duration::from_millis(500)).unwrap();
    assert!(auto_key_due(Some(at_gate), now, 500), "正好等于门槛算到期");
    let long_ago = now.checked_sub(Duration::from_millis(600)).unwrap();
    assert!(auto_key_due(Some(long_ago), now, 500), "超过门槛");
}

/// 🔴 本次改动的核心判据：**画面在动 → 按 60fps 抓**（而不是等输入事件）。
///
/// 写反了不会崩，只会退回「200ms 的窗口动画只抓到 2 帧」的跳变观感——
/// 用户报的「看不到动画」正是这个。所以四个边界都要钉住。
#[test]
fn 画面在动就按60fps抓不动就省() {
    assert_eq!(next_period_ms(true, 100, 1), 16, "活跃：均衡档也按 60fps 抓");
    assert_eq!(
        next_period_ms(true, 100, 4),
        16,
        "活跃圈不受 pace_scale 降频影响（否则一拖就自己降频）"
    );
    assert_eq!(next_period_ms(false, 100, 1), 100, "空闲：用档位间隔省 CPU");
    assert_eq!(next_period_ms(false, 100, 2), 200, "空闲：吃 pace_scale 降频");
    assert_eq!(next_period_ms(true, 8, 1), 8, "fps120 档活跃时保持 120fps");
    assert_eq!(next_period_ms(false, 8, 1), 8, "fps120 档空闲也跟随档位");
}

/// 🔴 接线守卫：H.264 路径**必须**喂自动档。
///
/// 2026-09-22 修的真 bug：`auto_note_frame` 全项目只有 JPEG 兜底路径调用，
/// H.264 路径从不喂 ⇒ 自动档的判据窗口永远是空的 ⇒ 档位**永远停在起跑档**
/// （默认「均衡」= 10fps）。而正常有硬编的机器走的都是 H.264，也就是
/// 「自动」实际等于「永远 10fps」。
///
/// 这类「漏一条调用」不报错、不掉帧、单测全绿，只能靠扫源码钉住。
#[test]
fn 守卫_h264路径必须喂自动档() {
    let src = include_str!("../inbound/video.rs");
    assert!(
        src.contains("auto_note_frame"),
        "inbound/video.rs 必须调用 svc.auto_note_frame——漏了它，自动档在 H.264 会话里形同不存在"
    );
}

/// 🔴 接线守卫：推流节拍的唯一出口是 `next_period_ms`。
///
/// 曾经是 `next_tick = frame_start + interval * pace_scale`（恒定）⇒ 画面
/// 在动也按档位间隔抓，窗口开关动画只抓到 2 帧。改回恒定式会静默复发。
#[test]
fn 守卫_推流节拍必须过next_period_ms() {
    let src = include_str!("../inbound/video_run.rs");
    assert!(
        src.contains("next_period_ms("),
        "推流循环必须用 rc::pace::next_period_ms 决定节拍——写回恒定档位间隔会让运动场景退回 10fps"
    );
}
