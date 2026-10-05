//! 丙-① + 丙-②（2026-09-30）：远程电脑的两块**桌面级置顶浮层**。
//!
//! ## 为什么是浮层而不是主窗里的条
//! 告知本来就有：`RcOverlay` 收到 pending 会 toast + `summonMainWindow`，被控横幅
//! 也常驻主窗。问题在拉起的是**非置顶**主窗、而且**要求主窗活着**——用户正被全屏
//! 应用盖着、或主窗整场都没打开时：
//! - 丙-①：120s 确认窗就在没人看见的地方走完，然后那条申请从列表里静静消失；
//! - 丙-②：会话已经开始了，桌面上没有任何「有人正在看你屏幕」的痕迹（审计 H1）。
//! 对标 §6.1 / §6.2 六家的共识是**独立置顶浮层**：确认那张要顶到手头的活之上，
//! 隐私那只要在右下角一直亮着，点一下就终止。
//!
//! ## 为什么两种形态共用一块窗口（而不是再开一个 `rc-priv`）
//! 每多一个常驻 webview 实测是 +34~47 MB 常驻内存（待办岛探针的口径，见
//! `todo_island_probe.rs`），而角标一旦做出来就是**开机期间一直存在**的东西。
//! 两块窗口能省的是代码，省不了的是内存，所以合成一块、按形态换几何与内容：
//! - `Ask`：光标所在屏工作区**顶缘水平居中**，320×168 卡片；
//! - `Capsule`：同一工作区**右下角** 12px，264×28 胶囊。
//! 两形态**不共存**：有申请待答时先答（`Ask` 优先），答完角标回来。被控中同时来新
//! 申请这条路后端本来就以「会话占用」拒掉，不存在把角标永久挤没的情况。
//!
//! ## 为什么开关权在 Rust
//! 判据（pending 数 / 会话相位 / 原因行）全在 `RcService`，而主窗可能整场没打开。
//! 触发挂在 `set_notify` 的**过渡**标记上（lib.rs，与「岛」的隐私门控同一招）：
//! 只在形态真的换档时动一次窗口，画质/光标那些 tick 不许把浮层拖着跟鼠标走。
//!
//! ## 内容怎么拿
//! 窗口自己的 JS 是新 webview（拿不到主窗任何 store）。所以挂载后主动
//! `rc_ask_state()` 取一次（**这一步同时解决创建竞态**——Rust 先 emit 也没关系，
//! 前端一上来就问），之后靠 `rc-session-changed` 事件跟着走。

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, Ordering};

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

/// 窗口标签（**必须**同时出现在 `capabilities/default.json` 与
/// `desktop-plugins.json` 的 windows 里，否则前端 invoke 会被权限层拒；
/// 还要在 `paste_engine::TOOL_WINDOW_LABELS` 里，否则它会污染前台窗口判据）。
///
/// 标签叫 `rc-ask` 是历史原因：丙-① 先做，丙-② 复用了同一块窗口（理由见文件头）。
pub const WINDOW_LABEL: &str = "rc-ask";

/// 几何（design/远程电脑-交互审计整改-甲乙丙-设计稿.html §丙-①§丙-② 申报值）：
/// 卡片 320×168 / 胶囊 264×28，窗口四周各多 `BLEED` 留给 CSS 投影。
const ASK_W: f64 = 320.0;
const ASK_H: f64 = 168.0;
const CAP_W: f64 = 264.0;
const CAP_H: f64 = 28.0;
const BLEED: f64 = 12.0;
/// 确认卡离工作区**顶**缘（不是整屏——任务栏压住下半张卡片可以，压住按钮不行）。
const TOP_GAP: f64 = 14.0;
/// 隐私角标离工作区**右下**缘。
const EDGE_GAP: f64 = 12.0;

/// 创建闸：build 是异步落到窗口的，期间另一条过渡路径再进来会重复造窗口。
static CREATING: AtomicBool = AtomicBool::new(false);
/// 上一次落到窗口上的形态：换档才重摆，同档重复 show 不许把浮层拖着跟鼠标走。
static SHOWN_MODE: AtomicU8 = AtomicU8::new(FloatMode::Hidden as u8);
/// 用户把确认卡**主动收起来**的时刻（0 = 没收过）。见 `mode_of` 第 4 参。
static DISMISSED_MS: AtomicI64 = AtomicI64::new(0);

/// 浮层的形态。`as u8` 的稳定编号写进 `SHOWN_MODE`，别重排。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FloatMode {
    Ask = 1,
    Capsule = 2,
    Hidden = 0,
}

impl FloatMode {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Ask,
            2 => Self::Capsule,
            _ => Self::Hidden,
        }
    }
    /// 前端 `rc_ask_state().mode` 的取值（措辞归前端，这里只出档名）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Capsule => "capsule",
            Self::Hidden => "hidden",
        }
    }
    fn card(self) -> (f64, f64) {
        match self {
            Self::Ask => (ASK_W, ASK_H),
            Self::Capsule => (CAP_W, CAP_H),
            Self::Hidden => (ASK_W, ASK_H),
        }
    }
    fn win(self) -> (f64, f64) {
        let (w, h) = self.card();
        (w + BLEED * 2.0, h + BLEED * 2.0)
    }
}

/// 形态判据（**纯函数**，单测直接钉优先级）。
///
/// - `pending_ms`：每条待答申请的到达时刻（`first_seen_ms`）。空 = 没人敲门。
/// - `note_ms`：还新鲜的那条「刚才为什么没了」的时刻；没有则 0。它必须能把窗口
///   留在 `Ask`，否则 pending 归零那一瞬句子就被藏了（设计稿 §丙-① 第③ 点）。
/// - `inbound_live`：本机正被远程中 → 隐私角标。
/// - `dismissed_ms`：用户上次**主动收起**确认卡的时刻。收起不等于答复，所以旧的
///   pending 不该被下一次画质 tick 又顶回来；只有比它更新的申请（或更新的原因）
///   才重新抢回 `Ask`。
pub fn mode_of(pending_ms: &[i64], note_ms: i64, inbound_live: bool, dismissed_ms: i64) -> FloatMode {
    let newest = pending_ms.iter().max().copied().unwrap_or(0).max(note_ms);
    if newest > dismissed_ms {
        FloatMode::Ask
    } else if inbound_live {
        FloatMode::Capsule
    } else {
        FloatMode::Hidden
    }
}

/// 浮层上摆的一条申请（从 `InboundKnock` 投影，字段名与前端 `RcInboundKnock` 同口径）。
#[derive(serde::Serialize)]
pub struct RcAskRow {
    pub peer: String,
    pub peer_name: String,
    pub display_name: String,
    pub capability: String,
    pub first_seen_ms: i64,
}

/// 角标要说的那句「谁在看着这台机器」——被控会话的最小投影。**不含**任何凭证、
/// 也不含帧内容；只有对方是谁、给了什么能力、什么时候开始。
#[derive(serde::Serialize)]
pub struct RcHostRow {
    pub peer: String,
    pub display_name: String,
    pub capability: String,
    pub started_ms: i64,
}

/// 从当前服务状态算形态。服务还没装（启动极早期）按 Hidden。
pub fn mode_now() -> FloatMode {
    let Some(svc) = crate::rc::global() else {
        return FloatMode::Hidden;
    };
    let st = svc.status();
    mode_of(
        &st
            .pending
            .iter()
            .map(|k| k.first_seen_ms)
            .collect::<Vec<_>>(),
        svc.ask_note().map(|n| n.at_ms).unwrap_or(0),
        st.session
            .as_ref()
            .is_some_and(|s| s.phase == crate::rc::SessionPhase::InboundActive),
        DISMISSED_MS.load(Ordering::SeqCst),
    )
}

/// 状态变了 → 换档（**lib.rs 的 notify 只调这一个**）。
///
/// 过渡判据收在这里而不是调用方：`SHOWN_MODE` 本来就是「上一次落到窗口上的形态」，
/// 再让 lib.rs 自己存一个 AtomicU8 就是两份真相（迟早不同步）。画质/光标那些 tick
/// 也会进这条回调，同档必须空转，否则浮层会被鼠标拖着走。
pub fn on_change(app: &AppHandle) {
    // Android 没有浮层窗（原因见 `create` 内注释）：确认面是主界面设备页的
    // 内联申请卡。这条判据放这里收口——所有状态 tick 只进这一个入口。
    if cfg!(target_os = "android") {
        return;
    }
    let target = mode_now();
    if FloatMode::from_u8(SHOWN_MODE.load(Ordering::SeqCst)) == target {
        return;
    }
    sync(app, target);
}

/// 换档判据（纯函数，单测钉「同档空转、跨档必动」）。
///
/// `on_change` 的「同档空转」是刻意的：画质/光标 tick 每秒都会进来，同档重复
/// 弹窗会把浮层拖着走。反过来它也意味着**任何把 `SHOWN_MODE` 记错账的路径**
/// 都会让下一条敲门被判成同档、弹框永远不出现——比不弹更糟的回归。
pub fn need_switch(shown: FloatMode, target: FloatMode) -> bool {
    shown != target
}

/// 按形态开关窗口。只在**过渡**时调（`on_change`），同档重复调用是空转。
pub fn sync(app: &AppHandle, mode: FloatMode) {
    // 与 `on_change` 同一道闸：`rc_ask_hide` 命令也会进这里，Android 上
    // 不许有任何触碰第二块窗的机会（会顶掉主界面）。
    if cfg!(target_os = "android") {
        return;
    }
    match mode {
        FloatMode::Hidden => hide(app),
        FloatMode::Ask | FloatMode::Capsule => show(app, mode),
    }
}

pub fn show(app: &AppHandle, mode: FloatMode) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let prev = FloatMode::from_u8(SHOWN_MODE.load(Ordering::SeqCst));
        if !w.is_visible().unwrap_or(false) || prev != mode {
            apply_geometry(&w, mode);
            SHOWN_MODE.store(mode as u8, Ordering::SeqCst);
            let _ = w.show();
        }
        return;
    }
    create(app, mode);
}

fn hide(app: &AppHandle) {
    SHOWN_MODE.store(FloatMode::Hidden as u8, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        // 归零时**不 close 只 hide**：窗口留着，下一条申请进来秒出（重新 build 一个
        // webview 的代价是几百毫秒白屏，而这条路径正是「有人正在等你答复」，不该卡）。
        let _ = w.hide();
    }
}

/// 落位：光标所在屏的**工作区**（顶缘居中 / 右下角，见各常量注释）。
///
/// 工作区口径与「岛」的停靠位置同一份数据源；`get_cursor_pos` 决定多屏里的哪一块
/// ——别人敲门时用户正在哪块屏上干活，提示就该出现在那块。
fn geometry(mode: FloatMode) -> (f64, f64, f64, f64) {
    let (cx, cy) = crate::screenshot::get_cursor_pos();
    let mon = crate::tray_manager::get_monitor_work_area(cx as f64, cy as f64);
    let scale = if mon.scale > 0.0 { mon.scale } else { 1.0 };
    let (w, h) = mode.win();
    let (wp, hp) = (w * scale, h * scale);
    let (cw, ch) = mode.card();
    let (x, y) = match mode {
        // 卡片**右下**缘离工作区右下缘各 EDGE_GAP；窗口比卡片大 BLEED 一圈，故再外扩。
        FloatMode::Capsule => (
            mon.work_x + mon.work_w - (EDGE_GAP + cw) * scale - BLEED * scale,
            mon.work_y + mon.work_h - (EDGE_GAP + ch) * scale - BLEED * scale,
        ),
        // TOP_GAP 是**卡片**离工作区顶缘的距离；窗口比卡片大 BLEED 一圈，故减掉。
        _ => (
            mon.work_x + (mon.work_w - wp) / 2.0,
            mon.work_y + (TOP_GAP - BLEED) * scale,
        ),
    };
    (x.max(mon.work_x), y.max(mon.work_y), wp, hp)
}

fn apply_geometry(w: &tauri::WebviewWindow, mode: FloatMode) {
    let (x, y, wp, hp) = geometry(mode);
    let _ = w.set_size(tauri::PhysicalSize::new(wp, hp));
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 建窗（桌面专属）。
///
/// 🔴 **Android 必须在此止步**：wry 在 Android 上**每个 Activity 只有一块
/// webview**，`builder.build()` 会走 `activity.setContentView(webview)` 把
/// 主界面的 webview **整块顶掉**。2026-10-03 真机白屏根因正是启动时预热建
/// 这块确认浮层 → 用户打开 App 看到的是 rcask 的空白页而不是主界面。
/// 手机端确认一律走主界面设备页的内联申请卡（`RcInboundAskCard` +
/// `App.tsx` 自动切页）；浮层窗（Ask/Capsule）是桌面专属交互。
fn create(app: &AppHandle, mode: FloatMode) {
    if cfg!(target_os = "android") {
        return;
    }
    if CREATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // 建窗走异步：`run_on_main_thread` 里 build 会重入当前线程的死锁风险，
    // 与栈浮标同一做法（窗口创建必须落在主线程消息队列上）。
    let _ = app.clone().run_on_main_thread(move || {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                CREATING.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset;
        if app.get_webview_window(WINDOW_LABEL).is_some() {
            return;
        }
        let (w, h) = mode.win();
        let builder = WebviewWindowBuilder::new(
            &app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("rcask.html".into()),
        )
        .title("远程电脑 · 桌面浮层")
        .inner_size(w, h)
        .resizable(false)
        .visible(false);
        #[cfg(desktop)]
        let builder = builder
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .transparent(true)
            // 🔴 不抢焦点：用户正在 Word 里打字，弹一个抢焦点的窗等于打断他干活。
            // 浮层上的按钮照样可点（点击会自然激活），只是不替他决定焦点在哪。
            .focused(false);
        match builder.build() {
            Ok(window) => {
                apply_geometry(&window, mode);
                SHOWN_MODE.store(mode as u8, Ordering::SeqCst);
                // 🔴 **刻意不申请 DWM 圆角**（栈浮标/托盘弹窗/快速粘贴都调了它）：
                // 见 todo_island.rs 的实测结论——显式申请 DWM 圆角等于告诉合成器
                // 「这个窗口不透明」，真透明的 layered alpha 一并被压掉，四角露白。
                // 本浮层是深玻璃卡片 + 圆角，形状与阴影全部交给 CSS。
                let _ = window.show();
                log::info!("[RC] 桌面浮层已显示（{}）", mode.as_str());
            }
            Err(e) => {
                // 与栈浮标同口径：浮层是告知放大器，不是失败点。造不出来就静默降级
                // ——主窗那条 toast + 拉起路径仍在，不能因为多一块窗口而让申请本身失败。
                log::warn!("[RC] 桌面浮层创建失败（降级为主窗告知）: {}", e);
            }
        }
    });
}

/// 浮层取当前形态与内容（挂载时问一次 + 每次 `rc-session-changed` 再问）。
///
/// `note` 是「这条申请为什么没了」的一次性原因（超时自动拒绝 / 满员丢最早），
/// **在 TTL 内每次轮询都给**（理由见 `RcService::ask_note`）。
#[tauri::command]
pub fn rc_ask_state() -> serde_json::Value {
    let svc = crate::rc::global();
    let st = svc.as_ref().map(|s| s.status());
    let rows: Vec<RcAskRow> = st
        .iter()
        .flat_map(|s| {
            s.pending.iter().map(|k| RcAskRow {
                peer: k.peer.clone(),
                peer_name: k.peer_name.clone(),
                display_name: k.display_name.clone(),
                capability: k.capability.as_str().to_string(),
                first_seen_ms: k.first_seen_ms,
            })
        })
        .collect();
    let host: Option<RcHostRow> = st.and_then(|s| {
        s.session
            .iter()
            .filter(|x| x.phase == crate::rc::SessionPhase::InboundActive)
            .map(|x| RcHostRow {
                peer: x.peer.clone(),
                display_name: if x.display_name.is_empty() {
                    x.peer_name.clone()
                } else {
                    x.display_name.clone()
                },
                capability: x.capability.as_str().to_string(),
                started_ms: x.started_ms,
            })
            .next()
    });
    let note = svc.as_ref().and_then(|s| s.ask_note());
    serde_json::json!({
        "mode": mode_now().as_str(),
        "pending": rows,
        "note": note,
        "host": host,
    })
}

/// 用户把浮层关掉（不答复）：只收窗口，不动 pending——120s 窗照旧，主窗那条还在。
///
/// 🔴 角标那条**不该被这里关掉**：它是隐私指示，关掉就等于「没人看见我在被远程」。
/// 所以 `mode_now()` 在收起后仍会退回 `Capsule`（若正被远程），只藏掉确认卡。
#[tauri::command]
pub fn rc_ask_hide(app: AppHandle) {
    DISMISSED_MS.store(crate::rc::service::now_ms(), Ordering::SeqCst);
    sync(&app, mode_now());
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_000_000;

    /// 丙-①②：两形态**不共存**，有申请先答，答完角标回来。
    /// 这条优先级是硬要求：角标要是能把确认卡挤掉，用户就再也无法批准任何人。
    #[test]
    fn 形态优先级_申请压过角标() {
        assert_eq!(mode_of(&[T], 0, true, 0), FloatMode::Ask);
        assert_eq!(mode_of(&[], 0, true, 0), FloatMode::Capsule);
        assert_eq!(mode_of(&[], 0, false, 0), FloatMode::Hidden);
    }

    /// 「这条申请为什么没了」那句必须能把窗口留在 Ask：pending 归零那一瞬就收起，
    /// 等于这句话只有写日志的那个人看得见（设计稿 §丙-① 第③ 点）。
    #[test]
    fn 原因行没读完不许收窗口() {
        assert_eq!(mode_of(&[], T, false, 0), FloatMode::Ask);
        // 但过期原因由 ask_note() 的 TTL 拦，不在这里；这里只认「有时刻就必须亮」。
        assert_eq!(mode_of(&[], 0, false, T), FloatMode::Hidden);
    }

    /// 🔴 收起确认卡**不能**把隐私角标一起收掉：那是「有人正在看你屏幕」的指示，
    /// 关掉它正好复现审计 H1。所以 dismiss 只压住 Ask 那一支。
    #[test]
    fn 收起卡片不收起隐私指示() {
        // 用户 5s 时点的收起，申请是 3s 来的 ⇒ 不再顶出卡片
        assert_eq!(mode_of(&[T], 0, true, T + 5000), FloatMode::Capsule);
        assert_eq!(mode_of(&[T], 0, false, T + 5000), FloatMode::Hidden);
        // 比收起那一刻**更新**的申请（第二条敲门）必须把卡片放回来
        assert_eq!(mode_of(&[T + 9000], 0, true, T + 5000), FloatMode::Ask);
        // 新写的原因行同理
        assert_eq!(mode_of(&[], T + 9000, true, T + 5000), FloatMode::Ask);
    }

    /// 档名会写进 `rc_ask_state().mode` 给前端分流，编号与字面量都不许漂移。
    #[test]
    fn 档名与u8编号是前端分流依据() {
        assert_eq!(FloatMode::from_u8(0), FloatMode::Hidden);
        assert_eq!(FloatMode::from_u8(1), FloatMode::Ask);
        assert_eq!(FloatMode::from_u8(2), FloatMode::Capsule);
        assert_eq!(FloatMode::from_u8(9), FloatMode::Hidden);
        assert_eq!(FloatMode::Ask.as_str(), "ask");
        assert_eq!(FloatMode::Capsule.as_str(), "capsule");
        assert_eq!(FloatMode::Hidden.as_str(), "hidden");
    }

    /// 换档判据：同档空转（画质 tick 不许拖着浮层走），跨档必动。任何让
    /// `SHOWN_MODE` 记错账的改动都会在这里先红——后果是「下一条敲门永远不弹」。
    #[test]
    fn 换档判据_同档空转_跨档必动() {
        assert!(need_switch(FloatMode::Hidden, FloatMode::Ask));
        assert!(need_switch(FloatMode::Capsule, FloatMode::Ask));
        // 同档仍然空转（画质 tick 不许把浮层拖着走）
        assert!(!need_switch(FloatMode::Ask, FloatMode::Ask));
        assert!(!need_switch(FloatMode::Hidden, FloatMode::Hidden));
    }
}
