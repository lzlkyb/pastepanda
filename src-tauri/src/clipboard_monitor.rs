use crate::content_classifier::ContentClassifier;
use crate::data_store::{compute_pinyin_initials, DataStore, HistoryItem};
use arboard::Clipboard;
use md5::{Digest, Md5};
use regex::Regex;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, LazyLock, Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::collections::VecDeque;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::sync::Condvar;

// ─── 自动标签写入：channel + 单 worker（B-01 修复） ───────────────────────
// 旧方案：4 并发线程 + 超限静默丢弃 → 突发时标签丢失无感知。
// 新方案：unbounded channel 排队 + 单 worker 顺序消化，突发不丢、DB 无并发争用。

/// 一次自动标签写入任务
struct TagJob {
    app: AppHandle,
    history_id: String,
    labels: Vec<String>,
}

/// 获取标签写入 channel 发送端（首次调用启动 worker 线程）
fn tag_tx() -> &'static mpsc::Sender<TagJob> {
    static TX: OnceLock<mpsc::Sender<TagJob>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<TagJob>();
        std::thread::Builder::new()
            .name("auto-tag-writer".into())
            .spawn(move || {
                for job in rx {
                    let Some(store) = job.app.try_state::<DataStore>() else {
                        continue;
                    };
                    match store.resolve_auto_tag_ids(&job.labels) {
                        Ok(tag_ids) if !tag_ids.is_empty() => {
                            if let Err(e) = store.add_history_tags(&job.history_id, &tag_ids) {
                                log::warn!("[ContentClassifier] 写入自动标签失败: {}", e);
                            } else {
                                log::info!(
                                    "[ContentClassifier] 自动分类: {:?} → {}",
                                    job.labels,
                                    job.history_id
                                );
                                let _ = job.app.emit(
                                    "tags-updated",
                                    serde_json::json!({
                                        "history_id": job.history_id,
                                        "tag_ids": tag_ids,
                                    }),
                                );
                            }
                        }
                        Ok(_) => {} // 无匹配标签，正常跳过
                        Err(e) => {
                            log::warn!("[ContentClassifier] 解析自动标签失败: {}", e);
                        }
                    }
                }
                log::info!("[ContentClassifier] auto-tag-writer 通道关闭，worker 退出");
            })
            .expect("failed to spawn auto-tag-writer thread");
        tx
    })
}

/// 剪贴板变化事件，推送到前端
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardChanged {
    pub item: HistoryItem,
}

/// 粘贴抑制状态 — 防止自身粘贴被记录
pub struct PasteSuppress {
    pub until: Mutex<Option<Instant>>,
    /// 预期粘贴内容的 hash，即使时间抑制过期，匹配 hash 也跳过
    pub expected_hash: Mutex<Option<String>>,
}

impl PasteSuppress {
    pub fn new() -> Self {
        Self {
            until: Mutex::new(None),
            expected_hash: Mutex::new(None),
        }
    }

    pub fn set(&self, duration: Duration) {
        if let Ok(mut guard) = self.until.lock() {
            *guard = Some(Instant::now() + duration);
        }
    }

    pub fn set_with_hash(&self, duration: Duration, hash: String) {
        if let Ok(mut guard) = self.until.lock() {
            *guard = Some(Instant::now() + duration);
        }
        if let Ok(mut guard) = self.expected_hash.lock() {
            *guard = Some(hash);
        }
    }

    /// 时间抑制兜底检查：是否仍处于自粘贴抑制窗口内。
    /// 作为 hash 主检查的兜底——覆盖 hash 已被清除的轮询竞态，以及无 hash 的粘贴路径（如文件）。
    pub fn is_suppressed(&self) -> bool {
        if let Ok(guard) = self.until.lock() {
            guard.map_or(false, |t| Instant::now() < t)
        } else {
            false
        }
    }

    /// 检查内容 hash 是否匹配预期粘贴内容（即使时间抑制已过期也跳过）
    pub fn is_hash_suppressed(&self, hash: &str) -> bool {
        if let Ok(guard) = self.expected_hash.lock() {
            guard.as_ref().map_or(false, |h| h == hash)
        } else {
            false
        }
    }

    /// U57：是否处于"hash 设防"模式（已知预期粘贴内容）。
    /// hash 模式下监听端只应按 hash 匹配跳过，不得用时间窗口无差别吞掉
    /// 粘贴后 3 秒内用户的新复制；时间兜底仅适用于无 hash 的粘贴路径。
    pub fn has_expected_hash(&self) -> bool {
        if let Ok(guard) = self.expected_hash.lock() {
            guard.is_some()
        } else {
            false
        }
    }

    pub fn clear_hash(&self) {
        if let Ok(mut guard) = self.expected_hash.lock() {
            *guard = None;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 事件驱动监听（Windows）
//
// 架构：消息-only 窗口注册 AddClipboardFormatListener，WM_CLIPBOARDUPDATE
// 事件驱动读取，彻底消除 400ms 轮询的采样盲区（快速连续复制时中间内容
// 落在两次采样之间而永久丢失）。
//
// 两级分离：
//   Stage 1（消息线程）：50ms 尾部防抖合并单次复制的多次通知 → 读剪贴板
//     （带重试，覆盖延迟渲染/打开竞争）→ MD5 去重 + 自粘贴抑制检查 →
//     捕获前台标题+进程路径（轻量，不做图标提取）→ 入有界队列。
//     全程 ~1-5ms，确保消息循环不被阻塞、每次复制都被及时读取。
//   Stage 2（工作线程）：图标提取、排除名单/敏感内容过滤、拼音、智能合并、
//     入库、前端推送、局域网同步。重处理延迟不再占用捕获窗口。
//
// 兜底：1000ms 定时器按 GetClipboardSequenceNumber 补读，覆盖极端情况下
// 丢失的通知与延迟渲染失败重试。
// ═══════════════════════════════════════════════════════════════

/// 捕获队列上限：极端突发（>32 条未处理）时丢弃最旧，保证最新复制的时效性
#[cfg(target_os = "windows")]
const CAPTURE_QUEUE_CAP: usize = 32;

/// 防抖定时器 ID：合并单次复制触发的多次 WM_CLIPBOARDUPDATE 通知
#[cfg(target_os = "windows")]
const TIMER_DEBOUNCE: usize = 1;

/// 兜底定时器 ID：按剪贴板序列号补读（防丢事件 / 延迟渲染重试）
#[cfg(target_os = "windows")]
const TIMER_FALLBACK: usize = 2;

/// Stage 1 捕获结果 — 内容与来源信息已就绪，等待工作线程做重处理
#[cfg(target_os = "windows")]
enum CapturedItem {
    Text {
        text: String,
        hash: String,
        title: String,
        exe_path: Option<PathBuf>,
        time: String,
    },
    Image {
        rgba: Vec<u8>,
        width: usize,
        height: usize,
        hash: String,
        title: String,
        exe_path: Option<PathBuf>,
        time: String,
    },
    Files {
        paths: Vec<String>,
        title: String,
        exe_path: Option<PathBuf>,
        time: String,
    },
    /// 图文混排富文本（CF_HTML 且含内嵌 <img>）——采集时机上晚于 Text 分支判断，
    /// 只在片段确实带图片时才走这条路径，避免把"纯文本也带 CF_HTML"的普通复制误判
    Rich {
        /// 已把 <img src> 改写为本地图片库路径后的 HTML 片段
        html_fragment: String,
        /// 同一剪贴板会话里的纯文本表示（源应用通常会同时写入 CF_UNICODETEXT），
        /// 阶段1 直接复用，不做 HTML→纯文本转换
        plain_text: String,
        hash: String,
        title: String,
        exe_path: Option<PathBuf>,
        time: String,
    },
}

/// 有界捕获队列（满则丢最旧）+ Condvar 唤醒工作线程
#[cfg(target_os = "windows")]
struct CaptureQueue {
    inner: Mutex<VecDeque<CapturedItem>>,
    condvar: Condvar,
}

#[cfg(target_os = "windows")]
impl CaptureQueue {
    fn new() -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
            condvar: Condvar::new(),
        }
    }

    /// 生产者侧（消息线程）：满则丢最旧并告警
    fn push(&self, item: CapturedItem) {
        if let Ok(mut queue) = self.inner.lock() {
            if queue.len() >= CAPTURE_QUEUE_CAP {
                let _ = queue.pop_front();
                log::warn!(
                    "[ClipboardMonitor] 捕获队列已满 ({})，丢弃最旧条目",
                    CAPTURE_QUEUE_CAP
                );
            }
            queue.push_back(item);
            self.condvar.notify_one();
        }
    }

    /// 消费者侧（工作线程）：阻塞弹出；队列空且 running=false 时返回 None 退出。
    /// 先排空队列再检查退出，确保 stop 前已捕获的条目仍被处理。
    fn pop(&self, running: &AtomicBool) -> Option<CapturedItem> {
        let mut queue = self.inner.lock().ok()?;
        loop {
            if let Some(item) = queue.pop_front() {
                return Some(item);
            }
            if !running.load(Ordering::SeqCst) {
                return None;
            }
            // 超时唤醒：周期性重查 running 标志（stop 后 200ms 内退出）
            match self.condvar.wait_timeout(queue, Duration::from_millis(200)) {
                Ok((guard, _)) => queue = guard,
                Err(_) => return None,
            }
        }
    }
}

/// MD5 hex 工具（两条监听路径共用）
fn md5_hex(data: &[u8]) -> String {
    format!("{:x}", Md5::new().chain_update(data).finalize())
}

/// 读取 bool 配置缓存（锁中毒时回退 false）
fn read_bool_cache(cache: &std::sync::RwLock<bool>) -> bool {
    cache.read().map(|g| *g).unwrap_or(false)
}

/// 修复 U36：判断文本是否应按敏感内容跳过记录（两条监听路径共用）
fn should_skip_sensitive_with(skip_cache: &std::sync::RwLock<bool>, text: &str) -> bool {
    if !read_bool_cache(skip_cache) {
        return false;
    }
    ContentClassifier::new().is_secret(text)
}

/// 修复 U36：判断来源应用是否在排除名单内（两条监听路径共用）
fn is_excluded_app_with(
    excluded_cache: &std::sync::RwLock<Vec<String>>,
    source_title: &str,
) -> bool {
    let excluded = match excluded_cache.read() {
        Ok(g) => g.clone(),
        Err(_) => return false,
    };
    if excluded.is_empty() || source_title.is_empty() {
        return false;
    }
    let lower = source_title.to_lowercase();
    excluded.iter().any(|app| {
        let app = app.trim().to_lowercase();
        !app.is_empty() && lower.contains(&app)
    })
}

/// 剪贴板监听器 — Windows 事件驱动（WM_CLIPBOARDUPDATE），其他平台轮询兜底
pub struct ClipboardMonitor {
    running: Arc<AtomicBool>,
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    /// 缓存 auto_strip 配置值，避免每次读取都锁定数据库读取配置
    cached_auto_strip: Arc<std::sync::RwLock<bool>>,
    /// 修复 U36：缓存"不记录匹配密钥模式的内容"开关
    cached_skip_sensitive: Arc<std::sync::RwLock<bool>>,
    /// 修复 U36：缓存应用排除名单（来源应用名，命中则不记录）
    cached_excluded_apps: Arc<std::sync::RwLock<Vec<String>>>,
    /// 事件驱动监听线程 ID（stop() 用于投递 WM_QUIT 唤醒阻塞的消息循环）
    #[cfg(target_os = "windows")]
    listener_thread_id: Arc<Mutex<Option<u32>>>,
}

impl ClipboardMonitor {
    pub fn new(app_handle: AppHandle, paste_suppress: Arc<PasteSuppress>) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            app_handle,
            paste_suppress,
            cached_auto_strip: Arc::new(std::sync::RwLock::new(false)),
            // 与前端 DEFAULT_CONFIG 对齐：默认关闭，由用户在设置中显式开启
            cached_skip_sensitive: Arc::new(std::sync::RwLock::new(false)),
            cached_excluded_apps: Arc::new(std::sync::RwLock::new(Vec::new())),
            #[cfg(target_os = "windows")]
            listener_thread_id: Arc::new(Mutex::new(None)),
        }
    }

    /// 更新缓存的 auto_strip 配置（由前端保存配置后调用）
    pub fn update_auto_strip_cache(&self, enabled: bool) {
        if let Ok(mut guard) = self.cached_auto_strip.write() {
            *guard = enabled;
        }
    }

    /// 读取缓存的 auto_strip 配置（无锁竞争，比每次查数据库快得多）
    #[cfg(not(target_os = "windows"))]
    fn get_auto_strip(&self) -> bool {
        read_bool_cache(&self.cached_auto_strip)
    }

    /// 修复 U36：更新敏感内容防护缓存（由前端保存配置后调用）
    pub fn update_sensitive_cache(&self, skip_sensitive: bool, excluded_apps: Vec<String>) {
        if let Ok(mut guard) = self.cached_skip_sensitive.write() {
            *guard = skip_sensitive;
        }
        if let Ok(mut guard) = self.cached_excluded_apps.write() {
            *guard = excluded_apps;
        }
    }

    /// 修复 U36：判断文本是否应按敏感内容跳过记录（仅非 Windows 轮询路径使用）
    #[cfg(not(target_os = "windows"))]
    fn should_skip_sensitive(&self, text: &str) -> bool {
        should_skip_sensitive_with(&self.cached_skip_sensitive, text)
    }

    /// 修复 U36：判断来源应用是否在排除名单内（仅非 Windows 轮询路径使用）
    #[cfg(not(target_os = "windows"))]
    fn is_excluded_app(&self, source_title: &str) -> bool {
        is_excluded_app_with(&self.cached_excluded_apps, source_title)
    }

    pub fn start(&self) {
        // 修复 M2：原子 CAS 替代"先判断后置位"，防止并发 toggle 同时通过检查
        // 而 spawn 出两个监听线程（各持独立 last_text_hash → 图片/文件重复入库）
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let running = self.running.clone();
        let app_handle = self.app_handle.clone();
        let paste_suppress = self.paste_suppress.clone();
        let auto_strip_cache = self.cached_auto_strip.clone();
        #[cfg(target_os = "windows")]
        let sensitive_cache = self.cached_skip_sensitive.clone();
        #[cfg(target_os = "windows")]
        let excluded_cache = self.cached_excluded_apps.clone();
        #[cfg(target_os = "windows")]
        let thread_id_slot = self.listener_thread_id.clone();

        #[cfg(target_os = "windows")]
        {
            std::thread::spawn(move || {
                run_event_listener(
                    running,
                    app_handle,
                    paste_suppress,
                    auto_strip_cache,
                    sensitive_cache,
                    excluded_cache,
                    thread_id_slot,
                );
            });
        }

        #[cfg(not(target_os = "windows"))]
        {
            std::thread::spawn(move || {
                run_polling_listener(running, app_handle, paste_suppress, auto_strip_cache);
            });
        }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);

        // 事件驱动路径：向监听线程投递 WM_QUIT，立即唤醒阻塞中的 GetMessageW
        // （工作线程靠 Condvar 200ms 超时唤醒后检测 running=false 自行退出）
        #[cfg(target_os = "windows")]
        if let Ok(slot) = self.listener_thread_id.lock() {
            if let Some(thread_id) = *slot {
                unsafe {
                    use windows::Win32::Foundation::{LPARAM, WPARAM};
                    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
                    let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
                }
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

// ═══════════════════════════════════════════════════════════════
// Windows 事件驱动实现
// ═══════════════════════════════════════════════════════════════

/// 监听线程主体：消息-only 窗口 + 剪贴板格式监听 + 防抖/兜底定时器
#[cfg(target_os = "windows")]
fn run_event_listener(
    running: Arc<AtomicBool>,
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    auto_strip_cache: Arc<std::sync::RwLock<bool>>,
    sensitive_cache: Arc<std::sync::RwLock<bool>>,
    excluded_cache: Arc<std::sync::RwLock<Vec<String>>>,
    thread_id_slot: Arc<Mutex<Option<u32>>>,
) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, GetClipboardSequenceNumber, RemoveClipboardFormatListener,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::*;

    // 消息窗口不需要自定义处理：所有消息在 GetMessageW 之后直接分发，
    // WM_CLIPBOARDUPDATE / WM_TIMER 在循环内处理，其余交给 DefWindowProcW
    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// 仅当槽位仍是本线程 ID 时清空（防止快速 toggle 时误清新线程的 ID）
    fn clear_thread_id_slot(slot: &Mutex<Option<u32>>, own_id: u32) {
        if let Ok(mut guard) = slot.lock() {
            if *guard == Some(own_id) {
                *guard = None;
            }
        }
    }

    log::info!("[ClipboardMonitor] 事件驱动监听线程启动");

    unsafe {
        // 先记录线程 ID，使 stop() 随时可以投递 WM_QUIT
        let thread_id = GetCurrentThreadId();
        if let Ok(mut slot) = thread_id_slot.lock() {
            *slot = Some(thread_id);
        }

        // Stage 2：捕获队列 + 处理工作线程
        let queue = Arc::new(CaptureQueue::new());
        {
            let queue = queue.clone();
            let running = running.clone();
            let app_handle = app_handle.clone();
            let sensitive_cache = sensitive_cache.clone();
            let excluded_cache = excluded_cache.clone();
            std::thread::spawn(move || {
                worker_loop(&queue, &running, &app_handle, &sensitive_cache, &excluded_cache);
            });
        }

        // 注册消息窗口类（类名含线程 ID：快速 toggle 时避免与旧监听线程的类冲突）
        let class_name_wide: Vec<u16> = format!("PastePandaClipMon_{}", thread_id)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let hinstance = GetModuleHandleW(None)
            .map(|h| HINSTANCE(h.0))
            .unwrap_or_default();
        let wnd_class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance,
            lpszClassName: PCWSTR(class_name_wide.as_ptr()),
            ..Default::default()
        };
        // 忽略 ERROR_CLASS_ALREADY_EXISTS：同名类已存在时直接复用即可
        RegisterClassW(&wnd_class);

        // 创建 message-only 窗口（HWND_MESSAGE：不出现在任务栏/窗口列表，不接收广播消息）
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name_wide.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            hinstance,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                // 修复 C8 同型：失败时复位 running，否则 is_running() 永远为 true、
                // start() 永远提前返回，监听永久失效（只能重启应用）
                log::error!("[ClipboardMonitor] 创建消息窗口失败: {}", e);
                running.store(false, Ordering::SeqCst);
                clear_thread_id_slot(&thread_id_slot, thread_id);
                let _ = app_handle.emit("monitor-status-changed", false);
                return;
            }
        };

        let mut clipboard = match Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[ClipboardMonitor] 无法打开剪贴板: {}", e);
                running.store(false, Ordering::SeqCst);
                clear_thread_id_slot(&thread_id_slot, thread_id);
                let _ = DestroyWindow(hwnd);
                let _ = app_handle.emit("monitor-status-changed", false);
                return;
            }
        };

        // 以当前剪贴板内容作为基准 hash（与轮询版一致：避免监听恢复后
        // 把已存在的内容重复记录一条）
        let mut last_text_hash: Option<String> = None;
        if let Ok(initial_text) = clipboard.get_text() {
            if !initial_text.is_empty() {
                let initial_text = if read_bool_cache(&auto_strip_cache) {
                    initial_text.trim().to_string()
                } else {
                    initial_text
                };
                if !initial_text.is_empty() {
                    last_text_hash = Some(md5_hex(initial_text.as_bytes()));
                }
            }
        }
        // 基准序列号：兜底定时器只在序列号变化时才补读
        let mut last_seq = GetClipboardSequenceNumber();
        // 连续读取失败计数（达到上限后放弃当前序列号，避免无限重试）
        let mut fail_streak: u32 = 0;

        if let Err(e) = AddClipboardFormatListener(hwnd) {
            log::warn!(
                "[ClipboardMonitor] AddClipboardFormatListener 失败 ({}), 将仅依赖 1s 序列号兜底定时器",
                e
            );
        }
        if SetTimer(hwnd, TIMER_FALLBACK, 1000, None) == 0 {
            log::warn!("[ClipboardMonitor] 兜底定时器创建失败");
        }

        log::info!(
            "[ClipboardMonitor] 事件驱动监听就绪 (WM_CLIPBOARDUPDATE + 50ms 防抖 + 1s 序列号兜底)"
        );

        let mut msg = MSG::default();
        // stop() 先置 running=false 再投递 WM_QUIT：
        //   - 循环内阻塞时：WM_QUIT 使 GetMessageW 返回 0 → break
        //   - 循环尚未进入时（setup 期间被 stop）：条件检查直接跳过循环
        while running.load(Ordering::SeqCst) {
            let ret = GetMessageW(&mut msg, None, 0, 0);
            // 0 = WM_QUIT；-1 = 错误（必须退出，否则 busy-loop 空转）
            if ret.0 <= 0 {
                if ret.0 == -1 {
                    log::error!("[ClipboardMonitor] GetMessageW 出错，监听线程退出");
                    running.store(false, Ordering::SeqCst);
                }
                break;
            }
            match msg.message {
                WM_CLIPBOARDUPDATE => {
                    // 尾部防抖：单次复制会触发多次通知（EmptyClipboard + N×SetClipboardData，
                    // 多格式应用还可能分批追加格式）。每次通知重置定时器，安静 50ms 后读一次，
                    // 读到的是最终完整内容；人工速度的快速连续复制（间隔 >100ms）不会被合并。
                    let _ = KillTimer(hwnd, TIMER_DEBOUNCE);
                    SetTimer(hwnd, TIMER_DEBOUNCE, 50, None);
                }
                WM_TIMER => {
                    let timer_id = msg.wParam.0;
                    if timer_id == TIMER_DEBOUNCE {
                        let _ = KillTimer(hwnd, TIMER_DEBOUNCE);
                        let ok = stage1_capture(
                            &mut clipboard,
                            &mut last_text_hash,
                            &paste_suppress,
                            &auto_strip_cache,
                            &queue,
                            &app_handle,
                        );
                        advance_seq(GetClipboardSequenceNumber(), ok, &mut last_seq, &mut fail_streak);
                    } else if timer_id == TIMER_FALLBACK {
                        // 兜底：序列号变化但未经过防抖路径（丢通知/读取失败重试）时补读
                        let seq = GetClipboardSequenceNumber();
                        if seq != last_seq {
                            let ok = stage1_capture(
                                &mut clipboard,
                                &mut last_text_hash,
                                &paste_suppress,
                                &auto_strip_cache,
                                &queue,
                                &app_handle,
                            );
                            advance_seq(seq, ok, &mut last_seq, &mut fail_streak);
                        }
                    }
                }
                _ => {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }

        // 清理（顺序：定时器 → 监听注册 → 窗口 → 类）
        let _ = KillTimer(hwnd, TIMER_DEBOUNCE);
        let _ = KillTimer(hwnd, TIMER_FALLBACK);
        let _ = RemoveClipboardFormatListener(hwnd);
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(PCWSTR(class_name_wide.as_ptr()), hinstance);
        clear_thread_id_slot(&thread_id_slot, thread_id);
        // 注意：正常退出不再写 running —— stop() 已置 false；
        // 若此处再写，快速 toggle 时会覆盖新监听线程刚置的 true
        log::info!("[ClipboardMonitor] 监听线程退出");
    }
}

/// 序列号推进策略：读取成功才推进；连续失败 3 次（如剪贴板只剩不可读格式）
/// 也推进，避免兜底定时器对同一序列号无限重试
#[cfg(target_os = "windows")]
fn advance_seq(seq: u32, ok: bool, last_seq: &mut u32, fail_streak: &mut u32) {
    if ok {
        *last_seq = seq;
        *fail_streak = 0;
    } else {
        *fail_streak += 1;
        if *fail_streak >= 3 {
            log::warn!("[ClipboardMonitor] 连续 3 次读取失败，放弃当前序列号");
            *last_seq = seq;
            *fail_streak = 0;
        }
    }
}

/// Stage 1（消息线程）：读剪贴板 + 去重 + 自粘贴抑制 + 捕获来源 → 入队。
/// 刻意保持轻量（无图标提取 / 无数据库 / 无正则），确保快速连续复制时
/// 消息循环不被阻塞——这是消除采样盲区的关键。
/// 返回读取是否成功（用于兜底序列号推进决策）。
#[cfg(target_os = "windows")]
fn stage1_capture(
    clipboard: &mut Clipboard,
    last_text_hash: &mut Option<String>,
    paste_suppress: &PasteSuppress,
    auto_strip_cache: &std::sync::RwLock<bool>,
    queue: &CaptureQueue,
    app_handle: &AppHandle,
) -> bool {
    // ── 图文混排富文本（CF_HTML 且同时含图与文）──
    // 必须放在纯文本分支之前判断：否则下面的文本分支会先把它当普通文本采集掉。
    //
    // 两道门槛缺一不可，分别拦两类误判：
    // 1. has_image：绝大多数复制（哪怕只选中一个词）源应用也会顺手写 CF_HTML，
    //    不拦会把普通文本全误判成富文本；
    // 2. has_text：企业微信/浏览器复制纯图片时也会写 CF_HTML，内容就是单个 <img>，
    //    不拦会把纯图片全误判成图文（实测踩过这个）。
    if let Some(fragment) = get_clipboard_html() {
        if html_fragment_has_image(&fragment) && html_fragment_has_text(&fragment) {
            let app_dir = app_handle.path().app_data_dir().unwrap_or_default();
            let images_dir = app_dir.join("images");
            let (rewritten, _saved_images) = localize_html_images(&fragment, &images_dir);

            // 同一剪贴板会话里通常还有 CF_UNICODETEXT，优先直接复用作为纯文本表示；
            // 少数应用（如“仅复制带标题的图片”场景）可能不写这个格式，
            // 若为空则用片段自身去标签后的文字作为保底，避免卡片标题空白、搜索也搜不到
            let mut plain_text = clipboard.get_text().unwrap_or_default();
            if plain_text.trim().is_empty() {
                plain_text = html_fragment_to_plain_text_fallback(&rewritten);
            }

            let hash = md5_hex(rewritten.as_bytes());

            if paste_suppress.is_hash_suppressed(&hash) {
                log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (hash匹配·富文本)");
                paste_suppress.clear_hash();
                *last_text_hash = Some(hash);
                return true;
            }
            if paste_suppress.has_expected_hash() {
                if !paste_suppress.is_suppressed() {
                    paste_suppress.clear_hash();
                }
            } else if paste_suppress.is_suppressed() {
                log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (无hash路径·时间抑制窗口内·富文本)");
                *last_text_hash = Some(hash);
                return true;
            }

            if Some(&hash) != last_text_hash.as_ref() {
                *last_text_hash = Some(hash.clone());

                let (title, exe_path) = capture_foreground_source(app_handle);
                queue.push(CapturedItem::Rich {
                    html_fragment: rewritten,
                    plain_text,
                    hash,
                    title,
                    exe_path,
                    time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                });
            }
            return true;
        }
    }

    // ── 文本 ──
    // 带重试读取：延迟渲染 (CF_OWNERDELAYDISPLAY) / 剪贴板打开竞争可能瞬时失败
    let mut text_read_ok = false;
    let mut text_value: Option<String> = None;
    let mut last_err: Option<arboard::Error> = None;
    for attempt in 0..3u32 {
        match clipboard.get_text() {
            Ok(t) => {
                text_read_ok = true;
                text_value = Some(t);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
    }
    if !text_read_ok {
        log::debug!("[ClipboardMonitor] 文本读取失败: {:?}", last_err);
    }

    if let Some(text) = text_value {
        if !text.is_empty() {
            // 自动去除空白（使用缓存的配置，避免锁数据库）
            let text = if read_bool_cache(auto_strip_cache) {
                text.trim().to_string()
            } else {
                text
            };

            if text.is_empty() {
                *last_text_hash = None;
                return true;
            }

            let hash = md5_hex(text.as_bytes());

            // 自粘贴抑制（与轮询版一致）：hash 匹配优先跳过；
            // 时间窗口仅作无 hash 路径兜底（U57）
            if paste_suppress.is_hash_suppressed(&hash) {
                log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (hash匹配)");
                paste_suppress.clear_hash();
                *last_text_hash = Some(hash);
                return true;
            }
            if paste_suppress.has_expected_hash() {
                if !paste_suppress.is_suppressed() {
                    paste_suppress.clear_hash();
                }
            } else if paste_suppress.is_suppressed() {
                log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (无hash路径·时间抑制窗口内)");
                *last_text_hash = Some(hash);
                return true;
            }

            if Some(&hash) == last_text_hash.as_ref() {
                return true; // 内容未变化
            }
            *last_text_hash = Some(hash.clone());

            let (title, exe_path) = capture_foreground_source(app_handle);
            queue.push(CapturedItem::Text {
                text,
                hash,
                title,
                exe_path,
                time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            });
            return true;
        }
    }

    // ── 图片 ──（文本为空或读取失败时探测）
    if let Ok(img) = clipboard.get_image() {
        if img.width > 0 && img.height > 0 {
            // 图片大小限制：超过 50MB（RGBA bytes）则跳过
            const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
            if img.bytes.len() > MAX_IMAGE_BYTES {
                log::warn!(
                    "[ClipboardMonitor] 图片过大 ({} bytes)，跳过记录",
                    img.bytes.len()
                );
                *last_text_hash = None;
                return true;
            }

            let img_hash = md5_hex(&img.bytes);

            if paste_suppress.is_hash_suppressed(&img_hash) {
                log::info!("[ClipboardMonitor] 跳过自身粘贴图片 (hash匹配)");
                paste_suppress.clear_hash();
                *last_text_hash = Some(img_hash);
                return true;
            }
            if paste_suppress.has_expected_hash() {
                if !paste_suppress.is_suppressed() {
                    paste_suppress.clear_hash();
                }
            } else if paste_suppress.is_suppressed() {
                log::info!("[ClipboardMonitor] 跳过自身粘贴图片 (无hash路径·时间抑制窗口内)");
                *last_text_hash = Some(img_hash);
                return true;
            }

            if Some(&img_hash) == last_text_hash.as_ref() {
                return true;
            }
            *last_text_hash = Some(img_hash.clone());

            let (title, exe_path) = capture_foreground_source(app_handle);
            queue.push(CapturedItem::Image {
                rgba: img.bytes.into_owned(),
                width: img.width,
                height: img.height,
                hash: img_hash,
                title,
                exe_path,
                time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            });
            return true;
        }
    }

    // ── 文件列表 (CF_HDROP) ──
    if let Some(files) = get_clipboard_files() {
        let files_hash = files.join("|");
        let hash = md5_hex(files_hash.as_bytes());
        if Some(&hash) != last_text_hash.as_ref() {
            *last_text_hash = Some(hash);
            let (title, exe_path) = capture_foreground_source(app_handle);
            queue.push(CapturedItem::Files {
                paths: files,
                title,
                exe_path,
                time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            });
        }
        return true;
    }

    // 无可读内容：文本读取成功（剪贴板确实为空/仅含不支持格式）记为成功；
    // 文本读取失败则返回 false，由兜底定时器重试
    *last_text_hash = None;
    text_read_ok
}

/// 捕获前台窗口标题 + 进程路径（轻量：不含图标提取，图标延迟到工作线程）
#[cfg(target_os = "windows")]
fn capture_foreground_source(app_handle: &AppHandle) -> (String, Option<PathBuf>) {
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return (String::new(), None);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return (String::new(), None);
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..len as usize]);

        let exe_path = app_handle
            .try_state::<crate::icon_extractor::IconCache>()
            .and_then(|cache| cache.get_process_path(hwnd));

        (title, exe_path)
    }
}

/// Stage 2（工作线程）：重处理——图标提取、敏感过滤、拼音、智能合并、
/// 入库、前端推送、局域网同步。与消息循环解耦，处理延迟不再占用捕获窗口。
#[cfg(target_os = "windows")]
fn worker_loop(
    queue: &CaptureQueue,
    running: &AtomicBool,
    app_handle: &AppHandle,
    sensitive_cache: &std::sync::RwLock<bool>,
    excluded_cache: &std::sync::RwLock<Vec<String>>,
) {
    log::info!("[ClipboardMonitor] 处理工作线程启动");
    while let Some(item) = queue.pop(running) {
        match item {
            CapturedItem::Text {
                text,
                hash,
                title,
                exe_path,
                time,
            } => process_text(
                app_handle,
                sensitive_cache,
                excluded_cache,
                text,
                hash,
                title,
                exe_path,
                time,
            ),
            CapturedItem::Image {
                rgba,
                width,
                height,
                hash,
                title,
                exe_path,
                time,
            } => process_image(app_handle, rgba, width, height, hash, title, exe_path, time),
            CapturedItem::Files {
                paths,
                title,
                exe_path,
                time,
            } => process_files(app_handle, paths, title, exe_path, time),
            CapturedItem::Rich {
                html_fragment,
                plain_text,
                hash,
                title,
                exe_path,
                time,
            } => process_rich(
                app_handle,
                sensitive_cache,
                excluded_cache,
                html_fragment,
                plain_text,
                hash,
                title,
                exe_path,
                time,
            ),
        }
    }
    log::info!("[ClipboardMonitor] 处理工作线程退出");
}

/// 提取来源图标（工作线程用：按捕获阶段保存的 exe 路径提取，
/// 首次 ~50ms、缓存命中 <1ms，不阻塞捕获）
#[cfg(target_os = "windows")]
fn extract_source_icon(app_handle: &AppHandle, exe_path: &Option<PathBuf>) -> Option<String> {
    exe_path.as_ref().and_then(|p| {
        app_handle
            .try_state::<crate::icon_extractor::IconCache>()
            .and_then(|cache| cache.extract_icon_by_exe_path(p))
    })
}

/// 处理捕获的文本条目（逻辑与轮询版一致：U36 过滤 → 智能合并 → 入库 → 自动标签 → 推送 → LAN）
#[cfg(target_os = "windows")]
fn process_text(
    app_handle: &AppHandle,
    sensitive_cache: &std::sync::RwLock<bool>,
    excluded_cache: &std::sync::RwLock<Vec<String>>,
    text: String,
    hash: String,
    source_title: String,
    exe_path: Option<PathBuf>,
    now_str: String,
) {
    // 修复 U36：敏感内容防护 —— 命中应用排除名单或密钥模式时不记录
    // （在入库/合并/推送/局域网同步之前拦截，确保敏感内容不落盘、不外传）
    if is_excluded_app_with(excluded_cache, &source_title) {
        log::info!(
            "[ClipboardMonitor] 跳过敏感内容：来源应用 \"{}\" 在排除名单内",
            source_title
        );
        return;
    }
    if should_skip_sensitive_with(sensitive_cache, &text) {
        log::info!("[ClipboardMonitor] 跳过敏感内容：匹配密钥/凭证模式，不记录");
        return;
    }

    let source_icon = extract_source_icon(app_handle, &exe_path);

    // 计算拼音首字母
    let pinyin_initials = compute_pinyin_initials(&text);

    // 智能合并：检查是否已存在相同 md5 的文本记录
    let store = app_handle.try_state::<DataStore>();
    let mut existing_id: Option<String> = None;
    if let Some(ref store) = store {
        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认") {
            // 找到重复内容，只更新时间戳（不创建新记录）
            existing_id = Some(existing.id.clone());
            if let Err(e) = store.update_history_time(&existing.id, &now_str) {
                log::warn!("[ClipboardMonitor] 更新重复记录时间失败: {}", e);
            } else {
                log::info!(
                    "[ClipboardMonitor] 智能合并重复文本 (id={})",
                    existing.id
                );
            }
            // 推送更新后的 item 到前端（前端会 prepend，使旧记录移到顶部）
            // 注意：..existing 的 tags 已被 load_tags_into_items 填充，不能覆盖
            let updated_item = HistoryItem {
                time: now_str.clone(),
                source: source_title.clone(),
                source_icon: source_icon.clone(),
                group_id: existing.group_id.clone(),
                ..existing
            };
            if let Err(e) = app_handle.emit(
                "clipboard-changed",
                ClipboardChanged {
                    item: updated_item.clone(),
                },
            ) {
                log::warn!("[ClipboardMonitor] 推送合并事件失败: {}", e);
            }
            // LAN 同步
            if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
                lan_sync.send(&text);
            }
        }
    }

    // 如果没有找到重复记录，则正常创建新记录
    if existing_id.is_none() {
        // 统一分类：一次 classify() 同时派生 content_type 和自动标签
        let labels = ContentClassifier::new().classify(&text);
        let item = HistoryItem {
            id: Uuid::new_v4().to_string(),
            text: text.clone(),
            time: now_str,
            item_type: "text".to_string(),
            content: String::new(),
            pinned: false,
            source: source_title.clone(),
            workspace: "默认".to_string(),
            md5: Some(hash),
            pinyin_initials: Some(pinyin_initials),
            group_id: None,
            source_icon: source_icon.clone(),
            content_type: Some(ContentClassifier::content_type_from_labels(&labels).to_string()),
            tags: Vec::new(),
        };

        // 插入数据库
        if let Some(ref store) = store {
            if let Err(e) = store.insert_history(&item) {
                log::error!("[ClipboardMonitor] 插入失败: {}", e);
            }
        }

        // 自动标签写入：发送到 channel，单 worker 顺序消化（突发不丢）
        if let Err(e) = tag_tx().send(TagJob {
            app: app_handle.clone(),
            history_id: item.id.clone(),
            labels: labels.clone(),
        }) {
            log::warn!("[ContentClassifier] 标签写入通道已关闭: {}", e);
        }

        // 推送事件到前端
        if let Err(e) = app_handle.emit(
            "clipboard-changed",
            ClipboardChanged { item: item.clone() },
        ) {
            log::warn!("[ClipboardMonitor] 推送文本事件失败: {}", e);
        }

        // LAN 同步：发送文本到局域网
        if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
            lan_sync.send(&text);
        }
    }
}

/// 处理捕获的图片条目（逻辑与轮询版一致：保存 PNG → 入库 → 推送 → LAN）
#[cfg(target_os = "windows")]
fn process_image(
    app_handle: &AppHandle,
    rgba: Vec<u8>,
    width: usize,
    height: usize,
    img_hash: String,
    source_title: String,
    exe_path: Option<PathBuf>,
    now_str: String,
) {
    // 保存图片到磁盘
    let app_dir = app_handle.path().app_data_dir().unwrap_or_default();
    let img_dir = app_dir.join("images");
    if let Err(e) = std::fs::create_dir_all(&img_dir) {
        log::error!(
            "[ClipboardMonitor] 创建图片目录失败 (跳过此次图片保存): {}",
            e
        );
        return;
    }
    let img_path = img_dir.join(format!("{}.png", img_hash));

    if !img_path.exists() {
        // 将 RGBA 数据转为 PNG 并保存
        let img_buf = image::RgbaImage::from_raw(width as u32, height as u32, rgba);
        let Some(img_buf) = img_buf else {
            log::error!(
                "[ClipboardMonitor] 图片 RGBA 数据与尺寸不匹配 ({}x{})，跳过本次图片",
                width,
                height
            );
            return;
        };
        let dyn_img = image::DynamicImage::ImageRgba8(img_buf);
        // 缩放到最大 1080px（长边限制）
        let max_dim = 1080u32;
        let dyn_img = if width as u32 > max_dim || height as u32 > max_dim {
            let ratio = max_dim as f64 / width.max(height) as f64;
            let new_w = (width as f64 * ratio) as u32;
            let new_h = (height as f64 * ratio) as u32;
            dyn_img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3)
        } else {
            dyn_img
        };
        // B-05：先写临时文件再原子 rename，防止崩溃/双 timer 触发时留下半文件。
        // 注意：临时文件扩展名为 .png.tmp，save() 按扩展名推断格式会因 .tmp 无法识别而
        // 必然失败（导致图片永不入库），故必须用 save_with_format 显式指定 PNG 编码。
        let tmp_path = img_path.with_extension("png.tmp");
        if let Err(e) = dyn_img.save_with_format(&tmp_path, image::ImageFormat::Png) {
            // 修复 M4：保存失败即中止，不再插入指向不存在文件的历史记录
            log::error!(
                "[ClipboardMonitor] 保存图片失败 ({}): {}，跳过本条记录",
                tmp_path.display(),
                e
            );
            return;
        }
        if let Err(e) = std::fs::rename(&tmp_path, &img_path) {
            log::error!(
                "[ClipboardMonitor] 重命名临时图片失败 ({} → {}): {}",
                tmp_path.display(),
                img_path.display(),
                e
            );
            let _ = std::fs::remove_file(&tmp_path);
            return;
        }
    }

    let source_icon = extract_source_icon(app_handle, &exe_path);

    let item = HistoryItem {
        id: Uuid::new_v4().to_string(),
        text: format!("[图片] {}x{}", width, height),
        time: now_str,
        item_type: "image".to_string(),
        content: img_path.to_string_lossy().to_string(),
        pinned: false,
        source: source_title,
        workspace: "默认".to_string(),
        md5: Some(img_hash),
        pinyin_initials: None,
        group_id: None,
        source_icon,
        content_type: Some("image".to_string()),
        tags: Vec::new(),
    };

    if let Some(store) = app_handle.try_state::<DataStore>() {
        if let Err(e) = store.insert_history(&item) {
            log::error!("[ClipboardMonitor] 插入图片记录失败: {}", e);
        }
    }
    if let Err(e) = app_handle.emit(
        "clipboard-changed",
        ClipboardChanged { item: item.clone() },
    ) {
        log::warn!("[ClipboardMonitor] 推送图片事件失败: {}", e);
    }

    // LAN 同步：发送图片到局域网
    if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
        let img_path_str = img_path.to_string_lossy().to_string();
        lan_sync.send_item(
            "image",
            &format!("[图片] {}", img_path_str),
            &img_path_str,
        );
    }
}

/// 处理捕获的图文混排富文本条目（阶段1：入库验证采集管道能跑通，
/// 内容完整性、图片清理、展示层留待阶段 2/3/4）
#[cfg(target_os = "windows")]
fn process_rich(
    app_handle: &AppHandle,
    sensitive_cache: &std::sync::RwLock<bool>,
    excluded_cache: &std::sync::RwLock<Vec<String>>,
    html_fragment: String,
    plain_text: String,
    hash: String,
    source_title: String,
    exe_path: Option<PathBuf>,
    now_str: String,
) {
    // 与 process_text 一致：排除名单应用 / 敏感内容不入库
    if is_excluded_app_with(excluded_cache, &source_title) {
        log::info!(
            "[ClipboardMonitor] 跳过敏感内容（富文本）：来源应用 \"{}\" 在排除名单内",
            source_title
        );
        return;
    }
    if should_skip_sensitive_with(sensitive_cache, &plain_text) {
        log::info!("[ClipboardMonitor] 跳过敏感内容（富文本）：匹配密钥/凭据模式，不记录");
        return;
    }

    let source_icon = extract_source_icon(app_handle, &exe_path);
    let pinyin_initials = compute_pinyin_initials(&plain_text);

    // 阶段1 不做智能合并去重（同 process_image/process_files，留待后续阶段补齐）
    let item = HistoryItem {
        id: Uuid::new_v4().to_string(),
        text: plain_text.clone(),
        time: now_str,
        item_type: "rich".to_string(),
        content: html_fragment,
        pinned: false,
        source: source_title,
        workspace: "默认".to_string(),
        md5: Some(hash),
        pinyin_initials: Some(pinyin_initials),
        group_id: None,
        source_icon,
        content_type: Some("rich".to_string()),
        tags: Vec::new(),
    };

    if let Some(store) = app_handle.try_state::<DataStore>() {
        if let Err(e) = store.insert_history(&item) {
            log::error!("[ClipboardMonitor] 插入富文本记录失败: {}", e);
            return;
        }
    }

    // 打上「图文」自动标签（同 process_text 的做法）。
    // 类型标识必须走标签体系，不能只在卡片上画个写死的徽标：
    // 标签才能点击筛选、才会出现在筛选标签列表里、才能被用户统一管理。
    if let Err(e) = tag_tx().send(TagJob {
        app: app_handle.clone(),
        history_id: item.id.clone(),
        labels: vec!["图文".to_string()],
    }) {
        log::warn!("[ContentClassifier] 标签写入通道已关闭: {}", e);
    }

    if let Err(e) = app_handle.emit(
        "clipboard-changed",
        ClipboardChanged { item: item.clone() },
    ) {
        log::warn!("[ClipboardMonitor] 推送富文本事件失败: {}", e);
    }

    // 局域网同步：富文本内嵌图片文件暂无传输机制，阶段1 先不同步（避免对端收到
    // 指向本地不存在路径的断链图片），后续阶段再补
}

/// 处理捕获的文件列表条目（逻辑与轮询版一致：逐文件入库 → 推送 → LAN）
#[cfg(target_os = "windows")]
fn process_files(
    app_handle: &AppHandle,
    paths: Vec<String>,
    source_title: String,
    exe_path: Option<PathBuf>,
    now_str: String,
) {
    let source_icon = extract_source_icon(app_handle, &exe_path);

    for file_path in &paths {
        let filename = std::path::Path::new(file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| file_path.clone());
        let file_hash = md5_hex(file_path.as_bytes());
        let item = HistoryItem {
            id: Uuid::new_v4().to_string(),
            text: filename,
            time: now_str.clone(),
            item_type: "file".to_string(),
            content: file_path.clone(),
            pinned: false,
            source: source_title.clone(),
            workspace: "默认".to_string(),
            md5: Some(file_hash),
            pinyin_initials: None,
            group_id: None,
            source_icon: source_icon.clone(),
            content_type: Some("file".to_string()),
            tags: Vec::new(),
        };
        if let Some(store) = app_handle.try_state::<DataStore>() {
            if let Err(e) = store.insert_history(&item) {
                log::error!("[ClipboardMonitor] 插入文件记录失败: {}", e);
            }
        }
        if let Err(e) = app_handle.emit(
            "clipboard-changed",
            ClipboardChanged { item: item.clone() },
        ) {
            log::warn!("[ClipboardMonitor] 推送文件事件失败: {}", e);
        }

        // LAN 同步：发送文件路径到局域网
        if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
            lan_sync.send_item("file", file_path, "");
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 非 Windows 兜底：保留文本轮询实现（本项目目标平台为 Windows，
// 此分支仅保证跨平台可编译）
// ═══════════════════════════════════════════════════════════════

#[cfg(not(target_os = "windows"))]
fn run_polling_listener(
    running: Arc<AtomicBool>,
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    _auto_strip_cache: Arc<std::sync::RwLock<bool>>,
) {
    log::info!("[ClipboardMonitor] 监听线程启动");

    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            // 修复 C8：失败时复位 running，否则 is_running() 永远为 true、
            // start() 永远提前返回，监听永久失效（只能重启应用）。
            // 同时广播状态事件，让 UI 不再显示"监听中"。
            log::error!("[ClipboardMonitor] 无法打开剪贴板: {}", e);
            running.store(false, Ordering::SeqCst);
            let _ = app_handle.emit("monitor-status-changed", false);
            return;
        }
    };

    let mut last_text_hash: Option<String> = None;
    let poll_interval = Duration::from_millis(400);

    // Low 修复：启动/重启时以当前剪贴板内容作为基准 hash，
    // 避免监听恢复后必然把已存在的内容重复记录一条
    if let Ok(initial_text) = clipboard.get_text() {
        if !initial_text.is_empty() {
            let initial_text = if let Some(monitor) = app_handle.try_state::<ClipboardMonitor>() {
                if monitor.get_auto_strip() {
                    initial_text.trim().to_string()
                } else {
                    initial_text
                }
            } else {
                initial_text
            };
            if !initial_text.is_empty() {
                last_text_hash = Some(md5_hex(initial_text.as_bytes()));
            }
        }
    }

    while running.load(Ordering::SeqCst) {
        std::thread::sleep(poll_interval);

        // 尝试读取文本
        match clipboard.get_text() {
            Ok(text) if !text.is_empty() => {
                // 自动去除空白（使用缓存的配置，避免每 400ms 锁数据库）
                let text = if let Some(monitor) = app_handle.try_state::<ClipboardMonitor>() {
                    if monitor.get_auto_strip() {
                        text.trim().to_string()
                    } else {
                        text
                    }
                } else {
                    text
                };

                if text.is_empty() {
                    last_text_hash = None;
                    continue;
                }

                let hash = md5_hex(text.as_bytes());

                // 检查是否是我们自己写入的粘贴内容（hash 匹配）
                if paste_suppress.is_hash_suppressed(&hash) {
                    log::info!("[ClipboardMonitor] 跳过自身粘贴内容 (hash匹配)");
                    paste_suppress.clear_hash();
                    last_text_hash = Some(hash);
                    continue;
                }

                // U57：hash 设防模式下只认 hash 匹配（上面已处理），
                // 窗口过期仍未命中则清除陈旧 hash，避免误吞用户后续复制的相同内容；
                // 时间兜底仅对无 hash 的粘贴路径（如"粘贴当前剪贴板"）生效
                if paste_suppress.has_expected_hash() {
                    if !paste_suppress.is_suppressed() {
                        paste_suppress.clear_hash();
                    }
                } else if paste_suppress.is_suppressed() {
                    log::info!(
                        "[ClipboardMonitor] 跳过自身粘贴内容 (无hash路径·时间抑制窗口内)"
                    );
                    last_text_hash = Some(hash);
                    continue;
                }

                if Some(&hash) != last_text_hash.as_ref() {
                    last_text_hash = Some(hash.clone());

                    // 获取前台窗口信息（标题 + 图标，一次调用）
                    let (source_title, source_icon) = get_foreground_window_info(&app_handle);

                    // 修复 U36：敏感内容防护 —— 命中应用排除名单或密钥模式时不记录
                    if let Some(monitor) = app_handle.try_state::<ClipboardMonitor>() {
                        if monitor.is_excluded_app(&source_title) {
                            log::info!(
                                "[ClipboardMonitor] 跳过敏感内容：来源应用 \"{}\" 在排除名单内",
                                source_title
                            );
                            continue;
                        }
                        if monitor.should_skip_sensitive(&text) {
                            log::info!(
                                "[ClipboardMonitor] 跳过敏感内容：匹配密钥/凭证模式，不记录"
                            );
                            continue;
                        }
                    }

                    // 计算拼音首字母
                    let pinyin_initials = compute_pinyin_initials(&text);
                    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

                    // 智能合并：检查是否已存在相同 md5 的文本记录
                    let store = app_handle.try_state::<DataStore>();
                    let mut existing_id: Option<String> = None;
                    if let Some(ref store) = store {
                        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认") {
                            existing_id = Some(existing.id.clone());
                            if let Err(e) = store.update_history_time(&existing.id, &now_str) {
                                log::warn!(
                                    "[ClipboardMonitor] 更新重复记录时间失败: {}",
                                    e
                                );
                            } else {
                                log::info!(
                                    "[ClipboardMonitor] 智能合并重复文本 (id={})",
                                    existing.id
                                );
                            }
                            let updated_item = HistoryItem {
                                time: now_str.clone(),
                                source: source_title.clone(),
                                source_icon: source_icon.clone(),
                                group_id: existing.group_id.clone(),
                                ..existing
                            };
                            if let Err(e) = app_handle.emit(
                                "clipboard-changed",
                                ClipboardChanged {
                                    item: updated_item.clone(),
                                },
                            ) {
                                log::warn!("[ClipboardMonitor] 推送合并事件失败: {}", e);
                            }
                            if let Some(lan_sync) =
                                app_handle.try_state::<crate::lan_sync::LanSync>()
                            {
                                lan_sync.send(&text);
                            }
                        }
                    }

                    if existing_id.is_none() {
                        let labels = ContentClassifier::new().classify(&text);
                        let item = HistoryItem {
                            id: Uuid::new_v4().to_string(),
                            text: text.clone(),
                            time: now_str,
                            item_type: "text".to_string(),
                            content: String::new(),
                            pinned: false,
                            source: source_title.clone(),
                            workspace: "默认".to_string(),
                            md5: Some(hash),
                            pinyin_initials: Some(pinyin_initials),
                            group_id: None,
                            source_icon: source_icon.clone(),
                            content_type: Some(
                                ContentClassifier::content_type_from_labels(&labels).to_string(),
                            ),
                            tags: Vec::new(),
                        };

                        if let Some(ref store) = store {
                            if let Err(e) = store.insert_history(&item) {
                                log::error!("[ClipboardMonitor] 插入失败: {}", e);
                            }
                        }

                        // 自动标签写入：发送到 channel，单 worker 顺序消化（突发不丢）
                        if let Err(e) = tag_tx().send(TagJob {
                            app: app_handle.clone(),
                            history_id: item.id.clone(),
                            labels: labels.clone(),
                        }) {
                            log::warn!("[ContentClassifier] 标签写入通道已关闭: {}", e);
                        }

                        if let Err(e) = app_handle.emit(
                            "clipboard-changed",
                            ClipboardChanged { item: item.clone() },
                        ) {
                            log::warn!("[ClipboardMonitor] 推送文本事件失败: {}", e);
                        }

                        if let Some(lan_sync) =
                            app_handle.try_state::<crate::lan_sync::LanSync>()
                        {
                            lan_sync.send(&text);
                        }
                    }
                }
            }
            _ => {
                // 注意：重构前此分支还会探测图片（跨平台）与文件（Windows）。
                // 本项目仅发布 Windows（事件驱动路径已完整覆盖三类内容），
                // 此兜底分支只保留文本轮询以保证跨平台可编译。
                last_text_hash = None;
            }
        }
    }

    log::info!("[ClipboardMonitor] 监听线程退出");
}

/// 获取前台窗口标题 + 提取来源图标（仅非 Windows 轮询路径使用）
/// 返回 (窗口标题, 图标文件名)
#[cfg(not(target_os = "windows"))]
fn get_foreground_window_info(_app_handle: &tauri::AppHandle) -> (String, Option<String>) {
    (String::new(), None)
}

/// 匹配 <img src="..."> 或 <img src='...'>（大小写不敏感）。
static IMG_SRC_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap()
});

/// 判断 CF_HTML 片段里是否确实带内嵌图片（用于决定是否走图文混排采集路径，
/// 避免把绝大多数"纯文本也带 CF_HTML"的普通复制误判为富文本）
#[cfg(target_os = "windows")]
fn html_fragment_has_image(fragment: &str) -> bool {
    IMG_SRC_RE.is_match(fragment)
}

/// 判断 CF_HTML 片段里除了图片以外是否还有真正的文字。
///
/// 为什么必需：“有 <img> 就算图文”是错的。从企业微信/浏览器复制一张纯图片时，
/// 源应用也会顺手写一份 CF_HTML，内容就是单独一个 <img src="file:///..." />
/// （已实测验证）。只看有无 <img> 会把纯图片全部误判成图文，后果是：
/// 本应当图片存的内容被当富文本存，粘贴回写时写 CF_HTML 而不是真实位图，
/// 而很多应用对前者的支持反而更差。
///
/// 所以图文的定义是“既有图、又有文”；只有图没有文的落回图片分支。
#[cfg(target_os = "windows")]
fn html_fragment_has_text(fragment: &str) -> bool {
    !html_fragment_to_plain_text_fallback(fragment).is_empty()
}

/// 提取 HTML 片段里所有 <img src> 的原始值（不判断是否本地/远程，不改写）。
/// 不按平台限制：供其他模块复用（删除历史时清理关联图片文件需要从 content 里反推 src）。
pub(crate) fn extract_img_srcs(fragment: &str) -> Vec<String> {
    IMG_SRC_RE
        .captures_iter(fragment)
        .filter_map(|cap| cap.get(1).or_else(|| cap.get(2)).map(|m| m.as_str().to_string()))
        .collect()
}

/// 尝试把单个 img src（本地文件路径 / file:// / data: URI）落盘到图片库，
/// 返回新文件的绝对路径。远程 http(s) 引用与无法识别的格式返回 None（阶段1
/// 范围之外，原样保留，不删除不报错）。
#[cfg(target_os = "windows")]
fn localize_one_image(src: &str, images_dir: &std::path::Path) -> Option<PathBuf> {
    let bytes: Vec<u8> = if src.starts_with("data:") {
        // 格式如 data:image/png;base64,xxxx；非 base64 的 data URI（罕见）不处理
        if !src.contains(";base64,") {
            return None;
        }
        let comma = src.find(',')?;
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &src[comma + 1..]).ok()?
    } else if src.starts_with("file:") {
        // Word/Outlook/浏览器常见写法：本地临时文件的 file:// 引用，来源应用
        // 清理临时文件后这个路径就失效，所以必须在采集那一刻立即读出来。
        let url = url::Url::parse(src).ok()?;
        let path = url.to_file_path().ok()?;
        std::fs::read(&path).ok()?
    } else if src.len() > 1 && src.as_bytes()[1] == b':' {
        // 裸盘符路径（少数应用不带 file:// 前缀，如 C:\Users\...\image.png）
        std::fs::read(src).ok()?
    } else {
        // http(s) 等远程引用：阶段1 不处理，保留原始 src 不报错
        return None;
    };

    if bytes.is_empty() {
        return None;
    }

    let ext = image::guess_format(&bytes)
        .ok()
        .and_then(|fmt| fmt.extensions_str().first().copied())
        .unwrap_or("png");
    let hash = md5_hex(&bytes);
    if let Err(e) = std::fs::create_dir_all(images_dir) {
        log::error!("[ClipboardMonitor] 创建图片目录失败（富文本内嵌图片）: {}", e);
        return None;
    }
    let file_path = images_dir.join(format!("{}.{}", hash, ext));
    if !file_path.exists() {
        if let Err(e) = std::fs::write(&file_path, &bytes) {
            log::error!("[ClipboardMonitor] 写入富文本内嵌图片失败: {}", e);
            return None;
        }
    }
    Some(file_path)
}

/// 极简 HTML→纯文本：去标签、解基础实体、合并空白（仅用于 CF_UNICODETEXT
/// 缺失时的展示/搜索保底，不追求完整还原——真实展示走前端富文本渲染）
static HTML_TAG_STRIP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());

#[cfg(target_os = "windows")]
fn html_fragment_to_plain_text_fallback(fragment: &str) -> String {
    let no_tags = HTML_TAG_STRIP_RE.replace_all(fragment, " ");
    let decoded = no_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 把片段里所有本地文件/data URI 图片抄一份进自己的图片库，并把 <img src>
/// 改写为新路径（远程 http(s) 引用原样保留）。逐个处理 img 标签，支持
/// 任意多图/任意顺序交错的图文混排片段。
/// 返回 (改写后的片段, 落盘的图片文件路径列表)
#[cfg(target_os = "windows")]
fn localize_html_images(fragment: &str, images_dir: &std::path::Path) -> (String, Vec<PathBuf>) {
    let mut saved_paths = Vec::new();
    let mut result = String::with_capacity(fragment.len());
    let mut last_end = 0usize;

    for cap in IMG_SRC_RE.captures_iter(fragment) {
        let Some(src_match) = cap.get(1).or_else(|| cap.get(2)) else {
            continue;
        };
        let src = src_match.as_str();

        result.push_str(&fragment[last_end..src_match.start()]);

        match localize_one_image(src, images_dir) {
            Some(new_path) => {
                saved_paths.push(new_path.clone());
                let new_src = new_path.to_string_lossy().replace('\\', "/");
                result.push_str(&format!("file:///{}", new_src));
            }
            None => {
                result.push_str(src);
            }
        }
        last_end = src_match.end();
    }
    result.push_str(&fragment[last_end..]);
    (result, saved_paths)
}

/// 构造一个完整的 CF_HTML 缓冲区（Version/StartHTML/EndHTML/StartFragment/EndFragment 自引用
/// 头部 + <!--StartFragment/EndFragment--> 标记包裹的片段）。采集侧测试用来验证解析，
/// 粘贴回写侧（execute_paste_rich）用来把存下来的片段重新包装回真实剪贴板格式。
pub(crate) fn build_cf_html_buffer(fragment_inner: &str) -> Vec<u8> {
    let prefix_html = "<html><body>\r\n<!--StartFragment-->";
    let suffix_html = "<!--EndFragment-->\r\n</body></html>";
    let header_template =
        |start_html: usize, end_html: usize, start_frag: usize, end_frag: usize| {
            format!(
                "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
                start_html, end_html, start_frag, end_frag
            )
        };
    let header_len = header_template(0, 0, 0, 0).len();
    let start_html = header_len;
    let start_frag = start_html + prefix_html.len();
    let end_frag = start_frag + fragment_inner.as_bytes().len();
    let end_html = end_frag + suffix_html.len();
    let header = header_template(start_html, end_html, start_frag, end_frag);
    let mut buf = Vec::new();
    buf.extend_from_slice(header.as_bytes());
    buf.extend_from_slice(prefix_html.as_bytes());
    buf.extend_from_slice(fragment_inner.as_bytes());
    buf.extend_from_slice(suffix_html.as_bytes());
    buf
}

/// 从剪贴板读取 CF_HTML 原始字节，按 StartFragment/EndFragment 字节偏移切出
/// 真正的富文本片段（不含 <!--StartFragment/EndFragment--> 注释本身）。
/// 头部偏移量是按字节算的，片段内容可能含中文等多字节 UTF-8 字符，
/// 已用真实剪贴板往返验证过字节片切不会错位。
#[cfg(target_os = "windows")]
fn get_clipboard_html() -> Option<String> {
    use windows::core::w;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    unsafe {
        let format_id = RegisterClipboardFormatW(w!("HTML Format"));
        if format_id == 0 {
            return None;
        }
        if OpenClipboard(None).is_err() {
            return None;
        }

        let handle = match GetClipboardData(format_id) {
            Ok(h) if !h.is_invalid() => h,
            _ => {
                let _ = CloseClipboard();
                return None;
            }
        };

        let hglobal = HGLOBAL(handle.0);
        let size = GlobalSize(hglobal);
        if size == 0 {
            let _ = CloseClipboard();
            return None;
        }
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            let _ = CloseClipboard();
            return None;
        }
        let raw = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(hglobal);
        let _ = CloseClipboard();

        parse_cf_html_fragment(&raw)
    }
}

/// 解析 CF_HTML 头部（Version/StartHTML/EndHTML/StartFragment/EndFragment），
/// 按 StartFragment~EndFragment 字节偏移切出片段内容。
#[cfg(target_os = "windows")]
pub(crate) fn parse_cf_html_fragment(raw: &[u8]) -> Option<String> {
    // 头部总是纯 ASCII 且很短，只在前 2KB 里找，避免因后面正文内容过大而白白扫描
    let header_len = raw.len().min(2048);
    let header_text = std::str::from_utf8(&raw[..header_len]).ok()?;

    let find_offset = |key: &str| -> Option<usize> {
        let idx = header_text.find(key)?;
        let rest = &header_text[idx + key.len()..];
        let end = rest.find(|c: char| c == '\r' || c == '\n')?;
        rest[..end].trim().parse::<usize>().ok()
    };

    let start_frag = find_offset("StartFragment:")?;
    let end_frag = find_offset("EndFragment:")?;
    if start_frag >= end_frag || end_frag > raw.len() {
        return None;
    }
    Some(String::from_utf8_lossy(&raw[start_frag..end_frag]).into_owned())
}

/// 从剪贴板读取文件路径列表 (CF_HDROP)
#[cfg(target_os = "windows")]
fn get_clipboard_files() -> Option<Vec<String>> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }

        const CF_HDROP: u32 = 15;
        let handle = GetClipboardData(CF_HDROP);
        let handle = match handle {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return None;
            }
        };

        if handle.is_invalid() {
            let _ = CloseClipboard();
            return None;
        }

        let hdrop = HDROP(handle.0);
        let mut files = Vec::new();

        // 获取文件数量
        let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);

        for i in 0..count {
            // 获取文件名长度（不含 null terminator）
            let needed = DragQueryFileW(hdrop, i, None);
            if needed == 0 {
                continue;
            }

            // 分配缓冲区并读取文件名
            let mut buf = vec![0u16; (needed + 1) as usize];
            let copied = DragQueryFileW(hdrop, i, Some(&mut buf));
            if copied > 0 {
                let path = OsString::from_wide(&buf[..copied as usize]);
                files.push(path.to_string_lossy().into_owned());
            }
        }

        let _ = CloseClipboard();
        if files.is_empty() {
            None
        } else {
            Some(files)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_new_not_suppressed() {
        let ps = PasteSuppress::new();
        assert!(!ps.is_suppressed());
        assert!(!ps.has_expected_hash());
    }

    #[test]
    fn test_set_activates_time_window() {
        let ps = PasteSuppress::new();
        ps.set(Duration::from_millis(200));
        assert!(ps.is_suppressed());
    }

    #[test]
    fn test_time_window_expires() {
        let ps = PasteSuppress::new();
        ps.set(Duration::from_millis(50));
        assert!(ps.is_suppressed());
        thread::sleep(Duration::from_millis(80));
        assert!(!ps.is_suppressed());
    }

    #[test]
    fn test_set_with_hash() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_millis(200), "abc123".to_string());
        assert!(ps.is_suppressed());
        assert!(ps.has_expected_hash());
        assert!(ps.is_hash_suppressed("abc123"));
        assert!(!ps.is_hash_suppressed("other"));
    }

    #[test]
    fn test_hash_suppressed_after_time_expires() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_millis(30), "hash1".to_string());
        thread::sleep(Duration::from_millis(60));
        // 时间窗口过期
        assert!(!ps.is_suppressed());
        // 但 hash 仍然匹配（U57 双重检查的核心）
        assert!(ps.has_expected_hash());
        assert!(ps.is_hash_suppressed("hash1"));
    }

    #[test]
    fn test_clear_hash() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_secs(10), "h".to_string());
        assert!(ps.has_expected_hash());
        ps.clear_hash();
        assert!(!ps.has_expected_hash());
        assert!(!ps.is_hash_suppressed("h"));
        // 时间窗口不受 clear_hash 影响
        assert!(ps.is_suppressed());
    }

    #[test]
    fn test_u57_dual_check_pattern() {
        // 模拟 U57 修复后的监听循环逻辑：
        // if has_expected_hash() { if !is_hash_suppressed(hash) { clear_hash(); } }
        // else if is_suppressed() { skip }
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_millis(30), "pasted_content".to_string());
        thread::sleep(Duration::from_millis(60)); // 时间过期

        // 场景 1：新复制的内容 hash 匹配 → 应跳过（自粘贴回显）
        let new_hash = "pasted_content";
        if ps.has_expected_hash() {
            assert!(ps.is_hash_suppressed(new_hash)); // 匹配 → 跳过
        }

        // 场景 2：新复制的内容 hash 不匹配 → 应清除 hash 并正常记录
        let different_hash = "user_new_content";
        if ps.has_expected_hash() {
            if !ps.is_hash_suppressed(different_hash) {
                ps.clear_hash(); // 不匹配 → 清除，正常记录
            }
        }
        assert!(!ps.has_expected_hash());
    }

    #[test]
    fn test_set_overwrites_previous() {
        let ps = PasteSuppress::new();
        ps.set_with_hash(Duration::from_secs(10), "old".to_string());
        ps.set_with_hash(Duration::from_secs(10), "new".to_string());
        assert!(ps.is_hash_suppressed("new"));
        assert!(!ps.is_hash_suppressed("old"));
    }

    #[test]
    fn test_concurrent_access() {
        let ps = Arc::new(PasteSuppress::new());
        let ps2 = Arc::clone(&ps);
        let handle = thread::spawn(move || {
            ps2.set_with_hash(Duration::from_millis(100), "t".to_string());
        });
        handle.join().unwrap();
        assert!(ps.is_suppressed());
        assert!(ps.is_hash_suppressed("t"));
    }

    // ── 捕获队列测试（事件驱动路径） ──

    #[cfg(target_os = "windows")]
    fn text_item(name: &str) -> CapturedItem {
        CapturedItem::Text {
            text: name.to_string(),
            hash: String::new(),
            title: String::new(),
            exe_path: None,
            time: String::new(),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_capture_queue_fifo_order() {
        let queue = CaptureQueue::new();
        let running = AtomicBool::new(true);
        queue.push(text_item("item-0"));
        queue.push(text_item("item-1"));
        match queue.pop(&running) {
            Some(CapturedItem::Text { text, .. }) => assert_eq!(text, "item-0"),
            _ => panic!("expected first text item"),
        }
        match queue.pop(&running) {
            Some(CapturedItem::Text { text, .. }) => assert_eq!(text, "item-1"),
            _ => panic!("expected second text item"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_capture_queue_bounded_drop_oldest() {
        let queue = CaptureQueue::new();
        for i in 0..(CAPTURE_QUEUE_CAP + 5) {
            queue.push(text_item(&format!("item-{}", i)));
        }
        let guard = queue.inner.lock().unwrap();
        assert_eq!(guard.len(), CAPTURE_QUEUE_CAP);
        // 最旧的 5 条被丢弃，队首应为 item-5
        match guard.front().unwrap() {
            CapturedItem::Text { text, .. } => assert_eq!(text, "item-5"),
            _ => panic!("expected text item"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_capture_queue_pop_exits_when_stopped() {
        let queue = CaptureQueue::new();
        let running = AtomicBool::new(false);
        // 队列空 + running=false → 立即返回 None（工作线程退出条件）
        assert!(queue.pop(&running).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_capture_queue_drains_before_exit() {
        let queue = CaptureQueue::new();
        let running = AtomicBool::new(true);
        queue.push(text_item("pending"));
        // stop 后队列中已捕获的条目仍应被处理（先排空再退出）
        running.store(false, Ordering::SeqCst);
        match queue.pop(&running) {
            Some(CapturedItem::Text { text, .. }) => assert_eq!(text, "pending"),
            _ => panic!("expected pending item to be drained"),
        }
        assert!(queue.pop(&running).is_none());
    }

    #[test]
    fn test_md5_hex() {
        // 与旧实现 format!("{:x}", Md5...) 口径一致
        assert_eq!(md5_hex(b"hello"), "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn test_is_excluded_app_with() {
        let cache = std::sync::RwLock::new(vec!["Keepass".to_string(), "  ".to_string()]);
        // 忽略大小写的包含匹配
        assert!(is_excluded_app_with(&cache, "KeePass - 数据库.kdbx"));
        assert!(is_excluded_app_with(&cache, "KEEPASS.EXE"));
        assert!(!is_excluded_app_with(&cache, "chrome"));
        // 空白名单项被忽略，空标题不匹配
        assert!(!is_excluded_app_with(&cache, ""));
        let empty = std::sync::RwLock::new(Vec::new());
        assert!(!is_excluded_app_with(&empty, "anything"));
    }

    #[test]
    fn test_should_skip_sensitive_with_disabled() {
        // 开关关闭时永不跳过（默认值已与前端 DEFAULT_CONFIG 对齐为 false）
        let cache = std::sync::RwLock::new(false);
        assert!(!should_skip_sensitive_with(&cache, "AKIA1234567890SECRET"));
    }

    // ── 图文混排 CF_HTML 采集测试（纯函数，不依赖真实剪贴板） ──

    /// 1x1 透明 PNG 的 base64 编码（测试用最小合法 PNG）
    #[cfg(target_os = "windows")]
    const TEST_PNG_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    #[cfg(target_os = "windows")]
    fn build_test_cf_html(fragment_inner: &str) -> Vec<u8> {
        build_cf_html_buffer(fragment_inner)
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_cf_html_fragment_byte_offset_with_chinese() {
        // 回归早期可行性验证结论：头部偏移是按字节算的，前面插入中文不能导致错位
        let fragment = "这是中文段落，包含<img src=\"file:///C:/temp/图片.png\">和后续文字。";
        let buf = build_test_cf_html(fragment);
        let parsed = parse_cf_html_fragment(&buf).expect("应能解析出片段");
        assert_eq!(parsed, fragment);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_cf_html_fragment_rejects_malformed_header() {
        assert!(parse_cf_html_fragment(b"not a cf_html buffer at all").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_html_fragment_has_image() {
        assert!(html_fragment_has_image(r#"<p>hi</p><img src="foo.png">"#));
        assert!(html_fragment_has_image(r#"<IMG SRC='foo.png'/>"#));
        assert!(!html_fragment_has_image("<p>纯文本没有图片</p>"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_pure_image_copy_is_not_rich() {
        // 回归：企业微信复制纯图片时实际写入的 CF_HTML 片段（从真实剪贴板倒出）。
        // 它确实带 <img>，但没有任何文字——不能当图文，否则纯图片会被当富文本存，
        // 粘贴回写时发 CF_HTML 而不是真实位图。
        let pure_image =
            r#"<img src="file:///D:/wx/QWXWork/Cache/Image/2026-08/企业微信截图_1785998.png" />"#;
        assert!(html_fragment_has_image(pure_image), "确实带图");
        assert!(
            !html_fragment_has_text(pure_image),
            "但没有文字，不应被当成图文"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_image_with_text_is_rich() {
        // 真正的图文混排：图与文同时存在，两道门槛都过
        let mixed = r#"<p>项目排期看这张图</p><img src="file:///C:/a.png" /><p>有问题找我</p>"#;
        assert!(html_fragment_has_image(mixed));
        assert!(html_fragment_has_text(mixed));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_image_with_only_whitespace_is_not_rich() {
        // 只有空白/不断行空格包裹的图片仍算纯图片（部分源应用会多包一层 <p>）
        let padded = "<p>  </p><img src=\"file:///C:/a.png\" /><p>&nbsp;</p>";
        assert!(html_fragment_has_image(padded));
        assert!(!html_fragment_has_text(padded), "空白不算文字");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_localize_one_image_data_uri() {
        let dir = std::env::temp_dir().join(format!("pastepanda_test_{}", Uuid::new_v4()));
        let src = format!("data:image/png;base64,{}", TEST_PNG_BASE64);
        let saved = localize_one_image(&src, &dir).expect("应能解码 data URI 并落盘");
        assert!(saved.exists());
        assert_eq!(saved.extension().and_then(|e| e.to_str()), Some("png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_localize_one_image_file_url_before_source_cleans_up() {
        // 模拟 Word/浏览器场景：源应用的临时图片文件存在于采集那一刻，
        // 必须立即读出抄走，后续源文件被删除也不影响已落盘的副本。
        let source_dir = std::env::temp_dir().join(format!("pastepanda_src_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&source_dir).unwrap();
        let source_file = source_dir.join("image001.png");
        use base64::Engine;
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode(TEST_PNG_BASE64)
            .unwrap();
        std::fs::write(&source_file, &png_bytes).unwrap();

        let images_dir = std::env::temp_dir().join(format!("pastepanda_images_{}", Uuid::new_v4()));
        let file_url = url::Url::from_file_path(&source_file).unwrap();
        let saved = localize_one_image(file_url.as_str(), &images_dir)
            .expect("应能读出 file:// 本地图片并落盘");
        assert!(saved.exists());
        assert_eq!(std::fs::read(&saved).unwrap(), png_bytes);

        // 源文件删除后，落盘的副本仍完好保留（验证"采集时即时抄走"确实有效）
        let _ = std::fs::remove_dir_all(&source_dir);
        assert!(saved.exists());

        let _ = std::fs::remove_dir_all(&images_dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_localize_one_image_remote_url_untouched() {
        let dir = std::env::temp_dir().join(format!("pastepanda_test_{}", Uuid::new_v4()));
        assert!(localize_one_image("https://example.com/pic.png", &dir).is_none());
        assert!(!dir.exists());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_localize_html_images_multiple_interleaved() {
        // 验证任意多图/任意交错的图文混排场景：文字 + 图片 + 图片 + 文字
        let images_dir = std::env::temp_dir().join(format!("pastepanda_multi_{}", Uuid::new_v4()));
        let data_src = format!("data:image/png;base64,{}", TEST_PNG_BASE64);
        let fragment = format!(
            "<p>前段文字</p><img src=\"{}\"><img src=\"{}\"><p>后段文字</p><img src=\"https://remote.example/x.png\">",
            data_src, data_src
        );
        let (rewritten, saved) = localize_html_images(&fragment, &images_dir);

        assert_eq!(saved.len(), 2, "两张 data URI 图片都应落盘（同内容同 hash同文件，但均计入返回列表）");
        assert!(rewritten.contains("前段文字"));
        assert!(rewritten.contains("后段文字"));
        // 远程引用保持原样
        assert!(rewritten.contains("https://remote.example/x.png"));
        // 本地化后的图片引用不再指向 data:
        assert_eq!(rewritten.matches("data:image/png").count(), 0);
        assert_eq!(rewritten.matches("file:///").count(), 2);

        let _ = std::fs::remove_dir_all(&images_dir);
    }
}
