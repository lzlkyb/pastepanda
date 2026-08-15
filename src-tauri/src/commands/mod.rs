/// 应用配置（从 tauri.conf.json 运行时读取，唯一配置来源）
use std::sync::LazyLock;
use std::sync::OnceLock;

/// 应用版本号（唯一来源：tauri.conf.json，构建时已由 sync-version.mjs 同步到 Cargo.toml）
/// 编译期 CARGO_PKG_VERSION 作为兜底，确保与 tauri.conf.json 一致。
pub static APP_VERSION: LazyLock<String> = LazyLock::new(|| {
    // 主路径：编译期嵌入（Cargo.toml 已由 prebuild 脚本同步）
    let compiled = env!("CARGO_PKG_VERSION").to_string();
    if !compiled.is_empty() && compiled != "0.0.0" {
        return compiled;
    }
    // 兜底：运行时读取 tauri.conf.json
    read_from_conf("version").unwrap_or_else(|_| "0.0.0".to_string())
});

/// 应用名称（由 lib.rs setup 通过 Tauri 框架 API 初始化，dev/安装版均可正确读取）
pub static APP_NAME: OnceLock<String> = OnceLock::new();

/// 获取应用版本号
#[tauri::command]
pub fn get_app_version() -> String {
    APP_VERSION.to_string()
}

/// 获取应用名称
#[tauri::command]
pub fn get_app_name() -> String {
    APP_NAME
        .get()
        .map(|s| s.as_str())
        .unwrap_or("PastePanda")
        .to_string()
}

/// 图片扩展名白名单：用于校验用户选择/粘贴的图片路径，防止通过这些命令读取或写入任意文件
pub(crate) const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"];

/// 校验路径是否为合法的图片文件：规范化路径后确认其存在、是普通文件，且扩展名在允许列表内。
/// 返回规范化后的路径，调用方应使用该路径进行后续文件操作。
pub(crate) fn validate_image_file_path(path: &str) -> Result<std::path::PathBuf, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("路径无效或文件不存在: {e}"))?;

    if !canonical.is_file() {
        return Err("目标路径不是一个有效的文件".to_string());
    }

    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    if !ALLOWED_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的文件类型: .{ext}，仅允许图片文件 ({})",
            ALLOWED_IMAGE_EXTENSIONS.join(", ")
        ));
    }

    Ok(canonical)
}

/// 图片最大解码像素数（100MP ≈ 400MB RGBA 内存），防止解压炸弹（修复 C18）
pub(crate) const MAX_DECODE_PIXELS: u64 = 100_000_000;

/// 仅读取图片头部获取尺寸（不完整解码），并校验是否超过解码上限。
/// 供所有 image::open 调用点前置调用，防止小文件解码出巨大位图导致内存暴涨（修复 C18）。
pub(crate) fn check_image_decode_limits(path: &std::path::Path) -> Result<(u32, u32), String> {
    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("无法打开图片: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("无法识别图片格式: {e}"))?;
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| format!("无法读取图片尺寸: {e}"))?;
    if (w as u64) * (h as u64) > MAX_DECODE_PIXELS {
        return Err(format!(
            "图片尺寸过大 ({}x{}，约 {}MP)，超过 {}MP 解码上限",
            w,
            h,
            (w as u64) * (h as u64) / 1_000_000,
            MAX_DECODE_PIXELS / 1_000_000
        ));
    }
    Ok((w, h))
}

/// 从 tauri.conf.json 读取指定 key 的字符串值（兜底逻辑）
pub(crate) fn read_from_conf(key: &str) -> Result<String, Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    // 候选路径：当前目录 → exe 同级 → exe 父目录的 ..（开发模式 src-tauri/）
    let mut candidates = vec![std::path::PathBuf::from("tauri.conf.json")];
    if let Some(dir) = &exe_dir {
        candidates.push(dir.join("tauri.conf.json"));
        candidates.push(dir.join("..").join("tauri.conf.json"));
    }

    for path in &candidates {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            let search = format!("\"{}\"", key);
            if let Some(start) = content.find(&search) {
                let after_key = &content[start + search.len()..];
                let trimmed = after_key.trim_start_matches(|c| c == ':' || c == ' ' || c == '"');
                if let Some(end) = trimmed.find('"') {
                    return Ok(trimmed[..end].to_string());
                }
            }
        }
    }
    Err(format!("{} not found in tauri.conf.json", key).into())
}

pub(crate) fn get_mime_from_path(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// 获取缩略图缓存目录（在应用数据目录下，确保在 Tauri asset scope 内）
pub(crate) fn get_thumb_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?
        .join("thumbnails");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建缩略图缓存目录: {}", e))?;
    Ok(dir)
}

/// 安全检查：拒绝 UNC / 网络共享路径（\\server\share 或 //server/share）。
/// Windows 上对此类路径执行 exists()/metadata()/explorer 会自动发起 SMB 认证，
/// 泄漏用户的 NTLMv2 凭据哈希（可被离线爆破或中继）。剪贴板中的文件路径可能被
/// 恶意程序或 LAN 同步注入，因此必须在任何文件系统操作前拦截（修复 C3）。
pub(crate) fn is_unsafe_network_path(path: &str) -> bool {
    let trimmed = path.trim();
    trimmed.starts_with("\\\\") || trimmed.starts_with("//")
}

mod ai;
mod action_events;
mod ai_feedback;
mod batch_replace;
mod chains;
mod stack_template;
mod config_convert;
mod content_memory;
mod semantic;
// pub(crate)：`ai::profile_prompt` 要用 build_profile / HOUR_SEGMENTS（避免把角色与
// 领域分类逻辑再写一份）。对外仍然不暴露。
pub(crate) mod profile;
mod sequence;
mod sticky;
mod quota;
mod encoding;
mod export;
mod groups;
mod history;
mod images;
mod lan;
mod paste;
mod regex_rules;
mod snippets;
mod system;
mod tags;
mod update;
mod url_summary;

#[cfg(test)]
mod tests;

pub use ai::*;
pub use action_events::*;
pub use ai_feedback::*;
pub use batch_replace::*;
pub use chains::*;
pub use stack_template::*;
pub use config_convert::*;
pub use content_memory::*;
pub use semantic::*;
pub use profile::*;
pub use sequence::*;
pub use sticky::*;
pub use quota::*;
pub use encoding::*;
pub use export::*;
pub use groups::*;
pub use history::*;
pub use images::*;
pub use lan::*;
pub use paste::*;
pub use regex_rules::*;
pub use snippets::*;
pub use system::*;
pub use tags::*;
pub use update::*;
pub use url_summary::*;
