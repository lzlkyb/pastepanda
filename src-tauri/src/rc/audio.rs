//! G3 — 会话音频：被控端系统声音 → 发起端播放。
//!
//! 三段式：
//! - **采集**：WASAPI 环回（默认渲染设备、共享模式）——远程「用电脑」听到的
//!   就是对方机器正在播的声音；没有渲染设备（无头机）= 没有音频，不报错。
//! - **编码**：MF 收件箱 AAC 编码器（`Microsoft AAC Audio Encoder`，同步 MFT，
//!   Win7 起自带）——零新依赖零体积；AAC-LC 每帧 1024 采样独立可解，
//!   丢一帧只咔一声不扩散。曾考虑 Opus（业界标配，但要多带 ~0.5MB 的 C 库，
//!   「不增加 exe 大量体积」约束下收件箱 AAC 是零成本路线）。
//! - **传输**：被控端**另开一条 QUIC 单向流**（`conn.open_uni`）专送音频——
//!   与视频可靠流分属不同 QUIC 流，互不队头阻塞；可靠有序对 AAC 无 FEC 也够用。
//!
//! 帧格式（音频流，被控端 → 发起端）：
//! `b"PPAUD1"` | `u32 json_len` | JSON `{"sr","ch","asc","br"}`，其后每个包
//! `u32 len` | `u8 type`(1=AAC) | `u64 pts_ms` | payload。
//! 发起端 `accept_uni` 后按头部识别音频流（其它未知流直接关）。
//!
//! 采样率跟设备混音格式走（44.1k/48k 直接编码，**不做重采样**）；
//! 声道统一缩混成立体声（mono 复制、>2ch 平均拆左右）。
//!
//! 延迟账（2026-09-20 实测，`aac编码器_开得起来且出帧` 打的数）：收件箱 AAC
//! 有 **2 帧编码器前瞻**（首包落在第 2 次提交、首个 pts=42ms；1024/48000≈21ms/帧），
//! 加上前端 60ms 起播缓冲与轮询抖动，端到端声音延迟量级 **~150ms**——远程办公够用，
//! 不适合节奏游戏。要压得更低得换 Opus（多带 C 库，体积代价）或把播放游标压到 30ms。

#![cfg(target_os = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
    MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL};

/// 音频流魔数（版本号缀在末尾：协议不兼容时对端认不出，直接关流）。
pub(super) const MAGIC: &[u8; 6] = b"PPAUD1";
/// AAC-LC 每帧采样数（每声道）。收件箱编码器固定值。
const AAC_SAMPLES_PER_FRAME: usize = 1024;
/// 编码声道数（采集侧缩混到此）。
const CHANNELS: u32 = 2;
/// 目标码率：128kbps 立体声（桌面音频透明档）。
const BITRATE_BPS: u32 = 128_000;
/// 发起端收包队列上限（≈40ms/包 → 2.5s）；满了丢最旧的——音频要新鲜。
const QUEUE_CAP: usize = 64;

// ── 线格式 ──────────────────────────────────────────────────────────────

/// 流描述（头部 JSON 的结构化形态）。`asc` = AAC AudioSpecificConfig，
/// 前端 WebCodecs `description` 直接用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioCfg {
    pub sr: u32,
    pub ch: u32,
    #[serde(with = "serde_b64")]
    pub asc: Vec<u8>,
    /// 码率 kbps（展示用）。
    pub br: u32,
}

mod serde_b64 {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD
            .decode(s)
            .map_err(serde::de::Error::custom)
    }
}

/// 发起端收到的音频包（drain 命令的元素）。
#[derive(Debug, Clone)]
pub struct AudioPkt {
    pub pts_ms: u64,
    pub data: Vec<u8>,
}

/// 发起端音频收流缓冲：accept_uni 的音频流写入，`rc_drain_audio` 取走。
/// AAC-LC 帧相互独立，队列满了丢最旧的（要新鲜，不要迟到的声音）。
#[derive(Default)]
pub struct AudioRx {
    pub cfg: Option<AudioCfg>,
    pub queue: std::collections::VecDeque<AudioPkt>,
}

impl AudioRx {
    pub fn begin(&mut self, cfg: AudioCfg) {
        self.cfg = Some(cfg);
        self.queue.clear();
    }

    pub fn push(&mut self, pts_ms: u64, data: Vec<u8>) {
        if self.queue.len() >= QUEUE_CAP {
            self.queue.pop_front();
        }
        self.queue.push_back(AudioPkt { pts_ms, data });
    }

    pub fn reset(&mut self) {
        self.cfg = None;
        self.queue.clear();
    }
}

/// 编码侧 → 写流任务的消息。
#[derive(Debug)]
pub enum AudioOut {
    /// 编码器刚打开（或重开）：先写流头。
    Cfg(AudioCfg),
    Pkt { pts_ms: u64, data: Vec<u8> },
}

/// 组音频流头部。
pub fn encode_stream_header(cfg: &AudioCfg) -> Vec<u8> {
    let json = serde_json::to_vec(cfg).expect("AudioCfg 序列化不会失败");
    let mut out = Vec::with_capacity(MAGIC.len() + 4 + json.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out
}

/// 解音频流头部。`buf` 需包含完整头部；返回 (cfg, 头部长度)。
/// 发起端据此识别「这条 uni 流是音频」——不是音频流（旧版本对端/陌生协议）返回 None。
pub fn try_parse_stream_header(buf: &[u8]) -> Option<(AudioCfg, usize)> {
    if buf.len() < MAGIC.len() + 4 || buf[..MAGIC.len()] != *MAGIC {
        return None;
    }
    let n = u32::from_le_bytes(buf[MAGIC.len()..MAGIC.len() + 4].try_into().ok()?) as usize;
    let start = MAGIC.len() + 4;
    if buf.len() < start + n {
        return None;
    }
    let cfg = serde_json::from_slice::<AudioCfg>(&buf[start..start + n]).ok()?;
    Some((cfg, start + n))
}

/// 编码一个传输包。
pub fn encode_packet(pts_ms: u64, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 8 + 4 + data.len());
    out.extend_from_slice(&((1 + 8 + data.len()) as u32).to_le_bytes());
    out.push(1u8);
    out.extend_from_slice(&pts_ms.to_le_bytes());
    out.extend_from_slice(data);
    out
}

// ── 采集侧纯函数（单测覆盖）────────────────────────────────────────────

/// f32 [-1,1] → s16，clamp 防炸音。
pub fn f32_to_s16(v: f32) -> i16 {
    let scaled = v * 32767.0;
    scaled.clamp(-32768.0, 32767.0) as i16
}

/// 任意声道缩混成立体声（interleaved f32 → interleaved f32）。
/// mono 复制；2ch 原样；>2ch 偶数位平均=左、奇数位平均=右（5.1 的 C/LFE
/// 摊进两侧——不精确但可听，省一套逐布局矩阵）。
pub fn downmix_to_stereo_f32(src: &[f32], ch: usize) -> Vec<f32> {
    match ch {
        0 => Vec::new(),
        1 => {
            let mut out = Vec::with_capacity(src.len() * 2);
            for v in src {
                out.push(*v);
                out.push(*v);
            }
            out
        }
        2 => src.to_vec(),
        n => {
            let frames = src.len() / n;
            let mut out = Vec::with_capacity(frames * 2);
            for f in 0..frames {
                let base = f * n;
                let mut l = 0f32;
                let mut r = 0f32;
                let (mut cl, mut cr) = (0usize, 0usize);
                for c in 0..n {
                    if c % 2 == 0 {
                        l += src[base + c];
                        cl += 1;
                    } else {
                        r += src[base + c];
                        cr += 1;
                    }
                }
                out.push(if cl > 0 { l / cl as f32 } else { 0.0 });
                out.push(if cr > 0 { r / cr as f32 } else { 0.0 });
            }
            out
        }
    }
}

/// 立体声 f32 → s16 interleaved。
pub fn stereo_f32_to_s16(src: &[f32]) -> Vec<i16> {
    src.iter().map(|v| f32_to_s16(*v)).collect()
}

// ── MF 收件箱 AAC 编码器（同步 MFT）────────────────────────────────────

pub struct AacPacket {
    pub pts_ms: u64,
    pub data: Vec<u8>,
}

pub struct AacEncoder {
    transform: IMFTransform,
    /// 协商好的输出类型里读出的 AudioSpecificConfig（头部 JSON 用）。
    asc: Vec<u8>,
    sr: u32,
    /// 已喂入的**每声道**采样计数（pts 的时间轴）。
    samples_in: u64,
    /// 凑满 1024×ch 的输入蓄水池（s16 interleaved stereo）。
    acc: Vec<i16>,
    /// 输出缓冲字节数（GetOutputStreamInfo）。
    out_size: u32,
    com_owned: bool,
}

fn mf_err(e: windows::core::Error) -> String {
    format!("MF：{e}")
}

impl AacEncoder {
    /// 打开收件箱 AAC 编码器。`sr` 跟设备混音格式（不重采样）；
    /// `ch` 恒为 2（采集侧已缩混）。打不开（枚举为空/类型协商失败）返回 Err，
    /// 调用方禁用音频——绝不能因此影响视频会话。
    pub fn open(sr: u32) -> Result<Self, String> {
        unsafe {
            let com_owned = CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED)
                .is_ok();
            super::encode_h264::ensure_mf_startup()?;

            let in_info = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Audio,
                guidSubtype: MFAudioFormat_PCM,
            };
            let out_info = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Audio,
                guidSubtype: MFAudioFormat_AAC,
            };
            let transform = create_aac_mft(&in_info, &out_info)?;

            // 输入：s16 PCM interleaved stereo
            let in_type = MFCreateMediaType().map_err(mf_err)?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(mf_err)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(mf_err)?;
            in_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sr).map_err(mf_err)?;
            in_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS).map_err(mf_err)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(mf_err)?;
            in_type
                .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2)
                .map_err(mf_err)?;
            in_type
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sr * CHANNELS * 2)
                .map_err(mf_err)?;
            transform.SetInputType(0, &in_type, 0).map_err(mf_err)?;

            // 输出：从「可用输出类型」里挑 sr/ch 匹配的——收件箱编码器的
            // AAC 专用字段（PayloadType 等）由它自己填，自建类型协商不过。
            let mut chosen: Option<IMFMediaType> = None;
            for idx in 0..64u32 {
                let Ok(t) = transform.GetOutputAvailableType(0, idx) else {
                    break;
                };
                let ok_sr =
                    t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(0) == sr;
                let ok_ch =
                    t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(0) == CHANNELS;
                if ok_sr && ok_ch {
                    chosen = Some(t);
                    break;
                }
            }
            let out_type = chosen.ok_or_else(|| format!("AAC 编码器没有 {sr}Hz 立体声输出类型"))?;
            // 尽力抬码率到 128k（可用类型带的是默认档）；失败只 warn
            if let Err(e) = out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, BITRATE_BPS / 8) {
                log::warn!("[RC] AAC 码率设置失败（用默认档）：{e}");
            }
            transform.SetOutputType(0, &out_type, 0).map_err(mf_err)?;

            // PayloadType 必须 0（裸 AAC 帧）；ADTS 流前端 description 对不上
            let payload = out_type.GetUINT32(&MF_MT_AAC_PAYLOAD_TYPE).unwrap_or(0);
            if payload != 0 {
                return Err(format!("AAC PayloadType={payload}（只支持 0=裸帧）"));
            }
            // AudioSpecificConfig（前端 description）。0.58 无 MF_MT_AAC_* 常量，
            // 直接按 AOT/采样率表/声道构造——AAC-LC 的 ASC 是确定性位串。
            let asc = asc_for(sr, CHANNELS)
                .ok_or_else(|| format!("ASC 构造失败：{sr}Hz 不在 AAC 标准采样率表内"))?;

            // 输出缓冲尺寸（自备 sample 用）。收件箱 AAC 是同步 MFT，不带分配器。
            let info = transform.GetOutputStreamInfo(0).map_err(mf_err)?;

            log::info!(
                "[RC] AAC 编码器已开：{sr}Hz 立体声 {}kbps，ASC {} 字节",
                BITRATE_BPS / 1000,
                asc.len()
            );
            Ok(Self {
                transform,
                asc,
                sr,
                samples_in: 0,
                acc: Vec::new(),
                out_size: info.cbSize.max(1),
                com_owned,
            })
        }
    }

    pub fn cfg(&self) -> AudioCfg {
        AudioCfg {
            sr: self.sr,
            ch: CHANNELS,
            asc: self.asc.clone(),
            br: BITRATE_BPS / 1000,
        }
    }

    /// 喂一段 s16 立体声 interleaved 采样，取回编出的 AAC 帧。
    /// 内部凑满 1024×2 才提交；不满的留在蓄水池。
    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<AacPacket>, String> {
        self.acc.extend_from_slice(pcm);
        let frame_vals = AAC_SAMPLES_PER_FRAME * CHANNELS as usize;
        let mut out = Vec::new();
        while self.acc.len() >= frame_vals {
            let chunk: Vec<i16> = self.acc.drain(..frame_vals).collect();
            let pts_ms = (self.samples_in * 1000) / self.sr.max(1) as u64;
            self.samples_in += AAC_SAMPLES_PER_FRAME as u64;
            out.extend(self.submit(&chunk, pts_ms)?);
        }
        Ok(out)
    }

    fn submit(&mut self, chunk: &[i16], pts_ms: u64) -> Result<Vec<AacPacket>, String> {
        unsafe {
            let bytes: Vec<u8> = chunk.iter().flat_map(|v| v.to_le_bytes()).collect();
            let buf = MFCreateMemoryBuffer(bytes.len() as u32).map_err(mf_err)?;
            {
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut max = 0u32;
                let mut cur = 0u32;
                buf.Lock(&mut p, Some(&mut max), Some(&mut cur)).map_err(mf_err)?;
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
                }
                buf.SetCurrentLength(bytes.len() as u32).map_err(mf_err)?;
                buf.Unlock().map_err(mf_err)?;
            }
            let sample = MFCreateSample().map_err(mf_err)?;
            sample.AddBuffer(&buf).map_err(mf_err)?;
            let t100 = (self.samples_in as i64 - AAC_SAMPLES_PER_FRAME as i64) * 10_000_000
                / self.sr.max(1) as i64;
            sample.SetSampleTime(t100).map_err(mf_err)?;
            sample
                .SetSampleDuration(AAC_SAMPLES_PER_FRAME as i64 * 10_000_000 / self.sr.max(1) as i64)
                .map_err(mf_err)?;
            self.transform.ProcessInput(0, &sample, 0).map_err(mf_err)?;

            let mut out = Vec::new();
            loop {
                // 自备输出 sample（收件箱 AAC 是同步 MFT，不自带分配器）：
                // 同一个 sample 反复提交——MFT 每轮把新帧写进它的缓冲。
                let provided = MFCreateSample().map_err(mf_err)?;
                let obuf = MFCreateMemoryBuffer(self.out_size).map_err(mf_err)?;
                provided.AddBuffer(&obuf).map_err(mf_err)?;
                let odb = MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: std::mem::ManuallyDrop::new(Some(provided.clone())),
                    dwStatus: 0,
                    pEvents: std::mem::ManuallyDrop::new(None),
                };
                let mut status = 0u32;
                let mut outs = [odb];
                match self.transform.ProcessOutput(0, &mut outs, &mut status) {
                    Ok(()) => {}
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                    Err(e) => return Err(format!("ProcessOutput：{e}")),
                }
                if let Ok(buf) = provided.ConvertToContiguousBuffer() {
                    if let Ok(bytes) = lock_buffer(&buf) {
                        if !bytes.is_empty() {
                            out.push(AacPacket { pts_ms, data: bytes });
                        }
                    }
                }
            }
            Ok(out)
        }
    }
}

impl Drop for AacEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        if self.com_owned {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

/// 由采样率/声道构造 AAC AudioSpecificConfig（AAC-LC）。
///
/// windows 0.58 没带 `MF_MT_AAC_AUDIO_SPECIFIC_DATA` 常量，而 ASC 本身是
/// 确定性位串（MSB 起）：AOT(5)=2(LC) | 采样率表序号(4) | 声道数(4) |
/// frameLen/dependsOnCoreCoder/extensionFlag 三个 0 → 正好 16 位两字节。
/// 对拍已知值：44.1k 立体声 = `0x12 0x10`（经典 "1210"）、48k 立体声 = `0x11 0x90`。
/// 采样率不在 ISO 14496-3 表 1.9 内（显式 24 位写法）不支持——收件箱 AAC
/// 编码器本身也只收表内采样率，SetInputType 会先一步失败。
fn asc_for(sr: u32, ch: u32) -> Option<Vec<u8>> {
    const FREQ_INDEX: [(u32, u32); 12] = [
        (96000, 0),
        (88200, 1),
        (64000, 2),
        (48000, 3),
        (44100, 4),
        (32000, 5),
        (24000, 6),
        (22050, 7),
        (16000, 8),
        (12000, 9),
        (11025, 10),
        (8000, 11),
    ];
    let idx = FREQ_INDEX.iter().find(|(f, _)| *f == sr)?.1;
    if ch == 0 || ch > 15 {
        return None;
    }
    let word: u16 = (2u16 << 11) | ((idx as u16) << 7) | ((ch as u16) << 3); // AOT=2 (AAC-LC)
    Some(vec![(word >> 8) as u8, (word & 0xFF) as u8])
}

unsafe fn lock_buffer(buf: &IMFMediaBuffer) -> Result<Vec<u8>, String> {
    let mut p: *mut u8 = std::ptr::null_mut();
    let mut max = 0u32;
    let mut cur = 0u32;
    buf.Lock(&mut p, Some(&mut max), Some(&mut cur)).map_err(mf_err)?;
    let n = if cur > 0 { cur as usize } else { max as usize };
    let mut out = vec![0u8; n];
    if !p.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(p, out.as_mut_ptr(), n);
    }
    buf.Unlock().map_err(mf_err)?;
    Ok(out)
}

/// 枚举收件箱 AAC 编码器（同步软件 MFT）。优先 SYNCMFT，兜底 ALL。
unsafe fn create_aac_mft(
    in_info: &MFT_REGISTER_TYPE_INFO,
    out_info: &MFT_REGISTER_TYPE_INFO,
) -> Result<IMFTransform, String> {
    for flags in [MFT_ENUM_FLAG_SYNCMFT, MFT_ENUM_FLAG_ALL] {
        let mut count = 0u32;
        let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
        let _ = MFTEnumEx(
            MFT_CATEGORY_AUDIO_ENCODER,
            flags,
            Some(in_info),
            Some(out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            let slice = std::slice::from_raw_parts(acts, count as usize);
            let first = slice[0].clone().ok_or("MFT activate 为空")?;
            CoTaskMemFree(Some(acts as _));
            return first
                .ActivateObject::<IMFTransform>()
                .map_err(|e| format!("ActivateObject(AAC)：{e}"));
        }
        if !acts.is_null() {
            CoTaskMemFree(Some(acts as _));
        }
    }
    Err("无 AAC 编码 MFT（收件箱缺失）".into())
}

// ── WASAPI 环回采集 ────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum SampleFmt {
    F32,
    S16,
}

pub struct LoopbackCapture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    sr: u32,
    ch: usize,
    fmt: SampleFmt,
}

impl LoopbackCapture {
    /// 打开默认渲染设备的环回采集。**必须在已 CoInitializeEx 的线程上调用**。
    /// 没有默认设备（无头机/禁用声卡）→ Err，调用方禁用音频。
    pub fn new() -> Result<Self, String> {
        unsafe {
            let enumr: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(mf_err)?;
            let dev = enumr
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .map_err(|e| format!("无默认播放设备：{e}"))?;
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
            Ok(Self { client, capture, sr, ch, fmt })
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr
    }

    /// 取走当前攒下的全部采样 → 立体声 s16 interleaved。没货返回空。
    pub fn pump(&self) -> Vec<i16> {
        let mut out = Vec::new();
        unsafe {
            loop {
                let Ok(n) = self.capture.GetNextPacketSize() else {
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
        out
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
    pub fn start(wanted: WantedFlag, tx: tokio::sync::mpsc::UnboundedSender<AudioOut>) -> Self {
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

fn audio_thread(stop: Arc<AtomicBool>, wanted: WantedFlag, tx: tokio::sync::mpsc::UnboundedSender<AudioOut>) {
    let com = ComGuard::new();
    let _ = com;
    let mut cap: Option<LoopbackCapture> = None;
    let mut enc: Option<AacEncoder> = None;
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
                Ok((c, e)) => {
                    let _ = tx.send(AudioOut::Cfg(e.cfg()));
                    cap = Some(c);
                    enc = Some(e);
                    log::info!("[RC] 音频采集启动（系统声音 → 对端）");
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
        let (Some(c), Some(e)) = (cap.as_ref(), enc.as_mut()) else {
            std::thread::sleep(std::time::Duration::from_millis(250));
            continue;
        };
        let pcm = c.pump();
        if pcm.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(8));
            continue;
        }
        match e.encode(&pcm) {
            Ok(pkts) => {
                for p in pkts {
                    if tx.send(AudioOut::Pkt { pts_ms: p.pts_ms, data: p.data }).is_err() {
                        return; // 写流任务没了：会话已结束
                    }
                }
            }
            Err(err) => {
                log::warn!("[RC] AAC 编码失败，重开编码器：{err}");
                enc = None;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 流头编解对称() {
        let cfg = AudioCfg { sr: 48000, ch: 2, asc: vec![0x12, 0x10], br: 128 };
        let buf = encode_stream_header(&cfg);
        let (got, used) = try_parse_stream_header(&buf).expect("应识别为音频流");
        assert_eq!(got, cfg);
        assert_eq!(used, buf.len());
        // 非音频流（旧版本对端的未知流）认不出
        assert!(try_parse_stream_header(b"XXXXXXXX").is_none());
        assert!(try_parse_stream_header(&buf[..buf.len() - 1]).is_none(), "截断不误判");
    }

    #[test]
    fn 传输包编解() {
        let p = encode_packet(1234, &[1, 2, 3]);
        let len = u32::from_le_bytes(p[0..4].try_into().unwrap()) as usize;
        assert_eq!(len, p.len() - 4, "len 是去掉长度字段后的总长");
        assert_eq!(p[4], 1);
        let pts = u64::from_le_bytes(p[5..13].try_into().unwrap());
        assert_eq!(pts, 1234);
        assert_eq!(&p[13..], &[1, 2, 3]);
    }

    #[test]
    fn 缩混_单声道复制() {
        let out = downmix_to_stereo_f32(&[0.5, 0.25], 1);
        assert_eq!(out, vec![0.5, 0.5, 0.25, 0.25]);
    }

    #[test]
    fn 缩混_立体声原样() {
        let src = vec![0.1f32, 0.2, 0.3, 0.4];
        assert_eq!(downmix_to_stereo_f32(&src, 2), src);
    }

    #[test]
    fn 缩混_四声道平均拆左右() {
        // FL FR SL SR → L=(FL+SL)/2 R=(FR+SR)/2
        let out = downmix_to_stereo_f32(&[1.0f32, 0.0, 0.5, 0.5], 4);
        assert_eq!(out, vec![0.75, 0.25]);
    }

    #[test]
    fn f32转s16_钳位() {
        assert_eq!(f32_to_s16(0.0), 0);
        assert_eq!(f32_to_s16(1.0), 32767);
        assert_eq!(f32_to_s16(-1.5), -32768, "超界 clamp，不回绕");
        assert_eq!(f32_to_s16(2.0), 32767);
    }

    #[test]
    fn asc构造_对拍已知值() {
        // 经典 AAC-LC ASC：44.1k 立体声 = "1210"
        assert_eq!(asc_for(44100, 2), Some(vec![0x12, 0x10]));
        // 48k 立体声 = "1190"
        assert_eq!(asc_for(48000, 2), Some(vec![0x11, 0x90]));
        // 单声道 48k：chCfg=1 → 0x1188
        assert_eq!(asc_for(48000, 1), Some(vec![0x11, 0x88]));
        // 表外采样率不支持（编码器本身也拒）
        assert_eq!(asc_for(44101, 2), None);
    }

    // ── 收流队列（发起端）────────────────────────────────────────────────

    #[test]
    fn 收流队列_满则丢最旧() {
        let mut rx = AudioRx::default();
        rx.begin(AudioCfg { sr: 48000, ch: 2, asc: vec![1, 2], br: 128 });
        for i in 0..(QUEUE_CAP as u64 + 5) {
            rx.push(i, vec![i as u8]);
        }
        assert_eq!(rx.queue.len(), QUEUE_CAP, "队列有上限");
        assert_eq!(rx.queue.front().unwrap().pts_ms, 5, "丢的是最旧的 5 个");
        assert_eq!(rx.queue.back().unwrap().pts_ms, QUEUE_CAP as u64 + 4);
    }

    #[test]
    fn 收流队列_新流清空旧包() {
        let mut rx = AudioRx::default();
        rx.push(1, vec![1]);
        rx.begin(AudioCfg { sr: 44100, ch: 2, asc: vec![9], br: 96 });
        assert!(rx.queue.is_empty(), "换流不能把上一条流的残包播出来");
        assert_eq!(rx.cfg.as_ref().unwrap().sr, 44100);
    }

    #[test]
    fn 收流队列_reset清干净() {
        let mut rx = AudioRx::default();
        rx.begin(AudioCfg { sr: 48000, ch: 2, asc: vec![1], br: 128 });
        rx.push(3, vec![7]);
        rx.reset();
        assert!(rx.cfg.is_none() && rx.queue.is_empty());
    }

    // ── 真机烟测：收件箱 AAC 编码器（不联网、不依赖对端）────────────────

    /// 这条是整个 G3 里唯一「真开 COM + MF + 收件箱 MFT 编出字节」的证据。
    /// 顺带把**编码器延迟**量出来（收件箱 AAC 有 MDCT 前瞻，前几帧不出包）——
    /// 这是估算「声音总延迟」时不能漏的一段。
    #[test]
    fn aac编码器_开得起来且出帧() {
        let mut enc = AacEncoder::open(48000).expect("收件箱 AAC 编码器应能打开");
        assert_eq!(enc.cfg().asc, vec![0x11, 0x90], "48k 立体声 ASC 对拍");
        assert_eq!(enc.cfg().br, BITRATE_BPS / 1000);

        // 不满一帧（1024 采样/声道 = 2048 个 i16）不提交，蓄在池子里
        assert!(enc.encode(&vec![0i16; 1000]).expect("不足一帧不应报错").is_empty());

        const PROBE_FRAMES: usize = 10;
        let frame = vec![0i16; AAC_SAMPLES_PER_FRAME * CHANNELS as usize];
        let mut pkts = Vec::new();
        let mut first_out_at = None;
        for i in 0..PROBE_FRAMES {
            let got = enc.encode(&frame).expect("满帧不应报错");
            if first_out_at.is_none() && !got.is_empty() {
                first_out_at = Some(i);
            }
            pkts.extend(got);
        }
        let delay = first_out_at.expect("连喂多帧必有输出（没有 = 编码器真的不出包）");
        eprintln!(
            "[G3 实测] 喂 {PROBE_FRAMES} 帧出 {} 包，首个输出落在第 {} 次提交，pts={}",
            pkts.len(),
            delay,
            pkts.first().map(|p| p.pts_ms).unwrap_or(0)
        );
        assert!(delay <= 3, "编码器延迟应在 3 帧（≈64ms）以内，实测 {delay}");
        assert_eq!(pkts.len(), PROBE_FRAMES - delay, "提交数与输出数应对得上");
        for p in &pkts {
            assert!(!p.data.is_empty(), "AAC 包不该是空的");
            assert!(p.data.len() < 2048, "128kbps 一帧（21ms）远小于 2KB");
        }
        // pts 递增且间距 ≈21ms（1024/48000）
        for w in pkts.windows(2) {
            assert!(
                w[1].pts_ms > w[0].pts_ms,
                "pts 必须递增：{} → {}",
                w[0].pts_ms,
                w[1].pts_ms
            );
            assert!(
                w[1].pts_ms - w[0].pts_ms <= 22,
                "间距应是 21~22ms：{} → {}",
                w[0].pts_ms,
                w[1].pts_ms
            );
        }

        // 包能过传输编码（长度字段 + 类型 + pts）并原样取回
        let wire = encode_packet(pkts[0].pts_ms, &pkts[0].data);
        let n = u32::from_le_bytes(wire[0..4].try_into().unwrap()) as usize;
        assert_eq!(n, wire.len() - 4);
        assert_eq!(&wire[13..], pkts[0].data.as_slice());
    }
}
