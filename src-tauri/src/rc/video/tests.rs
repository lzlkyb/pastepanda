//! `video.rs` 的单元测试（原样平移）。

use super::*;

fn solid(w: u32, h: u32, r: u8, g: u8, b: u8) -> Vec<u8> {
    let mut v = Vec::with_capacity((w * h * 3) as usize);
    for _ in 0..w * h {
        v.extend_from_slice(&[r, g, b]);
    }
    v
}

fn to_rgba(rgb: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgb.len() / 3 * 4);
    for p in rgb.chunks_exact(3) {
        out.extend_from_slice(&[p[0], p[1], p[2], 255]);
    }
    out
}

#[test]
fn static_frame_is_skipped() {
    let mut st = EncoderState::new();
    let w = 128u32;
    let h = 64u32;
    let mut rgba = Vec::new();
    for _ in 0..w * h {
        rgba.extend_from_slice(&[10, 20, 30, 255]);
    }
    let e1 = encode_rgba(&mut st, w, h, &rgba).unwrap();
    assert!(e1.frame.full);
    let e2 = encode_rgba(&mut st, w, h, &rgba).unwrap();
    assert!(e2.frame.jpeg.is_empty(), "静止第二帧应跳过");
}

#[test]
fn 静止超过阈值发一次高保真回补帧() {
    let mut st = EncoderState::new();
    let w = 128u32;
    let h = 64u32;
    let mut rgba = Vec::new();
    for _ in 0..w * h {
        rgba.extend_from_slice(&[10, 20, 30, 255]);
    }
    let t0 = 1_758_000_000_000i64;
    let base = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0).unwrap();
    assert!(base.frame.full);
    // 静止 100ms：仍在阈值内 → 跳帧
    let skip = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0 + 100).unwrap();
    assert!(skip.frame.jpeg.is_empty());
    // 静止 400ms：发一次回补整帧
    let refine = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0 + 400).unwrap();
    assert!(refine.refine, "静止 400ms 应触发回补");
    assert!(refine.frame.full && !refine.frame.jpeg.is_empty());
    // 回补已发：继续静止不再发
    let again = encode_rgba_ts(&mut st, w, h, rgba.clone(), t0 + 800).unwrap();
    assert!(again.frame.jpeg.is_empty(), "回补是一次性的");
    // 画面再变：回补标记复位
    for px in rgba.iter_mut().step_by(3) {
        *px = 200;
    }
    let chg = encode_rgba_ts(&mut st, w, h, rgba, t0 + 1200).unwrap();
    assert!(!chg.frame.jpeg.is_empty());
    assert!(!chg.refine);
}

/// G5：零拷贝门控（判据写错不崩，只会静默跑 CPU 管线——所以必须有单测钉住）。
#[test]
fn 零拷贝门控_只给高带宽档且要求单输出() {
    // uhd60（4K60）与 fps120（8ms 节拍）走零拷贝；1080p60 留在 CPU（扛得住）
    assert!(EncodeProfile::of_name("uhd60").wants_zero_copy(false, false));
    assert!(EncodeProfile::of_name("fps120").wants_zero_copy(false, false));
    for q in ["fps60", "uhd", "ultra", "sharp", "balanced", "smooth", "auto"] {
        assert!(
            !EncodeProfile::of_name(q).wants_zero_copy(false, false),
            "{q} 不该走零拷贝（CPU 管线够用）"
        );
    }
    // 多屏拼接：GPU 侧没有跨屏合成这条路
    assert!(!EncodeProfile::of_name("uhd60").wants_zero_copy(true, false));
    assert!(!EncodeProfile::of_name("fps120").wants_zero_copy(true, false));
    // 本会话 GPU 路径已被判死：两档都不再尝试
    assert!(!EncodeProfile::of_name("uhd60").wants_zero_copy(false, true));
    assert!(!EncodeProfile::of_name("fps120").wants_zero_copy(false, true));
}

#[test]
fn ultra_profile_is_2560_wide() {
    let p = EncodeProfile::of_name("ultra");
    assert_eq!(p.max_w, 2560);
    assert!(p.adapt_down > EncodeProfile::of_name("balanced").adapt_down);
    // 超宽图应缩到 2560 而不是 4K
    let mut st = EncoderState::with_profile(p, true);
    let (w, h) = (3840u32, 2160u32);
    let rgb = solid(w, h, 30, 30, 30);
    let rgba = to_rgba(&rgb);
    let e = encode_rgba(&mut st, w, h, &rgba).unwrap();
    assert!(e.frame.full);
    assert_eq!(e.frame.width, 2560);
    assert_eq!(e.frame.height, 1440);
}

#[test]
fn small_change_not_static() {
    let mut st = EncoderState::new();
    let w = 256u32;
    let h = 128u32;
    let mut a = solid(w, h, 50, 50, 50);
    let rgba_a = to_rgba(&a);
    let e0 = encode_rgba(&mut st, w, h, &rgba_a).unwrap();
    assert!(e0.frame.full && !e0.frame.jpeg.is_empty());
    // 改一整块 tile（64×64），保证超过块差阈值
    for y in 0..64u32 {
        for x in 0..64u32 {
            let i = ((y * w + x) * 3) as usize;
            a[i] = 220;
            a[i + 1] = 20;
            a[i + 2] = 20;
        }
    }
    let rgba_b = to_rgba(&a);
    let e = encode_rgba(&mut st, w, h, &rgba_b).unwrap();
    assert!(!e.frame.jpeg.is_empty(), "有改动不应跳过");
}

#[test]
fn compositor_full() {
    let mut st = EncoderState::new();
    let w = 128u32;
    let h = 64u32;
    let rgb = solid(w, h, 0, 0, 0);
    let rgba = to_rgba(&rgb);
    let full = encode_rgba(&mut st, w, h, &rgba).unwrap();
    let mut comp = Compositor::new();
    let (cw, ch, buf) = comp.apply(None, &full.frame.jpeg).unwrap();
    assert_eq!(cw, w);
    assert_eq!(ch, h);
    assert_eq!(buf.len(), (w * h * 3) as usize);
}

fn h264_frame(key: bool) -> VideoFrame {
    VideoFrame {
        width: 64,
        height: 32,
        jpeg: vec![0xab; 16],
        at_ms: 0,
        full: true,
        rect: None,
        codec: FrameCodec::H264,
        key,
        cap_ms: 0,
        enc_ms: 0,
    }
}

#[test]
fn outbox_溢出丢P帧后拦截到下一个key() {
    let mut ob = FrameOutbox::new();
    ob.push(h264_frame(true));
    // 塞满：全是 P 帧，溢出丢掉的也是 P 帧 ⇒ 引用链断了
    for _ in 0..(FrameOutbox::CAP + 10) {
        ob.push(h264_frame(false));
    }
    let got = ob.drain();
    // 溢出是「先弹旧、再判新」：断链标记落下时，正在入队的那个 P 帧也被拦下，
    // 所以队列里是 CAP-1 条而不是 CAP 条
    assert_eq!(got.len(), FrameOutbox::CAP - 1);
    // 断链后再来 P 帧：必须拦下，前端不能再收到解不出的花屏
    ob.push(h264_frame(false));
    assert!(ob.drain().is_empty(), "断链期间的 P 帧应被拦截");
    // key 帧重新起链
    ob.push(h264_frame(true));
    ob.push(h264_frame(false));
    let got = ob.drain();
    assert_eq!(got.len(), 2);
    assert!(got[0].key && !got[1].key);
}

#[test]
fn outbox_溢出丢到key帧不算断链() {
    let mut ob = FrameOutbox::new();
    ob.push(h264_frame(true));
    // 队列里全是 key 帧时溢出：丢的 key 不破坏引用链，P 帧照常放行
    for _ in 0..(FrameOutbox::CAP + 10) {
        ob.push(h264_frame(true));
    }
    ob.push(h264_frame(false));
    let got = ob.drain();
    assert_eq!(got.len(), FrameOutbox::CAP);
    assert!(!got.last().unwrap().key);
    // JPEG 帧不受断链逻辑影响：来了就收
    let mut jpeg = h264_frame(true);
    jpeg.codec = FrameCodec::Jpeg;
    ob.clear();
    ob.push(jpeg.clone());
    ob.push(jpeg);
    assert_eq!(ob.drain().len(), 2);
}

/// 🔴 tile_dirty 的语义 = 整块平均差 ≥ 阈值（2026-09-19 审查 P2）：
/// 曾把「当前前缀和 ≥ 阈值×已扫数」当判脏（均值只增不减是错的），
/// 块内第 1 个像素 d=100 就判脏而全块均值 0.39——单像素噪声永久判脏。
#[test]
fn tile_dirty_单像素噪声不算脏_整块均值才算() {
    let w = 8u32;
    let mut prev = vec![100u8; (w * 8 * 3) as usize];
    let mut cur = prev.clone();
    // 单像素大差：早退逻辑曾当场判脏
    cur[0] = 200;
    assert!(!tile_dirty(&prev, &cur, w, 0, 0, 8, 8));
    // 半数像素中等差：均值 (30*32)/64 = 15 ≥ 8 ⇒ 脏
    for i in 0..(64 * 3 / 2) {
        cur[i] = prev[i] + 10;
    }
    assert!(tile_dirty(&prev, &cur, w, 0, 0, 8, 8));
    // 拖动整窗（全部大差）：必然脏剪枝生效，结果不变
    for i in 0..cur.len() {
        cur[i] = prev[i] ^ 0xff;
    }
    assert!(tile_dirty(&prev, &cur, w, 0, 0, 8, 8));
    let _ = &mut prev;
}

/// 🔴 断链判据看「逐出后的新队头」（2026-09-19 审查 P2）：key 被逐出、
/// 新队头是引用它的 P 帧时必须置 corrupt——否则花屏帧直发前端。
#[test]
fn outbox_逐出key帧后新队头是P要置断链() {
    let mut ob = FrameOutbox::new();
    ob.push(h264_frame(true));
    for _ in 0..(FrameOutbox::CAP - 1) {
        ob.push(h264_frame(false));
    }
    // 队列满：这一推把队头的 key 挤出去，新队头是 P ⇒ 引用链断，
    // 本帧自身也因 corrupt 被拦
    ob.push(h264_frame(false));
    assert_eq!(
        ob.drain().len(),
        FrameOutbox::CAP - 1,
        "key 被逐出后断链置位，紧随的 P 帧不得入队"
    );
    // key 帧照常放行并清除断链——自愈通道还在
    ob.push(h264_frame(true));
    let got = ob.drain();
    assert_eq!(got.len(), 1);
    assert!(got[0].key);
}
