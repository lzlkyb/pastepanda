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
/// 「舞台已被 Rust 复位」（hide 时广播）：前端据此把 React 舞台同步回胶囊——
/// 否则展开态收岛后再点亮，窗口按旧舞台尺寸出现（审计 P3#22）。
pub const EVENT_STAGE_RESET: &str = "todo-island-stage-reset";

/// 隐私门控：被控会话（对方正在看本机画面）/ 截屏期间，岛绝不允许出现。
///
/// 为什么是门控而不是「开始时 hide 一次」：会话期间任何笔记写路径都会走
/// `refresh_island → apply_resident_visibility → show`，没有门的话岛会在对方
/// 画面里再次弹出来（审计 P2#4，隐私钩子被绕过）。show() 是四条路的收口，
/// 门拦在它入口处，第七个调用点出现时也不会漏。
static PRIVACY_GATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn privacy_on() -> bool {
    PRIVACY_GATE.load(Ordering::SeqCst)
}

/// 探针开关的环境变量名。
///
/// ❗ 探针阶段**不把岛做成开机常驻**：那是对用户日常使用的行为变更，属 B1 的账。
/// 带上 `PP_TODO_ISLAND_PROBE=1` 才显示，生产默认不出现。
pub(crate) const PROBE_ENV: &str = "PP_TODO_ISLAND_PROBE";

static CREATING: AtomicBool = AtomicBool::new(false);
/// 「首帧点亮序列是否已执行」。三条信号（前端首帧回报 / `on_page_load` / 兜底保险丝）
/// 谁先到谁执行，`swap` 守卫保证只跑一次——重复 `show()`/`start_poll()` 本身无害，
/// 但全屏门的「推迟」分支只能进一次，否则 WANT_VISIBLE 语义被搅乱。
///
/// ❗ 守卫判据**不能用 `window.is_visible()`** —— 实测（2026-09-24）`build()` 返回时
/// `is_visible()` 已经是 `true`：builder 上的 `.visible(false)` **在透明窗口上没有兜住**。
/// 拿可见性做守卫，兜底分支会**永不执行**（本文件第一版就是这么写的）。
static SHOW_DONE: AtomicBool = AtomicBool::new(false);
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    /// 到点提醒的那条（提醒态胶囊显示它）。None = 当前没有提醒。
    ///
    /// 只由 `push_state` 按 [`RemindLedger`] 注入——任何自己拼 `IslandState` 的地方
    /// 都**不该**手填这个字段（规则 #11.1：注入收口在唯一推送出口）。
    #[serde(default)]
    pub due_alert: Option<crate::todo_tasks::IslandTask>,
}

/// 岛最近一次状态快照（`manage` 进 Tauri 状态）。
#[derive(Default)]
pub struct IslandStateCache(pub std::sync::Mutex<Option<IslandState>>);

// ===== 材质与配置（2026-09-25 红色探针定稿：玻璃走 CSS，不走窗口级材质）=====
//
// 🔴 历史备注：本文件头部曾长期写着「材质：什么都不加」——那是 09-24 实测「窗口级玻璃
//    与 CSS 胶囊形状不可兼得」后的结论。后来 3a 立项用窗口级 Acrylic 承载玻璃
//    （design/待办灵动岛-液态玻璃-3a设计稿.html），**2026-09-25 红色探针把它推翻了**：
//    把 tint 改成纯红 α255 后，在 stadium rgn **外**的角点 (3,3) 抓到 rgb(228,10,10)——
//    **DWM 材质层不服从 SetWindowRgn**，胶囊四角的「方块玻璃」是该路线的固有产物，
//    调形状永远调不掉。社区同证：tauri#9287、dev.to「Acrylic 配不了圆角」；
//    对标 PILLAR 的 platform/windows.rs 零 DWM 调用、岛面 = CSS rgba(.94)。
//    ⇒ 定稿：窗口回到**纯全透明**，玻璃 = CSS 半透明面（一个「遮盖度」数驱动，
//    配方见 TodoIsland.module.css 的材质令牌块）。「不申请 DWM 圆角」不变。

/// 岛的配置切片（读 DataStore，键由设置页「灵动岛」分区写）。
///
/// 缺省 = 总开关**关**（新用户须自己在设置页「灵动岛」分区打开）/ 提醒开 / 横幅 30s。
/// 玻璃透度（`todo_island_glass`，遮盖度 20–100）由
/// **前端**读（材质在 CSS，见 todoisland-main.tsx），Rust 不消费它。
pub(crate) struct IslandConfig {
    pub enabled: bool,
    pub remind: bool,
    pub remind_ms: i64,
}

/// 读岛配置。❗ 缺省值必须与 `appStore.ts` 的 `DEFAULT_CONFIG` / `IslandSection.tsx` 一致。
pub(crate) fn island_config(app: &AppHandle) -> IslandConfig {
    let mut c = IslandConfig { enabled: false, remind: true, remind_ms: 30_000 };
    let Some(store) = app.try_state::<DataStore>() else { return c };
    let Ok(cfg) = store.get_config() else { return c };
    if let Some(v) = cfg.get("todo_island_enabled").and_then(|v| v.as_bool()) {
        c.enabled = v;
    }
    if let Some(v) = cfg.get("todo_island_remind").and_then(|v| v.as_bool()) {
        c.remind = v;
    }
    if let Some(ms) = cfg
        .get("todo_island_remind_ms")
        .and_then(|v| v.as_i64())
        .filter(|ms| (5_000..=300_000).contains(ms))
    {
        c.remind_ms = ms;
    }
    c
}

/// 探针模式绕过一切用户门控（开发诊断不陪绑配置）。
fn probe_on() -> bool {
    std::env::var(PROBE_ENV).ok().as_deref() == Some("1")
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
    // 配置变更 → 开关即时生效（设置页前端保存后广播 todo-island-config-changed）。
    // 开 = show()（窗口不存在会现建，show 内部有 enabled 门控）；关 = hide。
    // 玻璃档位/提醒时长不用 Rust 搬运：tick 每轮现读配置，材质由岛前端自己读。
    app.listen("todo-island-config-changed", {
        let app = app.clone();
        move |_| {
            if island_config(&app).enabled {
                show(&app);
            } else {
                hide(&app);
                log::info!("[TodoIsland] 已按配置关闭（隐藏，窗口保留待重开）");
            }
        }
    });
    // 提醒轮询（二期「甲案：岛即提醒」）：到点点亮岛 + 横幅，见 `remind_tick`。
    // ❗ 常驻不因「提醒关」而停——每轮 tick 自己读配置（关 = 只做收账），开关来回翻不用重启线程。
    {
        let app = app.clone();
        std::thread::spawn(move || remind_loop(app));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // 扫描在独立线程：setup 阶段不值得为它阻塞窗口起来
        let state = crate::todo_tasks::refresh_island(&app);
        if probe_on() {
            log::info!("[TodoIsland] 探针模式开启（{PROBE_ENV}=1），强制显示岛");
            if state.is_none() {
                log::warn!("[TodoIsland] 启动扫描失败（store 未就绪或库异常），岛将以空态显示");
            }
            show(&app);
            // 探针模式顺带自动跑一遍探针序列（A/B 抓屏 + 命中测试 + 内存），结论进日志
            crate::todo_island_probe::run_probe_sequence(app.clone());
        } else if !island_config(&app).enabled {
            log::info!("[TodoIsland] 配置为关闭，启动不显示岛");
        }
        // enabled 时这里什么都不做：常驻语义（2026-09-24 用户拍板）由 refresh_island
        // 的推送决定显隐（有待办才出现）；show() 内部的 enabled 门控继续兜底。
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
    // 用户总开关（探针绕过）。收口在这里而非每个调用点：refresh/提醒/命令/配置变更
    // 四条路都汇到 show，第七个调用点出现时也不会漏门。
    if !probe_on() && !island_config(app).enabled {
        return;
    }
    // 隐私门控（被控会话/截屏中）：岛绝不在对方画面里出现。放在 mark_shown 之前——
    // 会话中的「点亮意图」本身就不该成立（生效路径见 PRIVACY_GATE 注释）。
    if privacy_on() {
        return;
    }
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
    // 已可见路径同样重放 rgn：写路径的 show 都汇聚到这里，方角玻璃最多活到下次写
    crate::todo_island_stage::reapply_stage_region(app);
}

/// 隐藏岛。
pub fn hide(app: &AppHandle) {
    hide_inner(app, true);
}

/// 门控专用的收岛：**保留状态缓存**——隐藏期间 remind_tick 靠它继续挑任务记账，
/// 到点的提醒先挂账、门一关随 refresh 补显，不丢也不会在会话结束时轰炸
/// （审计 P3「隐藏期间提醒丢失」）。缓存清掉的话 tick 直接空转，提醒全灭。
pub(crate) fn hide_keep_state(app: &AppHandle) {
    hide_inner(app, false);
}

fn hide_inner(app: &AppHandle, clear_cache: bool) {
    // 隐藏即收回「想显示」的意图，旧复活轮询靠代次自行退出
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    REVIVE_GEN.fetch_add(1, Ordering::SeqCst);
    // 停轮询与复位悬停状态必须成对：只停线程不复位，下次显示时 `HOVERING` 会以
    // 「进来过」的身份启动，第一轮就按 12px 的离开外扩判定（详见 todo_island_hover.rs）。
    crate::todo_island_hover::stop_poll();
    crate::todo_island_hover::reset_hovering();
    if clear_cache {
        if let Some(cache) = app.try_state::<IslandStateCache>() {
            if let Ok(mut guard) = cache.0.lock() {
                *guard = None;
            }
        }
    }
    // 🔴 舞台复位（审计 P3#22）：展开态收岛后 CURRENT_STAGE 若停在 List，
    //    下次点亮窗口会按 420 宽展开尺寸突然出现。复位成胶囊并广播，
    //    前端把 React 舞台同步回去。
    crate::todo_island_stage::set_current_stage(crate::todo_island_stage::IslandStage::Pill);
    let _ = app.emit_to(WINDOW_LABEL, EVENT_STAGE_RESET, ());
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            log::info!("[TodoIsland] 已隐藏");
        }
    }
}

/// 隐私门控开关（收口点：被控会话 / 截屏期的所有 show 都在 show() 入口拦下）。
///
/// 开 = 立即收岛但保留状态缓存（`hide_keep_state`）；关 = refresh 恢复常驻可见性。
/// 重复同向调用是空操作（截图/长截图/会话可能层层叠加）。
pub fn set_privacy_gate(app: &AppHandle, on: bool) {
    if PRIVACY_GATE.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if on {
        log::info!("[TodoIsland] 隐私门控开启：岛收起，会话/截屏结束后自动恢复");
        hide_keep_state(app);
    } else {
        log::info!("[TodoIsland] 隐私门控解除");
        crate::todo_tasks::refresh_island(app);
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
    // rgn 自愈（2026-09-25 月牙复发）：on_page_load 常不触发、动画终帧可被作废，
    // show 是唯一每次都会走的入口——重放一次形状裁剪兜底。
    crate::todo_island_stage::reapply_stage_region(app);
    crate::todo_island_hover::start_poll(app);
    log::info!("[TodoIsland] 已显示（复用缓存窗口）");
}

/// 首帧点亮序列：通知前端 → 初始 rgn → 全屏门 → show → 穿透轮询。
///
/// 三条触发信号谁先到谁执行（`SHOW_DONE` 保证只跑一次）：
/// ① 前端首帧提交后 invoke `todo_island_page_ready`（**常规路径**）；
/// ② `on_page_load(Finished)`（webview 加载完成）；
/// ③ 6s 兜底保险丝（页面彻底挂了也得让岛出来）。
///
/// ❗ 为什么信号①是必需的（2026-09-25 用户实拍）：旧版只有②③，而③只等 2.5s——
/// dev 冷加载实测 ~5.5s，保险丝**抢先**把一个**什么都没画的透明窗** show 出来，
/// 后面的浏览器窗（标签栏、_ □ ✕ 标题钮）整个透到「岛上」。信号①在 React
/// 提交首帧后才到，从机制上保证「show 出来时内容已经画完」。
fn first_show(app: &AppHandle, window: &WebviewWindow, reason: &str) {
    if SHOW_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, EVENT_SHOWN, ());
    // 初始舞台（胶囊）的形状裁剪：此时尺寸已落定，读实测值与 CSS（填满窗口）对齐。
    if let Ok(s) = window.outer_size() {
        crate::todo_island_stage::apply_stage_region(
            window,
            crate::todo_island_stage::IslandStage::Pill,
            (s.width as i32, s.height as i32),
        );
    }
    // 首帧显示同样要过全屏门：启动瞬间恰在全屏应用里，岛不该顶出来
    if crate::todo_island_fullscreen::foreground_is_exclusive_fullscreen() {
        let _ = window.hide();
        WANT_VISIBLE.store(true, Ordering::SeqCst);
        start_revive_poll(app);
        log::info!("[TodoIsland] {reason}，但全屏中——显示推迟");
        return;
    }
    let _ = window.show();
    crate::todo_island_hover::start_poll(app);
    log::info!("[TodoIsland] {reason}，岛已显示");
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

        // 材质说明（2026-09-25 红色探针定稿）：这里**刻意没有任何窗口级 effects**——
        // DWM Acrylic 层不服从 SetWindowRgn（探针实锤见本文件「材质与配置」节），
        // 玻璃由岛前端的 CSS 半透明面承载（遮盖度 `--island-glass`）。
        // 「**不申请 DWM 圆角**」这条不变，它是窗口真透明的前提。
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
                first_show(window.app_handle(), &window, "页面加载事件");
            }
        });

        match wb.build() {
            Ok(window) => {
                let _ = window.set_position(pos);

                // 初始舞台（胶囊）的形状裁剪：消除圆角外的方角玻璃（月牙）。
                // ❗ 不能在 build 后立刻做——outer_size 那时**还没落定**（实测返回 (0,0)），
                //   rgn 会被裁成 1×1、整个岛消失（02:03 那轮实测翻过车）。挪到 on_page_load，
                //   页面加载完时尺寸早已落定，读实测值与 CSS（填满窗口）精确对齐。

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

                // 显示动作在 first_show 里（三条信号，见其注释）。
                // 兜底保险丝：6s 内三条信号一个都没来（页面加载失败 / React 崩了）才强制点亮——
                // 「岛一直不出现」确实比「晚出现」严重，但❗不能把保险丝调短来抢跑：
                // 2.5s 时代实测（2026-09-25）dev 冷加载要 ~5.5s，保险丝抢先 show 出一块
                // 什么都没画的透明窗，后面的浏览器窗整个透到「岛上」（用户实拍他窗标题栏）。
                let app_fallback = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(6000));
                    // ❗ 判据是 `SHOW_DONE`，**不是 `w.is_visible()`** —— 后者从 `build()`
                    // 起就是 `true`，拿它做守卫会让这个兜底**永不执行**：保险丝自己是断的，
                    // 比没装保险丝更糟（它给人一种「已经保过底了」的错觉）。
                    if SHOW_DONE.load(Ordering::SeqCst) {
                        return;
                    }
                    let Some(w) = app_fallback.get_webview_window(WINDOW_LABEL) else {
                        return;
                    };
                    log::warn!("[TodoIsland] 6s 内无「页面已画完」信号，兜底显示");
                    first_show(&app_fallback, &w, "兜底保险丝");
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

/// 前端首帧提交后的「我画完了」回报 —— 岛点亮的**常规信号①**（机制见 `first_show`）。
///
/// ❗ 岛前端在两帧 RAF 后调用；后端不校验调用次数，守卫在 `SHOW_DONE`。
#[tauri::command]
pub fn todo_island_page_ready(app: AppHandle) {
    let Some(w) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    first_show(&app, &w, "前端首帧回报");
}

// ===== 提醒（二期甲案：岛即提醒；时序与落地账见设计稿「提醒与截止时间」§5） =====

/// 轮询步进。15s 粒度 + 90s 窗口 = 错过一次还有 5 次机会，且纯内存读取。
const REMIND_POLL_MS: u64 = 15_000;
/// 超过这个「迟到量」不再弹（应用休眠恢复/启动时，几分钟前到期的任务静默记账）。
const REMIND_GRACE_MS: i64 = 90_000;

/// 提醒账本（`manage` 进 Tauri 状态）。
///
/// - `fired`：已提醒过的任务键（`noteId:line:dueMs`）——一条任务一个到期点只报一次，
///   应用重启后「启动时已过期」的也走这里静默记账（错过不补，防开机轰炸）；
/// - `active`：当前横幅。`push_state` 注入 `dueAlert` 的唯一依据。
#[derive(Default)]
pub struct RemindLedger(std::sync::Mutex<RemindInner>);

#[derive(Default)]
struct RemindInner {
    fired: std::collections::HashSet<String>,
    active: Option<(String, i64)>,
}

/// 提醒键：同一篇同一行同一到期点才视为「同一条」——行号漂移/改时间都算新的一条。
fn remind_key(t: &crate::todo_tasks::IslandTask) -> String {
    format!("{}:{}:{}", t.note_id, t.line, t.due_ms.unwrap_or(0))
}

/// push 前按账本注入 `dueAlert`（收口点：这是唯一注入处）。
///
/// 横幅挂着时，任何写路径的 refresh 推送都会重新注入——横幅不会被
/// 中途的笔记写入「顺手」顶掉；任务被勾掉（不在 pending 里）自然消失。
pub(crate) fn inject_remind(ledger: &RemindLedger, state: &mut IslandState) {
    let Ok(mut inner) = ledger.0.lock() else { return };
    let Some((key, _)) = &inner.active else { return };
    if let Some(t) = state.tasks.iter().find(|t| &remind_key(t) == key) {
        state.due_alert = Some(t.clone());
    } else {
        // 被提醒的那条没了（勾掉/删除/改时间）——横幅即时结束
        inner.active = None;
    }
}

/// 提醒主循环（init 里 spawn，应用生命周期常驻）。
///
/// ❗ 15s 一次、纯内存读取（快照 + 账本），无网络无 IO——规则 #8.1 的
/// 「不可见即停」不适用于它：岛隐藏时**正是**它要点亮岛的时候，这是功能本体。
fn remind_loop(app: AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(REMIND_POLL_MS));
        remind_tick(&app);
    }
}

/// 上一轮 tick 的时刻（时钟回拨检测用；0 = 首轮）。
static LAST_TICK_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 本轮判定时刻。系统时间被回拨（手动改时间 / NTP 校时）时 `now < 上一轮`：
/// 用回拨**前**的时刻做本轮判定——跨回拨窗口到期的任务仍按 grace 正常点火，
/// 不会因回拨漏报、回正后又因迟到被静默（审计 P3#23）。
fn tick_judge_ms(last_tick_ms: i64, now_ms: i64) -> i64 {
    if last_tick_ms > 0 && now_ms < last_tick_ms - 5_000 {
        last_tick_ms
    } else {
        now_ms
    }
}

/// 一轮提醒检查。逻辑全部可从 [`remind_select`]（纯函数）推演，这里只做 IO。
fn remind_tick(app: &AppHandle) {
    let Some(cache) = app.try_state::<IslandStateCache>() else { return };
    let Some(ledger) = app.try_state::<RemindLedger>() else { return };
    let now_ms = chrono::Local::now().timestamp_millis();
    let last_tick = LAST_TICK_MS.swap(now_ms, Ordering::SeqCst);
    let judge_ms = tick_judge_ms(last_tick, now_ms);
    let snapshot = match cache.0.lock() {
        Ok(g) => g.clone(),
        Err(_) => return,
    };
    let mut state = match snapshot {
        Some(s) => s,
        None => return,
    };

    let Ok(mut inner) = ledger.0.lock() else { return };
    // ① 横幅到点收摊：推出干净状态（走 refresh 重扫，顺带把可见性口径也对齐）
    // ❗ 配置在 tick 里现读（每 15s 一次纯内存读）：提醒开关/时长改动即时生效，
    //   不用给线程加重启协议。提醒关 = 不再新点火 + 把挂着的横幅也收掉。
    let ic = island_config(app);
    if let Some((_, fired_at)) = inner.active {
        if !ic.remind || judge_ms - fired_at >= ic.remind_ms {
            inner.active = None;
            drop(inner);
            crate::todo_tasks::refresh_island(app);
            return;
        }
        return; // 横幅展示中，不到点不动作（注入由 push_state 负责）
    }

    // ② 可见自愈（审计 P2#5 + P3#21）：岛可见时每 15s 重扫一遍。同步引擎直写
    //    路径没有钩子，岛常驻期间只有这条让它看到同步进来的新待办；顺带把
    //    due_label 隔夜翻新（「今天 16:00」不会过夜挂成假话）。缓存热，未变化时
    //    push_state 的事件闸让它近乎零成本。
    // ❗ 先放账本锁再 refresh：refresh → push_state → inject_remind 要拿同一把锁，
    //   持着不放就是自死锁。刷新后拿回锁，继续用新状态做挑选。
    let visible = app
        .get_webview_window(WINDOW_LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        drop(inner);
        if let Some(fresh) = crate::todo_tasks::refresh_island(app) {
            state = fresh;
        }
        inner = match ledger.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
    }

    if !ic.remind {
        // 提醒关 = 不再点火（可见自愈已经跑过）。过期的「该记的账」也不补：
        // re-open 后 grace 规则（REMIND_GRACE_MS）本来就会把迟到的到期点静默
        // 记账，不会轰炸。
        return;
    }

    // ③ 挑最紧的一条（纯函数见 remind_select；隐私门控/全屏门都在 show() 里拦）
    let Some(pick) = remind_select(&state, judge_ms, &inner.fired) else { return };
    match pick {
        RemindPick::Silent(key) => {
            inner.fired.insert(key);
        }
        RemindPick::Fire(task) => {
            let key = remind_key(&task);
            inner.fired.insert(key.clone());
            inner.active = Some((key, judge_ms));
            drop(inner);
            inject_remind(&ledger, &mut state);
            show(app); // 隐私门控 / 全屏门 / 复活轮询是 show() 自带的，这里不重复处理
            push_state(app, state);
        }
    }
}

/// [`remind_tick`] ② 的纯函数：该静默记账哪条、该点亮哪条。
///
/// - 启动时已过期（迟到超过 [`REMIND_GRACE_MS`]）→ 静默记账，不吵；
/// - 运行中刚跨过到期点（grace 内）→ 点火最紧的一条。
#[derive(Debug)]
enum RemindPick {
    Silent(String),
    Fire(crate::todo_tasks::IslandTask),
}

fn remind_select(
    state: &IslandState,
    now_ms: i64,
    fired: &std::collections::HashSet<String>,
) -> Option<RemindPick> {
    // 🔴 不依赖排序（审计 P1#1）：列表顺序由设置项 `todo_island_due_sort` 决定，
    //    用户关掉「到期优先」后是创建顺序——靠 `due > now 就 break` 提前收的话，
    //    前面任何一个未来任务都会让排在它后面的过期任务整批静默失效。
    //    全量扫完（≤50 条，纯内存），过期里挑最紧的一条。
    let mut oldest_silent: Option<(String, i64)> = None;
    for t in &state.tasks {
        if t.done {
            continue;
        }
        let Some(due) = t.due_ms else { continue };
        // 全天任务不弹提醒（has_time=false 只做列表展示）
        if !t.due_has_time {
            continue;
        }
        let key = remind_key(t);
        if fired.contains(&key) {
            continue;
        }
        if due > now_ms {
            continue;
        }
        if now_ms - due > REMIND_GRACE_MS {
            // 静默记账挑「最早过期」的那条——列表无序时第一个遇到的未必最早
            if oldest_silent.as_ref().is_none_or(|(_, d)| due < *d) {
                oldest_silent = Some((key, due));
            }
        } else {
            return Some(RemindPick::Fire(t.clone()));
        }
    }
    oldest_silent.map(|(k, _)| RemindPick::Silent(k))
}

/// 这是岛状态的**唯一**推送出口（`todo_tasks::refresh_island` 调它）——
/// 任何别的代码想更新岛状态都该走它，两处各推一次就会漂成「显示 A、实际 B」。
pub fn push_state(app: &AppHandle, mut state: IslandState) {
    // 提醒注入收口：账本上还挂着横幅就重新注入（先清掉上游可能带的原值，
    // 以账本为准——IslandState 在别处构建时 due_alert 恒应为 None）
    state.due_alert = None;
    if let Some(ledger) = app.try_state::<RemindLedger>() {
        inject_remind(&ledger, &mut state);
    }
    if let Some(cache) = app.try_state::<IslandStateCache>() {
        let mut guard = match cache.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        // 🔴 无变化不重推（事件闸）：remind_tick 每 15s 的可见自愈重扫走这里，
        //    未变化时若仍全量 emit，编辑器连续自动保存 + 常驻岛 = 事件/重绘风暴
        //    （审计 P3#16）。注入过 due_alert 的状态与缓存必然不同，横幅不受影响。
        if guard.as_ref() == Some(&state) {
            return;
        }
        *guard = Some(state.clone());
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

    // ----- 提醒挑选（remind_select 纯函数；时序见设计稿「提醒与截止时间」§5） -----

    fn task(id: &str, line: usize, due_ms: Option<i64>, has_time: bool) -> crate::todo_tasks::IslandTask {
        crate::todo_tasks::IslandTask {
            note_id: id.into(),
            note_title: "笔记".into(),
            line,
            text: format!("{id}{line}"),
            done: false,
            due_ms,
            due_has_time: has_time,
            due_label: None,
        }
    }

    fn state(tasks: Vec<crate::todo_tasks::IslandTask>) -> IslandState {
        IslandState {
            total: tasks.len() as u32,
            done: 0,
            hint: String::new(),
            tasks,
            done_tasks: vec![],
            due_alert: None,
        }
    }

    #[test]
    fn test_remind_select_fires_fresh_overdue_only() {
        let now = 1_000_000;
        // 两条过期：grace 内的（刚跨过）排前（due 升序），更老的静默
        let st = state(vec![
            task("a", 0, Some(now - 10_000), true),   // 刚过期 10s → 点火
            task("b", 1, Some(now - 500_000), true),  // 迟到 8 分钟 → 静默
        ]);
        let mut fired = std::collections::HashSet::new();
        match remind_select(&st, now, &fired) {
            Some(RemindPick::Fire(t)) => assert_eq!(t.note_id, "a"),
            other => panic!("应点火最紧一条，实际 {other:?}"),
        }
        // 记账后：a 不再报；b 静默入账
        fired.insert(format!("a:0:{}", now - 10_000));
        match remind_select(&st, now, &fired) {
            Some(RemindPick::Silent(k)) => assert_eq!(k, format!("b:1:{}", now - 500_000)),
            other => panic!("第二条该静默，实际 {other:?}"),
        }
    }

    #[test]
    fn test_remind_select_skips_all_day_and_future() {
        let now = 1_000_000;
        // 全天任务（has_time=false）永不点火；未来的不点火（排序下 break 提前收）
        let st = state(vec![
            task("c", 0, Some(now - 1_000), false),
            task("d", 1, Some(now + 60_000), true),
        ]);
        assert!(remind_select(&st, now, &std::collections::HashSet::new()).is_none());
    }

    /// 🔴 P1#1 守卫：挑选**不得依赖列表有序**。用户关掉「到期优先排序」后列表
    /// 是创建顺序——未来任务排在前、过期任务排在后时，`due > now 就 break` 的
    /// 老实现会让后面所有过期任务整批静默失效。
    #[test]
    fn test_remind_select_works_without_due_sort() {
        let now = 1_000_000;
        // 创建顺序：先写的还没到期，后写的已经过期（与到期序相反）
        let st = state(vec![
            task("future", 0, Some(now + 600_000), true),
            task("overdue", 1, Some(now - 10_000), true),
        ]);
        match remind_select(&st, now, &std::collections::HashSet::new()) {
            Some(RemindPick::Fire(t)) => assert_eq!(t.note_id, "overdue", "跨过未来任务也要点到过期的"),
            other => panic!("关排序后过期任务必须照常点火，实际 {other:?}"),
        }
    }

    /// 静默记账挑「最早过期」的那条——列表无序时第一个遇到的未必最早。
    #[test]
    fn test_remind_select_picks_oldest_for_silent_even_unsorted() {
        let now = 1_000_000;
        // 创建顺序：晚过期的在前，早过期的在后（无序）
        let st = state(vec![
            task("late", 0, Some(now - 500_000), true),
            task("older", 1, Some(now - 800_000), true),
        ]);
        match remind_select(&st, now, &std::collections::HashSet::new()) {
            Some(RemindPick::Silent(k)) => assert_eq!(k, format!("older:1:{}", now - 800_000)),
            other => panic!("该静默记账最早过期那条，实际 {other:?}"),
        }
    }

    /// P3#23 守卫：系统时间被回拨时，本轮用回拨前的时刻判定——跨回拨窗口
    /// 到期的任务不会因「回拨期间没到点」漏报、回正后又因迟到被静默。
    #[test]
    fn test_tick_judge_ms_on_clock_rollback() {
        // 正常前进：用 now
        assert_eq!(tick_judge_ms(1_000_000, 1_010_000), 1_010_000);
        // 首轮（last=0）：用 now
        assert_eq!(tick_judge_ms(0, 1_000_000), 1_000_000);
        // 微小抖动（<5s，NTP 常见）：不算回拨
        assert_eq!(tick_judge_ms(1_000_000, 998_000), 998_000);
        // 明显回拨：用回拨前的时刻
        assert_eq!(tick_judge_ms(1_000_000, 800_000), 1_000_000);
    }
}
