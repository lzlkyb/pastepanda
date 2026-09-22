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
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
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

/// 有界音频队列容量（约 64 × AAC 帧 ≈ 1.3s @48k）。满了丢最旧语义由
/// `try_push_audio` 的 try_send+计数近似：不堆积、不阻塞采集线程。
pub const AUDIO_CHAN_CAP: usize = 64;

/// 生产侧入口：有界 channel + `try_send`，满则丢包计数，**禁止无界堆积**。
/// 返回 `false` = 通道已关（会话结束，采集线程应退出）。
pub fn try_push_audio(
    tx: &tokio::sync::mpsc::Sender<AudioOut>,
    msg: AudioOut,
    dropped: &std::sync::atomic::AtomicU64,
) -> bool {
    use std::sync::atomic::Ordering;
    match tx.try_send(msg) {
        Ok(()) => true,
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            let n = dropped.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n.is_multiple_of(50) {
                log::warn!("[RC] 音频队列已满，丢包计数 {n}");
            }
            true
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => false,
    }
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

mod encode;
mod capture;

pub use encode::*;
// mf_err 给 capture 子模块用（经 use super::* 可见）。
use encode::mf_err;
pub use capture::*;

#[cfg(test)]
use encode::asc_for;

#[cfg(test)]
mod tests;