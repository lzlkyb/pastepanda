//! Geometry shared by early release and native drag completion. All coordinates are physical pixels.
pub fn centered_origin(point: [f64; 2], size: [f64; 2]) -> [f64; 2] {
    [point[0] - size[0] / 2.0, point[1] - size[1] / 2.0]
}

pub fn desktop_release(released: bool, over_desktop: bool) -> bool { released && over_desktop }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_centers_original_pixels_without_screen_fit() {
        assert_eq!(centered_origin([700.0, 450.0], [1200.0, 630.0]), [100.0, 135.0]);
        assert_eq!(centered_origin([-1200.0, 200.0], [3840.0, 2160.0]), [-3120.0, -880.0]);
    }
    #[test]
    fn an_application_without_ole_is_not_a_desktop_drop() {
        assert!(!desktop_release(true, false));
        assert!(desktop_release(true, true));
        assert!(!desktop_release(false, true));
    }
}
