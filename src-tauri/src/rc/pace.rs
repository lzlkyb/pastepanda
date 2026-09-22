//! 推流节拍判据（2026-09-22）。
//!
//! 从 `inbound.rs` 整块提出：`inbound.rs` 的主题是「被控端推流会话的结构与
//! 生命周期」，而这批是**纯判据**（帧间隔 / 编码器 fps / 主动 IDR 限频），
//! 随「远程手感」调参演进 —— 两者变更理由不同。混在一起会让 `inbound.rs`
//! 顶过 600 行红线（2026-09-22 实测：加完这批就到了 611）。
//!
//! 🔴 这里每一条都是「**错了不会崩**」的判据：写反了只是静默跑错帧率，
//! 表现是「卡」而不是「错」，靠读代码和肉眼都很难发现。所以每条都有回归钉，
//! 见 `rc/tests/pace.rs`。
//!
//! 这批判据的来历：用户报「远程时移动窗口明显卡顿，原生有窗口开关动画、
//! 远程看不到」。修的是三件事——① 提帧上限钉在 30fps；② 运动不驱动帧率
//!（只有输入事件那一瞬间提一帧）；③ 自适应降频把好档位也拖死。

/// 输入提帧的帧间隔上限（ms）：16ms = **60fps**。
///
/// 🔴 2026-09-22 由 33（30fps）降到 16（60fps）。原生桌面的窗口拖动/开关
/// 动画是 60fps：提到 30fps 仍然「看不到动画」—— 一段 200ms 的关闭动画
/// 只有 6 帧，看上去是跳变。拖动期间的带宽/CPU 上升由 CBR 码控
/// （`fps_bitrate_factor`：30fps→100%、60fps→160%）与 `pace_scale`
/// 自适应兜住，不再靠「限制提帧」来省。
const BOOST_GAP_MS: u64 = 16;

/// 本圈实际可用的最小帧间隔（ms）：档位间隔与提帧上限取小。
/// 档位本身比 16ms 更快时（fps60=16 / fps120=8）跟随档位，不被拖慢。
pub(crate) fn boost_gap_ms(interval_ms: u64) -> u64 {
    interval_ms.min(BOOST_GAP_MS)
}

/// C2：被控端**主动**要 IDR 的最小间隔（ms）。
///
/// 数据报弃帧后立刻要 IDR 能把「弃帧 → 对端发现缺口 → 往返请求 → 下一个
/// 自然 GOP」缩短成一圈。但 IDR 本身是整帧大包：不限频就会「拥塞→弃帧→
/// 要 IDR→更拥塞」自激成风暴。500ms 意味着最差每秒 2 个 IDR——比 1s 的
/// 自然 GOP 密一倍，是自愈加速而不是每帧重来。
pub(crate) const AUTO_KEY_MIN_GAP_MS: u128 = 500;

/// 是否该**主动**要一个 IDR（限频判据，纯函数便于单测）。
pub(crate) fn auto_key_due(
    last: Option<std::time::Instant>,
    now: std::time::Instant,
    min_gap_ms: u128,
) -> bool {
    match last {
        None => true,
        Some(t) => now.duration_since(t).as_millis() >= min_gap_ms,
    }
}

/// 下一帧的节拍（ms）——推流循环**唯一**决定「多久抓一次」的地方。
///
/// · **活跃**（本圈被输入提帧唤醒，或本圈真的产出了帧 ⇒ 画面在动）
///   → 提帧节拍 [`boost_gap_ms`]，即 16ms＝**60fps**。
///   这是「窗口开关 / 拖动动画终于看得见」的关键：动画期间画面一直在动，
///   于是每一圈都算活跃、被以 60fps 连续抓取。旧实现只在**输入事件到达的
///   那一瞬间**提一帧，一段 200ms 的关闭动画总共只抓到 2 帧——用户看到的
///   就是「跳一下」而不是动画。它同时覆盖「被控端自己在放视频」这类
///   **没有输入事件**的运动场景。
/// · **空闲**（桌面没变化）→ 档位间隔 × `pace_scale`，省 CPU 与带宽。
///
/// 过渡延迟可控：静止转运动最多等一个档位间隔（≤100ms）才发现，之后进入
/// 60fps；拖动场景本来就有输入提帧，无此延迟。
pub(crate) fn next_period_ms(active: bool, interval_ms: u64, pace_scale: u32) -> u64 {
    if active {
        boost_gap_ms(interval_ms)
    } else {
        interval_ms * pace_scale as u64
    }
}

/// 编码器时间戳/码控用的 fps：**按本档位的提帧上限算，不按静止间隔算**。
///
/// 🔴 为什么不能按 `interval_ms` 直接算（2026-09-22 改）：编码器的样本时间戳
/// 是 `idx * 1e7 / fps` **严格按 fps 步进**的（`mft_pick.rs::make_sample` /
/// `make_dxgi_sample`），而实际推流帧率会随运动/输入提帧升到 `boost_gap_ms`
/// 对应的帧率。两者不一致时：拖动期间真实出 60 帧/秒、编码器却按 30fps
/// 分配每帧 bit ⇒ 实际码率被 CBR 内部限流、画面塌陷。
/// 按提帧上限算则与 `fps_bitrate_factor`（30fps→100%、60fps→160%）
/// 天然对齐：总码率随帧率一起抬，每帧预算基本不变。
///
/// ❗ 只随**档位**变化 ⇒ 拖动开始/结束不会触发编码器重开
/// （`SessionEncoder::set_fps` 只在 fps 真的变了才 `reopen_needed`，
///  而重开要几百 ms，绝不能挂到输入事件上）。
///
/// 收口成一个函数而不是两处各写一遍：调用点有 `open_h264`（初始打开）与
/// `try_hardware_path`（每圈同步）两条，判据写两遍必漏一处。
///
/// ❗ `virtual_screen` / `gpu_disabled` 要一起传进来：D6b 在无零拷贝路径时
/// 把 fps120 档的节拍从 8ms 降回 16ms（见 [`effective_interval_ms`]），
/// 若只按档位原始间隔算，编码器会按 120fps 出时间戳而实际只跑 60fps。
pub(crate) fn want_fps_for(
    profile_interval: u64,
    virtual_screen: bool,
    gpu_disabled: bool,
) -> u32 {
    let effective = boost_gap_ms(effective_interval_ms(
        profile_interval,
        virtual_screen,
        gpu_disabled,
    ))
    .max(1);
    // 2026-09-22：三档 if 改映射表——fps144（7ms）/fps165（6ms）进档位表后，
    // 原「≤10 → 120」会把它们也标成 120fps，时间戳步进与 CBR 分配全错。
    // 🔴 fps 必须与真实帧率一致（见模块头），所以按 interval 精确映射，
    // 未知间隔按区间兜底（老档位 16/50/66/80/100ms 走 60/30 两档）。
    match effective {
        1..=6 => 165,
        7 => 144,
        8..=10 => 120,
        11..=20 => 60,
        _ => 30,
    }
}

/// 本会话实际可用的档位节拍（ms）。
///
/// D6b：fps120 请求落到**没有零拷贝路径**的场景（多屏拼接 / GPU 已判死）时，
/// 不能让 CPU 管线按 8ms 硬跑——节奏降回 16ms（fps60 体感）。UI 门控只挡
/// 正常路径，挡不住会话中途切范围 / 直连接口的请求。
///
/// 从 `video_run` 的循环体内提出来并收口：编码器 fps（[`want_fps_for`]）
/// 也必须看到这个降频后的值，否则时间戳步进与实际节拍脱节。
pub(crate) fn effective_interval_ms(
    profile_interval: u64,
    virtual_screen: bool,
    gpu_disabled: bool,
) -> u64 {
    if profile_interval <= 10 && (virtual_screen || gpu_disabled) {
        16
    } else {
        profile_interval
    }
}
