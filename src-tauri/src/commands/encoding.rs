/// 编码检测与批量转码命令。
/// 使用 chardetng 检测编码，encoding_rs 执行转换。
/// 转换前自动备份原文件（同目录 .bak 后缀）。
use serde::Serialize;
use tauri::State;

use crate::data_store::DataStore;

#[derive(Serialize)]
pub struct EncodingDetectResult {
    pub path: String,
    pub encoding: String,
    pub confidence: f32,
    pub has_bom: bool,
}

#[derive(Serialize)]
pub struct ConvertFileResult {
    pub path: String,
    pub ok: bool,
    pub backup_path: Option<String>,
    pub error: Option<String>,
}

/// 检测单个文件的编码
#[tauri::command]
pub fn detect_file_encoding(path: String) -> Result<EncodingDetectResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;

    // BOM 检测
    let (has_bom, content_bytes) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (true, &bytes[3..])
    } else if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        (true, &bytes[2..])
    } else {
        (false, bytes.as_slice())
    };

    // 使用 chardetng 检测
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(content_bytes, true);
    let encoding = detector.guess(None, true);

    Ok(EncodingDetectResult {
        path,
        encoding: encoding.name().to_string(),
        confidence: 0.8, // chardetng 不直接给置信度，给一个合理默认值
        has_bom,
    })
}

/// 转换单个文件编码（自动备份）
#[tauri::command]
pub fn convert_file_encoding(
    path: String,
    target_encoding: String,
    remove_bom: bool,
) -> Result<ConvertFileResult, String> {
    let result = do_convert(&path, &target_encoding, remove_bom);
    match result {
        Ok(backup_path) => Ok(ConvertFileResult {
            path: path.clone(),
            ok: true,
            backup_path,
            error: None,
        }),
        Err(e) => Ok(ConvertFileResult {
            path: path.clone(),
            ok: false,
            backup_path: None,
            error: Some(e),
        }),
    }
}

/// 批量转换文件编码
#[tauri::command]
pub fn batch_convert_encoding(
    _store: State<DataStore>,
    paths: Vec<String>,
    target_encoding: String,
    remove_bom: bool,
) -> Result<Vec<ConvertFileResult>, String> {
    let mut results = Vec::new();
    for path in &paths {
        let result = do_convert(path, &target_encoding, remove_bom);
        match result {
            Ok(backup_path) => results.push(ConvertFileResult {
                path: path.clone(),
                ok: true,
                backup_path,
                error: None,
            }),
            Err(e) => results.push(ConvertFileResult {
                path: path.clone(),
                ok: false,
                backup_path: None,
                error: Some(e),
            }),
        }
    }
    Ok(results)
}

/// 内部转换逻辑
fn do_convert(path: &str, target_encoding: &str, remove_bom: bool) -> Result<Option<String>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;

    // 检测当前编码。这里只需要剥掉 BOM 后的字节；
    // “要不要给输出加 BOM”只看参数 remove_bom 与目标编码（见下方写入处），
    // 不看源文件原本有没有 BOM，所以这个布尔值在本函数里用不到。
    // （对外暴露 has_bom 的是上面的检测命令，给界面展示用。）
    let (_has_bom, content_bytes) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (true, &bytes[3..])
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (true, &bytes[2..])
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (true, &bytes[2..])
    } else {
        (false, bytes.as_slice())
    };

    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(content_bytes, true);
    let src_encoding = detector.guess(None, true);

    // 获取目标编码
    let target_enc = encoding_rs::Encoding::for_label(target_encoding.as_bytes())
        .ok_or_else(|| format!("不支持的目标编码: {target_encoding}"))?;

    // 解码为 UTF-8 字符串
    let (decoded, _, had_errors) = src_encoding.decode(content_bytes);
    if had_errors {
        return Err(format!(
            "文件包含无法以 {} 正确解码的字节",
            src_encoding.name()
        ));
    }

    // 编码为目标格式
    let (encoded, _, enc_errors) = target_enc.encode(&decoded);
    if enc_errors {
        return Err(format!(
            "内容包含无法转换为 {} 的字符",
            target_enc.name()
        ));
    }

    // 备份原文件
    let backup_path = format!("{path}.bak");
    std::fs::copy(path, &backup_path).map_err(|e| format!("备份文件失败: {e}"))?;

    // 写入（可选加 BOM）
    let mut output: Vec<u8> = Vec::new();
    if !remove_bom && target_enc == encoding_rs::UTF_8 {
        output.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    output.extend_from_slice(&encoded);

    std::fs::write(path, &output).map_err(|e| format!("写入文件失败: {e}"))?;

    Ok(Some(backup_path))
}
