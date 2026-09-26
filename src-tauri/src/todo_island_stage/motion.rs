//! 舞台尺寸的**弹簧运动状态**（B 方案「连贯形变」的数学核）。
//!
//! ## 为什么要「速度」而不只是「位置」
//!
//! 老实现每次重定向都从当前位置、**零速度**重新起跳。快速反向（pill → list →
//! pill 连点）时，窗口已经带着向上的速度奔向 420，新目标却是 208 —— 从静止重跳
//! 等于先把速度抹掉再重新加速，肉眼看到的是「一顿」再走。本模块把速度也存进
//! 共享状态，新动画接住当前末态继续解同一个微分方程，反向只是换了目标值，
//! 运动本身不断。
//!
//! ## 解析解而不是逐帧积分
//!
//! 目标在两次重定向之间是常量，所以二阶线性 ODE 有闭式解（欠阻尼）：
//!
//! ```text
//!   x(t) = T + e^(−at)·(A·cos(ω_d t) + B·sin(ω_d t))
//!   A = x₀ − T,  B = (v₀ + a·A)/ω_d,  a = c/2,  ω_d = √k·√(1−ζ²),  ζ = c/(2√k)
//! ```
//!
//! 闭式解的好处：帧间隔抖动（16ms 步进偶发被拖长）不会累积误差，也不会像显式
//! 欧拉那样在 ω_d·Δt 偏大时发散。「从静止起步」的老行为是它的特例，由
//! [`SpringAxis::progress`] 保留（老单测仍以它为准）。

/// 弹簧刚度。🔴 **全库唯一一组参数**（文档 U2 §弹簧判定 1）：k=130、c=16（m=1）
/// → 阻尼比 ≈0.70、过冲 ≈4.5%、~500ms 落定。要调手感先改文档再改这里。
pub const SPRING_K: f64 = 130.0;
/// 弹簧阻尼，见 [`SPRING_K`]。
pub const SPRING_C: f64 = 16.0;

/// 落定判据的位置容差（逻辑 px）：距目标小于它且速度可忽略就算到位。
const SETTLE_POS: f64 = 0.25;
/// 落定判据的速度容差（逻辑 px/s）。
const SETTLE_VEL: f64 = 1.0;

/// 一维弹簧轴：位置 / 速度 / 目标。单位是逻辑像素。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringAxis {
    pub x: f64,
    pub v: f64,
    pub target: f64,
}

impl SpringAxis {
    pub fn new(x: f64) -> Self {
        Self { x, v: 0.0, target: x }
    }

    /// 换目标：**保留当前位置与速度**。这是「连贯」二字的全部含义。
    pub fn retarget(&mut self, target: f64) {
        self.target = target;
    }

    /// 从零速度、从 0 弹向 1 的进度——老实现（静止起步）的特例。
    /// 生产路径现在一律走 [`SpringMotion::advance`]（带初速），所以这里只留给
    /// 「弹簧参数被改动」的守卫单测；没有它，改 k/c 的手感漂移没有任何测试兜底。
    #[cfg(test)]
    pub fn progress(elapsed_s: f64) -> f64 {
        let mut axis = Self::new(0.0);
        axis.retarget(1.0);
        axis.advance(elapsed_s)
    }

    /// 推进 `dt` 秒，返回新位置（顺带更新速度，供下一次重定向续接）。
    pub fn advance(&mut self, dt: f64) -> f64 {
        let w0 = SPRING_K.sqrt();
        let a = SPRING_C / 2.0;
        let zeta = SPRING_C / (2.0 * w0);
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        let decay = (-a * dt).exp();
        let (sin, cos) = (wd * dt).sin_cos();
        let d0 = self.x - self.target;
        let b = (self.v + a * d0) / wd;
        self.x = self.target + decay * (d0 * cos + b * sin);
        self.v = decay * ((b * wd - a * d0) * cos + (-d0 * wd - a * b) * sin);
        self.x
    }

    /// 已落定：贴着目标且几乎不动。此时调用方应把终态精确写成目标值，
    /// 否则会留下一个亚像素级的常驻偏差（表现为圆角边缘一条细缝）。
    pub fn settled(&self) -> bool {
        (self.x - self.target).abs() < SETTLE_POS && self.v.abs() < SETTLE_VEL
    }
}

/// 两轴（宽 / 高）合成一台运动。宽高各自独立解同一个方程，参数相同。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringMotion {
    pub w: SpringAxis,
    pub h: SpringAxis,
}

impl SpringMotion {
    /// 胶囊末态（与 `stage_size` 的 Pill 行是同一份账）。
    pub fn pill() -> Self {
        Self { w: SpringAxis::new(208.0), h: SpringAxis::new(32.0) }
    }

    /// 停在某个尺寸上、速度为零（终帧落位用）。
    pub fn at(w: f64, h: f64) -> Self {
        Self { w: SpringAxis::new(w), h: SpringAxis::new(h) }
    }

    /// 换目标尺寸，保留当前位置与速度；返回自身以便链式接管共享状态。
    pub fn retarget(mut self, tw: f64, th: f64) -> Self {
        self.w.retarget(tw);
        self.h.retarget(th);
        self
    }

    /// 推进 `dt` 秒，返回 `(宽, 高)`。
    pub fn advance(&mut self, dt: f64) -> (f64, f64) {
        (self.w.advance(dt), self.h.advance(dt))
    }

    /// 两轴都落定了才算完。
    pub fn settled(&self) -> bool {
        self.w.settled() && self.h.settled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据 1（spec §形变）：反向时**首帧位置连续、速度不归零**。
    /// 速度归零就是「先停再走」，用户看到的那一下卡顿全部来自这里。
    #[test]
    fn test_reverse_keeps_position_and_velocity() {
        let mut m = SpringMotion::pill().retarget(420.0, 240.0);
        // 跑到 96ms：窗口正在长大、速度向上
        for _ in 0..6 {
            m.advance(0.016);
        }
        let (w_before, v_before) = (m.w.x, m.w.v);
        assert!(v_before > 1.0, "96ms 时应当仍在快速长大，v={v_before}");
        assert!(w_before > 208.0 && w_before < 420.0, "w={w_before}");

        // 中途反回胶囊：接住当前状态，而不是从静止重跳
        let mut after = m.retarget(208.0, 32.0);
        let (w0, _) = after.advance(0.0);
        assert!(
            (w0 - w_before).abs() < 1e-9,
            "反向首帧位置必须连续：{w0} vs {w_before}"
        );
        assert!(
            (after.w.v - v_before).abs() < 1e-9,
            "反向首帧速度必须续接：{} vs {v_before}",
            after.w.v
        );
        // 续接之后**不会一直冲向旧目标**：弹簧带着正速度反向时会先减速、再回头。
        // （要求第一帧就掉头是错的判据——那意味着速度被抹平，恰是不连续。）
        let mut reversed = false;
        for _ in 0..24 {
            after.advance(0.016);
            if after.w.v < 0.0 {
                reversed = true;
                break;
            }
        }
        assert!(
            reversed,
            "反向之后速度必须在数百毫秒内转为负，实际 v={}",
            after.w.v
        );
    }

    /// 判据 2（spec §形变）：反向之后仍收敛到新目标，且不靠无限振荡蒙混。
    #[test]
    fn test_reverse_still_settles_on_new_target() {
        let mut m = SpringMotion::pill().retarget(420.0, 240.0);
        for _ in 0..6 {
            m.advance(0.016);
        }
        m = m.retarget(208.0, 32.0);
        // 3.2s 远超落定时长（~500ms）；中途再反向一次，模拟连点
        for i in 0..200 {
            if i == 100 {
                m = m.retarget(300.0, 40.0);
            }
            m.advance(0.016);
        }
        assert!(m.settled(), "3.2s 后必须落定，实际 w={} h={}", m.w.x, m.h.x);
        assert!((m.w.x - 300.0).abs() < 0.25, "宽未落到 300：{}", m.w.x);
        assert!((m.h.x - 40.0).abs() < 0.25, "高未落到 40：{}", m.h.x);
    }

    /// 判据 3：从静止起步的特例与老实现逐点一致（防止换实现时悄悄改手感）。
    #[test]
    fn test_progress_matches_zero_velocity_step() {
        for i in 0..=1000u32 {
            let t = i as f64 / 1000.0;
            let mut axis = SpringAxis::new(0.0);
            axis.retarget(1.0);
            assert!(
                (axis.advance(t) - SpringAxis::progress(t)).abs() < 1e-12,
                "t={t} 两条路径不一致"
            );
        }
        assert_eq!(SpringAxis::progress(0.0), 0.0);
        assert!((SpringAxis::progress(1.0) - 1.0).abs() < 1e-3);
    }

    /// 落定判据本身不能被「贴着目标但还在高速」骗过去。
    #[test]
    fn test_settled_requires_both_position_and_velocity() {
        let fast_near = SpringAxis { x: 208.2, v: 50.0, target: 208.0 };
        assert!(!fast_near.settled(), "贴着目标但速度很大不算落定");
        let slow_far = SpringAxis { x: 160.0, v: 0.5, target: 208.0 };
        assert!(!slow_far.settled(), "速度慢但离得远不算落定");
    }
}