//! All Mac screen regions use one primary-display pixel density, including gaps.
use crate::screenshot::MonitorInfo;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}
impl From<&MonitorInfo> for Rect {
    fn from(m: &MonitorInfo) -> Self {
        Self {
            x: m.x,
            y: m.y,
            w: m.w,
            h: m.h,
        }
    }
}
impl Rect {
    pub fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.w)
    }
    pub fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.h)
    }
    pub fn intersect(self, other: Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= i64::from(x) || bottom <= i64::from(y) {
            return None;
        }
        Some(Self {
            x,
            y,
            w: i32::try_from(right - i64::from(x)).ok()?,
            h: i32::try_from(bottom - i64::from(y)).ok()?,
        })
    }
    pub fn validate(self, limit: i64) -> Result<(), String> {
        if self.w <= 0
            || self.h <= 0
            || i64::from(self.w) * i64::from(self.h) > limit
            || self.right() > i64::from(i32::MAX)
            || self.bottom() > i64::from(i32::MAX)
        {
            return Err("显示器区域超出安全尺寸限制".into());
        }
        Ok(())
    }
}
pub fn bounds(monitors: &[MonitorInfo]) -> Result<Rect, String> {
    let first = monitors.first().ok_or("未找到显示器")?;
    let mut result = Rect::from(first);
    result.validate(67_108_864)?;
    for m in &monitors[1..] {
        let rect = Rect::from(m);
        rect.validate(67_108_864)?;
        let right = result.right().max(rect.right());
        let bottom = result.bottom().max(rect.bottom());
        result.x = result.x.min(rect.x);
        result.y = result.y.min(rect.y);
        result.w = i32::try_from(right - i64::from(result.x)).map_err(|_| "虚拟屏宽度无效")?;
        result.h = i32::try_from(bottom - i64::from(result.y)).map_err(|_| "虚拟屏高度无效")?;
    }
    result.validate(67_108_864)?;
    Ok(result)
}
pub fn validate_region(monitors: &[MonitorInfo], region: Rect) -> Result<(), String> {
    region.validate(67_108_864)?;
    let desktop = bounds(monitors)?;
    if desktop.intersect(region) != Some(region)
        || !monitors
            .iter()
            .any(|m| region.intersect(Rect::from(m)).is_some())
    {
        return Err("截图区域超出显示器范围或位于屏幕间隙".into());
    }
    Ok(())
}
/// Sequential capture bounds memory to the destination plus one display image.
pub fn compose<F>(
    monitors: &[MonitorInfo],
    region: Rect,
    mut capture: F,
) -> Result<image::RgbaImage, String>
where
    F: FnMut(&MonitorInfo) -> Result<image::RgbaImage, String>,
{
    validate_region(monitors, region)?;
    let mut output = image::RgbaImage::from_pixel(
        region.w as u32,
        region.h as u32,
        image::Rgba([0, 0, 0, 255]),
    );
    for m in monitors {
        let Some(part) = region.intersect(Rect::from(m)) else {
            continue;
        };
        let frame = capture(m)?;
        if frame.width() != m.w as u32 || frame.height() != m.h as u32 {
            return Err("显示器分辨率已变化，请重新截图".into());
        }
        let crop = image::imageops::crop_imm(
            &frame,
            (part.x - m.x) as u32,
            (part.y - m.y) as u32,
            part.w as u32,
            part.h as u32,
        );
        image::imageops::replace(
            &mut output,
            &*crop,
            i64::from(part.x - region.x),
            i64::from(part.y - region.y),
        );
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn monitor(index: usize, x: i32, y: i32, w: i32, h: i32) -> MonitorInfo {
        MonitorInfo {
            index: index as i32,
            x,
            y,
            w,
            h,
            primary: index == 0,
        }
    }
    #[test]
    fn cross_display_crop_negative_origin_and_gap() {
        let monitors = vec![monitor(0, 0, 0, 4, 4), monitor(1, -4, -2, 4, 4)];
        assert_eq!(
            bounds(&monitors).unwrap(),
            Rect {
                x: -4,
                y: -2,
                w: 8,
                h: 6
            }
        );
        let region = Rect {
            x: -2,
            y: -1,
            w: 4,
            h: 4,
        };
        let image = compose(&monitors, region, |m| {
            Ok(image::RgbaImage::from_pixel(
                m.w as u32,
                m.h as u32,
                image::Rgba([if m.primary { 200 } else { 100 }, 0, 0, 255]),
            ))
        })
        .unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [100, 0, 0, 255]);
        assert_eq!(image.get_pixel(3, 0).0, [0, 0, 0, 255]);
        assert_eq!(image.get_pixel(3, 3).0, [200, 0, 0, 255]);
        assert_eq!(image.get_pixel(0, 3).0, [0, 0, 0, 255]);
    }
    #[test]
    fn reject_gap_only_overflow_and_resolution_change() {
        let monitors = vec![monitor(0, 0, 0, 2, 2), monitor(1, 4, 0, 2, 2)];
        for region in [
            Rect {
                x: 2,
                y: 0,
                w: 2,
                h: 2,
            },
            Rect {
                x: i32::MAX,
                y: 0,
                w: 1,
                h: 1,
            },
            Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 1,
            },
        ] {
            assert!(validate_region(&monitors, region).is_err());
        }
        assert!(compose(
            &monitors,
            Rect {
                x: 0,
                y: 0,
                w: 1,
                h: 1
            },
            |_| Ok(image::RgbaImage::new(1, 1))
        )
        .is_err());
        assert!(bounds(&[
            monitor(0, i32::MIN, 0, 2, 2),
            monitor(1, i32::MAX - 2, 0, 2, 2)
        ])
        .is_err());
    }
}
