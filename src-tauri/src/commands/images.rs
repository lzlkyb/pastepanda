use super::{
    check_image_decode_limits, get_mime_from_path, get_thumb_dir, validate_image_file_path,
    ALLOWED_IMAGE_EXTENSIONS,
};
use crate::data_store::DataStore;
use tauri::State;

/// 读取文件内容并返回 base64 编码（用于图片粘贴并变换）
#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    // 修复 C15：与 get_image_data_url 一致的 20MB 上限，防止合法扩展名的超大文件导致 OOM
    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "图片文件过大 ({}MB)，超过 20MB 限制",
            metadata.len() / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

/// 将富文本编辑器里新插入/粘贴的图片存入应用图片库，返回落盘路径。
/// 命名与采集侧完全一致（按内容 md5 + 真实格式扩展名），这样同一张图无论是采集进来的
/// 还是编辑时插入的，都落在同一个文件上，删除时的引用计数清理才能正确工作。
#[tauri::command]
pub fn save_rich_image(
    app_handle: tauri::AppHandle,
    data_base64: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use md5::{Digest, Md5};
    use tauri::Manager;

    // 与 read_file_as_base64 / get_image_data_url 同口径的 20MB 上限
    const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

    // 兼容前端直接丢过来的完整 data URI（data:image/png;base64,xxxx）
    let payload = match data_base64.find(",") {
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
            "图片过大 ({}MB)，超过 20MB 限制",
            bytes.len() / 1024 / 1024
        ));
    }

    // 按真实内容推断格式，而不是相信前端传的 MIME（假扩展名会让后续读图失败）；
    // 同时这也拦住了“把非图片文件伪装成图片存进来”的情况。
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
    let images_dir = app_dir.join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| format!("创建图片目录失败: {e}"))?;

    let hash = format!("{:x}", Md5::new().chain_update(&bytes).finalize());
    let file_path = images_dir.join(format!("{}.{}", hash, ext));
    if !file_path.exists() {
        // 先写临时文件再原子 rename，防止写一半崩溃留下残缺图片（同 process_image 的做法）
        let tmp_path = file_path.with_extension(format!("{}.tmp", ext));
        std::fs::write(&tmp_path, &bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        if let Err(e) = std::fs::rename(&tmp_path, &file_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("重命名临时图片失败: {e}"));
        }
    }
    Ok(file_path.to_string_lossy().to_string())
}

/// 读取图片文件并返回 base64 data URL（原图，用于预览）
#[tauri::command]
pub fn get_image_data_url(path: String) -> Result<String, String> {
    use std::io::Read;

    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "图片文件过大 ({}MB)，超过 20MB 限制",
            metadata.len() / 1024 / 1024
        ));
    }

    let mut file = std::fs::File::open(&canonical).map_err(|e| e.to_string())?;
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    let base64_str = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &buffer);
    let mime = get_mime_from_path(&path);
    Ok(format!("data:{};base64,{}", mime, base64_str))
}

/// 生成图片缩略图并写入应用数据目录，返回文件路径（最大宽度 300px，用于卡片列表）
/// 使用文件路径而非 base64 data URL，浏览器可原生缓存图片
#[tauri::command]
pub fn get_image_thumbnail(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::io::BufWriter;
    use std::io::Write;

    const MAX_WIDTH: u32 = 300;
    const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;

    // 修复 C16：与其他图片命令一致的严格路径校验（canonicalize + 白名单）
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!("图片文件过大 ({}MB)", metadata.len() / 1024 / 1024));
    }

    // 修复 C18：仅读头部校验尺寸，防止解压炸弹
    let (w, h) = check_image_decode_limits(&canonical)?;

    // 用源路径 + 修改时间生成缩略图文件名（内容变化自动重建）
    let mut hasher = DefaultHasher::new();
    canonical.to_string_lossy().hash(&mut hasher);
    let modified = metadata
        .modified()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        })
        .unwrap_or(0);
    modified.hash(&mut hasher);
    let hash = hasher.finish();
    let thumb_name = format!("thumb_{:016x}.jpg", hash);

    let thumb_dir = get_thumb_dir(&app_handle)?;
    let thumb_path = thumb_dir.join(&thumb_name);

    // 如果缩略图已存在且源文件未变化，直接返回路径
    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let img = image::open(&canonical).map_err(|e| format!("无法打开图片: {}", e))?;

    // 如果原图宽度 ≤ 300px，直接复制（转为 JPEG 减小体积）
    let output_img = if w <= MAX_WIDTH {
        img
    } else {
        let ratio = MAX_WIDTH as f64 / w as f64;
        let new_h = ((h as f64 * ratio) as u32).max(1);
        img.resize_exact(MAX_WIDTH, new_h, image::imageops::FilterType::Lanczos3)
    };

    // 写入 JPEG 格式（比 PNG 小 3-5 倍，适合照片类图片）
    let file =
        std::fs::File::create(&thumb_path).map_err(|e| format!("无法创建缩略图文件: {}", e))?;
    let mut writer = BufWriter::new(file);
    output_img
        .write_to(&mut writer, image::ImageFormat::Jpeg)
        .map_err(|e| format!("无法写入缩略图: {}", e))?;
    writer.flush().map_err(|e| e.to_string())?;

    Ok(thumb_path.to_string_lossy().to_string())
}

/// 获取图片信息（尺寸、文件大小）
#[tauri::command]
pub fn get_image_info(path: String) -> Result<serde_json::Value, String> {
    // 修复 C16/C18 同类问题：统一路径校验 + 仅读头部获取尺寸（无需完整解码，防解压炸弹）
    let canonical = validate_image_file_path(&path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息: {}", e))?;
    let file_size = metadata.len();

    let (width, height) = check_image_decode_limits(&canonical)?;

    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未知");

    let size_str = if file_size >= 1024 * 1024 {
        format!("{:.1} MB", file_size as f64 / 1024.0 / 1024.0)
    } else if file_size >= 1024 {
        format!("{:.1} KB", file_size as f64 / 1024.0)
    } else {
        format!("{} B", file_size)
    };

    Ok(serde_json::json!({
        "width": width,
        "height": height,
        "file_size": file_size,
        "size_str": size_str,
        "file_name": file_name,
        "path": path,
    }))
}

/// 保存图片目标路径的敏感目录黑名单（防御性层：拒绝写入到开机启动项、系统目录等敏感位置）
fn sensitive_dest_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(
            std::path::PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
        );
    }
    if let Ok(windir) = std::env::var("WINDIR").or_else(|_| std::env::var("SystemRoot")) {
        dirs.push(std::path::PathBuf::from(windir).join("System32"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        dirs.push(std::path::PathBuf::from(pf));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        dirs.push(std::path::PathBuf::from(pf86));
    }

    dirs
}

/// 保存图片文件（直接复制源文件到目标路径）
/// 安全约束：
/// - source 必须是已存在的图片文件（扩展名在白名单内），防止读取任意文件内容；
/// - dest 的文件扩展名也必须在图片白名单内，拒绝 .exe/.bat/.lnk 等可执行/快捷方式扩展名；
/// - dest 所在目录不得落在敏感目录（开机启动目录、System32、Program Files 等）内。
/// 目标路径本身允许是用户通过系统"另存为"对话框选择的任意正常位置——该对话框已构成
/// "写到哪里"的用户同意边界，这里只约束"写入的是什么"，避免任意文件读取后写出的攻击链。
#[tauri::command]
pub fn save_image_file(source: String, dest: String) -> Result<(), String> {
    let source_canonical = validate_image_file_path(&source)?;

    let dest_path = std::path::Path::new(&dest);

    let dest_ext = dest_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_IMAGE_EXTENSIONS.contains(&dest_ext.as_str()) {
        return Err(format!(
            "不支持的目标文件类型: .{dest_ext}，仅允许保存为图片文件 ({})",
            ALLOWED_IMAGE_EXTENSIONS.join(", ")
        ));
    }

    let dest_parent = dest_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "目标路径无效".to_string())?;
    let dest_file_name = dest_path
        .file_name()
        .ok_or_else(|| "目标路径缺少文件名".to_string())?;

    // 目标所在目录必须已存在（不基于用户输入创建任意目录，避免路径穿越产生的副作用）
    let dest_parent_canonical =
        std::fs::canonicalize(dest_parent).map_err(|_| "目标目录不存在或无效".to_string())?;

    // 防御性层：拒绝写入到系统/开机等敏感目录，降低"写图片到启动项进行骚扰性持久化"的风险
    for sensitive in sensitive_dest_dirs() {
        if let Ok(sensitive_canonical) = std::fs::canonicalize(&sensitive) {
            if dest_parent_canonical.starts_with(&sensitive_canonical) {
                return Err(format!(
                    "出于安全考虑，不允许保存到该目录: {}",
                    sensitive.display()
                ));
            }
        }
    }

    let dest_final = dest_parent_canonical.join(dest_file_name);
    std::fs::copy(&source_canonical, &dest_final).map_err(|e| format!("保存图片失败: {}", e))?;
    Ok(())
}

// ===== OCR 图片文字识别 =====

/// OCR 识别结果 — 每个词的信息
#[derive(serde::Serialize, Clone)]
pub struct OcrWordInfo {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// OCR 识别结果 — 按行分组
#[derive(serde::Serialize, Clone)]
pub struct OcrLineInfo {
    pub text: String,
    pub words: Vec<OcrWordInfo>,
}

/// OCR 识别结果
#[derive(serde::Serialize, Clone)]
pub struct OcrResult {
    pub lines: Vec<OcrLineInfo>,
    pub full_text: String,
}

/// 对图片文件执行 OCR 文字识别（Windows OCR 引擎）
/// 使用 async + spawn_blocking 避免阻塞主线程导致 UI 卡死
#[tauri::command]
pub async fn ocr_image(store: State<'_, DataStore>, path: String) -> Result<OcrResult, String> {
    let path_inner = path.clone();
    let result = tokio::task::spawn_blocking(move || ocr_image_impl(&path_inner))
        .await
        .map_err(|e| format!("OCR 任务失败: {}", e))??;
    // 识别成功后顺手写缓存：**key 必须是原始 path（与 history.content 同源字符串）**，
    // 不能拿 canonicalize 结果当 key——Windows 上它带 `\\?\` 前缀，而历史回填查询
    // 用的是 content 原值，两端对不上就永远查不到（实测 bug）。
    // 写缓存失败只跳过，不影响识别结果本身。
    if let Err(e) = store.set_ocr_text(&path, &result.full_text) {
        log::warn!("[OCR] 缓存写入失败 ({}): {}", path, e);
    }
    Ok(result)
}

/// 带持久化缓存的 OCR：只返回识别全文（主窗口卡片标题用）。
///
/// 与 `ocr_image` 的区别：
/// - 查库优先——命中（含「识别过但无文字」的空串命中）直接返回，零识别开销；
/// - 只返回 `full_text`，不返回词坐标框（框选功能继续用 `ocr_image`）；
/// - 识别前做**图像预处理**（小图放大）提升 Windows OCR 准确率——纯文本消费
///   不需要坐标，预处理不会像坐标版那样造成词框与原始图错位。
///
/// 缓存 key 用**原始 path**（与 history.content 同源，见 ocr_image 写缓存注释）；
/// 不命中才本地识别并入库，之后所有路径（历史 JOIN 回填 / 再次调用）都走缓存。
#[tauri::command]
pub async fn ocr_image_cached(store: State<'_, DataStore>, path: String) -> Result<String, String> {
    // 先查库：缓存 key 与 history.content 完全同串，回填与懒触发天然一致。
    // 未校验路径也能查（缓存查询无害）；识别前仍有 validate + 尺寸校验兜底。
    if let Some(cached) = store.get_ocr_text(&path)? {
        return Ok(cached);
    }
    // 校验拿 canonical 判存在性/类型/尺寸；失败即返回，不触发识别。
    validate_image_file_path(&path)?;
    check_image_decode_limits(&std::path::Path::new(&path))?;
    let path_inner = path.clone();
    let result = tokio::task::spawn_blocking(move || ocr_image_cached_impl(&path_inner))
        .await
        .map_err(|e| format!("OCR 任务失败: {}", e))??;
    store.set_ocr_text(&path, &result)?;
    Ok(result)
}

/// 坐标版 OCR（框选功能用）：校验 + WinRT 识别，返回词坐标框。
/// **不做图像预处理**——词框坐标必须与原始图片精确对应，
/// 预处理（放大）会让坐标错位。预处理只走 `ocr_image_cached_impl`。
#[cfg(target_os = "windows")]
fn ocr_image_impl(path: &str) -> Result<OcrResult, String> {
    // 修复 C16/C18 同类问题：OCR 通道此前无任何路径校验，可读取任意文件。
    // 统一走白名单 + canonicalize（兼防 UNC 凭据泄漏），并做头部尺寸校验防解压炸弹。
    let canonical = validate_image_file_path(path)?;
    check_image_decode_limits(&canonical)?;
    // 校验（白名单/存在性/尺寸）已在 validate_image_file_path 完成。
    // 但 std::fs::canonicalize 在 Windows 上会返回带 `\\?\` 设备命名空间前缀的路径，
    // 而 WinRT 的 StorageFile::GetFileFromPathAsync 只接受标准 Win32 路径（C:\...），
    // 喂入 `\\?\...` 会报 ERROR_INVALID_NAME (0x800700A1)。此处剥掉前缀再交给 WinRT。
    let canonical_str = strip_verbatim_prefix(&canonical);
    ocr_winrt_from_file(&canonical_str)
}

/// 文本版 OCR（卡片标题 / AI 栏）：校验 + **图像预处理**（小图放大）+ WinRT 识别。
/// 只返回 full_text；预处理提升 Windows OCR 对小字号/低分辨率截图的识别准确率。
#[cfg(target_os = "windows")]
fn ocr_image_cached_impl(path: &str) -> Result<String, String> {
    let prepared = preprocess_ocr_image(path)?;
    let result = ocr_winrt_from_file(&prepared.0.to_string_lossy())?;
    drop(prepared); // RAII 清理临时文件
    Ok(result.full_text)
}

/// 图像预处理：小图放大（Windows OCR 对小字号识别差，放大直接缓解；大图不动省时间）。
///
/// - 触发条件：长边 < 1000px → Lanczos3 放大 2x（放大后长边 < 2000，像素 < 4MP，安全）；
/// - 保持原色彩类型保存为临时 PNG：BitmapDecoder 解码后得到引擎可接受的
///   BGRA8 SoftwareBitmap（灰度化需转 RGBA8 防格式拒绝，第一版不做，实测后再加）；
/// - 临时文件用 RAII guard 删除（drop 即清理，异常路径不泄漏）。
fn preprocess_ocr_image(path: &str) -> Result<(std::path::PathBuf, TempPng), String> {
    use image::imageops::FilterType;
    use image::GenericImageView;

    let img = image::open(path).map_err(|e| format!("预处理解码失败: {e}"))?;
    let (w, h) = img.dimensions();
    let scaled = if w.max(h) < 1000 {
        img.resize(w.saturating_mul(2), h.saturating_mul(2), FilterType::Lanczos3)
    } else {
        img
    };
    let tmp = std::env::temp_dir().join(format!("pastepanda_ocr_{}.png", uuid::Uuid::new_v4()));
    scaled.save(&tmp).map_err(|e| format!("预处理保存失败: {e}"))?;
    Ok((tmp.clone(), TempPng(tmp)))
}

/// 临时 PNG 文件的 RAII 清理守卫：drop 时删除（识别完成 / 中途报错都不泄漏）。
struct TempPng(std::path::PathBuf);
impl Drop for TempPng {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// WinRT OCR 核心：对**标准 Win32 路径**（已 strip `\\?\` 前缀）执行识别。
/// 入参路径已由调用方完成白名单/存在性/尺寸校验。
#[cfg(target_os = "windows")]
fn ocr_winrt_from_file(win32_path: &str) -> Result<OcrResult, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    // 1. 用 StorageFile 打开图片文件
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(win32_path))
        .map_err(|e| format!("打开文件失败: {}", e))?
        .get()
        .map_err(|e| format!("等待文件打开失败: {}", e))?;

    // 2. 打开文件流 (需要 Storage_Streams feature)
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("打开文件流失败: {}", e))?
        .get()
        .map_err(|e| format!("等待文件流失败: {}", e))?;

    // 3. 解码图片 (静态方法, 需要 Storage_Streams feature)
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("创建解码器失败: {}", e))?
        .get()
        .map_err(|e| format!("解码图片失败: {}", e))?;

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("获取位图失败: {}", e))?
        .get()
        .map_err(|e| format!("读取位图数据失败: {}", e))?;

    // 4. 创建 OCR 引擎（中文优先，回退英文）
    let language = Language::CreateLanguage(&HSTRING::from("zh-Hans"))
        .or_else(|_| Language::CreateLanguage(&HSTRING::from("en-US")))
        .map_err(|_| "无法创建语言对象".to_string())?;

    let engine = OcrEngine::TryCreateFromLanguage(&language)
        .map_err(|e| format!("创建 OCR 引擎失败: {}. 请确保系统已安装中文语言包", e))?;

    // 5. 执行 OCR
    let ocr_result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR 识别失败: {}", e))?
        .get()
        .map_err(|e| format!("获取 OCR 结果失败: {}", e))?;

    // 6. 提取结果 (Lines/Words 需要 Foundation_Collections feature)
    let lines = {
        let ocr_lines = ocr_result
            .Lines()
            .map_err(|e| format!("获取 OCR 行失败: {}", e))?;
        let count = ocr_lines
            .Size()
            .map_err(|e| format!("获取行数失败: {}", e))? as usize;
        let mut lines_vec = Vec::with_capacity(count);
        for i in 0..count {
            let line = ocr_lines
                .GetAt(i as u32)
                .map_err(|e| format!("获取第 {} 行失败: {}", i, e))?;
            let line_text = line.Text().unwrap_or_default().to_string();

            let words_iv = line.Words().map_err(|e| format!("获取词列表失败: {}", e))?;
            let wcount = words_iv
                .Size()
                .map_err(|e| format!("获取词数失败: {}", e))? as usize;
            let mut words = Vec::with_capacity(wcount);
            for j in 0..wcount {
                let word = words_iv
                    .GetAt(j as u32)
                    .map_err(|e| format!("获取第 {}-{} 个词失败: {}", i, j, e))?;
                let rect = word.BoundingRect().unwrap_or_default();
                words.push(OcrWordInfo {
                    text: word.Text().unwrap_or_default().to_string(),
                    x: rect.X,
                    y: rect.Y,
                    width: rect.Width,
                    height: rect.Height,
                });
            }
            lines_vec.push(OcrLineInfo {
                text: line_text,
                words,
            });
        }
        lines_vec
    };

    let full_text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(OcrResult { lines, full_text })
}

/// 去掉 Windows 设备命名空间前缀 `\\?\`（std::fs::canonicalize 在 Windows 上会加上），
/// 因为 WinRT StorageFile::GetFileFromPathAsync 只接受标准 Win32 路径（C:\...）。
/// 非 Windows 平台不会出现该前缀，调用为 no-op。
fn strip_verbatim_prefix(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|stripped| stripped.to_string()).unwrap_or(s)
}

#[cfg(not(target_os = "windows"))]
fn ocr_image_impl(_path: &str) -> Result<OcrResult, String> {
    Err("OCR 功能仅支持 Windows 系统".to_string())
}

#[cfg(not(target_os = "windows"))]
fn ocr_image_cached_impl(_path: &str) -> Result<String, String> {
    Err("OCR 功能仅支持 Windows 系统".to_string())
}

// ===== 置顶图片（原生 Windows 窗口） =====

/// 创建原生 Windows 窗口显示置顶图片（GDI 渲染，不依赖 WebView）
#[tauri::command]
pub fn open_pinned_image(
    _app: tauri::AppHandle,
    _store: State<DataStore>,
    path: String,
) -> Result<(), String> {
    log::info!("[pinned-image] open_pinned_image 被调用, path: {}", path);
    crate::pinned_window::create_native_window(&path)
}

/// 关闭置顶图片（通知前端隐藏遮罩层 + 主动关闭当前原生置顶窗口）
#[tauri::command]
pub fn close_pinned_image() -> Result<(), String> {
    log::info!("[pinned-image] close_pinned_image 被调用");
    crate::pinned_window::close_current_window();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    /// 生成一张指定尺寸的灰色渐变 PNG（用于验证预处理缩放逻辑）
    fn make_png(path: &std::path::Path, w: u32, h: u32) {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            let v = ((x.wrapping_add(y)) % 255) as u8;
            image::Rgb([v, v, v])
        });
        img.save(path).expect("测试图片保存失败");
    }

    /// 小图（长边 < 1000）→ 放大 2x；临时文件由 RAII guard 清理
    #[test]
    fn test_preprocess_scales_small_image() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("pp_ocr_src_{}.png", uuid::Uuid::new_v4()));
        make_png(&src, 300, 200);

        let (tmp, guard) = preprocess_ocr_image(src.to_string_lossy().as_ref()).expect("预处理失败");
        let img = image::open(&tmp).expect("预处理产物打不开");
        assert_eq!(img.dimensions(), (600, 400), "长边 300 < 1000 应放大 2x");
        assert!(tmp.exists(), "预处理临时文件应存在");

        drop(guard);
        assert!(!tmp.exists(), "RAII guard drop 后临时文件应被删除");
        let _ = std::fs::remove_file(&src);
    }

    /// 大图（长边 ≥ 1000）→ 不放大（省时间，避免无收益的像素翻倍）
    #[test]
    fn test_preprocess_keeps_large_image() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("pp_ocr_big_{}.png", uuid::Uuid::new_v4()));
        make_png(&src, 2000, 1000);

        let (tmp, guard) = preprocess_ocr_image(src.to_string_lossy().as_ref()).expect("预处理失败");
        let img = image::open(&tmp).expect("预处理产物打不开");
        assert_eq!(img.dimensions(), (2000, 1000), "长边 2000 ≥ 1000 不应放大");
        drop(guard);
        let _ = std::fs::remove_file(&src);
    }

    /// 预处理失败（文件不存在）→ 返回 Err，不产生临时文件
    #[test]
    fn test_preprocess_missing_file_errors() {
        let missing = std::env::temp_dir().join("pp_ocr_no_such_file.png");
        assert!(preprocess_ocr_image(missing.to_string_lossy().as_ref()).is_err());
    }
}
