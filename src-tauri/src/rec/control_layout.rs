//! Control bar placement uses checked physical geometry; invalid screens must not panic.

/// 控制条首次显示的逻辑尺寸。
///
/// **必须 ≥ 内容的自然尺寸**：前端会用 `.surface` 的 offsetWidth/Height 反过来收紧窗口
/// （见 `RecControlBar.module.css` 的说明）。小于内容时首帧会被窗口裁掉一截
/// ——2026-10-18 实测旧值 260×36 时条本身要 312×38，左侧抓手与底部各被切掉一部分。
/// 320×38 = 实测 312×38 + 8px 余量；宁可先大后小（内容始终完整）也不要先小后大。
/// 「正在准备」态会多一段文案（实测 352 宽），不在初值里预置最大态：那会让录制主态
/// 每次都从 352 缩到 311；这类状态由前端量测上报自动跟随，初值只负责首帧不裁。
const COMPACT_W: f64 = 320.0;
const COMPACT_H: f64 = 38.0;

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
    let w = ((COMPACT_W * scale).round() as i64).min(sw);
    let h = ((COMPACT_H * scale).round() as i64).min(sh);
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
/// Keep the bottom/center anchor when a menu expands, without reserving an invisible hit area.
pub(super) fn resize(screen: (i32, i32, i32, i32), current: (i32, i32, u32, u32), logical: (u32, u32), scale: f64) -> Result<Layout, String> {
    if !(80..=480).contains(&logical.0) || !(28..=600).contains(&logical.1) {
        return Err("控制条尺寸无效".into());
    }
    // Reuse the same geometry validation as initial placement.
    place(screen, current, scale)?;
    let (sx, sy, sw, sh) = (i64::from(screen.0), i64::from(screen.1), i64::from(screen.2), i64::from(screen.3));
    let w = ((f64::from(logical.0) * scale).round() as i64).min(sw);
    let h = ((f64::from(logical.1) * scale).round() as i64).min(sh);
    let x = (i64::from(current.0) + (i64::from(current.2) - w) / 2).clamp(sx, sx + sw - w);
    let y = (i64::from(current.1) + i64::from(current.3) - h).clamp(sy, sy + sh - h);
    Ok(Layout {
        x: i32::try_from(x).map_err(|_| "控制条横坐标超出范围")?,
        y: i32::try_from(y).map_err(|_| "控制条纵坐标超出范围")?,
        w: w as u32, h: h as u32,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_hit_area_covers_the_whole_bar() {
        let layout = place((0, 0, 1920, 1080), (200, 200, 800, 600), 1.0).unwrap();
        // 320×38 不是审美选择：小于它时首帧会裁掉抓手与底部（见 COMPACT_W 的说明）
        assert_eq!((layout.w, layout.h), (320, 38));
    }
    #[test]
    fn collapse_resize_and_menu_stay_inside_the_monitor() {
        let screen = (-1920, 0, 1920, 1080);
        let compact = resize(screen, (-1000, 900, 260, 36), (80, 28), 1.0).unwrap();
        assert_eq!((compact.w, compact.h, compact.y), (80, 28, 908));
        let menu = resize(screen, (-90, 0, 80, 28), (260, 280), 1.5).unwrap();
        assert_eq!((menu.w, menu.h), (390, 420));
        assert!(menu.x >= -1920 && menu.x + menu.w as i32 <= 0 && menu.y >= 0);
        assert!(resize(screen, (-100, 0, 80, 28), (0, 28), 1.0).is_err());
    }
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
                x: 152,
                y: 684,
                w: 640,
                h: 76
            }
        );
    }
    #[test]
    fn small_and_negative_origin_displays_keep_bar_in_bounds() {
        assert_eq!(
            place((-300, -200, 300, 200), (-300, -200, 300, 200), 2.0).unwrap(),
            Layout {
                x: -300,
                y: -76,
                w: 300,
                h: 76
            }
        );
        assert!(place((i32::MAX, 0, 100, 100), (i32::MAX, 0, 100, 100), 1.0).is_ok());
    }
}
