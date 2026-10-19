//! Windows OLE 复制拖放：交付独立原图快照，原贴图保留；不注入粘贴或发送按键。
use std::{path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, AtomicIsize, Ordering}}};
use windows::core::{implement, w, HRESULT, PCWSTR, Result as WinResult};
use windows::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{
        Com::{CoCreateInstance, IDataObject, FORMATETC, STGMEDIUM, STGMEDIUM_0, CLSCTX_INPROC_SERVER, DVASPECT_CONTENT, TYMED_HGLOBAL},
        DataExchange::RegisterClipboardFormatW,
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::*,
        SystemServices::{MODIFIERKEYS_FLAGS, MK_LBUTTON, MK_MBUTTON, MK_RBUTTON},
        Threading::GetCurrentProcessId,
    },
    UI::{Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON}, Shell::{SHCreateItemFromParsingName, IShellItem, BHID_DataObject, IDragSourceHelper, SHDRAGIMAGE, CLSID_DragDropHelper}, WindowsAndMessaging::*},
};

#[derive(Debug, PartialEq)]
pub enum Outcome { Received, Cancelled, Rejected, Desktop }
pub fn outcome(status: HRESULT, effect: DROPEFFECT) -> Outcome {
    // DROP + NONE 只是松手，不能谎报“已交付”。所有允许效果都只有 COPY。
    if status == DRAGDROP_S_DROP && effect.0 & DROPEFFECT_COPY.0 != 0 { Outcome::Received }
    else if status == DRAGDROP_S_CANCEL { Outcome::Cancelled }
    else { Outcome::Rejected }
}
pub fn desktop_class(class: &str) -> bool {
    matches!(class, "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}
/// OLE has no receiver on either desktop or an unsupported app. Inspect the exposed surface,
/// skipping our hidden source / transparent drag overlay rather than treating both as desktop.
pub unsafe fn desktop_at(point: POINT, ignored_window: Option<isize>) -> bool {
    struct Scan { point: POINT, desktop: bool, ignored_window: Option<isize> }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let scan = &mut *(data.0 as *mut Scan);
        if scan.ignored_window == Some(hwnd.0 as isize) { return BOOL(1); }
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool()
            || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT.0 as isize != 0 { return BOOL(1); }
        let mut name = [0u16; 128];
        let len = GetClassNameW(hwnd, &mut name).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..len]);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == GetCurrentProcessId() && class == "PinnedImageWindow" { return BOOL(1); }
        let mut cloaked = 0u32;
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, std::mem::size_of::<u32>() as u32);
        if cloaked != 0 { return BOOL(1); }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() || scan.point.x < rect.left || scan.point.x >= rect.right
            || scan.point.y < rect.top || scan.point.y >= rect.bottom { return BOOL(1); }
        scan.desktop = desktop_class(&class);
        BOOL(0)
    }
    let mut scan = Scan { point, desktop: false, ignored_window };
    let _ = EnumWindows(Some(visit), LPARAM(&mut scan as *mut _ as isize));
    scan.desktop
}
unsafe fn released_outcome(released: bool, ignored_window: Option<isize>) -> Outcome {
    let mut point = POINT::default();
    if crate::pin_drag_policy::desktop_release(released, GetCursorPos(&mut point).is_ok() && desktop_at(point, ignored_window)) {
        Outcome::Desktop
    } else { Outcome::Rejected }
}
unsafe fn allowed_target(window: HWND) -> bool {
    if window.0.is_null() || !IsWindow(window).as_bool() { return false; }
    let root = GetAncestor(window, GA_ROOT);
    let mut name = [0u16; 128];
    let len = GetClassNameW(root, &mut name).max(0) as usize;
    if desktop_class(&String::from_utf16_lossy(&name[..len])) { return false; }
    let mut pid = 0;
    GetWindowThreadProcessId(window, Some(&mut pid));
    pid != 0 && pid != GetCurrentProcessId()
}
fn continuation(cancel: bool, escape: bool, keys: MODIFIERKEYS_FLAGS, allowed: bool) -> HRESULT {
    if cancel || escape || keys.0 & (MK_RBUTTON.0 | MK_MBUTTON.0) != 0 { DRAGDROP_S_CANCEL }
    else if keys.0 & MK_LBUTTON.0 == 0 { if allowed { DRAGDROP_S_DROP } else { DRAGDROP_S_CANCEL } }
    else { S_OK }
}
#[implement(IDropSource, IDropSourceNotify)]
struct Source {
    cancel: Arc<AtomicBool>, target: AtomicIsize, released: Arc<AtomicBool>,
    preview: Option<Arc<dyn Fn() + Send + Sync>>,
    last_preview: std::sync::Mutex<std::time::Instant>,
}
impl IDropSource_Impl for Source_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        let cancelled = self.cancel.load(Ordering::Acquire) || escape.as_bool()
            || keys.0 & (MK_RBUTTON.0 | MK_MBUTTON.0) != 0;
        if !cancelled && keys.0 & MK_LBUTTON.0 == 0 { self.released.store(true, Ordering::Release); }
        if !cancelled && keys.0 & MK_LBUTTON.0 != 0 {
            let mut last = self.last_preview.lock().unwrap_or_else(|p| p.into_inner());
            if last.elapsed() >= std::time::Duration::from_millis(60) {
                *last = std::time::Instant::now(); drop(last);
                if let Some(preview) = &self.preview { preview(); }
            }
        }
        continuation(self.cancel.load(Ordering::Acquire), escape.as_bool(), keys, unsafe { allowed_target(HWND(self.target.load(Ordering::Acquire) as *mut _)) })
    }
    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        if unsafe { allowed_target(HWND(self.target.load(Ordering::Acquire) as *mut _)) } { DRAGDROP_S_USEDEFAULTCURSORS }
        else {
            unsafe { if let Ok(cursor) = LoadCursorW(None, if self.preview.is_some() { IDC_ARROW } else { IDC_NO }) { SetCursor(cursor); } }
            S_OK
        }
    }
}
impl IDropSourceNotify_Impl for Source_Impl {
    fn DragEnterTarget(&self, target: HWND) -> WinResult<()> {
        // 以 OLE 通知的真实接收窗口判断；鼠标命中可能是拖动缩略图，不能用它猜接收目标。
        self.target.store(target.0 as isize, Ordering::Release);
        Ok(())
    }
    fn DragLeaveTarget(&self) -> WinResult<()> {
        self.target.store(0, Ordering::Release);
        Ok(())
    }
}
struct OleScope;
impl OleScope {
    unsafe fn new() -> WinResult<Self> { OleInitialize(None)?; Ok(Self) }
}
impl Drop for OleScope { fn drop(&mut self) { unsafe { OleUninitialize(); } } }

/// COM 数据对象先于 STA 释放；字段顺序不能交换。
pub struct Drag { data: IDataObject, source: IDropSource, released: Arc<AtomicBool>, ignored_window: Option<isize>, _ole: OleScope }
impl Drag {
    #[cfg(test)]
    pub unsafe fn prepare(path: &str, rgba: &[u8], width: u32, height: u32, cache: &Path, cancel: Arc<AtomicBool>) -> Result<Self, String> {
        Self::prepare_with_preview(path, rgba, width, height, cache, cancel, None, None)
    }
    #[allow(clippy::too_many_arguments)] // 独立语义参数，打包结构体反而难读
    pub unsafe fn prepare_with_preview(path: &str, rgba: &[u8], width: u32, height: u32, cache: &Path, cancel: Arc<AtomicBool>, preview: Option<Arc<dyn Fn() + Send + Sync>>, ignored_window: Option<isize>) -> Result<Self, String> {
        let ole = OleScope::new().map_err(|e| e.to_string())?;
        let staged = stage_file(Path::new(path), cache)?;
        let name: Vec<u16> = staged.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None).map_err(|e| e.to_string())?;
        let data: IDataObject = item.BindToHandler(None, &BHID_DataObject).map_err(|e| e.to_string())?;
        // Shell 提供 CF_HDROP；位图格式让接受图片但不接受文件的输入区也有机会接收。
        // 直接写 HGLOBAL，避免再复制一份完整 RGBA 或生成带 UI 的截图。
        set_dib(&data, rgba, width, height).map_err(|e| e.to_string())?;
        if let Ok(bytes) = std::fs::read(&staged) {
            if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                let format = RegisterClipboardFormatW(w!("PNG")) as u16;
                if format != 0 { set_bytes(&data, format, &bytes).map_err(|e| e.to_string())?; }
            }
        }
        // 小缩略图只服务拖动反馈；接收数据始终为原始尺寸。
        if let Err(e) = drag_image(&data, rgba, width, height) {
            log::debug!("拖动缩略图不可用，保留系统接收光标: {e}");
        }
        let released = Arc::new(AtomicBool::new(false));
        let source: IDropSource = Source { cancel, target: AtomicIsize::new(0), released: released.clone(), preview, last_preview: std::sync::Mutex::new(std::time::Instant::now()) }.into();
        Ok(Self { data, source, released, ignored_window, _ole: ole })
    }
    pub unsafe fn perform(&self) -> Result<Outcome, String> {
        // IPC / 解码期间已经松手时只落成贴图，不能立即向鼠标下的应用交付。
        if GetAsyncKeyState(VK_ESCAPE.0 as i32) < 0 { return Ok(Outcome::Cancelled); }
        if GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 { return Ok(released_outcome(true, self.ignored_window)); }
        self.released.store(false, Ordering::Release);
        let mut effect = DROPEFFECT_NONE;
        let status = DoDragDrop(&self.data, &self.source, DROPEFFECT_COPY, &mut effect);
        if status.is_err() { return Err(status.message().to_string()); }
        let result = outcome(status, effect);
        // A desktop release intentionally ends OLE without copying a file to Explorer.
        Ok(if result == Outcome::Cancelled && self.released.load(Ordering::Acquire) { released_outcome(true, self.ignored_window) } else { result })
    }
}
fn stage_file(source: &Path, root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // 目标可能在 Drop 返回后才读文件：不在拖放结束时删快照，也不依赖历史图片的生命周期。
    // 仅首次拖动清理本目录七天前的专属文件，无常驻定时器。
    static CLEANUP: std::sync::Once = std::sync::Once::new();
    CLEANUP.call_once(|| {
        let root = root.to_owned();
        std::thread::spawn(move || {
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten().take(256) {
                    let own = entry.file_name().to_string_lossy().starts_with("pin-drop-");
                    let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > 7 * 24 * 3600);
                    if own && old { let _ = std::fs::remove_file(entry.path()); }
                }
            }
        });
    });
    let extension = source.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let target = root.join(format!("pin-drop-{}.{}", uuid::Uuid::new_v4(), extension));
    let mut input = std::fs::File::open(source).map_err(|e| format!("无法读取原图: {e}"))?;
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
    // 不继承旧截图的修改时间，否则首次清理可能把刚复制出的老图片当作过期快照。
    std::io::copy(&mut input, &mut output).map_err(|e| format!("无法准备原图: {e}"))?;
    Ok(target)
}
fn format(code: u16) -> FORMATETC {
    FORMATETC { cfFormat: code, dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32, ..Default::default() }
}
unsafe fn set_global(data: &IDataObject, code: u16, len: usize, write: impl FnOnce(&mut [u8])) -> WinResult<()> {
    let global = GlobalAlloc(GMEM_MOVEABLE, len)?;
    let pointer = GlobalLock(global);
    if pointer.is_null() { let _ = GlobalFree(global); return Err(windows::core::Error::from_win32()); }
    write(std::slice::from_raw_parts_mut(pointer as *mut u8, len));
    let _ = GlobalUnlock(global);
    let medium = STGMEDIUM { tymed: TYMED_HGLOBAL.0 as u32, u: STGMEDIUM_0 { hGlobal: global }, ..Default::default() };
    if let Err(error) = data.SetData(&format(code), &medium, true) {
        let _ = GlobalFree(global); return Err(error);
    }
    Ok(())
}
unsafe fn set_bytes(data: &IDataObject, code: u16, bytes: &[u8]) -> WinResult<()> {
    set_global(data, code, bytes.len(), |out| out.copy_from_slice(bytes))
}
unsafe fn set_dib(data: &IDataObject, rgba: &[u8], width: u32, height: u32) -> WinResult<()> {
    let stride = width as usize * 4;
    let length = stride.checked_mul(height as usize).filter(|n| *n == rgba.len() && *n <= u32::MAX as usize)
        .ok_or_else(|| windows::core::Error::from(E_INVALIDARG))?;
    set_global(data, CF_DIB.0, 40 + length, |out| {
        out[..40].fill(0);
        out[0..4].copy_from_slice(&40u32.to_le_bytes());
        out[4..8].copy_from_slice(&width.to_le_bytes());
        out[8..12].copy_from_slice(&height.to_le_bytes());
        out[12..14].copy_from_slice(&1u16.to_le_bytes());
        out[14..16].copy_from_slice(&32u16.to_le_bytes());
        out[20..24].copy_from_slice(&(length as u32).to_le_bytes());
        for y in 0..height as usize {
            let source = &rgba[(height as usize - 1 - y) * stride..(height as usize - y) * stride];
            for (pixel, dest) in source.chunks_exact(4).zip(out[40 + y * stride..40 + (y+1) * stride].chunks_exact_mut(4)) {
                dest.copy_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
            }
        }
    })
}
unsafe fn drag_image(data: &IDataObject, rgba: &[u8], width: u32, height: u32) -> WinResult<()> {
    let factor = (240.0 / width as f64).min(180.0 / height as f64).min(1.0);
    let w = (width as f64 * factor).round().max(1.0) as i32;
    let h = (height as f64 * factor).round().max(1.0) as i32;
    let info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, ..Default::default() }, ..Default::default() };
    let mut bits = std::ptr::null_mut();
    let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
    if bits.is_null() { let _ = DeleteObject(bitmap); return Err(windows::core::Error::from(E_FAIL)); }
    let out = std::slice::from_raw_parts_mut(bits as *mut u8, (w*h*4) as usize);
    for y in 0..h as usize { for x in 0..w as usize {
        let sx = (x * width as usize / w as usize).min(width as usize - 1);
        let sy = (y * height as usize / h as usize).min(height as usize - 1);
        let input = &rgba[(sy*width as usize+sx)*4..][..4];
        out[(y*w as usize+x)*4..][..4].copy_from_slice(&[input[2],input[1],input[0],input[3]]);
    }}
    let result = (|| {
        let helper: IDragSourceHelper = CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER)?;
        helper.InitializeFromBitmap(&SHDRAGIMAGE { sizeDragImage: SIZE { cx: w, cy: h }, ptOffset: POINT { x: w / 2, y: h / 2 }, hbmpDragImage: bitmap, crColorKey: COLORREF(u32::MAX) }, data)
    })();
    let _ = DeleteObject(bitmap);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "本地大图性能诊断，不进入常规回归"]
    fn large_image_prepare_timings() {
        let root = std::env::temp_dir().join(format!("pastepanda-transfer-bench-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("source.png");
        let image = image::RgbaImage::from_fn(3840, 2160, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]));
        image.save(&path).unwrap();
        let start = std::time::Instant::now();
        let decoded = image::open(&path).unwrap();
        let decode = start.elapsed();
        let start = std::time::Instant::now();
        let _thumb = decoded.resize_exact(300, 168, image::imageops::FilterType::Lanczos3).to_rgb8();
        let thumbnail = start.elapsed();
        let rgba = decoded.into_rgba8();
        let start = std::time::Instant::now();
        let scaled = pastepanda_rc_scale::rgba_thumbnail(&rgba, 3840, 2160, 300, 168).unwrap();
        let accelerated = start.elapsed();
        assert_eq!(scaled.len(), 300 * 168 * 4);
        let start = std::time::Instant::now();
        let drag = unsafe { Drag::prepare(path.to_str().unwrap(), &rgba, 3840, 2160, &root.join("leases"), Arc::new(AtomicBool::new(false))).unwrap() };
        eprintln!("4K PNG: decode={decode:?}, previous thumbnail={thumbnail:?}, accelerated thumbnail={accelerated:?}, OLE prepare={:?}, RGBA={}bytes", start.elapsed(), rgba.len());
        drop(drag);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn copy_requires_received_effect_and_cancel_keeps_source() {
        assert_eq!(outcome(DRAGDROP_S_DROP, DROPEFFECT_COPY), Outcome::Received);
        assert_eq!(outcome(DRAGDROP_S_DROP, DROPEFFECT_NONE), Outcome::Rejected);
        assert_eq!(outcome(DRAGDROP_S_CANCEL, DROPEFFECT_COPY), Outcome::Cancelled);
        assert_eq!(outcome(DRAGDROP_S_DROP, DROPEFFECT_MOVE), Outcome::Rejected);
    }
    #[test]
    fn cancel_and_desktop_release_never_deliver_files() {
        assert_eq!(continuation(false, false, MK_LBUTTON, false), S_OK);
        assert_eq!(continuation(false, false, MODIFIERKEYS_FLAGS(0), false), DRAGDROP_S_CANCEL);
        assert_eq!(continuation(false, false, MODIFIERKEYS_FLAGS(0), true), DRAGDROP_S_DROP);
        assert_eq!(continuation(false, true, MK_LBUTTON, true), DRAGDROP_S_CANCEL);
        assert_eq!(continuation(true, false, MK_LBUTTON, true), DRAGDROP_S_CANCEL);
        for name in ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"] { assert!(desktop_class(name)); }
        assert!(!desktop_class("WeChatMainWndForPC"));
    }
    #[test]
    fn source_exposes_target_notifications_and_cancels_closed_target() {
        use windows::core::Interface;
        unsafe {
            let cancel = Arc::new(AtomicBool::new(false));
            let source: IDropSource = Source { cancel: cancel.clone(), target: AtomicIsize::new(0),
                released: Arc::new(AtomicBool::new(false)), preview: None,
                last_preview: std::sync::Mutex::new(std::time::Instant::now()) }.into();
            let notify: IDropSourceNotify = source.cast().unwrap();
            notify.DragEnterTarget(HWND(1usize as *mut _)).unwrap();
            assert_eq!(source.QueryContinueDrag(false, MODIFIERKEYS_FLAGS(0)), DRAGDROP_S_CANCEL);
            assert_eq!(source.QueryContinueDrag(true, MK_LBUTTON), DRAGDROP_S_CANCEL);
            cancel.store(true, Ordering::Release);
            assert_eq!(source.QueryContinueDrag(false, MK_LBUTTON), DRAGDROP_S_CANCEL);
            notify.DragLeaveTarget().unwrap();
        }
    }
    #[test]
    fn shell_object_delivers_original_file_and_full_size_dib() {
        unsafe {
            let root = std::env::temp_dir().join(format!("pastepanda-transfer-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("source.png");
            let mut rgba = [255, 0, 0, 255].repeat(256 * 128);
            rgba[(127 * 256 + 1) * 4..][..4].copy_from_slice(&[0, 255, 0, 255]);
            image::save_buffer(&path, &rgba, 256, 128, image::ColorType::Rgba8).unwrap();
            std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1)).unwrap();
            let drag = Drag::prepare(path.to_str().unwrap(), &rgba, 256, 128, &root.join("leases"), Arc::new(AtomicBool::new(false))).unwrap();
            assert!(drag.data.QueryGetData(&format(CF_HDROP.0)).is_ok());
            let mut file_medium = drag.data.GetData(&format(CF_HDROP.0)).unwrap();
            let drop_handle = windows::Win32::UI::Shell::HDROP(file_medium.u.hGlobal.0);
            let length = windows::Win32::UI::Shell::DragQueryFileW(drop_handle, 0, None);
            let mut name = vec![0u16; length as usize + 1];
            windows::Win32::UI::Shell::DragQueryFileW(drop_handle, 0, Some(&mut name));
            let delivered_file = PathBuf::from(String::from_utf16(&name[..length as usize]).unwrap());
            assert_ne!(delivered_file, path);
            assert_eq!(std::fs::read(&delivered_file).unwrap(), std::fs::read(&path).unwrap());
            ReleaseStgMedium(&mut file_medium);
            let mut medium = drag.data.GetData(&format(CF_DIB.0)).unwrap();
            let pointer = GlobalLock(medium.u.hGlobal) as *const u8;
            let bytes = std::slice::from_raw_parts(pointer, 48);
            assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 256);
            assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 128);
            assert_eq!(&bytes[40..48], &[0, 0, 255, 255, 0, 255, 0, 255]);
            let _ = GlobalUnlock(medium.u.hGlobal);
            ReleaseStgMedium(&mut medium);
            drop(drag);
            let retained = std::fs::read_dir(root.join("leases")).unwrap().flatten().next().unwrap().path();
            assert!(retained.metadata().unwrap().modified().unwrap().elapsed().unwrap().as_secs() < 120);
            assert_eq!(std::fs::read(retained).unwrap(), std::fs::read(path).unwrap());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
