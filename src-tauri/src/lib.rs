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
/// AM-5 召回基准。`#[cfg(test)]`：只在 `cargo test` 下编译，**不进安装包**。
/// 真库跑法见模块文档。
#[cfg(test)]
mod bench;
mod clipboard_monitor;
mod commands;
pub mod user_paths;
// DPAPI 加解密的公共收口（AI 密钥与 MCP 令牌共用同一份 unsafe FFI）
pub mod content_classifier;
pub mod data_store;
pub mod dpapi;
pub mod error;
pub mod hashing;
mod hotkey_manager;
mod icon_extractor;
mod lan_pair;
mod lan_sync;
mod lang_arbiter;
pub mod markdown;
mod mask;
pub mod mcp;
mod paste_engine;
mod paste_target;
mod pinned_window;
mod quick_paste;
mod screenshot;
mod stack_hud;
mod stack_hud_focus;
mod stack_hud_pos;
// 本机自有凭证的哈希登记处（让剪贴板监听不把我们自己的令牌/密钥记进历史）
/// 远程电脑（远程协助）。默认关；复用 sync 的 iroh 端点（双 ALPN）。
pub mod rc;
pub mod secret_registry;
/// AM-8 近重复判定（纯函数）。
pub mod similar;
/// M6 多机同步。当前只有 P1 身份/配对层，无传输层、无界面。
pub mod sync;
mod todo_island;
mod todo_island_hover;
mod todo_island_probe;
/// 岛的舞台尺寸与切换（收起/悬停/展开/输入/全清）。
mod todo_island_stage;
/// 独占全屏检测（岛在全屏应用前要藏起来，拍板 6）。
mod todo_island_fullscreen;
/// 待办扫描（灵动岛 B2）：活笔记正文的 GFM 复选框 → 岛状态。
pub mod todo_tasks;
mod tray_manager;
mod win_foreground;

/// 主窗口是不是**真的在用户眼前**。
///
/// 🔴 不能只看 `is_visible()`：Windows 上**最小化的窗口仍然带着 `WS_VISIBLE`**，
/// `is_visible()` 返回 `true`。只看它的话，窗口最小化后再点托盘 / 按唤出热键，
/// 会被判成「它开着，收起来吧」而走进 `hide()` 分支——把一个已经缩着的窗口
/// 又藏了一层。用户看到的就是「点了没反应」，得再点一次才出来（2026-09-06 反馈）。
pub fn main_window_showing(window: &tauri::WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

/// 把窗口摆到用户眼前（主窗口、md 编辑器窗口都用它）。
///
/// ❗ `unminimize()` 不能省：对已最小化的窗口，`show()` 在 Windows 上
/// **不会把它从任务栏恢复回来**，窗口依然缩着。全仓十几处
/// `show() + set_focus()` 里只有两处带了它，其余都拉不回最小化的窗口。
pub fn present_window(window: &tauri::WebviewWindow) {
    window.unminimize().ok();
    if let Err(e) = window.show() {
        log::warn!("[Window] 显示窗口失败: {}", e);
    }
    window.set_focus().ok();
}

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

/// 编辑器窗口的生命期状态。
///
/// ❗ 区分「窗口还没建好」与「窗口内前端已就绪」是**队列能否正确投递**的前提：
///
/// - `Idle` → 建窗，把文档放进队列
/// - `Booting` → 窗口在建 / 前端没挂载完，**只入队不 emit**；此刻 emit 会打在前端还没注册监听器的空档里，静默丢失
/// - `Ready` → 直接 emit `md-editor-load`，前端按去重键决定新开还是切过去
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum EditorWinStatus {
    #[default]
    Idle,
    Booting,
    Ready,
}

/// 编辑器窗口的共享状态。
#[derive(Default)]
pub struct EditorWindow {
    pub status: EditorWinStatus,
    /// 尚未被前端取走的待打开文档。
    ///
    /// ❗ 队列化是必需的，不是优化：双击多选 N 个 `.md` 会**连续**发 N 次请求，
    /// 后 N-1 次都落在「建窗中」这一档。旧实现是单槽 `Option` —— 后一个覆盖前一个，
    /// 而且每次都会再走一遍建窗分支（`get_webview_window` 此刻还没返回），
    /// 同名 label 建窗失败，最后只剩一个文件打不开。
    pub queue: Vec<EditorInitData>,
}

pub struct PendingEditor(pub std::sync::Mutex<EditorWindow>);

/// window-state 插件该持久化哪些窗口属性。
///
/// 🔴 `DECORATIONS` 必须摘掉 —— 本项目的窗口装饰**全部由代码决定**
/// （`tauri.conf.json` 的 main ＋ 每个 `WebviewWindowBuilder` 显式 `.decorations(false)`），
/// 它不是用户运行时可调的偏好，不该被持久化。
///
/// 踩坑经过（2026-09-22）：让插件持久化装饰位会造成一次「污染即永久」的自我延续 ——
/// 某次运行把 rc-workbench 的 `decorated: true` 写进
/// `%APPDATA%/com.pastepanda.app/.window-state.json`，此后每次启动插件都在建窗后
/// 把 `set_decorations(true)` 恢复回来 ⇒ 源码里的 `.decorations(false)` 形同虚设，
/// 工作台多出一条原生标题栏，与自绘 `RcA2TitleBar` 叠成两排窗口按钮。
///
/// 「有标题栏」是可量的，不是看岔了：外框高 − 客户区高 = 47px
/// （`SM_CYCAPTION(29) + SM_SIZEFRAME(4) + SM_CXPADDEDBORDER(5)`，均 @120dpi），
/// 而同进程 tray-popup 只有 10px（纯边框）。摘掉该位后真机实测 47 → 10、
/// 外框高 1010 → 971、标题栏下分割线 97 → 59（= 48 逻辑 px × 1.25）。
///
/// ⚠️ 残留物（无害，但别误以为会自动消失）：插件把 `WindowState` 当**整结构体**落盘
/// （`lib.rs` 的 `save_window_state` 遍历 cache 全字段写出），`update_state` 只是
/// 「标记位不在就不覆盖该字段」。所以 `.window-state.json` 里那条 `"decorated": true`
/// 会一直留在文件里、每次保存照写，只是 `restore_state` 也查标记位 ⇒ **永不生效**。
/// 想清干净得手动删这个键（纯清理，不影响行为）。
#[cfg(desktop)]
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all()
        & !tauri_plugin_window_state::StateFlags::DECORATIONS
}

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
    //
    // ❗ iroh 的 tracing 日志会经 log 桥接进 env_logger，而它的 info 是「每发一个 UDP 包
    //   一条」级别的（实测一次启动 831 行日志里 656 行是 iroh，占 79%）：
    //     · iroh::socket::transports  poll_send; network_path=… len=1200   ← 每包一条
    //     · iroh::socket::remote_map  handle_message; msg=ResolveRemote(..)
    //     · tracing::span             relay-actor; / actor; / tx;  ← 只有 span 名，无字段
    //   这三类是纯噪音，排查打洞问题也不会逐条看，直接 off。net_report/relay 是网络探测与
    //   TLS 连接，偶发且出问题时有价值，降到 warn。iroh::endpoint（节点 id）与
    //   pastepanda_lib::sync::service（同步失败原因）是真信号，保持 info。
    //   env_logger 的过滤按模块路径前缀匹配，所以 iroh::socket=off 一并覆盖 transports
    //   与 remote_map 两个子模块。需要调试 iroh 时 RUST_LOG=iroh=debug 即可全部恢复。
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(
        "info,iroh::socket=off,tracing::span=off,iroh::net_report=warn,iroh_relay=warn",
    ))
    .init();

    // 🔴 硬编诊断（2026-09-23）：进程时间线上的第一个 NVENC 激活采样点。
    // 「外部探针 ✓ / 本进程 ✗」已排除全部 MFT 侧因素（公寓实测 MTA、枚举 flags 与
    // 探针逐字一致、时序/caps 无关），只剩进程内其它状态。把「能不能激活 NVENC」
    // 当成进程的可观测量，沿启动时间线打点：坏在哪两点之间，凶手就在那一段初始化。
    #[cfg(target_os = "windows")]
    crate::rc::mft_diag::probe_nvenc_snapshot("P0 run 入口·logger 就绪");

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
            // 第二个实例启动时，显示已有窗口。
            // ❗ 走 `present_window` 而不是裸 `show()`：主窗口若正最小化着，
            //   `show()` 在 Windows 上拉不回来——双击图标/双击 md 都会看着像没反应。
            if let Some(window) = app.get_webview_window("main") {
                present_window(&window);
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
            log::info!("[BOOT] 0 setup 进入");
            // 🔴 硬编诊断 P1：Tauri 插件链已装、业务子系统尚未初始化。
            #[cfg(target_os = "windows")]
            crate::rc::mft_diag::probe_nvenc_snapshot("P1 BOOT0·插件就绪");
            // 窗口状态恢复 — 必须在 window.show() 之前注册，确保先恢复后显示。
            // 状态位为什么必须摘掉 DECORATIONS、以及「两排标题栏」的量化判据，
            // 见 `window_state_flags()` 的文档注释（别把那条摘除改回来）。
            #[cfg(desktop)]
            if let Err(e) = app
                .handle()
                .plugin(
                    tauri_plugin_window_state::Builder::default()
                        .with_state_flags(window_state_flags())
                        .build(),
                )
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
            log::info!("[BOOT] 1 window-state + updater 注册完成");
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
            app.manage(PendingEditor(std::sync::Mutex::new(EditorWindow::default())));

            // 截图标注窗口的待编辑图片路径（贴图双击重编辑用，初始为空）
            app.manage(screenshot::PendingShotEdit(std::sync::Mutex::new(None)));

            // 截图并行预截屏缓存（open_screenshot_window 截屏与窗口创建并行，初始为空）
            app.manage(screenshot::PendingShotCapture(std::sync::Mutex::new(None)));

            // 全屏编辑器当前打开的文件（截图"插入到文档"用）
            app.manage(screenshot::EditorTarget(std::sync::Mutex::new(None)));

            // 初始化 SQLite 数据库
            log::info!("[BOOT] 2 准备取 app_data_dir");
            let app_dir = handle.path().app_data_dir().expect("无法获取应用数据目录");
            log::info!("[BOOT] 3 app_data_dir = {}", app_dir.display());
            if let Err(e) = std::fs::create_dir_all(&app_dir) {
                log::error!("无法创建应用数据目录: {}", e);
            }
            let db_path = app_dir.join("clipboard.db");
            let db_path_str = db_path.to_str().unwrap_or_else(|| {
                log::error!("数据库路径包含非 UTF-8 字符，使用回退路径");
                "clipboard.db"
            });
            let store = match data_store::DataStore::new(db_path_str) {
                Ok(s) => {
                    log::info!("[BOOT] 4 数据库打开成功");
                    s
                }
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
            log::info!("[BOOT] 5 种子数据完成，准备回填摘要");
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
            // HTTPS 监听：**默认关**，只有配置里明确写过 true 才开。
            let mcp_https_enabled = store
                .get_config()
                .ok()
                .and_then(|c| c.get(mcp::CFG_HTTPS_ENABLED).and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let mcp_https_port = store
                .get_config()
                .ok()
                .and_then(|c| c.get(mcp::CFG_HTTPS_PORT).and_then(|v| v.as_u64()))
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p >= 1024)
                .unwrap_or(mcp::DEFAULT_HTTPS_PORT);
            // 局域网直连：默认关。开着时 start 会改绑 0.0.0.0。
            let mcp_lan_enabled = store
                .get_config()
                .ok()
                .and_then(|c| c.get(mcp::CFG_LAN_ENABLED).and_then(|v| v.as_bool()))
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

            // 本机局域网设备标识。
            //
            // 🔴 必须**持久化**。这里原先在下面起 LanSync 那行写的是每次启动
            //    `uuid::Uuid::new_v4()` 一个新的，旁边注释声称「该值仅用于过滤自身
            //    消息」——**那句是错的**：`lan_sync::remember_device` 拿对端的这个
            //    device_id 当「记住的设备」的身份键（存在 `lan_paired_devices`）。
            //    每次重启换身份的后果（2026-09-07 用户报上来、已在库里核实）：
            //      ① 对端每重启一次，本机就多记一台同名设备（列表无限增长）；
            //      ② `lan_pair::list_nearby` 按 device_id 过滤已配对，所以已配对的机器
            //         重启后又变成「附近的未配对设备」，配对形同虚设；
            //      ③ `PairState::note_reject` 的 REJECT_LIMIT（拒绝 N 次后不再弹框）
            //         可以靠重启绕过；
            //      ④ `forget_device` 删掉的是一个死 id，对端下次启动照样回来。
            //
            // ❗ 注意这里**重新 `get_config()`** 而不是用上面的 `saved_config`：
            //    首次启动两个 key 都缺，若两边各自 `saved_config.clone()` 再写回去，
            //    后写的那个会拿着**旧快照**把刚生成的配对密钥覆盖掉
            //    （下次启动又生成一个新的 ⇒ 首次启动期间配对好的设备全部失效）。
            //
            // ❗ 位置不能往下挑：`app.manage(store)` 之后 `store` 已经被 move 进
            //    Tauri 的状态里，那里再调 `store.get_config()` 直接 E0382。
            let device_id = {
                let cfg_now = store.get_config().unwrap_or_default();
                let existing = cfg_now
                    .get("lan_device_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                match existing {
                    Some(id) => id,
                    None => {
                        let new_id = uuid::Uuid::new_v4().to_string();
                        let mut cfg = cfg_now.clone();
                        if let Some(obj) = cfg.as_object_mut() {
                            obj.insert(
                                "lan_device_id".to_string(),
                                serde_json::Value::String(new_id.clone()),
                            );
                        }
                        if let Err(e) = store.save_config(&cfg) {
                            // 🔴 不能静默（规则 #15.3）：存不下就意味着本次启动的身份只活
                            //    到退出，对端下次会把我们当新设备——就是上面那个 bug 又回来了。
                            log::warn!(
                                "[LanSync] 保存本机 device_id 失败，本次启动的设备身份不会被记住: {}",
                                e
                            );
                        }
                        log::info!("[LanSync] 首次生成本机设备标识并已持久化");
                        new_id
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
            // 栈浮标的状态缓存：HUD webview 首次 mount 时拉取，避免
            // "后端 emit 早于 webview 就绪"导致的首帧空白
            app.manage(stack_hud::HudStateCache::default());
            // 恢复浮标拖拽保存的位置偏移（须在 DataStore manage 之后）
            stack_hud::init(&handle);

            // 待办灵动岛的状态缓存：岛 webview 首次 mount 时拉取，避免首帧空白
            app.manage(todo_island::IslandStateCache::default());
            // 待办提醒账本（二期甲案：到点点亮岛 + 横幅）
            app.manage(todo_island::RemindLedger::default());
            // 相对关键字到期点的钉死缓存（「@今天」隔夜不漂移、不每天重响）
            app.manage(todo_tasks::DuePinCache::default());
            // 待办扫描缓存：键是 updated_ms，内容没变的笔记不再重扫正文
            app.manage(todo_tasks::TodoScanCache::default());
            // 探针阶段：只有带上 PP_TODO_ISLAND_PROBE=1 才显示岛（B1 才接真正的常驻逻辑）
            todo_island::init(&handle);

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

            // 局域网同步（使用之前读取的配置）。
            // `device_id` 在上面跟 `lan_pairing_key` 一起读/生成——必须在
            // `app.manage(store)` **之前**，那一句把 `store` move 进了 Tauri 的状态。
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
                // 证书按需生成：开关不打开，这台机器上就永远不会出现证书文件。
                // 准备失败不拦住主服务（https 是可选功能）。
                let https = if mcp_https_enabled {
                    match mcp::tls::ensure(&app_dir) {
                        Ok(material) => Some(mcp::HttpsOpts {
                            port: mcp_https_port,
                            material,
                        }),
                        Err(e) => {
                            log::warn!("[MCP] 证书准备失败，HTTPS 本次不开：{}", e);
                            None
                        }
                    }
                } else {
                    None
                };
                let started = mcp::token::load_or_create(&app_dir).and_then(|token| {
                    mcp_server.start(
                        handle.clone(),
                        kb,
                        token,
                        mcp_port,
                        https,
                        mcp::LanStartOpts {
                            enabled: mcp_lan_enabled,
                        },
                    )
                });
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

            // 知识库同步（M6）。开关是 `kb_sync_enabled`，**与上面那个局域网同步
            // （同步剪贴板）无关**——用户可能只想要其中一个。
            //
            // ❗ 必须先 manage 再 boot：`boot` 里要 `try_state::<SyncService>()`。
            log::info!("[BOOT] 6 准备注册 SyncService");
            app.manage(sync::service::SyncService::new());
            // 远程协助：全局单例（sync accept 按 ALPN 路由要用）；State 也放同一份。
            // ❗ 必须是**同一个** RcService：两份实例会让会话状态与路由各说各话。
            {
                let rc_state = app.state::<data_store::DataStore>();
                let rc_svc = std::sync::Arc::new(rc::RcService::new((*rc_state).clone()));
                rc::install_global(rc_svc.clone());
                // 状态变化 → emit，前端 Overlay / 对话框立刻跟上（流断开自清也要能看见）
                {
                    let handle_rc = handle.clone();
                    // 岛只对「本机推流」的起止做反应（接线 #8）：推流开始藏、结束复。
                    // 用过渡标记去抖——notify 在画质/光标等状态变化时也会触发，
                    // 不能每次都 hide/refresh（岛会被闪没又闪回）。
                    let island_rc_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let island_rc_flag = island_rc_flag.clone();
                    rc_svc.set_notify(std::sync::Arc::new(move || {
                        if let Some(svc) = rc::global() {
                            let _ = handle_rc.emit("rc-session-changed", svc.status());
                            {
                                let st = svc.status();
                                let inbound = st
                                    .session
                                    .as_ref()
                                    .is_some_and(|s| s.phase == rc::SessionPhase::InboundActive);
                                let prev = island_rc_flag.load(std::sync::atomic::Ordering::SeqCst);
                                if inbound && !prev {
                                    island_rc_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                                    // 隐私门控（不只 hide 一次）：会话期间笔记写路径会把岛
                                    // 重新拉起，门拦在 show() 入口才拦得住（审计 P2#4）
                                    crate::todo_island::set_privacy_gate(&handle_rc, true);
                                } else if !inbound && prev {
                                    island_rc_flag.store(false, std::sync::atomic::Ordering::SeqCst);
                                    crate::todo_island::set_privacy_gate(&handle_rc, false);
                                }
                            }
                            if let Some(err) = svc.take_inject_err() {
                                let _ = handle_rc.emit("rc-inject-error", err);
                            }
                            // D11：被控端拒收/写不进剪贴板 → 发起端 toast。
                            // 与 inject-error 同一招：取走即清，避免同一句刷屏。
                            if let Some(err) = svc.take_clip_push_err() {
                                let _ = handle_rc.emit("rc-clip-push-error", err);
                            }
                        }
                    }));
                }
                // B3：被控端画面范围被对端改动 → 单独抛事件，让被控横幅能说出
                // 「对方把画面范围改成了 X」。只走 rc-session-changed 不够：
                // 那只是「状态变了」，被控端分不清是本地设置改的还是对端改的。
                {
                    let handle_scope = handle.clone();
                    rc_svc.set_scope_notify(std::sync::Arc::new(move |scope: &str| {
                        let _ = handle_scope.emit(
                            "rc-scope-changed",
                            serde_json::json!({ "scope": scope, "by_peer": true }),
                        );
                    }));
                }
                // Q10：被控端画质/编码被对端改动 → 抛事件让被控横幅能说出
                // 「对方把画质调成了 X」。与 rc-scope-changed 同一组理由：
                // 只走 rc-session-changed 分不清是本地改的还是对端改的。
                {
                    let handle_stream = handle.clone();
                    rc_svc.set_stream_notify(std::sync::Arc::new(move |kind: &str, name: &str| {
                        let _ = handle_stream.emit(
                            "rc-stream-note",
                            serde_json::json!({ "kind": kind, "name": name }),
                        );
                    }));
                }
                // C：会话路径自动切换（iroh 每 60s 会尝试把中继路径升级成直连）
                // → 单独抛事件。不加这一条，用户只会看到延迟突然变了却不知道为什么；
                // 「from/to」都要给，前端才能说出「从哪条路换到了哪条路」。
                {
                    let handle_path = handle.clone();
                    rc_svc.set_path_notify(std::sync::Arc::new(move |from: &str, to: &str| {
                        let _ = handle_path.emit(
                            "rc-path-changed",
                            serde_json::json!({ "from": from, "to": to }),
                        );
                    }));
                }
                // P1-6：远端光标形状变化 → 抛事件，前端切 overlay / 系统光标样式
                {
                    let handle_cursor = handle.clone();
                    rc_svc.set_cursor_notify(std::sync::Arc::new(move |shape: &str| {
                        let _ = handle_cursor.emit(
                            "rc-cursor-changed",
                            serde_json::json!({ "shape": shape }),
                        );
                    }));
                }
                // G6：文件传输状态（待响应请求 + 进度）→ 抛完整快照。
                // 传 JSON 载荷而不是「有事变了」：确认条与进度条需要**立即**知道
                // 是哪一条、到什么程度了；让前端再轮询一次命令是白跑一趟。
                {
                    let handle_file = handle.clone();
                    rc_svc.set_file_notify(std::sync::Arc::new(move |json: &str| {
                        match serde_json::from_str::<serde_json::Value>(json) {
                            Ok(v) => {
                                let _ = handle_file.emit("rc-file-state", v);
                            }
                            Err(e) => log::warn!("[RC] 文件状态事件载荷不合法：{e}"),
                        }
                    }));
                }
                // 发起端 outbox 有新帧 → 唤醒前端来 rc_drain_frames（原始二进制批量拉帧）。
                // 事件不带 payload：帧数据走 invoke 返回的 ArrayBuffer，事件只是「门铃」。
                {
                    let handle_frame = handle.clone();
                    rc_svc.set_frame_notify(std::sync::Arc::new(move || {
                        let _ = handle_frame.emit("rc-frame-ready", ());
                    }));
                }
                app.manage(rc_svc);
            }
            commands::boot(&handle);
            commands::rc_boot(&handle);
            log::info!("[BOOT] 7 boot 已派发");

            // 显示窗口
            // U5：开机自启带 /silent 标志时静默驻留托盘，不弹窗抢焦点
            // （与设置面板"开机后自动在后台运行，托盘图标常驻"的承诺一致）
            // 🔴 硬编诊断 P2/P3：setup 末尾与 setup 返回后 8s。
            //   P2 —— 数据库 / SyncService / 托盘 / 快捷键都已就绪；
            //   P3 —— webview（Chromium 自带 GPU 栈）与各异步子系统此时才真正就绪，
            //         这正是 P2 到选型之间唯一还没被采样覆盖的一段。
            // 若 P2 ✓ / P3 ✗ ⇒ 凶手在「setup 之后」；若 P1 ✓ / P2 ✗ ⇒ 在业务子系统里。
            #[cfg(target_os = "windows")]
            {
                crate::rc::mft_diag::probe_nvenc_snapshot("P2 setup 末尾·显示窗口前");
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    crate::rc::mft_diag::probe_nvenc_snapshot("P3 setup 后 8s·webview 就绪");
                });
            }

            log::info!("[BOOT] 8 准备显示窗口");
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
            commands::mark_search_recall,
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
            commands::read_clipboard_text,
            commands::copy_image_only,
            commands::copy_files,
            commands::save_foreground,
            commands::paste_send_tab,
            // 剪贴板栈浮标（HUD）：栈是无窗口热键操作，反馈必须另开小窗承载
            stack_hud::stack_hud_update,
            stack_hud::stack_hud_show,
            stack_hud::stack_hud_hide,
            stack_hud::stack_hud_state,
            stack_hud::stack_hud_adjust,
            // 待办灵动岛：屏幕顶部居中的无焦点小窗（P0 探针骨架）
            todo_island::todo_island_show,
            todo_island::todo_island_hide,
            todo_island::todo_island_state,
            todo_island::todo_island_page_ready,
            todo_island::todo_island_update,
            todo_tasks::todo_island_tasks,
            todo_tasks::todo_island_toggle_task,
            todo_island_stage::todo_island_set_stage,
            commands::note_append_daily_task,
            todo_island_probe::todo_island_probe,
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
            // 附近设备配对（免交换密钥）
            commands::get_lan_nearby,
            commands::get_lan_running,
            commands::get_lan_paired,
            commands::lan_poke_hello,
            commands::lan_forget_device,
            commands::lan_set_device_paused,
            commands::get_lan_pair_state,
            commands::lan_pair_start,
            commands::lan_pair_confirm,
            commands::lan_pair_cancel,
            // 知识库同步（M6）
            commands::kb_sync_identity,
            commands::kb_sync_invite_create,
            commands::kb_sync_invite_preview,
            commands::kb_sync_pair,
            commands::kb_sync_devices,
            commands::kb_sync_join_approve,
            commands::kb_sync_join_deny,
            commands::kb_sync_forget,
            commands::kb_sync_set_paused,
            commands::kb_sync_now,
            commands::kb_sync_refresh,
            commands::get_kb_sync_status,
            commands::toggle_kb_sync,
            // 远程电脑（R0 门禁 + R1 壳）
            commands::rc_status,
            commands::rc_identity,
            commands::rc_targets,
            commands::rc_probe_targets,
            commands::rc_sync_offers,
            commands::kb_sync_allow_from_rc,
            commands::kb_sync_deny_from_rc,
            commands::rc_invite_create,
            commands::rc_invite_preview,
            commands::rc_pair,
            commands::rc_forget,
            commands::rc_device_rename,
            commands::rc_device_tags_set,
            commands::rc_device_remark_set,
            commands::rc_join_approve,
            commands::rc_join_deny,
            commands::rc_set_enabled,
            commands::rc_start_channel,
            commands::rc_set_capability,
            commands::rc_set_device_allowed,
            commands::rc_request_session,
            commands::rc_uno_generate,
            commands::rc_uno_revoke,
            commands::rc_uno_pass_enable,
            commands::rc_uno_pass_disable,
            commands::rc_uno_pass_set_wan,
            commands::rc_cancel_request,
            commands::rc_clear_outbound_error,
            commands::rc_approve_inbound,
            commands::rc_deny_inbound,
            commands::rc_device_trust_set,
            commands::rc_device_auto_accept_set,
            commands::rc_end_session,
            commands::rc_require_active,
            commands::rc_latest_frame,
            commands::rc_drain_frames,
            commands::rc_file_send,
            commands::rc_file_pull,
            commands::rc_file_respond,
            commands::rc_file_cancel,
            commands::rc_file_clear_finished,
            commands::rc_file_snapshot,
            commands::rc_file_default_dir,
            commands::rc_drain_audio,
            commands::rc_audio_toggle,
            commands::rc_set_audio_local_mute,
            commands::rc_host_mute_set,
            commands::rc_send_input,
            commands::rc_open_workbench,
            commands::rc_push_clipboard,
            commands::rc_window_minimize,
            commands::rc_window_toggle_maximize,
            commands::rc_window_close,
            commands::rc_fit_window_to_video,
            commands::rc_set_quality,
            commands::rc_set_bitrate_pct,
            commands::rc_encode_caps,
            commands::rc_list_monitors,
            commands::rc_set_capture_scope,
            commands::rc_pull_clipboard,
            commands::rc_session_history,
            commands::rc_history_clear,
            // 局域网配对（A3）：附近设备 + 6 位数字核对
            commands::rc_nearby_status,
            commands::rc_nearby_pair,
            commands::rc_nearby_confirm,
            commands::rc_nearby_cancel,
            commands::mcp_get_status,
            commands::mcp_get_write_switches,
            commands::mcp_get_library_blurb,
            commands::mcp_set_library_blurb,
            commands::mcp_set_write_switch,
            commands::mcp_get_write_scope,
            commands::mcp_set_write_scope,
            commands::mcp_ai_folders,
            commands::mcp_undo_ai_folder,
            commands::mcp_audit_list,
            commands::mcp_audit_clients,
            commands::mcp_audit_clear,
            commands::mcp_get_token,
            commands::mcp_regenerate_token,
            commands::mcp_set_enabled,
            commands::mcp_set_port,
            commands::mcp_set_https_enabled,
            commands::mcp_set_lan_enabled,
            commands::mcp_tls_ca_status,
            commands::mcp_tls_install_ca,
            commands::mcp_tls_remove_ca,
            commands::mcp_client_probe,
            commands::mcp_client_connect,
            commands::mcp_client_disconnect,
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
            commands::note_toggle_pin,
            commands::note_list_deleted,
            commands::note_count_deleted,
            commands::note_restore_deleted,
            commands::note_purge,
            commands::note_purge_all,
            commands::note_count_expired,
            commands::note_get,
            commands::note_list,
            commands::note_by_history,
            commands::note_history_ids,
            commands::note_search,
            commands::note_search_relevant,
            commands::note_set_tags,
            commands::note_count,
            commands::kb_health,
            commands::history_day_meta,
            commands::history_day_excerpts,
            commands::history_recent_excerpts,
            commands::history_recent_meta,
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
            commands::note_revision_pin,
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
            commands::note_backlinks,
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
            commands::mark_editor_ready,
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

/// 窗口状态位的守卫：这套断言是防「有人顺手把 DECORATIONS 加回来」的。
/// 症状不像崩溃那样显眼——只表现为工作台窗口凭空多一条原生标题栏、按钮变两排，
/// 靠肉眼 code review 很容易放过，所以钉成单测。
#[cfg(all(test, desktop))]
mod window_state_flags_tests {
    use super::window_state_flags;
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn decorations_must_not_be_persisted() {
        assert!(
            !window_state_flags().contains(StateFlags::DECORATIONS),
            "DECORATIONS 又被加回状态位了：装饰由代码决定，持久化它会复现两排标题栏 \
             （真机实测外框高 971 → 1010、纵向差 10 → 47）。详见 window_state_flags() 注释"
        );
    }

    #[test]
    fn other_state_flags_are_kept() {
        let flags = window_state_flags();
        for flag in [
            StateFlags::POSITION,
            StateFlags::SIZE,
            StateFlags::MAXIMIZED,
            StateFlags::VISIBLE,
        ] {
            assert!(flags.contains(flag), "状态位 {flag:?} 被误删，窗口偏好会丢失");
        }
    }
}
