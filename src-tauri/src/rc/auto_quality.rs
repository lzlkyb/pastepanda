//! 画质「自动」档（2A，2026-09-18）：被控端会话内按对端 RTT + 近帧字节数，
//! 在 流畅/均衡/清晰/超清 之间带迟滞地自动换档。
//! 2026-09-19：判据加入**丢包率**（QUIC stats 采样）——丢包 ≥5% 视同链路差
//! 直接参与降档，≥2% 挡住升档。RTT 高说明慢，丢包多说明糊，两回事。
//!
//! 为什么单独一个模块：迟滞判据是一组**纯函数 + 纯状态**（时间由调用方传入，
//! 可无网络单测），而 `stream_cfg` 是推流参数的收口处。混在一起会把那个文件
//! 顶过 600 行红线，也让「判据」和「存放」两种职责挤在一处。
//!
//! ❗ 「原生」/ fps120+ 刻意不进自动阶梯：它们依赖 GPU 零拷贝，能否打开
//!    随机器与刷新率而定，不适合做自动目标。
//!
//! 2026-09-22：梯子纳入 **fps60**（硬编专属天花板）——但**动态**：只有
//! `h264_gpu` 可用的机器才追加。无硬编机器绝不能含 fps60：JPEG 全量截屏
//! 按 16ms 节拍跑是 CPU 灾难（每秒 60 次全屏抓取+编码），pace_scale 兜得住
//! 节奏兜不住白烧。所以梯子不再是常量，`tier` 下标的语义跟随
//! [`auto_ladder`] 的返回值，AutoTier 里必须存 `has_gpu`。
//!
//! 换档如何生效：[`StreamCfg::auto_note_frame`]（见 `stream_cfg.rs`）判定要换档时
//! 直接改写 `opts.profile`——推流循环每圈都会 `stream_opts_snapshot()` 比对并套用，
//! **零新信令**；会话中的 `SetQuality { quality: "auto" }` 也走同一条路。

/// 基础梯（JPEG 路径口径，低 → 高）。下标即 `AutoTier::tier`。
const BASE_LADDER: [&str; 4] = ["smooth", "balanced", "sharp", "ultra"];

/// 会话的实际自动梯子（低 → 高）：基础梯 + 硬编可用时的 fps60 天花板。
/// `tier` 下标语义跟着返回值走——**同一会话内 has_gpu 不变**（caps 是
/// OnceLock 单例），所以 tier 与梯子不会错位。
pub(super) fn auto_ladder(has_gpu: bool) -> Vec<&'static str> {
    if has_gpu {
        let mut v = BASE_LADDER.to_vec();
        v.push("fps60");
        v
    } else {
        BASE_LADDER.to_vec()
    }
}

/// 超额延迟（RTT − 会话下限，见 `stream_cfg::excess_rtt_ms`）≥ 200ms 持续
/// 这么久 → 降一档。2026-10-05：口径从绝对 RTT 改为超额延迟——中继固有
/// ~600ms 传播延迟不该触发降档（实测那样会把梯子一路踩到 smooth、字看不清），
/// 只有「比本场安静时刻还慢 200ms」才是排队信号。
const AUTO_DOWN_RTT_MS: i64 = 200;
const AUTO_DOWN_HOLD_MS: i64 = 10_000;
/// 稳定公网直连也允许恢复；超额口径下中继会话同样可能达标（这是有意的——
/// 换路重测容量的活由 `Flow::budget` 负责，这里只管档位）。
/// 🔴 A-乙（2026-10-06）：持续窗 30s → 12s。定标来自 §10 的真机形态：v6 直连
/// `rtt 17–57ms / loss 0pm / budget 8000kbps / delivered 2.4–5.8Mbps` 却整场停在
/// `balanced@100ms`，用户口径「需要自己手工切，自动挡就没有意义了」。冷却仍是
/// 15s（换档动作的抖动保护），所以从条件成立到升档最快 12s、两次换档间隔 ≥15s，
/// 不会形成新的来回跳。
const AUTO_UP_RTT_MS: i64 = 100;
const AUTO_UP_HOLD_MS: i64 = 12_000;
/// 两次换档之间的冷却：档位来回跳会让画面尺寸忽大忽小，比糊更难受。
const AUTO_COOLDOWN_MS: i64 = 15_000;
/// 近帧均值低于此值才认为有余量升档（帧都很轻 = 链路吃得下）。
const AUTO_UP_BYTES: usize = 60_000;
/// 参与 auto 判定的近帧窗口（与 `EncoderState::adapt` 的 8 帧同口径）。
const AUTO_FRAME_WINDOW: usize = 8;
/// 🔴 帧龄（排队压力）≥ 300ms 视同链路差（2026-10-03）：与码率缩放
/// `bitrate_scale_for_queue` 的 300ms 档同源（≈19 帧排队）。RTT 是 pong 测的，
/// 队列深时 pong 一起被堵，RTT 反而「钝」；帧龄是拥塞最直接的观测，
/// 该独立参与降档，不能只搭 RTT 的便车。
/// 🔴 2026-10-06 A-乙**收窄了这条的适用范围**（不是删掉）：`transport_clear` 为真
/// （RTT 有样本、<150ms、零丢包）时它**不再单独定罪**。理由有两层：
/// ① 这个槽里的数早就不是纯网络观测——它混着对端上报的**帧龄**（含对面解码+绘制
///   深度，真机实测稳定 1100ms 上下）与本端积压，传输层清白时它剩下的只有这两样，
///   砍码率治不了它们，只会把画面做糊（§10 现场：`rtt 17–57ms / loss 0 / backlog 0`
///   却因帧龄 1100ms 被钉在 balanced）。
/// ② 真拥塞并不因此失去降档通道：真排队时 `excess_rtt ≥ 200` 或 `loss ≥ 20‰∧有交付
///   压力` 照样触发；而**码率这一路的降档完全不经这个判据**——`Flow` 用自己的
///   send→ack `backlog` 砍 `kbps`，`fps_limit` 跟着 `kbps` 走（分辨率自
///   2026-10-06 文字优先拍板后不再跟预算走，见 `Flow::resolution_limit`）。
///   所以豁免只摘掉「自家生产节拍慢被记成网络拥塞」这一类误伤。
const AUTO_DOWN_QUEUE_MS: i64 = 300;

// 当前档画面持续重过本档预算 → 降档。阈值与该档自适应的 adapt_down 同源：
// 一个档位自己的 q 值自适应都压不住的帧大小，说明这个档对这条链路太重了。
// （2026-09-22：不再按下标查梯子——预算由调用方按 `auto_ladder` 算好传入
// `LinkSample.down_bytes`，判据保持纯函数。）

/// profile → 自动阶梯下标（不在阶梯内如 uhd/fps120 返回 None）。
pub(super) fn ladder_index_of(
    p: &super::video::EncodeProfile,
    has_gpu: bool,
) -> Option<usize> {
    auto_ladder(has_gpu)
        .iter()
        .position(|name| &super::video::EncodeProfile::of_name(name) == p)
}

/// 自动换档的**纯判据**（时间由调用方传入，可无网络单测）。
///
/// 优先级：降档判据 > 升档判据（先保流畅再谈清晰）。
/// 持续窗口（high/low since）**无论是否在冷却中都照常维护**——
/// 冷却只挡「换档」这个动作，不抹掉已经观测到的链路状态，
/// 否则冷却一过还要从头再等 30s，升档会莫名变慢。
///
/// 返回 (新档位下标（None = 不动），更新后的 high_since，更新后的 low_since)。
pub(super) struct LinkSample {
    pub tier: usize,
    /// 实际梯子长度（`auto_ladder(has_gpu).len()`）——升档天花板随硬编能力变。
    pub ladder_len: usize,
    /// 当前档的降档预算（`of_name(ladder[tier]).adapt_down`）。
    pub down_bytes: usize,
    /// 超额延迟（ms）= RTT − 会话下限；下限未建立时等于绝对 RTT。
    /// 🔴 2026-10-06：口径改成超额之后，**0 的含义变了**——它现在是「与本场安静
    /// 时刻同级」，即链路最好的那种读数，而不是「没测到」。未采样由
    /// [`LinkSample::rtt_measured`] 表达（同一个错误在帧龄槽上叫 A-甲）。
    pub rtt_ms: i64,
    /// 是否真有一个 RTT 读数（`stream_cfg::video_rtt_ms() > 0`）。
    /// 未测到 RTT 时不许升档（「没数据」不等于「很好」）。
    pub rtt_measured: bool,
    /// 排队压力 EMA（ms）：对端 NetHint 帧龄 ∨ 本端 `flow.backlog_ms`。
    /// **0 = 已排空的确凿样本**（不是「未采样」，未采样是负值，见
    /// `stream_cfg::set_peer_queue_ms`）。
    pub queue_ms: i64,
    /// 本会话是否收到过任何帧龄上报（`stream_cfg::peer_queue_seen`）。
    /// 「没见过上报」与「见过 0」必须能区分：前者是老对端，丢包得单独定罪；
    /// 后者是确凿的排空证据，丢包不再能借排队之名踩档。
    pub queue_measured: bool,
    /// 传输层否认网络在排队（RTT 有样本、低于降速线、零丢包）——与 `Flow::feedback`
    /// 的定罪豁免**同一个函数**，判据不许写两遍（AGENTS 规则 11.1）。
    pub transport_clear: bool,
    pub avg_bytes: usize,
    pub loss_permille: u64,
    pub high_since: Option<i64>,
    pub low_since: Option<i64>,
    pub last_change_ms: i64,
    pub now_ms: i64,
}

pub(super) fn auto_decide(s: LinkSample) -> (Option<usize>, Option<i64>, Option<i64>) {
    // 收口成结构体（clippy too_many_arguments）：调用点读起来是「一次链路采样」，
    // 以后加字段也不用再动签名。首行解构，下面全是原样逻辑。
    let LinkSample {
        tier,
        ladder_len,
        down_bytes,
        rtt_ms,
        rtt_measured,
        queue_ms,
        queue_measured,
        transport_clear,
        avg_bytes,
        loss_permille,
        high_since,
        low_since,
        last_change_ms,
        now_ms,
    } = s;
    // A-甲 收口（2026-10-06）：这里曾经是第三处把 `0` 当成「未采样」的写法
    // （`(queue_ms > 0)`）。0 现在是「已排空」的确凿样本，未采样改由
    // `queue_measured` 表达——老对端从不上报帧龄时仍要让丢包单独定罪，
    // 新对端上报 0 时则不许再借排队之名踩档。
    let measured_queue = queue_measured.then_some(queue_ms);
    // 高 RTT / 深排队独立降档，丢包需与交付压力一起判断。排队那一路受传输层否决，
    // 口径与理由见 `AUTO_DOWN_QUEUE_MS`。
    let link_bad = rtt_ms >= AUTO_DOWN_RTT_MS
        || super::media::loss_pressure(measured_queue, loss_permille, 50)
        || (queue_ms >= AUTO_DOWN_QUEUE_MS && !transport_clear);
    let high_since = if link_bad {
        Some(high_since.unwrap_or(now_ms))
    } else {
        None
    };
    // 🔴 A-甲 的孪生缺陷（2026-10-06 真机抓到）：这里原本写 `rtt_ms > 0`，那时
    // `rtt_ms` 还是**绝对 RTT**，`> 0` = 「有读数」。2026-10-05 口径换成**超额延迟**
    // 之后，`> 0` 变成了「必须比本场安静时刻更慢才准升档」——直连上 RTT 抖动只有
    // 21..29ms，而 `next_rtt_floor` 把下限沉到最小值，于是超额经常正好是 0；
    // 保持窗要**连续** 12s 成立，一拍归 0 就整窗作废 ⇒ 自动挡永远升不上去
    // （实测：v6 直连 rtt 19–29ms / loss 0 / backlog 0 / budget 8000 跑了 50s 仍停
    // balanced）。未采样这件事由 `rtt_measured` 表达，不许再用「读数等于 0」冒充。
    let low_since = if rtt_measured
        && rtt_ms < AUTO_UP_RTT_MS
        && !super::media::loss_pressure(measured_queue, loss_permille, 20)
        // 码控在 150ms 以上已经降速，自动画质不能在同一队列状态下反向升档。
        // 传输层否认排队时这份「150 以上」只剩本机采集/编码节拍与对面绘制深度，
        // 升档不该被它按住（同一条豁免的理由见 `AUTO_DOWN_QUEUE_MS`）。
        && (queue_ms < 150 || transport_clear)
    {
        Some(low_since.unwrap_or(now_ms))
    } else {
        None
    };
    if now_ms - last_change_ms < AUTO_COOLDOWN_MS {
        return (None, high_since, low_since);
    }
    let link_bad_sustained = high_since.is_some_and(|s| now_ms - s >= AUTO_DOWN_HOLD_MS);
    let rtt_good_sustained = low_since.is_some_and(|s| now_ms - s >= AUTO_UP_HOLD_MS);
    let want_down = link_bad_sustained || avg_bytes > down_bytes;
    let want_up = tier + 1 < ladder_len && rtt_good_sustained && avg_bytes < AUTO_UP_BYTES;
    let new_tier = if want_down && tier > 0 {
        Some(tier - 1)
    } else if !want_down && want_up {
        Some(tier + 1)
    } else {
        None
    };
    (new_tier, high_since, low_since)
}

/// 「自动」档的运行状态。每份推流配置一份（随 `StreamCfg` 存活）。
pub(super) struct AutoTier {
    pub(super) enabled: bool,
    /// 本机是否有硬编 H.264——决定梯子是否含 fps60（见 [`auto_ladder`]）。
    /// 会话建立时由 `reset_from_cfg` 按 caps 设置；off() 默认 false（保守）。
    pub(super) has_gpu: bool,
    /// 当前落在 `auto_ladder(has_gpu)` 的第几档。
    pub(super) tier: usize,
    /// 上一次换档时刻；0 = 本会话还没换过（冷却判据用）。
    pub(super) last_change_ms: i64,
    /// RTT 进入「差」区间的起点（None = 当前不在差区间）。
    pub(super) high_since: Option<i64>,
    /// RTT 进入「好」区间的起点。
    pub(super) low_since: Option<i64>,
    /// 近若干帧的 JPEG 字节数。
    pub(super) recent: Vec<usize>,
    /// 最近一次判档的输入快照（供 5s 汇总行打印）。空 = 本会话还没判过。
    ///
    /// 为什么要它：「自动挡为什么不给最好」以前只能从日志反推，而这次的根因
    /// （升档闸把「超额=0」当成没测到）恰恰是**反推不出来**的那类——读数全都
    /// 正常，坏的是一句 `> 0`。快照进日志才能当场看见保持窗到底有没有在走。
    pub(super) diag: String,
}

impl AutoTier {
    pub(super) fn off() -> Self {
        Self {
            enabled: false,
            has_gpu: false,
            tier: 1, // balanced
            last_change_ms: 0,
            high_since: None,
            low_since: None,
            recent: Vec::new(),
            diag: String::new(),
        }
    }
}

/// 判定窗口的帧数口径（`auto_note_frame` 用，放这里让测试与实现同源）。
pub(super) const FRAME_WINDOW: usize = AUTO_FRAME_WINDOW;

#[cfg(test)]
mod tests {
    use super::super::stream_cfg::StreamCfg;
    use super::{auto_decide, LinkSample, FRAME_WINDOW};

    const T0: i64 = 1_758_000_000_000;

    /// 以 1s 间隔喂一帧；返回本帧是否触发了换档。
    fn feed(s: &StreamCfg, bytes: usize, i: usize) -> bool {
        s.auto_note_frame(bytes, T0 + (i as i64) * 1000)
    }

    #[test]
    fn 选实名档会关掉自动() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("auto 合法");
        assert!(s.auto_enabled());
        s.set_quality("sharp").expect("合法");
        assert!(!s.auto_enabled(), "实名档 = 锁定，自动必须让位");
    }

    #[test]
    fn 自动档下rtt持续差10s会降档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(300);
        // 判定窗口每 8 帧收口一次：第 8 帧（i=7）首判，high_since 从 T0+7s 起算；
        // 之后 i=15（+8s）、i=23（+16s ≥ 10s 持续）→ 降档
        for i in 0..24 {
            let changed = feed(&s, 10_000, i);
            let want = i == 23;
            assert_eq!(changed, want, "第 {i} 帧换档预期不符");
        }
        assert_eq!(s.auto_tier_name(), "smooth");
        assert!(s.auto_enabled(), "自动降档不退出自动模式");
    }

    #[test]
    fn 自动档下帧持续超预算会立即降档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        // balanced 的 adapt_down = 220_000；rtt 未测（0）不影响字节判据。
        // 窗口在 i=7 收口（第 8 帧），立刻降。
        for i in 0..9 {
            let changed = feed(&s, 400_000, i);
            let want = i == 7;
            assert_eq!(changed, want, "第 {i} 帧换档预期不符");
        }
        assert_eq!(s.auto_tier_name(), "smooth");
    }

    #[test]
    fn 自动档下局域网且帧轻会升档且封顶超清() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(20);
        // 从 balanced 出发，升到 sharp、再升到 ultra（天花板），不应出现 uhd。
        // 每次升档后 15s 冷却 + 30s 持续窗口（窗口跨冷却保留，冷却一过就能升）。
        let mut hit_sharp = false;
        let mut hit_ultra = false;
        for i in 0..120 {
            if feed(&s, 5_000, i) {
                if s.auto_tier_name() == "sharp" && !hit_sharp {
                    hit_sharp = true;
                } else if s.auto_tier_name() == "ultra" {
                    hit_ultra = true;
                    break;
                }
            }
        }
        assert!(hit_sharp, "应先经过清晰档");
        assert!(hit_ultra, "条件持续满足应升到超清");
        assert_ne!(s.auto_tier_name(), "uhd", "自动档天花板是超清，不是原生");
    }

    #[test]
    fn 稳定公网时延可恢复画质但排队仍挡升档() {
        let sample = |queue_ms| LinkSample {
            tier: 0, ladder_len: 4, down_bytes: 150_000,
            rtt_ms: 80, rtt_measured: true, queue_ms, queue_measured: true, transport_clear: false,
            avg_bytes: 5_000, loss_permille: 0,
            high_since: None, low_since: Some(0), last_change_ms: 0, now_ms: 30_000,
        };
        assert_eq!(auto_decide(sample(80)).0, Some(1),
            "已稳定 30 秒的公网直连不能因不是局域网 RTT 永久保留 smooth");
        assert_eq!(auto_decide(sample(160)).0, None, "码控已降速的队列不能升画质");
        let mut high_rtt = sample(80);
        high_rtt.rtt_ms = 150;
        assert_eq!(auto_decide(high_rtt).0, None, "更慢链路不满足恢复条件");
    }

    #[test]
    fn bounded_lossy_delivery_can_restore_quality_but_congestion_still_downgrades() {
        let sample = |queue_ms| LinkSample {
            tier: 0, ladder_len: 4, down_bytes: 150_000,
            rtt_ms: 40, rtt_measured: true, queue_ms, queue_measured: true, transport_clear: false,
            avg_bytes: 5_000, loss_permille: 60,
            high_since: None, low_since: Some(0), last_change_ms: 0, now_ms: 30_000,
        };
        let healthy = auto_decide(sample(50));
        assert_eq!(healthy.0, Some(1));
        assert_eq!(healthy.1, None, "bounded delivery is not sustained congestion");
        let mut congested = sample(120);
        congested.tier = 1;
        congested.high_since = Some(0);
        let bad = auto_decide(congested);
        assert_eq!(bad.0, Some(0));
        assert_eq!(bad.2, None, "loss with queue pressure cannot restore quality");
    }

    /// A-乙 的**反例侧**：传输层不清白（有丢包）时，帧龄 ≥300ms 仍要独立定罪。
    /// 2026-10-03 那条判据没有被删掉，只是不再能在「网络否认排队」时单独成立。
    #[test]
    fn 帧龄持续破300ms_且传输层不清白_会降档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(20); // RTT 好
        s.note_stream_health(20, 1, 0); // 但有 1‰ 丢包 ⇒ transport_clear 判假
        s.set_peer_queue_ms(500);
        s.set_peer_queue_ms(500);
        assert_eq!(s.peer_queue_ms_for_test(), 500);
        for i in 0..24 {
            let changed = feed(&s, 10_000, i);
            assert_eq!(changed, i == 23, "第 {i} 帧换档预期不符");
        }
        assert_eq!(s.auto_tier_name(), "smooth");
    }

    /// A-乙 的**豁免侧**（§10 真机现场）：v6 直连 rtt 17–57ms、loss 0、本端积压 0，
    /// 对端上报的帧龄却有 1100ms（含对面绘制深度）。这时按帧龄定罪只会把画面钉在
    /// 低档，砍码率治不了它 ⇒ 不许降档。注意本例同时满足升档条件（A-甲 让排空/
    /// 清白样本能买到资格），所以断言只钉「绝不因帧龄往下」，不钉「纹丝不动」。
    #[test]
    fn 传输层清白时帧龄再高也不定罪() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(20);
        s.set_peer_queue_ms(1100);
        s.set_peer_queue_ms(1100);
        for i in 0..60 {
            feed(&s, 10_000, i);
            assert_ne!(s.auto_tier_name(), "smooth", "第 {i} 帧：传输层清白时帧龄不能定罪降档");
        }
    }

    /// A-甲 的第三处哨兵（判据侧）：**确凿排空**与**从未上报**是两回事。
    /// 上报过 0 ⇒ `loss_pressure` 里那条「队列 ≥100ms」不成立，丢包不能借排队之名
    /// 踩档；反例的另一半（从未上报时丢包必须仍然定罪）由
    /// `丢包持续千分之50会降档` 钉住——那条用例不喂 `set_peer_queue_ms`，走的正是
    /// `queue_measured = false` 这一臂。
    #[test]
    fn 确凿排空时丢包不再借排队定罪() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(10);
        s.note_stream_health(10, 60, 0); // 6% 丢包，但传输层不清白
        s.set_peer_queue_ms(0); // 对端确凿报告：已排空
        assert!(s.peer_queue_ms_for_test() < 100, "0 样本必须留在 0 附近");
        for i in 0..40 {
            feed(&s, 10_000, i);
            assert_ne!(
                s.auto_tier_name(),
                "smooth",
                "第 {i} 帧：确凿排空时丢包不该借排队定罪"
            );
        }
    }

    /// A-甲 的现场回归：排空样本（0）必须能把帧龄 EMA 拉下来。
    /// 旧写法 `if queue_ms <= 0 { return; }` 把 0 整条丢掉 ⇒ 这个槽只升不降，
    /// 本端积压明明归零，判档仍看见上一次上报的 1100ms ⇒ 自动挡永不回升。
    #[test]
    fn 排空样本能把帧龄ema拉回并买到升档资格() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(20);
        s.set_peer_queue_ms(1100);
        assert_eq!(s.peer_queue_ms_for_test(), 1100, "首样本直接播种");
        // 每拍喂 0（本端积压已排空）：α=1/2 逐拍收敛，四拍内跌破升档线 150。
        let mut crossed = None;
        for i in 1..=5 {
            s.set_peer_queue_ms(0);
            if s.peer_queue_ms_for_test() < 150 {
                crossed = Some(i);
                break;
            }
        }
        assert!(crossed.is_some(), "排空样本必须让 EMA 跌到升档线以下");
        // 条件连续成立满 12s（A-乙 的新门槛）后应升档。
        for i in 0..30 {
            if feed(&s, 1_000, i) {
                assert_eq!(s.auto_tier_name(), "sharp", "第 {i} 帧应升到清晰档");
                return;
            }
        }
        panic!("排空且传输清白的会话不该停在 balanced");
    }

    #[test]
    fn 换档后冷却期内不再连跳() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(300);
        // 帧重 + rtt 差，双判据都指向降档：第一次窗口收口（第 8 帧）就降
        for i in 0..16 {
            feed(&s, 400_000, i);
        }
        assert_eq!(s.auto_tier_name(), "smooth");
        // smooth 已是最低档，不会再动；换个场景验证冷却——重建一个从 sharp 开始的
        let s2 = StreamCfg::new();
        s2.set_quality("sharp").expect("合法");
        s2.set_quality("auto").expect("从 sharp 起跑");
        s2.set_peer_rtt(300);
        for i in 0..9 {
            feed(&s2, 400_000, i);
        }
        assert_eq!(s2.auto_tier_name(), "balanced", "第一次换档应发生");
        // 冷却期 15s 内（第 9~23 帧都距换档 <15s），即使判据再满足也不换
        for i in 9..23 {
            assert!(!feed(&s2, 400_000, i), "冷却期内不该换档");
        }
        assert_eq!(s2.auto_tier_name(), "balanced");
    }

    #[test]
    fn 近帧不满一窗不判定() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(300);
        for i in 0..(FRAME_WINDOW - 1) {
            assert!(!feed(&s, 400_000, i), "窗口没收口不该换档");
        }
        assert_eq!(s.auto_tier_name(), "balanced");
    }

    #[test]
    fn 丢包持续千分之50会降档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(10); // RTT 满速，纯靠丢包判据
        s.note_stream_health(10, 60, 0); // 6% 丢包
        for i in 0..24 {
            let changed = feed(&s, 10_000, i);
            let want = i == 23;
            assert_eq!(changed, want, "第 {i} 帧换档预期不符");
        }
        assert_eq!(s.auto_tier_name(), "smooth");
    }

    #[test]
    fn 丢包千分之20以上不升档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(20); // RTT 极好
        s.note_stream_health(20, 25, 0); // 但 2.5% 丢包
        for i in 0..60 {
            assert!(!feed(&s, 1_000, i), "丢包挡升档");
        }
        assert_eq!(s.auto_tier_name(), "balanced");
    }

    #[test]
    fn rtt没测到时不凭空升档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        // rtt 一直 0（发起端还没上报）：帧再轻也不能升——「没数据」不等于「很好」
        for i in 0..60 {
            assert!(!feed(&s, 1_000, i), "rtt 未测到不该升档");
        }
        assert_eq!(s.auto_tier_name(), "balanced");
    }

    /// 2026-09-22 动态梯子回归钉：fps60 天花板只给有硬编的机器。
    /// 无硬编机器若混进 fps60，JPEG 全量截屏按 16ms 跑 = CPU 灾难。
    #[test]
    fn 有硬编时自动梯子天花板是fps60_无硬编是超清() {
        use crate::rc::stream_cfg::StreamCodec;
        use crate::rc::video::EncodeProfile as EP;
        // 有硬编：balanced → sharp → ultra → fps60（三次升档，各自 30s 持续 + 15s 冷却）
        let s = StreamCfg::new();
        s.reset_from_cfg(EP::of_name("balanced"), false, true, StreamCodec::Auto, true);
        s.set_peer_rtt(20);
        let mut hit = false;
        for i in 0..400 {
            if feed(&s, 1_000, i) && s.auto_tier_name() == "fps60" {
                hit = true;
                break;
            }
        }
        assert!(hit, "有硬编时应能升到 fps60 天花板");
        // 无硬编：怎么喂都到不了 fps60
        let s2 = StreamCfg::new();
        s2.reset_from_cfg(EP::of_name("balanced"), false, true, StreamCodec::Auto, false);
        s2.set_peer_rtt(20);
        for i in 0..400 {
            feed(&s2, 1_000, i);
        }
        assert_ne!(s2.auto_tier_name(), "fps60", "无硬编机器梯子不含 fps60");
        assert_eq!(s2.auto_tier_name(), "ultra", "无硬编天花板仍是超清");
    }

    /// 2026-10-03 的原始判据（帧龄深 → 持续后降档、RTT 再好也不许升）在
    /// **传输层不清白**时仍成立，见上面的
    /// `帧龄持续破300ms_且传输层不清白_会降档`；传输层清白时的豁免与理由见
    /// `传输层清白时帧龄再高也不定罪`。这里保留「深排队挡住升档」那一半：
    /// 队列口径 ≥150ms 且网络不否认排队，自动画质不得反向升档。
    #[test]
    fn 帧龄深时不升档_且持续后降档() {
        let s = StreamCfg::new();
        s.set_quality("auto").expect("合法");
        s.set_peer_rtt(20); // RTT 极好，但队列深
        s.note_stream_health(20, 1, 0); // 1‰ 丢包 ⇒ 传输层不否认排队
        s.set_peer_queue_ms(500);
        s.set_peer_queue_ms(500);
        for i in 0..60 {
            if feed(&s, 1_000, i) {
                assert_eq!(
                    s.auto_tier_name(),
                    "smooth",
                    "队列深只许往低档走（RTT 再好也不许升）"
                );
            }
        }
        assert_eq!(s.auto_tier_name(), "smooth", "帧龄深最终应降到最低档");
    }
}
