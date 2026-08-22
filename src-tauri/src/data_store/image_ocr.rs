//! 图片 OCR 结果缓存（表 `image_ocr_cache`）。
//!
//! 用途：主窗口卡片标题自动显示图片 OCR 文字（方案 B：持久化）。
//! 每张图片只识别一次，重启不重跑；`full_text` 为空串表示「识别过但无文字」，
//! 与「未识别过」（None）区分——后者会触发前端懒识别，前者阻止反复重试。
//!
//! 红线：只存图片路径与识别文本，不存图片本体；文本是本地 OCR（Windows 引擎）
//! 的产物，不联网、不出本机，不受 AI 总开关约束（claude.md 规则 16 第 4 条）。

use rusqlite::params;
use std::collections::HashMap;

impl crate::data_store::DataStore {
    /// 取某图片路径的 OCR 文本：
    /// - `Ok(None)` = 从未识别过（前端应懒触发识别）；
    /// - `Ok(Some(""))` = 识别过但无文字（不要再识别）；
    /// - `Ok(Some(text))` = 识别结果。
    pub fn get_ocr_text(&self, image_path: &str) -> Result<Option<String>, String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT full_text FROM image_ocr_cache WHERE image_path = ?1",
            params![image_path],
            |row| row.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    /// 批量取多条图片路径的 OCR 文本（历史查询回填用，一条 IN 查询避免 N+1）。
    /// 结果不含「未识别过」的路径（调用方按 None 处理）。
    pub fn get_ocr_texts(&self, paths: &[String]) -> Result<HashMap<String, String>, String> {
        let mut map = HashMap::new();
        if paths.is_empty() {
            return Ok(map);
        }
        let placeholders: Vec<String> = paths
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let sql = format!(
            "SELECT image_path, full_text FROM image_ocr_cache WHERE image_path IN ({})",
            placeholders.join(",")
        );
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            paths.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            if let Ok((path, text)) = row {
                map.insert(path, text);
            }
        }
        Ok(map)
    }

    /// 写入（upsert）某图片路径的 OCR 文本。`full_text` 为空串同样入库
    /// （表示识别过但无文字），避免无文字图片每次进视口都重新识别。
    ///
    /// 顺带把文本写进 `image_ocr_fts`：OCR 是**异步**的——图片先入库、文字后到，
    /// 那一刻这张图在索引里还没有任何可搜的文本。不在这里补一次，截图里的字永远搜不到。
    pub fn set_ocr_text(&self, image_path: &str, full_text: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO image_ocr_cache (image_path, full_text, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(image_path) DO UPDATE SET
                 full_text = excluded.full_text,
                 updated_at = excluded.updated_at",
            params![
                image_path,
                full_text,
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
            ],
        )
        .map_err(|e| e.to_string())?;

        // 同一张图可能被多条历史引用（跨工作区各存一条），故按路径全查 rowid。
        let rowids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT rowid FROM history WHERE type = 'image' AND content = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([image_path], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // 先删后插：重新识别时旧文本必须从索引里消失，否则搜旧词还能搜到已被更正的图。
        // 常规 FTS5 才支持这个（虚拟表不支持 UPSERT），这也是它不做外部内容表的原因。
        // 索引失败只 warn：搜不到是退化，不该让 OCR 结果本身存不进去。
        for rowid in rowids {
            let res = conn
                .execute("DELETE FROM image_ocr_fts WHERE rowid = ?1", params![rowid])
                .and_then(|_| {
                    if full_text.is_empty() {
                        // 识别过但无文字：只删不插，不留空行占位
                        Ok(0)
                    } else {
                        conn.execute(
                            "INSERT INTO image_ocr_fts (rowid, ocr) VALUES (?1, ?2)",
                            params![rowid, crate::data_store::history::to_ngram(full_text)],
                        )
                    }
                });
            if let Err(e) = res {
                log::warn!("[FTS] OCR 索引同步失败 (rowid={}): {}", rowid, e);
            }
        }
        Ok(())
    }

    /// 回填存量图片的 OCR 文本到 `image_ocr_fts`，返回回填条数。
    ///
    /// v6.18 之前识别过的图片，文本已在 `image_ocr_cache` 里但从未进过索引
    /// （那时这张索引还不存在）。启动时由 `DataStore::new` 在索引为空时调一次。
    ///
    /// 取 `&Connection` 而不是 `&self`：`new()` 里 DataStore 还没构造出来。
    pub(crate) fn backfill_ocr_fts_on(conn: &rusqlite::Connection) -> Result<u32, String> {
        // 先收集再写（同 backfill_content_types 的写法）：不在游标还活着时往同一连接上写。
        // 这里读 history/image_ocr_cache、写 image_ocr_fts，本来也不冲突，
        // 但分两步就不必让读者去推敲这件事。
        let pending: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT h.rowid, c.full_text
                     FROM history h JOIN image_ocr_cache c ON c.image_path = h.content
                     WHERE h.type = 'image' AND c.full_text <> ''",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut n = 0u32;
        for (rowid, full_text) in pending {
            // 单条失败不该让整批回填中断（同 history_fts 存量回填的容错取舍）
            if conn
                .execute(
                    "INSERT INTO image_ocr_fts (rowid, ocr) VALUES (?1, ?2)",
                    params![rowid, crate::data_store::history::to_ngram(&full_text)],
                )
                .is_ok()
            {
                n += 1;
            }
        }
        Ok(n)
    }
}
