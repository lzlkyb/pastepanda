//! MF SinkWriter 封装——录屏的 MP4 封装层（视频 H.264/HEVC + 音频 AAC → .mp4）。
//!
//! 输入都是**已编码**数据（Annex-B 视频 / 裸 AAC 帧），SinkWriter 只做 mux：
//! MP4 sink 内置 Annex-B → 长度前缀（avcC/hvcC）转换，参数集（SPS/PPS/VPS）
//! 经 `MF_MT_MPEG_SEQUENCE_HEADER` 显式喂给它，不依赖从流里猜。
//!
//! 流的建立用 **AddStream（输出类型）→ SetInputMediaType（输入类型）** 的经典
//! 两步——windows 0.58 的 `IMFSinkWriter` 绑定没有 `SetOutputMediaType`（那是
//! Win8+ 的后加方法，绑定元数据没跟上），`AddStream` 全版本可用且语义一致。
//!
//! MF 时间单位 100ns；`at_ms * 10_000`。全部 COM 调用收敛在本文件，
//! 释放顺序同 `encode_h264.rs::release_com`：先放对象引用再 CoUninitialize。

#![cfg(target_os = "windows")]

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFSample, IMFSinkWriter, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MF_MT_AVG_BITRATE, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_MPEG_SEQUENCE_HEADER,
    MF_MT_SUBTYPE, MF_MT_USER_DATA, MFMediaType_Audio, MFMediaType_Video, MFAudioFormat_AAC,
    MFVideoFormat_H264, MFVideoFormat_HEVC,
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
    /// 打开 MP4 封装。`video_seq_header` = 参数集（`extract_parameter_sets` 的产物，
    /// 首帧里必须提得到）；音频轨可选（`None` = 纯画面）。
    pub fn open(
        path: &std::path::Path,
        width: u32,
        height: u32,
        fps: u32,
        hevc: bool,
        video_seq_header: &[u8],
        audio: Option<(u32, u32, &[u8])>, // (sample_rate, channels, asc)
        video_bitrate: u32,
    ) -> Result<Self, String> {
        unsafe {
            let com_owned = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
            .is_ok();
            crate::rc::encode_h264::ensure_mf_startup()?;

            let wide = HSTRING::from(path.as_os_str());
            let writer = MFCreateSinkWriterFromURL(PCWSTR::from_raw(wide.as_ptr()), None, None)
                .map_err(mf_err)?;

            let video_subtype = if hevc { &MFVideoFormat_HEVC } else { &MFVideoFormat_H264 };

            // ── 视频流：输出（容器侧）类型，AddStream 拿流号 ──
            let vout = MFCreateMediaType().map_err(mf_err)?;
            vout.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(mf_err)?;
            vout.SetGUID(&MF_MT_SUBTYPE, video_subtype).map_err(mf_err)?;
            let video_stream = writer.AddStream(&vout).map_err(mf_err)?;

            // ── 视频流：输入（已编码 Annex-B）类型 ──
            let vin = MFCreateMediaType().map_err(mf_err)?;
            vin.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(mf_err)?;
            vin.SetGUID(&MF_MT_SUBTYPE, video_subtype).map_err(mf_err)?;
            vin.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)
                .map_err(mf_err)?;
            vin.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1).map_err(mf_err)?;
            vin.SetUINT32(&MF_MT_AVG_BITRATE, video_bitrate).map_err(mf_err)?;
            if !video_seq_header.is_empty() {
                vin.SetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, video_seq_header)
                    .map_err(mf_err)?;
            }
            writer.SetInputMediaType(video_stream, &vin, None).map_err(mf_err)?;

            // ── 音频流（可选）：裸 AAC 帧 + ASC ──
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
                let stream = writer.AddStream(&aout).map_err(mf_err)?;
                let ain = MFCreateMediaType().map_err(mf_err)?;
                ain.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(mf_err)?;
                ain.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(mf_err)?;
                ain.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sr).map_err(mf_err)?;
                ain.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(mf_err)?;
                ain.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(mf_err)?;
                ain.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * 2).map_err(mf_err)?;
                ain.SetBlob(&MF_MT_USER_DATA, asc).map_err(mf_err)?;
                writer.SetInputMediaType(stream, &ain, None).map_err(mf_err)?;
                audio_stream = Some(stream);
                // AAC-LC 每帧 1024 采样
                audio_frame_t100 = 1024i64 * 10_000_000 / sr.max(1) as i64;
            }

            writer.BeginWriting().map_err(mf_err)?;
            Ok(Self {
                writer: Some(writer),
                video_stream,
                audio_stream,
                audio_frame_t100,
                com_owned,
            })
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
