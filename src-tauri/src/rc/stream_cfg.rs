//! 推流参数（画质档 / 截取范围 / 强制 JPEG）与心跳活性。
//!
//! 为什么单独一个模块：三个 `set_stream_*` 全是**纯校验 + 写字段**，但原先挂在
//! `RcService` 上——而那个类型持有 DataStore、iroh endpoint 和一堆锁，构造不出来，
//! 于是 `set_scope` 的四条分支**一条测试都没有**。采集范围是隐私面（对端能改你
//! 的画面范围），没有守门测试说不过去。搬到这里之后这些分支可以直接断言。
//!
//! **时间不进这个模块**：`touch_activity` / `should_pause` 的「现在」由调用方传入，
//! 暂停判定因此可以用假时钟精确断言，不必 sleep 或依赖机器负载。

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

use super::service::{CFG_CAPTURE_SCOPE, CFG_CODEC, CFG_QUALITY};

/// Q5：码率倍率的**默认值 = 最高档 200**（2026-10-02 用户拍板）。
///
/// 语义是「先给最好的」：健康链路上直接按 2× 基准码率跑（清晰优先）；
/// 弱网由 auto 缩放（RTT/丢包/带宽/队列四路判据）**乘法**压回去——
/// 用户 200% × auto 40% = 80%，弱网保护不被「尽量清晰」绕过。
/// 用户在会话 UI 显式选别的档会写配置，那才是他的真实意愿；
/// 未配置（新装 / 从没动过下拉）一律按 200 起步。
pub const DEFAULT_USER_BITRATE_PCT: u32 = 200;

/// 心跳超时：超过这么久没有输入/心跳 ⇒ 暂停推流。
const HEARTBEAT_TIMEOUT_MS: i64 = 3_500;

/// Q3：本会话的编码标准。auto = 硬编 H.264（不可用 JPEG 兜底）；
/// jpeg = 强制 JPEG（解码端兜底）；hevc = 硬编 HEVC（打不开自动回落 H.264，
/// 再 JPEG——见 `H264SessionEncoder::on_open_fail`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StreamCodec {
    Auto,
    ForceJpeg,
    Hevc,
    /// AV1: advertised by peer caps; Mac uses SVT software encoding, Windows
    /// uses FF hardware candidates. Initialization failure falls back to AVC.
    Av1,
}

/// 会话中可被发起端改的推流参数。
///
/// 字段是 `pub(super)` 而不是私有：取流的两条循环（`spawn_outbound_video` /
/// `spawn_inbound_video`）要直接读 `monitor` / `virtual_screen` / `codec`
/// 来决定抓哪块屏、走哪条编码路径。给它们加访问器只会让那两段代码更长。
#[derive(Debug, Clone, Copy)]
pub(super) struct StreamOpts {
    pub(super) profile: super::video::EncodeProfile,
    pub(super) virtual_screen: bool,
    /// >=0 抓指定显示器；-1 跟随 virtual_screen。
    pub(super) monitor: i32,
    /// Q3：本会话编码标准（原 force_jpeg: bool）。
    pub(super) codec: StreamCodec,
}

impl StreamOpts {
    /// 强制 JPEG 路径（解码端解不出硬编码时的兜底）。
    pub(super) fn force_jpeg(&self) -> bool {
        self.codec == StreamCodec::ForceJpeg
    }
}

impl Default for StreamOpts {
    fn default() -> Self {
        Self {
            profile: super::video::EncodeProfile::default(),
            virtual_screen: true,
            monitor: -1,
            codec: StreamCodec::Auto,
        }
    }
}

/// 推流参数 + 心跳/RTT 活性状态。字段私有，只能走下面这些口子。
pub(super) struct StreamCfg {
    opts: Mutex<StreamOpts>,
    /// 被控端：最近一次收到发起端输入/心跳的时间（0 = 尚未收到）。
    last_activity_ms: AtomicI64,
    /// 发起端最近一次测得的 RTT（毫秒）；0 = 尚未测到。
    last_rtt_ms: AtomicI64,
    /// 发起端上报的 RTT（NetHint）；被控端据此缩 H.264 码率。0 = 尚未收到。
    peer_rtt_ms: AtomicI64,
    /// 被控端**本端** QUIC stats 采样：最近 RTT（ms）。0 = 尚未采样。
    path_rtt_ms: AtomicI64,
    /// 被控端本端丢包率（‰，指数平滑）。0 = 尚未采样（未采样不缩码率）。
    path_loss_permille: AtomicI64,
    /// P3.2：QUIC 拥塞窗口推算的链路带宽估计（kbps，EMA）。0 = 尚未采样。
    /// 采样自**发视频的同一连接**的 PathStats.cwnd / rtt——BBR 下 cwnd/rtt
    /// 就是它的带宽估计，比 RTT 代理指标诚实得多。
    path_bw_kbps: AtomicI64,
    /// 发起端设置的「码率倍率」（Q5，50–200，100 = 跟随链路）。
    /// 与 RTT/丢包自动缩放相乘：用户调的是天花板，弱网保护仍然有效。
    user_bitrate_pct: AtomicI64,
    /// 本场会话是否已收到过发起端的码率/链路信息（`SetBitratePct` 或
    /// `NetHint` 任一到达即置位，会话建立时复位）。
    ///
    /// 🔴 为什么需要（2026-10-03）：被控端起播要先开硬编，而发起端的倍率是
    /// 会话建立后约 0.9s 才推到的。少了这个信号，起播宽限就只能按固定时长
    /// 空等；有它就能「倍率一到就开、不到就等到期」——LAN 上几乎零等待，
    /// 慢网上也有上界。见 `inbound/video.rs` 的起播宽限闸。
    peer_net_seen: AtomicBool,
    /// 时钟偏差（被控端时钟 − 发起端时钟，ms，EMA）。发起端由 pong 回包里的
    /// `hts` 估算；「画面延迟」= 本地时刻 − (帧采集时刻 − 偏差)。0 = 未校准。
    clock_skew_ms: AtomicI64,
    /// skew 样本过滤用的历史最小 RTT（0 = 尚无样本）。见 [`StreamCfg::note_clock_skew`]。
    skew_min_rtt_ms: AtomicI64,
    /// RTT / skew 连续拒绝数（重锚判据，见 [`StreamCfg::note_clock_skew`]）。
    skew_rej_streak: AtomicI64,
    /// 发起端帧龄 EMA（NetHint `queue_ms`，2026-09-28）——AP 队列的 in-band 观测。
    /// 存的是**平滑后**的值（升 α=1/2 / 降 α=1/2，见 [`StreamCfg::set_peer_queue_ms`]）；
    /// **0 = 已排空的确凿样本**，「尚未收到」由 `peer_queue_seen` 表示（2026-10-06 A-甲
    /// 之前这里是「0 = 未收到」，于是排空样本被丢弃、整个槽只升不降）。
    peer_queue_ms: AtomicI64,
    /// 帧粒度丢包反馈（NetHint `frame_loss_pm`，permille，非对称 EMA）。0 = 尚未收到。
    /// 与本端 conn 级丢包取 max 后喂码控与 RS 冗余——WiFi 丢包按突发砸帧，
    /// 帧粒度信号比 conn 包级更贴近接收端的真实观感。
    peer_loss_hint_pm: AtomicI64,
    /// 会话 RTT 下限（ms，2026-10-05 中继实测）。只有「安静样本」会写入：
    /// 收到过帧龄上报、帧龄 ≤90ms（码率缩放的全速带）、丢包 <10‰。
    /// 中继 ~600ms 这类**传播延迟**会沉成下限，RTT 类判据从此只看
    /// 「超额延迟 = 当前 RTT − 下限」，慢而宽的链路不再被当成拥塞砍码率/降档。
    /// 0 = 尚未建立（超额按绝对 RTT 走，行为等同旧版，保守）。
    rtt_floor_ms: AtomicI64,
    /// 本场会话是否收到过帧龄（排队）上报——下限跟踪器要求该信号在线，
    /// 起播阶段与不上报队列的旧对端都不能定安静样本。
    peer_queue_seen: AtomicBool,
    /// 「自动」档状态（2A）：enabled 时推流循环每帧喂字节数，由 [`StreamCfg::auto_note_frame`]
    /// 决定是否换档（换档 = 直接改 `opts.profile`，推流循环下一圈自己比对套用）。
    auto: Mutex<AutoTier>,
}

/// RTT → 码率缩放百分比（25–100）。局域网 <50ms 全速；跨网逐步砍。
/// 🔴 2026-10-05 起调用方喂的是**超额延迟**（RTT − 会话下限），语义从
/// 「走得慢」改成「排队了」：中继 ~600ms 传播延迟不再被当成拥塞。
pub fn bitrate_scale_for_rtt(rtt_ms: i64) -> u32 {
    match rtt_ms.max(0) {
        0..=49 => 100,
        50..=99 => 80,
        100..=199 => 60,
        200..=399 => 40,
        _ => 25,
    }
}

/// 会话 RTT 下限的**纯更新函数**（守卫单测直喂样本）。安静样本判据：
/// 收到过帧龄上报（`queue_reported`，旧对端不发则下限永不建立、退回绝对 RTT）、
/// 帧龄 ≤90ms（`bitrate_scale_for_queue` 的全速带）、丢包 <10‰。
/// 低于下限直接取新值（换路径/真改善要立刻生效）；高于下限每次只收敛 1/4
/// （LAN→中继这类迁移不能拿一两个样本重锚，否则拥塞尖峰会把下限抬上去、
/// 超额延迟判据就此失明）。非安静样本一律不动下限。
pub(crate) fn next_rtt_floor(
    floor: i64,
    sample_ms: i64,
    queue_reported: bool,
    queue_ms: i64,
    loss_pm: i64,
) -> i64 {
    if sample_ms <= 0 || !queue_reported || loss_pm >= 10 || queue_ms > 90 {
        return floor;
    }
    if floor <= 0 || sample_ms < floor {
        sample_ms
    } else {
        floor + (sample_ms - floor) / 4
    }
}

/// 视频数据报是否**允许**使用（纯函数，2026-10-02 公网联调两次实测收口）。
///
/// 🔴 依据一（18:15 会话，直连）：桌面把上千帧全部走数据报发出、本地零丢弃，
/// 对端重组器却一帧都凑不齐；同连接可靠流 pong 正常——数据报在公网路径近乎
/// 全丢。依据二（19:05 会话，绕中继）：iroh 在**中继路径**上 `conn.rtt()`
/// 恒为 0，按 RTT 降级的判据在最需要它的路径上失明，视频数据报灌爆桌面↔
/// 中继连接的拥塞窗口，把 pong / 控制帧 / JPEG 流全部堵死，最终写流卡死断会。
///
/// 因此**默认可靠流，采样到且够快才切数据报**：`rtt_ms <= 0`（未采样，含
/// 全部中继路径）不允许；RTT <300ms 且丢包 <150‰ 才放行。会话内允许
/// 数据报→可靠流单向降级（调用方负责），可靠流→数据报只在采样首次达标
/// 时进一次（局域网开场 ~1s 内完成，代价可忽略）。
pub fn video_dgram_allowed(rtt_ms: i64, loss_permille: i64) -> bool {
    rtt_ms > 0 && rtt_ms < 300 && loss_permille < 150
}

/// NetHint 档位判定（2026-09-27 重做，纯函数，守卫测试见 tests.rs）。
///
/// 返回 `(新档位, 是否应发 NetHint)`。档位 0/1/2 粗分链路质量
/// （≈ RTT <100 / <200 / ≥200），**只在档位变化时才发 NetHint**。
///
/// 🔴 为什么不能拿瞬时 RTT 直接判定（旧实现「±40ms 或跨 100/200 就发」）：
/// 拖动窗口时被控端 CPU 紧张，pong 处理被排队，RTT 出现 300~1200ms 的
/// **瞬时尖刺**（内网空闲实测 6~17ms）——旧判据几乎每个尖刺都发一次
/// NetHint，被控端码率缩放就在 25%/40%/60% 之间来回跳，每过一次 15pp
/// 迟滞就全链重开一次编码器（~1s 停顿，实测把「编码均值」抬到 218ms、
/// 帧率钉死在 7fps）。EMA 平滑归调用方；本函数只做**档位滞回**：
/// 升档需越过边界 +40%，降档需低于边界 −20%，边界附近不抖。
pub(crate) fn rtt_hint_tier(prev: u8, ema_ms: i64) -> (u8, bool) {
    let next = match prev {
        0 => {
            if ema_ms >= 140 {
                1
            } else {
                0
            }
        }
        1 => {
            if ema_ms >= 280 {
                2
            } else if ema_ms < 80 {
                0
            } else {
                1
            }
        }
        _ => {
            if ema_ms < 160 {
                1
            } else {
                2
            }
        }
    };
    (next, next != prev)
}

/// P3.2：带宽估计（kbps）→ 码率缩放百分比。与 RTT/丢包缩取 min——
/// 三条弱网信号（延迟高 / 丢包多 / 带宽窄）谁更糟听谁的。0 = 未采样不约束。
/// 分档参考：1080p 基准码率 ~4Mbps，估计值低于它的 1.5 倍就该缩。
pub fn bitrate_scale_for_bw(kbps: i64) -> u32 {
    match kbps.max(0) {
        0 => 100,
        0..=2_499 => 25,
        2_500..=5_999 => 50,
        6_000..=14_999 => 75,
        _ => 100,
    }
}

/// 排队压力（发起端帧龄 EMA，ms）→ 码率缩放百分比（2026-09-28）。
///
/// 为什么需要它：WiFi 的 AP 队列**只挡大帧不挡小 ping**——pong RTT 看着 10ms、
/// 视频帧却排了 200ms（真机实测：拖动中 RTT EMA ~30ms、帧龄 300ms+）。帧龄里
/// 扣掉采集/编码剩下的就是「发出去之前的排队 + 路上」——这是 sender 侧唯一
/// 能看见 AP 队列的信号（RustDesk `video_qos.rs` 同款思路：in-band 探测）。
/// 负值/未采样（≤0）不约束。分档约等于「排队帧数 ×16ms」：
/// 90ms≈6 帧、180ms≈11 帧、300ms≈19 帧。
pub fn bitrate_scale_for_queue(queue_ms: i64) -> u32 {
    match queue_ms.max(0) {
        0 => 100,
        1..=90 => 100,
        91..=180 => 70,
        181..=300 => 45,
        301..=500 => 25,
        _ => 15,
    }
}

/// 丢包率（‰）→ 码率缩放百分比。与 RTT 缩放取 min 后生效——
/// 两条弱网信号（延迟高 / 丢包多）谁更糟听谁的。
pub fn bitrate_scale_for_loss(permille: u64) -> u32 {
    match permille {
        0..=9 => 100,
        10..=19 => 80,
        20..=49 => 60,
        50..=99 => 40,
        _ => 25,
    }
}

// 画质「自动」档的判据与状态在 `auto_quality.rs`（2A）。这里只做存放与喂帧。

use super::auto_quality::{auto_decide, auto_ladder, ladder_index_of, AutoTier, LinkSample, FRAME_WINDOW};

impl StreamCfg {
    pub(super) fn media_ceiling_kbps(&self) -> u32 {
        // 保留画质档与用户倍率的上限意图，实际预算仍由交付闭环决定。
        let width = self.opts.lock().unwrap_or_else(|p| p.into_inner()).profile.max_w;
        let base = match width { 0..=1280 => 4_000, 1281..=1920 => 8_000, _ => 12_000 };
        let pct = self.user_bitrate_pct.load(Ordering::Relaxed).clamp(50, 200) as u32;
        (base * pct / 100).min(16_000)
    }
    pub(super) fn new() -> Self {
        Self {
            opts: Mutex::new(StreamOpts::default()),
            last_activity_ms: AtomicI64::new(0),
            last_rtt_ms: AtomicI64::new(0),
            peer_rtt_ms: AtomicI64::new(0),
            path_rtt_ms: AtomicI64::new(0),
            path_loss_permille: AtomicI64::new(0),
            path_bw_kbps: AtomicI64::new(0),
            user_bitrate_pct: AtomicI64::new(DEFAULT_USER_BITRATE_PCT as i64),
            peer_net_seen: AtomicBool::new(false),
            clock_skew_ms: AtomicI64::new(0),
            skew_min_rtt_ms: AtomicI64::new(0),
            skew_rej_streak: AtomicI64::new(0),
            peer_queue_ms: AtomicI64::new(0),
            peer_loss_hint_pm: AtomicI64::new(0),
            rtt_floor_ms: AtomicI64::new(0),
            peer_queue_seen: AtomicBool::new(false),
            auto: Mutex::new(AutoTier::off()),
        }
    }

    pub(super) fn note_rtt(&self, rtt_ms: i64) {
        self.last_rtt_ms.store(rtt_ms.max(0), Ordering::Relaxed);
    }

    pub(super) fn rtt_ms(&self) -> i64 {
        self.last_rtt_ms.load(Ordering::Relaxed)
    }

    /// 视频传输路选择用的「当前 RTT」：对端上报优先（发起端 ping 测的更稳），
    /// 没有就用本端 QUIC stats 采样。0 = 尚无样本。与 [`Self::bitrate_scale`]
    /// 里那份取值是同一口径，收口在这里避免两处漂移。
    pub(super) fn video_rtt_ms(&self) -> i64 {
        let peer = self.peer_rtt_ms.load(Ordering::Relaxed);
        if peer > 0 {
            peer
        } else {
            self.path_rtt_ms.load(Ordering::Relaxed)
        }
    }

    /// 测试探针：读回平滑后的排队压力槽（口径见 [`Self::set_peer_queue_ms`]）。
    #[cfg(test)]
    pub(super) fn peer_queue_ms_for_test(&self) -> i64 {
        self.peer_queue_ms.load(Ordering::Relaxed)
    }

    /// 被控端：记录对端上报的 RTT，并给出当前码率缩放（%）。
    pub(super) fn set_peer_rtt(&self, rtt_ms: i64) -> u32 {
        let v = rtt_ms.max(0);
        self.peer_rtt_ms.store(v, Ordering::Relaxed);
        // 链路信息到了同样算「对端已发言」——倍率可能走单独的 SetBitratePct，
        // 但先到的这个信号已足够结束起播宽限（见 `peer_net_seen` 字段注释）。
        self.peer_net_seen.store(true, Ordering::Relaxed);
        self.track_rtt_floor(v);
        self.bitrate_scale()
    }

    /// 用当前排队/丢包上下文把一个 RTT 样本喂进下限跟踪器。
    /// 🔴 调用顺序要求：NetHint 必须**先**更新帧龄与丢包**再**进来
    /// （inbound.rs 已按此重排），否则风暴起步的那一拍会拿上一拍的旧队列
    /// 把拥塞样本误判成安静样本、把下限抬进坑里。
    fn track_rtt_floor(&self, sample_ms: i64) {
        let floor = self.rtt_floor_ms.load(Ordering::Relaxed);
        let next = next_rtt_floor(
            floor,
            sample_ms,
            self.peer_queue_seen.load(Ordering::Relaxed),
            self.peer_queue_ms.load(Ordering::Relaxed),
            self.loss_permille(),
        );
        if next != floor {
            self.rtt_floor_ms.store(next, Ordering::Relaxed);
        }
    }

    /// 超额延迟（ms）= 当前 RTT − 会话下限。下限未建立（旧对端/起播前）
    /// 时等于绝对 RTT——保守，等同旧行为；中继上几拍内下限沉到 ~600ms 后，
    /// RTT 类判据就只对「比本场安静时刻更慢」的排队负责。
    pub(super) fn excess_rtt_ms(&self) -> i64 {
        let rtt = self.video_rtt_ms();
        let floor = self.rtt_floor_ms.load(Ordering::Relaxed);
        if floor <= 0 || rtt <= 0 {
            rtt
        } else {
            (rtt - floor).max(0)
        }
    }

    /// 本场会话是否已收到过对端码率/链路信息（起播宽限提前收闸用）。
    pub(super) fn peer_net_seen(&self) -> bool {
        self.peer_net_seen.load(Ordering::Relaxed)
    }

    pub(super) fn bitrate_scale(&self) -> u32 {
        let rtt = self.video_rtt_ms();
        let loss = self.loss_permille_u64();
        let bw = self.path_bw_kbps.load(Ordering::Relaxed);
        let queue = self.peer_queue_ms.load(Ordering::Relaxed);
        // RTT 路吃**超额延迟**：中继 ~600ms 固有传播不该砍码率（2026-10-05
        // 实测被 40% 档误伤）；真排队时超额照涨，保护不失效。其余三路本来就是
        // 「谁糟听谁」的拥塞直读，维持绝对值。
        let auto = bitrate_scale_for_rtt(self.excess_rtt_ms())
            .min(bitrate_scale_for_loss(loss))
            .min(bitrate_scale_for_bw(bw))
            .min(bitrate_scale_for_queue(queue));
        // 🔴 雪崩硬保护（2026-10-03）：帧龄 EMA 破秒 = 队列在单调积累（08:22
        // 真机会话帧龄一路涨到 46s）。这时再乘用户倍率会把 15% 抬回 30%
        // （200% 倍率），队列永不排干——熔断/降档的底线不该被「清晰优先」
        // 乘回去。破秒后码控只听链路的，倍率暂停参与。
        if queue > 1000 {
            return auto;
        }
        // Q5：用户倍率与之**相乘**（50–200，100 = 不干预）。乘法而非 min：
        // 弱网把 auto 砍到 40% 时，用户 200% 得到 80%——仍受保护但确实变清晰；
        // 若取 min，200% 在弱网下毫无意义。clamp 防退化（两端乘积域 12.5–200）。
        let user = self.user_bitrate_pct.load(Ordering::Relaxed).clamp(50, 200) as u32;
        let scaled = ((auto * user) / 100).clamp(10, 300);
        // 未收到有效 RTT 前先保守起播，用户倍率不能放大未知链路。
        crate::rc::media::scale_for_path(scaled, rtt, false)
    }

    /// 发起端设置码率倍率（Q5）。范围外拒绝——UI 滑条/下拉只出 50–200，
    /// 越界值说明对端有 bug 或被篡改，静默 clamp 会掩盖问题。
    pub(super) fn set_user_bitrate_pct(&self, pct: u32) -> Result<(), String> {
        if !(50..=200).contains(&pct) {
            return Err(format!("码率倍率只能是 50–200 的整数，得到 {pct}"));
        }
        self.user_bitrate_pct
            .store(pct as i64, Ordering::Relaxed);
        // 倍率偏好到了 = 起播宽限可以收了（见 `peer_net_seen` 字段注释）
        self.peer_net_seen.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// 被控端：QUIC stats 采样器（推流任务）每 500ms 喂一次本端链路状况。
    /// `loss_permille < 0` = 本窗口没有发包，不更新丢包（保留旧值）。
    pub(super) fn note_stream_health(&self, rtt_ms: i64, loss_permille: i64, bw_kbps: i64) {
        if rtt_ms > 0 {
            self.path_rtt_ms.store(rtt_ms, Ordering::Relaxed);
        }
        if loss_permille >= 0 {
            self.path_loss_permille
                .store(loss_permille.min(1000), Ordering::Relaxed);
        }
        if bw_kbps > 0 {
            // EMA（α=3/10）：单拍抖动别直接打到码控上
            let prev = self.path_bw_kbps.load(Ordering::Relaxed);
            let next = if prev == 0 {
                bw_kbps
            } else {
                (prev * 7 + bw_kbps * 3) / 10
            };
            self.path_bw_kbps.store(next, Ordering::Relaxed);
        }
    }

    /// 自动档判定用的当前丢包率（‰）。
    pub(super) fn loss_permille(&self) -> i64 {
        let own = self.path_loss_permille.load(Ordering::Relaxed).max(0);
        // 2026-09-28：帧粒度反馈（发起端实测「这批帧丢了多少」）与本端 conn 级
        // 丢包取 max——两把尺子谁量出来的更糟就信谁。conn 统计含流/心跳包，
        // 可能低估视频路径；帧反馈只统计视频帧，但窗口小会抖——互补。
        let hint = self.peer_loss_hint_pm.load(Ordering::Relaxed).max(0);
        own.max(hint)
    }

    /// 内部：丢包率（‰，无符号视图，码率缩放用）。
    fn loss_permille_u64(&self) -> u64 {
        self.loss_permille() as u64
    }

    /// 排队压力（ms）有两个来源，都写这一个槽：发起端 NetHint 携带的**帧龄 EMA**，
    /// 以及本端控制器每拍喂的**线上积压**（`media_control::apply_media_feedback` 里的
    /// `flow.backlog_ms`——注释早就写明它要「覆盖旧 NetHint 帧龄口径」）。
    ///
    /// 🔴 A-甲（2026-10-06）：**0 是「已经排空」的确凿样本，不是「无样本」**。旧写法
    /// `if queue_ms <= 0 { return; }` 把排空样本整条丢掉，这个槽因此**只能升不能降**：
    /// 本端积压明明已经是 0，槽里仍留着对端上一次上报的 1100ms 帧龄 ⇒
    /// `bitrate_scale_for_queue` 停在 60%/40%、`auto_quality` 的 `queue ≥ 300` 持续定罪。
    /// 实测形态：v6 直连 `rtt 17–57ms / loss 0pm / backlog 0ms` 却钉在 balanced 不升档
    /// （`docs/链路切换画质回升-业界源码对照-2026-10-06.md` §10）。
    /// 「无样本」的哨兵本来就是**负值**（`probe_out::age_ema_ms()` 未采到返回 -1，
    /// NetHint 的 `queue_ms` 是 `Option`），这里跟着收成 `< 0` 才丢——同一个语义
    /// 写两套哨兵（0 与 -1）正是它烂掉的原因（AGENTS 规则 11.1）。
    ///
    /// 平滑仍只做轻度（升 α=1/2 / 降 α=1/2）：两层慢速平滑叠加的等效恢复时间是几十秒
    /// （真机复盘 2026-09-28：一次 13s 停顿把码率钉死在 15% 半分钟），码率会糊成马赛克
    /// 还不回升。播种与否看 `peer_queue_seen`，不看槽值——0 现在是合法值。
    pub(super) fn set_peer_queue_ms(&self, queue_ms: i64) {
        if queue_ms < 0 {
            return;
        }
        let prev = self.peer_queue_ms.load(Ordering::Relaxed);
        let next = if self.peer_queue_seen.load(Ordering::Relaxed) {
            (prev + queue_ms) / 2
        } else {
            queue_ms
        };
        self.peer_queue_ms.store(next, Ordering::Relaxed);
        self.peer_queue_seen.store(true, Ordering::Relaxed);
    }

    /// 发起端 NetHint 携带的帧粒度丢包率（permille）。非对称 EMA 同上。
    pub(super) fn note_peer_frame_loss(&self, permille: i64) {
        if permille <= 0 {
            return;
        }
        let prev = self.peer_loss_hint_pm.load(Ordering::Relaxed);
        let next = if prev <= 0 {
            permille
        } else if permille > prev {
            (prev + permille) / 2
        } else {
            (prev * 7 + permille) / 8
        };
        self.peer_loss_hint_pm.store(next, Ordering::Relaxed);
    }

    /// 发起端：由 pong 估算的时钟偏差样本（被控端时钟 − 本机时钟，ms）。
    ///
    /// 口径：host 在收到 ping 的时刻打 `hts`，pong 到达本地为 `t1`，
    /// 往返 rtt 已知 ⇒ 偏差样本 = `hts − (t1 − rtt/2)`（网络对称假设）。
    /// 单样本带 ±rtt/2 抖动，做 EMA 并剔除离群（网络突刺/排队会让样本瞬间飞）；
    /// 换台对端偏差完全不同，所以会话建立时清零。
    ///
    /// 🔴 2026-09-27 重做（内网高 RTT 下「画面延迟」全是假象）：旧门槛
    ///   `rtt > 300ms 一律不收`在持续高 RTT 的内网里**一个样本都收不进**
    /// （实测往返 ~560ms ⇒ 全程未校准），而隔离内网没有 NTP，两机时钟差
    /// 可以漂到秒级——HUD 的「画面龄 2113ms / 网络段 1885ms」主要是这个
    /// 未校准的时钟差，不是真延迟。改为 **NTP 式 min-RTT 过滤**：
    /// ① 只信「接近历史最快」的往返样本（排队只往样本里加正偏置，历史
    ///   最小 RTT 最接近纯传播时间）；
    /// ② 已建立 EMA 后剔除离群（连续拒绝过多则重锚——初始锚可能歪，
    ///   隔离内网的时钟也在漂）。
    pub(super) fn note_clock_skew(&self, sample_ms: i64, rtt_ms: i64) {
        if rtt_ms <= 0 {
            return;
        }
        const RTT_WINDOW_MS: i64 = 100;
        const REJECT_MS: u64 = 150;
        let prev_min = self.skew_min_rtt_ms.load(Ordering::Relaxed);
        if prev_min == 0 || rtt_ms < prev_min {
            self.skew_min_rtt_ms.store(rtt_ms, Ordering::Relaxed);
        }
        let min = self.skew_min_rtt_ms.load(Ordering::Relaxed);
        if rtt_ms > min + RTT_WINDOW_MS {
            // 路径可能已从直连切到中继。只在 skew 离群分支计数，会让
            // 更慢路径的全部样本永远进不来，旧的错误时钟偏差也永远不变。
            self.reject_clock_sample();
            return;
        }
        let prev = self.clock_skew_ms.load(Ordering::Relaxed);
        if prev != 0 && sample_ms.abs_diff(prev) > REJECT_MS {
            // 离群。连续拒绝过多说明锚点本身不可信（首锚误差大 / 时钟漂移），
            // 丢锚重来——否则坏锚永远无法被修正。
            self.reject_clock_sample();
            return;
        }
        self.skew_rej_streak.store(0, Ordering::Relaxed);
        let next = if prev == 0 {
            sample_ms
        } else {
            (prev * 7 + sample_ms * 3) / 10
        };
        self.clock_skew_ms.store(next, Ordering::Relaxed);
    }

    fn reject_clock_sample(&self) {
        if self.skew_rej_streak.fetch_add(1, Ordering::Relaxed) + 1 >= 20 {
            self.clock_skew_ms.store(0, Ordering::Relaxed);
            self.skew_min_rtt_ms.store(0, Ordering::Relaxed);
            self.skew_rej_streak.store(0, Ordering::Relaxed);
        }
    }

    pub(super) fn clock_skew_ms(&self) -> i64 {
        self.clock_skew_ms.load(Ordering::Relaxed)
    }

    /// 会话建立时用本机配置初始化推流参数（画质与范围由调用方从配置解析好后传入）。
    ///
    /// `auto`：配置里画质档是不是「自动」。是则开启自动模式并从当前档起跑
    /// （"auto" 解析出的 profile 是 balanced，起跑档就是均衡）。
    /// `codec`（Q3）：本机配置的编码标准（CFG_CODEC：auto/jpeg/h264/hevc）。
    /// `h264_gpu`（2026-09-22）：硬编可用性——决定自动梯子是否含 fps60 天花板
    /// （caps 是 OnceLock 单例，一次会话内不变，tier 与梯子不会错位）。
    pub(super) fn reset_from_cfg(
        &self,
        profile: super::video::EncodeProfile,
        virtual_screen: bool,
        auto: bool,
        codec: StreamCodec,
        h264_gpu: bool,
    ) {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        g.profile = profile;
        g.virtual_screen = virtual_screen;
        g.monitor = -1;
        g.codec = codec;
        self.peer_rtt_ms.store(0, Ordering::Relaxed);
        // Q5：码率倍率回归默认（200，见 [`DEFAULT_USER_BITRATE_PCT`]）。
        // 发起端的偏好由它在会话建立后**无条件**推送（outbound.rs 启动即发
        // SetBitratePct），被控端不该继承上一场会话留下的旧值——那可能是
        // 另一台设备设的。推送是常态，这里的初值只在推送到达前生效一瞬。
        self.user_bitrate_pct
            .store(DEFAULT_USER_BITRATE_PCT as i64, Ordering::Relaxed);
        // P0-1 B6：路径统计（本端 RTT / 丢包）是**上一场会话**的采样残留，
        // 新会话第一拍采样到来之前不该拿旧值缩码率、判链路好坏。
        self.path_rtt_ms.store(0, Ordering::Relaxed);
        self.path_loss_permille.store(0, Ordering::Relaxed);
        self.path_bw_kbps.store(0, Ordering::Relaxed);
        self.peer_queue_ms.store(0, Ordering::Relaxed);
        self.peer_loss_hint_pm.store(0, Ordering::Relaxed);
        // RTT 下限与会话同生命周期：换台/换路径（LAN↔中继）最小 RTT 完全不同。
        self.rtt_floor_ms.store(0, Ordering::Relaxed);
        self.peer_queue_seen.store(false, Ordering::Relaxed);
        // 「对端已发言」是**本场会话**的信号：换场必须清零，否则新会话的
        // 起播宽限会被上一场的残留立刻收闸，倍率又开错。
        self.peer_net_seen.store(false, Ordering::Relaxed);
        self.clock_skew_ms.store(0, Ordering::Relaxed);
        // skew 过滤状态与会话同生命周期：换台对端 min-RTT 完全不同。
        self.skew_min_rtt_ms.store(0, Ordering::Relaxed);
        self.skew_rej_streak.store(0, Ordering::Relaxed);
        let mut a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
        a.enabled = auto;
        a.has_gpu = h264_gpu;
        a.tier = ladder_index_of(&profile, h264_gpu).unwrap_or(1);
        a.last_change_ms = 0;
        a.high_since = None;
        a.low_since = None;
        a.recent.clear();
        a.diag.clear();
    }

    /// 发起端在会话中改画质。
    ///
    /// "auto" = 打开被控端的自动换档（2A）；五档实名 = 锁定并关掉自动。
    pub(super) fn set_quality(&self, quality: &str) -> Result<(), String> {
        if quality == "auto" {
            // 从当前档起跑，别凭空跳回均衡——会话中开自动不该先抖一下画面。
            // 锁序不变量（见 auto_note_frame）：opts → auto 单向，先放 opts 再锁 auto。
            let cur_profile = {
                let g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
                g.profile
            };
            let mut a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
            a.tier = ladder_index_of(&cur_profile, a.has_gpu).unwrap_or(1);
            a.enabled = true;
            a.last_change_ms = 0;
            a.high_since = None;
            a.low_since = None;
            a.recent.clear();
            a.diag.clear();
            return Ok(());
        }
        if !matches!(
            quality,
            "uhd" | "uhd60" | "ultra" | "sharp" | "balanced" | "smooth" | "fps60" | "fps120"
                | "fps144" | "fps165"
        ) {
            return Err(
                "画质档只能是 auto / uhd / uhd60 / ultra / sharp / balanced / smooth / fps60 / fps120 / fps144 / fps165"
                    .into(),
            );
        }
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        g.profile = super::video::EncodeProfile::of_name(quality);
        // 实名档 = 用户（或发起端）明确锁定，自动让位
        self.auto.lock().unwrap_or_else(|p| p.into_inner()).enabled = false;
        Ok(())
    }

    /// 推流循环每帧喂一次 JPEG 字节数。自动档开启时据此（+ 对端 RTT）决定是否换档。
    ///
    /// 返回是否换了档（调用方只拿它做日志；真正的生效靠 `opts.profile` 被改掉后，
    /// 推流循环下一圈 `stream_opts_snapshot` 比对时自己套用——零新信令）。
    pub(super) fn auto_note_frame(&self, bytes: usize, now_ms: i64) -> bool {
        let mut a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
        if !a.enabled {
            return false;
        }
        a.recent.push(bytes);
        if a.recent.len() < FRAME_WINDOW {
            return false;
        }
        let avg: usize = a.recent.iter().sum::<usize>() / a.recent.len();
        a.recent.clear();
        // 与 bitrate_scale 同口径：peer 上报优先，旧对端不发 ping 时退本端
        // stats 采样——两套判据曾各看各的（码率在缩、自动档对链路一无所知）。
        let peer_rtt = self.peer_rtt_ms.load(Ordering::Relaxed);
        let rtt = if peer_rtt > 0 {
            peer_rtt
        } else {
            self.path_rtt_ms.load(Ordering::Relaxed)
        };
        // 2026-09-22：梯子动态化——has_gpu 决定天花板是否含 fps60（见 auto_ladder）。
        // has_gpu 在会话内不变（caps 单例），tier 与梯子不会错位。
        let ladder = auto_ladder(a.has_gpu);
        let down_bytes = super::video::EncodeProfile::of_name(ladder[a.tier]).adapt_down;
        let loss_pm = self.loss_permille().max(0);
        let excess = self.excess_rtt_ms();
        let queue = self.peer_queue_ms.load(Ordering::Relaxed);
        let queue_seen = self.peer_queue_seen.load(Ordering::Relaxed);
        let clear = super::media_flow::transport_clear(rtt, loss_pm);
        let (new_tier, high, low) = auto_decide(LinkSample {
            tier: a.tier,
            ladder_len: ladder.len(),
            down_bytes,
            rtt_ms: excess,
            // 超额为 0 = 「与本场安静时刻同级」的好读数，不是没测到（A-甲 孪生缺陷）。
            rtt_measured: rtt > 0,
            // 🔴 帧龄参与判档（2026-10-03），但**传输层清白时不再单独定罪**
            // （2026-10-06 A-乙，见 `auto_quality::AUTO_DOWN_QUEUE_MS` 注释）。
            queue_ms: queue,
            queue_measured: queue_seen,
            avg_bytes: avg,
            // 判据与 `Flow::feedback` 的定罪豁免**必须同源**（AGENTS 规则 11.1）：
            // 写两遍必漏一处，而这两处对同一个队列状态给出相反结论时，用户看到的
            // 就是「码率预算够、画面却糊在低档」。
            transport_clear: clear,
            loss_permille: loss_pm as u64,
            high_since: a.high_since,
            low_since: a.low_since,
            last_change_ms: a.last_change_ms,
            now_ms,
        });
        a.high_since = high;
        a.low_since = low;
        // 5s 汇总行读这份快照（`.cache` 复测里「为什么不升档」只能靠它自证）。
        // 每个判定窗（8 帧）重写一次，不在每帧格式化字符串。
        a.diag = format!(
            "近帧{}B(降档线{}B) 超额{}ms 帧龄{}ms{} 丢{}‰ 传输清白={} 好窗已{}",
            avg,
            down_bytes,
            excess,
            queue,
            if queue_seen { "" } else { "(未上报)" },
            loss_pm,
            clear,
            low.map_or(0, |s| now_ms - s)
        );
        let Some(t) = new_tier else {
            return false;
        };
        a.tier = t;
        a.last_change_ms = now_ms;
        let name = ladder[t];
        // 🔴 锁序：必须先放掉 `auto` 再取 `opts`。
        //    `set_quality` / `reset_from_cfg` 走的是 opts → auto，而本函数由
        //    **推流任务**调用（inbound.rs 每帧）、那两个由**输入读取任务**调用
        //    （inbound.rs 的 spawn_input_reader），两条链路真并发 ——
        //    同向取锁就是 ABBA 死锁（设计审查抓到的阻塞项）。
        drop(a);
        self.opts.lock().unwrap_or_else(|p| p.into_inner()).profile =
            super::video::EncodeProfile::of_name(name);
        log::info!(
            "[RC] 自动画质：链路 rtt={rtt}ms 超额={excess}ms 近帧均值 {avg}B 帧龄={queue}ms 传输清白={clear} → 切到「{name}」"
        );
        true
    }

    /// 自动档是否开启（status 组装用）。
    pub(super) fn auto_enabled(&self) -> bool {
        self.auto.lock().unwrap_or_else(|p| p.into_inner()).enabled
    }

    /// 自动档当前生效的档位名（仅 auto_enabled 时有意义）。
    pub(super) fn auto_tier_name(&self) -> String {
        let a = self.auto.lock().unwrap_or_else(|p| p.into_inner());
        let ladder = auto_ladder(a.has_gpu);
        // 🔴 tier 越界防御：has_gpu 理论上会话内不变，但 reset 竞态下 tier 可能
        // 短暂指向旧梯子的高位——取不到就退最低档，别 panic 在推流线程上。
        ladder.get(a.tier).unwrap_or(&ladder[0]).to_string()
    }

    /// 最近一次判档的输入快照（5s 汇总行用；未判过则空串）。
    pub(super) fn auto_diag(&self) -> String {
        self.auto
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .diag
            .clone()
    }

    /// 会话收尾：自动档状态整体复位。
    ///
    /// 不复位的话，会话结束后 `status()` 仍会报「生效档 = 流畅」这种**陈旧档位**：
    /// `enabled` 留在 true、`tier` 停在会话最后一档，而实际早就没有推流了。
    /// 复位成 `AutoTier::off()`（与新建时的初态单源），下一会话由
    /// `reset_from_cfg` 按配置重新点亮。
    pub(super) fn auto_reset(&self) {
        *self.auto.lock().unwrap_or_else(|p| p.into_inner()) = AutoTier::off();
    }

    /// 发起端在会话中改截取范围。
    pub(super) fn set_scope(&self, scope: &str) -> Result<(), String> {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        if scope == "virtual" {
            g.virtual_screen = true;
            g.monitor = -1;
            return Ok(());
        }
        if scope == "primary" {
            g.virtual_screen = false;
            g.monitor = -1;
            return Ok(());
        }
        if let Some(n) = scope.strip_prefix("monitor:") {
            let idx: i32 = n
                .parse()
                .map_err(|_| "显示器编号无效，应为 monitor:0 / monitor:1…")?;
            if idx < 0 {
                return Err("显示器编号不能为负".into());
            }
            g.virtual_screen = false;
            g.monitor = idx;
            return Ok(());
        }
        Err("截取范围只能是 virtual / primary / monitor:N".into())
    }

    /// 发起端：H.264 解不出时强制本会话走 JPEG；`codec=h264` 可再打开；
    /// Q3：`hevc` 切硬编 HEVC（打不开被控端自动回落 H.264）。
    pub(super) fn set_codec(&self, codec: &str) -> Result<(), String> {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        match codec {
            "jpeg" => {
                g.codec = StreamCodec::ForceJpeg;
                Ok(())
            }
            "h264" => {
                g.codec = StreamCodec::Auto;
                Ok(())
            }
            "hevc" => {
                g.codec = StreamCodec::Hevc;
                Ok(())
            }
            _ => Err("编码只能是 jpeg / h264 / hevc".into()),
        }
    }

    pub(super) fn snapshot(&self) -> StreamOpts {
        *self.opts.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn touch_activity(&self, now_ms: i64) {
        self.last_activity_ms.store(now_ms, Ordering::Relaxed);
    }

    /// 最近一次收到对端输入/心跳的时刻（epoch ms）；0 = 尚未收到。
    ///
    /// 🔴 P1-5：把**证据**给出去（`RcService::last_activity_ms`）。看门狗要判的是
    /// 「超过 15s」，`should_pause` 那个 3.5s 的布尔撑不起第二个判据——
    /// 让调用方自己再记一份时间就是两个数据源，迟早对不上。
    pub(super) fn last_activity_ms(&self) -> i64 {
        self.last_activity_ms.load(Ordering::Relaxed)
    }

    /// 是否应暂停推流：会话开始后长时间无心跳/输入。
    pub(super) fn should_pause(&self, now_ms: i64) -> bool {
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        if last == 0 {
            // 尚未收到任何输入：给发起端 5s 窗口发首个心跳
            return false;
        }
        now_ms - last > HEARTBEAT_TIMEOUT_MS
    }
}

/// 从配置里解析画质档。抽成自由函数是为了能直接单测默认值与非法值的回落。
///
/// 缺省 = "auto"（2A 起默认自动）；"auto" 本身解析成 balanced 的编码参数起跑，
/// 自动模式由 `reset_from_cfg` 的 `auto` 参数单独打开。
pub(super) fn profile_from_cfg(cfg: &serde_json::Value) -> super::video::EncodeProfile {
    super::video::EncodeProfile::of_name(
        cfg.get(CFG_QUALITY)
            .and_then(|v| v.as_str())
            .unwrap_or("auto"),
    )
}

/// 配置里的画质档是不是「自动」。
pub(super) fn auto_from_cfg(cfg: &serde_json::Value) -> bool {
    cfg.get(CFG_QUALITY)
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        == "auto"
}

/// 从配置里解析「是否抓整个虚拟屏」。只有显式 `primary` 才算否，其余（含缺省）都抓整屏。
pub(super) fn virtual_screen_from_cfg(cfg: &serde_json::Value) -> bool {
    cfg.get(CFG_CAPTURE_SCOPE)
        .and_then(|v| v.as_str())
        .map(|s| s != "primary")
        .unwrap_or(true)
}

/// Q3：配置里的编码标准 → 会话初值。`h264` 与 `auto` 同义（缺省）；
/// `hevc` 走硬编 HEVC（打不开被控端会话内自动回落 H.264）。
pub(super) fn codec_from_cfg(cfg: &serde_json::Value) -> StreamCodec {
    match cfg
        .get(CFG_CODEC)
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
    {
        "jpeg" => StreamCodec::ForceJpeg,
        "hevc" => StreamCodec::Hevc,
        "av1" => StreamCodec::Av1,
        _ => StreamCodec::Auto,
    }
}

#[cfg(test)]
mod tests;
