//! The service checks active session identity and Control before this adapter.
use crate::rc::input::{unicode_input_units, InputEvent, ScreenRegion};
extern "C" {
    fn pp_rc_inject(
        kind: u32,
        x: f64,
        y: f64,
        code: u32,
        down: bool,
        delta: i32,
        text: *const u16,
        units: usize,
    ) -> i32;
}
pub fn region() -> Result<(ScreenRegion, f64), String> {
    let rect = crate::macos::screen::desktop()?;
    Ok((
        ScreenRegion {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
        },
        crate::macos::screen::primary_scale(),
    ))
}
fn location(x: u16, y: u16, screen: &ScreenRegion, scale: f64) -> (f64, f64) {
    (
        (f64::from(screen.x) + f64::from(x) * f64::from(screen.w - 1) / 65535.) / scale,
        (f64::from(screen.y) + f64::from(y) * f64::from(screen.h - 1) / 65535.) / scale,
    )
}
fn result(code: i32) -> Result<(), String> {
    match code {
        0 => Ok(()),
        2 => Err("Mac 远程键鼠需要辅助功能权限，请在系统设置中允许 PastePanda".into()),
        3 => Err("这个按键暂未适配 Mac，请使用文字输入或其它快捷键".into()),
        _ => Err("Mac 输入事件无效或无法发送".into()),
    }
}
pub fn inject(event: &InputEvent, screen: &ScreenRegion) -> Result<(), String> {
    // Releasing held input must survive a display unplug or scope change.
    if let Some((kind, code)) = release_event(event) {
        return result(unsafe { pp_rc_inject(kind, 0., 0., code, false, 0, std::ptr::null(), 0) });
    }
    let layout = crate::macos::screen::native_monitors()?;
    let monitors: Vec<_> = layout.iter().map(|m| m.monitor.clone()).collect();
    let scale = layout.first().ok_or("未找到显示器")?.scale;
    let matching = monitors
        .iter()
        .any(|m| (m.x, m.y, m.w, m.h) == (screen.x, screen.y, screen.w, screen.h))
        || crate::macos::screen_layout::bounds(&monitors)
            .is_ok_and(|r| (r.x, r.y, r.w, r.h) == (screen.x, screen.y, screen.w, screen.h));
    if !matching {
        return Err("远控屏幕尺寸已变化，输入已取消，请重连".into());
    }
    if let InputEvent::MouseButton {
        x, y, down: true, ..
    }
    | InputEvent::Wheel { x, y, .. } = event
    {
        let (px, py) = location(*x, *y, screen, 1.);
        if !monitors.iter().any(|m| {
            px >= f64::from(m.x)
                && py >= f64::from(m.y)
                && px < f64::from(m.x) + f64::from(m.w)
                && py < f64::from(m.y) + f64::from(m.h)
        }) {
            return Err("光标位于显示器间隙，未发送点击或滚动".into());
        }
    }
    let mut units = Vec::new();
    let (kind, x, y, code, down, delta) = match event {
        InputEvent::MouseMove { x, y } => {
            let (x, y) = location(*x, *y, screen, scale);
            (1, x, y, 0, false, 0)
        }
        InputEvent::MouseButton { x, y, button, down } if (1..=3).contains(button) => {
            let (x, y) = location(*x, *y, screen, scale);
            (2, x, y, u32::from(*button), *down, 0)
        }
        InputEvent::Wheel { x, y, delta } => {
            let (x, y) = location(*x, *y, screen, scale);
            (3, x, y, 0, false, *delta)
        }
        InputEvent::Key { vk, down } => (4, 0., 0., *vk, *down, 0),
        InputEvent::Text { text } => {
            units = unicode_input_units(text)?;
            (5, 0., 0., 0, false, 0)
        }
        _ => return Err("这个指令不属于 Mac 键鼠注入".into()),
    };
    result(unsafe { pp_rc_inject(kind, x, y, code, down, delta, units.as_ptr(), units.len()) })
}
fn release_event(event: &InputEvent) -> Option<(u32, u32)> {
    match event {
        InputEvent::Key { vk, down: false } => Some((4, *vk)),
        InputEvent::MouseButton {
            button,
            down: false,
            ..
        } if (1..=3).contains(button) => Some((2, u32::from(*button))),
        _ => None,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn releases_do_not_depend_on_old_display_geometry() {
        assert_eq!(
            release_event(&InputEvent::Key {
                vk: 0x11,
                down: false
            }),
            Some((4, 0x11))
        );
        assert_eq!(
            release_event(&InputEvent::MouseButton {
                x: 0,
                y: 0,
                button: 1,
                down: false
            }),
            Some((2, 1))
        );
        assert_eq!(
            release_event(&InputEvent::Key {
                vk: 0x11,
                down: true
            }),
            None
        );
    }
    #[test]
    fn retina_endpoints_map_inside_display() {
        let screen = ScreenRegion {
            x: 0,
            y: 0,
            w: 3840,
            h: 2160,
        };
        assert_eq!(location(0, 0, &screen, 2.), (0., 0.));
        assert_eq!(location(65535, 65535, &screen, 2.), (1919.5, 1079.5));
    }
    #[test]
    fn permission_and_unsupported_key_fail_visibly() {
        assert!(result(2).unwrap_err().contains("辅助功能"));
        assert!(result(3).unwrap_err().contains("按键"));
    }
}
