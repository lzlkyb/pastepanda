use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager,
};

/// 截断文本，确保适合预览显示（最大 30 个字符）
fn truncate_preview(text: &str, max_len: usize) -> String {
    let text = text.trim();
    if text.len() <= max_len {
        return text.to_string();
    }
    let end = text
        .char_indices()
        .take(max_len)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(max_len);
    format!("{}…", &text[..end])
}

/// 获取最近 N 条文本记录用于自绘弹窗预览
/// 返回 (id, item_type, preview_text, full_text)，item_type 用于前端图标渲染
pub fn get_recent_texts_public(
    app: &AppHandle,
    limit: usize,
) -> Vec<(String, String, String, String)> {
    let store = match app.try_state::<crate::data_store::DataStore>() {
        Some(s) => s,
        None => return Vec::new(),
    };
    match store.get_recent_items(limit as u32) {
        Ok(items) => items
            .into_iter()
            .map(|item| {
                let preview = if item.item_type == "image" {
                    "图片".to_string()
                } else if item.item_type == "file" {
                    let name = std::path::Path::new(&item.text)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("文件");
                    truncate_preview(name, 26)
                } else {
                    truncate_preview(&item.text, 26)
                };
                (item.id, item.item_type, preview, item.text)
            })
            .collect(),
        Err(e) => {
            log::warn!("[TrayManager] 获取最近记录失败: {}", e);
            Vec::new()
        }
    }
}

/// 获取当前剪贴板监听状态
pub fn is_monitoring_public(app: &AppHandle) -> bool {
    app.try_state::<crate::clipboard_monitor::ClipboardMonitor>()
        .map(|m| m.is_running())
        .unwrap_or(true)
}

/// 构建弹窗数据 JSON（统一复用，消除重复查询）
pub fn build_popup_data_public(
    app: &AppHandle,
    recents: &[(String, String, String, String)],
    monitoring: bool,
) -> serde_json::Value {
    let version = crate::commands::APP_VERSION.to_string();
    let name = crate::commands::APP_NAME
        .get()
        .map(|s| s.as_str())
        .unwrap_or("PastePanda");

    let recents_json: Vec<serde_json::Value> = recents.iter().map(|(id, item_type, preview, text)| {
        serde_json::json!({ "id": id, "type": item_type, "preview": preview, "text": text })
    }).collect();

    let store = app.try_state::<crate::data_store::DataStore>();
    let stats = match store.as_ref() {
        Some(s) => match s.get_stats("默认") {
            Ok(s) => {
                log::info!(
                    "[TrayManager] stats 获取成功: total={}, pinned={}, today={}",
                    s.total,
                    s.pinned,
                    s.today
                );
                let max_size_mb = store
                    .and_then(|s| s.get_config().ok())
                    .and_then(|c| c.get("db_max_size_mb").and_then(|v| v.as_f64()))
                    .unwrap_or(100.0);
                Some(serde_json::json!({
                    "total": s.total,
                    "pinned": s.pinned,
                    "today": s.today,
                    "db_size_kb": s.db_size_kb,
                    "max_size_mb": max_size_mb,
                }))
            }
            Err(e) => {
                log::warn!("[TrayManager] get_stats 失败: {}", e);
                None
            }
        },
        None => {
            log::warn!("[TrayManager] DataStore 未初始化，无法获取统计");
            None
        }
    };

    serde_json::json!({
        "name": name,
        "version": version,
        "monitoring": monitoring,
        "recents": recents_json,
        "stats": stats,
    })
}

/// 任务栏停靠边缘
#[derive(Debug, Clone, Copy, PartialEq)]
enum TaskbarEdge {
    Bottom,
    Top,
    Left,
    Right,
}

/// 检测 Windows 任务栏停靠边缘（非 Windows 平台返回 Bottom）
#[cfg(target_os = "windows")]
fn get_taskbar_edge() -> TaskbarEdge {
    use windows::Win32::UI::Shell::SHAppBarMessage;
    use windows::Win32::UI::Shell::ABM_GETTASKBARPOS;
    use windows::Win32::UI::Shell::APPBARDATA;

    let mut abd = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        ..Default::default()
    };

    unsafe {
        // ABM_GETTASKBARPOS 会填充 uEdge 字段
        SHAppBarMessage(ABM_GETTASKBARPOS, &mut abd);
    }

    match abd.uEdge {
        0 => TaskbarEdge::Left,   // ABE_LEFT
        1 => TaskbarEdge::Top,    // ABE_TOP
        2 => TaskbarEdge::Right,  // ABE_RIGHT
        3 => TaskbarEdge::Bottom, // ABE_BOTTOM
        _ => TaskbarEdge::Bottom, // 未知默认底部
    }
}

#[cfg(not(target_os = "windows"))]
fn get_taskbar_edge() -> TaskbarEdge {
    TaskbarEdge::Bottom
}

/// 计算弹窗位置，与 Windows 原生托盘右键菜单逻辑一致：
/// - 任务栏底部 → 弹窗在图标上方，右边缘对齐
/// - 任务栏顶部 → 弹窗在图标下方，右边缘对齐
/// - 任务栏左侧 → 弹窗在图标右侧，上边缘对齐
/// - 任务栏右侧 → 弹窗在图标左侧，上边缘对齐
/// 增加屏幕边界约束（8px 安全边距），防止弹窗被裁剪或贴边
fn calc_popup_position(
    tray_rect: (f64, f64, f64, f64), // (x, y, w, h)
    popup_w: f64,
    popup_h: f64,
    edge: TaskbarEdge,
) -> tauri::PhysicalPosition<f64> {
    let (tray_x, tray_y, tray_w, tray_h) = tray_rect;
    let gap = 4.0; // 弹窗与图标之间的间距
    let margin = 8.0; // 屏幕边缘安全边距

    // 获取主显示器工作区尺寸（排除任务栏区域）
    let (screen_w, screen_h) = get_work_area_size();

    let (raw_x, raw_y) = match edge {
        TaskbarEdge::Bottom => {
            // 弹窗在图标上方，右边缘对齐图标右边缘
            let px = tray_x + tray_w - popup_w;
            let py = tray_y - popup_h - gap;
            (px, py)
        }
        TaskbarEdge::Top => {
            // 弹窗在图标下方，右边缘对齐图标右边缘
            let px = tray_x + tray_w - popup_w;
            let py = tray_y + tray_h + gap;
            (px, py)
        }
        TaskbarEdge::Left => {
            // 弹窗在图标右侧，上边缘对齐图标上边缘
            let px = tray_x + tray_w + gap;
            let py = tray_y;
            (px, py)
        }
        TaskbarEdge::Right => {
            // 弹窗在图标左侧，上边缘对齐图标上边缘
            let px = tray_x - popup_w - gap;
            let py = tray_y;
            (px, py)
        }
    };

    // 屏幕边界约束：确保弹窗不超出屏幕，留 margin 边距
    let x = raw_x.max(margin).min(screen_w - popup_w - margin);
    let y = raw_y.max(margin).min(screen_h - popup_h - margin);

    log::info!(
        "[TrayManager] 弹窗定位: taskbar={:?} tray=({:.0},{:.0} {:.0}x{:.0}) raw=({:.0},{:.0}) final=({:.0},{:.0}) screen=({:.0},{:.0})",
        edge, tray_x, tray_y, tray_w, tray_h, raw_x, raw_y, x, y, screen_w, screen_h
    );
    tauri::PhysicalPosition { x, y }
}

/// 获取主显示器工作区尺寸（排除任务栏）
#[cfg(target_os = "windows")]
fn get_work_area_size() -> (f64, f64) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::SystemParametersInfoW;
    use windows::Win32::UI::WindowsAndMessaging::SPI_GETWORKAREA;
    use windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS;

    let mut rect = RECT::default();
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    (
        (rect.right - rect.left) as f64,
        (rect.bottom - rect.top) as f64,
    )
}

#[cfg(not(target_os = "windows"))]
fn get_work_area_size() -> (f64, f64) {
    (1920.0, 1080.0) // 非 Windows 平台回退值
}

/// 防止快速连续右键点击导致“关闭旧弹窗 → 等待 → 创建新弹窗”序列相互重叠。
/// show_tray_popup 本身在托盘事件的主/事件循环线程上被调用，真正耗时的
/// 关闭/等待/创建逻辑放到后台线程执行；这个标志用于在后台序列进行期间
/// 忽略新的右键点击，避免并发关闭/创建同名窗口。
static POPUP_REBUILDING: AtomicBool = AtomicBool::new(false);

/// 打开自绘托盘弹出窗口（右键托盘图标触发）
/// 使用 tray_rect（从 Enter/Move 事件记录的托盘图标完整矩形）定位弹窗
///
/// 注意：关闭旧弹窗 → 等待其销毁 → 创建新弹窗的整个序列都被放进后台线程执行，
/// 因为本函数是从托盘图标的右键事件回调中直接同步调用的，回调运行在应用的
/// 主/事件循环线程上；此前这里的 std::thread::sleep(80ms) 是同步阻塞调用，
/// 快速连续右键会导致每次点击都卡住整个应用 UI 80ms。Tauri 的窗口句柄方法
/// （close/show/set_position 等，以及 WebviewWindowBuilder::build）都会通过
/// 事件循环的 dispatcher 安全地跨线程调用，因此可以放心地在后台线程里完成，
/// 这与本文件后面“延迟 300ms 注册失焦监听”所用的 std::thread::spawn 模式一致。
fn show_tray_popup(app: &AppHandle, tray_rect: (f64, f64, f64, f64)) {
    let popup_label = "tray-popup";
    let popup_w = 280.0;
    let popup_h = 470.0;

    log::info!(
        "[TrayManager] show_tray_popup 被调用, tray_rect=({:.0},{:.0} {:.0}x{:.0})",
        tray_rect.0,
        tray_rect.1,
        tray_rect.2,
        tray_rect.3
    );

    // 若上一次点击触发的“关闭/等待/重建”序列还在后台进行中，直接忽略本次点击，
    // 避免两个序列同时操作同一个 tray-popup 标签的窗口。
    if POPUP_REBUILDING.swap(true, Ordering::SeqCst) {
        log::info!("[TrayManager] 弹窗正在重建中，忽略本次右键点击");
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let app = &app;

        // 如果已有弹窗，先关闭并等待其销毁完成，再创建新窗口
        if let Some(existing) = app.get_webview_window(popup_label) {
            log::info!("[TrayManager] 关闭已有弹窗，准备重建");
            let _ = existing.close();
            std::thread::sleep(std::time::Duration::from_millis(80));
        }

        let monitoring = is_monitoring_public(app);
        let recents = get_recent_texts_public(app, 3);
        log::info!("[TrayManager] 最近记录: {} 条", recents.len());
        let popup_data = build_popup_data_public(app, &recents, monitoring);
        let taskbar_edge = get_taskbar_edge();
        let popup_pos = calc_popup_position(tray_rect, popup_w, popup_h, taskbar_edge);

        log::info!("[TrayManager] 开始创建弹窗窗口...");

        match WebviewWindowBuilder::new(
            app,
            popup_label,
            tauri::WebviewUrl::App("popup.html".into()),
        )
        .title("")
        .inner_size(popup_w, popup_h)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()
        {
            Ok(window) => {
                log::info!("[TrayManager] 弹窗窗口创建成功");

                // 设置位置
                let _ = window.set_position(popup_pos);

                // 应用 DWM 圆角（Windows 11）
                #[cfg(target_os = "windows")]
                set_dwm_round_corners(&window);

                // ★ 先发送初始化数据，再显示窗口 — 确保前端渲染时数据已就绪
                let _ = app.emit("tray-popup-init", &popup_data);
                log::info!("[TrayManager] 已发送 tray-popup-init（在 show 之前）");

                // 显示窗口
                let show_result = window.show();
                log::info!("[TrayManager] show() 结果: {:?}", show_result);
                let _ = window.set_focus();

                // ★ 延迟注册失焦监听，避免 show()/set_focus() 过程中误触发 Focused(false) 导致闪退
                let w_for_event = window.clone();
                let w_for_thread = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));

                    // 若这 300ms 等待期间窗口已被关闭/替换（例如又发生了一次快速右键重建），
                    // 则不要在一个已销毁的窗口对象上注册监听。
                    if w_for_event.is_visible().is_err() {
                        log::info!("[TrayManager] 弹窗已在等待期间被关闭，跳过失焦监听注册");
                        return;
                    }

                    let hide_flag = Arc::new(AtomicBool::new(false));
                    let flag = hide_flag.clone();
                    let flag2 = hide_flag.clone();
                    w_for_event.on_window_event(move |event| {
                        if let tauri::WindowEvent::Focused(false) = event {
                            if flag.swap(true, Ordering::SeqCst) {
                                return;
                            }
                            let w3 = w_for_thread.clone();
                            let f2 = flag2.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(30));
                                // 再次确认窗口仍然存在，避免作用于已销毁的窗口对象
                                if w3.is_visible().is_ok() {
                                    let _ = w3.hide();
                                }
                                f2.store(false, Ordering::SeqCst);
                            });
                        }
                    });
                    log::info!("[TrayManager] 失焦监听已注册");
                });
            }
            Err(e) => {
                log::warn!("[TrayManager] 创建托盘弹出窗口失败: {}", e);
            }
        }

        // 本轮关闭/重建序列结束，允许后续右键点击再次触发
        POPUP_REBUILDING.store(false, Ordering::SeqCst);
    });
}

/// 为弹窗窗口设置 DWM 圆角（Windows 11）
#[cfg(target_os = "windows")]
fn set_dwm_round_corners(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE};
    if let Ok(hwnd) = window.hwnd() {
        let preference: i32 = 2; // DWMWCP_ROUNDSMALL
        unsafe {
            if let Err(e) = DwmSetWindowAttribute(
                windows::Win32::Foundation::HWND(hwnd.0 as *mut _),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            ) {
                log::warn!("[TrayManager] DWM 圆角设置失败: {:?}", e);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn set_dwm_round_corners(_window: &tauri::WebviewWindow) {}

/// 初始化系统托盘图标（纯自绘弹窗，无原生菜单）
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let icon = Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap_or_else(|e| {
        log::error!("[TrayManager] 加载托盘图标失败: {}", e);
        let mut pixels = vec![0u8; 32 * 32 * 4];
        for y in 8..24 {
            for x in 8..24 {
                let idx = (y * 32 + x) * 4;
                pixels[idx] = 200;
                pixels[idx + 1] = 200;
                pixels[idx + 2] = 200;
                pixels[idx + 3] = 200;
            }
        }
        Image::new_owned(pixels, 32, 32)
    });

    let version = &crate::commands::APP_VERSION;

    // 记录最后一次托盘图标完整矩形 (x, y, w, h)（从 Enter/Move 事件获取）
    let tray_rect: Arc<Mutex<(f64, f64, f64, f64)>> = Arc::new(Mutex::new((0.0, 0.0, 24.0, 24.0)));

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip(format!("{} v{}", crate::commands::APP_NAME.get().map(|s| s.as_str()).unwrap_or("PastePanda"), &**version))
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |tray, event| {
            match event {
                // 记录托盘图标完整矩形（Enter/Move 事件提供 rect.position + rect.size）
                TrayIconEvent::Enter { rect, .. } | TrayIconEvent::Move { rect, .. } => {
                    let (x, y) = match rect.position {
                        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
                        tauri::Position::Logical(l) => (l.x, l.y),
                    };
                    let (w, h) = match rect.size {
                        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
                        tauri::Size::Logical(s) => (s.width, s.height),
                    };
                    if let Ok(mut r) = tray_rect.lock() {
                        *r = (x, y, w, h);
                    }
                }
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let app = tray.app_handle();
                    // 隐藏 popup（如果正在显示）
                    if let Some(popup) = app.get_webview_window("tray-popup") {
                        if popup.is_visible().unwrap_or(false) {
                            popup.hide().ok();
                        }
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            window.hide().ok();
                        } else {
                            if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
                                engine.save_foreground_hwnd();
                            }
                            window.unminimize().ok();
                            if let Err(e) = window.show() {
                                log::warn!("[TrayManager] 托盘左键-显示窗口失败: {}", e);
                            }
                            window.set_focus().ok();
                        }
                    }
                }
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } => {
                    // ★ 优先使用 Click 事件自带的 rect 获取托盘图标位置，
                    //    因为用户可能快速右键（未触发 Enter/Move），缓存 tray_rect 还是默认值 (0,0)
                    let (x, y) = match rect.position {
                        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
                        tauri::Position::Logical(l) => (l.x, l.y),
                    };
                    let (w, h) = match rect.size {
                        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
                        tauri::Size::Logical(s) => (s.width, s.height),
                    };
                    let tray_rect = (x, y, w, h);
                    log::info!(
                        "[TrayManager] 右键点击 — 直接从 Click rect 获取位置: ({:.0},{:.0} {:.0}x{:.0})",
                        x, y, w, h
                    );
                    // 右键 → 打开自绘弹出菜单，传递托盘完整矩形
                    show_tray_popup(tray.app_handle(), tray_rect);
                }
                _ => {}
            }
        })
        .build(app)?;

    log::info!("[TrayManager] 系统托盘已初始化 (纯自绘弹窗)");
    Ok(())
}
