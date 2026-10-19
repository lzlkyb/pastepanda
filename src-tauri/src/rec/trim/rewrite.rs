//! 重组侧：按保留区间重写 mdat 样本、重建 moov 的四张表。
//!
//! 布局固定为 `ftyp | mdat（各轨样本串联，轨序=moov 轨序）| moov`，
//! 因此每个 trak 只剩一个 chunk，stco 单条 entry 即可。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use super::boxes::{io_err, iter_boxes, push_u32, push_u32_at, push_u64_at, u32be, wrap_box};
use super::{output, Plan, SrcMp4, SrcTrack, TrimJob};

fn ms_to_ticks_ceil(ms:u64, timescale:u64)->u64 {
    (u128::from(ms)*u128::from(timescale)).div_ceil(1000).min(u128::from(u64::MAX)) as u64
}

impl SrcMp4 {
    /// 重组并写出 `[in_ms, out_ms]`（播放域，调用方已吸附）。
    /// 返回 (文件字节数, 实际入点, 实际出点)——实际入点 = 视频首保留关键帧的播放
    /// 时刻，选段早于首个可见关键帧时会被顶后，与名义吸附值可能不同。
    pub(super) fn write_trimmed(&mut self, dst: &Path, in_ms: u64, out_ms: u64, job: Option<&TrimJob>) -> Result<(u64, u64, u64), String> {
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
            let end_ts = ms_to_ticks_ceil(out_ms, ts) + t.elst_media_time;
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
            let start_ts = ms_to_ticks_ceil(eff_in, ts) + t.elst_media_time;
            let end_ts = ms_to_ticks_ceil(out_ms, ts) + t.elst_media_time;
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
        if let Some(job)=job { job.check_cancelled()?; }
        let (pending, mut out) = output::PendingOutput::new(dst, false)?;
        let mut copied=0u64;
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
                let mut remaining=u64::from(s.size);
                let mut n=0;
                let mut buffer=[0u8;64*1024];
                while remaining>0 {
                    if let Some(job)=job {job.check_cancelled()?;}
                    let limit=remaining.min(buffer.len() as u64) as usize;
                    let got=src.read(&mut buffer[..limit]).map_err(io_err)?;
                    if got==0 {break;}
                    out.write_all(&buffer[..got]).map_err(io_err)?;
                    remaining-=got as u64;
                    n+=got as u64;
                    copied+=got as u64;
                    if let Some(job)=job {job.progress(copied,mdat_payload);}
                }
                if n != u64::from(s.size) {
                    return Err(format!("样本 {i} 读取不完整（{n}/{}）", s.size));
                }
            }
        }
        let moov = self.build_moov(&plans, &chunk_offsets)?;
        out.write_all(&moov).map_err(io_err)?;
        out.flush().map_err(io_err)?;
        out.sync_all().map_err(io_err)?;
        drop(out);
        if let Some(job)=job {job.check_cancelled()?;}
        pending.commit()?;
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
            let movie_dur=u64::try_from(u128::from(media_dur)*u128::from(movie_ts)/u128::from(t.timescale.max(1)))
                .map_err(|_|"轨道时长超出支持范围")?;
            durs.push((media_dur, movie_dur));
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
    if p.is_empty() {return Err("时长盒子缺少版本".into());}
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
    if p.is_empty() {return Err("mdhd 缺少版本".into());}
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
    if p.first()==Some(&1) && p.len()>=24 {u32be(p,20)} else if p.len()>=16 {u32be(p,12)} else {1000}
}
