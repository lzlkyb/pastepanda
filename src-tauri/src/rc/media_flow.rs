//! 实时媒体的滑动窗口。只在编码前背压，已编码参考帧不会被逐帧丢弃。
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub(super) const FEEDBACK_MS: u64 = 200;
const MIN_KBPS: u32 = 400;
const MAX_PENDING: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaFeedback {
    pub received_at_ms: i64,
    pub received_bytes: u64,
    pub sample_ms: u64,
    pub age_ms: i64,
    #[serde(default)]
    pub presented_at_ms: i64,
    #[serde(default)]
    pub display_delay_ms: Option<u64>,
    /// 接收端单调到达时间与采集时间差的增量；不含 ACK 采样/回程或时钟校准。
    #[serde(default)]
    pub receive_queue_ms: Option<i64>,
}

struct Pending {
    at_ms: i64,
    sent_ms: u64,
    bytes: usize,
}

#[derive(Debug, PartialEq)]
pub(super) enum Admission { Ready, Wait, Reset }

pub(super) struct Flow {
    pub kbps: u32,
    pub delivered_kbps: u32,
    pub queue_ms: i64,
    pending: VecDeque<Pending>,
    pending_bytes: usize,
    next_ms: u64,
    ack_at_ms: i64,
    presented_at_ms: i64,
    last_adjust_ms: u64,
    recovery_queue: Option<(i64, u64)>,
    last_reset_ms: Option<u64>,
    last_feedback_ms: Option<u64>,
    baseline_age_ms: i64,
    baseline_ack_ms: u64,
    ack_delay_ms: Option<u64>,
    ack_mean_ms: Option<u64>,
    ack_variance_ms: u64,
    relay: Option<bool>,
    fps: u32,
    max_width: u32,
    resolution_changed_ms: Option<u64>,
}

impl Default for Flow {
    fn default() -> Self {
        Self { kbps: 2_000, delivered_kbps: 0, queue_ms: 0, pending: VecDeque::new(),
            pending_bytes: 0, next_ms: 0, ack_at_ms: 0, presented_at_ms: 0, last_adjust_ms: 0,
            recovery_queue: None, last_reset_ms: None, last_feedback_ms: None, baseline_age_ms: i64::MAX,
            baseline_ack_ms: u64::MAX, ack_delay_ms: None, ack_mean_ms: None,
            ack_variance_ms: 0, relay: None, fps: 15,
            max_width: 0, resolution_changed_ms: None }
    }
}

impl Flow {
    pub fn budget(&mut self, relay: bool, ceiling_kbps: u32) -> u32 {
        if self.relay != Some(relay) {
            self.relay = Some(relay);
            self.baseline_age_ms = i64::MAX;
            self.baseline_ack_ms = u64::MAX;
            self.ack_delay_ms = None;
            self.ack_mean_ms = None;
            self.ack_variance_ms = 0;
            self.recovery_queue = None;
            // 换路后重新测容量；直连升级不能继承慢中继的永久低档。
            self.kbps = if relay { 2_000 } else { 4_000 };
        }
        self.kbps = self.kbps.min(ceiling_kbps.max(MIN_KBPS));
        self.kbps
    }

    pub fn sent(&mut self, now: u64, started_ms: u64, at_ms: i64, bytes: usize) {
        // 反馈可能比 write future 的完成更早，不把已交付帧重新记作积压。
        if at_ms > self.ack_at_ms {
            self.pending.push_back(Pending { at_ms, sent_ms: now, bytes });
            self.pending_bytes = self.pending_bytes.saturating_add(bytes);
        }
        // 采集/编码和入队已经占用了本帧节拍，不能在工作结束后再等完整间隔。
        // 异步写入及同圈多个编码包仍累加字节债务；空闲不积攒突发发送额度。
        self.next_ms = self.next_ms.max(started_ms.min(now))
            .saturating_add((bytes as u64 * 8).div_ceil(self.kbps as u64));
    }

    pub fn feedback(&mut self, now: u64, f: &MediaFeedback, ceiling: u32, loss_pm: i64) {
        if f.received_at_ms <= self.ack_at_ms { return; }
        self.ack_at_ms = f.received_at_ms;
        self.last_feedback_ms = Some(now);
        let mut first_delay = None;
        let mut latest_delay = None;
        while self.pending.front().is_some_and(|p| p.at_ms <= self.ack_at_ms) {
            let p = self.pending.pop_front().unwrap();
            let delay = now.saturating_sub(p.sent_ms);
            first_delay.get_or_insert(delay);
            latest_delay = Some(delay);
            self.pending_bytes -= p.bytes;
        }
        if let Some(delay) = first_delay {
            // 媒体 ACK 包含整帧交付、200ms 采样和回程，小 ping RTT 会显著低估它。
            // 保留近期上界并逐样本衰减；异常样本不能突破 admission 的硬上界。
            self.ack_delay_ms = Some(delay.max(self.ack_delay_ms.unwrap_or(0).saturating_mul(7) / 8));
            // ACK 回程抖动不会出现在接收端队列中。只用上次耗时 + 固定余量
            // 会在健康但抖动的中继上反复 RESET；以平滑耗时和偏差估计恢复预算。
            if let Some(mean) = self.ack_mean_ms {
                self.ack_variance_ms = (self.ack_variance_ms.saturating_mul(3)
                    .saturating_add(delay.abs_diff(mean))) / 4;
                self.ack_mean_ms = Some(mean.saturating_mul(7).saturating_add(delay) / 8);
            } else {
                self.ack_mean_ms = Some(delay);
                self.ack_variance_ms = delay / 2;
            }
        }
        if let Some(delay) = latest_delay {
            // 同一发送端单调时钟的交付差值不受两端时钟重新校准影响。
            // 用批内最新 ACK，避免把 200ms 反馈采样跨度当成新增队列。
            self.baseline_ack_ms = self.baseline_ack_ms.min(delay);
            // 采样相位本身可在 0..200ms 变化，并不是网络或解码队列增长。
            self.queue_ms = delay.saturating_sub(self.baseline_ack_ms).saturating_sub(FEEDBACK_MS)
                .min(i64::MAX as u64) as i64;
        } else {
            // ACK 先于 write future 返回时尚无发送记录，保留已有帧龄口径兜底。
            self.baseline_age_ms = self.baseline_age_ms.min(f.age_ms.max(0));
            self.queue_ms = f.age_ms.saturating_sub(self.baseline_age_ms).max(0);
        }
        if let Some(queue) = f.receive_queue_ms { self.queue_ms = queue.max(0); }
        if f.presented_at_ms > self.presented_at_ms {
            self.presented_at_ms = f.presented_at_ms;
            if let Some(delay) = f.display_delay_ms {
                // 只使用新绘制测量，也兼容会重复携带上一次耗时的客户端。
                self.queue_ms = self.queue_ms.max(delay.min(10_000) as i64);
            }
        }
        let delivered = (f.received_bytes.saturating_mul(8) / f.sample_ms.max(1))
            .min(u32::MAX as u64) as u32;
        self.delivered_kbps = delivered;
        let loss_pressure = super::media::loss_pressure(
            f.receive_queue_ms.or_else(|| f.display_delay_ms.map(|ms| ms.min(10_000) as i64)),
            loss_pm.max(0) as u64, 31);
        // 中等队列只在连续稳定 3 秒后探测；正在上升的真实积压不能借恢复扩窗。
        if (60..100).contains(&self.queue_ms) && !loss_pressure {
            if !self.recovery_queue.is_some_and(|(queue, _)| queue.abs_diff(self.queue_ms) <= 10) {
                self.recovery_queue = Some((self.queue_ms, now));
            }
        } else { self.recovery_queue = None; }
        let recovered = self.recovery_queue.is_some_and(|(_, since)| now.saturating_sub(since) >= 3_000);
        if now.saturating_sub(self.last_adjust_ms) < 1_000 { return; }
        if self.queue_ms > 150 || loss_pressure {
            let observed = if delivered > 0 { (delivered as u64 * 9 / 10) as u32 } else { self.kbps };
            self.kbps = ((self.kbps as u64 * 8 / 10) as u32).min(observed).max(MIN_KBPS);
        } else if (self.queue_ms < 60 || recovered) && delivered as u64 >= self.kbps as u64 * 7 / 10 {
            // 只在实测流量接近预算时探测；静态画面的低流量不是线路上限。
            // 稳定公网的 60..100ms 抖动也需恢复探测，与 150ms 降速线留出滞回。
            self.kbps = self.kbps.saturating_add((self.kbps / 10).max(100)).min(ceiling.max(MIN_KBPS));
            self.recovery_queue = None;
        }
        self.last_adjust_ms = now;
    }

    pub fn admission(&self, now: u64, rtt_ms: i64) -> Admission {
        let rtt = if rtt_ms <= 0 { 500 } else { rtt_ms.clamp(20, 5_000) as u64 };
        let deadline = self.ack_deadline_ms(rtt);
        let stale = self.pending.front().is_some_and(|p| now.saturating_sub(p.sent_ms) > deadline);
        // 小 ping 不能给周期媒体反馈定死期限。ACK 仍在推进且额外队列不足
        // 300ms 时，允许反馈周期内的抖动；无反馈/严重积压仍按原期限 RESET。
        let progressing = self.queue_ms < 300 && self.last_feedback_ms.is_some_and(|at|
            now.saturating_sub(at) <= FEEDBACK_MS * 3 + rtt);
        let reset_cooled = self.last_reset_ms.is_none_or(|t| now.saturating_sub(t) > rtt + 500);
        if ((stale && !progressing) || self.pending_bytes > MAX_PENDING || self.pending.len() > 240) && reset_cooled {
            return Admission::Reset;
        }
        // BDP 包含 ACK 的 200ms 采样周期，另给 150ms 余量；否则低 RTT
        // 的局域网也会在第一份反馈回来前耗尽窗口，出现周期性断粮。
        let window = (self.kbps as u64 * (rtt + FEEDBACK_MS + 150) / 8).clamp(8 * 1024, MAX_PENDING as u64);
        if now < self.next_ms || self.pending_bytes as u64 >= window {
            Admission::Wait
        } else { Admission::Ready }
    }

    pub fn discard(&mut self, now: u64, loss_pm: i64) {
        // 已废弃帧的迟到 ACK 不属于新的参考链，不能缩短新流的起播宽限。
        if let Some(last) = self.pending.back() { self.ack_at_ms = self.ack_at_ms.max(last.at_ms); }
        // 🔴 反棘轮（2026-10-05 中继实测）：ACK 照常到达、零丢包、无增长队列时
        // 的 RESET 只是「慢」不是「坏」，RESET 本身已丢掉过期积压；预算再乘 0.7
        // 会自我强化（实测 2000→400kbps 钉死在地板，交付永远够不到扩容线）。
        // 只在有证据时降：帧丢包 ≥10‰、实测队列 >150ms、或 ACK 盲区
        // （反馈停更超过 5 个采样周期——背压失效时仍须降预算，防止无限重发大 IDR）。
        let ack_blind = self
            .last_feedback_ms
            .is_none_or(|t| now.saturating_sub(t) > FEEDBACK_MS * 5);
        self.pending.clear();
        self.pending_bytes = 0;
        self.next_ms = now;
        self.last_reset_ms = Some(now);
        self.last_feedback_ms = None;
        self.recovery_queue = None;
        if ack_blind || loss_pm >= 10 || self.queue_ms > 150 {
            self.kbps = ((self.kbps as u64 * 7 / 10) as u32).max(MIN_KBPS);
        }
    }

    fn ack_deadline_ms(&self, rtt: u64) -> u64 {
        // 完整 IDR 的交付还要串行化全部字节，小 ping 的 RTT 不包含这段耗时。
        // 只给最老帧计算余量，最多给既有写入预算 2 秒；不能随整个积压队列
        // 增长把 RESET 无限推迟。原字节窗/帧数水位照常先行保护。
        let serial = self.pending.front().map_or(0, |p|
            (p.bytes as u64 * 8).div_ceil(self.kbps.max(MIN_KBPS) as u64)
                .min(super::media::WRITE_BUDGET.as_millis() as u64));
        let base = rtt + 500 + serial;
        // 实测积压已经增长时不能用慢 ACK 反过来放宽超时，否则控制器会
        // 随拥塞一起扩窗，继续显示旧画面。正常传播/采样耗时才有这份余量。
        let deadline = if self.queue_ms > 150 { base } else {
            let jitter_budget = self.ack_mean_ms.unwrap_or(0)
                .saturating_add(self.ack_variance_ms.saturating_mul(4))
                .saturating_add(FEEDBACK_MS);
            let measured = self.ack_delay_ms.unwrap_or(0).saturating_add(500).max(jitter_budget);
            base.max(measured.min(base + 2_000))
        };
        if self.last_feedback_ms.is_none() { deadline.max(2_500) } else { deadline }
    }

    pub fn reset_diagnostics(&self, now: u64, rtt_ms: i64) -> String {
        let rtt = if rtt_ms <= 0 { 500 } else { rtt_ms.clamp(20, 5_000) as u64 };
        let age = self.pending.front().map_or(0, |p| now.saturating_sub(p.sent_ms));
        format!("pending={} bytes={} oldest={}ms deadline={}ms rtt={}ms budget={}kbps ack={} feedback_age={:?} media_ack={:?}ms queue={}ms",
            self.pending.len(), self.pending_bytes, age, self.ack_deadline_ms(rtt), rtt, self.kbps,
            self.ack_at_ms, self.last_feedback_ms.map(|t| now.saturating_sub(t)), self.ack_delay_ms, self.queue_ms)
    }

    pub fn fps_limit(&mut self, relay: bool) -> u32 {
        // 阈值带滞回，避免容量探测在边界反复改变 fps、触发编码器重开。
        self.fps = match self.fps {
            60 if relay || self.kbps < 7_000 => 30,
            30 if self.kbps < 2_500 => 15,
            15 if self.kbps < 1_000 => 10,
            10 if self.kbps >= 1_400 => 15,
            15 if self.kbps >= 3_500 => 30,
            30 if !relay && self.kbps >= 9_000 => 60,
            fps => fps,
        };
        // 快速直连上的用户高帧率档仍由既有采集/编码门控决定，不能把
        // fps120/144/165 静默裁成 60；常规档位会再与自身上限取 min。
        if self.fps == 60 { 165 } else { self.fps }
    }

    pub fn feedback_queue(&self) -> Option<i64> {
        self.last_feedback_ms.map(|_| self.queue_ms)
    }

    pub fn resolution_limit(&mut self, now: u64) -> u32 {
        let candidate = match self.max_width {
            0 if self.kbps < 1_800 => 1280,
            1280 if self.kbps < 700 => 960,
            960 if self.kbps >= 1_100 => 1280,
            1280 if self.kbps >= 2_800 => 0,
            current => current,
        };
        if candidate != self.max_width && self.resolution_changed_ms.is_none_or(|t| now.saturating_sub(t) >= 5_000) {
            self.max_width = candidate;
            self.resolution_changed_ms = Some(now);
        }
        self.max_width
    }
}

pub(super) fn scaled_dimensions(w: u32, h: u32, limit: u32) -> (u32, u32) {
    if limit == 0 || w <= limit { return (w.max(64) & !1, h.max(64) & !1); }
    let out_w = limit.max(64) & !1;
    (out_w, ((h as u64 * out_w as u64 / w as u64) as u32).max(64) & !1)
}

#[derive(Default)]
pub(super) struct Receiver {
    pub presented_at_ms: i64,
    bytes: u64,
    last_ms: Option<u64>,
    latest_at_ms: i64,
    arrivals: VecDeque<(i64, u64)>,
    display_delay_ms: Option<u64>,
    latest_age_ms: i64,
    baseline_transit_ms: Option<i64>,
    latest_queue_ms: i64,
    relay: Option<bool>,
}

impl Receiver {
    pub fn set_path(&mut self, relay: bool) {
        if self.relay != Some(relay) {
            self.relay = Some(relay);
            // 换路后的传播基线重新测量，不能把 LAN→中继的传播增量当作积压。
            self.baseline_transit_ms = None;
            self.latest_queue_ms = 0;
        }
    }

    pub fn presented(&mut self, at_ms: i64, now: u64) {
        if at_ms <= self.presented_at_ms { return; }
        if let Some((_, received)) = self.arrivals.iter().find(|(at, _)| *at == at_ms) {
            self.display_delay_ms = Some(now.saturating_sub(*received));
            self.presented_at_ms = at_ms;
            while self.arrivals.front().is_some_and(|(at, _)| *at <= at_ms) { self.arrivals.pop_front(); }
        }
    }

    pub fn receive(&mut self, now: u64, at_ms: i64, bytes: usize, age_ms: i64) {
        if at_ms <= self.latest_at_ms { return; }
        self.latest_at_ms = at_ms;
        self.latest_age_ms = age_ms;
        // 两个时钟的固定偏差在差分中抵消；不用会重新校准的 clock_skew，
        // 也不把本帧等到下一次 200ms 反馈任务的时间算进媒体积压。
        let transit = (now.min(i64::MAX as u64) as i64).saturating_sub(at_ms);
        let baseline = self.baseline_transit_ms.get_or_insert(transit);
        *baseline = (*baseline).min(transit);
        self.latest_queue_ms = transit.saturating_sub(*baseline).max(0);
        self.arrivals.push_back((at_ms, now));
        while self.arrivals.len() > 120 { self.arrivals.pop_front(); }
        self.bytes = self.bytes.saturating_add(bytes as u64);
        self.last_ms.get_or_insert(now);
    }

    pub fn has_pending(&self) -> bool { self.bytes > 0 }

    pub fn take_feedback(&mut self, now: u64) -> Option<MediaFeedback> {
        if !self.has_pending() { return None; }
        let start = *self.last_ms.get_or_insert(now);
        let elapsed = now.saturating_sub(start);
        if elapsed < FEEDBACK_MS { return None; }
        let f = MediaFeedback { received_at_ms: self.latest_at_ms, received_bytes: self.bytes,
            sample_ms: elapsed, age_ms: self.latest_age_ms, presented_at_ms: self.presented_at_ms,
            display_delay_ms: self.display_delay_ms.take(), receive_queue_ms: Some(self.latest_queue_ms) };
        self.bytes = 0;
        self.last_ms = Some(now);
        Some(f)
    }
}

#[cfg(test)]
mod tests;
