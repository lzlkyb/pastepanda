use super::tests::make_store;
use super::*;

fn draft() -> MobileKnowledgeDraft {
    MobileKnowledgeDraft {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        title: "随手记".into(),
        content: "离线也要留下正文".into(),
        updated_at: String::new(),
    }
}

#[test]
fn mobile_draft_commit_retry_is_independent_and_never_overwrites() {
    let store = make_store();
    let draft = draft();
    store.mobile_knowledge_draft_put(&draft).unwrap();
    let first = store.mobile_knowledge_draft_commit(&draft.id, 1).unwrap();
    assert!(store.mobile_knowledge_draft_get().unwrap().is_none());
    assert_eq!(
        store
            .mobile_knowledge_draft_commit(&draft.id, 1)
            .unwrap()
            .id,
        first.id
    );
    assert!(first.history_id.is_none());
    assert_eq!(store.note_count(), 1);
    assert!(store.mobile_knowledge_draft_put(&draft).is_err());
    assert!(store.mobile_knowledge_draft_commit(&draft.id, 2).is_err());
    store
        .note_update(&first.id, "电脑已更新", "新正文")
        .unwrap();
    assert_eq!(
        store
            .mobile_knowledge_draft_commit(&draft.id, 1)
            .unwrap()
            .content,
        "新正文"
    );
    store.note_delete(&first.id).unwrap();
    assert!(store.mobile_knowledge_draft_commit(&draft.id, 1).is_err());
}

#[test]
fn mobile_draft_stale_writes_and_failures_retain_latest_text() {
    let store = make_store();
    let mut draft = draft();
    store.mobile_knowledge_draft_put(&draft).unwrap();
    let old = draft.clone();
    draft.revision = 2;
    draft.content = "最新草稿".into();
    store.mobile_knowledge_draft_put(&draft).unwrap();
    assert!(store.mobile_knowledge_draft_put(&old).is_err());
    assert!(store.mobile_knowledge_draft_clear(&draft.id, 1).is_err());
    assert!(store.mobile_knowledge_draft_commit(&draft.id, 1).is_err());
    assert!(store
        .mobile_knowledge_draft_put(&super::tests_mobile_knowledge::draft())
        .is_err());
    assert_eq!(
        store.mobile_knowledge_draft_get().unwrap().unwrap().content,
        "最新草稿"
    );
    // Even a genuine primary-key collision cannot alter the existing note or clear draft.
    store
        .note_create_keeping_id(&draft.id, "已有笔记", "不能覆盖")
        .unwrap();
    assert!(store.mobile_knowledge_draft_commit(&draft.id, 2).is_err());
    assert_eq!(
        store.note_get(&draft.id).unwrap().unwrap().content,
        "不能覆盖"
    );
    assert_eq!(
        store
            .mobile_knowledge_draft_get()
            .unwrap()
            .unwrap()
            .revision,
        2
    );
}

#[test]
fn mobile_draft_transaction_rolls_back_creation_if_cleanup_fails() {
    let store = make_store();
    let draft = draft();
    store.mobile_knowledge_draft_put(&draft).unwrap();
    store.lock_conn().execute_batch("CREATE TRIGGER fail_draft_cleanup BEFORE DELETE ON mobile_knowledge_draft BEGIN SELECT RAISE(ABORT,'full disk'); END;").unwrap();
    assert!(store.mobile_knowledge_draft_commit(&draft.id, 1).is_err());
    assert!(store.note_get(&draft.id).unwrap().is_none());
    assert!(store.mobile_knowledge_draft_get().unwrap().is_some());
    store
        .lock_conn()
        .execute_batch("DROP TRIGGER fail_draft_cleanup;")
        .unwrap();
    store.mobile_knowledge_draft_commit(&draft.id, 1).unwrap();
    assert_eq!(store.note_count(), 1);
}

#[test]
fn mobile_list_is_bounded_searches_bodies_and_escapes_wildcards() {
    let store = make_store();
    for i in 0..23 {
        store
            .note_create(None, &format!("笔记{i}"), &"长正文".repeat(1000))
            .unwrap();
    }
    let first = store
        .mobile_knowledge_list(&MobileKnowledgeOptions::default())
        .unwrap();
    assert_eq!(first.items.len(), 20);
    assert!(first.has_more);
    assert!(first.items.iter().all(|n| n.excerpt.chars().count() <= 160));
    let second = store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            offset: 20,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(second.items.len(), 3);
    assert!(!second.has_more);
    assert!(!first
        .items
        .iter()
        .any(|a| second.items.iter().any(|b| a.id == b.id)));
    let needle = store.note_create(None, "配置", "百分比 99%_配置").unwrap();
    let found = store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            query: "%_".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, needle.id);
    store.note_delete(&needle.id).unwrap();
    assert!(store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            query: "%_".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn mobile_metadata_is_local_and_exact_titles_do_not_guess() {
    let store = make_store();
    let one = store.note_create(None, "会议", "一").unwrap();
    let two = store.note_create(None, "会议", "二").unwrap();
    store.note_create(None, "会议纪要", "三").unwrap();
    store.mobile_knowledge_set_common(&one.id, true).unwrap();
    store.mobile_knowledge_visit(&one.id, 0.65).unwrap();
    assert!(!store.note_get(&one.id).unwrap().unwrap().pinned);
    assert_eq!(
        store.note_get(&one.id).unwrap().unwrap().updated_at,
        one.updated_at
    );
    let common = store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            view: "common".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(common.items.len(), 1);
    assert_eq!(common.items[0].meta.reading_position, 0.65);
    assert!(store.mobile_knowledge_visit(&one.id, f64::NAN).is_err());
    assert!(store.mobile_knowledge_meta("missing").is_err());
    let exact = store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            exact_title: Some("会议".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(exact.items.len(), 2);
    assert!(exact.items.iter().any(|n| n.id == two.id));
}

#[test]
fn mobile_draft_and_receipt_survive_database_reopen() {
    let path = std::env::temp_dir().join(format!(
        "pastepanda-mobile-draft-{}.db",
        uuid::Uuid::new_v4()
    ));
    let draft = draft();
    {
        let store = DataStore::new(path.to_str().unwrap()).unwrap();
        store.mobile_knowledge_draft_put(&draft).unwrap();
    }
    {
        let store = DataStore::new(path.to_str().unwrap()).unwrap();
        assert_eq!(
            store.mobile_knowledge_draft_get().unwrap().unwrap().content,
            draft.content
        );
        store.mobile_knowledge_draft_commit(&draft.id, 1).unwrap();
    }
    {
        let store = DataStore::new(path.to_str().unwrap()).unwrap();
        assert!(store.mobile_knowledge_draft_get().unwrap().is_none());
        assert_eq!(
            store
                .mobile_knowledge_draft_commit(&draft.id, 1)
                .unwrap()
                .id,
            draft.id
        );
        assert_eq!(store.note_count(), 1);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn mobile_list_reuses_folder_subtree_and_tag_intersection() {
    let store = make_store();
    let folder = store.folder_create("工作", None).unwrap();
    let child = store.folder_create("会议", Some(&folder.id)).unwrap();
    let tag = store.create_tag("重点", "#111111").unwrap();
    let one = store.note_create(None, "会议", "详情").unwrap();
    let outside = store.note_create(None, "另一个", "详情").unwrap();
    store.note_set_folder(&one.id, Some(&child.id)).unwrap();
    store.note_set_tags(&one.id, &[tag.id.clone()]).unwrap();
    store.note_set_tags(&outside.id, &[tag.id.clone()]).unwrap();
    let page = store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            folder_filter: folder.id,
            tag_ids: vec![tag.id],
            query: "详情".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, one.id);
    assert_eq!(page.items[0].tags.len(), 1);
    assert_eq!(page.items[0].folder_name.as_deref(), Some("会议"));
}

#[test]
fn mobile_recent_search_includes_unread_notes_and_excerpts_near_match() {
    let store = make_store();
    let unread = store
        .note_create(
            None,
            "工作资料",
            &format!("{}尾部配置Needle", "背景资料".repeat(1000)),
        )
        .unwrap();
    let found = store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            view: "recent".into(),
            query: "needle".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, unread.id);
    assert!(found.items[0].excerpt.contains("尾部配置Needle"));
    assert!(store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            view: "common".into(),
            query: "needle".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn mobile_capture_blank_title_uses_first_nonempty_line_in_unicode_characters() {
    let store = make_store();
    let mut draft = draft();
    draft.title = "  ".into();
    draft.content = format!("\n  \n  {}  \n后面的正文", "手机记录中文标题".repeat(10));
    store.mobile_knowledge_draft_put(&draft).unwrap();
    let note = store.mobile_knowledge_draft_commit(&draft.id, 1).unwrap();
    assert_eq!(
        note.title,
        "手机记录中文标题"
            .repeat(10)
            .chars()
            .take(32)
            .collect::<String>()
    );
    assert_eq!(note.title.chars().count(), 32);
    assert_eq!(note.content, draft.content);
}

#[test]
fn mobile_search_uses_shared_chinese_english_and_pinyin_index() {
    let store = make_store();
    let note = store
        .note_create(None, "会议记录", "检查 API configuration")
        .unwrap();
    for query in ["会议", "api", "hyjl"] {
        let page = store
            .mobile_knowledge_list(&MobileKnowledgeOptions {
                query: query.into(),
                view: "recent".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.items.len(), 1, "{query}");
        assert_eq!(page.items[0].id, note.id);
    }
    // Deleting the derived entry simulates an unavailable match. Returning zero hits
    // must not silently scan all original Markdown and resurrect an unindexed hit.
    store
        .lock_conn()
        .execute("DELETE FROM notes_fts", [])
        .unwrap();
    assert!(store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            query: "configuration".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .is_empty());
    store
        .lock_conn()
        .execute_batch("DROP TABLE notes_fts")
        .unwrap();
    assert!(store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            query: "api".into(),
            ..Default::default()
        })
        .is_err());
}
