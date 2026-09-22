//! 多屏拼接 Compositor（virtual screen 拼装）。

use super::*;

/// 发起端合成器：整帧替换，脏块贴到缓冲上。
pub struct Compositor {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
}

impl Compositor {
    pub fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            rgb: Vec::new(),
        }
    }

    /// 应用一帧。返回是否产生了新的完整画面。
    pub fn apply(
        &mut self,
        rect: Option<DirtyRect>,
        jpeg: &[u8],
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let img = image::load_from_memory(jpeg).map_err(|e| format!("JPEG 解码失败：{e}"))?;
        let rgb = img.to_rgb8();
        match rect {
            None => {
                self.width = rgb.width();
                self.height = rgb.height();
                self.rgb = rgb.as_raw().clone();
            }
            Some(r) => {
                if self.rgb.is_empty() {
                    // 还没关键帧：忽略脏块
                    return Err("尚未收到关键帧".into());
                }
                if r.x + r.w > self.width || r.y + r.h > self.height {
                    return Err("脏矩形超出画布".into());
                }
                if rgb.width() != r.w || rgb.height() != r.h {
                    return Err("脏块尺寸与元数据不符".into());
                }
                let src = rgb.as_raw();
                for y in 0..r.h {
                    let src_i = (y * r.w) as usize * 3;
                    let dst_i = ((r.y + y) * self.width + r.x) as usize * 3;
                    let n = (r.w as usize) * 3;
                    if src_i + n > src.len() || dst_i + n > self.rgb.len() {
                        return Err("贴块越界".into());
                    }
                    self.rgb[dst_i..dst_i + n].copy_from_slice(&src[src_i..src_i + n]);
                }
            }
        }
        Ok((self.width, self.height, self.rgb.clone()))
    }
}

impl Default for Compositor {
    fn default() -> Self {
        Self::new()
    }
}
