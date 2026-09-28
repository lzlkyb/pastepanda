//! 图片二维码/条形码解码结果缓存（表 `image_barcode_cache`）。
//!
//! 用途：图片卡片自动显示「含二维码/条码」徽章 + 预览抽屉/右键菜单展示解码内容。
//! 与 `image_ocr_cache` 同一套纪律：每张图片只解码一次，重启不重跑；
//! `result_json` 为 "[]" 表示「解码过但没找到码」（与未解码过的 None 区分，
//! 防止无码图片被反复送去解码）。解码是本地 zxing-cpp，不联网、不出本机，
//! 不受 AI 总开关约束（claude.md 规则 16 第 4 条：本地能力不算 AI 功能）。
//!
//! 缓存 key 必须是**原始 path**（与 history.content 同源字符串）——
//! Windows 上 canonicalize 结果带 `\\?\` 前缀，两端对不上就永远查不到，
//! 教训见 image_ocr.rs 头注释。

use rusqlite::params;
use std::collections::HashMap;

/// 单个码的解码结果。points 为码区四角坐标（tl,tr,br,bl），供预览叠框。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BarcodeHit {
    /// zxing 格式名，如 "QRCode" / "Code128" / "DataMatrix"
    pub format: String,
    /// 解码文本
    pub text: String,
    /// 码区四角 [[x,y];4]
    pub points: [[i32; 2]; 4],
}

/// 缓存表里存的 JSON（Vec<BarcodeHit> 序列化）。
const EMPTY_HITS: &str = "[]";

impl crate::data_store::DataStore {
    /// 取某图片路径的解码结果 JSON：
    /// - `Ok(None)` = 从未解码过（前端应懒触发）；
    /// - `Ok(Some("[]"))` = 解码过但无码（不要再解码）；
    /// - `Ok(Some(json))` = 解码结果数组。
    pub fn get_barcodes_json(&self, image_path: &str) -> Result<Option<String>, String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT result_json FROM image_barcode_cache WHERE image_path = ?1",
            params![image_path],
            |row| row.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    /// 批量取多条图片路径的解码 JSON（历史查询回填用，一条 IN 查询避免 N+1，
    /// 同 get_ocr_texts 模式）。结果不含「未解码过」的路径。
    pub fn get_barcodes_json_map(
        &self,
        paths: &[String],
    ) -> Result<HashMap<String, String>, String> {
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
            "SELECT image_path, result_json FROM image_barcode_cache WHERE image_path IN ({})",
            placeholders.join(",")
        );
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = paths
            .iter()
            .map(|p| p as &dyn rusqlite::types::ToSql)
            .collect();
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for (path, json) in rows.flatten() {
            map.insert(path, json);
        }
        Ok(map)
    }

    /// 写入（upsert）某图片路径的解码结果。空结果同样入库（存 "[]"），
    /// 避免无码图片每次进视口都重新解码。
    pub fn set_barcodes(
        &self,
        image_path: &str,
        hits: &[BarcodeHit],
    ) -> Result<(), String> {
        let json = if hits.is_empty() {
            EMPTY_HITS.to_string()
        } else {
            serde_json::to_string(hits).map_err(|e| e.to_string())?
        };
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO image_barcode_cache (image_path, result_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(image_path) DO UPDATE SET
                 result_json = excluded.result_json,
                 updated_at = excluded.updated_at",
            params![
                image_path,
                json,
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 解析缓存 JSON。坏行（历史脏数据）当 None 处理，让前端重新解码一次自愈。
    pub fn parse_barcodes_json(json: &str) -> Option<Vec<BarcodeHit>> {
        serde_json::from_str(json).ok()
    }
}
