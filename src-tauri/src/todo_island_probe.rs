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

        // 档 3a 玻璃探针已删（2026-09-25）：窗口级 Acrylic 路线被红色探针推翻（结论见
        // todo_island.rs「材质与配置」节），逐配方 A/B 的提问对象不复存在。
    });
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
