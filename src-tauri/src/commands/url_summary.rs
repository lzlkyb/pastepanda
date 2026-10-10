//! 链接摘要（v6.4 六大王牌 A）——Rust 端抓页 + 轻量正文提取。
//!
//! 阶段 1：**本地零 AI 成本**。抓取网页 → 提取标题 + 正文 → 返回粗摘要。
//! 阶段 2（后置）：有 AI 时前端走 ai_run 精炼为 100-200 字（受 AI 门控规则约束）。
//!
//! 设计：
//! - **URL 白名单**：复用 open_url 的 http/https 校验，杜绝 file:// 等协议；
//! - **只存内存不落盘**（同 ai 缓存哲学）：抓取结果不写数据库，无明文副本；
//! - **24h 内存缓存**：同一 URL 不重复抓取，上限 200 条防内存膨胀；
//! - **正文提取**：scraper 去噪音标签（script/style/nav/footer/aside…），
//!   收拢段落文本，截断 800 字符返回——不引重型 readability 库。
//!
//! 「文章 → 知识库」阶段 2 在本文件加了 `fetch_url_article`：抓整页 →
//! 定位文章根节点返回**不截断的 HTML**（清洗在前端转换器做）→ 图片落盘。
//! 与摘要命令共用同一套 SSRF 防护 / 限流 / 客户端构造（规则 #11）。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, State};

use crate::data_store::DataStore;

/// 返回给前端的摘要数据
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlSummary {
    pub url: String,
    pub title: String,
    /// 正文粗文本（截断，前端展示/精炼用）
    pub text: String,
}

/// 返回给前端的**文章全文**数据（「文章 → 知识库」阶段 2）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlArticle {
    /// 重定向后的最终 URL（笔记里记「来源」用它，比入参更真实）
    pub url: String,
    pub title: String,
    /// 作者/公众号名（og:article:author，微信有、一般站点可能为空）
    pub author: String,
    /// 正文根节点 HTML（未截断）。图片已本地化为 file:/// 路径；
    /// 噪声清洗（导航/隐藏节点）在前端转换器 htmlToMarkdown 里做——清洗逻辑
    /// 只有一份（规则 #11），剪贴板 CF_HTML 转笔记走的是同一个函数。
    pub html: String,
}

// ===== 内存缓存（24h，不落盘） =====

struct CachedFetch {
    value: UrlSummary,
    at: Instant,
}

static URL_CACHE: LazyLock<Mutex<HashMap<String, CachedFetch>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct CachedArticle {
    value: UrlArticle,
    at: Instant,
}

/// 文章缓存与摘要缓存分开：单篇文章 HTML 可达数百 KB，条目上限比摘要小一个量级，
/// 防 200 篇长文把内存吃穿。
static ARTICLE_CACHE: LazyLock<Mutex<HashMap<String, CachedArticle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const MAX_ARTICLE_ENTRIES: usize = 50;

const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_ENTRIES: usize = 200;
/// 正文返回上限（字符）
const MAX_BODY_CHARS: usize = 800;
/// 抓取超时
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);
/// 响应体上限（防恶意大页面拖垮内存）
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

fn cache_get(url: &str) -> Option<UrlSummary> {
    if let Ok(mut guard) = URL_CACHE.lock() {
        // 清理过期条目
        guard.retain(|_, c| c.at.elapsed() < CACHE_TTL);
        if let Some(c) = guard.get(url) {
            if c.at.elapsed() < CACHE_TTL {
                return Some(c.value.clone());
            }
        }
    }
    None
}

fn cache_put(url: String, value: UrlSummary) {
    if let Ok(mut guard) = URL_CACHE.lock() {
        guard.retain(|_, c| c.at.elapsed() < CACHE_TTL);
        if guard.len() >= MAX_ENTRIES {
            // 淘汰最早写入的（先取出 key 再删，避免迭代借用与 remove 冲突）
            let oldest = guard
                .iter()
                .min_by_key(|(_, c)| c.at)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                guard.remove(&k);
            }
        }
        guard.insert(
            url,
            CachedFetch {
                value,
                at: Instant::now(),
            },
        );
    }
}

fn article_cache_get(url: &str) -> Option<UrlArticle> {
    if let Ok(mut guard) = ARTICLE_CACHE.lock() {
        guard.retain(|_, c| c.at.elapsed() < CACHE_TTL);
        if let Some(c) = guard.get(url) {
            return Some(c.value.clone());
        }
    }
    None
}

fn article_cache_put(url: String, value: UrlArticle) {
    if let Ok(mut guard) = ARTICLE_CACHE.lock() {
        guard.retain(|_, c| c.at.elapsed() < CACHE_TTL);
        if guard.len() >= MAX_ARTICLE_ENTRIES {
            let oldest = guard
                .iter()
                .min_by_key(|(_, c)| c.at)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                guard.remove(&k);
            }
        }
        guard.insert(
            url,
            CachedArticle {
                value,
                at: Instant::now(),
            },
        );
    }
}

// ===== 正文提取（轻量 readability） =====

/// 抓取 + 提取（纯函数，供单测直接喂 HTML）。
fn extract_from_html(url: &str, body: &str) -> UrlSummary {
    use scraper::{Html, Selector};

    let doc = Html::parse_document(body);

    // 标题
    let title = Selector::parse("title")
        .ok()
        .and_then(|sel| {
            doc.select(&sel)
                .next()
                .map(|e| e.text().collect::<String>())
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    // 收拢段落/列表文本（文章正文主要在这两处；script/style/nav 的文本不在 p/li 里，
    // 天然被跳过——不依赖 DOM 删除）。空行分隔。
    let mut parts: Vec<String> = Vec::new();
    // 不需要 mut：parts 是参数传进来的，闭包本身不捕获可变状态
    let push_block = |t: &str, parts: &mut Vec<String>| {
        let cleaned = t.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned.chars().count() >= 20 {
            parts.push(cleaned);
        }
    };
    if let Ok(p_sel) = Selector::parse("p") {
        for el in doc.select(&p_sel) {
            let t = el.text().collect::<String>();
            push_block(&t, &mut parts);
        }
    }
    if parts.is_empty() {
        if let Ok(li_sel) = Selector::parse("li") {
            for el in doc.select(&li_sel) {
                let t = el.text().collect::<String>();
                push_block(&t, &mut parts);
            }
        }
    }
    if parts.is_empty() {
        // 兜底：整个 body 的文本（可能含导航，但比空结果好）
        if let Ok(body_sel) = Selector::parse("body") {
            if let Some(body_el) = doc.select(&body_sel).next() {
                let t = body_el.text().collect::<String>();
                parts.push(t.split_whitespace().collect::<Vec<_>>().join(" "));
            }
        }
    }

    let mut text = parts.join("\n");
    if text.chars().count() > MAX_BODY_CHARS {
        text = text.chars().take(MAX_BODY_CHARS).collect();
    }

    UrlSummary {
        url: url.to_string(),
        title,
        text,
    }
}

/// 文章根节点的候选选择器，按优先级排。
/// 微信公众号正文在 `#js_content`；一般站点是 `<article>` / `<main>` /
/// `[role=main]`；全不中就退 body（让前端转换器兜底清洗）。
const ARTICLE_ROOT_SELECTORS: [&str; 4] = ["#js_content", "article", "main", "[role=main]"];

/// 从整页 HTML 里提取 (标题, 作者, 正文根节点 HTML)。
///
/// 标题：og:title meta 优先（微信/社交站点的 `<title>` 常带站点后缀，og:title 更干净）
/// 作者：og:article:author（微信公众号名）。
/// 正文：只定位**根节点并返回它的 HTML**——导航/脚本/隐藏节点的清洗不在这里做，
/// 前端 htmlToMarkdown 是所有 HTML（CF_HTML + 抓取页）唯一的清洗出口（规则 #11）。
/// 纯函数，供单测直接喂 HTML。
pub(crate) fn extract_article_from_html(body: &str) -> (String, String, String) {
    use scraper::{Html, Selector};

    let doc = Html::parse_document(body);

    let meta_content = |sel: &str| -> String {
        Selector::parse(sel)
            .ok()
            .and_then(|s| doc.select(&s).next())
            .and_then(|el| el.value().attr("content"))
            .unwrap_or("")
            .trim()
            .to_string()
    };

    let title = {
        let og = meta_content(r#"meta[property="og:title"]"#);
        if og.is_empty() {
            Selector::parse("title")
                .ok()
                .and_then(|s| doc.select(&s).next())
                .map(|e| e.text().collect::<String>())
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            og
        }
    };
    let author = meta_content(r#"meta[property="og:article:author"]"#);

    let mut root_html = String::new();
    for sel_str in ARTICLE_ROOT_SELECTORS {
        let Ok(sel) = Selector::parse(sel_str) else {
            continue;
        };
        if let Some(el) = doc.select(&sel).next() {
            // 🔴 必须取 **inner_html** 而不是外层 html：微信公众号把
            // `visibility: hidden; opacity: 0` 写在 #js_content 根节点自己身上
            // （页面 JS 加载后才显示的反爬渲染手法），外层序列化会把这个样式
            // 一起带回去，前端转换器「隐藏节点整棵丢弃」的规则就会把**整篇
            // 正文**连根丢掉——实测抓到的文章转出空内容（2026-10-05）。
            // 内层序列化剥掉根包装，正文内部的毒文本丢弃不受影响。
            root_html = el.inner_html();
            break;
        }
    }
    if root_html.is_empty() {
        if let Ok(body_sel) = Selector::parse("body") {
            if let Some(el) = doc.select(&body_sel).next() {
                root_html = el.inner_html();
            }
        }
    }

    (title, author, root_html)
}

/// 抓取专用的协议白名单：**只放 http/https**。
///
/// 不复用 `is_allowed_open_url`——那个是给「打开 URL」用的，它放行 `mailto:`
/// （在那个场景合理），而抓取一个 mailto 毫无意义。之前没出事是靠第二道
/// `host_str()` 返 None 兜住的，属于**巧合而非设计**：哪天第二道放宽，第一道就漏。
fn is_fetchable_url(url: &str) -> bool {
    let t = url.trim();
    t.starts_with("http://") || t.starts_with("https://")
}

/// 审查 backlog：#14 抓取 SSRF 防护 —— 剪贴板诱饵 URL 可能指向内网/保留地址
/// （localhost、192.168.*、10.* 等），抓取就等于替攻击者探测内网。这里拦截字面 IP
/// 的私有段与常见保留主机名（域名不解析，避免 DNS rebinding 面扩大）。
pub(crate) fn url_host_blocked(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url.trim()) else {
        return true;
    };
    let Some(host) = u.host_str() else {
        return true;
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    // `host_str()` 对 IPv6 返回的是**带方括号**的形式（如 `"[::1]"`），
    // 而 `IpAddr::parse` 不接受方括号。不先去掉的话下面整段 IPv6 处理
    // （unique-local / v4-mapped）**从来不会执行**——它们看着周全，实际是死代码，
    // 实测 `http://[::1]/` 直接放行。
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
            return true;
        }
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_private() || v4.is_link_local() {
                    return true;
                }
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_unique_local() {
                    return true;
                }
                if let Some(v4) = v6.to_ipv4_mapped() {
                    if v4.is_private() || v4.is_link_local() || v4.is_loopback() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// 抓取专用的 HTTP 客户端（两个命令共用，规则 #11）。
///
/// **重定向必须逐跳重查**。之前没设 policy，reqwest 默认跟随最多 10 次，
/// 而校验只在初始 URL 上做一次——于是
///     http://evil.com/ → 302 → http://192.168.1.1/admin
/// 就能完整绕过整个 SSRF 防护，而诱饵 URL 是攻击者完全可控的。
///
/// 为何不简单地 `Policy::none()`：http→https 的重定向太普遍，
/// 一律禁掉会让这个功能对一大片站点失效。
pub(crate) fn build_fetch_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error(std::io::Error::other("重定向次数过多"));
            }
            if url_host_blocked(attempt.url().as_str()) {
                return attempt.error(std::io::Error::other("重定向到了本地/内网地址"));
            }
            attempt.follow()
        }))
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PastePanda/5.10",
        )
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 抓取 URL（带流式限流），返回 (重定向后的最终 URL, 响应体文本)。
/// 审查 backlog：#6 流式限流 —— 先看 Content-Length 快速拒绝，再边读边计数，
/// 恶意大页不会整块进内存（此前先全量下载再判上限）。
pub(crate) async fn fetch_page_and_body(
    client: &reqwest::Client,
    url: &str,
) -> Result<(String, String), String> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("抓取失败（站点可能反爬或需要登录）: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("页面返回 HTTP {}", resp.status()));
    }

    if let Some(len) = resp.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err("页面过大，已放弃抓取".to_string());
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取页面失败: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BODY_BYTES {
            return Err("页面过大，已放弃抓取".to_string());
        }
    }
    Ok((resp.url().to_string(), String::from_utf8_lossy(&bytes).into_owned()))
}

/// 抓取 URL 并返回粗摘要（阶段 1：本地，无 LLM）。
#[tauri::command]
pub async fn fetch_url_summary(
    _store: State<'_, DataStore>,
    url: String,
) -> Result<UrlSummary, String> {
    if url.len() > 2048 || !is_fetchable_url(&url) {
        return Err("仅支持 http/https 链接".to_string());
    }
    if url_host_blocked(&url) {
        return Err("不支持本地/内网地址".to_string());
    }

    if let Some(cached) = cache_get(&url) {
        return Ok(cached);
    }

    let client = build_fetch_client()?;
    let (final_url, body) = fetch_page_and_body(&client, &url).await?;
    let result = extract_from_html(&final_url, &body);

    // 空正文也算成功（标题可能有用），但给前端区分：text 为空时前端提示"页面无可读内容"
    cache_put(url, result.clone());
    Ok(result)
}

/// 抓取文章全文（「文章 → 知识库」阶段 2）。
///
/// 与 [`fetch_url_summary`] 的差别：正文提取目标是**根节点 HTML**（不截断、
/// 不丢图片），噪声清洗交给前端 htmlToMarkdown（与剪贴板 CF_HTML 同一条
/// 清洗路径）；图片在这里下载落盘并改写为 file:/// 引用。
#[tauri::command]
pub async fn fetch_url_article(
    app: tauri::AppHandle,
    _store: State<'_, DataStore>,
    url: String,
) -> Result<UrlArticle, String> {
    if url.len() > 2048 || !is_fetchable_url(&url) {
        return Err("仅支持 http/https 链接".to_string());
    }
    if url_host_blocked(&url) {
        return Err("不支持本地/内网地址".to_string());
    }

    if let Some(cached) = article_cache_get(&url) {
        return Ok(cached);
    }

    let client = build_fetch_client()?;
    let (final_url, body) = fetch_page_and_body(&client, &url).await?;
    let (title, author, root_html) = extract_article_from_html(&body);

    if root_html.is_empty() {
        return Err("页面没有可提取的文章正文（可能需登录或是纯脚本渲染）".to_string());
    }

    // 图片本地化。目录解析失败则跳过（保留远程 src），正文照常返回——
    // 一篇没图的文章比一篇报错的文章有用。
    let html = match app.path().app_data_dir() {
        Ok(app_dir) => {
            let images_dir = app_dir.join("images");
            crate::html_images::localize_article_images(
                &root_html,
                &images_dir,
                &client,
                Some(final_url.as_str()),
            )
            .await
        }
        Err(e) => {
            log::warn!("[UrlArticle] 应用数据目录不可用，图片保留远程引用: {}", e);
            root_html
        }
    };

    let article = UrlArticle {
        url: final_url,
        title,
        author,
        html,
    };
    article_cache_put(url, article.clone());
    Ok(article)
}

/// 仅供测试：清空 URL 缓存
pub fn __clear_url_cache_for_test() {
    if let Ok(mut guard) = URL_CACHE.lock() {
        guard.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 抓取的协议白名单必须只放 http/https。
    ///
    /// 之前复用的 `is_allowed_open_url` 会放行 `mailto:`，靠第二道 host 检查兜住——
    /// 那是巧合不是设计。这条测试把第一道门自己钉住。
    #[test]
    fn test_only_http_is_fetchable() {
        assert!(is_fetchable_url("http://example.com/a"));
        assert!(is_fetchable_url(" https://example.com/a "));
        assert!(!is_fetchable_url("mailto:a@b.com"));
        assert!(!is_fetchable_url("file:///C:/Windows/win.ini"));
        assert!(!is_fetchable_url("ftp://example.com/x"));
        assert!(!is_fetchable_url(""));
    }

    /// SSRF 防护：字面内网/保留地址必须被拦。
    ///
    /// 重定向逐跳重查用的是同一个函数，所以这里每一条也同时是
    /// “http://evil.com → 302 → 内网” 那条绕过路径的回归。
    #[test]
    fn test_ssrf_blocks_internal_hosts() {
        for bad in [
            "http://localhost/",
            "http://foo.localhost/",
            "http://nas.local/",
            "http://127.0.0.1/",
            "http://0.0.0.0/",
            "http://192.168.1.1/admin",
            "http://10.0.0.5/",
            "http://172.16.0.1/",
            // 云厂商元数据端点——拓到就可能拿到临时凭证
            "http://169.254.169.254/latest/meta-data/",
            // IPv6：host_str() 带方括号，不先剥掉的话整段 IPv6 处理都是死代码
            "http://[::1]/",
            "http://[fd00::1]/",            // unique-local
            "http://[::ffff:192.168.1.1]/", // v4-mapped 的私有地址
            "mailto:a@b.com",               // 没有 host → 也该拦
        ] {
            assert!(url_host_blocked(bad), "应该拦住：{bad}");
        }
        for ok in ["http://example.com/", "https://8.8.8.8/"] {
            assert!(!url_host_blocked(ok), "不应该拦：{ok}");
        }
    }

    #[test]
    fn extract_title_and_paragraphs() {
        let html = r#"<html><head><title>测试文章标题</title></head>
            <body>
                <nav>导航不要</nav>
                <p>这是一段足够长的正文内容，介绍今天发生的重要事情，超过了二十个字符。</p>
                <p>第二段正文同样足够长，继续介绍后续的发展情况。</p>
                <footer>版权信息不需要</footer>
            </body></html>"#;
        let s = extract_from_html("https://example.com/a", html);
        assert_eq!(s.title, "测试文章标题");
        assert!(s.text.contains("这是一段足够长的正文内容"));
        assert!(s.text.contains("第二段正文同样足够长"));
        assert!(!s.text.contains("导航不要"), "nav 内容不应进入正文");
        assert!(!s.text.contains("版权信息"), "footer 内容不应进入正文");
    }

    #[test]
    fn extract_skips_script_content() {
        let html = r#"<html><head><title>标题</title></head><body>
            <script>var secret = "不要泄露的脚本内容";</script>
            <p>这是页面真正的一段足够长的正文，用来验证脚本内容被过滤掉。</p>
        </body></html>"#;
        let s = extract_from_html("https://example.com/b", html);
        assert!(
            !s.text.contains("不要泄露的脚本内容"),
            "script 内容不应进入正文"
        );
        assert!(s.text.contains("真正的一段足够长"));
    }

    #[test]
    fn extract_falls_back_to_body_when_no_paragraphs() {
        let html = r#"<html><head><title>无段落页</title></head>
            <body>这个页面没有使用 p 标签，只有一段很长的裸文本内容用于验证兜底逻辑是否正常工作。</body></html>"#;
        let s = extract_from_html("https://example.com/c", html);
        assert_eq!(s.title, "无段落页");
        assert!(s.text.contains("没有使用 p 标签"));
    }

    #[test]
    fn extract_truncates_long_body() {
        let long_para = "字".repeat(2000);
        let html = format!(
            r#"<html><head><title>长文</title></head><body><p>{}</p></body></html>"#,
            long_para
        );
        let s = extract_from_html("https://example.com/d", &html);
        assert!(s.text.chars().count() <= MAX_BODY_CHARS);
    }

    // ── 文章全文提取（fetch_url_article 的纯函数部分）──

    #[test]
    fn article_extracts_wechat_shape() {
        // 微信公众号文章的实测结构：og:title / og:article:author / #js_content
        let html = r#"<html><head>
            <meta property="og:title" content="一下子来了5个互选广告！"/>
            <meta property="og:article:author" content="我是珺珺吖"/>
            <title>页面前缀 - 一下子来了5个互选广告！</title>
            </head><body>
            <div class="rich_media_area_extra">推荐位杂质</div>
            <div id="js_content"><h2>小节</h2><p>正文段落，内含<a href="https://mp.weixin.qq.com/s?x=1">旧文链接</a>。</p></div>
            </body></html>"#;
        let (title, author, root) = extract_article_from_html(html);
        assert_eq!(title, "一下子来了5个互选广告！", "og:title 优先于带站点后缀的 title");
        assert_eq!(author, "我是珺珺吖");
        assert!(!root.contains(r#"id="js_content""#), "应返回内层 HTML，根包装（连同它身上的样式）不带走");
        assert!(root.contains("正文段落"));
        assert!(!root.contains("推荐位杂质"), "根节点外的杂质不该带进来");
    }

    #[test]
    fn article_wechat_hidden_root_does_not_swallow_content() {
        // 🔴 回归钉子（2026-10-05 实测翻车）：微信把 visibility:hidden/opacity:0
        // 写在 #js_content 根节点自己身上。外层序列化会把它带回去，前端
        // 「隐藏节点整棵丢弃」就会把整篇正文连根丢掉，转出空内容。
        // inner_html 之后，根样式留在门外，正文完整保留。
        let html = r#"<html><body>
            <div id="js_content" style="visibility: hidden; opacity: 0; ">
                <p>这是正文第一段，足够长可以过清洗。</p>
                <p>这是正文第二段。</p>
            </div>
            </body></html>"#;
        let (_, _, root) = extract_article_from_html(html);
        assert!(!root.contains("visibility"), "根节点的隐藏样式不得进入返回的 HTML");
        assert!(root.contains("正文第一段"));
        assert!(root.contains("正文第二段"));
    }

    #[test]
    fn article_root_priority_and_fallback() {
        // 无 js_content 时选 article；连 article 都没有退 body
        let with_article = r#"<html><body><nav>导航</nav><article><p>文章主体内容足够长。</p></article></body></html>"#;
        let (title, _, root) = extract_article_from_html(with_article);
        assert_eq!(title, ""); // 没有 og:title 也没有 title 标签
        // inner_html：article 包装不带出去（但 nav 在 article 外，也不该进来）
        assert!(root.starts_with("<p>"));
        assert!(root.contains("文章主体内容足够长。"));
        assert!(!root.contains("导航"));

        let bare = r#"<html><head><title>裸页</title></head><body><p>只有 body 的页面。</p></body></html>"#;
        let (title, _, root) = extract_article_from_html(bare);
        assert_eq!(title, "裸页");
        assert!(root.contains("只有 body 的页面"));
    }

    #[test]
    fn article_title_falls_back_to_title_tag() {
        let html = r#"<html><head><title>普通站点标题</title></head>
            <body><main><p>主体内容。</p></main></body></html>"#;
        let (title, _, root) = extract_article_from_html(html);
        assert_eq!(title, "普通站点标题");
        assert!(root.contains("主体内容。"));
        assert!(!root.contains("<main"), "main 包装不带走（inner_html）");
    }
}

