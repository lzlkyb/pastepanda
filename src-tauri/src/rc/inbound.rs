//! 被控端会话的两条任务：输入读取/处理、画面推流（Tier C 从 `service.rs` 拆出）。
//!
//! 拆法是「循环体类型化」而不是搬家：推流循环原来是一个 232 行函数，把「会话
//! 判定 / TTL / 心跳暂停 / 硬编优先 / JPEG 回退 / 失败收口」全部内联在三层嵌套
//! 里。现在圈起来一个 `InboundVideo` 结构体（持有 svc / 会话 id / 发送半流 /
//! 编码器 / Windows 硬编资源），每圈是一个显式的 `Step` 决策——改哪条路径、
//! 失败收不收口，一眼可见。
//!
//! 🔴 `my_id` 是 A2 修复的关键：任务启动时捕获**当时**那份会话 id，之后所有
//! 收口只按 id 命中（`force_end_if_session`），不能按 peer——否则重连后旧任务
//! 会误杀新会话（「点重连画面闪一下又断」）。
//!
//! 🔴 推流节奏（2026-09-19 重做）：旧实现「干完活再睡 interval」，每帧周期 =
//! 档位间隔 + 抓帧编码耗时，拖窗口时全帧编码最重，实际掉到 3~5fps。现在：
//! - **固定节奏**：下一帧锚在 `frame_start + interval`，编码耗时不再叠加；
//! - **输入驱动提帧**：收到键鼠事件 `boost_frame` 立刻醒过来抓一帧
//!   （`input_boost`），静止时保持慢节奏，拖动时逼近 `BOOST_GAP_MS`（16ms＝60fps）；
//! - **硬编覆盖全范围**：主屏 / 指定单屏 / 虚拟屏（多输出拼接）都走
//!   DXGI + H.264（`DxgiPool`），JPEG 只做编码器打不开或单帧失败时的兜底。
//!
//! ⚠️ 本模块的 async 方法一律取 `&mut self` 而不是 `&self`。不是随手写法：
//! async fn 的 future 会把参数（含 `&self`）持有到 future 结束，而
//! `tauri::async_runtime::spawn` 要求 `Send`——`&InboundVideo` 需要
//! `InboundVideo: Sync`（`DxgiPool` 里面是 `NonNull<c_void>`，不是），
//! `&mut InboundVideo` 只需要 `Send`（owned 的 `DxgiPool` 是）。改回
//! `&self` 会在 net.rs 的 spawn 处报「future cannot be sent」。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::input::{
    assert_control_allowed, converge_key_vk, get_clipboard_text_async, inject,
    set_clipboard_text_async,
};
use super::input::{InputEvent, capture_region};
// VideoCodec 仅 Windows 宿主编码路径使用（mobile 无推流管线）
#[cfg(target_os = "windows")]
use super::encode_h264::VideoCodec;
use super::protocol::SessionPhase;
use super::service::{
    clip_payload_ok, clip_pull_json_bytes, clip_push_json_bytes, RcService, CLIPBOARD_MAX_JSON_BYTES,
};
use crate::sync::transport::write_frame;

// 后台任务与画面能力上报已拆到 `inbound_tasks.rs`（2026-09-21）；
// 尺寸工具（primary/virtual_screen_size）也一并搬过去，这里通过下面的
// `use` 把它们拉回来，调用点保持原样。
use super::inbound_tasks::send_caps_frame;
// 尺寸工具是 Windows 宿主专属（采集坐标系），mobile 无推流管线用不到
#[cfg(target_os = "windows")]
use super::inbound_tasks::{primary_screen_size, virtual_screen_size};

/// 被控端推流任务。
pub(super) struct InboundVideo {
    pub(super) svc: Arc<RcService>,
    pub(super) peer: String,
    /// 任务启动时的会话 id；收口只认它。
    pub(super) my_id: String,
    /// 输入与画面共用的发送半流（对端收到的一切都从这里出去）。
    pub(super) send: Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
    pub(super) enc: Arc<std::sync::Mutex<super::video::EncoderState>>,
    /// 本会话连接句柄：数据报读取（鼠标低延迟通道）与 QUIC stats 采样都要用。
    pub(super) conn: iroh::endpoint::Connection,
    #[cfg(target_os = "windows")]
    pub(super) dxgi: super::dxgi::DxgiPool,
    /// R4 硬编会话；None = 不走硬编（配置 jpeg / 打不开）。
    #[cfg(target_os = "windows")]
    pub(super) h264: Option<super::encode_h264::H264SessionEncoder>,
    /// P2-9：硬编连续失败计数。每次成功清零；连续 60 帧（~4s@15fps）失败
    /// 说明编码器环境坏了（驱动卸载 / MFT 损坏），暂停硬编走 JPEG。
    /// ⚠️ 2026-09-21 起**不再是永久熔断**——见 `enc_retry_after`。
    #[cfg(target_os = "windows")]
    pub(super) enc_fail_streak: u32,
    /// 硬编熔断的冷却截止时刻（None = 未熔断）。到期自动重开硬编，
    /// 避免一次瞬态失败（分辨率切换 / 全屏 DRM / 显示器热插拔）把
    /// 7ms/帧 的硬编一路丢到会话结束。
    #[cfg(target_os = "windows")]
    pub(super) enc_retry_after: Option<std::time::Instant>,
    /// 重试退避秒数（首次 5s，每次熔断翻倍，上限 60s）。
    #[cfg(target_os = "windows")]
    pub(super) enc_retry_backoff: u64,
    /// 起播宽限截止时刻（Some = 首帧还没开过硬编，正在等）。
    ///
    /// 🔴 2026-10-03：编码器过去在 `try_new` 那一刻就按 100% 开，发起端的
    /// `SetBitratePct`（默认 200）约 0.9s 后才到 → 首帧刚出就全链重开一次
    /// （MFT/NVENC 两次初始化，重开周期内帧全丢）。现在改成：宽限内先不
    /// 开硬编，JPEG 兜底先出图；对端倍率/链路信息一到（`peer_net_seen`）
    /// 或宽限期满，才按**当前倍率**开（`open_h264` 读 `bitrate_scale`）。
    /// 这样常见路径（对端默认 200 = 本机默认 200）一次都不重开。
    /// None = 已开过（或本会话不需要，如强制 JPEG / mobile）。
    #[cfg(target_os = "windows")]
    pub(super) enc_first_open_at: Option<std::time::Instant>,
    /// P1：GPU 零拷贝路径已判定不可用（连续失败），本会话不再尝试。
    #[cfg(target_os = "windows")]
    pub(super) gpu_disabled: bool,
    /// P2-1：视频数据报发送端（帧序号 + 分片 + XOR FEC）。
    #[cfg(target_os = "windows")]
    pub(super) dgram: super::vid_dgram::VidDgramSender,
    /// 对端是否支持视频数据报（Request 帧能力位）。false = 旧版发起端：
    /// 它没有视频数据报读取任务，P 帧必须继续走可靠流，否则画面退化成
    /// 每秒一张关键帧的幻灯片。
    pub(super) peer_dgram: bool,
    /// 🔴 视频数据报放行闸（2026-10-02 两次公网实测收口）：默认 **false**（可靠流），
    /// 只有 RTT 采样到达且路径快（`video_dgram_allowed`）才进一次数据报模式。
    /// 未采样/中继路径永远可靠流——数据报在公网近乎全丢、在中继会灌爆
    /// 拥塞窗口把 pong/控制帧一起堵死，见 `stream_cfg::video_dgram_allowed` 文档。
    pub(super) dgram_allowed: bool,
    /// 「传输分 plane」（2026-10-03）：对端（Request.video_plane）支持在独立
    /// 单向流上收视频。true = H.264 帧走专属 uni 流（`PPVID1` 流头），积压
    /// 熔断可持续超阈时**整流重建**（丢弃积压），且视频写不再与 pong/输入
    /// 抢同一把发送锁；false = 旧版对端，视频留在会话半流（历史形态）。
    pub(super) peer_video_plane: bool,
    pub(super) peer_media_plane: bool,
    #[cfg(target_os = "windows")]
    pub(super) media_pipe: Option<media_pipe::MediaPipe>,
    /// 🔴 视频专属 uni 流（仅 `peer_video_plane` 时使用）：只由推流任务写，
    /// **不与任何任务共锁**——这是「视频写不再阻塞 pong」的物理基础。
    /// None = 尚未建（首帧时懒建）或刚被熔断重建丢弃（下一帧重开 + IDR）。
    /// 熔断持续起点（None = 当前不在熔断态）。持续 ≥`MELT_REBUILD_AFTER_MS`
    /// → 重建视频专属流，把旧流里的积压**整段丢弃**。
    /// 视频专属流建立/重建后置位：首帧必须等 IDR（新流上的 P 帧没有参考
    /// 基准）。关键帧写入成功后清除。❗不能用「写耗时==0」判新流——快路径
    /// 一帧本就可能 0ms。
    /// 视频专属流连续建流失败计数（≥3 → 判连接已死收口会话）。
    /// 🔴 可靠流积压熔断（2026-10-03）：可靠流没有「缓冲满」信号，写入在
    /// quinn 发送缓冲上阻塞、积压多少延迟涨多少（08:22 真机会话往返 450ms →
    /// 46s 且永不恢复，pong 被同连接的视频积压堵死）。判据与动作收口在
    /// `inbound/video.rs` 的 `melt_step`（纯函数）：写一帧的耗时就是排队水位。
    #[cfg(target_os = "windows")]
    pub(super) stream_melt: bool,
    /// 上一帧可靠流写入耗时（ms）——熔断的水位信号；0 = 尚无样本。
    #[cfg(target_os = "windows")]
    pub(super) stream_last_write_ms: u64,
    /// P3.1：对端能解 RS FEC（Request 帧能力位）。false = 走 XOR 老格式。
    pub(super) peer_fec_rs: bool,
    /// 输入提帧信号：键鼠事件到达时 `boost_frame`（notify_one，存许可），
    /// 推流循环提前醒。**别改回 notify_waiters**，理由见 `boost_frame`。
    pub(super) input_boost: Arc<tokio::sync::Notify>,
    /// 上一帧抓取起点（提帧限速用）。
    pub(super) last_frame_at: tokio::time::Instant,
    /// 对端解码断链 → 请求下一帧强制 IDR（P0-2 弱网自愈）。
    pub(super) force_key: Arc<AtomicBool>,
    /// C2：最近一次**由被控端主动**要求 IDR 的时刻（数据报弃帧触发）。
    ///
    /// 🔴 为什么必须限频：不限的话「拥塞 → 弃帧 → 立刻要 IDR → IDR 是整帧
    /// 大包、更拥塞 → 继续弃帧」会自激成 IDR 风暴，把链路彻底打死。
    /// 门限由 `crate::rc::pace::AUTO_KEY_MIN_GAP_MS` 定。
    #[cfg(target_os = "windows")]
    pub(super) auto_key_at: Option<std::time::Instant>,
    /// 最近一次发出的光标遥测（形状 + 位置 + 可见性；变化才发）。
    /// B 方案 2026-10-02：原先是 `Option<&'static str>`（只有形状）。
    pub(super) last_cursor: Option<super::input::RemoteCursor>,
    /// 上次发出光标遥测的单调毫秒；0 = 还没发过（首帧必发）。
    pub(super) last_cursor_ms: u64,
    /// 光标遥测的抓帧范围缓存（`(monitor, virtual_screen) → region`）。
    /// None = 还没算过。见 `inbound_tasks::cursor_region`。
    pub(super) cursor_region_cache: Option<((i32, bool), super::input::ScreenRegion)>,
    /// P1-7 自适应降频：档位间隔放大倍数（1~4）。编码持续跑不满档位间隔时翻倍。
    pub(super) pace_scale: u32,
    /// 单圈工作量（抓帧+编码+发送）的指数平滑，ms。
    pub(super) work_ema_ms: u64,
    /// Q8：**动帧**字节数 EMA——静止判定的稳定基线（静止时 P 帧几乎全是跳块，
    /// 极小）。只对判为「在动」的帧更新，静止期间不衰减。
    pub(super) motion_ema_bytes: u64,
    /// Q8：画面进入静止的时刻（None = 非静止）。
    pub(super) static_since: Option<std::time::Instant>,
    /// Q8：本轮静止是否已做过 IDR 精修（画面再动才重新武装）。
    pub(super) static_refined: bool,
    /// 诊断探针（2026-09-21）：分段耗时采样器 + 选型报告槽。
    /// 纯旁路——任何统计失败都不影响推流（见 `perf` 模块头注释）。
    pub(super) perf: super::perf::FrameStats,
    /// 探针暂存：本圈各分段耗时（抓屏/编码/发送，ms）与是否真的推出了一帧。
    /// 由 `try_hardware_path` / `jpeg_path` 填，`run` 在圈末一次性喂给 `perf`。
    ///
    /// 为什么用暂存而不是让两条路径直接调 `note_frame`：一份耗时同时服务
    /// 「H.264 硬编 / JPEG 兜底」两条路径、且「抓到帧」与「没抓到（屏幕未变）」
    /// 要区分——只在一个地方收口判定，比散在两处各写一遍少一个出错点。
    pub(super) perf_last: super::perf::FrameTiming,
    /// 探针：本圈硬编那条路**没有**出帧、实际走的是 JPEG 兜底
    /// （`try_hardware_path` 返回 `FallThrough` 时置位，每圈起点清零）。
    ///
    /// 为什么必须有它：`管线` 标签过去只看 `h264.is_some()`，于是「硬编对象在、
    /// 但抓屏熔断了、每帧其实编的是 JPEG」会被打成 `管线 H264`——2026-10-06 那场
    /// 整场 JPEG 就是靠这条谎报的标签把我带偏、反过来否掉了用户看到的实况。
    /// 标签必须回答「这一圈实际编了什么」，不是「本应编什么」。
    pub(super) tick_jpeg: bool,
    /// 会话防休眠守卫（设置项 `rc_keep_awake`，默认关；None = 本会话不保活）。
    ///
    /// 做成字段而不是「开始时设、结束时清」的两处调用：`run(mut self)` 的**每一条**
    /// 退出路径都会析构它——正常收口、对端断链、`force_end_if_session` 强制结束都一样，
    /// 不需要任何「记得调 release」的纪律。释放机制见 [`crate::rc::keep_awake`]。
    ///
    /// 🔴 前缀下划线是刻意的：这个字段**没有任何读取点**，它的唯一作用是被析构
    /// （与 `clipboard_monitor` 的 `_auto_strip_cache` 同款）。改成不带下划线的名字
    /// 会报 `field is never read`，别为了消警告把它「用起来」。
    pub(super) _keep_awake: Option<crate::rc::keep_awake::KeepAwake>,
}

/// 一圈推流的走向。命名决策替代三层嵌套 match。
pub(in crate::rc) enum Step {
    /// 本圈无事或已推完：睡到下一帧间隔。
    Sleep,
    /// 推送失败：已收口，退出循环。
    End,
    /// 硬编这条路没走成，落回 JPEG 路径。
    FallThrough,
}

/// [`motion_verdict`] 的判定结果，驱动 Q8 静止精修状态机。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MotionVerdict {
    /// 关键帧：**不参与运动判定**。自然 GOP 的 IDR 是节拍产物，精修强制的
    /// IDR 是本状态机自己的输出——把它们当成「画面动了」的话，精修 IDR
    /// 会清掉 `static_refined` 重新武装，静止画面变成每 ~330ms 一个 IDR 的
    /// 死循环（2026-09-19 审查发现的 P1）；顺带也避免把 500KB 量级的 IDR
    /// 字节混进动帧基准。基准未建立（ema=0）时首个动帧负责建立。
    Ignore,
    /// 动帧：更新字节基准、清静止计时、重新武装精修。
    Moving,
    /// 静帧：挂静止计时，超时强制一次 IDR。
    Static,
}

/// 一帧编码输出的运动判定（纯函数，可单测）。
///
/// 「动了」的判据：帧字节 ≥ 动帧基准的 1/6——静止画面的跳块 P 帧只有
/// 基准的零头。基准未建立（0）时任何非关键帧都算动（负责建立基准）。
pub(crate) fn motion_verdict(is_key: bool, motion_ema_bytes: u64, frame_bytes: u64) -> MotionVerdict {
    if is_key {
        MotionVerdict::Ignore
    } else if motion_ema_bytes == 0 || frame_bytes >= motion_ema_bytes / 6 {
        MotionVerdict::Moving
    } else {
        MotionVerdict::Static
    }
}

/// 剪贴板控制帧的**失败回执**（`clip_err` / `clip_push_err` 共用一条写帧路径）。
///
/// 🔴 D11（2026-09-22 审计）：`ClipboardPush` 那条腿过去在「只看会话 / 超限 /
/// 写剪贴板失败」三种情况下**只写日志不回帧**，发起端界面照样报「已推送」——
/// 用户到对端粘贴才发现是旧内容（项目规则 15.3：静默失败比报错难查一个量级）。
/// 收成一个函数是为了让两条腿（pull / push）的回帧写法没有第二种版本。
async fn reply_clip_err(
    send: &Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
    t: &str,
    error: String,
) {
    let msg = serde_json::json!({ "t": t, "error": error });
    if let Ok(b) = serde_json::to_vec(&msg) {
        let mut guard = send.lock().await;
        // C6：回执写不进去（连接已断）至少留痕——否则「回帧了」只是注释里的一厢情愿。
        if let Err(e) = write_frame(&mut guard, &b).await {
            log::debug!("[RC] 剪贴板回执帧写入失败（连接可能已断）：{e}");
        }
    }
}

/// 注入失败回执：`inject_err` 帧写给发起端 + 本机状态置位。
///
/// B9/P3-3（2026-09-25 审计）收口成一条路：入口校验拒绝（畸形 vk）与注入
/// 执行失败共用同一份回帧写法，不再各写一遍（写法分叉就是漏回帧的开始）。
async fn reply_inject_err(
    send: &Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
    error: String,
) {
    let msg = serde_json::json!({ "t": "inject_err", "error": error });
    if let Ok(b) = serde_json::to_vec(&msg) {
        let mut guard = send.lock().await;
        // C6：连「通知对方注入失败」这条帧都写丢了的话，必须留痕。
        if let Err(e) = write_frame(&mut guard, &b).await {
            log::warn!("[RC] inject_err 回执写帧失败：{e}");
        }
    }
}

/// [`pressed_rollback`] 的判定输入：这次注入**若成功**，追踪动作是什么。
///
/// ❗ 字段语义要看清：`Down(bool)` 的 bool 是「本次按下是否**新建**了记录」
///（`press_key`/`press_button` 的返回值），不是「键是否在按下态」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackOutcome {
    /// down 事件。bool = 本次按下是否新建了记录。
    Down(bool),
    /// up 事件：配对成功、记录已摘除（走到注入说明确实按着）。
    Up,
}

/// 注入失败后对 pressed 集合的回滚动作（🔴 P3-3，2026-09-25 审计）。
///
/// pressed 的不变量是「集合里的每颗键/鼠标键都**真的**在本机处于按下态」，
/// 会话收口 `release_all` 才能放心补发 up。注入失败会破坏这个不变量，按
/// 三种情形精确回滚（纯判定，无环境可单测）：
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PressedRollback {
    /// 首次按下且注入失败：**摘除**刚建的记录——键根本没按下去，
    /// 留着它收口就会补发孤立 up（孤立的 WM_RBUTTONUP 会在远端凭空
    /// 弹出上下文菜单）。
    Remove,
    /// 重复按下失败：记录**保留**——先前那次成功按下仍在生效，
    /// 摘了反而让收口漏发 up，键真卡死。
    Keep,
    /// 抬起失败：记录**放回**——机器上键还处于按下态（up 没送成），
    /// 放回后收口 `release_all` 会重试补发并如实上报失败（P1-3 的上报链）。
    Restore,
}

fn pressed_rollback(outcome: TrackOutcome) -> PressedRollback {
    match outcome {
        TrackOutcome::Down(was_new) => {
            if was_new {
                PressedRollback::Remove
            } else {
                PressedRollback::Keep
            }
        }
        TrackOutcome::Up => PressedRollback::Restore,
    }
}

/// 被控端处理一条输入（R2）。UIPI / 只看档必须报错不静默。
pub(super) async fn handle_inbound_input(
    svc: &Arc<RcService>,
    peer: &str,
    ev: InputEvent,
    session_id: &str,
    request_id: Option<&str>,
    send: &Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
) {
    if !svc.session_id_is(session_id) { return; }
    if let Some((key, _)) = super::settings::event_setting(&ev) {
        let result = svc.apply_inbound_setting(session_id, peer, &ev, request_id.is_some());
        if let Some(id) = request_id {
            let frame = match result {
                Ok(value) => serde_json::json!({"t":"setting_ack","request_id":id,"key":key,"status":"accepted","value":value}),
                Err(error) => serde_json::json!({"t":"setting_ack","request_id":id,"key":key,"status":"rejected","error":error}),
            };
            if let Ok(bytes) = serde_json::to_vec(&frame) {
                let mut guard = send.lock().await;
                if let Err(error) = write_frame(&mut guard, &bytes).await { log::debug!("[RC] 设置回执发送失败：{error}"); }
            }
        } else if let Err(error) = result { log::warn!("[RC] 设置失败：{error}"); }
        return;
    }
    // C-2 / P1-2：会话切换竞态窗口内，旧连接迟到的输入不得挂在新会话能力上执行。
    // 🔴 一次加锁取快照，入口与能力校验**同源**——旧写法
    // `session_is` + `session_capability` 两次加锁，中间可换会话。
    // 数据报路径与可靠流共用本函数，自动受益。
    let Some(snap) = svc.session_snapshot_for(peer) else {
        return;
    };
    if snap.phase != SessionPhase::InboundActive {
        return;
    }
    let cap = snap.capability;

    match &ev {
        InputEvent::ClipboardPush { text } => {
            // D11：三种失败都要回帧。过去这里静默 return，发起端界面报「已推送」，
            // 用户到对端粘贴才发现还是旧内容，且无从知道原因。
            if assert_control_allowed(cap).is_err() {
                reply_clip_err(
                    send,
                    "clip_push_err",
                    "当前是只看会话，不能写入对方剪贴板".into(),
                )
                .await;
                return;
            }
            // C-8 / P1-12：入站与出站同量纲——**编码后 JSON 字节**（`clip_payload_ok`）。
            // 发起端本地也会先卡一道（`push_clipboard`）；这里是兜改包 / 旧客户端的
            // 第二道。超限必须回 `clip_push_err`，禁止静默。
            let json_bytes = clip_push_json_bytes(text);
            if !clip_payload_ok(json_bytes) {
                log::warn!(
                    "[RC] 入站剪贴板帧过大（JSON {} 字节），已拒绝",
                    json_bytes
                );
                reply_clip_err(
                    send,
                    "clip_push_err",
                    format!(
                        "剪贴板内容约 {} KB，超过 {} KB 上限，未写入对方剪贴板",
                        json_bytes / 1024,
                        CLIPBOARD_MAX_JSON_BYTES / 1024
                    ),
                )
                .await;
                return;
            }
            // 写主机剪贴板前复核会话（P1-2）：快照到此之间 peer 可能已换。
            if !svc.session_peer_unchanged(&snap) {
                return;
            }
            // P2-4: clipboard retry sleeps; keep it off the tokio worker.
            if let Err(e) = set_clipboard_text_async(text.clone()).await {
                log::warn!("[RC] 写入被控剪贴板失败：{e}");
                reply_clip_err(send, "clip_push_err", format!("写入对方剪贴板失败：{e}")).await;
            }
            return;
        }
        InputEvent::ClipboardPull => {
            if assert_control_allowed(cap).is_err() {
                // 与 push 对齐：只看会话拉不了主机剪贴板，回帧让对端立刻说清，
                // 而不是干等 4s 超时后报一句含糊的「对方剪贴板为空或拉取失败」。
                reply_clip_err(send, "clip_err", "当前是只看会话，不能读取对方剪贴板".into())
                    .await;
                return;
            }
            if !svc.session_peer_unchanged(&snap) {
                return;
            }
            match get_clipboard_text_async().await {
                Ok(t) => {
                    // P1-12：回包同样按**编码后 JSON 字节**卡；超限回 `clip_err`，禁止静默。
                    let json_bytes = clip_pull_json_bytes(&t);
                    if !clip_payload_ok(json_bytes) {
                        reply_clip_err(send, "clip_err", "对方剪贴板过大，无法拉取".into()).await;
                    } else {
                        let msg = serde_json::json!({ "t": "clip", "text": t });
                        if let Ok(b) = serde_json::to_vec(&msg) {
                            let mut guard = send.lock().await;
                            // C6：回帧写失败留痕——对端只会看到 4s 超时，日志里
                            // 得能分清「它拉得慢」还是「链路已断」。
                            if let Err(e) = write_frame(&mut guard, &b).await {
                                log::warn!("[RC] 剪贴板回包写帧失败：{e}");
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[RC] 读被控剪贴板失败：{e}");
                    reply_clip_err(send, "clip_err", format!("读剪贴板失败：{e}")).await;
                }
            }
            return;
        }
        // ── 流控组：**免 Control，只看会话也可以调**（D5 边界成文，2026-09-22 审计）
        //
        // 🔴 这条边界的准确说法是：**允许 View 改的是「推给对方的这幅画面」，
        //    不含任何主机侧副作用。** 三件事都不属于它：
        //    1) 不注入本机输入（键鼠仍是 Control 专属）；
        //    2) 不改采集范围（`SetCaptureScope` 要求 Control——它可能切到隐私屏，
        //       改的是「主机上被看到的内容」，不是「画面怎么编码」）；
        //    3) 不碰本机剪贴板（push/pull 同样要求 Control）。
        //
        // 越权面已被下游 clamp 兜住，不是「靠信任」：`set_peer_rtt` 做 `max(0)`、
        // `set_user_bitrate_pct` 硬校验 50..=200、最终 `((auto * user) / 100).clamp(10, 300)`。
        // 所以最坏结果是「被控端码率被顶到 300% 或压到 10%」——是**资源影响**，
        // 不是越权动作。取舍是刻意保留的：View 得能调自己正看着的画质。
        // 改这一段之前先问：新加的东西有没有主机侧副作用？有就别放在这里。
        InputEvent::NetHint {
            rtt_ms,
            queue_ms,
            frame_loss_pm,
            media,
        } => {
            // 🔴 顺序有因（2026-10-05）：帧龄/丢包**先**入库，RTT 后到——
            // RTT 进 set_peer_rtt 时要拿同拍的排队/丢包判「安静样本」
            // （RTT 下限跟踪，见 `stream_cfg::next_rtt_floor`）。反过来排，
            // 风暴起步那一拍会拿上一拍的旧队列把拥塞 RTT 定成下限。
            if let Some(q) = queue_ms {
                svc.set_peer_queue_ms(*q);
            }
            if let Some(pm) = frame_loss_pm {
                svc.note_peer_frame_loss(*pm);
            }
            let scale = svc.set_peer_rtt(*rtt_ms);
            // 2026-09-28：排队压力（帧龄 EMA——AP 队列只挡大帧不挡小 ping）与
            // 帧粒度丢包反馈。都是弱网快速码控的信源，见 stream_cfg 各自注释。
            if let Some(feedback) = media {
                svc.apply_media_feedback(feedback);
            } else {
                svc.keep_media_queue_hint();
            }
            log::debug!("[RC] 对端 RTT {rtt_ms}ms → 码率 {scale}%");
            return;
        }
        InputEvent::SetBitratePct { pct } => {
            // Q5：发起端的码率倍率偏好。与 NetHint 一样是连续调整而非离散
            // 变更，不进 Q10 提示；被控端无感（画质档不变，只是编码目标变了）。
            if let Err(e) = svc.set_user_bitrate_pct(*pct) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端码率倍率：{pct}%");
            }
            return;
        }
        InputEvent::SetCaptureScope { scope } => {
            // D-2：改采集范围 = 改主机可观测内容（可能切到隐私屏）→ 要求 Control。
            // 只看会话拒绝；发起端 UI 已置灰，这里兜改包/旧客户端。
            if assert_control_allowed(cap).is_err() {
                log::info!("[RC] 只看会话试图改画面范围，已拒绝：{scope}");
                return;
            }
            if let Err(e) = svc.set_stream_scope(scope) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求画面范围：{scope}");
                // B3：被控端必须看得见这次变更。只 log 等于没提示——用户不知道
                // 自己的画面（可能含隐私内容）被切到了别处。
                svc.emit_scope_changed(scope);
                // P1：范围变了 → 单输出判定变了 → fps120 可用性跟着变，重报
                send_caps_frame(svc, send).await;
            }
            return;
        }
        InputEvent::SetCodec { codec } => {
            if let Err(e) = svc.set_stream_codec(codec) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求编码：{codec}");
                // Q10：编码切换同样要被控端可见（H.264 ↔ JPEG 观感差异明显）
                svc.emit_stream_note("codec", codec);
            }
            return;
        }
        // G3-C：发起端要求静音 / 恢复**本机（被控端）主机扬声器**。
        //
        // 🔴 要求 Control —— 这动的是本机的**物理输出环境**（屋里人听不听得到），
        // 与「改画质」那类只影响发起端自己画面的指令不同档，和键鼠注入同级。
        // 「只看」会话拒绝，并且**明确回一条失败**，免得发起端的按钮点了没反应。
        InputEvent::SetHostMute { on } => {
            let err = if assert_control_allowed(cap).is_err() {
                Some("当前会话仅为「只看」，无法改对方主机声音".to_string())
            } else {
                // 扬声器静音走 Windows 音频端点（mobile 宿主不存在，诚实回报不支持）
                #[cfg(target_os = "windows")]
                { match super::audio::spk_mute_set(*on) {
                    Ok(actual) => {
                        // 记「对端操作过且未撤销」——横幅据此摆提示与恢复入口。
                        svc.set_spk_muted_by_peer(actual);
                        // 本机前端的快照要跟着变，否则横幅提示与恢复按钮不会出现
                        // （这个分支不像命令层那样自带 emit）。
                        svc.notify.emit_changed();
                        log::info!("[RC] 对端{}本机扬声器", if actual { "静音了" } else { "恢复了" });
                        None
                    }
                    Err(e) => {
                        log::warn!("[RC] 切换本机扬声器静音失败：{e}");
                        Some(format!("切换主机扬声器失败：{e}"))
                    }
                } }
                #[cfg(not(target_os = "windows"))]
                { Some("本机无音频输出链路（宿主仅 Windows）".to_string()) }
            };
            // 回帧带**读回的真实值**（可能与我们请求的不同），发起端的按钮态以它为准。
            svc.emit_host_audio(err.as_deref()).await;
            return;
        }
        // 乙-③：控端要求锁住**被控者本人的物理键鼠**（RustDesk block-input 语义）。
        //
        // 🔴 两重门禁：`Control`（与键鼠注入同量级）+ **被控者本场授权**。
        // 授权不在只回一条失败给发起端，本机一个键都不吞——「把人锁在自己机器
        // 外面」不能有第二条路径。判据与落地全在 `service/input_gate.rs`。
        InputEvent::SetInputLock { on } => {
            if assert_control_allowed(cap).is_err() {
                log::info!("[RC] 只看会话试图锁定本机输入，已拒绝");
                return;
            }
            svc.peer_request_input_lock(*on).await;
            return;
        }
        _ => {}
    }

    if assert_control_allowed(cap).is_err() {
        log::debug!("[RC] 拒绝只看会话的键鼠注入");
        return;
    }

    // 🔴 乙-③ 闸 A：被控者「暂时收回我的键鼠」期间，对端的键鼠**一拍都不进本机**。
    //
    // 位置在能力校验之后、region 计算之前：越靠前越省，且收回期间连坐标换算都不必做。
    // 剪贴板 / 流控那些在上面就已 `return`，不受这道闸影响——收回管的是「谁的手在
    // 动这台机器的键鼠」，不是「对方能不能传个文本过来」。
    if !svc.input_injection_allowed() {
        match &ev {
            InputEvent::Key { .. } | InputEvent::Text { .. } => svc.note_peer_kbd(false),
            InputEvent::MouseMove { .. }
            | InputEvent::MouseButton { .. }
            | InputEvent::Wheel { .. } => svc.note_peer_mouse(false),
            _ => {}
        }
        return;
    }

    // P1-2：注入前再确认 peer/phase/capability 没换——快照到此之间会话可能
    // 已经切给另一台，迟到输入不得打在新会话上。
    // 紧贴 inject：region 计算期间会话同样可能已切换。
    if !svc.session_peer_unchanged(&snap) {
        log::debug!("[RC] 会话在注入前已切换，丢弃迟到输入（{peer}）");
        return;
    }

    // 🔴 收口（规则 11.1）：region 判定只有 `input::capture_region` 一份——
    // 光标遥测（被控端 → 发起端的「光标在哪」）算的是同一个 region。
    // 两处各写一份「monitor >= 0 → 主屏/virtual」的判定，迟早有一处漏了
    // monitor 分支，症状是「点击落点对、光标位置不对」，真机上要逐像素
    // 比对才看得出来。
    let region = capture_region(&svc.stream_opts_snapshot());
    // P1-2：region 计算后再钉一次——窗口拉长了检查与注入的间距。
    if !svc.session_peer_unchanged(&snap) {
        log::debug!("[RC] 会话在注入前已切换，丢弃迟到输入（{peer}）");
        return;
    }

    // C2（2026-09-23 复审）：按下追踪**紧贴注入**、在所有早退门控之后。
    // 原先记在守卫之前，「会话已切换」的丢弃路径会把按键留在 pressed 里——
    // 这颗键本机根本没按下，却等着被 release_all 补发一个凭空的 up。
    //
    // 追踪按下/抬起：会话收口时由 end_session 调 release_all 补发 up，
    // 避免对端断线后 Ctrl/Shift/鼠标键永久卡在按下态。只在会真正注入时记录。
    //
    // 🔴 顺带丢弃「未配对的抬起」（2026-09-22）：抬起态在 `pressed` 里查不到对应
    // 按下，说明这颗键在本机从未按下过。继续注入它的代价是**远端凭空弹菜单**——
    // Windows 对孤立的 WM_RBUTTONUP 会生成 WM_CONTEXTMENU（DefWindowProc 行为），
    // 而发起端的 `releaseModifiers()` 曾经在每次焦点离开画面时盲发三个鼠标 up
    // （前端已删，这里是第二道防线）。
    //
    // 误丢真实抬起的风险极低：鼠标的按下与抬起走同一路（数据报），真丢的是 DOWN，
    // 那时远端本来就没按下；万一乱序导致 DOWN 晚到，下一次点击会重发 DOWN
    // （重复按下照常注入）+ 配对的 UP，自愈。
    // 🔴 B9（2026-09-25 审计）：Key 的 vk 先收敛再谈追踪/注入。线上 vk 是
    // u32、`SendInput` 只要 u16——旧代码注入处 `as u16` 静默截断、追踪用
    // 原值，两套口径下畸形 vk（>0xFFFF）会「按 A 松 A 卡键」（down 记
    // 0x1_0041，up 来 0x41 查不到配对）。收口函数是
    // `input::converge_key_vk`（收口补发那条旁路也过它）；收不下的在这里
    // 丢弃并上报——不发注入、不进追踪。
    if let InputEvent::Key { vk, .. } = &ev {
        if converge_key_vk(*vk).is_none() {
            let error = format!("无效的按键值 vk={vk}（超出 0..=65535），已丢弃");
            log::warn!("[RC] 键鼠注入事件被拒（{peer}）：{error}");
            reply_inject_err(send, error).await;
            return;
        }
    }

    // C2（2026-09-23 复审）：按下追踪**紧贴注入**、在所有早退门控之后。
    // 原先记在守卫之前，「会话已切换」的丢弃路径会把按键留在 pressed 里——
    // 这颗键本机根本没按下，却等着被 release_all 补发一个凭空的 up。
    //
    // 追踪按下/抬起：会话收口时由 end_session 调 release_all 补发 up，
    // 避免对端断线后 Ctrl/Shift/鼠标键永久卡在按下态。只在会真正注入时记录。
    //
    // 🔴 顺带丢弃「未配对的抬起」（2026-09-22）：抬起态在 `pressed` 里查不到对应
    // 按下，说明这颗键在本机从未按下过。继续注入它的代价是**远端凭空弹菜单**——
    // Windows 对孤立的 WM_RBUTTONUP 会生成 WM_CONTEXTMENU（DefWindowProc 行为），
    // 而发起端的 `releaseModifiers()` 曾经在每次焦点离开画面时盲发三个鼠标 up
    // （前端已删，这里是第二道防线）。
    //
    // 误丢真实抬起的风险极低：鼠标的按下与抬起走同一路（数据报），真丢的是 DOWN，
    // 那时远端本来就没按下；万一乱序导致 DOWN 晚到，下一次点击会重发 DOWN
    // （重复按下照常注入）+ 配对的 UP，自愈。
    //
    // 🔴 P3-3（2026-09-25 审计）：追踪动作带回「这次是否新按下」（[`TrackOutcome`]），
    // 注入失败时按下方的 [`pressed_rollback`] 精确回滚——盲目「失败就删记录」
    // 会把先前成功那次重复按下的记录也抹掉，收口反而漏发 up。
    let track: Option<TrackOutcome> = match &ev {
        InputEvent::Key { vk, down } => {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            if *down {
                Some(TrackOutcome::Down(g.press_key(*vk)))
            } else {
                if !g.release_key(*vk) {
                    log::debug!("[RC] 丢弃未配对的抬起（vk={vk}）");
                    return;
                }
                Some(TrackOutcome::Up)
            }
        }
        InputEvent::MouseButton { button, down, .. } => {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            if *down {
                Some(TrackOutcome::Down(g.press_button(*button)))
            } else {
                if !g.release_button(*button) {
                    log::debug!("[RC] 丢弃未配对的抬起（button={button}）");
                    return;
                }
                Some(TrackOutcome::Up)
            }
        }
        _ => None,
    };

    // 乙-①：口径**紧贴注入**读一次（与 `session_peer_unchanged` 同期）。取早了
    // 会在「region 计算期间对端改了档」时用旧口径打下一批键。
    let mode = svc.key_mode();
    let r = inject(&ev, &region, mode);
    // 乙-③：「谁在动」的活动戳。只在**真的落进本机**时记绿——注入失败（UIPI、
    // 无效键值）不是「对方在用」，更不是「对方无权被拦」，那条红的另有来源
    //（收回闸，见上面）。失败留旧戳，靠时间窗自己淡出。
    if r.ok {
        match &ev {
            InputEvent::Key { .. } | InputEvent::Text { .. } => svc.note_peer_kbd(true),
            InputEvent::MouseMove { .. }
            | InputEvent::MouseButton { .. }
            | InputEvent::Wheel { .. } => svc.note_peer_mouse(true),
            _ => {}
        }
    }
    if !r.ok {
        // 🔴 P3-3：回滚 pressed（[`pressed_rollback`] 的三种情形），保证
        // 「集合里的键都真的按着」这条不变量，end_session 的 release_all
        // 才不会对没按下去的键注入孤立 up（凭空弹上下文菜单）。只走
        // pressed 的现有增删 API，不另开第二套记录口径。
        if let Some(t) = track {
            let action = pressed_rollback(t);
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            match (&ev, action) {
                (InputEvent::Key { vk, .. }, PressedRollback::Remove) => {
                    g.release_key(*vk);
                }
                (InputEvent::Key { vk, .. }, PressedRollback::Restore) => {
                    g.press_key(*vk);
                }
                (InputEvent::MouseButton { button, .. }, PressedRollback::Remove) => {
                    g.release_button(*button);
                }
                (InputEvent::MouseButton { button, .. }, PressedRollback::Restore) => {
                    g.press_button(*button);
                }
                // 其余组合：Keep（重复按下失败，先前成功按下的记录原样保留），
                // 以及「事件类型与追踪结果不配对」——后者不可达（track 只对
                // Key / MouseButton 置 Some），一并静默。
                _ => {}
            }
        }
        log::warn!("[RC] 键鼠注入失败（{peer}）：{}", r.error);
        // P1：UIPI 等失败要让发起端看见，不能只写日志
        reply_inject_err(send, r.error.clone()).await;
        svc.set_inject_err(r.error.clone());
    }
}

// impl InboundVideo 的推流方法平移到子模块（硬编路径 / 运行循环）。
#[cfg(target_os = "windows")]
mod media;
#[cfg(target_os = "windows")]
mod media_pipe;
mod video;
mod video_run;

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 P3-3（2026-09-25 审计）守卫：注入失败时对 pressed 的回滚判定。
    ///
    /// 盲目「失败就删记录」有两种坏法：重复按下失败会把先前成功那次的记录
    /// 也抹掉（收口漏发 up → 键真卡死）；抬起失败不把记录放回（机器上还按
    /// 着，收口既不重试也不上报）。三种情形必须各归各位。
    #[test]
    fn 注入失败的pressed回滚判定_p3_3() {
        // 首次按下失败：摘除——键没按下去，收口不许补发孤立 up
        //（孤立的 WM_RBUTTONUP 会在远端凭空弹出上下文菜单）。
        assert_eq!(
            pressed_rollback(TrackOutcome::Down(true)),
            PressedRollback::Remove
        );
        // 重复按下失败：保留——先前成功那次仍在生效
        assert_eq!(
            pressed_rollback(TrackOutcome::Down(false)),
            PressedRollback::Keep
        );
        // 抬起失败：放回——收口 release_all 重试补发并如实上报
        assert_eq!(pressed_rollback(TrackOutcome::Up), PressedRollback::Restore);
    }
}
