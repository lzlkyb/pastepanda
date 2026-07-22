use crate::clipboard_monitor::PasteSuppress;
use arboard::Clipboard;
use arboard::ImageData;
use md5::Digest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

/// 粘贴引擎 — 处理时序敏感的粘贴操作
pub struct PasteEngine {
    #[allow(dead_code)]
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    /// 手动保存的前台窗口句柄 + 时间戳（由 save_foreground_hwnd 设置，优先使用）。
    /// 有效期 2 秒，过期自动失效。这样 sequential paste 循环中的多次粘贴
    /// 都能使用热键触发时保存的目标窗口，不会因 execute_paste 内部清除而丢失。
    last_foreground_hwnd: std::sync::Mutex<Option<(isize, std::time::Instant)>>,
    /// 粘贴操作互斥锁：确保同一时间只有一个粘贴在执行，防止竞态
    paste_lock: AtomicBool,
    /// 本进程 ID（启动时缓存，用于过滤自身所有子窗口）
    own_pid: u32,
}

impl PasteEngine {
    pub fn new(app_handle: AppHandle, paste_suppress: Arc<PasteSuppress>) -> Self {
        let own_pid = std::process::id();
        Self {
            app_handle,
            paste_suppress,
            last_foreground_hwnd: std::sync::Mutex::new(None),
            paste_lock: AtomicBool::new(false),
            own_pid,
        }
    }

    /// 判断窗口是否属于本进程（包括主窗口、子窗口、弹出窗口等）
    #[cfg(target_os = "windows")]
    fn is_own_window(&self, hwnd: isize) -> bool {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid));
            pid == self.own_pid
        }
    }
    #[cfg(not(target_os = "windows"))]
    fn is_own_window(&self, _hwnd: isize) -> bool { false }

    /// 手动保存当前前台窗口（在显示窗口之前调用，作为备用）。
    /// 排除 PastePanda 自身的窗口，避免把"自己"当作粘贴目标。
    /// 保存时会附带时间戳，2 秒后自动过期。
    pub fn save_foreground_hwnd(&self) {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_invalid() {
                    return;
                }
                // 用进程 ID 过滤自身所有窗口
                if self.is_own_window(hwnd.0 as isize) {
                    return;
                }
                if let Ok(mut guard) = self.last_foreground_hwnd.lock() {
                    *guard = Some((hwnd.0 as isize, std::time::Instant::now()));
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
            let hwnd_val = hwnd.0 as isize;
            if self.is_own_window(hwnd_val) {
                return None;
            }
            Some(hwnd_val)
        }
    }
    #[cfg(not(target_os = "windows"))]
    pub fn capture_foreground_now(&self) -> Option<isize> {
        None
    }

    /// 保存的前台窗口有效期（秒）。超过此时间，last_foreground_hwnd 视为过期。
    const FOREGROUND_TTL_SECS: u64 = 2;

    /// 获取最佳目标窗口句柄：手动保存（2秒内有效） > 实时抓取（粘贴前一刻） > None
    /// 
    /// 注意：不再使用 tracked_foreground_hwnd（400ms 轮询可能过时）。
    /// 传入的 fallback 是 execute_paste 在粘贴前实时抓取的结果，比轮询更可靠。
    fn get_target_hwnd(&self, fallback: Option<isize>) -> Option<isize> {
        // 优先使用手动保存的句柄（热键触发时第一时间保存），但仅限 2 秒内有效
        if let Ok(manual) = self.last_foreground_hwnd.lock() {
            if let Some((hwnd, timestamp)) = *manual {
                let elapsed = timestamp.elapsed().as_secs();
                if elapsed < Self::FOREGROUND_TTL_SECS {
                    return Some(hwnd);
                }
                // 已过期，不删除（下次 save_foreground_hwnd 会覆盖）
            }
        }

        // 回退到传入的实时抓取结果（粘贴前一刻的最新前台窗口）
        if fallback.is_some() {
            return fallback;
        }

        // 最后实时抓取当前前台窗口（兜底）
        #[cfg(target_os = "windows")]
        {
            return self.capture_foreground_now();
        }
        #[cfg(not(target_os = "windows"))]
        None
    }

    /// 核心粘贴流程：写入剪贴板 → 发送 WM_PASTE 到目标窗口
    pub fn execute_paste(
        &self,
        text: Option<String>,
    ) -> Result<crate::commands::PasteResult, String> {
        let mut result = crate::commands::PasteResult {
            success: false,
            error: None,
            target_hwnd: None,
            clipboard_written: false,
            wm_paste_sent: false,
        };

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
        }
        result.clipboard_written = true;

        // 3. 粘贴前实时重抓前台窗口（排除自身），作为 get_target_hwnd 的回退值
        #[cfg(target_os = "windows")]
        let now_hwnd = self.capture_foreground_now();
        #[cfg(not(target_os = "windows"))]
        let now_hwnd: Option<isize> = None;

        // 4. 获取目标窗口句柄：手动保存 > 实时抓取 > None
        let target_hwnd = self.get_target_hwnd(now_hwnd);
        result.target_hwnd = target_hwnd;

        // 4. 发送 WM_PASTE 到目标窗口
        #[cfg(target_os = "windows")]
        {
            self.restore_and_send_ctrl_v(target_hwnd)?;
        }
        result.wm_paste_sent = true;

        // 5. 不在此处清除 last_foreground_hwnd！
        //    改为依赖时间戳过期机制（2 秒 TTL），确保 sequential paste
        //    循环中的多次粘贴都能使用热键触发时保存的目标窗口。

        result.success = true;
        Ok(result)
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
        // 1. 读取并解码图片（hash 口径须与监听线程一致：对 RGBA 像素字节计算，修复 C9。
        //    旧实现对磁盘文件字节算 hash，而监听线程对 arboard 解码后的 RGBA 算 hash，
        //    两者永不相等，导致图片自粘贴的 hash 主检查永远失效）
        //    修复 C18：先仅读头部校验尺寸上限，防解压炸弹
        //    修复 M30：慢 I/O（读文件+解码）在锁外执行，paste_lock 只保护
        //    "写剪贴板 → 发送 WM_PASTE" 临界区，避免大图解码期间阻塞所有粘贴
        crate::commands::check_image_decode_limits(std::path::Path::new(image_path))?;
        let img = image::open(image_path).map_err(|e| format!("无法解码图片: {}", e))?;
        let rgba = img.to_rgba8();
        let (width, height) = rgba.dimensions();
        let content_hash = format!("{:x}", md5::Md5::new().chain_update(rgba.as_raw()).finalize());

        // 2. 获取粘贴锁，防止剪贴板写入与粘贴投递之间的竞态条件
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

        // 3. 设置粘贴抑制（hash = RGBA 像素字节的 MD5，与监听线程匹配）
        self.paste_suppress
            .set_with_hash(Duration::from_millis(3000), content_hash);

        // 4. 写入剪贴板
        let img_data = ImageData {
            width: width as usize,
            height: height as usize,
            bytes: std::borrow::Cow::Borrowed(rgba.as_raw()),
        };

        let mut clipboard = Clipboard::new().map_err(|e| format!("无法打开剪贴板: {}", e))?;
        clipboard
            .set_image(img_data)
            .map_err(|e| format!("无法写入图片到剪贴板: {}", e))?;

        // 5. 粘贴前实时重抓前台窗口（排除自身）
        #[cfg(target_os = "windows")]
        let now_hwnd = self.capture_foreground_now();
        #[cfg(not(target_os = "windows"))]
        let now_hwnd: Option<isize> = None;

        // 4. 获取目标窗口句柄
        let target_hwnd = self.get_target_hwnd(now_hwnd);

        // 5. 发送 Ctrl+V
        #[cfg(target_os = "windows")]
        {
            self.restore_and_send_ctrl_v(target_hwnd)?;
        }

        // 5. 不在此处清除 last_foreground_hwnd（依赖 2 秒 TTL 过期）

        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn restore_and_send_ctrl_v(&self, hwnd_value: Option<isize>) -> Result<(), String> {
        use windows::Win32::Foundation::*;
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        use windows::Win32::UI::WindowsAndMessaging::*;

        // 无目标窗口：剪贴板已写入但无法投递按键，明确报错而非静默"成功"（修复 M3）
        let hwnd_raw = match hwnd_value {
            Some(h) => h,
            None => {
                return Err("未找到目标窗口，已取消粘贴（内容已复制到剪贴板，可手动 Ctrl+V）".to_string());
            }
        };

        unsafe {
            let hwnd = HWND(hwnd_raw as *mut _);

            if !IsWindow(hwnd).as_bool() {
                return Err("目标窗口已关闭，已取消粘贴（内容已复制到剪贴板，可手动 Ctrl+V）".to_string());
            }

            // 将目标窗口切换到前台（确保按键能送达）
            let was_minimized = IsIconic(hwnd).as_bool();
            if was_minimized {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            // 切换前台窗口并确认生效：Windows 的“前台锁定超时”（foreground lock timeout）
            // 机制可能悄悄拒绝来自后台进程的 SetForegroundWindow 请求（返回 false 但不报错）。
            // 一旦切换被拒绝，Ctrl+V 会被发送到当时真正处于前台的错误窗口——对剪贴板管理器
            // 而言可能泄漏密码等敏感内容。因此这里最多重试 3 次 SetForegroundWindow 并轮询确认，
            // 若始终无法确认切换成功则中止粘贴并报错（修复 C1），绝不冒险发送按键。
            let mut confirmed = false;
            for attempt in 0..3 {
                let ok = SetForegroundWindow(hwnd).as_bool();
                if !ok {
                    log::warn!(
                        "[PasteEngine] SetForegroundWindow 返回失败（第 {} 次尝试），hwnd={:?}",
                        attempt + 1,
                        hwnd_raw
                    );
                }
                // 无论返回值如何，都轮询确认实际前台窗口（返回值不总是可靠）
                for _ in 0..3 {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    if GetForegroundWindow() == hwnd {
                        confirmed = true;
                        break;
                    }
                }
                if confirmed {
                    break;
                }
            }
            if !confirmed {
                log::warn!(
                    "[PasteEngine] 前台窗口切换未能确认成功，hwnd={:?}，中止粘贴以防止内容发送到错误窗口",
                    hwnd_raw
                );
                // 恢复最小化状态，避免窗口停留在被还原的状态
                if was_minimized {
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                }
                return Err("无法切换到目标窗口，已中止粘贴以防止内容粘贴到错误窗口（内容已复制到剪贴板，可手动 Ctrl+V）".to_string());
            }

                // 使用 SendInput 模拟 Ctrl+V 按键（兼容所有应用，包括微信/企业微信等 WebView 应用）
                let mut inputs: [INPUT; 4] = std::mem::zeroed();

                // Ctrl 按下
                inputs[0].r#type = INPUT_KEYBOARD;
                inputs[0].Anonymous.ki.wVk = VIRTUAL_KEY(VK_CONTROL.0 as u16);

                // V 按下
                inputs[1].r#type = INPUT_KEYBOARD;
                inputs[1].Anonymous.ki.wVk = VIRTUAL_KEY(0x56);

                // V 释放
                inputs[2].r#type = INPUT_KEYBOARD;
                inputs[2].Anonymous.ki.wVk = VIRTUAL_KEY(0x56);
                inputs[2].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;

                // Ctrl 释放
                inputs[3].r#type = INPUT_KEYBOARD;
                inputs[3].Anonymous.ki.wVk = VIRTUAL_KEY(VK_CONTROL.0 as u16);
                inputs[3].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;

                SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

                // 如果窗口之前是最小化的，恢复最小化状态。
                // SendInput 只是把按键放入系统输入队列，目标窗口识别 Ctrl+V 并执行粘贴
                // 是异步的；如果窗口刚从最小化恢复，消息循环/激活可能还没完全就绪，
                // 需要多留一点时间，避免立刻重新最小化打断目标窗口的粘贴处理。
                if was_minimized {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                }
        }

        Ok(())
    }
}
