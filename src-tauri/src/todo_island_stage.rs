//! 岛的**舞台（stage）**——收起 / 悬停 / 展开 / 输入 / 全清五种窗口尺寸。
//!
//! ## 为什么窗口跟着内容变，而不是固定一个大窗口
//!
//! §4.4 ③曾把「固定大窗口（PILLAR 450×350，内容内部变换）」列为候选 5，
//! 前提是「窗口内、胶囊之外的透明区域能把点击穿透到下层」。展开批落地时
//! 设计稿 §6 已给出另一条路并写死：**窗口尺寸由 `set_size` + `set_position`
//! 在状态切换时一次到位，「长出来」的连续感由内容层伪造**（栈浮标的跟随
//! 滑入同款）。这条路的前提不需要探针——窗口永远贴合内容，穿透轮询
//! （`todo_island_hover.rs`）拿窗口矩形判定就**天然正确**，不存在「透明区吃点击」。
//! ⇒ 候选 5 就此否决，无需再验。
//!
//! ## 尺寸账（尺寸的**唯一**来源；CSS 卡片填满窗口、不再持有尺寸——2026-09-25 档 3a）
//!
//! | stage | 逻辑尺寸 | 内容 |
//! |---|---|---|
//! | Pill / Clear | 208 × 32 | 胶囊（全清只是内容换成勾 + 一句话） |
//! | Peek | 300 × 40 | 悬停轻提示 |
//! | List | 420 × 240 | 头 40 + 列表 + 底 40 |
//! | Compose | 420 × 280 | 列表 + 输入行 |
//!
//! 展开时**顶边钉住不动、只向下生长**：y 恒为 `TOP_MARGIN`，x 按新宽度重算。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

use crate::todo_island::{TOP_MARGIN, WINDOW_LABEL};

/// 当前舞台（0= Pill，顺序按 enum）。show()/reveal() 重定位时要按**当前**宽度居中，
/// 否则展开态（420 宽）遇上一次笔记变动触发的 show()，会被按胶囊宽度（208）重算，
/// 岛整体右偏 (420−208)/2 = 106px。
static CURRENT_STAGE: AtomicU8 = AtomicU8::new(0);

impl IslandStage {
    fn as_u8(self) -> u8 {
        match self {
            IslandStage::Pill => 0,
            IslandStage::Peek => 1,
            IslandStage::List => 2,
            IslandStage::Compose => 3,
            IslandStage::Clear => 4,
        }
    }

    fn from_u8(v: u8) -> IslandStage {
        match v {
            1 => IslandStage::Peek,
            2 => IslandStage::List,
            3 => IslandStage::Compose,
            4 => IslandStage::Clear,
            _ => IslandStage::Pill,
        }
    }
}

/// 记下当前舞台（set_stage 命令调；hide 后前端舞台只会停在 pill/clear，都是胶囊宽，无需复位）。
pub fn set_current_stage(stage: IslandStage) {
    CURRENT_STAGE.store(stage.as_u8(), Ordering::SeqCst);
}

/// 当前舞台。取不到（未设置过）按 Pill。
pub fn current_stage() -> IslandStage {
    IslandStage::from_u8(CURRENT_STAGE.load(Ordering::SeqCst))
}

/// 各舞台的逻辑尺寸（CSS px）。
///
/// ❗ 这些是**逻辑**值：交给 Tauri 的 `LogicalSize` / `LogicalPosition` 折算，
/// 单位教训见 [`calc_top_center_for`] 的注释。
pub fn stage_size(stage: IslandStage) -> (f64, f64) {
    match stage {
        IslandStage::Pill | IslandStage::Clear => (208.0, 32.0),
        IslandStage::Peek => (300.0, 40.0),
        IslandStage::List => (420.0, 240.0),
        IslandStage::Compose => (420.0, 280.0),
    }
}

/// 岛的舞台。前端在交互发生时调 `todo_island_set_stage` 通知，Rust 只管几何。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IslandStage {
    /// 收起胶囊（208×32）
    Pill,
    /// 悬停轻提示（300×40）
    Peek,
    /// 展开列表（420×240）
    List,
    /// 展开列表 + 输入行（420×280）
    Compose,
    /// 全清态（208×32，内容是勾 + 一句话）
    Clear,
}

/// 顶部居中落位（指定宽度版）：`x = 屏宽/2 − w/2`（逻辑），`y = 主屏顶 + TOP_MARGIN`。
///
/// ## 🔴 单位教训（第一版在这里算错过，别重复）
///
/// 宽高常量是**逻辑**值（CSS px），而 `monitor.size()` 是**物理**像素。第一版把两者
/// 直接相减，125% 缩放下实测偏右 26px（正好 `(物理宽 − 逻辑宽) / 2`）。
/// 修法是**整条链路统一逻辑空间**：主屏矩形除以 `scale`，返回 `LogicalPosition`
/// 交 Tauri 折算。混用单位在 100% 缩放下差值恰好为 0、**完全看不出来**。
pub(crate) fn calc_top_center_for(app: &AppHandle, width: f64) -> LogicalPosition<f64> {
    let Some(m) = app.primary_monitor().ok().flatten() else {
        // 取不到主屏信息（极罕见）：只钉 y，x 交给窗口系统默认摆放，
        // 不猜分辨率 —— 猜错的岛会落在屏幕外，比偏一点更难排查。
        return LogicalPosition { x: 0.0, y: TOP_MARGIN };
    };
    let p = m.position();
    let s = m.size();
    let scale = m.scale_factor();
    LogicalPosition {
        x: p.x as f64 / scale + (s.width as f64 / scale - width) / 2.0,
        y: p.y as f64 / scale + TOP_MARGIN,
    }
}

/// 切舞台：**窗口尺寸逐帧动画**（2026-09-25 档 3a 修订）。
///
/// ## 为什么不再「一次到位」
///
/// 材质（窗口级 Acrylic）按窗口矩形铺：窗口一次切到新尺寸时，材质立刻铺满整个新矩形，
/// 而 CSS 卡片还要过渡 200–300ms 才长到位——这中间窗口比卡片大出一圈，露出一层玻璃板
/// （浅色主题下就是用户反馈的「白板」）。修法是把动画的**唯一来源**交给窗口：
/// Rust 以 16ms 步进插值 `set_size` + `set_position`，CSS 卡片改为永远填满窗口
/// （`inset:0`），两者每帧同步，玻璃矩形与卡片矩形之间不再存在「差的一圈」。
///
/// ❗ 动画途中重定向：`ANIM_GEN` 作废旧线程，新动画从 `CURRENT_SIZE`（每步更新）起算，
/// 不从旧舞台尺寸起算——快速连续切换收敛到最后一个目标。
#[tauri::command]
pub fn todo_island_set_stage(app: AppHandle, stage: IslandStage) {
    set_current_stage(stage);
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    animate_window(&app, &window, stage);
}

/// 动画代次：新动画作废旧动画线程（与 hide epoch 同一手法）。
static ANIM_GEN: AtomicU64 = AtomicU64::new(0);
/// 当前逻辑尺寸（动画每步更新；中途重定向的起点，也是 rgn/重定位的依据）。
static CURRENT_SIZE: Mutex<(f64, f64)> = Mutex::new((208.0, 32.0));

/// 各舞台的动画时长（= 原 CSS transition-duration 表；CSS 侧尺寸过渡已删）。
fn stage_duration_ms(stage: IslandStage) -> u64 {
    match stage {
        IslandStage::Peek => 150,
        IslandStage::List | IslandStage::Compose => 300,
        IslandStage::Pill | IslandStage::Clear => 200,
    }
}

/// cubic-bezier(0.2, 0, 0, 1) 的进度函数（与原 CSS 缓动同一份账）。
///
/// 参数化曲线：x(t)=3(1-t)²t·0.2 + t³，y(t)=3(1-t)t²·1 + t³。
/// 给定时间分数 u，用二分法解 x(t)=u 再取 y(t)——每步 8 轮足够（≤20 步动画）。
fn ease_progress(u: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    // 两端早退：二分在 u=0/1 会收敛到 t≈ε，y 返回 2.7e-15 这类非精确值——
    // 动画首尾帧必须钉死在 0/1（首帧不能比起点多出一个亚像素）。
    if u <= 0.0 {
        return 0.0;
    }
    if u >= 1.0 {
        return 1.0;
    }
    let x_of = |t: f64| 3.0 * (1.0 - t) * (1.0 - t) * t * 0.2 + t * t * t;
    let mut lo = 0.0_f64;
    let mut hi = 1.0_f64;
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if x_of(mid) < u {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let t = (lo + hi) / 2.0;
    3.0 * (1.0 - t) * t * t + t * t * t
}

fn animate_window(app: &AppHandle, window: &tauri::WebviewWindow, stage: IslandStage) {
    let gen = ANIM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let (tw, th) = stage_size(stage);
    let start = {
        let cur = CURRENT_SIZE.lock().map(|g| *g).unwrap_or((208.0, 32.0));
        (cur.0, cur.1)
    };
    let duration = stage_duration_ms(stage);
    let window = window.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let step_ms = 16_u64;
        let steps = (duration / step_ms).max(1);
        for i in 1..=steps {
            if ANIM_GEN.load(Ordering::SeqCst) != gen {
                return; // 被新动画作废
            }
            let p = ease_progress(i as f64 / steps as f64);
            let w = start.0 + (tw - start.0) * p;
            let h = start.1 + (th - start.1) * p;
            let _ = window.set_size(LogicalSize::new(w, h));
            let _ = window.set_position(calc_top_center_for(&app, w));
            if let Ok(mut cur) = CURRENT_SIZE.lock() {
                *cur = (w, h);
            }
            std::thread::sleep(std::time::Duration::from_millis(step_ms));
        }
        // 终帧精确落位（插值末步可能差亚像素）
        if ANIM_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let _ = window.set_size(LogicalSize::new(tw, th));
        let _ = window.set_position(calc_top_center_for(&app, tw));
        if let Ok(mut cur) = CURRENT_SIZE.lock() {
            *cur = (tw, th);
        }
        apply_stage_region(&app, &window, stage);
    });
}

/// 把窗口（**连材质一起**）裁成当前舞台的形状——消除圆角外的方角玻璃（月牙）。
///
/// 探针 G4 实测（rgn-pill.png）：月牙被裁掉、边缘由 CSS 抗锯齿边盖住看不出锯齿。
/// 时机：动画**终帧**施加（动画途中窗口是过渡矩形，先不裁——CSS 卡片填满窗口，
/// 每帧的形状由窗口自身给出，静止后才需要把圆角外的材质裁掉）。
/// ❗ 只在 Windows 有意义；rgn 的所有权交给系统（MSDN：SetWindowRgn 后由系统管理）。
pub fn apply_stage_region(_app: &AppHandle, window: &tauri::WebviewWindow, stage: IslandStage) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
        // ⚠ tauri 的 hwnd() 返回它自己 windows 依赖（0.61）的 HWND，与本项目 0.58 不同类型，
        //   按裸指针重建（探针 hit_test 里 `own.0 as isize` 是同一版本差的证例）。
        let Ok(raw) = window.hwnd() else { return };
        let hwnd = windows::Win32::Foundation::HWND(raw.0 as isize as *mut core::ffi::c_void);
        let Ok(size) = window.outer_size() else { return };
        let Ok(scale) = window.scale_factor() else { return };
        // 收起三态 = 胶囊（椭圆直径 = 窗口高）；展开两态 = 12 逻辑px 圆角卡。
        let (w, h) = (size.width as i32 + 1, size.height as i32 + 1);
        let radius = match stage {
            IslandStage::Pill | IslandStage::Clear | IslandStage::Peek => size.height as i32,
            IslandStage::List | IslandStage::Compose => (12.0 * scale).round() as i32,
        };
        let hrgn = unsafe { CreateRoundRectRgn(0, 0, w, h, radius, radius) };
        if hrgn.is_invalid() {
            log::warn!("[TodoIsland] CreateRoundRectRgn 失败，本舞台保留矩形窗口（月牙可见）");
            return;
        }
        unsafe { SetWindowRgn(hwnd, hrgn, true) };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, stage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 展开态的宽必须**不小于**收起态、高不小于悬停态——顶边钉住、只往下长的前提。
    /// 有人把尺寸表改出倒挂时，这条先炸。
    #[test]
    fn test_stage_sizes_never_shrink_outward() {
        let (pw, ph) = stage_size(IslandStage::Pill);
        let (kw, kh) = stage_size(IslandStage::Peek);
        let (lw, lh) = stage_size(IslandStage::List);
        let (cw, ch) = stage_size(IslandStage::Compose);
        assert!(lw >= pw && lh >= ph, "展开必须完整包住收起");
        assert!(cw >= lw && ch >= lh, "输入必须完整包住展开");
        assert!(kw >= pw && kh >= ph, "悬停必须包住收起");
        assert_eq!((pw, ph), (208.0, 32.0), "收起尺寸与 ISLAND_W/H 是同一份账");
    }

    /// 当前舞台的存取往返：u8 编码不能漂（有人往中间插枚举值时这里先炸）。
    #[test]
    fn test_stage_u8_roundtrip() {
        for st in [
            IslandStage::Pill,
            IslandStage::Peek,
            IslandStage::List,
            IslandStage::Compose,
            IslandStage::Clear,
        ] {
            set_current_stage(st);
            assert_eq!(current_stage(), st);
        }
    }

    /// x 必须随宽度反向移动才能保持居中：420 宽的展开态，x 要比 208 宽时小 106。
    /// 不直接测坐标（要显示器信息），测**差值公式**本身——它就是「左右对称生长」的定义。
    #[test]
    fn test_centering_delta_matches_width_delta() {
        let (pw, _) = stage_size(IslandStage::Pill);
        let (lw, _) = stage_size(IslandStage::List);
        assert_eq!((lw - pw) / 2.0, 106.0, "设计稿：展开时左右各让出 106px");
    }

    /// 缓动函数的边界与单调性：p(0)=0、p(1)=1、单调不减——动画起点/终点不能漂，
    /// 中途不能倒退（倒退会让窗口先缩后胀，用户看到抽搐）。
    #[test]
    fn test_ease_progress_bounds_and_monotonic() {
        assert_eq!(ease_progress(0.0), 0.0);
        assert_eq!(ease_progress(1.0), 1.0);
        let mut prev = 0.0;
        for i in 0..=40 {
            let p = ease_progress(i as f64 / 40.0);
            assert!(p >= prev, "缓动在 t={} 出现倒退: {p} < {prev}", i as f64 / 40.0);
            prev = p;
        }
    }
}
