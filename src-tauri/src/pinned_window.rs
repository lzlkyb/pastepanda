//! 原生置顶图片窗口（Windows GDI DIB Section 渲染）
//! 不依赖 WebView，直接创建 Win32 窗口 + GDI 双缓冲绘制图片
//! 支持：鼠标滚轮缩放、拖拽移动、ESC/右键关闭

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};

use image::GenericImageView;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EndPaint,
    InvalidateRect, SelectObject, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HBITMAP, HBRUSH, PAINTSTRUCT, SRCCOPY,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, VK_CONTROL, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW,
    GetWindowLongPtrW, LoadCursorW, PostQuitMessage, RegisterClassW, SetWindowLongPtrW, ShowWindow,
    TranslateMessage, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, GWLP_USERDATA, IDC_ARROW, MSG,
    SW_SHOW, WM_CREATE, WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_PAINT, WM_RBUTTONUP, WM_SIZE, WNDCLASSW, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
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
}

unsafe impl Send for WindowState {}
unsafe impl Sync for WindowState {}

static WINDOW_RUNNING: AtomicBool = AtomicBool::new(false);
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
            }
            LRESULT(0)
        }

        WM_RBUTTONUP => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }

        WM_DESTROY => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr != 0 {
                let state = Box::from_raw(ptr as *mut WindowState);
                if let Some(hbmp) = state.hbitmap {
                    let _ = DeleteObject(hbmp);
                }
            }
            WINDOW_RUNNING.store(false, Ordering::SeqCst);
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
        style: CS_HREDRAW | CS_VREDRAW,
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
    if WINDOW_RUNNING.load(Ordering::SeqCst) {
        log::info!("[pinned-window] 已有窗口运行中");
    }
    WINDOW_RUNNING.store(true, Ordering::SeqCst);

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

    std::thread::spawn(move || {
        if let Err(e) = run_window_loop(pixels, img_width, img_height) {
            log::error!("[pinned-window] 窗口消息循环错误: {}", e);
        }
        WINDOW_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(())
}

fn run_window_loop(pixels: Vec<u8>, img_width: u32, img_height: u32) -> Result<(), String> {
    // GetModuleHandleW 返回 HMODULE，可转为 HINSTANCE
    let module = unsafe { windows::Win32::System::LibraryLoader::GetModuleHandleW(None) }
        .map_err(|e| format!("GetModuleHandle 失败: {:?}", e))?;

    let instance = HINSTANCE(module.0);

    register_class(instance)?;

    let class_name = to_wide(CLASS_NAME);
    let title = to_wide("置顶图片");

    let initial_w = (img_width as f32 * 0.6).clamp(300.0, 1200.0) as i32;
    let initial_h = (img_height as f32 * 0.6).clamp(200.0, 900.0) as i32;

    let initial_scale =
        if img_width as f32 / initial_w as f32 > img_height as f32 / initial_h as f32 {
            initial_w as f32 / img_width as f32
        } else {
            initial_h as f32 / img_height as f32
        };

    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            initial_w,
            initial_h,
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
