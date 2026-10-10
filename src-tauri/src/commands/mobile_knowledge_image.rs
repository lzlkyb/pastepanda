//! Markdown is untrusted: it must never read arbitrary local files or fetch external URLs.
use base64::{engine::general_purpose::STANDARD, Engine};
use md5::{Digest, Md5};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn mobile_knowledge_image(app: AppHandle, src: String) -> Result<String, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法读取应用目录: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        read_knowledge_image(&app_dir.join("images"), &src)
    })
    .await
    .map_err(|_| "图片读取任务失败".to_string())?
}

fn image_candidate(images: &Path, src: &str) -> Result<PathBuf, String> {
    if let Some(name) = src.strip_prefix("pp-asset:") {
        if name.contains(['/', '\\']) { return Err("图片名称无效".into()); }
        return Ok(images.join(name));
    }
    let normalized = src.replace('\\', "/");
    if let Some(name) = normalized.strip_prefix("images/") {
        if name.contains('/') { return Err("图片名称无效".into()); }
        return Ok(images.join(name));
    }
    if src.starts_with("file:") {
        return url::Url::parse(src)
            .map_err(|_| "图片路径无效")?
            .to_file_path()
            .map_err(|_| "图片路径无效".into());
    }
    let path = PathBuf::from(src);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("只支持应用内的图片".into())
    }
}

pub(crate) fn read_knowledge_image(images: &Path, src: &str) -> Result<String, String> {
    let (mime, bytes) = read_knowledge_image_bytes(images, src)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub(crate) fn read_knowledge_image_bytes(images: &Path, src: &str) -> Result<(&'static str, Vec<u8>), String> {
    let candidate = image_candidate(images, src)?;
    let file_name = candidate
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("图片名称无效")?;
    let (hash, extension) = file_name.rsplit_once('.').ok_or("图片名称无效")?;
    if hash.len() != 32
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        || !super::ALLOWED_IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
    {
        return Err("只支持应用内的内容寻址图片".into());
    }
    let root = images.canonicalize().map_err(|_| "图片尚未保存到本机")?;
    let canonical = candidate.canonicalize().map_err(|_| "图片尚未保存到本机")?;
    // Exact parent check blocks traversal and symlinks into other app-private directories.
    if canonical.parent() != Some(root.as_path()) {
        return Err("图片不在应用图片目录内".into());
    }
    let mut file = std::fs::File::open(&canonical).map_err(|_| "无法读取本机图片")?;
    let metadata = file.metadata().map_err(|_| "无法读取图片信息")?;
    if !metadata.is_file() || metadata.len() > crate::sync::attach::MAX_ASSET_BYTES {
        return Err("图片超过10MB或不是普通文件".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(crate::sync::attach::MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "图片读取失败")?;
    if bytes.len() as u64 > crate::sync::attach::MAX_ASSET_BYTES {
        return Err("图片超过10MB".into());
    }
    if format!("{:x}", Md5::digest(&bytes)) != hash.to_ascii_lowercase() {
        return Err("图片内容校验失败".into());
    }
    let (mime, _) = validate_image_bytes(&bytes)?;
    Ok((mime, bytes))
}

/// Shared by incoming Android collection and Markdown viewing: reject before bitmap decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageValidationError {
    InvalidFormat,
    UnsupportedFormat,
    InvalidDimensions,
    ExcessiveDimensions,
}
impl std::fmt::Display for ImageValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidFormat => "图片格式无效",
            Self::UnsupportedFormat => "暂不支持此图片格式",
            Self::InvalidDimensions => "无法读取图片尺寸",
            Self::ExcessiveDimensions => "图片分辨率过高，请在电脑上缩小后查看",
        })
    }
}
impl From<ImageValidationError> for String {
    fn from(error: ImageValidationError) -> Self { error.to_string() }
}

pub(crate) fn validate_image_bytes(bytes: &[u8]) -> Result<(&'static str, &'static str), ImageValidationError> {
    let (mime, extension) = match image::guess_format(bytes).map_err(|_| ImageValidationError::InvalidFormat)? {
        image::ImageFormat::Png => ("image/png", "png"),
        image::ImageFormat::Jpeg => ("image/jpeg", "jpg"),
        image::ImageFormat::Gif => ("image/gif", "gif"),
        image::ImageFormat::WebP => ("image/webp", "webp"),
        image::ImageFormat::Bmp => ("image/bmp", "bmp"),
        image::ImageFormat::Ico => ("image/x-icon", "ico"),
        _ => return Err(ImageValidationError::UnsupportedFormat),
    };
    // Inspect headers only: a small compressed file can still request hundreds of MB
    // when the phone decodes it. Never decode a full bitmap just to validate its size.
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| ImageValidationError::InvalidFormat)?
        .into_dimensions()
        .map_err(|_| ImageValidationError::InvalidDimensions)?;
    validate_dimensions(width, height)?;
    Ok((mime, extension))
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), ImageValidationError> {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16_000_000
    {
        return Err(ImageValidationError::ExcessiveDimensions);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_image_compressed_pixel_limit_is_independent_of_file_size() {
        assert!(validate_dimensions(4000, 3000).is_ok());
        assert!(validate_dimensions(8192, 8192).is_err());
        assert!(validate_dimensions(20000, 1).is_err());
        assert!(validate_dimensions(0, 100).is_err());
        assert!(validate_dimensions(u32::MAX, u32::MAX).is_err());
    }
    fn setup() -> (PathBuf, PathBuf, String) {
        let root =
            std::env::temp_dir().join(format!("pastepanda-image-test-{}", uuid::Uuid::new_v4()));
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let bytes = bytes.into_inner();
        let name = format!("{:x}.png", Md5::digest(&bytes));
        std::fs::write(images.join(&name), bytes).unwrap();
        (root, images, name)
    }
    #[test]
    fn mobile_image_portable_absolute_and_file_url_read_real_bytes() {
        let (root, images, name) = setup();
        let expected = read_knowledge_image(&images, &format!("images/{name}")).unwrap();
        assert!(expected.starts_with("data:image/png;base64,"));
        assert_eq!(
            read_knowledge_image(&images, &format!("pp-asset:{name}")).unwrap(),
            expected
        );
        assert_eq!(
            read_knowledge_image(&images, images.join(&name).to_str().unwrap()).unwrap(),
            expected
        );
        let url = url::Url::from_file_path(images.join(&name)).unwrap();
        assert_eq!(
            read_knowledge_image(&images, url.as_str()).unwrap(),
            expected
        );
        std::fs::remove_file(images.join(name)).unwrap();
        std::fs::remove_dir(images).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn mobile_image_rejects_traversal_external_files_forgery_and_oversize() {
        let (root, images, name) = setup();
        std::fs::copy(images.join(&name), root.join(&name)).unwrap();
        for src in [
            format!("images/../{name}"),
            root.join(&name).to_string_lossy().into(),
            format!("https://host/images/{name}"),
            "images/private.txt".into(),
        ] {
            assert!(read_knowledge_image(&images, &src).is_err(), "{src}");
        }
        let bad = "00000000000000000000000000000000.png";
        std::fs::write(images.join(bad), b"private text").unwrap();
        assert!(read_knowledge_image(&images, &format!("images/{bad}")).is_err());
        let file = std::fs::File::create(images.join(bad)).unwrap();
        file.set_len(crate::sync::attach::MAX_ASSET_BYTES + 1)
            .unwrap();
        drop(file);
        assert!(read_knowledge_image(&images, &format!("images/{bad}")).is_err());
        std::fs::remove_file(images.join(bad)).unwrap();
        std::fs::remove_file(images.join(&name)).unwrap();
        std::fs::remove_file(root.join(name)).unwrap();
        std::fs::remove_dir(images).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn mobile_image_rejects_symlink_to_private_directory() {
        let (root, images, name) = setup();
        std::fs::rename(images.join(&name), root.join(&name)).unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(root.join(&name), images.join(&name));
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(root.join(&name), images.join(&name));
        match linked {
            Ok(()) => {
                assert!(read_knowledge_image(&images, &format!("images/{name}")).is_err());
                std::fs::remove_file(images.join(&name)).unwrap();
            }
            // Windows Developer Mode/admin rights govern link creation, independently
            // of the app's path validation. Other errors remain actual test failures.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("symlink creation unavailable: {e}");
            }
            Err(e) => panic!("could not create test symlink: {e}"),
        }
        std::fs::remove_file(root.join(name)).unwrap();
        std::fs::remove_dir(images).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
