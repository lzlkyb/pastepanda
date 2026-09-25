//! 待办扫描（灵动岛 B2）的**只读**数据面。
//!
//! 为什么只有两条查询：扫描 orchestration（缓存、解析、排序、推送）都在
//! `crate::todo_tasks`，这里只给它开两扇最小的门——
//! 「哪些笔记活着、各自什么版本」和「单篇正文」。
//!
//! 🔴 写入**不**在这一层：勾选回写必须走既有 `note_update`
//! （版本快照、`updated_ms`、同步可见性都是它顺带保证的），见实施方案 §5 #9。

use super::DataStore;

/// 扫描索引行：`(id, title, updated_ms, daily_date)`。
pub type TaskIndexRow = (String, String, i64, Option<String>);

impl DataStore {
    /// 活笔记的扫描索引：`(id, title, updated_ms, daily_date)`。
    ///
    /// 故意**不碰 `content`**：正文可能很大，而扫描是「每次笔记变动都可能跑」的
    /// 常客。缓存命中（`updated_ms` 没变）时根本不需要正文；
    /// 未命中的那几篇由调用方拿 id 走 [`Self::note_content_raw`] 单取。
    /// 这条查询是每次刷新的固定成本——一列一扫，万条笔记也就毫秒级。
    pub fn note_active_task_index(&self) -> Result<Vec<TaskIndexRow>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(
                "SELECT id, title, updated_ms, daily_date \
                 FROM notes WHERE deleted_at IS NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 单篇正文。[`Self::note_active_task_index`] 的未命中路径专用。
    ///
    /// 不用 `note_get`：那个连 tags 都查，扫描要的只是正文这一列。
    pub fn note_content_raw(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.lock_conn();
        match conn.query_row("SELECT content FROM notes WHERE id = ?1", [id], |r| r.get::<_, String>(0)) {
            Ok(c) => Ok(Some(c)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}
