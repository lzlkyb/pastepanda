use super::{history_search::search_where, storage::ReadTask, SearchQuery};
use chrono::{Duration, NaiveDate};
use rusqlite::ToSql;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize)]
pub struct HistoryTimeQuery {
    pub workspace: String,
    pub search: String,
    pub filter: String,
    pub time_filter: String,
    pub source: String,
    pub group_filter: String,
    pub tag_ids: Vec<String>,
    pub start_date: String,
    pub end_date: String,
    pub selected_date: String,
}

#[derive(Serialize, Debug)]
pub struct DayCount {
    pub date: String,
    pub count: u64,
}
#[derive(Serialize, Debug)]
pub struct SourceCount {
    pub source: String,
    pub count: u64,
}
#[derive(Serialize, Debug)]
pub struct HistoryTimeDistribution {
    pub days: Vec<DayCount>,
    pub selected_date: String,
    pub hours: [u64; 24],
    pub sources: Vec<SourceCount>,
    pub selection_count: u64,
}

pub fn distribution(
    path: &Path,
    task: &ReadTask,
    query: &HistoryTimeQuery,
) -> Result<HistoryTimeDistribution, String> {
    let date =
        |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| "日期无效".to_string());
    let start = date(&query.start_date)?;
    let end = date(&query.end_date)?;
    let selected = date(&query.selected_date)?;
    if end < start || (end - start).num_days() > 30 {
        return Err("日期范围不能超过 31 天".into());
    }
    let next = |day: NaiveDate| {
        day.checked_add_signed(Duration::days(1))
            .ok_or_else(|| "日期超出范围".to_string())
    };
    let q = SearchQuery {
        workspace: &query.workspace,
        search: &query.search,
        filter: &query.filter,
        time_filter: "all",
        source: &query.source,
        group_filter: &query.group_filter,
        tag_ids: &query.tag_ids,
        limit: 1000,
    };
    let conn = task.connect(path)?;
    let (mut predicate, mut values) = search_where(&conn, &q)?;
    // Aggregate only timestamps and sources. No card bodies cross IPC and no list limit
    // is applied: totals must not change as the user scrolls through paginated cards.
    predicate.push_str(" AND ((time >= ? AND time < ?) OR (time >= ? AND time < ?))");
    for boundary in [start, next(end)?, selected, next(selected)?] {
        values.push(Box::new(boundary.format("%Y-%m-%d 00:00:00").to_string()));
    }
    let sql = format!("SELECT substr(time,1,10), CAST(substr(time,12,2) AS INTEGER), COALESCE(source,''), COUNT(*) {predicate} GROUP BY 1,2,3");
    let params: Vec<&dyn ToSql> = values.iter().map(|v| v.as_ref()).collect();
    let mut days: BTreeMap<String, u64> = (0..=(end - start).num_days())
        .map(|n| ((start + Duration::days(n)).to_string(), 0))
        .collect();
    let mut hours = [0; 24];
    let mut sources = BTreeMap::<String, u64>::new();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, usize>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        task.check()?;
        let (day, hour, source, count) = row.map_err(|e| e.to_string())?;
        if let Some(total) = days.get_mut(&day) {
            *total += count;
        }
        if day == query.selected_date && hour < 24 {
            hours[hour] += count;
            *sources.entry(source).or_default() += count;
        }
    }
    task.check()?;
    let (selection, values) = search_where(
        &conn,
        &SearchQuery {
            time_filter: &query.time_filter,
            ..q
        },
    )?;
    let params: Vec<&dyn ToSql> = values.iter().map(|v| v.as_ref()).collect();
    let selection_count = conn
        .query_row(
            &format!("SELECT COUNT(*) {selection}"),
            params.as_slice(),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut sources: Vec<_> = sources
        .into_iter()
        .map(|(source, count)| SourceCount { source, count })
        .collect();
    sources.sort_by(|a, b| b.count.cmp(&a.count).then(a.source.cmp(&b.source)));
    sources.truncate(5);
    Ok(HistoryTimeDistribution {
        days: days
            .into_iter()
            .map(|(date, count)| DayCount { date, count })
            .collect(),
        selected_date: query.selected_date.clone(),
        hours,
        sources,
        selection_count,
    })
}
