//! 剪贴板栈浮标（Stack HUD）—— 栈模式期间承载全部反馈的独立无焦点小窗。
//!
//! 栈是无窗口热键操作，用户视线在**别的应用**里，而栈的全部反馈都渲染在主窗口
//! webview 里。本模块把 `longshot-status` 跑通的「独立状态小窗」范式搬到栈上。
//! 范式与通用坑沉淀在 skill `tauri-floating-hud-window`。
//!
//! ## 窗口能力组合（缺一项就有一类 bug）
//!
//! | 能力 | 缺了会怎样 |
//! |---|---|
//! | `focused(false)` | **最严重**：抢焦点后用户的下一个 `Ctrl+V` 打进 HUD，而不是目标应用 |
//! | `always_on_top` | 被目标应用盖住，等于没显示 |
//! | `skip_taskbar` | 任务栏多出一个幽灵窗口，用户困惑 |
//! | `shadow(false)` | 系统阴影跟着圆角走，出现方形暗角 |
//! | `transparent(true)` | 圆角外是白底方块 |
//! | `set_ignore_cursor_events(true)` | 挡住用户对目标应用的点击，比它解决的问题更糟 |
//!
//! ## ❗ 落地时必须同时改的宿主判据
//!
//! `paste_engine.rs::any_own_window_visible()` 判「任一自身窗口可见」，加一个
//! 常驻可见的 HUD 会让它恒真 ⇒ 陈旧目标被无限续命。本模块 `WINDOW_LABEL`
//! 必须与其 `TOOL_WINDOW_LABELS` 一致（有守卫单测钉着）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};

/// 窗口标签。
///
/// 🔴 必须与 `paste_engine.rs::PasteEngine::TOOL_WINDOW_LABELS` 里的一致 ——
/// 不一致的话 HUD 会污染「本应用是否有窗口可见」的判据，把偶发的陈旧目标续命
/// 变成必然。
pub const WINDOW_LABEL: &str = "stack-hud";

/// HUD 逻辑尺寸。与 `StackHud.module.css` 的 `.root`（`inset:0` 铺满窗口）是同一份账，
/// 改宽度必须同步 CSS 注释里的尺寸说明。高度账：
/// padding 8×2 + 主行 15 + gap 2 + 预览 15 + gap 2 + 副行 15 = 65。
/// 宽度 208→240：放得下主行右侧进度徽章与更长的应用名。
pub const HUD_W: f64 = 240.0;
/// 高度账（与 `StackHud.module.css` `.root` 是同一份，改一处必须同步另一处）：
/// padding 8×2 + 三行 15×3 + 行距 2×2 = 65（预览行加入后 48 → 65）。
pub const HUD_H: f64 = 65.0;

/// 状态广播事件名（Rust → HUD webview）。
pub const EVENT_UPDATE: &str = "stack-hud-update";
/// 「窗口已显示」事件名。HUD 前端收到后播入场动画、重置空闲淡化计时。
pub const EVENT_SHOWN: &str = "stack-hud-shown";
/// 「窗口已挪到新位置」事件名。载荷 `{ dx, dy }` 为 CSS 像素位移（旧位置 − 新位置），
/// 前端据此把内容从旧位滑入新位 —— 原生窗口 `set_position` 是瞬时的，滑入只能靠内容层伪造。
pub const EVENT_REPOSITION: &str = "stack-hud-repositioned";

/// 跟随轮询间隔（ms）。与 UIA 缓存解耦：轮询走 `focused_control_rect_fresh`。
/// 450ms：用户 Tab 后半秒内浮标跟上，又不至于把 COM 查询做成高频活。
const FOLLOW_POLL_MS: u64 = 450;
/// 位移小于该物理像素数不算「挪了」—— 吃掉 UIA 取整抖动，避免每 tick 都播动画。
const FOLLOW_MIN_DELTA: i32 = 4;
/// 滑入动画位移上限（CSS px）。目标窗口跨大半屏时别把内容甩飞。
const SETTLE_CLAMP_CSS: f64 = 120.0;

/// HUD 状态快照。
///
/// HUD 是**独立的 JS 上下文**：主窗口的 zustand store、`app-toast` DOM 事件、
/// 任何主窗口内的状态，它一个都拿不到。状态只能经 Rust 广播过来，
/// 而 `hudBridge.ts` 是**唯一**的推送出口 —— 两个地方各推一次，早晚会漂移出
/// 「HUD 显示 A、实际做了 B」。
/// 本轮粘贴进度（主行右侧徽章）。`serde(default)` 兼容旧报文。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackHudProgress {
    /// 已成功粘贴条数
    pub done: usize,
    /// 本轮总条数（收集数与已粘贴+剩余取 max，避免截断导致分母虚低）
    pub total: usize,
    /// 覆盖徽章文案（如循环态的「第 2 轮」）。`None` = 渲染 `done/total`。
    /// `serde(default)`：旧前端报文没有这个字段，缺了不能整份状态反序列化失败。
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackHudState {
    /// 阶段：`collecting` 收集中 / `success` 已粘贴 / `error` 失败 / `done` 全部完毕
    pub phase: String,
    /// 栈内剩余条数
    pub count: usize,
    /// 目标应用可读名。**必须来自粘贴引擎的同一次解析**（见 `foreground_app` 的注释）
    pub target: Option<String>,
    /// 副行提示（覆盖默认文案）。`None` 表示由 `phase` 推导
    pub hint: Option<String>,
    /// 下一条要粘贴的内容预览（`stackItems[0]`，主窗口侧 `hudBridge.ts` 生成）。
    /// `None` = 栈空，浮标不渲染预览行。
    /// `serde(default)`：与旧快照/旧前端的报文兼容 —— 字段缺失当 `None`，
    /// 不会让整份状态反序列化失败。
    #[serde(default)]
    pub next: Option<String>,
    /// 粘贴热键（展示用，如 `Ctrl+Alt+P`）
    pub hotkey: String,
    /// 粘贴进度徽章；`None` = 不渲染（如 done 终态）
    #[serde(default)]
    pub progress: Option<StackHudProgress>,
    /// 锚点类型：`control` 输入框 / `window` 窗口 / `cursor` 光标。
    /// 由 Rust 在 `emit_state` 时按最近一次 `calc_position` 注入；前端据此决定是否画方向尾。
    #[serde(default)]
    pub anchor_kind: Option<String>,
}

impl Default for StackHudState {
    fn default() -> Self {
        Self {
            phase: "collecting".to_string(),
            count: 0,
            target: None,
            hint: None,
            next: None,
            hotkey: "Ctrl+Alt+P".to_string(),
            progress: None,
            anchor_kind: None,
        }
    }
}

/// HUD 最近一次状态快照。
///
/// 存在的理由是一个时序问题：窗口**首次**创建时，后端 `emit` 可能早于
/// webview 的 JS 就绪，事件就丢了 —— 表现为 HUD 首帧空白。所以后端留一份，
/// HUD 前端 mount 时主动拉一次。
#[derive(Default)]
pub struct HudStateCache(pub std::sync::Mutex<Option<StackHudState>>);

// ===== 定位 =====
//
// 纯逻辑在 `stack_hud_pos.rs`（可单测）；本节只做系统调用与组装：
// 锚点矩形（前台窗口）→ workarea → 落位，兜底退回光标候选。

use crate::stack_hud_pos::{
    anchor_pos, can_anchor_at_cursor, control_anchor_pos, pick_pos, should_follow, WorkArea,
    ANCHOR_CONTROL, ANCHOR_CURSOR, ANCHOR_CURSOR_WINDOW, ANCHOR_NONE, ANCHOR_WINDOW,
};

/// 最近一次定位用的锚点类型（取值见 `stack_hud_pos::ANCHOR_*`）。
/// 两个消费方：
/// 1. `emit_state` 读它写入 `StackHudState.anchor_kind`，前端据此决定是否画方向尾；
/// 2. `follow_anchor_with` 读它做「跟随白名单」判据（见 `should_follow`）——
///    连续两次光标锚不允许挪窗口，否则等价于浮标跟随鼠标。
static LAST_ANCHOR_KIND: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(ANCHOR_NONE);

fn store_anchor_kind(kind: u8) {
    LAST_ANCHOR_KIND.store(kind, Ordering::SeqCst);
}

fn last_anchor_kind_str() -> Option<String> {
    match LAST_ANCHOR_KIND.load(Ordering::SeqCst) {
        ANCHOR_CONTROL => Some("control".into()),
        ANCHOR_WINDOW => Some("window".into()),
        ANCHOR_CURSOR => Some("cursor".into()),
        ANCHOR_CURSOR_WINDOW => Some("cursorWindow".into()),
        _ => None,
    }
}

/// 把最近一次锚点类型回写进状态缓存。
///
/// 时机：`emit_state` 里 follow 之后也会注入；但**首帧**是
/// 「先 emit（窗口尚未创建）→ 再 create（这才算出落位）」，
/// 缓存里的首帧快照会缺 `anchorKind`。create/reveal 定位后补一次，
/// HUD 前端 mount 拉快照时才能画出方向尾。
fn inject_anchor_kind_into_cache(app: &AppHandle) {
    if let Some(cache) = app.try_state::<HudStateCache>() {
        if let Ok(mut guard) = cache.0.lock() {
            if let Some(s) = guard.as_mut() {
                s.anchor_kind = last_anchor_kind_str();
            }
        }
    }
}

/// 用户拖拽保存的偏移（物理像素，相对默认落位）。
/// 持久化在 config 的 `stack_hud_offset_x/y`，进程内用原子量缓存。
static OFFSET_X: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static OFFSET_Y: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static OFFSET_LOADED: AtomicBool = AtomicBool::new(false);

const OFFSET_KEY_X: &str = "stack_hud_offset_x";
const OFFSET_KEY_Y: &str = "stack_hud_offset_y";

/// 启动时从 config 恢复偏移（`lib.rs` setup 调一次）。
pub fn init(app: &AppHandle) {
    if OFFSET_LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(store) = app.try_state::<crate::data_store::DataStore>() else {
        return;
    };
    let Ok(cfg) = store.get_config() else {
        return;
    };
    let x = cfg
        .get(OFFSET_KEY_X)
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let y = cfg
        .get(OFFSET_KEY_Y)
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    OFFSET_X.store(x as i32, Ordering::SeqCst);
    OFFSET_Y.store(y as i32, Ordering::SeqCst);
    log::info!("[StackHud] 已恢复浮标偏移: ({x:.0}, {y:.0})");
}

/// 「调整模式」：进入后浮标恢复鼠标交互（可拖拽），退出时保存偏移并回到穿透。
static ADJUSTING: AtomicBool = AtomicBool::new(false);

/// 事件名：进入/退出调整模式（Rust → HUD webview，前端切换拖拽 UI）。
pub const EVENT_ADJUST: &str = "stack-hud-adjust";

/// 目标窗口矩形（物理像素）——取**实时前台窗口**。
/// 时机依据：收集/粘贴/开栈三个重定位时机里，前台就是用户正在操作的目标窗口
/// （粘贴后引擎把目标窗口激活回前台）。前台无效（桌面/自身）时返回 None。
#[cfg(target_os = "windows")]
fn anchor_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let engine = app.try_state::<crate::paste_engine::PasteEngine>()?;
    let hwnd = engine.capture_foreground_now()?;
    let mut r = RECT::default();
    let ok =
        unsafe { GetWindowRect(windows::Win32::Foundation::HWND(hwnd as *mut _), &mut r).is_ok() };
    if !ok || r.right <= r.left || r.bottom <= r.top {
        return None;
    }
    Some((
        r.left as f64,
        r.top as f64,
        (r.right - r.left) as f64,
        (r.bottom - r.top) as f64,
    ))
}

#[cfg(not(target_os = "windows"))]
fn anchor_rect(_app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    None
}

/// 获取鼠标光标的物理坐标（锚点无效时的兜底依据）
#[cfg(target_os = "windows")]
fn get_cursor_pos() -> (f64, f64) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }
    (pt.x as f64, pt.y as f64)
}

#[cfg(not(target_os = "windows"))]
fn get_cursor_pos() -> (f64, f64) {
    (100.0, 100.0)
}

/// 取光标所在**窗口**的矩形（物理像素），供兜底锚定用。
///
/// ## 为什么不是「直接贴光标」
///
/// 贴光标意味着落位坐标随鼠标变化，而这条定位链会被 450ms 跟随轮询反复调用 ——
/// 结果就是浮标实时跟随鼠标、一直黏在光标旁边挡住用户视线（实测反馈）。
/// 贴「光标底下的窗口」把落位钉在一个**不随鼠标移动的矩形**上，
/// 位置依然落在用户的视线范围内。
///
/// 判据在 [`can_anchor_at_cursor`]：排除 HUD 自己（`always_on_top` 会命中它，
/// 形成"以当前位置重新落位"的回环）与外壳窗口（桌面 / 任务栏），
/// **允许自身进程窗口** —— 与粘贴目标判据刻意不同，理由见该函数注释。
///
/// ❗ HUD 平时是 `set_ignore_cursor_events(true)`（`WS_EX_TRANSPARENT`），
/// `WindowFromPoint` 的命中测试本就会穿透它；这里的显式排除是第二道保险 ——
/// 调整模式下它会临时恢复鼠标交互，那时没有这道保险就会自锚。
#[cfg(target_os = "windows")]
fn window_rect_at_cursor(app: &AppHandle, cx: f64, cy: f64) -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetWindowRect, WindowFromPoint, GA_ROOT,
    };

    let pt = POINT {
        x: cx as i32,
        y: cy as i32,
    };
    let hwnd = unsafe { WindowFromPoint(pt) };
    if hwnd.0.is_null() {
        return None;
    }

    // 提升到**顶层窗口**。`WindowFromPoint` 命中的可能是子控件（Chrome 的渲染区、
    // 任务栏的按钮区都是子窗口），直接用它会错两处：
    // 1. 锚点变成"控件区域右上角"，而 `anchor_pos` 里那 40px 是**避让标题栏**用的
    //    ——控件区已经没有标题栏，偏移会把它推进内容里；
    // 2. 类名判据会拿子窗口类名去比外壳表（任务栏按钮的子窗口类名不是
    //    `Shell_TrayWnd`），任务栏会被误判成可锚窗口。
    // 提升后锚点语义与 ② 目标窗口锚一致：贴窗口右上内侧。
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let hwnd = if root.0.is_null() { hwnd } else { root };

    let excluded = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);

    // 类名取不到（窗口正在销毁）时按空串处理 → `can_anchor_at_cursor` 不额外拒绝
    let mut cls = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut cls) };
    let class_name = if n > 0 {
        String::from_utf16_lossy(&cls[..n as usize])
    } else {
        String::new()
    };

    if !can_anchor_at_cursor(hwnd.0 as isize, excluded, &class_name) {
        return None;
    }

    let mut r = RECT::default();
    let ok = unsafe { GetWindowRect(hwnd, &mut r).is_ok() };
    if !ok || r.right <= r.left || r.bottom <= r.top {
        return None;
    }
    Some((
        r.left as f64,
        r.top as f64,
        (r.right - r.left) as f64,
        (r.bottom - r.top) as f64,
    ))
}

#[cfg(not(target_os = "windows"))]
fn window_rect_at_cursor(_app: &AppHandle, _cx: f64, _cy: f64) -> Option<(f64, f64, f64, f64)> {
    None
}

/// 计算 HUD 位置（物理坐标系，DPI 感知）。
///
/// 链：聚焦输入框右上 → 目标窗口右上内侧 → **光标下的窗口右上内侧** → 贴光标候选。
/// 前三级都加用户拖拽保存的偏移，全越界再钳进所在显示器的工作区。
/// 后两级属「光标类锚点」，只落位一次不跟随（见 `should_follow`）。
fn calc_position(app: &AppHandle) -> tauri::PhysicalPosition<f64> {
    let offset = (
        OFFSET_X.load(Ordering::SeqCst) as f64,
        OFFSET_Y.load(Ordering::SeqCst) as f64,
    );
    calc_position_with_offset(app, false, offset)
}

/// `force_focus=true` 时聚焦控件走强制重探（跟随轮询用，要看见 Tab 换框）。
/// `offset` 显式传入，避免用全局原子量临时清零造成与 follow 轮询的竞态。
fn calc_position_with_offset(
    app: &AppHandle,
    force_focus: bool,
    offset: (f64, f64),
) -> tauri::PhysicalPosition<f64> {
    // ① 聚焦输入框（UIA / caret）—— 用户视线所在处
    if let Some(fg) = app
        .try_state::<crate::paste_engine::PasteEngine>()
        .and_then(|e| e.capture_foreground_now())
    {
        let ctrl = if force_focus {
            crate::stack_hud_focus::focused_control_rect_fresh(fg)
        } else {
            crate::stack_hud_focus::focused_control_rect(fg)
        };
        if let Some((cx, cy, cw, ch)) = ctrl {
            let mon = crate::tray_manager::get_monitor_work_area(cx + cw / 2.0, cy + ch / 2.0);
            let wa = WorkArea {
                x: mon.work_x,
                y: mon.work_y,
                w: mon.work_w,
                h: mon.work_h,
            };
            let (pw, ph) = (HUD_W * mon.scale, HUD_H * mon.scale);
            if let Some((x, y, _below)) = control_anchor_pos((cx, cy, cw, ch), offset, pw, ph, wa) {
                store_anchor_kind(ANCHOR_CONTROL);
                return tauri::PhysicalPosition { x, y };
            }
        }
    }

    // ② 锚定目标窗口右上内侧（现方案 A）
    if let Some((ax, ay, aw, ah)) = anchor_rect(app) {
        let mon = crate::tray_manager::get_monitor_work_area(ax + aw / 2.0, ay + ah / 2.0);
        let wa = WorkArea {
            x: mon.work_x,
            y: mon.work_y,
            w: mon.work_w,
            h: mon.work_h,
        };
        let (pw, ph) = (HUD_W * mon.scale, HUD_H * mon.scale);
        if let Some((x, y)) = anchor_pos(Some((ax, ay, aw, ah)), offset, pw, ph, wa) {
            store_anchor_kind(ANCHOR_WINDOW);
            return tauri::PhysicalPosition { x, y };
        }
    }

    // ③ 锚定「光标底下的窗口」右上内侧（2026-09-17 加入）
    //
    // 触发场景 = 前面两级的前提不成立（`capture_foreground_now()` 拿不到有效目标：
    // 前台是桌面 / 任务栏 / 本进程窗口）。用户在桌面上开栈、从托盘弹层开栈、
    // 在主窗口里开栈，都会落到这里。
    //
    // 比原来的「贴光标四象限」好在：落位钉在一个**不随鼠标移动**的矩形上，
    // 且不压在光标上挡住用户正在看的内容。
    let (cx, cy) = get_cursor_pos();
    if let Some((ax, ay, aw, ah)) = window_rect_at_cursor(app, cx, cy) {
        let mon = crate::tray_manager::get_monitor_work_area(ax + aw / 2.0, ay + ah / 2.0);
        let wa = WorkArea {
            x: mon.work_x,
            y: mon.work_y,
            w: mon.work_w,
            h: mon.work_h,
        };
        let (pw, ph) = (HUD_W * mon.scale, HUD_H * mon.scale);
        if let Some((x, y)) = anchor_pos(Some((ax, ay, aw, ah)), offset, pw, ph, wa) {
            store_anchor_kind(ANCHOR_CURSOR_WINDOW);
            return tauri::PhysicalPosition { x, y };
        }
    }

    // ④ 最后兜底：贴光标候选（连光标下都没有可锚窗口 —— 光标在桌面上）。
    //
    // ❗ 这一级与 ③ 都算「光标类锚点」：`should_follow` 只允许它们落位一次，
    //    之后钉住不动。没有这道拦截，450ms 轮询会把"贴光标一次"变成"跟随鼠标"。
    let mon = crate::tray_manager::get_monitor_work_area(cx, cy);
    let wa = WorkArea {
        x: mon.work_x,
        y: mon.work_y,
        w: mon.work_w,
        h: mon.work_h,
    };
    let (pw, ph) = (HUD_W * mon.scale, HUD_H * mon.scale);
    let (x, y) = pick_pos(cx, cy, pw, ph, wa);
    store_anchor_kind(ANCHOR_CURSOR);
    tauri::PhysicalPosition { x, y }
}

/// 跟随重定位：状态推送 / 轮询时把浮标挪到聚焦输入框（或目标窗口）旁。
///
/// 跳过四种情形：调整中（不能跟拖拽抢位置）、窗口不存在 / 隐藏、位移过小（抖动取整）、
/// **连续两次都是光标类锚点** —— 那算出来的是"鼠标此刻在哪"，跟着它挪就等于
/// 浮标实时跟随鼠标（判据见 `stack_hud_pos::should_follow`）。
fn follow_anchor(app: &AppHandle) {
    follow_anchor_with(app, false)
}

fn follow_anchor_with(app: &AppHandle, force_focus: bool) {
    if ADJUSTING.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    // ❗ 先取"上次落位用的锚点类型"——下面那次计算会把它覆盖成这次的。
    let prev_kind = LAST_ANCHOR_KIND.load(Ordering::SeqCst);
    let pos = calc_position_with_offset(
        app,
        force_focus,
        (
            OFFSET_X.load(Ordering::SeqCst) as f64,
            OFFSET_Y.load(Ordering::SeqCst) as f64,
        ),
    );
    // 跟随白名单：这次算出的落位是否构成"该把浮标挪过去"的理由。
    // 光标类锚点只在类型发生**真实变化**时落位一次，之后钉住 —— 没有这道拦截，
    // 450ms 轮询会让浮标一直黏在鼠标旁（用户实测："挡住视线"）。
    let now_kind = LAST_ANCHOR_KIND.load(Ordering::SeqCst);
    let follow = should_follow(prev_kind, now_kind);
    if !follow {
        // 不挪 ⇒ 浮标仍停在上一轮的位置上，锚点记录必须回滚成 prev_kind，
        // 否则 `anchor_kind` 会描述一个**没被采用**的落位，与实际位置不符。
        store_anchor_kind(prev_kind);
    }
    // 回写缓存，保证前端拉快照时有 anchorKind（读的是上面校正过的值）
    inject_anchor_kind_into_cache(app);
    if !follow {
        return;
    }

    let prev = window.outer_position().ok();
    if let Some(cur) = prev {
        let dx = cur.x - pos.x as i32;
        let dy = cur.y - pos.y as i32;
        if dx.abs() < FOLLOW_MIN_DELTA && dy.abs() < FOLLOW_MIN_DELTA {
            return;
        }
        let _ = window.set_position(pos);
        emit_reposition(app, dx as f64, dy as f64, &window);
        return;
    }
    let _ = window.set_position(pos);
}

/// 通知前端「窗口刚从旧位置挪过来」，载荷为 CSS 像素位移（旧 − 新）。
///
/// 原生 `set_position` 瞬时完成，没有系统级窗口动画；滑入感只能由内容层
/// 从 `translate(dx,dy)` 动画到 0 伪造（见 `StackHud.tsx` 的 settle）。
fn emit_reposition(app: &AppHandle, dx_phys: f64, dy_phys: f64, window: &WebviewWindow) {
    let Ok(cur) = window.outer_position() else {
        return;
    };
    let mon = crate::tray_manager::get_monitor_work_area(cur.x as f64, cur.y as f64);
    let scale = if mon.scale > 0.0 { mon.scale } else { 1.0 };
    let dx = (dx_phys / scale).clamp(-SETTLE_CLAMP_CSS, SETTLE_CLAMP_CSS);
    let dy = (dy_phys / scale).clamp(-SETTLE_CLAMP_CSS, SETTLE_CLAMP_CSS);
    let _ = app.emit_to(
        WINDOW_LABEL,
        EVENT_REPOSITION,
        serde_json::json!({ "dx": dx, "dy": dy }),
    );
}

// ===== 跟随轮询 =====
//
// 问题：只在收集/粘贴推送时重定位的话，用户在同一表单里 Tab 到下一个输入框，
// 浮标仍贴在上一个框上 —— 「不够显眼」的残留形态。
// 做法：HUD 可见期间每 450ms 强制重探聚焦控件并跟随；隐藏/调整中/代次过期即停。
// 遵守规则 8：轮询只在栈浮标可见时活着，不是全局常驻循环。

/// 跟随线程代次：递增即作废旧线程（新 show 接手 / hide 收摊）。
static FOLLOW_GEN: AtomicU64 = AtomicU64::new(0);

fn bump_follow_gen() -> u64 {
    FOLLOW_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

fn current_follow_gen() -> u64 {
    FOLLOW_GEN.load(Ordering::SeqCst)
}

/// 启动跟随轮询。可重入：每次调用作废旧线程并起新代。
fn start_follow_poll(app: &AppHandle) {
    let gen = bump_follow_gen();
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(FOLLOW_POLL_MS));
            if current_follow_gen() != gen {
                return;
            }
            let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            // 调整中 follow_anchor 自己会跳过；这里不 return，退出调整后轮询仍在
            follow_anchor_with(&app, true);
        }
    });
}

/// 停止跟随轮询（HUD 隐藏时调用）。
fn stop_follow_poll() {
    bump_follow_gen();
}

// ===== 窗口生命周期 =====

/// 防止并发创建同名窗口（连续快速开栈）
static CREATING: AtomicBool = AtomicBool::new(false);

/// 「显示意图」的代次，用来作废挂起的延迟隐藏。
///
/// [`hide_hud_after`] 是 `spawn + sleep`，醒来后无条件 `hide_hud`。而 `hudAllDone`
/// 会排一次 1.5 秒延迟隐藏；用户若在这 1.5 秒内重新开栈，[`show_hud`] 点亮浮标后
/// 那个挂起线程醒来又把它关掉 —— 浮标闪一下就没，反馈通道回到盲区。
/// 代次是唯一可靠判据：排定隐藏时取快照，醒来后比对，不一致就放弃。
static HUD_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 声明「浮标要显示」这一意图 —— 递增代次，作废所有挂起的延迟隐藏。
///
/// 顺带把锚点类型记录清回 `ANCHOR_NONE`：这是「跟随白名单」的放行条件 ——
/// 用户显式开一次栈，就是要看见浮标落到**当前**的操作现场，哪怕上一轮它停在光标锚上。
/// 不清的话，第二次开栈会沿用上一轮的"光标锚不跟随"结论，浮标钉在旧位置不动。
/// ❗ 只挂在「显示」路径上（`show_hud` / `reveal`）。轮询调它等于白名单永久失效。
fn mark_shown() {
    HUD_EPOCH.fetch_add(1, Ordering::SeqCst);
    LAST_ANCHOR_KIND.store(ANCHOR_NONE, Ordering::SeqCst);
}

/// 排定延迟隐藏时取一份代次快照
fn hide_epoch() -> u64 {
    HUD_EPOCH.load(Ordering::SeqCst)
}

/// 纯函数：挂起的隐藏是否已作废（期间有人要求显示过）。
///
/// 抽成纯函数是为了能单测 —— 这条判据的两种结果都对应一个真实用户场景，
/// 而 `hide_hud_after` 本身要起线程 + 真实窗口，CI 上跑不了。
fn hide_is_stale(scheduled: u64, current: u64) -> bool {
    scheduled != current
}

/// 显示 HUD（栈模式开始 / 重新定位时调用）
pub fn show_hud(app: &AppHandle) {
    // 先作废挂起的延迟隐藏：本次意图是「显示」，晚到的隐藏线程必须让位
    mark_shown();
    // 调整模式只保留「点亮」语义，不做任何重定位 —— 用户正拖着浮标，
    // 这时按开栈热键不能把窗口从他手底下抢走。
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            if !ADJUSTING.load(Ordering::SeqCst) {
                follow_anchor_with(app, false);
                // 重新定位也要通知前端：它负责重播入场动画 + 重置空闲淡化计时。
                // 漏掉这一次的话，用户切了显示器/重开一次而浮标仍停在 55% 淡化态。
                notify_shown(app);
            }
            start_follow_poll(app);
            return;
        }
        reveal(app, &window);
        return;
    }
    create(app);
}

/// 隐藏 HUD。
///
/// 调整模式下**强制退出**再隐藏：否则托盘只能 enter、hide 被短路，
/// 浮标会永久可交互并挡住目标应用点击（P1.1）。
pub fn hide_hud(app: &AppHandle) {
    if ADJUSTING.swap(false, Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.set_ignore_cursor_events(true);
        }
        let _ = app.emit_to(WINDOW_LABEL, EVENT_ADJUST, false);
        log::info!("[StackHud] 隐藏时强制退出调整模式");
    }
    stop_follow_poll();
    // 清空状态快照：本轮显示结束了，下次显示必须由新一轮 `stack_hud_update` 带动。
    // 不清的话，将来若有路径直接 `stack_hud_show`（不先 push），HUD 的首帧拉取
    // 会拿到上一轮栈的陈旧状态 —— 表现为「浮标写着上一轮的目标应用」。
    if let Some(cache) = app.try_state::<HudStateCache>() {
        if let Ok(mut guard) = cache.0.lock() {
            *guard = None;
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            log::info!("[StackHud] 已隐藏");
        }
    }
}

/// 延迟隐藏 —— 让「全部粘贴完毕」这类终态有机会被看见。
///
/// ❗ 醒来后必须比对代次（见 [`HUD_EPOCH`]）：期间用户若重新开栈，
/// 这次隐藏必须放弃，否则会把刚点亮的浮标关掉。
pub fn hide_hud_after(app: &AppHandle, delay_ms: u64) {
    let app = app.clone();
    let scheduled = hide_epoch();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if hide_is_stale(scheduled, hide_epoch()) {
            log::info!("[StackHud] 延迟隐藏作废：期间浮标已被重新点亮");
            return;
        }
        hide_hud(&app);
    });
}

/// 把状态快照广播给 HUD webview，并缓存一份供首帧拉取。
pub fn emit_state(app: &AppHandle, state: &StackHudState) {
    // 方案 A 的核心时机：每次推送都跟随目标窗口/聚焦控件重定位。
    // 收集/粘贴的瞬间用户视线必然在目标窗口上，浮标贴过去才「注意得到」。
    follow_anchor(app);
    let mut state = state.clone();
    // 注入最近一次定位的锚点类型 —— 前端据此决定是否画方向尾。
    // 必须在 follow_anchor 之后读，保证与本次落位同源。
    state.anchor_kind = last_anchor_kind_str();
    if let Some(cache) = app.try_state::<HudStateCache>() {
        if let Ok(mut guard) = cache.0.lock() {
            *guard = Some(state.clone());
        }
    }
    if let Err(e) = app.emit_to(WINDOW_LABEL, EVENT_UPDATE, state.clone()) {
        log::warn!("[StackHud] 广播状态失败: {}", e);
    }
}

/// 通知 HUD 前端「窗口刚显示」——它据此**重播入场动画 + 重置空闲淡化计时**。
///
/// 抽成函数是因为有两条触发路径（复用已存在的缓存窗口 / 首次创建），
/// 加上 `show_hud` 的「已显示只重定位」分支共三处，漏掉任何一处都会让浮标
/// 停在 45% 淡化态、或该有的入场动画不播。
///
/// ❗ 首次创建时这次 `emit` 通常**赶不上** webview 的 JS 就绪（`EVENT_SHOWN` 没有
/// 像状态那样的快照补偿），会静默丢掉。这是可接受的：首帧的入场动画由组件
/// 挂载时自身那次动画承担（`StackHud.tsx` 的 `shownAt` 初值为 0），
/// 两边效果等价。真要补偿得给 SHOWN 也做一份快照，成本不划算。
fn notify_shown(app: &AppHandle) {
    let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOWN, ());
}

/// 显示已存在的缓存窗口：重定位 → 点击穿透 → 通知前端 → show
///
/// ❗ 刻意**不调 `set_focus()`**（`quick_paste.rs` 的面板要 focus，HUD 不能要）：
/// 抢了焦点，用户的下一个 `Ctrl+V` 就打进 HUD 而不是目标应用。
fn reveal(app: &AppHandle, window: &WebviewWindow) {
    // 这里是「显示」的唯一实现点，同样要作废挂起的延迟隐藏
    mark_shown();
    follow_anchor_with(app, false);
    // 纯展示窗口：鼠标事件必须穿透，否则它挡住目标应用上正在编辑的区域
    let _ = window.set_ignore_cursor_events(true);
    notify_shown(app);
    let _ = window.show();
    start_follow_poll(app);
    log::info!("[StackHud] 已显示（复用缓存窗口）");
}

/// 首次创建 HUD 窗口。仿 `quick_paste.rs` 的结构：独立线程 + 防重入 + 双重检查。
fn create(app: &AppHandle) {
    if CREATING.swap(true, Ordering::SeqCst) {
        log::info!("[StackHud] 窗口创建中，忽略重复调用");
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        // RAII 复位：一次 panic 不能让 CREATING 永久卡在 true
        struct ResetOnDrop;
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                CREATING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ResetOnDrop;
        let app = &app;

        // 双重检查：线程启动期间可能已被另一路径创建
        if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
            reveal(app, &existing);
            return;
        }

        let pos = calc_position(app);
        inject_anchor_kind_into_cache(app);
        match WebviewWindowBuilder::new(
            app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("stackhud.html".into()),
        )
        .title("")
        .inner_size(HUD_W, HUD_H)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .focused(false) // 不抢焦点：抢了用户的下一个 Ctrl+V 会打进 HUD
        .visible(false)
        .build()
        {
            Ok(window) => {
                let _ = window.set_position(pos);
                inject_anchor_kind_into_cache(app);
                let _ = window.set_ignore_cursor_events(true);

                #[cfg(target_os = "windows")]
                crate::tray_manager::set_dwm_round_corners(&window);

                notify_shown(app);
                let _ = window.show();
                start_follow_poll(app);
                log::info!("[StackHud] 浮标窗口创建并显示");
            }
            Err(e) => {
                // HUD 是反馈放大器，不是失败点：创建不了就静默降级，主流程照走。
                // 不能让它成为新的失败源。
                log::warn!("[StackHud] 创建浮标窗口失败（本次降级为无浮标）: {}", e);
            }
        }
    });
}

// ===== 命令 =====

/// 推送 HUD 状态（`hudBridge.ts` 是唯一调用方）
#[tauri::command]
pub fn stack_hud_update(app: AppHandle, state: StackHudState) {
    emit_state(&app, &state);
}

/// 显示 HUD
#[tauri::command]
pub fn stack_hud_show(app: AppHandle) {
    show_hud(&app);
}

/// 隐藏 HUD；`delay_ms > 0` 时延迟隐藏（给终态留可见时间）
#[tauri::command]
pub fn stack_hud_hide(app: AppHandle, delay_ms: Option<u64>) {
    match delay_ms {
        Some(ms) if ms > 0 => hide_hud_after(&app, ms),
        _ => hide_hud(&app),
    }
}

/// 拉取最近一次状态 —— HUD 前端 mount 时调，解决"后端 emit 早于 webview 就绪"的首帧空白。
#[tauri::command]
pub fn stack_hud_state(cache: tauri::State<'_, HudStateCache>) -> Option<StackHudState> {
    cache.0.lock().ok().and_then(|g| g.clone())
}

/// 进入 / 退出「调整模式」。`enter=None` 时 toggle（托盘第二次点击可退出）。
///
/// 浮标平时是**点击穿透**的，收不到鼠标没法拖；常驻可交互则会让 208×48 的
/// 区域吃掉目标应用的点击 —— 比解决的问题更糟。所以：托盘弹层按钮进入/切换、
/// 双击浮标退出。
///
/// 退出时保存 `offset = 当前位置 − 默认落位`（锚点有效时即"贴窗口的哪个位置"），
/// 持久化到 config，恢复穿透。之后跟随目标窗口时保持这个相对位置。
#[tauri::command]
pub fn stack_hud_adjust(app: AppHandle, enter: Option<bool>) -> Result<bool, String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Err("浮标窗口不存在；先开一次栈模式再调整".to_string());
    };
    let currently = ADJUSTING.load(Ordering::SeqCst);
    let want_enter = enter.unwrap_or(!currently);
    if want_enter {
        ADJUSTING.store(true, Ordering::SeqCst);
        if !window.is_visible().unwrap_or(false) {
            show_hud(&app);
        }
        let _ = window.set_ignore_cursor_events(false);
        let _ = app.emit_to(WINDOW_LABEL, EVENT_ADJUST, true);
        log::info!("[StackHud] 进入调整模式");
        return Ok(true);
    }
    if !currently {
        // 本就不在调整：幂等成功，避免托盘误点报错
        return Ok(false);
    }

    ADJUSTING.store(false, Ordering::SeqCst);
    let _ = window.set_ignore_cursor_events(true);
    let _ = app.emit_to(WINDOW_LABEL, EVENT_ADJUST, false);

    // 退出时保存偏移：当前位置 − 默认落位（不含偏移的锚点/光标落位）
    let cur = window
        .outer_position()
        .map_err(|e| format!("读取浮标位置失败: {e}"))?;
    let default = default_position(&app);
    let ox = cur.x as f64 - default.x;
    let oy = cur.y as f64 - default.y;
    OFFSET_X.store(ox as i32, Ordering::SeqCst);
    OFFSET_Y.store(oy as i32, Ordering::SeqCst);

    if let Some(store) = app.try_state::<crate::data_store::DataStore>() {
        // save_config 是按键 upsert（事务包裹），只传这两个键不会影响其它配置
        if let Err(e) = store.save_config(&serde_json::json!({
            OFFSET_KEY_X: ox,
            OFFSET_KEY_Y: oy,
        })) {
            log::warn!("[StackHud] 偏移持久化失败: {e}");
        }
    }
    log::info!("[StackHud] 退出调整模式，偏移已保存: ({ox:.0}, {oy:.0})");
    Ok(false)
}

/// 「默认落位」= 偏移为 (0,0) 时的位置。供退出调整模式时反推偏移用。
/// **不临时改全局 OFFSET**——否则 follow 轮询会在清零窗口期把窗口挪走并写坏偏移。
fn default_position(app: &AppHandle) -> tauri::PhysicalPosition<f64> {
    calc_position_with_offset(app, false, (0.0, 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标签必须与 paste_engine 的排除表一致 —— 不一致会让 HUD 把
    /// 「陈旧目标续命」从偶发变成必然。
    #[test]
    fn test_window_label_matches_paste_engine_exclusion() {
        assert!(
            crate::paste_engine::PasteEngine::TOOL_WINDOW_LABELS.contains(&WINDOW_LABEL),
            "stack-hud 必须在 paste_engine 的工具窗排除表里，否则会污染前台窗口判据"
        );
    }

    /// 挂起的延迟隐藏必须被「重新显示」作废。
    ///
    /// 对应的真实场景：用户粘完最后一条 → `hudAllDone` 排了一次 1.5s 延迟隐藏 →
    /// 用户在 1.5s 内按 Ctrl+Alt+K 重新开栈 → 浮标被点亮 → 若不做代次校验，
    /// 那个挂起的线程醒来就把它关掉，用户看到浮标闪一下就没。
    #[test]
    fn test_scheduled_hide_is_stale_after_reshown() {
        let epoch = AtomicU64::new(0);
        // ① 排定延迟隐藏，记下代次快照
        let scheduled = epoch.load(Ordering::SeqCst);
        // ② 期间用户重新开栈 → show_hud 的 mark_shown
        epoch.fetch_add(1, Ordering::SeqCst);
        // ③ 隐藏线程醒来：必须放弃
        assert!(
            hide_is_stale(scheduled, epoch.load(Ordering::SeqCst)),
            "重新显示过之后，挂起的延迟隐藏必须作废"
        );
    }

    /// 反面：期间没人动过 → 隐藏照常执行。
    /// 少了这条，一个「永远返回 true」的退化实现也能让上面那条测试通过。
    #[test]
    fn test_scheduled_hide_runs_when_untouched() {
        let epoch = AtomicU64::new(0);
        let scheduled = epoch.load(Ordering::SeqCst);
        assert!(
            !hide_is_stale(scheduled, epoch.load(Ordering::SeqCst)),
            "没人重新显示时，延迟隐藏必须照常执行"
        );
    }

    /// 跟随轮询代次：bump 后旧线程必须退出（current != mine）
    #[test]
    fn test_follow_gen_bump_invalidates_old_poll() {
        let gen = AtomicU64::new(0);
        let mine = gen.fetch_add(1, Ordering::SeqCst) + 1;
        // 新一轮 show / hide 再 bump
        gen.fetch_add(1, Ordering::SeqCst);
        assert_ne!(
            gen.load(Ordering::SeqCst),
            mine,
            "代次递增后旧轮询线程必须退出"
        );
    }

    /// 重新显示浮标必须清掉上一轮的锚点类型记录。
    ///
    /// 对应的真实场景：用户上一轮在桌面上开过栈（落在光标锚）→ 关栈 → 又开一次。
    /// 若 `mark_shown` 不清记录，这一次会命中「光标锚不跟随」白名单，
    /// 浮标钉在上一轮的旧位置不动 —— 用户看到的是"浮标没跟过来"。
    #[test]
    fn test_mark_shown_resets_anchor_kind_for_reopen() {
        // ① 上一轮停在光标锚：同样的落位不该再挪窗口
        store_anchor_kind(ANCHOR_CURSOR);
        assert!(!should_follow(
            LAST_ANCHOR_KIND.load(Ordering::SeqCst),
            ANCHOR_CURSOR
        ));

        // ② 用户重新开栈
        mark_shown();

        // ③ 这次定位又算出光标锚 —— 必须放行，否则浮标停在旧位置
        assert!(
            should_follow(LAST_ANCHOR_KIND.load(Ordering::SeqCst), ANCHOR_CURSOR),
            "重新显示之后，光标锚必须能重新落位一次"
        );
    }
}
