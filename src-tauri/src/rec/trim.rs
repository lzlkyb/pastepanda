//! 录屏裁剪（四期 1.4）——关键帧对齐**无损剪切**：只重排 MP4 容器的 sample 表，
//! 不解码不转码，样本字节原样拷贝。
//!
//! # 为什么不用 `mp4` crate 的写路径
//!
//! 读路径没问题，但它的 HEVC 写路径是坏的：`HvcCBox::new()` 只写 1 字节
//! configuration_version，VPS/SPS/PPS 参数集全丢——原画档（HEVC）产物不可播。
//! 我们的产物形状已知（MF SinkWriter：`ftyp + mdat + moov`、非分片、
//! 视频 avc1/hev1 加可选 mp4a），因此自研定向重组器：**stsd 整块字节拷贝**（avcC/hvcC/esds 免重建，
//! 编解码无关），只重建四张表（stts / stss / stsc / stsz / stco）。
//!
//! # 时间域
//!
//! 样表里的时间是 **media 域**；播放域可能被 `edts/elst` 平移（SinkWriter 在音画
//! 锚点不一致时会给某条轨写 elst）。所有对外毫秒（关键帧、吸附、入出点）都是
//! **播放域**：`播放时间 = media 时间 − elst.media_time`；片头预留段（播放 <0 的
//! 样本，播放器不可见）不进关键帧索引。
//!
//! 重组不变量：**输出样本 media 时间从 0 续排**（stts 是纯差值表，首样本恒为
//! media 0），因此 elst.media_time 一并归零、segment_duration 改指新时长——
//! 播放 0 点 = 首个保留样本。各轨按同一播放点切开，音画对齐不漂移。
//!
//! # 吸附规则（宁多勿少）
//!
//! 入点吸到 ≤ 它的最近关键帧、出点吸到 ≥ 它的最近关键帧（无可吸时取 0/时长）——
//! 保留段 ⊇ 用户选段，最坏多留 1s，绝不丢用户要的内容。
//!
//! 未知盒子：stbl 内遇到（如 sdtp，逐样本语义）直接报错不硬写；moov 其他层级
//! 按字节原样保留。
//!
//! # 模块划分
//!
//! 本文件只留对外接口与源文件模型；字节工具在 `boxes.rs`，源解析在 `parse.rs`，
//! 重组写出在 `rewrite.rs`（原 1398 行单文件按解析/重写切开，便于各自复审上限）。

use std::path::{Path, PathBuf};

#[allow(clippy::duplicate_mod)] // output.rs 是各录制器以 #[path] 自带的共享模块，各自实例化互不引用，刻意布局
#[path = "output.rs"]
mod output;
#[path = "trim_job.rs"]
mod trim_job;
mod boxes;
mod parse;
mod rewrite;
#[cfg(test)]
mod tests;

pub use trim_job::{cancel as cancel_job, start as start_job, status as job_status, TrimJob};
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRACK_SAMPLES: u32 = 1_000_000;
const MAX_BOX_COUNT: usize = 100_000;

// ── 对外接口 ────────────────────────────────────────────────────────────

pub use super::trim_types::{snap, KeyframeIndex};

/// 扫视频轨关键帧（播放域毫秒）。只读 moov 表，不碰样本字节。
pub fn scan_keyframes(path: &Path) -> Result<KeyframeIndex, String> {
    let src = SrcMp4::open(path)?;
    let v = src
        .video()
        .ok_or_else(|| "文件没有视频轨（不是录屏产物？）".to_string())?;
    // 只收**可见**关键帧（media ≥ elst）：片头预留段（播放 <0）里的关键帧
    // 播放器永远放不到，进索引会把入点吸到不可达的位置
    let ts = u64::from(v.timescale.max(1));
    let keyframes_ms = v
        .samples
        .iter()
        .filter(|s| s.is_sync && s.media_time >= v.elst_media_time)
        .map(|s| (s.media_time - v.elst_media_time) * 1000 / ts)
        .collect();
    // 帧率取样本时长的**中位数**：静止期 MF 把空隙写进前一个样本的 duration
    // （见 timeline.rs 文件头），那些长样本会把平均值拉低；中位数仍是真实帧长。
    let fps = {
        let mut durations: Vec<u32> = v.samples.iter().map(|s| s.duration).filter(|d| *d > 0).collect();
        durations.sort_unstable();
        durations
            .get(durations.len() / 2)
            .map(|&ticks| (ts as f64 / f64::from(ticks) * 1000.0).round() / 1000.0)
            .filter(|fps| *fps > 0.0)
    };
    Ok(KeyframeIndex { duration_ms: v.duration_ms(), keyframes_ms, warning: None, fps })
}

/// 剪切 `[in_ms, out_ms]`（播放域，内部按宁多勿少吸附）到 `dst`。
/// 返回 (文件字节数, 实际入点, 实际出点)——实际值已按关键帧吸附。
/// 生产路径都带 TrimJob 走 [`trim_with_job`]；本包装目前仅测试在用，故 cfg(test)。
#[cfg(test)]
pub fn trim(src: &Path, in_ms: u64, out_ms: u64, dst: &Path) -> Result<(u64, u64, u64), String> {
    if in_ms >= out_ms {
        return Err("选段为空（入点不早于出点）".into());
    }
    trim_with_job(src, in_ms, out_ms, dst, None)
}

/// 剪切 `[in_ms, out_ms]`（播放域，内部按宁多勿少吸附）到 `dst`。
/// 返回 (文件字节数, 实际入点, 实际出点)——实际值已按关键帧吸附。
pub fn trim_with_job(src: &Path, in_ms: u64, out_ms: u64, dst: &Path, job: Option<&TrimJob>) -> Result<(u64,u64,u64),String> {
    if in_ms >= out_ms {return Err("选段为空（入点不早于出点）".into());}
    if let Some(job)=job {job.check_cancelled()?;}
    let mut src_mp4 = SrcMp4::open(src)?;
    let kf = scan_keyframes(src)?;
    let (in_m, out_m) = snap(&kf.keyframes_ms, kf.duration_ms, in_ms, out_ms);
    if out_m <= in_m {
        return Err("选段为空（吸附后没有可保留的内容）".into());
    }
    // 实际入点以视频首保留关键帧为准（选段早于首个可见关键帧时被顶后），回传真实值
    src_mp4.write_trimmed(dst, in_m, out_m, job)
}

fn media_to_playback_ms(media_ts: u64, timescale: u32, elst_media_time: u64) -> u64 {
    media_ts
        .saturating_sub(elst_media_time)
        .saturating_mul(1000)
        / u64::from(timescale.max(1))
}

// ── 源文件模型（解析侧填充、重组侧消费）─────────────────────────────────

/// 一条轨的保留计划（1-based 闭开区间 [first, end)）。
struct Plan {
    ti: usize,
    first: u32,
    end: u32,
}

/// 重组所需的全部样本信息（解析期一次算好，含文件偏移）。
#[derive(Clone, Debug)]
struct Sample {
    media_time: u64,
    duration: u32,
    size: u32,
    file_offset: u64,
    is_sync: bool,
}

struct SrcTrack {
    timescale: u32,
    /// elst 媒体起点（播放域 0 点对应的 media 时间；无 elst = 0）。
    elst_media_time: u64,
    /// 源是否有 stss（重建时决定写不写这张表；全同步轨不写）。
    has_stss: bool,
    /// edts 载荷（原样保留；None = 无）。
    edts: Option<Vec<u8>>,
    stsd: Vec<u8>,
    samples: Vec<Sample>,
    /// stsc 首条 entry 的 sample_description_index（重建 stsc 用）。
    desc_index: u32,
    is_video: bool,
}

impl SrcTrack {
    /// 播放域时长（最后样本终点）。
    fn duration_ms(&self) -> u64 {
        let last = self.samples.last().expect("轨道至少一个样本（parse 已保证）");
        media_to_playback_ms(last.media_time + u64::from(last.duration), self.timescale, self.elst_media_time)
    }
}

struct SrcMp4 {
    path: PathBuf,
    ftyp: Vec<u8>,
    moov: Vec<u8>,
    tracks: Vec<SrcTrack>,
}
