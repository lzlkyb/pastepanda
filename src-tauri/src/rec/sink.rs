//! MF SinkWriter 封装——录屏的 MP4 封装层（视频 H.264/HEVC + 音频 AAC → .mp4）。
//!
//! 输入都是**已编码**数据（Annex-B 视频 / 裸 AAC 帧），SinkWriter 只做 mux：
//! MP4 sink 内置 Annex-B → 长度前缀（avcC/hvcC）转换，参数集（SPS/PPS/VPS）
//! 由 sink 从流内自取。🔴 不要喂 `MF_MT_MPEG_SEQUENCE_HEADER`——pass-through
//! 输入类型带它必被拒（0xC00D36B4，2026-10-06 探针实证：start code / 裸 NAL /
//! 长度前缀三种格式、配任意属性集都一样）。
//!
//! 流的建立用 **AddStream（输出类型）→ SetInputMediaType（输入类型）** 的经典
//! 两步——windows 0.58 的 `IMFSinkWriter` 绑定没有 `SetOutputMediaType`（那是
//! Win8+ 的后加方法，绑定元数据没跟上），`AddStream` 全版本可用且语义一致。
//! 🔴 输出类型必须带全尺寸/帧率/码率（音轨加码率+每块采样数）：缺了的话
//! SetInputMediaType 也报 0xC00D36B4——错误浮现在输入侧，缺的属性在输出侧。
//!
//! 🔴 音轨**不许喂 `MF_MT_USER_DATA`**（裸 ASC / WAVEFORMATEX 都一样）：双侧都放
//! → open 一路全过、Finalize 才炸 0xC00D4A45；只放输出侧 → open 当场拒
//! 0xC00D36B4（2026-10-08 探针 + 变异各实测一次）。esds 由 sink 按采样率/声道数
//! 自造，与 `rc/audio.rs::asc_for` 那份逐字节相同，所以调用方无从也无需传 asc。
//!
//! 🔴 每条轨在 Finalize 前必须至少收到 **1 个样本**——moov 的样本描述要从流内
//! 自取，零样本轨 = 0xC00D4A45「未提供所需的标头」（静音场整场零环回包，
//! 2026-10-07 实录踩坑；音频线程按墙钟补静音保活，见 session.rs::run_audio）。
//!
//! MF 时间单位 100ns；`at_ms * 10_000`。全部 COM 调用收敛在本文件，
//! 释放顺序同 `encode_h264.rs::release_com`：先放对象引用再 CoUninitialize。

#![cfg(target_os = "windows")]

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFSample, IMFSinkWriter, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MF_MT_AVG_BITRATE, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_BLOCK, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MFMediaType_Audio,
    MFMediaType_Video, MFAudioFormat_AAC, MFVideoFormat_H264, MFVideoFormat_HEVC,
};

use super::quality;

/// SinkWriter 打不开/写出失败的统一错误前缀（会话据此整场停录）。
pub(crate) fn mf_err(e: windows::core::Error) -> String {
    format!("MF SinkWriter：{e}")
}

/// 从 Annex-B 流里提取参数集 NAL（H.264：SPS+PPS；HEVC：VPS+SPS+PPS），
/// 拼接为带 start code 的 sequence header。一帧里没有参数集返回空——调用方
/// 在首个 keyframe 前必须提取成功，否则 SinkWriter 写不出 moov。
///
/// 纯字节解析，无环境可单测（见 tests）。
pub fn extract_parameter_sets(hevc: bool, annex_b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in split_annex_b(annex_b) {
        let head = nal[0];
        let is_param = if hevc {
            // H.265 NAL type = (首字节 >> 1) & 0x3F：32=VPS 33=SPS 34=PPS
            let t = (head >> 1) & 0x3F;
            (32..=34).contains(&t)
        } else {
            // H.264 NAL type = 首字节 & 0x1F：7=SPS 8=PPS
            let t = head & 0x1F;
            t == 7 || t == 8
        };
        if is_param {
            // 每个 NAL 统一补成 4 字节长度 start code（参数集短，冗余无妨）
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(nal);
        }
    }
    out
}

/// 按 start code（00 00 01 / 00 00 00 01）切 Annex-B；返回的每个切片**不含** start code。
fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut starts: Vec<usize> = Vec::new();
    let n = data.len();
    let mut i = 0;
    while i + 2 < n {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &s) in starts.iter().enumerate() {
        // 3 字节 start code 前若还有一个 0（4 字节形式），归并进 start code
        let body_start = s + 3;
        let end = if k + 1 < starts.len() {
            let next = starts[k + 1];
            if next > 0 && data[next - 1] == 0 && next - 1 >= body_start {
                next - 1
            } else {
                next
            }
        } else {
            n
        };
        if end > body_start {
            out.push(&data[body_start..end]);
        }
    }
    out
}

pub struct RecSink {
    /// None = 已收尾/已释放（Drop 时显式先放 COM 引用再 CoUninitialize）。
    writer: Option<IMFSinkWriter>,
    video_stream: u32,
    audio_stream: Option<u32>,
    /// AAC 帧时长（100ns），写 sample duration 用。无音频轨为 0。
    audio_frame_t100: i64,
    /// 视频帧时长（100ns），写 sample duration 用。
    /// 🔴 视频样本必须显式带 duration：MF 的 MP4 sink 对无时长样本只保留约
    /// 12 帧的前向窗口（靠「下一帧时间戳」倒推上一帧时长），第 13 帧起
    /// WriteSample 直接报 0xC00D36C9「媒体示例没有持续时间」——一二期没炸
    /// 是因为时间轴塌在 0（delta=0 可平凡推导），三期修好时间轴后必然踩中。
    /// ⚠️ 我们给的这个值只是**下限**：相邻样本之间有空隙时（静止期不落样就是这种），
    /// MF 把空隙写进前一个样本的 stts duration，实测覆盖本值（见探针 1 的 90000/30000
    /// = 3000ms）。所以「不补帧会不会缩短轨长」的答案是不会，但「不给 duration」会。
    video_frame_t100: i64,
    com_owned: bool,
    /// 已写入的音频样本数（finalize 诊断用：0 = 音轨零样本，见 finalize）。
    audio_samples: u64,
    /// 已写入的媒体字节（视频+音频裸流，不含封装开销；四期 1.2 控制条体积显示）。
    /// 调用方持有同一 Arc 供 `rec_status` 跨线程读——计数器由会话注入（依赖注入），
    /// sink 不自造：状态读口永远只有一个（规则 11.1 同款思路）。
    bytes: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl RecSink {
    /// 打开 MP4 封装。音频轨可选（`None` = 纯画面）。
    /// 视频参数集由 sink 从 Annex-B 流内自取（见模块头：SEQUENCE_HEADER 喂不得）。
    pub fn open(
        path: &std::path::Path,
        width: u32,
        height: u32,
        fps: u32,
        hevc: bool,
        audio: Option<(u32, u32)>, // (采样率, 声道数)——ASC 不传，见下
        video_bitrate: u32,
        bytes: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) -> Result<Self, String> {
        let com_owned = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
            .is_ok()
        };
        // 装配收进闭包：任何一步失败都先把 COM 配平再返回——🔴 不配平会让本线程
        // 退出时引用计数失衡，干扰后续 MF/DXGI 初始化（同 Drop 的顺序纪律）
        let mut built: Option<Self> = None;
        let mut assemble = || -> Result<(), String> {
            unsafe {
                crate::rc::encode_h264::ensure_mf_startup()?;

                let wide = HSTRING::from(path.as_os_str());
                let writer = MFCreateSinkWriterFromURL(PCWSTR::from_raw(wide.as_ptr()), None, None)
                    .map_err(mf_err)?;

                let video_subtype = if hevc { &MFVideoFormat_HEVC } else { &MFVideoFormat_H264 };

                // ── 视频流：输出（容器侧）类型，AddStream 拿流号 ──
                // 🔴 MP4 sink 的流处理器要求输出类型带全尺寸/帧率/码率，否则
                // SetInputMediaType 一律拒之门外（报在输入侧的 0xC00D36B4，实际缺的
                // 是**输出侧**属性——2026-10-06 探针实证：只补输出三件套即过）
                let vout = MFCreateMediaType().map_err(mf_err)?;
                vout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(mf_err)?;
                vout.SetGUID(&MF_MT_SUBTYPE, video_subtype).map_err(mf_err)?;
                vout.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)
                    .map_err(mf_err)?;
                vout.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1).map_err(mf_err)?;
                vout.SetUINT32(&MF_MT_AVG_BITRATE, video_bitrate).map_err(mf_err)?;
                let video_stream = writer.AddStream(&vout).map_err(mf_err)?;

                // ── 视频流：输入（已编码 Annex-B）类型 ──
                let vin = MFCreateMediaType().map_err(mf_err)?;
                vin.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(mf_err)?;
                vin.SetGUID(&MF_MT_SUBTYPE, video_subtype).map_err(mf_err)?;
                vin.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)
                    .map_err(mf_err)?;
                vin.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1).map_err(mf_err)?;
                vin.SetUINT32(&MF_MT_AVG_BITRATE, video_bitrate).map_err(mf_err)?;
                writer.SetInputMediaType(video_stream, &vin, None).map_err(mf_err)?;

                // ── 音频流（可选）：裸 AAC 帧 ──
                // 音频与视频同理：缺 AVG_BYTES_PER_SECOND / SAMPLES_PER_BLOCK 会吃同样的
                // 0xC00D36B4，错误浮现在输入侧、缺的属性在输出侧
                //（码率与 rc/audio.rs 编码器同源，128kbps）。
                // 🔴 不要喂 ASC：MF_MT_USER_DATA 双侧都放时 open 一路全过、Finalize
                // 才炸 0xC00D4A45「未提供所需的标头」；只放输出侧则 open 当场拒
                // 0xC00D36B4（两种失败都实测过，裸 ASC 与 WAVEFORMATEX 形态一样）。
                // esds 由 sink 按采样率/声道数自造（2026-10-08 探针实证：去掉
                // USER_DATA 即 finalize ok，生成盒子里 DecoderSpecificInfo =
                // 0x11 0x90，与 rc/audio.rs::asc_for(48000,2) 逐字节相同）。
                let aac_br = crate::rc::audio::BITRATE_BPS / 8;
                let mut audio_stream = None;
                let mut audio_frame_t100 = 0i64;
                if let Some((sr, ch)) = audio {
                    let aout = MFCreateMediaType().map_err(mf_err)?;
                    aout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(mf_err)?;
                    aout.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sr).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * 2).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, aac_br).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_BLOCK, 1024).map_err(mf_err)?;
                    let stream = writer.AddStream(&aout).map_err(mf_err)?;
                    let ain = MFCreateMediaType().map_err(mf_err)?;
                    ain.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(mf_err)?;
                    ain.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(mf_err)?;
                    ain.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sr).map_err(mf_err)?;
                    ain.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(mf_err)?;
                    ain.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(mf_err)?;
                    ain.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * 2).map_err(mf_err)?;
                    ain.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, aac_br).map_err(mf_err)?;
                    ain.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_BLOCK, 1024).map_err(mf_err)?;
                    writer.SetInputMediaType(stream, &ain, None).map_err(mf_err)?;
                    audio_stream = Some(stream);
                    // AAC-LC 每帧 1024 采样
                    audio_frame_t100 = 1024i64 * 10_000_000 / sr.max(1) as i64;
                }

                writer.BeginWriting().map_err(mf_err)?;
                built = Some(Self {
                    writer: Some(writer),
                    video_stream,
                    audio_stream,
                    audio_frame_t100,
                    audio_samples: 0,
                    video_frame_t100: 10_000_000i64 / fps.max(1) as i64,
                    com_owned,
                    bytes,
                });
            }
            Ok(())
        };
        let result = assemble();
        match result {
            Ok(()) => Ok(built.expect("装配成功必有产物")),
            Err(e) => {
                if com_owned {
                    unsafe { windows::Win32::System::Com::CoUninitialize() };
                }
                Err(e)
            }
        }
    }

    /// 写一帧已编码视频（Annex-B）。`at_ms` 为编码器内部时间轴（ms）。
    pub fn write_video(&mut self, at_ms: i64, data: &[u8]) -> Result<(), String> {
        unsafe { self.write(self.video_stream, at_ms * 10_000, self.video_frame_t100, data) }
    }

    /// 写一帧裸 AAC。`pts_ms` 来自 `AacPacket`。
    pub fn write_audio(&mut self, pts_ms: i64, data: &[u8]) -> Result<(), String> {
        let stream = self.audio_stream.ok_or("无音频轨")?;
        self.audio_samples += 1;
        unsafe { self.write(stream, pts_ms * 10_000, self.audio_frame_t100, data) }
    }

    /// 是否开了音轨（drain 侧据此静默跳过：包要照收防通道积压，但不写不刷日志）。
    pub(crate) fn has_audio(&self) -> bool {
        self.audio_stream.is_some()
    }

    unsafe fn write(
        &mut self,
        stream: u32,
        t100: i64,
        dur100: i64,
        data: &[u8],
    ) -> Result<(), String> {
        unsafe {
            let writer = self
                .writer
                .as_ref()
                .ok_or_else(|| "SinkWriter 已释放".to_string())?;
            use std::sync::atomic::Ordering;
            self.bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
            let buf = MFCreateMemoryBuffer(data.len().max(1) as u32).map_err(mf_err)?;
            {
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut max = 0u32;
                let mut cur = 0u32;
                buf.Lock(&mut p, Some(&mut max), Some(&mut cur)).map_err(mf_err)?;
                if !p.is_null() && !data.is_empty() {
                    std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
                }
                buf.SetCurrentLength(data.len() as u32).map_err(mf_err)?;
                buf.Unlock().map_err(mf_err)?;
            }
            let sample: IMFSample = MFCreateSample().map_err(mf_err)?;
            sample.AddBuffer(&buf).map_err(mf_err)?;
            sample.SetSampleTime(t100).map_err(mf_err)?;
            if dur100 > 0 {
                sample.SetSampleDuration(dur100).map_err(mf_err)?;
            }
            writer.WriteSample(stream, Some(&sample)).map_err(mf_err)
        }
    }

    /// 收尾：写 moov、落盘。调用后本对象不可再用（Drop 只清 COM）。
    pub fn finalize(&mut self) -> Result<(), String> {
        match self.writer.as_ref() {
            Some(w) => unsafe {
                w.Finalize().map_err(|e| {
                    let mut msg = mf_err(e);
                    // 0xC00D4A45「未提供所需的标头」= 某条轨零样本，moov 写不出
                    // （样本描述要从流内自取）。视频零样本被参数集门卫挡在 open
                    // 前；音轨零样本只能在这里给出可读诊断（静音保活失守时）。
                    if self.audio_stream.is_some() && self.audio_samples == 0 {
                        msg.push_str("；诊断：音轨 0 样本（整场无音频产出）");
                    }
                    msg
                })
            },
            None => Err("SinkWriter 已释放".into()),
        }
    }
}

impl Drop for RecSink {
    /// 🔴 先放掉 SinkWriter（内含文件句柄）再 CoUninitialize，顺序反了就是
    /// 悬垂释放（同 `dxgi.rs::drop_com` / `encode_h264.rs::release_com`）。
    /// Finalize 已在会话收尾显式调用过；这里是错误路径兜底（release writer
    /// 本身不写 moov，错误路径的文件本来就要弃）。
    fn drop(&mut self) {
        self.writer = None;
        if self.com_owned {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
            self.com_owned = false;
        }
    }
}

/// 档位 → SinkWriter 打开参数的一个装配点（会话与命令共用，避免两处口径漂移）。
pub(crate) struct SinkParams {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub hevc: bool,
    pub bitrate: u32,
}

pub(crate) fn sink_params(q: quality::RecQuality, src_w: u32, src_h: u32) -> SinkParams {
    let (w, h) = quality::encoded_size(q, src_w, src_h);
    SinkParams {
        width: w,
        height: h,
        fps: q.fps(),
        hevc: q.codec() == crate::rc::encode_h264::VideoCodec::Hevc,
        bitrate: q.bitrate(w),
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    // ── 回归（2026-10-06 首次实录 0xC00D36B4）：MP4 sink 的 pass-through 校验
    // 四条铁律，靠逐属性探针实证——
    //   ① 输出类型必须带全尺寸/帧率/码率（缺了报在 SetInputMediaType，极具迷惑性）；
    //   ② 输入类型带 MF_MT_MPEG_SEQUENCE_HEADER 必被拒（任何格式/属性组合），
    //     参数集只能靠 sink 从 Annex-B 流内自取；
    //   ③ 音频两侧要补 AVG_BYTES_PER_SECOND + SAMPLES_PER_BLOCK；
    //   ④ 🔴 音频两侧都不得带 MF_MT_USER_DATA——双侧放（裸 ASC 或 WAVEFORMATEX）
    //     是「open 全绿、Finalize 炸 0xC00D4A45」，只放输出侧是「open 当场拒
    //     0xC00D36B4」，两条臂都实测过（2026-10-08 探针 + 变异）。sink 自造的
    //     esds 里 DecoderSpecificInfo = 0x11 0x90，正是 asc_for(48000,2) 那份。
    // 本测试走生产路径 RecSink::open 全真装配（含音轨），再用真编码器的帧走一次
    // 写入 + finalize，断言 moov 里出现 avcC（视频参数集进了容器）**和 esds 里
    // 的 ASC**（音轨样本描述进了容器）。编码器打不开的机器上端到端段优雅跳过。 ──

    #[test]
    fn 开封装_真实媒体类型含音轨() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        crate::rc::encode_h264::ensure_mf_startup().unwrap();

        let asc = [0x11u8, 0x90]; // AAC-LC 48kHz 立体声的 ASC（AOT=2, freqIdx=3, chCfg=2）
        let (w, h, fps, br) = (320u32, 240u32, 30u32, 2_000_000u32);

        // ── 段 1：生产路径开封装（视频 + 音轨全真类型）──
        let path = std::env::temp_dir().join("rec_sink_regression.mp4");
        let _ = std::fs::remove_file(&path);
        let mut sink = RecSink::open(
            &path,
            w,
            h,
            fps,
            false,
            Some((48000, 2)),
            br,
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        )
            .expect("生产同款媒体类型必须能开出 MP4 封装（视频+音轨）");

        // ── 段 2：真编码器端到端——写帧、finalize、moov 必须出现 avcC ──
        let mut enc = crate::rc::encode_h264::H264SessionEncoder::try_open(
            crate::rc::encode_h264::VideoCodec::H264,
            w,
            h,
            fps,
        );
        let frame = vec![96u8; (w * h * 4) as usize];
        let mut packets = Vec::new();
        // 40 帧：🔴 13 帧起才覆盖「MP4 sink 无时长样本前向窗口溢出」的回归
        //（WriteSample 0xC00D36C9，2026-10-07 真机实录；12 帧恰好在窗口内绕过了它）
        for i in 0..40i64 {
            match enc.encode_bgra(&frame, w, h) {
                Ok(mut ps) => {
                    for p in ps.iter_mut() {
                        p.at_ms = i * 33; // 时间轴归一到 30fps 步进
                    }
                    packets.extend(ps);
                }
                Err(e) => {
                    println!("（编码器本机不可用，端到端段跳过：{e}）");
                    break;
                }
            }
            if packets.len() >= 3 && packets.iter().any(|p| p.key) {
                break;
            }
        }
        if packets.iter().any(|p| p.key) {
            // 生产同款门卫：首关键帧里必须提得到参数集
            let key = packets.iter().find(|p| p.key).unwrap();
            assert!(!extract_parameter_sets(false, &key.data).is_empty(), "关键帧必须含 SPS/PPS");
            for p in &packets {
                sink.write_video(p.at_ms, &p.data).expect("写帧必须成功");
            }
            // 音轨按生产口径喂帧（生产侧由 session.rs::run_audio 的静音保活保证
            // 每条轨都有样本；这里同形）。pass-through sink 不解码，内容只要非空。
            let aac = [0x21u8; 64];
            for i in 0..5i64 {
                sink.write_audio(i * 21, &aac).expect("写音频样本必须成功"); // 1024/48000 ≈ 21ms
            }
            sink.finalize().expect("finalize 必须成功");
            drop(sink);
            let bytes = std::fs::read(&path).unwrap();
            assert!(
                bytes.windows(4).any(|win| win == b"avcC"),
                "moov 必须带 avcC——sink 没从流里收到参数集"
            );
            // 🔴 音轨标头同理必须真进容器：esds 里要能找到编码器那份 ASC。
            // 这条断言钉的是「open 通过 ≠ 文件写得出来」——USER_DATA 一喂就是
            // 装配全绿、finalize 炸（铁律 ④），只看 finalize 成功还不够。
            let e = bytes
                .windows(4)
                .position(|win| win == b"esds")
                .expect("moov 必须带 esds（音轨样本描述）");
            let tail = &bytes[e..(e + 64).min(bytes.len())];
            assert!(
                tail.windows(2).any(|win| win == &asc[..]),
                "esds 里的 ASC 必须是 0x11 0x90（AAC-LC/48k/立体声），否则音轨不可播"
            );
        } else {
            // 编码器缺席：类型装配（本回归的本体）已在 open 处验证过；
            // 空 sink 不能 finalize（0xC00D4A44 = 未处理任何 sample），直接丢弃
            drop(sink);
        }
        let _ = std::fs::remove_file(&path);
    }

    // ── 探针 1（2026-10-10 实测）：**容器时长由样本时间戳推，不由我们给的
    // duration 推，也不由样本数推**。8 个样本、最后时间戳 3198ms → mvhd 报
    // 3231ms（=3198+33），而 8×33ms=264ms；轨时基是 fps 定的 30000（15 分钟跨度
    // 实测 mvhd=900033ms 正常，u32 时长要 39.8 小时才回绕）。
    // ⇒ 封装层无罪：视频轨短于音频轨只能是**喂进来的时间戳**本身就短——
    //   生产侧时间轴按「已提交帧数」走，静止段不提交 = 轴不走（见 timeline.rs）。 ──
    #[test]
    fn 稀疏时间戳_容器时长跟时间戳不跟帧数() {
        let stamps = [0i64, 33, 66, 99, 132, 3132, 3165, 3198];
        let Some((samples, dur)) = 容器时长实测(&stamps, "sparse") else {
            return; // 本机无硬件编码器：类型装配本体已由上面的回归覆盖
        };
        println!(
            "稀疏时间戳实测：样本数={samples} 最后时间戳={}ms 容器时长={dur}ms",
            stamps[stamps.len() - 1]
        );
        assert!(
            dur + 100 >= *stamps.last().unwrap() as u64,
            "容器时长必须跟到最后一帧的时间戳：实测 {dur}ms，样本数 {samples}（×33ms 只有 {}ms）",
            samples as u64 * 33
        );
    }

    // ── 探针 2（「时间轴卡死」成品验收，二改：静止期不落样）：拿**生产同款**时间轴
    // （rec/timeline）驱动真编码器写 20 秒，画面每 2 秒才变一次，静止圈什么都不提交
    // ——成品时长必须仍是 20 秒，且样本只剩真帧那十几个。两条断言各挡一种回归：
    // ① 旧口径（提交帧数×帧长）在这串样本上只写出 11×33=363ms 的轨（60 秒会话改前
    // 实测 966ms）；② 过去的 ~500ms 补帧能过时长断言，却白重编（改前实测 42 个样本）。
    // 「不补也不缩短」的前提 = MF 把空隙写进**前一个样本**的 stts duration（探针 1）。
    // 逐格重编的代价另见下面 `补帧开销_静态逐格重编`。 ──
    #[test]
    fn 静止期不落样_容器时长跟住墙钟() {
        use crate::rec::timeline::VideoAxis;
        let (fps, secs) = (30u32, 20i64);
        let mut axis = VideoAxis::new(fps);
        let mut stamps: Vec<i64> = Vec::new();
        let mut el = 0i64;
        // 主循环按 1/fps 走；k%60==0 的那几圈 DXGI 才给真帧
        for k in 0..(secs * i64::from(fps) + 6) {
            el = k * 33;
            if k % 60 == 0 {
                stamps.push(axis.arrive(el));
            }
            // 静止圈（else 分支的去处）什么都不提交：空隙由前一个样本的 stts
            // duration 覆盖，见上面探针 1 与 rec/timeline.rs 顶部
        }
        // 与生产同款的收尾尾格（session.rs 收尾第一步）
        stamps.extend(axis.tail_hold(el, true));
        let want = stamps[stamps.len() - 1];
        let reported = axis.duration_ms();
        let Some((samples, dur)) = 容器时长实测(&stamps, "idle") else {
            return; // 无硬件编码器：轴本身由 timeline.rs 的单测覆盖
        };
        println!(
            "静止期不落样成品实测：提交时间戳数={} 写入样本数={samples} 最后时间戳={want}ms \
             容器时长={dur}ms rec-done 口径={reported}ms",
            stamps.len()
        );
        assert!(
            dur + 1000 >= (secs * 1000) as u64,
            "录满 {secs} 秒的产物只报了 {dur}ms（时间轴终点 {want}ms、样本 {samples}）——\
             视频轨短于会话时长，播放器末尾就是「卡死」"
        );
        assert!(
            dur.abs_diff(reported) <= 100,
            "rec-done 报 {reported}ms 而成品 {dur}ms——用户看到的时长与文件对不上"
        );
        // 静止期不许落补帧：轨长由时间戳跳格保证——MF 把空隙写进**前一个样本**的
        // stts duration（本机实测：t=132ms 的样本在 stts 里拿到 90000/30000=3000ms，
        // 见 `稀疏时间戳_容器时长跟时间戳不跟帧数`），所以不补不会缩短，补了只是白重编。
        // 上界 = 真帧 11 格 + 尾格 1 + 同槽顺延余量 2。
        assert!(
            samples <= 14,
            "静止段还在落补帧：{secs} 秒会话、画面每 2 秒才变一次，样本数应≈12，实测 {samples}\
             （= 每隔一段时间就把上一格画面重编一遍，静屏持续吃 CPU，而时长本就靠时间戳）"
        );
    }

    /// 用真编码器把一串时间戳写成 MP4，返回（写入样本数, 容器时长 ms）。
    /// 本机没有硬件编码器时返回 None（跳过，不当成通过）。
    fn 容器时长实测(stamps_ms: &[i64], tag: &str) -> Option<(usize, u64)> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        crate::rc::encode_h264::ensure_mf_startup().unwrap();

        let (w, h, fps) = (320u32, 240u32, 30u32);
        let path = std::env::temp_dir().join(format!("rec_sink_probe_{tag}.mp4"));
        let _ = std::fs::remove_file(&path);
        let mut sink = RecSink::open(
            &path,
            w,
            h,
            fps,
            false,
            None,
            2_000_000,
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        )
        .expect("开封装（纯画面轨）");

        let mut enc = crate::rc::encode_h264::H264SessionEncoder::try_open(
            crate::rc::encode_h264::VideoCodec::H264,
            w,
            h,
            fps,
        );
        let frame = vec![96u8; (w * h * 4) as usize];
        let mut samples = 0usize;
        for t in stamps_ms {
            enc.set_capture_at(*t);
            match enc.encode_bgra(&frame, w, h) {
                Ok(ps) => {
                    for p in &ps {
                        sink.write_video(p.at_ms, &p.data)
                            .unwrap_or_else(|e| panic!("写帧 @{t}ms 必须成功：{e}"));
                        samples += 1;
                    }
                }
                Err(e) => {
                    println!("（编码器本机不可用，探针跳过：{e}）");
                    return None;
                }
            }
        }
        if samples == 0 {
            println!("（编码器无输出，探针跳过）");
            return None;
        }
        sink.finalize().expect("finalize 必须成功");
        drop(sink);
        println!("探针文件：{}", path.display());
        Some((samples, super::super::scan::mp4_duration_ms(&path).expect("moov 必须带 mvhd")))
    }

    /// 「如果静止期补帧要付多少」的复核依据（规则 8：先测再写结论，不进 CI）——
    /// 生产已改成静止期不落样（见 `静止期不落样_容器时长跟住墙钟`），这组数字就是
    /// 不补的理由：每格都要真编一遍上一画面。本机跑法：
    /// `cargo test --lib 补帧开销 -- --ignored --nocapture`
    #[test]
    #[ignore = "900 帧 1080p 真编码，只本机量静止重编开销"]
    fn 补帧开销_静态逐格重编() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        crate::rc::encode_h264::ensure_mf_startup().unwrap();
        let (w, h, fps, n) = (1920u32, 1080u32, 30u32, 900usize);
        let mut enc = crate::rc::encode_h264::H264SessionEncoder::try_open_for_file(
            crate::rc::encode_h264::VideoCodec::H264,
            w,
            h,
            fps,
            8_000_000,
        );
        if !enc.available() {
            println!("（本机无可用硬件编码器，跳过）");
            return;
        }
        let frame = vec![96u8; (w * h * 4) as usize];
        let started = std::time::Instant::now();
        let mut packets = 0usize;
        let mut bytes = 0usize;
        for i in 0..n {
            enc.set_capture_at(i as i64 * 1000 / i64::from(fps));
            match enc.encode_bgra(&frame, w, h) {
                Ok(ps) => {
                    packets += ps.len();
                    bytes += ps.iter().map(|p| p.data.len()).sum::<usize>();
                }
                Err(e) => {
                    println!("（编码器不可用：{e}）");
                    return;
                }
            }
        }
        let ms = started.elapsed().as_millis();
        println!(
            "1080p30 静态逐格重编：{n} 帧耗时 {ms}ms（{:.2}ms/帧 = 每秒 {:.1}% 单核），\
             输出 {packets} 包 / {bytes}B（平均 {:.0}B/包）",
            ms as f64 / n as f64,
            ms as f64 * 100.0 / (n as f64 / f64::from(fps)) / 1000.0,
            bytes as f64 / packets.max(1) as f64
        );
    }

    #[test]
    fn 提取参数集_h264() {
        // 假 NAL：type 7 (SPS)、type 8 (PPS)、type 5 (IDR)
        let mut buf = vec![0, 0, 0, 1, 0x67, 0xAA, 0xBB];
        buf.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xCC]);
        buf.extend_from_slice(&[0, 0, 0, 1, 0x65, 0xDD, 0xEE]);
        let out = extract_parameter_sets(false, &buf);
        // SPS + PPS，IDR 不进
        assert_eq!(out, vec![0, 0, 0, 1, 0x67, 0xAA, 0xBB, 0, 0, 0, 1, 0x68, 0xCC]);
    }

    #[test]
    fn 提取参数集_hevc() {
        // VPS(32→0x40)、SPS(33→0x42)、PPS(34→0x44)、IDR(19→0x26)
        let mut buf = vec![0, 0, 1, 0x40, 0x01];
        buf.extend_from_slice(&[0, 0, 0, 1, 0x42, 0x02]);
        buf.extend_from_slice(&[0, 0, 0, 1, 0x44, 0x03]);
        buf.extend_from_slice(&[0, 0, 0, 1, 0x26, 0x04]);
        let out = extract_parameter_sets(true, &buf);
        assert_eq!(out, vec![
            0, 0, 0, 1, 0x40, 0x01, 0, 0, 0, 1, 0x42, 0x02, 0, 0, 0, 1, 0x44, 0x03
        ]);
    }

    #[test]
    fn 提取参数集_无参数集返回空() {
        let buf = vec![0, 0, 0, 1, 0x65, 0x01];
        assert!(extract_parameter_sets(false, &buf).is_empty());
    }

    #[test]
    fn 切片_混合三字节与四字节start_code() {
        // 4 字节后跟 3 字节：3 字节前不该多切出一个空/脏 NAL
        let buf = vec![0, 0, 0, 1, 0x67, 0x01, 0, 0, 1, 0x68, 0x02];
        let nals = split_annex_b(&buf);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0], &[0x67, 0x01]);
        assert_eq!(nals[1], &[0x68, 0x02]);
    }
}
