use super::{
    history_source::{distribution, HistorySourceDistribution, HistorySourceQuery},
    storage::ReadTask,
    tests::make_item,
    DataStore,
};
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    store: Option<DataStore>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pastepanda-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = DataStore::new(root.join("history.db").to_str().unwrap()).unwrap();
        Self {
            root,
            store: Some(store),
        }
    }
    fn store(&self) -> &DataStore {
        self.store.as_ref().unwrap()
    }
    fn query(&self) -> HistorySourceQuery {
        HistorySourceQuery {
            workspace: "默认".into(),
            search: "".into(),
            filter: "all".into(),
            time_filter: "window:2026-10-18 12:00:00~2026-10-18 18:00:00".into(),
            group_filter: "all".into(),
            tag_ids: vec![],
        }
    }
    fn read(&self, q: &HistorySourceQuery) -> HistorySourceDistribution {
        distribution(&self.root.join("history.db"), &ReadTask::default(), q).unwrap()
    }
    fn insert(&self, id: &str, kind: &str, source: &str, time: &str) {
        let mut item = make_item(id, id, time, kind);
        item.source = source.into();
        item.source_icon = Some(format!("{source}.png"));
        self.store().insert_history(&item).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn source_distribution_is_complete_sorted_and_not_limited_to_loaded_cards() {
    let f = Fixture::new();
    {
        let conn = f.store().lock_conn();
        for i in 0..1205 {
            conn.execute("INSERT INTO history(id,text,time,type,content,pinned,source,workspace) VALUES(?1,?1,'2026-10-18 14:00:00','text','',0,'Editor','默认')", [format!("row-{i}")]).unwrap();
        }
    }
    for i in 0..7 {
        f.insert(
            &format!("other-{i}"),
            "image",
            &format!("App-{i}"),
            "2026-10-18 15:00:00",
        );
    }
    let report = f.read(&f.query());
    assert_eq!(report.total.count, 1212);
    assert_eq!(report.sources.len(), 8);
    assert_eq!(report.sources[0].source, "Editor");
    assert_eq!(report.sources[0].metrics.count, 1205);
    assert_eq!(report.sources[1].source, "App-0");
}

#[test]
fn source_type_breakdown_matches_list_families_and_exact_source_keys() {
    let f = Fixture::new();
    for kind in ["text", "doc", "diagram", "image", "rich", "file", "audio"] {
        f.insert(kind, kind, "App - title", "2026-10-18 16:00:00");
    }
    f.insert(
        "other-title",
        "text",
        "App - other title",
        "2026-10-18 17:00:00",
    );
    f.insert("unknown", "text", "", "2026-10-18 17:30:00");
    let report = f.read(&f.query());
    assert_eq!(report.total.count, 9);
    assert_eq!(report.sources.len(), 2);
    let entry = &report.sources[0];
    assert_eq!(entry.source, "App - title");
    assert_eq!(entry.source_icon.as_deref(), Some("App - title.png"));
    assert_eq!(
        (
            entry.metrics.text_count,
            entry.metrics.image_count,
            entry.metrics.file_count,
            entry.metrics.other_count
        ),
        (3, 2, 1, 1)
    );
    assert_eq!(
        report.total.latest_time.as_deref(),
        Some("2026-10-18 17:30:00")
    );
    assert_eq!(
        entry.metrics.latest_time.as_deref(),
        Some("2026-10-18 16:00:00")
    );
    let mut q = f.query();
    q.filter = "image".into();
    assert_eq!(f.read(&q).total.count, 2);
    q.filter = "text".into();
    assert_eq!(f.read(&q).total.count, 5);
}

#[test]
fn source_scope_respects_time_workspace_group_tags_and_pins() {
    let f = Fixture::new();
    let group = f.store().create_group("review", "blue", "").unwrap();
    let tag = f.store().create_tag("keep", "blue").unwrap();
    for (id, time, workspace, tagged, pinned) in [
        ("start", "2026-10-18 12:00:00", "默认", true, true),
        ("last", "2026-10-18 17:59:59.999999", "默认", true, false),
        ("end", "2026-10-18 18:00:00", "默认", true, true),
        ("elsewhere", "2026-10-18 14:00:00", "其他", true, true),
        ("untagged", "2026-10-18 14:00:00", "默认", false, true),
    ] {
        let mut item = make_item(id, "review", time, "text");
        item.source = id.into();
        item.workspace = workspace.into();
        item.pinned = pinned;
        item.group_id = Some(group.id.clone());
        f.store().insert_history(&item).unwrap();
        if tagged {
            f.store()
                .add_item_tags(&[id.into()], &[tag.id.clone()])
                .unwrap();
        }
    }
    let mut q = f.query();
    q.group_filter = group.id;
    q.tag_ids = vec![tag.id];
    assert_eq!(f.read(&q).total.count, 2);
    q.filter = "pinned".into();
    assert_eq!(f.read(&q).total.count, 1);
    q.group_filter = "ungrouped".into();
    assert_eq!(f.read(&q).total.count, 0);
}

#[test]
fn source_keyword_includes_ocr_and_summaries_with_literal_special_characters() {
    let f = Fixture::new();
    let mut image = make_item("img", "[图片]", "2026-10-18 13:00:00", "image");
    image.content = "source-test-ocr.png".into();
    image.source = "Browser".into();
    f.store().insert_history(&image).unwrap();
    f.store()
        .set_ocr_text(&image.content, "季度营收报表")
        .unwrap();
    f.insert("季度营收", "text", "Editor", "2026-10-18 14:00:00");
    f.insert("summary", "text", "Chat", "2026-10-18 15:00:00");
    assert_eq!(f.store().lock_conn().execute("UPDATE history_summaries SET summary='季度营收' WHERE history_id='summary'", []).unwrap(), 1);
    let mut q = f.query();
    q.search = "季度营收".into();
    assert_eq!(f.read(&q).total.count, 3);
    assert_eq!(f.read(&q).sources.len(), 3);
    q.search = "!%_".into();
    assert_eq!(f.read(&q).total.count, 0);
}

#[test]
fn source_reads_are_read_only_and_invalid_or_cancelled_requests_are_errors() {
    let f = Fixture::new();
    f.insert("one", "file", "Explorer", "2026-10-18 13:00:00");
    let path = f.root.join("history.db");
    let before = std::fs::read(&path).unwrap();
    assert_eq!(f.read(&f.query()).total.count, 1);
    assert_eq!(before, std::fs::read(&path).unwrap());
    let mut q = f.query();
    q.time_filter = "window:broken".into();
    assert!(distribution(&path, &ReadTask::default(), &q).is_err());
    let task = ReadTask::default();
    task.cancel();
    assert!(distribution(&path, &task, &f.query()).is_err());
}
