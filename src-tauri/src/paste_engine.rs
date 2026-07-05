use crate::clipboard_monitor::PasteSuppress;
use arboard::Clipboard;
use arboard::ImageData;
use md5::Digest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 粘贴引擎 — 处理时序敏感的粘贴操作
pub struct PasteEngine {
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    /// 追踪的最后一个非自身前台窗口（由剪贴板轮询线程持续更新）
    tracked_foreground_hwnd: std::sync::Mutex<Option<isize>>,
    /// 手动保存的前台窗口句柄（由 save_foreground_hwnd 设置，优先使用）
    last_foreground_hwnd: std::sync::Mutex<Option<isize>>,
    /// 粘贴操作互斥锁：确保同一时间只有一个粘贴在执行，防止竞态
    paste_lock: AtomicBool,
}

impl PasteEngine {
    pub fn new(app_handle: AppHandle, paste_suppress: Arc<PasteSuppress>) -> Self {
        Self {
            app_handle,
            paste_suppress,
            tracked_foreground_hwnd: std::sync::Mutex::new(None),
            last_foreground_hwnd: std::sync::Mutex::new(None),
            paste_lock: AtomicBool::new(false),
        }
    }

    /// 持续追踪前台窗口 — 由剪贴板轮询线程每 400ms 调用一次
    /// 只记录非自身的窗口，确保保存的始终是用户正在操作的目标应用
    #[cfg(target_os = "windows")]
    pub fn track_foreground_window(&self) {
        use windows::Win32::UI::WindowsAndMessaging::*;
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return;
            }
            // 跳过我们自己的窗口
            if let Some(window) = self.app_handle.get_webview_window("main") {
                if let Ok(our_hwnd) = window.hwnd() {
                    if hwnd.0 as isize == our_hwnd.0 as isize {
                        return;
                    }
                }
            }
            // 更新追踪的前台窗口
            let old = match self.tracked_foreground_hwnd.lock() {
                Ok(v) => *v,
                Err(_) => return,
            };
            let new_hwnd = hwnd.0 as isize;
            if old != Some(new_hwnd) {
                // 获取窗口标题用于调试
                let len = GetWindowTextLengthW(hwnd);
                let title = if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    GetWindowTextW(hwnd, &mut buf);
                    String::from_utf16_lossy(&buf[..len as usize])
                } else {
                    "(无标题)".to_string()
                };
                log::info!(
                    "[PasteEngine] 追踪前台窗口: hwnd={}, title=\"{}\"",
                    new_hwnd,
                    title
                );
                if let Ok(mut guard) = self.tracked_foreground_hwnd.lock() {
                    *guard = Some(new_hwnd);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub fn track_foreground_window(&self) {}

    /// 手动保存当前前台窗口（在显示窗口之前调用，作为备用）。
    /// 排除 PastePanda 自身的窗口，避免把"自己"当作粘贴目标。
    pub fn save_foreground_hwnd(&self) {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_invalid() {
                    return;
                }
                // 过滤自身窗口
                if let Some(window) = self.app_handle.get_webview_window("main") {
                    if let Ok(our_hwnd) = window.hwnd() {
                        if hwnd.0 as isize == our_hwnd.0 as isize {
                            return;
                        }
                    }
                }
                if let Ok(mut guard) = self.last_foreground_hwnd.lock() {
                    *guard = Some(hwnd.0 as isize);
                }
            }
        }
    }

    /// 实时抓取当前前台窗口（排除自身），用于"粘贴前重抓"流程
    #[cfg(target_os = "windows")]
    pub fn capture_foreground_now(&self) -> Option<isize> {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }
            // 过滤自身窗口
            if let Some(window) = self.app_handle.get_webview_window("main") {
                if let Ok(our_hwnd) = window.hwnd() {
                    if hwnd.0 as isize == our_hwnd.0 as isize {
                        return None;
                    }
                }
            }
            Some(hwnd.0 as isize)
        }
    }
    #[cfg(not(target_os = "windows"))]
    pub fn capture_foreground_now(&self) -> Option<isize> {
        None
    }

    /// 获取最佳目标窗口句柄：手动保存 > 追踪 > 实时抓取 > None
    fn get_target_hwnd(&self) -> Option<isize> {
        // 优先使用手动保存的句柄
        if let Ok(manual) = self.last_foreground_hwnd.lock() {
            if manual.is_some() {
                return *manual;
            }
        }

        // 其次使用追踪的句柄
        if let Ok(tracked) = self.tracked_foreground_hwnd.lock() {
            if tracked.is_some() {
                return *tracked;
            }
        }

        // 最后实时抓取当前前台窗口（粘贴前一刻的最新状态）
        #[cfg(target_os = "windows")]
        {
            return self.capture_foreground_now();
        }
        #[cfg(not(target_os = "windows"))]
        None
    }

    /// 核心粘贴流程：写入剪贴板 → 发送 WM_PASTE 到目标窗口
    pub fn execute_paste(&self, text: Option<String>) -> Result<(), String> {
        log::info!("[PasteEngine] execute_paste 开始, text={}", text.is_some());

        // 0. 获取粘贴锁，防止竞态条件（同一时间只允许一个粘贴操作）
        if self.paste_lock.swap(true, Ordering::Acquire) {
            log::warn!("[PasteEngine] 上一个粘贴操作仍在进行中，跳过本次");
            return Err("上一个粘贴操作仍在进行中，请稍后再试".to_string());
        }
        // RAII 风格的锁释放
        struct LockGuard<'a>(&'a AtomicBool);
        impl<'a> Drop for LockGuard<'a> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = LockGuard(&self.paste_lock);

        // 1. 先设置粘贴抑制（必须在写入剪贴板之前）
        let content_hash = text.as_ref().map(|t| {
            format!(
                "{:x}",
                md5::Md5::new().chain_update(t.as_bytes()).finalize()
            )
        });
        if let Some(ref hash) = content_hash {
            self.paste_suppress
                .set_with_hash(Duration::from_millis(3000), hash.clone());
        } else {
            self.paste_suppress.set(Duration::from_millis(3000));
        }

        // 2. 写入剪贴板
        if let Some(ref t) = text {
            let mut clipboard = Clipboard::new().map_err(|e| format!("无法打开剪贴板: {}", e))?;
            clipboard
                .set_text(t.as_str())
                .map_err(|e| format!("无法写入剪贴板: {}", e))?;
            log::info!("[PasteEngine] 剪贴板已写入: {}...", &t[..t.len().min(30)]);
        }

        // 3. 粘贴前实时重抓前台窗口（排除自身）作为兜底目标，
        //    防止 tracked/manual 句柄过期或指向自身
        #[cfg(target_os = "windows")]
        if let Some(now_hwnd) = self.capture_foreground_now() {
            if let Ok(mut guard) = self.tracked_foreground_hwnd.lock() {
                *guard = Some(now_hwnd);
            }
        }

        // 4. 获取目标窗口句柄
        let target_hwnd = self.get_target_hwnd();
        log::info!("[PasteEngine] 目标窗口: {:?}", target_hwnd);

        // 4. 发送 WM_PASTE 到目标窗口
        #[cfg(target_os = "windows")]
        {
            self.restore_and_send_ctrl_v(target_hwnd)?;
        }

        // 5. 清除手动保存的句柄（仅在成功时清除，保留追踪的句柄）
        if let Ok(mut guard) = self.last_foreground_hwnd.lock() {
            *guard = None;
        }

        Ok(())
    }

    /// 仅复制不粘贴
    pub fn copy_only(&self, text: &str) -> Result<(), String> {
        let mut clipboard = Clipboard::new().map_err(|e| format!("无法打开剪贴板: {}", e))?;
        clipboard
            .set_text(text)
            .map_err(|e| format!("无法写入剪贴板: {}", e))?;
        Ok(())
    }

    /// 粘贴图片：读取图片文件 → 写入剪贴板 → 发送 WM_PASTE
    pub fn execute_paste_image(&self, image_path: &str) -> Result<(), String> {
        log::info!(
            "[PasteEngine] execute_paste_image 开始, path={}",
            image_path
        );

        // 0. 获取粘贴锁，防止竞态条件
        if self.paste_lock.swap(true, Ordering::Acquire) {
            log::warn!("[PasteEngine] 上一个粘贴操作仍在进行中，跳过本次图片粘贴");
            return Err("上一个粘贴操作仍在进行中，请稍后再试".to_string());
        }
        struct LockGuard<'a>(&'a AtomicBool);
        impl<'a> Drop for LockGuard<'a> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = LockGuard(&self.paste_lock);

        // 1. 设置粘贴抑制
        let content_hash = {
            let mut hasher = md5::Md5::new();
            let mut file =
                std::fs::File::open(image_path).map_err(|e| format!("无法打开图片文件: {}", e))?;
            std::io::copy(&mut file, &mut hasher).map_err(|e| format!("读取图片失败: {}", e))?;
            format!("{:x}", hasher.finalize())
        };
        self.paste_suppress
            .set_with_hash(Duration::from_millis(3000), content_hash);

        // 2. 读取图片并写入剪贴板
        let img = image::open(image_path).map_err(|e| format!("无法解码图片: {}", e))?;
        let rgba = img.to_rgba8();
        let (width, height) = rgba.dimensions();
        let img_data = ImageData {
            width: width as usize,
            height: height as usize,
            bytes: std::borrow::Cow::Borrowed(rgba.as_raw()),
        };

        let mut clipboard = Clipboard::new().map_err(|e| format!("无法打开剪贴板: {}", e))?;
        clipboard
            .set_image(img_data)
            .map_err(|e| format!("无法写入图片到剪贴板: {}", e))?;
        log::info!("[PasteEngine] 图片已写入剪贴板 {}x{}", width, height);

        // 3. 粘贴前实时重抓前台窗口（排除自身）
        #[cfg(target_os = "windows")]
        if let Some(now_hwnd) = self.capture_foreground_now() {
            if let Ok(mut guard) = self.tracked_foreground_hwnd.lock() {
                *guard = Some(now_hwnd);
            }
        }

        // 4. 获取目标窗口句柄
        let target_hwnd = self.get_target_hwnd();
        log::info!("[PasteEngine] 图片粘贴目标窗口: {:?}", target_hwnd);

        // 4. 发送 WM_PASTE
        #[cfg(target_os = "windows")]
        {
            self.restore_and_send_ctrl_v(target_hwnd)?;
        }

        // 5. 清除手动保存的句柄
        if let Ok(mut guard) = self.last_foreground_hwnd.lock() {
            *guard = None;
        }

        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn restore_and_send_ctrl_v(&self, hwnd_value: Option<isize>) -> Result<(), String> {
        use windows::Win32::Foundation::*;
        use windows::Win32::System::Threading::*;
        use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
        use windows::Win32::UI::WindowsAndMessaging::*;

        const WM_PASTE: u32 = 0x0302;

        log::info!(
            "[PasteEngine] restore_and_send_ctrl_v, hwnd={:?}",
            hwnd_value
        );

        unsafe {
            if let Some(hwnd_raw) = hwnd_value {
                let hwnd = HWND(hwnd_raw as *mut _);

                if !IsWindow(hwnd).as_bool() {
                    log::warn!("[PasteEngine] 目标窗口已不存在!");
                    return Ok(());
                }

                // 连接到目标窗口线程以获取其焦点控件
                let target_tid = GetWindowThreadProcessId(hwnd, None);
                let cur_tid = GetCurrentThreadId();
                let attached = if target_tid != cur_tid {
                    AttachThreadInput(cur_tid, target_tid, true).as_bool()
                } else {
                    true
                };

                // 找到目标窗口中有焦点的子控件（如 Notepad++ 的 Scintilla 编辑区）
                let focus_hwnd = GetFocus();
                let paste_target = if !focus_hwnd.is_invalid() && focus_hwnd != hwnd {
                    log::info!("[PasteEngine] 找到焦点子控件: {:?}", focus_hwnd.0);
                    focus_hwnd
                } else {
                    log::info!("[PasteEngine] 无焦点子控件，使用主窗口");
                    hwnd
                };

                // 使用 SendMessageW 同步发送 WM_PASTE，确保目标窗口处理完成再返回
                // 相比 PostMessageW，SendMessageW 更可靠，不会因目标消息队列繁忙而丢失粘贴
                let paste_result = SendMessageW(paste_target, WM_PASTE, WPARAM(0), LPARAM(0));
                log::info!("[PasteEngine] WM_PASTE 已发送, result={:?}", paste_result);

                // 断开线程连接
                if attached && target_tid != cur_tid {
                    let _ = AttachThreadInput(cur_tid, target_tid, false);
                }
            } else {
                log::warn!("[PasteEngine] 没有目标窗口!");
            }
        }

        Ok(())
    }
}
