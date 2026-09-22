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

/// RTT ≥ 200ms 持续这么久 → 降一档（与码率缩放最差档的门槛同源）。
const AUTO_DOWN_RTT_MS: i64 = 200;
const AUTO_DOWN_HOLD_MS: i64 = 10_000;
/// RTT < 50ms 持续这么久才升档——只有稳的局域网才值得往上走。
const AUTO_UP_RTT_MS: i64 = 50;
const AUTO_UP_HOLD_MS: i64 = 30_000;
/// 两次换档之间的冷却：档位来回跳会让画面尺寸忽大忽小，比糊更难受。
const AUTO_COOLDOWN_MS: i64 = 15_000;
/// 近帧均值低于此值才认为有余量升档（帧都很轻 = 链路吃得下）。
const AUTO_UP_BYTES: usize = 60_000;
/// 参与 auto 判定的近帧窗口（与 `EncoderState::adapt` 的 8 帧同口径）。
const AUTO_FRAME_WINDOW: usize = 8;

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
    pub rtt_ms: i64,
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
        avg_bytes,
        loss_permille,
        high_since,
        low_since,
        last_change_ms,
        now_ms,
    } = s;
    // 链路「差」的判据：RTT 高 **或** 丢包重（≥5%），任一成立都算差
    let link_bad = rtt_ms >= AUTO_DOWN_RTT_MS || loss_permille >= 50;
    let high_since = if link_bad {
        Some(high_since.unwrap_or(now_ms))
    } else {
        None
    };
    // rtt == 0 = 还没测到，不能当「很好」处理；丢包 ≥2% 同样挡住升档
    let low_since = if rtt_ms > 0 && rtt_ms < AUTO_UP_RTT_MS && loss_permille < 20 {
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
        }
    }
}

/// 判定窗口的帧数口径（`auto_note_frame` 用，放这里让测试与实现同源）。
pub(super) const FRAME_WINDOW: usize = AUTO_FRAME_WINDOW;

#[cfg(test)]
mod tests {
    use super::super::stream_cfg::StreamCfg;
    use super::FRAME_WINDOW;

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
        s.note_stream_health(10, 60); // 6% 丢包
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
        s.note_stream_health(20, 25); // 但 2.5% 丢包
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
}
