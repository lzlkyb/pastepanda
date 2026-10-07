//! 录屏指针合成（三期 P0，2026-10-06）——把 DXGI 指针形状画进 BGRA 帧。
//!
//! Desktop Duplication 的指针是**独立元数据**（不在桌面图里），不合成就进不了
//! 录像。这里按 `DXGI_OUTDUPL_POINTER_SHAPE_INFO.Type` 的三类格式逐像素合成：
//!
//! - MONOCHROME(1)：1bpp AND/XOR 双掩码，`h` = 两段掩码总高（AND 在前 XOR 在后），
//!   行按字节补齐到 `pitch`；AND=1&XOR=1 反色、AND=1&XOR=0 透明、AND=0 实色（XOR 位选黑白）。
//! - COLOR(2)：32bpp BGRA 直通，按 alpha 源叠。
//! - MASKED_COLOR(3)：32bpp BGRA，alpha=0 的像素走 XOR 掩码语义（与底图异或），
//!   alpha≠0 不透明直写——这是 Windows 默认箭头（白边黑箭头）的格式。
//!
//! 纯函数、不含 React/IO/COM，坐标全部由调用方换算好（画布系）。

/// DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
pub const TYPE_MONOCHROME: u32 = 1;
/// DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR
pub const TYPE_COLOR: u32 = 2;
/// DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR
pub const TYPE_MASKED_COLOR: u32 = 3;

/// 随帧绘制的指针描述（从 `rc::dxgi::PtrSnapshot` 换算而来）。
pub struct PtrDraw<'a> {
    /// 热点（尖端）在**目标帧坐标系**里的位置。
    pub x: i32,
    pub y: i32,
    /// 位图左上角相对热点的偏移（多数为 0）。
    pub hot_x: u32,
    pub hot_y: u32,
    pub kind: u32,
    pub w: u32,
    pub h: u32,
    pub pitch: u32,
    pub data: &'a [u8],
}

/// 把指针画进 BGRA 帧（原位修改）。越界行列裁剪；格式不认识就整体跳过
/// （宁可少画一帧指针，不能画花画面）。
pub fn draw_pointer(dst: &mut [u8], dst_w: u32, dst_h: u32, p: &PtrDraw) {
    let (w, h, pitch) = (p.w as usize, p.h as usize, p.pitch as usize);
    if w == 0 || h == 0 || p.data.len() < pitch * h {
        return;
    }
    // 位图左上角 = 热点 − hotspot 偏移
    let left = p.x - p.hot_x as i32;
    let top = p.y - p.hot_y as i32;
    if left >= dst_w as i32 || top >= dst_h as i32 {
        return;
    }
    // 🔴 MONOCHROME 的 `h` 是**两段掩码总高**（AND 段 + XOR 段），屏幕行只有
    // 一半——外层循环按屏幕行走，不按 h 走，否则指针会被画成两倍高。
    let half = h / 2;
    let rows = if p.kind == TYPE_MONOCHROME { half } else { h };
    for r in 0..rows {
        let dy = top + r as i32;
        if dy < 0 || dy >= dst_h as i32 {
            continue;
        }
        for c in 0..w {
            let dx = left + c as i32;
            if dx < 0 || dx >= dst_w as i32 {
                continue;
            }
            let di = (dy as usize * dst_w as usize + dx as usize) * 4;
            match p.kind {
                TYPE_MONOCHROME => {
                    let and = mask_bit(p.data, pitch, r, c);
                    let xor = mask_bit(p.data, pitch, half + r, c);
                    match (and, xor) {
                        (1, 0) => {}
                        (1, 1) => {
                            for k in 0..3 {
                                dst[di + k] = !dst[di + k];
                            }
                        }
                        _ => {
                            let v = if xor == 1 { 255u8 } else { 0u8 };
                            dst[di] = v;
                            dst[di + 1] = v;
                            dst[di + 2] = v;
                            dst[di + 3] = 255;
                        }
                    }
                }
                TYPE_COLOR => {
                    let si = r * pitch + c * 4;
                    let (b, g, rr, a) = (
                        p.data[si],
                        p.data[si + 1],
                        p.data[si + 2],
                        p.data[si + 3],
                    );
                    blend_pixel(dst, di, b, g, rr, a);
                }
                TYPE_MASKED_COLOR => {
                    let si = r * pitch + c * 4;
                    let (b, g, rr, a) = (
                        p.data[si],
                        p.data[si + 1],
                        p.data[si + 2],
                        p.data[si + 3],
                    );
                    if a == 0 {
                        // XOR 掩码语义：与底图逐通道异或（alpha 保持底图原值）
                        dst[di] ^= b;
                        dst[di + 1] ^= g;
                        dst[di + 2] ^= rr;
                    } else {
                        dst[di] = b;
                        dst[di + 1] = g;
                        dst[di + 2] = rr;
                        dst[di + 3] = 255;
                    }
                }
                _ => return,
            }
        }
    }
}

/// 1bpp 掩码取位（MSB 在前，行内按 pitch 字节补齐）。
fn mask_bit(data: &[u8], pitch: usize, row: usize, col: usize) -> u8 {
    let byte = data[row * pitch + col / 8];
    (byte >> (7 - (col % 8))) & 1
}

/// 源叠（src-over）：a=255 直写、a=0 不动、其余线性混合。
fn blend_pixel(dst: &mut [u8], di: usize, b: u8, g: u8, r: u8, a: u8) {
    if a == 255 {
        dst[di] = b;
        dst[di + 1] = g;
        dst[di + 2] = r;
        dst[di + 3] = 255;
        return;
    }
    if a == 0 {
        return;
    }
    let (a, inv) = (u32::from(a), 255 - u32::from(a));
    for k in 0..3 {
        let src = u32::from([b, g, r][k]);
        dst[di + k] = ((src * a + u32::from(dst[di + k]) * inv) / 255) as u8;
    }
    dst[di + 3] = 255;
}

// ── 点击涟漪（四期 1.3 烧入轨）─────────────────────────────────────────

/// 一条点击涟漪（画布系坐标；start_ms = 视频时间轴 ms，事件入帧时打点）。
pub struct Ripple {
    pub x: i32,
    pub y: i32,
    pub start_ms: u64,
}

/// 涟漪生命期：圆环从 R0 扩到 R1、alpha 线性衰减到 0。
pub const RIPPLE_DURATION_MS: u64 = 400;

const RIPPLE_R0: f32 = 9.0;
const RIPPLE_R1: f32 = 38.0;
const RIPPLE_RING_HALF_W: f32 = 1.6; // 描边半宽（px），带抗锯齿衰减
/// 青色（RGB；与录屏设计语言的青色手柄同源）。
const RIPPLE_RGB: [u8; 3] = [34, 211, 238];

/// 把所有活着的涟漪画进 BGRA 帧（原位修改）。调用方在指针**之前**画（光标
/// 保持最上层）；进度按视频时间轴算——跳帧/暂停时时间冻结，涟漪与编码出的
/// 画面严格对齐（不会在静止段偷偷走完）。
pub fn draw_ripples(dst: &mut [u8], dst_w: u32, dst_h: u32, ripples: &[Ripple], now_ms: u64) {
    for r in ripples {
        let elapsed = now_ms.saturating_sub(r.start_ms);
        if elapsed >= RIPPLE_DURATION_MS {
            continue;
        }
        let p = elapsed as f32 / RIPPLE_DURATION_MS as f32;
        let radius = RIPPLE_R0 + (RIPPLE_R1 - RIPPLE_R0) * p;
        let alpha = ((1.0 - p) * 0.85 * 255.0) as u32;
        let (cx, cy) = (r.x as f32, r.y as f32);
        let span = radius as i32 + 3;
        let (w, h) = (dst_w as i32, dst_h as i32);
        for dy in (cy as i32 - span)..=(cy as i32 + span) {
            if dy < 0 || dy >= h {
                continue;
            }
            for dx in (cx as i32 - span)..=(cx as i32 + span) {
                if dx < 0 || dx >= w {
                    continue;
                }
                let d = ((dx as f32 - cx).powi(2) + (dy as f32 - cy).powi(2)).sqrt();
                // 环带覆盖度：|d − r| ≤ 半宽，线性衰减出抗锯齿边
                let edge = RIPPLE_RING_HALF_W - (d - radius).abs();
                if edge <= 0.0 {
                    continue;
                }
                let cover = (edge / RIPPLE_RING_HALF_W).min(1.0);
                let a = ((alpha as f32 * cover) as u32).min(255) as u8;
                let di = (dy as usize * dst_w as usize + dx as usize) * 4;
                blend_pixel(dst, di, RIPPLE_RGB[2], RIPPLE_RGB[1], RIPPLE_RGB[0], a);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×1 底图（两像素，各通道值不同便于断言）。
    fn dst2() -> Vec<u8> {
        // px0 = (10,20,30,255)，px1 = (40,50,60,255)，BGRA 内存序
        vec![10, 20, 30, 255, 40, 50, 60, 255]
    }

    #[test]
    fn 单色指针_实色与反色() {
        // 2 宽、两段各 1 行（pitch 补齐 4）：AND=00（全实色），XOR=01（右像素白）
        let data = [0, 0, 0, 0, 0b0100_0000, 0, 0, 0];
        let mut dst = dst2();
        draw_pointer(
            &mut dst,
            2,
            1,
            &PtrDraw { x: 0, y: 0, hot_x: 0, hot_y: 0, kind: TYPE_MONOCHROME, w: 2, h: 2, pitch: 4, data: &data },
        );
        // 左像素：AND=0,XOR=0 → 黑实色
        assert_eq!(&dst[0..4], &[0, 0, 0, 255]);
        // 右像素：AND=0,XOR=1 → 白实色
        assert_eq!(&dst[4..8], &[255, 255, 255, 255]);
    }

    #[test]
    fn 单色指针_AND1XOR1_反色_坐标平移与裁剪() {
        // AND=11 XOR=11：两像素都反色
        let data = [0b1100_0000, 0, 0, 0, 0b1100_0000, 0, 0, 0];
        let mut dst = dst2();
        // 热点 (0,0)、位图左上 (−1,0)：只有右列落在底图 px0 上
        draw_pointer(
            &mut dst,
            2,
            1,
            &PtrDraw { x: 0, y: 0, hot_x: 1, hot_y: 0, kind: TYPE_MONOCHROME, w: 2, h: 2, pitch: 4, data: &data },
        );
        assert_eq!(&dst[0..4], &[!10, !20, !30, 255]);
        // px1 不在位图内 → 原样
        assert_eq!(&dst[4..8], &[40, 50, 60, 255]);
    }

    #[test]
    fn 掩色指针_alpha0走XOR_非0直写() {
        // 2 宽 1 行：左像素 alpha=0（XOR 语义），右像素 alpha=255（直写）
        let data = [0xFF, 0x00, 0x00, 0x00, 1, 2, 3, 255];
        let mut dst = dst2();
        draw_pointer(
            &mut dst,
            2,
            1,
            &PtrDraw { x: 0, y: 0, hot_x: 0, hot_y: 0, kind: TYPE_MASKED_COLOR, w: 2, h: 1, pitch: 8, data: &data },
        );
        // 左：0x10 ^ 0xFF
        assert_eq!(&dst[0..4], &[10 ^ 0xFF, 20 ^ 0x00, 30 ^ 0x00, 255]);
        // 右：直写 + alpha=255
        assert_eq!(&dst[4..8], &[1, 2, 3, 255]);
    }

    #[test]
    fn 彩色指针_半透明混合与透明跳过() {
        // 左像素 alpha=128 混合，右像素 alpha=0 跳过
        let data = [200, 100, 0, 128, 9, 9, 9, 0];
        let mut dst = dst2();
        draw_pointer(
            &mut dst,
            2,
            1,
            &PtrDraw { x: 0, y: 0, hot_x: 0, hot_y: 0, kind: TYPE_COLOR, w: 2, h: 1, pitch: 8, data: &data },
        );
        // px0: (200*128 + 10*127)/255 = 105
        assert_eq!(dst[0], ((200u32 * 128 + 10 * 127) / 255) as u8);
        assert_eq!(dst[1], ((100u32 * 128 + 20 * 127) / 255) as u8);
        assert_eq!(dst[2], ((0u32 * 128 + 30 * 127) / 255) as u8);
        // px1 原样
        assert_eq!(&dst[4..8], &[40, 50, 60, 255]);
    }

    #[test]
    fn 越界整体裁剪与未知格式跳过() {
        let mut dst = dst2();
        // 完全在帧外：不改任何字节
        draw_pointer(
            &mut dst,
            2,
            1,
            &PtrDraw { x: 5, y: 5, hot_x: 0, hot_y: 0, kind: TYPE_COLOR, w: 2, h: 1, pitch: 8, data: &[255; 8] },
        );
        assert_eq!(dst, dst2());
        // 未知类型：整体跳过
        draw_pointer(
            &mut dst,
            2,
            1,
            &PtrDraw { x: 0, y: 0, hot_x: 0, hot_y: 0, kind: 9, w: 2, h: 1, pitch: 8, data: &[255; 8] },
        );
        assert_eq!(dst, dst2());
    }

    // ── 涟漪 ──
    /// w×h 底图，全部 (10,20,30,255)。
    fn flat(w: usize, h: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for _ in 0..w * h {
            v.extend_from_slice(&[10, 20, 30, 255]);
        }
        v
    }

    #[test]
    fn 涟漪_环带落青色_环外环心不动() {
        // 40×40 画布，涟漪在中心
        let mut dst = flat(40, 40);
        draw_ripples(&mut dst, 40, 40, &[Ripple { x: 20, y: 20, start_ms: 0 }], 0);
        // p=0 时 r=9：中心 (20,20) 距离 0，不在环带（|0−9|=9 > 1.6）→ 原样
        let c = (20 * 40 + 20) * 4;
        assert_eq!(&dst[c..c + 4], &[10, 20, 30, 255], "环心不落色");
        // 环带上的点 (20+9, 20) 必落青色
        let ring = ((20 * 40) + 29) * 4;
        assert!(dst[ring] > 100 && dst[ring + 1] > 100, "环带像素被混成青色系 b={}", dst[ring]);
        // 远角原样
        let far = (2 * 40 + 2) * 4;
        assert_eq!(&dst[far..far + 4], &[10, 20, 30, 255]);
    }

    #[test]
    fn 涟漪_过期不画_越界安全() {
        let mut dst = flat(40, 40);
        let before = dst.clone();
        draw_ripples(&mut dst, 40, 40, &[Ripple { x: 20, y: 20, start_ms: 0 }], 400);
        assert_eq!(dst, before, "到时即跳过");
        // 帧边缘上的涟漪（半径外扩越界）不 panic、帧内部分照画
        draw_ripples(&mut dst, 40, 40, &[Ripple { x: 1, y: 1, start_ms: 0 }], 0);
        assert_ne!(dst, before, "边缘涟漪帧内部分仍落色");
    }
}
