/// 应用图标提取模块
/// 从 Windows 窗口句柄提取进程图标，缓存到本地文件
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// 图标缓存管理器
pub struct IconCache {
    /// 缓存目录：{app_data_dir}/source-icons/
    pub cache_dir: PathBuf,
    /// 进程路径 → 图标文件名的映射（内存缓存，避免重复提取）
    path_to_icon: Mutex<HashMap<String, Option<String>>>,
    /// 图标文件名 → 完整路径的快速查找（从磁盘恢复，支持重启后命中）
    icon_files: Mutex<HashMap<String, PathBuf>>,
}

impl IconCache {
    pub fn new(cache_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&cache_dir);

        // 从磁盘恢复图标文件索引（问题2修复：重启后不需要重新提取）
        let mut icon_files = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "png").unwrap_or(false) {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        // 验证文件是有效 PNG（问题4修复）
                        if Self::is_valid_png(&path) {
                            icon_files.insert(name.to_string(), path);
                        } else {
                            // 清理损坏文件
                            let _ = std::fs::remove_file(&path);
                            log::warn!("[IconCache] 清理损坏图标: {}", path.display());
                        }
                    }
                }
            }
        }
        log::info!("[IconCache] 从磁盘恢复 {} 个图标缓存", icon_files.len());

        Self {
            cache_dir,
            path_to_icon: Mutex::new(HashMap::new()),
            icon_files: Mutex::new(icon_files),
        }
    }

    /// 从窗口句柄提取图标，返回图标文件名（不含路径）
    /// 返回 None 表示无法获取图标
    /// 此方法由 clipboard_monitor 在捕获剪贴板内容时调用（此时前台窗口就是来源窗口）
    #[cfg(target_os = "windows")]
    pub fn extract_icon_by_hwnd(&self, hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
        if hwnd.is_invalid() {
            return None;
        }

        // 通过窗口句柄获取进程路径
        let exe_path = self.get_process_path(hwnd)?;
        let exe_path_str = exe_path.to_string_lossy().to_string();

        // 检查内存缓存
        {
            let cache = self.path_to_icon.lock().ok()?;
            if let Some(icon) = cache.get(&exe_path_str) {
                return icon.clone();
            }
        }

        // 提取图标并保存
        let icon_filename = self.extract_and_save_icon(&exe_path)?;

        let result = Some(icon_filename);

        // 写入内存缓存
        if let Ok(mut cache) = self.path_to_icon.lock() {
            cache.insert(exe_path_str, result.clone());
        }

        result
    }

    /// 根据图标文件名获取完整路径（用于 convertFileSrc）
    /// 先查内存（磁盘恢复时已预加载），再查磁盘
    pub fn get_icon_full_path(&self, filename: &str) -> Option<PathBuf> {
        // 修复 C14：防路径穿越。图标文件名应为纯文件名（hex hash + .png），
        // 拒绝任何含路径分隔符或 ".." 的输入，避免拼出缓存目录之外的路径
        // （此前可被用作任意文件存在性探针，且 is_valid_png 会整文件读入导致 OOM）
        if !Self::is_safe_icon_name(filename) {
            log::warn!("[IconCache] 拒绝非法图标文件名: {:?}", filename);
            return None;
        }
        // 1. 查内存缓存（最快）
        if let Ok(files) = self.icon_files.lock() {
            if let Some(path) = files.get(filename) {
                if path.exists() {
                    return Some(path.clone());
                }
            }
        }
        // 2. 回退到磁盘直接查（兼容旧数据）
        let path = self.cache_dir.join(filename);
        if path.exists() && Self::is_valid_png(&path) {
            return Some(path);
        }
        None
    }

    /// 校验图标文件名是否为安全的纯文件名（无路径分隔符、无 ".."、非空）
    fn is_safe_icon_name(name: &str) -> bool {
        !name.is_empty()
            && !name.contains(['/', '\\', ':'])
            && !name.contains("..")
            && name != "."
    }

    /// 根据 exe 路径 hash 查找图标（回退逻辑：窗口标题 → exe 路径 → hash → 图标）
    /// 用于 source_icon 为空但知道窗口标题的场景
    pub fn get_icon_by_exe_path(&self, exe_path: &PathBuf) -> Option<PathBuf> {
        let hash = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            exe_path.to_string_lossy().hash(&mut hasher);
            format!("{:016x}.png", hasher.finish())
        };
        self.get_icon_full_path(&hash)
    }

    /// 验证文件是否为有效 PNG（检查文件头 8 字节）
    /// 修复 C14：只读前 8 字节，不再整文件读入内存（大文件会导致 OOM）
    fn is_valid_png(path: &PathBuf) -> bool {
        use std::io::Read;
        const PNG_HEADER: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        std::fs::File::open(path)
            .and_then(|mut f| {
                let mut header = [0u8; 8];
                f.read_exact(&mut header).map(|_| header)
            })
            .map(|header| header == PNG_HEADER)
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    pub fn extract_icon_by_hwnd(&self, _hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
        None
    }

    /// 从窗口句柄获取进程可执行文件路径
    #[cfg(target_os = "windows")]
    fn get_process_path(&self, hwnd: windows::Win32::Foundation::HWND) -> Option<PathBuf> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        use windows::core::PWSTR;

        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }

            let handle = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                false,
                pid,
            )
            .ok()?;

            let mut buf = [0u16; 260]; // MAX_PATH
            let mut len = buf.len() as u32;
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            );

            let _ = CloseHandle(handle);

            if result.is_ok() && len > 0 {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                return Some(PathBuf::from(path));
            }

            None
        }
    }

    /// 提取 exe 图标并保存为 PNG 到缓存目录
    #[cfg(target_os = "windows")]
    fn extract_and_save_icon(&self, exe_path: &PathBuf) -> Option<String> {
        use windows::Win32::UI::Shell::{
            SHGetFileInfoW, SHGFI_ICON, SHGFI_LARGEICON, SHFILEINFOW,
        };
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, SelectObject,
            BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, DestroyIcon, ICONINFO};
        use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;

        unsafe {
            let mut sfi = SHFILEINFOW::default();
            let flags = SHGFI_ICON | SHGFI_LARGEICON;

            let exe_wide: Vec<u16> = exe_path
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let result = SHGetFileInfoW(
                windows::core::PCWSTR(exe_wide.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut sfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                flags,
            );

            if result == 0 || sfi.hIcon.is_invalid() {
                log::warn!("[IconExtractor] SHGetFileInfo 失败: {}", exe_path.display());
                return None;
            }

            let hicon = sfi.hIcon;

            // 获取图标信息
            let mut icon_info = ICONINFO::default();
            if GetIconInfo(hicon, &mut icon_info).is_err() {
                let _ = DestroyIcon(hicon);
                return None;
            }

            // 查询图标位图的真实尺寸：SHGFI_LARGEICON 返回的位图边长取决于系统
            // SM_CXICON/SM_CYICON，DPI 缩放（125%/150%/200%）下并非固定 48x48，
            // 硬编码会导致 GetDIBits 读取到错位/损坏的像素数据，这里用 GetObject 读真实尺寸
            let mut bitmap_info = BITMAP::default();
            let bitmap_info_size = std::mem::size_of::<BITMAP>() as i32;
            if GetObjectW(
                icon_info.hbmColor,
                bitmap_info_size,
                Some(&mut bitmap_info as *mut _ as *mut _),
            ) == 0
            {
                log::warn!(
                    "[IconExtractor] GetObject 获取图标位图尺寸失败: {}",
                    exe_path.display()
                );
                if !icon_info.hbmColor.is_invalid() {
                    let _ = DeleteObject(icon_info.hbmColor);
                }
                if !icon_info.hbmMask.is_invalid() {
                    let _ = DeleteObject(icon_info.hbmMask);
                }
                let _ = DestroyIcon(hicon);
                return None;
            }

            let icon_w: i32 = bitmap_info.bmWidth;
            let icon_h: i32 = bitmap_info.bmHeight.abs();

            if icon_w <= 0 || icon_h <= 0 {
                log::warn!(
                    "[IconExtractor] GetObject 返回的图标位图尺寸无效: {}x{}",
                    icon_w,
                    icon_h
                );
                if !icon_info.hbmColor.is_invalid() {
                    let _ = DeleteObject(icon_info.hbmColor);
                }
                if !icon_info.hbmMask.is_invalid() {
                    let _ = DeleteObject(icon_info.hbmMask);
                }
                let _ = DestroyIcon(hicon);
                return None;
            }

            let hdc = CreateCompatibleDC(None);
            if hdc.is_invalid() {
                if !icon_info.hbmColor.is_invalid() {
                    let _ = DeleteObject(icon_info.hbmColor);
                }
                if !icon_info.hbmMask.is_invalid() {
                    let _ = DeleteObject(icon_info.hbmMask);
                }
                let _ = DestroyIcon(hicon);
                return None;
            }

            let old_bmp = SelectObject(hdc, icon_info.hbmColor);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: icon_w,
                    biHeight: -icon_h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0 as u32,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [std::mem::zeroed(); 1],
            };

            let data_size = (icon_w * icon_h * 4) as usize;
            let mut pixels: Vec<u8> = vec![0u8; data_size];

            let rows = GetDIBits(
                hdc,
                icon_info.hbmColor,
                0,
                icon_h as u32,
                Some(pixels.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            // 清理 GDI 资源
            SelectObject(hdc, old_bmp);
            let _ = DeleteDC(hdc);
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask);
            }
            let _ = DestroyIcon(hicon);

            if rows == 0 {
                log::warn!("[IconExtractor] GetDIBits 失败");
                return None;
            }

            // BGRA → RGBA
            for chunk in pixels.chunks_exact_mut(4) {
                chunk.swap(0, 2); // B ↔ R
            }

            // 基于 exe 路径生成唯一文件名
            let hash = {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                exe_path.to_string_lossy().hash(&mut hasher);
                format!("{:016x}.png", hasher.finish())
            };

            let icon_path = self.cache_dir.join(&hash);

            let mut png_data = Vec::new();
            let encoder = PngEncoder::new(&mut png_data);
            if encoder
                .write_image(
                    &pixels,
                    icon_w as u32,
                    icon_h as u32,
                    image::ExtendedColorType::Rgba8,
                )
                .is_err()
            {
                log::warn!("[IconExtractor] PNG 编码失败");
                return None;
            }

            if let Err(e) = std::fs::write(&icon_path, &png_data) {
                log::warn!("[IconExtractor] 写入图标文件失败: {}", e);
                return None;
            }

            log::info!(
                "[IconExtractor] 提取图标成功: {} → {}",
                exe_path.display(),
                icon_path.display()
            );

            // 同步更新 icon_files 索引（问题2修复）
            if let Ok(mut files) = self.icon_files.lock() {
                files.insert(hash.clone(), icon_path.clone());
            }

            Some(hash)
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn extract_and_save_icon(&self, _exe_path: &PathBuf) -> Option<String> {
        None
    }

}
