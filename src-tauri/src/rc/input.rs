//! 远程键鼠注入（R2）。被控端本地执行 `SendInput`。
//!
//! # 安全
//!
//! - 仅在 `InboundActive` 且会话能力为 `Control` 时由 service 调用
//! - 不信任对端声明的坐标系之外的任何特权；UIPI 拦截要**明确报错**，不静默
//!
//! # 文本
//!
//! 长文本不走逐键注入，走「推剪贴板 → 对端 Ctrl+V」（`clipboard_push`）。

use serde::{Deserialize, Serialize};

/// 发起端 → 被控端的输入指令（JSON 控制帧的一种，经同一条 bi-stream 的反向半流）。
///
/// 鼠标坐标用 **0..=65535 归一化**（Windows `MOUSEEVENTF_ABSOLUTE` 同口径），
/// 避免发起端不知道对端虚拟屏分辨率。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputEvent {
    MouseMove {
        x: u16,
        y: u16,
    },
    /// button: 1=左 2=右 3=中；down=按下/抬起
    MouseButton {
        x: u16,
        y: u16,
        button: u8,
        down: bool,
    },
    Wheel {
        x: u16,
        y: u16,
        delta: i32,
    },
    Key {
        vk: u32,
        down: bool,
    },
    ClipboardPush {
        text: String,
    },
    ClipboardPull,
    /// 发起端心跳：会话 UI 存活时周期发送；被控端据此暂停/恢复推流。
    /// 可选 `ts` 用于 RTT 测量（被控端原样放进 pong）。
    Ping {
        ts: Option<i64>,
    },
    /// 发起端要求被控端改画质档（sharp/balanced/smooth）。
    SetQuality {
        quality: String,
    },
    /// 发起端要求被控端改截取范围（virtual/primary）。
    SetCaptureScope {
        scope: String,
    },
    /// 发起端要求本会话强制走 JPEG（H.264 解不出时回退）。
    SetCodec {
        codec: String,
    },
    /// 发起端把测得的 RTT 告知被控端，用于自适应降码率（R5.B2）。
    /// 不注入本机、不要求 Control。
    NetHint {
        rtt_ms: i64,
    },
    /// 发起端设置「码率倍率」（Q5，50–200，100 = 跟随链路）。与 RTT/丢包的
    /// 自动缩放**相乘**合成——用户调高也不会越过弱网保护，只是抬天花板。
    /// 不注入本机、不要求 Control（只看会话也该能调自己看到的画质）。
    SetBitratePct {
        pct: u32,
    },
    /// 发起端解码断链（丢包/花屏）时请求被控端下一帧强制 IDR。
    /// 不注入本机、不要求 Control——弱网自愈的主通道（2026-09-19）。
    RequestKey,
}

/// 远端光标形状。由被控端比对系统标准光标句柄得出，
/// 发起端据此切换 overlay / 本地光标样式（P1-6 光标形状同步）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorShape {
    Arrow,
    IBeam,
    Wait,
    Cross,
    SizeNwse,
    SizeNesw,
    SizeNs,
    SizeWe,
    SizeAll,
    No,
    Hand,
    AppStarting,
    UpArrow,
    /// 远端隐藏了光标（游戏/演示软件常见）
    Hidden,
    Unknown,
}

impl CursorShape {
    pub fn as_str(&self) -> &'static str {
        match self {
            CursorShape::Arrow => "arrow",
            CursorShape::IBeam => "ibeam",
            CursorShape::Wait => "wait",
            CursorShape::Cross => "cross",
            CursorShape::SizeNwse => "size_nwse",
            CursorShape::SizeNesw => "size_nesw",
            CursorShape::SizeNs => "size_ns",
            CursorShape::SizeWe => "size_we",
            CursorShape::SizeAll => "size_all",
            CursorShape::No => "no",
            CursorShape::Hand => "hand",
            CursorShape::AppStarting => "app_starting",
            CursorShape::UpArrow => "up_arrow",
            CursorShape::Hidden => "hidden",
            CursorShape::Unknown => "unknown",
        }
    }
}

/// 当前系统光标形状。拿不到（无光标/系统 API 失败）返回 Unknown。
#[cfg(target_os = "windows")]
pub fn current_cursor_shape() -> CursorShape {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, CURSORINFO, CURSOR_SHOWING, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS,
        IDC_HAND, IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENWSE, IDC_SIZENS,
        IDC_SIZEWE, IDC_UPARROW, IDC_WAIT, LoadCursorW,
    };

    /// 标准光标句柄 → 形状映射。进程内句柄恒定，只建一次。
    static MAP: OnceLock<HashMap<isize, CursorShape>> = OnceLock::new();
    let map = MAP.get_or_init(|| {
        let mut m = HashMap::new();
        let mut add = |idc: windows::core::PCWSTR, shape: CursorShape| {
            let h = unsafe { LoadCursorW(None, idc) }.unwrap_or(HCURSOR::default());
            if !h.0.is_null() {
                m.insert(h.0 as isize, shape);
            }
        };
        add(IDC_ARROW, CursorShape::Arrow);
        add(IDC_IBEAM, CursorShape::IBeam);
        add(IDC_WAIT, CursorShape::Wait);
        add(IDC_CROSS, CursorShape::Cross);
        add(IDC_SIZENWSE, CursorShape::SizeNwse);
        add(IDC_SIZENESW, CursorShape::SizeNesw);
        add(IDC_SIZENS, CursorShape::SizeNs);
        add(IDC_SIZEWE, CursorShape::SizeWe);
        add(IDC_SIZEALL, CursorShape::SizeAll);
        add(IDC_NO, CursorShape::No);
        add(IDC_HAND, CursorShape::Hand);
        add(IDC_APPSTARTING, CursorShape::AppStarting);
        add(IDC_UPARROW, CursorShape::UpArrow);
        m
    });

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err() {
            return CursorShape::Unknown;
        }
        // CURSOR_SHOWING = 光标可见；置 0 说明远端把光标藏了
        if (ci.flags.0 & CURSOR_SHOWING.0) == 0 {
            return CursorShape::Hidden;
        }
        let key = ci.hCursor.0 as isize;
        map
            .get(&key)
            .copied()
            .unwrap_or(CursorShape::Unknown)
    }
}

/// 非 Windows 平台恒 Unknown（不参与推流协议时不会被调用）。
#[cfg(not(target_os = "windows"))]
pub fn current_cursor_shape() -> CursorShape {
    CursorShape::Unknown
}

/// 注入结果。
#[derive(Debug, Clone, Serialize)]
pub struct InjectResult {
    pub ok: bool,
    /// UIPI 等失败原因；成功为空串。
    pub error: String,
}

#[cfg(target_os = "windows")]
fn send_inputs(
    inputs: &[windows::Win32::UI::Input::KeyboardAndMouse::INPUT],
) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::SendInput;
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            inputs,
            std::mem::size_of::<windows::Win32::UI::Input::KeyboardAndMouse::INPUT>() as i32,
        )
    };
    if sent as usize != inputs.len() {
        return Err(format!(
            "SendInput 仅注入 {}/{} 个事件（疑似 UIPI 拦截：目标进程完整性级别更高）",
            sent,
            inputs.len()
        ));
    }
    Ok(())
}

/// 键鼠映射用的屏幕区域（与截帧同一坐标系）。
#[derive(Debug, Clone, Copy)]
pub struct ScreenRegion {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl ScreenRegion {
    pub fn virtual_screen() -> Self {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
                SM_YVIRTUALSCREEN,
            };
            let (vw, vh, vx, vy) = unsafe {
                (
                    GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN),
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                )
            };
            Self {
                x: vx,
                y: vy,
                w: vw.max(1),
                h: vh.max(1),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Self {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            }
        }
    }
}

/// 0..=65535 归一化 → 指定区域像素坐标。
#[cfg(target_os = "windows")]
fn map_abs(x: u16, y: u16, region: &ScreenRegion) -> (i32, i32) {
    let vw = region.w.max(1) as i64;
    let vh = region.h.max(1) as i64;
    let px = region.x as i64 + (x as i64 * vw / 65535);
    let py = region.y as i64 + (y as i64 * vh / 65535);
    let max_x = region.x + region.w - 1;
    let max_y = region.y + region.h - 1;
    (
        (px as i32).clamp(region.x, max_x),
        (py as i32).clamp(region.y, max_y),
    )
}

/// 是否 Windows 扩展键（扫描码带 0xE0 前缀的那批）。
///
/// 这类键的 `dwFlags` 必须带 `KEYEVENTF_EXTENDEDKEY`，否则会被解释成小键盘数字键
/// （方向键变小键盘 4/6/8/2 等）。命中集合覆盖方向键 / 编辑键 / Win 键 / 部分 OEM 键。
///
/// ⚠️ 已知取舍：**不放 `0x0D`(Enter)**。前端 `src/lib/rcKeyMap.ts` 把主 Enter 与
/// NumpadEnter 都映射成 `0x0d`，若把 Enter 放进集合，会让主 Enter 被错发 `E0` 前缀，
/// 部分应用/游戏会因此识别成别的键。小键盘 Enter 的取舍由前端侧约定承担。
pub(crate) fn is_extended_vk(vk: u16) -> bool {
    matches!(
        vk,
        // PageUp/PageDown/End/Home
        0x21 | 0x22 | 0x23 | 0x24
        // 方向键 ← ↑ → ↓
        | 0x25 | 0x26 | 0x27 | 0x28
        // Insert / Delete
        | 0x2D | 0x2E
        // Win(L/R) / 右键菜单
        | 0x5B | 0x5C | 0x5D
        // 小键盘除号 / NumLock
        | 0x6F | 0x90
        // PrintScreen
        | 0x2C
        // 右 Ctrl / 右 Alt
        | 0xA3 | 0xA5
    )
}

/// 执行一条输入事件。仅 Windows。
pub fn inject(ev: &InputEvent, region: &ScreenRegion) -> InjectResult {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (ev, region);
        InjectResult {
            ok: false,
            error: "远程键鼠目前仅支持 Windows".into(),
        }
    }
    #[cfg(target_os = "windows")]
    {
        match inject_win(ev, region) {
            Ok(()) => InjectResult {
                ok: true,
                error: String::new(),
            },
            Err(e) => InjectResult {
                ok: false,
                error: e,
            },
        }
    }
}

#[cfg(target_os = "windows")]
fn inject_win(ev: &InputEvent, region: &ScreenRegion) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
        MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

    match ev {
        InputEvent::MouseMove { x, y } => {
            let (px, py) = map_abs(*x, *y, region);
            unsafe {
                SetCursorPos(px, py).map_err(|e| format!("SetCursorPos 失败：{e:?}"))?;
            }
            Ok(())
        }
        InputEvent::MouseButton { x, y, button, down } => {
            // 只有**按下**才重新定位：松开永远发生在当前光标处（OS 语义就是
            // 抬起不挪鼠标）。否则收口补发的 UP（x=0,y=0）会把远端光标瞬移到
            // 左上角；若恰有卡住的右键，右键菜单还会在那里凭空弹出。
            if *down {
                let (px, py) = map_abs(*x, *y, region);
                unsafe {
                    SetCursorPos(px, py).map_err(|e| format!("SetCursorPos 失败：{e:?}"))?;
                }
            }
            let flag = match (button, down) {
                (1, true) => MOUSEEVENTF_LEFTDOWN,
                (1, false) => MOUSEEVENTF_LEFTUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                (2, false) => MOUSEEVENTF_RIGHTUP,
                (3, true) => MOUSEEVENTF_MIDDLEDOWN,
                (3, false) => MOUSEEVENTF_MIDDLEUP,
                _ => return Err(format!("未知鼠标键 {button}")),
            };
            let input = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: flag,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            send_inputs(&[input])
        }
        InputEvent::Wheel { x, y, delta } => {
            let (px, py) = map_abs(*x, *y, region);
            unsafe {
                SetCursorPos(px, py).map_err(|e| format!("SetCursorPos 失败：{e:?}"))?;
            }
            let input = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: *delta as u32,
                        dwFlags: MOUSEEVENTF_WHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            send_inputs(&[input])
        }
        InputEvent::Key { vk, down } => {
            let vk = *vk as u16;
            let mut flags = if *down {
                Default::default()
            } else {
                KEYEVENTF_KEYUP
            };
            // 扩展键（扫描码带 0xE0 前缀，如方向键/Home/End/Win 等）必须带
            // KEYEVENTF_EXTENDEDKEY，否则 Windows 会把它解释成小键盘数字键
            //（方向键变小键盘 4/6/8/2 等）。
            if is_extended_vk(vk) {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(vk),
                        wScan: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            send_inputs(&[input])
        }
        InputEvent::ClipboardPush { text } => set_clipboard_text(text),
        InputEvent::ClipboardPull => Ok(()),
        InputEvent::Ping { .. } => Ok(()),
        InputEvent::NetHint { .. } => Ok(()),
        InputEvent::SetBitratePct { .. } => Ok(()),
        InputEvent::SetQuality { .. }
        | InputEvent::SetCaptureScope { .. }
        | InputEvent::SetCodec { .. }
        | InputEvent::RequestKey => Ok(()),
    }
}

/// 写入系统剪贴板文本。走 arboard（与 paste_engine 同一依赖，带瞬时占用重试）。
#[cfg(target_os = "windows")]
pub fn set_clipboard_text(text: &str) -> Result<(), String> {
    use arboard::Clipboard;
    let mut last = String::new();
    for i in 0..6 {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(40 * i as u64));
        }
        match Clipboard::new() {
            Ok(mut cb) => match cb.set_text(text) {
                Ok(()) => return Ok(()),
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("写入剪贴板失败：{last}"))
}

/// 读系统剪贴板文本（R3 拉回）。
#[cfg(target_os = "windows")]
pub fn get_clipboard_text() -> Result<String, String> {
    use arboard::Clipboard;
    let mut last = String::new();
    for i in 0..6 {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(40 * i as u64));
        }
        match Clipboard::new() {
            Ok(mut cb) => match cb.get_text() {
                Ok(t) => return Ok(t),
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("读取剪贴板失败：{last}"))
}

#[cfg(not(target_os = "windows"))]
pub fn get_clipboard_text() -> Result<String, String> {
    Err("剪贴板拉取目前仅支持 Windows".into())
}

#[cfg(not(target_os = "windows"))]
pub fn set_clipboard_text(_text: &str) -> Result<(), String> {
    Err("剪贴板写入目前仅支持 Windows".into())
}

/// 门禁：会话必须是可控档。service 在调用 inject 前检查。
pub fn assert_control_allowed(capability: crate::rc::protocol::Capability) -> Result<(), String> {
    use crate::rc::protocol::Capability;
    match capability {
        Capability::Control => Ok(()),
        Capability::View => Err("当前会话仅为「只看」，已拒绝键鼠输入".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rc::protocol::Capability;

    #[test]
    fn view_session_rejects_input_gate() {
        assert!(assert_control_allowed(Capability::View).is_err());
        assert!(assert_control_allowed(Capability::Control).is_ok());
    }

    #[test]
    fn input_event_roundtrip() {
        let e = InputEvent::MouseButton {
            x: 1000,
            y: 2000,
            button: 1,
            down: true,
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: InputEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn extended_vk_set() {
        let vks: [u16; 18] = [
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F,
            0x90, 0x2C, 0xA3, 0xA5,
        ];
        for vk in vks {
            assert!(is_extended_vk(vk), "vk {vk:#x} 应为扩展键");
        }
        // Enter(0x0D) 故意不在集合（主 Enter 与 NumpadEnter 同值）；A/Space 也不是
        for vk in [0x41u16, 0x0D, 0x20] {
            assert!(!is_extended_vk(vk), "vk {vk:#x} 不应为扩展键");
        }
    }
}
