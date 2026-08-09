use super::*;

// ============================================================
// is_allowed_open_url（open_url 的协议白名单）
// ============================================================

#[test]
fn test_open_url_allows_browser_and_mail() {
    assert!(is_allowed_open_url("https://example.com"));
    assert!(is_allowed_open_url("http://example.com/path?q=1"));
    assert!(is_allowed_open_url("mailto:a@b.com"));
    // 首尾空白允许（命令层会 trim）
    assert!(is_allowed_open_url("  https://example.com  "));
}

#[test]
fn test_open_url_rejects_other_protocols() {
    // 这是安全边界：file:/cmd:/javascript: 等协议一旦放行，
    // 剪贴板里任意一行内容就能让用户点一下打开本地程序或执行脚本
    assert!(!is_allowed_open_url("file:///C:/Windows/notepad.exe"));
    assert!(!is_allowed_open_url("cmd://echo%20hi"));
    assert!(!is_allowed_open_url("javascript:alert(1)"));
    assert!(!is_allowed_open_url("ftp://example.com"));
    assert!(!is_allowed_open_url("example.com")); // 没写协议的一律不放行
    assert!(!is_allowed_open_url(""));
}

// ============================================================
// is_unsafe_network_path
// ============================================================

#[test]
fn test_unc_backslash_detected() {
    assert!(is_unsafe_network_path(r"\\server\share\file.png"));
}

#[test]
fn test_unc_slash_detected() {
    assert!(is_unsafe_network_path("//server/share/file.png"));
}

#[test]
fn test_unc_with_leading_whitespace() {
    assert!(is_unsafe_network_path("  \\\\evil\\share"));
}

#[test]
fn test_local_path_safe() {
    assert!(!is_unsafe_network_path(r"C:\Users\test\img.png"));
    assert!(!is_unsafe_network_path("/home/user/img.png"));
    assert!(!is_unsafe_network_path("relative/path/img.png"));
}

// ============================================================
// validate_image_file_path
// ============================================================

#[test]
fn test_validate_nonexistent_path() {
    let result = validate_image_file_path("/nonexistent/path/img.png");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("路径无效或文件不存在"));
}

#[test]
fn test_validate_directory_rejected() {
    let dir = std::env::temp_dir();
    let result = validate_image_file_path(dir.to_str().unwrap());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("不是一个有效的文件"));
}

#[test]
fn test_validate_wrong_extension_rejected() {
    let dir = std::env::temp_dir().join(format!("pp_val_ext_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let txt_file = dir.join("malicious.exe.txt");
    std::fs::write(&txt_file, "not an image").unwrap();

    let result = validate_image_file_path(txt_file.to_str().unwrap());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("不支持的文件类型"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_validate_valid_png_accepted() {
    let dir = std::env::temp_dir().join(format!("pp_val_png_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let png_file = dir.join("test.png");
    // 写入最小 PNG 头（不需要完整图片，validate 只检查扩展名和 is_file）
    std::fs::write(&png_file, &[0x89, 0x50, 0x4E, 0x47]).unwrap();

    let result = validate_image_file_path(png_file.to_str().unwrap());
    assert!(result.is_ok());
    // 返回的是规范化路径
    assert_eq!(result.unwrap(), std::fs::canonicalize(&png_file).unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_validate_extension_case_insensitive() {
    let dir = std::env::temp_dir().join(format!("pp_val_case_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let jpg_file = dir.join("PHOTO.JPG");
    std::fs::write(&jpg_file, &[0xFF, 0xD8, 0xFF]).unwrap();

    let result = validate_image_file_path(jpg_file.to_str().unwrap());
    assert!(result.is_ok());

    let _ = std::fs::remove_dir_all(&dir);
}

// ============================================================
// check_image_decode_limits
// ============================================================

#[test]
fn test_decode_limits_small_image_ok() {
    let dir = std::env::temp_dir().join(format!("pp_val_lim_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let img_path = dir.join("small.png");

    // 生成 2x2 像素的合法 PNG
    let img = image::RgbaImage::new(2, 2);
    img.save(&img_path).unwrap();

    let result = check_image_decode_limits(&img_path);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), (2, 2));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_decode_limits_invalid_file() {
    let dir = std::env::temp_dir().join(format!("pp_val_inv_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let bad_file = dir.join("corrupt.png");
    std::fs::write(&bad_file, "this is not a png").unwrap();

    let result = check_image_decode_limits(&bad_file);
    assert!(result.is_err());

    let _ = std::fs::remove_dir_all(&dir);
}
