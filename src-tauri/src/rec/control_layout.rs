//! Control bar placement uses checked physical geometry; invalid screens must not panic.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Layout {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}
pub(super) fn place(
    screen: (i32, i32, i32, i32),
    region: (i32, i32, u32, u32),
    scale: f64,
) -> Result<Layout, String> {
    let (sx, sy, sw, sh) = screen;
    if sw < 16 || sh < 16 || !scale.is_finite() || !(1.0..=8.0).contains(&scale) {
        return Err("显示器尺寸或缩放无效，无法显示录制控制条".into());
    }
    let (sx, sy, sw, sh) = (i64::from(sx), i64::from(sy), i64::from(sw), i64::from(sh));
    let (rx, ry, rw, rh) = (
        i64::from(region.0),
        i64::from(region.1),
        i64::from(region.2),
        i64::from(region.3),
    );
    let w = ((496.0 * scale).round() as i64).min(sw);
    let h = ((48.0 * scale).round() as i64).min(sh);
    let gap = (12.0 * scale).round() as i64;
    let x = (rx + (rw - w) / 2).clamp(sx, sx + sw - w);
    let top = ry - h - gap;
    let y = (if top < sy { ry + rh + gap } else { top }).clamp(sy, sy + sh - h);
    Ok(Layout {
        x: i32::try_from(x).map_err(|_| "控制条横坐标超出范围")?,
        y: i32::try_from(y).map_err(|_| "控制条纵坐标超出范围")?,
        w: w as u32,
        h: h as u32,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zero_screen_and_invalid_scale_return_errors_without_panicking() {
        for screen in [(0, 0, 0, 0), (0, 0, -1, 1080), (0, 0, 1920, 0)] {
            assert!(place(screen, (0, 0, 944, 660), 2.0).is_err());
        }
        assert!(place((0, 0, 1920, 1080), (0, 0, 944, 660), f64::NAN).is_err());
    }
    #[test]
    fn retina_control_bar_fits_and_flips_below_top_region() {
        let layout = place((0, 0, 3840, 2160), (0, 0, 944, 660), 2.0).unwrap();
        assert_eq!(
            layout,
            Layout {
                x: 0,
                y: 684,
                w: 992,
                h: 96
            }
        );
    }
    #[test]
    fn small_and_negative_origin_displays_keep_bar_in_bounds() {
        assert_eq!(
            place((-300, -200, 300, 200), (-300, -200, 300, 200), 2.0).unwrap(),
            Layout {
                x: -300,
                y: -96,
                w: 300,
                h: 96
            }
        );
        assert!(place((i32::MAX, 0, 100, 100), (i32::MAX, 0, 100, 100), 1.0).is_ok());
    }
}
