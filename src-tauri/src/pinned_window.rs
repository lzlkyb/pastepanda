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
    GetKeyState, ReleaseCapture, SetCapture, VK_CONTROL, VK_ESCAPE, VK_T,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetMessageW,
    GetWindowLongPtrW, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassW,
    SetWindowLongPtrW, ShowWindow, TranslateMessage, CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW,
    CW_USEDEFAULT,
    GWLP_USERDATA, IDC_ARROW, MSG, SW_SHOW, WM_CLOSE, WM_CREATE, WM_DESTROY, WM_ERASEBKGND,
    WM_KEYDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_PAINT, WM_RBUTTONUP, WM_SIZE, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE,
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

/// 用 DIB 像素数据填充缓冲区（最近邻采样 + RGBA→BGRA）
fn fill_buffer(buf: &mut [u8], buf_w: i32, buf_h: i32, state: &WindowState) {
    let scaled_w = state.img_width as f32 * state.scale;
    let scaled_h = state.img_height as f32 * state.scale;
    let draw_x = (buf_w as f32 - scaled_w) * 0.5 + state.offset_x;
    let draw_y = (buf_h as f32 - scaled_h) * 0.5 + state.offset_y;

    for dy in 0..buf_h {
        for dx in 0..buf_w {
            let sx = (dx as f32 - draw_x) / state.scale;
            let sy = (dy as f32 - draw_y) / state.scale;
            let idx = ((dy * buf_w + dx) * 4) as usize;

            // 默认黑色
            buf[idx] = 0;
            buf[idx + 1] = 0;
            buf[idx + 2] = 0;
            buf[idx + 3] = 0;

            if sx >= 0.0 && sx < state.img_width as f32 && sy >= 0.0 && sy < state.img_height as f32
            {
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

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CREATE => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            LRESULT(0)
        }

        WM_SIZE => {
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
                            fill_buffer(buf, win_w, win_h, state);
                        }

                        let _ = SelectObject(hdc_mem, hbmp);
                        let _ = BitBlt(hdc, 0, 0, win_w, win_h, hdc_mem, 0, 0, SRCCOPY);
                    }
                    let _ = DeleteDC(hdc_mem);
                } else {
                    if let Some(bits) = state.dib_bits {
                        let buf =
                            std::slice::from_raw_parts_mut(bits, (win_w * win_h * 4) as usize);
                        fill_buffer(buf, win_w, win_h, state);
                    }

                    if let Some(hbmp) = state.hbitmap {
                        let hdc_mem = CreateCompatibleDC(hdc);
                        let _ = SelectObject(hdc_mem, hbmp);
                        let _ = BitBlt(hdc, 0, 0, win_w, win_h, hdc_mem, 0, 0, SRCCOPY);
                        let _ = DeleteDC(hdc_mem);
                    }
                }
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
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }

        WM_LBUTTONDOWN => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &mut *(ptr as *mut WindowState);
            state.dragging = true;
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
            if state.dragging {
                let mx = (lparam.0 & 0xFFFF) as i16 as i32;
                let my = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                state.offset_x = state.drag_start_off_x + (mx - state.drag_start_x) as f32;
                state.offset_y = state.drag_start_off_y + (my - state.drag_start_y) as f32;
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
                    log::info!("[pinned-window] 透明度调整为 {}", state.alpha);
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
                        ("重新编辑", 2),
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
                        _ => {}
                    }
                }
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
        style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
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
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
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
