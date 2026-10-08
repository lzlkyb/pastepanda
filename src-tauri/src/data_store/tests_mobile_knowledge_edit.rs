use super::tests::make_store;
use super::*;

fn edited(store: &DataStore, note_id: &str) -> MobileKnowledgeEditDraft {
    let mut draft = store.mobile_knowledge_edit_begin(note_id).unwrap();
    draft.revision += 1;
    draft.title = "手机新标题".into();
    draft.content = "手机修改正文".into();
    store.mobile_knowledge_edit_put(&draft).unwrap()
}
fn saved(result: MobileKnowledgeEditResult) -> Note {
    match result {
        MobileKnowledgeEditResult::Saved { note, .. } => note,
        other => panic!("expected saved, {other:?}"),
    }
}

#[test]
fn mobile_edit_commit_reuses_snapshots_wiki_indexes_and_sync_clock() {
    let store = make_store();
    let note = store.note_create(None, "原标题", "原正文").unwrap();
    let reference = store.note_create(None, "引用", "参考 [[原标题]]").unwrap();
    let before = store.note_updated_ms(&note.id).unwrap();
    let draft = edited(&store, &note.id);
    let result = store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .unwrap();
    assert!(matches!(
        &result,
        MobileKnowledgeEditResult::Saved { relinked: 1, .. }
    ));
    assert_eq!(saved(result).content, "手机修改正文");
    assert!(store.note_updated_ms(&note.id).unwrap() > before);
    assert_eq!(
        store.note_get(&reference.id).unwrap().unwrap().content,
        "参考 [[手机新标题]]"
    );
    let revisions = store.note_revision_list(&note.id).unwrap();
    assert_eq!(revisions.len(), 1);
    assert_eq!(
        store
            .note_revision_get(revisions[0].id)
            .unwrap()
            .unwrap()
            .content,
        "原正文"
    );
    assert!(store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            query: "修改正文".into(),
            view: "all".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .iter()
        .any(|n| n.id == note.id));
    assert!(store.mobile_knowledge_edit_get().unwrap().is_none());
}

#[test]
fn mobile_edit_remote_change_conflict_retains_both_versions_and_explicit_copy() {
    let store = make_store();
    let note = store.note_create(None, "原标题", "原正文").unwrap();
    let draft = edited(&store, &note.id);
    store
        .note_update(&note.id, "电脑标题", "电脑最新正文")
        .unwrap();
    match store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .unwrap()
    {
        MobileKnowledgeEditResult::Conflict { latest } => {
            assert_eq!(latest.content, "电脑最新正文")
        }
        other => panic!("expected conflict, {other:?}"),
    }
    assert_eq!(
        store.mobile_knowledge_edit_get().unwrap().unwrap().content,
        "手机修改正文"
    );
    let copy = saved(
        store
            .mobile_knowledge_edit_copy(&draft.id, draft.revision)
            .unwrap(),
    );
    assert_ne!(copy.id, note.id);
    assert_eq!(copy.content, "手机修改正文");
    assert_eq!(
        store.note_get(&note.id).unwrap().unwrap().content,
        "电脑最新正文"
    );
    assert_eq!(
        saved(
            store
                .mobile_knowledge_edit_copy(&draft.id, draft.revision)
                .unwrap()
        )
        .id,
        copy.id
    );
    assert!(store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .is_err());
    assert_eq!(store.note_count(), 2);
}

#[test]
fn mobile_edit_deleted_original_cannot_be_restored_by_save() {
    let store = make_store();
    let note = store.note_create(None, "原标题", "原正文").unwrap();
    let draft = edited(&store, &note.id);
    store.note_delete(&note.id).unwrap();
    assert!(matches!(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap(),
        MobileKnowledgeEditResult::Deleted
    ));
    assert!(store.mobile_knowledge_edit_get().unwrap().is_some());
    let copy = saved(
        store
            .mobile_knowledge_edit_copy(&draft.id, draft.revision)
            .unwrap(),
    );
    assert_ne!(copy.id, note.id);
    assert!(store.note_get(&note.id).unwrap().is_none());
    store.note_delete(&copy.id).unwrap();
    assert!(matches!(
        store
            .mobile_knowledge_edit_copy(&draft.id, draft.revision)
            .unwrap(),
        MobileKnowledgeEditResult::Deleted
    ));
    assert_eq!(store.note_count(), 0);
}

#[test]
fn mobile_edit_receipt_retry_returns_current_note_without_overwrite_or_resurrection() {
    let store = make_store();
    let note = store.note_create(None, "原标题", "原正文").unwrap();
    let draft = edited(&store, &note.id);
    store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .unwrap();
    store
        .note_update(&note.id, "后续改动", "电脑保存后的新版本")
        .unwrap();
    assert_eq!(
        saved(
            store
                .mobile_knowledge_edit_commit(&draft.id, draft.revision)
                .unwrap()
        )
        .content,
        "电脑保存后的新版本"
    );
    assert!(store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision + 1)
        .is_err());
    assert!(store.mobile_knowledge_edit_put(&draft).is_err());
    store.note_delete(&note.id).unwrap();
    assert!(matches!(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap(),
        MobileKnowledgeEditResult::Deleted
    ));
}

#[test]
fn mobile_edit_lost_copy_reply_cannot_replace_later_edits_or_create_another_copy() {
    let store = make_store();
    let note = store.note_create(None, "原标题", "原正文").unwrap();
    let draft = edited(&store, &note.id);
    let copy = saved(
        store
            .mobile_knowledge_edit_copy(&draft.id, draft.revision)
            .unwrap(),
    );
    assert_eq!(copy.title, "手机新标题（手机副本）");
    store
        .note_update(&copy.id, "已整理副本", "电脑继续修改副本")
        .unwrap();
    let retry = saved(
        store
            .mobile_knowledge_edit_copy(&draft.id, draft.revision)
            .unwrap(),
    );
    assert_eq!(retry.id, copy.id);
    assert_eq!(retry.content, "电脑继续修改副本");
    assert_eq!(store.note_count(), 2);
    store
        .lock_conn()
        .execute("DELETE FROM notes WHERE id=?", [&copy.id])
        .unwrap();
    assert!(matches!(
        store
            .mobile_knowledge_edit_copy(&draft.id, draft.revision)
            .unwrap(),
        MobileKnowledgeEditResult::Deleted
    ));
    assert_eq!(store.note_count(), 1);
}

#[test]
fn mobile_edit_compares_the_latest_database_version_from_another_connection() {
    let path = std::env::temp_dir()
        .join(format!(
            "pastepanda-mobile-edit-{}.db",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();
    let phone = DataStore::new(&path).unwrap();
    let note = phone.note_create(None, "原标题", "原正文").unwrap();
    let draft = edited(&phone, &note.id);
    let desktop = DataStore::new(&path).unwrap();
    desktop
        .note_update(&note.id, "另一个连接", "真实数据库最新版本")
        .unwrap();
    match phone
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .unwrap()
    {
        MobileKnowledgeEditResult::Conflict { latest } => {
            assert_eq!(latest.content, "真实数据库最新版本")
        }
        other => panic!("expected conflict, {other:?}"),
    }
    assert_eq!(
        phone.mobile_knowledge_edit_get().unwrap().unwrap().content,
        draft.content
    );
    assert_eq!(
        desktop.note_get(&note.id).unwrap().unwrap().content,
        "真实数据库最新版本"
    );
    drop(desktop);
    drop(phone);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn mobile_edit_slot_and_base_identity_cannot_be_replaced_or_rebased() {
    let store = make_store();
    let first = store.note_create(None, "一", "正文一").unwrap();
    let second = store.note_create(None, "二", "正文二").unwrap();
    let old = store.mobile_knowledge_edit_begin(&first.id).unwrap();
    let latest = edited(&store, &first.id);
    assert!(store.mobile_knowledge_edit_begin(&second.id).is_err());
    assert!(store.mobile_knowledge_edit_put(&old).is_err());
    assert!(store
        .mobile_knowledge_edit_clear(&old.id, old.revision)
        .is_err());
    assert!(store
        .mobile_knowledge_edit_commit(&old.id, old.revision)
        .is_err());
    let mut forged = latest.clone();
    forged.revision += 1;
    forged.base_note.content = "伪造原文".into();
    assert!(store.mobile_knowledge_edit_put(&forged).is_err());
    forged = latest.clone();
    forged.note_id = second.id.clone();
    assert!(store.mobile_knowledge_edit_put(&forged).is_err());
    assert_eq!(
        store.mobile_knowledge_edit_get().unwrap().unwrap().content,
        latest.content
    );
    store
        .mobile_knowledge_edit_clear(&latest.id, latest.revision)
        .unwrap();
    assert!(store.mobile_knowledge_edit_put(&latest).is_err());
    assert_eq!(
        store
            .mobile_knowledge_edit_begin(&second.id)
            .unwrap()
            .note_id,
        second.id
    );
}

#[test]
fn mobile_edit_categories_are_atomic_and_keep_unmodified_ai_tag_source() {
    let store = make_store();
    let note = store.note_create(None, "标题", "正文").unwrap();
    let ai = store.create_tag("AI分类", "#000000").unwrap();
    let manual = store.create_tag("手机分类", "#000000").unwrap();
    store
        .note_tags_edit(&note.id, &[ai.id.clone()], &[])
        .unwrap();
    let folder = store.folder_create("手机文件夹", None).unwrap();
    let mut draft = store.mobile_knowledge_edit_begin(&note.id).unwrap();
    draft.revision += 1;
    draft.folder_id = Some(folder.id.clone());
    draft.tag_ids.push(manual.id.clone());
    store.mobile_knowledge_edit_put(&draft).unwrap();
    let before = store.note_updated_ms(&note.id).unwrap();
    let updated = saved(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap(),
    );
    assert_eq!(updated.folder_id, Some(folder.id));
    assert_eq!(updated.tags.len(), 2);
    assert!(store.note_updated_ms(&note.id).unwrap() > before);
    let source: String = store
        .lock_conn()
        .query_row(
            "SELECT source FROM note_tags WHERE note_id=? AND tag_id=?",
            params![note.id, ai.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source, "ai");
    assert!(store.note_revision_list(&note.id).unwrap().is_empty());
}

#[test]
fn mobile_edit_category_changes_on_desktop_conflict_and_missing_selection_retains_draft() {
    let store = make_store();
    let note = store.note_create(None, "标题", "正文").unwrap();
    let tag = store.create_tag("分类", "#000000").unwrap();
    let draft = edited(&store, &note.id);
    store.note_set_tags(&note.id, &[tag.id]).unwrap();
    assert!(matches!(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap(),
        MobileKnowledgeEditResult::Conflict { .. }
    ));
    store
        .mobile_knowledge_edit_clear(&draft.id, draft.revision)
        .unwrap();
    let mut draft = edited(&store, &note.id);
    draft.revision += 1;
    draft.folder_id = Some(uuid::Uuid::new_v4().to_string());
    store.mobile_knowledge_edit_put(&draft).unwrap();
    assert_eq!(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap_err(),
        "MOBILE_EDIT_REJECTED:folder_missing"
    );
    assert_eq!(store.note_get(&note.id).unwrap().unwrap().content, "正文");
    assert!(store.mobile_knowledge_edit_get().unwrap().is_some());
    draft.revision += 1;
    draft.folder_id = None;
    draft.tag_ids.push(uuid::Uuid::new_v4().to_string());
    store.mobile_knowledge_edit_put(&draft).unwrap();
    assert_eq!(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap_err(),
        "MOBILE_EDIT_REJECTED:tag_missing"
    );
    draft.revision += 1;
    draft.tag_ids.pop();
    store.mobile_knowledge_edit_put(&draft).unwrap();
    assert_eq!(
        saved(
            store
                .mobile_knowledge_edit_commit(&draft.id, draft.revision)
                .unwrap()
        )
        .content,
        "手机修改正文"
    );
}

#[test]
fn mobile_edit_receipt_failure_rolls_back_note_relinks_indexes_and_draft_clear() {
    let store = make_store();
    let note = store.note_create(None, "原标题", "原正文").unwrap();
    let link = store.note_create(None, "引用", "[[原标题]]").unwrap();
    let draft = edited(&store, &note.id);
    store.lock_conn().execute_batch("CREATE TRIGGER reject_mobile_edit_receipt BEFORE INSERT ON mobile_knowledge_edit_commits BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").unwrap();
    assert!(store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .is_err());
    assert_eq!(store.note_get(&note.id).unwrap().unwrap().content, "原正文");
    assert_eq!(
        store.note_get(&link.id).unwrap().unwrap().content,
        "[[原标题]]"
    );
    assert!(store.note_revision_list(&note.id).unwrap().is_empty());
    assert_eq!(
        store.mobile_knowledge_edit_get().unwrap().unwrap().revision,
        draft.revision
    );
    assert!(store
        .mobile_knowledge_list(&MobileKnowledgeOptions {
            query: "修改正文".into(),
            view: "all".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn mobile_edit_noop_save_does_not_bump_clock_or_snapshot() {
    let store = make_store();
    let note = store.note_create(None, "标题", "正文").unwrap();
    let draft = store.mobile_knowledge_edit_begin(&note.id).unwrap();
    let before = store.note_updated_ms(&note.id);
    store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .unwrap();
    assert_eq!(before, store.note_updated_ms(&note.id));
    assert!(store.note_revision_list(&note.id).unwrap().is_empty());
}

#[test]
fn mobile_edit_title_only_note_remains_editable_but_empty_title_is_recoverable() {
    let store = make_store();
    let note = store.note_create(None, "只有标题", "").unwrap();
    let mut draft = store.mobile_knowledge_edit_begin(&note.id).unwrap();
    draft.revision += 1;
    draft.title = " ".into();
    store.mobile_knowledge_edit_put(&draft).unwrap();
    assert_eq!(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap_err(),
        "MOBILE_EDIT_REJECTED:title_empty"
    );
    assert_eq!(store.note_get(&note.id).unwrap().unwrap().title, "只有标题");
    draft.revision += 1;
    draft.title = "整理后的标题".into();
    store.mobile_knowledge_edit_put(&draft).unwrap();
    let result = saved(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap(),
    );
    assert_eq!(result.title, "整理后的标题");
    assert_eq!(result.content, "");
}

#[test]
fn mobile_edit_preserves_parallel_pin_and_tag_display_changes_without_false_conflict() {
    let store = make_store();
    let note = store.note_create(None, "标题", "正文").unwrap();
    let tag = store.create_tag("标签", "#000000").unwrap();
    store.note_set_tags(&note.id, &[tag.id.clone()]).unwrap();
    let draft = edited(&store, &note.id);
    store.note_toggle_pin(&note.id).unwrap();
    store.update_tag(&tag.id, "标签新名", "#112233").unwrap();
    let result = saved(
        store
            .mobile_knowledge_edit_commit(&draft.id, draft.revision)
            .unwrap(),
    );
    assert!(result.pinned);
    assert_eq!(result.tags[0].name, "标签新名");
    assert_eq!(result.tags[0].color, "#112233");
    assert_eq!(result.content, "手机修改正文");
}

#[test]
fn mobile_edit_survives_reopen_and_keeps_capture_draft_independent() {
    let path = std::env::temp_dir()
        .join(format!(
            "pastepanda-mobile-edit-{}.db",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .to_string();
    let store = DataStore::new(&path).unwrap();
    let note = store.note_create(None, "标题", "正文").unwrap();
    let capture = MobileKnowledgeDraft {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        title: "捕获".into(),
        content: "独立草稿".into(),
        updated_at: String::new(),
    };
    store.mobile_knowledge_draft_put(&capture).unwrap();
    let draft = edited(&store, &note.id);
    drop(store);
    let store = DataStore::new(&path).unwrap();
    assert_eq!(
        store.mobile_knowledge_edit_get().unwrap().unwrap().content,
        draft.content
    );
    assert_eq!(
        store.mobile_knowledge_draft_get().unwrap().unwrap().content,
        capture.content
    );
    store
        .mobile_knowledge_edit_commit(&draft.id, draft.revision)
        .unwrap();
    assert_eq!(
        store.mobile_knowledge_draft_get().unwrap().unwrap().id,
        capture.id
    );
    drop(store);
    std::fs::remove_file(path).unwrap();
}
