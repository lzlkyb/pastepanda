//! Long screenshot wheel injection, pinned to one window throughout each batch.
use super::{prepare_target, require_accessibility};
extern "C" {
    fn pp_mac_scroll_target_at(x: i32, y: i32, pid: *mut i32, window: *mut u32) -> i32;
    fn pp_mac_scroll_send(pid: i32, window: u32, x: i32, y: i32, lines: i32) -> i32;
}
fn wheel_lines(delta: i32) -> Result<i32, String> {
    if delta == 0 || i64::from(delta).abs() > 4800 {
        return Err("滚动幅度无效".into());
    }
    Ok(((i64::from(delta).abs() / 120).max(1) * 3 * i64::from(delta.signum())) as i32)
}
pub fn scroll(x: i32, y: i32, delta: i32, repeat: Option<i32>) -> Result<(), String> {
    let lines = wheel_lines(delta)?;
    require_accessibility()?;
    let mut pid = 0;
    let mut window = 0;
    let status = unsafe { pp_mac_scroll_target_at(x, y, &mut pid, &mut window) };
    if status != 0 || pid <= 0 || window == 0 || pid as u32 == std::process::id() {
        return Err("滚动位置没有可用的目标窗口".into());
    }
    prepare_target(pid as isize, std::process::id())?;
    let times = repeat.unwrap_or(1).clamp(1, 60);
    for step in 0..times {
        match unsafe { pp_mac_scroll_send(pid, window, x, y, lines) } {
            0 => {}
            1 => return Err("滚动需要辅助功能权限，请检查系统设置".into()),
            2 => return Err("滚动目标或前台焦点已变化，已停止本次滚动".into()),
            _ => return Err("无法创建 Mac 滚动事件".into()),
        }
        if step + 1 < times {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wheel_conversion_preserves_direction_and_rejects_extremes() {
        assert_eq!(wheel_lines(-120).unwrap(), -3);
        assert_eq!(wheel_lines(240).unwrap(), 6);
        assert_eq!(wheel_lines(-1).unwrap(), -3);
        for delta in [0, 4801, i32::MIN, i32::MAX] {
            assert!(wheel_lines(delta).is_err());
        }
    }
}
