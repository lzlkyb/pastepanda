//! Mac recording bounds and capability checks; no IO.
use super::session_types::RecOpts;
pub(super) fn validate(opts: &RecOpts, screen: (i32, i32, i32, i32)) -> Result<(), String> {
    let (x, y, w, h) = screen;
    if opts.w < 16
        || opts.h < 16
        || u64::from(opts.w) * u64::from(opts.h) > 40_000_000
        || opts.x < x
        || opts.y < y
        || i64::from(opts.x) + i64::from(opts.w) > i64::from(x) + i64::from(w)
        || i64::from(opts.y) + i64::from(opts.h) > i64::from(y) + i64::from(h)
    {
        return Err("录屏区域超出桌面或尺寸无效".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn opts() -> RecOpts {
        RecOpts {
            x: 0,
            y: 0,
            w: 800,
            h: 600,
            quality: super::super::quality::RecQuality::High,
            sys_audio: true,
            mic_audio: false,
            click_highlight: false,
            event_sidecar: false,
        }
    }
    #[test]
    fn recording_bounds_and_supported_options() {
        let mut o = opts();
        assert!(validate(&o, (0, 0, 1920, 1080)).is_ok());
        o.x = i32::MAX;
        assert!(validate(&o, (0, 0, 1920, 1080)).is_err());
        o = opts();
        o.mic_audio = true;
        assert!(validate(&o, (0, 0, 1920, 1080)).is_ok());
        o = opts();
        o.event_sidecar = true;
        assert!(validate(&o, (0, 0, 1920, 1080)).is_ok());
        o = opts();
        o.click_highlight = true;
        assert!(validate(&o, (0, 0, 1920, 1080)).is_ok());
    }
    #[test]
    fn unsupported_recording_os_is_rejected_before_privacy_preflight() {
        let native = include_str!("../macos/recording.m");
        let start = native.split("int32_t pp_rec_start(").nth(1).unwrap();
        assert!(start.find("@available(macOS 13.0").unwrap()
            < start.find("CGPreflightScreenCaptureAccess").unwrap(),
            "macOS 12 must get unsupported, not an instruction to re-authorize recording");
    }

}
