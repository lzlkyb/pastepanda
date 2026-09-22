//! BGRA 色彩空间转换（RGBA 打包 / NV12 BT.709 limited）。
//!
//! 2026-09-22 从 `dxgi.rs` 平移（体量合规）：纯函数、不碰 DXGI/D3D 对象，
//! 与抓屏实现无耦合。调用方经 `dxgi::bgra_to_*` re-export 路径不变。

pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        out.extend_from_slice(&[p[2], p[1], p[0], 255]);
    }
    out
}

/// BGRA → NV12（BT.709 limited range，整数定点；Q1 统一口径）。
///
/// 🔴 原实现逐像素 f32 标量循环，4K 一帧（800 万像素）要几十上百毫秒，
/// 是硬编路径最大的 CPU 热点；整数定点版同公式，2×2 块一次算出 4 个 Y 与
/// 一对 UV（UV 取 4 采样均值，与原实现语义一致），实测快一个数量级。
///
/// 🔴 宽高必须是**偶数**（P0-1 B7）：本函数按偶数宽做行步进，奇数输入意味着
/// 调用方的行步进与这里不一致——静默取偶只会把错位当成画面编码进去。
/// 之前「向下取偶」的行为已删除：调用方（H.264 路径）在进入前就保证偶数
/// （inbound 对奇数抓帧直接回 JPEG），这里再兜一次但**显式报错**。
pub fn bgra_to_nv12(bgra: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    bgra_to_nv12_into(bgra, w, h, &mut out)?;
    Ok(out)
}

/// P2-8：带复用缓冲的 NV12 转换。每帧 `vec![0u8; 12MB]`（4K）在编码热路径上
/// 是纯浪费——调用方（编码器）持一个缓冲反复用；尺寸变了 resize 会自动适配。
/// 语义与 [`bgra_to_nv12`] 完全一致，只是把输出缓冲交给调用方持有。
pub fn bgra_to_nv12_into(
    bgra: &[u8],
    w: u32,
    h: u32,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    if w == 0 || h == 0 {
        return Err("空画面".into());
    }
    if w % 2 == 1 || h % 2 == 1 {
        return Err(format!("NV12 要求偶数尺寸，得到 {w}x{h}"));
    }
    let w = w as usize;
    let h = h as usize;
    if bgra.len() < w * h * 4 {
        return Err("BGRA 长度不足".into());
    }
    let y_size = w * h;
    out.clear();
    out.resize(y_size + (w / 2) * (h / 2) * 2, 0);
    let (y_plane, uv_plane) = out.split_at_mut(y_size);
    for by in 0..h / 2 {
        let y0 = by * 2;
        let row0 = &bgra[y0 * w * 4..(y0 + 1) * w * 4];
        let row1 = &bgra[(y0 + 1) * w * 4..(y0 + 2) * w * 4];
        let uv_row = &mut uv_plane[by * (w / 2) * 2..(by + 1) * (w / 2) * 2];
        for bx in 0..w / 2 {
            let x0 = bx * 2;
            let i00 = x0 * 4;
            let i01 = i00 + 4;

            let (b00, g00, r00) = (row0[i00] as i32, row0[i00 + 1] as i32, row0[i00 + 2] as i32);
            let (b01, g01, r01) = (row0[i01] as i32, row0[i01 + 1] as i32, row0[i01 + 2] as i32);
            // row1 已是下一行的切片：下标与 row0 同列，不再加整行偏移
            let (b10, g10, r10) = (row1[i00] as i32, row1[i00 + 1] as i32, row1[i00 + 2] as i32);
            let (b11, g11, r11) = (row1[i01] as i32, row1[i01 + 1] as i32, row1[i01 + 2] as i32);

            // Q1（2026-09-19）：色彩矩阵统一 **BT.709 limited**——未标注 VUI 的
            // HD 流，浏览器/解码器按 709 解释（601 编码 × 709 解读 = 红/绿整体
            // 偏移，发橙发灰）。矩阵本身无法经 ICodecAPI 标注，靠编码侧与
            // 解读侧口径一致来保证。与 GPU 路径（gpu.rs 的 P709）严格同口径。
            //
            // Y = (47R + 157G + 16B + 128) >> 8 + 16；limited range 恒在 [16,235]
            let yb = y0 * w + x0;
            y_plane[yb] = (((47 * r00 + 157 * g00 + 16 * b00 + 128) >> 8) + 16) as u8;
            y_plane[yb + 1] = (((47 * r01 + 157 * g01 + 16 * b01 + 128) >> 8) + 16) as u8;
            y_plane[yb + w] = (((47 * r10 + 157 * g10 + 16 * b10 + 128) >> 8) + 16) as u8;
            y_plane[yb + w + 1] = (((47 * r11 + 157 * g11 + 16 * b11 + 128) >> 8) + 16) as u8;

            // UV = 4 采样均值：位移从 >>8 拼成 >>10
            let (sr, sg, sb) = (
                r00 + r01 + r10 + r11,
                g00 + g01 + g10 + g11,
                b00 + b01 + b10 + b11,
            );
            let u = (((-26 * sr - 87 * sg + 113 * sb + 512) >> 10) + 128).clamp(0, 255) as u8;
            let v = (((112 * sr - 102 * sg - 10 * sb + 512) >> 10) + 128).clamp(0, 255) as u8;
            uv_row[bx * 2] = u;
            uv_row[bx * 2 + 1] = v;
        }
    }
    Ok(())
}
