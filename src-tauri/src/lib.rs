use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// 启动早期致命错误：弹出原生错误对话框后干净退出进程，
/// 避免 windows_subsystem = "windows" 下无控制台时用户看到的"静默崩溃"或 panic 崩溃对话框。
fn fatal_startup_error(app: &tauri::AppHandle, title: &str, detail: impl std::fmt::Display) {
    let message = format!(
        "{detail}\n请检查磁盘空间、文件占用（例如杀毒软件/备份软件）或联系技术支持后重试。"
    );
    app.dialog()
        .message(message)
        .kind(MessageDialogKind::Error)
        .title(title)
        .blocking_show();
    std::process::exit(1);
}

mod clipboard_monitor;
mod commands;
pub mod content_classifier;
pub mod data_store;
pub mod error;
mod hotkey_manager;
mod icon_extractor;
mod lan_sync;
mod lang_arbiter;
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
            if let Err(e) = app
                .handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())
            {
                log::error!("window-state 插件初始化失败: {}", e);
                fatal_startup_error(
                    app.handle(),
                    "PastePanda 启动失败",
                    format!("窗口状态插件初始化失败: {e}"),
                );
            }

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
            let store = match data_store::DataStore::new(db_path_str) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("无法初始化数据库: {}", e);
                    fatal_startup_error(
                        app.handle(),
                        "PastePanda 启动失败",
                        format!("数据库初始化失败: {e}"),
                    );
                    unreachable!("fatal_startup_error 已退出进程");
                }
            };

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

            // 读取（或首次启动时自动生成并持久化）局域网同步配对密钥，
            // 用于对 LAN 同步消息进行签名/验签，防止未配对设备伪造消息
            let lan_pairing_key = {
                let existing = saved_config
                    .get("lan_pairing_key")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    // 修复 M14：旧版本可能保存了 "1" 这类弱密钥，强度校验不通过则视为无效并重新生成
                    // （已配对的设备需要重新粘贴新密钥，属安全升级的预期行为）
                    .filter(|k| {
                        let ok = lan_sync::validate_pairing_key(k).is_ok();
                        if !ok {
                            log::warn!("[LanSync] 已保存的配对密钥强度不足，已自动重新生成");
                        }
                        ok
                    });
                match existing {
                    Some(key) => key,
                    None => {
                        let new_key = lan_sync::generate_pairing_key();
                        let mut cfg = saved_config.clone();
                        if let Some(obj) = cfg.as_object_mut() {
                            obj.insert(
                                "lan_pairing_key".to_string(),
                                serde_json::Value::String(new_key.clone()),
                            );
                        }
                        if let Err(e) = store.save_config(&cfg) {
                            log::warn!("[LanSync] 保存自动生成的配对密钥失败: {}", e);
                        }
                        new_key
                    }
                }
            };
            let auto_strip_enabled = saved_config
                .get("auto_strip")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // 修复 U36：读取敏感内容防护配置（默认开启）
            let skip_sensitive_enabled = saved_config
                .get("skip_sensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let excluded_apps_list: Vec<String> = saved_config
                .get("excluded_apps")
                .and_then(|v| v.as_str())
                .map(|s| {
                    s.split(',')
                        .map(|a| a.trim().to_string())
                        .filter(|a| !a.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let hotkey_config = hotkey_manager::HotkeyConfig {
                show_window: saved_config
                    .get("hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Alt+V")
                    .to_string(),
                seq_paste: saved_config
                    .get("sequential_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Alt+Q")
                    .to_string(),
                index_prefix: "Ctrl+Alt".to_string(),
                stack_toggle: saved_config
                    .get("stack_toggle_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Alt+K")
                    .to_string(),
                stack_paste: saved_config
                    .get("stack_paste_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Alt+P")
                    .to_string(),
            };

            app.manage(store);

            // 一次性补填迁移：后台为旧数据（content_type 为 NULL）运行统一分类器回填，
            // 使前端可以完全依赖持久化的 content_type，不再需要本地检测回退
            let backfill_handle = handle.clone();
            std::thread::spawn(move || {
                if let Some(store) = backfill_handle.try_state::<data_store::DataStore>() {
                    match store.backfill_content_types() {
                        Ok(n) if n > 0 => log::info!("[Backfill] content_type 补填完成: {} 行", n),
                        Ok(_) => {}
                        Err(e) => log::warn!("[Backfill] content_type 补填失败: {}", e),
                    }
                }
            });

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
            // 修复 U36：初始化敏感内容防护缓存
            monitor.update_sensitive_cache(skip_sensitive_enabled, excluded_apps_list);
            monitor.start();
            app.manage(monitor);

            // 初始化图标缓存（用于来源应用真实图标）
            let icon_cache_dir = app_dir.join("source-icons");
            let icon_cache = icon_extractor::IconCache::new(icon_cache_dir);
            app.manage(icon_cache);

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
                // release 版为 windows_subsystem = "windows"，无控制台可见，仅 log::warn! 用户无法感知，
                // 需通过事件通知前端弹出提示，否则用户会误以为软件损坏
                if let Err(emit_err) = handle.emit("hotkey-register-failed", e) {
                    log::warn!("[HotkeyManager] 发送热键注册失败事件失败: {}", emit_err);
                }
            }

            // 局域网同步（使用之前读取的配置）
            // 修复 Low：device_id 改用完整 UUID（原仅取前 8 位十六进制 = 32bit，易碰撞/被伪造），
            // 该值仅用于过滤自身消息，无长度约束
            let device_id = uuid::Uuid::new_v4().to_string();
            let lan_sync = lan_sync::LanSync::new(device_id, lan_pairing_key);
            if lan_enabled {
                lan_sync.start_listener(handle.clone());
                log::info!("[LanSync] 局域网同步已启用");
            }
            app.manage(lan_sync);

            // 显示窗口
            // U5：开机自启带 /silent 标志时静默驻留托盘，不弹窗抢焦点
            // （与设置面板"开机后自动在后台运行，托盘图标常驻"的承诺一致）
            let silent_start = std::env::args().any(|a| a.eq_ignore_ascii_case("/silent"));
            if let Some(window) = app.get_webview_window("main") {
                if silent_start {
                    log::info!("[Startup] /silent 模式：窗口保持隐藏，仅托盘常驻");
                } else {
                    if let Err(e) = window.show() {
                        log::warn!("窗口显示失败: {}", e);
                    }
                    if let Err(e) = window.set_focus() {
                        log::warn!("窗口聚焦失败: {}", e);
                    }
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
            commands::use_snippet,
            commands::get_all_history,
            commands::get_image_data_url,
            commands::get_image_thumbnail,
            commands::get_image_info,
            commands::reregister_hotkeys,
            commands::get_file_info,
            commands::read_text_file_preview,
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
            commands::get_lan_pairing_key,
            commands::set_lan_pairing_key,
            commands::regenerate_lan_pairing_key,
            commands::get_app_version,
            commands::get_app_name,
            commands::ocr_image,
            commands::open_pinned_image,
            commands::close_pinned_image,
            commands::hide_tray_popup,
            commands::set_stack_mode,
            commands::get_tray_popup_data,
            commands::emit_tray_open_settings,
            commands::show_main_window,
            commands::save_image_file,
            commands::start_update,
            commands::check_update,
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
            commands::get_source_app_icon,
            commands::clear_source_icon_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
