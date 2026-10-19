// ── 测试：手造 MP4 夹具往返（无环境依赖，纯字节级）───────────────────────
//
// 夹具：视频 ts=1000、30 样本×33ms（sync=第 1/11/21 样本，media 0/330/660）、
// 尺寸 100+i；音频 ts=1000、90 样本×10ms、尺寸 40+i。2+2 块交错布局。
// 样本字节 = 全 i 的重复（字节级等值断言用）。可选 elst（掐头重排验证）、
// all_sync = 不写视频 stss（全同步轨路径）。

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::boxes::*;
use super::parse::parse_minf;
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
    if bytes.is_empty() {let _=std::fs::remove_file(&p);} else {std::fs::write(&p, bytes).unwrap();}
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
#[test]
fn audit_real_timescale_keeps_requested_duration() {
    let mut data = fixture(false, 0, false, false);
    for i in 4..data.len().saturating_sub(24) {
        if &data[i..i+4] == b"mdhd" {
            let old = u32be(&data, i+16);
            push_u32_at(&mut data, i+16, old*30);
            let dur = u32be(&data, i+20);
            push_u32_at(&mut data, i+20, dur*30);
        }
        if &data[i..i+4] == b"stts" {
            let n = u32be(&data, i+8) as usize;
            for j in 0..n {
                let at = i+16+j*8;
                let delta = u32be(&data, at);
                push_u32_at(&mut data, at, delta*30);
            }
        }
    }
    let src = write_tmp("audit_ts30000_src.mp4", &data);
    let dst = write_tmp("audit_ts30000_dst.mp4", &[]);
    assert_eq!(scan_keyframes(&src).unwrap().duration_ms, 990);
    let result = trim(&src,0,660,&dst).unwrap();
    let output = std::fs::read(&dst).unwrap();
    let at = output.windows(4).position(|w| w == b"mdhd").unwrap();
    let real = u64::from(u32be(&output, at+20))*1000/u64::from(u32be(&output,at+16));
    println!("requested 660 ms; reported {}..{} ms; actual {} ms",result.1,result.2,real);
    assert_eq!(real,660,"trim output duration must equal snapped requested duration");
}    #[test]
fn audit_valid_uniform_stsz_must_not_panic() {
    let mut p = vec![];
    push_u32(&mut p,0);
    push_u32(&mut p,100);
    push_u32(&mut p,3);
    let minf = wrap_box(b"stbl",&wrap_box(b"stsz",&p));
    let parsed = std::panic::catch_unwind(|| {
        parse_minf(&minf,&mut vec![],&mut vec![],&mut vec![],&mut vec![],&mut 0,&mut vec![],&mut vec![])
    });
    assert!(parsed.is_ok(),"a valid uniform stsz must not panic");
}
#[test]
fn existing_output_is_never_truncated() {
    let source=write_tmp("no_overwrite_src.mp4", &fixture(false,0,false,false));
    let destination=write_tmp("no_overwrite_dst.mp4", b"previous successful output");
    assert!(trim(&source,0,660,&destination).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(),b"previous successful output");
}
#[test]
fn malformed_tables_are_errors_without_panics() {
    for kind in [b"stts",b"stss",b"stsc",b"stsz",b"stco",b"co64",b"ctts"] {
        let mut p=vec![0;12];
        push_u32_at(&mut p,4,20);
        if kind==b"stsz" {push_u32_at(&mut p,4,0);push_u32_at(&mut p,8,20);}
        let bytes=wrap_box(b"stbl",&wrap_box(kind,&p));
        let result=std::panic::catch_unwind(|| parse_minf(&bytes,&mut vec![],&mut vec![],&mut vec![],&mut vec![],&mut 0,&mut vec![],&mut vec![]));
        assert!(result.is_ok(),"{kind:?} must not panic");
        assert!(result.unwrap().is_err(),"{kind:?} must be rejected");
    }
}

fn map_fixture_boxes(bytes:&[u8], replace:&mut impl FnMut([u8;4],&[u8])->Option<Vec<u8>>)->Vec<u8> {
    let mut result=Vec::new();
    for item in iter_boxes(bytes).unwrap() {
        let replacement=replace(item.name,item.payload).unwrap_or_else(|| {
            if matches!(&item.name,b"moov"|b"trak"|b"mdia"|b"minf"|b"stbl"|b"edts") {
                wrap_box(&item.name,&map_fixture_boxes(item.payload,replace))
            } else {wrap_box(&item.name,item.payload)}
        });
        result.extend_from_slice(&replacement);
    }
    result
}

#[test]
fn hostile_co64_offsets_are_errors_without_panics() {
    let bytes=map_fixture_boxes(&fixture(false,0,false,false),&mut |kind,payload| {
        if &kind!=b"stco" {return None;}
        let mut offsets=payload[..8].to_vec();
        for _ in 0..u32be(payload,4) {push_u64(&mut offsets,u64::MAX);}
        Some(wrap_box(b"co64",&offsets))
    });
    let source=write_tmp("hostile_co64.mp4",&bytes);
    let parsed=std::panic::catch_unwind(||SrcMp4::open(&source));
    assert!(parsed.is_ok(),"hostile sample offsets must not panic");
    assert!(parsed.unwrap().is_err());
}

#[test]
fn truncated_edit_lists_are_rejected_before_timeline_or_rewrite() {
    for length in [0,4,8,16] {
        let bytes=map_fixture_boxes(&fixture(false,0,true,false),&mut |kind,_| {
            (&kind==b"elst").then(||wrap_box(b"elst",&vec![0;length]))
        });
        let source=write_tmp(&format!("short_elst_{length}.mp4"),&bytes);
        assert!(scan_keyframes(&source).is_err(),"elst length {length} must be rejected");
    }
}

#[test]
fn uniform_sample_tables_roundtrip_and_retrim() {
    let bytes=map_fixture_boxes(&fixture(false,0,false,false),&mut |kind,payload| {
        if &kind!=b"stsz" {return None;}
        let mut sizes=payload[..12].to_vec();
        push_u32_at(&mut sizes,4,40);
        Some(wrap_box(b"stsz",&sizes))
    });
    let source=write_tmp("uniform_roundtrip_src.mp4",&bytes);
    let destination=write_tmp("uniform_roundtrip_out.mp4",&[]);
    let repeated=write_tmp("uniform_roundtrip_again.mp4",&[]);
    trim(&source,0,660,&destination).unwrap();
    assert_eq!(scan_keyframes(&destination).unwrap().duration_ms,660);
    trim(&destination,330,660,&repeated).unwrap();
    assert_eq!(scan_keyframes(&repeated).unwrap().duration_ms,330);
}

#[test]
fn independent_video_90000_and_audio_48000_timescales_preserve_duration() {
    let mut factor=90;
    let bytes=map_fixture_boxes(&fixture(false,0,false,false),&mut |kind,payload| {
        if &kind==b"mdhd" {
            factor=if u32be(payload,16)==990 {90}else{48};
            let mut data=payload.to_vec();
            push_u32_at(&mut data,12,1000*factor);
            push_u32_at(&mut data,16,u32be(payload,16)*factor);
            Some(wrap_box(&kind,&data))
        } else if &kind==b"stts" {
            let mut data=payload.to_vec();
            for index in 0..u32be(payload,4) as usize {
                let offset=12+index*8;
                push_u32_at(&mut data,offset,u32be(payload,offset)*factor);
            }
            Some(wrap_box(&kind,&data))
        } else {None}
    });
    let source=write_tmp("independent_ts_src.mp4",&bytes);
    let destination=write_tmp("independent_ts_out.mp4",&[]);
    assert_eq!(trim(&source,0,660,&destination).unwrap().1,0);
    let output=SrcMp4::open(&destination).unwrap();
    assert_eq!(output.tracks[0].timescale,90000);
    assert_eq!(output.tracks[1].timescale,48000);
    assert_eq!(output.tracks[0].duration_ms(),660);
    assert_eq!(output.tracks[1].duration_ms(),660);
    let mut durations=Vec::new();
    map_fixture_boxes(&std::fs::read(&destination).unwrap(),&mut |kind,payload| {
        if &kind==b"mdhd" {durations.push((u32be(payload,12),u32be(payload,16)));}
        None
    });
    assert_eq!(durations,vec![(90000,59400),(48000,31680)]);
}
