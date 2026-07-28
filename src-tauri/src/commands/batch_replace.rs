/// 文件级批量查找替换命令（支持正则）。
/// 预览阶段只读不改；执行阶段先备份（.bak）再替换。
use regex::Regex;
use serde::Serialize;
use tauri::State;

use crate::data_store::DataStore;

#[derive(Serialize)]
pub struct MatchInfo {
    pub line: usize,
    pub col: usize,
    pub context: String,
}

#[derive(Serialize)]
pub struct PreviewFileResult {
    pub path: String,
    pub match_count: usize,
    pub matches: Vec<MatchInfo>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ReplaceFileResult {
    pub path: String,
    pub ok: bool,
    pub replaced_count: usize,
    pub backup_path: Option<String>,
    pub error: Option<String>,
}

/// 预览：在文件中查找匹配项（不修改文件）
#[tauri::command]
pub fn preview_replace(
    paths: Vec<String>,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<PreviewFileResult>, String> {
    let re = build_regex(&pattern, is_regex, case_sensitive)?;
    let mut results = Vec::new();

    for path in &paths {
        let result = (|| -> Result<Vec<MatchInfo>, String> {
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("读取失败（可能是二进制文件）: {e}"))?;
            let mut matches = Vec::new();
            for (line_idx, line) in content.lines().enumerate() {
                for m in re.find_iter(line) {
                    matches.push(MatchInfo {
                        line: line_idx + 1,
                        col: m.start() + 1,
                        context: truncate_context(line, m.start(), m.end()),
                    });
                }
            }
            Ok(matches)
        })();

        match result {
            Ok(matches) => {
                let count = matches.len();
                results.push(PreviewFileResult {
                    path: path.clone(),
                    match_count: count,
                    matches,
                    error: None,
                });
            }
            Err(e) => results.push(PreviewFileResult {
                path: path.clone(),
                match_count: 0,
                matches: Vec::new(),
                error: Some(e),
            }),
        }
    }

    Ok(results)
}

/// 执行替换（先备份 .bak）
#[tauri::command]
pub fn execute_replace(
    _store: State<DataStore>,
    paths: Vec<String>,
    pattern: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<ReplaceFileResult>, String> {
    let re = build_regex(&pattern, is_regex, case_sensitive)?;
    let mut results = Vec::new();

    for path in &paths {
        let result = (|| -> Result<(usize, String), String> {
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("读取失败: {e}"))?;

            let mut count = 0usize;
            let new_content = re
                .replace_all(&content, |caps: &regex::Captures| {
                    count += 1;
                    // 支持 $1 $2 捕获组引用
                    let mut result = replacement.clone();
                    for i in 0..caps.len() {
                        if let Some(m) = caps.get(i) {
                            result = result.replace(&format!("${i}"), m.as_str());
                        }
                    }
                    result
                })
                .to_string();

            if count == 0 {
                return Ok((0, String::new()));
            }

            // 备份
            let backup_path = format!("{path}.bak");
            std::fs::copy(path, &backup_path).map_err(|e| format!("备份失败: {e}"))?;

            // 写入
            std::fs::write(path, new_content).map_err(|e| format!("写入失败: {e}"))?;

            Ok((count, backup_path))
        })();

        match result {
            Ok((count, backup_path)) => results.push(ReplaceFileResult {
                path: path.clone(),
                ok: true,
                replaced_count: count,
                backup_path: if backup_path.is_empty() {
                    None
                } else {
                    Some(backup_path)
                },
                error: None,
            }),
            Err(e) => results.push(ReplaceFileResult {
                path: path.clone(),
                ok: false,
                replaced_count: 0,
                backup_path: None,
                error: Some(e),
            }),
        }
    }

    Ok(results)
}

/// 构建正则（非正则模式时转义为字面量）
fn build_regex(pattern: &str, is_regex: bool, case_sensitive: bool) -> Result<Regex, String> {
    let pat = if is_regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    let full = if case_sensitive {
        pat
    } else {
        format!("(?i){pat}")
    };
    Regex::new(&full).map_err(|e| format!("正则表达式无效: {e}"))
}

/// 截取匹配上下文（前后各 20 字符）
fn truncate_context(line: &str, start: usize, end: usize) -> String {
    let ctx_start = start.saturating_sub(20);
    let ctx_end = (end + 20).min(line.len());
    let prefix = if ctx_start > 0 { "…" } else { "" };
    let suffix = if ctx_end < line.len() { "…" } else { "" };
    format!("{prefix}{}{suffix}", &line[ctx_start..ctx_end])
}
