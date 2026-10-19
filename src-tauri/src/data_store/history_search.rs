//! The list and the time explorer must count the same matches, including OCR and summaries.
use super::history::{fts_safe, push_time_bound, to_ngram, SearchQuery};
use rusqlite::{Connection, ToSql};

pub(super) fn search_where(
    conn: &Connection,
    q: &SearchQuery,
) -> Result<(String, Vec<Box<dyn ToSql>>), String> {
    if q.time_filter.starts_with("window:")
        && !matches!(
            super::history::time_bound(q.time_filter),
            super::history::TimeBound::Window(_, _)
        )
    {
        return Err("时间范围无效".into());
    }
    let mut sql = "FROM history WHERE workspace = ?".to_string();
    let mut values: Vec<Box<dyn ToSql>> = vec![Box::new(q.workspace.to_string())];
    if !q.search.is_empty() {
        sql.push_str(" AND (text LIKE ? ESCAPE '\\' OR pinyin_initials LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR id IN (SELECT history_id FROM history_summaries WHERE summary LIKE ? ESCAPE '\\')");
        let pattern = format!("%{}%", super::escape_like_pattern(q.search));
        for _ in 0..4 {
            values.push(Box::new(pattern.clone()));
        }
        // Older databases without either FTS table keep the literal fallback. A union,
        // rather than a per-page fallback, keeps day/hour totals additive and truthful.
        let fts = !q.search.trim().is_empty() && fts_safe(q.search) && conn.query_row(
            "SELECT COUNT(*) = 2 FROM sqlite_schema WHERE name IN ('history_fts','image_ocr_fts') AND type='table'",
            [], |r| r.get::<_, bool>(0),
        ).map_err(|e| e.to_string())?;
        if fts {
            let tokens = to_ngram(q.search)
                .split_whitespace()
                .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ");
            sql.push_str(" OR rowid IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?) OR rowid IN (SELECT rowid FROM image_ocr_fts WHERE image_ocr_fts MATCH ?)");
            values.push(Box::new(tokens.clone()));
            values.push(Box::new(tokens));
        }
        sql.push(')');
    }
    match q.filter {
        "all" => {}
        "pinned" => sql.push_str(" AND pinned = 1"),
        "image" => sql.push_str(" AND type IN ('image','rich')"),
        "text" => sql.push_str(" AND type IN ('text','diagram','doc')"),
        other => {
            sql.push_str(" AND type = ?");
            values.push(Box::new(other.to_string()));
        }
    }
    push_time_bound(&mut sql, &mut values, q.time_filter);
    if !q.source.is_empty() {
        sql.push_str(" AND source = ?");
        values.push(Box::new(q.source.to_string()));
    }
    match q.group_filter {
        "all" | "" => {}
        "ungrouped" => sql.push_str(" AND group_id IS NULL"),
        group => {
            sql.push_str(" AND group_id = ?");
            values.push(Box::new(group.to_string()));
        }
    }
    for tag in q.tag_ids {
        sql.push_str(" AND id IN (SELECT history_id FROM history_tags WHERE tag_id = ?)");
        values.push(Box::new(tag.clone()));
    }
    Ok((sql, values))
}
