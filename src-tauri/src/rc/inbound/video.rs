//! InboundVideo 构造与硬编（H.264）路径：try_new / open_h264 / try_hardware_path / send_h264_pkts。

use super::*;

/// 编码标准决策（纯函数，规则 11.1：判据两处调用必收口）。
/// 档位自带 HEVC 偏好（uhd60）优先于显式 SetCodec；AV1 只在显式选择时启用。
/// （Windows 宿主专属：VideoCodec 属编码器域，mobile 无推流管线不编译）
#[cfg(target_os = "windows")]
pub(in crate::rc) fn want_stream_codec(
    profile_hevc: bool,
    codec: &crate::rc::stream_cfg::StreamCodec,
) -> VideoCodec {
    use crate::rc::stream_cfg::StreamCodec;
    if profile_hevc {
        return VideoCodec::Hevc;
    }
    match codec {
        StreamCodec::Hevc => VideoCodec::Hevc,
        StreamCodec::Av1 => VideoCodec::Av1,
        _ => VideoCodec::H264,
    }
}

#[cfg(test)]
mod want_codec_tests {
    use super::want_stream_codec;
    use crate::rc::encode_h264::VideoCodec;
    use crate::rc::stream_cfg::StreamCodec;

    #[test]
    fn 编码标准决策_档位偏好优先_显式次之() {
        assert_eq!(want_stream_codec(true, &StreamCodec::Av1), VideoCodec::Hevc);
        assert_eq!(want_stream_codec(false, &StreamCodec::Hevc), VideoCodec::Hevc);
        assert_eq!(want_stream_codec(false, &StreamCodec::Av1), VideoCodec::Av1);
        assert_eq!(want_stream_codec(false, &StreamCodec::Auto), VideoCodec::H264);
        assert_eq!(
            want_stream_codec(false, &StreamCodec::ForceJpeg),
            VideoCodec::H264,
            "JPEG 由 force_jpeg 门控另走，这里恒 H264"
        );
    }
}
// 推流节拍判据收口在 `rc::pace`（inbound.rs 的主题是会话结构与生命周期）。
use crate::rc::pace::{auto_key_due, want_fps_for, AUTO_KEY_MIN_GAP_MS};

/// 🔴 可靠流积压熔断（2026-10-03，判据收口为纯函数便于无环境单测）。
///
/// 背景：数据报放行闸（`stream_cfg::video_dgram_allowed`）在公网/中继/未采样
/// 路径上恒关，视频全程走可靠 QUIC 流。可靠流**没有任何弃帧机制**——写入在
/// quinn 发送缓冲上阻塞，编码端产多少就积多少，延迟单调上涨且永不恢复
/// （08:22 真机会话：往返 450ms → 46s，pong 被同一连接的视频积压堵死，
/// 「断链 0」——链路没坏，纯粹是队列）。
///
/// 水位信号：`write_all` 在缓冲未满时立即返回，**只有队列深了才会阻塞**——
/// 所以「写完一帧用了多久」就是积压的直观读数。单帧写 ≥`MELT_SLOW_MS` → 熔断：
/// 只弃大 P 帧（小帧是窄管上唯一能穿过的），关键帧照发（写耗时顺便当水位
/// 探针）；某次写入变快 = 队列已排干 → 退出。
#[cfg(target_os = "windows")]
pub(crate) const MELT_SLOW_MS: u64 = 1500;
/// 一帧在这个时间内写完 = 队列已排干，退出熔断恢复产帧。
#[cfg(target_os = "windows")]
pub(crate) const MELT_EXIT_MS: u64 = 80;
/// 熔断期只弃**大** P 帧，小帧照发（2026-10-03 09:52 中继会话教训）：
/// 窄管路径上写一帧的时间下限就是帧的传输时间，阈值太低会把唯一能穿过
/// 窄管的小 P 帧（2~10KB）也弃掉 = 对端永远「等待对方画面」。阈值取
/// 32KB：静态/慢动帧放行，运动大帧在熔断期停住不加塞。
#[cfg(target_os = "windows")]
pub(crate) const MELT_DROP_MIN_BYTES: u64 = 32 * 1024;
/// 「传输分 plane」：熔断**持续**这么久 → 整流重建（2026-10-03）。可靠流上
/// 已入队字节无法丢弃，光弃新帧只能停止加量、不能清账；重建把旧流连同
/// 积压整段丢弃，延迟上界 = 重开周期内新积的量。5s：一次 GOP + 数帧的
/// 观察窗，短于它会把「写一帧的正常传输时间」误判成持续拥塞。
#[cfg(target_os = "windows")]
pub(crate) const MELT_REBUILD_AFTER_MS: u128 = 5_000;

/// 熔断判定对本帧的动作。
#[cfg(target_os = "windows")]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MeltAction {
    /// 照常写入。
    Send,
    /// 弃掉本 P 帧（调用方负责计数）。
    DropP,
}

/// 起播宽限：等发起端倍率/链路信息到位再开硬编的上界（毫秒）。
///
/// 判据不是「等满」而是「谁先到」——`peer_net_seen` 一置位就立刻开
/// （LAN 上几乎零成本），只有对端始终不发言才等满。取 1500ms 的理由：
/// 2026-10-03 真机实测发起端 `SetBitratePct` 在起播约 0.9s 后到达
/// （绕中继路径），1.5s 给了一倍的余量；等满的场景（旧对端/控制帧丢）
/// 也只是 JPEG 多兜底 1.5s，见 `try_new` 的宽限闸注释。
#[cfg(target_os = "windows")]
pub(crate) const ENC_OPEN_GRACE_MS: u64 = 1_500;

/// 起播宽限判据（纯函数，便于无环境单测）：对端信息已到，或宽限期满——
/// 两者满足其一就该开硬编。
#[cfg(target_os = "windows")]
pub(crate) fn enc_first_open_due(
    due: std::time::Instant,
    now: std::time::Instant,
    peer_seen: bool,
) -> bool {
    peer_seen || now >= due
}

/// 输入上一帧的写入耗时与当前熔断状态，输出（新熔断态，本帧动作）。
///
/// 时序：`last_write_ms` 是**上一帧**的写入耗时，用它决定**本帧**发不发——
/// 写入是阻塞的，「上一帧写得慢」正是「此刻队列还深」的证据。
///
/// 🔴 **单帧大阻塞即进熔断，不数连击**（11:10 会话教训）：真实流量是
/// 「1 个大 IDR 阻塞 10~15s + 一串快的小帧写」交替，快帧会把「连续 N 慢」
/// 的连击清零——初版数 3 连击，整场会话 `流积压弃帧 0`，熔断实际是死代码，
/// 帧龄照样涨到 90s。写一帧阻塞 ≥1.5s 本身就是「产量远超吞吐」的实锤，
/// 一次就够判。
///
/// 🔴 熔断期**不强制 IDR**（与数据报路径的 C2 弃帧不同）：流上弃帧没有「洞」，
/// 接收端解码断链走 corrupt→RequestKey 自愈、自然 GOP ≤1s 兜底；强灌 IDR
/// 是把**最大的帧**往已堵死的管子里倒（09:52 中继会话由此全程无帧）。
#[cfg(target_os = "windows")]
pub(crate) fn melt_step(
    melt: bool,
    last_write_ms: u64,
    is_key: bool,
    frame_bytes: u64,
) -> (bool, MeltAction) {
    let melt = melt || last_write_ms >= MELT_SLOW_MS;
    if !melt {
        return (melt, MeltAction::Send);
    }
    // 上一帧写得快 = 队列已排干，退出熔断、本帧放行
    if last_write_ms < MELT_EXIT_MS {
        return (false, MeltAction::Send);
    }
    // 关键帧不能弃：弃了接收端要等下一个 GOP 才能重新起链，这期间全是花屏。
    // 照发——它的写耗时就是下一次判定的水位输入。
    if is_key {
        return (melt, MeltAction::Send);
    }
    // 小 P 帧放行：它们是窄管上唯一能穿过的帧，弃了 = 对端永远无帧
    if frame_bytes < MELT_DROP_MIN_BYTES {
        return (melt, MeltAction::Send);
    }
    (melt, MeltAction::DropP)
}

#[cfg(all(test, target_os = "windows"))]
mod melt_tests {
    use super::{melt_step, MeltAction, MELT_DROP_MIN_BYTES, MELT_EXIT_MS, MELT_SLOW_MS};

    #[test]
    fn 健康路径永不熔断() {        assert_eq!(
            melt_step(false, 0, false, MELT_DROP_MIN_BYTES),
            (false, MeltAction::Send)
        );
        assert_eq!(
            melt_step(false, MELT_SLOW_MS - 1, false, MELT_DROP_MIN_BYTES),
            (false, MeltAction::Send),
            "写 1.5s 内不算拥塞"
        );
    }

    /// 🔴 单帧大阻塞即进熔断（11:10 会话：IDR 写阻塞 14.9s，连击判据全场
    /// 没凑齐 3 次，熔断是死代码）。
    #[test]
    fn 单帧大阻塞进熔断_大P弃_小P放_关键帧照发() {
        // 大阻塞的下一帧就是大 P：进熔断且立刻弃（水位来自上一帧的阻塞）
        let (melt, a) = melt_step(false, MELT_SLOW_MS, false, MELT_DROP_MIN_BYTES);
        assert!(melt, "一次大阻塞就该进熔断");
        assert_eq!(a, MeltAction::DropP);
        // 熔断中：上一帧仍慢 → 关键帧照发、小 P 帧放行
        assert_eq!(
            melt_step(melt, MELT_SLOW_MS, true, MELT_DROP_MIN_BYTES),
            (true, MeltAction::Send),
            "关键帧不能弃"
        );
        assert_eq!(
            melt_step(melt, MELT_SLOW_MS, false, 8 * 1024),
            (true, MeltAction::Send),
            "小 P 帧不许弃——窄管上对端全靠它"
        );
        // 边界：恰好达到阈值才弃
        assert_eq!(
            melt_step(melt, MELT_SLOW_MS, false, MELT_DROP_MIN_BYTES - 1).1,
            MeltAction::Send
        );
    }

    #[test]
    fn 快速写入退出熔断() {
        let (m, a) = melt_step(true, MELT_EXIT_MS - 1, false, MELT_DROP_MIN_BYTES);
        assert!(!m, "快速写入 = 队列排干，退出熔断");
        assert_eq!(a, MeltAction::Send);
    }
}

/// 🔴 起播宽限判据（2026-10-03）：「谁先到」而不是「等满」——对端信息
/// 一置位就收闸（LAN 零等待），对端始终不发言才等满（上界 1.5s）。
/// 写成 if 各处的分支逻辑最难守，收口成纯函数钉住。
#[cfg(all(test, target_os = "windows"))]
mod enc_open_tests {
    use super::{enc_first_open_due, ENC_OPEN_GRACE_MS};
    use std::time::{Duration, Instant};

    fn due() -> Instant {
        Instant::now() + Duration::from_millis(ENC_OPEN_GRACE_MS)
    }

    #[test]
    fn 宽限内且对端没发言_继续等() {
        assert!(
            !enc_first_open_due(due(), Instant::now(), false),
            "倍率还没到、宽限未满：先走 JPEG 兜底，不开硬编"
        );
    }

    #[test]
    fn 对端信息一到就收闸_不等宽限满() {
        assert!(
            enc_first_open_due(due(), Instant::now(), true),
            "LAN 上 SetBitratePct 几十毫秒就到：立即开，别空等 1.5s"
        );
    }

    #[test]
    fn 对端始终沉默_等满也要开() {
        let past = Instant::now() - Duration::from_secs(1);
        assert!(
            enc_first_open_due(past, Instant::now(), false),
            "旧对端不发倍率：到点也必须开，否则整场 JPEG"
        );
    }
}

impl InboundVideo {
    /// 🔴 调研实验开关（2026-10-03）：`PP_RC_DGRAM_FORCE=1` 无视数据报放行闸
    /// 强制视频走数据报。闸门的「公网数据报近乎全丢」结论（18:15 会话）可能
    /// 是在**中继路径**上测的——中继转发 UDP 质量差不代表直连也差；行业
    /// （Moonlight/Parsec）的默认态恰是不可靠数据报。直连真实丢包率需要
    /// 重测定方向，本开关只在桌面 dev 实验时手动设置，正式判据仍是
    /// `stream_cfg::video_dgram_allowed`。OnceLock 缓存：环境变量只在首次读取。
    #[cfg(target_os = "windows")]
    fn dgram_force() -> bool {
        static FORCE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *FORCE.get_or_init(|| {
            std::env::var("PP_RC_DGRAM_FORCE").is_ok_and(|v| v == "1")
        })
    }

    /// 会话存在、是入站活跃、且属于本 peer 才建；否则 `None`（启动前会话已结束）。
    pub(in crate::rc) fn try_new(
        svc: Arc<RcService>,
        peer: &str,
        send: iroh::endpoint::SendStream,
        conn: iroh::endpoint::Connection,
        peer_dgram: bool,
        peer_fec_rs: bool,
        peer_video_plane: bool,
        peer_media_plane: bool,
        peer_media_feedback: bool,
    ) -> Option<Self> {
        let my_id = {
            let inner = svc.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .session
                .as_ref()
                .filter(|s| s.phase == SessionPhase::InboundActive && s.peer == peer)
                .map(|s| s.id.clone())
        }?;
        svc.configure_media_feedback(&my_id, peer_media_feedback && peer_video_plane);
        let _ = send.set_priority(crate::rc::media::CONTROL_PRIORITY);
        let send = Arc::new(tokio::sync::Mutex::new(send));
        let profile = svc.encode_profile();
        let virt = svc.capture_virtual_screen();
        svc.reset_stream_opts_from_cfg();
        let enc = Arc::new(std::sync::Mutex::new(
            crate::rc::video::EncoderState::with_profile(profile, virt),
        ));
        // R6：主屏 / 指定单屏 / 虚拟屏都优先 DXGI + H.264；打不开回退 JPEG。
        //
        // 🔴 起播宽限（2026-10-03）：**先不在这里开**。发起端的
        // `SetBitratePct`（默认 200）约 0.9s 后才到，此刻开只能按 100% 开、
        // 等倍率到了再全链重开一次（~2s 白烧 + 重开周期内帧全丢）。改成
        // 宽限内先走 JPEG 兜底——画面出现得反而更快（MFT 初始化要几百 ms，
        // JPEG 立即可出），硬编按**当前倍率**晚一步再开。判据与收闸条件见
        // [`ENC_OPEN_GRACE_MS`] / [`enc_first_open_due`]。
        #[cfg(target_os = "windows")]
        let h264: Option<crate::rc::encode_h264::H264SessionEncoder> = None;
        // 宽限**不是失败**，不安排 `enc_retry_after` 退避：那个闸只服务
        // 「硬编熔断后的重试」。宽限内若到期仍开不起，才在推流循环里按
        // 既有口径（起步 5s、翻倍至 60s）补上，见 `try_hardware_path`。
        #[cfg(target_os = "windows")]
        let enc_retry_after: Option<std::time::Instant> = None;
        #[cfg(target_os = "windows")]
        let enc_first_open_at =
            Some(std::time::Instant::now() + std::time::Duration::from_millis(ENC_OPEN_GRACE_MS));
        // 重试退避起步值（首次 5s，每次重试翻倍，上限 60s；翻倍由重试点统一
        // 执行）。宽限到期时首次打开失败也用它安排下一次。
        #[cfg(target_os = "windows")]
        let enc_retry_backoff: u64 = 5;
        // 防休眠：只在**真的要开始推流**这一刻起持（放在 `my_id` 那道闸之后）。
        // 更早拿等于让「被拒/来不及建会话」的连接白白按住用户机器；不做成字段则要有
        // 一处记得 release，而退出路径不止一条。
        let keep_awake = if svc.keep_awake() {
            crate::rc::keep_awake::KeepAwake::start()
        } else {
            None
        };
        Some(Self {
            svc,
            peer: peer.to_string(),
            my_id,
            send,
            enc,
            #[cfg(target_os = "windows")]
            dxgi: crate::rc::dxgi::DxgiPool::new(),
            #[cfg(target_os = "windows")]
            h264,
            #[cfg(target_os = "windows")]
            enc_fail_streak: 0,
            #[cfg(target_os = "windows")]
            enc_retry_after,
            #[cfg(target_os = "windows")]
            enc_retry_backoff,
            #[cfg(target_os = "windows")]
            enc_first_open_at,
            #[cfg(target_os = "windows")]
            gpu_disabled: false,
            #[cfg(target_os = "windows")]
            dgram: crate::rc::vid_dgram::VidDgramSender::new(),
            peer_dgram,
            dgram_allowed: false,
            peer_video_plane,
            peer_media_plane,
            #[cfg(target_os = "windows")]
            media_pipe: None,
            #[cfg(target_os = "windows")]
            stream_melt: false,
            #[cfg(target_os = "windows")]
            stream_last_write_ms: 0,
            peer_fec_rs,
            conn,
            input_boost: Arc::new(tokio::sync::Notify::new()),
            last_frame_at: tokio::time::Instant::now(),
            force_key: Arc::new(AtomicBool::new(false)),
            #[cfg(target_os = "windows")]
            auto_key_at: None,
            last_cursor: None,
            last_cursor_ms: 0,
            cursor_region_cache: None,
            pace_scale: 1,
            work_ema_ms: 0,
            motion_ema_bytes: 0,
            static_since: None,
            static_refined: false,
            perf: crate::rc::perf::FrameStats::new(),
            perf_last: crate::rc::perf::FrameTiming::idle(),
            tick_jpeg: false,
            _keep_awake: keep_awake,
        })
    }

    /// R6 硬编会话：配置强制 JPEG 时不开；打不开也回 None（走 JPEG）。
    /// Q3：配置 `hevc` 时按 HEVC 打开（打不开 SessionEncoder 会话内自动回落
    /// H.264，不再整个退 JPEG）。打开尺寸跟**当前抓取范围**的物理分辨率走
    /// （会话中换范围时 `encode_bgra` 检测到尺寸变化会自己重开）。
    /// 时间戳统一按 30fps 步进：输入提帧的上限也是 30fps（BOOST_MIN_GAP），
    /// 保证时间戳单调不倒退。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn open_h264(
        svc: &Arc<RcService>,
        virt: bool,
    ) -> Option<crate::rc::encode_h264::H264SessionEncoder> {
        // Q3：编码标准统一从会话参数快照取——`reset_stream_opts_from_cfg` 已把
        // 本机配置（rc_codec）解析进去，与会话中 SetCodec 的切换同一条通路；
        // uhd60 等自带 HEVC 偏好的档位也在这里生效。
        let opts = svc.stream_opts_snapshot();
        if opts.force_jpeg() {
            return None;
        }
        let codec = want_stream_codec(opts.profile.hevc, &opts.codec);
        let (pw, ph) = if virt {
            let (sx, sy, sw, sh) = virtual_screen_size();
            let _ = (sx, sy);
            (((sw.max(64) as u32) + 1) & !1, ((sh.max(64) as u32) + 1) & !1)
        } else {
            primary_screen_size()
        };
        // 时间戳 fps 按**本档位提帧上限**算（见 `want_fps_for`）：拖动时真实
        // 帧率就是它，编码器的 PTS 步进与码控分配才对得上。
        // 新建会话时还没跑过零拷贝判据 ⇒ `gpu_disabled = false`，但抓取范围
        // 已知，虚拟屏场景的降频仍要算进去。
        let id = svc.status().session.as_ref()?.id.clone();
        let fps = want_fps_for(svc.encode_profile().interval_ms, virt, false).min(svc.media_fps_limit(&id));
        // 起播也使用发送器的绝对预算，不能按另一套百分比开出过量码流。
        let budget = svc.media_budget_kbps(&id) * 1000;
        let enc = crate::rc::encode_h264::H264SessionEncoder::try_open_with_budget(
            codec, pw, ph, fps, budget,
        );
        if enc.available() {
            log::info!(
                "[RC] {} 硬编已启用 @ {pw}x{ph} {fps}fps（媒体预算 {}kbps，范围：{}）",
                codec.as_str().to_uppercase(),
                enc.scaled_bitrate() / 1000,
                if virt { "虚拟屏" } else { "主屏" }
            );
            Some(enc)
        } else {
            None
        }
    }

    /// 被控端结束会话时要用这条半流发 End（入站收口路径读它）。
    pub(in crate::rc) async fn register_send_slot(&mut self) {
        let ib = self.send.clone();
        let svc = self.svc.clone();
        tauri::async_runtime::spawn(async move {
            *svc.inbound_send.lock().await = Some(ib);
        });
    }

    /// 探针：本圈**实际**出的帧走了哪条管线（不是「本应走哪条」）。
    ///
    /// 🔴 2026-10-06：这里过去只看 `self.h264.is_some()`，于是抓屏熔断后整场
    /// 每帧编 JPEG、标签却恒打 `管线 H264`——硬编对象一直在，只是再也喂不进去
    /// （`grab` 直接报 `DXGI 已禁用`）。那条谎报让我反过来否掉了用户看到的实况，
    /// 所以标签必须回答「这一圈编了什么」，并区分三种兜底原因：
    /// - `无硬编` = 本会话就没开起来（用户配 jpeg / 编码器打不开）；
    /// - `抓屏已熔断` = DXGI 整池判死，`grab` 直接报错（编码器其实活着）；
    /// - `单帧回退` = 编码器在、抓屏在，这一帧没编出来（奇数尺寸 / 单帧编码失败）。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) fn pipeline_label(&self) -> String {
        if self.tick_jpeg {
            let why = if self.h264.is_none() {
                "无硬编"
            } else if !self.dxgi.is_enabled() {
                "抓屏已熔断"
            } else {
                "单帧回退"
            };
            return format!("JPEG（{why}）");
        }
        // 编码标准取自编码器本体（HEVC 可能已回落 H.264）
        match self.h264.as_ref().map(|e| e.codec().as_str().to_uppercase()) {
            // GPU 模式不好从外面读（`gpu_mode` 私有），但 `gpu_disabled` 能区分
            // 「零拷贝可用」与「已判死回落 CPU」，够诊断用了。
            Some(std) if self.gpu_disabled => format!("{std}-CPU（零拷贝已判死）"),
            Some(std) => std,
            None => "JPEG（无硬编）".to_string(),
        }
    }

    /// mobile 宿主没有硬编管线，恒 JPEG（相关字段在这个 cfg 下根本不存在）。
    #[cfg(not(target_os = "windows"))]
    pub(in crate::rc) fn pipeline_label(&self) -> String {
        "JPEG".to_string()
    }

    /// 探针（2026-09-21）：组装汇总行的运行时上下文——档位 / 节奏 / 实际管线。
    pub(in crate::rc) fn perf_extra(
        &self,
        opts: &crate::rc::stream_cfg::StreamOpts,
        interval: u64,
    ) -> crate::rc::perf::ReportExtra {
        // 「空转」= 本圈根本没出帧（屏幕未变化 / 被闸丢掉），跟「出了帧但是 JPEG」
        // 是两件事：把后者写成空转，兜底 25 分钟在日志里就是一片安静。
        let pipeline = if !self.perf_last.produced {
            "空转".to_string()
        } else {
            self.pipeline_label()
        };
        let active_quality = if self.svc.auto_enabled() {
            // 带上判档快照：「为什么不升档」以前只能反推，这次根因恰恰是反推
            // 不出来的一句 `> 0`（见 `StreamCfg::auto_diag`）。
            let diag = self.svc.auto_diag();
            let name = self.svc.auto_tier_name();
            if diag.is_empty() {
                name
            } else {
                format!("{name}（{diag}）")
            }
        } else {
            String::new()
        };
        crate::rc::perf::ReportExtra {
            profile: crate::rc::perf::profile_name(&opts.profile),
            interval_ms: interval,
            pace_scale: self.pace_scale,
            pipeline,
            active_quality,
            pick: None,
        }
    }

    /// 收尾行的上下文。档位取自**最后一次快照**（会话参数在结束时已不可靠）。
    pub(in crate::rc) fn perf_extra_last(&self) -> crate::rc::perf::ReportExtra {
        let opts = self.svc.stream_opts_snapshot();
        let interval = opts.profile.interval_ms;
        // 收尾时 `perf_last` 可能停在最后一个空转圈 → 别让它把管线谎报成「空转」
        let mut extra = self.perf_extra(&opts, interval);
        if extra.pipeline == "空转" {
            extra.pipeline = self.pipeline_label();
        }
        extra
    }

    /// R6 硬编路径：主屏 / 指定单屏 / 虚拟屏都走 DXGI + H.264；仅强制 JPEG 时回退。
    /// P1：fps120 档（interval ≤10ms）+ 单输出场景走 D3D11 零拷贝；
    /// 其余（多屏拼接 / 低档位 / GPU 路径不可用）走 CPU 管线，失败回 JPEG。
    pub(in crate::rc) async fn try_hardware_path(&mut self, opts: &crate::rc::stream_cfg::StreamOpts) -> Step {
        #[cfg(target_os = "windows")]
        {
            // 🔴 起播宽限闸（2026-10-03）：宽限内先不开硬编，等对端倍率/链路
            // 信息到位（`peer_net_seen`）或到期。宽限内本圈返回 FallThrough →
            // JPEG 兜底先出图（首帧反而更快，MFT 初始化要几百 ms），倍率到位后
            // 一次性按当前倍率开对，省掉一次全链重开。
            if let Some(due) = self.enc_first_open_at {
                let now = std::time::Instant::now();
                if !opts.force_jpeg()
                    && enc_first_open_due(due, now, self.svc.peer_net_seen())
                {
                    self.enc_first_open_at = None;
                    // 等了多久 = 宽限 − 剩余（已过期则记满宽限）
                    let waited_ms = ENC_OPEN_GRACE_MS.saturating_sub(
                        due.checked_duration_since(now)
                            .map_or(0, |d| d.as_millis() as u64),
                    );
                    log::info!(
                        "[RC] 起播宽限收闸（等 {waited_ms}ms{}），按当前倍率开硬编",
                        if self.svc.peer_net_seen() {
                            "，对端信息已到"
                        } else {
                            "，等满"
                        }
                    );
                    self.h264 = Self::open_h264(&self.svc, opts.virtual_screen);
                    if self.h264.is_none() {
                        // 首次打开失败：按既有退避口径安排重试（起步 5s、
                        // 翻倍至 60s），别让一次瞬态失败变成整场 JPEG。
                        self.enc_fail_streak = 0;
                        self.enc_retry_after =
                            Some(now + std::time::Duration::from_secs(self.enc_retry_backoff));
                    }
                } else {
                    // 宽限未到、对端还没发言：本圈不出 H.264 帧。
                    // 走 FallThrough 让 JPEG 兜底——手机先看到软图，别干等。
                    return Step::FallThrough;
                }
            }
            // 硬编熔断冷却期满 → 自动重开一次（2026-09-21）。
            // 放在入口、而不是埋在「本帧编码失败」分支里：那个分支每帧都会进，
            // 且开编码器要几百 ms，在那里重开会把推流拖垮。
            if self.h264.is_none() {
                // 配置强制 JPEG 时不重试：open_h264 必返回 None，重试只会
                // 刷「冷却期满」日志。enc_retry_after 保持原值不动——用户
                // 中途改回 H.264 时下一圈这里立刻生效。
                if !opts.force_jpeg() {
                    if let Some(t) = self.enc_retry_after {
                        if std::time::Instant::now() >= t {
                            log::info!("[RC] 硬编冷却期满，尝试重新启用");
                            self.h264 = Self::open_h264(&self.svc, opts.virtual_screen);
                            self.enc_fail_streak = 0;
                            self.enc_retry_after = None;
                            // 退避翻倍（上限 60s）：坏环境里别把 CPU 烧在反复重开上
                            self.enc_retry_backoff = (self.enc_retry_backoff * 2).min(60);
                            // 🔴 再审计 B2（2026-09-25）：重试**再失败**也必须安排
                            // 下一次——过去这里把 enc_retry_after 留成 None，一次
                            // 失败就整场不再重试（初始打开失败的场次更是从未重试过）。
                            // 翻倍发生在本次重试时，所以下一次冷却用翻倍后的值：
                            // 5s → 10s → 20s → 40s → 60s（上限），与熔断退避同口径。
                            if self.h264.is_none() {
                                self.enc_retry_after = Some(
                                    std::time::Instant::now()
                                        + std::time::Duration::from_secs(self.enc_retry_backoff),
                                );
                            }
                        }
                    }
                }
            }
            let Some(henc) = self.h264.as_mut() else {
                return Step::FallThrough;
            };
            if !henc.available() || opts.force_jpeg() {
                return Step::FallThrough;
            }
            // Q3/Q4：编码标准跟会话参数走——显式 SetCodec（hevc/av1/h264）或档位
            // 自带 HEVC 偏好（uhd60）都会触发编码器按需重开；HEVC 连续打不开
            // 时 SessionEncoder 自己回落 H.264。
            // 判据收口在 [`want_stream_codec`]（两处调用点：open_h264 / 每圈同步）。
            let codec = want_stream_codec(opts.profile.hevc, &opts.codec);
            henc.set_codec(codec);
            // 编码目标与发送节拍共用交付预算；动态重配优先，重开仅作后备。
            henc.apply_bitrate_budget(self.svc.media_budget_kbps(&self.my_id) * 1000);
            henc.resolution_limit = self.svc.media_resolution_limit(&self.my_id);
            // P0-2：对端解码断链 → 下一帧强制 IDR（设不中就等自然 GOP）
            if self.force_key.swap(false, Ordering::SeqCst) {
                let ok = henc.force_key();
                log::debug!("[RC] 对端请求关键帧：{}", if ok { "已强制" } else { "编码器不支持" });
            }
            // 时间戳 fps 跟档位走（120/60/30），判据收口在 `want_fps_for`：
            // 按**提帧上限**算而不是静止间隔——拖动时真实帧率就是它，
            // 编码器的 PTS 步进与 CBR 每帧 bit 分配才对得上（写错不崩，
            // 只会静默让码率腰斩，见该函数注释）。
            henc.set_fps(want_fps_for(
                opts.profile.interval_ms,
                opts.virtual_screen,
                self.gpu_disabled,
            ).min(self.svc.media_fps_limit(&self.my_id)));
            // P1/G5 零拷贝门控（2026-09-28 重判）：硬件 MFT + 单输出 + GPU 路径没判死。
            // 旧判据绑档位（fps120/uhd60），60Hz 机器永远进不了高帧率档 ⇒ 永远 GDI
            // CPU 捕获（拖动实测 53–74ms/帧）——零拷贝是本地收益，与网络档位无关。
            // 判据集中在 `EncodeProfile::wants_zero_copy`（有单测）——写错不崩、
            // 只会静默跑 CPU 管线。
            let want_gpu = henc.resolution_limit == 0 && opts.profile.wants_zero_copy(
                opts.virtual_screen,
                self.gpu_disabled,
                crate::rc::gpu::encode_caps().h264_gpu,
            );
            if want_gpu {
                // P0-2 延迟分段：抓帧耗时单独记
                let cap_t0 = std::time::Instant::now();
                let grabbed = self.dxgi.grab_gpu(opts.virtual_screen, opts.monitor);
                let cap_ms = cap_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
                match grabbed {
                    Err(e) if e.starts_with("[gpu_disabled]") => {
                        self.gpu_disabled = true;
                    }
                    Err(e) => {
                        // 🔴 再审计 B4（2026-09-25）：抓帧的瞬时错误也计入
                        // gpu_fail_streak（口径见 note_gpu_grab_fail）——过去这里
                        // 只写日志完全不计数，GPU 管线在抓帧层坏掉（AcquireNextFrame
                        // / staging 创建失败 / 输出拓扑对不上）时每帧白试一遍再回落
                        // CPU，整个会话都不会判死。
                        let verdict = henc.note_gpu_grab_fail(e);
                        if verdict.starts_with("[gpu_disabled]") {
                            self.gpu_disabled = true;
                        } else {
                            log::debug!("[RC] GPU 抓帧失败，本帧走 CPU：{verdict}");
                        }
                    }
                    Ok(None) => return Step::Sleep,
                    Ok(Some(g)) => {
                        // 采集时刻在 grab 之后取：编码/发送耗时不算进「画面链路延迟」
                        let ts = crate::rc::service::now_ms();
                        if let (Some(dev), Some(ctx)) =
                            (self.dxgi.d3d_device(), self.dxgi.d3d_ctx())
                        {
                            let enc_t0 = std::time::Instant::now();
                            henc.set_capture_at(ts);
                            let encoded =
                                henc.encode_gpu(&dev, &ctx, &g.tex, g.width, g.height);
                            let enc_ms =
                                enc_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
                            match encoded {
                                Ok(pkts) => {
                                    return self
                                        .send_h264_pkts(pkts, ts, cap_ms, enc_ms)
                                        .await;
                                }
                                Err(e) if e.starts_with("[gpu_disabled]") => {
                                    self.gpu_disabled = true;
                                }
                                Err(e) => {
                                    log::debug!("[RC] GPU 编码失败，本帧走 CPU：{e}");
                                }
                            }
                        }
                    }
                }
            }
            // ---- CPU 管线（多屏拼接 / 低档位 / GPU 路径不可用的兜底）----
            // P0-2 延迟分段：抓帧耗时单独记（HUD 分「慢在抓/慢在编/慢在网络」）
            let cap_t0 = std::time::Instant::now();
            let grabbed = self.dxgi.grab(opts.virtual_screen, opts.monitor);
            let cap_ms = cap_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
            match grabbed {
                Ok(Some((w, h, bgra))) => {
                    if w % 2 == 1 || h % 2 == 1 {
                        // NV12/H.264 要求偶数尺寸；奇数（理论上不该出现）本帧回 JPEG
                        return Step::FallThrough;
                    }
                    // 采集时刻就在 grab 之后取：编码/发送耗时不算进「画面链路延迟」
                    let ts = crate::rc::service::now_ms();
                    let enc_t0 = std::time::Instant::now();
                    henc.set_capture_at(ts);
                    // 🔴 再审计 P3-10：grab 现在返回池内缓冲的借用（不再转移所有权），
                    // 编码完即归还，缓冲跨圈复用
                    let encoded = henc.encode_bgra(bgra, w, h);
                    let enc_ms = enc_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
                    match encoded {
                        Ok(pkts) => {
                            self.enc_fail_streak = 0;
                            self.send_h264_pkts(pkts, ts, cap_ms, enc_ms).await
                        }
                        Err(e) => {
                            // P2-9：连续失败熔断——每帧重开编码器的代价比「画质
                            // 降级到 JPEG」高得多。
                            // ⚠️ 2026-09-21 修正：过去熔断是**整场会话永久**的
                            // （`h264 = None` 后再没机会回硬编）。但硬编失败常常是
                            // **瞬态**的（分辨率切换 / 显示器热插拔 / 全屏切换），
                            // 永久放弃等于把 7ms/帧 的硬编一路白丢到会话结束。
                            // 现改为**带冷却的自动重试**：熔断时按老做法置
                            // `h264 = None`（停止每帧重开编码器），记下冷却截止；
                            // 冷却期内稳定走 JPEG，期满自动 `open_h264` 重试一次。
                            // 退避 5s → 10s → 20s → 40s → 60s（上限），
                            // 避免在坏环境里反复重开把 CPU 烧光。
                            self.enc_fail_streak = self.enc_fail_streak.saturating_add(1);
                            if self.enc_fail_streak >= 60 {
                                if self.enc_retry_after.is_none() {
                                    log::warn!(
                                        "[RC] 硬编连续 {} 帧失败，暂停硬编走 JPEG；{}s 后自动重试：{e}",
                                        self.enc_fail_streak,
                                        self.enc_retry_backoff
                                    );
                                    self.enc_retry_after = Some(
                                        std::time::Instant::now()
                                            + std::time::Duration::from_secs(self.enc_retry_backoff),
                                    );
                                    // 真正的熔断动作：停掉每帧重开编码器
                                    self.h264 = None;
                                    // 探针：熔断次数（收尾行会带上）
                                    crate::rc::perf::bump_u32(&crate::rc::perf::counters::ENC_FUSE);
                                }
                                // 冷却是「暂停」不是「永久放弃」——但重开**不能在这里**：
                                // 本分支每帧都会进，且开编码器要几百 ms，必须等
                                // 冷却期满后再由下面的独立判断处理。
                            } else {
                                log::debug!(
                                    "[RC] 视频编码失败（第 {} 帧），本帧回退 JPEG：{e}",
                                    self.enc_fail_streak
                                );
                            }
                            Step::FallThrough
                        }
                    }
                }
                Ok(None) => Step::Sleep,
                Err(_) => {
                    // 探针：抓屏失败计数（`grab` 返回 Err 而非 Ok(None)——后者是
                    // 「屏幕没变」的正常空转，混为一谈会看不出真实故障）
                    crate::rc::perf::bump(&crate::rc::perf::counters::CAPTURE_FAIL);
                    Step::FallThrough
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = opts;
            Step::FallThrough
        }
    }

    /// 推送 H.264 包（CPU/GPU 两路共用）。
    ///
    /// P2-1 传输策略：**P 帧走 QUIC 数据报 + 帧内 XOR FEC**（不可靠但无队头
    /// 阻塞，丢片由 FEC 补、补不回由 corrupt→request_key 自愈）；**关键帧走
    /// 可靠流**并带帧序号（对端据此重置数据报重组器）。数据报缓冲挤满时：
    /// 关键帧回退流（有 seq 锚，安全），P 帧直接弃帧（下一帧在接收端成洞 →
    /// corrupt 等关键帧——绝不能用流补发，会造成双份同序号帧）。
    #[cfg(target_os = "windows")]
    pub(in crate::rc) async fn send_h264_pkts(
        &mut self,
        pkts: Vec<crate::rc::encode_h264::H264Packet>,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
    ) -> Step {
        if pkts.is_empty() {
            return Step::Sleep;
        }
        // 探针：H.264 路径出了帧。发送耗时在最后统一算——
        // 关键帧走可靠流、P 帧走数据报，两条路的 send 都要计入。
        let send_t0 = std::time::Instant::now();
        self.perf_last = crate::rc::perf::FrameTiming::produced(
            cap_ms as u64,
            enc_ms as u64,
            None, // 结尾补上真实发送耗时
        );
        // Q3：编码标准取自编码器本体（回落时同帧起即换）。
        let codec = self
            .h264
            .as_ref()
            .map(|e| e.codec())
            .unwrap_or(VideoCodec::H264);
        // VideoCodec（编码端）→ FrameCodec（线上帧标注）换算。
        let frame_codec = match codec {
            VideoCodec::Hevc => crate::rc::video::FrameCodec::Hevc,
            VideoCodec::Av1 => crate::rc::video::FrameCodec::Av1,
            VideoCodec::H264 => crate::rc::video::FrameCodec::H264,
        };
        // Q8 文本清晰：H264/HEVC 是 CBR 码控，静止画面的 P 帧几乎全是跳块，
        // 滚动文档落下的糊字不会被后续 P 帧修好（JPEG 路径有 300ms q95 精修，
        // 这条路径此前没有任何回补）。静止 >REFINE_AFTER_MS 时强制一个 IDR：
        // 整帧按当前码率重新编码，静止文本立刻变脆。静止判定用「只对动帧
        // 更新的字节基准」——EMA 连静止帧一起算会在高帧率下几十毫秒内收敛，
        // 阈值失真；动帧基准在静止期间保持稳定，静止多久都判得准。
        // 每轮静止只精修一次（画面再动才重新武装），不会周期性打爆码率。
        //
        // 🔴 判定交给纯函数 [`motion_verdict`]：这里曾是 `is_key || …`——
        //   精修强制出的 IDR 自己就被当成了「画面动了」，把 static_refined
        //   清掉重新武装，静止画面变成每 ~330ms 一个 IDR 的死循环。
        //   关键帧（无论自然 GOP 还是精修产物）不参与运动判定，见该函数。
        let frame_bytes: u64 = pkts.iter().map(|p| p.data.len() as u64).sum();
        let is_key = pkts.iter().any(|p| p.key);
        // 2A 自动档喂帧（2026-09-22 补）。
        //
        // 🔴 此前 H.264 路径**从不**调用 `auto_note_frame`——全项目只有 JPEG
        //    兜底路径喂（`video_run.rs::jpeg_path`）。后果：判据窗口永远是空的，
        //    自动档连一次换档判定都做不了，档位**永远停在起跑档**。而正常有硬编
        //    的机器走的都是这条路 ⇒ 「自动」实际等于「均衡 = 10fps」，
        //    正是「拖动窗口明显卡顿、窗口开关动画看不到」的主因之一。
        //    这种失效不报错、不掉帧，只能靠读调用点发现。
        //
        // 口径与 JPEG 路径一致：**关键帧不喂**——IDR 是节拍产物/一次性的
        //    大帧，喂进去会把「近帧均值」基准抬高一截（JPEG 路径同理跳过
        //    refine 帧，见 `jpeg_path` 的 `if !enc_out.refine`）。
        if !is_key {
            self.svc.auto_note_frame(frame_bytes as usize);
        }
        match motion_verdict(is_key, self.motion_ema_bytes, frame_bytes) {
            MotionVerdict::Ignore => {}
            MotionVerdict::Moving => {
                self.motion_ema_bytes = if self.motion_ema_bytes == 0 {
                    frame_bytes.max(1)
                } else {
                    (self.motion_ema_bytes * 7 + frame_bytes) / 8
                };
                self.static_since = None;
                self.static_refined = false;
            }
            MotionVerdict::Static => {
                let since = *self.static_since.get_or_insert(std::time::Instant::now());
                if !self.static_refined
                    && since.elapsed().as_millis() as i64 > crate::rc::video::REFINE_AFTER_MS
                {
                    if self.h264.as_ref().is_some_and(|e| e.force_key()) {
                        log::debug!("[RC] 画面静止，下一帧 IDR 精修（文本清晰）");
                    }
                    // 无论编码器支不支持都只试一次，别每圈都敲
                    self.static_refined = true;
                }
            }
        }
        // 🔴 数据报放行闸（2026-10-02 两次公网实测收口）：**默认可靠流**，只有
        // RTT 采样到达且路径快（`video_dgram_allowed`）才进一次数据报模式。
        // 未采样/中继路径永远可靠流：数据报在公网近乎全丢（18:15 会话千帧
        // 全丢）、在中继会灌爆桌面↔中继连接的拥塞窗口，把 pong/控制帧/JPEG
        // 流全部堵死（19:05 会话写流卡死断会）。进数据报时强制 IDR——对端
        // 重组器靠数据报 FLAG_KEY 重新起链。
        if self.peer_dgram
            && (!self.peer_media_plane || Self::dgram_force())
            && !self.dgram_allowed
            && (Self::dgram_force()
                || crate::rc::stream_cfg::video_dgram_allowed(
                    self.svc.video_rtt_ms(),
                    self.svc.loss_permille(),
                ))
        {
            self.dgram_allowed = true;
            self.force_key.store(true, std::sync::atomic::Ordering::SeqCst);
            // 视频若此前走在专属流上：弃流。半途切数据报后，旧流里残留的
            // 积压帧会晚到并打断 dgram 帧序（corrupt 自愈代价可免则免）。
            self.discard_media_stream();
            log::info!(
                "[RC] 视频切换数据报（force={}，rtt {}ms / loss {}‰）——并强制 IDR",
                Self::dgram_force(),
                self.svc.video_rtt_ms(),
                self.svc.loss_permille()
            );
        }
        for p in pkts {
            let ts = if p.at_ms > 0 { p.at_ms } else { ts };
            let sq = self.dgram.take_seq();
            // 走可靠流的两种情况：对端不支持数据报（能力位缺省），或数据报
            // 放行闸未开（未采样 / 公网 / 中继——默认态）。
            if !self.peer_dgram || !self.dgram_allowed {
                // 🔴「传输分 plane」（2026-10-03）：对端支持独立视频流 → H.264
                // 走**专属 uni 流**：不与 pong/输入共锁（心跳饿死根治），
                // 且熔断持续超阈时整流重建——旧流积压随流丢弃，延迟有上界。
                if self.peer_video_plane {
                    if !self
                        .send_via_video_plane(&p, sq, ts, cap_ms, enc_ms, codec.as_str())
                        .await
                    {
                        return Step::End;
                    }
                    continue;
                }
                // 旧对端（无 video_plane 位）：视频留在会话半流（历史形态）。
                // 🔴 积压熔断（2026-10-03）：可靠流没有「缓冲满→弃帧」信号，
                // 不熔断的话积压只进不出（08:22 真机会话往返涨到 46s）。判据
                // 与动作见 `melt_step`：单帧大阻塞进熔断 → 只弃大 P 帧，
                // 写入变快 = 队列排干 → 恢复。
                let (melt, action) = melt_step(
                    self.stream_melt,
                    self.stream_last_write_ms,
                    p.key,
                    p.data.len() as u64,
                );
                self.stream_melt = melt;
                if action == MeltAction::DropP {
                    // 🔴 只弃大 P 帧、不强制 IDR（教训见 `melt_step` 文档）：
                    // 强灌 IDR 会把最大的帧倒进已堵死的管子（09:52 中继会话
                    // 由此全程无帧）。接收端断链走 corrupt→RequestKey 自愈。
                    crate::rc::perf::bump(&crate::rc::perf::counters::STREAM_MELT);
                    log::debug!("[RC] 可靠流积压，弃大 P 帧 #{sq}");
                    continue;
                }
                let t0 = std::time::Instant::now();
                if !self.send_pkt_via_stream(&p, sq, ts, cap_ms, enc_ms, codec.as_str()).await {
                    return Step::End;
                }
                self.stream_last_write_ms = t0.elapsed().as_millis() as u64;
                continue;
            }
            // 关键帧也走数据报（2026-09-22 C1）。
            //
            // 🔴 旧实现把关键帧一律塞可靠流，理由是「有 seq 锚、安全」。代价是
            //    **队头阻塞**：可靠流与输入事件、心跳共用同一条 SendStream，
            //    而 1s GOP 的 IDR 常在几百 KB 量级（4K 更大）——拖动窗口时画面
            //    全屏变化、IDR 频繁且大，注入的鼠标事件就排在大帧后面，
            //    「操作跟手」直接失效。
            //    接收端其实**早就支持**数据报关键帧（`vid_dgram::feed_inner`
            //    收到 FLAG_KEY 会重锚 `next_seq`、清 `corrupt` 与 `hole_since`，
            //    单测 `组内丢两片整帧报废_corrupt等关键帧` 钉着「关键帧必须能
            //    重新起链」），只是一直没有发送方这么用。
            let loss = self.svc.loss_permille();
            match self
                .dgram
                .send_frame(
                    &self.conn, sq, &p.data, p.key, ts, cap_ms, enc_ms, p.width, p.height,
                    frame_codec, self.peer_fec_rs, loss,
                )
                .await
            {
                Ok(()) => { self.svc.media_sent(&self.my_id, self.media_started_ms(), ts, p.data.len()); }
                Err(crate::rc::vid_dgram::SendErr::Busy) if p.key => {
                    // 关键帧**不能弃**：丢了要等下一个 GOP（1s）才有锚，这期间
                    // 对端看到的全是花屏。数据报装不下（大 IDR 超过 iroh 的
                    // `datagram_send_buffer_size`，默认 1MiB）就回退可靠流——
                    // 慢一点，但一定到得了。
                    log::debug!("[RC] 关键帧装不进数据报缓冲，回退可靠流 #{sq}");
                    if !self.send_pkt_via_stream(&p, sq, ts, cap_ms, enc_ms, codec.as_str()).await {
                        return Step::End;
                    }
                }
                Err(crate::rc::vid_dgram::SendErr::Busy) => {
                    // P 帧：数据报缓冲满 = 拥塞。弃帧（接收端成洞 → corrupt →
                    // 要关键帧，走自愈）。
                    //
                    // C2：**主动**告知对端要 IDR，不等它发现缺口再走一个 RTT。
                    // 拖动窗口时这一路会连续命中（全屏变化的 P 帧动辄上百个
                    // 分片），被动自愈意味着「每次弃帧都要等一个往返 + 下一个
                    // IDR」，正是「拖起来一顿一顿」的来源。
                    crate::rc::perf::bump(&crate::rc::perf::counters::DGRAM_DROP);
                    self.request_key_after_drop();
                    log::debug!("[RC] 数据报缓冲满，弃 P 帧 #{sq} 并主动要 IDR");
                }
                Err(crate::rc::vid_dgram::SendErr::Dropped(e)) => {
                    crate::rc::perf::bump(&crate::rc::perf::counters::DGRAM_DROP);
                    // 分片发了一半就中断：本帧必然成洞，同样主动要 IDR
                    // （接收端也会走到同一结论，但要多花一个往返）。
                    self.request_key_after_drop();
                    log::debug!("[RC] P 帧分片发送中断（{e}）——主动要 IDR");
                }
            }
        }
        // 探针：补上真实发送耗时（上面循环里两种发送方式各自计时不划算，
        // 这里统一取整段时长——诊断要的是「发送这一段占了多少预算」）
        self.perf_last.send_ms = Some(send_t0.elapsed().as_millis() as u64);
        Step::Sleep
    }

    /// C2：数据报弃帧后**主动**要一个 IDR（带限频）。
    ///
    /// 不主动要的话，要等对端发现缺口 → 发 `request_key` → 再走一个 RTT，
    /// 这期间对端只能拿花屏或冻结的旧帧。拖动窗口时这一路会连续命中，
    /// 正是「拖起来一顿一顿」的来源之一。
    ///
    /// 🔴 限频不可省：IDR 是整帧大包，无节制地要会「拥塞→弃帧→要 IDR→
    /// 更拥塞」自激。门限见 [`AUTO_KEY_MIN_GAP_MS`]（同模块常量）。
    #[cfg(target_os = "windows")]
    fn request_key_after_drop(&mut self) {
        let now = std::time::Instant::now();
        if !auto_key_due(self.auto_key_at, now, AUTO_KEY_MIN_GAP_MS) {
            return;
        }
        self.auto_key_at = Some(now);
        // 消费点在 `try_hardware_path` 圈首：下一圈编码前 `henc.force_key()`。
        self.force_key.store(true, Ordering::SeqCst);
    }

    /// 走**可靠流**发一个 H.264/HEVC 包（关键帧的锚点路径，也是旧版发起端
    /// 与「关键帧装不进数据报缓冲」时的兜底）。
    ///
    /// 返回 `false` = 写失败、会话已收口，调用方必须立刻 `return Step::End`。
    ///
    /// 抽成方法而不是内联：调用点从 1 个变成 3 个（旧版发起端全走流 /
    /// 数据报装不下的关键帧回退 / 将来可能的其它兜底），三处各写一遍
    /// `write_h264` + 失败收口，必然漏掉一处（漏了就是「推流失败但循环
    /// 继续跑」的僵尸会话）。
    /// ❗ 必须 `&mut self` 而不是 `&self`：本方法有 await 点，`&self` 会把
    /// `&InboundVideo` 带进 future，而 spawn 要求 `Send` ⇒ 需要
    /// `InboundVideo: Sync`；`DxgiPool` 持有 `NonNull<c_void>`，它是 `Send`
    /// 但不是 `Sync`。`&mut T` 只要求 `T: Send`。（同一条钉子见 `rc/mod.rs`
    /// 的并发说明，2026-09-22 这里又踩了一次。）
    #[cfg(target_os = "windows")]
    async fn send_pkt_via_stream(
        &mut self,
        p: &crate::rc::encode_h264::H264Packet,
        sq: u32,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
        codec_label: &str,
    ) -> bool {
        if self.peer_video_plane {
            return self.send_via_video_plane(p, sq, ts, cap_ms, enc_ms, codec_label).await;
        }
        let mut guard = self.send.lock().await;
        if crate::rc::video::write_h264(
            &mut guard,
            &p.data,
            p.key,
            p.width,
            p.height,
            ts,
            cap_ms,
            enc_ms,
            sq,
            codec_label,
        )
        
        .await
        .is_err()
        {
            drop(guard);
            self.svc
                .force_end_if_session(&self.my_id, "H.264 推送失败")
                .await;
            return false;
        }
        true
    }
}
