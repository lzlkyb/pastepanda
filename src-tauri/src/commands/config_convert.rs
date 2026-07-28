/// 配置格式互转命令：properties ↔ YAML ↔ JSON。
/// 手写 properties parser（格式简单，无需外部 crate）。
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use tauri::State;

use crate::data_store::DataStore;

// ===== Properties 解析/序列化 =====

/// 解析 Java properties 格式为扁平 key-value 映射
fn parse_properties(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // 跳过空行和注释
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
            continue;
        }
        // 支持 = 和 : 作为分隔符
        let sep_pos = trimmed
            .find('=')
            .or_else(|| trimmed.find(':'))
            .unwrap_or(trimmed.len());
        let key = trimmed[..sep_pos].trim().to_string();
        let value = trimmed[sep_pos..].trim_start_matches(['=', ':']).trim().to_string();
        if !key.is_empty() {
            map.insert(key, value);
        }
    }
    map
}

/// 将扁平 key-value 映射序列化为 properties 格式
fn to_properties(map: &BTreeMap<String, String>) -> String {
    map.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n")
}

// ===== 扁平 ↔ 嵌套 JSON 互转 =====

/// 将扁平 "a.b.c" = "v" 转为嵌套 JSON
fn flat_to_nested(map: &BTreeMap<String, String>) -> JsonValue {
    let mut root = JsonValue::Object(serde_json::Map::new());
    for (key, value) in map {
        let parts: Vec<&str> = key.split('.').collect();
        let mut current = &mut root;
        for (i, part) in parts.iter().enumerate() {
            if i == parts.len() - 1 {
                current[*part] = JsonValue::String(value.clone());
            } else {
                if !current.get(part).map_or(false, |v| v.is_object()) {
                    current[*part] = JsonValue::Object(serde_json::Map::new());
                }
                current = &mut current[*part];
            }
        }
    }
    root
}

/// 将嵌套 JSON 转为扁平 "a.b.c" = "v"
fn nested_to_flat(value: &JsonValue, prefix: &str, out: &mut BTreeMap<String, String>) {
    match value {
        JsonValue::Object(map) => {
            for (k, v) in map {
                let new_prefix = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                nested_to_flat(v, &new_prefix, out);
            }
        }
        JsonValue::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        other => {
            out.insert(prefix.to_string(), other.to_string());
        }
    }
}

// ===== 格式检测 =====

/// 检测配置文本的格式
fn detect_format(text: &str) -> &'static str {
    let trimmed = text.trim();
    // JSON：以 { 或 [ 开头
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if serde_json::from_str::<JsonValue>(trimmed).is_ok() {
            return "json";
        }
    }
    // YAML：包含 "key:" 模式且不以 { 开头，或有 --- 文档标记
    if trimmed.starts_with("---") || trimmed.lines().any(|l| {
        let t = l.trim();
        !t.is_empty()
            && !t.starts_with('#')
            && (t.contains(": ") || t.ends_with(':'))
            && !t.contains('=')
    }) {
        return "yaml";
    }
    // Properties：包含 key=value 或 key:value 模式
    if trimmed.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('#') && !t.starts_with('!') && (t.contains('=') || t.contains(':'))
    }) {
        return "properties";
    }
    "properties" // 默认回退
}

// ===== 通用解析：任意格式 → 扁平 map =====

/// 将任意支持格式的配置文本解析为扁平 key-value 映射
fn parse_to_flat(text: &str, format: &str) -> Result<BTreeMap<String, String>, String> {
    match format {
        "properties" => Ok(parse_properties(text)),
        "yaml" => {
            let yaml_val: serde_yaml::Value =
                serde_yaml::from_str(text).map_err(|e| format!("YAML 解析失败: {e}"))?;
            let json_val = serde_json::to_value(&yaml_val)
                .map_err(|e| format!("YAML→JSON 中间转换失败: {e}"))?;
            let mut m = BTreeMap::new();
            nested_to_flat(&json_val, "", &mut m);
            Ok(m)
        }
        "json" => {
            let json_val: JsonValue =
                serde_json::from_str(text).map_err(|e| format!("JSON 解析失败: {e}"))?;
            let mut m = BTreeMap::new();
            nested_to_flat(&json_val, "", &mut m);
            Ok(m)
        }
        _ => Err(format!("不支持的格式: {format}")),
    }
}

// ===== Tauri 命令 =====

/// 检测配置格式
#[tauri::command]
pub fn detect_config_format(text: String) -> String {
    detect_format(&text).to_string()
}

/// 配置格式转换
#[tauri::command]
pub fn convert_config(text: String, from: String, to: String) -> Result<String, String> {
    if from == to {
        return Ok(text);
    }

    let flat = parse_to_flat(&text, &from)?;

    // 从中间表示序列化为目标格式
    match to.as_str() {
        "properties" => Ok(to_properties(&flat)),
        "json" => {
            let nested = flat_to_nested(&flat);
            serde_json::to_string_pretty(&nested).map_err(|e| format!("JSON 序列化失败: {e}"))
        }
        "yaml" => {
            let nested = flat_to_nested(&flat);
            serde_yaml::to_string(&nested).map_err(|e| format!("YAML 序列化失败: {e}"))
        }
        _ => Err(format!("不支持的目标格式: {to}")),
    }
}

/// 批量转换配置文件（读取文件 → 转换 → 写入目标路径）
#[tauri::command]
pub fn batch_convert_config(
    _store: State<DataStore>,
    paths: Vec<String>,
    to: String,
    output_dir: Option<String>,
) -> Result<Vec<ConvertResult>, String> {
    let mut results = Vec::new();

    for path_str in &paths {
        let path = std::path::Path::new(path_str);
        let result = (|| -> Result<String, String> {
            let content =
                std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
            let from = detect_format(&content).to_string();
            let converted = convert_config(content, from, to.clone())?;

            // 确定输出路径
            let out_path = if let Some(dir) = &output_dir {
                let file_name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let ext = match to.as_str() {
                    "yaml" => "yaml",
                    "json" => "json",
                    _ => "properties",
                };
                std::path::Path::new(dir).join(format!("{file_name}.{ext}"))
            } else {
                // 同目录，替换扩展名
                let ext = match to.as_str() {
                    "yaml" => "yaml",
                    "json" => "json",
                    _ => "properties",
                };
                path.with_extension(ext)
            };

            std::fs::write(&out_path, &converted)
                .map_err(|e| format!("写入失败: {e}"))?;
            Ok(out_path.to_string_lossy().to_string())
        })();

        match result {
            Ok(out_path) => results.push(ConvertResult {
                path: path_str.clone(),
                ok: true,
                output_path: Some(out_path),
                error: None,
            }),
            Err(e) => results.push(ConvertResult {
                path: path_str.clone(),
                ok: false,
                output_path: None,
                error: Some(e),
            }),
        }
    }

    Ok(results)
}

#[derive(serde::Serialize)]
pub struct ConvertResult {
    pub path: String,
    pub ok: bool,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

// ===== 配置语义 Diff =====

#[derive(serde::Serialize, Clone)]
pub struct ConfigDiffEntry {
    pub key: String,
    pub left_value: Option<String>,
    pub right_value: Option<String>,
    /// "same" | "modified" | "left_only" | "right_only"
    pub status: String,
}

#[derive(serde::Serialize)]
pub struct ConfigDiffResult {
    pub left_format: String,
    pub right_format: String,
    pub entries: Vec<ConfigDiffEntry>,
    pub same_count: usize,
    pub modified_count: usize,
    pub left_only_count: usize,
    pub right_only_count: usize,
}

/// 对两段配置文本做 key-value 语义级对比（自动检测格式，跨格式可比）
#[tauri::command]
pub fn diff_config(left: String, right: String) -> Result<ConfigDiffResult, String> {
    let left_format = detect_format(&left).to_string();
    let right_format = detect_format(&right).to_string();

    let left_map = parse_to_flat(&left, &left_format)?;
    let right_map = parse_to_flat(&right, &right_format)?;

    // 合并两侧 key（BTreeMap 天然有序）
    let all_keys: std::collections::BTreeSet<&String> =
        left_map.keys().chain(right_map.keys()).collect();

    let mut entries = Vec::with_capacity(all_keys.len());
    let (mut same_count, mut modified_count, mut left_only_count, mut right_only_count) =
        (0usize, 0usize, 0usize, 0usize);

    for key in all_keys {
        let lv = left_map.get(key);
        let rv = right_map.get(key);
        let status = match (lv, rv) {
            (Some(l), Some(r)) => {
                if l == r {
                    same_count += 1;
                    "same"
                } else {
                    modified_count += 1;
                    "modified"
                }
            }
            (Some(_), None) => {
                left_only_count += 1;
                "left_only"
            }
            (None, Some(_)) => {
                right_only_count += 1;
                "right_only"
            }
            (None, None) => unreachable!(),
        };
        entries.push(ConfigDiffEntry {
            key: key.clone(),
            left_value: lv.cloned(),
            right_value: rv.cloned(),
            status: status.to_string(),
        });
    }

    Ok(ConfigDiffResult {
        left_format,
        right_format,
        entries,
        same_count,
        modified_count,
        left_only_count,
        right_only_count,
    })
}

/// 对两个配置文件做语义对比（读取文件内容后调用 diff_config 逻辑）
#[tauri::command]
pub fn diff_config_files(left_path: String, right_path: String) -> Result<ConfigDiffResult, String> {
    let left = std::fs::read_to_string(&left_path)
        .map_err(|e| format!("读取左侧文件失败: {e}"))?;
    let right = std::fs::read_to_string(&right_path)
        .map_err(|e| format!("读取右侧文件失败: {e}"))?;
    diff_config(left, right)
}

/// 读取文本文件内容（供前端混合模式使用）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}
