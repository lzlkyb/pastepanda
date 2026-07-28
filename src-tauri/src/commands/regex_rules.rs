/// 正则规则 CRUD 命令：从 localStorage 迁移到 SQLite 持久化。
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::data_store::DataStore;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RegexRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub replacement: String,
    pub flags: String,
    pub enabled: bool,
    pub preset: bool,
    pub sort_order: i32,
}

/// 获取所有正则规则（按 sort_order 排序）
#[tauri::command]
pub fn get_regex_rules(store: State<DataStore>) -> Result<Vec<RegexRule>, String> {
    let conn = store.conn.lock().map_err(|e| format!("锁获取失败: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT id, name, pattern, replacement, flags, enabled, preset, sort_order FROM regex_rules ORDER BY sort_order, id")
        .map_err(|e| format!("查询正则规则失败: {e}"))?;

    let rules: Vec<RegexRule> = stmt
        .query_map([], |row| {
            Ok(RegexRule {
                id: row.get(0)?,
                name: row.get(1)?,
                pattern: row.get(2)?,
                replacement: row.get(3)?,
                flags: row.get(4)?,
                enabled: row.get::<_, i32>(5)? != 0,
                preset: row.get::<_, i32>(6)? != 0,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| format!("遍历正则规则失败: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rules)
}

/// 批量保存正则规则（全量替换：先清空再插入）
/// 前端维护完整规则列表，一次性提交。简化了增删改排序的复杂度。
#[tauri::command]
pub fn save_regex_rules(store: State<DataStore>, rules: Vec<RegexRule>) -> Result<usize, String> {
    let mut conn = store.conn.lock().map_err(|e| format!("锁获取失败: {e}"))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;

    tx.execute("DELETE FROM regex_rules", [])
        .map_err(|e| format!("清空正则规则失败: {e}"))?;

    let count = rules.len();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO regex_rules (id, name, pattern, replacement, flags, enabled, preset, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| format!("准备插入语句失败: {e}"))?;

        for r in &rules {
            stmt.execute(params![
                r.id,
                r.name,
                r.pattern,
                r.replacement,
                r.flags,
                r.enabled as i32,
                r.preset as i32,
                r.sort_order,
            ])
            .map_err(|e| format!("插入规则 {} 失败: {e}", r.id))?;
        }
    }

    tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(count)
}
