//! HTML 图片本地化共享模块（规则 #11 收口）。
//!
//! 两个消费方：
//! - `clipboard_monitor`：采集剪贴板 CF_HTML 时把**本地**图片（data:/file:/盘符）
//!   立即抄进图片库——来源应用的临时文件随时会被清理，必须当场落盘；
//! - `commands::url_summary::fetch_url_article`：抓取网页文章后把**远程**图片
//!   （http(s)）下载落盘——微信等图床有防盗链，引用外链的笔记离线即挂。
//!
//! 本地分支从 `clipboard_monitor` 原样迁入（行为零改动，测试随迁）；
//! 远程下载只存在于 async 的 [`localize_article_images`]——剪贴板采集线程没有
//! tokio 运行时，sync 版遇到 http(s) 一律保留原样返回 None（原口径不变）。

use std::path::{Path, PathBuf};

use regex::Regex;
use std::sync::LazyLock;

use crate::hashing::md5_hex;

/// 匹配 <img src="..."> 或 <img src='...'>（大小写不敏感）。
pub(crate) static IMG_SRC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap());

/// 单个 `<img …>` 标签（用于整标签改写，而非只抓属性值）。
static IMG_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<img\b[^>]*>").unwrap());

/// 标签内带值的属性（name="v" / name='v' / name=裸值）。
static HTML_ATTR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});

/// 提取 HTML 片段里所有 <img src> 的原始值（不判断是否本地/远程，不改写）。
/// 调用方：`data_store::history` 删除历史时反推关联图片文件做孤儿清理。
pub(crate) fn extract_img_srcs(fragment: &str) -> Vec<String> {
    IMG_SRC_RE
        .captures_iter(fragment)
        .filter_map(|cap| cap.get(1).or_else(|| cap.get(2)).map(|m| m.as_str().to_string()))
        .collect()
}

/// 尝试把单个 img src（本地文件路径 / file:// / data: URI）落盘到图片库，
/// 返回新文件的绝对路径。远程 http(s) 引用返回 None（采集线程不下载，
/// 远程下载走 async 的 [`localize_article_images`]）。
pub(crate) fn localize_one_image(src: &str, images_dir: &Path) -> Option<PathBuf> {
    let bytes: Vec<u8> = if src.starts_with("data:") {
        // 格式如 data:image/png;base64,xxxx；非 base64 的 data URI（罕见）不处理
        if !src.contains(";base64,") {
            return None;
        }
        let comma = src.find(',')?;
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &src[comma + 1..]).ok()?
    } else if src.starts_with("file:") {
        // Word/Outlook/浏览器常见写法：本地临时文件的 file:// 引用，来源应用
        // 清理临时文件后这个路径就失效，所以必须在采集那一刻立即读出来。
        let url = url::Url::parse(src).ok()?;
        let path = url.to_file_path().ok()?;
        std::fs::read(&path).ok()?
    } else if src.len() > 1 && src.as_bytes()[1] == b':' {
        // 裸盘符路径（少数应用不带 file:// 前缀，如 C:\Users\...\image.png）
        std::fs::read(src).ok()?
    } else {
        // http(s) 等远程引用：采集路径不下载，保留原始 src 不报错
        return None;
    };

    if bytes.is_empty() {
        return None;
    }
    Some(save_image_bytes(&bytes, images_dir)?)
}

/// 把图片字节落盘（md5 命名去重），返回文件绝对路径。
fn save_image_bytes(bytes: &[u8], images_dir: &Path) -> Option<PathBuf> {
    let ext = image::guess_format(bytes)
        .ok()
        .and_then(|fmt| fmt.extensions_str().first().copied())
        .unwrap_or("png");
    let hash = md5_hex(bytes);
    if let Err(e) = std::fs::create_dir_all(images_dir) {
        log::error!("[HtmlImages] 创建图片目录失败: {}", e);
        return None;
    }
    let file_path = images_dir.join(format!("{}.{}", hash, ext));
    if !file_path.exists() {
        if let Err(e) = std::fs::write(&file_path, bytes) {
            log::error!("[HtmlImages] 写入图片失败: {}", e);
            return None;
        }
    }
    Some(file_path)
}

/// 把片段里所有本地文件/data URI 图片抄一份进自己的图片库，并把 <img src>
/// 改写为新路径（远程 http(s) 引用原样保留）。逐个处理 img 标签，支持
/// 任意多图/任意顺序交错的图文混排片段。
/// 返回 (改写后的片段, 落盘的图片文件路径列表)
pub(crate) fn localize_html_images(fragment: &str, images_dir: &Path) -> (String, Vec<PathBuf>) {
    let mut saved_paths = Vec::new();
    let mut result = String::with_capacity(fragment.len());
    let mut last_end = 0usize;

    for cap in IMG_SRC_RE.captures_iter(fragment) {
        let Some(src_match) = cap.get(1).or_else(|| cap.get(2)) else {
            continue;
        };
        let src = src_match.as_str();

        result.push_str(&fragment[last_end..src_match.start()]);

        match localize_one_image(src, images_dir) {
            Some(new_path) => {
                saved_paths.push(new_path.clone());
                let new_src = new_path.to_string_lossy().replace('\\', "/");
                result.push_str(&format!("file:///{}", new_src));
            }
            None => {
                result.push_str(src);
            }
        }
        last_end = src_match.end();
    }
    result.push_str(&fragment[last_end..]);
    (result, saved_paths)
}

/// 单图下载上限。文章配图极少超过几 MB，这条只拦被诱导下载的大文件。
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// 下载一张远程图片并落盘。403/451 时带 Referer 重试一次——微信等图床的
/// 防盗链按「请求来自哪个页面」放行，服务端直接下载多数不需要 Referer
/// （2026-10-05 实测 mmbiz.qpic.cn 无 Referer 即 200），带上是兜底。
async fn download_remote_image(
    client: &reqwest::Client,
    src: &str,
    referer: Option<&str>,
    images_dir: &Path,
) -> Option<PathBuf> {
    let resp = client.get(src).send().await;
    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        Ok(r) if r.status().as_u16() == 403 || r.status().as_u16() == 451 => {
            let Some(ref_tag) = referer else {
                return None;
            };
            let retried = client
                .get(src)
                .header(reqwest::header::REFERER, ref_tag)
                .send()
                .await
                .ok()?;
            if !retried.status().is_success() {
                log::warn!("[HtmlImages] 图片下载失败（含 Referer 重试后）: {} → {}", src, retried.status());
                return None;
            }
            retried
        }
        Ok(r) => {
            log::warn!("[HtmlImages] 图片下载失败: {} → {}", src, r.status());
            return None;
        }
        Err(e) => {
            log::warn!("[HtmlImages] 图片请求失败: {} → {}", src, e);
            return None;
        }
    };
    if let Some(len) = resp.content_length() {
        if len > MAX_IMAGE_BYTES as u64 {
            return None;
        }
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    save_image_bytes(&bytes, images_dir)
}

/// 解析 `<img …>` 标签里的属性（名小写）。正则一次抓一个属性，
/// 避免「src 与 data-src 谁在前」影响匹配顺序——属性优先级由调用方定。
fn img_attrs(tag: &str) -> Vec<(String, String)> {
    HTML_ATTR_RE
        .captures_iter(tag)
        .filter_map(|c| {
            let name = c.get(1)?.as_str().to_ascii_lowercase();
            let value = c
                .get(2)
                .or_else(|| c.get(3))
                .or_else(|| c.get(4))
                .map(|m| m.as_str().to_string())?;
            Some((name, value))
        })
        .collect()
}

/// 从 `<img …>` 标签里取出真实图片地址：data-src 优先（懒加载真实地址），
/// 其次 src；两者都空/缺失返回 None。
fn img_tag_src(tag: &str) -> Option<String> {
    let attrs = img_attrs(tag);
    let pick = |want: &str| {
        attrs
            .iter()
            .find(|(n, _)| n == want)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.trim().is_empty())
    };
    pick("data-src").or_else(|| pick("src"))
}

/// 重建 `<img …>` 标签：src 指向本地文件、丢弃 data-src，其余属性
/// （alt/class 等，前端转换器要用 alt）按原顺序保留。
fn rewrite_img_tag(tag: &str, new_src: &str) -> String {
    let mut out = String::from("<img");
    for (name, value) in img_attrs(tag) {
        if name == "src" || name == "data-src" {
            continue;
        }
        out.push_str(&format!(" {}=\"{}\"", name, value.replace('"', "&quot;")));
    }
    out.push_str(&format!(" src=\"{}\"", new_src));
    out.push('>');
    out
}

/// 抓取文章 HTML 的图片本地化（async，只在 tokio 运行时里调用）。
/// data:/file:/盘符 走本地分支；http(s) 下载落盘（403 带 Referer 重试）。
/// 下载失败/超限的图片保留原始远程地址——正文仍在，不因一张图失败丢整篇。
/// 逐张串行下载：一篇文章配图通常 ≤20 张，串行已够（并行省的秒数不值得
/// 引入并发对图床的突发压力）。
pub async fn localize_article_images(
    html: &str,
    images_dir: &Path,
    client: &reqwest::Client,
    referer: Option<&str>,
) -> String {
    let mut result = String::with_capacity(html.len());
    let mut last_end = 0usize;
    for m in IMG_TAG_RE.find_iter(html) {
        let tag = m.as_str();
        let Some(src) = img_tag_src(tag) else {
            continue;
        };
        result.push_str(&html[last_end..m.start()]);
        let localized = if src.starts_with("http://") || src.starts_with("https://") {
            download_remote_image(client, &src, referer, images_dir).await
        } else {
            localize_one_image(&src, images_dir)
        };
        match localized {
            Some(path) => {
                let new_src = path.to_string_lossy().replace('\\', "/");
                result.push_str(&rewrite_img_tag(tag, &format!("file:///{}", new_src)));
            }
            None => result.push_str(tag),
        }
        last_end = m.end();
    }
    result.push_str(&html[last_end..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 透明 PNG 的 base64 编码（测试用最小合法 PNG）
    const TEST_PNG_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    #[test]
    fn test_localize_one_image_data_uri() {
        let dir = std::env::temp_dir().join(format!("pastepanda_test_{}", uuid::Uuid::new_v4()));
        let src = format!("data:image/png;base64,{}", TEST_PNG_BASE64);
        let saved = localize_one_image(&src, &dir).expect("应能解码 data URI 并落盘");
        assert!(saved.exists());
        assert_eq!(saved.extension().and_then(|e| e.to_str()), Some("png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_localize_one_image_file_url_before_source_cleans_up() {
        // 模拟 Word/浏览器场景：源应用的临时图片文件存在于采集那一刻，
        // 必须立即读出抄走，后续源文件被删除也不影响已落盘的副本。
        let source_dir = std::env::temp_dir().join(format!("pastepanda_src_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&source_dir).unwrap();
        let source_file = source_dir.join("image001.png");
        use base64::Engine;
        let png_bytes =
            base64::engine::general_purpose::STANDARD.decode(TEST_PNG_BASE64).unwrap();
        std::fs::write(&source_file, &png_bytes).unwrap();

        let images_dir =
            std::env::temp_dir().join(format!("pastepanda_images_{}", uuid::Uuid::new_v4()));
        let file_url = url::Url::from_file_path(&source_file).unwrap();
        let saved = localize_one_image(file_url.as_str(), &images_dir)
            .expect("应能读出 file:// 本地图片并落盘");
        assert!(saved.exists());
        assert_eq!(std::fs::read(&saved).unwrap(), png_bytes);

        // 源文件删除后，落盘的副本仍完好保留（验证"采集时即时抄走"确实有效）
        let _ = std::fs::remove_dir_all(&source_dir);
        assert!(saved.exists());

        let _ = std::fs::remove_dir_all(&images_dir);
    }

    #[test]
    fn test_localize_one_image_remote_url_untouched() {
        let dir = std::env::temp_dir().join(format!("pastepanda_test_{}", uuid::Uuid::new_v4()));
        assert!(localize_one_image("https://example.com/pic.png", &dir).is_none());
        assert!(!dir.exists());
    }

    #[test]
    fn test_localize_html_images_multiple_interleaved() {
        // 验证任意多图/任意交错的图文混排场景：文字 + 图片 + 图片 + 文字
        let images_dir =
            std::env::temp_dir().join(format!("pastepanda_multi_{}", uuid::Uuid::new_v4()));
        let data_src = format!("data:image/png;base64,{}", TEST_PNG_BASE64);
        let fragment = format!(
            "<p>前段文字</p><img src=\"{}\"><img src=\"{}\"><p>后段文字</p><img src=\"https://remote.example/x.png\">",
            data_src, data_src
        );
        let (rewritten, saved) = localize_html_images(&fragment, &images_dir);

        assert_eq!(
            saved.len(),
            2,
            "两张 data URI 图片都应落盘（同内容同 hash同文件，但均计入返回列表）"
        );
        assert!(rewritten.contains("前段文字"));
        assert!(rewritten.contains("后段文字"));
        // 远程引用保持原样
        assert!(rewritten.contains("https://remote.example/x.png"));
        // 本地化后的图片引用不再指向 data:
        assert_eq!(rewritten.matches("data:image/png").count(), 0);
        assert_eq!(rewritten.matches("file:///").count(), 2);

        let _ = std::fs::remove_dir_all(&images_dir);
    }

    #[test]
    fn test_img_tag_src_prefers_data_src() {
        assert_eq!(
            img_tag_src(r#"<img src="https://p/1px.gif" data-src="https://real/a.jpg">"#),
            Some("https://real/a.jpg".to_string())
        );
        assert_eq!(
            img_tag_src(r#"<img alt="x" src="https://only/s.png">"#),
            Some("https://only/s.png".to_string())
        );
    }

    #[test]
    fn test_rewrite_img_tag_keeps_alt_drops_data_src() {
        let out = rewrite_img_tag(
            r#"<img src="https://p/1px.gif" data-src="https://real/a.jpg" alt="配图">"#,
            "file:///C:/images/x.jpg",
        );
        assert!(out.contains(r#"src="file:///C:/images/x.jpg""#));
        assert!(out.contains(r#"alt="配图""#));
        assert!(!out.contains("data-src"));
        assert!(!out.contains("1px.gif"));
    }
}
