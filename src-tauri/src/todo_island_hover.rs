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
//! ## 滞回带（8 进 / 12 出）
//!
//! 进出用**同一个**外扩值时，光标停在边界上会让 `set_ignore_cursor_events` 每 60ms 翻一次，
//! 窗口在「收事件 / 不收事件」之间抖动 —— 表现为岛上的 hover 样式闪烁。
//! 所以进入外扩（`HOVER_IN_PAD`）**故意小于**离开外扩（`HOVER_OUT_PAD`），
//! 两者之间的环形带里保持当前状态。这条关系由编译期断言钉住（见下）。
//!
//! ## 代次作废（与栈浮标同款）
//!
//! 每次 `start_poll` 都 `POLL_GEN += 1`，旧线程下一轮醒来发现代次不是自己的就退出。
//! 少了它，每次 `show()` 都会叠加一个永不退出的轮询线程，60ms 一次地抢窗口状态。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::todo_island::{EVENT_HOVER, WINDOW_LABEL};

/// 鼠标进入判定外扩像素。给 208×32 的胶囊留一点容错，避免贴边时反复切。
const HOVER_IN_PAD: f64 = 8.0;
/// 鼠标离开判定外扩像素。**故意大于进入值**，构成滞回带（8 进 / 12 出）：
/// 相等时，光标停在边界上会让 `set_ignore_cursor_events` 每 tick 翻转一次，
/// 窗口在「收事件 / 不收事件」之间抖动 —— 表现为岛上的 hover 样式闪烁。
const HOVER_OUT_PAD: f64 = 12.0;
/// 光标位置轮询间隔（ms）。60ms ≈ 16fps，比视觉感知快、又远低于把 COM 查询做成高频活。
const HOVER_POLL_MS: u64 = 60;

/// 滞回带必须存在（进入外扩 < 离开外扩），否则光标停在边界上会让穿透状态每 tick 翻转。
///
/// 写成**编译期断言**而不是 `#[test]`：两个值都是常量，`assert!` 放在测试里是恒真的死代码
/// （clippy 会正确地标 `assertions_on_constants`），而编译期断言能在编译时就挡住
/// 有人把这两个值改成相等 —— 比运行测试更早一步。
const _: () = assert!(HOVER_IN_PAD < HOVER_OUT_PAD);

/// 鼠标当前是否在岛上（滞回判定后的结果）。
static HOVERING: AtomicBool = AtomicBool::new(false);
/// 悬停轮询代次：`bump` 之后旧线程自行退出（与栈浮标同款做法）。
static POLL_GEN: AtomicU64 = AtomicU64::new(0);

/// 鼠标当前是否在岛上（探针回报用）。
pub(crate) fn is_hovering() -> bool {
    HOVERING.load(Ordering::SeqCst)
}

/// 清掉悬停状态（岛隐藏时调）。
///
/// ❗ 必须与 `stop_poll` 配对：只停线程不复位状态，下次 `show()` 时
/// `HOVERING` 会以「进来过」的身份启动，第一轮就按 12px 的离开外扩判定，
/// 于是光标明明不在岛上也短暂进入「收事件」状态。
pub(crate) fn reset_hovering() {
    HOVERING.store(false, Ordering::SeqCst);
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

/// 一轮判定：光标在岛矩形内 → 收鼠标事件（岛可点）；在带外 → 恢复穿透。
///
/// 滞回：进入用 `HOVER_IN_PAD`、退出用 `HOVER_OUT_PAD`，两者之间的环形带里保持当前状态。
fn step_hover(app: &AppHandle, window: &WebviewWindow) {
    let Some((cx, cy)) = cursor_pos() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (x, y) = (pos.x as f64, pos.y as f64);
    let (w, h) = (size.width as f64, size.height as f64);

    let was = HOVERING.load(Ordering::SeqCst);
    let pad = if was { HOVER_OUT_PAD } else { HOVER_IN_PAD };
    let inside = cx >= x - pad && cx <= x + w + pad && cy >= y - pad && cy <= y + h + pad;

    if inside == was {
        return;
    }
    HOVERING.store(inside, Ordering::SeqCst);
    // inside → 收事件（false = 不忽略光标）；outside → 穿透（true = 忽略光标）
    let _ = window.set_ignore_cursor_events(!inside);
    let _ = app.emit_to(WINDOW_LABEL, EVENT_HOVER, inside);
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
}
