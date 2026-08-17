//! SQL 只读校验（编辑器增量 P1 · SQL 编辑器）
//!
//! 用途：SQLite `:memory:` 临时库 + `EXPLAIN` 做**语法校验**（不执行、不建表、
//! 不写任何数据），返回错误语句的起始行号与消息，供 SqlEditor 标红定位。
//!
//! 红线：只读校验 —— 非只读语句（INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/
//! ATTACH/VACUUM 等）直接拦截，绝不执行。

use rusqlite::Connection;

/// 校验结果（前端据此显示结果条 / 标红）
#[derive(serde::Serialize)]
pub struct SqlValidateResult {
    /// 是否全部语法通过
    pub ok: bool,
    /// 出错语句的起始行号（1 起；ok=true 时为 None）
    pub line: Option<usize>,
    /// 错误消息（ok=false 时）
    pub message: Option<String>,
    /// 被拆出的语句条数（校验了多少条）
    pub stmt_count: usize,
}

/// 只读语句关键字白名单（剥离注释/空白后，取首词判断）
const READONLY_PREFIXES: &[&str] = &[
    "select", "with", "explain", "pragma", "values",
];

/// 去掉 SQL 注释（-- 行注释 与 /* */ 块注释），返回剥离后的内容
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '-' if chars.peek() == Some(&'-') => {
                // 行注释：吃掉到行尾
                while let Some(n) = chars.next() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                // 块注释：吃掉到 */
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        break;
                    }
                    if n == '\n' {
                        out.push('\n');
                    }
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// 按 `;` 拆分多语句，返回 (语句, 起始行号) 列表（跳过空语句）。
///
/// 注释内（`--` 行注释 / `/* */` 块注释）的 `;` 不视为分隔符——否则会把含注释分号的
/// 合法语句错误拆碎，导致只读校验把正常 SQL 误判为语法错误（红线：只读校验不可误伤）。
fn split_statements(sql: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut start_line = 1;
    let mut line = 1;
    let mut in_single = false; // '...'
    let mut in_double = false; // "..."
    let mut in_line_comment = false; // -- ... （到行尾）
    let mut in_block_comment = false; // /* ... */
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        // 块注释内部：只寻找 */ 结束符，其余一律跳过（保留换行以对齐行号）
        if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next(); // 吃掉 '/'
                in_block_comment = false;
            } else if c == '\n' {
                line += 1;
                current.push('\n');
            }
            continue;
        }
        // 行注释内部：到行尾结束
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                line += 1;
                current.push('\n');
            }
            continue;
        }
        match c {
            // 换行与引号都要保留进 current（否则注释行会与后续语句粘连、引号丢失导致拆分错乱）
            '\n' => {
                line += 1;
                current.push('\n');
            }
            '-' if chars.peek() == Some(&'-') && !in_single && !in_double => {
                in_line_comment = true;
            }
            '/' if chars.peek() == Some(&'*') && !in_single && !in_double => {
                in_block_comment = true;
                chars.next(); // 吃掉 '*'
            }
            '\'' if !in_double => {
                in_single = !in_single;
                current.push('\'');
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push('"');
            }
            ';' if !in_single && !in_double => {
                let s = current.trim().to_string();
                // 跳过空语句与纯注释块（剥离注释后无有效内容）
                if !strip_comments(&s).trim().is_empty() {
                    out.push((s, start_line));
                }
                current.clear();
            }
            _ => {
                // 语句的第一个有效字符处记录起始行（current 里可能已有换行/空格等空白）
                if current.trim().is_empty() && !c.is_whitespace() {
                    start_line = line;
                }
                current.push(c);
            }
        }
    }
    if !current.trim().is_empty() {
        let s = current.trim().to_string();
        if !strip_comments(&s).trim().is_empty() {
            out.push((s, start_line));
        }
    }
    out
}

/// 语义错误特征：语法正确但引用了不存在的对象/函数 —— 只校验语法，这类视为通过
fn is_semantic_only(err: &str) -> bool {
    let e = err.to_lowercase();
    [
        "no such table",
        "no such column",
        "no such function",
        "no such index",
        "no such view",
        "no such collation",
    ]
    .iter()
    .any(|k| e.contains(k))
}

/// 校验单条语句的只读性：剥离注释后首词必须命中白名单
fn is_readonly(stmt: &str) -> bool {
    let cleaned = strip_comments(stmt);
    let first = cleaned
        .trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_lowercase();
    READONLY_PREFIXES.iter().any(|p| first == *p)
}

/// 对单条语句做语法校验：`:memory:` 临时库 + EXPLAIN（只读，无副作用）
fn explain_stmt(stmt: &str) -> Result<(), String> {
    let conn = Connection::open_in_memory().map_err(|e| format!("创建内存库失败: {e}"))?;
    conn.execute_batch(&format!("EXPLAIN {}", stmt))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// SQL 语法校验入口（Tauri command）
#[tauri::command]
pub fn sql_validate(sql: String) -> Result<SqlValidateResult, String> {
    // 空输入 / 超长保护
    if sql.trim().is_empty() {
        return Ok(SqlValidateResult { ok: true, line: None, message: None, stmt_count: 0 });
    }
    if sql.len() > 100_000 {
        return Ok(SqlValidateResult {
            ok: false,
            line: None,
            message: Some("SQL 过长（>100KB），请分段校验".to_string()),
            stmt_count: 0,
        });
    }

    let statements = split_statements(&sql);
    let total = statements.len();

    for (stmt, start_line) in &statements {
        // 红线①：非只读语句直接拦截（绝不执行）
        if !is_readonly(stmt) {
            return Ok(SqlValidateResult {
                ok: false,
                line: Some(*start_line),
                message: Some("仅支持只读校验（SELECT / WITH / EXPLAIN / PRAGMA），该语句可能修改数据，已拦截".to_string()),
                stmt_count: total,
            });
        }
        // 语法校验（EXPLAIN；语义类错误——表/列/函数不存在——视为语法通过）
        if let Err(e) = explain_stmt(stmt) {
            if !is_semantic_only(&e) {
                return Ok(SqlValidateResult {
                    ok: false,
                    line: Some(*start_line),
                    message: Some(e),
                    stmt_count: total,
                });
            }
        }
    }

    Ok(SqlValidateResult { ok: true, line: None, message: None, stmt_count: total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_select_passes() {
        let r = sql_validate("SELECT * FROM users WHERE id = 1;".to_string()).unwrap();
        assert!(r.ok);
        assert_eq!(r.stmt_count, 1);
    }

    #[test]
    fn multi_statements_all_valid() {
        let sql = "SELECT 1;\nSELECT 2;  -- 注释\nSELECT 'a;b';".to_string();
        let r = sql_validate(sql).unwrap();
        assert!(r.ok);
        assert_eq!(r.stmt_count, 3);
    }

    #[test]
    fn syntax_error_reports_line() {
        let sql = "SELECT 1;\nSELECT FROM WHERE;".to_string();
        let r = sql_validate(sql).unwrap();
        assert!(!r.ok);
        assert_eq!(r.line, Some(2));
        assert!(r.message.is_some());
    }

    #[test]
    fn write_statements_blocked() {
        for stmt in [
            "INSERT INTO t VALUES (1);",
            "UPDATE t SET a=1;",
            "DELETE FROM t;",
            "DROP TABLE t;",
            "CREATE TABLE t(id);",
            "ATTACH ':memory:' AS x;",
        ] {
            let r = sql_validate(stmt.to_string()).unwrap();
            assert!(!r.ok, "应拦截: {stmt}");
            assert!(r.message.unwrap().contains("只读"), "消息应提示只读: {stmt}");
        }
    }

    #[test]
    fn with_clause_and_pragma_allowed() {
        assert!(sql_validate("WITH x AS (SELECT 1) SELECT * FROM x;".to_string()).unwrap().ok);
        assert!(sql_validate("PRAGMA table_info(users);".to_string()).unwrap().ok);
    }

    #[test]
    fn empty_and_huge_input_handled() {
        assert!(sql_validate("   ".to_string()).unwrap().ok);
        let huge = "SELECT 1;".repeat(20_000);
        let r = sql_validate(huge).unwrap();
        assert!(!r.ok);
        assert!(r.message.unwrap().contains("过长"));
    }

    #[test]
    fn comment_stripped_for_readonly_check() {
        // 注释里的危险词不应影响判断
        let sql = "-- DELETE FROM t\nSELECT 1;".to_string();
        assert!(sql_validate(sql).unwrap().ok);
    }

    #[test]
    fn semicolon_inside_block_comment_not_split() {
        // 块注释里的分号不得被当作语句分隔符（此前会误拆导致合法 SQL 报语法错误）
        let sql = "SELECT * FROM t /* a ; b */ WHERE id = 1;".to_string();
        let r = sql_validate(sql).unwrap();
        assert!(r.ok, "报错: {:?}", r.message);
        assert_eq!(r.stmt_count, 1);
    }

    #[test]
    fn semicolon_inside_line_comment_not_split() {
        // 行注释里的分号不得被当作语句分隔符
        let sql = "SELECT 1; -- 分号;在这里\nSELECT 2;".to_string();
        let r = sql_validate(sql).unwrap();
        assert!(r.ok, "报错: {:?}", r.message);
        assert_eq!(r.stmt_count, 2);
    }
}
