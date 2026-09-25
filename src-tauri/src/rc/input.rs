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
    /// G3：发起端开关系统声音（音频流）。会话中切换，被控端以可见提示回显
    ///（emit_stream_note，同画质变更的 Q10 通道）。不注入本机、不要求 Control。
    AudioOn {
        on: bool,
    },
    /// G3-C：发起端要求把**被控端主机扬声器**静音 / 恢复（本地外放闭嘴）。
    ///
    /// ❗ **要求 `Control`**：这改的是被控端的**物理输出环境**（屋里人听不听得到），
    /// 与「改画质档」那类只影响发起端自己画面的指令不同——「只看」会话不该能
    /// 悄悄关掉对方的喇叭。与键鼠注入同为「操作对方机器」量级。
    ///
    /// 不影响环回采集：WASAPI 抽头在端点静音之前，音频照常串过来（见 `audio.rs`）。
    SetHostMute {
        on: bool,
    },
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

/// 🔴 B8（2026-09-25 审计）：region 内归一化坐标 → 虚拟桌面像素 → 虚拟桌面
/// 0..=65535 归一化。第一段与 [`map_abs`] 同一套公式，保证「预览的光标在哪、
/// 点击就落在哪」；第二段是 `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK`
/// 要求的口径——**不带 VIRTUALDESK 的 ABSOLUTE 按主屏归一化**，多屏 +
/// 负坐标（左/上侧副屏）会被折进主屏范围，点错屏。
/// `desk` 由调用方给 [`ScreenRegion::virtual_screen`]（SM_XVIRTUALSCREEN 等），
/// 本函数保持纯函数、可离线单测。
#[cfg(target_os = "windows")]
fn abs_to_virtual_desk(x: u16, y: u16, region: &ScreenRegion, desk: &ScreenRegion) -> (i32, i32) {
    let (px, py) = map_abs(x, y, region);
    (
        pixel_to_abs(px, desk.x, desk.w),
        pixel_to_abs(py, desk.y, desk.h),
    )
}

/// 像素 → 0..=65535（按 `origin + span` 的范围归一化）。
/// 与 [`map_abs`] 的正向公式互为近似逆，边缘舍入误差 ≤1 像素，对点击无感。
#[cfg(target_os = "windows")]
fn pixel_to_abs(p: i32, origin: i32, span: i32) -> i32 {
    if span <= 1 {
        return 0;
    }
    let rel = (p - origin).clamp(0, span - 1);
    ((rel as i64 * 65_535) / (span as i64 - 1)) as i32
}

/// 🔴 B9（2026-09-25 审计）：`InputEvent::Key` 的 vk 收敛——线上是 u32，
/// `SendInput` 只要 u16。**所有**消费点（入站注入、按下追踪、会话收口补发）
/// 都必须先过这里拿同一个值，禁止「注入处 `as u16` 截断、别处用原值」的分叉
///（旧写法下畸形 vk >0xFFFF 会按 A 松 A 卡键：down 记 0x10041、up 来 0x41
/// 查不到配对）。收不下的返回 `None`，调用方丢弃该事件并走 `inject_err` 上报。
pub fn converge_key_vk(vk: u32) -> Option<u16> {
    u16::try_from(vk).ok()
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
        KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
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
            let flag = match (button, down) {
                (1, true) => MOUSEEVENTF_LEFTDOWN,
                (1, false) => MOUSEEVENTF_LEFTUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                (2, false) => MOUSEEVENTF_RIGHTUP,
                (3, true) => MOUSEEVENTF_MIDDLEDOWN,
                (3, false) => MOUSEEVENTF_MIDDLEUP,
                _ => return Err(format!("未知鼠标键 {button}")),
            };
            // 🔴 B8（2026-09-25 审计）：定位与点击**合成同一次 SendInput**。
            // 旧实现 SetCursorPos + 另发一次 SendInput，两步之间本机物理鼠标
            // 一动，点击就落在被抢跑后的位置。现在按下事件自带
            // ABSOLUTE|VIRTUALDESK 归一化坐标，一次注入完成「移过去 + 按下」。
            // ❗ 只有**按下**才带坐标：松开永远发生在当前光标处（OS 语义就是
            // 抬起不挪鼠标），否则收口补发的 UP（x=0,y=0）在 ABSOLUTE 语义下
            // 会把远端光标瞬移到左上角；若恰有卡住的右键，右键菜单还会在
            // 那里凭空弹出。
            let mi = if *down {
                let desk = ScreenRegion::virtual_screen();
                let (ax, ay) = abs_to_virtual_desk(*x, *y, region, &desk);
                MOUSEINPUT {
                    dx: ax,
                    dy: ay,
                    mouseData: 0,
                    dwFlags: flag | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    time: 0,
                    dwExtraInfo: 0,
                }
            } else {
                MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flag,
                    time: 0,
                    dwExtraInfo: 0,
                }
            };
            send_inputs(&[INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi },
            }])
        }
        InputEvent::Wheel { x, y, delta } => {
            // 🔴 B8：与 MouseButton 同理——定位与滚轮合成一次注入，
            // 杜绝「定位了却滚在别处」的抢跑窗口。
            let desk = ScreenRegion::virtual_screen();
            let (ax, ay) = abs_to_virtual_desk(*x, *y, region, &desk);
            let input = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: ax,
                        dy: ay,
                        mouseData: *delta as u32,
                        dwFlags: MOUSEEVENTF_WHEEL | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            send_inputs(&[input])
        }
        InputEvent::Key { vk, down } => {
            // 🔴 B9（2026-09-25 审计）：vk 先收敛再注入。旧实现 `*vk as u16`
            // 静默截断，与按下追踪的 u32 原值分叉（按 A 松 A 卡键的根源）。
            // 入口（inbound.rs）已拦一道，这里再拦是纵深：收口补发等旁路
            // 也走 inject，同样不得截断。
            let Some(vk) = converge_key_vk(*vk) else {
                return Err(format!("无效的按键值 vk={}（超出 0..=65535），已丢弃", vk));
            };
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
        | InputEvent::RequestKey
        | InputEvent::AudioOn { .. }
        // G3-C：不注入键鼠（由 `inbound.rs` 直接调端点音量接口处理）
        | InputEvent::SetHostMute { .. } => Ok(()),
    }
}

/// 写入系统剪贴板文本。走 arboard（与 paste_engine 同一依赖，带瞬时占用重试）。
///
/// 同步入口（`inject` 等）。**async 上下文必须走 `set_clipboard_text_async`**——
/// 这里的 `thread::sleep` 重试会占死 tokio worker。
#[cfg(target_os = "windows")]
pub fn set_clipboard_text(text: &str) -> Result<(), String> {
    use arboard::Clipboard;
    let mut last = String::new();
    for i in 0..6 {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(clipboard_retry_delay_ms(i)));
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

/// 读系统剪贴板文本（R3 拉回）。async 上下文请用 `get_clipboard_text_async`。
#[cfg(target_os = "windows")]
pub fn get_clipboard_text() -> Result<String, String> {
    use arboard::Clipboard;
    let mut last = String::new();
    for i in 0..6 {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(clipboard_retry_delay_ms(i)));
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

/// 剪贴板占用重试的退避（纯函数，可单测）。第 i 次失败后等 `40 * i` ms。
pub fn clipboard_retry_delay_ms(attempt: u32) -> u64 {
    40u64 * u64::from(attempt)
}

/// async 包装：把带 sleep 重试的剪贴板写入丢进 blocking 池，不占 tokio worker。
pub async fn set_clipboard_text_async(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_clipboard_text(&text))
        .await
        .map_err(|e| format!("剪贴板写入任务失败：{e}"))?
}

/// async 包装：同上，读方向。
pub async fn get_clipboard_text_async() -> Result<String, String> {
    tokio::task::spawn_blocking(get_clipboard_text)
        .await
        .map_err(|e| format!("剪贴板读取任务失败：{e}"))?
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
    fn 剪贴板重试退避按40ms递增() {
        assert_eq!(clipboard_retry_delay_ms(0), 0);
        assert_eq!(clipboard_retry_delay_ms(1), 40);
        assert_eq!(clipboard_retry_delay_ms(5), 200);
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

    /// 🔴 B9（2026-09-25 审计）守卫：vk 收敛是唯一口径——0..=65535 收，
    /// 超出一律拒。旧实现注入处 `as u16` 静默截断（0x1_0041 → 0x41），
    /// 畸形 vk 会「按 A 松 A 卡键」。
    #[test]
    fn vk收敛_超0xFFFF必须拒_b9() {
        assert_eq!(converge_key_vk(0), Some(0));
        assert_eq!(converge_key_vk(0x41), Some(0x41));
        assert_eq!(converge_key_vk(0xFFFF), Some(0xFFFF));
        assert_eq!(
            converge_key_vk(0x1_0000),
            None,
            "0x1_0000 截断成 0 正是缺陷本体，必须拒"
        );
        assert_eq!(converge_key_vk(0x1_0041), None, "0x1_0041 截断成 0x41（A）会卡键");
        assert_eq!(converge_key_vk(u32::MAX), None);
    }

    /// 🔴 B8（2026-09-25 审计）守卫：归一化 → 虚拟桌面换算的边界与回代。
    /// 区域 = 虚拟桌面时两端必须精确铺满 0..=65535；子区域（单屏）换算结果
    /// 回代后必须落回目标像素（±1 像素舍入）——「预览在哪、点击就落在哪」。
    #[cfg(target_os = "windows")]
    #[test]
    fn 鼠标绝对坐标换算_两端铺满且回代落点一致_b8() {
        let desk = ScreenRegion::virtual_screen();
        let (ax0, ay0) = abs_to_virtual_desk(0, 0, &desk, &desk);
        let (ax1, ay1) = abs_to_virtual_desk(65535, 65535, &desk, &desk);
        assert_eq!((ax0, ay0), (0, 0), "左上角必须精确为 0（负原点偏移要被剥掉）");
        assert_eq!((ax1, ay1), (65535, 65535), "右下角必须精确为 65535");
        // 单屏子区域：换算仍落在 0..=65535，回代像素与 map_abs 目标一致
        let region = ScreenRegion {
            x: desk.x,
            y: desk.y,
            w: (desk.w / 2).max(1),
            h: (desk.h / 2).max(1),
        };
        for &(x, y) in &[(0u16, 0u16), (32768, 16384), (65535, 65535)] {
            let (ax, ay) = abs_to_virtual_desk(x, y, &region, &desk);
            assert!((0..=65535).contains(&ax) && (0..=65535).contains(&ay));
            let px = desk.x + (ax as i64 * desk.w as i64 / 65535) as i32;
            let py = desk.y + (ay as i64 * desk.h as i64 / 65535) as i32;
            let (want_x, want_y) = map_abs(x, y, &region);
            assert!(
                (px - want_x).abs() <= 1 && (py - want_y).abs() <= 1,
                "x={x},y={y}: 回代 ({px},{py}) 与目标 ({want_x},{want_y}) 偏差 >1px"
            );
        }
    }

    /// G3-C：线上键名是 JSON，改了它新旧版本就对不上（失败形态是**静默无效**——
    /// 旧被控端把不认识的 `kind` 落在 match 的 `_` 上，一声不吭）。
    #[test]
    fn set_host_mute_线格式钉住() {
        let v = serde_json::to_value(InputEvent::SetHostMute { on: true }).unwrap();
        assert_eq!(v["kind"], "set_host_mute");
        assert_eq!(v["on"], true);
        let back: InputEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back, InputEvent::SetHostMute { on: true });
        // 关的那一档也要能往返（bool 编码反了会「只能静音、恢复不了」）
        let v2 = serde_json::to_value(InputEvent::SetHostMute { on: false }).unwrap();
        let back2: InputEvent = serde_json::from_value(v2).unwrap();
        assert_eq!(back2, InputEvent::SetHostMute { on: false });
    }
}
