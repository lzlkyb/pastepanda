//! 图片二维码/条形码解码（rxing，zxing 的纯 Rust 移植；本地解码、不联网，
//! 与 OCR 同属「本地能力」，不受 AI 总开关约束——claude.md 规则 16 第 4 条）。
//!
//! 设计对齐 `ocr_image_cached` 那一套：
//! - 结果进 `image_barcode_cache`（key=原始 path，见 image_barcode.rs 头注释的教训）；
//! - 「解码过但无码」也入库（空数组），阻止无码图片被反复送去解码；
//! - 重活（解码 + 灰度转换）放 spawn_blocking，不阻塞主线程。

use super::{check_image_decode_limits, validate_image_file_path};
use crate::data_store::{BarcodeHit, DataStore};
use image::GenericImageView;
use rxing::helpers::detect_multiple_in_luma_with_hints;
use rxing::{DecodeHints, ResultPoint};
use tauri::State;

/// 解码图片中的全部二维码/条形码（带持久化缓存）。
///
/// 返回空数组有两种情况：解码过但确实没码（缓存命中）、或图片正常但无码。
/// 命令失败（Err）仅代表「没跑成功」（文件坏/不支持），前端不缓存失败状态。
#[tauri::command]
pub async fn detect_barcodes_cached(
    store: State<'_, DataStore>,
    path: String,
) -> Result<Vec<BarcodeHit>, String> {
    // 先查库（与 ocr_image_cached 同：未校验路径也能查，缓存查询无害）。
    // 坏 JSON 行不当命中，落到下面重解码一次自愈。
    if let Some(json) = store.get_barcodes_json(&path)? {
        if let Some(hits) = DataStore::parse_barcodes_json(&json) {
            return Ok(hits);
        }
    }
    validate_image_file_path(&path)?;
    check_image_decode_limits(std::path::Path::new(&path))?;
    let path_inner = path.clone();
    let hits = tokio::task::spawn_blocking(move || detect_impl(&path_inner))
        .await
        .map_err(|e| format!("条码解码任务失败: {}", e))??;
    // 🔴 key 必须是原始 path（history.content 同源串），不是 canonicalize 结果。
    store.set_barcodes(&path, &hits)?;
    Ok(hits)
}

fn detect_impl(path: &str) -> Result<Vec<BarcodeHit>, String> {
    let canonical = validate_image_file_path(path)?;
    check_image_decode_limits(&canonical)?;
    let img = image::open(&canonical).map_err(|e| format!("读取图片失败: {e}"))?;
    let (w, h) = img.dimensions();
    let luma = img.to_luma8();

    let mut hints = DecodeHints::default();
    hints.TryHarder = Some(true);
    let results = match detect_multiple_in_luma_with_hints(luma.into_raw(), w, h, &mut hints) {
        Ok(rs) => rs,
        // 「没找到码」是正常结果不是错误：存空数组，下次不再重跑
        Err(rxing::Exceptions::NotFoundException(_)) => Vec::new(),
        Err(e) => return Err(format!("条码解码失败: {e}")),
    };

    let mut hits: Vec<BarcodeHit> = Vec::new();
    for r in &results {
        let text = r.getText().to_string();
        if text.is_empty() {
            continue;
        }
        // rxing 的结果点是码区角点（1D 码是四条边中点），统一收成外接矩形四角，
        // 预览叠框只用矩形——比透传原始点更稳（旋转/部分点位缺失都不用前端处理）。
        let pts = r.getPoints();
        let (min_x, max_x, min_y, max_y) = pts.iter().fold(
            (i32::MAX, i32::MIN, i32::MAX, i32::MIN),
            |(x0, x1, y0, y1), p| {
                let px = p.get_x().round() as i32;
                let py = p.get_y().round() as i32;
                (x0.min(px), x1.max(px), y0.min(py), y1.max(py))
            },
        );
        let points = if pts.is_empty() {
            [[0, 0], [0, 0], [0, 0], [0, 0]]
        } else {
            [[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y]]
        };
        hits.push(BarcodeHit {
            format: format!("{}", r.getBarcodeFormat()),
            text,
            points,
        });
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实二维码解码（前端 qrcode 库生成、固化在 tests/fixtures 的 PNG）。
    /// detect_impl 会走路径校验，先把 fixture 复制到临时目录再解。
    fn decode_fixture(name: &str) -> Vec<BarcodeHit> {
        let dir = std::env::temp_dir().join(format!("pastepanda_qr_test_{}", name));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{}.png", name));
        std::fs::write(
            &f,
            match name {
                "qr_url" => include_bytes!("../../tests/fixtures/qr_url.png") as &[u8],
                "qr_cn_text" => include_bytes!("../../tests/fixtures/qr_cn_text.png") as &[u8],
                _ => panic!("unknown fixture"),
            },
        )
        .unwrap();
        let hits = detect_impl(f.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        hits
    }

    #[test]
    fn decodes_qr_with_url_payload() {
        let hits = decode_fixture("qr_url");
        assert_eq!(hits.len(), 1, "应解出恰好一个码");
        assert_eq!(hits[0].text, "https://example.com/pastepanda-qr-test");
        // rxing 的 Display 是小写格式名（qrcode/code128…），前端展示文案再映射
        assert_eq!(hits[0].format, "qrcode");
        // 码位四角应落在图内（fixture 320×320 附近，含留白不做精确断言）
        for [x, y] in hits[0].points {
            assert!(x >= 0 && x < 400 && y >= 0 && y < 400, "码位坐标异常: {x},{y}");
        }
    }

    #[test]
    fn decodes_qr_with_chinese_payload() {
        let hits = decode_fixture("qr_cn_text");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "粘贴熊猫二维码识别测试🐼");
    }
}
