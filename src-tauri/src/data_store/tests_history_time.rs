use super::{
    history_time::{distribution, HistoryTimeQuery},
    storage::ReadTask,
    tests::make_item,
    DataStore, SearchQuery,
};
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    store: Option<DataStore>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pastepanda-time-{}", uuid::Uuid::new_v4()));
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
    fn query(&self) -> HistoryTimeQuery {
        HistoryTimeQuery {
            workspace: "默认".into(),
            search: "".into(),
            filter: "all".into(),
            time_filter: "window:2026-10-17 00:00:00~2026-10-18 00:00:00".into(),
            source: "".into(),
            group_filter: "all".into(),
            tag_ids: vec![],
            start_date: "2026-10-05".into(),
            end_date: "2026-10-18".into(),
            selected_date: "2026-10-17".into(),
        }
    }
    fn read(&self, q: &HistoryTimeQuery) -> super::history_time::HistoryTimeDistribution {
        distribution(&self.root.join("history.db"), &ReadTask::default(), q).unwrap()
    }
    fn list(&self, q: &HistoryTimeQuery) -> Vec<super::HistoryItem> {
        self.store()
            .search_history(&SearchQuery {
                workspace: &q.workspace,
                search: &q.search,
                filter: &q.filter,
                time_filter: &q.time_filter,
                source: &q.source,
                group_filter: &q.group_filter,
                tag_ids: &q.tag_ids,
                limit: 1000,
            })
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn time_distribution_ignores_page_limits_and_counts_empty_days() {
    let f = Fixture::new();
    {
        let conn = f.store().lock_conn();
        for i in 0..1205 {
            conn.execute("INSERT INTO history(id,text,time,type,content,pinned,source,workspace) VALUES(?1,?1,'2026-10-17 14:00:00','text','',0,'Editor','默认')", [format!("row-{i}")]).unwrap();
        }
    }
    let q = f.query();
    let report = f.read(&q);
    assert_eq!(report.days.len(), 14);
    assert_eq!(report.days.iter().map(|d| d.count).sum::<u64>(), 1205);
    assert_eq!(report.days[0].count, 0);
    assert_eq!(report.hours[14], 1205);
    assert_eq!(report.selection_count, 1205);
    assert_eq!(f.list(&q).len(), 1000);
}

#[test]
fn time_window_excludes_next_boundary_and_does_not_prioritize_pins() {
    let f = Fixture::new();
    for (id, time, pinned) in [
        ("first", "2026-10-17 00:00:00", true),
        ("last", "2026-10-17 23:59:59.999999", false),
        ("next", "2026-10-18 00:00:00", false),
    ] {
        let mut item = make_item(id, id, time, "text");
        item.pinned = pinned;
        f.store().insert_history(&item).unwrap();
    }
    let q = f.query();
    let report = f.read(&q);
    assert_eq!(report.selection_count, 2);
    assert_eq!(
        f.list(&q).iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        vec!["last", "first"]
    );
    assert_eq!(report.hours[23], 1);
}

#[test]
fn time_distribution_and_list_share_type_source_workspace_group_and_tags() {
    let f = Fixture::new();
    let group = f.store().create_group("review", "blue", "").unwrap();
    let tag = f.store().create_tag("keep", "blue").unwrap();
    for (id, kind, workspace, source) in [
        ("rich", "rich", "默认", "Wechat"),
        ("img", "image", "默认", "Wechat"),
        ("doc", "doc", "默认", "Wechat"),
        ("other", "image", "别处", "Wechat"),
        ("source", "image", "默认", "Browser"),
    ] {
        let mut item = make_item(id, id, "2026-10-17 13:00:00", kind);
        item.workspace = workspace.into();
        item.source = source.into();
        item.group_id = Some(group.id.clone());
        f.store().insert_history(&item).unwrap();
    }
    f.store()
        .add_item_tags(
            &["rich".into(), "img".into(), "doc".into()],
            &[tag.id.clone()],
        )
        .unwrap();
    let mut q = f.query();
    q.filter = "image".into();
    q.source = "Wechat".into();
    q.group_filter = group.id;
    q.tag_ids = vec![tag.id];
    assert_eq!(f.read(&q).selection_count, 2);
    assert_eq!(f.list(&q).len(), 2);
    q.filter = "text".into();
    assert_eq!(f.read(&q).selection_count, 1);
    assert_eq!(f.list(&q)[0].id, "doc");
}

#[test]
fn time_keyword_counts_include_ocr_and_literal_matches_without_fallback_drift() {
    let f = Fixture::new();
    let mut image = make_item("img", "[图片]", "2026-10-17 13:00:00", "image");
    image.content = "image-for-ocr.png".into();
    f.store().insert_history(&image).unwrap();
    f.store()
        .set_ocr_text(&image.content, "季度营收报表")
        .unwrap();
    f.store()
        .insert_history(&make_item(
            "text",
            "季度营收",
            "2026-10-17 14:00:00",
            "text",
        ))
        .unwrap();
    let mut q = f.query();
    q.search = "季度营收".into();
    assert_eq!(f.read(&q).selection_count, 2);
    assert_eq!(f.list(&q).len(), 2);
    assert_eq!(f.read(&q).hours.iter().sum::<u64>(), 2);
    // Punctuation must remain a literal search, never an invalid MATCH expression.
    q.search = "!%".into();
    assert_eq!(f.read(&q).selection_count, 0);
    assert!(f.list(&q).is_empty());
}

#[test]
fn time_selected_day_outside_recent_chart_is_still_queryable_and_read_only() {
    let f = Fixture::new();
    f.store()
        .insert_history(&make_item("old", "a", "2025-12-31 22:00:00", "text"))
        .unwrap();
    let mut q = f.query();
    q.selected_date = "2025-12-31".into();
    q.time_filter = "window:2025-12-31 22:00:00~2026-01-01 00:00:00".into();
    let before = std::fs::read(f.root.join("history.db")).unwrap();
    let report = f.read(&q);
    assert_eq!(report.hours[22], 1);
    assert_eq!(report.selection_count, 1);
    assert_eq!(report.days.iter().map(|d| d.count).sum::<u64>(), 0);
    assert_eq!(before, std::fs::read(f.root.join("history.db")).unwrap());
}

#[test]
fn time_invalid_ranges_and_cancelled_reads_are_errors_not_empty_success() {
    let f = Fixture::new();
    let mut q = f.query();
    q.time_filter = "window:broken".into();
    assert!(distribution(&f.root.join("history.db"), &ReadTask::default(), &q).is_err());
    q = f.query();
    q.start_date = "invalid".into();
    assert!(distribution(&f.root.join("history.db"), &ReadTask::default(), &q).is_err());
    q = f.query();
    let task = ReadTask::default();
    task.cancel();
    assert!(distribution(&f.root.join("history.db"), &task, &q).is_err());
}
