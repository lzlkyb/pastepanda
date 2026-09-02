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

pub mod ai;
mod atomic_write;
mod auto_cleanup;
mod clipboard_monitor;
mod commands;
// DPAPI 加解密的公共收口（AI 密钥与 MCP 令牌共用同一份 unsafe FFI）
pub mod dpapi;
pub mod content_classifier;
pub mod data_store;
pub mod error;
pub mod hashing;
mod hotkey_manager;
mod icon_extractor;
mod lan_sync;
mod lang_arbiter;
mod mask;
pub mod mcp;
mod paste_engine;
mod pinned_window;
mod quick_paste;
mod screenshot;
// 本机自有凭证的哈希登记处（让剪贴板监听不把我们自己的令牌/密钥记进历史）
pub mod secret_registry;
mod tray_manager;
mod win_foreground;

/// 首次启动时通过文件关联传入的待打开文件路径。
/// setup 阶段前端尚未加载，无法直接 emit 事件，
/// 先存入该状态，前端挂载后调用 take_pending_file_open 取走。
pub struct PendingFileOpen(pub std::sync::Mutex<Option<Vec<String>>>);

/// 全屏编辑器独立窗口的初始数据（通用外壳：markdown/json/html/text/csv/code）。
/// 新建编辑器窗口时先存入该状态，窗口内前端挂载后调用 take_editor_init 取走，
/// 规避"窗口尚未加载完成就 emit 事件导致丢失"的时序竞态。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInitData {
    /// 来源剪贴板卡片 id（从卡片进入时有值，保存时回写该条记录）
    pub source_id: Option<String>,
    /// 初始文本内容（从卡片进入时为卡片 text）
    pub content: Option<String>,
    /// 文件路径（从文件关联进入时有值）
    pub file_path: Option<String>,
    /// 内容类型（markdown/json/html/text/csv/code/config/shell），前端据此查表选择语言模式/视图形态；
    /// 缺省（None）时前端回退 markdown，兼容既有 .md 文件关联
    pub content_type: Option<String>,
    /// 语言提示（如 "Rust"、"YAML"，来自调用方对自动标签的派生），
    /// code 类型据此动态加载 CodeMirror 语言模式；None 时编辑器内可手动选择
    #[serde(default)]
    pub language: Option<String>,
}

pub struct PendingEditor(pub std::sync::Mutex<Option<EditorInitData>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `env_logger::init()` 在 RUST_LOG 未设时默认只放行 **error**，于是全项目
    // 170 个 log::warn! 与 128 个 log::info! 一直输出到虚无。实测确认：启动必然执行的
    // `[HotkeyManager] 注册热键` 在 dev 控制台出现 0 次，只有 updater 的 error 冒出来。
    //
    // 这不是洁癖问题——history_fts 那三个索引 bug（UPSERT/DELETE/COUNT 全年失败）
    // 唯一的报错渠道就是 log::warn!，报错渠道本身是断的，所以它们能长期不被发现。
    //
    // 默认提到 info；RUST_LOG 仍然覆盖一切（要更静就 RUST_LOG=error）。
    // 热路径已核对：剪贴板监听是事件驱动，info 只在线程生命周期与每条新内容时打，
    // 不存在按轮询频率刷日志的地方。
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 文件关联：应用已运行时，系统双击 .md 文件会启动第二个实例，
            // 文件路径作为命令行参数传入，提取后发送事件到前端打开全屏编辑器
            let md_paths: Vec<String> = args
                .iter()
                .filter(|a| {
                    let lower = a.to_lowercase();
                    lower.ends_with(".md") || lower.ends_with(".markdown")
                })
                .cloned()
                .collect();
            if !md_paths.is_empty() {
                let _ = app.emit("file-open-event", md_paths);
            }
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

            // 文件关联（首次启动）：系统双击 .md 文件时，文件路径作为命令行参数传入。
            // 此时前端尚未加载，先存入 PendingFileOpen 状态，前端挂载后主动取走。
            let startup_md_paths: Vec<String> = std::env::args()
                .filter(|a| {
                    let lower = a.to_lowercase();
                    lower.ends_with(".md") || lower.ends_with(".markdown")
                })
                .collect();
            app.manage(PendingFileOpen(std::sync::Mutex::new(
                if startup_md_paths.is_empty() {
                    None
                } else {
                    Some(startup_md_paths)
                },
            )));

            // 全屏 Markdown 编辑器独立窗口的待取初始数据（初始为空）
            app.manage(PendingEditor(std::sync::Mutex::new(None)));

            // 截图标注窗口的待编辑图片路径（贴图双击重编辑用，初始为空）
            app.manage(screenshot::PendingShotEdit(std::sync::Mutex::new(None)));

            // 截图并行预截屏缓存（open_screenshot_window 截屏与窗口创建并行，初始为空）
            app.manage(screenshot::PendingShotCapture(std::sync::Mutex::new(None)));

            // 全屏编辑器当前打开的文件（截图"插入到文档"用）
            app.manage(screenshot::EditorTarget(std::sync::Mutex::new(None)));

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

            // M5-1 内容记忆：启动时懒回填历史摘要（纯规则，不阻塞主流程）。
            // 只补一次（幂等）；清空后不自动补存量（红线②：删了就是删了）。
            // 2000 条规则摘要（正则 + 截断）耗时在百毫秒级，可接受。
            let started = std::time::Instant::now();
            match store.history_summaries_backfill(2000) {
                Ok(n) => log::info!(
                    "[内容记忆] 启动回填 {} 条摘要（{}ms）",
                    n,
                    started.elapsed().as_millis()
                ),
                Err(e) => log::warn!("[内容记忆] 启动回填失败: {}", e),
            }

            // AI 用量明细：启动时清一次过期记录，并删掉 v6 之前那份已废弃的
            // ai_usage.json（它看上去像权威数据源，实际已停止更新，留着只会带偏排查）
            match store.ai_usage_purge(data_store::AI_USAGE_RETAIN_DAYS) {
                Ok(n) if n > 0 => log::info!("[AI] 已清理 {} 条过期用量明细", n),
                Ok(_) => {}
                Err(e) => log::warn!("[AI] 清理过期用量明细失败: {}", e),
            }
            ai::budget::remove_legacy_usage_file(&app_dir);

            // 动作使用日志：启动时清一次过期记录。学习价值在最近几周，旧事件没有留存意义
            match store.action_event_purge(data_store::ACTION_EVENTS_RETAIN_DAYS) {
                Ok(n) if n > 0 => log::info!("[ActionEvents] 已清理 {} 条过期事件", n),
                Ok(_) => {}
                Err(e) => log::warn!("[ActionEvents] 清理过期事件失败: {}", e),
            }

            // AI 反馈：同上。之前 `AI_FEEDBACK_RETAIN_DAYS` 定义了但从未被使用，
            // 结果是反馈数据永久留存——红线②里“自动过期”那一半一直没落地。
            match store.ai_feedback_purge(data_store::AI_FEEDBACK_RETAIN_DAYS) {
                Ok(n) if n > 0 => log::info!("[AI] 已清理 {} 条过期反馈", n),
                Ok(_) => {}
                Err(e) => log::warn!("[AI] 清理过期反馈失败: {}", e),
            }

            // 偏好信号：同节奏过期。“你总把输出改短”本身就是习惯画像，
            // 不自动过期就等于永久留存（同 ai_feedback 那个坑）。
            match store.pref_signal_purge(data_store::PREF_SIGNAL_RETAIN_DAYS) {
                Ok(n) if n > 0 => log::info!("[AI] 已清理 {} 条过期偏好信号", n),
                Ok(_) => {}
                Err(e) => log::warn!("[AI] 清理过期偏好信号失败: {}", e),
            }

            // 读取 LAN 同步配置（在 store 被 manage 之前）
            let lan_enabled = store
                .get_config()
                .ok()
                .and_then(|c| c.get("lan_sync_enabled").and_then(|v| v.as_bool()))
                .unwrap_or(false);

            // 读知识库 MCP 服务配置（同样在 store 被 manage 之前）。
            // 默认 false（决策 D7）：开一个本机监听端口不能因为升级就默默发生。
            let mcp_enabled = store
                .get_config()
                .ok()
                .and_then(|c| c.get(mcp::CFG_ENABLED).and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let mcp_port = store
                .get_config()
                .ok()
                .and_then(|c| c.get(mcp::CFG_PORT).and_then(|v| v.as_u64()))
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p >= 1024)
                .unwrap_or(mcp::DEFAULT_PORT);

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
            // 修复 U36：读取敏感内容防护配置。默认值须与前端 DEFAULT_CONFIG 一致
            // （false = 默认关闭，由用户在设置中显式开启）——此前 unwrap_or(true)
            // 与前端默认 false 脱节，导致未保存过配置的用户防护被静默开启
            let skip_sensitive_enabled = saved_config
                .get("skip_sensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
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
            // P1 文档采集：结构化文本复制保留 CF_HTML。默认 true（与前端 DEFAULT_CONFIG 对齐），
            // 未保存过配置的用户也能直接用上文档保真采集
            let doc_capture_enabled = saved_config
                .get("doc_capture")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
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
                quick_paste: saved_config
                    .get("quick_paste_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Alt+V")
                    .to_string(),
                // 截图标注热键（v6.18 新增）；默认 Ctrl+Q（2 键，避开 QQ/微信截图热键占用）
                screenshot: saved_config
                    .get("screenshot_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Q")
                    .to_string(),
                // 今日速记（B2 #3 / D11）
                daily_note: saved_config
                    .get("daily_note_hotkey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Ctrl+Alt+D")
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

            // 自动清理调度器（后端常驻）：启动延迟首跑 + 每小时循环，
            // 替代原前端 setInterval——关闭窗口驻留托盘时清理不再停摆，
            // 且清理结果不占用前端撤销栈（策略性清理非用户误删）
            auto_cleanup::start(handle.clone());

            // 初始化粘贴抑制
            let paste_suppress = Arc::new(clipboard_monitor::PasteSuppress::new());
            app.manage(paste_suppress.clone());

            // 初始化粘贴引擎
            let paste_engine =
                paste_engine::PasteEngine::new(handle.clone(), paste_suppress.clone());
            app.manage(paste_engine);

            // 初始化图标缓存（用于来源应用真实图标）
            // 须在监听器启动之前 manage：事件驱动监听的捕获/处理线程依赖 IconCache
            let icon_cache_dir = app_dir.join("source-icons");
            let icon_cache = icon_extractor::IconCache::new(icon_cache_dir);
            app.manage(icon_cache);

            // 启动剪贴板监听
            let monitor = clipboard_monitor::ClipboardMonitor::new(handle.clone(), paste_suppress);
            // 从数据库初始化 auto_strip 缓存（在 store.manage 之前已读取），避免轮询时每次都锁数据库
            monitor.update_auto_strip_cache(auto_strip_enabled);
            // 修复 U36：初始化敏感内容防护缓存
            monitor.update_sensitive_cache(skip_sensitive_enabled, excluded_apps_list);
            // P1 文档采集：初始化 doc_capture 缓存
            monitor.update_doc_capture_cache(doc_capture_enabled);
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

            // 知识库 MCP Server（M4）。只有配置里明确开过才启。
            let mcp_server = mcp::McpServer::new();
            if mcp_enabled {
                let kb = std::sync::Arc::new(mcp::source::AppKbSource::new(handle.clone()));
                let started = mcp::token::load_or_create(&app_dir)
                    .and_then(|token| mcp_server.start(kb, token, mcp_port));
                match started {
                    Ok(port) => {
                        log::info!("[MCP] 知识库服务已启用：http://127.0.0.1:{}/mcp", port)
                    }
                    // 不静默（规则 #15.3）：release 版无控制台，光写 log 用户无法感知，
                    // 会只看到一个「已开启」的开关而客户端永远连不上（端口被占是常见原因）。
                    Err(e) => {
                        log::warn!("[MCP] 服务启动失败: {}", e);
                        if let Err(emit_err) = handle.emit("mcp-start-failed", e) {
                            log::warn!("[MCP] 发送启动失败事件失败: {}", emit_err);
                        }
                    }
                }
            }
            app.manage(mcp_server);

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
            commands::count_expired_history,
            commands::count_history_conditions,
            commands::clear_history_conditions,
            commands::preview_history_conditions,
            commands::get_config,
            commands::save_config,
            commands::get_stats,
            commands::get_stats_detail,
            commands::get_sidebar_counts,
            commands::search_history,
            commands::paste_text,
            commands::paste_precheck,
            commands::paste_image,
            commands::paste_rich,
            commands::copy_rich_only,
            commands::update_history_rich,
            commands::save_rich_image,
            commands::copy_only,
            commands::copy_image_only,
            commands::copy_files,
            commands::save_foreground,
            commands::paste_send_tab,
            commands::stack_template_list,
            commands::stack_template_save,
            commands::stack_template_delete,
            commands::stack_template_touch,
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
            commands::read_text_file_full,
            commands::write_text_file_full,
            commands::write_binary_file_base64,
            commands::open_file_with_system,
            commands::open_file_location,
            commands::set_startup,
            commands::get_startup,
            commands::get_md_association_status,
            commands::set_md_association,
            commands::toggle_monitor,
            commands::get_monitor_status,
            commands::get_lan_status,
            commands::toggle_lan_sync,
            commands::send_lan_test,
            commands::get_lan_devices,
            commands::get_lan_pairing_key,
            commands::set_lan_pairing_key,
            commands::regenerate_lan_pairing_key,
            commands::mcp_get_status,
            commands::mcp_get_token,
            commands::mcp_regenerate_token,
            commands::mcp_set_enabled,
            commands::mcp_set_port,
            commands::get_app_version,
            commands::get_app_name,
            commands::ocr_image,
            commands::ocr_image_cached,
            commands::open_pinned_image,
            commands::close_pinned_image,
            screenshot::capture_screen,
            screenshot::capture_region,
            screenshot::save_screenshot_image,
            screenshot::close_screenshot_window,
            screenshot::screenshot_ready,
            screenshot::hide_screenshot_window,
            screenshot::show_screenshot_window,
            screenshot::open_longshot_status,
            screenshot::close_longshot_status,
            screenshot::arm_longshot_escape,
            screenshot::arm_longshot_guard,
            screenshot::disarm_longshot_guard,
            screenshot::longshot_heartbeat,
            screenshot::snap_window_at,
            screenshot::enum_window_rects,
            screenshot::enum_controls,
            screenshot::send_mouse_wheel,
            screenshot::scroll_longshot,
            screenshot::get_scroll_bottom,
            screenshot::get_scroll_range,
            screenshot::take_pending_shot_edit,
            screenshot::virtual_screen_size,
            screenshot::insert_screenshot_to_history,
            screenshot::update_screenshot_ocr_summary,
            screenshot::finish_screenshot_rgba,
            screenshot::take_pending_shot_capture,
            screenshot::mark_ocr_temp,
            screenshot::unmark_ocr_temp,
            screenshot::get_cursor_pos,
            screenshot::get_auto_frame_window,
            screenshot::get_auto_chain_after_screenshot,
            screenshot::set_editor_target,
            screenshot::get_editor_target,
            screenshot::insert_into_editor,
            screenshot::emit_ocr_ready,
            screenshot::list_pinned_images,
            screenshot::close_pinned_image_by_path,
            screenshot::transform_pinned_image_by_path,
            screenshot::open_pinned_panel,
            screenshot::open_pinned_edit,
            commands::hide_tray_popup,
            quick_paste::hide_quick_paste,
            quick_paste::get_quick_paste_data,
            commands::set_stack_mode,
            commands::get_tray_popup_data,
            commands::emit_tray_open_settings,
            commands::show_main_window,
            commands::save_image_file,
            commands::start_update,
            commands::check_update,
            commands::read_file_as_base64,
            commands::read_pdf_as_base64,
            commands::allow_media_asset,
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
            // 笔记（知识库 A 阶段 · 规划 §8.1 3️⃣）
            commands::note_create,
            commands::note_update,
            commands::note_delete,
            commands::note_get,
            commands::note_list,
            commands::note_by_history,
            commands::note_history_ids,
            commands::note_search,
            commands::note_search_relevant,
            commands::note_set_tags,
            commands::note_count,
            commands::note_count_filtered,
            // 笔记文件夹（B1 #1）
            commands::folder_list,
            commands::folder_unfiled_count,
            commands::folder_max_depth,
            commands::folder_delete_impact,
            commands::folder_create,
            commands::folder_rename,
            commands::folder_move,
            commands::folder_delete,
            commands::note_set_folder,
            // 版本快照 + 恢复（B1 #4 / D8）
            commands::note_revision_list,
            commands::note_revision_get,
            commands::note_restore,
            // Markdown 目录导出 / 导入（B1 #5 / D1）
            commands::note_export_dir,
            commands::note_import_dir,
            commands::note_markdown,
            // 笔记轻量 AI（B1 ＋轻量 AI）——模型调用走 ai_run，这里只落库
            commands::note_set_summary,
            commands::note_add_ai_tags,
            commands::note_confirm_ai_tags,
            // 笔记访问时间（B2 前置，为 #7 重现的「久未访问」攒数据）
            commands::note_touch,
            // 字段视图（B2 #9）：分组组头的真实条数（笔记侧 + 收件箱侧）
            commands::note_group_counts,
            commands::kb_inbox_group_counts,
            // 今日速记（B2 #3 / D11）——热键与右键菜单共用 append 这一条
            commands::note_append_daily,
            commands::note_daily_dates,
            commands::note_daily_earliest,
            commands::note_daily_today,
            // 待沉淀区（知识库 A 阶段 · 规划 §8.1 4️⃣）
            commands::kb_inbox_list,
            commands::kb_inbox_count,
            commands::kb_inbox_dismiss,
            commands::kb_inbox_undismiss,
            // 自动收录影子运行（规划 §8.1 5️⃣）
            commands::kb_shadow_run,
            commands::kb_shadow_stats,
            commands::kb_shadow_clear,
            commands::get_source_app_icon,
            commands::clear_source_icon_cache,
            commands::take_pending_file_open,
            commands::file_mtime_ms,
            commands::open_fullscreen_editor,
            commands::take_editor_init,
            commands::close_editor_window,
            commands::insert_markdown_history,
            commands::insert_diagram_history,
            commands::update_diagram_history,
            commands::export_history_csv,
            commands::export_history_xlsx,
            commands::detect_config_format,
            commands::convert_config,
            commands::batch_convert_config,
            commands::diff_config,
            commands::diff_config_files,
            commands::read_text_file,
            commands::detect_file_encoding,
            commands::convert_file_encoding,
            commands::batch_convert_encoding,
            commands::preview_replace,
            commands::execute_replace,
            commands::get_regex_rules,
            commands::save_regex_rules,
            // 云端 AI 地基（阶段 B0）——注意没有 ai_get_key，密钥不回读给前端
            commands::ai_get_config,
            commands::ai_set_config,
            commands::ai_set_key,
            commands::ai_has_key,
            commands::ai_clear_key,
            commands::ai_list_providers,
            commands::ai_test_connection,
            // v6.4 AI 面板 v2：per-provider 配置 + 自定义服务商多实例
            commands::ai_get_provider_config,
            commands::ai_save_custom_provider,
            commands::ai_delete_custom_provider,
            commands::ai_list_actions,
            commands::ai_get_usage,
            commands::ai_list_content_types,
            commands::ai_list_custom_actions,
            commands::ai_save_custom_action,
            commands::ai_delete_custom_action,
            commands::ai_reorder_custom_actions,
            commands::ai_preview_custom,
            commands::ai_list_usage_log,
            commands::ai_get_usage_stats,
            commands::ai_clear_usage_log,
            commands::ai_run,
            // 动作链（X1 B2）：自定义链 CRUD
            commands::chain_list,
            commands::chain_save,
            commands::chain_delete,
            commands::chain_reorder,
            // AI 结果反馈 + 动作偏好（M3 偏好学习）
            commands::ai_feedback_add,
            commands::ai_feedback_stats,
            commands::ai_feedback_clear,
            commands::action_pref_get,
            commands::action_pref_set,
            commands::action_prefs_all,
            // AI 编链：模型根据内容编一条动作链（用户确认后才跑）
            commands::ai_plan_chain,
            // 偏好自荐：特征信号 → 待确认的偏好建议
            commands::pref_signal_add,
            commands::pref_signal_top,
            commands::pref_signal_accept,
            commands::pref_signal_dismiss,
            commands::pref_signal_clear,
            // 内容记忆（M5-1）：本地检索摘要
            commands::history_summaries_backfill,
            commands::history_summaries_count,
            commands::history_summaries_clear,
            // 语义索引（M5-2）：云端 embedding + 本地向量检索
            commands::semantic_status,
            commands::semantic_set_config,
            commands::semantic_index,
            commands::semantic_search,
            commands::sql_validate,
            // 用户画像（M6-2/M6-3）：聚合 + 覆盖 + 导出
            commands::profile_refine,
            commands::profile_get,
            commands::profile_set_override,
            commands::profile_export,
            commands::profile_install_skill,
            commands::skill_install_workflows,
            commands::profile_action_boosts,
            commands::profile_prompt_preview,
            // 程序性记忆（V3-B）：高频动作序列
            commands::sequence_suggest,
            // 环境智能：二元转移表（做完 A 常接着做 B）嗂给推荐排序
            commands::sequence_transitions,
            // 粘性数据（v6.8）：活跃日历 / 连续周数 / 成就 / 里程碑
            commands::stats_sticky,
            // 免费额度（v6.9 签到送 token）：总览 / 签到 / 兑换
            commands::ai_quota_get,
            commands::ai_quota_sign,
            commands::ai_quota_redeem,
            // 动作使用日志（v6.0 第一步：action_events 表）
            commands::action_event_log,
            commands::action_event_stats,
            commands::action_event_clear,
            // 个性化推荐数据（v6.1：权重聚合 / 不再推荐 / 一键清空学习记录）
            commands::action_recommend_weights,
            commands::action_recommend_scene_weights,
            commands::action_dismiss_add,
            commands::action_dismissals,
            commands::action_dismiss_remove,
            commands::action_pin_add,
            commands::action_pins,
            commands::action_pin_remove,
            commands::action_learnings_clear,
            // 执行类动作（v6.0 复制即执行）：协议白名单打开链接
            commands::open_url,
            // v6.4 链接摘要（六大王牌 A，阶段 1：抓页 + 本地正文提取）
            commands::fetch_url_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
