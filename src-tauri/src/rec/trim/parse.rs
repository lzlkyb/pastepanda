//! 源 MP4 解析：顶层盒子定位、trak 表展开（stts / stss / stsc / stsz / stco / co64）。
//!
//! 解析期把一切都算成「样本 + 文件偏移」，重组侧只按保留区间重排、不再碰原表。
//! 边界（盒子数、样本数、moov 体积、偏移越界）在这里一次性挡住。

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::boxes::{io_err, iter_boxes, u32be, u64be};
use super::{Sample, SrcMp4, SrcTrack, MAX_BOX_COUNT, MAX_MOOV_BYTES, MAX_TRACK_SAMPLES};

fn table_entries(payload:&[u8], header:usize, entry_size:usize)->Result<usize,String> {
    if payload.len()<header {return Err("样本表头不完整".into());}
    let count=u32be(payload,4) as usize;
    if count>MAX_TRACK_SAMPLES as usize || count>(payload.len()-header)/entry_size {return Err("样本表条目越界".into());}
    Ok(count)
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
        if out.len()>=MAX_BOX_COUNT {return Err("顶层盒子数量超过安全上限".into());}
        let mut head = [0u8; 8];
        f.read_exact(&mut head).map_err(|_| "顶层盒子头不完整".to_string())?;
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
            if size32 < 8 { return Err("顶层盒子尺寸非法".into()); }
            (8u64, u64::from(size32) - 8)
        };
        if off.checked_add(header_len).and_then(|n|n.checked_add(payload_len)).is_none_or(|end|end>size) {return Err("顶层盒子越出文件边界".into());}
        out.push(TopBox { name, payload_off: off + header_len, payload_len });
        off += header_len + payload_len;
        f.seek(SeekFrom::Start(off)).map_err(io_err)?;
    }
    Ok(out)
}

impl SrcMp4 {
    pub(super) fn open(path: &Path) -> Result<Self, String> {
        let mut f = std::fs::File::open(path).map_err(|e| format!("打开失败：{e}"))?;
        let top = top_level_boxes(&mut f)?;
        let mut load = |b: &TopBox| -> Result<Vec<u8>, String> {
            f.seek(SeekFrom::Start(b.payload_off)).map_err(io_err)?;
            if b.payload_len > MAX_MOOV_BYTES { return Err("媒体索引超过64MB，无法安全读取".into()); }
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
                if tracks.len() >= 8 {return Err("轨道数量异常，无法安全读取".into());}
                let track=parse_trak(child.payload)?;
                let file_len=f.metadata().map_err(io_err)?.len();
                if track.samples.iter().any(|sample| sample.file_offset.checked_add(u64::from(sample.size)).is_none_or(|end| end>file_len)) {return Err("样本数据越出文件边界".into());}
                tracks.push(track);
            }
        }
        if tracks.is_empty() {
            return Err("moov 里没有轨道".into());
        }
        Ok(Self { path: path.to_path_buf(), ftyp, moov, tracks })
    }

    /// 视频轨 = hdlr 为 vide 的第一条；兜底第一条。
    pub(super) fn video(&self) -> Option<&SrcTrack> {
        self.tracks.iter().find(|t| t.is_video).or_else(|| self.tracks.first())
    }
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
                        if p.len()<8 || !matches!(p[0],0|1) {return Err("elst 头不完整或版本不支持".into());}
                        let required=if p[0]==1 {28}else{20};
                        if p.len()<required || u32be(p,4)!=1 {return Err("elst 条目不完整或不是单段编辑".into());}
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
                            if (p[0]==1 && mt>i64::MAX as u64) || (p[0]==0 && mt>i32::MAX as u64) {
                                return Err("elst 负媒体起点暂不支持剪切".into());
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
                            if p.is_empty() {return Err("mdhd 缺少版本".into());}
                            let required=if p[0]==1 {32} else {20};
                            if p.len()<required {return Err("mdhd 不完整".into());}
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
    let count = stsz_sizes.len() as u32;
    let timing_count=stts.iter().try_fold(0u32, |sum,(count,_)|sum.checked_add(*count)).ok_or("样本数溢出")?;
    if count>MAX_TRACK_SAMPLES || timing_count!=count || stsc.is_empty() || stts.is_empty() {return Err("样本表数量不一致或超过安全上限".into());}
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
    if stsc[0].0!=1 || stsc.iter().any(|entry|entry.1==0) || stsc.windows(2).any(|entries|entries[0].0>=entries[1].0) {
        return Err("stsc 块索引必须递增且每块包含样本".into());
    }
    let mut per_chunk: Vec<(u64, u32)> = Vec::with_capacity(chunk_offsets.len());
    let mut entry=0;
    for ci in 1..=chunk_offsets.len() as u32 {
        // Both tables are sorted: walk each once even for a large hostile index.
        while entry+1<stsc.len() && stsc[entry+1].0<=ci {entry+=1;}
        let active = stsc[entry];
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
            file_off = file_off.checked_add(u64::from(size)).ok_or("样本文件偏移溢出")?;
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

/// 供 `trim/tests.rs` 直接喂恶意表载荷（免造完整文件）。
#[allow(clippy::too_many_arguments)]
pub(super) fn parse_minf(
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
                    let n = table_entries(p, 8, 8)?;
                    for i in 0..n {
                        let o = 8 + i * 8;
                        stts.push((u32be(p, o), u32be(p, o + 4)));
                    }
                }
                b"stss" => {
                    let p = s.payload;
                    let n = table_entries(p, 8, 4)?;
                    for i in 0..n {
                        stss.push(u32be(p, 8 + i * 4));
                    }
                }
                b"stsc" => {
                    let p = s.payload;
                    let n = table_entries(p, 8, 12)?;
                    for i in 0..n {
                        let o = 8 + i * 12;
                        stsc.push((u32be(p, o), u32be(p, o + 4), u32be(p, o + 8)));
                    }
                }
                b"stsz" => {
                    let p = s.payload;
                    if p.len()<12 {return Err("stsz 不完整".into());}
                    *stsz_uniform = u32be(p, 4);
                    let n=u32be(p,8) as usize;
                    if n>MAX_TRACK_SAMPLES as usize {return Err("样本数超过安全上限".into());}
                    if *stsz_uniform!=0 {stsz_sizes.resize(n,*stsz_uniform);} else {
                        if n>(p.len()-12)/4 {return Err("stsz 样本表不完整".into());}
                        for i in 0..n {stsz_sizes.push(u32be(p,12+i*4));}
                    }
                }
                b"stco" => {
                    let p = s.payload;
                    let n = table_entries(p, 8, 4)?;
                    for i in 0..n {
                        chunk_offsets.push(u64::from(u32be(p, 8 + i * 4)));
                    }
                }
                b"co64" => {
                    let p = s.payload;
                    let n = table_entries(p, 8, 8)?;
                    for i in 0..n {
                        chunk_offsets.push(u64be(p, 8 + i * 8));
                    }
                }
                b"ctts" => {
                    // 合成时间偏移（B 帧重排）。录屏编码已关 B 帧，偏移应全 0——
                    // 全 0 则重组后直接丢弃这张表；非 0 是别的来源文件，逐样本
                    // 偏移的裁剪语义未验证，拒绝不硬写。
                    let p = s.payload;
                    let n = table_entries(p, 8, 8)?;

                    for i in 0..n {
                        let o = 8 + i * 8;
                        let off = u64::from(u32be(p, o + 4));
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
