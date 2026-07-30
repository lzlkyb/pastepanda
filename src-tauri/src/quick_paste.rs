//! 快捷粘贴面板（类 Win+V）：热键唤出、贴光标定位、失焦隐藏的轻量弹窗。
//! 窗口缓存复用（创建一次，show/hide + 重定位 + 数据刷新），避免每次重建的开销。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "quick-paste";

/// 面板逻辑尺寸随布局变化：grid=双栏网格 460×520，list=单栏列表 380×500
fn panel_size(layout: &str) -> (f64, f64) {
    match layout {
        "list" => (380.0, 500.0),
        _ => (460.0, 520.0), // grid 为默认布局
    }
}

/// 从 DataStore 读取快捷粘贴面板布局配置（"grid" / "list"），缺省/非法时回退 "grid"
fn get_layout(app: &AppHandle) -> String {
    app.try_state::<crate::data_store::DataStore>()
        .and_then(|store| store.get_config().ok())
        .and_then(|cfg| {
            cfg.get("quick_paste_layout")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "grid".to_string())
}

/// 获取鼠标光标的物理坐标
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

/// 计算面板位置：光标右下方偏移，钳制到所在显示器工作区（物理坐标系，DPI 感知）
/// panel_w / panel_h 为当前布局的逻辑尺寸
fn calc_position(panel_w: f64, panel_h: f64) -> tauri::PhysicalPosition<f64> {
    let (cx, cy) = get_cursor_pos();
    let mon = crate::tray_manager::get_monitor_work_area(cx, cy);

    let offset = 8.0; // 光标与面板左上角的间距
    let margin = 8.0; // 屏幕边缘安全边距

    // 逻辑尺寸 → 物理尺寸
    let pw = panel_w * mon.scale;
    let ph = panel_h * mon.scale;

    let raw_x = cx + offset;
    let raw_y = cy + offset;

    // 钳制到工作区；若工作区比面板小则贴左上角
    let (min_x, max_x) = (mon.work_x + margin, mon.work_x + mon.work_w - pw - margin);
    let (min_y, max_y) = (mon.work_y + margin, mon.work_y + mon.work_h - ph - margin);
    let x = if max_x < min_x { min_x } else { raw_x.max(min_x).min(max_x) };
    let y = if max_y < min_y { min_y } else { raw_y.max(min_y).min(max_y) };

    log::info!(
        "[QuickPaste] 定位: cursor=({:.0},{:.0}) scale={:.2} final=({:.0},{:.0})",
        cx, cy, mon.scale, x, y
    );
    tauri::PhysicalPosition { x, y }
}

/// 防止并发创建同名窗口（快速连按热键）
static CREATING: AtomicBool = AtomicBool::new(false);

/// 切换快捷粘贴面板（热键回调入口）：
/// - 面板可见 → 隐藏
/// - 面板已创建但隐藏 → 重定位 + 刷新 + 显示
/// - 面板未创建 → 创建
pub fn toggle_quick_paste(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            log::info!("[QuickPaste] 面板已隐藏");
            return;
        }
        show_panel(app, &window);
        return;
    }
    create_panel(app);
}

/// 显示已有面板：按当前布局重设尺寸 → 重定位 → 发事件通知前端刷新数据 → show + focus
fn show_panel(app: &AppHandle, window: &WebviewWindow) {
    // 窗口是缓存复用的，布局可能已在设置中切换，须按当前布局重设尺寸后再定位
    let layout = get_layout(app);
    let (w, h) = panel_size(&layout);
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    let pos = calc_position(w, h);
    let _ = window.set_position(pos);
    // 通知前端刷新数据（前端监听后 invoke get_quick_paste_data）
    let _ = app.emit("quick-paste-show", ());
    let _ = window.show();
    let _ = window.set_focus();
    log::info!("[QuickPaste] 面板已显示（复用缓存窗口，布局={}）", layout);
}

/// 首次创建面板窗口
fn create_panel(app: &AppHandle) {
    if CREATING.swap(true, Ordering::SeqCst) {
        log::info!("[QuickPaste] 窗口创建中，忽略重复调用");
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
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
            show_panel(app, &existing);
            return;
        }

        let layout = get_layout(app);
        let (panel_w, panel_h) = panel_size(&layout);
        let pos = calc_position(panel_w, panel_h);

        match WebviewWindowBuilder::new(
            app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("quickpaste.html".into()),
        )
        .title("")
        .inner_size(panel_w, panel_h)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()
        {
            Ok(window) => {
                let _ = window.set_position(pos);

                #[cfg(target_os = "windows")]
                crate::tray_manager::set_dwm_round_corners(&window);

                // 通知前端加载数据
                let _ = app.emit("quick-paste-show", ());

                let _ = window.show();
                let _ = window.set_focus();
                log::info!("[QuickPaste] 面板窗口创建并显示");

                // 延迟注册失焦隐藏，避免 show/set_focus 过程中误触发
                let w_for_event = window.clone();
                let w_for_hide = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    if w_for_event.is_visible().is_err() {
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
                            let w = w_for_hide.clone();
                            let f = flag2.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(30));
                                if w.is_visible().is_ok() {
                                    let _ = w.hide();
                                    log::info!("[QuickPaste] 失焦，面板已隐藏");
                                }
                                f.store(false, Ordering::SeqCst);
                            });
                        }
                    });
                    log::info!("[QuickPaste] 失焦监听已注册");
                });
            }
            Err(e) => {
                log::warn!("[QuickPaste] 创建面板窗口失败: {}", e);
            }
        }
    });
}

/// 隐藏快捷粘贴面板（前端粘贴后调用）
#[tauri::command]
pub fn hide_quick_paste(app: AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        }
    }
}

/// 快捷粘贴面板数据项
#[derive(serde::Serialize)]
pub struct QuickPasteItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub text: String,
    pub content: String,
    pub pinned: bool,
    pub time: String,
    pub source: String,
    pub content_type: String,
}

/// 获取快捷粘贴面板数据（最近 N 条，置顶优先）
#[tauri::command]
pub fn get_quick_paste_data(
    store: tauri::State<'_, crate::data_store::DataStore>,
) -> Result<Vec<QuickPasteItem>, String> {
    let items = store.get_recent_items(30)?;
    let mut result: Vec<QuickPasteItem> = items
        .into_iter()
        .map(|item| QuickPasteItem {
            id: item.id,
            item_type: item.item_type,
            text: item.text,
            content: item.content,
            pinned: item.pinned,
            time: item.time,
            source: item.source,
            content_type: item.content_type.unwrap_or_default(),
        })
        .collect();
    // 置顶项排前，其余保持时间倒序（稳定排序）
    result.sort_by(|a, b| b.pinned.cmp(&a.pinned));
    Ok(result)
}
