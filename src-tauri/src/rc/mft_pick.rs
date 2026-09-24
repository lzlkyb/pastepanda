//! 硬编 MFT 的**选型与探测**（2026-09-21 从 `encode_h264.rs` 拆出）。
//!
//! # 为什么单独一个文件
//!
//! 这里是「哪个编码器能用」的全部逻辑：枚举 → 排序 → 逐台试编 → 交出干净实例，
//! 外加媒体类型/sample 的构造工具。它与「编码器怎么用」（`MfH264Encoder` 的
//! open/encode/drain）是两种完全不同的变更理由——前者随显卡与驱动演进，
//! 后者随 MF 协议演进。拆开之前，`encode_h264.rs` 里 460 余行是这块。
//!
//! # 🔴 三条实测约束（改这里之前必读，来源 `probe/rc-mft-type`）
//!
//! 1. **枚举不能带 NV12 输入约束**。硬编 MFT 全是 async，在设输出类型之前
//!    `GetInputAvailableType` 返回空 → 带 NV12 约束的 `MFTEnumEx` 枚举 **0 台**。
//! 2. **不能盲取 `slice[0]`**。本机实测 H.264 枚举序是
//!    `[0] Intel QSV（✗ 首帧挂死）`、`[1] NVIDIA NVENC（✓ 7ms/帧）`——盲取必失败。
//! 3. **试编探测与正式使用必须是两个独立实例**。`probe_encodable` 会设类型、
//!    开流、喂帧；把探测过的实例交出去，`open_inner` 就在一个「已跑过流」的
//!    transform 上重新协商类型，行为未定义。
//!
//! 对外暴露 `create_h264_mft`（选型主入口）与一组媒体类型/sample 构造工具；
//! `open_inner`（`encode_h264.rs`）与它一起完成「开一台编码器」。

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;

use super::encode_h264::{
    bitrate_for_width, h264_level_for, mf_err, VideoCodec, H264_PROFILE_HIGH,
};

/// 试编探测用的固定尺寸/帧率。
///
/// 用固定值而非调用方真实分辨率：探测只回答「这台能不能出包」，
/// 与目标分辨率无关；固定值也让多台 MFT 的探测耗时可比。
const PROBE_W: u32 = 1920;
const PROBE_H: u32 = 1080;
const PROBE_FPS: u32 = 30;

/// 单台候选试编的**墙钟上限**（毫秒）。超时即判该台不可用，转下一台。
///
/// # 阈值依据（2026-09-23 实测，本机 3 台候选 × 4 次真机会话的 `编码器选型` 报告）
/// - 正常路径单台最坏 **580ms**（Intel QSV；四次采样 440/402/439/580）
/// - NVIDIA 的 `ActivateObject` 失败 28–68ms（最快的一台）
/// - [`probe_feed`] 内部的事件等待理论最坏 2700ms（两帧 ×「等 NeedInput
///   1500ms + 等输出 600ms」）——外层必须**大于**它，否则会把「内层本来能
///   处理完的慢路径」误标成超时（结论同为不可用，但日志会失去「失败原因」
///   这一维度，排障时很值钱）
///
/// 取 3000ms ⇒ 正常路径有 5 倍余量，内层最坏之上再留 300ms 给实例化与类型协商。
/// **只有真挂死才触发**（单次 COM 调用不返回，内层 deadline 检查不到）。
const PROBE_TIMEOUT_MS: u64 = 3000;

/// 一次选型的**总预算**（毫秒）。超了就不再试后续候选。
///
/// 单台兜底会按候选数线性放大（6 台 × 3s = 18s），而选型跑在 **tokio worker**
/// 上、调用方在等。6000ms 够「2 台各挂满 3s」或「1 台挂满 + 其余正常走完」，
/// 又不至于把一次选型拖到十几秒。
const PICK_BUDGET_MS: u64 = 6000;

/// 同步 MFT 单帧最多收多少个包（防「行为异常时永远返回有输出」的死循环）。
///
/// 低延迟模式下「一帧出一包」是常态，本值纯属保险——不是为了限制产量，
/// 而是为了让死循环变成一次正常的失败返回（比超时弃置线程更干净的收场）。
const MAX_DRAIN_PER_FRAME: usize = 64;

/// 单台候选的试编结论。
///
/// 区分「失败」与「超时」不是为了好看：超时意味着**线程没回来**（工作线程已
/// 弃置），失败意味着**线程回来了但报了错**。两者的下一步处置完全不同。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeOutcome {
    /// 试编出包 ⇒ 这台可用
    Passed,
    /// `ActivateObject` 失败（含原地重试）
    ActivateFailed,
    /// 实例化成功，但试编没出包
    EncodeFailed,
    /// 超过 [`PROBE_TIMEOUT_MS`] 仍未返回
    TimedOut,
}

/// 让 `IMFActivate` 能交给试编线程。
///
/// `windows` crate 把 COM 接口统一标成 `!Send`，但这里跨线程传它是安全的：
/// ① 传的是 MFT 的**激活器（类厂）**，不是 MFT 实例——实例在接收线程里创建、
///    也在接收线程里使用，符合 MF「MFT 非线程安全、应单线程使用」的约定；
/// ② 接收线程自己 `CoInitializeEx(MTA)`，与创建线程**同属 MTA**——MTA 内
///    跨线程直接调用接口指针是 COM 允许的（同公寓无需 marshalling）；
/// ③ 这里移交的是 `AddRef` 后的引用，引用计数是原子的。
struct SendActivate(IMFActivate);
unsafe impl Send for SendActivate {}

impl SendActivate {
    /// 在试编线程里执行「实例化 + 试编」。
    ///
    /// # Safety
    /// 与 [`activate_and_probe`] 同一要求：调用线程必须先 `CoInitializeEx(MTA)`
    /// （`activate_and_probe` 自己会做），且同一时刻只有一个线程在用这个激活器。
    ///
    /// 为什么做成**消耗 `self` 的方法**而不是自由函数：Rust 2021 的精确捕获
    /// （disjoint closure captures）会让 `move || activate_and_probe(&job.0, ..)`
    /// 只捕获字段 `job.0`（即裸 `IMFActivate`），从而**绕过**上面那句
    /// `unsafe impl Send for SendActivate`，编译期直接报 `NonNull<c_void>` 不可 Send
    /// （2026-09-23 实测踩到）。写成消耗 `self` 的方法，闭包就必须捕获整个
    /// `SendActivate`，安全断言才真正生效。
    unsafe fn probe(self, codec: VideoCodec) -> ProbeOutcome {
        activate_and_probe(&self.0, codec)
    }
}

/// 在独立线程里跑 `job`，最多等 `timeout`；超时/建线程失败/子线程 panic
/// 一律返回 `None`（调用方据此判该台不可用）。
///
/// # 为什么必须另起线程
///
/// MF 硬编 MFT 在驱动异常时会**永久挂住**——不是返回错误，是单次
/// `GetEvent` / `ProcessOutput` 永不返回（本机 Intel QSV 的典型形态就是
/// 「首帧抛流变化后事件流再也不回包」）。试编跑在**调用线程**上，而调用链是
/// `video_run → try_hardware_path`（async）→ `open_h264`（同步）→ 选型，
/// 也就是**一个 tokio worker**：一台挂死就占死一个 worker，且此后每次
/// 熔断冷却重试都再占一个。
///
/// Rust 的 `JoinHandle` 没有 join-timeout，所以用 channel + `recv_timeout`。
/// 超时后工作线程**弃置不管**（detached）——它卡在驱动里，没有安全的回收手段，
/// 只能等进程退出。一次选型最多泄漏与候选数相同的线程数，可接受。
///
/// 泛型化是为了**可单测**：真 MFT 在单测里造不出来，但「超时到底生不生效」
/// 是本机制的全部价值，必须被验证过（见文件末的 `timeout_tests`）。
fn run_with_timeout<T, F>(job: F, timeout: std::time::Duration, what: &str) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("rc-mft-probe".into())
        .spawn(move || {
            // `send` 失败只表示主线程已超时离开，值被丢弃即可
            let _ = tx.send(job());
        });
    if let Err(e) = spawned {
        log::warn!("[RC] {what}：工作线程创建失败（{e}），判该台不可用");
        return None;
    }
    match rx.recv_timeout(timeout) {
        Ok(v) => Some(v),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            log::warn!(
                "[RC] {what}：超过 {}ms 未返回（MFT 无响应），判该台不可用——工作线程已弃置",
                timeout.as_millis()
            );
            None
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            log::warn!("[RC] {what}：工作线程异常退出（panic），判该台不可用");
            None
        }
    }
}

/// 试编线程主体：`CoInitializeEx(MTA)` → 实例化（失败原地重试一次）→ 试编。
///
/// 整个「实例化 + 试编」都放在这条线程里（而不只是 `probe_encodable`）：
/// MFT 从创建到使用都在同一条线程上，不必把 `IMFTransform` 跨线程传——
/// 少一处需要论证线程安全性的地方。
///
/// # Safety
/// `act` 必须是 `MFTEnumEx` 返回的有效激活器；同一时刻只能有一个线程在用它
/// （本函数由 [`SendActivate::probe`] 在独占所有权下调用，天然满足）。
/// 线程内自行完成 COM 初始化，调用方不必预初始化。
unsafe fn activate_and_probe(act: &IMFActivate, codec: VideoCodec) -> ProbeOutcome {
    // 新线程必然是未初始化 COM 的干净状态 ⇒ 这里应得 `S_OK`（被拒会留告警）
    super::mft_diag::ensure_mta_quiet("MFT 试编线程");
    let name = friendly_name_of(act).unwrap_or_else(|| "(无名)".into());
    let t = match act.ActivateObject::<IMFTransform>() {
        Ok(t) => t,
        // 🔴 2026-09-23：真机上这台报 `0x8000FFFF`，而**同参数的外部探针 ✓**
        // （`pick.exe --luid --probe-both`，同机同时段）。先原地重试一次，
        // 把「瞬态」与「持久」分开——重试能救活就是真修复。
        Err(e) => match act.ActivateObject::<IMFTransform>() {
            Ok(t) => {
                log::warn!("[RC] 编码器「{name}」首次实例化失败（{e}），原地重试成功");
                t
            }
            Err(e2) => {
                log::warn!("[RC] 编码器「{name}」ActivateObject 失败：{e}（重试亦失败：{e2}）");
                return ProbeOutcome::ActivateFailed;
            }
        },
    };
    if probe_encodable(&t, codec) {
        ProbeOutcome::Passed
    } else {
        ProbeOutcome::EncodeFailed
    }
}

/// 提取 D3D11 设备所在 DXGI 适配器的 LUID（打包成 u64：High<<32 | Low）。
/// 提不到（异常驱动）返回 None，调用方退回「枚举第一个」的旧行为。
pub(super) fn adapter_luid_of(device: &ID3D11Device) -> Option<u64> {
    use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGIAdapter};
    unsafe {
        let dxgi: IDXGIDevice = device.cast().ok()?;
        let adapter: IDXGIAdapter = dxgi.GetAdapter().ok()?;
        let desc = adapter.GetDesc().ok()?;
        Some(((desc.AdapterLuid.HighPart as i64 as u64) << 32) | desc.AdapterLuid.LowPart as u64)
    }
}

/// 挑一台可用的硬编 MFT 并 ActivateObject 返回。
///
/// ⚠️ 2026-09-21 三处修正（探针 `probe/rc-mft-type` 实测，逐条有数据）：
/// ① **枚举不能带 NV12 输入约束**。硬编 MFT 全是 async，在设输出类型之前
///    `GetInputAvailableType` 返回空 → 带 NV12 约束的 `MFTEnumEx` 枚举 **0 台**。
///    `pick` 探针验证：去掉输入约束后 H.264/HEVC 各枚举到 3 台。
/// ② **不能盲取 `slice[0]`**。实测 H.264 枚举顺序是
///    `[0] Intel QSV H.264（✗ 首帧挂死）`、`[1] NVIDIA NVENC H.264（✓ 7ms/帧）`——
///    盲取第一个必失败。改为**按序试编**：每台真喂几帧，第一台能出包的就用。
/// ③ 试编成本只在**开编码器时**付一次（约几十 ms），不是每帧，可以接受。
pub(super) unsafe fn create_h264_mft(prefer_adapter: Option<u64>, codec: VideoCodec) -> Result<IMFTransform, String> {
    let pick_t0 = std::time::Instant::now();
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *codec.mf_subtype(),
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    // 硬件 MFT 多为 async：不能只用 HARDWARE|SYNCMFT（会枚举 0 个掉进软编）
    for flags in [
        MFT_ENUM_FLAG_HARDWARE,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT,
        MFT_ENUM_FLAG_ALL,
    ] {
        count = 0;
        acts = std::ptr::null_mut();
        let _ = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            None, // ← 不带输入约束（见上方 ①）
            Some(&out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            break;
        }
    }
    if count == 0 || acts.is_null() {
        return Err(format!("无 {} MFT", codec.as_str()));
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);

    // 候选排序：LUID 匹配的排最前（混合显卡零拷贝路径需要同适配器），其余按枚举序。
    // 去重按原始指针：`IMFActivate` 的 clone 只是 AddRef 同一 COM 对象，
    // 指针相等即同一个 MFT。
    let mut order: Vec<IMFActivate> = Vec::new();
    if let Some(want) = prefer_adapter {
        for a in slice.iter().flatten() {
            if a.GetUINT64(&MFT_ENUM_ADAPTER_LUID).map(|v| v == want).unwrap_or(false) {
                order.push(a.clone());
            }
        }
        if order.is_empty() {
            log::warn!("[RC] 没有 LUID 匹配的编码 MFT，退回枚举顺序");
        }
    }
    for a in slice.iter().flatten() {
        let dup = order
            .iter()
            .any(|c| std::ptr::eq(c.as_raw(), a.as_raw()));
        if !dup {
            order.push(a.clone());
        }
    }
    CoTaskMemFree(Some(acts as _));

    // 逐台试编：第一台真能出包的才返回
    //
    // 🔴 诊断探针（2026-09-21）：选型过程过去在日志里是**隐形的**——只知道
    // 「硬编没启用」，不知道试了几台、每台为何失败、花了多久。2026-09-21
    // 排查「H.264 从未启用」时，正是这三条信息的缺失让定位绕了远路。
    // 现在把每台的试编结果记进 `MftPickReport`，由 `perf` 模块渲染成一条
    // 可 grep 的日志（`grep 编码器选型`）。
    let mut report = super::perf::MftPickReport {
        candidates: order.len(),
        ..Default::default()
    };
    let mut tried = 0usize;
    // `take(6)` 的上限顺带决定「预算耗尽时还剩几台没试」的算法
    let take = order.len().min(6);
    for act in order.iter().take(6) {
        // 总预算：单台兜底会按候选数线性放大，全挂时不能让调用方等十几秒
        let used_ms = pick_t0.elapsed().as_millis() as u64;
        if used_ms >= PICK_BUDGET_MS {
            log::warn!(
                "[RC] 选型总预算 {PICK_BUDGET_MS}ms 已耗尽（已用 {used_ms}ms），放弃剩余 {} 台候选",
                take - tried
            );
            break;
        }
        tried += 1;
        let name = friendly_name_of(act).unwrap_or_else(|| "(无名)".into());
        let probe_t0 = std::time::Instant::now();
        // 🔴 试编放在**独立线程 + 带超时**里（2026-09-23）。三条理由：
        // ① 探测与使用**必须是两个独立实例**：`probe_encodable` 会设类型、开流、
        //    喂帧，若把探测用的实例直接交出去，`open_inner` 就在一个「已跑过流的」
        //    transform 上重新协商类型——行为未定义。多 ActivateObject 一次只是一次
        //    COM 实例化，代价可忽略。
        // ② MFT 在驱动异常时会**永久挂住**（单次调用不返回），而选型跑在 tokio
        //    worker 上——一台挂死就占死一个 worker，此后每次熔断冷却重试再占一个。
        // ③ 挂死时 `probe_encodable` 内部的 deadline 也救不了：它只在**两次调用
        //    之间**检查，单次 `GetEvent` / `ProcessOutput` 卡住就永远走不到检查点。
        // 机制与阈值依据见 `run_with_timeout` 与 `PROBE_TIMEOUT_MS` 的注释。
        let job = SendActivate(act.clone());
        let outcome = run_with_timeout(
            // ⚠️ 必须写成 `job.probe(..)`（消耗 self 的方法）——写成
            // `activate_and_probe(&job.0, ..)` 会被精确捕获绕过 `Send` 断言
            move || unsafe { job.probe(codec) },
            std::time::Duration::from_millis(PROBE_TIMEOUT_MS),
            &format!("编码器「{name}」试编"),
        )
        .unwrap_or(ProbeOutcome::TimedOut);
        let ms = probe_t0.elapsed().as_millis() as u64;
        match outcome {
            ProbeOutcome::Passed => report.details.push((name.clone(), true, ms)),
            ProbeOutcome::TimedOut => {
                // 超时告警已在 `run_with_timeout` 内按名打过，这里只记账
                report.details.push((format!("{name}（超时）"), false, ms));
                continue;
            }
            ProbeOutcome::ActivateFailed | ProbeOutcome::EncodeFailed => {
                log::warn!("[RC] 编码器「{name}」试编失败，尝试下一台");
                report.details.push((name.clone(), false, ms));
                continue;
            }
        }
        // 探测通过 → 另起一台干净的实例交给调用方
        match act.ActivateObject::<IMFTransform>() {
            Ok(clean) => {
                if tried > 1 {
                    log::info!(
                        "[RC] 跳过 {} 台不可用编码器，选中「{name}」",
                        tried - 1
                    );
                }
                report.tried = tried;
                report.skipped = tried.saturating_sub(1);
                report.chosen = name;
                report.pick_ms = pick_t0.elapsed().as_millis() as u64;
                log::info!("{}", super::perf::render_pick(&report));
                return Ok(clean);
            }
            Err(e) => {
                log::warn!("[RC] 编码器「{name}」二次实例化失败：{e}");
                report.details.push((format!("{name}（二次实例化失败）"), false, 0));
            }
        }
    }
    report.tried = tried;
    report.skipped = tried;
    report.pick_ms = pick_t0.elapsed().as_millis() as u64;
    log::warn!("{}", super::perf::render_pick(&report));
    // 全败 ⇒ 取证：本线程公寓 + 原地重测（瞬态/持久）+ 干净线程对照（线程局部/进程全局）。
    // 「探针 ✓ / 真机 ✗」这类差异靠猜是猜不出来的，只能把现场量出来。
    super::mft_diag::dump_pick_failure(codec);
    Err(format!(
        "{} 的 {tried} 台硬编 MFT 全部试编失败",
        codec.as_str()
    ))
}

/// IMFActivate 的友好名（日志用）。
///
/// `pub(super)`：`mft_diag` 也要用它标注每台的结果，**别在那边再写一份**
/// （同一份友好名两处实现，改其一就静默分叉）。
pub(super) unsafe fn friendly_name_of(act: &IMFActivate) -> Option<String> {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len))
        .ok()
        .map(|_| {
            String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)])
        })
}

/// 试编探测：不改变 transform 的对外状态，只回答「这台 MFT 能不能一路出包」。
///
/// 为什么不能用「尝试设类型」代替：`pick` 探针实测 Intel QSV H.264 的
/// **设类型全部成功**，坏是坏在首帧 ProcessOutput（抛流变化后事件流挂死）——
/// 只有真喂一帧才暴露得出来。
/// 这里让 transform 走完完整的类型协商（顺序见 `open_inner`）再喂 2 帧，
/// 至少出 1 包才判可用。
pub(super) unsafe fn probe_encodable(t: &IMFTransform, codec: VideoCodec) -> bool {
    let (w, h, fps) = (PROBE_W, PROBE_H, PROBE_FPS);
    let Ok(attrs) = t.GetAttributes() else {
        return false;
    };
    let is_async = attrs
        .GetUINT32(&MF_TRANSFORM_ASYNC)
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_async && attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).is_err() {
        return false;
    }
    // 先输出后输入（顺序见 open_inner 的注释）
    let bitrate = bitrate_for_width(w);
    let Ok(out_type) = create_video_type(codec.mf_subtype(), w, h, fps) else {
        return false;
    };
    let _ = out_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
    if codec == VideoCodec::H264 {
        let _ = out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH);
        let _ = out_type.SetUINT32(&MF_MT_MPEG2_LEVEL, h264_level_for(w, h, fps));
    }
    if t.SetOutputType(0, &out_type, 0).is_err() {
        return false;
    }
    let Ok(in_type) = create_video_type(&MFVideoFormat_NV12, w, h, fps) else {
        return false;
    };
    if t.SetInputType(0, &in_type, 0).is_err() {
        return false;
    }
    // open 阶段的一次性再协商（NVIDIA 在这里抛流变化，见 open_inner 同段逻辑）
    for _ in 0..2 {
        let Ok(mt) = t.GetOutputAvailableType(0, 0) else {
            break;
        };
        let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
        let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps, 1));
        if t.SetOutputType(0, &mt, 0).is_ok() {
            break;
        }
    }
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    // 造一帧中性 NV12（灰阶渐变，避免编码器走「全黑零成本」路径给出假阳性）
    let need = (w * h * 3 / 2) as usize;
    let mut nv12 = vec![0u8; need];
    for (i, b) in nv12.iter_mut().take((w * h) as usize).enumerate() {
        *b = ((i as u32 * 7 / w.max(1)) % 200 + 16) as u8;
    }
    for b in nv12.iter_mut().skip((w * h) as usize) {
        *b = 128;
    }

    // async 走事件协议；同步直接 ProcessInput/ProcessOutput
    let events: Option<IMFMediaEventGenerator> = if is_async {
        t.cast().ok()
    } else {
        None
    };
    let mut got = 0usize;
    for idx in 0..2u64 {
        match probe_feed(t, events.as_ref(), &nv12, idx, need) {
            Ok(n) => got += n,
            Err(_) => break,
        }
        if got > 0 {
            break;
        }
    }
    let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    got > 0
}

/// 试编喂一帧，返回收到的包数。
unsafe fn probe_feed(
    t: &IMFTransform,
    events: Option<&IMFMediaEventGenerator>,
    nv12: &[u8],
    idx: u64,
    need: usize,
) -> Result<usize, ()> {
    let Ok(sample) = make_sample(nv12, need, idx, PROBE_FPS) else {
        return Err(());
    };
    let mut got = 0usize;
    match events {
        None => {
            if t.ProcessInput(0, &sample, 0).is_err() {
                return Err(());
            }
            // 同步 MFT 直接收包。上限防「MFT 行为异常时永远返回有输出」的死循环：
            // 外层 `run_with_timeout` 虽然也能兜住，但那时工作线程已被弃置（泄漏）；
            // 这里给一个正常绝对够用的上限就避免了这次泄漏。
            while got < MAX_DRAIN_PER_FRAME && matches!(drain_probe(t), Ok(true)) {
                got += 1;
            }
        }
        Some(eg) => {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            let mut need_input = false;
            while !need_input {
                if std::time::Instant::now() >= deadline {
                    return Err(());
                }
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            return Err(());
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            need_input = true;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(_) => return Err(()),
                }
            }
            if t.ProcessInput(0, &sample, 0).is_err() {
                return Err(());
            }
            let out_deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(600);
            while std::time::Instant::now() < out_deadline {
                match eg.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        let ty = ev.GetType().unwrap_or(0);
                        if ty == MEError.0 as u32 {
                            return Err(());
                        }
                        if ty == METransformHaveOutput.0 as u32 {
                            match drain_probe(t) {
                                Ok(true) => got += 1,
                                Ok(false) => {}
                                Err(_) => return Err(()),
                            }
                            break;
                        }
                        if ty == METransformNeedInput.0 as u32 {
                            break;
                        }
                    }
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(_) => return Err(()),
                }
            }
        }
    }
    Ok(got)
}

/// 试编收包，返回是否收到（错误直接吞掉——探测而已）。
unsafe fn drain_probe(t: &IMFTransform) -> Result<bool, ()> {
    let mut outs = [MFT_OUTPUT_DATA_BUFFER {
        dwStreamID: 0,
        ..Default::default()
    }];
    let mut status = 0u32;
    match t.ProcessOutput(0, &mut outs, &mut status) {
        Ok(()) => Ok(outs[0].pSample.is_some()),
        Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(false),
        Err(_) => Err(()),
    }
}

/// 取 MFT 自己给出的输出类型为基准，只改帧尺寸/帧率/码率/profile。
///
/// 为什么不能自造：探针实测 NVIDIA MFT 对自造的 2560×1440 输出类型报
/// `MF_E_DXGI_UNSUPPORTED_DEVICE (0xC00D6D76)`，而用 MFT 自己给的类型
/// （帧尺寸字段为 0，即「未指定」，由调用方填）改尺寸后立刻通过。
/// 用 MFT 给的类型还有个附赠好处：它带着厂商要求的其余属性
///（如 `MF_MT_MPEG2_PROFILE` 的默认值、色彩信息），不必我们猜。
pub(super) unsafe fn pick_output_type(
    t: &IMFTransform,
    codec: VideoCodec,
    w: u32,
    h: u32,
    fps: u32,
    bitrate: u32,
) -> Result<IMFMediaType, String> {
    // 找第一个 subtype 匹配的可用输出类型
    let mut base: Option<IMFMediaType> = None;
    for i in 0..16u32 {
        let Ok(mt) = t.GetOutputAvailableType(0, i) else {
            break;
        };
        let ok = mt
            .GetGUID(&MF_MT_SUBTYPE)
            .map(|g| g == *codec.mf_subtype())
            .unwrap_or(false);
        if ok {
            base = Some(mt);
            break;
        }
    }
    let mt = base.ok_or("MFT 没有该 subtype 的可用输出类型")?;
    // 只改我们关心的：帧尺寸 / 帧率 / 码率（其余保留 MFT 的原始设定）
    mt.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(mf_err)?;
    let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1));
    let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
    let _ = mt.SetUINT32(&MF_MT_INTERLACE_MODE, 2);
    // Q3：profile/level 只有 H.264 标注——HEVC MFT 强写 H.264 语义的这两个键会拒开
    if codec == VideoCodec::H264 {
        let _ = mt.SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_HIGH);
        let _ = mt.SetUINT32(&MF_MT_MPEG2_LEVEL, h264_level_for(w, h, fps));
    }
    Ok(mt)
}

/// 造视频媒体类型。⚠️ 2026-09-21：`fps` **必须**带上（探针 A/B 对照实测）——
/// 过去只设 5 个属性（major/subtype/interlace/frame_size/PAR），硬编 MFT 一律
/// 拒收，报 `MF_E_INVALIDTYPE (0xC00D36B4)`。补 `MF_MT_FRAME_RATE` 后
/// NVIDIA NVENC / Intel QSV 四台编码器全部接受。
pub(super) unsafe fn create_video_type(
    subtype: &windows::core::GUID,
    w: u32,
    h: u32,
    fps: u32,
) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(mf_err)?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(mf_err)?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(mf_err)?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(mf_err)?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(mf_err)?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32x2(1, 1))
        .map_err(mf_err)?;
    t.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1))
        .map_err(mf_err)?;
    Ok(t)
}

pub(super) fn pack_u32x2(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

pub(super) fn pack_ratio(n: u32, d: u32) -> u64 {
    pack_u32x2(n, d)
}

/// P1：把 NV12 GPU 纹理包装成编码器输入 sample（D3D11-aware MFT 用）。
pub(super) unsafe fn make_dxgi_sample(
    tex: &ID3D11Texture2D,
    idx: u64,
    fps: u32,
) -> Result<IMFSample, String> {
    let iid = <ID3D11Texture2D as Interface>::IID;
    let buf = MFCreateDXGISurfaceBuffer(&iid, tex, 0, false).map_err(mf_err)?;
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

pub(super) unsafe fn make_sample(nv12: &[u8], len: usize, idx: u64, fps: u32) -> Result<IMFSample, String> {
    let buf = MFCreateMemoryBuffer(len as u32).map_err(mf_err)?;
    {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut max = 0u32;
        let mut cur = 0u32;
        buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
            .map_err(mf_err)?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, len);
        }
        buf.SetCurrentLength(len as u32).map_err(mf_err)?;
        buf.Unlock().map_err(mf_err)?;
    }
    let sample = MFCreateSample().map_err(mf_err)?;
    sample.AddBuffer(&buf).map_err(mf_err)?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    let dur = 10_000_000u64 / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(mf_err)?;
    sample.SetSampleDuration(dur as i64).map_err(mf_err)?;
    Ok(sample)
}

pub(super) unsafe fn lock_buf(buf: &IMFMediaBuffer) -> Result<Vec<u8>, String> {
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut max = 0u32;
    let mut cur = 0u32;
    buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
        .map_err(mf_err)?;
    let n = if cur > 0 { cur as usize } else { max as usize };
    let mut out = vec![0u8; n];
    if !data.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(data, out.as_mut_ptr(), n);
    }
    buf.Unlock().map_err(mf_err)?;
    Ok(out)
}

#[cfg(test)]
mod timeout_tests {
    use super::{run_with_timeout, ProbeOutcome, MAX_DRAIN_PER_FRAME, PICK_BUDGET_MS, PROBE_TIMEOUT_MS};
    use std::time::{Duration, Instant};

    /// 守卫：超时必须生效，且必须**及时**返回。
    ///
    /// 这是本机制的全部价值所在，而真 MFT 在单测里造不出来（需要真显卡与驱动），
    /// 所以只能把「超时语义」单独验证掉——它一旦失效，恢复成的是
    /// 「一台 MFT 挂死 → 占死一个 tokio worker」，且在日志里看不出来。
    #[test]
    fn 慢任务必须被超时掐断() {
        let t0 = Instant::now();
        let r: Option<u32> = run_with_timeout(
            || {
                std::thread::sleep(Duration::from_millis(800));
                7
            },
            Duration::from_millis(80),
            "单测慢任务",
        );
        assert_eq!(r, None, "超过 timeout 的任务必须返回 None");
        assert!(
            t0.elapsed() < Duration::from_millis(600),
            "超时必须立即返回，不能等任务自己跑完（实测 {:?}）",
            t0.elapsed()
        );
    }

    /// 守卫：正常完成必须拿到**真值**——安全网不能把正常路径一起砍掉。
    #[test]
    fn 快任务必须拿到结果() {
        let r = run_with_timeout(
            || ProbeOutcome::Passed,
            Duration::from_millis(2000),
            "单测快任务",
        );
        assert_eq!(r, Some(ProbeOutcome::Passed));
    }

    /// 守卫：子线程 panic 必须被当成「该台不可用」，而不是把调用方一起带崩。
    /// MFT 的厂商 DLL 内部是有可能崩的，这条路径必须在设计里被明确覆盖。
    #[test]
    fn 线程panic必须判不可用() {
        let r: Option<u32> = run_with_timeout(
            || panic!("模拟厂商 MFT 内部崩溃"),
            Duration::from_millis(2000),
            "单测 panic",
        );
        assert_eq!(r, None, "子线程 panic 不得传播，应判该台不可用");
    }

    /// 守卫：三个阈值必须落在「正常路径之上、明显异常之下」。
    ///
    /// 实测锚点（2026-09-23，本机 3 台候选 × 4 次真机会话）：正常单台最坏 580ms。
    /// 这些数字全是拍脑袋就能改坏的——写小了会误杀慢机器上的好编码器
    /// （日志表现为「超时」，但功能其实正常），写大了等于没有保护。
    ///
    /// 用 `const { assert!(..) }` 求值：阈值被改坏时**编译就失败**，比跑到测试
    /// 才发现更早、更难绕过。代价是 panic 消息只能是静态字面量（因此把实测
    /// 锚点写进了消息本身）。
    #[test]
    fn 阈值必须覆盖实测的正常路径() {
        // 实测锚点：本机 3 台候选 × 4 次真机会话，单台最坏 580ms（Intel QSV）
        const PROBE_WORST_CASE_MS: u64 = 580;
        const {
            assert!(
                PROBE_TIMEOUT_MS >= PROBE_WORST_CASE_MS * 2,
                "单台超时相对实测最坏（580ms）至少要有 2 倍余量"
            )
        };
        const { assert!(PROBE_TIMEOUT_MS <= 10_000, "单台超时超过 10s 就失去了保护意义") };
        // 预算是「兜底 × 候选数」的收敛手段，必须明显小于 6 × 单台
        const {
            assert!(
                PICK_BUDGET_MS < PROBE_TIMEOUT_MS * 6,
                "总预算必须小于 6 台各自挂满的上限，否则它不起作用"
            )
        };
        const {
            assert!(
                PICK_BUDGET_MS >= PROBE_TIMEOUT_MS,
                "总预算小于单台超时会让第一台就被砍掉"
            )
        };
        // 收包上限：一帧出一个包是常态，64 是保险值而不是产量限制
        const { assert!(MAX_DRAIN_PER_FRAME >= 8, "收包上限过小会误判正常的多包帧") };
    }
}