//! Media Foundation H.264 编码器（MfH264Encoder）。

use super::*;

pub struct MfH264Encoder {
    /// COM 引用。`release_com` 里**先**置空再 `CoUninitialize`（同 `dxgi.rs::drop_com`）。
    transform: Option<IMFTransform>,
    /// Q3：本编码器出的是什么流（H.264/HEVC）。发送侧写进帧元数据，
    /// 前端据此选解码器。
    codec: VideoCodec,
    /// P1：硬件 MFT 绝大多数是 **async MFT**——必须走事件协议（拿到
    /// METransformNeedInput 才能喂帧、METransformHaveOutput 才能收包）。
    /// 之前的同步 ProcessInput 在 async MFT 上每帧都失败，整条硬编路径
    /// 静默退化成 JPEG。None = 同步 MFT（收件箱软编），直接 ProcessInput。
    events: Option<IMFMediaEventGenerator>,
    need_input: bool,
    have_output: bool,
    /// 异步首帧放长等待（编码器初始化常有几百 ms）。
    async_first_wait: bool,
    /// ICodecAPI（厂商 MFT 可能不暴露 → None）：低延迟/码控/GOP/强制关键帧都走它。
    codec_api: Option<ICodecAPI>,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    frame_idx: u64,
    com_owned: bool,
    pending: Vec<H264Packet>,
    /// P1：D3D11 零拷贝模式（fps120 档）。Some = BGRA 纹理经 VideoProcessor
    /// 转成 NV12 纹理直接进编码器，全程不碰显存读回。
    gpu: Option<crate::rc::gpu::GpuNv12Converter>,
}

/// MFStartup 进程级一次（视频/音频编码器共用；线程安全）。
pub fn ensure_mf_startup() -> Result<(), String> {
    static INIT: std::sync::Once = std::sync::Once::new();
    static INIT_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    INIT.call_once(|| unsafe {
        let r = MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL);
        if let Err(e) = &r {
            log::warn!("[RC] MFStartup 失败：{e}");
        }
        INIT_OK.store(r.is_ok(), std::sync::atomic::Ordering::SeqCst);
    });
    if INIT_OK.load(std::sync::atomic::Ordering::SeqCst) {
        Ok(())
    } else {
        Err("MFStartup 失败".into())
    }
}

/// MF 错误码 → 可读字符串（`encode_h264` 与 `mft_pick` 共用）。
pub(in crate::rc) fn mf_err(e: windows::core::Error) -> String {
    format!("MF：{e}")
}

/// 逐项尽力设置 ICodecAPI（VT_UI4）。厂商 MFT 支持度参差——
/// 单项失败只记 warn，绝不因此中断会话（默认行为兜底）。
unsafe fn codecapi_set_u32(api: &ICodecAPI, key: &windows::core::GUID, value: u32, what: &str) {
    let v = windows::core::VARIANT::from(value);
    if let Err(e) = api.SetValue(key, &v) {
        log::warn!("[RC] CODECAPI {what}={value} 不被支持：{e}");
    }
}

impl MfH264Encoder {
    pub fn open(codec: VideoCodec, width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self, String> {
        Self::open_inner(codec, width, height, fps, bitrate, None)
    }

    /// P1：D3D11 零拷贝模式。编码器绑定 D3D 设备（MF_SA_D3D11_AWARE 的
    /// 硬件 MFT），输入用 GPU 纹理包装的 sample。
    pub fn open_gpu(
        codec: VideoCodec,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        Self::open_inner(codec, width, height, fps, bitrate, Some((device, ctx)))
    }

    fn open_inner(
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        gpu: Option<(&ID3D11Device, &ID3D11DeviceContext)>,
    ) -> Result<Self, String> {
        unsafe {
            let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            ensure_mf_startup()?;

            let w = (width & !1).max(64);
            let h = (height & !1).max(64);

            // 审查 M1（混合显卡）：零拷贝路径的纹理来自 DXGI 池的适配器，
            // 编码 MFT 必须在同一适配器上——跨 GPU 传纹理要么直接失败、
            // 要么暗中多一份拷贝。GPU 模式带 LUID 优先匹配；CPU 模式喂的是
            // 内存缓冲，无需匹配。
            let prefer_adapter = gpu.and_then(|(dev, _)| adapter_luid_of(dev));
            let transform = create_h264_mft(prefer_adapter, codec)?;

            // 🔴 硬件 MFT 是 async：必须先解锁（MF_TRANSFORM_ASYNC_UNLOCK）再设类型，
            // 否则 SetInputType/ProcessInput 直接失败——之前同步用法在 async MFT 上
            // 表现为「硬编永远打不开、每帧静默回 JPEG」。
            let attrs = transform.GetAttributes().map_err(mf_err)?;
            let is_async = attrs
                .GetUINT32(&MF_TRANSFORM_ASYNC)
                .map(|v| v != 0)
                .unwrap_or(false);
            let events: Option<IMFMediaEventGenerator> = if is_async {
                attrs
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(mf_err)?;
                let eg: IMFMediaEventGenerator = transform
                    .cast()
                    .map_err(|e| format!("MFT 事件源：{e}"))?;
                Some(eg)
            } else {
                None
            };

            // P1：D3D 管理器必须**在设类型之前**绑（MFT 以 D3D11 模式协商分配器）
            if let Some((dev, _ctx)) = gpu {
                let mut token = 0u32;
                let mut mgr: Option<IMFDXGIDeviceManager> = None;
                MFCreateDXGIDeviceManager(&mut token, &mut mgr).map_err(mf_err)?;
                let mgr = mgr.ok_or("DXGIDeviceManager 创建为空")?;
                mgr.ResetDevice(dev, token).map_err(mf_err)?;
                let unk: windows::core::IUnknown = mgr.cast().map_err(|e| format!("cast：{e}"))?;
                transform
                    .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, unk.as_raw() as usize)
                    .map_err(mf_err)?;
            }

            // ⚠️ 2026-09-21 修正（探针 `probe/rc-mft-type` 实测）：
            // **必须先 SetOutputType 再 SetInputType**。硬件 MFT 全是 async，
            // 在设输出类型之前 `GetInputAvailableType` 返回 0 个类型
            //（连遍历 24 次都拿不到 NV12），此时 SetInputType 必报
            // `MF_E_INVALIDMEDIATYPE (0xC00D6D60)`。
            // 原代码顺序反了 —— 这正是「硬编永远打不开、静默退回 JPEG」的根因。
            //
            // 🔴 另一条实测约束：**输出类型的第一次 SetOutputType 必须成功**。
            // 自造一个 2560×1440 的 H.264 输出类型去设，NVIDIA MFT 直接报
            // `MF_E_DXGI_UNSUPPORTED_DEVICE (0xC00D6D76)`；一旦失败，该 MFT
            // **实例进入坏状态**，随后连正确的类型也设不上（干净进程里复现过）。
            // 所以这里改为**先取 MFT 自己给出的可用类型、只改帧尺寸与码率**：
            // 实测 2560×1440 下 30/30 帧成功、10.08ms/帧（99fps）；
            // 1920×1080 下 7.15ms/帧（140fps）。
            let out_type = pick_output_type(&transform, codec, w, h, fps, bitrate)
                .or_else(|e| {
                    log::warn!("[RC] 取 MFT 基准输出类型失败，退回自造：{e}");
                    create_video_type(codec.mf_subtype(), w, h, fps)
                })?;
            transform.SetOutputType(0, &out_type, 0).map_err(mf_err)?;

            let in_type = create_video_type(&MFVideoFormat_NV12, w, h, fps)?;
            transform.SetInputType(0, &in_type, 0).map_err(mf_err)?;

            // ⚠️ 硬编设完类型后会要求**流变化再协商**：SPS/PPS 在此时才定稿。
            // 实测 NVIDIA 在此处抛 `MF_E_TRANSFORM_STREAM_CHANGE (0xC00D6D61)`，
            // 按 `GetOutputAvailableType(0)` 重设一次即可；Intel 更晚（首帧的
            // ProcessOutput 才抛），那一路由 `submit_and_collect` 兜。
            for _ in 0..2 {
                match transform.GetOutputAvailableType(0, 0) {
                    Ok(mt) => {
                        let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
                        let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1));
                        if transform.SetOutputType(0, &mt, 0).is_ok() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }

            // P1：VideoProcessor 转换器（BGRA → NV12，显存内）
            let gpu_conv = match gpu {
                Some((dev, ctx)) => Some(crate::rc::gpu::GpuNv12Converter::new(dev, ctx, w, h)?),
                None => None,
            };
            // 🔴 低延迟三件套（2026-09-19）：MFT 默认带流水线缓冲（实测吃掉数帧、
            // 20~60ms），远程画面必须逐帧进出。
            // ① MF_LOW_LATENCY（IMFAttributes，Win8+）；② AVLowLatencyMode（ICodecAPI）；
            // ③ 显式码控 CBR + GOP，替换「只设 MF_MT_AVG_BITRATE」的默认行为。
            // 任何一项不被支持都只 warn——编码器按默认行为继续工作。
            if let Ok(attrs) = transform.cast::<IMFAttributes>() {
                if let Err(e) = attrs.SetUINT32(&MF_LOW_LATENCY, 1) {
                    log::warn!("[RC] MF_LOW_LATENCY 不被支持：{e}");
                }
            }
            let codec_api: Option<ICodecAPI> = transform.cast::<ICodecAPI>().ok();
            if let Some(api) = &codec_api {
                codecapi_set_u32(api, &CODECAPI_AVLowLatencyMode, 1, "AVLowLatencyMode");
                codecapi_set_u32(
                    api,
                    &CODECAPI_AVEncCommonRateControlMode,
                    eAVEncCommonRateControlMode_CBR.0 as u32,
                    "RateControlMode=CBR",
                );
                codecapi_set_u32(api, &CODECAPI_AVEncCommonMeanBitRate, bitrate, "MeanBitRate");
                // P0-3：GOP = fps×1（1s）。之前是 ×2（2s）：解码断链又没等到
                // ForceKeyFrame 时要花 2s 等自然 GOP。request_key 自愈兜底 + 1s GOP。
                codecapi_set_u32(api, &CODECAPI_AVEncMPVGOPSize, fps.max(1), "GoPSize=1s");
                // P2-2：滚动帧内刷新（Gradual Intra Refresh）——用「每帧刷一列宏块」
                // 代替整帧 IDR：码率不突刺、丢包局部愈合。厂商 MFT 支持度参差
                //（NVENC/新 Intel 支持），不支持只 warn，编码器按默认行为继续。
                codecapi_set_u32(
                    api,
                    &CODECAPI_AVEncVideoGradualIntraRefresh,
                    fps.max(1),
                    "GradualIntraRefresh(1s周期)",
                );
                // Q1：标注 limited range（尽力而为）。色彩矩阵没有 ICodecAPI 键——
                // 编码侧已统一 BT.709（dxgi/gpu），未标注 VUI 的 HD 流浏览器按
                // 709 解读，两侧口径一致。
                codecapi_set_u32(
                    api,
                    &CODECAPI_AVEncVideoOutputColorNominalRange,
                    eAVEncVideoColorNominalRange_16_235.0 as u32,
                    "OutputColorNominalRange=16_235",
                );
            }

            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(mf_err)?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(mf_err)?;

            Ok(Self {
                transform: Some(transform),
                codec,
                events,
                need_input: false,
                have_output: false,
                async_first_wait: true,
                codec_api,
                width: w,
                height: h,
                fps: fps.max(1),
                bitrate,
                frame_idx: 0,
                com_owned,
                pending: Vec::new(),
                gpu: gpu_conv,
            })
        }
    }

    /// 本编码器的流标准（Q3，发送侧写进帧元数据）。
    pub fn codec(&self) -> VideoCodec {
        self.codec
    }

    /// 请求下一帧强制为 IDR（弱网花屏自愈：前端解码断链时要点一次）。
    /// 返回是否设置成功（不支持的 MFT 返回 false，调用方等自然 GOP）。
    pub fn force_key(&self) -> bool {
        let Some(api) = &self.codec_api else {
            return false;
        };
        let v = windows::core::VARIANT::from(1u32);
        unsafe { api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &v).is_ok() }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn encode_nv12(&mut self, nv12: &[u8]) -> Result<Vec<H264Packet>, String> {
        unsafe {
            let need = (self.width * self.height * 3 / 2) as usize;
            if nv12.len() < need {
                return Err(format!("NV12 不足 {} < {}", nv12.len(), need));
            }
            let sample = make_sample(nv12, need, self.frame_idx, self.fps)?;
            self.frame_idx += 1;
            self.submit_and_collect(sample)?;
            Ok(std::mem::take(&mut self.pending))
        }
    }

    /// P1 零拷贝编码：BGRA 捕获纹理 → VideoProcessor → NV12 纹理 → 编码器。
    pub fn encode_texture(
        &mut self,
        bgra: &ID3D11Texture2D,
        w: u32,
        h: u32,
    ) -> Result<Vec<H264Packet>, String> {
        let conv = self
            .gpu
            .as_mut()
            .ok_or("编码器不是 D3D11 零拷贝模式")?;
        let (ew, eh) = ((w.max(64) & !1), (h.max(64) & !1));
        if conv.size() != (ew, eh) {
            return Err(format!("纹理尺寸不符：{ew}x{eh} vs 编码器 {}x{}", conv.size().0, conv.size().1));
        }
        let nv12 = conv.convert(bgra)?;
        let sample = unsafe { make_dxgi_sample(&nv12, self.frame_idx, self.fps)? };
        self.frame_idx += 1;
        self.submit_and_collect(sample)?;
        Ok(std::mem::take(&mut self.pending))
    }

    /// 喂一帧 + 收产出。同步 MFT 直接 ProcessInput / 循环 ProcessOutput；
    /// 异步 MFT 走事件协议：等 NeedInput → 喂 → 等 HaveOutput → 收。
    /// 任何等待都有上界（首帧 2s、之后 300ms）——超时报错让调用方回退 JPEG，
    /// 绝不卡死推流循环。
    ///
    /// ⚠️ 2026-09-21：**不加运行时流变化自愈**（探针 `probe/rc-mft-type` 实测）。
    /// Intel QSV H.264 那台会在首帧的 ProcessOutput 抛
    /// `MF_E_TRANSFORM_STREAM_CHANGE (0xC00D6D61)`，但实测**再协商也救不回来**：
    /// 重设输出类型能成功，随后事件流彻底挂死（`NeedInput` 永不再来），
    /// 重开全新实例同样如此 → 该 MFT 在 `MFT_ENUM_FLAG_HARDWARE` 下本身就不可用。
    /// 正确处置是**让它走既有的失败计数**（`enc_fail_streak` → 熔断 → 退避重试），
    /// 由调用方回退 JPEG；其余三台（NVENC H.264/HEVC、Intel H265）实测 6/6 帧稳定。
    fn submit_and_collect(&mut self, sample: IMFSample) -> Result<(), String> {
        unsafe {
            match self.events.clone() {
                None => {
                    self.transform
                        .as_ref()
                        .ok_or_else(|| "H.264 编码器已释放".to_string())?
                        .ProcessInput(0, &sample, 0)
                        .map_err(mf_err)?;
                    self.drain()?;
                }
                Some(events) => {
                    let wait_ms = if self.async_first_wait { 2000 } else { 300 };
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
                    while !self.need_input {
                        self.pump_one(&events, Some(deadline))?;
                    }
                    self.need_input = false;
                    self.transform
                        .as_ref()
                        .ok_or_else(|| "H.264 编码器已释放".to_string())?
                        .ProcessInput(0, &sample, 0)
                        .map_err(mf_err)?;
                    // 低延迟模式一进一出；队列里残留的旧 HaveOutput 也一并收掉，
                    // 否则输出逐帧漂移、延迟累积。
                    let mut collected = 0usize;
                    loop {
                        let pumped = self.pump_one(&events, Some(deadline))?;
                        if self.have_output {
                            self.have_output = false;
                            self.drain_once()?;
                            collected += 1;
                        }
                        if collected >= 4 || (collected > 0 && !pumped) {
                            break;
                        }
                    }
                    if collected == 0 {
                        return Err("编码器一帧未出（低延迟模式异常）".into());
                    }
                    self.async_first_wait = false;
                }
            }
            Ok(())
        }
    }

    /// 非阻塞泵一个事件。`deadline=None` 时不等待、只探一次；
    /// 返回是否真的处理了事件（调用方据此判断队列是否已空）。
    fn pump_one(
        &mut self,
        events: &IMFMediaEventGenerator,
        deadline: Option<std::time::Instant>,
    ) -> Result<bool, String> {
        unsafe {
            match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                Ok(ev) => self.on_event(ev).map(|_| true),
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => match deadline {
                    None => Ok(false),
                    Some(d) if std::time::Instant::now() >= d => {
                        Err("等待编码器事件超时（MFT 无响应）".into())
                    }
                    Some(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        Ok(false)
                    }
                },
                Err(e) => Err(format!("MF 事件泵：{e}")),
            }
        }
    }

    fn on_event(&mut self, ev: IMFMediaEvent) -> Result<(), String> {
        let t = unsafe { ev.GetType() }.unwrap_or(0);
        if t == MEError.0 as u32 {
            return Err("编码器错误事件（MEError）".into());
        }
        if t == METransformNeedInput.0 as u32 {
            self.need_input = true;
        }
        if t == METransformHaveOutput.0 as u32 {
            self.have_output = true;
        }
        Ok(())
    }

    unsafe fn drain(&mut self) -> Result<(), String> {
        loop {
            match self.drain_once_raw() {
                Ok(true) => continue, // 还有产出，继续收
                Ok(false) => break,   // NEED_MORE_INPUT：编码器没货了
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// 收一次输出（异步模式：HaveOutput 到了调一次）。返回是否有产出。
    unsafe fn drain_once(&mut self) -> Result<(), String> {
        self.drain_once_raw().map(|_| ())
    }

    unsafe fn drain_once_raw(&mut self) -> Result<bool, String> {
        let od = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            ..Default::default()
        };
        let mut status = 0u32;
        let mut outs = [od];
        let Some(transform) = self.transform.as_ref() else {
            return Err("H.264 编码器已释放".into());
        };
        match transform.ProcessOutput(0, &mut outs, &mut status) {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(false),
            Err(e) => {
                // 探针（2026-09-21）：流变化是「这台 MFT 其实不可用」的特征错误
                //（Intel QSV H.264 首帧必抛）。计一次数，收尾行就能回答
                //「这场会话碰到过几次流变化」——不计数的话它只混在
                // `enc_fail_streak` 里，看不出是同一类根因。
                const MF_E_TRANSFORM_STREAM_CHANGE_CODE: i32 = 0xC00D6D61u32 as i32;
                if e.code() == windows::core::HRESULT(MF_E_TRANSFORM_STREAM_CHANGE_CODE) {
                    crate::rc::perf::bump_u32(&crate::rc::perf::counters::STREAM_CHANGE);
                }
                return Err(format!("ProcessOutput：{e}"));
            }
        }        if let Some(sample) = outs[0].pSample.as_ref() {
            if let Ok(buf) = sample.ConvertToContiguousBuffer() {
                if let Ok(bytes) = lock_buf(&buf) {
                    let key = match sample.GetUINT32(&MFSampleExtension_CleanPoint) {
                        Ok(v) => v != 0,
                        Err(_) => self.pending.is_empty(),
                    };
                    self.pending.push(H264Packet {
                        data: to_annex_b(&bytes),
                        key,
                        width: self.width,
                        height: self.height,
                    });
                }
            }
        }
        Ok(true)
    }
}

impl MfH264Encoder {
    /// 🔴 必须先放掉所有 COM 引用再 `CoUninitialize`，顺序反了就是悬垂释放
    /// （同 `dxgi.rs::drop_com`）。字段在 `Drop::drop` 返回后才自动 drop，
    /// 所以不能把 `CoUninitialize` 写在 Drop 体末尾就完事——那时 transform
    /// /events/codec_api/gpu 还活着。
    fn release_com(&mut self) {
        if let Some(t) = self.transform.as_ref() {
            unsafe {
                let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
        self.transform = None;
        self.events = None;
        self.codec_api = None;
        self.gpu = None;
        if self.com_owned {
            unsafe { CoUninitialize() };
            self.com_owned = false;
        }
    }
}

impl Drop for MfH264Encoder {
    fn drop(&mut self) {
        self.release_com();
    }
}


pub(in crate::rc) fn to_annex_b(raw: &[u8]) -> Vec<u8> {
    if raw.len() >= 4 && raw[0] == 0 && raw[1] == 0 && raw[2] == 0 && raw[3] == 1 {
        return raw.to_vec();
    }
    if raw.len() >= 3 && raw[0] == 0 && raw[1] == 0 && raw[2] == 1 {
        return raw.to_vec();
    }
    let mut out = Vec::with_capacity(raw.len() + 32);
    let mut i = 0usize;
    while i + 4 <= raw.len() {
        let n = u32::from_be_bytes([raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]) as usize;
        i += 4;
        if n == 0 || i + n > raw.len() {
            break;
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&raw[i..i + n]);
        i += n;
    }
    if out.is_empty() {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(raw);
    }
    out
}
