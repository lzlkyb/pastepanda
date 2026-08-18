//! 原生置顶图片窗口（Windows GDI DIB Section 渲染）
//! 不依赖 WebView，直接创建 Win32 窗口 + GDI 双缓冲绘制图片
//! 支持：鼠标滚轮缩放、拖拽移动、ESC/右键关闭

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use image::GenericImageView;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EndPaint,
    InvalidateRect, SelectObject, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HBITMAP, HBRUSH, PAINTSTRUCT, SRCCOPY,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, VK_0, VK_CONTROL, VK_ESCAPE, VK_F, VK_R, VK_T, VK_V,
};
/// `WM_MOUSELEAVE`（winuser.h，值固定为 0x02A3）。
///
/// 本版 windows-rs 没有导出这个常量（TrackMouseEvent 一族在 KeyboardAndMouse，
/// 但消息号两个模块里都没有），所以自己声明。
///
/// ❗ 必须是个**常量**：match 里写一个未声明的名字当模式，Rust 会把它当成 catch-all 绑定，
/// 那条分支会吞掉后面所有消息，而编译器只给一条 unused_variables 警告
/// （这个坑在本文件的 WM_TIMER 上刚踩过一次）。
const WM_MOUSELEAVE: u32 = 0x02A3;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetMessageW,
    GetWindowLongPtrW, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassW,
    SetWindowLongPtrW, ShowWindow, TranslateMessage, CS_DBLCLKS, CS_DROPSHADOW, CS_HREDRAW,
    CS_VREDRAW,
    CW_USEDEFAULT,
    GWLP_USERDATA, IDC_ARROW, MSG, SW_SHOW, WM_CLOSE, WM_CREATE, WM_DESTROY, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_TIMER,
    WM_PAINT, WM_RBUTTONUP, WM_SIZE, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_POPUP, WS_VISIBLE,
};

/// 窗口运行时状态
struct WindowState {
    pixels: Vec<u8>,
    img_width: u32,
    img_height: u32,
    scale: f32,
    offset_x: f32,
    offset_y: f32,
    dragging: bool,
    drag_start_x: i32,
    drag_start_y: i32,
    drag_start_off_x: f32,
    drag_start_off_y: f32,
    hbitmap: Option<HBITMAP>,
    dib_bits: Option<*mut u8>,
    last_width: i32,
    last_height: i32,
    /// 窗口透明度（255 = 不透明，T 键循环切换），SetLayeredWindowAttributes 生效
    alpha: u8,
    /// 该窗口的代际号，用于在 WM_DESTROY 中判断这是否仍是当前被跟踪的窗口
    generation: u64,
    /// 旋转角度（0 / 90 / 180 / 270），R 键每次 +90
    rotation: u16,
    /// 水平翻转（左右镜像）
    flip_h: bool,
    /// 垂直翻转（上下镜像）
    flip_v: bool,
    /// 关闭按钮是否可见（鼠标在顶部条带里）。
    close_visible: bool,
    /// 鼠标是否正压在关闭按钮上（压着变红）。
    close_hot: bool,
    /// HUD 要显示的一次性文字（None = 显示默认的 缩放% / 角度 / 透明度）。
    /// 「复制文字」这类异步动作用它回报结果——贴图窗是纯 Win32 窗口，没有 toast 组件，
    /// 复用 HUD 这块地方比新造一套浮层划算。
    hud_text: Option<String>,
    /// 本次拖拽是「平移图片」（按下时按着 Ctrl）还是「移动窗口」（裸拖）。
    pan_mode: bool,
    /// 鼠标是否悬停在窗口上（描边平时极淡、hover / 拖动时变亮）。
    /// 靠 TrackMouseEvent 申请 WM_MOUSELEAVE 来复位——不申请的话鼠标移出去不会有任何消息，
    /// 描边会一直亮着。
    hover: bool,
    /// 底部 HUD（缩放% / 角度 / 透明度）的展示截止时间。
    ///
    /// ❌ HUD 不能常驻：用户钉一张图是为了看**图**，在上面永久压一行白字
    /// （而且关不掉、浅色图上还看不见）是干扰。只在刚改过缩放/角度/透明度
    /// 后短暂显示，到时由 HUD_TIMER_ID 定时器触发一次重绘自行消失。
    hud_until: Option<std::time::Instant>,
}

/// HUD 自动隐藏的定时器 id（仅本窗口内唯一即可）
const HUD_TIMER_ID: usize = 1;
/// HUD 停留时长（毫秒）
const HUD_SHOW_MS: u32 = 1500;

/// 标记「刚改过参数」：HUD 显示一段时间，并排一个定时器到期后重绘抹掉它。
unsafe fn touch_hud(hwnd: HWND, state: &mut WindowState) {
    use windows::Win32::UI::WindowsAndMessaging::SetTimer;
    state.hud_until =
        Some(std::time::Instant::now() + std::time::Duration::from_millis(HUD_SHOW_MS as u64));
    // 重复 SetTimer 同一个 id = 重新计时（Win32 语义），正好是我们要的防抖
    SetTimer(hwnd, HUD_TIMER_ID, HUD_SHOW_MS + 100, None);
}

/// 让 HUD 立刻显示一段文字（同步调用，必须在窗口线程上）。
unsafe fn flash_hud(hwnd: HWND, text: &str) {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if ptr == 0 {
        return;
    }
    let state = &mut *(ptr as *mut WindowState);
    state.hud_text = Some(text.to_string());
    touch_hud(hwnd, state);
    let _ = InvalidateRect(hwnd, None, false);
}

/// 后台线程回报一段 HUD 文字。
///
/// 通过 Box 指针经 lparam 传字符串：窗口线程收到后 `Box::from_raw` 收回所有权。
/// PostMessage 失败（窗口已销毁）时就地回收，不泄漏。
fn post_toast(hwnd_val: isize, msg: String) {
    use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
    let raw = Box::into_raw(Box::new(msg));
    unsafe {
        if PostMessageW(
            HWND(hwnd_val as *mut _),
            WM_PINNED_TOAST,
            WPARAM(0),
            LPARAM(raw as isize),
        )
        .is_err()
        {
            // 窗口没了，把刚 leak 出去的 String 收回来
            drop(Box::from_raw(raw));
        }
    }
}

/// 对贴图跑一次 OCR，返回全文。优先命中库里的缓存（同一张图第二次点是瞬时的）。
fn ocr_pinned_text(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    use tauri::Manager;
    // 缓存 key 必须是原始 path（与 history.content 同源），不能用 canonicalize 结果 ——
    // Windows 上后者带 \?\ 前缀，两端对不上就永远查不到（commands/images.rs 已踩过）。
    if let Some(store) = app.try_state::<crate::data_store::DataStore>() {
        if let Ok(Some(cached)) = store.get_ocr_text(path) {
            return Ok(cached);
        }
    }
    let text = crate::commands::ocr_full_text(path)?;
    if let Some(store) = app.try_state::<crate::data_store::DataStore>() {
        // 写缓存失败只跳过，不影响这次的结果
        let _ = store.set_ocr_text(path, &text);
    }
    Ok(text)
}

/// 文本写剪贴板。走 PasteEngine 的收口方法（带重试，剪贴板是全局互斥资源）。
fn copy_text_to_clipboard(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    use tauri::Manager;
    let eng = app
        .try_state::<crate::paste_engine::PasteEngine>()
        .ok_or_else(|| "PasteEngine 未注册".to_string())?;
    eng.copy_only(text)
}

unsafe impl Send for WindowState {}
unsafe impl Sync for WindowState {}

/// 当前置顶窗口的身份标识（HWND 数值 + 单调递增代际号）。
///
/// 用 Mutex 记录“当前唯一存活的置顶窗口是谁”，取代原先仅用一个 AtomicBool
/// 表示“是否有窗口在跑”的做法：布尔值无法区分“哪一个”窗口，导致任意一个
/// 窗口（哪怕已经被替换掉）的 WM_DESTROY 都会把标志错误地清成 false，
/// 且原逻辑在“已有窗口运行”时只打日志，并没有真正阻止/替换创建新窗口。
#[derive(Clone)]
struct PinnedWindowHandle {
    hwnd: isize,
    generation: u64,
    /// 贴图图片路径（V6.19 贴图管理面板用）
    path: String,
}

// HWND 只是一个句柄数值，跨线程传递该数值本身是安全的
unsafe impl Send for PinnedWindowHandle {}

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static CURRENT_WINDOW: Mutex<Vec<PinnedWindowHandle>> = Mutex::new(Vec::new());

const CLASS_NAME: &str = "PinnedImageWindow";

/// 跨线程变换指令（管理面板按 path 旋转/翻转）：wparam 编码 1=旋转90° 2=水平翻转 3=垂直翻转 4=恢复
const WM_TRANSFORM_PINNED: u32 = 0x0400 + 100;
/// 后台线程 → 窗口线程：显示一段 HUD 文字（lparam 是 Box<String> 的裸指针）
const WM_PINNED_TOAST: u32 = 0x0400 + 101;

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn make_bitmap_info(w: i32, h: i32) -> BITMAPINFO {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    bmi
}

/// 绘制包围盒（旋转后图实际占的像素尺寸）：旋转 90/270 时宽高互换
fn effective_box(state: &WindowState) -> (i32, i32) {
    let draw_w = (state.img_width as f32 * state.scale).round().max(1.0) as i32;
    let draw_h = (state.img_height as f32 * state.scale).round().max(1.0) as i32;
    if state.rotation % 180 != 0 {
        (draw_h, draw_w)
    } else {
        (draw_w, draw_h)
    }
}

/// 用 DIB 像素数据填充缓冲区（最近邻采样 + RGBA→BGRA + 旋转/翻转变换）
/// 圆角半径（逻辑像素）。**裁剪与描边共用它**，所以两者天然严丝合缝。
///
/// 为什么不用 DWM 的圆角：`DWMWCP_ROUNDSMALL` 已经是 DWM 最小的档，再小没有，
/// 而它对截图来说仍然偏大——圆角是**真的把角上的像素裁掉**，贴图的四个角有内容时就是丢内容。
/// 而且 DWM 的实际半径没有公开 API 可查，描边只能取个"略大"的值去凑，永远对不齐。
/// 自己用 SetWindowRgn 裁，半径完全可控（见 apply_round_region）。
///
/// 代价：区域裁剪是二值的，圆弧带一点锯齿（DWM 那条是合成器级、带抗锯齿）。
/// 半径只有 4 dip 时锯齿也就 1~2 个像素台阶，换来的是"不多啃内容"。
const CORNER_RADIUS_DIP: f32 = 4.0;

/// 平时描边的不透明度（与底图做 alpha 混合）；hover / 拖动时升到 1.0。
const BORDER_ALPHA_IDLE: f32 = 0.35;

/// 把一帧完整画进 DIB：底图 + 描边 + 关闭按钮。
///
/// ❗ 这三件事必须**成套**做：`fill_buffer` 会覆写整块 DIB，谁在它之后漏了补描边/按钮，
/// 那一帧就没有它们。
/// ❌ 旧写法把 draw_border 只放在「重建 DIB」那一支，而 hover 触发的重绘走的是
/// 「尺寸未变」那一支（只调 fill_buffer）—— 于是描边在第一次重绘后就被擦掉、
/// 关闭按钮**永远不出现**（用户反馈的「X 没有显示出来」正是这个）。
/// 收口成一个函数之后，两支各调一次，不可能再漏。
unsafe fn paint_frame(hwnd: HWND, buf: &mut [u8], w: i32, h: i32, state: &WindowState) {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    let scale = GetDpiForWindow(hwnd).max(96) as f32 / 96.0;
    fill_buffer(buf, w, h, state);
    draw_border(
        buf,
        w,
        h,
        CORNER_RADIUS_DIP * scale,
        state.hover || state.dragging,
    );
    if state.close_visible {
        draw_close_button(buf, w, h, scale, state.close_hot);
    }
}

/// 按 CORNER_RADIUS_DIP 把窗口裁成小圆角矩形。
///
/// ❗ 每次尺寸变化都要重设：窗口区域是按窗口坐标定的，不会随 resize 自动缩放，
/// 不重设的话放大后四个角会缺一块、缩小后圆角跑到画面里面去。所以 WM_SIZE 里也调它。
/// SetWindowRgn **接管** region 的所有权，调用后不能再 DeleteObject。
unsafe fn apply_round_region(hwnd: HWND) {
    // SetWindowRgn 在 Gdi 模块（不在 WindowsAndMessaging）
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    let mut rc = RECT::default();
    if GetClientRect(hwnd, &mut rc).is_err() {
        return;
    }
    let (w, h) = (rc.right - rc.left, rc.bottom - rc.top);
    if w <= 0 || h <= 0 {
        return;
    }
    let scale = GetDpiForWindow(hwnd).max(96) as f32 / 96.0;
    // CreateRoundRectRgn 的后两个参数是**椭圆的宽高**，即直径 = 2r
    let d = ((CORNER_RADIUS_DIP * scale).round() as i32 * 2).max(2);
    // 右/下边界是开区间，要 +1 才盖满最后一行/列
    let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, d, d);
    if !rgn.is_invalid() {
        SetWindowRgn(hwnd, rgn, true);
    }
}

/// 关闭按钮直径与边距（逻辑像素，跟 DPI 缩放 —— 可点目标是感知量，写死物理像素在高 DPI 屏上会小到点不准）
const CLOSE_BTN_DIP: f32 = 20.0;
const CLOSE_MARGIN_DIP: f32 = 7.0;

/// 关闭按钮的圆心与半径（物理像素）。窗口太小就返回 None（按钮会盖掉整张图）。
///
/// ❗ 绘制与命中测试**都走这一个函数**：各算一遍的话，看到的 X 和点得到的 X 会错位，
/// 而这种错位在小窗口 / 高 DPI 下才显形，最难查（规则 11：公共函数收口）。
fn close_button(buf_w: i32, buf_h: i32, scale: f32) -> Option<(f32, f32, f32)> {
    let r = CLOSE_BTN_DIP * scale * 0.5;
    let m = CLOSE_MARGIN_DIP * scale;
    // 窗口至少要能容下「按钮 + 两侧边距」，且高度也够，否则按钮会压满画面
    if (buf_w as f32) < (r * 2.0 + m * 2.0) * 2.0 || (buf_h as f32) < (r * 2.0 + m * 2.0) {
        return None;
    }
    Some((buf_w as f32 - m - r, m + r, r))
}

/// 鼠标是否落在「顶部条带」里 —— 只有在这里才显示关闭按钮。
///
/// 为什么不是「hover 就显示」：X 是盖在图上的，一直挂着会挡内容。
/// 贴到顶部才出现，与「顶栏」这个通用心智一致，也不影响看图。
fn in_top_band(my: i32, buf_h: i32, scale: f32) -> bool {
    let band = (CLOSE_BTN_DIP + CLOSE_MARGIN_DIP * 3.0) * scale;
    my >= 0 && (my as f32) < band.min(buf_h as f32)
}

/// 画关闭按钮：圆底 + 白色 X，按覆盖率做抗锯齿。
///
/// 与描边同理，画在 DIB 像素上而不是用 GDI —— `LWA_ALPHA` 让 alpha 通道失效，
/// 画笔画不出半透明圆底（见 draw_border 的注释）。
fn draw_close_button(buf: &mut [u8], buf_w: i32, buf_h: i32, scale: f32, hot: bool) {
    let Some((cx, cy, r)) = close_button(buf_w, buf_h, scale) else {
        return;
    };
    // 悬停在按钮上时变红（Windows 关闭按钮的通用语言），平时是中性深色
    let (br, bg, bb, ba) = if hot {
        (0xE5u32, 0x48u32, 0x4Du32, 0.95f32)
    } else {
        (0x1Au32, 0x1Eu32, 0x28u32, 0.55f32)
    };
    let arm = r * 0.38; // X 的臂长
    let half_stroke = (1.1 * scale).max(1.0);
    let x0 = (cx - r - 1.0).floor().max(0.0) as i32;
    let x1 = (cx + r + 1.0).ceil().min(buf_w as f32) as i32;
    let y0 = (cy - r - 1.0).floor().max(0.0) as i32;
    let y1 = (cy + r + 1.0).ceil().min(buf_h as f32) as i32;
    for y in y0..y1 {
        for x in x0..x1 {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            // 圆边缘 1px 淡出
            let cov = if dist <= r - 1.0 {
                1.0
            } else if dist < r {
                r - dist
            } else {
                continue;
            };
            let i = ((y * buf_w + x) * 4) as usize;
            if i + 3 >= buf.len() {
                continue;
            }
            // 先铺圆底
            let a = ba * cov;
            let inv = 1.0 - a;
            let mut pb = buf[i] as f32 * inv + bb as f32 * a;
            let mut pg = buf[i + 1] as f32 * inv + bg as f32 * a;
            let mut pr = buf[i + 2] as f32 * inv + br as f32 * a;
            // 再叠白色 X：两条对角线到点的距离有解析式（|dx∓dy|/√2），不用逐段求距离
            if dx.abs() <= arm && dy.abs() <= arm {
                let d1 = (dx - dy).abs() * std::f32::consts::FRAC_1_SQRT_2;
                let d2 = (dx + dy).abs() * std::f32::consts::FRAC_1_SQRT_2;
                let dmin = d1.min(d2);
                let xa = if dmin <= half_stroke - 0.5 {
                    1.0
                } else if dmin < half_stroke + 0.5 {
                    half_stroke + 0.5 - dmin
                } else {
                    0.0
                } * cov;
                if xa > 0.0 {
                    let xinv = 1.0 - xa;
                    pb = pb * xinv + 255.0 * xa;
                    pg = pg * xinv + 255.0 * xa;
                    pr = pr * xinv + 255.0 * xa;
                }
            }
            buf[i] = pb as u8;
            buf[i + 1] = pg as u8;
            buf[i + 2] = pr as u8;
        }
    }
}

/// 圆角矩形的有符号距离：< 0 在内部，== 0 在边界上，> 0 在外部。
fn round_rect_sdf(px: f32, py: f32, w: f32, h: f32, r: f32) -> f32 {
    let qx = (px - w * 0.5).abs() - (w * 0.5 - r);
    let qy = (py - h * 0.5).abs() - (h * 0.5 - r);
    let ox = qx.max(0.0);
    let oy = qy.max(0.0);
    (ox * ox + oy * oy).sqrt() + qx.max(qy).min(0.0) - r
}

/// 沿圆角矩形边缘画 1px 描边，颜色与底下的图真实混合。
///
/// ❌ 为什么不用 GDI 画笔画个框：窗口是 `WS_EX_LAYERED` 且只设了 `LWA_ALPHA`，
/// DIB 的 alpha 通道被系统忽略——画笔只能画**不透明**像素，做不出「极淡」。
/// 而这里本来就是我们自己往 DIB 写像素的地方，在像素层面混合才能真正半透明，
/// 顺带还能给圆弧做抗锯齿（按覆盖率给 alpha）。
fn draw_border(buf: &mut [u8], buf_w: i32, buf_h: i32, radius: f32, active: bool) {
    if buf_w < 3 || buf_h < 3 {
        return;
    }
    // BGRA 顺序（DIB 是小端 32 位）
    let (br, bg, bb) = if active {
        (0x63u32, 0x66u32, 0xF1u32) // --accent #6366F1
    } else {
        (0x96u32, 0xA0u32, 0xB4u32) // 中性灰蓝，浅底深底都能看出边界
    };
    let base_a = if active { 1.0f32 } else { BORDER_ALPHA_IDLE };
    let w = buf_w as f32;
    let h = buf_h as f32;
    let r = radius.max(0.0).min(w.min(h) * 0.5);
    // 只在边缘一圈附近算 SDF：内部大片区域直接跳过，省掉整幅的开方
    let band = radius.ceil() as i32 + 2;
    for y in 0..buf_h {
        let near_v = y < band || y >= buf_h - band;
        for x in 0..buf_w {
            if !near_v && x >= band && x < buf_w - band {
                continue;
            }
            let d = round_rect_sdf(x as f32 + 0.5, y as f32 + 0.5, w, h, r);
            // d ∈ [-1.5, 0] 是描边带；再往内快速淡出，得到抗锯齿的圆弧
            if d > 0.5 || d < -1.8 {
                continue;
            }
            let cov = if d > 0.0 {
                (1.0 - d / 0.5).max(0.0) // 边界外侧半像素：淡出
            } else if d > -1.0 {
                1.0
            } else {
                (1.0 + (d + 1.0) / 0.8).max(0.0) // 内侧淡出
            };
            let a = base_a * cov;
            if a <= 0.004 {
                continue;
            }
            let i = ((y * buf_w + x) * 4) as usize;
            if i + 3 >= buf.len() {
                continue;
            }
            let inv = 1.0 - a;
            buf[i] = (buf[i] as f32 * inv + bb as f32 * a) as u8;
            buf[i + 1] = (buf[i + 1] as f32 * inv + bg as f32 * a) as u8;
            buf[i + 2] = (buf[i + 2] as f32 * inv + br as f32 * a) as u8;
        }
    }
}

fn fill_buffer(buf: &mut [u8], buf_w: i32, buf_h: i32, state: &WindowState) {
    let (box_w, box_h) = effective_box(state);
    let draw_x = (buf_w as f32 - box_w as f32) * 0.5 + state.offset_x;
    let draw_y = (buf_h as f32 - box_h as f32) * 0.5 + state.offset_y;
    let draw_w = state.img_width as f32 * state.scale;
    let draw_h = state.img_height as f32 * state.scale;
    let cx = box_w as f32 * 0.5;
    let cy = box_h as f32 * 0.5;
    let rot = state.rotation % 360;
    let sign_h = if state.flip_h { -1.0f32 } else { 1.0f32 };
    let sign_v = if state.flip_v { -1.0f32 } else { 1.0f32 };

    for dy in 0..buf_h {
        for dx in 0..buf_w {
            let idx = ((dy * buf_w + dx) * 4) as usize;
            // 默认透明黑
            buf[idx] = 0;
            buf[idx + 1] = 0;
            buf[idx + 2] = 0;
            buf[idx + 3] = 0;

            let lx = dx as f32 - draw_x;
            let ly = dy as f32 - draw_y;
            if lx >= 0.0 && lx < box_w as f32 && ly >= 0.0 && ly < box_h as f32 {
                // 局部坐标（以旋转后包围盒中心为原点）
                let bx = lx - cx;
                let by = ly - cy;
                // 反旋转：旋转后局部 → 未旋转图局部。
                //
                // ❌ 90 与 270 两个分支曾经写反了。y 轴向下的坐标系里，顺时针转 90° 的
                // **正**变换是 (x,y) → (-y,x)；这里需要的是它的**逆**，即 (y,-x)。
                // 把正变换当逆变换用，净效果就是转了 -90°，于是 R 键实际是逆时针，
                // 与按钮/菜单/日志里写的“顺时针”相反（也与 Snipaste / Windows 照片的惯例相反）。
                let (ux, uy) = match rot {
                    90 => (by, -bx),
                    180 => (-bx, -by),
                    270 => (-by, bx),
                    _ => (bx, by),
                };
                // 翻转（在未旋转图局部空间）
                let ux = ux * sign_h;
                let uy = uy * sign_v;
                // 未旋转图局部 → 源像素坐标
                let sx = (ux + draw_w * 0.5) / state.scale;
                let sy = (uy + draw_h * 0.5) / state.scale;
                if sx >= 0.0 && sx < state.img_width as f32 && sy >= 0.0 && sy < state.img_height as f32 {
                    let six = sx as u32;
                    let siy = sy as u32;
                    let src = ((siy * state.img_width + six) * 4) as usize;
                    // RGBA → BGRA
                    buf[idx] = state.pixels[src + 2];
                    buf[idx + 1] = state.pixels[src + 1];
                    buf[idx + 2] = state.pixels[src];
                    buf[idx + 3] = state.pixels[src + 3];
                }
            }
        }
    }
}

/// 旋转/翻转后按旋转后包围盒 resize 窗口客户区（保持位置，SWP_NOMOVE），并触发重绘。
/// 同时把拖拽偏移清零，让图回到中心（旋转后再平移语义不直观）。
fn apply_transform(hwnd: HWND, state: &mut WindowState) {
    state.offset_x = 0.0;
    state.offset_y = 0.0;
    let (tw, th) = effective_box(state);
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClientRect, GetWindowRect, SetWindowPos, SWP_NOZORDER,
        };
        let mut cr = RECT::default();
        let mut wr = RECT::default();
        if GetClientRect(hwnd, &mut cr).is_ok() && GetWindowRect(hwnd, &mut wr).is_ok() {
            let cur_w = cr.right - cr.left;
            let cur_h = cr.bottom - cr.top;
            if (tw, th) != (cur_w, cur_h) {
                let chrome_w = (wr.right - wr.left) - (cr.right - cr.left);
                let chrome_h = (wr.bottom - wr.top) - (cr.bottom - cr.top);
                let new_w = tw + chrome_w;
                let new_h = th + chrome_h;
                // 绕**中心**缩放而不是固定左上角：旧写法用 SWP_NOMOVE，一张宽图转成竖图
                // 会从原位一路往下长，容易直接长出屏幕。旋转的心智是“原地转”。
                let old_w = wr.right - wr.left;
                let old_h = wr.bottom - wr.top;
                let nx = wr.left + (old_w - new_w) / 2;
                let ny = wr.top + (old_h - new_h) / 2;
                let _ = SetWindowPos(hwnd, HWND::default(), nx, ny, new_w, new_h, SWP_NOZORDER);
            }
        }
        state.hud_text = None;
        touch_hud(hwnd, state); // 旋转/翻转后把当前角度亮一下
        let _ = InvalidateRect(hwnd, None, false);
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CREATE => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            LRESULT(0)
        }

        WM_SIZE => {
            // 尺寸变了就重设圆角区域（滚轮缩放、旋转都会走到这里）。
            // 不重设的话放大后四角缺块、缩小后圆角跑进画面里。
            apply_round_region(hwnd);
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }

        WM_ERASEBKGND => LRESULT(1),

        WM_PAINT => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &mut *(ptr as *mut WindowState);

            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let win_w = rect.right - rect.left;
            let win_h = rect.bottom - rect.top;

            if win_w <= 0 || win_h <= 0 {
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }

            if state.img_width > 0 && state.img_height > 0 && !state.pixels.is_empty() {
                let need_rebuild = state.hbitmap.is_none()
                    || state.last_width != win_w
                    || state.last_height != win_h;

                if need_rebuild {
                    if let Some(old_bmp) = state.hbitmap {
                        let _ = DeleteObject(old_bmp);
                    }
                    state.dib_bits = None;

                    let bmi = make_bitmap_info(win_w, win_h);
                    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();

                    let hdc_mem = CreateCompatibleDC(hdc);
                    let hbitmap_result =
                        CreateDIBSection(hdc_mem, &bmi, DIB_RGB_COLORS, &mut bits, None, 0);

                    if let Ok(hbmp) = hbitmap_result {
                        state.hbitmap = Some(hbmp);
                        state.dib_bits = Some(bits as *mut u8);
                        state.last_width = win_w;
                        state.last_height = win_h;

                        if !bits.is_null() {
                            let buf = std::slice::from_raw_parts_mut(
                                bits as *mut u8,
                                (win_w * win_h * 4) as usize,
                            );
                            paint_frame(hwnd, buf, win_w, win_h, state);
                        }

                        let _ = SelectObject(hdc_mem, hbmp);
                        let _ = BitBlt(hdc, 0, 0, win_w, win_h, hdc_mem, 0, 0, SRCCOPY);
                    }
                    let _ = DeleteDC(hdc_mem);
                } else {
                    if let Some(bits) = state.dib_bits {
                        let buf =
                            std::slice::from_raw_parts_mut(bits, (win_w * win_h * 4) as usize);
                        paint_frame(hwnd, buf, win_w, win_h, state);
                    }

                    if let Some(hbmp) = state.hbitmap {
                        let hdc_mem = CreateCompatibleDC(hdc);
                        let _ = SelectObject(hdc_mem, hbmp);
                        let _ = BitBlt(hdc, 0, 0, win_w, win_h, hdc_mem, 0, 0, SRCCOPY);
                        let _ = DeleteDC(hdc_mem);
                    }
                }
            }

            // 底部 HUD：回显 缩放% · 旋转° · 透明度（解决“缩了多少看不见”）。
            // 只在刚改过参数后的 HUD_SHOW_MS 内显示（见 hud_until 的注释）。
            if state.hud_until.is_some_and(|t| std::time::Instant::now() < t) {
                use windows::Win32::Graphics::Gdi::{
                    CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, FillRect, SelectObject,
                    SetBkMode, SetTextColor, TRANSPARENT, DT_CENTER, DT_SINGLELINE, DT_VCENTER,
                };
                use windows::Win32::Foundation::COLORREF;
                use windows::Win32::UI::HiDpi::GetDpiForWindow;
                let line = match &state.hud_text {
                    Some(t) => format!("  {t}  "),
                    None => format!(
                        "  {}%   {}°   {}%  ",
                        (state.scale * 100.0).round() as i32,
                        state.rotation % 360,
                        state.alpha
                    ),
                };
                let mut wtext = to_wide(&line);
                // ❌ 字号不能写死逻辑单位：本进程是 per-monitor DPI 感知的，
                // 写死 14 在 150% 缩放的屏上就是真小了一半。字号是感知量，得跟 DPI 走。
                let dpi = GetDpiForWindow(hwnd).max(96);
                let font_h = (14 * dpi as i32) / 96;
                let bar_h = font_h + (8 * dpi as i32) / 96;
                // 深色底衬（白字无描边、直接压在浅色图上等于看不见）
                let mut bar = RECT {
                    left: 0,
                    top: (win_h - bar_h).max(0),
                    right: win_w,
                    bottom: win_h,
                };
                let brush = CreateSolidBrush(COLORREF(0x00201A14)); // BGR：深蓝灰
                FillRect(hdc, &bar, brush);
                let _ = DeleteObject(brush);

                let hfont = CreateFontW(font_h, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, None);
                // ❌ 必须接住 SelectObject 返回的旧字体并在删除前换回去：
                // Windows 拒绝删除仍被 DC 选中的 GDI 对象，旧写法的 DeleteObject 必然失败，
                // 而这段在 WM_PAINT 里——拖动/缩放/改透明度都重绘，于是**每帧泄一个字体句柄**，
                // 进程 GDI 句柄上限默认 10000，拖一会儿就耗尽、之后绘制全废。
                let old_font = SelectObject(hdc, hfont);
                let _ = SetBkMode(hdc, TRANSPARENT);
                let _ = SetTextColor(hdc, COLORREF(0x00FFFFFF));
                let _ = DrawTextW(
                    hdc,
                    &mut wtext,
                    &mut bar,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                );
                SelectObject(hdc, old_font);
                let _ = DeleteObject(hfont);
            }

            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }

        WM_MOUSEWHEEL => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &mut *(ptr as *mut WindowState);
            let delta = ((wparam.0 >> 16) as i16) as f32 / 120.0;
            let ctrl = GetKeyState(VK_CONTROL.0 as i32) < 0;
            state.scale = (state.scale + delta * (if ctrl { 0.05 } else { 0.15 })).clamp(0.1, 10.0);
            // 缩放后把窗口尺寸同步过去（绕中心），让图永远严丝合缝地填满客户区。
            //
            // ❌ 旧行为是只改缩放比、窗口不动：放大后图被裁在窗口里，缩小后四周露出来的
            // 不是透明而是**纯黑**（LWA_ALPHA 让 DIB 的 alpha 通道失效）。
            // 无边框之后这条更要紧——窗口边界就是图的边界，露黑边会直接看成「图坏了」。
            // apply_transform 本来就干这件事（旋转/翻转用的），这里复用它。
            apply_transform(hwnd, state);
            state.hud_text = None; // 回到默认那行（可能还残留着「已复制 N 字」）
            touch_hud(hwnd, state); // 刚改了缩放：把 HUD 亮一下再自行消失
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }

        // HUD 到期：干掉定时器并重绘一次把它抹掉。
        // 不做这一步的话，hud_until 过期了也要等下一次重绘才会消失。
        WM_TIMER if wparam.0 == HUD_TIMER_ID => {
            use windows::Win32::UI::WindowsAndMessaging::KillTimer;
            let _ = KillTimer(hwnd, HUD_TIMER_ID);
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr != 0 {
                let state = &mut *(ptr as *mut WindowState);
                state.hud_until = None;
                state.hud_text = None; // 一次性文字用完即清，之后 HUD 回到默认那行
            }
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }

        WM_LBUTTONDOWN => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &mut *(ptr as *mut WindowState);
            // ❗ 关闭按钮的判定必须在起手拖动**之前**：否则按在 X 上会先 SetCapture 进拖动，
            // 轻微抖动就把窗口拖走了，X 反而点不到。
            if state.close_hot {
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            state.dragging = true;
            // 按下时就定死这次手势是「平移图片」还是「移动窗口」，拖拽途中不再翻转
            state.pan_mode = GetKeyState(VK_CONTROL.0 as i32) < 0;
            state.drag_start_x = (lparam.0 & 0xFFFF) as i16 as i32;
            state.drag_start_y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            state.drag_start_off_x = state.offset_x;
            state.drag_start_off_y = state.offset_y;
            let _ = SetCapture(hwnd);
            LRESULT(0)
        }

        WM_MOUSEMOVE => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &mut *(ptr as *mut WindowState);
            // 进入窗口：描边变亮，并申请一条 WM_MOUSELEAVE 用来复位。
            // 不申请的话鼠标移出去不会有任何消息，描边就一直亮着。
            if !state.hover {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    TrackMouseEvent, TRACKMOUSEEVENT, TME_LEAVE,
                };
                state.hover = true;
                let mut tme = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                let _ = TrackMouseEvent(&mut tme);
                let _ = InvalidateRect(hwnd, None, false);
            }
            // 关闭按钮的显隐与悬停态。只在真的变化时重绘，别让每次 mousemove 都刷一帧。
            {
                use windows::Win32::UI::HiDpi::GetDpiForWindow;
                let mx = (lparam.0 & 0xFFFF) as i16 as i32;
                let my = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                let mut cr = RECT::default();
                if GetClientRect(hwnd, &mut cr).is_ok() {
                    let sc = GetDpiForWindow(hwnd).max(96) as f32 / 96.0;
                    let (cw, ch) = (cr.right - cr.left, cr.bottom - cr.top);
                    let show = !state.dragging && in_top_band(my, ch, sc);
                    let hot = show
                        && close_button(cw, ch, sc).is_some_and(|(cx, cy, r)| {
                            let dx = mx as f32 + 0.5 - cx;
                            let dy = my as f32 + 0.5 - cy;
                            dx * dx + dy * dy <= r * r
                        });
                    if show != state.close_visible || hot != state.close_hot {
                        state.close_visible = show;
                        state.close_hot = hot;
                        let _ = InvalidateRect(hwnd, None, false);
                    }
                }
            }
            if state.dragging {
                let mx = (lparam.0 & 0xFFFF) as i16 as i32;
                let my = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                if state.pan_mode {
                    // Ctrl + 拖 = 平移图片（只有放大到超出屏幕、窗口被钳住时才用得上）
                    state.offset_x = state.drag_start_off_x + (mx - state.drag_start_x) as f32;
                    state.offset_y = state.drag_start_off_y + (my - state.drag_start_y) as f32;
                    let _ = InvalidateRect(hwnd, None, false);
                } else if (mx - state.drag_start_x).abs() + (my - state.drag_start_y).abs() > 4 {
                    // 裸拖 = 移动窗口。去掉标题栏之后必须自己接这件事，
                    // 否则贴图就彻底动不了了（原来只能靠标题栏拖）。
                    //
                    // ❌ 关键：要等移动**超过阈值**才交给系统，不能在 WM_LBUTTONDOWN 里直接交。
                    // WM_NCLBUTTONDOWN 会进入系统的模态拖动循环，纯击（没移动）也被它吃掉，
                    // 第二次点击就不会变成 WM_LBUTTONDBLCLK ——「双击贴图重新编辑」会失效。
                    // 加了阈值之后，纯击根本不进拖动循环，双击与右键菜单都保持原样。
                    //
                    // 交给系统还白拿了贴边吸附、跨屏 DPI 处理这些行为。
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SendMessageW, HTCAPTION, WM_NCLBUTTONDOWN,
                    };
                    state.dragging = false;
                    let _ = ReleaseCapture();
                    SendMessageW(
                        hwnd,
                        WM_NCLBUTTONDOWN,
                        WPARAM(HTCAPTION as usize),
                        LPARAM(0),
                    );
                    let _ = InvalidateRect(hwnd, None, false);
                }
            }
            LRESULT(0)
        }

        WM_MOUSELEAVE => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr != 0 {
                let state = &mut *(ptr as *mut WindowState);
                state.hover = false;
                state.close_visible = false;
                state.close_hot = false;
                let _ = InvalidateRect(hwnd, None, false);
            }
            LRESULT(0)
        }

        WM_LBUTTONUP => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr != 0 {
                let state = &mut *(ptr as *mut WindowState);
                state.dragging = false;
            }
            let _ = ReleaseCapture();
            LRESULT(0)
        }

        WM_KEYDOWN => {
            if wparam.0 == VK_ESCAPE.0 as usize {
                let _ = DestroyWindow(hwnd);
            } else if wparam.0 == VK_T.0 as usize {
                // T：循环切换透明度 255 → 180 → 110 → 60 → 255（贴图叠在工作区上时看底）
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr != 0 {
                    let state = &mut *(ptr as *mut WindowState);
                    state.alpha = match state.alpha {
                        255 => 180,
                        180 => 110,
                        110 => 60,
                        _ => 255,
                    };
                    use windows::Win32::Foundation::COLORREF;
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetLayeredWindowAttributes, LWA_ALPHA,
                    };
                    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), state.alpha, LWA_ALPHA);
                    state.hud_text = None;
                    touch_hud(hwnd, state);
                    let _ = InvalidateRect(hwnd, None, false);
                    log::info!("[pinned-window] 透明度调整为 {}", state.alpha);
                }
            } else if wparam.0 == VK_R.0 as usize {
                // R：顺时针旋转 90°
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr != 0 {
                    let state = &mut *(ptr as *mut WindowState);
                    state.rotation = (state.rotation + 90) % 360;
                    apply_transform(hwnd, state);
                    log::info!("[pinned-window] 旋转为 {}°", state.rotation);
                }
            } else if wparam.0 == VK_F.0 as usize {
                // F：水平翻转
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr != 0 {
                    let state = &mut *(ptr as *mut WindowState);
                    state.flip_h = !state.flip_h;
                    apply_transform(hwnd, state);
                    log::info!("[pinned-window] 水平翻转: {}", state.flip_h);
                }
            } else if wparam.0 == VK_V.0 as usize {
                // V：垂直翻转
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr != 0 {
                    let state = &mut *(ptr as *mut WindowState);
                    state.flip_v = !state.flip_v;
                    apply_transform(hwnd, state);
                    log::info!("[pinned-window] 垂直翻转: {}", state.flip_v);
                }
            } else if wparam.0 == VK_0.0 as usize {
                // 0：恢复实际大小（旋转归零、取消翻转）
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr != 0 {
                    let state = &mut *(ptr as *mut WindowState);
                    state.rotation = 0;
                    state.flip_h = false;
                    state.flip_v = false;
                    apply_transform(hwnd, state);
                    log::info!("[pinned-window] 已恢复实际大小");
                }
            }
            LRESULT(0)
        }

        WM_LBUTTONDBLCLK => {
            // 双击贴图 → 回到截图标注窗口重新编辑（按 hwnd 区分，多贴图各编辑各的）
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr != 0 {
                if let Some((app, path)) = crate::screenshot::peek_pinned_edit_by_hwnd(hwnd.0 as isize)
                {
                    // 用 peek 不用 take：take 会把绑定从 map 里移除，双击一次之后
                    // 再双击、以及右键菜单的「复制图片/重新编辑」就全失效了。
                    // 清理改由 WM_DESTROY 里的 unbind_pinned_edit 负责。
                    log::info!("[pinned-window] 双击贴图，进入重新编辑: {}", path);
                    crate::screenshot::open_editor_window(&app, path);
                }
            }
            LRESULT(0)
        }

        WM_RBUTTONUP => {
            // V6.19 贴图右键菜单：复制图片 / 重新编辑 / 关闭 / 关闭全部
            let (mx, my) = (
                (lparam.0 & 0xFFFF) as i16 as i32,
                ((lparam.0 >> 16) & 0xFFFF) as i16 as i32,
            );
            let info = crate::screenshot::peek_pinned_edit_by_hwnd(hwnd.0 as isize);
            use windows::Win32::Graphics::Gdi::ClientToScreen;
            use windows::Win32::UI::WindowsAndMessaging::{
                AppendMenuW, CreatePopupMenu, DestroyMenu, TrackPopupMenu, MF_STRING,
                TPM_RETURNCMD, TPM_RIGHTBUTTON,
            };
            if let Ok(hmenu) = unsafe { CreatePopupMenu() } {
                if !hmenu.0.is_null() {
                    let items = [
                        ("复制图片", 1usize),
                        ("复制文字", 9),
                        ("重新编辑", 2),
                        ("旋转 90°", 5),
                        ("水平翻转", 6),
                        ("垂直翻转", 7),
                        ("实际大小", 8),
                        ("关闭", 3),
                        ("关闭全部", 4),
                    ];
                    for (label, id) in items {
                        let wide = to_wide(label);
                        unsafe {
                            let _ = AppendMenuW(hmenu, MF_STRING, id, PCWSTR(wide.as_ptr()));
                        }
                    }
                    // 客户端坐标 → 屏幕坐标（菜单用屏幕坐标弹出）
                    let mut pt = windows::Win32::Foundation::POINT { x: mx, y: my };
                    unsafe {
                        let _ = ClientToScreen(hwnd, &mut pt);
                    }
                    let cmd = unsafe {
                        TrackPopupMenu(
                            hmenu,
                            TPM_RETURNCMD | TPM_RIGHTBUTTON,
                            pt.x,
                            pt.y,
                            0,
                            hwnd,
                            None,
                        )
                    };
                    unsafe {
                        let _ = DestroyMenu(hmenu);
                    }
                    // TPM_RETURNCMD：返回值即命令 id（BOOL 载体）
                    let cmd_id = cmd.0 as u16;
                    match cmd_id {
                        1 => {
                            // 复制图片到剪贴板
                            if let Some((ref app, path)) = info {
                                use tauri::Manager;
                                if let Some(eng) =
                                    app.try_state::<crate::paste_engine::PasteEngine>()
                                {
                                    if let Err(e) = eng.copy_image_only(&path) {
                                        log::warn!("[pinned-window] 复制贴图失败: {}", e);
                                    }
                                }
                            }
                        }
                        2 => {
                            // 重新编辑（回到截图标注窗口）
                            if let Some((app, path)) = info {
                                crate::screenshot::open_editor_window(&app, path);
                            }
                        }
                        3 => {
                            let _ = DestroyWindow(hwnd);
                        }
                        4 => {
                            close_current_window();
                        }
                        9 => {
                            // 复制文字：对贴图跑一次 OCR，全文进剪贴板。
                            //
                            // ❗ 必须放到后台线程：这里是窗口过程，跑在贴图窗自己的消息循环上，
                            // OCR 要几百毫秒到几秒，占着不放贴图会直接假死（连拖动都不响应）。
                            // 完成后用 PostMessage 把结果送回本线程显示（见 WM_PINNED_TOAST）。
                            if let Some((ref app, path)) = info {
                                let app = app.clone();
                                let hwnd_val = hwnd.0 as isize;
                                flash_hud(hwnd, "识别文字中…");
                                std::thread::spawn(move || {
                                    let msg = match ocr_pinned_text(&app, &path) {
                                        Ok(text) if text.trim().is_empty() => {
                                            "未识别到文字".to_string()
                                        }
                                        Ok(text) => {
                                            let n = text.chars().count();
                                            match copy_text_to_clipboard(&app, &text) {
                                                Ok(()) => format!("已复制 {n} 字"),
                                                Err(e) => {
                                                    log::warn!("[pinned-window] 写剪贴板失败: {e}");
                                                    "复制失败".to_string()
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            log::warn!("[pinned-window] 贴图 OCR 失败: {e}");
                                            "文字识别失败".to_string()
                                        }
                                    };
                                    post_toast(hwnd_val, msg);
                                });
                            }
                        }
                        5 => {
                            // 旋转 90°
                            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                            if ptr != 0 {
                                let state = &mut *(ptr as *mut WindowState);
                                state.rotation = (state.rotation + 90) % 360;
                                apply_transform(hwnd, state);
                            }
                        }
                        6 => {
                            // 水平翻转
                            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                            if ptr != 0 {
                                let state = &mut *(ptr as *mut WindowState);
                                state.flip_h = !state.flip_h;
                                apply_transform(hwnd, state);
                            }
                        }
                        7 => {
                            // 垂直翻转
                            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                            if ptr != 0 {
                                let state = &mut *(ptr as *mut WindowState);
                                state.flip_v = !state.flip_v;
                                apply_transform(hwnd, state);
                            }
                        }
                        8 => {
                            // 实际大小（旋转归零、取消翻转）
                            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                            if ptr != 0 {
                                let state = &mut *(ptr as *mut WindowState);
                                state.rotation = 0;
                                state.flip_h = false;
                                state.flip_v = false;
                                apply_transform(hwnd, state);
                            }
                        }
                        _ => {}
                    }
                }
            }
            LRESULT(0)
        }

        WM_PINNED_TOAST => {
            // 收回后台线程 Box 出来的字符串（见 post_toast）
            if lparam.0 != 0 {
                let msg = *Box::from_raw(lparam.0 as *mut String);
                flash_hud(hwnd, &msg);
            }
            LRESULT(0)
        }

        WM_TRANSFORM_PINNED => {
            // 管理面板按 path 下发的旋转/翻转指令（跨线程，PostMessage 到此窗口线程执行）
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr != 0 {
                let state = &mut *(ptr as *mut WindowState);
                match wparam.0 {
                    1 => state.rotation = (state.rotation + 90) % 360,
                    2 => state.flip_h = !state.flip_h,
                    3 => state.flip_v = !state.flip_v,
                    4 => {
                        state.rotation = 0;
                        state.flip_h = false;
                        state.flip_v = false;
                    }
                    _ => {}
                }
                apply_transform(hwnd, state);
                log::info!("[pinned-window] 面板指令变换完成 rotation={}° flip_h={} flip_v={}", state.rotation, state.flip_h, state.flip_v);
            }
            LRESULT(0)
        }

        WM_DESTROY => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            let mut destroyed_generation = None;
            if ptr != 0 {
                let state = Box::from_raw(ptr as *mut WindowState);
                destroyed_generation = Some(state.generation);
                if let Some(hbmp) = state.hbitmap {
                    let _ = DeleteObject(hbmp);
                }
            }

            // 多贴图并存：从全局集合移除被销毁的窗口（HWND + 代际号都匹配才移除，
            // 避免旧代窗口的销毁事件误清新窗口的状态）
            if let Ok(mut guard) = CURRENT_WINDOW.lock() {
                if let Some(gen) = destroyed_generation {
                    guard.retain(|h| !(h.hwnd == hwnd.0 as isize && h.generation == gen));
                }
            }

            // 解除重编辑绑定：不清的话 PINNED_EDIT_MAP 只增不减，而且 Windows 会复用 HWND 数值，
            // 新窗口拿到旧 hwnd 时会串到上一张图的路径（右键「复制图片」复制错图）。
            crate::screenshot::unbind_pinned_edit(hwnd.0 as isize);

            let _ = PostQuitMessage(0);
            LRESULT(0)
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn register_class(instance: HINSTANCE) -> Result<(), String> {
    let class_name = to_wide(CLASS_NAME);
    let cursor =
        unsafe { LoadCursorW(None, IDC_ARROW) }.map_err(|e| format!("LoadCursor 失败: {:?}", e))?;

    let wc = WNDCLASSW {
        // CS_DBLCLKS 必须声明：窗口类没有它，系统就永远不发 WM_LBUTTONDBLCLK，
        // 双击只会变成两次 WM_LBUTTONDOWN——下面那个「双击贴图重新编辑」分支会是死代码。
        // CS_DROPSHADOW：给无边框弹出式窗口一条系统投影。贴图去掉标题栏之后，
        // 「这块内容浮在桌面上」的存在感主要靠阴影，而不是靠描边。
        style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS | CS_DROPSHADOW,
        lpfnWndProc: Some(wndproc),
        hInstance: instance,
        hCursor: cursor,
        hbrBackground: HBRUSH::default(),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    let _ = unsafe { RegisterClassW(&wc) };
    Ok(())
}

pub fn create_native_window(image_path: &str) -> Result<(), String> {
    // 多贴图并存（V5）：不再"关旧开新"——多次贴图各自创建独立置顶窗口。
    // 关闭由 close_current_window（关全部）或各窗口自身的 Esc/右键完成。
    // 修复 C18：先仅读头部校验尺寸上限，防解压炸弹
    crate::commands::check_image_decode_limits(std::path::Path::new(image_path))?;
    let img = image::open(image_path).map_err(|e| format!("无法加载图片: {}", e))?;
    let (img_width, img_height) = img.dimensions();
    let rgba = img.to_rgba8();
    let pixels: Vec<u8> = rgba.into_raw();

    log::info!(
        "[pinned-window] 图片已加载: {}x{}, {} bytes",
        img_width,
        img_height,
        pixels.len()
    );

    let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
    let image_path_owned = image_path.to_string();

    std::thread::spawn(move || {
        if let Err(e) = run_window_loop(pixels, img_width, img_height, generation, image_path_owned) {
            log::error!("[pinned-window] 窗口消息循环错误: {}", e);
        }
    });

    Ok(())
}

/// 主动关闭全部置顶贴图窗口（供 `close_pinned_image` 命令调用）。
/// 多贴图并存后语义为"关闭所有贴图"。
pub fn close_current_window() {
    // 其他线程持锁期间 panic 会使 Mutex 中毒；中毒后直接 unwrap 会二次 panic。
    // 这里恢复为 into_inner()，保证"关闭所有贴图"这一清理动作在任何情况下都能完成。
    let windows = match CURRENT_WINDOW.lock() {
        Ok(mut guard) => guard.drain(..).collect::<Vec<_>>(),
        Err(poisoned) => poisoned.into_inner().drain(..).collect::<Vec<_>>(),
    };
    for w in windows {
        unsafe {
            let _ = PostMessageW(HWND(w.hwnd as *mut _), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

/// 当前贴图路径列表（贴图管理面板，V6.19）
pub fn list_pinned_images() -> Vec<String> {
    let guard = CURRENT_WINDOW.lock().unwrap_or_else(|p| p.into_inner());
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for w in guard.iter() {
        if seen.insert(w.path.clone()) {
            out.push(w.path.clone());
        }
    }
    out
}

/// 关闭指定路径的贴图窗口（V6.19 贴图管理面板"关闭单张"）
pub fn close_pinned_by_path(path: &str) {
    let windows = CURRENT_WINDOW
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|w| w.path == path)
        .map(|w| w.hwnd)
        .collect::<Vec<_>>();
    for hwnd in windows {
        unsafe {
            let _ = PostMessageW(HWND(hwnd as *mut _), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

/// 管理面板按 path 下发变换指令（1=旋转90° 2=水平翻转 3=垂直翻转 4=恢复）。
/// 跨线程：向该 path 对应的所有贴图窗口 PostMessage 自定义消息，由窗口线程改 state 并重绘。
pub fn transform_pinned_image_by_path(path: &str, action: u8) {
    let windows = CURRENT_WINDOW
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let hwnds: Vec<isize> = windows
        .iter()
        .filter(|w| w.path == path)
        .map(|w| w.hwnd)
        .collect();
    drop(windows);
    for hwnd in hwnds {
        unsafe {
            let _ = PostMessageW(
                HWND(hwnd as *mut _),
                WM_TRANSFORM_PINNED,
                WPARAM(action as usize),
                LPARAM(0),
            );
        }
    }
}

fn run_window_loop(
    pixels: Vec<u8>,
    img_width: u32,
    img_height: u32,
    generation: u64,
    image_path: String,
) -> Result<(), String> {
    // GetModuleHandleW 返回 HMODULE，可转为 HINSTANCE
    let module = unsafe { windows::Win32::System::LibraryLoader::GetModuleHandleW(None) }
        .map_err(|e| format!("GetModuleHandle 失败: {:?}", e))?;

    let instance = HINSTANCE(module.0);

    register_class(instance)?;

    let class_name = to_wide(CLASS_NAME);
    let title = to_wide("置顶图片");

    // 贴图默认 **1:1 原始像素**。
    //
    // 旧实现是 (img_w × 0.6).clamp(300,1200) 再反算 scale，于是贴出来的图
    // 永远比刚截的那块小 40%（小图还会被 clamp 的下限拉成不等比）——
    // 用户报的「贴图显示的图片大小和截图的不一致」就是这个。
    // 贴图的意义就是“贴出来的就是刚截的那块”，能直接压在原内容上对比；
    // 缩过就没法比了（Snipaste 也是 1:1 起步，缩放交给滚轮）。
    //
    // 只有一种情况需要缩：图比屏幕工作区还大，1:1 会撑出屏幕。
    // SM_CXFULLSCREEN / SM_CYFULLSCREEN 给的正是全屏窗口的客户区尺寸（已排除任务栏）。
    let (fs_w, fs_h) = unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXFULLSCREEN, SM_CYFULLSCREEN,
        };
        let w = GetSystemMetrics(SM_CXFULLSCREEN);
        let h = GetSystemMetrics(SM_CYFULLSCREEN);
        // 取不到就按 1920x1080 兜底（只影响“超大图要不要缩”这一个判断）
        (if w > 0 { w } else { 1920 }, if h > 0 { h } else { 1080 })
    };
    let fit = (fs_w as f32 * 0.9 / img_width.max(1) as f32)
        .min(fs_h as f32 * 0.9 / img_height.max(1) as f32)
        .min(1.0);
    let initial_scale = fit;
    // 这两个是期望的**客户区**尺寸；CreateWindowExW 要的是外框，建完再修正。
    let client_w = (img_width as f32 * fit).round().max(1.0) as i32;
    let client_h = (img_height as f32 * fit).round().max(1.0) as i32;

    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(title.as_ptr()),
            // ❌ 不用 WS_OVERLAPPEDWINDOW：它 = WS_CAPTION | WS_THICKFRAME | ...，
            // 贴图会顶着一条系统标题栏 + 一圈粗调整边框，
            // 「贴在桌面上的一块内容」就变成「一个开着的窗口里装着一张图」。
            // WS_POPUP 是纯客户区，边界与圆角由我们自己画（见 draw_border）。
            //
            // 代价：没有拖边缩放了（THICKFRAME 提供的）。缩放统一走滚轮——
            // 滚轮改的是图的缩放比，比拖边框改窗口尺寸语义更对，两者本来也容易打架。
            WS_POPUP | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            client_w,
            client_h,
            None,
            None,
            instance,
            None,
        )
    };

    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => return Err(format!("CreateWindowExW 失败: {:?}", e)),
    };

    // 把**客户区**调成真正的 client_w × client_h。
    //
    // CreateWindowExW 的宽高是**窗口外框**（含 WS_OVERLAPPEDWINDOW 的标题栏与边框），
    // 而 fill_buffer 是按**客户区**画的 —— 直接把期望客户区尺寸传进去，图就会
    // 少掉标题栏那一截高度（约 31px）与左右边框，“1:1” 就名不副实了。
    //
    // 用实测差值而不是 AdjustWindowRectEx：后者拿的是**系统 DPI**下的非客户区尺寸，
    // 本进程是 per-monitor v2，窗口在 125% 屏上的标题栏比系统 DPI 算出来的高（除非
    // 再去取 GetDpiForWindow 配 AdjustWindowRectExForDpi）。差值法不依赖 DPI，一定准。
    //
    // 位置故意放在 SetLayeredWindowAttributes **之前**：窗口是 WS_VISIBLE 建的，
    // 但分层窗在首次设分层属性前不被 DWM 合成（见下面那段注释），
    // 此时改尺寸用户看不到闪动。
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, SetWindowPos, SWP_NOMOVE, SWP_NOZORDER,
        };
        let mut cr = RECT::default();
        let mut wr = RECT::default();
        if GetClientRect(hwnd, &mut cr).is_ok() && GetWindowRect(hwnd, &mut wr).is_ok() {
            let chrome_w = (wr.right - wr.left) - (cr.right - cr.left);
            let chrome_h = (wr.bottom - wr.top) - (cr.bottom - cr.top);
            if let Err(e) = SetWindowPos(
                hwnd,
                HWND::default(),
                0,
                0,
                client_w + chrome_w,
                client_h + chrome_h,
                SWP_NOMOVE | SWP_NOZORDER,
            ) {
                // 不能静默：失败的后果是贴图比截图小一圈，而那正是这次要修的 bug
                log::warn!("[pinned-window] 修正客户区尺寸失败（贴图不会是 1:1）: {e:?}");
            }
        }
    }

    // 小圆角：**自己裁**，不用 DWM 的。
    //
    // ❗ 必须显式关掉 DWM 圆角：Windows 11 会**默认**圆化顶层窗口，而且用的是较大的半径。
    // 不关的话我们自己的小半径区域和 DWM 的大半径会叠在一起，最终看到的是 DWM 那个大圆角
    // ——用户反馈的"圆角太大挡住部分内容"就是这个。圆角是真的把角上的像素裁掉，
    // 对贴图（角上可能有正文）来说，半径大一点就是实打实地丢内容。
    unsafe {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
        };
        let pref = DWMWCP_DONOTROUND;
        if let Err(e) = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        ) {
            // 旧系统没这个属性，本来也不会自动圆角，忽略即可
            log::debug!("[pinned-window] 关闭 DWM 圆角不适用（旧系统，无妨）: {e:?}");
        }
    }
    unsafe {
        apply_round_region(hwnd);
    }

    // ❗ 必须在这里就把分层属性初始化一次。
    //
    // 窗口带了 WS_EX_LAYERED，而分层窗口在首次调用 SetLayeredWindowAttributes
    // （或 UpdateLayeredWindow）**之前根本不会被 DWM 合成** —— 用户看到的就是
    // 一个空白透明框：窗体、标题栏、拖拽、右键菜单全都在，就是图不显示。
    //
    // 旧实现只在 T 键（循环切透明度）的处理里调它，所以贴图后必须先按一下 T
    // 才能看见图——而界面上没任何地方写着要按 T。
    //
    // COLORREF(0) 在 LWA_ALPHA 模式下被忽略（它只在 LWA_COLORKEY 下作为色键生效），
    // 所以不会把图里的黑色像素抠成透明。
    unsafe {
        use windows::Win32::Foundation::COLORREF;
        use windows::Win32::UI::WindowsAndMessaging::{SetLayeredWindowAttributes, LWA_ALPHA};
        if let Err(e) = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA) {
            // 不能静默：这一步失败的后果就是“窗开了但看不见图”，
            // 日志里没痕迹的话下一个人还要从头查一遍。
            log::error!("[pinned-window] SetLayeredWindowAttributes 失败（贴图会不可见）: {e:?}");
        }
    }

    // 登记为"当前置顶窗口集合"的一员（供关闭/重编辑回调使用）。
    // 中毒恢复：其他线程持锁 panic 后此处若直接 unwrap 会二次 panic，导致贴图登记失败。
    let mut guard = match CURRENT_WINDOW.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.push(PinnedWindowHandle {
        hwnd: hwnd.0 as isize,
        generation,
        path: image_path.to_string(),
    });
    // ⚠️ 必须在进入消息循环前显式释放锁。本函数尾部就是 GetMessageW 消息循环，
    // guard 若活到函数结束，这把锁会被本窗口线程一直占着直到窗口关闭，后果全部必然发生：
    // ① 本线程的 WM_DESTROY 里还要再 lock 同一把非重入 Mutex → 自死锁，Esc 关不掉窗口；
    // ② 第二张贴图的窗口线程卡死在这一行 → 窗口建出来了却没有消息循环，白屏无响应；
    // ③ close_current_window / list_pinned_images / close_pinned_by_path 全部阻塞调用方。
    // 改多贴图并存前这里是 `*CURRENT_WINDOW.lock().unwrap() = Some(..)`，临时值语句结束即释放，
    // 换成具名 guard 后就丢掉了这个隐式释放点。
    drop(guard);

    // 多贴图重编辑：把最近一次贴图绑定到本窗口 hwnd（双击哪张就编辑哪张）
    if let Some((app, path)) = crate::screenshot::take_pinned_edit_request() {
        crate::screenshot::bind_pinned_edit(hwnd.0 as isize, &app, &path);
    }

    // DWM 圆角
    {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
        };
        let preference: i32 = 2;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    let state = Box::new(WindowState {
        pixels,
        img_width,
        img_height,
        scale: initial_scale,
        offset_x: 0.0,
        offset_y: 0.0,
        dragging: false,
        drag_start_x: 0,
        drag_start_y: 0,
        drag_start_off_x: 0.0,
        drag_start_off_y: 0.0,
        hbitmap: None,
        dib_bits: None,
        last_width: 0,
        last_height: 0,
        alpha: 255,
        rotation: 0,
        close_visible: false,
        close_hot: false,
        hud_text: None,
        pan_mode: false,
        hover: false,
        hud_until: None,
        flip_h: false,
        flip_v: false,
        generation,
    });

    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = UpdateWindow(hwnd);
    }

    let mut msg = MSG::default();
    loop {
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 <= 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    Ok(())
}
