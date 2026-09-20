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

// ============================================================
// 命令注册守卫（Tauri invoke_handler）
//
// 🔴 为什么必须有：`#[tauri::command] pub fn x` 声明了、`pub use` 也导出了、
//    clippy / cargo test / tsc / vitest **全都发现不了**它没进 `lib.rs` 的
//    `generate_handler!`。前端一 `invoke` 才报「命令不存在」——运行期、
//    还是在用户机器上才炸。「写完了但没接上」这类静默缺口只能靠对账单测钉住。
//
// 做法：把 `lib.rs` 与 `commands/` 下的源文件当**文本**读进来对账，不需要真启动
// 应用。目录是**递归扫**出来的，所以新增命令文件**不用改这里**——否则守卫自己
// 就变成了下一个「要人手维护」的缺口。
// ============================================================

/// 从源码文本里抽出 `#[tauri::command]` 紧跟着的那个函数名。
///
/// 只做这一件事，手写扫描比多引一个正则依赖省。
fn tauri_command_names(src: &str) -> Vec<String> {
    const MARK: &str = "#[tauri::command]";
    /// 属性与 `fn` 之间可能还夹着别的属性/空行，只看接下来这么长一段。
    const WINDOW: usize = 200;
    let mut out = Vec::new();
    let mut rest = src;
    while let Some(i) = rest.find(MARK) {
        let after = &rest[i + MARK.len()..];
        let mut end = after.len().min(WINDOW);
        while end > 0 && !after.is_char_boundary(end) {
            end -= 1;
        }
        if let Some(fi) = after[..end].find("fn ") {
            let name: String = after[fi + 3..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                out.push(name);
            }
        }
        rest = after;
    }
    out
}

fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_rs(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn test_all_tauri_commands_are_registered_in_invoke_handler() {
    let lib = include_str!("../lib.rs");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    let mut files = Vec::new();
    collect_rs(&root, &mut files);
    assert!(
        files.len() > 10,
        "没扫到 commands 源文件，路径八成写错了：{}",
        root.display()
    );

    let mut checked = 0usize;
    let mut missing = Vec::new();
    for f in &files {
        // 🔴 跳过测试文件：守卫自己的用例里必须写出 `#[tauri::command]` 这个字面量
        //    （否则没法测抽取器），扫进去就会把 `foo_bar` 这类示例名当成真命令误报。
        //    这也是为什么扫描要认「文件」而不是认「名字」。
        if f.file_name().is_some_and(|n| n == "tests.rs") {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(f) else {
            continue;
        };
        for name in tauri_command_names(&src) {
            checked += 1;
            if !lib.contains(&format!("commands::{name},")) {
                missing.push(format!("{}::{name}", f.display()));
            }
        }
    }
    // 🔴 下界守卫：扫描逻辑一旦失效（比如把 `fn ` 改了写法），这个测试会「零样本通过」，
    //    变成永远绿的空转守卫——那比没有守卫更危险。
    assert!(
        checked > 300,
        "对账样本只有 {checked} 条，扫描逻辑可能已失效，别让它空转通过"
    );
    assert!(
        missing.is_empty(),
        "这些命令声明了但没进 lib.rs 的 generate_handler!，前端一调就报「命令不存在」：{missing:#?}"
    );
}

#[test]
fn test_tauri_command_name_extractor_handles_extra_attributes() {
    let src = "#[tauri::command]\n#[specta::specta]\npub async fn foo_bar(\n    a: String,\n) -> Result<(), String> {\n    Ok(())\n}";
    assert_eq!(tauri_command_names(src), vec!["foo_bar"]);
    // 没有 `#[tauri::command]` 的普通函数不算（否则守卫会误报一大堆）
    assert!(tauri_command_names("pub fn plain() {}").is_empty());
}
