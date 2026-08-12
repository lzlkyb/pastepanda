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
    app_handle: AppHandle,
    paste_suppress: Arc<PasteSuppress>,
    /// 手动保存的前台窗口句柄 + 时间戳（由 save_foreground_hwnd 设置，优先使用）。
    /// 有效期规则（窗口会话绑定，对齐 Win+V 语义）：
    /// - 本应用任一窗口可见期间（主窗口浏览 / 快捷粘贴面板 / 托盘弹窗），保存值
    ///   永久有效——所有"打开窗口"路径都会先刷新保存，故不会陈旧；
    /// - 全部窗口隐藏后仅在短 TTL 内有效（覆盖连续粘贴/索引粘贴等无窗口热键场景），
    ///   过期自动失效，避免粘贴到早已切换走的旧窗口。
    last_foreground_hwnd: std::sync::Mutex<Option<(isize, std::time::Instant)>>,
    /// 粘贴操作互斥锁：确保同一时间只有一个粘贴在执行，防止竞态
    paste_lock: AtomicBool,
    /// 本进程 ID（启动时缓存，用于过滤自身所有子窗口）
    own_pid: u32,
}

/// 按可执行文件名归类前台应用（v6.2 目标感知粘贴）。
/// 返回 (应用名, 类别)，类别供前端决定粘贴前建议（Excel→表格化等）。
#[cfg(target_os = "windows")]
fn categorize_app(exe: &str) -> (String, String) {
    let label = exe.trim_end_matches(".exe").to_string();
    let cat = if exe.contains("chrome")
        || exe.contains("msedge")
        || exe.contains("firefox")
        || exe.contains("opera")
        || exe.contains("brave")
    {
        "browser"
    } else if exe.contains("excel") {
        "excel"
    } else if exe.contains("winword") {
        "word"
    } else if exe.contains("wps") {
        "office"
    } else if exe.contains("code.exe")
        || exe.contains("devenv")
        || exe.contains("idea")
        || exe.contains("rider")
        || exe.contains("pycharm")
    {
        "ide"
    } else if exe.contains("cmd.exe")
        || exe.contains("powershell")
        || exe.contains("windowsterminal")
        || exe.contains("wt.exe")
        || exe.contains("alacritty")
    {
        "terminal"
    } else {
        "other"
    };
    (label, cat.to_string())
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
    /// 有效期与窗口会话绑定：本应用窗口可见期间永久有效，全部隐藏后短 TTL 过期。
    pub fn save_foreground_hwnd(&self) {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetDesktopWindow, GetForegroundWindow, GetShellWindow,
            };
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_invalid() {
                    return;
                }
                // 排除桌面窗口：用户"显示桌面"（Win+D / 点击桌面空白）时前台是桌面，
                // 若保存它，粘贴会把按键发给桌面导致内容丢失
                if hwnd == GetDesktopWindow() || hwnd == GetShellWindow() {
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

    /// 识别前台应用的名称与类别（v6.2 目标感知粘贴）。
    /// 优先用手动保存的句柄（用户从主窗/托盘点粘贴前保存的那个），
    /// 其次实时抓当前前台窗口。返回 (应用名, 类别)。
    #[cfg(target_os = "windows")]
    pub fn foreground_app(&self) -> Option<(String, String)> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

        let hwnd = {
            let guard = self.last_foreground_hwnd.lock().ok()?;
            guard.map(|(h, _)| h)
        }
        .or_else(|| self.capture_foreground_now())?;

        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(
                windows::Win32::Foundation::HWND(hwnd as *mut _),
                Some(&mut pid),
            );
            if pid == 0 {
                return None;
            }
            let Ok(proc) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return None;
            };
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                proc,
                windows::Win32::System::Threading::PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(proc);
            if ok.is_err() {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let exe = path.rsplit('\\').next().unwrap_or("").to_ascii_lowercase();
            Some(categorize_app(&exe))
        }
    }
    #[cfg(not(target_os = "windows"))]
    pub fn foreground_app(&self) -> Option<(String, String)> {
        None
    }

    /// 全部窗口隐藏后，保存的前台窗口的兜底有效期（秒）。
    /// 仅覆盖无窗口的热键粘贴场景（连续粘贴/索引粘贴/栈粘贴——热键回调会先
    /// save_foreground_hwnd 再立即粘贴，实际耗时远小于此值）。
    const FOREGROUND_TTL_SECS: u64 = 5;

    /// 确认目标窗口前台后、发送 Ctrl+V 前的就绪延时（毫秒）。
    /// 目标窗口刚切到前台时，其消息循环/焦点控件可能尚未就绪，立刻 SendInput
    /// 按键虽能成功入队却会被目标丢弃（"提示已粘贴却没内容"的关键诱因）。
    /// 对齐 Ditto 的 SendKeys 前置延时实践，给目标应用留出就绪时间。
    const PRE_PASTE_DELAY_MS: u64 = 40;

    /// 本应用当前是否有任一窗口可见（主窗口 / 快捷粘贴面板 / 托盘弹窗 / 编辑器等）
    fn any_own_window_visible(&self) -> bool {
        use tauri::Manager;
        self.app_handle
            .webview_windows()
            .values()
            .any(|w| w.is_visible().unwrap_or(false))
    }

    /// 获取最佳目标窗口句柄：手动保存（窗口会话绑定）> 实时抓取（粘贴前一刻）> None
    ///
    /// 手动保存值的有效期与"窗口会话"绑定（对齐 Win+V 语义）：
    /// - 本应用任一窗口可见 → 永久有效（用户正在浏览历史，目标就是唤出前的窗口）；
    /// - 全部窗口隐藏 → 仅在 FOREGROUND_TTL_SECS 内有效（防陈旧误粘）。
    /// 传入的 fallback 是 execute_paste 在粘贴前实时抓取的结果，比轮询更可靠。
    fn get_target_hwnd(&self, fallback: Option<isize>) -> Option<isize> {
        if let Ok(manual) = self.last_foreground_hwnd.lock() {
            if let Some((hwnd, timestamp)) = *manual {
                let window_open = self.any_own_window_visible();
                let fresh = timestamp.elapsed().as_secs() < Self::FOREGROUND_TTL_SECS;
                if window_open || fresh {
                    return Some(hwnd);
                }
                // 窗口全隐藏且已过期：不使用陈旧值，落入下方回退
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
        //    依赖窗口会话绑定机制（窗口可见期间永久有效 + 隐藏后短 TTL 过期），
        //    确保 sequential paste 循环中的多次粘贴都能使用热键触发时保存的目标窗口。

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

    /// 仅复制图片到剪贴板（不粘贴）— 走 arboard，绕开 WebView2 Web Clipboard API 兼容问题
    pub fn copy_image_only(&self, image_path: &str) -> Result<(), String> {
        crate::commands::check_image_decode_limits(std::path::Path::new(image_path))?;
        let img = image::open(image_path).map_err(|e| format!("无法解码图片: {}", e))?;
        let rgba = img.to_rgba8();
        let (width, height) = rgba.dimensions();
        // hash 口径与监听线程一致：对 RGBA 像素字节计算
        let content_hash = format!("{:x}", md5::Md5::new().chain_update(rgba.as_raw()).finalize());

        // 设置粘贴抑制（hash），防止剪贴板监听器重复记录
        self.paste_suppress
            .set_with_hash(Duration::from_millis(3000), content_hash);

        let img_data = ImageData {
            width: width as usize,
            height: height as usize,
            bytes: std::borrow::Cow::Borrowed(rgba.as_raw()),
        };
        let mut clipboard = Clipboard::new().map_err(|e| format!("无法打开剪贴板: {}", e))?;
        clipboard
            .set_image(img_data)
            .map_err(|e| format!("无法写入图片到剪贴板: {}", e))?;
        Ok(())
    }

    /// 复制文件到剪贴板（CF_HDROP，等同于资源管理器 Ctrl+C）
    #[cfg(target_os = "windows")]
    pub fn copy_files(&self, paths: &[String]) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::{BOOL, GlobalFree, HANDLE, POINT};
        use windows::Win32::System::DataExchange::*;
        use windows::Win32::System::Memory::*;

        if paths.is_empty() {
            return Err("文件列表为空".to_string());
        }

        // 设置时间窗口抑制，防止监听器把这次写入当成新内容记录
        self.paste_suppress.set(Duration::from_millis(3000));

        // 构建双 null 结尾的宽字符文件列表
        let mut data: Vec<u16> = Vec::new();
        for p in paths {
            let wide: Vec<u16> = std::path::Path::new(p)
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            data.extend_from_slice(&wide);
        }
        data.push(0); // 列表结尾的第二个 null

        // DROPFILES 头（p_files 指向文件列表偏移，f_wide = 1 表示宽字符）
        #[repr(C)]
        struct DropFiles {
            p_files: u32,
            pt: POINT,
            f_nc: BOOL,
            f_wide: BOOL,
        }
        let header_size = std::mem::size_of::<DropFiles>();
        let total_size = header_size + data.len() * 2;

        unsafe {
            OpenClipboard(None).map_err(|e| format!("无法打开剪贴板: {}", e))?;
            let _ = EmptyClipboard();

            let hmem = match GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size) {
                Ok(h) => h,
                Err(e) => {
                    let _ = CloseClipboard();
                    return Err(format!("GlobalAlloc 失败: {}", e));
                }
            };

            let ptr = GlobalLock(hmem);
            if ptr.is_null() {
                let _ = GlobalFree(hmem);
                let _ = CloseClipboard();
                return Err("GlobalLock 失败".to_string());
            }

            // 写入 DROPFILES 头
            let df = ptr as *mut DropFiles;
            (*df).p_files = header_size as u32;
            (*df).pt = POINT { x: 0, y: 0 };
            (*df).f_nc = BOOL(0);
            (*df).f_wide = BOOL(1);

            // 写入文件列表
            let dst = (ptr as *mut u8).add(header_size) as *mut u16;
            std::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());

            let _ = GlobalUnlock(hmem);

            const CF_HDROP: u32 = 15;
            if let Err(e) = SetClipboardData(CF_HDROP, HANDLE(hmem.0)) {
                let _ = GlobalFree(hmem);
                let _ = CloseClipboard();
                return Err(format!("SetClipboardData(CF_HDROP) 失败: {}", e));
            }

            let _ = CloseClipboard();
        }
        Ok(())
    }

    /// 将图文混排内容一次性写入剪贴板（CF_HTML 富文本 + CF_UNICODETEXT 纯文本保底），不触发粘贴。
    /// 必须用原始 Win32（同 copy_files() 的模式），因为 arboard 的 set_text/set_image
    /// 每次都会独立开关剪贴板，无法在同一个会话里同时装两种格式。
    /// 图片以 <img src="file:///..."> 本地路径引用内嵌在 HTML 里；目标应用是否认这种引用
    /// 取决于对方，纯文本保底至少保证能粘出文字。
    #[cfg(target_os = "windows")]
    fn write_rich_to_clipboard(html_fragment: &str, plain_text: &str) -> Result<(), String> {
        use windows::core::w;
        use windows::Win32::Foundation::{GlobalFree, HANDLE};
        use windows::Win32::System::DataExchange::*;
        use windows::Win32::System::Memory::*;

        let cf_html_bytes = crate::clipboard_monitor::build_cf_html_buffer(html_fragment);
        let mut text_wide: Vec<u16> = plain_text.encode_utf16().collect();
        text_wide.push(0); // CF_UNICODETEXT 需要字结尾 null

        unsafe {
            OpenClipboard(None).map_err(|e| format!("无法打开剪贴板: {}", e))?;
            let _ = EmptyClipboard();

            // -- 写 CF_UNICODETEXT --
            let text_byte_len = text_wide.len() * std::mem::size_of::<u16>();
            let text_hmem = match GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, text_byte_len) {
                Ok(h) => h,
                Err(e) => {
                    let _ = CloseClipboard();
                    return Err(format!("GlobalAlloc(文本) 失败: {}", e));
                }
            };
            let text_ptr = GlobalLock(text_hmem);
            if text_ptr.is_null() {
                let _ = GlobalFree(text_hmem);
                let _ = CloseClipboard();
                return Err("GlobalLock(文本) 失败".to_string());
            }
            std::ptr::copy_nonoverlapping(text_wide.as_ptr(), text_ptr as *mut u16, text_wide.len());
            let _ = GlobalUnlock(text_hmem);

            const CF_UNICODETEXT: u32 = 13;
            if let Err(e) = SetClipboardData(CF_UNICODETEXT, HANDLE(text_hmem.0)) {
                let _ = GlobalFree(text_hmem);
                let _ = CloseClipboard();
                return Err(format!("SetClipboardData(文本) 失败: {}", e));
            }

            // -- 写 CF_HTML --
            let format_id = RegisterClipboardFormatW(w!("HTML Format"));
            let html_hmem = match GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, cf_html_bytes.len()) {
                Ok(h) => h,
                Err(e) => {
                    let _ = CloseClipboard();
                    return Err(format!("GlobalAlloc(HTML) 失败: {}", e));
                }
            };
            let html_ptr = GlobalLock(html_hmem);
            if html_ptr.is_null() {
                let _ = GlobalFree(html_hmem);
                let _ = CloseClipboard();
                return Err("GlobalLock(HTML) 失败".to_string());
            }
            std::ptr::copy_nonoverlapping(cf_html_bytes.as_ptr(), html_ptr as *mut u8, cf_html_bytes.len());
            let _ = GlobalUnlock(html_hmem);

            if let Err(e) = SetClipboardData(format_id, HANDLE(html_hmem.0)) {
                let _ = GlobalFree(html_hmem);
                let _ = CloseClipboard();
                return Err(format!("SetClipboardData(HTML) 失败: {}", e));
            }

            let _ = CloseClipboard();
        }
        Ok(())
    }

    /// 仅复制图文混排内容到剪贴板（不粘贴）
    #[cfg(target_os = "windows")]
    pub fn copy_rich_only(&self, html_fragment: &str, plain_text: &str) -> Result<(), String> {
        let content_hash = format!("{:x}", md5::Md5::new().chain_update(html_fragment.as_bytes()).finalize());
        self.paste_suppress
            .set_with_hash(Duration::from_millis(3000), content_hash);
        Self::write_rich_to_clipboard(html_fragment, plain_text)
    }

    /// 粘贴图文混排内容：写入剪贴板（CF_HTML + 纯文本保底）→ 发送 WM_PASTE
    #[cfg(target_os = "windows")]
    pub fn execute_paste_rich(&self, html_fragment: &str, plain_text: &str) -> Result<(), String> {
        // 1. 获取粘贴锁，防止竞态
        if self.paste_lock.swap(true, Ordering::Acquire) {
            log::warn!("[PasteEngine] 上一个粘贴操作仍在进行中，跳过本次图文混排粘贴");
            return Err("上一个粘贴操作仍在进行中，请稍后再试".to_string());
        }
        struct LockGuard<'a>(&'a AtomicBool);
        impl<'a> Drop for LockGuard<'a> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = LockGuard(&self.paste_lock);

        // 2. 粘贴抑制（hash 口径需与采集时一致：md5(片段字节)，采集时也是这样算的）
        let content_hash = format!("{:x}", md5::Md5::new().chain_update(html_fragment.as_bytes()).finalize());
        self.paste_suppress
            .set_with_hash(Duration::from_millis(3000), content_hash);

        // 3. 写入剪贴板
        Self::write_rich_to_clipboard(html_fragment, plain_text)?;

        // 4. 粘贴前实时重抓前台窗口 + 发送 Ctrl+V（与 execute_paste_image 一致）
        let now_hwnd = self.capture_foreground_now();
        let target_hwnd = self.get_target_hwnd(now_hwnd);
        self.restore_and_send_ctrl_v(target_hwnd)?;

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

        // 5. 不在此处清除 last_foreground_hwnd（依赖窗口会话绑定 + 短 TTL 过期）

        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn restore_and_send_ctrl_v(&self, hwnd_value: Option<isize>) -> Result<(), String> {
        use windows::Win32::Foundation::*;
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
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

            // === 激活目标窗口（对齐 Ditto 的成熟配方）===
            // 旧实现仅"重试 3 次 SetForegroundWindow + 固定 3×10ms 轮询"，且确认前台后
            // 立刻发送按键。问题有二：① Windows 的"前台锁定超时"会悄悄拒绝后台进程的
            //   SetForegroundWindow（返回 false 但不报错），导致激活不扎实；② 目标窗口
            //   刚切到前台时消息循环/焦点控件尚未就绪，立刻 SendInput 的按键虽成功入队
            //   却会被目标丢弃——表现就是"提示已粘贴却没内容"。下面按 Ditto 的做法修复。
            let was_minimized = IsIconic(hwnd).as_bool();
            if was_minimized {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }

            // 1) 临时关闭"前台锁定超时"：置 0 让 SetForegroundWindow 稳定成功，结束后恢复原值。
            let mut lock_timeout: u32 = 0;
            let got_timeout = SystemParametersInfoW(
                SPI_GETFOREGROUNDLOCKTIMEOUT,
                0,
                Some(&mut lock_timeout as *mut u32 as *mut core::ffi::c_void),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .is_ok();
            let _ = SystemParametersInfoW(
                SPI_SETFOREGROUNDLOCKTIMEOUT,
                0,
                None,
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            );

            // 2) 把本线程输入队列挂到"当前前台窗口"所在线程，获得设置前台的权限。
            let cur_tid = GetCurrentThreadId();
            let fore_tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let attached_fore = fore_tid != 0
                && fore_tid != cur_tid
                && AttachThreadInput(cur_tid, fore_tid, true).as_bool();

            // 3) 循环激活并确认前台（替代固定 3×10ms 轮询）：每轮 BringWindowToTop +
            //    SetForegroundWindow，再短轮询确认；未确认则重试，直到成功或超时。
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            let mut confirmed = false;
            while std::time::Instant::now() < deadline {
                let _ = BringWindowToTop(hwnd);
                let ok = SetForegroundWindow(hwnd).as_bool();
                if !ok {
                    log::warn!(
                        "[PasteEngine] SetForegroundWindow 返回失败，hwnd={:?}（继续轮询确认）",
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

            // 4) 无论成功与否，都恢复前台锁定超时 & 解除线程输入挂接。
            if got_timeout {
                let _ = SystemParametersInfoW(
                    SPI_SETFOREGROUNDLOCKTIMEOUT,
                    0,
                    Some(lock_timeout as usize as *mut core::ffi::c_void),
                    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                );
            }
            if attached_fore {
                let _ = AttachThreadInput(cur_tid, fore_tid, false);
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

            // 5) 发送前就绪延时：等目标应用的消息循环/焦点控件就绪，避免按键被丢弃。
            std::thread::sleep(std::time::Duration::from_millis(Self::PRE_PASTE_DELAY_MS));

                // 使用 SendInput 模拟 Ctrl+V 按键（兼容所有应用，包括微信/企业微信等 WebView 应用）
                //
                // 连按优化：若用户物理按住 Ctrl（"按住 Ctrl 连点粘贴热键"场景），
                // 只注入 V 按下/释放——物理 Ctrl + 合成 V 在目标应用中即为 Ctrl+V。
                // 若此时注入合成"Ctrl 释放"，系统会认为 Ctrl 已松开，而长按的 Ctrl
                // 不会再产生新的按下事件，导致下次点按热键时修饰键不匹配、热键失效
                // （用户被迫松开 Ctrl 重新按）。未按住时合成完整按下/释放。
                //
                // 额外修饰键处理：热键含 Alt/Shift/Win（如默认 Ctrl+Alt+Q）时，用户
                // 按住它们连点，物理修饰键残留按下会让目标应用收到 Ctrl+Alt+V 而非
                // Ctrl+V（部分应用中是"粘贴为纯文本"）。故注入 V 前先合成释放这些
                // 修饰键，V 后再合成按回——恢复逻辑状态，下次热键匹配不受影响。
                let ctrl_held = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16) & 0x8000 != 0;
                let extra_keys = [VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN];
                let extra_held = [
                    (GetAsyncKeyState(VK_MENU.0 as i32) as u16) & 0x8000 != 0,   // Alt
                    (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16) & 0x8000 != 0,  // Shift
                    (GetAsyncKeyState(VK_LWIN.0 as i32) as u16) & 0x8000 != 0,   // 左 Win
                    (GetAsyncKeyState(VK_RWIN.0 as i32) as u16) & 0x8000 != 0,   // 右 Win
                ];

                // 最多 12 事件：4(释放额外修饰键) + Ctrl↓ + V↓ + V↑ + Ctrl↑ + 4(按回额外修饰键)
                let mut inputs: [INPUT; 12] = std::mem::zeroed();
                let mut n = 0usize;

                // 1. 先释放物理按住的额外修饰键（Alt/Shift/Win）
                for i in 0..4 {
                    if extra_held[i] {
                        inputs[n].r#type = INPUT_KEYBOARD;
                        inputs[n].Anonymous.ki.wVk = extra_keys[i];
                        inputs[n].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
                        n += 1;
                    }
                }

                // 2. Ctrl 按下（仅当未物理按住）
                if !ctrl_held {
                    inputs[n].r#type = INPUT_KEYBOARD;
                    inputs[n].Anonymous.ki.wVk = VIRTUAL_KEY(VK_CONTROL.0 as u16);
                    n += 1;
                }

                // 3. V 按下 / V 释放
                inputs[n].r#type = INPUT_KEYBOARD;
                inputs[n].Anonymous.ki.wVk = VIRTUAL_KEY(0x56);
                n += 1;
                inputs[n].r#type = INPUT_KEYBOARD;
                inputs[n].Anonymous.ki.wVk = VIRTUAL_KEY(0x56);
                inputs[n].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
                n += 1;

                // 4. Ctrl 释放（仅当未物理按住）
                if !ctrl_held {
                    inputs[n].r#type = INPUT_KEYBOARD;
                    inputs[n].Anonymous.ki.wVk = VIRTUAL_KEY(VK_CONTROL.0 as u16);
                    inputs[n].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
                    n += 1;
                }

                // 5. 按回额外修饰键（恢复逻辑状态，保证热键可连按）
                for i in 0..4 {
                    if extra_held[i] {
                        inputs[n].r#type = INPUT_KEYBOARD;
                        inputs[n].Anonymous.ki.wVk = extra_keys[i];
                        n += 1;
                    }
                }

                let sent = SendInput(&inputs[..n], std::mem::size_of::<INPUT>() as i32);

                // SendInput 返回实际成功注入的事件数。与请求数 n 不符，说明部分/全部
                // 按键被系统拦截——最典型的是 UIPI：目标应用以管理员身份运行而本进程为
                // 普通权限时，跨完整性级别的合成键盘输入会被静默丢弃。此时绝不能报成功
                // （这正是"提示已粘贴却没内容"的根因），降级走 WM_PASTE 直投兜底。
                if sent != n as u32 {
                    log::warn!(
                        "[PasteEngine] SendInput 仅注入 {}/{} 个事件（疑似 UIPI 拦截），降级 WM_PASTE，hwnd={:?}",
                        sent, n, hwnd_raw
                    );
                    if !self.post_wm_paste(hwnd) {
                        // 兜底也失败：恢复最小化状态后返回明确错误，不再谎报成功
                        if was_minimized {
                            let _ = ShowWindow(hwnd, SW_MINIMIZE);
                        }
                        return Err("无法向目标窗口投递粘贴（目标应用可能以管理员身份运行，权限高于本应用）。内容已复制到剪贴板，可手动 Ctrl+V".to_string());
                    }
                }

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

    /// WM_PASTE 兜底投递：当 SendInput 被 UIPI 等机制拦截（返回注入数不符）时，
    /// 尝试直接向目标窗口投递 WM_PASTE。先用 AttachThreadInput 把本线程输入队列
    /// 挂到目标窗口线程，GetFocus 即可取到目标线程当前的焦点控件（真正接收文本的
    /// Edit/富文本控件），把 WM_PASTE 投给它；取不到焦点控件则退回顶层窗口。
    /// 注意：对完整性级别高于本进程的目标，WM_PASTE 同样会被 UIPI 消息过滤拦截，
    /// 此时返回 false，由调用方报明确错误而非谎报成功。
    #[cfg(target_os = "windows")]
    fn post_wm_paste(&self, hwnd: windows::Win32::Foundation::HWND) -> bool {
        use windows::Win32::Foundation::*;
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
        use windows::Win32::UI::WindowsAndMessaging::*;
        unsafe {
            let target_tid = GetWindowThreadProcessId(hwnd, None);
            let cur_tid = GetCurrentThreadId();
            let attached = target_tid != 0
                && target_tid != cur_tid
                && AttachThreadInput(cur_tid, target_tid, true).as_bool();
            // 共享输入队列后 GetFocus 返回目标线程的焦点控件；为空则退回顶层窗口
            let focus = GetFocus();
            let target = if focus.0.is_null() { hwnd } else { focus };
            let ok = PostMessageW(target, WM_PASTE, WPARAM(0), LPARAM(0)).is_ok();
            if attached {
                let _ = AttachThreadInput(cur_tid, target_tid, false);
            }
            ok
        }
    }
}

#[cfg(test)]
#[cfg(target_os = "windows")]
mod tests {
    use super::*;

    /// 真实剪贴板往返：写入 write_rich_to_clipboard 后直接读真实剪贴板，验证 CF_UNICODETEXT
    /// 和 CF_HTML 两个格式同时写入成功且内容正确（不需要构造 PasteEngine 实例，因为
    /// write_rich_to_clipboard 是不带 self 的关联函数）。
    ///
    /// **为什么标 `#[ignore]`（2026-08-11）**：它写的是**真实系统剪贴板**。
    /// 只要开发机上 PastePanda 正在运行，它的剪贴板监听就会把下面这个测试片段
    /// 当成一条图文内容记录进历史——用户实测到的现象是“图文类型每隔一段时间就
    /// 自己多出一模一样的一条，而且一直是这一条”，实际上每跑一次 `cargo test` 就污染一次
    /// （历史里曾因此积了 20 条，同一个 md5）。
    ///
    /// “测完再恢复原内容”救不了：监听端已经看到中间态了。所以只能不自动跑。
    ///
    /// CF_HTML 的构造/解析往返已有**纯内存**单测覆盖
    /// （`clipboard_monitor.rs` 的 `test_parse_cf_html_fragment_byte_offset_with_chinese`），
    /// 日常回归不缺这一条；本测试验的是 Win32 写入路径，改动那部分代码时手动跑：
    ///   `cargo test -- --ignored test_write_rich_to_clipboard_round_trip`
    /// 跑之前先退出 PastePanda，否则依旧会往历史里多一条。
    #[test]
    #[ignore = "写真实系统剪贴板：会被正在运行的 PastePanda 采集成一条历史（见上方注释）"]
    fn test_write_rich_to_clipboard_round_trip() {
        use windows::core::w;
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::DataExchange::*;
        use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

        let fragment = "这是中文段落，包含<img src=\"file:///C:/temp/图片.png\">和后续文字。";
        let plain = "这是中文段落，图片和后续文字。";

        PasteEngine::write_rich_to_clipboard(fragment, plain).expect("写入剪贴板应成功");

        unsafe {
            OpenClipboard(None).expect("打开剪贴板失败");

            // -- 读 CF_UNICODETEXT --
            const CF_UNICODETEXT: u32 = 13;
            let text_handle = GetClipboardData(CF_UNICODETEXT).expect("读取 CF_UNICODETEXT 失败");
            let text_hmem = HGLOBAL(text_handle.0);
            let text_ptr = GlobalLock(text_hmem) as *const u16;
            let mut len = 0usize;
            while *text_ptr.add(len) != 0 {
                len += 1;
            }
            let read_text = String::from_utf16_lossy(std::slice::from_raw_parts(text_ptr, len));
            let _ = GlobalUnlock(text_hmem);
            assert_eq!(read_text, plain, "读回的 CF_UNICODETEXT 应与写入的纯文本一致");

            // -- 读 CF_HTML --
            let format_id = RegisterClipboardFormatW(w!("HTML Format"));
            let html_handle = GetClipboardData(format_id).expect("读取 HTML Format 失败");
            let html_hmem = HGLOBAL(html_handle.0);
            let size = GlobalSize(html_hmem);
            let html_ptr = GlobalLock(html_hmem) as *const u8;
            let raw = std::slice::from_raw_parts(html_ptr, size).to_vec();
            let _ = GlobalUnlock(html_hmem);

            let _ = CloseClipboard();

            let parsed = crate::clipboard_monitor::parse_cf_html_fragment(&raw)
                .expect("应能从写回的 CF_HTML 里解析出片段");
            assert_eq!(parsed, fragment, "解析出的片段应与写入前的完全一致（回写侧与采集侧共用同一套 CF_HTML 构造/解析逻辑）");
        }
    }
}
