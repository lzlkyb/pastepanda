//! 实时媒体的滑动窗口。只在编码前背压，已编码参考帧不会被逐帧丢弃。
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub(super) const FEEDBACK_MS: u64 = 200;
const MIN_KBPS: u32 = 400;
const MAX_PENDING: usize = 2 * 1024 * 1024;
/// 降速线：作用于 `backlog_ms`（本端 send→ack 超额，不含对端上报与客户端绘制延迟），同时
/// 也是稳定平台探测带的上界、以及「传输层否认排队」的那条 RTT 线。中继会话的绘制延迟稳态
/// 就有 100..160ms，拿它当积压会把预算棘轮到 400kbps 地板。
const BACKLOG_DOWN_MS: i64 = 150;
/// 扩窗线：积压低于它就是确凿余量，每份反馈都可以试探；落在 60..150 之间要连续稳定
/// 3 秒才探（§24 缺陷①：真拥塞的积压每秒涨几百毫秒，被吸收的抖动平台不涨）。
const BACKLOG_PROBE_MS: i64 = 60;
const BACKLOG_STABLE_MS: u64 = 10;
/// 增长趋势判据：比上一份反馈又涨这么多才算真在堆积，且积压得先高过采样相位噪声。
const BACKLOG_RISE_MS: i64 = 30;
const BACKLOG_RISE_MIN_MS: i64 = 120;
/// 一个反馈窗口的可接受跨度上限；超过它 `delivered` 就不是线路容量证据
/// （静止画面、发送端断粮、反馈迟发都会给出低值，拿它封顶 = 自我棘轮）。
const REPRESENTATIVE_SAMPLE_MS: u64 = FEEDBACK_MS * 2;
/// app-limited 判据：本窗投递速率低于预算的 65% ⇒ 我们测的是画面不是线路
/// （WebRTC `alr_detector.cc:92-93` 的 0.65 口径；结论见
/// `docs/链路切换画质回升-业界源码对照-2026-10-06.md` §3.1）。
const APP_LIMITED_PCT: u64 = 65;
/// 升档持续门槛（墙钟）：fps/宽度的**升**档条件要连续成立满这么久才放行，降档永远即时。
/// 定标来自 round4 中继段重放（同文档 §5乙）：门槛 7s 把切换 10→4、A→B→A 往返 5→2、
/// 升档事件 4→1；≥15s 会把回升彻底杀光（0 次升档），已否决。
const UPGRADE_HOLD_MS: u64 = 7_000;

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
    /// 近期交付包络（观测到的最大交付速率，每份反馈衰减 1/8；app-limited 窗不参与，
    /// 见 `APP_LIMITED_PCT`）；扩窗判据看它，不看单窗。
    pub capacity_kbps: u32,
    pub queue_ms: i64,
    /// 线上传输/解码积压（本端 send→ack 超额口径，不含对端上报与客户端绘制延迟）；
    /// 拥塞判据与对端提示都看它。
    pub backlog_ms: i64,
    /// 本窗投递速率明显低于预算（测的是画面不是线路）；诊断与扩窗门用。
    pub app_limited: bool,
    /// 对端上报的「采集→到达」超额（ms）。只作旁证打印，**不参与定罪**：它含发送端
    /// 采集+编码与接收端回调前排队，快路径上会虚高到 240..620ms（见 `feedback`）。
    pub peer_queue_ms: i64,
    /// 采集/编码到上线的耗时（EMA，ms）——对端 `receive_queue_ms` 里那段本机开销的量证。
    pub tx_work_ms: u64,
    pending: VecDeque<Pending>,
    pending_bytes: usize,
    next_ms: u64,
    ack_at_ms: i64,
    presented_at_ms: i64,
    last_adjust_ms: u64,
    prev_backlog_ms: Option<i64>,
    /// 探测带内的稳定平台：(平台水位, 站定起点)。
    plateau: Option<(i64, u64)>,
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
    /// 升档条件的连续成立起点（墙钟）；条件一断或发生任何降档即清零。
    fps_up_since: Option<u64>,
    width_up_since: Option<u64>,
}

impl Default for Flow {
    fn default() -> Self {
        Self { kbps: 2_000, delivered_kbps: 0, capacity_kbps: 0, queue_ms: 0, backlog_ms: 0,
            app_limited: false, peer_queue_ms: 0, tx_work_ms: 0,
            pending: VecDeque::new(),
            pending_bytes: 0, next_ms: 0, ack_at_ms: 0, presented_at_ms: 0, last_adjust_ms: 0,
            prev_backlog_ms: None, plateau: None, last_reset_ms: None, last_feedback_ms: None, baseline_age_ms: i64::MAX,
            baseline_ack_ms: u64::MAX, ack_delay_ms: None, ack_mean_ms: None,
            ack_variance_ms: 0, relay: None, fps: 15,
            max_width: 0, resolution_changed_ms: None, fps_up_since: None, width_up_since: None }
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
            self.prev_backlog_ms = None;
            self.plateau = None;
            self.capacity_kbps = 0;
            // 换路是一次重新测量，不是同一根管道的续集：升档计时也从零开始。
            self.fps_up_since = None;
            self.width_up_since = None;
            // 换路后重新测容量；直连升级不能继承慢中继的永久低档。
            self.kbps = if relay { 2_000 } else { 4_000 };
        }
        self.kbps = self.kbps.min(ceiling_kbps.max(MIN_KBPS));
        self.kbps
    }

    pub fn sent(&mut self, now: u64, started_ms: u64, at_ms: i64, bytes: usize) {
        // 采集/编码启动到真正上线的耗时：对端那个「队列」里属于我们自己的那一半。
        self.tx_work_ms = self.tx_work_ms.saturating_mul(3).saturating_add(
            now.saturating_sub(started_ms.min(now))) / 4;
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

    /// `rtt_ms` 是传输层当前 RTT（`video_rtt_ms()`，0 = 尚无样本）：它是「网络自己承认在
    /// 排队吗」的独立仪表，用来豁免两个队列口径共同的污染源（见下方 `transport_clear`）。
    pub fn feedback(&mut self, now: u64, f: &MediaFeedback, ceiling: u32, loss_pm: i64, rtt_ms: i64) {
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
        if let Some(queue) = f.receive_queue_ms { self.peer_queue_ms = queue.max(0); }
        // 拥塞判据的证据锚：本端 send→ack 超额。**对端上报的 `receive_queue_ms` 不再
        // 覆盖它**——那个数从采集时刻起算（`at_ms` 是采集时间），把发送端采集+编码+序列化
        // 与接收端回调前的排队全算进「线上积压」。实测：v6 直连段 rtt=29ms/loss=0，
        // 该数却有 240..626ms，逐秒 ×0.8 把预算砍到 400kbps 地板钉死约 5 分钟
        // （`docs/链路切换画质回升-业界源码对照-2026-10-06.md` §1、§2.1）。
        self.backlog_ms = self.queue_ms;
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
        // app-limited：本窗投递速率明显低于预算 ⇒ delivered 测的是画面不是线路。
        self.app_limited = f.sample_ms <= REPRESENTATIVE_SAMPLE_MS
            && (delivered as u64).saturating_mul(100) < (self.kbps as u64) * APP_LIMITED_PCT;
        // 传输层否认「网络在排队」：RTT 已有样本、低于降速线、且零丢包。此时两个队列口径
        // 说的高积压都只剩本机开销或对端渲染管线——降码率治不了它，只会把画面做糊。
        // （实测：v6 直连 52 拍 backlog>150ms，其中传输层 rtt≥150ms 的有 **0** 拍；
        //  中继段 20 拍里 20 拍一致。见 docs/链路切换画质回升-业界源码对照-2026-10-06.md §1）
        let transport_clear = rtt_ms > 0 && rtt_ms < BACKLOG_DOWN_MS && loss_pm == 0;
        // 容量包络：观测到的最大交付速率，每份反馈衰减 1/8（约每秒折半）。被背压截断的
        // 窗口（刚 RESET、发送端断粮）给的是低值，拿那种低值当上限就是自我棘轮（实测交付
        // 835kbps 的超长窗口把 4000 一次踩到 751，之后再没涨回去）；真降容量时包络 1–2 秒内
        // 仍能跟上。**app-limited 样本不参与衰减**：对齐 `tcp_bbr.c:799`、本仓 vendor 的
        // `bbr3/mod.rs:766-770`、WebRTC ALR `aimd_rate_control.cc:253-259` 三家同一条——
        // 静止画面把包络沉向实际低交付率，会同时关掉扩窗门（`capacity ≥ 0.8×kbps`）和
        // 漂移帽（`capacity×5/4`），于是钉在 400kbps 地板后没有任何证据能把它抬回去。
        self.capacity_kbps = if self.app_limited {
            self.capacity_kbps.max(delivered)
        } else {
            ((self.capacity_kbps as u64 * 7 / 8) as u32).max(delivered)
        };
        // 拥塞证据只看 `backlog_ms`（本端 send→ack 超额），不看绘制延迟：中继会话的渲染管线
        // 稳态就有 100..160ms，旧口径拿它当积压，于是每 3 秒 RESET 一次就缩一次预算。
        // 真拥塞的积压每秒涨几百毫秒，稳态传播给的是一个不涨的平台。
        // **增长趋势不受 `transport_clear` 豁免**：RTT 是低频采样、可能正处在盲区，而「比上一
        // 拍又涨了 30ms」是本端单调时钟的差值，不受采样相位影响。只豁免绝对水位（`deep`），
        // 因为水位高但传输层否认、又不涨，剩下的只有本机开销/对端渲染深度。
        let rising = self.prev_backlog_ms
            .is_some_and(|prev| self.backlog_ms > BACKLOG_RISE_MIN_MS
                && self.backlog_ms.saturating_sub(prev) >= BACKLOG_RISE_MS);
        self.prev_backlog_ms = Some(self.backlog_ms);
        // 探测带（扩窗线..降速线）内的水位站定 3 秒才算平台；一路上涨的真积压站不住。
        if self.backlog_ms > BACKLOG_PROBE_MS && self.backlog_ms <= BACKLOG_DOWN_MS {
            if !self.plateau.is_some_and(|(base, _)| base.abs_diff(self.backlog_ms) <= BACKLOG_STABLE_MS) {
                self.plateau = Some((self.backlog_ms, now));
            }
        } else {
            self.plateau = None;
        }
        if now.saturating_sub(self.last_adjust_ms) < 1_000 { return; }
        let deep = !transport_clear && self.backlog_ms > BACKLOG_DOWN_MS;
        let plateaued = self.plateau.is_some_and(|(_, since)| now.saturating_sub(since) >= 3_000);
        if loss_pressure || deep || rising {
            // 封顶用**本窗口**的实测交付：有拥塞证据时链路是满流的，这个速率就是管子宽度。
            // 但窗口必须正常——被背压自己拉长的采样（实测 5..8s）和断粮窗口给出的是低值，
            // 拿它封顶就是自锁（旧口径 min(4000×0.8, 835×0.9)→751 再没涨回去）。
            let honest = f.sample_ms <= REPRESENTATIVE_SAMPLE_MS;
            let cap = if honest && delivered > 0 && (delivered as u64) < self.kbps as u64 {
                (delivered as u64) * 9 / 10
            } else { u64::MAX };
            self.kbps = ((self.kbps as u64 * 8 / 10).min(cap) as u32).max(MIN_KBPS);
            self.plateau = None;
        } else if (self.backlog_ms < BACKLOG_PROBE_MS || plateaued || transport_clear)
            && (self.capacity_kbps as u64) * 10 >= (self.kbps as u64) * 8 {
            // 包络门同时是**漂移封顶**：`capacity ≥ 0.8×kbps` ⇒ 预算最高停在已证明交付
            // 能力的 1.25 倍（BBR 的探测增益 5/4，`tcp_bbr.c:799` 的 app-limited 语义——
            // 没打满预算的样本不算「管子还能装」的证据）。旧门 0.7 允许比值常年停在
            // 1.43：真机中继 75 拍里 18 拍 `delivered < 0.5×budget`（最坏 3474/208、
            // 5085/752、2734/391），预算 6152 而实测交付只有 2562，且永远没有停下的理由。
            // 积压低于扩窗线=确凿余量，带内站够久的平台重新试探，传输层否认拥塞也算余量
            // （塌到地板后若不许再探，队列口径的任何残留就永久锁死档位）。包络明显高出
            // 预算=确凿余量，大步快探（旧口径每秒 +10%，中继从 400kbps 爬回可用带宽要 20
            // 多秒）。探一次后回到观察期。
            let step = if (self.capacity_kbps as u64) * 5 >= (self.kbps as u64) * 6 { self.kbps / 4 }
                else { (self.kbps / 10).max(100) };
            // 门在步进**前**判，比值就会按步长过冲一格；这里把封顶做成硬上限，
            // 「不高于已证明交付能力的 1.25 倍」才是真话而不是倾向。
            let drift_cap = ((self.capacity_kbps as u64) * 5 / 4).max(MIN_KBPS as u64) as u32;
            self.kbps = self.kbps.saturating_add(step).min(drift_cap).min(ceiling.max(MIN_KBPS));
            self.plateau = None;
        } else {
            return;
        }
        self.last_adjust_ms = now;
    }

    pub fn admission(&self, now: u64, rtt_ms: i64) -> Admission {
        let rtt = if rtt_ms <= 0 { 500 } else { rtt_ms.clamp(20, 5_000) as u64 };
        let deadline = self.ack_deadline_ms(rtt, now);
        let stale = self.pending.front().is_some_and(|p| now.saturating_sub(p.sent_ms) > deadline);
        // 小 ping 不能给周期媒体反馈定死期限。ACK 仍在推进且额外队列不足
        // 300ms 时，允许反馈周期内的抖动；无反馈/严重积压仍按原期限 RESET。
        let progressing = self.backlog_ms < 300 && self.last_feedback_ms.is_some_and(|at|
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
        // 🔴 反棘轮 v2（2026-10-06 复测）：证据锚点必须跨 RESET 存活。上一版在这里
        // 把 last_feedback_ms 抹成 None，而 `is_none_or(盲区)` 对 None 恒真——于是
        // 「刚清完队列、新流还没收到第一份反馈」每次都自动算作拥塞证据，实测 66%
        // 的 RESET 带 feedback_age=None 进来，预算照样踩到 400kbps 地板。
        // ACK 真的停更仍要降（背压失效时不降会无限重发大 IDR），但那件事由
        // `ack_deadline_ms` 按 last_reset_ms 给的起播宽限负责，不靠抹掉反馈历史。
        let ack_blind = self
            .last_feedback_ms
            .is_none_or(|t| now.saturating_sub(t) > FEEDBACK_MS * 5);
        self.pending.clear();
        self.pending_bytes = 0;
        self.next_ms = now;
        self.last_reset_ms = Some(now);
        // 换参考链后积压口径重新起算，跨 RESET 的差值不是增长趋势。
        self.prev_backlog_ms = None;
        self.plateau = None;
        if ack_blind || loss_pm >= 10 || self.backlog_ms > BACKLOG_DOWN_MS {
            self.kbps = ((self.kbps as u64 * 7 / 10) as u32).max(MIN_KBPS);
        }
    }

    fn ack_deadline_ms(&self, rtt: u64, now: u64) -> u64 {
        // 完整 IDR 的交付还要串行化全部字节，小 ping 的 RTT 不包含这段耗时。
        // 只给最老帧计算余量，最多给既有写入预算 2 秒；不能随整个积压队列
        // 增长把 RESET 无限推迟。原字节窗/帧数水位照常先行保护。
        let serial = self.pending.front().map_or(0, |p|
            (p.bytes as u64 * 8).div_ceil(self.kbps.max(MIN_KBPS) as u64)
                .min(super::media::WRITE_BUDGET.as_millis() as u64));
        let base = rtt + 500 + serial;
        // 实测积压已经增长时不能用慢 ACK 反过来放宽超时，否则控制器会
        // 随拥塞一起扩窗，继续显示旧画面。正常传播/采样耗时才有这份余量。
        let deadline = if self.backlog_ms > BACKLOG_DOWN_MS { base } else {
            let jitter_budget = self.ack_mean_ms.unwrap_or(0)
                .saturating_add(self.ack_variance_ms.saturating_mul(4))
                .saturating_add(FEEDBACK_MS);
            let measured = self.ack_delay_ms.unwrap_or(0).saturating_add(500).max(jitter_budget);
            base.max(measured.min(base + 2_000))
        };
        // 起播宽限挂在「最后一次反馈」与「最后一次 RESET」里较晚的那个时刻上：
        // 新参考链在拿到第一份反馈前不该按旧口径判死，而证据已经停更 5 个采样
        // 周期的链也仍要有界恢复。健康链路（反馈照常到）拿不到这份余量。
        let startup = [self.last_feedback_ms, self.last_reset_ms].into_iter().flatten().max();
        if startup.is_none_or(|t| now.saturating_sub(t) > FEEDBACK_MS * 5) {
            deadline.max(2_500)
        } else { deadline }
    }

    pub fn reset_diagnostics(&self, now: u64, rtt_ms: i64) -> String {
        let rtt = if rtt_ms <= 0 { 500 } else { rtt_ms.clamp(20, 5_000) as u64 };
        let age = self.pending.front().map_or(0, |p| now.saturating_sub(p.sent_ms));
        format!("pending={} bytes={} oldest={}ms deadline={}ms rtt={}ms budget={}kbps delivered={}kbps ack={} feedback_age={:?} media_ack={:?}ms queue={}ms backlog={}ms peer_queue={}ms capacity={}kbps app_limited={} tx_work={}ms",
            self.pending.len(), self.pending_bytes, age, self.ack_deadline_ms(rtt, now), rtt, self.kbps,
            self.delivered_kbps,
            self.ack_at_ms, self.last_feedback_ms.map(|t| now.saturating_sub(t)), self.ack_delay_ms, self.queue_ms, self.backlog_ms, self.peer_queue_ms, self.capacity_kbps, self.app_limited, self.tx_work_ms)
    }

    /// 升档条件的连续成立门槛（墙钟）。条件一断就重新计时，返回「够不够久」。
    /// 只用在**升**档上；降档永远即时（重放口径同源，见 `UPGRADE_HOLD_MS`）。
    fn upgrade_held(since: &mut Option<u64>, now: u64) -> bool {
        match *since {
            None => { *since = Some(now); false }
            Some(t) => now.saturating_sub(t) >= UPGRADE_HOLD_MS,
        }
    }

    /// 任何一次降档都要把升档计时清零：刚掉下来的档不能靠「条件早就成立」立刻弹回去。
    fn clear_upgrade_anchors(&mut self) {
        self.fps_up_since = None;
        self.width_up_since = None;
    }

    pub fn fps_limit(&mut self, relay: bool, now: u64) -> u32 {
        // 阈值带滞回，避免容量探测在边界反复改变 fps、触发编码器重开。
        let (next, up) = match self.fps {
            60 if relay || self.kbps < 7_000 => (30, false),
            30 if self.kbps < 2_500 => (15, false),
            15 if self.kbps < 1_000 => (10, false),
            10 if self.kbps >= 1_400 => (15, true),
            15 if self.kbps >= 3_500 => (30, true),
            30 if !relay && self.kbps >= 9_000 => (60, true),
            fps => (fps, false),
        };
        if next != self.fps {
            if !up {
                self.clear_upgrade_anchors();
                self.fps = next;
            } else if Self::upgrade_held(&mut self.fps_up_since, now) {
                self.fps = next;
                self.fps_up_since = None;
            }
        } else {
            self.fps_up_since = None;
        }
        // 快速直连上的用户高帧率档仍由既有采集/编码门控决定，不能把
        // fps120/144/165 静默裁成 60；常规档位会再与自身上限取 min。
        if self.fps == 60 { 165 } else { self.fps }
    }

    pub fn feedback_queue(&self) -> Option<i64> {
        // 对端提示要说的是「线上排队了多久」，不是对面渲染管线有多深。
        self.last_feedback_ms.map(|_| self.backlog_ms)
    }

    pub fn resolution_limit(&mut self, now: u64) -> u32 {
        let candidate = match self.max_width {
            0 if self.kbps < 1_800 => 1280,
            1280 if self.kbps < 700 => 960,
            960 if self.kbps >= 1_100 => 1280,
            1280 if self.kbps >= 2_800 => 0,
            current => current,
        };
        if candidate == self.max_width {
            self.width_up_since = None;
            return self.max_width;
        }
        // 0 = 不限宽（原分辨率）是最高一档，拿它排在 1280/960 之上判升还是降。
        let rank = |w: u32| match w { 0 => 3, 1280 => 2, _ => 1 };
        let up = rank(candidate) > rank(self.max_width);
        if up && !Self::upgrade_held(&mut self.width_up_since, now) { return self.max_width; }
        // 既有 5 秒冷却照旧生效（编码器重开本身的开销），与升档门槛是两道独立的闸。
        if self.resolution_changed_ms.is_some_and(|t| now.saturating_sub(t) < 5_000) { return self.max_width; }
        if up { self.width_up_since = None; } else { self.clear_upgrade_anchors(); }
        self.max_width = candidate;
        self.resolution_changed_ms = Some(now);
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
