//! 截图采集与截图窗口管理（截图标注功能）。
//!
//! - `capture_screen`：GDI BitBlt 捕获整个虚拟屏幕（多显示器拼接），返回 PNG data URL
//!   + 物理坐标系原点/尺寸。前端据此 1:1 显示底图，并用
//!     `clientX * devicePixelRatio` 换算鼠标物理坐标，保证选区与像素精确对应。
//! - `save_screenshot_image`：把标注合成后的 PNG data URL 落盘到应用数据目录
//!   `screenshots/`（md5 去重），供 OCR / 复制图片 / 保存图库复用同一文件。
//! - `open_screenshot_window`：创建/复用透明置顶截图窗口（无边框、覆盖整个虚拟屏幕）。
//!
//! 坐标系约定：全程使用**物理像素**（窗口定位、底图、选区、Canvas 均同源），
//! 唯一换算点是前端 WebView 内 CSS 显示尺寸 = 物理像素 / devicePixelRatio。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

const WINDOW_LABEL: &str = "screenshot";

/// 截图结果：PNG data URL + 虚拟屏幕物理坐标与尺寸
#[derive(serde::Serialize)]
pub struct ScreenCapture {
    pub data_url: String,
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: i32,
    pub height: i32,
}

/// 捕获整个虚拟屏幕（所有显示器拼接）为 PNG data URL（物理像素）。
/// async + spawn_blocking：GDI 截屏 + 4K PNG 编码是重活，放主线程会卡 UI（长截图每帧都调）。
#[tauri::command]
pub async fn capture_screen() -> Result<ScreenCapture, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(capture_virtual_screen)
            .await
            .map_err(|e| format!("截图任务失败: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("截图功能目前仅支持 Windows".to_string())
    }
}

/// 捕获屏幕上的一个矩形区域（物理像素，屏幕坐标）。
///
/// 长截图每帧只需要选区那一小块，而原实现每帧都截全屏、再由前端 drawImage 裁掉：
/// 选区若占屏 1/5，就有 80% 的 BitBlt / 像素转换 / JPEG 编码 / base64 / 解码是白做的，
/// 而这套最多要跑 40 遍。
///
/// 它还是交互变友好的前提：只有不再截全屏，截图窗口才不必把自己藏起来（hide），
/// 进度提示 / 手动停止才有地方放——现在长截图全程无反馈正是因为窗口被隐藏了。
#[tauri::command]
pub async fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<ScreenCapture, String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || capture_rect(x, y, w, h))
            .await
            .map_err(|e| format!("截图任务失败: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, w, h);
        Err("截图功能目前仅支持 Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn capture_virtual_screen() -> Result<ScreenCapture, String> {
    // 收口：全屏截图 = “区域截图”取整个虚拟屏，不再写第二份 GDI 代码（规则 11.1）。
    let (width, height, origin_x, origin_y) = virtual_screen_metrics();
    if width <= 0 || height <= 0 {
        return Err(format!("获取虚拟屏幕尺寸失败: {width}x{height}"));
    }
    capture_rect(origin_x, origin_y, width, height)
}

/// GDI 截屏实现：按屏幕坐标矩形取像素 → JPEG data URL。
#[cfg(target_os = "windows")]
fn capture_rect(
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> Result<ScreenCapture, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::io::Cursor;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP, HGDIOBJ, SRCCOPY,
    };

    if width <= 0 || height <= 0 {
        return Err(format!("无效的截图区域尺寸: {width}x{height}"));
    }

    unsafe {

        let screen_dc = GetDC(HWND(std::ptr::null_mut()));
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.0.is_null() {
            let _ = ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
            return Err("创建兼容 DC 失败".to_string());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负值 = top-down DIB，行序与内存一致
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: (width * height * 4) as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        // ⚠️ 下面这段有三处可能提前返回（CreateDIBSection / from_raw / JPEG 编码）。
        // 原实现把 GDI 清理放在函数尾部，任一处 `?` 触发就会跳过它，
        // 而长截图每帧都调本函数——编码偶发失败会持续泄漏一个 DC 加一张 4K DIB（约 33MB），
        // GDI 对象有每进程配额，泄到上限后所有截图都会失败。
        // 故把可失败部分收进闭包，出来后无论成败都走同一段清理。
        let mut hbmp = HBITMAP::default();
        let mut old = HGDIOBJ::default();
        let result = (|| -> Result<ScreenCapture, String> {
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        hbmp = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|e| format!("创建 DIB 位图失败: {e}"))?;
        old = SelectObject(mem_dc, hbmp);
        let _ = BitBlt(mem_dc, 0, 0, width, height, screen_dc, origin_x, origin_y, SRCCOPY);

        // BGRA 像素 → RGBA（image crate 用 RGBA）
        let len = (width as usize) * (height as usize) * 4;
        let bgra = std::slice::from_raw_parts(bits as *mut u8, len);
        let mut rgba = Vec::with_capacity(len);
        for px in bgra.chunks_exact(4) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }

        let img = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
            .ok_or_else(|| "像素数据构造失败".to_string())?;
        // JPEG 0.9：4K 全屏 PNG（~20MB）编码/传输/解码比 JPEG（~4MB）慢约 5 倍，
        // 截图打开与长截图每帧都受益；屏幕截图在 0.9 质量下几乎无可见损失
        // （合成输出本来就是 JPEG 0.92，取色/马赛克采样在无损语义下人眼无感）。
        // ⚠️ JPEG 无 alpha：编码前必须 Rgba8 → Rgb8，否则报
        // "encoder or decoder for Jpeg does not support the color type 'Rgba8'"（实测坑）。
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let mut jpg_buf = Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg_buf, 90);
        rgb.write_with_encoder(encoder)
            .map_err(|e| format!("JPEG 编码失败: {e}"))?;
        log::info!(
            "[Screenshot] 截屏成功 {}x{} @({},{}), jpeg {} bytes",
            width,
            height,
            origin_x,
            origin_y,
            jpg_buf.get_ref().len()
        );

        Ok(ScreenCapture {
            data_url: format!(
                "data:image/jpeg;base64,{}",
                STANDARD.encode(jpg_buf.into_inner())
            ),
            origin_x,
            origin_y,
            width,
            height,
        })
        })();

        // 清理 GDI 资源（先还原对象再删位图，避免悬挂）——成功与失败路径共用
        if !hbmp.0.is_null() {
            let _ = SelectObject(mem_dc, old);
            let _ = DeleteObject(hbmp);
        }
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
        result
    }
}

/// 保存截图结果（PNG data URL → 应用数据目录 screenshots/，md5 去重），返回文件路径。
/// 供 OCR / 复制图片 / 保存图库复用同一文件。
#[tauri::command]
pub fn save_screenshot_image(
    app_handle: tauri::AppHandle,
    data_base64: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use md5::{Digest, Md5};

    // 截图合成图放宽到 50MB（4K 全屏 PNG 可能十几 MB），但仍设上限防 OOM
    const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;

    let payload = match data_base64.find(',') {
        Some(idx) if data_base64.starts_with("data:") => &data_base64[idx + 1..],
        _ => data_base64.as_str(),
    };
    let bytes = STANDARD
        .decode(payload)
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大 ({}MB)，超过 50MB 限制",
            bytes.len() / 1024 / 1024
        ));
    }
    let ext = image::guess_format(&bytes)
        .map_err(|_| "无法识别的图片格式".to_string())?
        .extensions_str()
        .first()
        .copied()
        .unwrap_or("png");

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {e}"))?;
    let shots_dir = app_dir.join("screenshots");
    std::fs::create_dir_all(&shots_dir).map_err(|e| format!("创建截图目录失败: {e}"))?;

    let hash = format!("{:x}", Md5::new().chain_update(&bytes).finalize());
    let file_path = shots_dir.join(format!("{}.{}", hash, ext));
    if !file_path.exists() {
        // 先写临时文件再原子 rename，防止写一半崩溃留下残缺图片（同 save_rich_image）
        let tmp_path = file_path.with_extension(format!("{}.tmp", ext));
        std::fs::write(&tmp_path, &bytes).map_err(|e| format!("写入截图失败: {e}"))?;
        if let Err(e) = std::fs::rename(&tmp_path, &file_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("重命名临时文件失败: {e}"));
        }
    }
    Ok(file_path.to_string_lossy().to_string())
}

/// 打开（或复用）截图窗口：全局热键回调入口。
/// 已存在 → 重新 show + focus + 通知前端刷新；否则新建（覆盖整个虚拟屏幕）。
///
/// V6 启动提速：**截屏与窗口创建并行**——后台线程立即开始 BitBlt+JPEG 编码并缓存，
/// 前端挂载/刷新后直接 take 取用，省掉"窗口加载完 → 再截屏"的串行等待。
pub fn open_screenshot_window(app: &AppHandle) {
    // 先保存当前前台窗口句柄：截图完成后"复制图片"要粘贴/回填到原目标
    if let Some(engine) = app.try_state::<crate::paste_engine::PasteEngine>() {
        engine.save_foreground_hwnd();
    }
    // 并行截屏（不阻塞热键回调；窗口创建期间编码完成）
    #[cfg(target_os = "windows")]
    {
        let app2 = app.clone();
        std::thread::spawn(move || {
            if let Ok(shot) = capture_virtual_screen() {
                if let Some(p) = app2.try_state::<PendingShotCapture>() {
                    *p.0.lock().unwrap_or_else(|x| x.into_inner()) = Some(shot);
                }
            }
        });
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("screenshot-refresh", ());
        return;
    }
    create_window(app);
}

/// 待取截屏缓存（open_screenshot_window 并行截屏后存入，前端挂载/刷新时 take 走）。
pub struct PendingShotCapture(pub std::sync::Mutex<Option<ScreenCapture>>);

/// 取走预截屏结果（一次性；None 表示窗口创建前截屏未完成，前端回退自行截屏）
#[tauri::command]
pub fn take_pending_shot_capture(state: tauri::State<'_, PendingShotCapture>) -> Option<ScreenCapture> {
    state.0.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// 防止并发创建同名窗口（快速连按热键）
static CREATING: AtomicBool = AtomicBool::new(false);

fn create_window(app: &AppHandle) {
    if CREATING.swap(true, Ordering::SeqCst) {
        log::info!("[Screenshot] 窗口创建中，忽略重复调用");
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        struct ResetOnDrop;
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                CREATING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ResetOnDrop;

        let (w, h, x, y) = virtual_screen_metrics();
        match tauri::WebviewWindowBuilder::new(
            &app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("screenshot.html".into()),
        )
        .title("")
        .inner_size(w as f64, h as f64)
        .position(x as f64, y as f64)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .visible(false)
        .build()
        {
            Ok(window) => {
                let _ = window.show();
                let _ = window.set_focus();
                log::info!(
                    "[Screenshot] 截图窗口已创建并显示 {}x{} @({},{})",
                    w,
                    h,
                    x,
                    y
                );
            }
            Err(e) => log::warn!("[Screenshot] 创建截图窗口失败: {}", e),
        }
    });
}

#[cfg(target_os = "windows")]
fn virtual_screen_metrics() -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        (
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
        )
    }
}

#[cfg(not(target_os = "windows"))]
fn virtual_screen_metrics() -> (i32, i32, i32, i32) {
    (1920, 1080, 0, 0)
}

/// 光标当前位置（物理像素，虚拟屏幕坐标——与 snap_window_at 同口径）
#[tauri::command]
pub fn get_cursor_pos() -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut pt);
        }
        (pt.x, pt.y)
    }
    #[cfg(not(target_os = "windows"))]
    {
        (0, 0)
    }
}

/// 截图自动框选光标所在窗口的开关（设置页可关，默认开）
#[tauri::command]
pub fn get_auto_frame_window(store: tauri::State<'_, crate::data_store::DataStore>) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get("auto_frame_window").and_then(|v| v.as_bool()))
        .unwrap_or(true)
}

/// 截图完成后自动执行的动作链 id（设置页配置，空 = 不自动；自动执行仅限纯本地步骤）
#[tauri::command]
pub fn get_auto_chain_after_screenshot(
    store: tauri::State<'_, crate::data_store::DataStore>,
) -> Option<String> {
    store
        .get_config()
        .ok()
        .and_then(|c| {
            c.get("auto_chain_after_screenshot")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
}

/// 截图复制后向主窗口推送 OCR 就绪提示（截图窗口已关闭，toast 只能发主窗口）
#[tauri::command]
pub fn emit_ocr_ready(app: tauri::AppHandle, text: String, line_count: usize) {
    let _ = app.emit(
        "screenshot-ocr-ready",
        serde_json::json!({ "text": text, "count": line_count }),
    );
}

// ===== V6.19 第二梯队：截图插入当前编辑文档 =====

/// 当前全屏编辑器打开的文件路径（编辑器打开时注册、关闭时清除）
pub struct EditorTarget(pub std::sync::Mutex<Option<String>>);

/// 编辑器打开/关闭时注册目标文件（None = 关闭）
#[tauri::command]
pub fn set_editor_target(state: tauri::State<'_, EditorTarget>, editor_path: Option<String>) {
    let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    *guard = editor_path;
}

/// 查询当前编辑器目标文件（截图窗口判断是否显示"插入到文档"）
#[tauri::command]
pub fn get_editor_target(state: tauri::State<'_, EditorTarget>) -> Option<String> {
    state.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 截图插入当前编辑文档：把图片引用追加到 md 文件末尾（编辑器 useFileWatch 自动重载）
#[tauri::command]
pub fn insert_into_editor(editor_path: String, image_path: String) -> Result<(), String> {
    use std::io::Write;
    // markdown 图片引用：相对路径更稳（图片在 app_data/screenshots/，编辑器可能指向任意位置），
    // 但文件移动会断；用绝对路径（Windows 盘符）最直接，且 useFileWatch 只监听本文件变化。
    let line = format!("\n\n![]({})\n", image_path.replace('\\', "/"));
    // ⚠️ 必须走 append，不能「读全文 + 覆盖写」。原实现是
    // `read_to_string(..).unwrap_or_default()` 再 `fs::write(全文 + 新行)`：
    // 读一旦失败（文件被编辑器独占 / 不是 UTF-8 / 权限不足）就会拿空串去覆盖，
    // 把用户整份文档清成只剩一行图片引用——不进回收站、不可恢复。
    // create(true)：保留原来「文件不存在则新建」的行为；append 保证任何情况下都不截断。
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&editor_path)
        .map_err(|e| format!("打开编辑器文件失败: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("写入编辑器文件失败: {e}"))?;
    log::info!("[Screenshot] 截图已插入编辑器: {}", editor_path);
    Ok(())
}

// ===== 提前 OCR 的临时图：关窗即删 =====

/// 标注态会先把选区原图存成 PNG 喂给 OCR（PNG 无损，JPEG 伪影会掉识别率）。
/// 这张图纯属中间产物，不清理的话每截一次图就在 screenshots/ 里多留一张全尺寸 PNG。
/// ⚠️ 它与用户最终要的结果图是两个文件（PNG vs JPEG 0.92，md5 不同，不会互相顶掉）。
/// 如果以后把提前 OCR 也改成 JPEG，必须重新审视这里——两者会变成同一个文件，删临时图等于删结果图。
static OCR_TEMP: std::sync::OnceLock<std::sync::Mutex<Option<std::path::PathBuf>>> =
    std::sync::OnceLock::new();

fn ocr_temp_slot() -> &'static std::sync::Mutex<Option<std::path::PathBuf>> {
    OCR_TEMP.get_or_init(|| std::sync::Mutex::new(None))
}

/// 只允许删 app_data/screenshots/ 下的文件。路径来自前端，不做归属校验
/// 等于开了一个「删任意文件」的口子。
fn is_under_screenshots(app: &AppHandle, p: &std::path::Path) -> bool {
    let Ok(dir) = app.path().app_data_dir() else {
        return false;
    };
    match (p.canonicalize(), dir.join("screenshots").canonicalize()) {
        (Ok(a), Ok(b)) => a.starts_with(b),
        _ => false,
    }
}

/// 删掉已登记的临时 OCR 图（关窗 / 登记新图时调用）
fn purge_ocr_temp(app: &AppHandle) {
    let old = ocr_temp_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(p) = old {
        if is_under_screenshots(app, &p) {
            match std::fs::remove_file(&p) {
                Ok(_) => log::info!("[Screenshot] 已清理临时 OCR 图: {}", p.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::warn!("[Screenshot] 清理临时 OCR 图失败: {e}"),
            }
        }
    }
}

/// 登记本次的临时 OCR 图（前端提前识别存完后调用）。
/// 登记新的会先删掉上一张，避免反复截图时累积（窗口常驻，不每次都走 close）。
#[tauri::command]
pub fn mark_ocr_temp(app: tauri::AppHandle, path: String) {
    purge_ocr_temp(&app);
    *ocr_temp_slot().lock().unwrap_or_else(|p| p.into_inner()) =
        Some(std::path::PathBuf::from(path));
}

/// 关闭截图窗口（前端 Esc 取消 / 完成出口后调用；close 销毁窗口，资源干净释放）
#[tauri::command]
pub fn close_screenshot_window(app: tauri::AppHandle) {
    // 关窗即删临时 OCR 图。放在后端而不是前端 close()：截图窗口有多条关闭路径
    // （Esc / 失焦自动取消 / 各个完成出口 / 截屏失败页的关闭按钮），
    // 它们最终都汇到这个命令，在这里收口才不会漏（规则 11.1）。
    purge_ocr_temp(&app);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
}

/// 隐藏截图窗口（长截图滚动捕获时临时隐藏，让滚轮事件落到目标窗口）
#[tauri::command]
pub fn hide_screenshot_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// 重新显示截图窗口（长截图完成后恢复，状态保留）
#[tauri::command]
pub fn show_screenshot_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ===== 截图主动入库（修复：复制图片出口走剪贴板监控会被 suppress/1080px 缩放拦掉） =====

/// 截图"复制图片"出口：主动把截图片入库剪贴板历史，并把 OCR 全文写入内容记忆摘要
/// （语义检索可命中"那张图的字"）。
///
/// 为什么必须主动入库：`copy_image_only` 会设置与图片内容 hash 一致的粘贴抑制，
/// 剪贴板监控看到同 hash 位图直接跳过（防粘贴重复），截图复制因此**不会**进历史；
/// 即便进了，监控也会把大图缩到 1080px 重存到 images/，OCR 缓存（key 为截图路径）
/// 查不到——记忆检索整条链路悬空。截图流程自己入库：内容用截图原始文件、OCR 直接写入。
///
/// md5 口径与 copy_image_only / 剪贴板监控一致：RGBA 像素字节。
#[tauri::command]
pub fn insert_screenshot_to_history(
    app: tauri::AppHandle,
    image_path: String,
    ocr_text: Option<String>,
) -> Result<(), String> {
    use md5::{Digest, Md5};
    use uuid::Uuid;

    let img = image::open(&image_path).map_err(|e| format!("无法读取截图: {e}"))?;
    let (w, h) = image::GenericImageView::dimensions(&img);
    let rgba = img.to_rgba8();
    let img_hash = format!("{:x}", Md5::new().chain_update(rgba.as_raw()).finalize());
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let store = app.state::<crate::data_store::DataStore>();
    // 查重：同一图片已入库只更新时间（与剪贴板监控的智能合并行为一致）
    if let Ok(Some(existing)) = store.find_latest_by_md5(&img_hash, "默认", "image") {
        let _ = store.update_history_time(&existing.id, &now_str);
        if let Some(t) = ocr_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            let _ = store.history_summary_ensure(&existing.id, t);
        }
        return Ok(());
    }

    let item = crate::data_store::HistoryItem {
        id: Uuid::new_v4().to_string(),
        text: format!("[图片] {}x{}", w, h),
        time: now_str,
        item_type: "image".to_string(),
        content: image_path,
        pinned: false,
        source: "PastePanda 截图".to_string(),
        workspace: "默认".to_string(),
        md5: Some(img_hash),
        pinyin_initials: None,
        group_id: None,
        source_icon: None,
        content_type: Some("image".to_string()),
        ocr_text: ocr_text.clone(),
        tags: Vec::new(),
    };
    store.insert_history(&item)?;
    if let Some(t) = ocr_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        store.history_summary_ensure(&item.id, t)?;
        // V6.19 联动：OCR 全文走内容分类 → 截图卡片自动打类型标签（代码/表格/链接/密钥…），
        // 与剪贴板文字的自动标签同一套体系，历史里可按标签同时筛出文字与截图。
        let labels = crate::content_classifier::ContentClassifier::new().classify(t);
        crate::clipboard_monitor::enqueue_auto_tags(app.clone(), item.id.clone(), labels);
    }
    // 通知前端刷新列表
    let _ = app.emit(
        "clipboard-changed",
        crate::clipboard_monitor::ClipboardChanged { item },
    );
    Ok(())
}

// ===== 贴图双击重新编辑（截图标注窗口"编辑模式"） =====

/// 截图标注窗口待取的编辑图片路径（贴图双击 → open_editor_window 存入，前端挂载/take 取走）。
/// 与 lib.rs 的 PendingEditor 同模式：规避"窗口未加载完就 emit 丢失"的时序竞态。
pub struct PendingShotEdit(pub std::sync::Mutex<Option<String>>);

/// 取走待编辑图片路径（一次性）
#[tauri::command]
pub fn take_pending_shot_edit(state: tauri::State<'_, PendingShotEdit>) -> Option<String> {
    state.0.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// 贴图窗口 → 重新编辑的回调注册（open_pinned_image 命令在打开贴图时调用）。
/// 多贴图并存（V5）：slot 存"最近一次贴图"，窗口创建后按 hwnd 绑定到 map，
/// 双击哪个贴图就编辑哪张（不再只认最后一张）。
static PINNED_EDIT_SLOT: std::sync::OnceLock<std::sync::Mutex<Option<(tauri::AppHandle, String)>>> =
    std::sync::OnceLock::new();
static PINNED_EDIT_MAP: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<isize, (tauri::AppHandle, String)>>,
> = std::sync::OnceLock::new();

fn pinned_edit_slot() -> &'static std::sync::Mutex<Option<(tauri::AppHandle, String)>> {
    PINNED_EDIT_SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

fn pinned_edit_map() -> &'static std::sync::Mutex<std::collections::HashMap<isize, (tauri::AppHandle, String)>> {
    PINNED_EDIT_MAP.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 登记当前贴图（open_pinned_image 调用；窗口创建后由 pinned_window 绑定 hwnd）
pub fn register_pinned_edit(app: &tauri::AppHandle, path: &str) {
    *pinned_edit_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some((app.clone(), path.to_string()));
}

/// 窗口创建后绑定（pinned_window 的 run_window_loop 拿到 hwnd 后调用）
pub fn bind_pinned_edit(hwnd: isize, app: &tauri::AppHandle, path: &str) {
    pinned_edit_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(hwnd, (app.clone(), path.to_string()));
}

/// 窗口销毁时解除绑定（pinned_window 的 WM_DESTROY 调用）。
/// 原先叫 take_pinned_edit_by_hwnd，被双击处理当成「取值」用，结果双击一次就把绑定消耗掉了；
/// 现在取值一律用 peek，本函数只用于销毁时清理（防 map 泄漏 + HWND 复用串号）。
pub fn unbind_pinned_edit(hwnd: isize) -> Option<(tauri::AppHandle, String)> {
    pinned_edit_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&hwnd)
}

/// 查询贴图信息（右键菜单用，不取走）
pub fn peek_pinned_edit_by_hwnd(hwnd: isize) -> Option<(tauri::AppHandle, String)> {
    pinned_edit_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&hwnd)
        .cloned()
}

/// 最近一次待绑定贴图（窗口线程内取用）
pub fn take_pinned_edit_request() -> Option<(tauri::AppHandle, String)> {
    pinned_edit_slot().lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// 打开截图窗口进入"编辑模式"：窗口按图片 fit 尺寸 resize + 居中，前端 take pending 后载图标注。
pub fn open_editor_window(app: &tauri::AppHandle, path: String) {
    if let Some(p) = app.try_state::<PendingShotEdit>() {
        *p.0.lock().unwrap_or_else(|x| x.into_inner()) = Some(path.clone());
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("screenshot-edit-image", path);
        return;
    }
    create_window(app);
    // 前端挂载后 take_pending_shot_edit 拿到路径，自行 setSize/setPosition 并载图
}

/// 虚拟屏幕物理尺寸（供前端编辑模式计算 fit 窗口尺寸）
#[tauri::command]
pub fn virtual_screen_size() -> (i32, i32) {
    let (w, h, _, _) = virtual_screen_metrics();
    (w, h)
}

// ===== V6.19 贴图管理面板 =====

/// 当前贴图路径列表
#[tauri::command]
pub fn list_pinned_images() -> Vec<String> {
    crate::pinned_window::list_pinned_images()
}

/// 关闭指定贴图（面板"关闭单张"）
#[tauri::command]
pub fn close_pinned_image_by_path(path: String) {
    crate::pinned_window::close_pinned_by_path(&path);
}

/// 托盘"贴图管理"入口：显示主窗口并通知前端弹出贴图面板
#[tauri::command]
pub fn open_pinned_panel(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("show-pinned-panel", ());
}

/// 贴图面板"重新编辑"：打开截图标注窗口载入该图
#[tauri::command]
pub fn open_pinned_edit(app: tauri::AppHandle, path: String) {
    open_editor_window(&app, path);
}

// ===== 吸附窗口（点击自动框选目标窗口） =====

/// 吸附矩形（物理像素，虚拟屏幕坐标）
#[derive(serde::Serialize)]
pub struct SnapRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 命中测试：给定物理坐标，返回光标下方有效窗口的屏幕矩形（排除自身/桌面/任务栏）。
/// 用 EnumWindows 从 Z 序最上层开始遍历，跳过截图窗口自身后取第一个包含该点的可见窗口——
/// 因为截图窗口全屏透明覆盖，WindowFromPoint 只会命中它自己。
#[tauri::command]
pub fn snap_window_at(app: tauri::AppHandle, x: i32, y: i32) -> Result<Option<SnapRect>, String> {
    #[cfg(target_os = "windows")]
    {
        snap_window_impl(&app, x, y)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, x, y);
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
fn snap_window_impl(app: &tauri::AppHandle, x: i32, y: i32) -> Result<Option<SnapRect>, String> {
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetDesktopWindow, GetWindowRect, WNDENUMPROC,
    };

    unsafe {
        // 排除截图窗口自身（全屏透明覆盖层）
        let self_hwnd = app
            .get_webview_window(WINDOW_LABEL)
            .and_then(|w| w.hwnd().ok())
            .map(|h| HWND(h.0 as *mut _))
            .unwrap_or_default();
        let desktop = GetDesktopWindow();
        let pt = POINT { x, y };

        // EnumWindows 从 Z 序最上层开始，找到第一个包含该点、可见、非自身的顶层窗口
        let mut ctx = (self_hwnd, pt, desktop, None::<HWND>);
        let lparam = LPARAM(&mut ctx as *mut _ as isize);
        let enum_fn: WNDENUMPROC = Some(enum_snap_proc);
        let _ = EnumWindows(enum_fn, lparam);

        let Some(hwnd) = ctx.3 else {
            return Ok(None);
        };

        // 视觉边界优先（排除 DWM 阴影），失败回退 GetWindowRect
        let mut bounds = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut bounds as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr.is_err() || bounds.right <= bounds.left || bounds.bottom <= bounds.top {
            let mut r = RECT::default();
            let _ = GetWindowRect(hwnd, &mut r);
            bounds = r;
        }

        Ok(Some(SnapRect {
            x: bounds.left,
            y: bounds.top,
            w: bounds.right - bounds.left,
            h: bounds.bottom - bounds.top,
        }))
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_snap_proc(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::{HWND, POINT, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowRect, IsIconic, IsWindowVisible,
    };

    let ctx = lparam.0 as *mut (HWND, POINT, HWND, Option<HWND>);
    let (self_hwnd, pt, desktop, found) = &mut *ctx;
    if hwnd == *self_hwnd || hwnd == *desktop {
        return TRUE;
    }
    // 排除任务栏 / 桌面图标层
    let mut cls: [u16; 64] = [0; 64];
    let n = GetClassNameW(hwnd, &mut cls);
    if n > 0 {
        let name = String::from_utf16_lossy(&cls[..n as usize]);
        if name == "Shell_TrayWnd" || name == "Progman" || name == "WorkerW" {
            return TRUE;
        }
    }
    if IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_ok()
            && pt.x >= r.left && pt.x < r.right
            && pt.y >= r.top && pt.y < r.bottom
            && (r.right - r.left) >= 20
            && (r.bottom - r.top) >= 20
        {
            *found = Some(hwnd);
            return windows::Win32::Foundation::FALSE; // 停止遍历
        }
    }
    TRUE
}

// ===== 长截图：滚动注入 =====

/// 在指定物理坐标处发送鼠标滚轮事件（长截图滚动注入）。
///
/// 默认走 `PostMessage(WM_MOUSEWHEEL)` 直接投给目标窗口，**完全不动物理光标**；
/// 原实现是 SetCursorPos 把光标抢过去 → SendInput → 再放回，每帧一次，
/// 用户会看到光标反复跳，而且要 sleep(30ms) 等光标生效。
///
/// `force_input = true` 时直接用 SendInput：部分应用（游戏、某些自绘制控件）只认
/// 真实输入设备事件、不响应 PostMessage，前端发现画面没动时会带着这个标志重试一帧，
/// 避免把「注入方式不被接受」误判成「已滚到底」。
#[tauri::command]
pub fn send_mouse_wheel(
    x: i32,
    y: i32,
    delta: i32,
    force_input: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if force_input.unwrap_or(false) {
            send_wheel_via_input(x, y, delta)
        } else {
            // PostMessage 失败（没找到窗口等）则当场回退，不让一帧白丢
            send_wheel_via_post(x, y, delta).or_else(|_| send_wheel_via_input(x, y, delta))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, delta, force_input);
        Err("长截图功能目前仅支持 Windows".to_string())
    }
}

/// 不动光标的滚轮注入：把 WM_MOUSEWHEEL 直接 Post 给坐标下的窗口。
#[cfg(target_os = "windows")]
fn send_wheel_via_post(x: i32, y: i32, delta: i32) -> Result<(), String> {
    use windows::Win32::Foundation::{LPARAM, POINT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WindowFromPoint, WM_MOUSEWHEEL};

    unsafe {
        // 注：目前长截图期间截图窗口是隐藏的，所以这里命中的就是目标窗口。
        // 若以后改成「不隐藏窗口」（长截图交互设计稿 §1），这里会命中截图窗口自己，
        // 到时候必须改成像 snap_window_impl 那样枚举并排除自身。
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.0.is_null() {
            return Err("该位置没有窗口".to_string());
        }
        // wParam 高 16 位 = 有符号 delta，低 16 位 = 修饰键（不带）
        let wparam = WPARAM(((delta as i16 as u16 as usize) << 16) & 0xFFFF_0000);
        // ⚠️ WM_MOUSEWHEEL 的 lParam 是**屏幕坐标**（不是客户区坐标），且每轴只有 16 位：
        // 超大分辨率或多显示器负坐标会被截断。绝大多数应用靠 hwnd 定位、不读这个坐标，可接受。
        let lparam =
            LPARAM(((((y as i16 as u16) as u32) << 16) | ((x as i16 as u16) as u32)) as isize);
        PostMessageW(hwnd, WM_MOUSEWHEEL, wparam, lparam)
            .map_err(|e| format!("PostMessage 滚轮失败: {e:?}"))
    }
}

/// 回退方案：真实输入事件（会临时抢光标）。
/// 部分应用只认 SendInput，所以不能删。
#[cfg(target_os = "windows")]
fn send_wheel_via_input(x: i32, y: i32, delta: i32) -> Result<(), String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT, MOUSEEVENTF_WHEEL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    unsafe {
        // 保存当前光标位置
        let mut old = POINT::default();
        let _ = GetCursorPos(&mut old);
        // 移到滚动区域中心
        let _ = SetCursorPos(x, y);
        // 短暂等待光标生效（SendInput 的 wheel 事件发到光标所在窗口）
        std::thread::sleep(std::time::Duration::from_millis(30));

        let mi = MOUSEINPUT {
            dx: x,
            dy: y,
            mouseData: delta as u32, // 120 = 一格；负 = 向下滚动
            dwFlags: MOUSEEVENTF_WHEEL,
            ..Default::default()
        };
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi },
        };
        let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        // 恢复光标
        let _ = SetCursorPos(old.x, old.y);
        if sent == 0 {
            return Err("发送滚轮事件失败".to_string());
        }
        Ok(())
    }
}
