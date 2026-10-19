use super::{DatabaseUsage, ReadTask, TableUsage};
use rusqlite::Connection;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

fn schema(conn: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT name, type, tbl_name FROM sqlite_schema WHERE type IN ('table','index')")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn shadow_tables(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("PRAGMA main.table_list")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(|e| e.to_string())?;
    let mut shadows = HashSet::new();
    for row in rows {
        let (name, kind) = row.map_err(|e| e.to_string())?;
        if kind == "shadow" {
            shadows.insert(name);
        }
    }
    Ok(shadows)
}

fn business_names<'a>(
    objects: &'a [(String, String, String)],
    shadows: &HashSet<String>,
) -> HashSet<&'a str> {
    objects
        .iter()
        .filter(|(n, t, _)| t == "table" && !n.starts_with("sqlite_") && !shadows.contains(n))
        .map(|(n, _, _)| n.as_str())
        .collect()
}

pub fn database_usage(path: &Path, task: &ReadTask) -> Result<DatabaseUsage, String> {
    let conn = task.connect(path)?;
    query_usage(&conn, task)
}

fn query_usage(conn: &Connection, task: &ReadTask) -> Result<DatabaseUsage, String> {
    let page_size: u64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_count: u64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let free_count: u64 = conn
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let objects = schema(conn)?;
    let shadows = shadow_tables(conn)?;
    let names = business_names(&objects, &shadows);
    let mut sizes = HashMap::<String, u64>::new();
    let supported = conn
        .query_row(
            "SELECT sqlite_compileoption_used('ENABLE_DBSTAT_VTAB')",
            [],
            |r| r.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if supported {
        let mut stmt = conn
            .prepare("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))
            .map_err(|e| e.to_string())?
        {
            task.check()?;
            let (name, size) = row.map_err(|e| e.to_string())?;
            sizes.insert(name, size);
        }
    }
    let mut tables = Vec::new();
    for name in &names {
        task.check()?;
        // Only SQLite-declared shadow tables can be grouped. A real future table with
        // a matching FTS prefix remains independent instead of silently disappearing.
        let internal: Vec<String> = shadows
            .iter()
            .filter(|s| {
                names
                    .iter()
                    .filter(|n| s.starts_with(&format!("{n}_")))
                    .max_by_key(|n| n.len())
                    .is_some_and(|owner| owner == name)
            })
            .cloned()
            .collect();
        let owns = |n: &str| n == *name || internal.iter().any(|s| s == n);
        let table_bytes = sizes.iter().filter(|(n, _)| owns(n)).map(|(_, b)| *b).sum();
        let index_bytes = objects
            .iter()
            .filter(|(_, t, owner)| t == "index" && owns(owner))
            .map(|(n, _, _)| sizes.get(n).copied().unwrap_or(0))
            .sum();
        tables.push(TableUsage {
            name: name.to_string(),
            table_bytes: supported.then_some(table_bytes),
            index_bytes: supported.then_some(index_bytes),
            internal_tables: internal,
        });
    }
    tables.sort_by(|a, b| {
        b.table_bytes
            .unwrap_or(0)
            .saturating_add(b.index_bytes.unwrap_or(0))
            .cmp(
                &a.table_bytes
                    .unwrap_or(0)
                    .saturating_add(a.index_bytes.unwrap_or(0)),
            )
            .then(a.name.cmp(&b.name))
    });
    let assigned: u64 = tables
        .iter()
        .map(|t| t.table_bytes.unwrap_or(0) + t.index_bytes.unwrap_or(0))
        .sum();
    let page_bytes = page_size * page_count;
    let free_bytes = page_size * free_count;
    Ok(DatabaseUsage {
        page_bytes,
        free_bytes,
        other_bytes: supported.then_some(
            page_bytes
                .saturating_sub(free_bytes)
                .saturating_sub(assigned),
        ),
        size_supported: supported,
        tables,
    })
}
