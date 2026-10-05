use crate::content_classifier::ContentClassifier;
use crate::data_store::{compute_pinyin_initials, DataStore, HistoryItem, TimeBump};
// arboard 是桌面剪贴板引擎：Windows 走事件路径、macOS/Linux 走轮询兜底（都在 desktop），
// mobile 不监听系统剪贴板（RC 会话内剪贴板走 rc/clipboard.rs），整个引擎不编译。
#[cfg(desktop)]
use arboard::Clipboard;
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

/// 排一条自动标签写入。
///
/// 对外的**唯一入口**：channel 与 TagJob 保持私有，命令层（如流程图入库）也能打标签。
/// 原先四处调用点各抄一遍「构造 TagJob + send + 失败时 warn」，收口到这里（规则 #11）。
///
/// 注意：标签名必须已在 `ensure_auto_tags` 的种子表里——`resolve_auto_tag_ids` 是
/// 「按 name 查，查不到就跳过」，没种子的名字会**静默失效**（「文档」就这么一直没生效过）。
pub(crate) fn enqueue_auto_tags(app: AppHandle, history_id: String, labels: Vec<String>) {
    if labels.is_empty() {
        return;
    }
    if let Err(e) = tag_tx().send(TagJob {
        app,
        history_id,
        labels,
    }) {
        log::warn!("[ContentClassifier] 标签写入通道已关闭: {}", e);
    }
}

/// 获取标签写入 channel 发送端（首次调用启动 worker 线程）
fn tag_tx() -> &'static mpsc::Sender<TagJob> {
    static TX: OnceLock<mpsc::Sender<TagJob>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<TagJob>();
        if let Err(e) = std::thread::Builder::new()
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
        {
            log::error!("[ContentClassifier] 启动 auto-tag-writer 线程失败: {}", e);
        }
        tx
    })
}

/// 剪贴板变化事件，推送到前端
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardChanged {
    pub item: HistoryItem,
}

/// 采集端按哪一类内容识别一次读取 —— 与 `stage1_capture` 的分支一一对应。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WriteKind {
    Rich,
    Text,
    Image,
    Files,
}

/// 写入线程持有剪贴板的**临界区**上限。
///
/// 闸门唯一的存在理由：写入方 `OpenClipboard` 期间监听线程去读会撞 `os error 1418`。
/// 正常路径靠 [`WriteGuard::drop`] 即时开闸；这个上限只防守卫没走到 Drop（线程 panic）
/// 把闸门焊死 —— 「读不到剪贴板」绝不能变成永久状态。
const RACE_MAX: Duration = Duration::from_millis(500);

/// 写入方算不出 hash 时的身份窗口长度（沿用历史 3s）。
///
/// 它只压制写入方**声明过的那一类**内容（见 [`WriteOpts::kinds`]），不再无差别吞掉
/// 窗口内用户的每一次复制 —— 旧行为的成因与影响见
/// `docs/复制未入库诊断与方案-2026-09-28.md` §9。
const IDENTITY_WINDOW: Duration = Duration::from_millis(3000);

/// 文件列表写入/采集的共用 hash 口径（规则 11.1：两边算不出同一个 hash 就等于没报备）。
pub fn files_clipboard_hash(paths: &[String]) -> String {
    md5_hex(paths.join("|").as_bytes())
}

/// 一次「应用自己写剪贴板」的报备内容。
pub struct WriteOpts {
    hashes: Vec<String>,
    /// `None` = 全部类别（写入方说不清自己要写什么内容，如「粘贴当前剪贴板」）
    kinds: Option<Vec<WriteKind>>,
    /// `true` = 采集端一定能算出同一个 hash → 进入「只认 hash」模式，
    /// 窗口内用户复制的别的内容照常采集。
    ///
    /// `false` = 算不出（图文的采集 hash 是内联图片落地后被改写过的片段；
    /// 「粘贴当前剪贴板」压根不知道内容是什么）→ 只能按 [`kinds`] 做时间兜底。
    precise: bool,
}

impl WriteOpts {
    /// 纯文本。同时登记原串与 trim 串：采集端是否去空白取决于用户配置，只登记一种口径
    /// 会让另一半自粘贴落到阶段 2 的智能合并（多一次无谓的卡片置顶）。
    pub fn text(raw: &str) -> Self {
        let mut hashes = vec![md5_hex(raw.as_bytes())];
        let trimmed = raw.trim();
        if trimmed != raw {
            hashes.push(md5_hex(trimmed.as_bytes()));
        }
        Self {
            hashes,
            kinds: Some(vec![WriteKind::Text]),
            precise: true,
        }
    }

    /// 图文混排。采集端的 hash 是**内联图片落地之后**被改写过的片段，写入方算不出同一个
    /// hash，所以这条只能走类别窗口；CF_HTML 也可能被读成纯文本，两个类别都声明。
    pub fn rich(html_fragment: &str) -> Self {
        Self {
            hashes: vec![md5_hex(html_fragment.as_bytes())],
            kinds: Some(vec![WriteKind::Rich, WriteKind::Text]),
            precise: false,
        }
    }

    /// 图片（RGBA 像素字节，与采集端一致）。
    pub fn image_rgba(rgba: &[u8]) -> Self {
        Self {
            hashes: vec![md5_hex(rgba)],
            kinds: Some(vec![WriteKind::Image]),
            precise: true,
        }
    }

    /// 文件列表（CF_HDROP）。
    pub fn files(paths: &[String]) -> Self {
        Self {
            hashes: vec![files_clipboard_hash(paths)],
            kinds: Some(vec![WriteKind::Files]),
            precise: true,
        }
    }

    /// 说不清写了什么 → 全部类别按时间兜底。
    pub fn unknown() -> Self {
        Self {
            hashes: Vec::new(),
            kinds: None,
            precise: false,
        }
    }
}

/// 守卫：作用域结束即打开读取闸门。写入方必须把它持有到剪贴板写完。
pub struct WriteGuard<'a> {
    suppress: &'a PasteSuppress,
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        self.suppress.open_race();
    }
}

/// 粘贴抑制状态 — 防止自身粘贴被记录。
///
/// 两道闸，职责不同，**混用会出事**：
/// - **竞争闸** `race_until`：写入线程持有剪贴板的临界区。期间阶段 1 干脆不读剪贴板，
///   避免和写入线程抢 `OpenClipboard`（os error 1418）。由 [`PasteSuppress::begin_write`]
///   返回的守卫配对释放。
/// - **身份窗口** `until` + `kinds` + `expected`：内容已落定，用来认出「这次读到的就是我们
///   刚写的那一份」。算得准靠 hash（一次性命中，命中后整段身份作废）；算不准靠**类别**窗口。
///
/// 旧实现把两道闸合成一个「3 秒内一律不读」，代价是粘贴后 3 秒内用户的任何复制都被吞掉，
/// 而阶段 1 顶部的无差别早退又架空了各分支里的 U57 hash 判据。
pub struct PasteSuppress {
    until: Mutex<Option<Instant>>,
    /// 报备过的内容 hash（可能多个口径）。空 = 未设防。
    expected: Mutex<Vec<String>>,
    /// `None` = 未报备类别 = 按全部类别兜底。
    kinds: Mutex<Option<Vec<WriteKind>>>,
    /// 本次报备是否精确到「采集端算得出同一个 hash」。
    precise: Mutex<bool>,
    race_until: Mutex<Option<Instant>>,
}

impl PasteSuppress {
    pub fn new() -> Self {
        Self {
            until: Mutex::new(None),
            expected: Mutex::new(Vec::new()),
            kinds: Mutex::new(None),
            precise: Mutex::new(false),
            race_until: Mutex::new(None),
        }
    }

    /// 应用自己写剪贴板**之前**调用。返回的守卫必须活到写入结束（临界区一到就开闸）。
    pub fn begin_write(&self, opts: WriteOpts) -> WriteGuard<'_> {
        if let Ok(mut guard) = self.race_until.lock() {
            *guard = Some(Instant::now() + RACE_MAX);
        }
        if let Ok(mut guard) = self.until.lock() {
            *guard = Some(Instant::now() + IDENTITY_WINDOW);
        }
        if let Ok(mut guard) = self.expected.lock() {
            *guard = opts.hashes;
        }
        if let Ok(mut guard) = self.kinds.lock() {
            *guard = opts.kinds;
        }
        if let Ok(mut guard) = self.precise.lock() {
            *guard = opts.precise;
        }
        WriteGuard { suppress: self }
    }

    fn open_race(&self) {
        if let Ok(mut guard) = self.race_until.lock() {
            *guard = None;
        }
    }

    /// 竞争闸是否开着（阶段 1 据此决定「这次要不要读剪贴板」）。
    pub fn in_race(&self) -> bool {
        self.race_until
            .lock()
            .map(|guard| guard.is_some_and(|t| Instant::now() < t))
            .unwrap_or(false)
    }

    fn window_alive(&self) -> bool {
        self.until
            .lock()
            .map(|guard| guard.is_some_and(|t| Instant::now() < t))
            .unwrap_or(false)
    }

    /// 身份窗口是否仍覆盖 `kind` 这一类内容。
    fn window_covers(&self, kind: WriteKind) -> bool {
        if !self.window_alive() {
            return false;
        }
        self.kinds
            .lock()
            .map(|guard| match guard.as_ref() {
                None => true,
                Some(kinds) => kinds.contains(&kind),
            })
            .unwrap_or(true)
    }

    fn hash_hit(&self, candidates: &[&str]) -> bool {
        self.expected
            .lock()
            .map(|guard| candidates.iter().any(|c| guard.iter().any(|h| h == c)))
            .unwrap_or(false)
    }

    fn has_expected(&self) -> bool {
        self.expected
            .lock()
            .map(|guard| !guard.is_empty())
            .unwrap_or(false)
    }

    /// 是否处于「精确设防」模式：写入方报备了采集端算得出的 hash。
    fn precise_armed(&self) -> bool {
        self.precise.lock().map(|g| *g).unwrap_or(false) && self.has_expected()
    }

    /// 身份已经用上（hash 命中）→ 整段作废。
    ///
    /// 🔴 必须连时间窗口一起清掉：只清 hash 的话，自粘贴回显之后窗口内用户复制的**别的**
    /// 内容会被类别兜底一起吞掉 —— 那正是本次要修的病灶。
    fn identity_done(&self) {
        if let Ok(mut guard) = self.expected.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.kinds.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.precise.lock() {
            *guard = false;
        }
        if let Ok(mut guard) = self.until.lock() {
            *guard = None;
        }
    }

    fn clear_stale(&self) {
        if let Ok(mut guard) = self.expected.lock() {
            guard.clear();
        }
    }

    /// 阶段 1 唯一的「这次读取是不是应用自己刚写的」判定（规则 11.1 收口）。
    ///
    /// `candidates` 是这次读取用到的全部 hash 口径（Doc 条目同时给「片段 hash」和
    /// 「纯文本 hash」），第一个用于日志展示。
    ///
    /// 返回跳过原因串，`None` = 照常采集。判据顺序即优先级：
    /// 1. 窗口不覆盖这个类别（或已过期）→ 本次读取与本次写入无关，直接采集；
    ///    过期时顺手作废陈旧身份，免得同内容日后被莫名吞掉；
    /// 2. hash 命中 → 精确到内容，命中后整段身份作废；
    /// 3. 精确设防但没命中 → **只认 hash**，窗口内用户别的内容照常采集（U57）；
    /// 4. 写入方说不清内容（如富文本片段落不了地、或「粘贴当前剪贴板」）→ 按类别做时间兜底。
    pub fn own_write_reason(&self, candidates: &[&str], kind: WriteKind) -> Option<&'static str> {
        if !self.window_covers(kind) {
            if !self.window_alive() {
                self.clear_stale();
            }
            return None;
        }
        if self.hash_hit(candidates) {
            self.identity_done();
            return Some("self_paste_hash");
        }
        if self.precise_armed() {
            return None;
        }
        Some("self_paste_window")
    }
}

/// 各采集分支共用的自粘贴跳过判定 + 日志（规则 11.1：判定与日志口径只此一处）。
fn own_write_skip(
    paste_suppress: &PasteSuppress,
    candidates: &[&str],
    kind_name: &'static str,
    kind: WriteKind,
) -> bool {
    match paste_suppress.own_write_reason(candidates, kind) {
        Some(reason) => {
            log::info!(
                "[ClipboardMonitor] 跳过采集 reason={} kind={} hash8={}",
                reason,
                kind_name,
                hash8(candidates[0])
            );
            true
        }
        None => false,
    }
}

/// 采集去重窗口：一次复制在多久之内的重复读取算「同一份内容已被采过」。
const DEDUP_TTL: Duration = Duration::from_millis(1500);

/// 采集去重状态 —— 只用来合并「同一次复制被读两遍」（50ms 防抖 + 1s 序列号兜底 +
/// Office 延迟渲染补写格式），**不是**「这段内容见过了就别再记」。
///
/// 为什么必须带 TTL：没有期限的单值基线会把任何一次「跳过但没落库」变成对该内容的
/// **永久拉黑**。三条污染路径的共同点是「写了基线却没有产生记录」——
/// ① 监听线程启动/暂停恢复时以当前剪贴板为基线；② 自身粘贴 hash 命中时写基线；
/// ③ 基线在阶段 1 被消费、阶段 2 才决定存不存（排除名单 / 敏感 / 插库失败 / 队列丢弃）。
/// 用户侧表现都是「复制没进、重复制也不进、改一个字才进」。
/// 详见 `docs/复制未入库诊断与方案-2026-09-28.md` §2.0。
///
/// 真正的「重复内容不新建记录」仍由阶段 2 的智能合并（按 md5 查库）负责，所以这里
/// 多放过一次重复采集的代价只是旧卡片移到顶部，而不是丢一条记录。
pub struct CaptureDedup {
    last: Mutex<Option<(String, Instant)>>,
}

impl CaptureDedup {
    pub fn new() -> Self {
        Self {
            last: Mutex::new(None),
        }
    }

    /// 是否是 `DEDUP_TTL` 内刚采过的同一份内容
    pub fn is_recent(&self, hash: &str) -> bool {
        self.recent_at(hash, Instant::now())
    }

    /// **只允许在真的入队之后调用**（规则 #11.1）：跳过路径写这里 = 重新开出
    /// 「永久拉黑」的口子，所以调用点收在这个类型里，监听侧拿不到写权限的其它入口。
    pub fn note(&self, hash: &str) {
        self.note_at(hash, Instant::now());
    }

    /// 剪贴板变空 / 只剩不可读内容：忘记上一份，让同样的内容下次仍走完整流程。
    pub fn clear(&self) {
        if let Ok(mut guard) = self.last.lock() {
            *guard = None;
        }
    }

    fn recent_at(&self, hash: &str, now: Instant) -> bool {
        self.last
            .lock()
            .map(|guard| match guard.as_ref() {
                Some((h, at)) => h == hash && now - *at < DEDUP_TTL,
                None => false,
            })
            .unwrap_or(false)
    }

    fn note_at(&self, hash: &str, at: Instant) {
        if let Ok(mut guard) = self.last.lock() {
            *guard = Some((hash.to_string(), at));
        }
    }
}

/// 日志里用的 hash 前缀（完整 md5 太吵，前 8 位足够对上同一条内容）
fn hash8(hash: &str) -> &str {
    &hash[..hash.len().min(8)]
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
    /// 结构化文档内容（P1）：CF_HTML 有结构（表格/标题/列表）但无图片的文本复制，
    /// 典型来源是 Word/Excel/网页。与 Rich 同构存储（content=HTML 片段、text=纯文本），
    /// 保留结构供下游清洗/转 Markdown/表格保真使用；无结构的普通文本仍走 Text 分支。
    Doc {
        /// 原始 CF_HTML 片段（未做图片本地化——门控已排除含图片场景）
        html_fragment: String,
        /// 同一剪贴板会话里的纯文本表示（CF_UNICODETEXT）
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
// md5_hex 已移到 `crate::hashing`（内容哈希的单一实现）——之前 lan_sync 又拄了一份
// 并在注释里声明“与本函数同口径”，而智能合并完全依赖两边真的同口径。
use crate::hashing::md5_hex;
// 图片本地化已移到 `crate::html_images`（剪贴板采集与 URL 抓取两条路径共用，规则 #11）
// 本函数里只有 windows 采集路径用到；其余平台不 import 免生 unused 警告
#[cfg(target_os = "windows")]
use crate::html_images::{localize_html_images, IMG_SRC_RE};

/// 读取 bool 配置缓存（锁中毒时回退 false）
fn read_bool_cache(cache: &std::sync::RwLock<bool>) -> bool {
    cache.read().map(|g| *g).unwrap_or(false)
}

/// 监听器四项进程内缓存的**解析结果**，每项都是 `Option`。
///
/// 🔴 为什么必须有这一层：`save_config` 是按键 upsert，允许只传一个字段
/// （截图遮罩改「OCR 选字模式」就只发 `{ocr_select_mode}`）。旧写法对这四项
/// `unwrap_or(默认)`，于是那种局部报文被读成「用户把它们关了」——敏感防护、
/// 排除名单、auto_strip 的**运行中缓存当场清零**，而设置页显示的是 config 里的值、
/// 依旧亮着「开」，密码照常入历史。缓存只在启动和 save_config 时刷新，
/// 所以这个静默失效会一路带到下次全量保存或重启。
///
/// 启动路径（`lib.rs`）与保存路径共用这一个解析函数，缺省值只在那一处写。
/// 规则 #11.1：以后加第五项隐私开关，只需在这里加一个字段——
/// 两处调用点都拿的是结构体，不会有人新写一个 `unwrap_or` 走错。
#[derive(Debug, PartialEq, Eq, Default)]
pub(crate) struct MonitorCachePatch {
    pub auto_strip: Option<bool>,
    pub skip_sensitive: Option<bool>,
    pub excluded_apps: Option<Vec<String>>,
    pub doc_capture: Option<bool>,
}

fn bool_flag(cfg: &serde_json::Value, key: &str) -> Option<bool> {
    cfg.get(key).and_then(|v| v.as_bool())
}

/// 排除名单是逗号分隔串。传空串 = 用户清空了名单（要刷成空），
/// 没带这个键 = 别处的局部报文，不动缓存。
fn excluded_apps_list(cfg: &serde_json::Value) -> Option<Vec<String>> {
    cfg.get("excluded_apps").and_then(|v| v.as_str()).map(|s| {
        s.split(',')
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect()
    })
}

/// 从一份（可能是局部的）config 报文里算出该刷新哪些缓存。
pub(crate) fn cache_patch_from(cfg: &serde_json::Value) -> MonitorCachePatch {
    MonitorCachePatch {
        auto_strip: bool_flag(cfg, "auto_strip"),
        skip_sensitive: bool_flag(cfg, "skip_sensitive"),
        excluded_apps: excluded_apps_list(cfg),
        doc_capture: bool_flag(cfg, "doc_capture"),
    }
}

/// 修复 U36：判断文本是否应按敏感内容跳过记录（两条监听路径共用）
fn should_skip_sensitive_with(skip_cache: &std::sync::RwLock<bool>, text: &str) -> bool {
    // 🔴 自有凭证无条件跳过，**不看用户开关**，且必须在开关判断之前。
    //
    // 把我们自己发给用户的 MCP 令牌 / 局域网配对密钥记进历史，从来不是用户
    // 「选择」要记的东西——而 `is_secret` 根本认不出它们（详见 `secret_registry`
    // 头部：43 字符令牌过不了那个 `len % 4 == 0` 的卡）。
    //
    // 放在这个共用函数里 = 五条记录路径（text / rich / doc / doc-html / 轮询）
    // 自动全覆盖，以后加新路径也不会漏。
    if crate::secret_registry::is_own_secret(text) {
        return true;
    }
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
    /// P1 文档采集：缓存"结构化文本复制保留 CF_HTML"开关（默认开启，设置键 doc_capture）
    cached_doc_capture: Arc<std::sync::RwLock<bool>>,
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
            // P1 文档采集：默认开启（与前端 DEFAULT_CONFIG 的 doc_capture 对齐）
            cached_doc_capture: Arc::new(std::sync::RwLock::new(true)),
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

    /// 修复 U36：更新敏感内容防护总闸缓存（由前端保存配置后调用）。
    ///
    /// ❗ 与排除名单**各自一个 setter**：合成一个 `update(两值)` 的话，
    /// 报文只带来其中一个时，另一个没有可信来源，调用方只能瞎填默认值——
    /// 那正是「局部 save_config 把隐私开关静默清零」的成因（见 `commands/history.rs` 的 `monitor_cache_patch`）。
    pub fn update_skip_sensitive_cache(&self, enabled: bool) {
        if let Ok(mut guard) = self.cached_skip_sensitive.write() {
            *guard = enabled;
        }
    }

    /// 修复 U36：更新应用排除名单缓存（由前端保存配置后调用）
    pub fn update_excluded_apps_cache(&self, apps: Vec<String>) {
        if let Ok(mut guard) = self.cached_excluded_apps.write() {
            *guard = apps;
        }
    }

    /// P1 文档采集：更新"结构化文本保留 CF_HTML"开关缓存（由前端保存配置后调用）
    pub fn update_doc_capture_cache(&self, enabled: bool) {
        if let Ok(mut guard) = self.cached_doc_capture.write() {
            *guard = enabled;
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
        // 而 spawn 出两个监听线程（各持独立 CaptureDedup → 图片/文件重复入库）
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
        let doc_capture_cache = self.cached_doc_capture.clone();
        #[cfg(target_os = "windows")]
        let thread_id_slot = self.listener_thread_id.clone();

        #[cfg(target_os = "windows")]
        {
            std::thread::spawn(move || {
                run_event_listener(
                    running,
                    app_handle,
                    ListenerShared {
                        paste_suppress,
                        auto_strip_cache,
                        sensitive_cache,
                        excluded_cache,
                        doc_capture_cache,
                        thread_id_slot,
                    },
                );
            });
        }

        // 轮询兜底是「桌面非 Windows」专属（macOS/Linux 无剪贴板消息）；
        // mobile 不采集系统剪贴板，不编译。
        #[cfg(all(desktop, not(target_os = "windows")))]
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

/// 监听线程要用的一整套共享状态。
///
/// 里面有三项都是 `Arc<RwLock<bool>>`（auto_strip / sensitive / doc_capture）——
/// 位置参数下顺序写反编译器**不会报错**，只会静默用错配置。收成结构体后按名字赋值。
#[cfg(target_os = "windows")]
struct ListenerShared {
    paste_suppress: Arc<PasteSuppress>,
    auto_strip_cache: Arc<std::sync::RwLock<bool>>,
    sensitive_cache: Arc<std::sync::RwLock<bool>>,
    excluded_cache: Arc<std::sync::RwLock<Vec<String>>>,
    doc_capture_cache: Arc<std::sync::RwLock<bool>>,
    thread_id_slot: Arc<Mutex<Option<u32>>>,
}

/// 监听线程主体：消息-only 窗口 + 剪贴板格式监听 + 防抖/兜底定时器
#[cfg(target_os = "windows")]
fn run_event_listener(running: Arc<AtomicBool>, app_handle: AppHandle, shared: ListenerShared) {
    let ListenerShared {
        paste_suppress,
        auto_strip_cache,
        sensitive_cache,
        excluded_cache,
        doc_capture_cache,
        thread_id_slot,
    } = shared;
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
                worker_loop(
                    &queue,
                    &running,
                    &app_handle,
                    &sensitive_cache,
                    &excluded_cache,
                );
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

        // 采集去重状态：**不**以当前剪贴板内容作为基线（P1，见 docs/复制未入库诊断与
        // 方案-2026-09-28.md §2.0）。旧做法在每次监听线程启动（含托盘「暂停记录→恢复
        // 记录」）时把剪贴板上躺着的内容标记为已采，而那条内容其实并没有落库 —— 于是
        // 用户之后复制它一次都不进，直到内容变化。宁可让阶段 2 的智能合并多兜一次。
        let dedup = CaptureDedup::new();
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
                            &dedup,
                            &paste_suppress,
                            &auto_strip_cache,
                            &doc_capture_cache,
                            &queue,
                            &app_handle,
                        );
                        advance_seq(
                            GetClipboardSequenceNumber(),
                            ok,
                            &mut last_seq,
                            &mut fail_streak,
                        );
                    } else if timer_id == TIMER_FALLBACK {
                        // 兜底：序列号变化但未经过防抖路径（丢通知/读取失败重试）时补读
                        let seq = GetClipboardSequenceNumber();
                        if seq != last_seq {
                            let ok = stage1_capture(
                                &mut clipboard,
                                &dedup,
                                &paste_suppress,
                                &auto_strip_cache,
                                &doc_capture_cache,
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
    dedup: &CaptureDedup,
    paste_suppress: &PasteSuppress,
    auto_strip_cache: &std::sync::RwLock<bool>,
    doc_capture_cache: &std::sync::RwLock<bool>,
    queue: &CaptureQueue,
    app_handle: &AppHandle,
) -> bool {
    // 竞争闸（写入线程持有剪贴板的临界区）内：不读剪贴板。
    // 读了再判断是白抢一次全局互斥的 OpenClipboard，与写入线程并发时一方报
    // os error 1418（截图完成复制失败的根源；微信截图无监听线程所以没有此竞争）。
    //
    // 🔴 这道闸只覆盖临界区（守卫 Drop 即开，上限 RACE_MAX）。它**不能**兼任身份判断：
    // 旧实现在这里挂一个 3 秒窗口，把「粘贴后 3 秒内的任意一次复制」整批静默吞掉，
    // 还架空了下面各分支里的 U57 hash 判据。身份判断走 `PasteSuppress::own_write_reason`。
    if paste_suppress.in_race() {
        log::info!("[ClipboardMonitor] 跳过采集 reason=self_paste_race kind=all");
        return true;
    }

    // CF_HTML 只读一次，供 rich 分支与 doc 门控复用（避免竞态窗口与重复 I/O）
    let html_fragment_opt = get_clipboard_html();

    // ── 图文混排富文本（CF_HTML 且同时含图与文）──
    // 必须放在纯文本分支之前判断：否则下面的文本分支会先把它当普通文本采集掉。
    //
    // 两道门槛缺一不可，分别拦两类误判：
    // 1. has_image：绝大多数复制（哪怕只选中一个词）源应用也会顺手写 CF_HTML，
    //    不拦会把普通文本全误判成富文本；
    // 2. has_text：企业微信/浏览器复制纯图片时也会写 CF_HTML，内容就是单个 <img>，
    //    不拦会把纯图片全误判成图文（实测踩过这个）。
    if let Some(fragment) = html_fragment_opt.as_deref() {
        if html_fragment_has_image(fragment) && html_fragment_has_text(fragment) {
            // 图文混排需先把片段内联图片落地到本地（依赖应用数据目录）。
            // 目录不可用时降级为下方纯文本分支，避免把图片写到 CWD（unwrap_or_default 的空路径）。
            if let Ok(app_dir) = app_handle.path().app_data_dir() {
                let images_dir = app_dir.join("images");
                let (rewritten, _saved_images) = localize_html_images(fragment, &images_dir);

                // 同一剪贴板会话里通常还有 CF_UNICODETEXT，优先直接复用作为纯文本表示；
                // 少数应用（如"仅复制带标题的图片"场景）可能不写这个格式，
                // 若为空则用片段自身去标签后的文字作为保底，避免卡片标题空白、搜索也搜不到
                let mut plain_text = clipboard.get_text().unwrap_or_default();
                if plain_text.trim().is_empty() {
                    plain_text = html_fragment_to_plain_text_fallback(&rewritten);
                }

                let hash = md5_hex(rewritten.as_bytes());

                if own_write_skip(paste_suppress, &[&hash], "rich", WriteKind::Rich) {
                    return true;
                }

                if dedup.is_recent(&hash) {
                    log::info!(
                        "[ClipboardMonitor] 跳过采集 reason=dedup kind=rich hash8={}",
                        hash8(&hash)
                    );
                    return true;
                }
                dedup.note(&hash);

                let (title, exe_path) = capture_foreground_source(app_handle);
                queue.push(CapturedItem::Rich {
                    html_fragment: rewritten,
                    plain_text,
                    hash,
                    title,
                    exe_path,
                    time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                });
                return true;
            } else {
                log::warn!("[ClipboardMonitor] 获取应用数据目录失败，图文富文本降级为纯文本采集");
            }
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
                dedup.clear();
                return true;
            }

            let text_hash = md5_hex(text.as_bytes());

            // ── P1 文档门控 ──
            // 从 Word/Excel/网页复制的"有结构文本"（表格/标题/列表），剪贴板上同时有
            // CF_HTML；此前只存纯文本，结构在入库前就丢了，下游无法做清洗/转 Markdown/
            // 表格保真。这里探测到结构片段就改走 Doc 分支保留 HTML。
            // 无结构的普通复制（聊天、记事本等）detect_doc_fragment 返回 false，行为不变。
            let doc_fragment: Option<String> = if read_bool_cache(doc_capture_cache) {
                html_fragment_opt
                    .as_deref()
                    .filter(|fragment| detect_doc_fragment(fragment, &text))
                    .map(|s| s.to_string())
            } else {
                None
            };
            // Doc 条目 hash 按 HTML 片段计（与 rich 口径一致，去重粒度=结构内容）
            let hash = match &doc_fragment {
                Some(fragment) => md5_hex(fragment.as_bytes()),
                None => text_hash.clone(),
            };

            // 自粘贴抑制：Doc 条目带「片段 hash + 纯文本 hash」两个口径，命中任一即算自己
            // 刚写的；时间窗口只兜「写入方说不清内容」的路径（见 own_write_reason）
            if own_write_skip(
                paste_suppress,
                &[&hash, &text_hash],
                "text/doc",
                WriteKind::Text,
            ) {
                return true;
            }

            if dedup.is_recent(&hash) {
                log::info!(
                    "[ClipboardMonitor] 跳过采集 reason=dedup kind=text/doc hash8={}",
                    hash8(&hash)
                );
                return true;
            }
            dedup.note(&hash);

            let (title, exe_path) = capture_foreground_source(app_handle);
            let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            match doc_fragment {
                Some(fragment) => queue.push(CapturedItem::Doc {
                    html_fragment: fragment,
                    plain_text: text,
                    hash,
                    title,
                    exe_path,
                    time: now_str,
                }),
                None => queue.push(CapturedItem::Text {
                    text,
                    hash,
                    title,
                    exe_path,
                    time: now_str,
                }),
            }
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
                dedup.clear();
                return true;
            }

            let img_hash = md5_hex(&img.bytes);

            if own_write_skip(paste_suppress, &[&img_hash], "image", WriteKind::Image) {
                return true;
            }

            if dedup.is_recent(&img_hash) {
                log::info!(
                    "[ClipboardMonitor] 跳过采集 reason=dedup kind=image hash8={}",
                    hash8(&img_hash)
                );
                return true;
            }
            dedup.note(&img_hash);

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
        // hash 口径与写入方共用 files_clipboard_hash（旧实现在这里没有任何自粘贴判定，
        // 全靠阶段 1 顶部的无差别时间早退兜着 —— 那道闸已经缩成竞争闸，必须自己认）
        let hash = files_clipboard_hash(&files);
        if own_write_skip(paste_suppress, &[&hash], "file", WriteKind::Files) {
            return true;
        }
        if dedup.is_recent(&hash) {
            log::info!(
                "[ClipboardMonitor] 跳过采集 reason=dedup kind=file hash8={}",
                hash8(&hash)
            );
            return true;
        }
        dedup.note(&hash);
        let (title, exe_path) = capture_foreground_source(app_handle);
        queue.push(CapturedItem::Files {
            paths: files,
            title,
            exe_path,
            time: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        });
        return true;
    }

    // 无可读内容：文本读取成功（剪贴板确实为空/仅含不支持格式）记为成功；
    // 文本读取失败则返回 false，由兜底定时器重试
    dedup.clear();
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
                CaptureMeta {
                    source_title: title,
                    exe_path,
                    now_str: time,
                },
            ),
            CapturedItem::Image {
                rgba,
                width,
                height,
                hash,
                title,
                exe_path,
                time,
            } => process_image(
                app_handle,
                rgba,
                width,
                height,
                hash,
                CaptureMeta {
                    source_title: title,
                    exe_path,
                    now_str: time,
                },
            ),
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
                CaptureMeta {
                    source_title: title,
                    exe_path,
                    now_str: time,
                },
            ),
            CapturedItem::Doc {
                html_fragment,
                plain_text,
                hash,
                title,
                exe_path,
                time,
            } => process_doc(
                app_handle,
                sensitive_cache,
                excluded_cache,
                html_fragment,
                plain_text,
                hash,
                CaptureMeta {
                    source_title: title,
                    exe_path,
                    now_str: time,
                },
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

/// 一条采集内容的来源元信息：文本 / 图片 / 富文本 / 文档四条处理路径都要它。
///
/// 三项类型相近（`String` / `Option<PathBuf>` / `String`），散在参数表尾**极易传错顺序**；
/// 收成结构体后由调用点说明每个值是什么。函数内首行解构，故正文完全不用改。
#[cfg(target_os = "windows")]
struct CaptureMeta {
    source_title: String,
    exe_path: Option<PathBuf>,
    now_str: String,
}

/// 处理捕获的文本条目（逻辑与轮询版一致：U36 过滤 → 智能合并 → 入库 → 自动标签 → 推送 → LAN）
#[cfg(target_os = "windows")]
fn process_text(
    app_handle: &AppHandle,
    sensitive_cache: &std::sync::RwLock<bool>,
    excluded_cache: &std::sync::RwLock<Vec<String>>,
    text: String,
    hash: String,
    meta: CaptureMeta,
) {
    let CaptureMeta {
        source_title,
        exe_path,
        now_str,
    } = meta;
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
        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认", "text") {
            // 找到重复内容，只更新时间戳（不创建新记录）
            existing_id = Some(existing.id.clone());
            if let Err(e) = store.update_history_time(&existing.id, &now_str, TimeBump::Recapture) {
                log::warn!("[ClipboardMonitor] 更新重复记录时间失败: {}", e);
            } else {
                log::info!("[ClipboardMonitor] 智能合并重复文本 (id={})", existing.id);
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
            ocr_text: None,
            barcodes: None,
            tags: Vec::new(),
        };

        // 插入数据库
        if let Some(ref store) = store {
            if let Err(e) = store.insert_history(&item) {
                log::error!("[ClipboardMonitor] 插入失败: {}", e);
            }
        }

        // 自动标签写入：发送到 channel，单 worker 顺序消化（突发不丢）
        enqueue_auto_tags(app_handle.clone(), item.id.clone(), labels.clone());

        // 推送事件到前端
        if let Err(e) =
            app_handle.emit("clipboard-changed", ClipboardChanged { item: item.clone() })
        {
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
    meta: CaptureMeta,
) {
    let CaptureMeta {
        source_title,
        exe_path,
        now_str,
    } = meta;
    // 保存图片到磁盘
    let app_dir = match app_handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            // 目录不可用则跳过本次图片保存（不写 CWD），避免数据落到错误位置
            log::error!(
                "[ClipboardMonitor] 获取应用数据目录失败 (跳过此次图片保存): {}",
                e
            );
            return;
        }
    };
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
        // 注意：临时文件扩展名以 .tmp 结尾，save() 按扩展名推断格式会因 .tmp 无法识别而
        // 必然失败（导致图片永不入库），故必须用 save_with_format 显式指定 PNG 编码。
        // 临时名/收尾走 atomic_write：旧写法 `<hash>.png.tmp` 把内容哈希当成临时名，
        // 而上面这条注释自己就承认“双 timer 触发”会发生 —— 两个 timer 拿到同一张图就撞同一个 tmp。
        let tmp_path = crate::atomic_write::unique_tmp_path(&img_path);
        if let Err(e) = dyn_img.save_with_format(&tmp_path, image::ImageFormat::Png) {
            // 修复 M4：保存失败即中止，不再插入指向不存在文件的历史记录
            log::error!(
                "[ClipboardMonitor] 保存图片失败 ({}): {}，跳过本条记录",
                tmp_path.display(),
                e
            );
            return;
        }
        if let Err(e) = crate::atomic_write::finish_rename(&tmp_path, &img_path) {
            log::error!(
                "[ClipboardMonitor] 重命名临时图片失败 ({} → {}): {}",
                tmp_path.display(),
                img_path.display(),
                e
            );
            return;
        }
    }

    let source_icon = extract_source_icon(app_handle, &exe_path);

    // 智能合并：同一张图片重复复制（截图后再次 Ctrl+C / 拖拽重触发）只更新一次时间，
    // 不新建记录（此前 image 分支完全不去重，与 rich 同款欠账）
    let store = app_handle.try_state::<DataStore>();
    if let Some(ref store) = store {
        if let Ok(Some(existing)) = store.find_latest_by_md5(&img_hash, "默认", "image") {
            if let Err(e) = store.update_history_time(&existing.id, &now_str, TimeBump::Recapture) {
                log::warn!("[ClipboardMonitor] 更新重复图片时间失败: {}", e);
            } else {
                log::info!("[ClipboardMonitor] 智能合并重复图片 (id={})", existing.id);
            }
            // V4 截图记忆：重复图片也补 OCR 摘要（语义检索可命中"那张图的字"）
            ensure_image_ocr_memory(store, &existing.id, &img_path);
            let updated_item = HistoryItem {
                time: now_str.clone(),
                source: source_title.clone(),
                source_icon: source_icon.clone(),
                group_id: existing.group_id.clone(),
                ..existing
            };
            if let Err(e) =
                app_handle.emit("clipboard-changed", ClipboardChanged { item: updated_item })
            {
                log::warn!("[ClipboardMonitor] 推送图片合并事件失败: {}", e);
            }
            return;
        }
    }

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
        ocr_text: None,
        barcodes: None,
        tags: Vec::new(),
    };

    if let Some(store) = app_handle.try_state::<DataStore>() {
        if let Err(e) = store.insert_history(&item) {
            log::error!("[ClipboardMonitor] 插入图片记录失败: {}", e);
        } else {
            // V4 截图记忆：图片有 OCR 缓存 → 写摘要进内容记忆（语义检索可命中）
            ensure_image_ocr_memory(&store, &item.id, &img_path);
        }
    }
    if let Err(e) = app_handle.emit("clipboard-changed", ClipboardChanged { item: item.clone() }) {
        log::warn!("[ClipboardMonitor] 推送图片事件失败: {}", e);
    }

    // LAN 同步：发送图片到局域网
    if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
        let img_path_str = img_path.to_string_lossy().to_string();
        lan_sync.send_item("image", &format!("[图片] {}", img_path_str), &img_path_str);
    }
}

/// V4 截图记忆：图片入库时若已有 OCR 缓存（截图标注识别过），把识别全文写入
/// 内容记忆摘要，使语义检索（"那张图的字"）能命中图片记录。失败仅 warn，不阻断采集。
#[cfg(target_os = "windows")]
fn ensure_image_ocr_memory(
    store: &crate::data_store::DataStore,
    history_id: &str,
    img_path: &std::path::Path,
) {
    let path_str = img_path.to_string_lossy().to_string();
    match store.get_ocr_text(&path_str) {
        Ok(Some(text)) if !text.is_empty() => {
            if let Err(e) = store.history_summary_ensure(history_id, &text) {
                log::warn!("[ClipboardMonitor] 图片 OCR 记忆写入失败: {}", e);
            }
        }
        _ => {}
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
    meta: CaptureMeta,
) {
    let CaptureMeta {
        source_title,
        exe_path,
        now_str,
    } = meta;
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

    // 智能合并：检查是否已存在相同 md5 的富文本记录（同 process_text/process_doc 的做法，
    // 避免同一图文在应用间反复复制时创建多条历史记录——此前该路径完全不去重，
    // 删除后再次复制又会冒出新记录）
    let store = app_handle.try_state::<DataStore>();
    if let Some(ref store) = store {
        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认", "rich") {
            if let Err(e) = store.update_history_time(&existing.id, &now_str, TimeBump::Recapture) {
                log::warn!("[ClipboardMonitor] 更新重复富文本时间失败: {}", e);
            } else {
                log::info!("[ClipboardMonitor] 智能合并重复富文本 (id={})", existing.id);
            }
            let updated_item = HistoryItem {
                time: now_str.clone(),
                source: source_title.clone(),
                source_icon: source_icon.clone(),
                group_id: existing.group_id.clone(),
                ..existing
            };
            if let Err(e) =
                app_handle.emit("clipboard-changed", ClipboardChanged { item: updated_item })
            {
                log::warn!("[ClipboardMonitor] 推送富文本合并事件失败: {}", e);
            }
            return;
        }
    }

    let pinyin_initials = compute_pinyin_initials(&plain_text);
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
        ocr_text: None,
        barcodes: None,
        tags: Vec::new(),
    };

    if let Some(ref store) = store {
        if let Err(e) = store.insert_history(&item) {
            log::error!("[ClipboardMonitor] 插入富文本记录失败: {}", e);
            return;
        }
    }

    // 打上「图文」自动标签（同 process_text 的做法）。
    // 类型标识必须走标签体系，不能只在卡片上画个写死的徽标：
    // 标签才能点击筛选、才会出现在筛选标签列表里、才能被用户统一管理。
    enqueue_auto_tags(
        app_handle.clone(),
        item.id.clone(),
        vec!["图文".to_string()],
    );

    if let Err(e) = app_handle.emit("clipboard-changed", ClipboardChanged { item: item.clone() }) {
        log::warn!("[ClipboardMonitor] 推送富文本事件失败: {}", e);
    }

    // 局域网同步：富文本内嵌图片文件暂无传输机制，阶段1 先不同步（避免对端收到
    // 指向本地不存在路径的断链图片），后续阶段再补
}

/// 处理捕获的文档条目（P1：Word/Excel/网页等"有结构无图片"的文本复制）。
/// 模板同 process_rich，两处差异：① type/content_type 为 "doc"；
/// ② 对纯文本副本跑分类器派生自动标签（链接/代码/邮箱等），另加"文档"类型标签。
#[cfg(target_os = "windows")]
fn process_doc(
    app_handle: &AppHandle,
    sensitive_cache: &std::sync::RwLock<bool>,
    excluded_cache: &std::sync::RwLock<Vec<String>>,
    html_fragment: String,
    plain_text: String,
    hash: String,
    meta: CaptureMeta,
) {
    let CaptureMeta {
        source_title,
        exe_path,
        now_str,
    } = meta;
    // 与 process_text/process_rich 一致：排除名单应用 / 敏感内容不入库
    // （敏感检测作用于纯文本副本——HTML 里同样可能携带密钥模式）
    if is_excluded_app_with(excluded_cache, &source_title) {
        log::info!(
            "[ClipboardMonitor] 跳过敏感内容（文档）：来源应用 \"{}\" 在排除名单内",
            source_title
        );
        return;
    }
    if should_skip_sensitive_with(sensitive_cache, &plain_text) {
        log::info!("[ClipboardMonitor] 跳过敏感内容（文档）：匹配密钥/凭据模式，不记录");
        return;
    }
    // 敏感检测也作用于 HTML 片段——属性值（href 里的 api_key、data-token 等）
    // 不会出现在纯文本副本中，需要单独检查
    if should_skip_sensitive_with(sensitive_cache, &html_fragment) {
        log::info!("[ClipboardMonitor] 跳过敏感内容（文档·HTML 属性）：匹配密钥/凭据模式，不记录");
        return;
    }

    let source_icon = extract_source_icon(app_handle, &exe_path);

    // 智能合并：检查是否已存在相同 md5 的文档记录（同 process_text 的做法，
    // 避免重复复制同一文档创建多条历史记录）
    let store = app_handle.try_state::<DataStore>();
    if let Some(ref store) = store {
        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认", "doc") {
            if let Err(e) = store.update_history_time(&existing.id, &now_str, TimeBump::Recapture) {
                log::warn!("[ClipboardMonitor] 更新重复文档时间失败: {}", e);
            } else {
                log::info!("[ClipboardMonitor] 智能合并重复文档 (id={})", existing.id);
            }
            let updated_item = HistoryItem {
                time: now_str,
                source: source_title.clone(),
                source_icon: source_icon.clone(),
                group_id: existing.group_id.clone(),
                ..existing
            };
            if let Err(e) =
                app_handle.emit("clipboard-changed", ClipboardChanged { item: updated_item })
            {
                log::warn!("[ClipboardMonitor] 推送合并事件失败: {}", e);
            }
            return;
        }
    }

    // 没有找到重复记录，创建新记录
    let pinyin_initials = compute_pinyin_initials(&plain_text);

    // 统一分类：一次 classify() 派生自动标签（纯文本副本），
    // 再补一个类型标签"文档"（同 rich 补"图文"的做法，走标签体系便于筛选）
    let mut labels = ContentClassifier::new().classify(&plain_text);
    labels.push("文档".to_string());

    let item = HistoryItem {
        id: Uuid::new_v4().to_string(),
        text: plain_text,
        time: now_str,
        item_type: "doc".to_string(),
        content: html_fragment,
        pinned: false,
        source: source_title,
        workspace: "默认".to_string(),
        md5: Some(hash),
        pinyin_initials: Some(pinyin_initials),
        group_id: None,
        source_icon,
        content_type: Some("doc".to_string()),
        ocr_text: None,
        barcodes: None,
        tags: Vec::new(),
    };

    if let Some(ref store) = store {
        if let Err(e) = store.insert_history(&item) {
            log::error!("[ClipboardMonitor] 插入文档记录失败: {}", e);
            return;
        }
    }

    enqueue_auto_tags(app_handle.clone(), item.id.clone(), labels);

    if let Err(e) = app_handle.emit("clipboard-changed", ClipboardChanged { item: item.clone() }) {
        log::warn!("[ClipboardMonitor] 推送文档事件失败: {}", e);
    }

    // 局域网同步：与 rich 一致，阶段1 先不同步（HTML 片段体积大且对端暂无渲染链路）
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

        // 智能合并：同一文件路径重复复制只更新时间、不新建记录
        // （此前 files 分支完全不去重，与 rich/image 同款欠账）
        let store = app_handle.try_state::<DataStore>();
        if let Some(ref store) = store {
            if let Ok(Some(existing)) = store.find_latest_by_md5(&file_hash, "默认", "file") {
                if let Err(e) =
                    store.update_history_time(&existing.id, &now_str, TimeBump::Recapture)
                {
                    log::warn!("[ClipboardMonitor] 更新重复文件时间失败: {}", e);
                } else {
                    log::info!("[ClipboardMonitor] 智能合并重复文件 (id={})", existing.id);
                }
                let updated_item = HistoryItem {
                    time: now_str.clone(),
                    source: source_title.clone(),
                    source_icon: source_icon.clone(),
                    group_id: existing.group_id.clone(),
                    ..existing
                };
                if let Err(e) =
                    app_handle.emit("clipboard-changed", ClipboardChanged { item: updated_item })
                {
                    log::warn!("[ClipboardMonitor] 推送文件合并事件失败: {}", e);
                }
                // 合并命中：不新建记录，但 LAN 同步仍照发（对端更新到顶部）
                if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
                    lan_sync.send_item("file", file_path, "");
                }
                continue;
            }
        }

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
            ocr_text: None,
            barcodes: None,
            tags: Vec::new(),
        };
        if let Some(ref store) = store {
            if let Err(e) = store.insert_history(&item) {
                log::error!("[ClipboardMonitor] 插入文件记录失败: {}", e);
            }
        }
        if let Err(e) =
            app_handle.emit("clipboard-changed", ClipboardChanged { item: item.clone() })
        {
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

#[cfg(all(desktop, not(target_os = "windows")))]
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

    // 采集去重状态：**不**以当前剪贴板内容作为基线（P1，理由与事件驱动路径完全一致，
    // 见 `CaptureDedup` 与 docs/复制未入库诊断与方案-2026-09-28.md §2.0）
    let dedup = CaptureDedup::new();
    let poll_interval = Duration::from_millis(400);

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
                    dedup.clear();
                    continue;
                }

                let hash = md5_hex(text.as_bytes());

                // 自粘贴抑制：与 Windows 事件路径共用同一判定（规则 11.1）。
                // 轮询路径没有「写入线程持有剪贴板」的临界区可让守卫覆盖，因此它只走
                // hash + 类别窗口两道判据，不受竞争闸影响。
                if own_write_skip(&paste_suppress, &[&hash], "text", WriteKind::Text) {
                    continue;
                }

                if !dedup.is_recent(&hash) {
                    dedup.note(&hash);

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
                        if let Ok(Some(existing)) = store.find_latest_by_md5(&hash, "默认", "text")
                        {
                            existing_id = Some(existing.id.clone());
                            if let Err(e) = store.update_history_time(
                                &existing.id,
                                &now_str,
                                TimeBump::Recapture,
                            ) {
                                log::warn!("[ClipboardMonitor] 更新重复记录时间失败: {}", e);
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
                            ocr_text: None,
                            barcodes: None,
                        };

                        if let Some(ref store) = store {
                            if let Err(e) = store.insert_history(&item) {
                                log::error!("[ClipboardMonitor] 插入失败: {}", e);
                            }
                        }

                        // 自动标签写入：发送到 channel，单 worker 顺序消化（突发不丢）
                        enqueue_auto_tags(app_handle.clone(), item.id.clone(), labels.clone());

                        if let Err(e) = app_handle
                            .emit("clipboard-changed", ClipboardChanged { item: item.clone() })
                        {
                            log::warn!("[ClipboardMonitor] 推送文本事件失败: {}", e);
                        }

                        if let Some(lan_sync) = app_handle.try_state::<crate::lan_sync::LanSync>() {
                            lan_sync.send(&text);
                        }
                    }
                }
            }
            _ => {
                // 注意：重构前此分支还会探测图片（跨平台）与文件（Windows）。
                // 本项目仅发布 Windows（事件驱动路径已完整覆盖三类内容），
                // 此兜底分支只保留文本轮询以保证跨平台可编译。
                dedup.clear();
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

/// P1 文档结构门控：判断 CF_HTML 片段是否为值得保留 HTML 的"结构化文档"。
/// 纯函数、不依赖剪贴板，可单测。
///
/// 三个条件（全部满足才命中）：
/// 1. 片段字节数 ≤ 200KB —— 控制存储膨胀，超大片段宁可只存纯文本；
/// 2. 含结构标签：表格/标题/列表是强信号，单独即可；链接是弱信号，
///    需要剪贴板纯文本足够长才计入——否则聊天短句里带一个链接会被误判；
/// 3. 片段去标签后的文本与剪贴板纯文本大致一致，防止个别应用写出的
///    怪异 CF_HTML（内容与纯文本对不上）被当文档入库。
#[cfg(target_os = "windows")]
fn detect_doc_fragment(fragment: &str, plain_text: &str) -> bool {
    const MAX_FRAGMENT_BYTES: usize = 200 * 1024;
    if fragment.len() > MAX_FRAGMENT_BYTES {
        return false;
    }

    let lower = fragment.to_lowercase();
    let has_table = lower.contains("<table");
    let has_heading = (1..=6u32).any(|n| lower.contains(&format!("<h{}", n)));
    // <li 后须跟非字母字符，排除 <link（Outlook CF_HTML 偶尔内联 link 标签）
    let has_list = lower.contains("<ul")
        || lower.contains("<ol")
        || lower.contains("<li>")
        || lower.contains("<li ")
        || lower.contains("<li\t")
        || lower.contains("<li\n")
        || lower.contains("<li\r");
    let has_link = lower.contains("<a ")
        || lower.contains("<a\t")
        || lower.contains("<a\n")
        || lower.contains("<a\r");

    let strong = has_table || has_heading || has_list;
    let weak_link = has_link && plain_text.chars().count() >= 50;
    if !strong && !weak_link {
        return false;
    }

    let stripped = html_fragment_to_plain_text_fallback(fragment);
    if strong {
        // 强信号：只要去标签后有文字就通过。Word CF_HTML 的 mso 噪声导致
        // 去标签文本与 CF_UNICODETEXT 可能有细微差异（多 span/多余空格），
        // 不该因此把结构化文档降级为纯文本。
        return !stripped.is_empty();
    }
    // 弱信号（仅链接+长文本）：须文本一致性验证，防止短文本误判
    text_substantially_matches(&stripped, plain_text)
}

/// 粗粒度判断两段文本是否"大致同一内容"：去掉全部空白后，短者长度需达到
/// 长者的 50%，且短者开头一段须出现在长者中（doc 门控用，防怪异 CF_HTML 入库）
#[cfg(target_os = "windows")]
fn text_substantially_matches(a: &str, b: &str) -> bool {
    let na: String = a.chars().filter(|c| !c.is_whitespace()).collect();
    let nb: String = b.chars().filter(|c| !c.is_whitespace()).collect();
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    let (long, short) = if na.len() >= nb.len() {
        (na.as_str(), nb.as_str())
    } else {
        (nb.as_str(), na.as_str())
    };
    if (short.len() as f64) / (long.len() as f64) < 0.5 {
        return false;
    }
    // 双端验证：短者前 32 字符 + 后 16 字符都须出现在长者中（按字符边界切）
    let head_len = short
        .char_indices()
        .nth(32)
        .map(|(i, _)| i)
        .unwrap_or(short.len());
    if !long.contains(&short[..head_len]) {
        return false;
    }
    let tail_start = {
        let total = short.chars().count();
        if total <= 32 {
            return true; // 短者 ≤32 字符已在前缀检查中全覆盖
        }
        let skip = total.saturating_sub(16);
        short
            .char_indices()
            .nth(skip)
            .map(|(i, _)| i)
            .unwrap_or(short.len())
    };
    long.contains(&short[tail_start..])
}

/// 极简 HTML→纯文本：去标签、解基础实体、合并空白（仅用于 CF_UNICODETEXT
/// 缺失时的展示/搜索保底，不追求完整还原——真实展示走前端富文本渲染）
static HTML_TAG_STRIP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());

/// 数字字符实体 &#NNN; / &#xHH;（用于 html_fragment_to_plain_text_fallback 补齐解码）
#[cfg(target_os = "windows")]
static NUMERIC_ENTITY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#(x?[0-9a-fA-F]+);").unwrap());

#[cfg(target_os = "windows")]
fn html_fragment_to_plain_text_fallback(fragment: &str) -> String {
    let no_tags = HTML_TAG_STRIP_RE.replace_all(fragment, " ");
    let decoded = no_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        // Word/Excel CF_HTML 常见命名实体（补齐 text_substantially_matches 一致性问题）
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&hellip;", "\u{2026}")
        .replace("&copy;", "\u{00A9}")
        .replace("&reg;", "\u{00AE}")
        .replace("&trade;", "\u{2122}")
        .replace("&rsquo;", "\u{2019}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&rdquo;", "\u{201C}")
        .replace("&ldquo;", "\u{201D}")
        .replace("&middot;", "\u{00B7}")
        .replace("&laquo;", "\u{00AB}")
        .replace("&raquo;", "\u{00BB}");
    // 数字实体 &#NNN; / &#xHH;
    let decoded = NUMERIC_ENTITY_RE.replace_all(&decoded, |caps: &regex::Captures| {
        let raw = &caps[1];
        let code = if let Some(hex) = raw.strip_prefix('x').or_else(|| raw.strip_prefix('X')) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            raw.parse::<u32>().ok()
        };
        code.and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_default()
    });
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 构造一个完整的 CF_HTML 缓冲区（Version/StartHTML/EndHTML/StartFragment/EndFragment 自引用
/// 头部 + <!--StartFragment/EndFragment--> 标记包裹的片段）。采集侧测试用来验证解析，
/// 粘贴回写侧（execute_paste_rich）用来把存下来的片段重新包装回真实剪贴板格式。
pub(crate) fn build_cf_html_buffer(fragment_inner: &str) -> Vec<u8> {
    let prefix_html = "<html><body>\r\n<!--StartFragment-->";
    let suffix_html = "<!--EndFragment-->\r\n</body></html>";
    let header_template = |start_html: usize,
                           end_html: usize,
                           start_frag: usize,
                           end_frag: usize| {
        format!(
                "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
                start_html, end_html, start_frag, end_frag
            )
    };
    let header_len = header_template(0, 0, 0, 0).len();
    let start_html = header_len;
    let start_frag = start_html + prefix_html.len();
    let end_frag = start_frag + fragment_inner.len();
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
        let end = rest.find(['\r', '\n'])?;
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

    fn hash_of(s: &str) -> String {
        md5_hex(s.as_bytes())
    }

    #[test]
    fn test_new_has_no_own_write_identity() {
        let ps = PasteSuppress::new();
        assert!(!ps.in_race());
        assert_eq!(ps.own_write_reason(&[&hash_of("x")], WriteKind::Text), None);
    }

    /// 竞争闸靠守卫配对释放，不是靠时长。
    #[test]
    fn test_guard_releases_race_on_drop() {
        let ps = PasteSuppress::new();
        let guard = ps.begin_write(WriteOpts::text("粘贴的内容"));
        assert!(ps.in_race());
        drop(guard);
        assert!(!ps.in_race());
    }

    /// 🔴 竞争闸必须有硬上限：守卫没走到 Drop（线程 panic）时，「读不到剪贴板」
    /// 不能变成永久状态；同时上限要显著大于一次剪贴板写入，否则挡不住 1418 竞争。
    #[test]
    fn test_race_window_is_bounded() {
        assert!(RACE_MAX < Duration::from_millis(2000), "{:?}", RACE_MAX);
        assert!(RACE_MAX > Duration::from_millis(50), "{:?}", RACE_MAX);
    }

    /// 🔴 本次修复的核心不变量：hash 设防期间，窗口内用户复制的**别的内容**必须照常采集。
    /// 旧实现把身份判断挂在阶段 1 顶部的 3 秒无差别早退上，这条会稳定失败。
    #[test]
    fn test_hash_mode_does_not_swallow_other_content() {
        let ps = PasteSuppress::new();
        let guard = ps.begin_write(WriteOpts::text("被粘贴的那一条"));
        assert_eq!(
            ps.own_write_reason(&[&hash_of("用户紧接着复制的新内容")], WriteKind::Text),
            None
        );
        drop(guard);
    }

    /// hash 命中 = 身份已经用上 → 整段作废，后续同窗口内的内容一律照常采集。
    /// 只清 hash 不清窗口的话，自粘贴回显之后用户复制的别的内容会被类别兜底一起吞掉。
    #[test]
    fn test_hash_hit_finishes_identity() {
        let ps = PasteSuppress::new();
        let pasted = "同一条内容";
        let guard = ps.begin_write(WriteOpts::text(pasted));
        assert_eq!(
            ps.own_write_reason(&[&hash_of(pasted)], WriteKind::Text),
            Some("self_paste_hash")
        );
        assert_eq!(
            ps.own_write_reason(&[&hash_of("别的内容")], WriteKind::Text),
            None
        );
        drop(guard);
    }

    /// 类别窗口只对写入方声明过的类别生效。图文写入会带 CF_HTML，也可能被采集端读成
    /// 纯文本，所以 rich 报备同时覆盖 Rich + Text，但与图片/文件无关。
    #[test]
    fn test_identity_window_is_kind_scoped() {
        let ps = PasteSuppress::new();
        let guard = ps.begin_write(WriteOpts::rich("<p>片段</p>"));
        assert_eq!(
            ps.own_write_reason(&[&hash_of("x")], WriteKind::Rich),
            Some("self_paste_window")
        );
        assert_eq!(
            ps.own_write_reason(&[&hash_of("y")], WriteKind::Image),
            None
        );
        assert_eq!(
            ps.own_write_reason(&[&hash_of("z")], WriteKind::Files),
            None
        );
        drop(guard);
    }

    /// 写入方说不清自己写了什么（「粘贴当前剪贴板」）→ 全部类别按时间兜底。
    #[test]
    fn test_unknown_opts_cover_all_kinds() {
        let ps = PasteSuppress::new();
        let guard = ps.begin_write(WriteOpts::unknown());
        for kind in [
            WriteKind::Rich,
            WriteKind::Text,
            WriteKind::Image,
            WriteKind::Files,
        ] {
            assert_eq!(
                ps.own_write_reason(&[&hash_of("h")], kind),
                Some("self_paste_window"),
                "类别 {:?}",
                kind
            );
        }
        drop(guard);
    }

    /// 文本报备同时覆盖原串与 trim 串：采集端是否去空白取决于用户配置，
    /// 只登记一种口径会让另一半自粘贴落到阶段 2 的智能合并。
    #[test]
    fn test_text_opts_register_both_trim_states() {
        let raw = "  带尾随空白的内容  ";
        for candidate in [raw.to_string(), raw.trim().to_string()] {
            let ps = PasteSuppress::new();
            let guard = ps.begin_write(WriteOpts::text(raw));
            assert_eq!(
                ps.own_write_reason(&[&hash_of(&candidate)], WriteKind::Text),
                Some("self_paste_hash"),
                "口径 {:?}",
                candidate
            );
            drop(guard);
        }
    }

    /// 文件列表的 hash 口径写死成 `join("|")` 的 md5：采集端与写入端算不出同一个值，
    /// 报备就等于没做（历史上文件分支正是靠无差别时间早退掩盖了这个缺口）。
    #[test]
    fn test_files_hash_uses_shared_join_format() {
        let paths = vec!["C:\\a.txt".to_string(), "C:\\b.txt".to_string()];
        assert_eq!(
            files_clipboard_hash(&paths),
            md5_hex("C:\\a.txt|C:\\b.txt".as_bytes())
        );
    }

    /// 陈旧身份不得永久生效：窗口过期且没命中 → 作废，避免日后同内容被莫名吞掉。
    #[test]
    fn test_stale_identity_dropped_after_window_expires() {
        let ps = PasteSuppress::new();
        let guard = ps.begin_write(WriteOpts::text("a"));
        drop(guard);
        thread::sleep(IDENTITY_WINDOW + Duration::from_millis(150));
        assert_eq!(
            ps.own_write_reason(&[&hash_of("别的用户内容")], WriteKind::Text),
            None
        );
        assert!(
            !ps.has_expected(),
            "窗口过期且没命中 → 陈旧 hash 必须作废（否则同内容日后被永久拉黑）"
        );
    }

    #[test]
    fn test_begin_write_overwrites_previous_identity() {
        let ps = PasteSuppress::new();
        let g1 = ps.begin_write(WriteOpts::text("旧内容"));
        let g2 = ps.begin_write(WriteOpts::text("新内容"));
        assert_eq!(
            ps.own_write_reason(&[&hash_of("新内容")], WriteKind::Text),
            Some("self_paste_hash")
        );
        // 上一条报备已被覆盖，不该继续吞
        assert_eq!(
            ps.own_write_reason(&[&hash_of("旧内容")], WriteKind::Text),
            None
        );
        drop((g1, g2));
    }

    #[test]
    fn test_concurrent_access() {
        let ps = Arc::new(PasteSuppress::new());
        let ps2 = Arc::clone(&ps);
        let handle = thread::spawn(move || {
            let _guard = ps2.begin_write(WriteOpts::text("t"));
        });
        handle.join().unwrap();
        // 跨线程可见；线程内守卫已 Drop → 竞争闸已开，身份仍在
        assert!(!ps.in_race());
        assert_eq!(
            ps.own_write_reason(&[&hash_of("t")], WriteKind::Text),
            Some("self_paste_hash")
        );
    }

    // ── 采集去重状态测试（P1–P3 根因的守卫，见 docs/复制未入库诊断与方案-2026-09-28.md） ──

    #[test]
    fn test_dedup_ttl_is_bounded() {
        // 🔴 守卫：去重窗口必须有期限。无限期的单值基线正是「复制没进、重复制也不进、
        // 改一个字才进」的根因 —— 任何一次「跳过但没落库」都会把该内容永久拉黑。
        assert!(
            DEDUP_TTL < Duration::from_secs(5),
            "去重窗口必须短到用户不会以为「重复制没反应」"
        );
        assert!(
            DEDUP_TTL > Duration::from_millis(500),
            "去重窗口必须长到能盖住 50ms 防抖 + 1s 序列号兜底对同一次复制的二次读取"
        );
    }

    #[test]
    fn test_dedup_recent_only_inside_ttl() {
        let dedup = CaptureDedup::new();
        let t0 = Instant::now();
        dedup.note_at("aaaa", t0);
        assert!(dedup.recent_at("aaaa", t0 + Duration::from_millis(1499)));
        assert!(!dedup.recent_at("aaaa", t0 + DEDUP_TTL));
        // TTL 之后同样的内容必须重新走一遍采集流程（由阶段 2 的智能合并兜重复，
        // 表现为旧卡片移到顶部，而不是「没有任何反应」）
        assert!(!dedup.recent_at("aaaa", t0 + Duration::from_secs(3)));
    }

    #[test]
    fn test_dedup_is_single_slot_not_a_set() {
        // A → B → A：第三次复制 A 不能被「A 见过」挡住，否则用户看不到卡片置顶。
        let dedup = CaptureDedup::new();
        let t0 = Instant::now();
        dedup.note_at("a", t0);
        dedup.note_at("b", t0 + Duration::from_millis(100));
        assert!(!dedup.recent_at("a", t0 + Duration::from_millis(200)));
        assert!(dedup.recent_at("b", t0 + Duration::from_millis(200)));
    }

    #[test]
    fn test_dedup_clear_forgets() {
        // 剪贴板变空 / 只剩不可读内容时必须忘记上一份（旧行为一致）
        let dedup = CaptureDedup::new();
        dedup.note("x");
        assert!(dedup.is_recent("x"));
        dedup.clear();
        assert!(!dedup.is_recent("x"));
    }

    #[test]
    fn test_dedup_default_is_not_recent() {
        // P1 守卫：监听线程启动时不再以当前剪贴板为基线，所以「刚启动」状态下
        // 任何 hash 都不算刚采过 —— 恢复监听后的第一次复制一定会被采集。
        let dedup = CaptureDedup::new();
        assert!(!dedup.is_recent("whatever"));
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
    fn test_own_secret_skipped_even_when_switch_is_off() {
        // 🔴 这条钉的是「自有凭证不看用户开关」。
        //
        // 背景：MCP 令牌是 43 字符 base64url，`is_secret` 的通用 base64 分支要求
        // `len % 4 == 0`，43 % 4 == 3 永远不命中；它也没有任何已知前缀。
        // 所以旧路径会把用户拷走的令牌明文记进 history——而那个令牌正是
        // 用 DPAPI 加密落盘、专门避开明文存储的东西。
        //
        // 注意：登记处是**进程全局**的，而 cargo 默认并行跑测试。
        // 这个串必须与 `secret_registry` 自己的用例不同，否则那边一登记，
        // 这边的「未登记时不应跳过」就会随机红。
        let token = "mNtKzQrVwXyBcDfGhJkLpQsTvWzAbCdEfGhIjKlMnOp";
        let off = std::sync::RwLock::new(false);
        assert!(
            !should_skip_sensitive_with(&off, token),
            "未登记时不应跳过（否则证明不了是登记起的作用）"
        );

        crate::secret_registry::register(crate::secret_registry::SLOT_MCP_TOKEN, token);
        assert!(
            should_skip_sensitive_with(&off, token),
            "已登记的自有凭证必须跳过，即使「跳过敏感内容」开关是关的"
        );
        // 不相干的文本不受影响
        assert!(!should_skip_sensitive_with(&off, "今天天气不错适合出门"));
        crate::secret_registry::register(crate::secret_registry::SLOT_MCP_TOKEN, "");
    }

    #[test]
    fn test_should_skip_sensitive_with_disabled() {
        // 开关关闭时永不跳过（默认值已与前端 DEFAULT_CONFIG 对齐为 false）
        let cache = std::sync::RwLock::new(false);
        assert!(!should_skip_sensitive_with(&cache, "AKIA1234567890SECRET"));
    }

    // ── 图文混排 CF_HTML 采集测试：图片本地化（localize_*）的测试已随实现迁往 html_images.rs ──

    // ── P1 文档结构门控（detect_doc_fragment / text_substantially_matches 纯函数）──

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_word_table() {
        // Word/Excel 表格片段 + 与纯文本一致 → 命中
        let fragment =
            "<table><tr><td>姓名</td><td>年龄</td></tr><tr><td>张三</td><td>28</td></tr></table>";
        let plain = "姓名\t年龄\n张三\t28";
        assert!(detect_doc_fragment(fragment, plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_heading_and_list() {
        let fragment = "<h1>标题</h1><p>正文段落</p><ul><li>项一</li><li>项二</li></ul>";
        let plain = "标题\n正文段落\n项一\n项二";
        assert!(detect_doc_fragment(fragment, plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_plain_paragraph_rejected() {
        // 仅 <p>/<span>，无结构标签 → 不命中
        let fragment = "<p>这是一段普通文字</p><span>没有结构</span>";
        let plain = "这是一段普通文字没有结构";
        assert!(!detect_doc_fragment(fragment, plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_short_link_rejected() {
        // 链接 + 短文本 → 弱信号不达标 → 不命中
        let fragment = "<a href=\"https://example.com\">链接</a>";
        let plain = "链接";
        assert!(!detect_doc_fragment(fragment, plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_long_link_ok() {
        // 链接 + 长文本（≥50 字符），片段去标签文本与纯文本一致 → 命中
        let body = "This is a long enough sentence that exceeds fifty characters total yes it does";
        let fragment = format!("<p>{}</p><a href=\"https://example.com\">link</a>", body);
        let plain = format!("{}\nlink", body);
        assert!(detect_doc_fragment(&fragment, &plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_oversized_rejected() {
        // 超 200KB → 不命中（即使含结构标签）
        let fragment = format!("<table><tr><td>{}</td></tr></table>", "a".repeat(210_000));
        let plain = "a".repeat(210_000);
        assert!(!detect_doc_fragment(&fragment, &plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_strong_table_mismatch_ok() {
        // 强信号（表格）：即使片段文本与纯文本不匹配也命中（Word mso 噪声导致
        // 去标签文本与 CF_UNICODETEXT 有细微差异，强信号不该因此被拒）
        let fragment = "<table><tr><td>完全不同的内容</td></tr></table>";
        let plain = "这里是毫不相关的纯文本";
        assert!(detect_doc_fragment(fragment, plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_detect_doc_fragment_weak_link_mismatch_rejected() {
        // 弱信号（仅链接+长文本）：片段文本与纯文本对不上 → 不命中
        let body = "This is a long enough sentence that exceeds fifty characters total yes";
        let fragment = format!(
            "<a href=\"https://example.com\">完全不同的链接文本</a>{}",
            body
        );
        let plain = format!("{}\n{}", body, body); // 纯文本与片段内容不匹配
        assert!(!detect_doc_fragment(&fragment, &plain));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_text_substantially_matches_identical() {
        assert!(text_substantially_matches("hello world", "hello world"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_text_substantially_matches_different() {
        assert!(!text_substantially_matches(
            "hello world",
            "completely different text"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_text_substantially_matches_ratio_below_half() {
        // 短者 < 长者的 50% → false
        let short = "ab";
        let long = "abcdefghijklmnopqrstuvwxyz";
        assert!(!text_substantially_matches(short, long));
    }

    // ===== 局部 save_config 不得清零隐私缓存（P0 #1）=====
    //
    // 🔴 钉的是这条不变量：报文没带某个键 → 该项是 None（不刷新）。
    // 旧实现对四项 `unwrap_or(默认)`，于是截图遮罩那次只发 `{ocr_select_mode}`
    // 的报文被读成「用户关了敏感防护/清空的排除名单」，而设置页仍显示「开」。

    /// 只带一个无关键的局部报文（截图遮罩改 OCR 选字模式）→ 四项全 None。
    #[test]
    fn partial_payload_touches_no_privacy_cache() {
        let patch = cache_patch_from(&serde_json::json!({ "ocr_select_mode": "modifier" }));
        assert_eq!(
            patch,
            MonitorCachePatch {
                auto_strip: None,
                skip_sensitive: None,
                excluded_apps: None,
                doc_capture: None,
            }
        );
    }

    /// 全量报文（设置页那条路径）→ 四项都取值，缺省仍由调用点决定。
    #[test]
    fn full_payload_reports_every_cached_flag() {
        let patch = cache_patch_from(&serde_json::json!({
            "auto_strip": true,
            "skip_sensitive": true,
            "excluded_apps": "KeePass, 1Password",
            "doc_capture": false,
        }));
        assert_eq!(patch.auto_strip, Some(true));
        assert_eq!(patch.skip_sensitive, Some(true));
        assert_eq!(
            patch.excluded_apps,
            Some(vec!["KeePass".to_string(), "1Password".to_string()])
        );
        assert_eq!(patch.doc_capture, Some(false));
    }

    /// 空串 = 用户**清空**了名单，要刷成空表；这和「没带这个键」是两回事。
    /// 混成一件事的话，清空的名单会在下次启动时复活。
    #[test]
    fn cleared_list_is_distinct_from_absent_list() {
        assert_eq!(
            cache_patch_from(&serde_json::json!({ "excluded_apps": "" })).excluded_apps,
            Some(vec![])
        );
        assert_eq!(
            cache_patch_from(&serde_json::json!({})).excluded_apps,
            None
        );
    }

    /// 每项独立判定：敏感防护单独翻转时不得把排除名单刷成空。
    /// 这是拆掉旧 `update_sensitive_cache(两值)` 的理由。
    #[test]
    fn each_key_refreshes_only_itself() {
        let patch = cache_patch_from(&serde_json::json!({ "skip_sensitive": false }));
        assert_eq!(patch.skip_sensitive, Some(false));
        assert_eq!(patch.excluded_apps, None);
    }
}
