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
    //
    // 显式 to_rgb8：JPEG 没有 alpha 通道。
    //
    // ⚠️ 这里**不是**必需的修复，只是把隐式行为写明。实测过（见 thumb_diag 测试）：
    // `DynamicImage::write_to(.., Jpeg)` 对 RGBA 输入会自己降到 RGB，不报错。
    // 那个 "does not support the color type 'Rgba8'" 只发生在直接用
    // `JpegEncoder` + `write_with_encoder` 时（screenshot.rs 的捕获路径是那种写法）。
    //
    // 保留它的理由：读代码的人不必去查 write_to 内部做了什么，
    // 且以后若改成显式 encoder 也不会突然坏掉。
    let file =
        std::fs::File::create(&thumb_path).map_err(|e| format!("无法创建缩略图文件: {}", e))?;
    let mut writer = BufWriter::new(file);
    image::DynamicImage::ImageRgb8(output_img.to_rgb8())
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

/// 对图片文件执行 OCR 文字识别（PP-OCRv6 离线引擎，纯 Rust + MNN，模型随包发布）
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
/// - 引擎为 PP-OCRv6（离线、随包发布），识别准确率显著高于原 Windows 自带 OCR。
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

/// 坐标版 OCR（框选功能用）：校验 + PP-OCRv6 引擎识别，返回词坐标框。
///
/// 引擎为 PP-OCRv6（纯 Rust + MNN，模型随安装包发布，零外部依赖），跨平台可用。
/// 不做图像预处理——词框坐标必须与原始图片精确对应。
/// 同步取一张图的 OCR 全文（不带坐标、不查缓存）。
///
/// 给非 async 调用方用（贴图窗口的 wndproc 是 Win32 同步回调，不能 .await）。
/// 缓存读写由调用方负责——它才知道该用哪个 key（必须与 history.content 同源字符串）。
///
/// ❗ 会阻塞当前线程几百毫秒到几秒，调用方务必放到后台线程。
pub fn ocr_full_text(path: &str) -> Result<String, String> {
    let canonical = validate_image_file_path(path)?;
    check_image_decode_limits(&canonical)?;
    // with_coords = false：只要文字，省掉逐字符 bbox 的反投影
    let res = ocr_recognize(&canonical, false)?;
    Ok(res.full_text)
}

fn ocr_image_impl(path: &str) -> Result<OcrResult, String> {
    let canonical = validate_image_file_path(path)?;
    check_image_decode_limits(&canonical)?;
    ocr_recognize(&canonical, true)
}

/// 文本版 OCR（卡片标题 / AI 栏）：校验 + PP-OCRv6 引擎识别，只返回全文。
///
/// 与 `ocr_image` 区别同前：查库优先（见 ocr_image_cached 注释），仅返回 `full_text`。
fn ocr_image_cached_impl(path: &str) -> Result<String, String> {
    let canonical = validate_image_file_path(path)?;
    check_image_decode_limits(&canonical)?;
    let result = ocr_recognize(&canonical, false)?;
    Ok(result.full_text)
}

/// 全局 OCR 引擎缓存。MNN 模型加载较重（数百 ms ~ 1s），首次识别时初始化一次，后续复用。
static OCR_ENGINE: std::sync::OnceLock<std::sync::Mutex<ocr_rs::OcrEngine>> =
    std::sync::OnceLock::new();

/// 在候选目录中定位 OCR 模型目录：找到包含检测模型文件的目录即返回。
///
/// 搜索顺序（覆盖 dev / 打包后两种布局）：
/// 1. 环境变量 `PASTEPANDA_OCR_MODELS_DIR`（调试用，强制指定）；
/// 2. 从当前 exe 所在目录开始，逐级向上查找 `ocr_models/` 与 `resources/ocr_models/`
///    —— 既覆盖 `tauri dev`（源码 `src-tauri/resources/ocr_models`），也覆盖安装包
///    （Tauri 把 resources 复制到 exe 旁边的 `resources/ocr_models`）。
fn resolve_ocr_models_dir() -> Option<std::path::PathBuf> {
    const DET_MODEL: &str = "PP-OCRv6_small_det.mnn";
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(env_dir) = std::env::var("PASTEPANDA_OCR_MODELS_DIR") {
        candidates.push(std::path::PathBuf::from(env_dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let mut cur = Some(dir.to_path_buf());
            while let Some(d) = cur {
                candidates.push(d.join("ocr_models"));
                candidates.push(d.join("resources").join("ocr_models"));
                cur = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    candidates.into_iter().find(|p| p.join(DET_MODEL).is_file())
}

/// 取得（惰性初始化）全局 OCR 引擎。
fn get_ocr_engine() -> Result<&'static std::sync::Mutex<ocr_rs::OcrEngine>, String> {
    if let Some(engine) = OCR_ENGINE.get() {
        return Ok(engine);
    }
    let dir = resolve_ocr_models_dir().ok_or_else(|| {
        "找不到 OCR 模型文件（PP-OCRv6_small_det.mnn）。请确认模型已随程序发布到 \
         resources/ocr_models/ 目录，或通过环境变量 PASTEPANDA_OCR_MODELS_DIR 指定模型目录。"
            .to_string()
    })?;
    let det = dir.join("PP-OCRv6_small_det.mnn");
    let rec = dir.join("PP-OCRv6_small_rec.mnn");
    let keys = dir.join("ppocr_keys_v6_small.txt");
    let engine = ocr_rs::OcrEngine::new(det, rec, keys, None)
        .map_err(|e| format!("OCR 引擎初始化失败: {}", e))?;
    let _ = OCR_ENGINE.set(std::sync::Mutex::new(engine));
    OCR_ENGINE
        .get()
        .ok_or_else(|| "OCR 引擎缓存写入失败".to_string())
}

/// 用 PP-OCRv6 引擎对图片执行识别。
///
/// - `with_coords = true`：返回按行分组的词坐标框（框选用，每行一个整行级文本框）；
/// - `with_coords = false`：只返回拼接后的全文（卡片标题 / AI 栏用）。
///
/// PP-OCR 的检测输出为**行级**：每个识别结果是一整行文字 + 整行 bbox，故映射为
/// 一个 `OcrLineInfo` 内含单个整行级 `OcrWordInfo`（框选高亮变为按行高亮，复制文字不受影响）。
fn ocr_recognize(path: &std::path::Path, with_coords: bool) -> Result<OcrResult, String> {
    let img = image::open(path).map_err(|e| format!("图片解码失败: {e}"))?;
    let engine = get_ocr_engine()?;
    let guard = engine
        .lock()
        .map_err(|_| "OCR 引擎锁已被污染（此前发生 panic），请重启应用".to_string())?;
    let results = guard
        .recognize(&img)
        .map_err(|e| format!("OCR 识别失败: {}", e))?;
    drop(guard);

    if !with_coords {
        let full_text = results
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(OcrResult {
            lines: Vec::new(),
            full_text,
        });
    }

    // 行级结果 → 逐行映射为 OcrLineInfo。
    // 若后端提供了逐字符横坐标（char_xn），则展开成逐字符词框（真·字级），
    // 让前端拖选可精确到单个字；否则回退为整行级词框（兜底，不破坏旧行为）。
    // PP-OCR 后处理已按阅读顺序（上→下、同高度左→右）返回，无需再排序。
    // 注意：imageproc::rect::Rect 的 x/y/width/height 字段为私有，必须用同名方法访问。
    let (img_w, img_h) = (img.width(), img.height());
    let mut lines: Vec<OcrLineInfo> = Vec::with_capacity(results.len());
    for r in &results {
        let rect = &r.bbox.rect;
        let text = r.text.clone();
        let chars: Vec<char> = text.chars().collect();
        let words = if !r.char_xn.is_empty() && r.char_xn.len() == chars.len() {
            // 真·字级：把归一化横坐标反投影回原图，逐字符成框。
            let boxes = ocr_rs::char_boxes_from_rec(&r.char_xn, &r.bbox, img_w, img_h);
            chars
                .iter()
                .zip(boxes.iter())
                .map(|(ch, b)| OcrWordInfo {
                    text: ch.to_string(),
                    x: b.0,
                    y: b.1,
                    width: b.2,
                    height: b.3,
                })
                .collect()
        } else {
            // 兜底：整行级词框。
            vec![OcrWordInfo {
                text: text.clone(),
                x: rect.left() as f32,
                y: rect.top() as f32,
                width: rect.width() as f32,
                height: rect.height() as f32,
            }]
        };
        lines.push(OcrLineInfo { text, words });
    }
    let full_text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(OcrResult { lines, full_text })
}

// ===== 置顶图片（原生 Windows 窗口） =====

/// 创建原生 Windows 窗口显示置顶图片（GDI 渲染，不依赖 WebView）
#[tauri::command]
pub fn open_pinned_image(
    app: tauri::AppHandle,
    _store: State<DataStore>,
    path: String,
) -> Result<(), String> {
    log::info!("[pinned-image] open_pinned_image 被调用, path: {}", path);
    // (app, path) 直接随窗口创建线程带下去绑定，避免全局 slot 被连续双击覆盖（"双击A开B"）。
    crate::pinned_window::create_native_window(app, &path)
}

/// 关闭置顶图片（通知前端隐藏遮罩层 + 主动关闭当前原生置顶窗口）
#[tauri::command]
pub fn close_pinned_image() -> Result<(), String> {
    log::info!("[pinned-image] close_pinned_image 被调用");
    crate::pinned_window::close_current_window();
    Ok(())
}

/// OCR 端到端冒烟测试：加载 PP-OCRv6 模型并对 uploads/ 下的截图跑一次真实识别。
/// 仅用于验证「模型能加载 + 引擎能跑通 + 坐标/文本能正确返回」，不依赖具体图片内容。
#[cfg(test)]
mod ocr_smoke_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn smoke_ocr_engine_runs_on_sample_image() {
        // 直接指向仓库内已下载的模型目录，避免测试时路径解析歧义
        std::env::set_var(
            "PASTEPANDA_OCR_MODELS_DIR",
            concat!(env!("CARGO_MANIFEST_DIR"), "/resources/ocr_models"),
        );
        // 取仓库 uploads/ 下第一张 png 作为样例（CARGO_MANIFEST_DIR 为 src-tauri，
        // 故向上两级到达 clipboard-manager-tauri，再进 uploads）
        let uploads = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("uploads");
        let sample = std::fs::read_dir(&uploads)
            .ok()
            .and_then(|mut d| {
                d.find_map(|e| {
                    let p = e.ok()?.path();
                    if p.extension().map(|x| x == "png").unwrap_or(false) {
                        Some(p)
                    } else {
                        None
                    }
                })
            });
        let sample = match sample {
            Some(p) => p,
            None => {
                eprintln!("跳过冒烟测试：uploads 下未找到 png 样例");
                return;
            }
        };

        // 坐标版：验证模型加载成功且能返回行/词框
        let coords = ocr_recognize(&sample, true)
            .unwrap_or_else(|e| panic!("OCR(坐标版) 失败: {}", e));
        println!(
            "[OCR smoke] 坐标版：{} 行，全文长度 {} 字符",
            coords.lines.len(),
            coords.full_text.chars().count()
        );
        for (i, line) in coords.lines.iter().take(5).enumerate() {
            if let Some(w) = line.words.first() {
                println!(
                    "  行{}: '{}' @ ({:.0},{:.0},{:.0}x{:.0})",
                    i, line.text, w.x, w.y, w.width, w.height
                );
            }
        }

        // 文本版：仅返回全文
        let text = ocr_recognize(&sample, false)
            .unwrap_or_else(|e| panic!("OCR(文本版) 失败: {}", e));
        assert!(
            !text.full_text.is_empty() || coords.lines.is_empty(),
            "若图片无文字属正常；有文字则应被识别出来"
        );
        println!("[OCR smoke] 全文预览:\n{}", text.full_text);
    }
}



/// 诊断用：拿真实截图文件跑一遍缩略图生成的核心步骤，打印每一步的结果。
///
/// 为什么需要它：卡片显示“图片加载失败”时，前端只把错误吞进 logger.error，
/// 而 dev 控制台不好取；直接在这里复现同一条链路能拿到确切的错误串。
///
/// 跑法：cargo test --lib thumb_diag -- --nocapture --ignored
#[cfg(test)]
mod thumb_diag {
    #[test]
    #[ignore]
    fn thumb_diag() {
        let dir = std::path::PathBuf::from(
            std::env::var("APPDATA").unwrap_or_default(),
        )
        .join("com.pastepanda.app")
        .join("screenshots");
        println!("目录: {}", dir.display());

        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .expect("读目录失败")
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .collect();
        files.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());

        for e in files.iter().rev().take(3) {
            let p = e.path();
            println!("\n=== {} ({} bytes) ===", p.display(), e.metadata().map(|m| m.len()).unwrap_or(0));

            match super::validate_image_file_path(&p.to_string_lossy()) {
                Ok(c) => println!("  validate_image_file_path: OK -> {}", c.display()),
                Err(err) => { println!("  validate_image_file_path: ERR {err}"); continue; }
            }
            match crate::commands::check_image_decode_limits(&p) {
                Ok((w, h)) => println!("  check_image_decode_limits: OK {w}x{h}"),
                Err(err) => { println!("  check_image_decode_limits: ERR {err}"); continue; }
            }
            let img = match image::open(&p) {
                Ok(i) => { println!("  image::open: OK color={:?}", i.color()); i }
                Err(err) => { println!("  image::open: ERR {err}"); continue; }
            };
            // 这一步就是修复点：不先 to_rgb8 的话 RGBA 输入会报
            // "does not support the color type 'Rgba8'"
            let mut buf: Vec<u8> = Vec::new();
            let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
            match rgb.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg) {
                Ok(()) => println!("  写 JPEG（先 to_rgb8）: OK {} bytes", buf.len()),
                Err(err) => println!("  写 JPEG（先 to_rgb8）: ERR {err}"),
            }
            // 对照：不转 RGB 直接写，验证旧实现的失败
            let mut buf2: Vec<u8> = Vec::new();
            match img.write_to(&mut std::io::Cursor::new(&mut buf2), image::ImageFormat::Jpeg) {
                Ok(()) => println!("  写 JPEG（旧实现，不转）: OK {} bytes", buf2.len()),
                Err(err) => println!("  写 JPEG（旧实现，不转）: ERR {err}"),
            }
        }
    }
}
