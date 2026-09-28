//! 控制端探针（2026-09-27 取证）：RTT / 帧龄分段 / 数据报断链的周期汇总。
//!
//! 被控端有 `[RC-PERF]`（[`super::perf`]，挂在 InboundVideo 上每 5s 汇总），
//! 控制端此前**只算不记**——pong 的 RTT 样本、每帧遥测（采集时刻 / cap / enc）
//! 到手即丢，内网高延迟只能靠 HUD 截图猜。本模块把发起端视角的观测按 5s
//! 一行打成 `[RC-PROBE]`，经 logging.rs 同时进 dev 控制台与 rc.log。
//!
//! 与 `perf.rs` 同款「错了不会崩」口径：全部纯内存统计，任何失败不影响推流。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// 汇总周期：5s 一行，与被控端 `[RC-PERF]` 对齐，两端日志可以按时间对读。
const REPORT_EVERY_MS: u128 = 5_000;

struct Window {
    started: Instant,
    /// pong 往返样本（ping 每秒一发 ⇒ 每窗约 5 个）。
    rtt_n: u64,
    rtt_min: i64,
    rtt_max: i64,
    rtt_sum: i64,
    /// 帧龄样本（本机收帧时刻 − 对端采集时刻 + skew）及其分段。
    age_n: u64,
    age_min: i64,
    age_max: i64,
    age_sum: i64,
    cap_sum: i64,
    enc_sum: i64,
    net_sum: i64,
    /// 最近一帧的编码分辨率（会话内应恒定，变化即记录价值）。
    last_w: u32,
    last_h: u32,
    /// 数据报引用链断裂次数（每次触发 request_key）。
    damaged: u64,
    /// JPEG 帧数（>0 = 本场会话在 JPEG 兜底路径上，H.264 没走起来）。
    jpeg: u64,
    /// 当前 skew（对端时钟 − 本机时钟）。
    skew: i64,
}

static WINDOW: Mutex<Option<Window>> = Mutex::new(None);
static REPORTS: AtomicU64 = AtomicU64::new(0);

/// 帧龄 EMA（NetHint 快速码控的信源，2026-09-28）。**非对称**平滑：升快
/// （α=1/2，WiFi 队列一涨立刻反映到码控）降慢（α=1/8，恢复要稳，别把码率
/// 拉成电锯）。-1 = 尚无样本。
static AGE_EMA: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);
/// FEC 逐帧反馈计数（2026-09-28）：收端视角「本帧靠校验片恢复过数据片」的帧数
/// 与「引用链断裂丢弃」的帧数。发送端据此上调 RS 冗余——比 conn 级丢包‰
/// 更贴近帧粒度（WiFi 丢包是按突发砸在某几帧上的）。
static FEC_RECOVERED: AtomicU64 = AtomicU64::new(0);
static FEC_DROPPED: AtomicU64 = AtomicU64::new(0);
/// 交付帧总数（frame_loss 反馈的分母）。
static DELIVERED: AtomicU64 = AtomicU64::new(0);

fn blank(now: Instant) -> Window {
    Window {
        started: now,
        rtt_n: 0,
        rtt_min: i64::MAX,
        rtt_max: 0,
        rtt_sum: 0,
        age_n: 0,
        age_min: i64::MAX,
        age_max: 0,
        age_sum: 0,
        cap_sum: 0,
        enc_sum: 0,
        net_sum: 0,
        last_w: 0,
        last_h: 0,
        damaged: 0,
        jpeg: 0,
        skew: 0,
    }
}

/// pong 到达（outbound.rs 的 pong 分支）。`skew` = 本轮算出的时钟偏差样本
/// （未经 EMA，记录原始值供对读）。
pub(super) fn note_pong(rtt_ms: i64, skew_sample: i64) {
    let Ok(mut g) = WINDOW.lock() else { return };
    let w = g.get_or_insert_with(|| blank(Instant::now()));
    w.rtt_n += 1;
    w.rtt_sum += rtt_ms;
    w.rtt_min = w.rtt_min.min(rtt_ms);
    w.rtt_max = w.rtt_max.max(rtt_ms);
    if skew_sample != 0 {
        w.skew = skew_sample;
    }
    maybe_report(w);
}

/// 一帧交付（push.rs 两路共用入口）。`skew` = 发起端当前校准值
/// （`svc.clock_skew_ms()`），age = 本机收帧时刻 − 对端采集时刻 + skew。
pub(super) fn note_frame(
    at_ms: i64,
    cap_ms: u16,
    enc_ms: u16,
    width: u32,
    height: u32,
    skew: i64,
) {
    note_telemetry(at_ms, cap_ms, enc_ms, width, height, skew, false);
}

/// 一帧 JPEG（handle_jpeg：H.264 打不开 / 单帧失败时的兜底路径）。
/// JPEG 帧计数 > 0 即说明本场会话硬编没走起来——这是「编码慢」最重要的分诊信号。
pub(super) fn note_jpeg(
    at_ms: i64,
    cap_ms: u16,
    enc_ms: u16,
    width: u32,
    height: u32,
    skew: i64,
) {
    note_telemetry(at_ms, cap_ms, enc_ms, width, height, skew, true);
}

fn note_telemetry(
    at_ms: i64,
    cap_ms: u16,
    enc_ms: u16,
    width: u32,
    height: u32,
    skew: i64,
    jpeg: bool,
) {
    let age = chrono::Utc::now().timestamp_millis() - at_ms + skew;
    // 帧龄 EMA：升快降慢（见 AGE_EMA 注释）。clamp 到 [-1000, 2500]：
    // 🔴 2026-09-28 真机复盘——13s 级链路停顿的样本若原样进 EMA（曾 clamp 到
    // 60s），升 α=1/2 一拍跳上去了、降 α=1/8 要几十秒才缓过来，B 端码率被钉死
    // 在 15% 整整半分钟。停顿是链路事件不是稳态排队，2.5s 封顶让码控「看见了
    // 就压、过去了就放」，深停顿另由 RTT 档位兜底。
    let age_c = age.clamp(-1000, 2500);
    AGE_EMA.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |prev| {
        Some(if prev < 0 {
            age_c
        } else if age_c > prev {
            (prev + age_c) / 2
        } else {
            (prev * 7 + age_c) / 8
        })
    })
    .ok();
    DELIVERED.fetch_add(1, Ordering::Relaxed);
    let Ok(mut g) = WINDOW.lock() else { return };
    let w = g.get_or_insert_with(|| blank(Instant::now()));
    w.age_n += 1;
    w.age_sum += age;
    w.age_min = w.age_min.min(age);
    w.age_max = w.age_max.max(age);
    w.cap_sum += cap_ms as i64;
    w.enc_sum += enc_ms as i64;
    // 网络段 = 帧龄 − 采集 − 编码（解码在前端实测，这里不含）；负值 clamp 0。
    w.net_sum += (age - cap_ms as i64 - enc_ms as i64).max(0);
    w.last_w = width;
    w.last_h = height;
    w.skew = skew;
    if jpeg {
        w.jpeg += 1;
    }
    maybe_report(w);
}

/// 数据报重组引用链断裂（spawn_video_dgram_reader 的 damaged 分支）。
pub(super) fn bump_damaged() {
    FEC_DROPPED.fetch_add(1, Ordering::Relaxed);
    let Ok(mut g) = WINDOW.lock() else { return };
    let w = g.get_or_insert_with(|| blank(Instant::now()));
    w.damaged += 1;
}

/// 一帧靠校验片恢复过缺失数据片（vid_dgram 的 `recovered` 标志）。
pub(super) fn bump_fec_recovered() {
    FEC_RECOVERED.fetch_add(1, Ordering::Relaxed);
}

/// 帧龄 EMA 快照（NetHint 快速码控信源）。-1 = 尚无样本。
pub(super) fn age_ema_ms() -> i64 {
    AGE_EMA.load(Ordering::Relaxed)
}

/// FEC 逐帧反馈快照（读后清零，NetHint 每次携带自上一次以来的窗口）。
/// 返回 `(丢失帧数, 交付帧数)`——调用方折算 permille。无样本返回 `None`。
pub(super) fn take_frame_loss_feedback() -> Option<(u64, u64)> {
    let dropped = FEC_DROPPED.swap(0, Ordering::Relaxed);
    let recovered = FEC_RECOVERED.swap(0, Ordering::Relaxed);
    let delivered = DELIVERED.swap(0, Ordering::Relaxed);
    if dropped == 0 && recovered == 0 && delivered == 0 {
        return None;
    }
    Some((dropped, delivered))
}

/// 满 5s 打一行并清窗。调用方持锁。
fn maybe_report(w: &mut Window) {
    if w.started.elapsed().as_millis() < REPORT_EVERY_MS {
        return;
    }
    let n = REPORTS.fetch_add(1, Ordering::Relaxed) + 1;
    let rtt_line = if w.rtt_n > 0 {
        format!(
            "往返 {}ms（min {} / max {}，{} 样本）",
            w.rtt_sum / w.rtt_n as i64,
            w.rtt_min,
            w.rtt_max,
            w.rtt_n
        )
    } else {
        "无 pong".into()
    };
    let age_line = if w.age_n > 0 {
        let n = w.age_n as i64;
        format!(
            "帧龄 {}ms（min {} / max {}）· 采集 {} · 编码 {} · 网络 {} · {}x{}",
            w.age_sum / n,
            w.age_min,
            w.age_max,
            w.cap_sum / n,
            w.enc_sum / n,
            w.net_sum / n,
            w.last_w,
            w.last_h
        )
    } else {
        "无帧".into()
    };
    log::info!(
        "[RC-PROBE #{n}] {rtt_line} · {age_line} · 断链 {} · JPEG帧 {} · skew {}ms",
        w.damaged,
        w.jpeg,
        w.skew
    );
    let started = Instant::now();
    *w = blank(started);
}
