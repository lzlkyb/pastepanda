//! Public article fetching reuses the desktop extractor/client, without desktop UI or AI.
use super::url_summary::{
    build_fetch_client, extract_article_from_html, fetch_page_and_body, url_host_blocked,
};
use crate::data_store::mobile_article::{pin_article_image, ArticleImagePin};
use crate::data_store::{DataStore, MobileArticle, MobileArticleFields, MobileArticleImage, Note};
use std::{collections::HashMap, io::Write, path::Path, sync::LazyLock, time::Duration};
use tauri::{AppHandle, Manager, State};

static FETCHES: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(2));
const ARTICLE_BYTES: usize = 60 * 1024 * 1024;
const IMAGE_BYTES: usize = 10 * 1024 * 1024;

fn public_url(input: &str) -> Result<String, String> {
    crate::data_store::mobile_article::article_url_key(input)?;
    if url_host_blocked(input) {
        return Err("不支持本地或内网文章地址".into());
    }
    Ok(input.trim().into())
}

#[tauri::command]
pub fn mobile_article_begin(
    store: State<DataStore>,
    url: String,
    source_id: Option<String>,
) -> Result<MobileArticle, String> {
    let task = store.mobile_article_begin(&public_url(&url)?)?;
    match source_id {
        Some(source) => store.mobile_article_bind_source(&task.id, &source),
        None => Ok(task),
    }
}
#[tauri::command]
pub fn mobile_article_get(store: State<DataStore>, id: String) -> Result<MobileArticle, String> {
    store.mobile_article_get(&id)
}
#[tauri::command]
pub fn mobile_article_pending(store: State<DataStore>) -> Result<Vec<MobileArticle>, String> {
    store.mobile_article_pending()
}
#[tauri::command]
pub fn mobile_article_for_note(
    store: State<DataStore>,
    id: String,
) -> Result<Option<MobileArticle>, String> {
    store.mobile_article_for_note(&id)
}
#[tauri::command]
pub fn mobile_article_put(
    store: State<DataStore>,
    id: String,
    fields: MobileArticleFields,
) -> Result<MobileArticle, String> {
    store.mobile_article_put(&id, &fields)
}
#[tauri::command]
pub fn mobile_article_ack_sources(
    store: State<DataStore>,
    id: String,
    sources: Vec<String>,
) -> Result<MobileArticle, String> {
    store.mobile_article_ack_sources(&id, &sources)
}
#[tauri::command]
pub fn mobile_article_save(
    store: State<DataStore>,
    id: String,
    revision: u32,
    link_only: bool,
) -> Result<Note, String> {
    store.mobile_article_save(&id, revision, link_only)
}

async fn image_download(
    client: &reqwest::Client,
    src: &str,
    referer: &str,
    images: &Path,
    budget: usize,
) -> Result<(String, usize, ArticleImagePin), String> {
    public_url(src)?;
    let mut response = client
        .get(src)
        .header(reqwest::header::REFERER, referer)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .map_err(|_| "图片暂时无法读取")?;
    if !response.status().is_success() {
        return Err("图片来源暂时不可用".into());
    }
    let limit = budget.min(IMAGE_BYTES);
    if response.content_length().is_some_and(|v| v > limit as u64) {
        return Err("图片超过下载大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "图片读取中断")? {
        if bytes.len() + chunk.len() > limit {
            return Err("图片超过下载大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let (_, extension) =
        super::mobile_knowledge_image::validate_image_bytes(&bytes).map_err(|e| e.to_string())?;
    let name = format!("{}.{}", crate::hashing::md5_hex(&bytes), extension);
    // Ownership reaches SQLite after all initial downloads finish. Protect already
    // published files from clipboard cleanup throughout that intervening window.
    let pin = pin_article_image(&name);
    std::fs::create_dir_all(images).map_err(|_| "图片未能保存，请检查手机存储空间")?;
    // Atomic publishing prevents a killed download from leaving a valid-looking partial file.
    let target = images.join(&name);
    let temporary = images.join(format!(".article-{}.tmp", uuid::Uuid::new_v4()));
    let publish = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "图片暂存失败")?;
        file.write_all(&bytes).map_err(|_| "图片暂存失败")?;
        file.sync_all().map_err(|_| "图片暂存失败")?;
        drop(file);
        if target.exists() {
            if std::fs::symlink_metadata(&target)
                .map_err(|_| "图片保存失败")?
                .file_type()
                .is_symlink()
            {
                return Err("图片目录中出现无效引用".into());
            }
            if std::fs::read(&target).ok().is_some_and(|old| old == bytes) {
                return Ok(());
            }
            std::fs::remove_file(&target).map_err(|_| "旧图片无法更新")?;
        }
        std::fs::rename(&temporary, &target).map_err(|_| "图片保存失败，请检查手机存储空间".into())
    })();
    let _ = std::fs::remove_file(&temporary);
    publish?;
    Ok((format!("pp-asset:{name}"), bytes.len(), pin))
}

fn readable_article(title: &str, html: &str) -> bool {
    if html.len() > 512 * 1024 {
        return false;
    }
    let document = scraper::Html::parse_fragment(html);
    let text = document.root_element().text().collect::<String>();
    if text.trim().chars().count() < 20 {
        return false;
    }
    ![
        "环境异常",
        "访问验证",
        "安全验证",
        "网页无法访问",
        "文章已被删除",
    ]
    .iter()
    .any(|v| title.trim() == *v)
        && !text
            .trim()
            .starts_with("当前环境异常，完成验证后即可继续访问")
}

async fn fetch_article(
    app: &AppHandle,
    mut task: MobileArticle,
    pins: &mut Vec<ArticleImagePin>,
) -> Result<MobileArticle, String> {
    public_url(&task.url)?;
    let client = build_fetch_client()?;
    let (final_url, body) = fetch_page_and_body(&client, &task.url).await?;
    let (title, author, html) = extract_article_from_html(&body);
    if !readable_article(&title, &html) {
        return Err(
            "暂时没有取得可读正文，可能需要验证、登录，或文章已不可用。可以仅存链接。".into(),
        );
    }
    let image_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "手机存储目录不可用")?
        .join("images");
    let base = url::Url::parse(&final_url).map_err(|_| "文章地址无效")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut result = String::with_capacity(html.len());
    let mut last = 0;
    let mut images = Vec::<MobileArticleImage>::new();
    let mut seen = HashMap::<String, usize>::new();
    let mut used = 0;
    for found in crate::html_images::IMG_TAG_RE.find_iter(&html) {
        let tag = found.as_str();
        let Some(src) = crate::html_images::img_tag_src(tag) else {
            continue;
        };
        let remote = base.join(&src).map(|u| u.to_string()).unwrap_or(src);
        if images.len() >= 128 && !seen.contains_key(&remote) {
            return Err("这篇文章配图超过128张，请先仅存链接或分段收集正文".into());
        }
        let index = if let Some(index) = seen.get(&remote) {
            *index
        } else {
            let index = images.len();
            let mut image = MobileArticleImage {
                url: remote.clone(),
                local: None,
                bytes: 0,
            };
            if used < ARTICLE_BYTES && tokio::time::Instant::now() < deadline {
                if let Ok(Ok((local, bytes, pin))) = tokio::time::timeout_at(
                    deadline,
                    image_download(
                        &client,
                        &remote,
                        &final_url,
                        &image_dir,
                        ARTICLE_BYTES - used,
                    ),
                )
                .await
                {
                    pins.push(pin);
                    image.local = Some(local);
                    image.bytes = bytes;
                    used += bytes;
                }
            }
            images.push(image);
            seen.insert(remote.clone(), index);
            index
        };
        result.push_str(&html[last..found.start()]);
        result.push_str(&crate::html_images::rewrite_img_tag(
            tag,
            images[index].local.as_deref().unwrap_or(&remote),
        ));
        last = found.end();
    }
    result.push_str(&html[last..]);
    task.url = final_url;
    if task.title.is_empty() {
        task.title = title;
    }
    task.author = author;
    task.html = result;
    task.images = images;
    task.error.clear();
    Ok(task)
}

#[tauri::command]
pub async fn mobile_article_fetch(
    app: AppHandle,
    store: State<'_, DataStore>,
    id: String,
) -> Result<MobileArticle, String> {
    let _permit = FETCHES
        .try_acquire()
        .map_err(|_| "已有文章正在读取，请稍后重试")?;
    let current = store.mobile_article_get(&id)?;
    if current.note_id.is_some() && !current.saved_link_only {
        return Ok(current);
    }
    let mut pins = Vec::new();
    let result = match fetch_article(&app, current.clone(), &mut pins).await {
        Ok(task) => task,
        Err(message) => {
            let mut task = current.clone();
            task.error = message;
            task
        }
    };
    let stored = store.mobile_article_fetched(&current, result);
    drop(pins);
    stored
}

#[tauri::command]
pub async fn mobile_article_image_fetch(
    app: AppHandle,
    store: State<'_, DataStore>,
    id: String,
    index: usize,
) -> Result<MobileArticle, String> {
    let _permit = FETCHES
        .try_acquire()
        .map_err(|_| "已有图片正在读取，请稍后重试")?;
    let task = store.mobile_article_get(&id)?;
    let image = task.images.get(index).ok_or("这张图片已经变化")?;
    let used: usize = task
        .images
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, v)| v.bytes)
        .sum();
    if used >= ARTICLE_BYTES {
        return Err("这篇文章图片已达到60MB限制，请保留正文或查看原文".into());
    }
    let images = app
        .path()
        .app_data_dir()
        .map_err(|_| "手机存储目录不可用")?
        .join("images");
    let client = build_fetch_client()?;
    let (local, bytes, _pin) = image_download(
        &client,
        &image.url,
        &task.url,
        &images,
        ARTICLE_BYTES - used,
    )
    .await?;
    store.mobile_article_image_saved(&id, index, &image.url, &local, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn article_pages_reject_challenges_and_oversized_documents() {
        assert!(!readable_article(
            "环境异常",
            "<p>当前环境异常，完成验证后即可继续访问</p>"
        ));
        assert!(!readable_article("文章", "<p>短验证</p>"));
        assert!(!readable_article("文章", &"a".repeat(512 * 1024 + 1)));
        assert!(readable_article(
            "谈谈登录设计",
            "<article>这里是正常公开文章的正文，并讨论登录设计如何让用户操作更方便。</article>"
        ));
    }
    #[test]
    fn article_url_gate_covers_pages_and_image_sources() {
        for url in [
            "file:///secret.png",
            "https://user:pass@example.com/a",
            "http://127.0.0.1/a",
            "http://[::1]/a",
            "http://192.168.1.1/a",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
        assert!(public_url("https://mp.weixin.qq.com/s/example?sn=keep").is_ok());
    }
}
