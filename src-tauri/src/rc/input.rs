//! 远程键鼠注入（R2）。被控端本地执行 `SendInput`。
//!
//! # 安全
//!
//! - 仅在 `InboundActive` 且会话能力为 `Control` 时由 service 调用
//! - 不信任对端声明的坐标系之外的任何特权；UIPI 拦截要**明确报错**，不静默
//!
//! # 文本
//!
//! 两条路，按长度分：输入法候选串走 [`InputEvent::Text`]（Unicode 逐码元注入，
//! 上限 [`TEXT_MAX_UTF16_UNITS`]）；更长的文本不走逐键注入，走「推剪贴板 →
//! 对端 Ctrl+V」（[`InputEvent::ClipboardPush`]）。

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
    /// 乙-①（2026-09-29）：控端**输入法候选串确认后**的整串文本注入
    ///（`KEYEVENTF_UNICODE`，逐 UTF-16 码元 down/up）。
    ///
    /// 为什么不让逐键 `Key` 穿过去：组合期间的按键（拼音字母）打到对方机器上会
    /// **二次触发对端的输入法**，出来的是拼音字母 + 乱码候选。打字档下前端把
    /// 候选期按键全拦（`src/lib/rcKeyMode.ts` 的 `imeIntercepted`），只在
    /// `compositionend` 发这一条整串——中文这才打得出来。
    ///
    /// 与 [`InputEvent::ClipboardPush`] 的分工：本条注入到**当前焦点控件**，
    /// 不碰剪贴板、不需要对端按 Ctrl+V；超过 [`TEXT_MAX_UTF16_UNITS`] 的长文本
    /// 才该走剪贴板。
    Text {
        text: String,
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
    /// `queue_ms`（2026-09-28）：发起端**帧龄 EMA**——它包含的排队延迟是 pong
    /// RTT 看不见的（AP 队列只挡大帧不挡小 ping）。被控端据此快速减码率。
    /// `frame_loss_pm`：帧粒度丢包率（permille）——靠校验片恢复过 / 整帧丢弃的
    /// 占比，比 conn 级丢包更贴近 WiFi 的突发形态。两者都是 Option（旧对端不带）。
    NetHint {
        rtt_ms: i64,
        #[serde(default)]
        queue_ms: Option<i64>,
        #[serde(default)]
        frame_loss_pm: Option<i64>,
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
    /// 乙-①：控端声明「它的按键按什么口径打在对方机器上」——`"type"`（打字档，
    /// 默认）| `"direct"`（直传档，按扫描码）。
    ///
    /// ❗ **要求 `Control`**：这改的是**对方机器怎么被按键**，与画面范围同量级，
    /// 不是「我自己看什么」（同 `SetCaptureScope` 的 D-2 判据）。
    ///
    /// 被控端只认这两个值，**未知值回落默认档且不报错**：直传没生效只是退回原样，
    /// 而拒收会让用户的键凭空消失。
    ///
    /// 两档的取舍（对标结论：六家都是会话内显式开关，无一做成自动判定）：
    /// - 打字档 `wVk` 注入：按字符翻译，中文可输入，游戏里可能错位；
    /// - 直传档 `KEYEVENTF_SCANCODE`：游戏/快捷键准，中文打不出（候选串不发）。
    SetKeyMode {
        mode: String,
    },
    /// 乙-③：控端要求**锁住被控者本人的物理键鼠**（RustDesk 的 block-input 语义）。
    ///
    /// ❗ **要求 `Control`**，且**还要求被控端本场已授权**（抽屉里勾了「允许对方
    /// 锁定我的输入」）。两重门禁缺一不可：授权不在，这条帧只回一个失败原因给
    /// 发起端，本机一个键都不吞——「远程把人锁在自己机器外面」不能有第二条路径。
    ///
    /// 与 `SetHostMute` 同量级：它动的是**对方屋里那个人能不能操作自己的电脑**。
    /// 线上仍是 `on: bool`（开关只有一个方向，档位留给 `SetKeyMode` 那种多值场景）。
    SetInputLock {
        on: bool,
    },
}

/// 乙-①：按键注入口径（线格式见 [`InputEvent::SetKeyMode`]）。
///
/// 为什么不是 `bool`：档位名是**跨端契约**，将来加第三档（RustDesk 有 map /
/// scancode / translate 三档）时 `bool` 会被迫翻转语义或改默认值，而线上旧值
/// 的含义跟着变——那是最难查的一种不兼容。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyMode {
    /// 打字档：`wVk` 注入（历史行为，默认）。
    #[default]
    VirtualKey,
    /// 直传档：`KEYEVENTF_SCANCODE` + 键盘布局映射出的扫描码。
    ScanCode,
}

impl KeyMode {
    /// 线上字符串 → 档位。**未知值一律回落默认档**（理由见 `SetKeyMode` 的注释）。
    pub fn from_wire(s: &str) -> Self {
        match s {
            "direct" => Self::ScanCode,
            _ => Self::VirtualKey,
        }
    }

    /// 档位 → 线上字符串（与前端 `src/lib/rcKeyMode.ts` 的 `RcKeyMode` 同集合）。
    pub fn wire(self) -> &'static str {
        match self {
            Self::ScanCode => "direct",
            Self::VirtualKey => "type",
        }
    }
}

/// 单次文本注入的上限（UTF-16 码元）。
///
/// IME 候选串远小于它；越界说明对端在把 `text` 当长文本通道用——那种量级该走
/// [`InputEvent::ClipboardPush`]，而不是往输入队列里一次塞上千条 `SendInput`。
pub const TEXT_MAX_UTF16_UNITS: usize = 512;

/// 文本 → 待注入的 UTF-16 码元序列（纯函数，可离线单测）。
///
/// 空串与越界都返回 `Err`，错误串原样回给发起端（`reply_inject_err`）——
/// **不静默截断**：截断出来的半句话被对方发出去，比不发更糟。
/// 代理对（emoji）按码元展开，两个码元各发一次 down/up（与 AutoHotkey 同做法，
/// 目标应用会在同一个编辑控件里拼回一个字）。
pub fn unicode_input_units(text: &str) -> Result<Vec<u16>, String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.is_empty() {
        return Err("没有要发送的文本".into());
    }
    if units.len() > TEXT_MAX_UTF16_UNITS {
        return Err(format!(
            "文本过长（{} 个字符，单次上限 {}），请改走剪贴板",
            units.len(),
            TEXT_MAX_UTF16_UNITS
        ));
    }
    Ok(units)
}

/// 直传档的扫描码方案（纯函数，可离线单测）：
/// `MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC_EX, 当前布局)` 的返回值 → `(wScan, 扩展键)`。
///
/// `None` = 映射不到（当前键盘布局里没有这颗键，例如法语布局没有反引号）
/// ⇒ 调用方**回落 `wVk` 注入**，绝不丢键。
///
/// `VSC_EX` 把扩展前缀放在高位字节（Home → `0xE047`）：这里让 `wScan` **带着前缀**，
/// 同时置 `KEYEVENTF_EXTENDEDKEY`——前者给按扫描码读的应用，后者给按标志位读的应用。
/// 只发标志不发前缀，读原始扫描码的游戏会把方向键认成小键盘 4/6/8/2。
pub fn direct_scan_plan(mapped: u32) -> Option<(u16, bool)> {
    let body = (mapped & 0xFF) as u16;
    if body == 0 {
        return None;
    }
    let prefix = ((mapped >> 8) & 0xFF) as u16;
    let extended = prefix == 0xE0 || prefix == 0xE1;
    Some((if extended { mapped as u16 } else { body }, extended))
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
///
/// `mode` 是乙-① 的按键口径（打字档 = `wVk`，直传档 = 扫描码）。它由**调用方**
/// 传进来（`RcService::key_mode`），不在本模块藏全局：按下与补发的 up 必须用
/// 同一个口径，而 `Pressed::release_all` 是在会话收口处直接调注入的。
pub fn inject(ev: &InputEvent, region: &ScreenRegion, mode: KeyMode) -> InjectResult {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (ev, region, mode);
        InjectResult {
            ok: false,
            error: "远程键鼠目前仅支持 Windows".into(),
        }
    }
    #[cfg(target_os = "windows")]
    {
        match inject_win(ev, region, mode) {
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
fn inject_win(ev: &InputEvent, region: &ScreenRegion, mode: KeyMode) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
        MOUSEINPUT, VIRTUAL_KEY,
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
            // 乙-①：直传档改发扫描码。映射不到（当前布局没这颗键）就回落 `wVk`——
            // 「直传没生效」不能演变成「这颗键打不出去」。
            let mut w_vk = VIRTUAL_KEY(vk);
            let mut w_scan = 0u16;
            if mode == KeyMode::ScanCode {
                if let Some((scan, extended)) = direct_scan_plan(scan_code_of_vk(vk)) {
                    w_vk = VIRTUAL_KEY(0);
                    w_scan = scan;
                    flags |= KEYEVENTF_SCANCODE;
                    if extended {
                        flags |= KEYEVENTF_EXTENDEDKEY;
                    }
                }
            }
            // 扩展键（扫描码带 0xE0 前缀，如方向键/Home/End/Win 等）必须带
            // KEYEVENTF_EXTENDEDKEY，否则 Windows 会把它解释成小键盘数字键
            //（方向键变小键盘 4/6/8/2 等）。两档都要，故在上面的分支之后。
            if is_extended_vk(vk) {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: w_vk,
                        wScan: w_scan,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            send_inputs(&[input])
        }
        InputEvent::Text { text } => {
            // 乙-①：候选串整串按 Unicode 注入。所有 down/up **合成一次 SendInput**：
            // 分批提交时若插进本机物理输入，串就被拆开、字序错乱——那是用户最难
            // 复现的形态（画面里看着对，发出去少半截）。
            let units = unicode_input_units(text)?;
            let mut inputs = Vec::with_capacity(units.len() * 2);
            for u in units {
                for up in [false, true] {
                    inputs.push(INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                // KEYEVENTF_UNICODE 的口径：wVk 必须为 0，字符放 wScan
                                wVk: VIRTUAL_KEY(0),
                                wScan: u,
                                dwFlags: KEYEVENTF_UNICODE
                                    | if up {
                                        KEYEVENTF_KEYUP
                                    } else {
                                        Default::default()
                                    },
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    });
                }
            }
            send_inputs(&inputs)
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
        | InputEvent::SetHostMute { .. }
        // 乙-①：档位本身不注入任何东西，落地是 `RcService::set_key_mode`
        //（在 `inbound.rs` 的流控组里做），这里只是 exhaustive match 的收口。
        | InputEvent::SetKeyMode { .. }
        // 乙-③：同理，它动的是**本机物理键鼠的钩子**（`local_input::set_swallow`），
        // 不是往系统里注键。落地在 `inbound.rs`，这里只收口。
        | InputEvent::SetInputLock { .. } => Ok(()),
    }
}

/// vk → `MAPVK_VK_TO_VSC_EX` 的原始映射值（本机当前键盘布局）。
/// 判据在纯函数 [`direct_scan_plan`] 里，这里只负责问系统。
#[cfg(target_os = "windows")]
fn scan_code_of_vk(vk: u16) -> u32 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayout, MapVirtualKeyExW, MAPVK_VK_TO_VSC_EX,
    };
    // 线程 id 0 = 当前线程的布局。❗ 不去取「前台窗口」的布局：焦点在两个应用
    // 之间切换的瞬间，同一颗键的 down 与 up 会取到不同布局，比统一用本机布局
    // 更容易打出不配对的键。
    unsafe { MapVirtualKeyExW(vk as u32, MAPVK_VK_TO_VSC_EX, GetKeyboardLayout(0)) }
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
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

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

    /// 乙-① 线格式守卫：`text` / `set_key_mode` 的键名与前端
    /// `src/lib/api/rcFrameTypes.ts` 的 union 一致。改了这里 = 跨端静默无效
    ///（旧被控端把不认识的 `kind` 落在 match 的 `_` 上，一声不吭）。
    #[test]
    fn 乙1_文本与键盘模式线格式钉住() {
        let v = serde_json::to_value(InputEvent::Text {
            text: "熊猫".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "text");
        assert_eq!(v["text"], "熊猫");
        let back: InputEvent = serde_json::from_value(v).unwrap();
        assert_eq!(
            back,
            InputEvent::Text {
                text: "熊猫".into()
            }
        );

        let m = serde_json::to_value(InputEvent::SetKeyMode {
            mode: "direct".into(),
        })
        .unwrap();
        assert_eq!(m["kind"], "set_key_mode");
        assert_eq!(m["mode"], "direct");
        let backm: InputEvent = serde_json::from_value(m).unwrap();
        assert_eq!(
            backm,
            InputEvent::SetKeyMode {
                mode: "direct".into()
            }
        );
    }

    /// 乙-③ 线格式守卫：`set_input_lock` 的键名与前端 `rcFrameTypes.ts` 的 union
    /// 一致。这条改错的失败形态最坏：**发起端点了「锁定对方」而对面毫无反应**
    ///（旧被控端把不认识的 `kind` 落在 match 的 `_` 上，一声不吭）。
    #[test]
    fn 乙3_输入锁定线格式钉住() {
        let v = serde_json::to_value(InputEvent::SetInputLock { on: true }).unwrap();
        assert_eq!(v["kind"], "set_input_lock");
        assert_eq!(v["on"], true);
        let back: InputEvent = serde_json::from_value(v).unwrap();
        assert_eq!(back, InputEvent::SetInputLock { on: true });
        // 解除那一档同样要能往返（bool 反了 = 锁上就解不开）
        let v2 = serde_json::to_value(InputEvent::SetInputLock { on: false }).unwrap();
        let back2: InputEvent = serde_json::from_value(v2).unwrap();
        assert_eq!(back2, InputEvent::SetInputLock { on: false });
    }

    /// 乙-① 档位判据：只有 `direct` 是直传，**其它一切值（含脏值 / 缺省）回落打字档**。
    /// 失败形态必须是「直传没生效」而不是「键打不出去」。
    #[test]
    fn 乙1_键盘模式未知值回落打字档() {
        assert_eq!(KeyMode::from_wire("direct"), KeyMode::ScanCode);
        for s in ["type", "", "Direct", "scancode", "自动"] {
            assert_eq!(KeyMode::from_wire(s), KeyMode::VirtualKey, "{s} 必须是打字档");
        }
        assert_eq!(KeyMode::default(), KeyMode::VirtualKey);
        // wire 是 from_wire 的逆（两档都能 round-trip，否则控端收了读不回来）
        for m in [KeyMode::VirtualKey, KeyMode::ScanCode] {
            assert_eq!(KeyMode::from_wire(m.wire()), m);
        }
    }

    /// 乙-① 文本上限判据：空串与越界必须**报错**，不静默截断。
    #[test]
    fn 乙1_文本注入序列_空与超限都拒() {
        assert_eq!(unicode_input_units("AB"), Ok(vec![0x41, 0x42]));
        let zh: Vec<u16> = "中".encode_utf16().collect();
        assert_eq!(unicode_input_units("中"), Ok(zh));
        // 代理对：一个 emoji = 两个码元（各发一对 down/up，见函数注释）
        assert_eq!(unicode_input_units("🐼").unwrap().len(), 2);
        assert!(unicode_input_units("").is_err(), "空串必须拒，不能让注入静默成功");
        let big = "啊".repeat(TEXT_MAX_UTF16_UNITS + 1);
        let err = unicode_input_units(&big).unwrap_err();
        assert!(err.contains("512"), "错误里要带上限，用户才知道怎么绕：{err}");
        assert_eq!(
            unicode_input_units(&"啊".repeat(TEXT_MAX_UTF16_UNITS)).unwrap().len(),
            TEXT_MAX_UTF16_UNITS,
            "恰好到上限必须放行"
        );
    }

    /// 乙-① 直传档扫描码判据：`MAPVK_VK_TO_VSC_EX` 的三种返回值。
    /// 0 = 当前布局没这颗键 → 回落 `wVk`；带 E0/E1 前缀 → 前缀留在 `wScan`
    /// 且报扩展键（漏了标志位，游戏把方向键认成小键盘 4/6/8/2）。
    #[test]
    fn 乙1_扫描码方案_前缀与回落都判对() {
        // A：普通键，无前缀
        assert_eq!(direct_scan_plan(0x1E), Some((0x1E, false)));
        // Home：VSC_EX 返回 0xE047
        assert_eq!(direct_scan_plan(0xE047), Some((0xE047, true)));
        // Pause 一类：E1 前缀
        assert_eq!(direct_scan_plan(0xE145), Some((0xE145, true)));
        // 映射不到（整值 0）与「只有前缀没有正文」都必须回落
        assert_eq!(direct_scan_plan(0), None);
        assert_eq!(direct_scan_plan(0xE000), None);
    }
}
