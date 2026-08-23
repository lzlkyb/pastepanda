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

// ============================================================
// read_pdf_as_base64 的路径校验（审查发现 #1）
//
// PdfViewer 原先走 plugin-fs 的 readFile(path)，而 capabilities 只有 fs:default——
// 生成的 schema 写明它「enables read access to the application specific directories」，
// 也就是只能读应用自己的目录。而 PDF 路径来自 parseFilePaths(item.content)，
// 是用户的原始路径（D:\docs\x.pdf），必然被拒；失败还会显示成「无法解析 PDF」，
// 把权限问题误报成文件损坏。
//
// 修法沿用项目既有做法（图片一律走 Rust 命令读，见 read_file_as_base64），
// 而不是把 fs:scope 开成 ** —— 那等于把整个文件系统交给 WebView。
// ============================================================

#[test]
fn test_validate_pdf_rejects_non_pdf() {
    let dir = std::env::temp_dir().join(format!("pp_pdf_ext_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("payload.exe");
    std::fs::write(&f, "MZ").unwrap();

    let result = validate_pdf_file_path(f.to_str().unwrap());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("不支持的文件类型"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_validate_pdf_accepts_pdf_and_is_case_insensitive() {
    let dir = std::env::temp_dir().join(format!("pp_pdf_ok_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("doc.PDF");
    std::fs::write(&f, b"%PDF-1.7\n").unwrap();

    assert!(validate_pdf_file_path(f.to_str().unwrap()).is_ok());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_validate_pdf_rejects_directory_and_missing() {
    assert!(validate_pdf_file_path("/nonexistent/x.pdf").is_err());
    let dir = std::env::temp_dir();
    let e = validate_pdf_file_path(dir.to_str().unwrap()).unwrap_err();
    assert!(e.contains("不是一个有效的文件"));
}

// ============================================================
// allow_media_asset 的路径校验（审查发现 #6）
//
// FileDetailDialog 的音视频内嵌播放走 convertFileSrc，但 tauri.conf.json 的
// assetProtocol.scope 只有 $APPDATA/**，用户复制进来的原始路径在 scope 外会被
// 拦成 403 —— 而 convertFileSrc 只是字符串拼接，前端拿不到任何错误信号，
// 表现为播放器静默不动。修法是按需 allow_file，而不是把 scope 开成 **。
//
// 这里测的是授权前的那道门：扩展名白名单必须只放行 WebView 原生能解的容器，
// 否则 allow_media_asset 就成了「任意文件加进 asset 白名单」的入口。
// ============================================================

#[test]
fn test_validate_media_rejects_non_media() {
    let dir = std::env::temp_dir().join(format!("pp_media_ext_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("secrets.env");
    std::fs::write(&f, "TOKEN=1").unwrap();

    let result = validate_media_file_path(f.to_str().unwrap());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("不支持的文件类型"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_validate_media_rejects_non_native_containers() {
    // mkv / avi / mov 一律降级为「用系统播放」，不进 asset 白名单：
    // 放进来只会得到一个能生成、但 WebView 播不动的 asset:// URL。
    let dir = std::env::temp_dir().join(format!("pp_media_nn_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["a.mkv", "b.avi", "c.mov", "d.wmv", "e.flv"] {
        let f = dir.join(name);
        std::fs::write(&f, b"\0").unwrap();
        assert!(
            validate_media_file_path(f.to_str().unwrap()).is_err(),
            "{name} 不应通过校验"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_validate_media_accepts_native_and_is_case_insensitive() {
    let dir = std::env::temp_dir().join(format!("pp_media_ok_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["clip.MP4", "song.mp3", "voice.M4A", "raw.wav"] {
        let f = dir.join(name);
        std::fs::write(&f, b"\0").unwrap();
        assert!(
            validate_media_file_path(f.to_str().unwrap()).is_ok(),
            "{name} 应通过校验"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}
