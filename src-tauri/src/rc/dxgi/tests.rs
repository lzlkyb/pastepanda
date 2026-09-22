//! `dxgi.rs` 的单元测试（NV12 色彩口径等，原样平移）。

use super::*;

#[test]
fn bgra_to_rgba_swaps() {
    let bgra = [10u8, 20, 30, 255];
    let rgba = bgra_to_rgba(&bgra);
    assert_eq!(&rgba[..], &[30, 20, 10, 255]);
}

#[test]
fn nv12_len() {
    let bgra = vec![0u8; 4 * 4 * 4];
    let nv = bgra_to_nv12(&bgra, 4, 4).unwrap();
    assert_eq!(nv.len(), 4 * 4 + 4 * 4 / 2);
}

#[test]
fn nv12_奇数尺寸显式报错() {
    let bgra = vec![0u8; 5 * 5 * 4];
    // P0-1 B7：奇数输入曾静默取偶——行步进与调用方不一致时会把错位画面
    // 编码进去。现在必须显式报错，让调用方走 JPEG 兜底。
    assert!(bgra_to_nv12(&bgra, 5, 5).is_err());
    assert!(bgra_to_nv12(&bgra, 4, 5).is_err());
    assert!(bgra_to_nv12(&bgra, 5, 4).is_err());
}

/// 灰度输入（R=G=B）应得到中灰 Y 与中性 U/V=128，验证通道序与系数没写反。
#[test]
fn nv12_灰色输入uv中性() {
    let w = 4usize;
    let h = 4usize;
    let mut bgra = Vec::new();
    for _ in 0..w * h {
        bgra.extend_from_slice(&[128, 128, 128, 255]); // BGRA
    }
    let nv = bgra_to_nv12(&bgra, w as u32, h as u32).unwrap();
    for &y in &nv[..w * h] {
        assert!((y as i32 - 126).abs() <= 2, "灰色 Y 应 ≈126（limited range：0.859×128+16），得到 {y}");
    }
    for &uv in &nv[w * h..] {
        assert_eq!(uv, 128, "灰色的 U/V 必须是 128");
    }
}

#[test]
fn nv12_色彩矩阵是_bt709_limited() {
    // Q1：601 编码 × 浏览器 709 解读 = 整体偏色。锁死 709 limited 的
    // 特征值——红 Y = 16+219×0.2126 ≈ 63（601 是 81）、绿 ≈ 173（601 是 145）、
    // 蓝 ≈ 32（601 是 90）。
    let px = |r: u8, g: u8, b: u8| -> (u8, u8, u8) {
        let mut bgra = vec![0u8; 2 * 2 * 4];
        for p in bgra.chunks_exact_mut(4) {
            p[0] = b;
            p[1] = g;
            p[2] = r;
            p[3] = 255;
        }
        let nv = bgra_to_nv12(&bgra, 2, 2).unwrap();
        (nv[0], nv[4], nv[5]) // Y00, U(0,0), V(0,0)——UV 平面跟在 4 字节 Y 后
    };
    let (yr, ur, vr) = px(255, 0, 0);
    assert!((yr as i32 - 63).abs() <= 1, "709 limited 红的 Y，得到 {yr}");
    // 系数整数化允许极值处 ±1 的舍入差（色度抽样后不可见）
    assert!((vr as i32 - 240).abs() <= 1, "红的 Cr，得到 {vr}");
    let (yb, ub, _) = px(0, 0, 255);
    assert!((yb as i32 - 32).abs() <= 1, "709 limited 蓝的 Y，得到 {yb}");
    assert!((ub as i32 - 240).abs() <= 1, "蓝的 Cb，得到 {ub}");
    let (yg, _, _) = px(0, 255, 0);
    assert!((yg as i32 - 173).abs() <= 1, "709 limited 绿的 Y，得到 {yg}");
    let _ = (ur, ub);
}
