//! 实时媒体的滑动窗口。只在编码前背压，已编码参考帧不会被逐帧丢弃。
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub(super) const FEEDBACK_MS: u64 = 200;
const MIN_KBPS: u32 = 400;
/// 文字优先的另一半（2026-10-06 真机中继复测）：分辨率不再缩之后，1080p 在
/// 400kbps 地板上每帧只分到 ~8KB，用户判「文字清楚但卡/块太重」——同场实测
/// 容量包络 1071..1184kbps 明明够。编码宽 ≥[`FULLHD_MIN_WIDTH`] 时把预算地板
/// 抬到 1Mbps；仍受实测容量钳制（见 `Flow::floor_kbps`），链路真窄时地板跟着降。
const FULLHD_FLOOR_KBPS: u32 = 1_000;
const FULLHD_MIN_WIDTH: u32 = 1_600;
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
/// 🔴 P1（2026-10-06）：**不再要求窗口正常**。旧的第二半 `sample_ms ≤ 400` 恰好在
/// 故障形态上反噬：低帧率时反馈窗天然被拉长，于是 `app_limited` 判成 false，包络继续
/// 按拍衰减（实测 870→444→236）并同时关掉扩窗门与漂移帽——这就是那半条自锁链。
/// 窗口长短现在只管一件事：能不能拿 `delivered` 封顶降档（`REPRESENTATIVE_SAMPLE_MS`）。
const APP_LIMITED_PCT: u64 = 65;
/// 主动探测（P3）：本窗**因预算丢过帧**（确凿需求，见 `note_drop`）且传输层清白时，
/// 一次把预算翻倍。定标取自 WebRTC `probe_controller.cc:94`（ALR 期每 5s 探一次）与
/// `:572-573`（探测上限按分配速率翻倍）。没有这份探测，P0 拆掉阻塞闸之后「预算不够」与
/// 「线路不够」在纯交付速率上仍不可分——只能靠丢帧证据 + 主动试。
const PROBE_COOLDOWN_MS: u64 = 5_000;
/// 探测的保护窗：这段时间内的拥塞证据算「探测失败」，回落到探测起点而不是对膨胀后的
/// 值再乘 0.8（一次失败探测挨两刀）。定标同源：`probe_controller.cc:53` 的
/// `kAlrEndedTimeout` 也是 3 秒。
const PROBE_HOLD_MS: u64 = 3_000;
/// 拥塞证据下包络的移动步长：对齐 `link_capacity_estimator.cc:39-40` 的
/// `OnOveruseDetected → Update(rate, 0.05)`（慢速 EWMA，不给单拍定罪权）。
const CAPACITY_OVERUSE_ALPHA: u64 = 50;
/// 升档持续门槛（墙钟）：fps/宽度的**升**档条件要连续成立满这么久才放行，降档永远即时。
/// 定标来自 round4 中继段重放（同文档 §5乙）：门槛 7s 把切换 10→4、A→B→A 往返 5→2、
/// 升档事件 4→1；≥15s 会把回升彻底杀光（0 次升档），已否决。
const UPGRADE_HOLD_MS: u64 = 7_000;
/// 🔴 G2（2026-10-06）：**绝对水位**（`backlog > 降速线`）要连续这么多拍才拿到定罪权。
/// 业界没有单拍踩这一脚的：`rd_qos.rs:220-222` 要 2 连拍，WebRTC 的
/// `aimd_rate_control.cc` 用「时长」而不是「次数」做门槛。我们此前的现场形态是
/// 「自己把采集圈卡住 ⇒ 一拍 backlog 6813ms ⇒ 预算连砍三刀」
/// （`docs/链路切换画质回升-业界源码对照-2026-10-06.md` §10）。
/// 只给水位加门槛，**增长趋势（`rising`）与丢包仍单拍定罪**：前者是本端单调时钟的
/// 差值、后者是链路直读，两者都不是采样相位能造出来的假象。
const DEEP_STREAK_TICKS: u8 = 2;
/// 🔴 G3（2026-10-06）：真正砍过一刀（或 RESET 过）之后，要再等这么多拍**新**证据才许
/// 砍第二刀。口径来自 `rd_qos.rs` 的 `replies_after_bitrate_reduction`——刚降完码率时
/// 窗口里那些 ACK 是**上一段拥塞的遗留**，拿它们当「还是拥塞」的复证就是自我循环。
/// 硬证据（`rising` / 丢包）不受此限：拥塞真的在恶化时响应仍要快。
/// 1s 的 `last_adjust_ms` 冷却不够，因为它对 RESET 之前就已经排好的队不设防。
const POST_CUT_WAIT_TICKS: u8 = 2;

/// 积压线按路径归一（2026-10-06 真机中继第二轮，方案乙）：降速线 150ms 与扩窗线 60ms
/// 定标在 20..30ms RTT 的直连上。中继固有 RTT ~600ms、ACK 抖动 ±400ms，健康链路的
/// backlog 稳态就有 388..465ms——线坐在抖动**里面**，于是 G2 两连拍判深积压连砍（实测
/// capacity 2.3Mbps 被砍回 892kbps）、deadline 放宽分支被关死（10 秒 4 次 RESET，
/// 每次弃 7..10 帧就是一次可见卡顿）、排队压力 EMA 长期高位把编码码率再打 25..70% 折。
/// 归一尺用 `ack_mean_ms`（send→ack 的平滑实测，含传播与采样）：降速线 = max(150,
/// mean/2)、扩窗线 = max(60, mean/4)，探针带形状不变（扩窗线 < 降速线恒成立）。
/// 🔴 rising 两线（`BACKLOG_RISE_*`）**有意保持绝对常数**：方差尺会被积压自己污染
/// （爬升中的 backlog 灌大 `ack_variance`，信号吃掉噪声估计），mean 尺则会盖住直连
/// 40ms/拍的真实趋势（`growing_queue_shrinks_the_budget_within_seconds` 的反例）。
/// 真拥塞仍抓得住：rising 单拍趋势与丢包照旧定罪；ack_mean 被持续排队抬升时，
/// 绝对水位先超 `max(150, mean/2)`。`transport_clear` 的 RTT 线**有意保持绝对 150ms**
/// （甲-2 拍板：中继固有传播延迟不能由 RTT 自证清白），不随本尺缩放。
impl Flow {
    fn backlog_down_ms(&self) -> i64 {
        BACKLOG_DOWN_MS.max((self.ack_mean_ms.unwrap_or(0) / 2) as i64)
    }
    fn backlog_probe_ms(&self) -> i64 {
        BACKLOG_PROBE_MS.max((self.ack_mean_ms.unwrap_or(0) / 4) as i64)
    }
}


/// 「传输层否认网络在排队」的唯一判据：RTT 已有样本、低于降速线、且零丢包。
/// 🔴 单一数据源（AGENTS 规则 11.1）：控制器定罪（`feedback`）与采集圈的自适应降频
/// 复位（P4，`inbound::video_run`）必须看同一个数，判据写两遍必漏一处。
pub(super) fn transport_clear(rtt_ms: i64, loss_pm: i64) -> bool {
    rtt_ms > 0 && rtt_ms < BACKLOG_DOWN_MS && loss_pm == 0
}

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
    /// 近期交付包络（观测到的最大交付速率）。🔴 P2（2026-10-06）：**只在证据下移动**，
    /// 不再每份反馈 ×7/8 衰减——对齐 `link_capacity_estimator.cc`：只有
    /// `OnOveruseDetected`（慢速下调）与 `OnProbeRate`/观测上界（上调）两个入口。
    /// 衰减版把「画面静止」测出的低交付当成管子变窄，实测 870→444→236 一路沉到地板，
    /// 同时关掉扩窗门（`capacity ≥ 0.8×kbps`）与漂移帽（`capacity×5/4`）。
    pub capacity_kbps: u32,
    pub queue_ms: i64,
    /// 线上传输/解码积压（本端 send→ack 超额口径，不含对端上报与客户端绘制延迟）；
    /// 拥塞判据与对端提示都看它。
    pub backlog_ms: i64,
    /// 本窗投递速率明显低于预算，且既没被预算丢过帧也没有拥塞证据（测的是画面不是线路）。
    pub app_limited: bool,
    /// 上一个反馈窗里**因预算（字节窗/发送债务）丢过帧** ⇒ 需求确凿大于供给。
    /// 这是 P0 拆掉阻塞闸之后才拿得到的证据：旧实现生产者直接卡在闸上，控制器分不清
    /// 「线路窄」和「我们自己没送」，实测把 400kbps 地板当成线路能力钉死。
    pub demand_limited: bool,
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
    /// 绝对水位（`backlog > 降速线`）的连续拍数，G2 的计数（见 `DEEP_STREAK_TICKS`）。
    deep_streak: u8,
    /// 砍过一刀/RESET 之后还剩几拍「只观察不连砍」，G3 的计数（见 `POST_CUT_WAIT_TICKS`）。
    post_cut_wait: u8,
    /// 探测带内的稳定平台：(平台水位, 站定起点)。
    plateau: Option<(i64, u64)>,
    /// 本窗累计「想发而被预算挡下」的帧数；`feedback` 取走并清零（`note_drop` 递增）。
    drops_in_window: u32,
    /// 在飞探测的起点预算：探测期内出现拥塞证据就回落到这里（一次失败探测只挨一刀）。
    probe_floor: u32,
    /// 最近一次探测的起始时刻（既是保护窗 `PROBE_HOLD_MS`，也是冷却 `PROBE_COOLDOWN_MS`
    /// 的锚点：同一份证据不重复撞墙）。
    probe_at_ms: Option<u64>,
    last_reset_ms: Option<u64>,
    last_feedback_ms: Option<u64>,
    baseline_age_ms: i64,
    baseline_ack_ms: u64,
    ack_delay_ms: Option<u64>,
    ack_mean_ms: Option<u64>,
    ack_variance_ms: u64,
    relay: Option<bool>,
    fps: u32,
    /// 预算地板档位：编码宽 ≥`FULLHD_MIN_WIDTH` 时为 `FULLHD_FLOOR_KBPS`，否则 `MIN_KBPS`。
    min_kbps: u32,
    /// 升档条件的连续成立起点（墙钟）；条件一断或发生任何降档即清零。
    fps_up_since: Option<u64>,
}

impl Default for Flow {
    fn default() -> Self {
        Self { kbps: 2_000, delivered_kbps: 0, capacity_kbps: 0, queue_ms: 0, backlog_ms: 0,
            app_limited: false, demand_limited: false, peer_queue_ms: 0, tx_work_ms: 0,
            pending: VecDeque::new(),
            pending_bytes: 0, next_ms: 0, ack_at_ms: 0, presented_at_ms: 0, last_adjust_ms: 0,
            prev_backlog_ms: None, plateau: None, drops_in_window: 0, probe_floor: 0,
            deep_streak: 0, post_cut_wait: 0,
            probe_at_ms: None, last_reset_ms: None, last_feedback_ms: None, baseline_age_ms: i64::MAX,
            baseline_ack_ms: u64::MAX, ack_delay_ms: None, ack_mean_ms: None,
            ack_variance_ms: 0, relay: None, fps: 15, min_kbps: MIN_KBPS, fps_up_since: None }
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
            // 换路后探测与丢帧证据一起作废：旧路径上「被预算挡下」说明不了新路径的容量。
            self.drops_in_window = 0;
            self.demand_limited = false;
            self.probe_at_ms = None;
            self.probe_floor = 0;
            // 换路是一次重新测量，不是同一根管道的续集：升档计时也从零开始。
            self.fps_up_since = None;
            // 换路后重新测容量；直连升级不能继承慢中继的永久低档。
            self.kbps = if relay { 2_000 } else { 4_000 };
        }
        self.kbps = self.kbps.min(ceiling_kbps.max(self.floor_kbps()));
        self.kbps
    }

    /// 每圈编码时由调用点喂实际编码宽：宽 ≥[`FULLHD_MIN_WIDTH`] ⇒ 地板抬到
    /// [`FULLHD_FLOOR_KBPS`]（1080p 喂不饱就是色块+积压 RESET，见常量注释）。
    pub fn note_encode_width(&mut self, w: u32) {
        self.min_kbps = if w >= FULLHD_MIN_WIDTH { FULLHD_FLOOR_KBPS } else { MIN_KBPS };
    }

    /// 预算下限。1080p 档抬到 [`FULLHD_FLOOR_KBPS`]，再被实测容量包络钳到九成：
    /// 链路真窄时地板跟着包络降（不下探过 [`MIN_KBPS`]）；无容量证据时信档位地板。
    fn floor_kbps(&self) -> u32 {
        if self.min_kbps <= MIN_KBPS { return MIN_KBPS; }
        if self.capacity_kbps > 0 {
            MIN_KBPS.max(self.min_kbps.min(self.capacity_kbps * 9 / 10))
        } else { self.min_kbps }
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

    /// P0：生产端「这一帧想发但被预算挡下」（字节窗满、发送债务未到期、或单槽流水线被
    /// 占用）。调用方**不阻塞、不重试**，只记这一笔账——它是 app-limited 判据与主动探测
    /// 唯一的需求证据：没有它，「线路窄」和「我们自己没送」在交付速率上长得一模一样。
    pub fn note_drop(&mut self) {
        self.drops_in_window = self.drops_in_window.saturating_add(1);
    }

    /// 准入没放行时，下一次再来问的最早时刻（P0 的节拍锚，替代旧的阻塞式等待）：按发送
    /// 债务 `next_ms` 算，夹在 8..`FEEDBACK_MS` 之间——字节窗满了没有时刻信号可查，只能按
    /// 反馈周期回查；下界 8ms 防静止画面把采集圈变成忙等。
    pub fn gate_retry_ms(&self, now: u64) -> u64 {
        self.next_ms.saturating_sub(now).clamp(8, FEEDBACK_MS)
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
        // 传输层否认「网络在排队」：RTT 已有样本、低于降速线、且零丢包。此时两个队列口径
        // 说的高积压都只剩本机开销或对端渲染管线——降码率治不了它，只会把画面做糊。
        // （实测：v6 直连 52 拍 backlog>150ms，其中传输层 rtt≥150ms 的有 **0** 拍；
        //  中继段 20 拍里 20 拍一致。判据收口成 `transport_clear()`，采集圈的 P4 复位共用）
        let transport_clear = transport_clear(rtt_ms, loss_pm);
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
        if self.backlog_ms > self.backlog_probe_ms() && self.backlog_ms <= self.backlog_down_ms() {
            if !self.plateau.is_some_and(|(base, _)| base.abs_diff(self.backlog_ms) <= BACKLOG_STABLE_MS) {
                self.plateau = Some((self.backlog_ms, now));
            }
        } else {
            self.plateau = None;
        }
        let deep_now = !transport_clear && self.backlog_ms > self.backlog_down_ms();
        // G2：绝对水位要连续两拍才拿到定罪权（口径见 `DEEP_STREAK_TICKS`）；
        // `rising`/`loss_pressure` 仍是单拍硬证据，不等这一拍。
        self.deep_streak = if deep_now {
            self.deep_streak.saturating_add(1)
        } else {
            0
        };
        let deep = self.deep_streak >= DEEP_STREAK_TICKS;
        let congested = loss_pressure || deep || rising;
        // 🔴 P0 换回来的证据：本窗生产者有没有「想发而被预算挡下」的帧（`note_drop`）。
        // 旧实现把采集圈整个阻塞在准入闸上，控制器只看得到「交付变慢」，分不清是线路窄
        // 还是我们自己没送——那条自锁链的起点就在这里。
        let had_drops = self.drops_in_window > 0;
        self.drops_in_window = 0;
        self.demand_limited = had_drops;
        // app-limited（P1）三个条件缺一不可：没被预算挡过帧（否则需求确凿）、没有拥塞证据
        // （否则这份低交付是线路给的）、速率明显低于预算（否则算打满）。**窗口长短不参与**
        // （旧的第二半 `sample_ms ≤ 400` 在低帧率形态上恰好反噬成 false，见 `APP_LIMITED_PCT`）。
        self.app_limited = !had_drops && !congested
            && (delivered as u64).saturating_mul(100) < (self.kbps as u64) * APP_LIMITED_PCT;
        let honest = f.sample_ms <= REPRESENTATIVE_SAMPLE_MS;
        // 容量包络（P2）：**只在证据下移动，没有每拍 ×7/8 衰减**。三家源码同一条口径——
        // `link_capacity_estimator.cc` 只有 `OnOveruseDetected`(α=0.05) 与 `OnProbeRate`
        // (α=0.5) 两个入口、`tcp_bbr.c` 的 app-limited 采样不进 max-filter、本仓 vendor 的
        // `bbr3/mod.rs:766-770` 同构。衰减版把「画面静止」测出的低交付当成管子变窄：
        // 实测 870→444→236 一路沉到地板，同时关掉扩窗门（`capacity ≥ 0.8×kbps`）与漂移帽
        // （`capacity×5/4`），钉死之后没有任何证据能把它抬回去。
        if self.app_limited {
            // 测的是画面不是管子：包络一动不动，也不参与任何方向的判断。
        } else if congested && honest {
            // 慢速 EWMA 下调，单拍不许一脚踩死（835kbps 的超长窗把 4000 一次踩到 751
            // 就是旧口径的自锁现场；那种被拉长的窗口本来就 `!honest`，不参与）。
            let cur = self.capacity_kbps as u64;
            self.capacity_kbps = (cur - cur.saturating_mul(CAPACITY_OVERUSE_ALPHA) / 1_000
                + (delivered as u64).saturating_mul(CAPACITY_OVERUSE_ALPHA) / 1_000) as u32;
        } else {
            // 上界取 max：包络是「已证明的管宽」，不因安静期遗忘（`budget()` 换路时才清零）。
            self.capacity_kbps = self.capacity_kbps.max(delivered);
        }
        if now.saturating_sub(self.last_adjust_ms) < 1_000 { return; }
        let plateaued = self.plateau.is_some_and(|(_, since)| now.saturating_sub(since) >= 3_000);
        let probe_active = self.probe_at_ms.is_some_and(|t| now.saturating_sub(t) < PROBE_HOLD_MS);
        let probe_cooled = self.probe_at_ms.is_none_or(|t| now.saturating_sub(t) >= PROBE_COOLDOWN_MS);
        if congested {
            if self.post_cut_wait > 0 && !(rising || loss_pressure) {
                // G3：上一刀（或 RESET）之后还没等到足够新证据，这一拍只观察不连砍。
                // 水位本身可能是 RESET 之前就排好的遗留队列，1s 的 `last_adjust_ms`
                // 冷却对它不设防。硬证据（`rising`/丢包）不走这条路。
                self.post_cut_wait -= 1;
                self.plateau = None;
            } else if probe_active {
                // 探测期内的拥塞证据 = 探测失败：回到探测起点。对膨胀后的值再乘 0.8 等于
                // 让一次试错挨两刀，代价是恢复期白白多糊一档。
                self.kbps = self.probe_floor.max(self.floor_kbps());
                self.post_cut_wait = POST_CUT_WAIT_TICKS;
            } else {
                // 封顶用**本窗口**的实测交付：有拥塞证据时链路是满流的，这个速率就是管子宽度。
                // 但窗口必须正常——被背压自己拉长的采样（实测 5..8s）和断粮窗口给出的是低值，
                // 拿它封顶就是自锁（旧口径 min(4000×0.8, 835×0.9)→751 再没涨回去）。
                let cap = if honest && delivered > 0 && (delivered as u64) < self.kbps as u64 {
                    (delivered as u64) * 9 / 10
                } else { u64::MAX };
                self.kbps = ((self.kbps as u64 * 8 / 10).min(cap) as u32).max(self.floor_kbps());
                self.post_cut_wait = POST_CUT_WAIT_TICKS;
            }
            self.plateau = None;
        } else if had_drops && transport_clear && probe_cooled
            && self.kbps < ceiling.max(self.floor_kbps()) {
            // P3 主动探测（口径见 `PROBE_COOLDOWN_MS`）：本窗确有需求（被预算挡下过帧）、
            // 传输层又否认排队 ⇒ 挡住我们的很可能是**自家预算**而不是线路，一次翻倍去问。
            // 静止画面（`!had_drops`）绝不探：`tcp_bbr.c:788-799` 那条「app-limited 期间
            // 维持已知的最好速率、不拿它当管子还能装」就是这条线的出处。
            self.probe_floor = self.kbps;
            self.kbps = ((self.kbps as u64 * 2)
                .min(ceiling.max(MIN_KBPS) as u64).max(self.floor_kbps() as u64))
                .min(u32::MAX as u64) as u32;
            self.probe_at_ms = Some(now);
            self.plateau = None;
        } else if (self.backlog_ms < self.backlog_probe_ms() || plateaued || transport_clear)
            && !probe_active
            && (self.capacity_kbps as u64) * 10 >= (self.kbps as u64) * 8 {
            // 包络门同时是**漂移封顶**：`capacity ≥ 0.8×kbps` ⇒ 预算最高停在已证明交付
            // 能力的 1.25 倍（BBR 的探测增益 5/4 在 `tcp_bbr.c:164` 的 `bbr_pacing_gain[]`
            // 与 `:180` 的 `bbr_full_bw_thresh`——旧注释误引 :799，:788-799 讲的是 app-limited
            // 语义，本地核对记录见 `.cache/bench-20261006/industry-2/bbr-quic/findings.md` §A）。
            // 旧门 0.7 允许比值常年停在
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
            // 门（`capacity ≥ 0.8×kbps`）与这条帽（`kbps ≤ 1.25×capacity`）是同一个比的两侧，
            // 所以进入本分支后 `min(drift_cap)` 永不可能低于现有预算——升档分支天然只升不降，
            // 不需要额外的 `max(kbps)` 兜探测试值。（探测把 kbps 抬到包络之上也一样：能进
            // 这门就必有 drift_cap ≥ kbps。）
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

    /// RESET（弃掉未交付的积压）后的预算处置。`rtt_ms` 只用于 G3 之外的**传输层否决**：
    /// 与 `feedback` 的定罪豁免同一个函数，判据不许写两遍（AGENTS 规则 11.1）。
    /// 调用方拿不到 RTT 样本时传 0 = 不豁免（保守，等同旧行为）。
    pub fn discard(&mut self, now: u64, loss_pm: i64, rtt_ms: i64) {
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
        // G2 的水位连拍同样跨 RESET 无效：新链还没收到任何 ACK，不该背着旧链的计数砍。
        self.deep_streak = 0;
        self.plateau = None;
        // ACK 停更 / 丢包 ≥10‰ 这两条照旧即时减码率（背压失效时不减会无限重发大 IDR）。
        // 🔴 第三条（`backlog > 降速线`）现在要过传输层否决——RESET 之后第一拍的水位
        // 常常是旧链残留 + 本机开销，网络否认排队时减它治不了病只会糊画面（§10 现场：
        // 锁屏把采集圈卡住 8.7s，本端积压 6813ms，而链路 rtt 一直是 20–40ms、零丢包）。
        let deep_backlog =
            self.backlog_ms > self.backlog_down_ms() && !transport_clear(rtt_ms, loss_pm);
        if ack_blind || loss_pm >= 10 || deep_backlog {
            self.kbps = ((self.kbps as u64 * 7 / 10) as u32).max(MIN_KBPS);
            // G3：刚减过，后面几拍必须拿到新证据才许再减。
            self.post_cut_wait = POST_CUT_WAIT_TICKS;
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
        let deadline = if self.backlog_ms > self.backlog_down_ms() { base } else {
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
        format!("pending={} bytes={} oldest={}ms deadline={}ms rtt={}ms budget={}kbps delivered={}kbps ack={} feedback_age={:?} media_ack={:?}ms queue={}ms backlog={}ms peer_queue={}ms capacity={}kbps app_limited={} demand_limited={} probe={:?} tx_work={}ms",
            self.pending.len(), self.pending_bytes, age, self.ack_deadline_ms(rtt, now), rtt, self.kbps,
            self.delivered_kbps,
            self.ack_at_ms, self.last_feedback_ms.map(|t| now.saturating_sub(t)), self.ack_delay_ms, self.queue_ms, self.backlog_ms, self.peer_queue_ms, self.capacity_kbps, self.app_limited, self.demand_limited, self.probe_at_ms, self.tx_work_ms)
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

    /// 文字优先（2026-10-06 复测 B 拍板）：中继/低预算**不降分辨率**，省码率
    /// 只走 fps 阶梯与码率缩放。960/1280 降采样档已拆除——960×540 上 1080p 屏
    /// 文字不可读，用户原话「不然文字看不清楚」；恒返 0（不限宽）。
    pub fn resolution_limit(&self) -> u32 { 0 }
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
