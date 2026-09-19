//! JPEG 头解析：只读 SOF0/SOF2 拿宽高，不解像素。

/// 从 JPEG 头读 SOF0/SOF2 宽高（不解像素）。
pub(crate) fn jpeg_dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 9 < jpeg.len() {
        if jpeg[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = jpeg[i + 1];
        // SOF0..SOF15（跳过 DHT/DAC 等）
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            let h = u16::from_be_bytes([jpeg[i + 5], jpeg[i + 6]]) as u32;
            let w = u16::from_be_bytes([jpeg[i + 7], jpeg[i + 8]]) as u32;
            if w > 0 && h > 0 {
                return Some((w, h));
            }
            return None;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if i + 3 >= jpeg.len() {
            break;
        }
        let seglen = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if seglen < 2 {
            break;
        }
        i += 2 + seglen;
    }
    None
}

#[cfg(test)]
mod jpeg_dim_tests {
    use super::jpeg_dimensions;

    #[test]
    fn reads_sof0_dimensions() {
        // 手工最小 JPEG 头：SOI + SOF0(len=11, precision=8, h=64, w=128)
        let mut b = vec![
            0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x40, 0x00, 0x80,
        ];
        b.extend_from_slice(&[1, 0x11, 0]);
        assert_eq!(jpeg_dimensions(&b), Some((128, 64)));
    }

    #[test]
    fn rejects_non_jpeg() {
        assert_eq!(jpeg_dimensions(&[0x00, 0x01]), None);
    }
}
