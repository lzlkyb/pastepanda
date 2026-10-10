//! 「排序不许留平手」的守卫（2026-10-09）。
//!
//! 起因是一条 CI 独有的判红：`created_at` 只存到**毫秒**、`history.time` 只存到**秒**，
//! 于是快机器上两行常落进同一个键值变成平手，此时**相对顺序由 SQLite 自由安排**
//! （随执行计划、索引、ANALYZE 统计、VACUUM 而变）。后果分两级：
//!   • 展示级——同一份数据两次打开顺序不同；
//!   • 真缺陷——`LIMIT ? OFFSET ?` 分页时同一条重复出现 / 另一条永远跌页。
//!
//! `kb_inbox.rs` 的 `order_by` 注释早就写了「最后那道是为了结果稳定：不加的话分页会
//! 重复/跌页」，但三条臂里只有一条真带上了那道次键——**注释是真话、代码是半条**，
//! 这正是机器守卫比人眼可靠的地方。
//!
//! 口径：`data_store` 下每条 SQL 的 `ORDER BY` 都必须以一个**确定性的最后一键**收尾。
//! 要么显式次键（`rowid` / 业务唯一列），要么该键本身就是分组唯一键。
//! 例外走 `ALLOWED` 白名单，必须写清「为什么平手不可能」或「为什么平手无害」。
//!
//! 两条通道：
//!   • A——从 `ORDER BY` 往后取到字面量收尾引号（注释行里的命中剔除）。主力，可靠。
//!   • B——被 `format!` 当 `{order}` 拼进去的**排序体字面量**（如 `"h.time DESC, h.rowid DESC"`）。
//!     逐行在 `//` 之前按引号配对切，并要求整段只由列名字符组成——是启发式，
//!     **不保证抓全**，但抓到的每条都是真在用的排序片段。
//!
//! 🔴 次键选 `rowid` 还是 `id` 归人判断，本守卫查不出来：它只验「确定性」，
//! 而随机 uuid v4 的 `notes.id` **也是**确定的（同一份数据两次排同一个序，分页不重复不跌页），
//! 所以 `id` 收尾能过守卫。区别在语义——`rowid` 是本地插入序（展示要它），
//! `id` 是掷骰子；而喂给摘要/幂等/增量同步的流要的恰恰是后者
//! （`sync/digest.rs` 的 `ORDER BY updated_ms, id` 是跨机契约，不是外观，见 `ALLOWED`）。

use std::path::Path;

/// 取一条 ORDER BY 子句的最后一个键（去掉关键词、LIMIT/OFFSET 与续行反斜杠）。
fn tail_key(clause: &str) -> String {
    let start = clause.find("ORDER BY").map(|i| i + 8).unwrap_or(0);
    let mut c = clause[start..].replace('\\', " ");
    for cut in ["LIMIT", "OFFSET", "limit", "offset"] {
        if let Some(i) = c.find(cut) {
            c.truncate(i);
        }
    }
    c.split(',').last().unwrap_or("").trim().to_string()
}

/// 把 `notes.rowid DESC` / `grp COLLATE NOCASE ASC` / `t.name ASC` 这类键压成裸列名。
fn bare_column(tail: &str) -> String {
    let mut s = tail
        .to_lowercase()
        .replace("desc", "")
        .replace("asc", "")
        .replace("collate", "")
        .replace("nocase", "")
        .replace(['(', ')', ' '], "")
        .trim_matches('.')
        .to_string();
    // `t.name` / `notes.title` / `mobile.last_access_at` 一律按列名比对，别名交给唯一性判断。
    if let Some(i) = s.rfind('.') {
        s = s[i + 1..].to_string();
    }
    s
}

/// 唯一列 / 分组键：这些值在结果里天然不重复，平手不可能。
const UNIQUE_COLUMNS: &[&str] = &[
    "id",
    "action_id",
    "content_type",
    "source",
    "client",
    "name",
    "tag_id",
    "daily_date",
    "note_id",
    "d",
    "hour",
    "grp",
];

fn is_deterministic(tail: &str) -> bool {
    let t = tail.to_lowercase();
    if t.contains("rowid") {
        return true;
    }
    let col = bare_column(tail);
    // 分组键作末键时（`GROUP BY x ORDER BY x` 之类）也算确定；用等值判断而非前缀。
    UNIQUE_COLUMNS.contains(&col.as_str())
}

/// 已知例外：文件 → 子句里出现的片段 → 为什么安全。
///
/// 🔴 新增例外必须写理由；空理由的例外等于把守卫关掉一半。
const ALLOWED: &[(&str, &str, &str)] = &[
    (
        "note.rs",
        "ORDER BY sort_order",
        "分组/排序面板的显式次序，同值由上层重排保证",
    ),
    ("note.rs", "ORDER BY t.name", "标签名唯一，不可能平手"),
    (
        "note.rs",
        "ORDER BY updated_ms, id",
        "同步增量流：按跨机复制的 uuid 递进，是契约不是外观",
    ),
    (
        "note.rs",
        "\"grp DESC\"",
        "分组键（按月聚合），组间天然唯一；且它是拼进 ORDER BY 的前半",
    ),
    (
        "note.rs",
        "\"grp COLLATE NOCASE ASC\"",
        "分组键（按目录/标签聚合），组间天然唯一；同上半拼",
    ),
    ("tag.rs", "ORDER BY name ASC", "标签名唯一"),
    (
        "content_classifier.rs",
        "ORDER BY name",
        "SQL 格式化单测的样本串，不执行——本守卫唯一不在真 SQL 上的命中",
    ),
    (
        "group.rs",
        "ORDER BY sort_order ASC",
        "sort_order 保存时逐个赋值；无分页，展示层平手无害",
    ),
    (
        "chains.rs",
        "ORDER BY sort_order",
        "链内成员顺序由加入时分配，不重复",
    ),
    (
        "note.rs",
        "ORDER BY source_agent",
        "SELECT DISTINCT 单列，返回值天然不重复",
    ),
    (
        "pref_signals.rs",
        "ORDER BY n DESC, s.feature ASC",
        "GROUP BY s.feature 之后的分组键，组间天然唯一（且只取 1 行）",
    ),
    ("profile.rs", "ORDER BY hour", "分组键（0..23），天然唯一"),
    (
        "profile.rs",
        "\"ORDER BY d ASC\"",
        "分组键（按天），天然唯一",
    ),
    (
        "note_daily.rs",
        "ORDER BY daily_date",
        "同一天多行返回的是同一个日期串，谁在前看不出差别（日历打点）",
    ),
    (
        "config.rs",
        "ORDER BY COUNT(*) DESC, source ASC",
        "本身就是带次键的写法，末键 source 是分组键",
    ),
    (
        "kb_inbox.rs",
        "\"grp COLLATE NOCASE ASC\"",
        "分组键（类型/来源/原因三档），组间天然唯一",
    ),
    (
        "mobile_knowledge.rs",
        "\"mobile.last_access_at DESC\"",
        "只是 `ORDER BY {order}, notes.id DESC` 的前半，次键在格式串里",
    ),
    (
        "mobile_knowledge.rs",
        "\"notes.updated_ms DESC\"",
        "只是 `ORDER BY {order}, notes.id DESC` 的前半，次键在格式串里",
    ),
];

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(p);
        }
    }
}

/// 通道 A：文件里所有「SQL 语境」的 ORDER BY 子句（返回文本含关键词本身）。
fn clauses_in(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, _) in src.match_indices("ORDER BY") {
        // 命中在注释里（那是在复述上面某条）就跳过。
        let line_start = src[..i].rfind('\n').map(|p| p + 1).unwrap_or(0);
        if src[line_start..i].trim_start().starts_with("//") {
            continue;
        }
        let after = &src[i + 8..];
        let end = after.find('"').unwrap_or_else(|| after.len().min(240));
        let body = &after[..end];
        if body.trim().is_empty() || body.trim_end().ends_with(',') {
            continue; // 动态拼接的头部，由通道 B 管它拼进去的那些片段
        }
        if body.trim() == "{}" {
            continue; // 同上：整段排序都来自 `{}`，次键由通道 B 盯候选臂
        }
        out.push(format!("ORDER BY{body}"));
    }
    out
}

/// 通道 B：排序体字面量——被 `format!` 当 `{order}` 使的 `"col DESC, …"`。
///
/// 只在代码部分（`//` 之前）按引号配对切；闭合引号找得到才算一条。
fn body_literals_in(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in src.lines() {
        let code: Vec<char> = match line.find("//") {
            Some(i) => line[..i].chars().collect(),
            None => line.chars().collect(),
        };
        let mut i = 0usize;
        while i < code.len() {
            if code[i] != '"' {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < code.len() {
                if code[j] == '\\' {
                    j += 2;
                    continue;
                }
                if code[j] == '"' {
                    break;
                }
                j += 1;
            }
            if j >= code.len() {
                break; // 本行不闭合（多行字面量），由通道 A 的 ORDER BY 命中负责
            }
            let t: String = code[i + 1..j].iter().collect();
            let t = t.trim();
            let looks_like_order_body = !t.is_empty()
                && !t.contains("ORDER BY")
                && (t.contains("DESC") || t.contains("ASC"))
                && !t.ends_with(',')
                && t.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_. ,()".contains(c));
            if looks_like_order_body {
                out.push(format!("\"{t}\""));
            }
            i = j + 1;
        }
    }
    out
}

#[test]
fn every_order_by_ends_with_a_deterministic_key() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect(&dir, &mut files);
    assert!(
        files.len() > 20,
        "只扫到 {} 个文件，守卫等于没跑",
        files.len()
    );

    let mut violations: Vec<String> = Vec::new();
    let mut seen = 0usize;
    for f in &files {
        let Some(name) = f.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // 本文件的注释里满是 ORDER BY 字面量；测试用例的顺序由各自的断言负责。
        if name == "tests_ordering.rs" || name.starts_with("tests") {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(f) else {
            continue;
        };
        for clause in clauses_in(&src).into_iter().chain(body_literals_in(&src)) {
            seen += 1;
            let tail = tail_key(&clause);
            if tail.is_empty() || is_deterministic(&tail) {
                continue;
            }
            let flat = clause.replace('\\', " ");
            if let Some((_, _, why)) = ALLOWED
                .iter()
                .find(|(f2, frag, _)| *f2 == name && (flat.contains(frag) || clause.contains(frag)))
            {
                assert!(!why.is_empty(), "{name} 的例外没写理由：{clause}");
                continue;
            }
            violations.push(format!("{name} ｜ 末键「{tail}」｜ 片段：{clause}"));
        }
    }
    assert!(
        seen >= 30,
        "只解析到 {seen} 条排序键，多半是提取逻辑失效（守卫自欺）"
    );
    assert!(
        violations.is_empty(),
        "这些排序留了平手：同毫秒/同秒的相对顺序由 SQLite 自由安排，分页会重复或跌页\n{}",
        violations.join("\n")
    );
}
