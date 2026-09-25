//! 待办灵动岛的探针（P0 一次性脚手架，`docs/待办灵动岛-实施方案-2026-09-24.md` §4）。
//!
//! ## 为什么单独一个文件
//!
//! 这一整份是**一次性的**：结论落档后，除 `todo_island_probe` 这一个诊断命令之外的代码都该删。
//! 与业务代码分文件，是为了让「拆脚手架」= `rm` 一个文件 + 摘一行注册，
//! 而不是在 500 行的业务文件里挖 270 行出来。
//!
//! ## 它现在还验什么
//!
//! 原始三条未知都已定论（结论见 `todo_island.rs` 文件头）：
//! ① 不做窗口级材质、且**不能申请 DWM 圆角**；② 穿透切换无闪、命中测试正确；③ RSS +34~47 MB。
//! 材质那一轮的 A/B（Acrylic on/off、α140/α0、定档/低染色）已全部跑完并落档，本文件里已删干净。
//!
//! 剩下两件事仍值得每次跑一遍：
//! - **形态**：把岛真渲染出来抓图 → 胶囊四角有没有缺口、有没有方块玻璃、有没有白底（存 PNG 供人看）
//! - **客观状态**：位置 / 尺寸 / 命中测试 / RSS（数字判据，不接受「配置写对了所以应该生效」）
//!
//! ## 为什么判定必须由 Rust 侧自己发起
//!
//! 岛的 webview **不是浏览器标签页**：没有外部通道能往里注入 `invoke`
//! （CDP 够不着 Tauri 的 IPC，devtools 也没法从外部驱动），所以判定做成自动跑。
//!
//! ## 三条已经踩过的测量坑（别再犯）
//!
//! | 坑 | 现象 | 处置 |
//! |---|---|---|
//! | ① 计时起点错 | 等 3s 是从 `init` 起算，而窗口在**另一个线程**里创建 —— 到点时刚 build 完，第一张图抓到空白 webview（5.7KB vs 21.9KB） | 改成轮询 `is_visible()` 再计时 |
//! | ② 抓屏区域越界 | 岛贴上沿 10px，外扩 24px 后顶边到 **-14px**（屏幕外），GDI 抓屏幕外的返回值不可预期 | 抓取矩形钳制到主屏内 |
//! | ③ 🔴 靠 `window.eval` 改 CSS 做测量 | 有一整轮的读数**全部停在定档值**（岛体 37），说明变量根本没被改 —— 被测对象没事，**测量工具自己是坏的** | 改**源文件**（临时覆盖块），并且判据要选**不依赖绝对值**的那种（示例见下） |
//! | ④ 🔴 抓图抓到的**可能是别人** | 09-24 15:10 那次读数「岛中心 rgb(255,255,255) / 窗外 244」看着像白底回归，**实际抓的是浏览器标签栏** —— `island.png` 里能直接看到标签栏文字和关闭按钮。那一帧岛的页面还没画完，透明窗口下面是另一个应用的窗口 | 数值判据**必须配一张图**：看图一眼就知道读的是谁。另外 `wait_visible` 只保证「窗口可见」，**不保证「页面画完」**，而 `show()` 现在由 `on_page_load` 驱动 ⇒ 两者本就不同步（撞上慢加载就会抓到未绘制帧）|
//!
//! ③ 的修法值得展开，它是这一轮最有价值的经验：
//! 要判「webview 到底透不透明」，靠「岛体从 37 变成 229」是不够的 —— 这个数字的意义
//! 依赖 CSS 当时是什么档。真正硬的判据是**相对关系**：CSS 归零后，
//! **「岛体像素 == 窗外像素」**（差 0）只有真透明才可能满足，白底必然是 255 ≠ 242。
//! 判据一旦换成相对关系，测量工具的小毛病就不再能伪造结论。

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

use crate::todo_island::{is_hovering, primary_monitor_rect, WINDOW_LABEL};

/// 窗口创建前的进程 RSS（探针③的基线）。
///
/// 放在探针文件而不是业务文件：它唯一的消费者是这里的 `ProbeReport`。
static RSS_BEFORE: AtomicU64 = AtomicU64::new(0);

/// 记下窗口创建前的基线。`todo_island::create` 在**建 webview 之前**调一次。
pub(crate) fn mark_rss_baseline() {
    if let Some(rss) = mem_rss_bytes() {
        RSS_BEFORE.store(rss, Ordering::SeqCst);
        log::info!("[TodoIsland] 窗口创建前 RSS = {} MB", rss / 1024 / 1024);
    }
}

/// 打印创建后的 RSS 增量（探针③的结论行）。`todo_island::create` 在窗口起来后调。
pub(crate) fn report_rss_delta() {
    let Some(rss) = mem_rss_bytes() else { return };
    let before = RSS_BEFORE.load(Ordering::SeqCst);
    if before > 0 {
        log::info!(
            "[TodoIsland] 窗口创建后 RSS = {} MB（增量 {} MB）",
            rss / 1024 / 1024,
            rss.saturating_sub(before) / 1024 / 1024
        );
    }
}

/// 探针回报。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// 窗口是否已存在
    pub window_exists: bool,
    /// 窗口是否可见
    pub visible: bool,
    /// 是否 transparent(true)
    pub transparent: bool,
    /// 是否 always_on_top(true)
    pub always_on_top: bool,
    /// 当前是否处于「收鼠标事件」状态（鼠标在岛上）
    pub hovering: bool,
    /// `WindowFromPoint(岛中心)` 命中的是不是岛自己。
    ///
    /// 判据：**鼠标不在岛上时它应为 `false`** —— 那说明 `WS_EX_TRANSPARENT` 生效，
    /// hit-test 已经把岛跳过去了（穿透成功）。若在鼠标明明不在岛上时仍为 `true`，
    /// 穿透没生效，岛会吃掉它下面应用的点击。
    pub hit_test_hits_island: bool,
    /// 岛外框位置（物理像素）
    pub position: [i32; 2],
    /// 岛外框尺寸（物理像素）
    pub size: [u32; 2],
    /// 主显示器 `[x, y, w, h]`（物理像素）
    pub monitor: Option<[f64; 4]>,
    /// 当前进程 RSS（字节）
    pub rss_bytes: Option<u64>,
    /// RSS 增量（相对窗口创建前，字节）
    pub rss_delta_bytes: Option<u64>,
}

/// 跑一次探针并回报客观状态。
///
/// ❗ 这些都是**可测的量**：命中测试交给系统 `WindowFromPoint`，内存交给
/// `GetProcessMemoryInfo`、几何交给 `outer_position`/`outer_size`。
/// 不接受「配置写对了所以应该生效」这种推断 —— 状态类问题必须靠可测差值下结论。
#[tauri::command]
pub fn todo_island_probe(app: AppHandle) -> ProbeReport {
    let window = app.get_webview_window(WINDOW_LABEL);
    let (position, size) = window
        .as_ref()
        .and_then(|w| {
            let p = w.outer_position().ok()?;
            let s = w.outer_size().ok()?;
            Some(([p.x, p.y], [s.width, s.height]))
        })
        .unwrap_or(([0, 0], [0, 0]));

    let center = (
        position[0] + size[0] as i32 / 2,
        position[1] + size[1] as i32 / 2,
    );

    let rss = mem_rss_bytes();
    let before = RSS_BEFORE.load(Ordering::SeqCst);

    ProbeReport {
        window_exists: window.is_some(),
        visible: window
            .as_ref()
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false),
        // `transparent` / `always_on_top` 由 builder 固定为 true（Tauri 没给对应 getter），
        // 这里如实反映构造参数。要验它们**真的**生效，看抓图的像素与命中测试，不看这两个字段。
        transparent: true,
        always_on_top: true,
        hovering: is_hovering(),
        hit_test_hits_island: hit_test(center.0, center.1)
            .zip(window.as_ref().and_then(|w| w.hwnd().ok()))
            .map(|(hit, own)| hit == own.0 as isize)
            .unwrap_or(false),
        position,
        size,
        monitor: primary_monitor_rect(&app).map(|(x, y, w, h, _)| [x, y, w, h]),
        rss_bytes: rss,
        rss_delta_bytes: rss
            .zip(if before > 0 { Some(before) } else { None })
            .map(|(a, b)| a.saturating_sub(b)),
    }
}

/// 探针自动序列（只在 `PP_TODO_ISLAND_PROBE=1` 时跑一次，由 `todo_island::init` 触发）。
pub(crate) fn run_probe_sequence(app: AppHandle) {
    std::thread::spawn(move || {
        // ① 等窗口**真的可见**再计时。
        //
        // 第一版是「从 init 起算固定 sleep 3s」——错。窗口在 `create` 的独立线程里建，
        // 实测 init 后 3s 时它刚 build 完，第一张图抓到的是**还没渲染的空白 webview**
        // （on1 5.7KB / off 9.9KB / on2 21.9KB，同状态两次采样的差 52.7 比 A/B 的 24.5 还大
        // ⇒ 那次测量整份作废）。
        let Some(window) = wait_visible(&app) else {
            log::warn!("[TodoIsland][probe] 等窗口可见超时（10s），探针中止");
            return;
        };

        // 再给 webview 首帧 + DWM 合成留时间（窗口「可见」不等于「画完了」）
        std::thread::sleep(std::time::Duration::from_millis(1200));

        let (Ok(p), Ok(s)) = (window.outer_position(), window.outer_size()) else {
            log::warn!("[TodoIsland][probe] 读不到窗口几何，探针中止");
            return;
        };

        // ② 抓取区域要向外扩（看胶囊四角之外有没有方块玻璃/白底），但**必须钳制在屏幕内**。
        //
        // 岛贴屏幕上沿 10px，外扩 24px 后顶边到 -14px（屏幕外），GDI 抓屏幕外区域的
        // 返回值不可预期 —— 第一版就是这么抓的，图上顶部那条带子的来源至今不明。
        let (mx, my, mw, mh, _) = primary_monitor_rect(&app).unwrap_or((0.0, 0.0, 1920.0, 1080.0, 1.0));
        let x = (p.x - PAD).max(mx as i32);
        let y = (p.y - PAD).max(my as i32);
        let w = (p.x + s.width as i32 + PAD).min((mx + mw) as i32) - x;
        let h = (p.y + s.height as i32 + PAD).min((my + mh) as i32) - y;
        if w <= 0 || h <= 0 {
            log::warn!("[TodoIsland][probe] 钳制后抓取区域非正（{w}x{h}），探针中止");
            return;
        }
        // 岛在抓取图内的偏移，用来读「岛中心」「左上角外侧」这些具体像素
        let (ix, iy) = (p.x - x, p.y - y);

        // ③ 抓图 + 打印一组**相对判据**。
        //
        // 单看岛体颜色判不出透明成不成立：桌面本身若为浅色，「透出桌面」和「webview 白底」
        // **都是亮值** ⇒ 必须用「岛中心 − 窗外」这个差值。差 0 只有真透明才可能。
        let mut shot: Option<Vec<u8>> = None;
        match crate::screenshot::grab_rect_rgba(x, y, w, h) {
            Ok(px) => {
                save_probe_png("island", w, h, &px);
                let cx = ix + s.width as i32 / 2;
                let cy = iy + s.height as i32 / 2;
                let center = pixel_at(&px, w, cx, cy);
                // 窗口矩形**之外** 6px = 纯桌面色，作为「染色/底到底有没有真透出去」的参照。
                let outside = pixel_at(&px, w, ix - 6, iy - 6);
                if let (Some(c), Some(o)) = (center, outside) {
                    log::info!(
                        "[TodoIsland][probe] island：岛中心 rgb({}, {}, {}) | 窗外 rgb({}, {}, {}) | \
                         中心−窗外 {}（判读：若窗口层是白底，中心会明显**亮于**窗外；真透明则应接近 0）",
                        c.0,
                        c.1,
                        c.2,
                        o.0,
                        o.1,
                        o.2,
                        c.0 as i32 - o.0 as i32
                    );
                }
                shot = Some(px);
            }
            Err(e) => log::warn!("[TodoIsland][probe] 抓屏失败: {e}"),
        }

        // ④ 沿窗口左上角 45° 向内逐像素取值 —— **缺口就藏在这条线上**。
        //
        // 窗口层被 DWM 裁到 r≈8（物理）而 CSS 胶囊裁到 r≈16 时，两者之间那条月牙
        // 只有窗口层、没有 CSS，剖面上会表现为一段**比胶囊内部亮**的区段。
        // 判据：三行/单行的剖面若从窗口角点**单调**降到胶囊内部，缺口不存在。
        if let Some(px) = shot {
            let vals: Vec<String> = (0..=DIAG_LEN)
                .map(|k| {
                    pixel_at(&px, w, ix + k, iy + k)
                        .map(|c| c.0.to_string())
                        .unwrap_or_else(|| "--".to_string())
                })
                .collect();
            log::info!(
                "[TodoIsland][probe] 左上角对角线（0=窗口角点，物理px，值=像素 R 通道）: {}",
                vals.join(" ")
            );
        }

        let rep = todo_island_probe(app.clone());
        log::info!(
            "[TodoIsland][probe] 命中测试：WindowFromPoint(岛中心) 命中岛自己 = {}（鼠标在岛上 = {}；\
             鼠标不在岛上时该值应为 false —— 那才说明 WS_EX_TRANSPARENT 生效）",
            rep.hit_test_hits_island,
            rep.hovering
        );
        log::info!(
            "[TodoIsland][probe] 位置 {:?} 尺寸 {:?} 主屏 {:?}（位置为**物理**像素；\
             居中判据：px + 宽/2 应等于 主屏宽/2）",
            rep.position,
            rep.size,
            rep.monitor
        );
        log::info!(
            "[TodoIsland][probe] RSS {} MB（增量 {} MB）",
            rep.rss_bytes.unwrap_or(0) / 1024 / 1024,
            rep.rss_delta_bytes.unwrap_or(0) / 1024 / 1024
        );
        log::info!(
            "[TodoIsland][probe] 形态请看 {}（胶囊四角有没有缺口 / 有没有白底矩形）",
            std::env::temp_dir().join("todo-probe/island.png").display()
        );

        // ===== 档 3a 玻璃探针（2026-09-25，方案 3a「双主题磨砂」立项依据）=====
        //
        // 要回答的三个问题（结论进 design/待办灵动岛-液态玻璃-3a设计稿.html）：
        //   G1 材质在本机真生效吗、各 tint 配方渲染出来是什么色（相对判据：on−off 差 ≫ 组内差）；
        //   G2 四角剖面：材质按窗口矩形铺，胶囊圆角外那块月牙露不露、露多少；
        //   G3 真实文字在「材质 + 低染色」上的实测对比度（中心行 p95−p5 亮度对）。
        // 方法沿用本文件头部的三条教训：组内基线、钳制抓屏、eval 结果要回读验证。
        run_glass_probe(&app, &window, (x, y, w, h), (ix, iy));
    });
}

/// 玻璃探针的 tint 配方。alpha 语义 = 材质染色的不透明度（叠在模糊后的桌面上）。
/// （type 别名只为过 clippy::type_complexity，别拆散元组——三档配方按位对齐。）
type GlassRecipe = (&'static str, (u8, u8, u8, u8));
const GLASS_RECIPES: [GlassRecipe; 3] = [
    // 深磨砂：PILLAR 式深 tint，对应主题的深色档
    ("dark150", (20, 20, 24, 150)),
    // 白磨砂两档：液态玻璃的浅色档候选，浓度按「白文档上深字要 ≥4.5:1」反推后实测
    ("white110", (255, 255, 255, 110)),
    ("white150", (255, 255, 255, 150)),
];

/// CSS 染色压到近透明（材质成为岛体染色的主要来源；文字/环/描边仍由 CSS 画）。
const GLASS_CSS_TINT: &str = "rgba(128, 128, 128, 0.06)";

/// 每次施加材质后给 DWM 重合成的稳定时间。
const GLASS_SETTLE_MS: u64 = 700;

/// 几何参数打包成元组（外矩形 + 内部取点）只为过 clippy::too_many_arguments。
fn run_glass_probe(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    (x, y, w, h): (i32, i32, i32, i32),
    (ix, iy): (i32, i32),
) {
    // ⓪ 生产材质现在常驻（create 时施加）——基线前必须先摘掉，否则「材质关」不成立。
    let _ = window.set_effects(None);
    std::thread::sleep(std::time::Duration::from_millis(500));
    // ① CSS 染色压到近透明。坑③的教训：eval 可能静默失效 —— 让它顺手改
    //    document.title，Rust 读回确认「eval 这把尺子自己是好的」，再谈读数。
    let js = format!(
        "document.documentElement.style.setProperty('--island-tint','{GLASS_CSS_TINT}','important');\
         document.documentElement.style.setProperty('--island-tint-hover','{GLASS_CSS_TINT}','important');\
         document.title='pprobe-ok';"
    );
    if let Err(e) = window.eval(&js) {
        log::warn!("[TodoIsland][probe][glass] eval 注入失败，玻璃探针作废: {e}");
        return;
    }
    std::thread::sleep(std::time::Duration::from_millis(400));
    let title_ok = window.title().map(|t| t.contains("pprobe-ok")).unwrap_or(false);
    log::info!(
        "[TodoIsland][probe][glass] eval 回读（参考值）：title 含 pprobe-ok = {title_ok}\
         （❗ 无装饰窗上 window.title() 不反映 document.title，false 不代表 eval 失败 ——\
         真判据是下面的内部采样点是否随配方变化）"
    );

    // 内部染色采样点：窗口右缘内 8 物理px、垂直居中 —— 右 padding 区，没有文字/环。
    // 这是「材质 + CSS 染色」的纯背景响应点，中心点会打到文字笔画上（浅色模式实翻过车）。
    let s0 = window.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((0, 0));
    let tint_pt = (ix + s0.0 - 8, iy + s0.1 / 2);
    let tint_at = |px: &[u8]| pixel_at(px, w, tint_pt.0, tint_pt.1);

    // ② 组内基线：材质**关闭**连抓两张 —— 它们的差就是这套测量的噪声底。
    let mut gbase_tint = None;
    for tag in ["gbase-a", "gbase-b"] {
        if let Ok(px) = crate::screenshot::grab_rect_rgba(x, y, w, h) {
            if tag.ends_with('a') {
                gbase_tint = tint_at(&px);
            }
            save_probe_png(tag, w, h, &px);
        }
    }
    if let Some(t) = gbase_tint {
        log::info!(
            "[TodoIsland][probe][glass] 基线内部（材质关 + CSS 染色已压零）rgb({},{},{})\
             —— 应≈窗外桌面色；若仍是主题 tint 色（深 24 / 白 247），eval 没生效，本轮作废",
            t.0, t.1, t.2
        );
    }
    log::info!("[TodoIsland][probe][glass] 组内基线（材质关）两张已存 gbase-a/b.png");

    // ③ 逐配方：施加 Acrylic → 稳定 → 连抓两张 → 中心/窗外/对角线/文字行对比度。
    for (name, (r, g, b, a)) in GLASS_RECIPES {
        let effects = tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::Acrylic)
            .color(tauri::utils::config::Color(r, g, b, a))
            .build();
        if let Err(e) = window.set_effects(Some(effects)) {
            log::warn!("[TodoIsland][probe][glass] {name}: set_effects 失败: {e}");
            continue;
        }
        std::thread::sleep(std::time::Duration::from_millis(GLASS_SETTLE_MS));

        let mut frames: Vec<Vec<u8>> = Vec::new();
        for tag in [format!("glass-{name}-a"), format!("glass-{name}-b")] {
            match crate::screenshot::grab_rect_rgba(x, y, w, h) {
                Ok(px) => {
                    save_probe_png(&tag, w, h, &px);
                    frames.push(px);
                }
                Err(e) => log::warn!("[TodoIsland][probe][glass] {name}: 抓屏失败: {e}"),
            }
        }
        let Some(px) = frames.first() else { continue };
        let (cx, cy) = (ix + s0.0 / 2, iy + s0.1 / 2);

        // 材质响应（G1 主判据）：内部染色采样点随配方移动 = eval 生效 + 材质生效。
        // 理论值 = tint(alpha) 合成到模糊桌面上；单背景线性标定见设计稿。
        if let Some(t) = tint_at(px) {
            log::info!(
                "[TodoIsland][probe][glass] {name}: 内部染色点 rgb({},{},{})（基线 {:?}）",
                t.0, t.1, t.2, gbase_tint
            );
        }

        // 四角剖面（G2）：材质铺满窗口矩形，胶囊圆角外的月牙若露材质，
        // 这条线上会出现一段「与内部同色、但形状在胶囊外」的区段；配合 PNG 人眼复核。
        let vals: Vec<String> = (0..=DIAG_LEN)
            .map(|k| {
                pixel_at(px, w, ix + k, iy + k)
                    .map(|c| c.0.to_string())
                    .unwrap_or_else(|| "--".to_string())
            })
            .collect();
        log::info!("[TodoIsland][probe][glass] {name} 左上角对角线: {}", vals.join(" "));

        // 文字行实测对比度（G3）：文字永远是行内的**少数极端簇**——
        // 深玻璃上是 p95（亮笔画）、浅玻璃上是 p5（暗笔画），所以对比对象取 p95 vs p5。
        // （第一版用 p45 当背景，浅色模式下 p45 也是背景，量出 1.06:1 的伪值 —— 已修。）
        if let Some(contrast) = text_row_contrast(px, w, cx, cy) {
            log::info!(
                "[TodoIsland][probe][glass] {name}: 文字行实测对比度 ≈ {contrast:.2}:1\
                 （门槛 ≥4.5；本机桌面这一种背景下的实测，四背景表在设计稿里按它标定）"
            );
        }

        // 组内差读数：同配方两帧中心的差
        if let (Some(a), Some(b)) = (frames.first(), frames.get(1)) {
            let pa = pixel_at(a, w, cx, cy);
            let pb = pixel_at(b, w, cx, cy);
            if let (Some(pa), Some(pb)) = (pa, pb) {
                log::info!(
                    "[TodoIsland][probe][glass] {name}: 组内噪声（a−b 中心 R）= {}\
                     （读数规则：组间差必须显著大于它才可判，坑②的教训）",
                    pa.0 as i32 - pb.0 as i32
                );
            }
        }
    }

    // ④ 复原：恢复**生产**材质（不再是无材质——档 3a 起岛常驻 Acrylic）+ 恢复 CSS 染色。
    crate::todo_island::apply_theme_material(app);
    let _ = window.eval(
        "document.documentElement.style.removeProperty('--island-tint');\
         document.documentElement.style.removeProperty('--island-tint-hover');\
         document.title='';",
    );
    std::thread::sleep(std::time::Duration::from_millis(400));

    // ⑤ G4 月牙消除实验（2026-09-25，用户反馈「四个脚月牙太重」）：
    //    SetWindowRgn 把窗口**连材质一起**裁成胶囊形。看两件事：
    //    a) 圆角外的方角玻璃（月牙）是否被裁掉；b) 裁出来的边缘有没有 GDI 锯齿。
    //    若 a✓b✓ 则月牙有了干净的消除手段；锯齿明显则回退「接受/改圆角」二选一。
    #[cfg(target_os = "windows")]
    {
        // ⚠ windows 0.58：CreateRoundRectRgn / SetWindowRgn / HRGN 都在 Graphics::Gdi
        //   （第一版按 WindowsAndMessaging + Result 签名写，E0432/E0308 翻车）。
        use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, HRGN, SetWindowRgn};
        // ⚠ tauri 的 window.hwnd() 返回的是它自己 windows 依赖（0.61）的 HWND，
        //   与本项目 0.58 的 HWND 不是同一类型（E0277 的根因）——按裸指针重建。
        //   既有代码 hit_test 里 `own.0 as isize` 的比较就是这个版本差的既有证例。
        if let Ok(raw) = window.hwnd() {
            let hwnd = windows::Win32::Foundation::HWND(raw.0 as isize as *mut core::ffi::c_void);
            let s = window
                .outer_size()
                .map(|s| (s.width as i32, s.height as i32))
                .unwrap_or((0, 0));
            // 胶囊 = 圆角矩形，椭圆直径 = 窗口高（47 物理 → 正好半高，端头全圆）。
            let hrgn = unsafe { CreateRoundRectRgn(0, 0, s.0 + 1, s.1 + 1, s.1, s.1) };
            if hrgn.is_invalid() {
                log::warn!("[TodoIsland][probe][glass] rgn: CreateRoundRectRgn 返回无效句柄");
            } else {
                let applied = unsafe { SetWindowRgn(hwnd, hrgn, true) };
                std::thread::sleep(std::time::Duration::from_millis(600));
                if let Ok(px) = crate::screenshot::grab_rect_rgba(x, y, w, h) {
                    save_probe_png("rgn-pill", w, h, &px);
                    let vals: Vec<String> = (0..=DIAG_LEN)
                        .map(|k| {
                            pixel_at(&px, w, ix + k, iy + k)
                                .map(|c| c.0.to_string())
                                .unwrap_or_else(|| "--".to_string())
                        })
                        .collect();
                    log::info!(
                        "[TodoIsland][probe][glass] rgn 左上角对角线: {}（判据：月牙段消失 = \
                         前几个物理px 应直接从桌面色跳进玻璃色，无中间方角段；锯齿要看 rgn-pill.png）",
                        vals.join(" ")
                    );
                } else {
                    log::warn!("[TodoIsland][probe][glass] rgn: 抓屏失败");
                }
                let _ = applied;
                // 无论结果如何都摘掉 rgn（空 HRGN = 恢复矩形窗口）
                unsafe { SetWindowRgn(hwnd, HRGN::default(), true) };
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }

    log::info!("[TodoIsland][probe][glass] 已复原（生产材质已按主题恢复 + CSS 染色恢复）");
}

/// 中心水平行 ±2px 内的实测文字对比度：亮度 p95（最亮簇）与 p5（最暗簇）之比。
///
/// 文字笔画永远是行内的**少数极端簇**：深玻璃上它是 p95、浅玻璃上它是 p5，
/// 两端一夹就是文字-背景对。不找「某个字」的精确位置 —— 那太脆；整行分位数跨字体、
/// 跨文案都成立。（第一版拿 p45 当背景，浅色模式下 p45 也是背景，量出 1.06:1 的伪值。）
/// 文字行扫描的半宽（物理 px）。❗必须 **小于胶囊半宽**（260/2 = 130）：
/// 第一版用 ±160，两端扫到胶囊外的桌面像素，p95/p5 被桌面污染，量出过 4.61 的伪值。
const TEXT_ROW_HALF: i32 = 110;

fn text_row_contrast(px: &[u8], w: i32, cx: i32, cy: i32) -> Option<f64> {
    let mut lum: Vec<f64> = Vec::new();
    for dy in -2..=2 {
        for dx in -TEXT_ROW_HALF..=TEXT_ROW_HALF {
            let (r, g, b) = pixel_at(px, w, cx + dx, cy + dy)?;
            lum.push(0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64);
        }
    }
    if lum.len() < 20 {
        return None;
    }
    lum.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| lum[((lum.len() as f64 - 1.0) * q).round() as usize];
    let (hi, lo) = (p(0.95), p(0.05));
    // WCAG 相对亮度：8bit 值先线性化
    let lin = |v: f64| {
        let c = v / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (l1, l2) = (lin(hi), lin(lo));
    let (l1, l2) = if l1 > l2 { (l1, l2) } else { (l2, l1) };
    Some((l1 + 0.05) / (l2 + 0.05))
}

/// 抓取时向外扩的像素（要看得到胶囊四角之外）。
const PAD: i32 = 24;

/// 对角线剖面的采样长度（物理像素）。
///
/// 必须盖过 **CSS 胶囊的圆角半径**才有意义：岛高 32 逻辑 px ⇒ 胶囊端圆角 r = 16 逻辑
/// = 20 物理（125% DPI）。取 26 留余量，能同时看到「窗口角」与「胶囊边界」两段。
const DIAG_LEN: i32 = 26;

/// 轮询等窗口可见（最多 10s）。
fn wait_visible(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    for _ in 0..100 {
        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
            if w.is_visible().unwrap_or(false) {
                return Some(w);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

/// 取图内某点的 RGB（抓屏数据是 RGBA 四通道）。越界返回 `None` 而不是夹取 ——
/// 夹取会把「量错了位置」伪装成一个正常读数。
fn pixel_at(px: &[u8], w: i32, x: i32, y: i32) -> Option<(u8, u8, u8)> {
    if x < 0 || y < 0 || w <= 0 || x >= w {
        return None;
    }
    let i = ((y * w + x) * 4) as usize;
    if i + 3 > px.len() {
        return None;
    }
    Some((px[i], px[i + 1], px[i + 2]))
}

/// 把探针抓到的 RGBA 存成 PNG（`%TEMP%/todo-probe/`），供人眼复核四角形态。
///
/// 数字判据（像素差）能回答「有没有变化」，但回答不了「胶囊四角之外是不是方块玻璃」——
/// 那要看图。
fn save_probe_png(name: &str, w: i32, h: i32, rgba: &[u8]) {
    let dir = std::env::temp_dir().join("todo-probe");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("[TodoIsland][probe] 建目录失败: {e}");
        return;
    }
    let Some(img) = image::RgbaImage::from_raw(w as u32, h as u32, rgba.to_vec()) else {
        log::warn!("[TodoIsland][probe] 构造图像失败（{name}）");
        return;
    };
    let path = dir.join(format!("{name}.png"));
    match img.save(&path) {
        Ok(()) => log::info!("[TodoIsland][probe] 截图已存 {}", path.display()),
        Err(e) => log::warn!("[TodoIsland][probe] 存图失败（{name}）: {e}"),
    }
}

/// `WindowFromPoint` —— 返回该屏幕坐标上**参与 hit-test 的最上层窗口句柄**。
///
/// 它天然跳过 `WS_EX_TRANSPARENT` 的窗口，所以是「鼠标能不能点穿」最直接的客观判据。
#[cfg(target_os = "windows")]
fn hit_test(x: i32, y: i32) -> Option<isize> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::WindowFromPoint;
    let p = POINT { x, y };
    let hwnd = unsafe { WindowFromPoint(p) };
    if hwnd.is_invalid() {
        None
    } else {
        Some(hwnd.0 as isize)
    }
}

#[cfg(not(target_os = "windows"))]
fn hit_test(_x: i32, _y: i32) -> Option<isize> {
    None
}

/// 当前进程工作集（RSS）字节数。
#[cfg(target_os = "windows")]
fn mem_rss_bytes() -> Option<u64> {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS::default();
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut c,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if ok.is_ok() {
        Some(c.WorkingSetSize as u64)
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn mem_rss_bytes() -> Option<u64> {
    None
}
