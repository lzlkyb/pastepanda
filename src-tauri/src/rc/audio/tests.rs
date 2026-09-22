//! `audio.rs` 的单元测试（原样平移）。

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

/// P2-3: bounded queue must drop-on-full and never block/accumulate unboundedly.
#[test]
fn 音频队列满则丢包计数不阻塞() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let (tx, rx) = tokio::sync::mpsc::channel::<AudioOut>(2);
    let dropped = AtomicU64::new(0);
    let pkt = |i| AudioOut::Pkt {
        pts_ms: i,
        data: vec![0u8; 4],
    };
    assert!(try_push_audio(&tx, pkt(0), &dropped));
    assert!(try_push_audio(&tx, pkt(1), &dropped));
    // third is full -> drop + count, still "ok" for the producer
    assert!(try_push_audio(&tx, pkt(2), &dropped));
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
    // channel stays bounded at 2
    assert_eq!(rx.len(), 2);
    drop(rx);
    assert!(!try_push_audio(&tx, pkt(3), &dropped), "closed channel must signal stop");
}
