use super::{history_search::search_where, storage::ReadTask, SearchQuery};
use rusqlite::ToSql;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize)]
pub struct HistorySourceQuery {
    pub workspace: String,
    pub search: String,
    pub filter: String,
    pub time_filter: String,
    pub group_filter: String,
    pub tag_ids: Vec<String>,
}

#[derive(Default, Debug, Serialize)]
pub struct SourceMetrics {
    pub count: u64,
    pub text_count: u64,
    pub image_count: u64,
    pub file_count: u64,
    pub other_count: u64,
    pub latest_time: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct HistorySourceEntry {
    pub source: String,
    pub source_icon: Option<String>,
    #[serde(flatten)]
    pub metrics: SourceMetrics,
}
#[derive(Debug, Serialize)]
pub struct HistorySourceDistribution {
    pub total: SourceMetrics,
    pub sources: Vec<HistorySourceEntry>,
}

pub fn distribution(
    path: &Path,
    task: &ReadTask,
    query: &HistorySourceQuery,
) -> Result<HistorySourceDistribution, String> {
    let conn = task.connect(path)?;
    let (predicate, values) = search_where(
        &conn,
        &SearchQuery {
            workspace: &query.workspace,
            search: &query.search,
            filter: &query.filter,
            time_filter: &query.time_filter,
            source: "",
            group_filter: &query.group_filter,
            tag_ids: &query.tag_ids,
            limit: 1000,
        },
    )?;
    // Match the list's type families and predicates, without its pagination cap.
    // Exact raw source keys remain selectable by the existing source = ? filter.
    let sql = format!(
        "SELECT COALESCE(source,''), MAX(NULLIF(source_icon,'')), COUNT(*),
        SUM(type IN ('text','diagram','doc')), SUM(type IN ('image','rich')),
        SUM(type = 'file'), MAX(time) {predicate} GROUP BY COALESCE(source,'')"
    );
    let params: Vec<&dyn ToSql> = values.iter().map(|v| v.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            let count = r.get::<_, u64>(2)?;
            let text_count = r.get::<_, u64>(3)?;
            let image_count = r.get::<_, u64>(4)?;
            let file_count = r.get::<_, u64>(5)?;
            Ok(HistorySourceEntry {
                source: r.get(0)?,
                source_icon: r.get(1)?,
                metrics: SourceMetrics {
                    count,
                    text_count,
                    image_count,
                    file_count,
                    other_count: count - text_count - image_count - file_count,
                    latest_time: r.get(6)?,
                },
            })
        })
        .map_err(|e| e.to_string())?;
    let mut total = SourceMetrics::default();
    let mut sources = Vec::new();
    for row in rows {
        task.check()?;
        let entry = row.map_err(|e| e.to_string())?;
        let m = &entry.metrics;
        total.count += m.count;
        total.text_count += m.text_count;
        total.image_count += m.image_count;
        total.file_count += m.file_count;
        total.other_count += m.other_count;
        if m.latest_time > total.latest_time {
            total.latest_time = m.latest_time.clone();
        }
        // Empty source already means 'all' in the list. Count it in totals, but
        // never offer an unknown-source row that would silently select everything.
        if !entry.source.is_empty() {
            sources.push(entry);
        }
    }
    task.check()?;
    sources.sort_by(|a, b| {
        b.metrics
            .count
            .cmp(&a.metrics.count)
            .then(a.source.cmp(&b.source))
    });
    Ok(HistorySourceDistribution { total, sources })
}
