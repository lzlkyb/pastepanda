use std::sync::Arc;
use tauri::Manager;

mod clipboard_monitor;
mod commands;
pub mod content_classifier;
pub mod data_store;
pub mod error;
mod hotkey_manager;
mod lan_sync;
mod paste_engine;
mod pinned_window;
mod tray_manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二个实例启动时，显示已有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 窗口状态恢复 — 必须在 window.show() 之前注册，确保先恢复后显示
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())
                .expect("window-state 插件初始化失败");

            // 初始化 APP_NAME（通过 Tauri 框架 API 获取，dev/安装版均可正确读取）
            let product_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| "PastePanda".into());
            let _ = commands::APP_NAME.set(product_name);

            // Updater 插件容错注册：初始化失败仅 warn，不中断应用启动
            #[cfg(desktop)]
            {
                if let Err(e) = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                {
                    log::warn!("初始化 Updater 插件失败，已跳过：{e}");
                }
            }
            let handle = app.handle().clone();

            // 初始化 SQLite 数据库
            let app_dir = handle.path().app_data_dir().expect("无法获取应用数据目录");
            if let Err(e) = std::fs::create_dir_all(&app_dir) {
                log::error!("无法创建应用数据目录: {}", e);
            }
            let db_path = app_dir.join("clipboard.db");
            let db_path_str = db_path.to_str().unwrap_or_else(|| {
                log::error!("数据库路径包含非 UTF-8 字符，使用回退路径");
                "clipboard.db"
            });
            let store = data_store::DataStore::new(db_path_str).expect("无法初始化数据库");

            // 初始化自动标签种子数据（AI 智能分类用）
            if let Err(e) = store.ensure_auto_tags() {
                log::warn!("[ContentClassifier] 自动标签种子数据初始化失败: {}", e);
            }

            // 读取 LAN 同步配置（在 store 被 manage 之前）
            let lan_enabled = store
                .get_config()
                .ok()
                .and_then(|c| c.get("lan_sync_enabled").and_then(|v| v.as_bool()))
                .unwrap_or(false);

            // 读取保存的热键配置（在 store 被 manage 之前）
            let saved_config = store.get_config().unwrap_or_default();
            let auto_strip_enabled = saved_config
                .get("auto_strip")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let hotkey_config = hotkey_manager::HotkeyConfig {
                show_window: saved_config
                    .get("hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Shift+V")
                    .to_string(),
                seq_paste: saved_config
                    .get("sequential_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Q")
                    .to_string(),
                index_prefix: "Ctrl+Alt".to_string(),
            };

            app.manage(store);

            // 初始化粘贴抑制
            let paste_suppress = Arc::new(clipboard_monitor::PasteSuppress::new());
            app.manage(paste_suppress.clone());

            // 初始化粘贴引擎
            let paste_engine =
                paste_engine::PasteEngine::new(handle.clone(), paste_suppress.clone());
            app.manage(paste_engine);

            // 启动剪贴板监听
            let monitor = clipboard_monitor::ClipboardMonitor::new(handle.clone(), paste_suppress);
            // 从数据库初始化 auto_strip 缓存（在 store.manage 之前已读取），避免轮询时每次都锁数据库
            monitor.update_auto_strip_cache(auto_strip_enabled);
            monitor.start();
            app.manage(monitor);

            // 初始化内容分类器（AI 智能分类）
            let classifier = content_classifier::ContentClassifier::new();
            app.manage(classifier);

            // 系统托盘
            if let Err(e) = tray_manager::setup_tray(&handle) {
                log::warn!("[TrayManager] 托盘初始化失败: {}", e);
            }

            // 全局热键
            if let Err(e) = hotkey_manager::register_global_hotkeys(&handle, &hotkey_config) {
                log::warn!("[HotkeyManager] 热键注册失败: {}", e);
            }

            // 局域网同步（使用之前读取的配置）
            let device_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
            let lan_sync = lan_sync::LanSync::new(device_id);
            if lan_enabled {
                lan_sync.start_listener(handle.clone());
                log::info!("[LanSync] 局域网同步已启用");
            }
            app.manage(lan_sync);

            // 显示窗口
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.show() {
                    log::warn!("窗口显示失败: {}", e);
                }
                if let Err(e) = window.set_focus() {
                    log::warn!("窗口聚焦失败: {}", e);
                }

                // Win11 DWM 圆角
                #[cfg(target_os = "windows")]
                {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::Graphics::Dwm::{
                        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        let preference: i32 = 2; // DWMWCP_ROUNDSMALL = 2
                        unsafe {
                            if let Err(e) = DwmSetWindowAttribute(
                                HWND(hwnd.0 as *mut _),
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &preference as *const i32 as *const _,
                                std::mem::size_of::<i32>() as u32,
                            ) {
                                log::warn!("DWM 圆角设置失败: {:?}", e);
                            }
                        }
                    }
                }
            }

            log::info!(
                "{} v{} 启动",
                commands::APP_NAME
                    .get()
                    .map(|s| s.as_str())
                    .unwrap_or("PastePanda"),
                *commands::APP_VERSION
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_history,
            commands::insert_history,
            commands::update_history,
            commands::delete_history,
            commands::toggle_pin,
            commands::clear_history,
            commands::get_config,
            commands::save_config,
            commands::get_stats,
            commands::paste_text,
            commands::paste_image,
            commands::copy_only,
            commands::save_foreground,
            commands::toggle_window,
            commands::exit_app,
            commands::import_history,
            commands::add_snippet,
            commands::get_snippets,
            commands::update_snippet,
            commands::delete_snippet,
            commands::get_all_history,
            commands::get_image_data_url,
            commands::get_image_thumbnail,
            commands::get_image_info,
            commands::reregister_hotkeys,
            commands::get_file_info,
            commands::open_file_with_system,
            commands::open_file_location,
            commands::set_startup,
            commands::get_startup,
            commands::toggle_monitor,
            commands::get_monitor_status,
            commands::get_lan_status,
            commands::toggle_lan_sync,
            commands::send_lan_test,
            commands::get_lan_devices,
            commands::get_app_version,
            commands::get_app_name,
            commands::ocr_image,
            commands::open_pinned_image,
            commands::close_pinned_image,
            commands::hide_tray_popup,
            commands::get_tray_popup_data,
            commands::emit_tray_open_settings,
            commands::show_main_window,
            commands::save_image_file,
            commands::start_update,
            commands::read_file_as_base64,
            commands::get_groups,
            commands::create_group,
            commands::update_group,
            commands::delete_group,
            commands::reorder_groups,
            commands::move_to_group,
            commands::get_tags,
            commands::create_tag,
            commands::update_tag,
            commands::delete_tag,
            commands::set_item_tags,
            commands::add_item_tags,
            commands::remove_item_tags,
            commands::get_items_with_tags,
            commands::confirm_auto_tags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
