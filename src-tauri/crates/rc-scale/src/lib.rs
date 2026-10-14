//! 实时 BGRA 缩放热路径。独立编译让泛型卷积也使用优化代码，
//! 避免 dev 主工程实例化未优化的 SIMD 泛型，仍耗时数百毫秒。
use fast_image_resize::{images::{Image, ImageRef}, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

#[derive(Default)]
pub struct BgraScaler {
    resizer: Resizer,
    pixels: Vec<u8>,
}

impl BgraScaler {
    pub fn resize(&mut self, src: &[u8], w: u32, h: u32, ew: u32, eh: u32) -> Result<&[u8], String> {
        if w == 0 || h == 0 || ew == 0 || eh == 0 { return Err("空缩放画面".into()); }
        let source = ImageRef::new(w, h, src, PixelType::U8x4).map_err(|e| e.to_string())?;
        self.pixels.resize(ew as usize * eh as usize * 4, 0);
        let mut dest = Image::from_slice_u8(ew, eh, &mut self.pixels, PixelType::U8x4).map_err(|e| e.to_string())?;
        // Bilinear convolution 是旧 Triangle 的同类三角核（缩小时扩展核）。
        // 抓屏 alpha 常为 0，禁止预乘以免合法 BGRA 被当作透明像素抹黑。
        let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear)).use_alpha(false);
        self.resizer.resize(&source, &mut dest, Some(&options)).map_err(|e| e.to_string())?;
        Ok(&self.pixels)
    }
}

mod nv12;
pub use nv12::{bgra_to_nv12, bgra_to_nv12_into};

/// 缩略图沿用 Lanczos3；与实时缩放共用已优化的卷积模块，RGBA 各通道不交换。
pub fn rgba_thumbnail(src: &[u8], w: u32, h: u32, tw: u32, th: u32) -> Result<Vec<u8>, String> {
    let source = ImageRef::new(w, h, src, PixelType::U8x4).map_err(|e| e.to_string())?;
    let mut dest = Image::new(tw, th, PixelType::U8x4);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)).use_alpha(false);
    Resizer::new().resize(&source, &mut dest, Some(&options)).map_err(|e| e.to_string())?;
    Ok(dest.into_vec())
}

#[cfg(test)]
mod thumbnail_tests {
    use super::*;
    #[test]
    fn channels_and_transparent_rgb_are_preserved() {
        // 原缩略图不预乘 alpha；透明 RGB 也不能在 JPEG 之前被抹黑。
        for pixel in [[231, 17, 89, 255], [13, 183, 239, 0]] {
            let source = pixel.repeat(8 * 4);
            let result = rgba_thumbnail(&source, 8, 4, 2, 1).unwrap();
            assert_eq!(result, pixel.repeat(2));
        }
    }
    #[test]
    fn truncated_pixels_fail_instead_of_producing_a_blank_frame() {
        assert!(rgba_thumbnail(&[0; 3], 2, 1, 1, 1).is_err());
    }
}
