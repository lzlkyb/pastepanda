use super::*;

#[test]
fn resize_preserves_bgra_even_when_capture_alpha_is_zero() {
    let mut scaler = BgraScaler::default();
    let pixels = [255, 20, 10, 0].repeat(8 * 8);
    let resized = scaler.resize(&pixels, 8, 8, 4, 4).unwrap();
    assert!(resized.chunks_exact(4).all(|p| p == [255, 20, 10, 0]));
    let nv = crate::rc::dxgi::bgra_to_nv12(resized, 4, 4).unwrap();
    let expected = crate::rc::dxgi::bgra_to_nv12(&[255, 20, 10, 0].repeat(4 * 4), 4, 4).unwrap();
    assert_eq!(nv, expected);
}

#[test]
fn triangle_quality_and_channel_order_match_the_previous_scaler() {
    let mut scaler = BgraScaler::default();
    let mut pixels = vec![0u8; 96 * 54 * 4];
    for (i, p) in pixels.chunks_exact_mut(4).enumerate() {
        p.copy_from_slice(&[(i * 37) as u8, (i * 11) as u8, (i / 96 * 9) as u8, 255]);
    }
    let input = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(96, 54, pixels.as_slice()).unwrap();
    for (w, h) in [(64, 36), (48, 28), (96, 54)] {
        let reference = image::imageops::resize(&input, w, h, image::imageops::FilterType::Triangle);
        let scaled = scaler.resize(&pixels, 96, 54, w, h).unwrap();
        let error = scaled.iter().zip(reference.as_raw()).map(|(a,b)| a.abs_diff(*b)).max().unwrap();
        assert!(error <= 2, "{w}x{h} 三角卷积误差 {error} 超出舍入容差");
    }
}

#[test]
fn resize_reuses_storage_and_rejects_incomplete_input() {
    let mut scaler = BgraScaler::default();
    let pixels = [20, 40, 60, 255].repeat(16 * 16);
    let first = scaler.resize(&pixels, 16, 16, 8, 8).unwrap().as_ptr();
    assert_eq!(scaler.resize(&pixels, 16, 16, 8, 8).unwrap().as_ptr(), first);
    assert!(scaler.resize(&pixels[..32], 16, 16, 8, 8).is_err());
    assert!(scaler.resize(&pixels, 16, 16, 0, 8).is_err());
}

#[test]
#[ignore = "本机耗时对照，手动执行；不把硬件速度作为常规 CI 断言"]
fn cpu_scaling_benchmark() {
    let pixels = [50, 120, 200, 0].repeat(1920 * 1080);
    let source = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(1920, 1080, pixels.as_slice()).unwrap();
    let mut scaler = BgraScaler::default();
    let mut nv = Vec::new();
    for (w, h) in [(1280, 720), (960, 540)] {
        // 先暖缓存；随后分别测旧缩放、新缩放和同一转换器。
        scaler.resize(&pixels, 1920, 1080, w, h).unwrap();
        let t = Instant::now();
        for _ in 0..4 { std::hint::black_box(image::imageops::resize(&source, w, h, image::imageops::FilterType::Triangle)); }
        let old = t.elapsed().as_secs_f64() * 250.;
        let t = Instant::now();
        for _ in 0..4 { std::hint::black_box(scaler.resize(&pixels, 1920, 1080, w, h).unwrap()); }
        let new = t.elapsed().as_secs_f64() * 250.;
        let resized = scaler.resize(&pixels, 1920, 1080, w, h).unwrap();
        let t = Instant::now();
        for _ in 0..4 { crate::rc::dxgi::bgra_to_nv12_into(resized, w, h, &mut nv).unwrap(); }
        println!("{w}x{h} old_scale={old:.2}ms simd_scale={new:.2}ms nv12={:.2}ms", t.elapsed().as_secs_f64() * 250.);
    }
}

#[test]
#[ignore = "需要本机硬件编码器，手动验证缩放到实际编码包的完整路径"]
fn scaled_cpu_frames_reach_the_hardware_encoder() {
    use crate::rc::encode_h264::{H264SessionEncoder, VideoCodec};
    let mut enc = H264SessionEncoder::try_open(VideoCodec::H264, 1920, 1080, 15);
    assert!(enc.available(), "本机硬件编码器未打开");
    enc.resolution_limit = 960;
    let mut pixels = [50, 120, 200, 0].repeat(1920 * 1080);
    let mut delivered = 0;
    let mut times = Vec::new();
    for n in 0..24 {
        // 每帧改变一个色块，验证真实数据路径，不能只反复编码一个零缓冲。
        for p in pixels[..128 * 4].chunks_exact_mut(4) { p[0] = (n * 10) as u8; }
        let at = 1_000 + n * 67;
        enc.set_capture_at(at);
        let t = Instant::now();
        let packets = enc.encode_bgra(&pixels, 1920, 1080).unwrap();
        if n >= 3 { times.push(t.elapsed().as_secs_f64() * 1_000.); }
        for p in packets {
            assert_eq!((p.width, p.height), (960, 540));
            assert!(!p.data.is_empty());
            assert!((1_000..=at).contains(&p.at_ms), "出包要保留原采集时刻");
            delivered += 1;
        }
    }
    assert!(delivered >= 20, "24 个输入帧只产生了 {delivered} 个包");
    times.sort_by(f64::total_cmp);
    println!("scaled encode packets={delivered} median={:.2}ms p95={:.2}ms", times[times.len()/2], times[times.len()*95/100]);
}
