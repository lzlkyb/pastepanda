//! 岛的**舞台（stage）**——收起 / 悬停 / 展开 / 输入 / 全清五种窗口尺寸。
//!
//! ## 为什么窗口跟着内容变，而不是固定一个大窗口
//!
//! §4.4 ③曾把「固定大窗口（PILLAR 450×350，内容内部变换）」列为候选 5，
//! 前提是「窗口内、胶囊之外的透明区域能把点击穿透到下层」。展开批落地时
//! 设计稿 §6 已给出另一条路并写死：**窗口尺寸由 Rust 逐帧下达**（一次 `SetWindowPos`
//! 同给尺寸与位置，原子生效），「长出来」的连续感由窗口矩形本身伪造
//! （2026-09-28 两次修订：先是 `set_size` + `set_position` 两条消息造成抖与排队；
//! 改成动画线程直接 send 之后节拍准了，却把窗口甩到 WebView2 绘制前面 1–4 帧，
//! 观感变成「形状/边缘不对」⇒ 现在这次调用投回**主线程队列**执行，见 `apply_frame`）。
//! 这条路的前提不需要探针——窗口永远贴合内容，穿透轮询
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
//! 展开时**钉住停靠那条边**：顶档 y 恒定只向下长，底档底边恒定只向上长
//! （`y = wa.bottom − h` 逐帧重算），x 按新宽度重算。锚点六档见 `todo_island_anchor.rs`。

mod motion;

use motion::SpringMotion;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::todo_island_anchor::AnchorFrame;
use crate::todo_island::WINDOW_LABEL;

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
/// 单位教训见 `todo_island_anchor` 模块头。
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

// 落位公式（旧 `calc_top_center_for`：顶部居中、`y = TOP_MARGIN`）已随「停靠锚点」六档
// 迁到 `todo_island_anchor::calc_anchor_pos`，那条 🔴 单位教训（逻辑 px 与物理 px 不能直接
// 相减，125% 缩放下实测偏右 26px）跟着搬过去了。
// 本文件只负责按当前舞台的 `w` / `h` 逐帧调用它。

/// 切舞台：**窗口尺寸逐帧动画**（2026-09-25 档 3a 修订）。
///
/// ## 为什么不再「一次到位」
///
/// 材质（窗口级 Acrylic）按窗口矩形铺：窗口一次切到新尺寸时，材质立刻铺满整个新矩形，
/// 而 CSS 卡片还要过渡 200–300ms 才长到位——这中间窗口比卡片大出一圈，露出一层玻璃板
/// （浅色主题下就是用户反馈的「白板」）。修法是把动画的**唯一来源**交给窗口：
/// Rust 逐帧插值、**一次 `SetWindowPos` 同时下达尺寸与位置**（见 [`apply_frame`]），
/// CSS 卡片改为永远填满窗口（`inset:0`），两者每帧同步，
/// 玻璃矩形与卡片矩形之间不再存在「差的一圈」。
///
/// ❗ 动画途中重定向：`ANIM_GEN` 作废旧线程，新动画从共享运动状态
/// （`load_motion()`——位置与速度都每步更新）起算，不从旧舞台尺寸、更不从静止起算：
/// 快速连续切换既收敛到最后一个目标，运动又不断（数学在 `motion` 模块）。
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
/// **在飞闸**：主线程手里最多压一次窗口下达。见 `apply_frame` 的队列口径说明。
static DISPATCH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// 上一次下达从「投进队列」到「主线程执行完」的排队时延（纳秒）。只给探针读数。
static DISPATCH_LAT_NS: AtomicU64 = AtomicU64::new(0);
/// 当前逻辑尺寸（动画每步更新；中途重定向的起点，也是 rgn/重定位的依据）。
/// 运动状态 + 代次。代次用于写回仲裁：被作废的旧动画线程醒来时不允许再把
/// 自己的末态写回去（否则新动画接住的是一个已经过时的速度）。
#[derive(Clone, Copy)]
struct MotionSlot {
    gen: u64,
    motion: SpringMotion,
}

static MOTION: Mutex<Option<MotionSlot>> = Mutex::new(None);

/// 读当前运动状态。没跑过动画时 = 停在胶囊末态。
fn load_motion() -> SpringMotion {
    MOTION
        .lock()
        .ok()
        .and_then(|slot| slot.map(|s| s.motion))
        .unwrap_or_else(SpringMotion::pill)
}

/// 写回运动状态；代次比自己旧的写入一律丢弃。
fn store_motion(gen: u64, motion: SpringMotion) {
    if let Ok(mut slot) = MOTION.lock() {
        let fresh = match *slot {
            Some(s) => s.gen <= gen,
            None => true,
        };
        if fresh {
            *slot = Some(MotionSlot { gen, motion });
        }
    }
}

/// 各舞台的动画时长（= 原 CSS transition-duration 表；CSS 侧尺寸过渡已删）。
///
/// U2 2026-09-25 修订：常规路径走**弹簧**（`motion::SpringMotion`，自带自然落定时长，
/// 不看这张表）；本表只剩两个用途——系统「减少动态效果」开启时的回退路径，
/// 以及 CSS 侧其余过渡（颜色/hover）的参考口径。
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

// ===== 弹簧（U2 2026-09-25 修订：位移动变可用一组定参弹簧） =====
//
// 🔴 参数**全库只此一组**（文档 U2 §弹簧判定 1）：k=130、c=16（m=1）→
//    阻尼比 ≈0.70、过冲 ≈4.5%、~500ms 落定。要调手感先改文档再改这里。

/// 弹簧动画的收尾时长（积分落定后由终帧精确落位兜底）。
const SPRING_SETTLE_MS: u64 = 800;


/// 系统「减少动态效果」开了吗（Windows 设置 > 辅助功能 > 视觉效果 > 动画效果）。
///
/// U2 §弹簧判定 4：弹簧必须吃这个开关——开启时回退 [`ease_progress`]（无过冲）。
/// 每次动画起头查一次（SystemParametersInfo 是廉价的注册表读，不值得缓存）。
fn system_animations_disabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::BOOL;
        use windows::Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        };
        let mut enabled = BOOL::default();
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                Some(&mut enabled as *mut BOOL as *mut core::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        };
        ok.is_ok() && !enabled.as_bool()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn animate_window(app: &AppHandle, window: &tauri::WebviewWindow, stage: IslandStage) {
    let gen = ANIM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let (tw, th) = stage_size(stage);
    // 接管当前末态：位置**和速度**一起接住。快速反向（pill→list→pill 连点）时
    // 运动是连续的，而不是每次从静止重新起跳——那一下「先停再走」的卡顿全部
    // 来自旧实现的零速度起步。
    let mut motion = load_motion().retarget(tw, th);
    let start = (motion.w.x, motion.h.x);
    let duration = stage_duration_ms(stage);
    let window = window.clone();
    let app = app.clone();
    // U2 §弹簧判定 4：系统「减少动态效果」开启 → 回退贝塞尔（无过冲）
    let use_spring = !system_animations_disabled();
    // 🔴 循环内一个 Tauri **取值器**都不许调（`scale_factor` / `primary_monitor` / `hwnd`
    // 在 tauri-runtime-wry 里都是 `window_getter!`：投一条消息给主线程再阻塞等回执）。
    // 逐帧问 = 每帧多两次跨线程往返，正是本次要治的病。起头一次取全，缓存进线程。
    let Some(frame) = AnchorFrame::capture(&app, &window) else {
        log::warn!("[TodoIsland] 动画跳过：取不到主屏工作区或窗口尺寸");
        return;
    };
    let scale = frame.scale;
    #[cfg(target_os = "windows")]
    let Some(hwnd) = window.hwnd().ok().map(|h| h.0 as isize) else {
        log::warn!("[TodoIsland] 动画跳过：取不到 hwnd");
        return;
    };
    #[cfg(not(target_os = "windows"))]
    let hwnd = 0_isize;
    // 起始先用**期望值**裁一刀：缩小时胶囊形状立刻出现（不等到动画结束）；
    // 长大时期望 rgn 比当前窗口大 = 不裁、无副作用。终帧再按**下达的那个子像素取整值**精裁。
    // ❗ 长大方向多留 8%：弹簧过冲 ~4.5% 会让窗口**超过**目标尺寸——rgn 若按目标裁，
    //   过冲那几帧会被平口裁掉，弹簧等于白弹（回退贝塞尔时无过冲，8% 也无害）。
    let growing = tw > start.0 || th > start.1;
    let (ew, eh) = expected_phys_size(stage, scale);
    let rgn_phys = if growing {
        ((ew as f64 * 1.08) as i32, (eh as f64 * 1.08) as i32)
    } else {
        (ew, eh)
    };
    apply_stage_region(&window, stage, rgn_phys);
    let probe = std::env::var(crate::todo_island::PROBE_ENV).ok().as_deref() == Some("1");
    std::thread::spawn(move || {
        // ❗ **真实 Δt**，不是固定 16ms。旧实现每步硬喂 `step_s = 0.016` 再
        // `sleep(16ms)`：sleep 本身有粒度、每次系统调用还要花时间，实际帧间隔
        // 20–40ms ⇒ 弹簧的虚拟时间**落后墙钟**（动画被拉成慢动作），而投出去的消息
        // 一旦在主线程排队，之后就是连续回放（「顿一下再窜到位」）。
        // 现在弹簧吃真实经过时间，追不上就**丢帧**（一帧跳多一点）而不是排队补帧。
        // 帧预算 16ms（≈60fps）。2026-09-28 试过按真实刷新率取（本机 100Hz ⇒ 10ms，
        // 实测节拍 66 帧 / Δt 10.7ms），但用户判「形状边缘不如之前」后退回——账见
        // `docs/待办灵动岛-实施方案-2026-09-24.md` §15.5。
        let frame_budget = std::time::Duration::from_millis(16);
        let anim_start = std::time::Instant::now();
        let mut prev = anim_start;
        let mut frames = 0_u32;
        let mut slowest_ms = 0_f64;
        // 探针账：`lat_*` = 一次下达从「投进主线程队列」到「主线程执行完」的排队时延
        // （读的是上一帧的值：本帧刚投，还没跑完）；`dropped` = 被在飞闸丢掉的帧；
        // `discarded_ms` = 因 Δt 钳制被丢掉的虚拟时间（墙钟走了、弹簧没走完 ⇒ 动画被拉长）。
        let mut lat_sum = 0_f64;
        let mut lat_max = 0_f64;
        let mut dropped = 0_u32;
        let mut discarded_ms = 0_f64;
        if use_spring {
            loop {
                if ANIM_GEN.load(Ordering::SeqCst) != gen {
                    return; // 被新动画作废
                }
                let now = std::time::Instant::now();
                let dt_ms = now.duration_since(prev).as_secs_f64() * 1000.0;
                prev = now;
                // 上限 34ms（≈2 帧）：久顿之后不许瞬移——瞬移在观感上是一次闪跳。
                let (w, h) = motion.advance((dt_ms / 1000.0).clamp(0.001, 0.034));
                frames += 1;
                slowest_ms = slowest_ms.max(dt_ms);
                if probe {
                    log::info!(
                        "[TodoIsland][spring] {:.0}ms w={w:.1} h={h:.1} v={:.1} dt={dt_ms:.1} spring=true",
                        anim_start.elapsed().as_secs_f64() * 1000.0,
                        motion.w.v
                    );
                }
                let sent = apply_frame(&app, &window, hwnd, &frame, w, h);
                if probe {
                    if sent {
                        let lat = DISPATCH_LAT_NS.load(Ordering::Relaxed) as f64 / 1e6;
                        lat_sum += lat;
                        lat_max = lat_max.max(lat);
                    } else {
                        dropped += 1;
                    }
                    discarded_ms += (dt_ms - 34.0).max(0.0);
                }
                store_motion(gen, motion);
                // 弹簧：**落定即止**（判据见 motion::SETTLE_*，大行程约 700ms），
                // 不必把 SPRING_SETTLE_MS 的兜底时长跑完。
                if motion.settled() || anim_start.elapsed().as_millis() as u64 >= SPRING_SETTLE_MS {
                    break;
                }
                let spent = prev.elapsed();
                let rest = frame_budget.saturating_sub(spent);
                if !rest.is_zero() {
                    std::thread::sleep(rest);
                }
            }
        } else {
            // 减少动态效果：按舞台时长表现插值，落点精确、无过冲；
            // 速度不参与，所以终态显式清零，别把弹簧末速带给下一次常规动画。
            let total_s = duration as f64 / 1000.0;
            loop {
                if ANIM_GEN.load(Ordering::SeqCst) != gen {
                    return; // 被新动画作废
                }
                let now = std::time::Instant::now();
                let dt_ms = now.duration_since(prev).as_secs_f64() * 1000.0;
                prev = now;
                frames += 1;
                slowest_ms = slowest_ms.max(dt_ms);
                let u = anim_start.elapsed().as_secs_f64() / total_s;
                let p = ease_progress(u);
                let w = start.0 + (tw - start.0) * p;
                let h = start.1 + (th - start.1) * p;
                if probe {
                    log::info!("[TodoIsland][spring] {u:.2} w={w:.1} h={h:.1} dt={dt_ms:.1} spring=false");
                }
                let sent = apply_frame(&app, &window, hwnd, &frame, w, h);
                if probe && !sent {
                    dropped += 1;
                }
                if u >= 1.0 {
                    break;
                }
                let rest = frame_budget.saturating_sub(prev.elapsed());
                if !rest.is_zero() {
                    std::thread::sleep(rest);
                }
            }
        }
        // 终帧精确落位（插值末步可能差亚像素）。❗ 与循环里的帧不同，终帧**不许丢**：
        // 后面没有下一帧会替它补投，丢了岛就停在最后一个中间尺寸上。所以在飞闸没开就重试。
        // ❗ 但重试必须有上限：主线程被弹窗/模态卡住时无限自旋 = 这条线程再也不回来。
        let final_deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while !apply_frame(&app, &window, hwnd, &frame, tw, th) {
            if ANIM_GEN.load(Ordering::SeqCst) != gen || std::time::Instant::now() > final_deadline {
                log::warn!("[TodoIsland] 终帧下达没能在 500ms 内挤进主线程队列，交给 rgn 自愈补正");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // 等这一次真的被主线程执行完再读尺寸：`outer_size` 是阻塞取值器，正常情况下它
        // 排在刚才那条下达后面（同一队列，FIFO）自然拿到新值，但那是队列时序的巧合，
        // 不是契约——这里显式等，读到的才一定是终帧。
        wait_dispatch_settled();
        store_motion(gen, SpringMotion::at(tw, th));
        // 终帧精裁：旧实现在这里无条件 `sleep(120ms)` 再读 `outer_size`——那 120ms 是给
        // 「异步 `set_size` 不知道何时生效」打的补丁，代价就是用户看到的终帧形状 pop。
        // 现在等的不是时间而是**事件**（在飞下达执行完），所以既不会读到旧尺寸，也不会多等。
        // ❗ 仍按实测 `outer_size` 裁，不用下达值：region 活在**窗口矩形**坐标系里，
        //   而 CSS 卡片填的是**客户区**，两者差一个 frame（实测 125% 下 260×40 / 260×47），
        //   实测值才是唯一不会算错的那一份。
        if let Ok(s) = window.outer_size() {
            apply_stage_region(&window, stage, (s.width as i32, s.height as i32));
        }
        if probe {
            let wall_ms = anim_start.elapsed().as_secs_f64() * 1000.0;
            log::info!(
                "[TodoIsland][motion] {stage:?} frames={frames} wall={wall_ms:.0}ms avg={:.1}ms \
                 max={slowest_ms:.1}ms lat_avg={:.2}ms lat_max={lat_max:.2}ms dropped={dropped} \
                 discarded={discarded_ms:.0}ms spring={use_spring} frame={}x{}",
                wall_ms / frames.max(1) as f64,
                lat_sum / frames.max(1) as f64,
                frame.frame_w,
                frame.frame_h
            );
        }
    });
}

/// 一帧的窗口下达：**尺寸与位置在同一次系统调用里生效**，且**投进主线程队列**执行。
///
/// ## 为什么既不是 `set_size`+`set_position`，也不是动画线程直接 `SetWindowPos`
///
/// 查 Tauri 2.11.3：`set_size` / `set_position` 各投一条消息（`send_user_message`），
/// 于是「变大」与「挪位」可能落在相邻两帧上 ⇒ 有一帧「已经变大但还没挪到锚点」，观感是**抖**。
/// 2026-09-28 第一次修法是动画线程直接跨线程 `SetWindowPos`（一次给全四个数，原子），
/// 节拍确实准了（实测 49 帧 / avg 16.6ms / discarded 0），但换来一条更贵的错：
/// **它是把 `WM_WINDOWPOSCHANGED` 直接 send 给属主线程**，绕开了 WebView2 绘制所在的
/// 队列 ⇒ 窗口每帧都跑到内容前面 1–4 帧。逐帧像素实测（`pp-mid2` + 基线 diff）：
/// 窗口 385×186 时画面还是 322×40 的胶囊、窗口 492×312 时画面 376×80，
/// 也就是「先拉宽、迟迟不长高」，终帧才啪地补上——用户判的「视觉边缘/形状不对」就是它。
///
/// 所以本函数保留**一次调用给全四个数**（原子），但把这次调用**投回主线程队列**执行：
/// 缩放与它后面的绘制在同一个队列里排队，窗口不可能超过内容。代价是需要背压，
/// 否则又回到「排队回放」——背压就是在飞闸 `DISPATCH_IN_FLIGHT`：**主线程手里最多压一条**，
/// 追不上时动画线程丢帧（弹簧仍按真实 Δt 前进，所以墙钟时长不变，只是中间尺寸变少）。
///
/// 返回值 = 这一帧**有没有真的投出去**（false = 被在飞闸丢掉，或投递失败）。
/// 终帧必须重试到投出去为止（见调用点），中间帧丢了无所谓。
fn apply_frame(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    hwnd: isize,
    frame: &AnchorFrame,
    w: f64,
    h: f64,
) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        let _ = window;
        let (x, y, cw, ch) = frame.rect(crate::todo_island_anchor::anchor(), w, h);
        // 在飞闸：上一条还没被主线程执行完 ⇒ 这一帧直接丢，不排队。
        if !try_take_dispatch() {
            return false;
        }
        let posted = std::time::Instant::now();
        let sent = app.clone().run_on_main_thread(move || {
            unsafe {
                let _ = SetWindowPos(
                    HWND(hwnd as *mut core::ffi::c_void),
                    HWND(core::ptr::null_mut()),
                    x,
                    y,
                    cw as i32,
                    ch as i32,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            DISPATCH_LAT_NS.store(posted.elapsed().as_nanos() as u64, Ordering::Relaxed);
            release_dispatch();
        });
        if sent.is_err() {
            // 主线程已经不在（退出中）：闸必须打开，否则后续所有帧都被当成「在飞」丢掉
            release_dispatch();
            return false;
        }
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri::LogicalSize;
        let _ = (hwnd, frame);
        let _ = window.set_size(LogicalSize::new(w, h));
        let _ = window.set_position(crate::todo_island_anchor::calc_anchor_pos(app, w, h));
        true
    }
}

/// 在飞闸的开闸尝试。`true` = 本帧可以投；`false` = 主线程手里已经压着一条 ⇒ 丢帧。
/// 这是 F 方案唯一的背压手段：**丢帧，不排队**（排队就是本次要治的「顿一下再窜到位」）。
fn try_take_dispatch() -> bool {
    DISPATCH_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_ok()
}

/// 关闸（下达执行完 / 投递失败）。漏关 = 之后每一帧都被当成「在飞」丢掉，岛冻在原地。
fn release_dispatch() {
    DISPATCH_IN_FLIGHT.store(false, Ordering::Release);
}

/// 等在飞下达被主线程执行完（终帧专用）。上限 200ms：主线程真被卡住时宁可裁早一帧，
/// 下一轮 `reapply_stage_region` 自愈会补正——但正常情况下这就是「下一条队列消息」的耗时。
fn wait_dispatch_settled() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    while DISPATCH_IN_FLIGHT.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

/// 把窗口（**连材质一起**）裁成舞台形状——消除圆角外的方角玻璃（月牙）。
///
/// 探针 G4 实测（rgn-pill.png）：月牙被裁掉、边缘由 CSS 抗锯齿边盖住看不出锯齿。
/// ❗ `phys` 必须是**窗口实际（或即将）具有**的物理尺寸。两个调用时机：
/// - 动画**起始**：传舞台表 × scale 的期望值（长大时 rgn 比窗口大 = 不裁、无副作用；
///   缩小时胶囊形状立刻出现）；
/// - 动画**终帧**：传 `AnchorFrame::rect` 算出的**下达值**（尺寸是我们自己按物理像素
///   定的，不必回读 `outer_size`；原先「sleep 120ms 再读实测值」是异步 `set_size`
///   路径的补丁，代价是终帧形状 pop，2026-09-28 随单次 `SetWindowPos` 一起删掉）。
///   历史翻过的车：读未落定的旧尺寸会把半径算成退化值（胶囊舞台上留着 List 的
///   15px 圆角裁剪）。
///
/// rgn 的所有权交给系统（MSDN：SetWindowRgn 后由系统管理）。仅 Windows 有意义。
pub fn apply_stage_region(window: &tauri::WebviewWindow, stage: IslandStage, phys: (i32, i32)) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Gdi::{CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn};
        // ⚠ tauri 的 hwnd() 返回它自己 windows 依赖（0.61）的 HWND，与本项目 0.58 不同类型，
        //   按裸指针重建（探针 hit_test 里 `own.0 as isize` 是同一版本差的证例）。
        let Ok(raw) = window.hwnd() else { return };
        let hwnd = windows::Win32::Foundation::HWND(raw.0 as isize as *mut core::ffi::c_void);
        let Ok(scale) = window.scale_factor() else { return };
        // 收起两态（pill/clear）= **半胶囊**（吸附形变设计稿 §3②）：贴屏幕那条边压平
        // （顶档 r_top=0 / 底档镜像 r_card=0），另一条边 = 高度一半的半圆帽
        // （floor(h/2)，floor 让 GDI 弧落在 CSS 弧内侧的既有口径）。peek 仍是满胶囊；
        // 展开两态 = 四角统一 12px 圆角卡。
        // ❗ 两类形状都走**逐行像素中心**多边形 region（build_stadium_region /
        //   build_top_rounded_region）。历史教训（2026-09-25 用户两轮实拍）：
        //   CreateRoundRectRgn 只有统一半径、且弧形与 CSS 正圆对不上（胶囊 r=round(23.5)=24
        //   vs CSS 23.5，两帽整圈裸材质月牙；展开态 GDI 角「方」偏差 2–5px）——
        //   任何「拿 GDI 形状去贴 CSS」的路线都已被实测否决，勿回改。
        // radius 仅是 GDI 兜底路径（多边形拼装失败时）的参数；收起三态取 floor（23<23.5），
        // GDI 弧才落在 CSS 弧**内侧**——外扩哪怕 0.5px 就是一片月牙。
        //   ❗ 兜底形态对半胶囊也退**统一半径 floor(h/2) 的胶囊**（比 12px 整卡在轮廓上
        //     更接近目标形状，且参数来源与 stadium 完全一致，兜底路径零改动）。
        let radius = match stage {
            IslandStage::Pill | IslandStage::Clear | IslandStage::Peek => {
                (phys.1 as f64 / 2.0).floor() as i32
            }
            IslandStage::List | IslandStage::Compose => (12.0 * scale).round() as i32,
        };
        let hrgn = unsafe { CreateRoundRectRgn(0, 0, phys.0 + 1, phys.1 + 1, radius, radius) };
        if hrgn.is_invalid() {
            log::warn!("[TodoIsland] CreateRoundRectRgn 失败，本舞台保留矩形窗口（月牙可见）");
            return;
        }
        let hrgn = match stage {
            IslandStage::Peek => {
                // ❗ 传实测 w/h 本身（**不 +1**）：+1 是 CreateRoundRectRgn 的半开区间口径，
                //   逐行像素判据按像素下标 0..w-1 算，多 1 会把最右/最下行多裁出一列
                let merged = unsafe { CreateRectRgn(0, 0, 0, 0) };
                let ok = unsafe { build_stadium_region(merged, phys.0, phys.1) };
                if ok {
                    let _ = unsafe { DeleteObject(hrgn) };
                    merged
                } else {
                    let _ = unsafe { DeleteObject(merged) };
                    hrgn // 拼装失败退回 GDI 胶囊：可能有 ≤1px 材质细缝，好过整窗不裁
                }
            }
            // 吸附形变（设计稿 §3②）：停靠两态**贴屏幕那条边压平**（半径 0）、
            // 另一条边 = 半圆帽。顶档压上缘（r_top=0），底档镜像压下缘（r_card=0）——
            // 拼装走 build_top_rounded_region 的双半径能力，**零新增拼装代码**。
            IslandStage::Pill | IslandStage::Clear => {
                let flat_bottom = crate::todo_island_anchor::anchor().is_bottom();
                let (r_card, r_top) = if flat_bottom {
                    (0, radius)
                } else {
                    (radius, 0)
                };
                let merged = unsafe { CreateRectRgn(0, 0, 0, 0) };
                let ok = unsafe { build_top_rounded_region(merged, phys.0, phys.1, r_card, r_top) };
                if ok {
                    let _ = unsafe { DeleteObject(hrgn) };
                    merged
                } else {
                    let _ = unsafe { DeleteObject(merged) };
                    hrgn // 兜底 = 统一半径胶囊（floor(h/2)），轮廓最接近半胶囊
                }
            }
            IslandStage::List | IslandStage::Compose => {
                // B 方案：四角同半径（设计稿目标观感是 12px，不是旧的顶 8 / 底 12）
                let r_top = radius;
                let merged = unsafe { CreateRectRgn(0, 0, 0, 0) };
                let ok = unsafe { build_top_rounded_region(merged, phys.0, phys.1, radius, r_top) };
                if ok {
                    let _ = unsafe { DeleteObject(hrgn) };
                    merged
                } else {
                    let _ = unsafe { DeleteObject(merged) };
                    hrgn // 拼装失败退回统一 12：顶角可能有 1–2px 材质细缝，好过整窗不裁
                }
            }
        };
        let applied = unsafe { SetWindowRgn(hwnd, hrgn, true) };
        // ❗ 永久诊断：月牙问题的三条施加路径都可能缺席（on_page_load 实测常不触发、
        //   动画终帧会被新动画作废）——没有这行日志，「方角玻璃」无从排查。
        log::info!(
            "[TodoIsland] rgn {stage:?} phys={phys:?} radius={radius} dock={} applied={}",
            crate::todo_island_anchor::anchor().as_str(),
            applied != 0
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, stage, phys);
    }
}

/// 舞台表 × scale 的期望物理尺寸（动画起始时的 rgn 近似值用）。
fn expected_phys_size(stage: IslandStage, scale: f64) -> (i32, i32) {
    let (lw, lh) = stage_size(stage);
    ((lw * scale).round() as i32, (lh * scale).round() as i32)
}

/// 生成「顶部圆角 r_top、其余圆角 r_card」的窗口区域到 `dst`（仅 Windows）。
///
/// ❗ 逐行**像素中心判据**：像素中心落在 CSS 圆内才进 region。region 与 CSS 弧的分歧
/// 被压到「覆盖率 <50% 的抗锯齿像素」级（几何偏差 ≤0.5px）——**整像素裸材质月牙
/// 机制上不可能再出现**（2026-09-25 用户两轮实拍后，胶囊与展开卡统一到本规则）。
/// 历史：`CreateRoundRectRgn` 只有统一半径且弧形与 CSS 正圆对不上（胶囊 r24 vs CSS
/// 23.5、两帽整圈月牙）；第一版多边形按**角度采样**，本版改逐行中点规则——
/// 更准（无弦差）且没有「屏幕 Y 轴方向」「ALTERNATE 自交」那类采样期踩坑。
/// 贴合性由 `test_top_rounded_region_tracks_css_arc` /
/// `test_stadium_region_hugs_css_cap` 永久钉住。
///
/// 返回 false = GDI 调用失败（调用方退回统一圆角整卡）。
#[cfg(target_os = "windows")]
unsafe fn build_top_rounded_region(
    dst: windows::Win32::Graphics::Gdi::HRGN,
    w: i32,
    h: i32,
    r_card: i32,
    r_top: i32,
) -> bool {
    use windows::Win32::Foundation::POINT;
    let (wf, hf, rc, rt) = (w as f64, h as f64, r_card as f64, r_top as f64);
    let mut left = Vec::with_capacity(h as usize);
    let mut right = Vec::with_capacity(h as usize);
    for y in 0..h {
        // 该行的 CSS 左/右边界（物理坐标）：顶角区贴 r_top 圆、底角区贴 r_card 圆、中段直边
        let yc = y as f64 + 0.5;
        let (xl, xr) = if yc < rt {
            let d = (rt * rt - (rt - yc) * (rt - yc)).max(0.0).sqrt();
            (rt - d, wf - rt + d)
        } else if yc > hf - rc {
            let d = (rc * rc - (yc - (hf - rc)) * (yc - (hf - rc))).max(0.0).sqrt();
            (rc - d, wf - rc + d)
        } else {
            (0.0, wf)
        };
        // 像素 x 进 region ⇔ 中心 x+0.5 ∈ [xl, xr]。⚠ GDI region 扫描线**左含右排**：
        // 左顶点=含、右顶点=排（test_stadium 实测钉住），所以右顶点要 floor+1
        left.push(POINT { x: (xl - 0.5).ceil().max(0.0) as i32, y });
        right.push(POINT { x: ((xr - 0.5).floor() + 1.0).min(wf) as i32, y });
    }
    // ⚠ GDI 多边形转 region 连**下边界也排外**（实测：顶点到 y=h−1 时 rgnbox 高度少 1、
    //   窗口最底行整行透明）——补一行 y=h 的重复顶点，让「被排外的底边」落到窗外。
    pad_bottom_row(&mut left, &mut right, h);
    fill_row_polygon(dst, left, right)
}

/// 胶囊（stadium）：CSS 999px 圆角 = **高度一半**的半圆帽（左右帽 + 上下直边）。
/// 同款逐行像素中心判据（理由见 `build_top_rounded_region`——胶囊态月牙 2026-09-25
/// 用户实拍：CreateRoundRectRgn r=round(47/2)=24 vs CSS 23.5，两帽整圈裸材质）。
#[cfg(target_os = "windows")]
unsafe fn build_stadium_region(
    dst: windows::Win32::Graphics::Gdi::HRGN,
    w: i32,
    h: i32,
) -> bool {
    use windows::Win32::Foundation::POINT;
    let r = h as f64 / 2.0;
    let mut left = Vec::with_capacity(h as usize);
    let mut right = Vec::with_capacity(h as usize);
    for y in 0..h {
        let dy = (y as f64 + 0.5) - r;
        let d = (r * r - dy * dy).max(0.0).sqrt();
        left.push(POINT { x: (r - d - 0.5).ceil().max(0.0) as i32, y });
        // ⚠ GDI region 扫描线左含右排——右顶点 floor+1（理由见 build_top_rounded_region）
        right.push(POINT {
            x: ((w as f64 - r + d - 0.5).floor() + 1.0).min(w as f64) as i32,
            y,
        });
    }
    // ⚠ 下边界排外——同 build_top_rounded_region 的补行处理
    pad_bottom_row(&mut left, &mut right, h);
    fill_row_polygon(dst, left, right)
}

/// 行边界多边形的「底边垫行」：把最后一行的左右顶点在 y=h 复制一份。
/// GDI 把多边形的下边界当排外边（同 RECT bottom），顶点只到 h−1 时最底行整行被裁。
#[cfg(target_os = "windows")]
fn pad_bottom_row(
    left: &mut Vec<windows::Win32::Foundation::POINT>,
    right: &mut Vec<windows::Win32::Foundation::POINT>,
    h: i32,
) {
    use windows::Win32::Foundation::POINT;
    let n = left.len();
    if n == 0 || n != right.len() {
        return;
    }
    let l = left[n - 1];
    let r = right[n - 1];
    left.push(POINT { y: h, ..l });
    right.push(POINT { y: h, ..r });
}

/// 行边界 → HRGN：左界自上而下、右界自下而上，ALTERNATE 填充后拷给 `dst`。
#[cfg(target_os = "windows")]
unsafe fn fill_row_polygon(
    dst: windows::Win32::Graphics::Gdi::HRGN,
    left: Vec<windows::Win32::Foundation::POINT>,
    right: Vec<windows::Win32::Foundation::POINT>,
) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreatePolygonRgn, DeleteObject, ALTERNATE, GDI_REGION_TYPE, RGN_COPY,
    };
    let mut pts: Vec<POINT> = left;
    pts.extend(right.into_iter().rev());
    let poly = unsafe { CreatePolygonRgn(&pts, ALTERNATE) };
    if poly.is_invalid() {
        return false;
    }
    let ok = unsafe { CombineRgn(dst, poly, None, RGN_COPY) != GDI_REGION_TYPE(0) };
    let _ = unsafe { DeleteObject(poly) };
    ok
}

/// rgn **自愈重放**：按当前舞台 + 落定后的实测尺寸重裁一次（show() 后延迟调用）。
///
/// 形状裁剪有三个施加时机（on_page_load / 动画起始 / 动画终帧），实测**前两个都不可靠**：
/// on_page_load 常常不触发（create() 的兜底 WARN），动画终帧会被新动画作废——
/// 任何一次缺席，岛就以方角玻璃示人（2026-09-25 用户实测月牙复发，本函数因此存在）。
/// 幂等且廉价：show() 是低频路径（常驻可见性只在笔记写路径变化），重放一次
/// SetWindowRgn 只是小型重绘。
pub fn reapply_stage_region(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(crate::todo_island::WINDOW_LABEL) else {
        return;
    };
    std::thread::spawn(move || {
        // 等 set_size/set_position 落定（同动画终帧的 120ms 口径），避免读到未落定尺寸
        std::thread::sleep(std::time::Duration::from_millis(120));
        let Ok(s) = window.outer_size() else { return };
        // ❗ 尺寸未落定时 outer_size 可能是 (0,0)——裁成 1×1 = 整岛消失（02:03 实测教训）
        if s.width <= 2 || s.height <= 2 {
            log::warn!("[TodoIsland] rgn 重放跳过：outer_size 未落定 ({}×{})", s.width, s.height);
            return;
        }
        apply_stage_region(&window, current_stage(), (s.width as i32, s.height as i32));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- 弹簧（U2 2026-09-25 修订：定参 k=130/c=16，判定 1 的守卫） -----

    #[test]
    fn test_spring_overshoot_and_settle() {
        // 首帧钉死 0
        assert_eq!(motion::SpringAxis::progress(0.0), 0.0);
        // 过冲在 3%–6% 之间（设计目标 ~4.5%）：峰值必须存在且受控
        let peak = (0..800)
            .map(|i| motion::SpringAxis::progress(i as f64 / 1000.0))
            .fold(f64::MIN, f64::max);
        assert!(peak > 1.03 && peak < 1.06, "过冲 {peak} 不在 3%–6%");
        // 800ms 落定到 0.3% 内（420px 上 ≈1px，终帧精确落位兜底掉）
        let tail = motion::SpringAxis::progress(0.8);
        assert!((tail - 1.0).abs() < 0.003, "800ms 未落定：{tail}");
        assert!((motion::SpringAxis::progress(1.0) - 1.0).abs() < 0.001);
        // 全程不为负（欠阻尼从 0 弹向 1 不会反向穿零；采样到 800ms 与 SPRING_SETTLE_MS 同步）
        for i in 1..800 {
            assert!(motion::SpringAxis::progress(i as f64 / 1000.0) > 0.0, "t={i}ms 出现负值");
        }
    }

    #[test]
    fn test_spring_params_are_the_single_set() {
        // 判定 1 的机器守卫：有人改了 motion 里的 k/c，过冲特征立刻变——
        // 本测试与文档数值互相钉死（改参数先改文档 U2 §弹簧，两条一起动）。
        let k = 130.0_f64;
        let c = 16.0_f64;
        let w0 = k.sqrt();
        let zeta = c / (2.0 * w0);
        let overshoot = (-zeta * std::f64::consts::PI / (1.0 - zeta * zeta).sqrt()).exp();
        assert!((overshoot - 0.045).abs() < 0.005, "设计过冲 4.5%，实推 {overshoot}");
    }

    /// region 必须贴住 CSS 圆弧 **±1px**——这是「展开态顶角月牙」的几何判据：
    /// region 比 CSS 碎（边界 x 更小）→ 弧外露出材质月牙；比 CSS 紧（x 更大）→
    /// 背景咬进卡片。GDI 纯 region 数学，不需要窗口（仅 Windows 跑）。
    #[cfg(target_os = "windows")]
    #[test]
    fn test_top_rounded_region_tracks_css_arc() {
        use windows::Win32::Graphics::Gdi::{CreateRectRgn, PtInRegion, DeleteObject};
        // list 终帧物理尺寸 × scale 1.25；B 方案起四角同半径（12px × 1.25 = 15）
        let (w, h, r_card, r_top) = (526, 301, 15, 15);
        let dst = unsafe { CreateRectRgn(0, 0, 0, 0) };
        assert!(unsafe { build_top_rounded_region(dst, w, h, r_card, r_top) });
        // y=0 是多边形边界行，PtInRegion 对边界点不可靠——从 y=1 扫到角弧结束
        for y in 1..r_top {
            let mut first = -1;
            for x in 0..(r_card * 2) {
                if unsafe { PtInRegion(dst, x, y) }.as_bool() {
                    first = x;
                    break;
                }
            }
            assert!(first >= 0, "y={y} 整行被裁——背景咬边");
            // CSS 判据（像素中心）：x 进 region ⇔ x ≥ 顶角圆左界 − 0.5。
            // ceil/floor 取整使偏差**单侧**：左界 ∈ [bound, bound+1)、右界 ∈ (bound−1, bound]，
            // 外扩超过 ε 或多咬 1px 都失败。
            let yc = y as f64 + 0.5;
            let dy = r_top as f64 - yc;
            let xl = r_top as f64 - (r_top as f64 * r_top as f64 - dy * dy).max(0.0).sqrt();
            let bound = xl - 0.5;
            let diff = first as f64 - bound;
            assert!(
                diff >= -0.01 && diff <= 1.01,
                "y={y} region 左界 {first} 偏离 CSS 判据 {bound:.2} 超限（材质月牙或背景咬边）"
            );
        }
        // 直边衔接：y ∈ [r_top, r_card] 处 x=0 必须在 region 内（桥接矩形覆盖）
        for y in r_top..=r_card {
            assert!(unsafe { PtInRegion(dst, 0, y) }.as_bool(), "y={y} 边缘缺口（桥接失效）");
        }
        // 底角同半径（B 方案四角统一 12px）：底部弧线也必须贴住 CSS 圆，
        // 否则「已统一圆角」只活在 CSS 里，rgn 还按旧的非对称形状裁。
        for y in (h - r_card)..h - 1 {
            let mut first = -1;
            for x in 0..(r_card * 2) {
                if unsafe { PtInRegion(dst, x, y) }.as_bool() {
                    first = x;
                    break;
                }
            }
            assert!(first >= 0, "y={y} 底角整行被裁——背景咬边");
            let yc = y as f64 + 0.5;
            // ❗ 底角圆心在 (r_card, h − r_card)，所以「到圆心的 y 距离」是
            //    yc − (h − r_card)，**不是** h − yc：后者是到「下边缘」的距离，
            //    等于把圆心挪到 y=h 上，于是要求最后一行左界退到 0 ——
            //    那正是「底角不圆」的形状（y=h−1 行应收到 ≈ r_card 附近）。
            //    写法照顶角判据的镜像即可：顶角 dy = r_top − yc、底角 dy = yc − (h − r_card)。
            let dy = yc - (h as f64 - r_card as f64);
            let xl = r_card as f64 - (r_card as f64 * r_card as f64 - dy * dy).max(0.0).sqrt();
            let bound = xl - 0.5;
            let diff = first as f64 - bound;
            assert!(
                diff >= -0.01 && diff <= 1.01,
                "y={y} 底角 region 左界 {first} 偏离 CSS 判据 {bound:.2} 超限"
            );
        }
        // ❗ 上下边界行 + rgnbox 整窗（下边界排外守卫，同 test_stadium_region_hugs_css_cap）
        for x in [w / 2 - 1, w / 2, w / 2 + 1] {
            assert!(unsafe { PtInRegion(dst, x, 0) }.as_bool(), "顶行 ({x},0) 缺口");
            assert!(unsafe { PtInRegion(dst, x, h - 1) }.as_bool(), "底行 ({x},{}) 缺口", h - 1);
        }
        let mut rb = windows::Win32::Foundation::RECT::default();
        unsafe { windows::Win32::Graphics::Gdi::GetRgnBox(dst, &mut rb) };
        assert_eq!((rb.left, rb.top, rb.right, rb.bottom), (0, 0, w, h), "rgnbox 不是整窗");
        let _ = unsafe { DeleteObject(dst) };
    }

    /// 胶囊 region 必须贴住 CSS 半圆帽（圆心 (h/2, h/2)、半径 h/2）——判据按
    /// **像素中心**：每个进 region 的像素中心都在 CSS 圆内、每个中心在圆内的像素
    /// 都在 region 里（偏差 >0.5px 即失败）。外扩 = 裸材质月牙（2026-09-25 实拍），
    /// 多收 = 背景咬边。GDI 纯 region 数学（仅 Windows 跑）。
    #[cfg(target_os = "windows")]
    #[test]
    fn test_stadium_region_hugs_css_cap() {
        use windows::Win32::Graphics::Gdi::{CreateRectRgn, PtInRegion, DeleteObject};
        let (w, h) = (260, 47); // pill 终帧物理尺寸（scale 1.25）
        let r = h as f64 / 2.0;
        let dst = unsafe { CreateRectRgn(0, 0, 0, 0) };
        assert!(unsafe { build_stadium_region(dst, w, h) });
        for y in 1..h - 1 {
            // 左帽：region 内最左像素
            let mut first = -1;
            for x in 0..(r as i32 + 2) {
                if unsafe { PtInRegion(dst, x, y) }.as_bool() {
                    first = x;
                    break;
                }
            }
            assert!(first >= 0, "y={y} 整行被裁——背景咬边");
            // CSS 判据：像素 x 的中心 (x+0.5, y+0.5) 在帽圆内 ⇔ x ≥ r−√(r²−dy²)−0.5。
            // ceil/floor 取整使偏差**单侧**（左 ∈ [bound, bound+1)、右 ∈ (bound−1, bound]），
            // 外扩超 ε = 月牙、多咬超 1px = 吃边，都失败。
            let dy = (y as f64 + 0.5) - r;
            let halfw = (r * r - dy * dy).max(0.0).sqrt();
            let bound = r - halfw - 0.5;
            let diff = first as f64 - bound;
            assert!(
                diff >= -0.01 && diff <= 1.01,
                "y={y} region 左界 {first} 偏离 CSS 判据 {bound:.2} 超限（月牙或咬边）"
            );
            // 右帽：region 内最右像素
            let mut last = -1;
            for x in (w - r as i32 - 2)..w {
                if unsafe { PtInRegion(dst, x, y) }.as_bool() {
                    last = x;
                }
            }
            let rbound = w as f64 - r + halfw - 0.5;
            let rdiff = last as f64 - rbound;
            assert!(
                rdiff <= 0.01 && rdiff >= -1.01,
                "y={y} region 右界 {last} 偏离 CSS 判据 {rbound:.2} 超限"
            );
        }
        // 中段行必须全程覆盖（左右帽之间是直边）
        let mid = h / 2;
        assert!(unsafe { PtInRegion(dst, 0, mid) }.as_bool(), "中行左端缺口");
        assert!(unsafe { PtInRegion(dst, w - 1, mid) }.as_bool(), "中行右端缺口");
        // ❗ 上下边界行也必须在 region 里：GDI 多边形转 region 下边界排外（顶点只到
        //   y=h−1 时最底行整行被裁，实测 rgnbox 高度少 1）——pad_bottom_row 的守卫
        for x in [w / 2 - 1, w / 2, w / 2 + 1] {
            assert!(unsafe { PtInRegion(dst, x, 0) }.as_bool(), "顶行 ({x},0) 缺口");
            assert!(unsafe { PtInRegion(dst, x, h - 1) }.as_bool(), "底行 ({x},{}) 缺口", h - 1);
        }
        // rgnbox 必须正好是整窗（(0,0)-(w,h)，右/下为排外口径）
        let mut rb = windows::Win32::Foundation::RECT::default();
        unsafe { windows::Win32::Graphics::Gdi::GetRgnBox(dst, &mut rb) };
        assert_eq!((rb.left, rb.top, rb.right, rb.bottom), (0, 0, w, h), "rgnbox 不是整窗");
        let _ = unsafe { DeleteObject(dst) };
    }

    /// 半胶囊 region（吸附形变设计稿 §3②）：上缘**满宽压平**（r_top=0）、下弧贴住 CSS 半圆帽。
    /// 判据与 stadium 同款（像素中心、偏差单侧 ≤1px）；顶行满宽是「方顶」的关键判据——
    /// rgn 若仍按胶囊裁，顶缘两角会透出壁纸缝，CSS 方角与 rgn 错配。
    #[cfg(target_os = "windows")]
    #[test]
    fn test_half_capsule_region_square_top_round_bottom() {
        use windows::Win32::Graphics::Gdi::{CreateRectRgn, PtInRegion, DeleteObject};
        let (w, h) = (260, 47); // pill 终帧物理尺寸（scale 1.25）
        let r_card = h / 2; // 23（floor，与 stadium 兜底同口径）
        let dst = unsafe { CreateRectRgn(0, 0, 0, 0) };
        assert!(unsafe { build_top_rounded_region(dst, w, h, r_card, 0) });
        // 直边区（y ∈ [1, h−r_card)）：左右缘满宽——上缘压平、两侧从顶直落
        for y in 1..(h - r_card) {
            assert!(unsafe { PtInRegion(dst, 0, y) }.as_bool(), "y={y} 左缘缺口（顶未压平）");
            assert!(unsafe { PtInRegion(dst, w - 1, y) }.as_bool(), "y={y} 右缘缺口");
        }
        // 底弧：与 CSS 半圆帽（圆心 (r_card, h−r_card)）贴合，偏差单侧 ≤1px
        for y in (h - r_card)..h - 1 {
            let mut first = -1;
            for x in 0..(r_card * 2) {
                if unsafe { PtInRegion(dst, x, y) }.as_bool() {
                    first = x;
                    break;
                }
            }
            assert!(first >= 0, "y={y} 底角整行被裁——背景咬边");
            let yc = y as f64 + 0.5;
            let dy = yc - (h as f64 - r_card as f64);
            let xl = r_card as f64 - (r_card as f64 * r_card as f64 - dy * dy).max(0.0).sqrt();
            let bound = xl - 0.5;
            let diff = first as f64 - bound;
            assert!(
                diff >= -0.01 && diff <= 1.01,
                "y={y} 底弧左界 {first} 偏离 CSS 判据 {bound:.2} 超限"
            );
        }
        // rgnbox 整窗（下边界排外守卫同款）
        let mut rb = windows::Win32::Foundation::RECT::default();
        unsafe { windows::Win32::Graphics::Gdi::GetRgnBox(dst, &mut rb) };
        assert_eq!((rb.left, rb.top, rb.right, rb.bottom), (0, 0, w, h), "rgnbox 不是整窗");
        let _ = unsafe { DeleteObject(dst) };
    }

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

    /// 在飞闸守卫：背压的口径是**丢帧不排队**，所以「一条在飞时第二条必须拿不到闸」，
    /// 而关闸后必须能重新拿——漏关闸（投递失败分支）会让岛永久冻在最后一个尺寸上。
    #[test]
    fn test_dispatch_gate_is_single_flight() {
        release_dispatch();
        assert!(try_take_dispatch(), "空闸必须能开");
        assert!(!try_take_dispatch(), "在飞时第二条必须被丢掉（不许排队回放）");
        assert!(!try_take_dispatch(), "连续尝试同样必须被挡");
        release_dispatch();
        assert!(try_take_dispatch(), "关闸后必须重新可投");
        release_dispatch();
    }
}
