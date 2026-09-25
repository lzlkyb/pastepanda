//! 待办灵动岛（Todo Island）—— 屏幕顶部居中的常驻无焦点小窗。
//!
//! ## 这一版是什么
//!
//! **P0 探针骨架**（`docs/待办灵动岛-实施方案-2026-09-24.md` §4），不是完整功能。
//! 三条风险最高的未知均已验完（结论见右列）：
//!
//! | # | 探什么 | 结论 |
//! |---|---|---|
//! | ① | 窗口级材质与胶囊形状 | **不做窗口级材质**；且必须**不申请 DWM 圆角**（见下节） |
//! | ② | 按光标轮询切换 `set_ignore_cursor_events` | 通过；鼠标不在岛上时 `WindowFromPoint` 不命中岛（穿透生效） |
//! | ③ | 常驻一个 WebView2 的 RSS 增量 | +34 ~ +47 MB |
//!
//! 探针的**判定逻辑与抓屏都在 `todo_island_probe.rs`**（一次性脚手架，验完即删）；
//! 本文件只留窗口生命周期、定位、穿透轮询这些**会长期存在**的部分。
//!
//! ## 材质：窗口级 Acrylic（2026-09-25 档 3a 修订；此前曾定「什么都不加」）
//!
//! | 项 | 结论 |
//! |---|---|
//! | ~~不做窗口级材质~~ | **已修订**：DWM 圆角真凶定位后玻璃障碍解除；液态玻璃探针实测标定浓度，定稿厚磨砂 α.78（配方见 `MATERIAL_DARK/LIGHT`，判据见设计稿 §1） |
//! | ~~α0 Acrylic 当「透明激活器」~~ | 维持排除——它的前提是错的（见上节） |
//! | ~~`set_background_color(0,0,0,0)`~~ | 维持排除：本来就透明 |
//!
//! ## 🔴 全透明自绘窗口**不能申请 DWM 圆角**
//!
//! 微软文档：以「**每像素 alpha 分层**」或「**窗口区域**」呈现的应用**无法**采用圆角设置
//! —— 反过来说，**显式申请了它，DWM 就以「这个窗口不透明」为前提，把 layered alpha 一并压掉**。
//!
//! 实测（2026-09-24，§4.5）：同一个窗口、同样什么都不施加，只去掉 `set_dwm_round_corners()`，
//! 岛体就从 `rgb(242)`（= 白底 255 × CSS 染色，桌面根本没透出来）变成 **`rgb(242) == 窗外桌面色`**
//! （差值 **0**，真透明）。同一次改动还消掉了那个 **126 级四角缺口** ——
//! 缺口的成因正是 DWM 自己的 r≈8 与 CSS 胶囊的 r≈16 两套半径错开、露出中间那圈窗口层。
//!
//! ❗ **与栈浮标 / 托盘弹窗的做法相反**：那两处是**不透明**窗口，必须求系统给圆角；
//! 岛是全透明自绘，要的恰恰是「不要它」。照抄那三处会同时踩中「不透明」和「缺口」两个坑。
//!
//! ## 窗口能力组合（与栈浮标同源，差异两条）
//!
//! | 选项 | 理由 |
//! |---|---|
//! | `decorations(false)` | 无边框，**形状 100% 归 CSS** |
//! | `always_on_top(true)` | 被目标应用盖住等于没显示 |
//! | `skip_taskbar(true)` | 任务栏多出一个幽灵窗口 |
//! | `transparent(true)` | 圆角外要透出桌面；**原生就生效，无需任何效果去激活** |
//! | `focused(false)` | 不抢焦点 |
//! | `shadow(false)` | 原生阴影跟着窗口矩形走，会和胶囊形状打架 |
//! | ❌ **不调 `set_dwm_round_corners`** | 差异①：栈浮标/托盘弹窗/快速粘贴都要它，岛必须不要（见上节） |
//! | `set_ignore_cursor_events` | 差异②，**与栈浮标相反**：栈浮标全程穿透（纯展示），岛要能点 |
//!   —— 但不能常驻收事件，否则 208×32 的胶囊会吃掉它下面应用的点击。所以按光标轮询动态切。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::data_store::DataStore;

/// 窗口标签。
///
/// 🔴 必须与 `paste_engine.rs::PasteEngine::TOOL_WINDOW_LABELS` 里的一致 ——
/// 岛是**常驻可见**的，漏进那张排除表会让 `any_own_window_visible()` 恒为真，
/// 把「手动保存的粘贴目标」无限续命（用户按热键，内容稳定飞到几十分钟前的窗口）。
pub const WINDOW_LABEL: &str = "todo-island";

/// 岛收起态尺寸（与 `TodoIsland.module.css`、`todo_island_stage::stage_size` 是同一份账，
/// 改一处必须同步另两处）。全部舞台的尺寸表见 `todo_island_stage.rs`。
pub const ISLAND_W: f64 = 208.0;
pub const ISLAND_H: f64 = 32.0;

/// 贴屏幕上沿的距离。顶部锚定的定义：**屏幕水平中心 × 屏幕上沿 + 此值**。
///
/// ❗ 展开时顶边钉住不动、只向下生长 —— 即 `set_position` 的 y 恒为它，
/// 只有 x 按新宽度重算（`x = 屏宽/2 - 新宽/2`）。这条是设计稿第六节写定的口径。
pub const TOP_MARGIN: f64 = 10.0;

// ❗ 光标穿透轮询那一整套（滞回常量、`HOVERING` / `POLL_GEN`、`start_poll` / `stop_poll`、
//    `cursor_pos`、对应单测）已切到 `todo_island_hover.rs`：本文件到 590 行、红线 600，
//    而那一块是与窗口创建 / 定位 / 生命周期都无耦合的独立关注点。
//    `is_hovering` 由本模块**原样再导出**，探针（`todo_island_probe.rs`）的调用点不变。

/// 「窗口已显示」事件（Rust → 岛 webview）。
pub const EVENT_SHOWN: &str = "todo-island-shown";
/// 「鼠标是否在岛上」事件。前端据此切 hover 视觉；也用于探针观察轮询是否在跑。
pub const EVENT_HOVER: &str = "todo-island-hover";
/// 「岛状态有更新」事件（Rust → 岛 webview，载荷是 [`IslandState`]）。
pub const EVENT_UPDATE: &str = "todo-island-update";

/// 探针开关的环境变量名。
///
/// ❗ 探针阶段**不把岛做成开机常驻**：那是对用户日常使用的行为变更，属 B1 的账。
/// 带上 `PP_TODO_ISLAND_PROBE=1` 才显示，生产默认不出现。
const PROBE_ENV: &str = "PP_TODO_ISLAND_PROBE";

static CREATING: AtomicBool = AtomicBool::new(false);
/// 页面是否已经加载完（`on_page_load` 打出 `Finished` 后置真）。
///
/// ❗ **不能用 `window.is_visible()` 当这个判据** —— 实测（2026-09-24）`build()` 返回时
/// `is_visible()` 已经是 `true`：builder 上的 `.visible(false)` **在透明窗口上没有兜住**。
/// 拿可见性做守卫，兜底分支会**永不执行**（本文件第一版就是这么写的）。
static PAGE_LOADED: AtomicBool = AtomicBool::new(false);
/// 「要求显示」代次，用于作废挂起的延迟隐藏。
static EPOCH: AtomicU64 = AtomicU64::new(0);
/// 「岛想显示但被独占全屏拦下」。全屏一结束由复活轮询补 show（拍板 6 的另一半）。
static WANT_VISIBLE: AtomicBool = AtomicBool::new(false);
/// 复活轮询代次：hide / 新一轮 show 都会让旧轮询线程自行退出。
static REVIVE_GEN: AtomicU64 = AtomicU64::new(0);

/// 岛的状态快照。
///
/// 存在的理由与栈浮标同款：窗口**首次**创建时，后端 `emit` 可能早于 webview 的 JS 就绪，
/// 事件就丢了 —— 表现为首帧空白。所以后端留一份，前端 mount 时主动拉一次。
///
/// B2 起由 `todo_tasks::compute_island_state` 现算（扫活笔记正文的 GFM 复选框），
/// 不再有人工填的假状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandState {
    /// 待办总数（全库口径，含已完成）
    pub total: u32,
    /// 已完成数
    pub done: u32,
    /// 收起态右侧那句：下一条要做的；全清时「全部完成」；空库为空串
    pub hint: String,
    /// 未完成任务列表（按「今天速记 → updated_ms 降序」排好、截过上限）。
    ///
    /// `serde(default)`：探针期缓存的旧快照没有这个字段，反序列化不能因此挂。
    #[serde(default)]
    pub tasks: Vec<crate::todo_tasks::IslandTask>,
    /// 已完成任务列表（同一排序与上限）。「已完成」标签页用。
    #[serde(default)]
    pub done_tasks: Vec<crate::todo_tasks::IslandTask>,
}

/// 岛最近一次状态快照（`manage` 进 Tauri 状态）。
#[derive(Default)]
pub struct IslandStateCache(pub std::sync::Mutex<Option<IslandState>>);

// ===== 材质（2026-09-25 档 3a「厚磨砂」定稿，design/待办灵动岛-液态玻璃-3a设计稿.html）=====
//
// 🔴 历史备注：本文件头部曾长期写着「材质：什么都不加」——那是 09-24 实测「窗口级玻璃
//    与 CSS 胶囊形状不可兼得」后的结论。后来定位了真凶（DWM 圆角，见下），玻璃的
//    障碍解除；液态玻璃立项后用探针实测标定了浓度（四背景全绿的最低 α≈0.78），
//    于本日起用窗口级 Acrylic。「不申请 DWM 圆角」这条**不变**——它是玻璃能透明的前提。

/// 材质 tint（RGBA，α = 染色不透明度）。α.78 是四背景全绿的最低浓度（探针标定外推，
/// 见设计稿 §1：清透档在「浅色主题+近黑背景」「深色主题+白文档」两个必然场景掉线）。
const MATERIAL_DARK: (u8, u8, u8, u8) = (20, 20, 24, 200);
const MATERIAL_LIGHT: (u8, u8, u8, u8) = (255, 255, 255, 200);

/// 前端 `theme.ts` 六套主题的暗色 key 在 Rust 侧的镜像。❗ 新增主题时必须同步这里
/// （Rust 读不到 TS 的 dark 标志；未知 key 落浅色 = DEFAULT ocean 的档）。
fn theme_is_dark(theme: &str) -> bool {
    matches!(theme, "ocean-dark" | "midnight")
}

/// 按 config.theme 给岛施加对应极性的窗口级 Acrylic。
///
/// ❗ 失败不许静默：CSS 染色已改为近透明（染色由材质接管），材质加不上而没人知道，
/// 岛就「透明消失」了——必须通知前端挂 `data-material="off"` 走实色兜底（CSS 有对应块）。
pub fn apply_theme_material(app: &AppHandle) {
    let Some(store) = app.try_state::<DataStore>() else { return };
    let theme = store
        .get_config()
        .ok()
        .and_then(|c| c.get("theme").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_default();
    drop(store);
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else { return };
    let (r, g, b, a) = if theme_is_dark(&theme) { MATERIAL_DARK } else { MATERIAL_LIGHT };
    let effects = tauri::window::EffectsBuilder::new()
        .effect(tauri::window::Effect::Acrylic)
        .color(tauri::utils::config::Color(r, g, b, a))
        .build();
    if let Err(e) = window.set_effects(Some(effects)) {
        log::warn!("[TodoIsland] 施加 Acrylic 失败（{e}），前端走实色兜底");
        let _ = window.eval("document.documentElement.dataset.material='off';");
    } else {
        let _ = window.eval("delete document.documentElement.dataset.material;");
    }
}

// ===== 定位 =====

/// 主显示器矩形与缩放：`(x, y, w, h, scale)`，位置与尺寸都是**物理像素**。
///
/// ❗ **显式取主屏**而不是「当前窗口所在屏」：多显示器时 y=10 的口径必须先确定是**哪块屏**的顶边，
/// 否则同一份代码在双屏机器上会把岛贴到副屏上沿。
/// 兜底值不是硬编码分辨率，而是「取不到就用 (0,0) + 让窗口系统自己收」—— 见 `calc_top_center`。
///
/// `scale` 一并带出来：调用方要拿它把物理尺寸折成逻辑尺寸（见 `calc_top_center` 的单位教训）。
///
/// `pub(crate)`：探针要回报主屏矩形（`todo_island_probe.rs`）。
pub(crate) fn primary_monitor_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64, f64)> {
    let m = app.primary_monitor().ok().flatten()?;
    let p = m.position();
    let s = m.size();
    Some((
        p.x as f64,
        p.y as f64,
        s.width as f64,
        s.height as f64,
        m.scale_factor(),
    ))
}

// ❗ 这里曾有一整套窗口级材质：`acrylic_recipe(α140)` / `acrylic_recipe_tinted(α)` / `initial_effects()`，
//    连同 `use tauri::window::{Effect, EffectsBuilder}` 一起删了。2026-09-24 实测把三个候选全部排除：
//      · 窗口级 Acrylic 玻璃 —— 业界四份对标一致不做（理由见 `TodoIsland.module.css` 头部）；
//      · α0 Acrylic 当「透明激活器」—— **它的前提是错的**（见下）；
//      · `set_background_color(0,0,0,0)` —— 可用，但本来就透明，不需要。
//
//    **为什么留墓碑**：其中「α0 激活器」那条曾被当成结论写进实施方案文档和 skill，它说
//    「`transparent(true)` 单独不让 webview 透明，必须先用一次效果去激活它」。
//    推翻它只需要去掉一个 DWM 调用 —— 同一个窗口、同样什么都不施加，
//    只把 `set_dwm_round_corners()` 拿掉，岛体就从 `rgb(242)`（白底 255 × CSS 染色）变成
//    `rgb(242) == 窗外桌面色`（**差 0**，真透明）。
//    ⇒ 真凶是 DWM 圆角：它以「这个窗口不透明」为前提，把 layered alpha 一并压掉了。
//
//    「同一份配置、只差一个 DWM 调用、结论相反」比那些函数本身更值得记住 ——
//    判据是：**下结论前先确认对照组的其它变量真的一致**。

// ===== 生命周期 =====

/// 插件初始化（`lib.rs` setup 调一次）。
///
/// **常驻语义（2026-09-24 用户拍板）**：启动即扫一遍真数据，显隐由
/// `refresh_island` 的结果决定——有待办就出现在顶边，全清 1.5s 后收起。
/// 探针开关只保留探针职责（强制显示 + 自动跑探针序列），不再是「唯一的显示入口」。
pub fn init(app: &AppHandle) {
    // 主题切换 → 材质极性跟着翻（设置页前端广播 theme-changed；Rust 用 Listener 接）。
    // 岛隐藏时窗口仍存活，监听照常到达——下次显示即新材质。
    app.listen("theme-changed", {
        let app = app.clone();
        move |_| apply_theme_material(&app)
    });
    let app = app.clone();
    std::thread::spawn(move || {
        // 扫描在独立线程：setup 阶段不值得为它阻塞窗口起来
        let state = crate::todo_tasks::refresh_island(&app);
        if std::env::var(PROBE_ENV).ok().as_deref() == Some("1") {
            log::info!("[TodoIsland] 探针模式开启（{PROBE_ENV}=1），强制显示岛");
            if state.is_none() {
                log::warn!("[TodoIsland] 启动扫描失败（store 未就绪或库异常），岛将以空态显示");
            }
            show(&app);
            // 探针模式顺带自动跑一遍探针序列（A/B 抓屏 + 命中测试 + 内存），结论进日志
            crate::todo_island_probe::run_probe_sequence(app.clone());
        }
    });
}

/// 声明「岛要显示」—— 递增代次，作废所有挂起的延迟隐藏。
fn mark_shown() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn hide_epoch() -> u64 {
    EPOCH.load(Ordering::SeqCst)
}

/// 纯函数：挂起的隐藏是否已作废（期间有人要求显示过）。
fn hide_is_stale(scheduled: u64, current: u64) -> bool {
    scheduled != current
}

// 鼠标当前是否在岛上（探针回报用）。
//
// ❗ 实现已连同 `HOVERING` 一起搬到 `todo_island_hover.rs`；这里**原样再导出**，
//    让 `todo_island_probe.rs` 里那句 `use crate::todo_island::{is_hovering, ..}` 不必改，
//    模块边界也保持「探针只认 todo_island」这一个入口。
pub(crate) use crate::todo_island_hover::is_hovering;

/// 显示岛（创建或复用缓存窗口）。
///
/// ❗ **独占全屏时不弹**（拍板 6）：全屏里岛会盖住游戏 HUD / 放映内容，还会被
/// 截图与推流抓走。点亮意图（`mark_shown`）**先落账**——哪怕显示本身被推迟，
/// 挂起的「全清 1.5s 收起」也必须被作废；推迟的显示由复活轮询在全屏结束后补上。
pub fn show(app: &AppHandle) {
    mark_shown();
    if crate::todo_island_fullscreen::foreground_is_exclusive_fullscreen() {
        WANT_VISIBLE.store(true, Ordering::SeqCst);
        start_revive_poll(app);
        log::info!("[TodoIsland] 独占全屏中，岛显示推迟到全屏结束");
        return;
    }
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            recenter(app, &window);
            return;
        }
        reveal(app, &window);
        return;
    }
    create(app);
}

/// 按**当前舞台**的宽度重新居中。
///
/// ❗ 不能写死 `ISLAND_W`：展开态（420 宽）下任何一次笔记变动都会走到 show()，
/// 按胶囊宽（208）算 x 会把岛右偏 (420−208)/2 = 106px，直到下次切舞台才纠正。
fn recenter(app: &AppHandle, window: &WebviewWindow) {
    let (w, _) = crate::todo_island_stage::stage_size(crate::todo_island_stage::current_stage());
    let _ = window.set_position(crate::todo_island_stage::calc_top_center_for(app, w));
}

/// 隐藏岛。
pub fn hide(app: &AppHandle) {
    // 隐藏即收回「想显示」的意图，旧复活轮询靠代次自行退出
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    REVIVE_GEN.fetch_add(1, Ordering::SeqCst);
    // 停轮询与复位悬停状态必须成对：只停线程不复位，下次显示时 `HOVERING` 会以
    // 「进来过」的身份启动，第一轮就按 12px 的离开外扩判定（详见 todo_island_hover.rs）。
    crate::todo_island_hover::stop_poll();
    crate::todo_island_hover::reset_hovering();
    if let Some(cache) = app.try_state::<IslandStateCache>() {
        if let Ok(mut guard) = cache.0.lock() {
            *guard = None;
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            log::info!("[TodoIsland] 已隐藏");
        }
    }
}

/// 延迟隐藏 —— 给「刚勾完最后一条」这类终态留可见时间。
///
/// ❗ 醒来后必须比对代次：期间若岛被重新点亮，这次隐藏必须放弃。
pub fn hide_after(app: &AppHandle, delay_ms: u64) {
    let app = app.clone();
    let scheduled = hide_epoch();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if hide_is_stale(scheduled, hide_epoch()) {
            log::info!("[TodoIsland] 延迟隐藏作废：期间岛已被重新点亮");
            return;
        }
        hide(&app);
    });
}

/// 复活轮询：全屏期间被拦下的显示意图，全屏一结束就补上。
///
/// 1s 一次的原生调用（GetForegroundWindow + 矩形比较），微秒级；退出条件三条：
/// 代次失效（又 show / hide 过）、意图被收回、已经显示了。不停循环的场景只有
/// 「用户全屏挂机 + 有待办」——那正是岛该等着的场景（规则 #8.1：不可见即停）。
fn start_revive_poll(app: &AppHandle) {
    let mine = REVIVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            if REVIVE_GEN.load(Ordering::SeqCst) != mine || !WANT_VISIBLE.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
            if REVIVE_GEN.load(Ordering::SeqCst) != mine || !WANT_VISIBLE.load(Ordering::SeqCst) {
                return;
            }
            if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                if w.is_visible().unwrap_or(false) {
                    WANT_VISIBLE.store(false, Ordering::SeqCst);
                    return;
                }
            }
            if crate::todo_island_fullscreen::foreground_is_exclusive_fullscreen() {
                continue;
            }
            WANT_VISIBLE.store(false, Ordering::SeqCst);
            log::info!("[TodoIsland] 全屏结束，补上被推迟的显示");
            show(&app);
            return;
        }
    });
}

/// 显示已存在的缓存窗口：重定位 → 复穿透轮询 → 通知前端 → show。
///
/// ❗ 与栈浮标一致，**刻意不调 `set_focus()`**：抢了焦点，用户在别处打的字会落进岛。
fn reveal(app: &AppHandle, window: &WebviewWindow) {
    mark_shown();
    recenter(app, window);
    let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOWN, ());
    let _ = window.show();
    crate::todo_island_hover::start_poll(app);
    log::info!("[TodoIsland] 已显示（复用缓存窗口）");
}

/// 首次创建岛窗口。仿 `stack_hud.rs::create` 的结构：独立线程 + 防重入 + 双重检查。
fn create(app: &AppHandle) {
    if CREATING.swap(true, Ordering::SeqCst) {
        log::info!("[TodoIsland] 窗口创建中，忽略重复调用");
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

        if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
            reveal(app, &existing);
            return;
        }

        // 探针③基线：**创建 webview 之前**采一次（判定细节全在 todo_island_probe.rs）
        crate::todo_island_probe::mark_rss_baseline();

        let pos = crate::todo_island_stage::calc_top_center_for(app, ISLAND_W);

        // 档 3a（2026-09-25）：窗口级 Acrylic 在这里施加（`apply_theme_material`，
        // 配方与失败兜底见函数注释）。曾经「三种候选全部排除、什么都不加」的结论
        // 已被液态玻璃立项修订——但「**不申请 DWM 圆角**」这条不变，它是玻璃透明的前提。
        let wb = WebviewWindowBuilder::new(
            app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("todoisland.html".into()),
        )
        .title("")
        .inner_size(ISLAND_W, ISLAND_H)
        .position(pos.x, pos.y)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .focused(false)
        .visible(false)
        // ❗ **等页面加载完再 show** —— 这条是本轮实测出来的，不是「保险起见」。
        //
        // `build()` 返回时 webview 只是**被创建**，页面还在加载。此时立刻 `show()`，
        // 屏幕上出现的是一块**纯白矩形**（WebView2 的默认底色），持续到页面渲染出内容为止。
        //
        // 实测：`build()` 后直接 show，4 秒后抓图，岛中心仍是 `rgb(242)`、主屏对角线上
        // 27 个采样点**全是桌面色** —— 岛整个不可见；而**同一个页面用浏览器打开渲染完全正常**
        // （深色胶囊、文字、进度环都在）。两条合起来把根因钉死在「显示时机」而非前端代码。
        //
        // ❗ 这也解释了旧实现那套「施加 α0 Acrylic → 等 700ms → `set_effects(None)`」为什么看起来有效：
        // 那 700ms 的等待（外加 `set_effects` 触发的一次重合成）**恰好**跨过了页面加载窗口。
        // **别把「等一等就好了」误读成「effects 是必需的」** —— 那是两个机制，后者已被 §4.5 排除。
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                // 先置真再 show：兜底线程以它为准（不能用 `is_visible()`，见 `PAGE_LOADED` 的注释）。
                PAGE_LOADED.store(true, Ordering::SeqCst);
                let app = window.app_handle();
                let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOWN, ());
                // 首帧显示同样要过全屏门：启动瞬间恰在全屏应用里，岛不该顶出来
                if crate::todo_island_fullscreen::foreground_is_exclusive_fullscreen() {
                    let _ = window.hide();
                    WANT_VISIBLE.store(true, Ordering::SeqCst);
                    start_revive_poll(app);
                    log::info!("[TodoIsland] 页面加载完成，但全屏中——显示推迟");
                    return;
                }
                let _ = window.show();
                crate::todo_island_hover::start_poll(app);
                log::info!("[TodoIsland] 页面加载完成，岛已显示");
            }
        });

        match wb.build() {
            Ok(window) => {
                let _ = window.set_position(pos);

                // 档 3a：按主题极性施加窗口级 Acrylic（浓度配方与失败兜底见
                // `apply_theme_material`）；CSS 侧染色已改为近透明，由材质接管。
                apply_theme_material(app);
                // 初始舞台（胶囊）的形状裁剪：消除圆角外的方角玻璃（月牙）。
                crate::todo_island_stage::apply_stage_region(
                    app,
                    &window,
                    crate::todo_island_stage::IslandStage::Pill,
                );

                // ❗ **立刻显式隐藏**，不能只靠 builder 上的 `.visible(false)`。
                //
                // 实测（2026-09-24）：`build()` 返回时 `is_visible()` **已经是 `true`** ——
                // 也就是说那条 `.visible(false)` 至少没有反映到「可查询的状态」上。
                // 两种可能：① 窗口真的被显示出来了；② tao 报的是它自己的缓存标志、实际没显示。
                // **机制未查明**（已排除 window-state 插件：`.window-state.json` 无 `todo-island` 条目）。
                //
                // 不赌的原因：可能性 ① 会让一个空白窗口在那几秒里**静默吃掉点击**。
                // `hide()` 是真 `ShowWindow(SW_HIDE)`，把「还没画完就不该出现」变成**事实**而非意向。
                let _ = window.hide();

                // ❗ **刻意不申请 DWM 圆角**（22:30 对标结论；原实现那行是从栈浮标抄来的）。
                //
                // 栈浮标**不透明**，必须求系统给它圆角；岛是**全透明自绘**窗口，需要的恰恰相反。
                // 微软文档写得很直白：「每像素 alpha 分层」或「窗口区域」的应用**无法**采用
                // 圆角设置 —— 也就是透明自绘窗口本来就不该有系统圆角，**显式申请才会拿到**。
                //
                // 拿到的半径是 DWM 自己的固定值（实测 ≈8 物理 px @125%），而 CSS 要的是
                // `border-radius: 999px` 的 16px 半圆 ⇒ 两套半径从四角错开，露出 DWM 那一层。
                // **这就是实测 126 级缺口的真凶**，跟玻璃无关（原归因「玻璃与 CSS 形状不可兼得」是错的）。
                //
                // 同栈对照：PILLAR（Tauri 2 + React，Windows 灵动岛）的 `platform/windows.rs`
                // 整个文件零 DWM 调用 —— 形状 100% 归 CSS，这是可信的先例。
                #[cfg(target_os = "windows")]
                {
                    // ❗ 初始必须是**穿透**（`true` = 忽略光标），不是收事件。
                    //
                    // 实测：`build()` 返回时 `is_visible()` **已经是 `true`**（builder 上的
                    // `.visible(false)` 在透明窗口上没兜住），而页面还要几秒才画完 ——
                    // 这几秒里窗口是「可见 + 空白 + always-on-top」。
                    // 此时若设成收事件，它会**静默吃掉**屏幕顶部中间那块（物理 260×47）的点击：
                    // 用户去点下面的浏览器标签栏会发现点不动，而且**看不出是谁挡的**。
                    //
                    // 穿透状态由轮询接管 —— `on_page_load` 里 `show()` 之后才 `start_poll`，
                    // 第一轮 `step_hover` 就按光标位置定成正确值（在岛上 → `false` 收事件；
                    // 不在 → 保持 `true` 穿透）。
                    let _ = window.set_ignore_cursor_events(true);
                }

                crate::todo_island_probe::report_rss_delta();

                // 显示动作在 `on_page_load` 里（理由见 builder 上那段注释）。
                // 兜底：万一下一帧页面加载事件没触发（加载失败等），2.5s 后强制显示 ——
                // 「岛一直不出现」比「岛早出现 1 秒」严重得多。
                let app_fallback = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    // ❗ 判据是 `PAGE_LOADED`，**不是 `w.is_visible()`** —— 后者从 `build()`
                    // 起就是 `true`，拿它做守卫会让这个兜底**永不执行**：保险丝自己是断的，
                    // 比没装保险丝更糟（它给人一种「已经保过底了」的错觉）。
                    if PAGE_LOADED.load(Ordering::SeqCst) {
                        return;
                    }
                    let Some(w) = app_fallback.get_webview_window(WINDOW_LABEL) else {
                        return;
                    };
                    log::warn!("[TodoIsland] 页面加载事件未触发，兜底显示");
                    let _ = app_fallback.emit_to(WINDOW_LABEL, EVENT_SHOWN, ());
                    let _ = w.show();
                    crate::todo_island_hover::start_poll(&app_fallback);
                });
                log::info!("[TodoIsland] 岛窗口已创建，等页面加载完成后显示");
            }
            Err(e) => {
                // 岛是反馈层，不是失败点：创建不了就静默降级，主流程照走。
                log::warn!("[TodoIsland] 创建岛窗口失败: {e}");
            }
        }
    });
}

// ===== 命令 =====

/// 显示岛
#[tauri::command]
pub fn todo_island_show(app: AppHandle) {
    show(&app);
}

/// 隐藏岛；`delay_ms > 0` 时延迟隐藏
#[tauri::command]
pub fn todo_island_hide(app: AppHandle, delay_ms: Option<u64>) {
    match delay_ms {
        Some(ms) if ms > 0 => hide_after(&app, ms),
        _ => hide(&app),
    }
}

/// 拉取最近一次状态 —— 岛前端 mount 时调，解决「后端 emit 早于 webview 就绪」的首帧空白。
#[tauri::command]
pub fn todo_island_state(cache: tauri::State<'_, IslandStateCache>) -> Option<IslandState> {
    cache.0.lock().ok().and_then(|g| g.clone())
}

/// 推一份状态进岛：更新快照缓存 + 广播给岛窗口。
///
/// 这是岛状态的**唯一**推送出口（`todo_tasks::refresh_island` 调它）——
/// 任何别的代码想更新岛状态都该走它，两处各推一次就会漂成「显示 A、实际 B」。
pub fn push_state(app: &AppHandle, state: IslandState) {
    if let Some(cache) = app.try_state::<IslandStateCache>() {
        if let Ok(mut guard) = cache.0.lock() {
            *guard = Some(state.clone());
        }
    }
    let _ = app.emit_to(WINDOW_LABEL, EVENT_UPDATE, state);
}

/// 推送岛状态（保留给前端 / 探针手动推；常规路径走 `todo_tasks::refresh_island`）。
#[tauri::command]
pub fn todo_island_update(app: AppHandle, state: IslandState) {
    push_state(&app, state);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标签必须与 paste_engine 的排除表一致。
    ///
    /// 岛是**常驻可见**的，漏进排除表的后果比栈浮标更严重：栈浮标只在栈模式期间出现，
    /// 而岛一直都在 —— `any_own_window_visible()` 会**恒**为真，
    /// 「手动保存的粘贴目标」于是永不过期，用户按热键内容稳定飞到几十分钟前那个窗口。
    #[test]
    fn test_window_label_matches_paste_engine_exclusion() {
        assert!(
            crate::paste_engine::PasteEngine::TOOL_WINDOW_LABELS.contains(&WINDOW_LABEL),
            "todo-island 必须在 paste_engine 的工具窗排除表里，否则常驻的岛会让前台窗口判据恒为真"
        );
    }

    /// 挂起的延迟隐藏必须被「重新显示」作废。
    ///
    /// 真实场景：勾完最后一条 → 排定 1.5s 后收起 → 1.5s 内又来了一条待办 → 岛被点亮
    /// → 不做代次校验的话，那个挂起的线程醒来就把它关掉，用户看到岛闪一下就没。
    #[test]
    fn test_scheduled_hide_is_stale_after_reshown() {
        let epoch = AtomicU64::new(0);
        let scheduled = epoch.load(Ordering::SeqCst);
        epoch.fetch_add(1, Ordering::SeqCst); // 期间重新点亮
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

    // ❗ 与悬停轮询有关的两条判据都**随实现一起搬到 `todo_island_hover.rs`** 了：
    //      · `test_hover_poll_gen_bump_invalidates_old_poll`
    //      · `const _: () = assert!(HOVER_IN_PAD < HOVER_OUT_PAD);`（编译期断言）
    //    它们测的对象在那个文件里，留在这里只能测到局部变量，等于自证。
}
