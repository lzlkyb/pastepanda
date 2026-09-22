//! WASAPI loopback 采集、AudioWorker 线程与扬声器静音查询。

use super::*;

#[derive(Clone, Copy, PartialEq)]
enum SampleFmt {
    F32,
    S16,
}

/// 默认播放设备（`eRender` + `eMultimedia`）。
///
/// **必须在已 `CoInitializeEx` 的线程上调用。** 没有默认设备（无头机 / 声卡被
/// 禁用）时 Err，调用方据此禁用音频。
fn default_render_device() -> Result<IMMDevice, String> {
    unsafe {
        let enumr: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(mf_err)?;
        enumr
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|e| format!("无默认播放设备：{e}"))
    }
}

/// 当前默认渲染端点的 id（P1-5：worker 定期比对，发现默认设备被切换就重建
/// 采集——WASAPI 环回**不会**跟随默认设备迁移）。查不到返回 None（忽略本次检查）。
fn default_render_device_id() -> Option<String> {
    unsafe {
        let enumr: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        enumr
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .ok()?
            .GetId()
            .ok()
            .and_then(|s| s.to_string().ok())
    }
}

pub struct LoopbackCapture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    sr: u32,
    ch: usize,
    fmt: SampleFmt,
    /// 采集绑定的默认渲染端点 id（P1-5 设备失效/切换检测用）。
    device_id: String,
}

impl LoopbackCapture {
    /// 打开默认渲染设备的环回采集。**必须在已 CoInitializeEx 的线程上调用**。
    /// 没有默认设备（无头机/禁用声卡）→ Err，调用方禁用音频。
    pub fn new() -> Result<Self, String> {
        unsafe {
            let dev = default_render_device()?;
            // 端点 id 留底：worker 靠它发现「默认设备被切换了」（P1-5）
            let dev_id = dev
                .GetId()
                .ok()
                .and_then(|s| s.to_string().ok())
                .unwrap_or_default();
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(mf_err)?;
            let wf = client.GetMixFormat().map_err(mf_err)?;
            if wf.is_null() {
                return Err("混音格式为空".into());
            }
            let (sr, ch, fmt) = inspect_format(&*wf)?;
            // 环回模式必须用设备混音格式初始化；缓冲 0 = 系统默认（~10ms 档）
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    0,
                    0,
                    wf,
                    None,
                )
                .map_err(mf_err)?;
            let capture: IAudioCaptureClient = client.GetService().map_err(mf_err)?;
            client.Start().map_err(mf_err)?;
            Ok(Self { client, capture, sr, ch, fmt, device_id: dev_id })
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr
    }

    /// 本采集绑定的默认渲染端点 id。
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 取走当前攒下的全部采样 → 立体声 s16 interleaved。没货返回空。
    /// 第二个返回值 = **设备失效**（P1-5）：`GetNextPacketSize`/`GetBuffer`
    /// 出错（典型：端点被拔出/禁用）。原先错误被吞成「没货」，worker 拿着
    /// 死掉的采集永远空转，会话内静默断声。设备失效时旧数据照常返回。
    pub fn pump(&mut self) -> (Vec<i16>, bool) {
        let mut out = Vec::new();
        let mut broken = false;
        unsafe {
            loop {
                let Ok(n) = self.capture.GetNextPacketSize() else {
                    broken = true;
                    break;
                };
                if n == 0 {
                    break;
                }
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32; // GetBuffer 回 u32 位集（0x58 无 AUDCLNT_BUFFERFLAGS 型）
                if self
                    .capture
                    .GetBuffer(&mut p, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    broken = true;
                    break;
                }
                let bytes = (frames as usize) * self.ch * self.bytes_per_sample();
                if !p.is_null() && bytes > 0 {
                    let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                    let stereo: Vec<f32> = match (self.fmt, silent) {
                        (SampleFmt::F32, false) => {
                            let f: &[f32] =
                                std::slice::from_raw_parts(p as *const f32, frames as usize * self.ch);
                            downmix_to_stereo_f32(f, self.ch)
                        }
                        (SampleFmt::F32, true) => vec![0.0; frames as usize * 2],
                        (SampleFmt::S16, false) => {
                            let s: &[i16] =
                                std::slice::from_raw_parts(p as *const i16, frames as usize * self.ch);
                            let f: Vec<f32> = s.iter().map(|v| *v as f32 / 32768.0).collect();
                            downmix_to_stereo_f32(&f, self.ch)
                        }
                        (SampleFmt::S16, true) => vec![0.0; frames as usize * 2],
                    };
                    out.extend(stereo_f32_to_s16(&stereo));
                }
                let _ = self.capture.ReleaseBuffer(frames);
            }
        }
        (out, broken)
    }

    fn bytes_per_sample(&self) -> usize {
        match self.fmt {
            SampleFmt::F32 => 4,
            SampleFmt::S16 => 2,
        }
    }
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

/// 识别设备混音格式：采样率 / 声道 / 样本格式（f32 或 s16）。
///
/// `unsafe` 的原因只有一个：`WAVE_FORMAT_EXTENSIBLE` 分支要按同址转换读
/// `cbSize` 扩展段（见 `as_extensible`），指针有效性由调用方（`GetMixFormat`）
/// 保证。tag 不是 0xFFFE 时不会碰那一块。
unsafe fn inspect_format(wf: &WAVEFORMATEX) -> Result<(u32, usize, SampleFmt), String> {
    let tag = wf.wFormatTag; // 0.58 里是裸 u16
    let sr = wf.nSamplesPerSec;
    let ch = wf.nChannels as usize;
    if sr == 0 || ch == 0 {
        return Err(format!("混音格式异常：{sr}Hz/{ch}ch"));
    }
    // WAVE_FORMAT_EXTENSIBLE(0xFFFE) 看 SubFormat。两个子类型 GUID 与
    // `KSDATAFORMAT_SUBTYPE_{IEEE_FLOAT,PCM}` **同值**（00000003/00000001-…-9b71），
    // 直接借用 MF 侧常量——省一个 `Win32_Media_Multimedia` feature，
    // 而 PCM 那个 KS 常量在 windows 0.58 的 Multimedia 里压根没导出。
    if tag == 0xFFFE {
        let ext = as_extensible(wf);
        let sub = ext.SubFormat;
        if sub == MFAudioFormat_Float {
            return Ok((sr, ch, SampleFmt::F32));
        }
        if sub == MFAudioFormat_PCM && ext.Samples.wValidBitsPerSample == 16 {
            return Ok((sr, ch, SampleFmt::S16));
        }
        return Err("混音格式既非 f32 也非 s16 PCM".into());
    }
    if tag == 3 {
        return Ok((sr, ch, SampleFmt::F32));
    }
    if tag == 1 && wf.wBitsPerSample == 16 {
        return Ok((sr, ch, SampleFmt::S16));
    }
    Err(format!("混音格式 tag={:#x} 不支持", tag))
}

/// WAVEFORMATEX → WAVEFORMATEXTENSIBLE（混音格式几乎总是 extensible）。
/// 指针同址转换：extensible 是 ex 的超集，长度由 cbSize 保证。
unsafe fn as_extensible(wf: &WAVEFORMATEX) -> &WAVEFORMATEXTENSIBLE {
    &*(wf as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE)
}

// ── 采集 + 编码 worker（独立线程，COM 常驻）────────────────────────────

/// `true` = 该出声（对端申请了 && 本机没静音）。异步任务写入，采集线程读。
pub type WantedFlag = Arc<AtomicBool>;

pub struct AudioWorker {
    stop: Arc<AtomicBool>,
}

impl AudioWorker {
    pub fn start(wanted: WantedFlag, tx: tokio::sync::mpsc::Sender<AudioOut>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        // ❗ 线程刻意 **detach**（不保 JoinHandle）：stop() 在 async 任务里被调，
        // join 会把运行时线程堵住最多 250ms（worker 的睡眠粒度）。线程靠标志位
        // 自行退出，采集/编码资源在其自身的 Drop 里释放。
        let _ = std::thread::Builder::new()
            .name("rc-audio".into())
            .spawn(move || audio_thread(stop2, wanted, tx));
        Self { stop }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for AudioWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn audio_thread(stop: Arc<AtomicBool>, wanted: WantedFlag, tx: tokio::sync::mpsc::Sender<AudioOut>) {
    let com = ComGuard::new();
    let _ = com;
    let mut cap: Option<LoopbackCapture> = None;
    let mut enc: Option<AacEncoder> = None;
    // P2-6：本会话累计喂给编码器的**帧数**（立体声 interleaved 的一半）。
    // 编码器重开时以此为 pts 基点，时间轴不倒退。
    let mut samples_total: u64 = 0;
    // P1-5：默认设备比对节流（每 5 秒一次，别每轮 8ms 都查 COM）。
    let mut last_dev_check = std::time::Instant::now();
    let dropped = std::sync::atomic::AtomicU64::new(0);
    log::info!("[RC] 音频 worker 启动");
    while !stop.load(Ordering::SeqCst) {
        if !wanted.load(Ordering::SeqCst) {
            if cap.take().is_some() || enc.take().is_some() {
                log::info!("[RC] 音频暂停（对端关了或本机静音）");
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            continue;
        }
        if cap.is_none() {
            match (|| -> Result<(LoopbackCapture, AacEncoder), String> {
                let c = LoopbackCapture::new()?;
                let e = AacEncoder::open(c.sample_rate())?;
                Ok((c, e))
            })() {
                Ok((c, mut e)) => {
                    // pts 时间轴接续（P2-6）：设备切换导致采样率变化时，
                    // 用累计帧数当基点在毫秒尺度上依然近似正确。
                    e.set_sample_offset(samples_total);
                    if !try_push_audio(&tx, AudioOut::Cfg(e.cfg()), &dropped) {
                        return;
                    }
                    log::info!("[RC] 音频采集启动（系统声音 → 对端）");
                    cap = Some(c);
                    enc = Some(e);
                    last_dev_check = std::time::Instant::now();
                }
                Err(e) => {
                    log::warn!("[RC] 音频采集打不开（本场会话没有声音）：{e}");
                    // 打不开别疯狂重试：歇 2s，wanted 翻转前不再刷屏
                    for _ in 0..8 {
                        if stop.load(Ordering::SeqCst) || !wanted.load(Ordering::SeqCst) {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                    continue;
                }
            }
        }
        // P1-5：默认渲染设备被切换了？环回采集绑的是打开那一刻的端点，
        // 不会自己跟过去——定期比对端点 id，变了就重建（重建会重发 Cfg，
        // 对端解码器随之换新流）。
        if last_dev_check.elapsed() >= std::time::Duration::from_secs(5) {
            last_dev_check = std::time::Instant::now();
            if let (Some(c), Some(current)) = (cap.as_ref(), default_render_device_id()) {
                if !c.device_id().is_empty() && current != c.device_id() {
                    log::info!("[RC] 默认播放设备已切换，重建音频采集");
                    cap = None;
                    enc = None;
                    continue;
                }
            }
        }
        let (Some(c), Some(e)) = (cap.as_mut(), enc.as_mut()) else {
            std::thread::sleep(std::time::Duration::from_millis(250));
            continue;
        };
        let (pcm, broken) = c.pump();
        // P1-5：设备失效（端点拔出/禁用）→ 丢弃旧采集，走上面的重建路径。
        // 原先错误被吞成「没货」，这里永远空转，会话内静默断声到结束。
        if broken {
            log::warn!("[RC] 音频采集设备失效（被拔出或禁用），准备重建");
            cap = None;
            enc = None;
            std::thread::sleep(std::time::Duration::from_millis(500));
            continue;
        }
        if pcm.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(8));
            continue;
        }
        samples_total += (pcm.len() / 2) as u64; // 立体声 interleaved → 帧数
        match e.encode(&pcm) {
            Ok(pkts) => {
                for p in pkts {
                    if !try_push_audio(
                        &tx,
                        AudioOut::Pkt {
                            pts_ms: p.pts_ms,
                            data: p.data,
                        },
                        &dropped,
                    ) {
                        return; // 写流任务没了：会话已结束
                    }
                }
            }
            Err(err) => {
                log::warn!("[RC] AAC 编码失败，重开编码器（pts 基点接续在 {} 帧）：{err}", samples_total);
                // 编码器换了但设备没换：只重开编码器，pts 基点用累计帧数接续（P2-6）。
                match AacEncoder::open(c.sample_rate()) {
                    Ok(mut e2) => {
                        e2.set_sample_offset(samples_total);
                        if !try_push_audio(&tx, AudioOut::Cfg(e2.cfg()), &dropped) {
                            return;
                        }
                        enc = Some(e2);
                    }
                    Err(e) => {
                        log::warn!("[RC] 编码器重开失败，整链重建：{e}");
                        cap = None;
                        enc = None;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    log::info!("[RC] 音频 worker 退出");
}

/// 线程级 COM 初始化（MTA）。MSA 线程在 drop 时配对 CoUninitialize。
struct ComGuard {
    owned: bool,
}

impl ComGuard {
    fn new() -> Self {
        let owned = unsafe {
            windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED)
                .is_ok()
        };
        Self { owned }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.owned {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

// ── 主机扬声器静音（G3-C：控制端远程静音）──────────────────────────────
//
// 为什么走端点音量而不是我们的软件开关：用户在外地远程连回家，家里有人时
// 不想让主机外放出声（半夜、开会），要能一键让**主机本地**闭嘴。
// 这与「不发送声音」（`audio_local_mute`）是两个维度——后者是给不给对端听，
// 这里影响的是主机本地的物理输出。
//
// 🔴 WASAPI 环回采集的抽头在端点静音**之前**（GStreamer `wasapi2src` 专门有个
//    `loopback-silence-on-device-mute` 开关，默认 false 即默认不注入静音），
//    所以静音主机扬声器**不影响**已采集的音频——对端照样听得到。
//    这正是 Parsec / NVIDIA GameStream「mute host speakers」的既定行为。

/// 读默认播放设备的端点静音态。
///
/// 自带 COM 初始化（可在任意线程调用，成对 `CoUninitialize`）。
pub fn spk_mute_get() -> Result<bool, String> {
    let _com = ComGuard::new();
    let vol = endpoint_volume()?;
    unsafe { vol.GetMute().map(|b| b.as_bool()).map_err(mf_err) }
}

/// 设主机扬声器静音，返回**设置后读回的真实值**（不回显入参——设备可能拒绝）。
///
/// 自带 COM 初始化。没有默认播放设备时 Err（无头机 / 声卡被禁用）。
pub fn spk_mute_set(on: bool) -> Result<bool, String> {
    let _com = ComGuard::new();
    let vol = endpoint_volume()?;
    unsafe {
        vol.SetMute(on, std::ptr::null()).map_err(mf_err)?;
        vol.GetMute().map(|b| b.as_bool()).map_err(mf_err)
    }
}

fn endpoint_volume() -> Result<IAudioEndpointVolume, String> {
    let dev = default_render_device()?;
    unsafe { dev.Activate(CLSCTX_ALL, None).map_err(mf_err) }
}
