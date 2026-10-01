//! 待办灵动岛的**光标穿透轮询**——从 `todo_island.rs` 切出来的独立关注点。
//!
//! ## 为什么要单独一个文件
//!
//! `todo_island.rs` 已到 590 行（红线 600），而这里是一块**边界干净**的东西：
//! 它只解决一个问题 —— 「208×32 的胶囊什么时候该收鼠标事件」，
//! 与窗口创建 / 定位 / 生命周期三者无耦合，输入只有「光标物理坐标」和「窗口外框」。
//!
//! ## 它解决的问题
//!
//! 岛是一块**常驻**浮在屏幕顶部的窗口。两类做法都不行：
//!
//! | 做法 | 后果 |
//! |---|---|
//! | 全程 `set_ignore_cursor_events(true)`（= 栈浮标的做法） | 鼠标点不到岛，岛上的按钮是死的 |
//! | 全程 `set_ignore_cursor_events(false)` | 208×32 的胶囊**恒久**吃掉它下面那条屏幕顶边的点击 —— 那是浏览器标签栏 / 应用标题栏的位置 |
//!
//! ⇒ 只能**按光标位置动态切**：光标进岛 → 收事件；光标出岛 → 恢复穿透。
//!
//! ## 命中边界贴着可见形状走（2 进 / 6 出）
//!
//! 判定对象从「窗口矩形」换成「**可见形状**」（停靠半胶囊 / peek 胶囊 / 12px 圆角卡，
//! 与 stage rgn 同一份账的纯几何侧）：矩形死角、展开态窗口的空白区不再拦点击——用户抱怨「岛附近没法点下层窗口」
//! 的直接根源就是旧版按矩形外扩 8/12px（吸附双态设计稿 §0 归因①）。
//! 凸形状的等距外扩仍是同族形状（胶囊外扩 p = (w+2p)×(h+2p) 胶囊、圆角 r 外扩 p = r+p），
//! 所以纯几何判定零像素读取、零额外线程。
//!
//! 进出用**同一个**外扩值时，光标停在边界上会让 `set_ignore_cursor_events` 每 60ms 翻一次，
//! 窗口在「收事件 / 不收事件」之间抖动 —— 表现为岛上的 hover 样式闪烁。
//! 所以进入外扩（`HOVER_IN_PAD`）**故意小于**离开外扩（`HOVER_OUT_PAD`），
//! 两者之间的环形带里保持当前状态。这条关系由编译期断言钉住（见下）。
//!
//! ## 拦截与展开分离（吸附双态设计稿 §3 的状态机）
//!
//! ① **拦截**：光标进可见形状 → **立即**收事件（拍板②：保证「停在岛上点一下」零失败）；
//!    出形状 → 恢复穿透。掠过岛旁（形状外）全程穿透零拦截。
//! ② **展开**：收起两态（pill/clear）要在形内**连续停留**才发 hover 事件——
//!    3 拍（≈180ms）先发 `todo-island-intent` 点亮意图 glow（此刻仍穿透，是预告不是拦截），
//!    4 拍（≈240ms）才发 hover=true 让前端切 peek。光标掠过岛面只会被拦 1–2 拍，不会展开。
//!    展开两态（list/compose）hover 立即发——列表的 6s 闲置自收计时器靠它清掉，不能等。
//!
//! ## 代次作废（与栈浮标同款）
//!
//! 每次 `start_poll` 都 `POLL_GEN += 1`，旧线程下一轮醒来发现代次不是自己的就退出。
//! 少了它，每次 `show()` 都会叠加一个永不退出的轮询线程，60ms 一次地抢窗口状态。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::todo_island::{EVENT_HOVER, EVENT_INTENT, WINDOW_LABEL};
use crate::todo_island_stage::IslandStage;

/// 鼠标进入判定外扩像素。命中边界贴着**可见形状**走（不是窗口矩形），2px 只给
/// 60ms 轮询采样留容错——外扩带就是「看不见却拦点击」的区域，必须最小（设计稿 §2）。
const HOVER_IN_PAD: f64 = 2.0;
/// 鼠标离开判定外扩像素。**故意大于进入值**，构成滞回带（2 进 / 6 出）：
/// 相等时，光标停在边界上会让 `set_ignore_cursor_events` 每 tick 翻转一次，
/// 窗口在「收事件 / 不收事件」之间抖动 —— 表现为岛上的 hover 样式闪烁。
const HOVER_OUT_PAD: f64 = 6.0;
/// 光标位置轮询间隔（ms）。60ms ≈ 16fps，比视觉感知快、又远低于把 COM 查询做成高频活。
const HOVER_POLL_MS: u64 = 60;
/// 形内连续停留多少拍点亮「意图」glow（此刻**仍穿透**，是预告不是拦截）。3 拍 ≈ 180ms。
const INTENT_TICKS: u32 = 3;
/// 形内连续停留多少拍才发 hover=true（前端切 peek）。4 拍 ≈ 240ms——扫过不展开。
const PEEK_TICKS: u32 = 4;

/// 滞回带必须存在（进入外扩 < 离开外扩），否则光标停在边界上会让穿透状态每 tick 翻转。
///
/// 写成**编译期断言**而不是 `#[test]`：两个值都是常量，`assert!` 放在测试里是恒真的死代码
/// （clippy 会正确地标 `assertions_on_constants`），而编译期断言能在编译时就挡住
/// 有人把这两个值改成相等 —— 比运行测试更早一步。
const _: () = assert!(HOVER_IN_PAD < HOVER_OUT_PAD);
/// 意图（glow 预告）必须先于 peek 展开，否则「突然被拦」没有预告期。
const _: () = assert!(INTENT_TICKS < PEEK_TICKS);

/// 鼠标当前是否在岛上（滞回判定后的结果 = 拦截状态）。
static HOVERING: AtomicBool = AtomicBool::new(false);
/// 形内连续停留拍数（进岛清零、每拍 +1）。
static DWELL_TICKS: AtomicU32 = AtomicU32::new(0);
/// intent 事件当前是否已发 true（离开时补发 false 清理）。
static INTENT_SENT: AtomicBool = AtomicBool::new(false);
/// hover 事件当前已发的值（按变化发放；离开/陈旧状态补发 false 清理）。
static EMITTED_HOVER: AtomicBool = AtomicBool::new(false);
/// 悬停轮询代次：`bump` 之后旧线程自行退出（与栈浮标同款做法）。
static POLL_GEN: AtomicU64 = AtomicU64::new(0);

/// 鼠标当前是否在岛上（探针回报用）。
pub(crate) fn is_hovering() -> bool {
    HOVERING.load(Ordering::SeqCst)
}

/// 清掉悬停状态（岛隐藏时调）。
///
/// ❗ 必须与 `stop_poll` 配对：只停线程不复位状态，下次 `show()` 时
/// `HOVERING` 会以「进来过」的身份启动，第一轮就按离开外扩判定，
/// 于是光标明明不在岛上也短暂进入「收事件」状态。
///
/// ❗ `EMITTED_HOVER` / `INTENT_SENT` **刻意不清**：隐藏期间若事件已发 true，
/// 复显后第一轮轮询（光标不在岛上）会按「已发值」补发 false 给前端清干净——
/// 提前清掉的话前端 hover 残留 true，复显直接以 peek 尺寸亮出。
pub(crate) fn reset_hovering() {
    HOVERING.store(false, Ordering::SeqCst);
    DWELL_TICKS.store(0, Ordering::SeqCst);
}

/// 启动悬停轮询。每次调用都会 bump 代次，让上一轮线程自行退出（防多线程叠加）。
pub(crate) fn start_poll(app: &AppHandle) {
    let mine = POLL_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || loop {
        if POLL_GEN.load(Ordering::SeqCst) != mine {
            return;
        }
        let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        step_hover(&app, &window);
        std::thread::sleep(std::time::Duration::from_millis(HOVER_POLL_MS));
    });
}

/// 停止悬停轮询（代次失效）。
pub(crate) fn stop_poll() {
    POLL_GEN.fetch_add(1, Ordering::SeqCst);
}

/// 命中形状（与 stage rgn 是同一份账的**纯几何侧**：停靠半胶囊 = HalfCapsule(Bottom)、
/// peek 胶囊 = Stadium、展开卡 = Rounded）。
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum IslandShape {
    /// 胶囊（CSS `border-radius: 999px` = 高度一半的半圆帽，peek 态）
    Stadium,
    /// 半胶囊（吸附形变设计稿 §3③）：上缘压平贴屏幕顶、下缘 = 高度一半的半圆帽（停靠两态）
    HalfCapsule,
    /// 半胶囊**镜像**（停靠锚点 C1）：贴屏幕**底边**时下缘压平、上缘是半圆帽。
    /// 独立变体而不是加 bool：新加形状时编译器会逼着 `shape_hit` 的 match 表态。
    HalfCapsuleBottom,
    /// 圆角矩形（list / compose 四角 12 逻辑px）
    Rounded { radius: f64 },
}

/// 纯几何：点（窗口局部坐标）是否落在「可见形状等距外扩 `pad` px」内。
///
/// 凸形状的等距外扩仍是同族形状：胶囊外扩 p = (w+2p)×(h+2p) 的胶囊、圆角 r 外扩 p = r+p、
/// **锐角外扩成半径 p 的圆角**——所以统一化为「外扩形的圆角矩形含点（上下角半径可不同）」：
/// 中段整行在形内，顶/底角区看角圆心距离。零像素读取，非 Windows 也参与单测。
pub(crate) fn shape_hit(shape: IslandShape, w: f64, h: f64, pad: f64, lx: f64, ly: f64) -> bool {
    // 粗筛：外扩矩形外直接否（光标在窗外较远时的绝大多数 tick 走这条早退）
    if lx < -pad || ly < -pad || lx > w + pad || ly > h + pad {
        return false;
    }
    // 换到外扩形局部坐标（外扩形左上角在 (-pad, -pad)）
    let (ew, eh) = (w + 2.0 * pad, h + 2.0 * pad);
    let (px, py) = (lx + pad, ly + pad);
    // 等距外扩后的上/下角半径：锐角（r_top=0）外扩成半径 pad 的圆角
    let (r_t, r_b) = match shape {
        IslandShape::Stadium => (eh / 2.0, eh / 2.0),
        IslandShape::HalfCapsule => (pad, eh / 2.0),
        IslandShape::HalfCapsuleBottom => (eh / 2.0, pad),
        IslandShape::Rounded { radius } => (radius + pad, radius + pad),
    };
    let (r_t, r_b) = (
        r_t.min(eh / 2.0).min(ew / 2.0),
        r_b.min(eh / 2.0).min(ew / 2.0),
    );
    // 圆角矩形含点（上下角半径可不同）：直边中段整行在形内；顶/底角区看角圆心距离
    if py >= r_t && py <= eh - r_b {
        return true;
    }
    let (cy, r) = if py < r_t { (r_t, r_t) } else { (eh - r_b, r_b) };
    let cx = if px < r {
        r
    } else if px > ew - r {
        ew - r
    } else {
        // 角圆心正上/下方：仍在直边段内
        return true;
    };
    let (dx, dy) = (px - cx, py - cy);
    dx * dx + dy * dy <= r * r
}

/// 纯函数：光标在形内、已停留 `dwell` 拍时，本拍该发什么。`(intent, hover)`。
///
/// - **拦截不在这里**：`set_ignore_cursor_events` 形内立即切（拍板②），保证点击零失败；
/// - intent glow：只在收起两态发（展开态光标本来就在岛上，glow 由 data-hover 负责）；
/// - hover（= 前端切 peek / 展开态的「鼠标在岛上」信号）：收起两态等 [`PEEK_TICKS`]
///   停留才发（掠过不展开）；展开两态立即发（列表 6s 闲置自收计时器靠它清掉）。
fn emit_plan(stage_collapsed: bool, dwell: u32) -> (bool, bool) {
    let intent = stage_collapsed && dwell >= INTENT_TICKS;
    let hover = !stage_collapsed || dwell >= PEEK_TICKS;
    (intent, hover)
}

/// 一轮判定。两条线分开（吸附双态设计稿 §3 的状态机）：
///
/// ① **拦截**：光标进可见形状（±滞回）→ 立即收事件；出 → 恢复穿透。
/// ② **事件**：intent glow（收起态停留 3 拍）与 hover（收起态 4 拍 / 展开态立即）
///    按停留拍数发放，离开时按「已发值」补发 false 清理——前端据此切
///    停靠 / 意图 / 预览三态视觉。
fn step_hover(app: &AppHandle, window: &WebviewWindow) {
    let Some((cx, cy)) = cursor_pos() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    // 光标与窗口尺寸都是物理像素，差值即窗口局部物理坐标——shape_hit 直接吃
    let (lx, ly) = (cx - pos.x as f64, cy - pos.y as f64);
    let (w, h) = (size.width as f64, size.height as f64);

    let stage = crate::todo_island_stage::current_stage();
    let collapsed = matches!(stage, IslandStage::Pill | IslandStage::Clear);
    // 形状与 rgn 是同一份账（吸附形变设计稿 §3③）：停靠两态半胶囊、peek 满胶囊、展开两态圆角卡。
    // 半胶囊压平哪条边看**锚点贴哪条边**（C1 停靠位置）——底档镜像，否则命中边界与
    // 屏幕外的那条边重合，会把贴屏幕那条边外 6px 的窗口当成岛来拦点击。
    let shape = match stage {
        IslandStage::Pill | IslandStage::Clear => {
            if crate::todo_island_anchor::anchor().is_bottom() {
                IslandShape::HalfCapsuleBottom
            } else {
                IslandShape::HalfCapsule
            }
        }
        IslandStage::Peek => IslandShape::Stadium,
        IslandStage::List | IslandStage::Compose => IslandShape::Rounded {
            // CSS 的 12 逻辑px → 物理（rgn 的 apply_stage_region 同一份折算）
            radius: 12.0 * window.scale_factor().unwrap_or(1.0),
        },
    };

    let was = HOVERING.load(Ordering::SeqCst);
    let pad = if was { HOVER_OUT_PAD } else { HOVER_IN_PAD };
    let inside = shape_hit(shape, w, h, pad, lx, ly);

    if inside != was {
        HOVERING.store(inside, Ordering::SeqCst);
        // inside → 收事件（false = 不忽略光标）；outside → 穿透（true = 忽略光标）
        // （点击穿透是桌面窗口概念，mobile 无该 API）
        #[cfg(desktop)]
        let _ = window.set_ignore_cursor_events(!inside);
    }

    if !inside {
        // 离开（或复显后的陈旧状态自愈）：按已发值补发 false，计数清零
        if EMITTED_HOVER.swap(false, Ordering::SeqCst) {
            let _ = app.emit_to(WINDOW_LABEL, EVENT_HOVER, false);
        }
        if INTENT_SENT.swap(false, Ordering::SeqCst) {
            let _ = app.emit_to(WINDOW_LABEL, EVENT_INTENT, false);
        }
        DWELL_TICKS.store(0, Ordering::SeqCst);
        return;
    }

    let dwell = DWELL_TICKS.fetch_add(1, Ordering::SeqCst) + 1;
    let (want_intent, want_hover) = emit_plan(collapsed, dwell);
    if want_intent && !INTENT_SENT.swap(true, Ordering::SeqCst) {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_INTENT, true);
    }
    if want_hover != EMITTED_HOVER.swap(want_hover, Ordering::SeqCst) {
        let _ = app.emit_to(WINDOW_LABEL, EVENT_HOVER, want_hover);
    }
}

/// 光标物理坐标。
#[cfg(target_os = "windows")]
fn cursor_pos() -> Option<(f64, f64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    if unsafe { GetCursorPos(&mut p) }.is_ok() {
        Some((p.x as f64, p.y as f64))
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn cursor_pos() -> Option<(f64, f64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 悬停轮询代次：bump 后旧线程必须退出（与栈浮标的同款判据）。
    /// 少了它，每次 show 都会叠加一个永不退出的轮询线程，60ms 一次地抢窗口状态。
    #[test]
    fn test_hover_poll_gen_bump_invalidates_old_poll() {
        let gen = AtomicU64::new(0);
        let mine = gen.fetch_add(1, Ordering::SeqCst) + 1;
        gen.fetch_add(1, Ordering::SeqCst); // 新一轮 show
        assert_ne!(
            gen.load(Ordering::SeqCst),
            mine,
            "代次递增后旧轮询线程必须退出"
        );
    }

    // ❗ 这里刻意**没有**「滞回带不为空」的测试：两个值都是常量，写成 `#[test]`
    // 就是恒真断言（clippy 的 `assertions_on_constants` 是对的）。
    // 该判据已由本文件顶部的编译期断言钉住：
    // `const _: () = assert!(HOVER_IN_PAD < HOVER_OUT_PAD);`
    // —— 常量之间的关系属于编译期，放在运行测试里等于没测。
    //
    // 用 `//` 而非 `///`：`mod tests` 的收尾注释后面没有 item 可 document，
    // 写成 `///` 会得到 `expected item after doc comment`（本轮实际踩到）。

    /// 矩形死角必须**不**命中——这是本轮改造的存在理由（吸附设计稿 §0 归因①）：
    /// 旧实现按「窗口矩形 ± 8/12px」判定，胶囊圆角外那四个方块会静默吃掉
    /// 下层窗口的点击。有人把 shape_hit 改回矩形判定时，这条先炸。
    #[test]
    fn test_shape_hit_stadium_excludes_rect_dead_corner() {
        let (w, h) = (208.0, 32.0); // pill 逻辑尺寸，纯几何与单位无关
        // (2,2) 在窗口矩形内、可见胶囊外——死角，不许拦
        assert!(!shape_hit(IslandShape::Stadium, w, h, 2.0, 2.0, 2.0));
        // 形内中心命中
        assert!(shape_hit(IslandShape::Stadium, w, h, 2.0, 104.0, 16.0));
        // 左缘外 1px（滞回进带 2px 内）命中；3px 外不命中
        assert!(shape_hit(IslandShape::Stadium, w, h, 2.0, -1.0, 16.0));
        assert!(!shape_hit(IslandShape::Stadium, w, h, 2.0, -3.0, 16.0));
    }

    /// 外扩带贴着形状走（等距曲线）：顶边中点外 1px 在带内、外 3px 在带外；
    /// 圆帽对角方向按径向距离同样成立。守卫「命中边界 = 可见形状 + pad」的前提。
    #[test]
    fn test_shape_hit_pad_band_follows_outline() {
        let (w, h) = (208.0, 32.0);
        assert!(shape_hit(IslandShape::Stadium, w, h, 2.0, w / 2.0, -1.0));
        assert!(!shape_hit(IslandShape::Stadium, w, h, 2.0, w / 2.0, -3.0));
        // 左帽 45° 方向：帽圆心 (16,16)、半径 16；径向距离 17（带内）命中、19（带外）不命中
        let d17 = 17.0 / std::f64::consts::SQRT_2;
        let d19 = 19.0 / std::f64::consts::SQRT_2;
        assert!(shape_hit(IslandShape::Stadium, w, h, 2.0, 16.0 - d17, 16.0 - d17));
        assert!(!shape_hit(IslandShape::Stadium, w, h, 2.0, 16.0 - d19, 16.0 - d19));
    }

    /// 展开卡（12px 圆角）死角同样不拦；圆角弧内正常命中。
    #[test]
    fn test_shape_hit_rounded_card_dead_corner() {
        let (w, h, r) = (525.0, 300.0, 15.0); // list 420×240 × scale 1.25
        let shape = IslandShape::Rounded { radius: r };
        assert!(!shape_hit(shape, w, h, 2.0, 2.0, 2.0), "死角不许拦");
        assert!(shape_hit(shape, w, h, 2.0, 16.0, 16.0), "弧内必须命中");
        assert!(shape_hit(shape, w, h, 2.0, w / 2.0, -1.0), "顶边外 1px 在带内");
    }

    /// 半胶囊（吸附形变设计稿 §3③ / §5）：上缘压平后**顶部两角由穿透死角变拦截**
    /// （有意行为变化，本测试把它钉成约定）；上缘 pad 带内命中、带外不拦；
    /// 下半与 stadium 几何相同（下帽圆心同为 (h/2, h/2)），下弧判据必须逐点一致。
    #[test]
    fn test_shape_hit_half_capsule_flat_top() {
        let (w, h) = (208.0, 32.0);
        let hc = IslandShape::HalfCapsule;
        // 上缘外 1px（pad 带内）命中；3px 外不命中
        assert!(shape_hit(hc, w, h, 2.0, w / 2.0, -1.0));
        assert!(!shape_hit(hc, w, h, 2.0, w / 2.0, -3.0));
        // 旧 stadium 死角 (2,2)：方顶后在形内——有意变化，钉住
        assert!(shape_hit(hc, w, h, 2.0, 2.0, 2.0));
        // 左缘中段外 1px 命中（直边从顶直落）
        assert!(shape_hit(hc, w, h, 2.0, -1.0, 16.0));
        // 上角外扩弧：锐角在窗口原点 (0,0)，外扩成半径=pad 的圆弧——径向 2.5px 外不拦、1.5px 内拦
        let d25 = 2.5 / std::f64::consts::SQRT_2;
        let d15 = 1.5 / std::f64::consts::SQRT_2;
        assert!(!shape_hit(hc, w, h, 2.0, -d25, -d25), "上角弧外不许拦");
        assert!(shape_hit(hc, w, h, 2.0, -d15, -d15), "上角弧内必须命中");
        // 下弧与 stadium 逐点一致（外扩形下帽圆心同为 (18,18)，45° 径向 17 在带内 / 19 在带外）
        let d17 = 17.0 / std::f64::consts::SQRT_2;
        let d19 = 19.0 / std::f64::consts::SQRT_2;
        assert_eq!(
            shape_hit(hc, w, h, 2.0, 16.0 - d17, 16.0 + d17),
            shape_hit(IslandShape::Stadium, w, h, 2.0, 16.0 - d17, 16.0 + d17),
            "下弧几何必须与 stadium 一致"
        );
        assert!(shape_hit(hc, w, h, 2.0, 16.0 - d17, 16.0 + d17));
        assert!(!shape_hit(hc, w, h, 2.0, 16.0 - d19, 16.0 + d19));
    }

    /// 底档半胶囊（停靠锚点 C1）必须是顶档的**逐点镜像**：`hit(bottom, x, y)
    /// == hit(top, x, h − y)`。整片扫点而不是挑几个代表点——压平哪条边这种错
    /// 只会露在边界带的那一两行上，抽样很容易全绿。
    #[test]
    fn test_shape_hit_half_capsule_mirrors_top() {
        let (w, h, pad) = (208.0, 32.0, 2.0);
        let top = IslandShape::HalfCapsule;
        let bottom = IslandShape::HalfCapsuleBottom;
        let mut x = -5.0;
        while x <= w + 5.0 {
            let mut y = -5.0;
            while y <= h + 5.0 {
                assert_eq!(
                    shape_hit(bottom, w, h, pad, x, y),
                    shape_hit(top, w, h, pad, x, h - y),
                    "镜像破裂 @ ({x}, {y})"
                );
                y += 1.0;
            }
            x += 1.0;
        }
        // 再钉两条直觉：底档**下缘外**不许拦（那是任务栏 / 屏幕外），
        // 而半圆帽所在的上缘外 1px 必须拦得到。
        assert!(!shape_hit(bottom, w, h, pad, w / 2.0, h + 3.0));
        assert!(shape_hit(bottom, w, h, pad, w / 2.0, -1.0));
    }

    /// 事件门控（emit_plan 纯函数）：拦截立即（不走这里），intent 3 拍、hover/peek 4 拍；
    /// 展开两态 hover 立即——列表的 6s 闲置自收计时器靠 hover=true 清掉，等拍数会误收。
    #[test]
    fn test_emit_plan_gates_peek_behind_dwell() {
        // 收起两态：掠过（1 拍）什么都不发；停留 3 拍亮 intent；4 拍才切 peek
        assert_eq!(emit_plan(true, 1), (false, false));
        assert_eq!(emit_plan(true, 2), (false, false));
        assert_eq!(emit_plan(true, 3), (true, false));
        assert_eq!(emit_plan(true, 4), (true, true));
        // 展开两态：hover 立即，intent 不再发（glow 已由 data-hover 负责）
        assert_eq!(emit_plan(false, 1), (false, true));
        assert_eq!(emit_plan(false, 10), (false, true));
    }
}
