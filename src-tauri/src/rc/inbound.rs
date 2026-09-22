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
    assert_control_allowed, get_clipboard_text_async, inject, set_clipboard_text_async,
};
use super::input::{InputEvent, ScreenRegion};
use super::encode_h264::VideoCodec;
use super::protocol::SessionPhase;
use super::service::{
    clip_payload_ok, clip_pull_json_bytes, clip_push_json_bytes, RcService, CLIPBOARD_MAX_JSON_BYTES,
};
use crate::sync::transport::write_frame;

// 后台任务与画面能力上报已拆到 `inbound_tasks.rs`（2026-09-21）；
// 尺寸工具（primary/virtual_screen_size）也一并搬过去，这里通过下面的
// `use` 把它们拉回来，调用点保持原样。
use super::inbound_tasks::{primary_screen_size, send_caps_frame, virtual_screen_size};

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
    /// 最近一次发出的光标形状（变化才发）。
    pub(super) last_cursor: Option<&'static str>,
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
        let _ = write_frame(&mut guard, &b).await;
    }
}

/// 被控端处理一条输入（R2）。UIPI / 只看档必须报错不静默。
pub(super) async fn handle_inbound_input(
    svc: &Arc<RcService>,
    peer: &str,
    ev: InputEvent,
    send: &Arc<tokio::sync::Mutex<iroh::endpoint::SendStream>>,
) {
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
                            let _ = write_frame(&mut guard, &b).await;
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
        InputEvent::SetQuality { quality } => {
            if let Err(e) = svc.set_stream_quality(quality) {
                log::warn!("[RC] {e}");
            } else {
                log::info!("[RC] 对端要求画质档：{quality}");
                // Q10：与 SetCaptureScope 同理——对端（含只看会话）改了本机推流
                // 档位，被控者不能只有 log；画质被调低画面变糊要能看见原因。
                svc.emit_stream_note("quality", quality);
            }
            return;
        }
        InputEvent::NetHint { rtt_ms } => {
            let scale = svc.set_peer_rtt(*rtt_ms);
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
        // G3：发起端开关系统声音。不注入输入；被控端必须看得见——
        // 「我的声音正在被对方听」和「画面被切走」是同一级别的可见性。
        InputEvent::AudioOn { on } => {
            // C-1 拍板：只看可收系统声音。AudioOn 只切换发起端收听开关，
            // 不改主机环境，故 inbound 侧不要求 Control（与 send_input 白名单一致）。
            svc.set_audio_muted(!*on);
            // 与 quality/codec 同款分工：note 里传**原值**（on/off），中文文案归前端。
            // 传句子会让被控横幅的「不是 codec 就是画质」分支把它读成画质。
            svc.emit_stream_note("audio", if *on { "on" } else { "off" });
            log::info!("[RC] 对端{}系统声音", if *on { "开启" } else { "关闭" });
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
                match super::audio::spk_mute_set(*on) {
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
                }
            };
            // 回帧带**读回的真实值**（可能与我们请求的不同），发起端的按钮态以它为准。
            svc.emit_host_audio(err.as_deref()).await;
            return;
        }
        _ => {}
    }

    if assert_control_allowed(cap).is_err() {
        log::debug!("[RC] 拒绝只看会话的键鼠注入");
        return;
    }

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
    match &ev {
        InputEvent::Key { vk, down } => {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            if *down {
                g.press_key(*vk);
            } else if !g.release_key(*vk) {
                log::debug!("[RC] 丢弃未配对的抬起（vk={vk}）");
                drop(g);
                return;
            }
        }
        InputEvent::MouseButton { button, down, .. } => {
            let mut g = svc.pressed.lock().unwrap_or_else(|p| p.into_inner());
            if *down {
                g.press_button(*button);
            } else if !g.release_button(*button) {
                log::debug!("[RC] 丢弃未配对的抬起（button={button}）");
                drop(g);
                return;
            }
        }
        _ => {}
    }

    // P1-2：注入前再确认 peer/phase/capability 没换——快照到此之间会话可能
    // 已经切给另一台，迟到输入不得打在新会话上。
    // 紧贴 inject：region 计算期间会话同样可能已切换。
    if !svc.session_peer_unchanged(&snap) {
        log::debug!("[RC] 会话在注入前已切换，丢弃迟到输入（{peer}）");
        return;
    }

    let region = {
        let opts = svc.stream_opts_snapshot();
        if opts.monitor >= 0 {
            match crate::screenshot::monitor_region(opts.monitor) {
                Ok((x, y, w, h)) => ScreenRegion { x, y, w, h },
                Err(_) => ScreenRegion::virtual_screen(),
            }
        } else if opts.virtual_screen {
            ScreenRegion::virtual_screen()
        } else {
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
                };
                let (w, h) =
                    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
                ScreenRegion {
                    x: 0,
                    y: 0,
                    w: w.max(1),
                    h: h.max(1),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                ScreenRegion::virtual_screen()
            }
        }
    };
    // P1-2：region 计算后再钉一次——窗口拉长了检查与注入的间距。
    if !svc.session_peer_unchanged(&snap) {
        log::debug!("[RC] 会话在注入前已切换，丢弃迟到输入（{peer}）");
        return;
    }
    let r = inject(&ev, &region);
    if !r.ok {
        log::warn!("[RC] 键鼠注入失败（{peer}）：{}", r.error);
        // P1：UIPI 等失败要让发起端看见，不能只写日志
        let msg = serde_json::json!({ "t": "inject_err", "error": r.error });
        if let Ok(b) = serde_json::to_vec(&msg) {
            let mut guard = send.lock().await;
            let _ = write_frame(&mut guard, &b).await;
        }
        svc.set_inject_err(r.error.clone());
    }
}

// impl InboundVideo 的推流方法平移到子模块（硬编路径 / 运行循环）。
mod video;
mod video_run;