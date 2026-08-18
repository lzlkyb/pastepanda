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

/// 截图结果：data URL + 虚拟屏幕物理坐标与尺寸。
///
/// ⚠️ `rename_all = "camelCase"` 不能删：前端 `ScreenInfo` 读的是 `dataUrl` /
/// `originX` / `originY`。之前漏了这行，serde 序列化出的是 snake_case，
/// 前端取到的全是 `undefined` —— 而 JS 读不存在的属性不报错，于是一路静默降级：
///   ① `img.src = undefined` → 底图永远加载失败 → 马赛克/模糊退化成色块、吸管取不到色；
///   ② `ensureResultPath` 里同一句 loadImage 失败 → "完成"/"更多"点了没反应；
///   ③ `toScreenPt` 拿 `originX` 算出 NaN → 长截图截区域坐标全错。
/// 截图窗是全屏透明的，底图没加载时看到的是真实屏幕，肉眼完全看不出来。
///
/// 同形态的 bug 本项目已经出过一次：OcrResult 的 `full_text` vs `fullText`（见
/// `src/lib/api/images.ts` 里的注释），当时的解法是"在 api 包装层归一化"。
/// 截图这块没有包装层（直接 invoke<ScreenInfo>），于是同一个坑又踩了一遍。
/// 靠"记得在包装层归一化"不可靠 —— 直接让后端输出 camelCase 才是治本。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
pub async fn capture_region(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<ScreenCapture, String> {
    #[cfg(target_os = "windows")]
    {
        // 长截图期间临时隐藏状态窗，避免它被拼进长图（截图窗自身已 hide，
        // 这是唯一还可见的浮层）。普通截图时该窗不存在，hide/show 均为 no-op，零开销。
        let status = app.get_webview_window(LONGSHOT_LABEL);
        if let Some(win) = &status {
            let _ = win.hide();
            // ❌ hide() 之后必须给 DWM 一点时间重合成：ShowWindow(SW_HIDE) 只是发起隐藏，
            // 屏幕内容未必已经更新，而 BitBlt 是从屏幕 DC 拉像素的——不等就可能
            // 把刚“隐藏”的状态窗拍进长图里。一帧的量级就够，对总时长无影响。
            tokio::time::sleep(std::time::Duration::from_millis(16)).await;
        }
        let res = tokio::task::spawn_blocking(move || capture_rect(x, y, w, h)).await;
        // ❌ 恢复必须在 `?` **之前**：旧写法把 `?` 放在 show() 前面，一旦 spawn_blocking
        // 报 JoinError（capture_rect panic，比如超大矩形分配失败）就提前返回，
        // 状态窗**永久隐藏**——用户就此失去唯一的「停止/放弃」入口。
        if let Some(win) = &status {
            let _ = win.show();
        }
        res.map_err(|e| format!("截图任务失败: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, x, y, w, h);
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

/// GDI 抓像素：按屏幕坐标矩形取 RGBA，**不做任何编码**。
///
/// 从 capture_rect 里拆出来的原因有两个：
/// ① 编码格式选型（JPEG / PNG / 压缩等级）的基准必须拿**未经压缩的真实像素**去测——
///    拿已经 JPEG 过一遍的图测 PNG，体积会因为 JPEG 振铃引入的高频噪声而明显偏大，
///    结论会偏保守；
/// ② 后续若把底图改成无损或改走 asset protocol，都只需要换编码那一段。
#[cfg(target_os = "windows")]
fn grab_rect_rgba(
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> Result<Vec<u8>, String> {
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
        let result = (|| -> Result<Vec<u8>, String> {
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        hbmp = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|e| format!("创建 DIB 位图失败: {e}"))?;
        old = SelectObject(mem_dc, hbmp);
        // 已知限制（跨屏错位）：origin_x/origin_y 是「虚拟屏幕」物理坐标（整屏 DC 原点）。
        // 混合 DPI 多显示器下，BitBlt 跨屏拷贝可能出现原点偏移，导致跨显示器选区内容错位。
        // P2-B2 只保证「每片同比例」（前端 drawImage 拉伸归一），未根治跨屏坐标错位；
        // 根治需按显示器分块截取再拼合（属大改，本次未做）。见前端 P2-B2 段注释。
        let _ = BitBlt(mem_dc, 0, 0, width, height, screen_dc, origin_x, origin_y, SRCCOPY);

        // BGRA 像素 → RGBA（image crate 用 RGBA）
        let len = (width as usize) * (height as usize) * 4;
        let bgra = std::slice::from_raw_parts(bits as *mut u8, len);
        let mut rgba = Vec::with_capacity(len);
        for px in bgra.chunks_exact(4) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }

        Ok(rgba)
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

/// 抓像素 + 编码成 data URL。
#[cfg(target_os = "windows")]
fn capture_rect(
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> Result<ScreenCapture, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};

    let rgba = grab_rect_rgba(origin_x, origin_y, width, height)?;
    let img = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| "像素数据构造失败".to_string())?;

    // 无损 PNG（Fast 压缩 + Up 滤波器）。
    //
    // 这里原本是 JPEG q90，注释写着“4K 全屏 PNG 编码/传输/解码比 JPEG 慢约 5 倍”。
    // 那句话是错的 —— encode_bench 在 2560x1440（368 万像素）上的实测：
    //
    //   JPEG q90 (4:2:2)   150.3ms   0.70MB   base64 0.93MB   ← 旧实现
    //   PNG Fast/Up         25.0ms   2.50MB   base64 3.34MB   ← 现在
    //   PNG Fast/NoFilter   39.3ms  11.06MB
    //   PNG Fast/Adaptive  154.9ms   1.88MB
    //   PNG Default/Up     220.5ms   1.54MB
    //   PNG Default/Adapt  384.1ms   1.48MB
    //
    // 旧结论大概是用 PNG **默认参数**（Default/Adaptive = 384ms）得出的。
    // 换成 Fast/Up 后比 JPEG **快 6 倍**：`Up` 是逐行差分，而屏幕内容有大量
    // 水平重复的纯色行，差分后几乎全零，既快又小。
    //
    // 为什么要无损：user 反馈“截图没有实际图片清晰”。image 0.25 的 JpegEncoder
    // 写死 4:2:2 色度抽样（与 quality 无关，见 codecs/jpeg/encoder.rs），
    // 叠上前端合成时的第二代 JPEG，屏幕文字边缘发虚并带彩色镶边。
    // 现在两代都是无损了（前端那一代见 canvasToDataUrl）。
    //
    // 仍然转 RGB8：alpha 恒为 255，带上它白白多 25% 数据；且基准测的就是 RGB8。
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut png_buf: Vec<u8> = Vec::new();
    PngEncoder::new_with_quality(&mut png_buf, CompressionType::Fast, FilterType::Up)
        .write_image(&rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    log::info!(
        "[Screenshot] 截屏成功 {}x{} @({},{}), png {} bytes",
        width,
        height,
        origin_x,
        origin_y,
        png_buf.len()
    );

    Ok(ScreenCapture {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(png_buf)),
        origin_x,
        origin_y,
        width,
        height,
    })
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

    // 上限从 50MB 抬到 120MB。
    //
    // 原因：合成输出从 JPEG 0.92 改回了无损 PNG（修“截图不如实际清晰”），
    // 而 PNG 在屏幕内容上比 JPEG 大 4~6 倍。长截图的高度上限是 12000px
    // （见前端 MAX_H），配 4K 宽选区就是 3000 万像素，文字密集的 PNG 能到 20～30MB。
    //
    // 为什么不能“到了上限再说”：这个报错发生在长截图的**最后一步**，
    // 用户已经滴了半分钟滚轮，报一句“图片过大”就把成果全丢了。
    const MAX_IMAGE_BYTES: usize = 120 * 1024 * 1024;

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
    // ⚠️ 必须先清掉上一轮残留的预截屏，再启动新的。
    //
    // 竞态：预截屏是异步写入的（BitBlt + JPEG 编码几百毫秒），而 emit refresh 是立刻的。
    // 若本轮"前端 take 早于后台线程写入"，前端会回退自截（拿到的图是对的），
    // 但那个线程随后仍会把这一轮的图写进缓存且无人取走 —— 下次按热键，
    // 前端一 take 就拿到上一次的画面，表现为"同一窗口第二次截图还是旧内容"，
    // 而且一旦发生就永远慢一拍（每次都把本轮的图留给下一次）。
    if let Some(p) = app.try_state::<PendingShotCapture>() {
        *p.0.lock().unwrap_or_else(|x| x.into_inner()) = None;
    }
    // 并行截屏（不阻塞热键回调；窗口创建期间编码完成）
    #[cfg(target_os = "windows")]
    {
        let app2 = app.clone();
        std::thread::spawn(move || {
            if let Ok(shot) = capture_virtual_screen() {
                if let Some(p) = app2.try_state::<PendingShotCapture>() {
                    *p.0.lock().unwrap_or_else(|x| x.into_inner()) =
                        Some((shot, std::time::Instant::now()));
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
/// 带写入时间：预截屏只在“刚按下热键”那一瞬有意义，隔了一段时间的一定是残留。
pub struct PendingShotCapture(
    pub std::sync::Mutex<Option<(ScreenCapture, std::time::Instant)>>,
);

/// 预截屏的有效期。超过这个时长就不可能是本轮的结果，
/// 宁可让前端自己重截（多几百毫秒），也不能给一张旧图。
const PENDING_SHOT_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// 取走预截屏结果（一次性；None 表示窗口创建前截屏未完成，前端回退自行截屏）。
/// 除了 open 时会主动清空，这里再加一道 TTL —— 双保险，因为“发出旧图”是静默且难发现的错误。
#[tauri::command]
pub fn take_pending_shot_capture(
    state: tauri::State<'_, PendingShotCapture>,
) -> Option<ScreenCapture> {
    let taken = state.0.lock().unwrap_or_else(|p| p.into_inner()).take();
    match taken {
        Some((shot, at)) if at.elapsed() < PENDING_SHOT_TTL => Some(shot),
        Some((_, at)) => {
            log::warn!(
                "[Screenshot] 丢弃过期预截屏（{}ms 前写入），前端将自行重截",
                at.elapsed().as_millis()
            );
            None
        }
        None => None,
    }
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
                // ⚠️ builder 的 inner_size / position 收的是**逻辑像素**
                //（tauri 2.11 webview_window.rs 的 doc 原话："Window size in logical pixels"、
                // "The initial position of the window in logical pixels"），
                // 而 virtual_screen_metrics() 给的是**物理像素**——进程被 tao 设成了
                // PER_MONITOR_AWARE_V2，GetSystemMetrics(SM_CXVIRTUALSCREEN) 不再虚拟化。
                //
                // 单位穿错的后果不是"窗口大一点"，而是三个看起来毫不相干的 bug
                //（125% 缩放实测：2560x1440 被当逻辑值 → 实际窗口 3200x1800）：
                //   ① .shot-bg 是 background-size:100% 100%，把底图铺满这个大出 25% 的
                //      窗口 → **整个画面被放大 scale 倍**，跟微信截图的 1:1 一比就看出来；
                //   ② 前端 clientX × dpr 算出的"物理坐标"整体被拉伸，左上角不偏、
                //      越往右下偏得越多 → **吸附框右侧/下侧有偏差**（比例误差的指纹，
                //      原点错才是整体平移）；
                //   ③ 屏幕右下 (scale-1) 那一圈换算出的坐标超出真实屏幕范围，
                //      snap_window_at 在屏幕外找不到任何窗口 → **那片区域吸附直接失效**。
                //
                // 所以这里必须用物理量再覆盖一次。build 时是 visible(false)，
                // 在 show() 之前改完，用户看不到中间那一帧。
                // 用物理坐标而不是在 builder 里除以 scale_factor：build 前拿不到目标
                // 显示器的 scale，且多屏混合 DPI 时没有单一 scale 可用，物理坐标唯一。
                let _ = window.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                let _ = window.show();
                let _ = window.set_focus();
                log::info!(
                    "[Screenshot] 截图窗口已创建并显示 {}x{} @({},{}) 物理像素，scale={}",
                    w,
                    h,
                    x,
                    y,
                    window.scale_factor().unwrap_or(1.0)
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

/// 两个路径是不是同一个文件（先 canonicalize，拿不到就退回字面比）。
///
/// 收口在这里：mark_ocr_temp 与 unmark_ocr_temp 都要做这个判定，
/// 各写一遍就是同一个 bug 的两个版本（规则 11）。
fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 登记本次的临时 OCR 图（前端提前识别存完后调用）。
/// 登记新的会先删掉上一张，避免反复截图时累积（窗口常驻，不每次都走 close）。
///
/// ❌ 但「新的」和「上一张」可能是**同一个文件**，此时绝不能删：
/// `save_screenshot_image` 是 md5 去重的，同一个选区裁出来的像素完全一致 → 同一个路径。
/// 于是「进标注态 → Esc 退回 → 再进标注态」这条路径上：
///   第二次预识别拿到同一个 P → mark_ocr_temp(P) 先 purge 把 P **自己**删了
///   → 紧接着的 ocrImage(P) 报「路径无效或文件不存在 (os error 2)」。
/// 这就是 unmark_ocr_temp 文档里提到的那个「对称的隐患」，当时只在 unmark 侧加了守卫。
#[tauri::command]
pub fn mark_ocr_temp(app: tauri::AppHandle, path: String) {
    let incoming = std::path::PathBuf::from(&path);
    {
        let slot = ocr_temp_slot().lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_deref().is_some_and(|cur| same_file(cur, &incoming)) {
            log::info!("[Screenshot] 临时 OCR 图与上一张同一个文件，保留不删: {path}");
            return; // 已经登记的就是它，什么都不用做
        }
    } // ❌ 先释锁再 purge：purge_ocr_temp 自己还要拿同一把锁
    purge_ocr_temp(&app);
    *ocr_temp_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(incoming);
}

/// 撤销临时登记：该文件已经“晋升”为正式结果图，不能再当临时文件删。
///
/// 为什么会发生“同一个文件既是临时图又是结果图”：
/// `save_screenshot_image` 是 **md5 去重**的（`if !file_path.exists()` 不重写）。
/// 提前 OCR 存的是选区原图；若用户**没画任何标注**，合成出的结果图像素
/// 与选区原图完全一致 → md5 相同 → 拿到的是同一个路径。
/// 于是卡片存了这个路径，而关窗时 `purge_ocr_temp` 把它删了——
/// 卡片指向一个不存在的文件，缩略图生成失败，界面上就是“图片加载失败”。
///
/// 旧版没暴露是因为结果图当时是 JPEG、OCR 临时图是 PNG，字节不同所以 md5 不同；
/// 把结果图改成无损 PNG 后两边就撞上了。
///
/// 顺带修掉一个对称的隐患：`mark_ocr_temp` 会先 `purge_ocr_temp()` 删上一张。
/// 连续截两次相同内容时，第二次会把第一张已入库卡片的图删掉。
#[tauri::command]
pub fn unmark_ocr_temp(path: String) {
    let mut slot = ocr_temp_slot().lock().unwrap_or_else(|p| p.into_inner());
    // 只比较归一化后的路径（见 same_file）：两边都来自 `save_screenshot_image` 的返回值，
    // 字面上应该相等；但前端绕一圈传回来时不保证。
    let same = slot
        .as_deref()
        .is_some_and(|cur| same_file(cur, std::path::Path::new(&path)));
    if same {
        log::info!("[Screenshot] 结果图与临时 OCR 图同一个文件，取消临时登记: {path}");
        slot.take();
    }
}

/// 关闭截图窗口（前端 Esc 取消 / 完成出口后调用；close 销毁窗口，资源干净释放）
#[tauri::command]
pub fn close_screenshot_window(app: tauri::AppHandle) {
    // 关窗即删临时 OCR 图。放在后端而不是前端 close()：截图窗口有多条关闭路径
    // （Esc / 失焦自动取消 / 各个完成出口 / 截屏失败页的关闭按钮），
    // 它们最终都汇到这个命令，在这里收口才不会漏（规则 11.1）。
    purge_ocr_temp(&app);
    unregister_longshot_escape(&app); // 兜底：长截图中强关窗也要释放全局 Esc
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

// ===== 长截图状态小窗口 =====
//
// 为什么需要一个独立窗口：长截图期间截图窗口被 hide()，而隐藏的 WebView
// **收不到任何输入事件**（键盘/鼠标/右键全无效）。因此：
// ① 进度无处显示；② 旧代码里的"长截图中 Esc 中止"是个死功能 —— 它要求用户在
// 窗口隐藏期间按键，而那时候根本没人接收。
//
// 这个小窗口只依赖一件已被现有代码证明的事：隐藏的 WebView 仍能执行 JS 与收发 IPC
// （长截图循环本身就在隐藏期间跑并持续 invoke 后端）。不依赖任何渲染/合成假设。

const LONGSHOT_LABEL: &str = "longshot-status";

/// 给状态窗选一个**不与选区相交**的位置。
///
/// 必须不相交：长截图每帧都对选区矩形做 BitBlt，状态窗一旦压在选区上就会被
/// 拼进长图里。只要它完全在选区外，截图就是干净的 —— 这是确定的，不靠透明度赌。
///
/// 坐标全部是**虚拟屏幕物理像素**。候选位置按优先级试，都不行（选区几乎占满屏幕）
/// 返回 None，调用方退回"不开状态窗，结束后用 toast 报告结果"。
fn pick_status_pos(
    sel: (i32, i32, i32, i32),
    screen: (i32, i32, i32, i32),
    win_w: i32,
    win_h: i32,
    gap: i32,
) -> Option<(i32, i32)> {
    let (sx, sy, sw, sh) = sel;
    let (scx, scy, scw, sch) = screen;
    let right = scx + scw - gap - win_w;
    let bottom = scy + sch - gap - win_h;
    let left = scx + gap;
    let top = scy + gap;
    let mid_x = scx + (scw - win_w) / 2;

    // 优先右下（系统通知区，用户天然会往那看），然后其余三个角，
    // 最后试选区正下方/正上方居中（选区靠一侧时这两个位置比角落更靠近视线）。
    let candidates = [
        (right, bottom),
        (left, bottom),
        (right, top),
        (left, top),
        (mid_x, bottom),
        (mid_x, top),
    ];
    candidates
        .into_iter()
        .find(|&(x, y)| {
            // 完全在屏幕内
            x >= scx && y >= scy && x + win_w <= scx + scw && y + win_h <= scy + sch
                // 与选区不相交
                && (x + win_w <= sx || x >= sx + sw || y + win_h <= sy || y >= sy + sh)
        })
        // 兜底：选区几乎占满整屏、四角都放不下时，退到屏幕底部居中。
        // 此时可能与选区底部轻微相交，但 capture_region 在截屏瞬间会临时隐藏本窗
        // （见 capture_region），不会被拼进长图 —— 总比“完全没有退出入口”强。
        .or_else(|| {
            let bx = scx + ((scw - win_w) / 2);
            let by = scy + sch - gap - win_h;
            if bx >= scx && by >= scy && bx + win_w <= scx + scw && by + win_h <= scy + sch {
                Some((bx, by))
            } else {
                None
            }
        })
}

/// 打开长截图状态小窗。参数是选区的虚拟屏幕物理矩形。
///
/// 返回是否真的开了窗：选区占满屏幕时找不到不相交的位置，此时宁可不开，
/// 也不能把状态窗拼进用户的长图里。前端据此决定要不要提示"本次无法中途停止"。
#[tauri::command]
pub fn open_longshot_status(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<bool, String> {
    // 已存在就先关（上一轮异常退出残留）
    if let Some(win) = app.get_webview_window(LONGSHOT_LABEL) {
        let _ = win.close();
    }
    let (scw, sch, scx, scy) = virtual_screen_metrics();

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        LONGSHOT_LABEL,
        tauri::WebviewUrl::App("longshot.html".into()),
    )
    .title("")
    .inner_size(LONGSHOT_W, LONGSHOT_H)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .transparent(true)
    .focused(false) // 不抢焦点：抢了会把滚轮目标窗口激活态打乱
    .visible(false)
    .build()
    .map_err(|e| format!("创建长截图状态窗失败: {e}"))?;

    // 窗口建好后才能读 scale_factor，拿它把逻辑尺寸换算成物理尺寸，
    // 才能与选区（物理像素）做相交判断。
    let scale = window.scale_factor().unwrap_or(1.0);
    let pw = (LONGSHOT_W * scale).round() as i32;
    let ph = (LONGSHOT_H * scale).round() as i32;

    match pick_status_pos((x, y, w, h), (scx, scy, scw, sch), pw, ph, 16) {
        Some((px, py)) => {
            let _ = window.set_position(tauri::PhysicalPosition::new(px, py));
            let _ = window.show();
            log::info!("[Screenshot] 长截图状态窗 @({},{}) {}x{}", px, py, pw, ph);
            Ok(true)
        }
        None => {
            // 选区占满屏幕：无处可放且不能遮挡，直接不开
            let _ = window.close();
            log::info!("[Screenshot] 选区占满屏幕，不开长截图状态窗（仍可按 Esc 退出）");
            Ok(false)
        }
    }
}

/// 关闭长截图状态小窗（长截图结束/失败/放弃都走这里，在 finally 里调用）
#[tauri::command]
pub fn close_longshot_status(app: tauri::AppHandle) {
    unregister_longshot_escape(&app);
    if let Some(win) = app.get_webview_window(LONGSHOT_LABEL) {
        let _ = win.close();
    }
}

// ===== 长截图期间的全局 Esc（逃生舱） =====
//
// 状态小窗的"放弃"按钮需要用户用鼠标去点；这条全局 Esc 是第二道保险，
// 它不依赖任何窗口可见性与焦点 —— 哪怕状态窗根本没开成，按 Esc 也能退出。
//
// 代价是长截图期间全局独占 Esc（几秒到几十秒）。因此注销放在四处：
// close_longshot_status / show_screenshot_window / close_screenshot_window，
// 任一路径都会释放，避免异常退出后 Esc 被永久占着。

fn longshot_esc_shortcut() -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use std::str::FromStr;
    tauri_plugin_global_shortcut::Shortcut::from_str("Escape").ok()
}

/// 武装长截图逃生舱（全局 Esc）。
///
/// 必须是**独立命令**、在一切之前调用：之前把注册写在 open_longshot_status 里、
/// 而且在 WebviewWindowBuilder::build() 之后 —— 状态窗一旦创建失败就直接 return Err，
/// 全局 Esc 根本没注册上。逃生舱不能依赖它要保护的东西。
#[tauri::command]
pub fn arm_longshot_escape(app: tauri::AppHandle) -> bool {
    register_longshot_escape(&app)
}

fn register_longshot_escape(app: &AppHandle) -> bool {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let Some(sc) = longshot_esc_shortcut() else {
        return false;
    };
    let res = app.global_shortcut().on_shortcut(sc, move |app, _sc, event| {
        if event.state == ShortcutState::Pressed {
            // 走与状态窗"放弃"按钮完全相同的链路，不另开一条分支（规则 11.1）
            let _ = app.emit("longshot-control", "abort");
        }
    });
    match res {
        Ok(()) => {
            log::info!("[Screenshot] 长截图全局 Esc 已注册");
            true
        }
        // 注册失败不能阻断长截图（比如 Esc 被别的程序占了），还有状态窗兜底
        Err(e) => {
            log::warn!("[Screenshot] 长截图全局 Esc 注册失败（不阻断）: {}", e);
            false
        }
    }
}

fn unregister_longshot_escape(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let Some(sc) = longshot_esc_shortcut() else {
        return;
    };
    // 未注册时 unregister 会报错，这是正常情况（四处都调、幂等），走 debug 不刷 warn
    if let Err(e) = app.global_shortcut().unregister(sc) {
        log::debug!("[Screenshot] 长截图全局 Esc 注销（可能本就未注册）: {}", e);
    }
}

/// 状态窗逻辑尺寸。写成常量是因为几何判断与建窗必须用同一份值。
const LONGSHOT_W: f64 = 300.0;
const LONGSHOT_H: f64 = 48.0;

/// 重新显示截图窗口（长截图完成后恢复，状态保留）
#[tauri::command]
pub fn show_screenshot_window(app: tauri::AppHandle) {
    unregister_longshot_escape(&app); // 长截图已结束，释放全局 Esc
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        // ⚠️ set_focus() 在这里会静默失败：长截图期间往目标窗口注入滚轮把它激活了，
        // 而 Windows 的"前台锁定超时"会拒绝非前台进程的 SetForegroundWindow（不报错）。
        // 后果就是"窗口回来了但 Esc/右键失灵" —— 按键全发给了之前的前台窗口，
        // 用户退不出截图。这里用 Ditto 配方硬抢回来。
        #[cfg(target_os = "windows")]
        if let Ok(h) = window.hwnd() {
            if !crate::win_foreground::force_foreground(h.0 as isize) {
                log::warn!("[Screenshot] 截图窗未能抢回前台，键盘快捷键可能失效");
            }
        }
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

/// 管理面板"旋转/翻转"：按 path 向贴图窗口下发变换指令（action: 1=旋转90° 2=水平翻转 3=垂直翻转 4=恢复）
#[tauri::command]
pub fn transform_pinned_image_by_path(path: String, action: u8) {
    crate::pinned_window::transform_pinned_image_by_path(&path, action);
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

/// 吸附矩形（物理像素，虚拟屏幕坐标）。
/// 字段都是单词，目前不受命名影响；加上 rename_all 是为了以后添多词字段时不再踩同一个坑。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 吸附双层目标：同时返回「窗口」与「控件」两个矩形（屏幕物理坐标）。
///
/// - `win`：光标下最顶层可见窗口的视觉边界；控件级吸附退化成窗口级时它等于 `ctrl`；
/// - `ctrl`：命中到的具体控件（UIA / 子窗口 / 面板），即真正要框选的区域；
///   当没有更细控件可用时回退到 `win` 本身（前端据此只画单层框，避免双框难看）。
///
/// 前端把 `ctrl` 当作实际选区（内层亮蓝框），`win` 用于画外层淡蓝窗口轮廓，
/// 形成「淡蓝窗口边界 + 亮蓝选区」的双层轮廓（最像微信的观感收尾，Tier3）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapTargets {
    pub win: SnapRect,
    pub ctrl: SnapRect,
}

/// 从 DWM 视觉边界与 GetWindowRect 两个候选里挑一个可用的（纯逻辑，带单测）。
///
/// 矩形用 `(left, top, right, bottom)`，`None` = 该来源取值失败。
/// 规则：DWM 成功且矩形有效就用 DWM；否则回退 GetWindowRect。
///
/// ⚠️ 抽成函数是为了让**命中测试与返回值走同一套边界**。旧实现里两者分开写：
/// 命中测试用 GetWindowRect（含 DWM 投影阴影，Win10/11 上左/右/下各大 7~8px），
/// 返回值用 DWMWA_EXTENDED_FRAME_BOUNDS（视觉边界）。差这 7~8px 的后果是
///   ① 鼠标停在窗口外那圈阴影里时判定为命中，但框出来是视觉边界 → 鼠标在框外；
///   ② 两窗口并排时阴影区重叠 → 命中 Z 序更上层那个，可视觉上鼠标在另一个窗口上
///      → 框莫名跳到隔壁窗口。这就是“自动检测窗口不准确”的主因。
fn pick_bounds(
    dwm: Option<(i32, i32, i32, i32)>,
    fallback: Option<(i32, i32, i32, i32)>,
) -> Option<(i32, i32, i32, i32)> {
    let valid = |r: &(i32, i32, i32, i32)| r.2 > r.0 && r.3 > r.1;
    match dwm {
        Some(r) if valid(&r) => Some(r),
        _ => fallback.filter(valid),
    }
}

/// 永远不该被吸附的系统外壳窗口类名。
///
/// 注意故意**没有**收 `Windows.UI.Core.CoreWindow`：开始菜单 / 搜索用它，
/// 而它们没显示时本来就是 cloaked（已被 is_cloaked 拦掉）；真正显示着的时候
/// 用户是有可能想截它的，黑名单会把这条路堵死。
const SHELL_CLASSES: &[&str] = &[
    "Progman",                      // 桌面（悬停 → 前端全屏吸附）
    "WorkerW",                      // 桌面壁纸层
    "XamlExplorerHostIslandWindow", // Win11 Alt+Tab / 贴靠布局浮层
    "ForegroundStaging",            // 窗口切换过渡层
];

fn is_shell_class(name: &str) -> bool {
    SHELL_CLASSES.contains(&name)
}

/// 任务栏（主 / 副屏）。它们**不再**进 `SHELL_CLASSES` 黑名单，可像普通窗口一样被吸附，
/// 但 DWM 视觉边界（`EXTENDED_FRAME_BOUNDS`）对这类外壳窗口不可靠，常返回整块工作区，
/// 所以命中测试与取矩形一律改用 `GetWindowRect`（见 `enum_snap_proc` / `enum_rects_proc` /
/// `snap_window_impl` 的 tray 分支）。
fn is_tray_class(name: &str) -> bool {
    name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd"
}

/// 直接用 `GetWindowRect`（不做 DWM 视觉边界换算）。用于任务栏这类
/// `DWMWA_EXTENDED_FRAME_BOUNDS` 会返回整块工作区 / 不准的外壳窗口。
#[cfg(target_os = "windows")]
unsafe fn raw_window_rect(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r)
        .is_ok()
        .then_some((r.left, r.top, r.right, r.bottom))
}

/// 取窗口类名（吸附命中后判断是否为任务栏用）。
#[cfg(target_os = "windows")]
unsafe fn class_name_of(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut cls: [u16; 256] = [0; 256];
    let n = GetClassNameW(hwnd, &mut cls);
    if n > 0 {
        String::from_utf16_lossy(&cls[..n as usize])
    } else {
        String::new()
    }
}

/// 面积辅助（`(l, t, r, b)` → 宽×高）。
fn area(r: (i32, i32, i32, i32)) -> i64 {
    ((r.2 - r.0) as i64).max(0) * ((r.3 - r.1) as i64).max(0)
}

/// 命中测试：给定物理坐标，返回光标下方有效窗口的屏幕矩形（排除自身/桌面/任务栏）。
/// 用 EnumWindows 从 Z 序最上层开始遍历，跳过截图窗口自身后取第一个包含该点的可见窗口——
/// 因为截图窗口全屏透明覆盖，WindowFromPoint 只会命中它自己。
#[tauri::command]
pub fn snap_window_at(app: tauri::AppHandle, x: i32, y: i32) -> Result<Option<SnapTargets>, String> {
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

/// 枚举当前所有可见顶层窗口的视觉矩形（屏幕物理坐标），供拖选时「吸邻近窗口边缘」用。
///
/// 排除：截图窗口自身、桌面、任务栏 / 副屏任务栏（Shell_TrayWnd 等）、
/// DWM 隐身窗（cloaked：挂起 UWP / 其他虚拟桌面）、最小化窗。
/// 窗口在截图会话内不会移动，前端进会话时取一次即可，不必每帧枚举。
#[tauri::command]
pub fn enum_window_rects(app: tauri::AppHandle) -> Result<Vec<SnapRect>, String> {
    #[cfg(target_os = "windows")]
    {
        unsafe { enum_window_rects_impl(&app) }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
unsafe fn enum_window_rects_impl(app: &tauri::AppHandle) -> Result<Vec<SnapRect>, String> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetDesktopWindow, WNDENUMPROC};

    let self_hwnd = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| HWND(h.0 as *mut _))
        .unwrap_or_default();
    let desktop = GetDesktopWindow();

    let mut ctx = (self_hwnd, desktop, Vec::<(i32, i32, i32, i32)>::new());
    let lparam = LPARAM(&mut ctx as *mut _ as isize);
    let enum_fn: WNDENUMPROC = Some(enum_rects_proc);
    let _ = EnumWindows(enum_fn, lparam);

    Ok(ctx
        .2
        .into_iter()
        .map(|(l, t, r, b)| SnapRect {
            x: l,
            y: t,
            w: r - l,
            h: b - t,
        })
        .collect())
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_rects_proc(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, IsIconic, IsWindowVisible};

    let ctx = lparam.0 as *mut (
        windows::Win32::Foundation::HWND,
        windows::Win32::Foundation::HWND,
        Vec<(i32, i32, i32, i32)>,
    );
    let (self_hwnd, desktop, out) = &mut *ctx;
    if hwnd == *self_hwnd || hwnd == *desktop {
        return windows::Win32::Foundation::BOOL(1);
    }
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return windows::Win32::Foundation::BOOL(1);
    }
    // 缓冲区 256：类名上限就是 256（同 enum_snap_proc）
    let mut cls: [u16; 256] = [0; 256];
    let n = GetClassNameW(hwnd, &mut cls);
    let cls_str = if n > 0 {
        String::from_utf16_lossy(&cls[..n as usize])
    } else {
        String::new()
    };
    if is_shell_class(&cls_str) {
        return windows::Win32::Foundation::BOOL(1);
    }
    if is_cloaked(hwnd) {
        return windows::Win32::Foundation::BOOL(1);
    }
    // 任务栏 DWM 视觉边界不可靠（常返回整块工作区），统一用 GetWindowRect
    let rect = if is_tray_class(&cls_str) {
        raw_window_rect(hwnd)
    } else {
        window_visual_rect(hwnd)
    };
    if let Some(rect) = rect {
        out.push(rect);
    }
    windows::Win32::Foundation::BOOL(1)
}

/// 取窗口的视觉边界（屏幕物理坐标，`(l, t, r, b)`）。**命中测试与返回值共用它。**
#[cfg(target_os = "windows")]
unsafe fn window_visual_rect(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut b = RECT::default();
    let dwm = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut b as *mut RECT as *mut core::ffi::c_void,
        std::mem::size_of::<RECT>() as u32,
    )
    .is_ok()
    .then_some((b.left, b.top, b.right, b.bottom));

    let mut r = RECT::default();
    let fb = GetWindowRect(hwnd, &mut r)
        .is_ok()
        .then_some((r.left, r.top, r.right, r.bottom));

    pick_bounds(dwm, fb)
}

/// 从顶层窗口往下钻，找鼠标下最细的**真实子窗口**（控件级识别，QQ 截图同款）。
///
/// 三个必须算对的点：
///   ① `ChildWindowFromPointEx` **只搜直接子窗口**（MSDN 原话：孙子及更深不搜），
///      所以必须自己递归；
///   ② **它要的是父窗口的客户区坐标，不是屏幕坐标**。每下钻一层都得重新
///      `ScreenToClient` 一次 —— 这是这个 API 最容易错的地方，传屏幕坐标会得到
///      “有时对有时不对”的结果（窗口在屏幕左上角时恰好能对）；
///   ③ 终止条件用返回值语义：点在父窗口内但不落在任何合格子窗口内时，
///      它**返回父窗口句柄**。所以“返回值 == 传入句柄”就是到底了。
///
/// `CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT`：跳过不可见与透明子窗。
/// 故意不加 `CWP_SKIPDISABLED` —— 置灰的控件用户照样可能想截。
///
/// `MAX_DEPTH` 是硬保险：理论上 ③ 就能终止，但这是跑在它进程外的推断，
/// 遇到构造得很奇怪的窗口树（或枚举过程中窗口被重建）不能把 hover 路径挂死。
/// 收集从顶层窗到鼠标下最细真实子窗口的整条 HWND 链（top → … → leaf）。
///
/// 复用 deepest_child_at 的逐层下钻（ChildWindowFromPointEx 只搜直接子窗，
/// 必须自己递归；每层都要 ScreenToClient 重算客户区坐标；返回值 == 传入句柄即到底），
/// 区别是**每一层都记录 cur**，供 `pick_best_control` 在 window→叶子 之间挑
/// 最合适的控件——而不是只取最深的叶子（那样要么框到 21px 小按钮，要么因太大退回整窗）。
#[cfg(target_os = "windows")]
unsafe fn control_chain_at(
    top: windows::Win32::Foundation::HWND,
    screen_pt: windows::Win32::Foundation::POINT,
) -> Vec<windows::Win32::Foundation::HWND> {
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT,
    };

    const MAX_DEPTH: usize = 16;
    let mut chain = Vec::with_capacity(MAX_DEPTH + 1);
    let mut cur = top;
    chain.push(cur);
    for _ in 0..MAX_DEPTH {
        // 屏幕坐标 → 当前父窗口的客户区坐标（每层都要重算，见 deepest_child_at 注释 ②）
        let mut p = screen_pt;
        if !ScreenToClient(cur, &mut p).as_bool() {
            break;
        }
        let child = ChildWindowFromPointEx(cur, p, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
        // NULL = 点在父窗外（防意外）；== cur = 到底了
        if child.0.is_null() || child == cur {
            break;
        }
        cur = child;
        chain.push(cur);
    }
    chain
}

/// 纯逻辑：从一组候选矩形里挑“最合适的截图区域”（不碰 Win32，可单测）。
/// `pick_best_control` 负责把 HWND 链取成矩形后调用它。
///
/// 规则（物理像素）：
///   - 最小边长 40px：排除分隔条 / 滚动条箭头 / 小图标这类“框住没意义”的碎屑；
///   - 占顶层窗面积 5%~92%：排除几乎等于整窗的渲染宿主（Chrome/Electron 的
///     Chrome_RenderWidgetHostHWND），也排除面积占比过小的残片。
/// 返回 None = 链上没有可用控件，调用方应退回顶层窗整窗。
fn select_best_rect(
    rects: &[(i32, i32, i32, i32)],
    top_rect: (i32, i32, i32, i32),
) -> Option<(i32, i32, i32, i32)> {
    const MIN_SIDE: i32 = 40;
    const MIN_RATIO: i64 = 5; // 占顶层窗面积下限（%）
    const MAX_RATIO: i64 = 92; // 上限（%）
    let ta = area(top_rect);
    if ta <= 0 {
        return None;
    }
    let mut best: Option<(i32, i32, i32, i32)> = None;
    let mut best_area: i64 = i64::MAX;
    for &c in rects {
        let (w, h) = (c.2 - c.0, c.3 - c.1);
        if w < MIN_SIDE || h < MIN_SIDE {
            continue;
        }
        let ca = area(c);
        if ca * 100 < ta * MIN_RATIO || ca * 100 > ta * MAX_RATIO {
            continue;
        }
        // 取“满足约束的最小区域”= 最精确、但仍是像样的控件（微信同款：框工具栏而非整窗或最深小按钮）
        if ca < best_area {
            best_area = ca;
            best = Some(c);
        }
    }
    best
}

/// 从 window→叶子 的 HWND 链里挑“最合适的截图区域”。
///
/// 微信的做法：悬停到面板 / 工具栏 / 列表就框那一整块，而不是框最深的 21px 小按钮、
/// 也不是退回整窗。链上没有任何控件满足约束 → 退回顶层窗整窗。
#[cfg(target_os = "windows")]
unsafe fn pick_best_control(
    chain: &[windows::Win32::Foundation::HWND],
    top_rect: (i32, i32, i32, i32),
) -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rects = Vec::with_capacity(chain.len());
    for &h in &chain[1..] {
        let mut r = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(h, &mut r).is_ok() {
            rects.push((r.left, r.top, r.right, r.bottom));
        }
    }
    select_best_rect(&rects, top_rect).unwrap_or(top_rect)
}

/// 通过 **UI Automation（完整 IUIAutomation）** 取光标下的**逻辑控件**边界矩形（屏幕物理坐标）。
///
/// 为什么需要它：Chrome / Edge / VS Code / 飞书 / Electron / WPF / UWP / Qt 这些现代 App
/// 的界面画在一个大渲染宿主 HWND 上，没有标准 Win32 子窗口——`control_chain_at` 只能
/// 拿到占满全窗的宿主，于是「控件级吸附」实际退化成「窗口级」。
///
/// 必须用**完整 UIA 的 `ElementFromPoint`**，而不是 legacy MSAA（`AccessibleObjectFromPoint`
/// 在 Electron / Chrome / VS Code 上命中测试只会落到顶层窗口，拿不到具体控件）。UIA 的
/// `ElementFromPoint` 能穿透到光标下最深的真实控件（按钮 / 输入框 / 列表项 / 网页内可访问
/// 元素），这正是 Snipaste / 微信截图控件级吸附的真正做法。
///
/// 仅在 Win32 路径只拿到「整窗或接近整窗」时才调用（每 90ms 一次的路径里，
/// Office / 资源管理器这类 Win32 标准程序根本不会走到这里，快路径不受影响）。
///
/// 坐标约定：UIA 在 DPI-aware 进程里返回**物理屏幕像素**，与本项目其余几何（DWM
/// EXTENDED_FRAME_BOUNDS 也是物理像素）一致，无需 DPI 换算；若实测高 DPI 下偏移，
/// 再按 GetDpiForWindow 修正。
///
/// 安全网：COM 未初始化 / UIA 创建失败 / 控件不可达 / 矩形退化 → 返回 None，调用方退回 Win32 结果。
#[cfg(target_os = "windows")]
unsafe fn uia_control_at(
    pt: windows::Win32::Foundation::POINT,
    top_rect: (i32, i32, i32, i32),
) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationElement};

    // UIA 在 STA 下最稳定；已初始化（含模式不同 RPC_E_CHANGED_MODE）一律忽略，仍尝试后续调用。
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

    // 创建 UIA 客户端（进程内 COM 服务器）。这是取「逻辑控件」边界的关键——
    // legacy MSAA 在 Electron / Chrome / VS Code 上只会命中到顶层窗口，拿不到具体控件；
    // UIA 的 ElementFromPoint 能穿透到光标下最深的真实控件。
    let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL) {
        Ok(a) => a,
        Err(_) => return None,
    };
    let element: IUIAutomationElement = match automation.ElementFromPoint(pt) {
        Ok(e) => e,
        Err(_) => return None,
    };
    let r = match element.CurrentBoundingRectangle() {
        Ok(r) => r,
        Err(_) => return None,
    };
    let rect = (r.left, r.top, r.right, r.bottom);

    // 过滤：太碎（<20px）或几乎等于整窗（>95%）都没意义，退回 Win32。
    const MIN_SIDE: i32 = 20;
    if (rect.2 - rect.0) < MIN_SIDE || (rect.3 - rect.1) < MIN_SIDE {
        return None;
    }
    let ta = area(top_rect);
    if ta <= 0 {
        return None;
    }
    if area(rect) * 100 > ta * 95 {
        return None;
    }
    Some(rect)
}

/// 窗口是否被 DWM「隐身」。
///
/// 两类窗口 `IsWindowVisible` 返回 true 但实际看不见，旧实现一个都没排：
///   ① UWP / Store 应用的挂起壳窗口（ApplicationFrameWindow）——应用挂起后仍占着原矩形，
///      于是鼠标在桌面空白处却吸附到早就关掉的“设置”“日历”；
///   ② **其他虚拟桌面上的窗口**——切到桌面 2 时桌面 1 的窗口照样 visible。
/// Windows 自己的 Alt+Tab、任务栏都靠 DWMWA_CLOAKED 过滤这两类。
///
/// 取值失败按“没隐身”处理：宁可多枚举一个窗口，也不要因为一次 DWM 调用失败
/// 就把正常窗口全部排掉（那会让吸附整体失灵）。
#[cfg(target_os = "windows")]
unsafe fn is_cloaked(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};

    let mut cloaked: u32 = 0;
    let ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut core::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok();
    ok && cloaked != 0
}

#[cfg(target_os = "windows")]
fn snap_window_impl(app: &tauri::AppHandle, x: i32, y: i32) -> Result<Option<SnapTargets>, String> {
    use windows::Win32::Foundation::{HWND, LPARAM, POINT};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetDesktopWindow, WNDENUMPROC};

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
            // 光标在桌面空白 / 无任何顶层窗口覆盖的区域：返回 None，
            // 前端据此吸附整屏（QQ / Snipaste 同款全屏吸附），不再微信式全暗。
            return Ok(None);
        };

        // 任务栏（主 / 副屏）：DWM 视觉边界对这类外壳窗口不可靠（常返回整块工作区），
        // 直接用 GetWindowRect 取准确的任务栏小矩形。
        let cls = class_name_of(hwnd);
        if is_tray_class(&cls) {
            if let Some(r) = raw_window_rect(hwnd) {
                let (l, t, rr, b) = r;
                return Ok(Some(SnapTargets {
                    win: SnapRect {
                        x: l,
                        y: t,
                        w: rr - l,
                        h: b - t,
                    },
                    ctrl: SnapRect {
                        x: l,
                        y: t,
                        w: rr - l,
                        h: b - t,
                    },
                }));
            }
            return Ok(None);
        }

        // 与命中测试同一套边界（见 pick_bounds 的注释）
        let Some(top_rect) = window_visual_rect(hwnd) else {
            return Ok(None);
        };

        // 控件级细化：沿 window→叶子 的整条 HWND 链挑最合适的控件区域，
        // 而非只取最深的叶子（那样要么框到 21px 小按钮、要么因太大退回整窗）。
        // 子窗口用 GetWindowRect 而不是 window_visual_rect：EXTENDED_FRAME_BOUNDS
        // 是给**顶层窗**算阴影的，子窗口根本没有 DWM 阴影，对它调那个要么失败
        // 要么拿到奇怪值。
        let chain = control_chain_at(hwnd, pt);
        let mut rect = pick_best_control(&chain, top_rect);
        // Tier2：当 Win32 只拿到「整窗 / 接近整窗」（现代 App 无标准子窗口，
        // 只有占满全窗的渲染宿主）时，用 UI Automation 取光标下的逻辑控件，
        // 补上真正的控件级吸附。Win32 已能框到面板/列表的标准程序不会走到这，快路径不受影响。
        if area(rect) * 100 > area(top_rect).max(1) * 90 {
            if let Some(uia) = uia_control_at(pt, top_rect) {
                rect = uia;
            }
        }

        let (wl, wt, wr, wb) = top_rect;
        let (l, t, r, b) = rect;
        Ok(Some(SnapTargets {
            win: SnapRect {
                x: wl,
                y: wt,
                w: wr - wl,
                h: wb - wt,
            },
            ctrl: SnapRect {
                x: l,
                y: t,
                w: r - l,
                h: b - t,
            },
        }))
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_snap_proc(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::{HWND, POINT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, IsIconic, IsWindowVisible};

    let ctx = lparam.0 as *mut (HWND, POINT, HWND, Option<HWND>);
    let (self_hwnd, pt, desktop, found) = &mut *ctx;

    // 检查顺序按开销从低到高排：本回调每次吸附会被调几百次
    // （前端 90ms 节流），后两项都是 DWM 调用，能先被前面拦下就不要走。
    if hwnd == *self_hwnd || hwnd == *desktop {
        return TRUE;
    }
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return TRUE;
    }

    // 缓冲区 256：类名上限就是 256。旧实现给了 64，更长的类名会被静默截断、
    // 比较随之失败（黑名单形同不存在）。
    let mut cls: [u16; 256] = [0; 256];
    let n = GetClassNameW(hwnd, &mut cls);
    let cls_str = if n > 0 {
        String::from_utf16_lossy(&cls[..n as usize])
    } else {
        String::new()
    };
    if is_shell_class(&cls_str) {
        return TRUE;
    }

    // 隐身窗口（UWP 挂起壳 / 其它虚拟桌面）：visible 为 true 但看不见，必须排掉
    if is_cloaked(hwnd) {
        return TRUE;
    }

    // ⚠️ 命中测试必须用**视觉边界**，与返回值同源（见 pick_bounds 的注释）。
    // 任务栏例外：DWM 视觉边界对它会返回整块工作区，必须用 GetWindowRect，
    // 否则光标在屏幕上任何位置都会"命中任务栏"，吞掉所有普通窗口的吸附。
    let rect = if is_tray_class(&cls_str) {
        raw_window_rect(hwnd)
    } else {
        window_visual_rect(hwnd)
    };
    if let Some((l, t, r, b)) = rect {
        if pt.x >= l && pt.x < r && pt.y >= t && pt.y < b && (r - l) >= 20 && (b - t) >= 20 {
            *found = Some(hwnd);
            return windows::Win32::Foundation::FALSE; // 停止遍历
        }
    }
    TRUE
}

#[cfg(test)]
mod snap_tests {
    use super::{is_shell_class, pick_bounds, select_best_rect};

    #[test]
    fn test_prefer_dwm_when_valid() {
        // DWM 给的是视觉边界，GetWindowRect 每边大 8px（阴影）
        let dwm = Some((108, 100, 908, 700));
        let fb = Some((100, 100, 916, 708));
        assert_eq!(pick_bounds(dwm, fb), dwm);
    }

    #[test]
    fn test_fallback_when_dwm_fails() {
        let fb = Some((100, 100, 916, 708));
        assert_eq!(pick_bounds(None, fb), fb);
    }

    #[test]
    fn test_fallback_when_dwm_returns_degenerate_rect() {
        // 实测过的坑：部分窗口 DWM 调用成功但给回全 0 / 零面积矩形，
        // 光看 is_ok() 会拿到一个没用的矩形。
        let fb = Some((100, 100, 916, 708));
        assert_eq!(pick_bounds(Some((0, 0, 0, 0)), fb), fb);
        assert_eq!(pick_bounds(Some((50, 50, 40, 60)), fb), fb); // right < left
    }

    #[test]
    fn test_none_when_both_sources_unusable() {
        assert_eq!(pick_bounds(None, None), None);
        assert_eq!(pick_bounds(Some((0, 0, 0, 0)), Some((5, 5, 5, 5))), None);
    }

    #[test]
    fn test_shell_class_blacklist() {
        assert!(is_shell_class("Progman")); // 桌面仍排除（前端全屏吸附）
        assert!(is_shell_class("WorkerW")); // 桌面壁纸层仍排除
        assert!(is_shell_class("XamlExplorerHostIslandWindow"));
        // 任务栏不再黑名单：现在可被吸附（用 GetWindowRect），is_shell_class 不应再命中
        assert!(!is_shell_class("Shell_TrayWnd"));
        assert!(!is_shell_class("Shell_SecondaryTrayWnd"));
        assert!(!is_shell_class("Chrome_WidgetWin_1")); // 普通应用窗不能被误排
        // 故意不排：开始菜单显示着的时候用户可能想截它
        assert!(!is_shell_class("Windows.UI.Core.CoreWindow"));
    }

    #[test]
    fn test_select_best_rect_prefers_smallest_usable() {
        // 链上同时有侧栏(24%) / 列表(48%) / 21px 按钮碎屑：
        // 应框最小的「像样控件」= 侧栏，而非按钮或整窗。
        let top = (100, 100, 1300, 900); // 1200x800
        let sidebar = (100, 132, 400, 900); // 300x768 ≈ 24%
        let list = (400, 132, 1000, 900); // 600x768 ≈ 48%
        let button = (410, 140, 431, 161); // 21x21 碎屑
        let r = select_best_rect(&[sidebar, list, button], top).unwrap();
        assert_eq!(r, sidebar);
    }

    #[test]
    fn test_select_best_rect_falls_back_when_only_render_host() {
        // Chrome/Electron 渲染宿主占 ~96%，不满足 <=92%，应退回整窗（None）。
        let top = (100, 100, 1300, 900);
        let host = (100, 132, 1300, 900);
        assert!(select_best_rect(&[host], top).is_none());
    }

    #[test]
    fn test_select_best_rect_rejects_tiny_and_degenerate() {
        let top = (100, 100, 1300, 900);
        assert!(select_best_rect(&[(410, 140, 431, 161)], top).is_none()); // 21px 碎屑
        assert!(select_best_rect(&[(100, 100, 1300, 100)], top).is_none()); // 高 0 退化矩形
        assert!(select_best_rect(&[], top).is_none()); // 空链
    }

    #[test]
    fn test_select_best_rect_rejects_when_top_degenerate() {
        assert!(select_best_rect(&[(0, 0, 100, 100)], (5, 5, 5, 5)).is_none());
    }
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

// ===== 长截图：WM_VSCROLL 优先路径 + 统一滚动入口 =====

/// 长截图滚动注入优先路径：向选区坐标下「真正可滚动的控件」发 `WM_VSCROLL / SB_PAGEDOWN`。
///
/// 为什么比 `WM_MOUSEWHEEL` 更好：经典 Win32 控件（记事本编辑框、资源管理器列表、
/// WinForms/MFC/Delphi/Java-SWT 等）规范地响应 `WM_VSCROLL`，`SB_PAGEDOWN` 一次滚「一页」、
/// 正确触发 `WM_PAINT` 重绘，比「把滚轮事件丢到坐标下的窗口」更准、对自绘/Java 控件兼容性更强。
///
/// 现代应用（浏览器、Electron、UWP、WPF、Swing）大多**不**响应 `WM_VSCROLL`（自绘滚动），
/// 这种情况由 `scroll_longshot` 自动回退到 `WM_MOUSEWHEEL` 注入。
///
/// 返回 `Ok(())` 仅代表「成功投递了 WM_VSCROLL」，不代表控件真的滚了——
/// 是否真滚由前端 `waitStable` + 重叠比对判断，没动会触发 `force_input` 兜底。
#[cfg(target_os = "windows")]
struct VScrollCandidate {
    hwnd: windows::Win32::Foundation::HWND,
    contains: bool,
    dist2: i64,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn vscroll_enum_cb(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GetWindowRect, GWL_STYLE, WS_VSCROLL};
    let ctx = &mut *(lparam.0 as *mut (&i32, &i32, &mut Vec<VScrollCandidate>));
    let px = *ctx.0;
    let py = *ctx.1;
    let cands = &mut *ctx.2;
    let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
    if style & (WS_VSCROLL.0 as u32) != 0 {
        let mut rect = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            let contains = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
            let cx = (rect.left + rect.right) / 2;
            let cy = (rect.top + rect.bottom) / 2;
            let dx = (cx - px) as i64;
            let dy = (cy - py) as i64;
            cands.push(VScrollCandidate {
                hwnd,
                contains,
                dist2: dx * dx + dy * dy,
            });
        }
    }
    windows::Win32::Foundation::BOOL(1)
}

#[cfg(target_os = "windows")]
fn find_vscroll_hwnd(x: i32, y: i32) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::{LPARAM, POINT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetWindowLongW, GWL_STYLE, WindowFromPoint, WS_VSCROLL,
    };
    unsafe {
        let root = WindowFromPoint(POINT { x, y });
        if root.0.is_null() {
            return None;
        }
        let mut cands: Vec<VScrollCandidate> = Vec::new();
        // ❌ 要沿**祖先链往上找**，不能只看 WindowFromPoint 的结果及其子窗：
        // WindowFromPoint 返回的往往是最深的那个叶子控件，而滚动条通常在它的**父容器**
        // 上（列表/文档视图/滚动面板）——“点在子控件上、滚动条在父容器”恰好是最常见的
        // 形形，旧实现在这种情况下直接找不到。
        {
            use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_PARENT};
            let mut cur = root;
            // 防循环：祖先链不可能很深，16 层结束
            for _ in 0..16 {
                if cur.0.is_null() {
                    break;
                }
                let style = GetWindowLongW(cur, GWL_STYLE) as u32;
                if style & (WS_VSCROLL.0 as u32) != 0 {
                    cands.push(VScrollCandidate {
                        hwnd: cur,
                        contains: true,
                        dist2: 0,
                    });
                }
                let parent = GetAncestor(cur, GA_PARENT);
                if parent.0.is_null() || parent == cur {
                    break;
                }
                cur = parent;
            }
        }
        let mut ctx: (&i32, &i32, &mut Vec<VScrollCandidate>) = (&x, &y, &mut cands);
        let _ = EnumChildWindows(root, Some(vscroll_enum_cb), LPARAM(&mut ctx as *mut _ as isize));
        if cands.is_empty() {
            return None;
        }
        // 优先「包含选区中心」的控件，其次「几何中心最近」的
        cands.sort_by(|a, b| b.contains.cmp(&a.contains).then(a.dist2.cmp(&b.dist2)));
        Some(cands[0].hwnd)
    }
}

#[cfg(target_os = "windows")]
fn scroll_via_vscroll(x: i32, y: i32) -> Result<(), String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_VSCROLL};
    let target = find_vscroll_hwnd(x, y).ok_or_else(|| "未找到可滚动子控件".to_string())?;
    unsafe {
        // SB_PAGEDOWN = 3（Windows 规范值）：低位 wParam；lParam 必须为 0。
        PostMessageW(target, WM_VSCROLL, WPARAM(3), LPARAM(0))
            .map_err(|e| format!("WM_VSCROLL 投递失败: {e:?}"))
    }
}

/// 长截图「已滚到底」的权威信号：向选区中心命中的可滚动控件取 `GetScrollInfo(SB_VERT)`，
/// 若 `nPos + nPage >= nMax` 即到底。与图像重叠检测双保险——重叠检测在动态内容
/// （懒加载 / SPA 还在填数据）下会一直"看着在变"而永不收敛，本函数能直接判定终点，
/// 避免一路滚到屏数上限或误判提前停。无 WS_VSCROLL 子控件（浏览器等）→ 返回 false，
/// 交给图像重叠兜底（不报错、不回归）。
#[tauri::command]
pub fn get_scroll_bottom(x: i32, y: i32) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = match find_vscroll_hwnd(x, y) {
            Some(h) => h,
            None => return Ok(false),
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetScrollInfo, SB_VERT, SCROLLINFO, SIF_ALL};
        unsafe {
            let mut si = SCROLLINFO {
                cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
                fMask: SIF_ALL,
                ..Default::default()
            };
            if GetScrollInfo(hwnd, SB_VERT, &mut si).is_ok() && si.nMax > 0 {
                let bottom = si.nPos as i64 + si.nPage as i64;
                return Ok(bottom >= si.nMax as i64 - 1);
            }
        }
        Ok(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
        Err("长截图功能目前仅支持 Windows".to_string())
    }
}

/// 长截图「预览即默认」：进入长截图前先探测选区命中的可滚动控件，返回它的
/// 窗体屏幕矩形 + 滚动范围（nMax/nPage/nPos），供前端画出「整页淡预览」并让用户
/// 单击截整页 / 拖拽选纵向区间。无 Win32 滚动条（浏览器/SPA 等）→ 返回 None，
/// 前端回退到「直接自动滚动」的旧行为，零回归。
#[derive(serde::Serialize)]
pub struct ScrollRangeOut {
    /// 可滚动控件窗体的屏幕矩形（物理像素，绝对坐标）
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// SB_VERT 滚动范围。
    ///
    /// ❌ 单位是**滚动单位**，不是像素：编辑框按**行**、列表按**项**、
    /// 只有那些自己按像素设范围的应用才恰好是像素。拿它当像素算预览高度，
    /// 在记事本/列表上会错得很远。所以另给 `extra_ratio`，前端只用比例。
    pub n_max: i32,
    /// 视口高度（滚动单位）
    pub n_page: i32,
    /// 当前滚动位置（滚动单位）
    pub n_pos: i32,
    /// 光标下方还有多少屏内容（**无单位比例**）= (nMax - nPage - nPos) / nPage。
    ///
    /// 比例在任何滚动单位下都成立（行/项/像素同时约掉），乘上选区高度就是
    /// 预览要伸展的物理像素数。前端算预览几何与屏数一律用它。
    pub extra_ratio: f32,
}

#[tauri::command]
pub fn get_scroll_range(x: i32, y: i32) -> Result<Option<ScrollRangeOut>, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = match find_vscroll_hwnd(x, y) {
            Some(h) => h,
            None => return Ok(None),
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetScrollInfo, GetWindowRect, SB_VERT, SCROLLINFO, SIF_ALL,
        };
        use windows::Win32::Foundation::RECT;
        unsafe {
            let mut wr = RECT::default();
            if GetWindowRect(hwnd, &mut wr).is_err() {
                return Ok(None);
            }
            let mut si = SCROLLINFO {
                cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
                fMask: SIF_ALL,
                ..Default::default()
            };
            if GetScrollInfo(hwnd, SB_VERT, &mut si).is_ok() && si.nMax > 0 {
                // 用比例而不是绝对值把「下面还有多少」传出去（见 extra_ratio 的注释）。
                // nPage 为 0（控件不报 SIF_PAGE）时无法归一化，给 0 让前端走无预览的旧路径。
                let page = si.nPage as i32;
                let extra_ratio = if page > 0 {
                    ((si.nMax as i32 - page - si.nPos as i32).max(0) as f32) / page as f32
                } else {
                    0.0
                };
                return Ok(Some(ScrollRangeOut {
                    x: wr.left,
                    y: wr.top,
                    w: wr.right - wr.left,
                    h: wr.bottom - wr.top,
                    n_max: si.nMax as i32,
                    n_page: page,
                    n_pos: si.nPos as i32,
                    extra_ratio,
                }));
            }
        }
        Ok(None)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
        Err("长截图功能目前仅支持 Windows".to_string())
    }
}

/// 长截图滚动注入的统一入口（替代 `send_mouse_wheel` 在长截图中的使用）。
///
/// 优先级：`WM_VSCROLL`（经典可滚动控件，最规范）→ `WM_MOUSEWHEEL` PostMessage（现代应用）
/// → `SendInput` 真实滚轮（只认真实输入的应用）。
/// `force_input = true` 时跳过前两种，直接走 SendInput（前端发现画面没动时升级用）。
#[tauri::command]
pub fn scroll_longshot(
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
            // ❌ 不能写成 `scroll_via_vscroll(..).or_else(|_| 滚轮)`：PostMessage 只要窗口句柄
            // 有效就返回成功，**与控件是否真的滚了没关系**，于是 or_else 永不触发，
            // “现代应用不响应 WM_VSCROLL 会自动回退滚轮”根本不成立。
            // 改成**两种都发**：经典控件吃 WM_VSCROLL、现代应用吃 WM_MOUSEWHEEL，
            // 两者互不干扰（不认的那条就是一个被忽略的消息），而且省掉一轮无效尝试。
            // 两路都投不出去才降到 SendInput（真实输入，成本最高、会动真光标）。
            //
            // 注意：投递成功仍不代表画面真的动了。“到底了还是不认”由前端的
            // waitStable + 重叠比对判定，没动会升级到 force_input 兑底。
            let a = scroll_via_vscroll(x, y);
            let b = send_wheel_via_post(x, y, delta);
            if a.is_ok() || b.is_ok() {
                Ok(())
            } else {
                send_wheel_via_input(x, y, delta)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, delta, force_input);
        Err("长截图功能目前仅支持 Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::pick_status_pos;

    // 1920x1080 主屏，状态窗 300x48，间距 16
    const SCREEN: (i32, i32, i32, i32) = (0, 0, 1920, 1080);
    const W: i32 = 300;
    const H: i32 = 48;
    const GAP: i32 = 16;

    fn pick(sel: (i32, i32, i32, i32)) -> Option<(i32, i32)> {
        pick_status_pos(sel, SCREEN, W, H, GAP)
    }

    /// 状态窗与选区相交 = 会被 BitBlt 拼进长图，这是这个函数唯一不能出错的地方
    fn intersects(pos: (i32, i32), sel: (i32, i32, i32, i32)) -> bool {
        let (x, y) = pos;
        let (sx, sy, sw, sh) = sel;
        !(x + W <= sx || x >= sx + sw || y + H <= sy || y >= sy + sh)
    }

    #[test]
    fn 选区在左上时状态窗放右下() {
        let sel = (100, 100, 400, 300);
        let p = pick(sel).expect("左上小选区必然有位置");
        assert_eq!(p, (1920 - GAP - W, 1080 - GAP - H));
        assert!(!intersects(p, sel));
    }

    #[test]
    fn 选区盖住右下角时改放左下() {
        // 选区覆盖右下角候选位，右下不可用
        let sel = (1400, 900, 500, 180);
        let p = pick(sel).expect("左下应该可用");
        assert_eq!(p, (GAP, 1080 - GAP - H));
        assert!(!intersects(p, sel));
    }

    #[test]
    fn 横贯屏幕底部的选区把状态窗挤到上方() {
        // 底部整条被占：左下右下都不行，右上可用
        let sel = (0, 800, 1920, 280);
        let p = pick(sel).expect("上方应该可用");
        assert_eq!(p.1, GAP);
        assert!(!intersects(p, sel));
    }

    #[test]
    fn 选区占满屏幕时不给位置() {
        // 无处可放。宁可不开窗，也不能把状态窗拼进用户的长图
        assert_eq!(pick((0, 0, 1920, 1080)), None);
    }

    #[test]
    fn 只剩中间一条缝时也不会给出相交位置() {
        // 上下各占一半多一点，四个角全被占，中间缝隙放不下 48 高
        let sel = (0, 0, 1920, 1060);
        match pick(sel) {
            Some(p) => panic!("不该返回相交位置 {:?}", p),
            None => {}
        }
    }

    #[test]
    fn 负原点副屏也能正确算位置() {
        // 副屏摆在主屏左边：虚拟屏原点为负
        let screen = (-1920, 0, 3840, 1080);
        let sel = (-1800, 100, 400, 300);
        let p = pick_status_pos(sel, screen, W, H, GAP).expect("有位置");
        // 必须落在虚拟屏内，且不与选区相交
        assert!(p.0 >= -1920 && p.0 + W <= 1920);
        assert!(p.1 >= 0 && p.1 + H <= 1080);
        let (sx, sy, sw, sh) = sel;
        assert!(p.0 + W <= sx || p.0 >= sx + sw || p.1 + H <= sy || p.1 >= sy + sh);
    }

    #[test]
    fn 紧贴选区边缘不算相交() {
        // 选区右边缘正好等于状态窗左边缘：不相交，可以用
        let sel = (0, 0, 1920 - GAP - W, 1080);
        let p = pick(sel).expect("右侧缝隙刚好放得下");
        assert_eq!(p.0, 1920 - GAP - W);
        assert!(!intersects(p, sel));
    }
}

/* ===================== 编码格式选型基准 =====================
 *
 * 背景：用户反馈"截图没有实际图片清晰"。原因是有损压缩叠了两代
 *   ① 本文件 capture_rect：全屏 JPEG q90，且 image 0.25 的 JpegEncoder
 *      写死 4:2:2 色度抽样（见 codecs/jpeg/encoder.rs 的 "subsampling ratio 4:2:2"，
 *      与 quality 参数无关）；
 *   ② 前端 canvasToDataUrl：合成图再编一次 JPEG 0.92。
 *
 * ② 改 PNG 几乎零代价（发生在用户点「完成」之后）。① 是否能改无损，
 * 取决于编码耗时——截图窗打开是即时路径，用户已经抱怨过一次"截图速度有点慢"。
 * 所以不能凭上面那句"慢约 5 倍"的注释下判断，必须实测。
 *
 * 跑法（必须在有桌面会话的环境下，GDI 需要真实屏幕）：
 *   cd src-tauri && cargo test --release encode_bench -- --nocapture --ignored
 *
 * 标 #[ignore] 的理由：它依赖真实屏幕内容与机器性能，结果不是稳定断言，
 * 不能进 CI 常规用例——它是一次性的选型工具，留在仓库里是为了以后
 * 换 image 版本或换机器时能一键复测。
 */
#[cfg(all(test, target_os = "windows"))]
mod encode_bench {
    use std::io::Cursor;
    use std::time::Instant;

    fn ms(t: Instant) -> f64 {
        t.elapsed().as_secs_f64() * 1000.0
    }

    #[test]
    #[ignore]
    fn encode_bench() {
        // ❗ 必须先声明 per-monitor V2，否则这个基准是错的。
        //
        // 正式进程里这一步由 tao 帮忙做了（tao/src/platform_impl/windows/dpi.rs 的
        // become_dpi_aware 调 SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)），
        // 但 cargo test 不走 tao——默认是 DPI unaware，于是
        // GetSystemMetrics(SM_CXVIRTUALSCREEN) 返回的是**虚拟化后的逻辑像素**
        // （150% 缩放下只有真实分辨率的 2/3），像素量差一半以上，
        // 测出的编码耗时会严重偏乐观，拿这种数字做选型会得出错结论。
        unsafe {
            use windows::Win32::UI::HiDpi::{
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            };
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }

        let (w, h, ox, oy) = super::virtual_screen_metrics();
        println!("\n虚拟屏幕 {w}x{h} @({ox},{oy}) = {} 万像素", w * h / 10000);
        println!("（请核对这个尺寸是不是你屏幕的真实分辨率——对不上就说明 DPI 声明没生效）");

        // 抓一次原始像素，所有编码器共用同一份输入（公平对比）
        let t = Instant::now();
        let rgba = super::grab_rect_rgba(ox, oy, w, h).expect("抓屏失败");
        let grab_ms = ms(t);
        println!("BitBlt + BGRA→RGBA : {grab_ms:7.1} ms   {:6.1} MB 原始", rgba.len() as f64 / 1e6);

        let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba).expect("构造失败");
        let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();

        println!("\n{:<26} {:>9} {:>10} {:>9}", "编码方式", "耗时", "体积", "base64后");
        println!("{}", "-".repeat(58));

        let report = |name: &str, enc_ms: f64, bytes: usize| {
            // base64 膨胀 4/3；data URL 要走一次 IPC 到 WebView
            let b64_ms = {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                let buf = vec![0u8; bytes];
                let t = Instant::now();
                let _ = STANDARD.encode(&buf);
                ms(t)
            };
            println!(
                "{:<26} {:>7.1}ms {:>8.2}MB {:>7.2}MB (+{:.0}ms)",
                name, enc_ms, bytes as f64 / 1e6, bytes as f64 * 4.0 / 3.0 / 1e6, b64_ms
            );
        };

        // ① 现状基线
        for q in [90u8, 95] {
            let t = Instant::now();
            let mut buf = Cursor::new(Vec::new());
            let e = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q);
            rgb.write_with_encoder(e).unwrap();
            let d = ms(t);
            report(&format!("JPEG q{q} (4:2:2)"), d, buf.get_ref().len());
        }

        // ② PNG：压缩等级 × 滤波器
        use image::codecs::png::{CompressionType as C, FilterType as F, PngEncoder};
        use image::{ExtendedColorType, ImageEncoder};
        for (cn, c) in [("Fast", C::Fast), ("Default", C::Default)] {
            for (fnm, f) in [("NoFilter", F::NoFilter), ("Up", F::Up), ("Adaptive", F::Adaptive)] {
                let t = Instant::now();
                let mut buf: Vec<u8> = Vec::new();
                PngEncoder::new_with_quality(&mut buf, c, f)
                    .write_image(&rgb, w as u32, h as u32, ExtendedColorType::Rgb8)
                    .unwrap();
                let d = ms(t);
                report(&format!("PNG {cn}/{fnm} (RGB8)"), d, buf.len());
            }
        }

        println!("\n参考：截图窗打开是即时路径，用户可感知阈值约 300ms（含 grab {grab_ms:.0}ms）");
    }
}
