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
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}
