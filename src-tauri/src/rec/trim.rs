//! 录屏裁剪（四期 1.4）——关键帧对齐**无损剪切**：只重排 MP4 容器的 sample 表，
//! 不解码不转码，样本字节原样拷贝。
//!
//! # 为什么不用 `mp4` crate 的写路径
//!
//! 读路径没问题，但它的 HEVC 写路径是坏的：`HvcCBox::new()` 只写 1 字节
//! configuration_version，VPS/SPS/PPS 参数集全丢——原画档（HEVC）产物不可播。
//! 我们的产物形状已知（MF SinkWriter：`ftyp + mdat + moov`、非分片、视频 avc1/hev1
//! + 可选 mp4a），因此自研定向重组器：**stsd 整块字节拷贝**（avcC/hvcC/esds 免重建，
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

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

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
    Ok(KeyframeIndex { duration_ms: v.duration_ms(), keyframes_ms, warning: None })
}

/// 剪切 `[in_ms, out_ms]`（播放域，内部按宁多勿少吸附）到 `dst`。
/// 返回 (文件字节数, 实际入点, 实际出点)——实际值已按关键帧吸附。
pub fn trim(src: &Path, in_ms: u64, out_ms: u64, dst: &Path) -> Result<(u64, u64, u64), String> {
    if in_ms >= out_ms {
        return Err("选段为空（入点不早于出点）".into());
    }
    let kf = scan_keyframes(src)?;
    let (in_m, out_m) = snap(&kf.keyframes_ms, kf.duration_ms, in_ms, out_ms);
    if out_m <= in_m {
        return Err("选段为空（吸附后没有可保留的内容）".into());
    }
    let mut src_mp4 = SrcMp4::open(src)?;
    // 实际入点以视频首保留关键帧为准（选段早于首个可见关键帧时被顶后），回传真实值
    src_mp4.write_trimmed(dst, in_m, out_m)
}

fn media_to_playback_ms(media_ts: u64, timescale: u32, elst_media_time: u64) -> u64 {
    media_ts
        .saturating_sub(elst_media_time)
        .saturating_mul(1000)
        / u64::from(timescale.max(1))
}

// ── 盒子遍历（纯内存，操作 moov 载荷）───────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct BoxRef<'a> {
    name: [u8; 4],
    payload: &'a [u8],
}

/// 遍历一段「容器载荷」里的兄弟盒子。只支持 32 位尺寸（MF 产物如此）；
/// size==1（64 位 largesize）在 moov 内部出现即报错——不硬解不猜。
fn iter_boxes(buf: &[u8]) -> Result<Vec<BoxRef<'_>>, String> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < buf.len() {
        if buf.len() - off < 8 {
            return Err(format!("盒子头越界（@{off}，余 {} 字节）", buf.len() - off));
        }
        let size = u32be(buf, off) as usize;
        let mut name = [0u8; 4];
        name.copy_from_slice(&buf[off + 4..off + 8]);
        if size == 1 {
            return Err(format!("盒子 {name:?} 用 64 位 largesize（moov 内部不支持）"));
        }
        if size < 8 {
            return Err(format!("盒子 {name:?} 尺寸非法（{size}）"));
        }
        let end = off + size;
        if end > buf.len() {
            return Err(format!("盒子 {name:?} 越出父容器（{end} > {}）", buf.len()));
        }
        out.push(BoxRef { name, payload: &buf[off + 8..end] });
        off = end;
    }
    Ok(out)
}

fn u32be(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
fn u64be(b: &[u8], off: usize) -> u64 {
    u64::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3], b[off + 4], b[off + 5], b[off + 6], b[off + 7]])
}
fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_be_bytes());
}
fn push_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_be_bytes());
}
fn wrap_box(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(payload.len() + 8);
    push_u32(&mut v, payload.len() as u32 + 8);
    v.extend_from_slice(name);
    v.extend_from_slice(payload);
    v
}
fn push_u32_at(v: &mut [u8], off: usize, x: u32) {
    v[off..off + 4].copy_from_slice(&x.to_be_bytes());
}
fn push_u64_at(v: &mut [u8], off: usize, x: u64) {
    v[off..off + 8].copy_from_slice(&x.to_be_bytes());
}

// ── 源文件解析 ──────────────────────────────────────────────────────────

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

impl SrcMp4 {
    fn open(path: &Path) -> Result<Self, String> {
        let mut f = std::fs::File::open(path).map_err(|e| format!("打开失败：{e}"))?;
        let top = top_level_boxes(&mut f)?;
        let mut load = |b: &TopBox| -> Result<Vec<u8>, String> {
            f.seek(SeekFrom::Start(b.payload_off)).map_err(io_err)?;
            let mut v = vec![0u8; b.payload_len as usize];
            f.read_exact(&mut v).map_err(io_err)?;
            Ok(v)
        };
        let ftyp_box = top.iter().find(|b| b.name == *b"ftyp").ok_or("不是 MP4（缺 ftyp）")?;
        let moov_box = top
            .iter()
            .find(|b| b.name == *b"moov")
            .ok_or("不是 MP4（缺 moov；分片/流式录制不支持剪切）")?;
        let ftyp = load(ftyp_box)?;
        let moov = load(moov_box)?;
        let mut tracks = Vec::new();
        for child in iter_boxes(&moov)? {
            if child.name == *b"trak" {
                tracks.push(parse_trak(child.payload)?);
            }
        }
        if tracks.is_empty() {
            return Err("moov 里没有轨道".into());
        }
        Ok(Self { path: path.to_path_buf(), ftyp, moov, tracks })
    }

    /// 视频轨 = hdlr 为 vide 的第一条；兜底第一条。
    fn video(&self) -> Option<&SrcTrack> {
        self.tracks.iter().find(|t| t.is_video).or_else(|| self.tracks.first())
    }

    /// 重组并写出 `[in_ms, out_ms]`（播放域，调用方已吸附）。
    /// 返回 (文件字节数, 实际入点, 实际出点)——实际入点 = 视频首保留关键帧的播放
    /// 时刻，选段早于首个可见关键帧时会被顶后，与名义吸附值可能不同。
    fn write_trimmed(&mut self, dst: &Path, in_ms: u64, out_ms: u64) -> Result<(u64, u64, u64), String> {
        // 视频轨先解析：首保留样本必须直接落在**可见**关键帧样本上（吸附点=切开点）。
        // 不能用 in_ms 算术反推 media 切点：①播放域毫秒换算有舍入（ts=90000 时
        // 必现），切点会落回关键帧前一个样本；②elst 片头预留段（播放 <0）里的
        // 关键帧不可见、兜底 0 时算术点掉进预留段——两种都让输出以非关键帧开头，
        // 花屏到下一 GOP。
        let video_ti = self.tracks.iter().position(|t| t.is_video);
        let mut eff_in = in_ms;
        let mut plans: Vec<Plan> = Vec::new();
        if let Some(vi) = video_ti {
            let t = &self.tracks[vi];
            let ts = u64::from(t.timescale.max(1));
            // 可见关键帧（播放 ≥ 0）：（播放毫秒, 1-based 样本号）
            let visible: Vec<(u64, u32)> = t
                .samples
                .iter()
                .enumerate()
                .filter(|(_, s)| s.is_sync && s.media_time >= t.elst_media_time)
                .map(|(i, s)| ((s.media_time - t.elst_media_time) * 1000 / ts, i as u32 + 1))
                .collect();
            let Some(&(pb, first)) = visible
                .iter()
                .rev()
                .find(|(pb, _)| *pb <= in_ms)
                .or_else(|| visible.first())
            else {
                return Err("视频轨没有可见关键帧（无法按关键帧对齐剪切）".into());
            };
            eff_in = pb;
            let end_ts = (out_ms * ts + ts - 1) / ts + t.elst_media_time;
            let n = t.samples.len() as u32;
            let end = (first..=n)
                .find(|&i| t.samples[(i - 1) as usize].media_time >= end_ts)
                .unwrap_or(n + 1);
            if end > first {
                plans.push(Plan { ti: vi, first, end });
            }
        }
        if video_ti.is_some() && plans.is_empty() {
            return Err("选段为空（视频轨不落在选段内）".into());
        }
        // 其余轨（音频等）：按视频的**实际**入点同点切开——视频吸附顶后时音频
        // 跟着移，重组后两条轨从同一播放时刻起播，音画不漂移。
        // 切点换算用 ceil：media ≥ ceil(播放ms × ts / 1000) 才是「播放 ≥ 切点」的
        // 精确整数条件，floor 会把切点前一两个样本也带上。
        for (ti, t) in self.tracks.iter().enumerate() {
            if t.is_video {
                continue;
            }
            let ts = u64::from(t.timescale.max(1));
            let start_ts = (eff_in * ts + ts - 1) / ts + t.elst_media_time;
            let end_ts = (out_ms * ts + ts - 1) / ts + t.elst_media_time;
            let n = t.samples.len() as u32;
            let Some(first) = (1..=n).find(|&i| t.samples[(i - 1) as usize].media_time >= start_ts)
            else {
                continue; // 整段落在轨外：跳过该轨
            };
            let end = (first..=n)
                .find(|&i| t.samples[(i - 1) as usize].media_time >= end_ts)
                .unwrap_or(n + 1);
            if end > first {
                plans.push(Plan { ti, first, end });
            }
        }
        if plans.is_empty() {
            return Err("选段为空（没有轨道落在选段内）".into());
        }
        plans.sort_by_key(|p| p.ti); // build_moov 按 trak 出现序配对

        // ── 布局：ftyp | mdat(头 + 各轨样本串联，轨序 = moov 轨序) | moov ──
        let ftyp_len = self.ftyp.len() as u64 + 8;
        let mdat_header = 8u64;
        let mut chunk_offsets = Vec::new();
        let mut off = ftyp_len + mdat_header;
        for p in &plans {
            let t = &self.tracks[p.ti];
            let len: u64 = (p.first..p.end)
                .map(|i| u64::from(t.samples[(i - 1) as usize].size))
                .sum();
            chunk_offsets.push(off);
            off += len;
        }
        let mdat_payload = off - (ftyp_len + mdat_header);
        if off > u32::MAX as u64 {
            return Err("裁剪产物超过 4GB，暂不支持（分段导出另案）".into());
        }

        // ── 写出 ──
        use std::io::Write;
        let mut out = std::fs::File::create(dst).map_err(|e| format!("创建文件失败：{e}"))?;
        out.write_all(&wrap_box(b"ftyp", &self.ftyp)).map_err(io_err)?;
        let mut mdat_head = Vec::new();
        push_u32(&mut mdat_head, (mdat_header + mdat_payload) as u32);
        mdat_head.extend_from_slice(b"mdat");
        out.write_all(&mdat_head).map_err(io_err)?;
        let mut src = std::fs::File::open(&self.path).map_err(|e| format!("重开源失败：{e}"))?;
        for p in &plans {
            let t = &self.tracks[p.ti];
            for i in p.first..p.end {
                let s = &t.samples[(i - 1) as usize];
                src.seek(SeekFrom::Start(s.file_offset)).map_err(io_err)?;
                let n = std::io::copy(&mut (&mut src).take(u64::from(s.size)), &mut out).map_err(io_err)?;
                if n != u64::from(s.size) {
                    return Err(format!("样本 {i} 读取不完整（{n}/{}）", s.size));
                }
            }
        }
        let moov = self.build_moov(&plans, &chunk_offsets)?;
        out.write_all(&moov).map_err(io_err)?;
        out.flush().map_err(io_err)?;
        Ok((off + moov.len() as u64, eff_in, out_ms))
    }

    /// 从原 moov 重组：mvhd/tkhd/mdhd 时长 patch、四表重建；stsd / edts / 其余层级原样。
    fn build_moov(&self, plans: &[Plan], chunk_offsets: &[u64]) -> Result<Vec<u8>, String> {
        let children = iter_boxes(&self.moov)?;
        let movie_ts = children
            .iter()
            .find(|b| b.name == *b"mvhd")
            .map(|b| mvhd_timescale(b.payload))
            .unwrap_or(1000);
        // 先算各轨新时长（movie 域），mvhd 取最大
        let mut durs = Vec::new();
        for p in plans {
            let t = &self.tracks[p.ti];
            let first = &t.samples[(p.first - 1) as usize];
            let last = &t.samples[(p.end - 2) as usize];
            let media_dur = last.media_time + u64::from(last.duration) - first.media_time;
            durs.push((media_dur, media_dur * u64::from(movie_ts) / u64::from(t.timescale.max(1))));
        }
        let movie_dur = durs.iter().map(|(_, m)| *m).max().unwrap_or(0);

        let mut body: Vec<u8> = Vec::new();
        let mut trak_i = 0usize;
        for child in children {
            if child.name == *b"trak" {
                // 计划按源轨号配对（有的轨可能整段落在选段外而没有计划）
                if let Some(pi) = plans.iter().position(|p| p.ti == trak_i) {
                    let p = &plans[pi];
                    body.extend_from_slice(&rewrite_trak(
                        child.payload,
                        &self.tracks[p.ti],
                        p,
                        durs[pi].0,
                        durs[pi].1,
                        chunk_offsets[pi],
                    )?);
                }
                trak_i += 1;
            } else if child.name == *b"mvhd" {
                body.extend_from_slice(&patch_duration_box(child.name, child.payload, movie_dur)?);
            } else {
                body.extend_from_slice(&wrap_box(&child.name, child.payload));
            }
        }
        Ok(wrap_box(b"moov", &body))
    }
}

// ── 顶层盒子遍历（文件头，支持 64 位 largesize 的 mdat）──────────────────

struct TopBox {
    name: [u8; 4],
    payload_off: u64,
    payload_len: u64,
}

fn top_level_boxes(f: &mut std::fs::File) -> Result<Vec<TopBox>, String> {
    f.seek(SeekFrom::Start(0)).map_err(io_err)?;
    let mut out = Vec::new();
    let mut off = 0u64;
    let size = f.metadata().map_err(io_err)?.len();
    while off < size {
        let mut head = [0u8; 8];
        if f.read_exact(&mut head).is_err() {
            break;
        }
        let size32 = u32be(&head, 0);
        let name = [head[4], head[5], head[6], head[7]];
        let (header_len, payload_len) = if size32 == 1 {
            let mut big = [0u8; 8];
            f.read_exact(&mut big).map_err(io_err)?;
            let s = u64be(&big, 0);
            if s < 16 {
                return Err(format!("盒子 {name:?} largesize 非法（{s}）"));
            }
            (16u64, s - 16)
        } else if size32 == 0 {
            (8u64, size - off - 8)
        } else {
            (8u64, u64::from(size32) - 8)
        };
        out.push(TopBox { name, payload_off: off + header_len, payload_len });
        off += header_len + payload_len;
        f.seek(SeekFrom::Start(off)).map_err(io_err)?;
    }
    Ok(out)
}

fn io_err(e: std::io::Error) -> String {
    format!("IO：{e}")
}

// ── trak 解析 ───────────────────────────────────────────────────────────

fn parse_trak(trak: &[u8]) -> Result<SrcTrack, String> {
    let (mut timescale, mut elst_media_time) = (0u32, 0u64);
    let (mut edts, mut stsd) = (None, Vec::new());
    let (mut stts, mut stss) = (Vec::new(), Vec::new());
    let (mut stsc, mut chunk_offsets) = (Vec::new(), Vec::new());
    let (mut stsz_uniform, mut stsz_sizes) = (0u32, Vec::new());
    let (mut handler, mut desc_index) = (*b"????", 1u32);

    for child in iter_boxes(trak)? {
        match &child.name {
            b"edts" => {
                for e in iter_boxes(child.payload)? {
                    if e.name == *b"elst" {
                        let p = e.payload;
                        // ISO 14496-12 §8.6.6：entry 内 segment_duration 在前、media_time
                        // 在后——v0 media_time@12、v1 media_time@16（写成 @8 是读到了时长）
                        if p.len() >= 16 {
                            let mt = if p[0] == 1 {
                                if p.len() < 24 {
                                    return Err("elst v1 条目不完整".into());
                                }
                                u64be(p, 16)
                            } else {
                                u64::from(u32be(p, 12))
                            };
                            if mt == u64::MAX || mt == u64::from(u32::MAX) {
                                return Err("elst 空编辑（media_time=-1）暂不支持剪切".into());
                            }
                            let rate_off = if p[0] == 1 { 24 } else { 16 };
                            if p.len() >= rate_off + 4 && u32be(p, rate_off) != 0x0001_0000 {
                                return Err("elst 播放速率 ≠ 1.0 暂不支持剪切".into());
                            }
                            elst_media_time = mt;
                        }
                    }
                }
                edts = Some(child.payload.to_vec());
            }
            b"mdia" => {
                for m in iter_boxes(child.payload)? {
                    match &m.name {
                        b"mdhd" => {
                            let p = m.payload;
                            if p[0] == 1 {
                                timescale = u32be(p, 20);
                            } else {
                                timescale = u32be(p, 12);
                            }
                        }
                        b"hdlr" => {
                            // ver/flags(4) + pre_defined(4) + handler_type(4)
                            if m.payload.len() >= 12 {
                                handler.copy_from_slice(&m.payload[8..12]);
                            }
                        }
                        b"minf" => parse_minf(
                            m.payload,
                            &mut stsd,
                            &mut stts,
                            &mut stss,
                            &mut stsc,
                            &mut stsz_uniform,
                            &mut stsz_sizes,
                            &mut chunk_offsets,
                        )?,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if timescale == 0 {
        return Err("轨道 timescale 为 0".into());
    }
    let count: u32 = if stsz_uniform != 0 {
        stts.iter().map(|(c, _)| *c).sum()
    } else {
        stsz_sizes.len() as u32
    };
    if count == 0 {
        return Err(format!(
            "轨道没有样本（handler={} stts={} stsz_uni={stsz_uniform} stsz_n={} stsc={} stco={})",
            String::from_utf8_lossy(&handler), stts.len(), stsz_sizes.len(), stsc.len(), chunk_offsets.len()
        ));
    }
    if chunk_offsets.is_empty() {
        return Err("轨道没有 chunk 偏移（stco/co64 缺失）".into());
    }
    // chunk → (offset, 样本数)：stsc 的 first_chunk 单调，取「最后一个 first_chunk ≤ ci」的 entry
    let mut per_chunk: Vec<(u64, u32)> = Vec::with_capacity(chunk_offsets.len());
    for ci in 1..=chunk_offsets.len() as u32 {
        let mut active = stsc[0];
        for e in &stsc {
            if e.0 <= ci {
                active = *e;
            } else {
                break;
            }
        }
        if active.2 != 0 {
            desc_index = active.2;
        }
        per_chunk.push((chunk_offsets[(ci - 1) as usize], active.1));
    }
    // 展开：时间累计（stts）× 尺寸（stsz）× 偏移（逐 chunk 顺序）
    let mut samples = Vec::with_capacity(count as usize);
    let mut t = 0u64;
    let mut si = 0usize;
    let mut si_left = stts.first().map_or(0, |(c, _)| *c);
    let mut delta = stts.first().map_or(0, |(_, d)| *d);
    let mut idx1 = 1u32;
    'chunks: for (coff, spc) in per_chunk {
        let mut file_off = coff;
        for _ in 0..spc {
            if idx1 > count {
                break 'chunks;
            }
            while si_left == 0 && si + 1 < stts.len() {
                si += 1;
                si_left = stts[si].0;
                delta = stts[si].1;
            }
            let size = if stsz_uniform != 0 { stsz_uniform } else { stsz_sizes[(idx1 - 1) as usize] };
            samples.push(Sample {
                media_time: t,
                duration: delta,
                size,
                file_offset: file_off,
                is_sync: stss.is_empty() || stss.binary_search(&idx1).is_ok(), // 无 stss = 全部同步帧
            });
            t += u64::from(delta);
            file_off += u64::from(size);
            si_left = si_left.saturating_sub(1);
            idx1 += 1;
        }
    }
    if samples.len() < count as usize {
        return Err(format!("样本表不一致（stts/stsz/stco 推出 {} < {count}）", samples.len()));
    }
    Ok(SrcTrack {
        timescale,
        elst_media_time,
        has_stss: !stss.is_empty(),
        edts,
        stsd,
        samples,
        desc_index,
        is_video: &handler == b"vide",
    })
}

#[allow(clippy::too_many_arguments)]
fn parse_minf(
    minf: &[u8],
    stsd: &mut Vec<u8>,
    stts: &mut Vec<(u32, u32)>,
    stss: &mut Vec<u32>,
    stsc: &mut Vec<(u32, u32, u32)>,
    stsz_uniform: &mut u32,
    stsz_sizes: &mut Vec<u32>,
    chunk_offsets: &mut Vec<u64>,
) -> Result<(), String> {
    for m in iter_boxes(minf)? {
        if m.name != *b"stbl" {
            continue;
        }
        for s in iter_boxes(m.payload)? {
            match &s.name {
                b"stsd" => *stsd = s.payload.to_vec(),
                b"stts" => {
                    let p = s.payload;
                    let n = u32be(p, 4) as usize;
                    for i in 0..n {
                        let o = 8 + i * 8;
                        stts.push((u32be(p, o), u32be(p, o + 4)));
                    }
                }
                b"stss" => {
                    let p = s.payload;
                    let n = u32be(p, 4) as usize;
                    for i in 0..n {
                        stss.push(u32be(p, 8 + i * 4));
                    }
                }
                b"stsc" => {
                    let p = s.payload;
                    let n = u32be(p, 4) as usize;
                    for i in 0..n {
                        let o = 8 + i * 12;
                        stsc.push((u32be(p, o), u32be(p, o + 4), u32be(p, o + 8)));
                    }
                }
                b"stsz" => {
                    let p = s.payload;
                    *stsz_uniform = u32be(p, 4);
                    let n = u32be(p, 8) as usize;
                    for i in 0..n {
                        stsz_sizes.push(u32be(p, 12 + i * 4));
                    }
                }
                b"stco" => {
                    let p = s.payload;
                    let n = u32be(p, 4) as usize;
                    for i in 0..n {
                        chunk_offsets.push(u64::from(u32be(p, 8 + i * 4)));
                    }
                }
                b"co64" => {
                    let p = s.payload;
                    let n = u32be(p, 4) as usize;
                    for i in 0..n {
                        chunk_offsets.push(u64be(p, 8 + i * 8));
                    }
                }
                b"ctts" => {
                    // 合成时间偏移（B 帧重排）。录屏编码已关 B 帧，偏移应全 0——
                    // 全 0 则重组后直接丢弃这张表；非 0 是别的来源文件，逐样本
                    // 偏移的裁剪语义未验证，拒绝不硬写。
                    let p = s.payload;
                    let n = u32be(p, 4) as usize;
                    let wide = p[0] == 1;
                    for i in 0..n {
                        let o = 8 + i * if wide { 12 } else { 8 };
                        let off = if wide { u64be(p, o + 4) } else { u64::from(u32be(p, o + 4)) };
                        if off != 0 {
                            return Err("含 B 帧（ctts 偏移非 0）——裁剪暂不支持该文件".into());
                        }
                    }
                }
                b"sdtp" => {
                    return Err("stbl 里有 sdtp（逐样本标志）——裁剪需按样本过滤，暂不支持该文件".into());
                }
                other => {
                    return Err(format!("stbl 里有未知盒子 {other:?}——为防写出坏文件已中止"));
                }
            }
        }
    }
    Ok(())
}

// ── trak 重组 ───────────────────────────────────────────────────────────

/// 重组单条 trak：tkhd/mdhd 时长 patch、elst 归零重指（有才写）、stbl 四表重建 + stsd 原样。
fn rewrite_trak(
    trak: &[u8],
    t: &SrcTrack,
    p: &Plan,
    media_dur: u64,
    movie_dur: u64,
    chunk_offset: u64,
) -> Result<Vec<u8>, String> {
    let count = p.end - p.first;
    // stts runs
    let mut stts: Vec<(u32, u32)> = Vec::new();
    for i in p.first..p.end {
        let d = t.samples[(i - 1) as usize].duration;
        match stts.last_mut() {
            Some((c, dd)) if *dd == d => *c += 1,
            _ => stts.push((1, d)),
        }
    }
    // stss：源有才写；保留段内必含关键帧（入点吸附保证），防空集合
    let stss: Option<Vec<u32>> = if t.has_stss {
        // 输出序号 = 样本在保留段里的位次（i − first + 1），不是「第几个 sync」
        let kept: Vec<u32> = (p.first..p.end)
            .filter(|&i| t.samples[(i - 1) as usize].is_sync)
            .map(|i| i - p.first + 1)
            .collect();
        if kept.is_empty() {
            return Err("保留段内没有关键帧（吸附逻辑失效，拒绝写出）".into());
        }
        Some(kept)
    } else {
        None
    };
    let sizes: Vec<u32> = (p.first..p.end).map(|i| t.samples[(i - 1) as usize].size).collect();
    let uniform = if sizes.iter().all(|&s| s == sizes[0]) { sizes[0] } else { 0 };

    let mut body: Vec<u8> = Vec::new();
    for child in iter_boxes(trak)? {
        match &child.name {
            b"tkhd" => body.extend_from_slice(&patch_duration_box(*b"tkhd", child.payload, movie_dur)?),
            b"edts" => {
                // 🔴 输出样本 media 时间从 0 续排（stts 是纯差值表，首样本恒为 media 0），
                // elst 的 media_time 必须归零：播放 = media − elst_media_time，不归零
                // 保留段会整体平移（掐头后旧值还会让播放器去跳「已删样本」）。
                // segment_duration 同步改指新 media 时长，让这条 edit 语义完整。
                if t.edts.is_some() {
                    let mut inner: Vec<u8> = Vec::new();
                    for el in iter_boxes(child.payload)? {
                        if el.name == *b"elst" && el.payload.len() >= 16 {
                            let mut pl = el.payload.to_vec();
                            if pl[0] == 1 {
                                if pl.len() >= 24 {
                                    push_u64_at(&mut pl, 8, media_dur); // segment_duration
                                    push_u64_at(&mut pl, 16, 0); // media_time
                                }
                            } else {
                                push_u32_at(&mut pl, 8, media_dur.min(u32::MAX as u64) as u32);
                                push_u32_at(&mut pl, 12, 0);
                            }
                            inner.extend_from_slice(&wrap_box(b"elst", &pl));
                        } else {
                            inner.extend_from_slice(&wrap_box(&el.name, el.payload));
                        }
                    }
                    body.extend_from_slice(&wrap_box(b"edts", &inner));
                }
            }
            b"mdia" => {
                let mut mbody: Vec<u8> = Vec::new();
                for m in iter_boxes(child.payload)? {
                    match &m.name {
                        b"mdhd" => mbody.extend_from_slice(&patch_mdhd(m.payload, media_dur)?),
                        b"minf" => {
                            let mut minf_body: Vec<u8> = Vec::new();
                            for mm in iter_boxes(m.payload)? {
                                if mm.name != *b"stbl" {
                                    minf_body.extend_from_slice(&wrap_box(&mm.name, mm.payload));
                                    continue;
                                }
                                let mut stbl: Vec<u8> = Vec::new();
                                for x in iter_boxes(mm.payload)? {
                                    match &x.name {
                                        b"stsd" => stbl.extend_from_slice(&wrap_box(b"stsd", &t.stsd)),
                                        b"stts" => {
                                            let mut pl = Vec::new();
                                            push_u32(&mut pl, 0); // version/flags
                                            push_u32(&mut pl, stts.len() as u32);
                                            for (c, d) in &stts {
                                                push_u32(&mut pl, *c);
                                                push_u32(&mut pl, *d);
                                            }
                                            stbl.extend_from_slice(&wrap_box(b"stts", &pl));
                                        }
                                        b"stss" => {
                                            if let Some(nums) = &stss {
                                                let mut pl = Vec::new();
                                                push_u32(&mut pl, 0); // version/flags
                                                push_u32(&mut pl, nums.len() as u32);
                                                for &n in nums {
                                                    push_u32(&mut pl, n);
                                                }
                                                stbl.extend_from_slice(&wrap_box(b"stss", &pl));
                                            }
                                        }
                                        b"stsc" => {
                                            let mut pl = Vec::new();
                                            push_u32(&mut pl, 0); // version/flags
                                            push_u32(&mut pl, 1); // entry_count
                                            push_u32(&mut pl, 1); // first_chunk
                                            push_u32(&mut pl, count); // samples_per_chunk
                                            push_u32(&mut pl, t.desc_index.max(1));
                                            stbl.extend_from_slice(&wrap_box(b"stsc", &pl));
                                        }
                                        b"stsz" => {
                                            let mut pl = Vec::new();
                                            push_u32(&mut pl, 0); // version/flags
                                            push_u32(&mut pl, uniform);
                                            push_u32(&mut pl, count);
                                            if uniform == 0 {
                                                for &s in &sizes {
                                                    push_u32(&mut pl, s);
                                                }
                                            }
                                            stbl.extend_from_slice(&wrap_box(b"stsz", &pl));
                                        }
                                        b"stco" | b"co64" => {
                                            let mut pl = Vec::new();
                                            push_u32(&mut pl, 0); // version/flags
                                            push_u32(&mut pl, 1); // entry_count
                                            push_u32(&mut pl, chunk_offset as u32);
                                            stbl.extend_from_slice(&wrap_box(b"stco", &pl));
                                        }
                                        b"ctts" => {
                                            // 全 0 偏移已在解析期验证——解码序=显示序，直接丢弃
                                        }
                                        other => {
                                            return Err(format!("stbl 未知盒子 {other:?}（解析期应已拦）"));
                                        }
                                    }
                                }
                                minf_body.extend_from_slice(&wrap_box(b"stbl", &stbl));
                            }
                            mbody.extend_from_slice(&wrap_box(b"minf", &minf_body));
                        }
                        _ => mbody.extend_from_slice(&wrap_box(&m.name, m.payload)),
                    }
                }
                body.extend_from_slice(&wrap_box(b"mdia", &mbody));
            }
            _ => body.extend_from_slice(&wrap_box(&child.name, child.payload)),
        }
    }
    Ok(wrap_box(b"trak", &body))
}

// ── 时长 patch ──────────────────────────────────────────────────────────

/// tkhd/mvhd：按版本 patch duration 字段（时长单位 movie 域）。
/// v0：tkhd duration@20、mvhd@16；v1 时间字段 8 字节 → tkhd@28、mvhd@24。
fn patch_duration_box(name: [u8; 4], p: &[u8], duration_ts: u64) -> Result<Vec<u8>, String> {
    let mut p = p.to_vec();
    let mut dur_off = match &name {
        b"mvhd" => 16usize,
        b"tkhd" => 20usize,
        _ => return Err(format!("patch_duration_box 不支持 {name:?}")),
    };
    if p[0] == 1 {
        dur_off += 8;
        if p.len() >= dur_off + 8 {
            push_u64_at(&mut p, dur_off, duration_ts);
        }
    } else if p.len() >= dur_off + 4 {
        push_u32_at(&mut p, dur_off, duration_ts.min(u32::MAX as u64) as u32);
    }
    Ok(wrap_box(&name, &p))
}

/// mdhd：v0 timescale@12 duration@16；v1 timescale@20 duration@24。
fn patch_mdhd(p: &[u8], duration_ts: u64) -> Result<Vec<u8>, String> {
    let mut p = p.to_vec();
    if p[0] == 1 {
        if p.len() >= 24 + 8 {
            push_u64_at(&mut p, 24, duration_ts);
        }
    } else if p.len() >= 16 + 4 {
        push_u32_at(&mut p, 16, duration_ts.min(u32::MAX as u64) as u32);
    }
    Ok(wrap_box(b"mdhd", &p))
}

fn mvhd_timescale(p: &[u8]) -> u32 {
    if p[0] == 1 {
        u32be(p, 20)
    } else {
        u32be(p, 12)
    }
}

// ── 测试：手造 MP4 夹具往返（无环境依赖，纯字节级）───────────────────────
//
    // 夹具：视频 ts=1000、30 样本×33ms（sync=第 1/11/21 样本，media 0/330/660）、
    // 尺寸 100+i；音频 ts=1000、90 样本×10ms、尺寸 40+i。2+2 块交错布局。
    // 样本字节 = 全 i 的重复（字节级等值断言用）。可选 elst（掐头重排验证）、
    // all_sync = 不写视频 stss（全同步轨路径）。
    #[cfg(test)]
    mod tests {
    use super::*;

    fn fixture(hevc: bool, base_media_ms: u64, with_elst: bool, all_sync: bool) -> Vec<u8> {
        let e = base_media_ms;
        let vsize = |i: u32| 100 + i;
        let asize = |i: u32| 40 + i;
        let vsample = |i: u32| vec![i as u8; vsize(i) as usize];
        let asample = |i: u32| vec![(i as u8).wrapping_add(0x80); asize(i) as usize];

        // mdat 载荷：vid1(1..=16) aud1(1..=45) vid2(17..=30) aud2(46..=90)
        let mut mdat: Vec<u8> = Vec::new();
        let v1: Vec<u32> = (1..=16).collect();
        let a1: Vec<u32> = (1..=45).collect();
        let v2: Vec<u32> = (17..=30).collect();
        let a2: Vec<u32> = (46..=90).collect();
        let mut off = 0u64;
        let mut offs = [0u64; 4];
        for (k, ids) in [&v1, &a1, &v2, &a2].into_iter().enumerate() {
            offs[k] = off;
            for &i in ids {
                let b = if k % 2 == 0 { vsample(i) } else { asample(i) };
                off += b.len() as u64;
                mdat.extend_from_slice(&b);
            }
        }
        let (v1_off, a1_off, v2_off, a2_off) = (offs[0], offs[1], offs[2], offs[3]);

        let ftyp_payload = {
            let mut p = Vec::new();
            p.extend_from_slice(b"isom");
            push_u32(&mut p, 512);
            p.extend_from_slice(b"isom");
            p
        };
        let ftyp = wrap_box(b"ftyp", &ftyp_payload);
        let data_start = ftyp.len() as u64 + 8;
        let c1 = data_start + v1_off;
        let c2 = data_start + a1_off;
        let c3 = data_start + v2_off;
        let c4 = data_start + a2_off;

        let (video_inner, audio_inner) = if hevc { (*b"hev1", *b"mp4a") } else { (*b"avc1", *b"mp4a") };
        let stsd = |inner: &[u8; 4]| {
            let mut p = Vec::new();
            push_u32(&mut p, 0); // version/flags
            push_u32(&mut p, 1); // entry_count
            p.extend_from_slice(&wrap_box(inner, &vec![7u8; 48]));
            wrap_box(b"stsd", &p)
        };
        let stts = |entries: &[(u32, u32)]| {
            let mut p = Vec::new();
            push_u32(&mut p, 0); // version/flags
            push_u32(&mut p, entries.len() as u32);
            for (c, d) in entries {
                push_u32(&mut p, *c);
                push_u32(&mut p, *d);
            }
            wrap_box(b"stts", &p)
        };
        let stss = |nums: &[u32]| {
            let mut p = Vec::new();
            push_u32(&mut p, 0);
            push_u32(&mut p, nums.len() as u32);
            for &n in nums {
                push_u32(&mut p, n);
            }
            wrap_box(b"stss", &p)
        };
        let stsc = |entries: &[(u32, u32, u32)]| {
            let mut p = Vec::new();
            push_u32(&mut p, 0);
            push_u32(&mut p, entries.len() as u32);
            for (a, b, c) in entries {
                push_u32(&mut p, *a);
                push_u32(&mut p, *b);
                push_u32(&mut p, *c);
            }
            wrap_box(b"stsc", &p)
        };
        let stsz = |sizes: &[u32]| {
            let mut p = Vec::new();
            push_u32(&mut p, 0);
            push_u32(&mut p, 0); // uniform=0 → 逐条
            push_u32(&mut p, sizes.len() as u32);
            for &s in sizes {
                push_u32(&mut p, s);
            }
            wrap_box(b"stsz", &p)
        };
        let stco = |offs: &[u64]| {
            let mut p = Vec::new();
            push_u32(&mut p, 0);
            push_u32(&mut p, offs.len() as u32);
            for &o in offs {
                push_u32(&mut p, o as u32);
            }
            wrap_box(b"stco", &p)
        };
        let mdhd = |dur: u64| {
            let mut p = vec![0u8; 24];
            push_u32_at(&mut p, 12, 1000); // timescale @12
            push_u32_at(&mut p, 16, dur as u32);
            wrap_box(b"mdhd", &p)
        };
        let hdlr = |kind: &[u8; 4]| {
            let mut p = vec![0u8; 12];
            p[8..12].copy_from_slice(kind);
            wrap_box(b"hdlr", &p)
        };
        let tkhd = |dur: u64| {
            let mut p = vec![0u8; 84];
            push_u32_at(&mut p, 20, dur as u32);
            wrap_box(b"tkhd", &p)
        };
        let elst_box = |media_time: u64, seg_dur: u64| {
            let mut p = Vec::new();
            push_u32(&mut p, 0); // version/flags (v0)
            push_u32(&mut p, 1); // entry_count
            push_u32(&mut p, seg_dur as u32); // segment_duration 在前（ISO 14496-12 §8.6.6）
            push_u32(&mut p, media_time as u32); // media_time
            push_u32(&mut p, 0x0001_0000); // rate 1.0
            wrap_box(b"edts", &wrap_box(b"elst", &p))
        };

        let v_dur = 30 * 33; // 990
        let a_dur = 90 * 10; // 900
        let video_track = {
            let mut stbl = stsd(&video_inner);
            stbl.extend_from_slice(&stts(&[(30, 33)]));
            if !all_sync {
                stbl.extend_from_slice(&stss(&[1, 11, 21]));
            }
            stbl.extend_from_slice(&stsc(&[(1, 16, 1), (2, 45, 1), (3, 14, 1), (4, 45, 1)]));
            stbl.extend_from_slice(&stsz(&(1..=30).map(vsize).collect::<Vec<_>>()));
            stbl.extend_from_slice(&stco(&[c1, c3]));
            let mut minf = wrap_box(b"vmhd", &[]);
            minf.extend_from_slice(&wrap_box(b"stbl", &stbl));
            let mut mdia = mdhd(v_dur);
            mdia.extend_from_slice(&hdlr(b"vide"));
            mdia.extend_from_slice(&wrap_box(b"minf", &minf));
            let mut trak = tkhd(v_dur);
            if with_elst {
                trak.extend_from_slice(&elst_box(e, v_dur));
            }
            trak.extend_from_slice(&wrap_box(b"mdia", &mdia));
            wrap_box(b"trak", &trak)
        };
        let audio_track = {
            let mut stbl = stsd(&audio_inner);
            stbl.extend_from_slice(&stts(&[(90, 10)]));
            stbl.extend_from_slice(&stsc(&[(1, 45, 1), (2, 45, 1)]));
            stbl.extend_from_slice(&stsz(&(1..=90).map(asize).collect::<Vec<_>>()));
            stbl.extend_from_slice(&stco(&[c2, c4]));
            let mut minf = wrap_box(b"smhd", &[]);
            minf.extend_from_slice(&wrap_box(b"stbl", &stbl));
            let mut mdia = mdhd(a_dur);
            mdia.extend_from_slice(&hdlr(b"soun"));
            mdia.extend_from_slice(&wrap_box(b"minf", &minf));
            let mut trak = tkhd(a_dur);
            trak.extend_from_slice(&wrap_box(b"mdia", &mdia));
            wrap_box(b"trak", &trak)
        };
        let mut mvhd = vec![0u8; 100];
        push_u32_at(&mut mvhd, 12, 1000); // movie timescale @12
        push_u32_at(&mut mvhd, 16, v_dur as u32);
        let mut moov = wrap_box(b"mvhd", &mvhd);
        moov.extend_from_slice(&video_track);
        moov.extend_from_slice(&audio_track);

        let mut file = ftyp;
        file.extend_from_slice(&wrap_box(b"mdat", &mdat));
        file.extend_from_slice(&wrap_box(b"moov", &moov));
        file
    }

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("pastepanda_trim_tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn sample_bytes(path: &Path, track: usize, idx1: u32) -> Vec<u8> {
        let src = SrcMp4::open(path).unwrap();
        let s = &src.tracks[track].samples[(idx1 - 1) as usize];
        let mut f = std::fs::File::open(path).unwrap();
        f.seek(SeekFrom::Start(s.file_offset)).unwrap();
        let mut buf = vec![0u8; s.size as usize];
        f.read_exact(&mut buf).unwrap();
        buf
    }



    #[test]
    fn 吸附_宁多勿少与边界() {
        let kf = [0u64, 330, 660];
        assert_eq!(snap(&kf, 990, 100, 500), (0, 660));
        assert_eq!(snap(&kf, 990, 330, 660), (330, 660));
        assert_eq!(snap(&kf, 990, 700, 900), (660, 990), "出点后无关键帧吸到末尾");
        assert_eq!(snap(&kf, 990, 500, 100), (0, 660), "反向输入先归一，出点仍向上吸");
        assert_eq!(snap(&kf, 990, 2000, 2500), (660, 990), "越界钳到时长");
        assert_eq!(snap(&[], 990, 100, 500), (100, 500), "无关键帧（音频）原值");
    }

    #[test]
    fn 裁剪_往返_H264无elst() {
        let f = write_tmp("trim_h264.mp4", &fixture(false, 0, false, false));
        let kf = scan_keyframes(&f).unwrap();
        assert_eq!(kf.duration_ms, 990);
        assert_eq!(kf.keyframes_ms, vec![0, 330, 660]);
        // 裁 100–500 → 吸附 0–660
        let dst = write_tmp("trim_h264_out.mp4", b"");
        let (bytes, in_m, out_m) = trim(&f, 100, 500, &dst).unwrap();
        assert_eq!((in_m, out_m), (0, 660));
        assert!(bytes > 0);
        let out = SrcMp4::open(&dst).unwrap();
        assert_eq!(out.tracks.len(), 2);
        let v = &out.tracks[0];
        let a = &out.tracks[1];
        assert_eq!(v.samples.len(), 20, "video：media<660 的 20 个样本");
        assert_eq!(a.samples.len(), 66, "audio：media<660 的 66 个样本");
        assert_eq!(v.samples[0].media_time, 0, "输出从 0 续排");
        let sync_times: Vec<u64> = v.samples.iter().filter(|s| s.is_sync).map(|s| s.media_time).collect();
        assert_eq!(sync_times, vec![0, 330], "stss 重建：保留段内 sync=第1、11样本");
        // 字节等值：输出第 5 个视频样本 == 源第 5 个；音频第 40 个同理
        assert_eq!(sample_bytes(&dst, 0, 5), sample_bytes(&f, 0, 5));
        assert_eq!(sample_bytes(&dst, 1, 40), sample_bytes(&f, 1, 40));
        // 输出再裁一次（尾段）：540–660 → 吸 330–660
        let dst2 = write_tmp("trim_h264_out2.mp4", b"");
        let (_, in2, out2) = trim(&dst, 540, 660, &dst2).unwrap();
        assert_eq!((in2, out2), (330, 660));
        let out2p = SrcMp4::open(&dst2).unwrap();
        assert_eq!(out2p.tracks[0].samples.len(), 10, "media 330..660 的 10 个样本");
        assert_eq!(out2p.tracks[0].samples[0].media_time, 0, "二次裁剪仍从 0 续排");
    }

    #[test]
    fn 裁剪_往返_HEVC与elst掐头() {
        // HEVC（stsd 原样拷贝路径）+ elst（media 基点 200，播放域与无 elst 同）
        let f = write_tmp("trim_hevc.mp4", &fixture(true, 200, true, false));
        let kf = scan_keyframes(&f).unwrap();
        // 规范语义：elst.media_time=200 = 跳过媒体前 200ms → 播放域 = media − 200
        assert_eq!(kf.duration_ms, 790, "播放域时长 = 媒体末 − 跳过段");
        assert_eq!(
            kf.keyframes_ms,
            vec![130, 460],
            "播放域关键帧（330/660−200）；media 0 的关键帧在片头预留段（播放 −200）不可见，不进索引"
        );
        // 裁 340–700 → 吸 130–790（入点吸 ≤340 的 130；出点后无关键帧吸到末尾）
        let dst = write_tmp("trim_hevc_out.mp4", b"");
        let (_, in_m, out_m) = trim(&f, 340, 700, &dst).unwrap();
        assert_eq!((in_m, out_m), (130, 790));
        let out = SrcMp4::open(&dst).unwrap();
        let v = &out.tracks[0];
        assert_eq!(v.samples.len(), 20, "video：media 330..990 的 20 个样本");
        assert_eq!(out.tracks[1].samples.len(), 66, "audio：media 130..790 的 66 个样本");
        // 🔴 elst 归零：输出样本 media 从 0 续排（stts 纯差值表），elst 不归零播放
        // 就会整体平移；归零后播放 0 点 = 首保留样本（源 media 330）
        assert_eq!(v.elst_media_time, 0, "elst.media_time 归零");
        assert_eq!(v.samples[0].media_time, 0, "输出 media 从 0 续排");
        let kf2 = scan_keyframes(&dst).unwrap();
        assert_eq!(kf2.keyframes_ms, vec![0, 330], "保留段内两个关键帧落在输出 0/330");
        assert_eq!(kf2.duration_ms, 660, "保留 660ms（330..990）");
        assert_eq!(sample_bytes(&dst, 0, 1), sample_bytes(&f, 0, 11), "输出首样本=源第11样本");
    }

    #[test]
    fn 裁剪_选段为空拒绝() {
        let f = write_tmp("trim_empty.mp4", &fixture(false, 0, false, false));
        let dst = write_tmp("trim_empty_out.mp4", b"");
        // 入点不早于出点 → 直接拒绝（吸附是「宁多勿少」放大，不抢救空选段）
        assert!(trim(&f, 500, 500, &dst).is_err());
        assert!(trim(&f, 600, 100, &dst).is_err(), "反向输入同样拒绝");
    }

    #[test]
    fn 裁剪_无stss全同步轨() {
        let f = write_tmp("trim_allsync.mp4", &fixture(false, 0, false, true));
        let kf = scan_keyframes(&f).unwrap();
        assert_eq!(kf.keyframes_ms.len(), 30, "无 stss = 每个样本都是关键帧");
        let dst = write_tmp("trim_allsync_out.mp4", b"");
        let (_, in_m, out_m) = trim(&f, 100, 500, &dst).unwrap();
        // 每帧都是关键帧 → 吸到最近的帧边界即可，不再放大到整 GOP
        assert_eq!((in_m, out_m), (99, 528));
        let out = SrcMp4::open(&dst).unwrap();
        let v = &out.tracks[0];
        assert_eq!(v.samples.len(), 13, "media 99..528 的 13 个样本");
        assert!(!v.has_stss, "源没有 stss，输出也不写");
        assert_eq!(v.samples[0].media_time, 0, "输出 media 从 0 续排");
    }
}
