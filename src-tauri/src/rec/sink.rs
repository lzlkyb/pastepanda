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
//! MF 时间单位 100ns；`at_ms * 10_000`。全部 COM 调用收敛在本文件，
//! 释放顺序同 `encode_h264.rs::release_com`：先放对象引用再 CoUninitialize。

#![cfg(target_os = "windows")]

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFSample, IMFSinkWriter, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MF_MT_AVG_BITRATE, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_BLOCK, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_MT_USER_DATA, MFMediaType_Audio,
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
    com_owned: bool,
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
        audio: Option<(u32, u32, &[u8])>, // (sample_rate, channels, asc)
        video_bitrate: u32,
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

                // ── 音频流（可选）：裸 AAC 帧 + ASC ──
                // 音频与视频同理：缺 AVG_BYTES_PER_SECOND / SAMPLES_PER_BLOCK 会吃同样的
                // MF_E_INVALIDMEDIATYPE；ASC 放**输入侧**会被拒、双侧都放才过
                //（码率与 rc/audio.rs 编码器同源，128kbps）
                let aac_br = crate::rc::audio::BITRATE_BPS / 8;
                let mut audio_stream = None;
                let mut audio_frame_t100 = 0i64;
                if let Some((sr, ch, asc)) = audio {
                    let aout = MFCreateMediaType().map_err(mf_err)?;
                    aout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(mf_err)?;
                    aout.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sr).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * 2).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, aac_br).map_err(mf_err)?;
                    aout.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_BLOCK, 1024).map_err(mf_err)?;
                    aout.SetBlob(&MF_MT_USER_DATA, asc).map_err(mf_err)?;
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
                    ain.SetBlob(&MF_MT_USER_DATA, asc).map_err(mf_err)?;
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
                    com_owned,
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
        unsafe { self.write(self.video_stream, at_ms * 10_000, 0, data) }
    }

    /// 写一帧裸 AAC。`pts_ms` 来自 `AacPacket`。
    pub fn write_audio(&mut self, pts_ms: i64, data: &[u8]) -> Result<(), String> {
        let stream = self.audio_stream.ok_or("无音频轨")?;
        unsafe { self.write(stream, pts_ms * 10_000, self.audio_frame_t100, data) }
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
            Some(w) => unsafe { w.Finalize().map_err(mf_err) },
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
    // 三条铁律，靠逐属性探针实证——
    //   ① 输出类型必须带全尺寸/帧率/码率（缺了报在 SetInputMediaType，极具迷惑性）；
    //   ② 输入类型带 MF_MT_MPEG_SEQUENCE_HEADER 必被拒（任何格式/属性组合），
    //     参数集只能靠 sink 从 Annex-B 流内自取；
    //   ③ 音频两侧要补 AVG_BYTES_PER_SECOND + SAMPLES_PER_BLOCK，ASC 双侧都放才过。
    // 本测试走生产路径 RecSink::open 全真装配（含音轨），再用真编码器的帧走一次
    // 写入 + finalize，断言 moov 里出现 avcC（参数集真的进了容器）。编码器
    // 打不开的机器上端到端段优雅跳过。 ──
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
        let mut sink = RecSink::open(&path, w, h, fps, false, Some((48000, 2, &asc)), br)
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
        for i in 0..12i64 {
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
            sink.finalize().expect("finalize 必须成功");
            drop(sink);
            let bytes = std::fs::read(&path).unwrap();
            assert!(
                bytes.windows(4).any(|win| win == b"avcC"),
                "moov 必须带 avcC——sink 没从流里收到参数集"
            );
        } else {
            // 编码器缺席：类型装配（本回归的本体）已在 open 处验证过；
            // 空 sink 不能 finalize（0xC00D4A44 = 未处理任何 sample），直接丢弃
            drop(sink);
        }
        let _ = std::fs::remove_file(&path);
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
