use super::mobile_article::article_url_key;
use super::tests::make_store;
use super::*;
#[test]
fn clipboard_cleanup_keeps_an_inflight_article_download_before_metadata_commit() {
    let store = make_store();
    let directory = std::env::temp_dir().join(format!("article-flight-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let name = "11111111111111111111111111111111.png";
    let path = directory.join(name);
    std::fs::write(&path, b"image bytes").unwrap();
    let pin = super::mobile_article::pin_article_image(name);
    let item = HistoryItem {
        content: path.to_string_lossy().into(),
        ..super::tests::make_item(
            "inflight-article-picture",
            "picture",
            "2026-10-10 10:00:00",
            "image",
        )
    };
    store.insert_history(&item).unwrap();
    store.delete_history(&[item.id]).unwrap();
    let survived = path.exists();
    drop(pin);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(&directory);
    assert!(
        survived,
        "a picture stays pinned while another download is still running"
    );
}

fn fields(task: &MobileArticle, body: &str) -> MobileArticleFields {
    MobileArticleFields {
        revision: task.revision,
        title: "测试文章".into(),
        body: body.into(),
        remarks: "自己的收藏原因".into(),
        folder_id: None,
        tag_ids: Vec::new(),
    }
}

#[test]
fn article_identity_preserves_access_params_and_ignores_query_order() {
    assert_eq!(
        article_url_key("https://example.com/a?sn=secret&mid=1#x").unwrap(),
        article_url_key("https://example.com/a?mid=1&sn=secret").unwrap()
    );
    assert_ne!(
        article_url_key("https://example.com/a?sn=a").unwrap(),
        article_url_key("https://example.com/a?sn=b").unwrap()
    );
    assert!(article_url_key("https://user:pass@example.com/a").is_err());
}

#[test]
fn article_save_is_independent_of_editor_draft_and_retry_is_idempotent() {
    let store = make_store();
    let draft = MobileKnowledgeDraft {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        title: "原草稿".into(),
        content: "原文字".into(),
        folder_id: None,
        tag_ids: vec![],
        updated_at: String::new(),
    };
    store.mobile_knowledge_draft_put(&draft).unwrap();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    let task = store
        .mobile_article_put(&task.id, &fields(&task, "公开文章正文"))
        .unwrap();
    let note = store
        .mobile_article_save(&task.id, task.revision, false)
        .unwrap();
    let retry = store
        .mobile_article_save(&task.id, task.revision, false)
        .unwrap();
    assert_eq!(note.id, retry.id);
    assert_eq!(
        store.mobile_knowledge_draft_get().unwrap().unwrap().content,
        "原文字"
    );
    assert!(store.mobile_article_pending().unwrap().is_empty());
    assert_eq!(
        store.mobile_article_for_note(&note.id).unwrap().unwrap().id,
        task.id
    );
}

#[test]
fn bookmark_fill_updates_the_same_note_and_preserves_remarks() {
    let store = make_store();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    let task = store
        .mobile_article_put(&task.id, &fields(&task, ""))
        .unwrap();
    let note = store
        .mobile_article_save(&task.id, task.revision, true)
        .unwrap();
    let task = store.mobile_article_get(&task.id).unwrap();
    let task = store
        .mobile_article_put(&task.id, &fields(&task, "后来取得的正文"))
        .unwrap();
    let filled = store
        .mobile_article_save(&task.id, task.revision, false)
        .unwrap();
    assert_eq!(filled.id, note.id);
    assert!(filled.content.contains("自己的收藏原因"));
    assert!(filled.content.contains("后来取得的正文"));
    assert!(!store.mobile_article_get(&task.id).unwrap().saved_link_only);
}

#[test]
fn bookmark_fill_refuses_to_overwrite_a_modified_note() {
    let store = make_store();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    let note = store
        .mobile_article_save(&task.id, task.revision, true)
        .unwrap();
    store
        .note_update(&note.id, "用户改过的标题", "用户写下的新正文")
        .unwrap();
    let task = store.mobile_article_get(&task.id).unwrap();
    let task = store
        .mobile_article_put(&task.id, &fields(&task, "网站正文"))
        .unwrap();
    assert!(store
        .mobile_article_save(&task.id, task.revision, false)
        .is_err());
    assert_eq!(
        store.note_get(&note.id).unwrap().unwrap().content,
        "用户写下的新正文"
    );
}

#[test]
fn stale_fields_and_fetch_replies_do_not_replace_newer_input() {
    let store = make_store();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    let next = store
        .mobile_article_put(&task.id, &fields(&task, "新的正文"))
        .unwrap();
    assert!(store
        .mobile_article_put(&task.id, &fields(&task, "旧正文"))
        .is_err());
    assert!(store.mobile_article_fetched(&task, task.clone()).is_err());
    assert_eq!(store.mobile_article_get(&task.id).unwrap().body, next.body);
}

#[test]
fn redirected_duplicate_is_detected_without_overwriting_existing_note() {
    let store = make_store();
    let first = store
        .mobile_article_begin("https://example.com/final")
        .unwrap();
    let first = store
        .mobile_article_put(&first.id, &fields(&first, "已收藏正文"))
        .unwrap();
    let note = store
        .mobile_article_save(&first.id, first.revision, false)
        .unwrap();
    let task = store
        .mobile_article_begin("https://example.com/short")
        .unwrap();
    let mut fetched = task.clone();
    fetched.url = "https://example.com/final".into();
    let fetched = store.mobile_article_fetched(&task, fetched).unwrap();
    assert_eq!(fetched.duplicate_note_id, Some(note.id));
    assert!(store
        .mobile_article_save(&task.id, fetched.revision, true)
        .is_err());
}
#[test]
fn save_rechecks_a_redirected_article_that_was_pending_when_fetched() {
    let store = make_store();
    let first = store
        .mobile_article_begin("https://example.com/final")
        .unwrap();
    let first = store
        .mobile_article_put(&first.id, &fields(&first, "原文A"))
        .unwrap();
    let second = store
        .mobile_article_begin("https://example.com/short")
        .unwrap();
    let mut fetched = second.clone();
    fetched.url = "https://example.com/final".into();
    let second = store.mobile_article_fetched(&second, fetched).unwrap();
    let second = store
        .mobile_article_put(&second.id, &fields(&second, "原文B"))
        .unwrap();
    let note = store
        .mobile_article_save(&first.id, first.revision, false)
        .unwrap();
    assert!(
        store
            .mobile_article_save(&second.id, second.revision, false)
            .is_err(),
        "must detect the note saved after the fetch"
    );
    assert_eq!(
        store
            .mobile_article_get(&second.id)
            .unwrap()
            .duplicate_note_id,
        Some(note.id.clone())
    );
    assert!(store
        .note_get(&note.id)
        .unwrap()
        .unwrap()
        .content
        .contains("原文A"));
}

#[test]
fn image_completion_patches_only_its_token_in_current_user_content() {
    let store = make_store();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    let mut fetched = task.clone();
    fetched.images = vec![MobileArticleImage {
        url: "https://example.com/image.png".into(),
        local: None,
        bytes: 0,
    }];
    let fetched = store.mobile_article_fetched(&task, fetched).unwrap();
    let fetched = store
        .mobile_article_put(
            &task.id,
            &fields(&fetched, "![图](https://example.com/image.png)\n\n原正文"),
        )
        .unwrap();
    let note = store
        .mobile_article_save(&task.id, fetched.revision, false)
        .unwrap();
    let edited = format!("{}\n\n刚刚新增的用户备注", note.content);
    store.note_update(&note.id, &note.title, &edited).unwrap();
    let patched = store
        .mobile_article_image_saved(
            &task.id,
            0,
            "https://example.com/image.png",
            "pp-asset:00000000000000000000000000000000.png",
            12,
        )
        .unwrap();
    let note = store.note_get(&note.id).unwrap().unwrap();
    assert!(note.content.contains("刚刚新增的用户备注"));
    assert!(note.content.contains("![图](pp-asset:"));
    assert_eq!(patched.images[0].bytes, 12);
    assert!(store
        .mobile_article_image_saved(
            &task.id,
            0,
            "https://evil.example/wrong",
            "pp-asset:x.png",
            12
        )
        .is_err());
}

#[test]
fn share_receipts_survive_reentry_without_duplicating_sources() {
    let store = make_store();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    store
        .mobile_article_bind_source(&task.id, "share-one")
        .unwrap();
    let same = store.mobile_article_begin("https://example.com/a").unwrap();
    let same = store
        .mobile_article_bind_source(&same.id, "share-one")
        .unwrap();
    assert_eq!(same.id, task.id);
    assert_eq!(same.source_ids, vec!["share-one"]);
    let cleared = store
        .mobile_article_ack_sources(&same.id, &["share-one".into()])
        .unwrap();
    assert!(cleared.source_ids.is_empty());
    assert_eq!(
        store
            .mobile_article_bind_source(&same.id, "share-two")
            .unwrap()
            .source_ids,
        vec!["share-two"]
    );
}

#[test]
fn clipboard_cleanup_keeps_an_image_owned_by_a_pending_or_saved_article() {
    let store = make_store();
    let directory = std::env::temp_dir().join(format!("article-ref-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let name = "00000000000000000000000000000000.png";
    let path = directory.join(name);
    std::fs::write(&path, b"image bytes").unwrap();
    let task = store.mobile_article_begin("https://example.com/a").unwrap();
    let mut fetched = task.clone();
    fetched.images = vec![MobileArticleImage {
        url: "https://example.com/image.png".into(),
        local: Some(format!("pp-asset:{name}")),
        bytes: 11,
    }];
    store.mobile_article_fetched(&task, fetched).unwrap();
    let item = HistoryItem {
        content: path.to_string_lossy().into(),
        ..super::tests::make_item("article-picture", "picture", "2026-10-10 10:00:00", "image")
    };
    store.insert_history(&item).unwrap();
    store.delete_history(&[item.id]).unwrap();
    assert!(
        path.exists(),
        "pending article still owns its locally downloaded picture"
    );
    let task = store.mobile_article_get(&task.id).unwrap();
    let task = store
        .mobile_article_put(&task.id, &fields(&task, &format!("![图](pp-asset:{name})")))
        .unwrap();
    store
        .mobile_article_save(&task.id, task.revision, false)
        .unwrap();
    let item = HistoryItem {
        content: path.to_string_lossy().into(),
        ..super::tests::make_item(
            "saved-article-picture",
            "picture",
            "2026-10-10 10:00:01",
            "image",
        )
    };
    store.insert_history(&item).unwrap();
    store.delete_history(&[item.id]).unwrap();
    assert!(
        path.exists(),
        "saved article still owns its locally downloaded picture"
    );
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(&directory);
}
