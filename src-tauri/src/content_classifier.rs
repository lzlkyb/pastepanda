//! 内容自动分类引擎 — 纯本地规则引擎
//!
//! 对剪贴板文本内容进行分类，返回标签名列表。
//! 每条记录分类耗时 < 0.5ms，零外部 API 依赖。

use regex::Regex;
use std::sync::LazyLock;

/// 分类结果 — 标签名列表（如 ["代码", "JavaScript"]）
pub type Labels = Vec<String>;

// ===== URL 检测 =====
static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(https?|ftp|file|ws|wss|sftp|telnet|ssh|rdp)://[^\s]+$").unwrap()
});

// ===== 日志时间戳格式 =====
static LOG_TS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)(^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\]|^\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2}|\[\d{2}/[A-Z][a-z]{2}/\d{4}:\d{2}:\d{2}:\d{2}|^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s+\d{2}:\d{2}:\d{2})").unwrap()
});
static LOG_LEVEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(DEBUG|INFO|WARN(ING)?|ERROR|FATAL|TRACE|NOTICE|CRITICAL)\b").unwrap()
});

// ===== 命令行检测 =====
static CMD_ARG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\s(--?[\w-]+|[\w./\\]+)").unwrap()
});

// ===== 配置文件检测 =====
static YAML_LINE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*[\w.-]+\s*:\s+").unwrap()
});
static TOML_SECTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*\[[\w.]+\]\s*$").unwrap()
});
static ENV_LINE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*[A-Z_][A-Z0-9_]*\s*=\s*").unwrap()
});

// ===== 密钥/Token 检测 =====
static JWT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$").unwrap()
});
static BASE64_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9+/]+={0,2}$").unwrap()
});

// ===== 个人信息（PII）—— **仅用于出网判据**，不进 `is_secret` =====
//
// 为何单独一套：`is_secret` 同时服务于内容分类（clipboard_monitor 是否记录、
// history / content_memory 是否排除）。把邮箱/IP 加进去会让日常内容大面积被当密钥
// 处理，代价太大；而“发给第三方”这个动作的风险阀值本来就应该更低。
// 前端 `lib/mask.ts`（粘贴守卫）一直认这 4 类，而出网侧不认——方向是反的：
// 强判据装在“本地粘贴”上，弱判据装在“发给云端”上。本节就是把那半扇门补上。
static PII_PHONE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"1[3-9][0-9]{9}").unwrap());
static PII_ID_CARD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]{17}[0-9Xx]").unwrap());
static PII_IPV4_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]{1,3}(?:\.[0-9]{1,3}){3}").unwrap());
static PII_EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap()
});
// 与下方已有的 EMAIL_RE / PHONE_RE 区分开：那两个是**锚定**的（`^…$`），回答的是
// “整条内容就是一个邮箱/手机号吗”，给内容类型分类用；这里的 PII_* 是**内嵌**匹配，
// 回答的是“文本里含不含个人信息”。两者是不同问题，不能合并。

/// 要求匹配两侧不是 ASCII 数字，等价于 `(?<!\d)…(?!\d)`。
///
/// Rust 的 regex crate 不支持环视，而前端 `mask.ts` 用的就是环视。用 `\b` 代替会
/// 比前端**更宽松**（`abc13812345678` 这种字母紧贴数字的情况会漏），而这是安全闸，
/// 寄严不寄宽，所以手工查边界保证与前端同语义。
fn has_match_digit_bounded(re: &Regex, text: &str) -> bool {
    re.find_iter(text).any(|m| {
        let left_ok = text[..m.start()]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_ascii_digit());
        let right_ok = text[m.end()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_digit());
        left_ok && right_ok
    })
}

/// 已知服务商的密钥前缀清单。
///
/// 这些串普遍含 `-`/`_`，或总长度不是 4 的倍数，因此走不到下面的通用 Base64 分支——
/// 在补这张表之前，开着「敏感内容防护」也拦不住它们（`should_skip_sensitive_with` 直接调 `is_secret`）。
///
/// 前缀是各家固定的公开格式而非用户偏好，故写死在代码里、随版本更新，不做成可配项。
/// 语义：`trimmed` 以 `prefix` 开头**且**总长度 > `min_len`。
const SECRET_PREFIXES: &[(&str, usize)] = &[
    ("sk-", 20),         // OpenAI / Anthropic（覆盖 sk-ant-、sk-proj- 等变体）
    ("xoxb-", 20),       // Slack bot token
    ("xoxp-", 20),       // Slack user token
    ("xoxa-", 20),       // Slack app token
    ("xoxe-", 20),       // Slack refresh token
    ("xapp-", 20),       // Slack app-level token
    ("AIza", 35),        // Google API Key（实际固定 39 位）
    ("glpat-", 20),      // GitLab personal access token
    ("ghp_", 30),        // GitHub PAT（经典）
    ("gho_", 30),        // GitHub OAuth token
    ("ghu_", 30),        // GitHub user-to-server token
    ("ghs_", 30),        // GitHub server-to-server token
    ("ghr_", 30),        // GitHub refresh token
    ("github_pat_", 30), // GitHub PAT（细粒度）
];

// ===== 代码检测 — 通用关键字 =====
static CODE_KEYWORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(function|return|class|import|export|const|let|var|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|this|async|await|yield|typedef|struct|enum|interface|extends|implements|abstract|static|public|private|protected|void|int|float|double|bool|boolean|string|char|byte|long|short|echo|exit|fi|elif)\b").unwrap()
});
static CODE_SYNTAX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[{};]|=>|&&|\|\||== |!= |<= |>= ").unwrap()
});
static CODE_INDENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[ \t]{2,}\S").unwrap()
});

// ===== 单行代码检测 =====
/// 行首强关键字（大小写敏感：代码中这些关键字都是小写，避免 "Let me know"/"Variable costs" 等散文误伤）
static SINGLE_LINE_KW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(const|let|var|fn|def|func|pub\s+fn)\b").unwrap()
});
/// 行首 SQL 强特征（大小写不敏感）：多词短语或 select...from 组合，避免散文 "Select the best option..."
static SINGLE_LINE_SQL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(insert\s+into|create\s+table|drop\s+table|alter\s+table|delete\s+from|update\s+\w+\s+set)\b|^select\b.+\bfrom\b").unwrap()
});
/// 函数调用结构：标识符紧邻左括号且括号内无换行（区别于散文中的 "think (as noted)"）
static CALL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z_]\w*\([^)]*\)").unwrap()
});

// ===== Email 检测 =====
static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$").unwrap()
});

// ===== 电话号码检测（中国手机号） =====
static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\+?86)?1[3-9]\d{9}$").unwrap()
});

// ===== 颜色检测 =====
static COLOR_HEX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$").unwrap()
});
static COLOR_RGB_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$").unwrap()
});
static COLOR_HSL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$").unwrap()
});

// ===== 文件路径检测 =====
static FILE_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^([A-Z]:\\|\\\\|/[\w.]|[.~]/)").unwrap()
});

// ===== Markdown 检测 =====
static MD_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^#{1,6}\s+\S").unwrap()
});
static MD_BOLD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\*\*[^*]+\*\*|__[^_]+__").unwrap()
});
static MD_LIST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*[-*+]\s+\S|^\s*\d+\.\s+\S").unwrap()
});
static MD_CODE_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"```").unwrap()
});
static MD_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[[^\]]*\]\([^)]+\)").unwrap()
});
static MD_BLOCKQUOTE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^>\s+\S").unwrap()
});

// ===== HTML 检测 =====
static HTML_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<(html|head|body|div|span|p|a|img|script|style|table|ul|ol|li|h[1-6]|form|input|button|section|article|nav|header|footer|main)\b[^>]*>").unwrap()
});
static HTML_DOCTYPE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<!DOCTYPE\s+html").unwrap()
});

/// 常用命令白名单
static COMMON_COMMANDS: &[&str] = &[
    "git", "docker", "npm", "yarn", "pnpm", "cargo", "rustc",
    "python", "python3", "node", "npx", "kubectl", "curl", "wget",
    "ssh", "scp", "rsync", "tar", "gzip", "zip", "unzip",
    "make", "cmake", "gcc", "clang", "java", "mvn", "gradle",
    "pip", "pip3", "conda", "brew", "choco", "apt", "apt-get",
    "yum", "dnf", "pacman", "systemctl", "service",
    "psql", "mysql", "redis-cli", "sqlite3",
    "ffmpeg", "adb",
    "vim", "nvim", "code", "explorer", "start",
    "cd", "dir", "ls", "cp", "mv", "rm", "mkdir", "touch",
    "cat", "tail", "head", "grep", "find", "xargs", "tee", "awk", "sed",
    "chmod", "chown", "ln",
    "ping", "tracert", "nslookup", "netstat", "tasklist", "taskkill",
    "claude", "codebuddy",
];

/// 语言特征（按语言，值越大越具特征性）
/// patterns 中的正则已预编译为 LazyLock<Regex>，零运行时编译开销
struct LanguageProfile {
    keywords: &'static [&'static str],
    patterns: &'static [fn() -> &'static Regex],
    label: &'static str,
}

/// 辅助宏：创建 LazyLock<Regex> 并返回引用
macro_rules! re {
    ($pat:expr) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
        || &*RE
    }};
}

static LANGUAGE_PROFILES: &[LanguageProfile] = &[
    LanguageProfile {
        label: "Python",
        keywords: &["def ", "import ", "from ", "self.", "print(", "class ", "elif", "pass", "None", "True", "False", "with ", "as "],
        patterns: &[re!(r"(?m)^\s*def \w+\(.*\):"), re!(r"(?m)^\s*class \w+.*:"), re!(r"\.py\b")],
    },
    LanguageProfile {
        label: "JavaScript",
        keywords: &["function", "const", "let", "var", "=>", "import ", "export ", "console.log", "undefined", "null", "typeof", "prototype", "Promise", ".then("],
        patterns: &[re!(r"\bconst \w+ = "), re!(r"\bfunction \w+\("), re!(r"\.js\b"), re!(r"\.jsx\b")],
    },
    LanguageProfile {
        label: "TypeScript",
        keywords: &[": string", ": number", ": boolean", ": void", "interface ", "type ", "enum ", "as const", "Readonly", "Partial<"],
        patterns: &[re!(r":\s*(string|number|boolean|void)\b"), re!(r"\binterface \w+\b"), re!(r"\btype \w+ ="), re!(r"\.tsx?\b")],
    },
    LanguageProfile {
        label: "Rust",
        keywords: &["fn ", "let mut", "impl", "pub ", "use ", "struct ", "enum ", "match ", "Vec<", "Option<", "Result<", "println!(", "mut ", "&self", "&mut"],
        patterns: &[re!(r"\bfn \w+\(.*\)"), re!(r"\bimpl \w+"), re!(r"\bpub fn "), re!(r"\blet mut \b"), re!(r"\w+!\(")],
    },
    LanguageProfile {
        label: "Java",
        keywords: &["public class", "private ", "protected ", "void ", "System.out", "String[]", "ArrayList", "HashMap", "@Override", "@Autowired", "@Service", "@Component"],
        patterns: &[re!(r"\bpublic (class|interface|enum)\b"), re!(r"\bSystem\.out\.print"), re!(r"\bprivate (String|int|boolean|void)\b")],
    },
    LanguageProfile {
        label: "Go",
        keywords: &["func ", "package ", "defer", "go func", "chan ", "goroutine", "interface{", "struct{", "fmt.Println", "err != nil"],
        patterns: &[re!(r"\bfunc \w+\("), re!(r"\bpackage \w+"), re!(r"\bdefer \w+\("), re!(r":=")],
    },
    LanguageProfile {
        label: "SQL",
        keywords: &["SELECT", "FROM", "WHERE", "INSERT INTO", "UPDATE", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "JOIN", "LEFT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET"],
        patterns: &[re!(r"(?i)\bSELECT\b.+\bFROM\b"), re!(r"(?i)\bINSERT INTO\b"), re!(r"(?i)\bCREATE TABLE\b")],
    },
    LanguageProfile {
        label: "HTML",
        keywords: &["<html", "<head", "<body", "<div", "<span", "<p>", "<a ", "<img ", "<script", "<style", "<!DOCTYPE", "</", "/>"],
        patterns: &[re!(r"<\w+[^>]*>"), re!(r"</\w+>"), re!(r"<!DOCTYPE html")],
    },
    LanguageProfile {
        label: "CSS",
        keywords: &["{ ", "px", "em", "rem", "vh", "vw", "color:", "background:", "margin:", "padding:", "display:", "position:", "font-size:", "@media", "@keyframes", "@import", "flex", "grid", "#"],
        patterns: &[re!(r"[.#][\w-]+\s*\{"), re!(r"@media"), re!(r"@keyframes")],
    },
    LanguageProfile {
        label: "Shell",
        keywords: &["#!/bin/", "echo", "chmod", "chown", "if [", "fi", "then", "else", "elif", "for i in", "while ", "do", "done", "export ", "source ", "$(", "${"],
        patterns: &[re!(r"^#!/bin/"), re!(r"\$\{?\w+\}?"), re!(r"\$\(\s*\w+")],
    },
];

/// 内容分类器
pub struct ContentClassifier;

impl ContentClassifier {
    pub fn new() -> Self {
        Self
    }

    /// 对文本进行分类，返回标签名列表
    pub fn classify(&self, text: &str) -> Labels {
        let text = text.trim();

        // 空文本
        if text.is_empty() {
            return vec!["纯文本".to_string()];
        }

        // ===== 0.5 单行精确匹配 =====
        if self.is_email(text) { return vec!["邮箱".to_string()]; }
        if self.is_phone(text) { return vec!["电话".to_string()]; }
        if self.is_color(text) { return vec!["颜色".to_string()]; }
        if self.is_file_path(text) { return vec!["文件路径".to_string()]; }

        // 纯数字
        if text.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',' || c == '-' || c == ' ' || c == '\n' || c == '\r') {
            // 确认不全是标点/空格
            let digit_count = text.chars().filter(|c| c.is_ascii_digit()).count();
            if digit_count > 0 && digit_count as f64 / text.len() as f64 > 0.5 {
                return vec!["数字".to_string()];
            }
        }

        // ===== JSON 检测（必须先于下面的"超短文本"早退检查，否则短 JSON 如 {"id":1} 会被误判为纯文本）=====
        if self.is_json(text) {
            return vec!["JSON".to_string()];
        }

        // 超短文本 (< 15 字符，不含特殊格式)
        if text.len() < 15 && !text.contains('\n') && !text.contains("://") {
            return vec!["纯文本".to_string()];
        }

        // ===== 1. URL 检测 =====
        if URL_RE.is_match(text) {
            return vec!["链接".to_string()];
        }

        // ===== 1.5 Markdown 检测（在代码之前） =====
        if self.is_markdown(text) {
            return vec!["Markdown".to_string()];
        }

        // ===== 1.6 HTML 检测 =====
        if self.is_html(text) {
            return vec!["HTML".to_string()];
        }

        // ===== 2. 配置文件检测 =====
        if let Some(config_label) = self.detect_config(text) {
            return vec!["配置文件".to_string(), config_label];
        }

        // ===== 3. CSV/TSV 检测 =====
        if self.is_csv(text) {
            return vec!["表格".to_string()];
        }

        // ===== 4. 命令行检测 =====
        if self.is_command(text) {
            return vec!["命令行".to_string()];
        }

        // ===== 5. 日志检测 =====
        if self.is_log(text) {
            return vec!["日志".to_string()];
        }

        // ===== 6. 密钥/Token 检测 =====
        if self.is_secret(text) {
            return vec!["密钥".to_string()];
        }

        // ===== 7. 代码检测（多行） =====
        if self.is_code(text) {
            let lang = self.detect_language(text, false);
            let mut labels = vec!["代码".to_string()];
            if let Some(l) = lang {
                labels.push(l.to_string());
            }
            return labels;
        }

        // ===== 7.5 单行代码检测（"复制一行代码/SQL" 高频场景） =====
        // 单行关键词证据薄弱，detect_language 内部始终走解析器仲裁
        if self.is_code_single_line(text) {
            let lang = self.detect_language(text, true);
            let mut labels = vec!["代码".to_string()];
            if let Some(l) = lang {
                labels.push(l.to_string());
            }
            return labels;
        }

        // ===== 8. 默认：纯文本 =====
        vec!["纯文本".to_string()]
    }

    /// 从 labels 里取**语言级**标签（LANGUAGE_PROFILES 的 label）。
    ///
    /// `content_type_from_labels` 只能给到 `code`，这一层才分得出是哪门语言。
    /// prompt 里写明语言对输出质量影响很大：同一段 `fn` 在 Rust 与 Go 里含义完全不同。
    ///
    /// 返回 `&'static str` 而不是拷贝：语言名是编译期常量表里的，不需要堆分配。
    pub fn language_from_labels(labels: &[String]) -> Option<&'static str> {
        LANGUAGE_PROFILES
            .iter()
            .map(|p| p.label)
            .find(|l| labels.iter().any(|x| x == l))
    }

    /// 从 classify() 返回的标签列表派生 content_type（单一分类入口）。
    /// 映射规则：第一个标签决定主类型。
    pub fn content_type_from_labels(labels: &[String]) -> &'static str {
        match labels.first().map(|s| s.as_str()) {
            Some("邮箱") => "email",
            Some("电话") => "phone",
            Some("颜色") => "color",
            Some("文件路径") => "file_path",
            Some("链接") => "link",
            Some("数字") => "number",
            Some("JSON") => "json",
            Some("Markdown") => "markdown",
            Some("HTML") => "html",
            Some("配置文件") => "config",
            Some("表格") => "csv",
            Some("命令行") => "shell",
            Some("日志") => "log",
            Some("密钥") => "secret",
            Some("代码") => "code",
            Some("纯文本") => "text",
            _ => "text",
        }
    }

    /// 检测是否为合法 JSON
    fn is_json(&self, text: &str) -> bool {
        let trimmed = text.trim();
        // 快速检查首尾字符
        if !(trimmed.starts_with('{') && trimmed.ends_with('}'))
            && !(trimmed.starts_with('[') && trimmed.ends_with(']'))
        {
            return false;
        }
        // 尝试解析 JSON（也支持 JSONC：去除 // 注释）
        let text_to_parse = if trimmed.contains("//") {
            // 简单去除单行注释
            let lines: Vec<&str> = trimmed
                .lines()
                .map(|line| {
                    if let Some(pos) = line.find("//") {
                        let before = &line[..pos];
                        // 确保 // 不在字符串内（简单检测）
                        // 扣除转义引号 \"，避免 {"url": "\"// x"} 误判为注释
                        // 局限：\\" 边界（转义反斜杠+真引号）仍可能误判，实际 JSON 配置极罕见
                        let quote_count = before.matches('"').count()
                            .saturating_sub(before.matches("\\\"").count());
                        if quote_count % 2 == 0 {
                            before
                        } else {
                            line
                        }
                    } else {
                        line
                    }
                })
                .collect();
            lines.join("\n")
        } else {
            trimmed.to_string()
        };
        serde_json::from_str::<serde_json::Value>(&text_to_parse).is_ok()
    }

    /// 检测配置文件类型
    fn detect_config(&self, text: &str) -> Option<String> {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() < 2 {
            return None;
        }
        let total = lines.len() as f64;

        // ENV: KEY=VALUE 模式
        let env_lines = lines
            .iter()
            .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#') && ENV_LINE_RE.is_match(l))
            .count() as f64;
        if env_lines / total > 0.7 && total > 3.0 {
            return Some("ENV".to_string());
        }

        // TOML: 包含 [section]
        let has_section = lines.iter().any(|l| TOML_SECTION_RE.is_match(l));
        let toml_lines = lines
            .iter()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#') && !t.starts_with('[') && t.contains('=')
            })
            .count() as f64;
        if has_section || (toml_lines / total > 0.5 && total > 3.0) {
            return Some("TOML".to_string());
        }

        // YAML: key: value 模式
        let yaml_lines = lines
            .iter()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#') && YAML_LINE_RE.is_match(l)
            })
            .count() as f64;
        if yaml_lines / total > 0.5 && total > 3.0 {
            return Some("YAML".to_string());
        }

        // INI: [section] + key=value
        if has_section {
            return Some("INI".to_string());
        }

        None
    }

    /// 检测 CSV/TSV
    fn is_csv(&self, text: &str) -> bool {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() < 2 {
            return false;
        }
        // 取前 5 行检查
        let check_lines: Vec<&&str> = lines.iter().take(5).filter(|l| !l.trim().is_empty()).collect();
        if check_lines.len() < 2 {
            return false;
        }

        // 尝试逗号分隔
        let comma_counts: Vec<usize> = check_lines
            .iter()
            .map(|l| l.split(',').count())
            .collect();
        let all_same_comma = comma_counts.len() >= 2
            && comma_counts.iter().all(|&c| c == comma_counts[0])
            && comma_counts[0] >= 2;

        // 尝试制表符分隔
        let tab_counts: Vec<usize> = check_lines
            .iter()
            .map(|l| l.split('\t').count())
            .collect();
        let all_same_tab = tab_counts.len() >= 2
            && tab_counts.iter().all(|&c| c == tab_counts[0])
            && tab_counts[0] >= 2;

        all_same_comma || all_same_tab
    }

    /// 检测命令行
    fn is_command(&self, text: &str) -> bool {
        // 多行文本不是命令
        if text.lines().count() > 3 {
            return false;
        }
        // 长度至少 8 字符
        if text.len() < 8 {
            return false;
        }
        // 第一行检查
        let first_line = text.lines().next().unwrap_or("").trim();
        if first_line.is_empty() {
            return false;
        }

        // 检查是否以常见命令开头，且命令后须为词边界（字符串结尾/空白/非字母数字），
        // 避免 "dir"/"cat"/"find" 等前缀误伤 "directory"/"category"/"finder" 等普通单词
        let lower = first_line.to_lowercase();
        let starts_with_cmd = COMMON_COMMANDS.iter().any(|cmd| {
            lower.starts_with(cmd)
                && lower
                    .as_bytes()
                    .get(cmd.len())
                    .map_or(true, |b| !b.is_ascii_alphanumeric())
        });
        if !starts_with_cmd {
            return false;
        }

        // 必须有参数
        CMD_ARG_RE.is_match(first_line)
    }

    /// 检测日志
    /// 路径 1：时间戳 + 日志级别同行（严格，适合应用日志，单行也允许）
    /// 路径 2：仅有时间戳（多行 ≥60% 一致性，适合 nginx/syslog 等无级别格式）
    fn is_log(&self, text: &str) -> bool {
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len() as f64;
        if total < 1.0 {
            return false;
        }

        let mut ts_level = 0f64;
        let mut ts_only = 0f64;
        for l in &lines {
            let l = l.trim();
            if l.is_empty() {
                continue;
            }
            if LOG_TS_RE.is_match(l) {
                ts_only += 1.0;
                if LOG_LEVEL_RE.is_match(l) {
                    ts_level += 1.0;
                }
            }
        }

        // 路径 1：时间戳 + 级别共存
        if ts_level >= 1.0 && ts_level / total > 0.3 {
            return true;
        }
        // 路径 2：仅时间戳（nginx 访问日志、syslog 等），要求更高一致性
        total >= 2.0 && ts_only >= 2.0 && ts_only / total > 0.6
    }

    /// 含个人信息（手机号 / 邮箱 / 身份证 / IPv4）——与前端 `lib/mask.ts` 同四类。
    ///
    /// **只给出网判据用**，不参与内容分类（理由见文件上方 PII 节的注释）。
    pub fn has_pii(text: &str) -> bool {
        has_match_digit_bounded(&PII_PHONE_RE, text)
            || has_match_digit_bounded(&PII_ID_CARD_RE, text)
            || has_match_digit_bounded(&PII_IPV4_RE, text)
            || PII_EMAIL_RE.is_match(text)
    }

    /// **出网判据的唯一入口**：密钥 或 个人信息。
    ///
    /// 所有“把内容交给第三方”的路径都走这里，不要直接用 `is_secret`：
    /// `ai_run` / `ai_plan_chain` / `ai_test_action` / `semantic_search` / `profile_refine`。
    /// `is_secret` 仍然只服务于内容分类（是否记录/排除/展示为敏感）。
    ///
    /// 已知代价：任何含邮箱或 IP 的文本都会触发一次出网确认（包括“帮我润色这封
    /// 邮件”这种正当请求），以及 `1.2.3.4` 这种版本号会被当成 IPv4。
    /// 这是有意的取舍：门只是**确认**而不是拒绝（force 可过），宁可多问一句。
    pub fn is_sensitive_for_egress(&self, text: &str) -> bool {
        self.is_secret(text) || Self::has_pii(text)
    }

    /// 检测密钥/Token。
    ///
    /// 注意：**出网路径不该直接调它**，用 [`Self::is_sensitive_for_egress`]。
    pub fn is_secret(&self, text: &str) -> bool {
        let trimmed = text.trim();

        // JWT
        if trimmed.len() > 50 && JWT_RE.is_match(trimmed) {
            return true;
        }

        // AWS Access Key（固定 20 位，多一位少一位都不是，故不入前缀表）
        if trimmed.starts_with("AKIA") && trimmed.len() == 20 {
            return true;
        }

        // 服务商密钥前缀（OpenAI/Anthropic/Slack/Google/GitLab/GitHub 等，见 SECRET_PREFIXES）。
        //
        // 按 **token** 判，而不是整串 `starts_with`：原实现要求“整条内容就是一个密钥”
        // （starts_with + 无空格无换行），于是 `OPENAI_KEY=sk-xxxx…`、`key: sk-xxxx…`
        // 这类配置片段全部漏过。而 `is_secret` **同时就是 AI 出网门**
        // （commands/ai/run.rs、commands/ai/plan.rs），漏过 = 直接发给云端第三方。
        // 前端的 lib/mask.ts 一直是内嵌匹配（粘贴守卫能拦），两边判据不一致。
        //
        // 切 token 的字符集 = 密钥合法字符（字母/数字/-/_），所以 `=`、`:`、引号、
        // 逗号都是分隔符；长度阀值仍用同一张前缀表，所以“以前缀开头的说明文字”
        // （如 `sk-ant 是…前缀`）仍然因 token 太短而不命中——比旧的“无空格”限制更精确。
        if trimmed
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .any(|tok| {
                SECRET_PREFIXES
                    .iter()
                    .any(|(prefix, min_len)| tok.starts_with(prefix) && tok.len() > *min_len)
            })
        {
            return true;
        }

        // PEM 私钥块（RSA / EC / OPENSSH / PGP 等变体统一命中）。
        // 它本身是多行内容，所以不能去蹭上面那条单行约束。
        if trimmed.starts_with("-----BEGIN") && trimmed.contains("PRIVATE KEY") {
            return true;
        }

        // 通用 Base64（长串、非文本）
        // 真实 base64 编码数据（含末尾 padding）长度必为 4 的倍数，以此作为必要条件之一，
        // 排除普通驼峰命名标识符（如 calculateTotalPriceWithDiscountAndTax123）被误判为密钥
        if trimmed.len() > 30
            && !trimmed.contains(' ')
            && !trimmed.contains('\n')
            && trimmed.len() % 4 == 0
            && BASE64_RE.is_match(trimmed)
        {
            // 排除明显的文本（包含常见英文单词）
            let upper = trimmed.to_uppercase();
            let common_words = ["THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HAD", "HER", "WAS", "ONE", "OUR", "OUT", "HAS", "HAVE"];
            let looks_like_text = common_words.iter().any(|w| upper.contains(w));

            // 排除 camelCase/标识符风格字符串：不含 base64 常见符号 + / =，
            // 且存在"小写字母紧跟大写字母"的驼峰命名特征（真实 base64 中这种相邻模式很少见）
            let has_base64_symbols =
                trimmed.contains('+') || trimmed.contains('/') || trimmed.contains('=');
            let looks_like_camel_case = !has_base64_symbols
                && trimmed
                    .as_bytes()
                    .windows(2)
                    .any(|w| w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase());

            if !looks_like_text && !looks_like_camel_case {
                return true;
            }
        }

        false
    }

    /// 检测是否为代码（多行片段）
    /// 分母使用"有效行数"（排除空行和注释行），避免注释稀释代码特征比例
    fn is_code(&self, text: &str) -> bool {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() < 2 {
            return false;
        }

        let effective: Vec<&str> = lines
            .iter()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !is_comment_line(t)
            })
            .copied()
            .collect();
        let total = effective.len() as f64;
        if total < 2.0 {
            return false;
        }

        // 统计代码特征行
        let code_lines = effective
            .iter()
            .filter(|l| {
                let l = l.trim();
                CODE_KEYWORD_RE.is_match(l) || CODE_SYNTAX_RE.is_match(l)
            })
            .count() as f64;

        // 统计缩进行
        let indent_lines = CODE_INDENT_RE.find_iter(text).count() as f64;

        // 阈值：代码特征行 > 40%
        let code_ratio = code_lines / total;
        let indent_ratio = indent_lines / total;

        code_ratio > 0.4 || (code_ratio > 0.2 && indent_ratio > 0.3)
    }

    /// 单行代码检测（补偿 is_code 要求 ≥2 行的限制）
    /// 路径 1：行首强关键字（const/fn/def/func/SELECT...FROM 等）直接命中
    /// 路径 2：括号配对 +（以 ; 结尾 / 含 => / 含函数调用结构）
    fn is_code_single_line(&self, text: &str) -> bool {
        if text.contains('\n') {
            return false;
        }
        let t = text.trim();
        if t.len() < 15 {
            return false;
        }
        // 路径 1：行首强关键字（大小写敏感/不敏感按关键字类型区分）
        if SINGLE_LINE_KW_RE.is_match(t) || SINGLE_LINE_SQL_RE.is_match(t) {
            return true;
        }
        // 路径 2：括号配对 + 终止/箭头/调用结构
        let has_pair = (t.contains('(') && t.contains(')'))
            || (t.contains('{') && t.contains('}'))
            || (t.contains('[') && t.contains(']'));
        if !has_pair {
            return false;
        }
        t.ends_with(';') || t.contains("=>") || CALL_RE.is_match(t)
    }

    /// 检测代码语言（规则计分 + tree-sitter 仲裁）
    /// - single_line=true 时，始终走解析器仲裁（单行关键词证据薄弱）
    /// - 高置信度（得分 ≥11 或与次高分差距 ≥5）：直接返回规则结果
    /// - 低置信度：把得分 >0 的候选（前 5）送仲裁；仲裁失败则回退规则结果
    fn detect_language(&self, text: &str, single_line: bool) -> Option<&'static str> {
        let text_lower = text.to_lowercase();
        let mut scores: Vec<(&'static str, i32)> = LANGUAGE_PROFILES
            .iter()
            .map(|p| (p.label, profile_score(p, text, &text_lower)))
            .filter(|(_, s)| *s > 0)
            .collect();
        scores.sort_by(|a, b| b.1.cmp(&a.1));

        let (best_label, best_score) = *scores.first()?;
        if best_score < 6 {
            return None;
        }
        let second_score = scores.get(1).map(|s| s.1).unwrap_or(0);

        // 高置信度：规则结果可信（多行才适用；单行一律仲裁）
        if !single_line && (best_score >= 11 || best_score - second_score >= 5) {
            return Some(best_label);
        }

        // 低置信度 → tree-sitter 仲裁
        let candidates: Vec<&str> = scores.iter().take(5).map(|(l, _)| *l).collect();
        crate::lang_arbiter::arbitrate(text, &candidates).or(Some(best_label))
    }

    /// 检测邮箱
    fn is_email(&self, text: &str) -> bool {
        !text.contains('\n') && EMAIL_RE.is_match(text)
    }

    /// 检测电话号码
    fn is_phone(&self, text: &str) -> bool {
        !text.contains('\n') && PHONE_RE.is_match(text.trim())
    }

    /// 检测颜色值
    fn is_color(&self, text: &str) -> bool {
        let t = text.trim();
        if t.contains('\n') { return false; }
        if COLOR_HEX_RE.is_match(t) { return true; }
        if COLOR_RGB_RE.is_match(t) {
            // 验证 R/G/B 通道 0-255（正则允许 0-999）
            let nums: Vec<u32> = t
                .trim_start_matches("rgba(")
                .trim_start_matches("rgb(")
                .trim_end_matches(')')
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect();
            return nums.len() >= 3 && nums[..3].iter().all(|&v| v <= 255);
        }
        if COLOR_HSL_RE.is_match(t) {
            // 验证 S/L 百分比 0-100
            let nums: Vec<u32> = t
                .trim_start_matches("hsla(")
                .trim_start_matches("hsl(")
                .trim_end_matches(')')
                .split(',')
                .skip(1) // 跳过 hue（0-360 无上限约束，正则已限 0-999）
                .filter_map(|s| s.trim().trim_end_matches('%').parse::<u32>().ok())
                .collect();
            return nums.len() >= 2 && nums.iter().all(|&v| v <= 100);
        }
        false
    }

    /// 检测文件路径（单行或少量行）
    fn is_file_path(&self, text: &str) -> bool {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() > 5 { return false; }
        // 每行都必须是路径格式
        lines.iter().all(|l| {
            let l = l.trim();
            !l.is_empty() && FILE_PATH_RE.is_match(l)
        })
    }

    /// 检测 Markdown（评分制：命中 ≥ 2 种语法特征）
    fn is_markdown(&self, text: &str) -> bool {
        let lines = text.lines().count();
        if lines < 2 { return false; }
        let mut score = 0;
        if MD_HEADING_RE.is_match(text) { score += 1; }
        if MD_BOLD_RE.is_match(text) { score += 1; }
        if MD_LIST_RE.is_match(text) { score += 1; }
        if MD_CODE_BLOCK_RE.is_match(text) { score += 1; }
        if MD_LINK_RE.is_match(text) { score += 1; }
        if MD_BLOCKQUOTE_RE.is_match(text) { score += 1; }
        score >= 2
    }

    /// 检测 HTML
    fn is_html(&self, text: &str) -> bool {
        if HTML_DOCTYPE_RE.is_match(text) { return true; }
        // 至少包含 2 个不同的 HTML 标签
        let matches: Vec<&str> = HTML_TAG_RE.find_iter(text).take(3).map(|m| m.as_str()).collect();
        matches.len() >= 2
    }
}

/// 语言特征计分：关键词命中 +3（大小写不敏感），正则模式命中 +5（匹配原始文本）
fn profile_score(profile: &LanguageProfile, text: &str, text_lower: &str) -> i32 {
    let mut score = 0i32;
    for kw in profile.keywords {
        if text_lower.contains(&kw.to_ascii_lowercase()) {
            score += 3;
        }
    }
    for get_re in profile.patterns {
        let re: &Regex = get_re();
        if re.is_match(text) {
            score += 5;
        }
    }
    score
}

/// 判定注释行（用于 is_code 分母过滤，避免注释稀释代码特征比例）
/// 支持 //、#、/*、* (jsdoc 延续)、-- (SQL/Lua)、<!-- (HTML)
fn is_comment_line(t: &str) -> bool {
    t.starts_with("//")
        || t.starts_with('#')
        || t.starts_with("/*")
        || t.starts_with('*')
        || t.starts_with("--")
        || t.starts_with("<!--")
}


#[cfg(test)]
mod tests {
    use super::*;

    fn classify(text: &str) -> Vec<String> {
        ContentClassifier::new().classify(text)
    }

    #[test]
    fn test_url() {
        assert!(classify("https://github.com/user/repo").contains(&"链接".to_string()));
    }

    #[test]
    fn test_json() {
        let r = classify(r#"{"name": "test", "value": 42}"#);
        assert!(r.contains(&"JSON".to_string()));
    }

    #[test]
    fn test_number() {
        assert!(classify("12345").contains(&"数字".to_string()));
        assert!(classify("123.456").contains(&"数字".to_string()));
    }

    #[test]
    fn test_javascript() {
        let r = classify("function hello() {\n  console.log('hi');\n  return 42;\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_python() {
        let r = classify("def hello():\n    print('hi')\n    return 42");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_sql() {
        // SQL DDL + DML 组合，特征明显
        let r = classify(
            "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  email TEXT UNIQUE,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\nINSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');\nINSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com');\n\nSELECT u.id, u.name, u.email\nFROM users u\nWHERE u.id = 1\n  AND u.active = 1\nORDER BY name\nLIMIT 10;",
        );
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_command() {
        let r = classify("git commit -m \"fix: bug\"");
        assert!(r.contains(&"命令行".to_string()));
    }

    #[test]
    fn test_log() {
        let r = classify("2024-01-01 12:00:00 [ERROR] Connection failed\n2024-01-01 12:00:01 [INFO] Retrying...");
        assert!(r.contains(&"日志".to_string()));
    }

    #[test]
    fn test_csv() {
        let r = classify("name,age,city\nAlice,30,NYC\nBob,25,LA");
        assert!(r.contains(&"表格".to_string()));
    }

    #[test]
    fn test_jwt() {
        let r = classify("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.signature");
        assert!(r.contains(&"密钥".to_string()));
    }

    #[test]
    fn test_plaintext() {
        let r = classify("Hello, this is a simple text message.");
        assert!(r.contains(&"纯文本".to_string()));
    }

    #[test]
    fn test_env_config() {
        let r = classify("DB_HOST=localhost\nDB_PORT=5432\nDB_NAME=myapp\nDB_USER=admin");
        assert!(r.contains(&"配置文件".to_string()));
    }

    #[test]
    fn test_rust_code() {
        let r = classify("fn main() {\n    let x = 42;\n    println!(\"{}\", x);\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_typescript_code() {
        let r = classify("interface User {\n  name: string;\n  age: number;\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_html_code() {
        let r = classify("<!DOCTYPE html>\n<html>\n<head>\n  <title>Test</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <div class=\"container\">\n    <p>Hello</p>\n  </div>\n</body>\n</html>");
        assert!(r.contains(&"HTML".to_string()));
    }

    #[test]
    fn test_css_code() {
        let r = classify(".container {\n  display: flex;\n  color: red;\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_shell_code() {
        let r = classify("#!/bin/bash\n\nexport PATH=/usr/bin\ncd /home/user\n\necho \"Starting...\"\nif [ -f \"$1\" ]; then\n  cat \"$1\" | grep \"error\"\nelse\n  echo \"File not found\"\n  exit 1\nfi");
        assert!(r.contains(&"代码".to_string()));
        assert!(r.contains(&"Shell".to_string()));
    }

    #[test]
    fn test_empty_text() {
        let r = classify("");
        assert!(r.contains(&"纯文本".to_string()));
    }

    #[test]
    fn test_short_text() {
        let r = classify("Hi");
        assert!(r.contains(&"纯文本".to_string()));
    }

    #[test]
    fn test_yaml_config() {
        let r = classify("name: myapp\nversion: 1.0\ndatabase:\n  host: localhost");
        assert!(r.contains(&"配置文件".to_string()));
    }

    #[test]
    fn test_toml_config() {
        let r = classify("[package]\nname = \"myapp\"\nversion = \"1.0\"");
        assert!(r.contains(&"配置文件".to_string()));
    }

    #[test]
    fn test_github_token() {
        let r = classify(concat!("ghp_", "1234567890abcdef1234567890abcdef12345678"));
        assert!(r.contains(&"密钥".to_string()));
    }

    #[test]
    fn test_aws_key() {
        let r = classify("AKIA1234567890ABCDEF");
        assert!(r.contains(&"密钥".to_string()));
    }

    #[test]
    fn test_go_code() {
        let r = classify("package main\n\nimport \"fmt\"\n\nfunc main() {\n\tx := 42\n\tfmt.Println(\"Hello\", x)\n\tif x > 0 {\n\t\tfmt.Println(\"Positive\")\n\t}\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_java_code() {
        let r = classify("public class Main {\n    public static void main(String[] args) {\n        System.out.println(\"Hello\");\n    }\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_command_with_flags() {
        let r = classify("docker run --rm -it ubuntu bash");
        assert!(r.contains(&"命令行".to_string()));
    }

    #[test]
    fn test_npm_command() {
        let r = classify("npm install --save react");
        assert!(r.contains(&"命令行".to_string()));
    }

    #[test]
    fn test_json_array() {
        let r = classify("[\n  {\"id\": 1, \"name\": \"Alice\"},\n  {\"id\": 2, \"name\": \"Bob\"}\n]");
        assert!(r.contains(&"JSON".to_string()));
    }

    #[test]
    fn test_url_ftp() {
        let r = classify("ftp://files.example.com/data/report.pdf");
        assert!(r.contains(&"链接".to_string()));
    }

    // ===== 回归测试：3 个误判修复场景 =====

    #[test]
    fn test_short_json_not_plaintext() {
        // 修复前：< 15 字符且无换行/"://" 会在 JSON 检测之前早退为纯文本
        let r = classify(r#"{"id":1}"#);
        assert!(r.contains(&"JSON".to_string()));
    }

    #[test]
    fn test_sentence_with_command_prefix_word_not_command() {
        // 修复前："directory" 以 "dir" 为前缀，被误判为命令行
        let r = classify("directory of important files");
        assert!(!r.contains(&"命令行".to_string()));
    }

    #[test]
    fn test_camel_case_identifier_not_secret() {
        // 修复前：>30 字符、无空格、字符集匹配 base64 正则，被误判为密钥
        let r = classify("calculateTotalPriceWithDiscountAndTax123");
        assert!(!r.contains(&"密钥".to_string()));
    }

    // ===== 补充：is_secret 公开方法直接测试 =====

    #[test]
    fn test_is_secret_jwt_boundary() {
        let c = ContentClassifier::new();
        // JWT 格式：header.payload.signature（三段，两个点）
        // 长度 > 50 才触发
        let jwt = "aaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaa";
        assert!(jwt.len() > 50);
        assert!(c.is_secret(jwt));
        // 短于 50 字符的类 JWT 不触发
        let short = "aaaaaa.aaaaaa.aaaaaa";
        assert!(short.len() < 50);
        assert!(!c.is_secret(short));
    }

    #[test]
    fn test_is_secret_aws_key_exact_length() {
        let c = ContentClassifier::new();
        assert!(c.is_secret("AKIA1234567890ABCDEF")); // 20 chars
        assert!(!c.is_secret("AKIA1234567890ABCDE")); // 19 chars → 不触发
        assert!(!c.is_secret("AKIA1234567890ABCDEFG")); // 21 chars → 不触发
    }

    #[test]
    fn test_is_secret_github_pat() {
        let c = ContentClassifier::new();
        assert!(c.is_secret(concat!("github_pat_", "1234567890abcdef1234567890abcdef")));
        assert!(!c.is_secret("ghp_short")); // 太短
    }

    #[test]
    fn test_is_secret_vendor_prefixes() {
        let c = ContentClassifier::new();
        // 以下全部含 `-`/`_` 或长度非 4 的倍数，走不到 Base64 分支，
        // 必须由 SECRET_PREFIXES 命中（否则开着「敏感内容防护」仍会入库）。
        assert!(c.is_secret(concat!("sk", "-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")));
        assert!(c.is_secret(concat!("sk", "-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD")));
        assert!(c.is_secret(concat!("xoxb-", "1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx")));
        assert!(c.is_secret("xapp-1-A01234567-1234567890123-abcdef0123456789"));
        assert!(c.is_secret("AIzaSyB1234567890abcdefghijklmnopqrstuv")); // 39 位
        assert!(c.is_secret(concat!("glpat-", "ABCDEFGHIJKLMNOPQRST")));
        assert!(c.is_secret("gho_1234567890abcdef1234567890abcdef12"));
    }

    #[test]
    fn test_is_secret_prefix_needs_min_length() {
        let c = ContentClassifier::new();
        // 前缀对上但长度不够 → 不触发，避免把普通短串当密钥
        assert!(!c.is_secret("sk-learn"));
        assert!(!c.is_secret("AIzaShortKey"));
        assert!(!c.is_secret("glpat-tooshort"));
    }

    #[test]
    fn test_is_secret_prefix_requires_single_line_no_space() {
        let c = ContentClassifier::new();
        // 以前缀开头的说明性文字不应被当成密钥
        assert!(!c.is_secret("sk-ant 是 Anthropic 密钥的前缀，不是密钥本身"));

        // 内嵌密钥（回归）：旧实现用整串 starts_with + “无空格”，下面这些全部漏过。
        // is_secret 同时是 AI 出网门，漏过就是把密钥发给云端第三方。
        assert!(
            c.is_secret(concat!("OPENAI_KEY=sk", "-proj-abcdefghijklmnopqrstuvwxyz0123456789")),
            "环境变量形式的内嵌密钥应判敏感"
        );
        assert!(
            c.is_secret(concat!("key: sk", "-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")),
            "冒号形式的内嵌密钥应判敏感"
        );
        assert!(
            c.is_secret(concat!("给你个 token \"ghp_", "1234567890abcdef1234567890abcdef12\"，帮我看看")),
            "引号包裹、中文句子中的内嵌密钥应判敏感"
        );
        assert!(
            c.is_secret(concat!("line1\nAPI=xoxb-", "1234567890-1234567890123-AbCdEfGhIjKlMnOpQrSt\nline3")),
            "多行配置里的内嵌密钥应判敏感"
        );
        // 切 token 后长度阀值仍生效：短前缀不因为“现在支持内嵌”而变成误报
        assert!(!c.is_secret("配置项叫 sk-key，值自己填"));
        assert!(!c.is_secret("OPENAI_KEY=sk-你的密钥"));
        assert!(!c.is_secret("glpat-开头的一行说明 后面还有内容"));
    }

    /// PII 只进出网判据，**不影响** `is_secret` 的分类语义。
    ///
    /// 这条是边界护栏：如果将来有人把 PII 推进 `is_secret`，日常内容（任何带邮箱
    /// 或 IP 的文本）会被 clipboard_monitor / history / content_memory 当密钥排除。
    #[test]
    fn test_pii_only_affects_egress_not_classification() {
        let c = ContentClassifier::new();
        for s in [
            "联系 13812345678",
            "邮箱 zhang.san@example.com",
            "服务器 10.0.19.194",
            "身份证 11010519491231002X",
        ] {
            assert!(ContentClassifier::has_pii(s), "应识别为 PII: {s:?}");
            assert!(c.is_sensitive_for_egress(s), "出网应拦: {s:?}");
            assert!(!c.is_secret(s), "但不该被当成密钥（会影响入库/排除）: {s:?}");
        }
    }

    /// 数字边界：手机号/身份证/IP 嵌在更长的数字串里不算。
    /// （前端 mask.ts 用 `(?<!\d)…(?!\d)`，Rust 无环视，手工查边界必须同语义）
    #[test]
    fn test_pii_digit_boundary() {
        assert!(!ContentClassifier::has_pii("9913812345678123"), "嵌在长数字串里不算手机号");
        assert!(ContentClassifier::has_pii("tel:13812345678,谢谢"), "标点包围的手机号应识别");
        // 普通文本不该误报
        assert!(!ContentClassifier::has_pii("今天天气不错，开了 3 个会"));
        assert!(!ContentClassifier::has_pii("function add(a, b) { return a + b; }"));
    }

    #[test]
    fn test_is_secret_pem_private_key() {
        let c = ContentClassifier::new();
        let rsa = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
        assert!(c.is_secret(rsa));
        let openssh = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----";
        assert!(c.is_secret(openssh));
        // 证书是公开物，不应拦
        let cert = "-----BEGIN CERTIFICATE-----\nMIIDdTCCAl2gAwIBAgIJAKl\n-----END CERTIFICATE-----";
        assert!(!c.is_secret(cert));
    }

    #[test]
    fn test_is_secret_base64_length_must_be_multiple_of_4() {
        let c = ContentClassifier::new();
        // 长度 32（4 的倍数），纯 base64 字符，无空格 → 触发
        let b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
        assert_eq!(b64.len(), 32);
        assert!(c.is_secret(b64));
        // 长度 33（非 4 的倍数）→ 不触发
        let not_b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
        assert_eq!(not_b64.len(), 33);
        assert!(!c.is_secret(not_b64));
    }

    #[test]
    fn test_is_secret_base64_with_padding() {
        let c = ContentClassifier::new();
        // 带 = 填充的真实 base64
        assert!(c.is_secret("SGVsbG8gV29ybGQhIFRoaXMgaXMgYQ=="));
    }

    #[test]
    fn test_is_secret_rejects_common_words() {
        let c = ContentClassifier::new();
        // 包含常见英文单词 THE → 排除（即使长度是 4 的倍数也不触发）
        // "THEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" 长度 35，非 4 倍数 → 已被长度排除
        let with_the = "THEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert!(!c.is_secret(with_the));
    }

    // ===== 补充：命令行边界 =====

    #[test]
    fn test_multiline_not_command() {
        // 超过 3 行 → 不是命令
        let r = classify("git status\ngit add .\ngit commit -m \"msg\"\ngit push");
        assert!(!r.contains(&"命令行".to_string()));
    }

    #[test]
    fn test_command_without_args_not_command() {
        // 无参数 → 不是命令
        let r = classify("git");
        assert!(!r.contains(&"命令行".to_string()));
    }

    #[test]
    fn test_command_word_boundary() {
        // "finder" 不应匹配 "find" 命令
        let r = classify("finder of lost treasures and ancient relics");
        assert!(!r.contains(&"命令行".to_string()));
    }

    // ===== 补充：CSV 边界 =====

    #[test]
    fn test_csv_inconsistent_columns_not_table() {
        let r = classify("a,b,c\n1,2\nx,y,z,w");
        assert!(!r.contains(&"表格".to_string()));
    }

    #[test]
    fn test_tsv_detection() {
        let r = classify("name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tLA");
        assert!(r.contains(&"表格".to_string()));
    }

    // ===== 补充：JSON 边界 =====

    #[test]
    fn test_jsonc_with_comments() {
        let r = classify("{\n  // this is a comment\n  \"name\": \"test\",\n  \"value\": 42\n}");
        assert!(r.contains(&"JSON".to_string()));
    }

    #[test]
    fn test_jsonc_escaped_quote_before_slashes() {
        // B-03：转义引号 \" 后紧跟 // 不应被误判为注释
        let r = classify(r#"{"a": "\"// x"}"#);
        assert!(r.contains(&"JSON".to_string()));
    }

    #[test]
    fn test_invalid_json_not_json() {
        let r = classify("{invalid json content here}");
        assert!(!r.contains(&"JSON".to_string()));
    }

    // ===== 补充：分类优先级 =====

    #[test]
    fn test_url_takes_priority_over_plaintext() {
        // 长 URL 不应被判为纯文本
        let r = classify("https://example.com/very/long/path/to/resource?query=value&other=123");
        assert!(r.contains(&"链接".to_string()));
    }

    #[test]
    fn test_json_takes_priority_over_short_text() {
        // 短 JSON 优先于"超短文本"早退
        let r = classify(r#"{"a":1}"#);
        assert!(r.contains(&"JSON".to_string()));
    }

    // ===== 补充：空白/特殊输入 =====

    #[test]
    fn test_whitespace_only() {
        let r = classify("   \n\t  ");
        assert!(r.contains(&"纯文本".to_string()));
    }

    #[test]
    fn test_numbers_with_separators() {
        let r = classify("1,234,567.89");
        assert!(r.contains(&"数字".to_string()));
    }

    #[test]
    fn test_negative_numbers() {
        let r = classify("-42 -100 -0.5");
        assert!(r.contains(&"数字".to_string()));
    }

    #[test]
    fn test_email() {
        assert!(classify("user@example.com").contains(&"邮箱".to_string()));
        assert!(classify("test.name+tag@sub.domain.co.uk").contains(&"邮箱".to_string()));
    }

    #[test]
    fn test_phone() {
        assert!(classify("13812345678").contains(&"电话".to_string()));
        assert!(classify("+8613912345678").contains(&"电话".to_string()));
    }

    #[test]
    fn test_color() {
        assert!(classify("#FF5733").contains(&"颜色".to_string()));
        assert!(classify("rgb(255, 87, 51)").contains(&"颜色".to_string()));
        assert!(classify("hsl(120, 50%, 75%)").contains(&"颜色".to_string()));
    }

    #[test]
    fn test_file_path() {
        assert!(classify(r"C:\Users\test\file.txt").contains(&"文件路径".to_string()));
        assert!(classify("/home/user/file.txt").contains(&"文件路径".to_string()));
        assert!(classify("~/Documents/report.pdf").contains(&"文件路径".to_string()));
    }

    #[test]
    fn test_markdown() {
        let md = "# Title\n\nSome **bold** text\n\n- item 1\n- item 2";
        assert!(classify(md).contains(&"Markdown".to_string()));
    }

    #[test]
    fn test_html() {
        let html = "<!DOCTYPE html>\n<html>\n<head><title>Test</title></head>\n<body><div>Hello</div></body>\n</html>";
        assert!(classify(html).contains(&"HTML".to_string()));
    }

    #[test]
    fn test_content_type_basic() {
        let c = ContentClassifier::new();
        let ct = |t: &str| ContentClassifier::content_type_from_labels(&c.classify(t));
        assert_eq!(ct("user@example.com"), "email");
        assert_eq!(ct("13812345678"), "phone");
        assert_eq!(ct("#FF5733"), "color");
        assert_eq!(ct(r"C:\Users\test\f.txt"), "file_path");
        assert_eq!(ct("https://github.com"), "link");
        assert_eq!(ct("12345"), "number");
        assert_eq!(ct(r#"{"a":1}"#), "json");
        assert_eq!(ct("hello world"), "text");
    }

    #[test]
    fn test_content_type_code() {
        let c = ContentClassifier::new();
        assert_eq!(
            ContentClassifier::content_type_from_labels(&c.classify("function hello() {\n  console.log('hi');\n  return 42;\n}")),
            "code"
        );
    }

    #[test]
    fn test_content_type_markdown() {
        let c = ContentClassifier::new();
        assert_eq!(
            ContentClassifier::content_type_from_labels(&c.classify("# Title\n\nSome **bold** text\n\n- item 1\n- item 2")),
            "markdown"
        );
    }

    // ===== Plan B: 单行代码 + 注释豁免 + 仲裁 + 日志扩展 =====

    #[test]
    fn test_single_line_js() {
        // 单行 JS 代码：const 强关键字命中 → 代码+JavaScript（解析器仲裁确认）
        let r = classify("const x = foo();");
        assert!(r.contains(&"代码".to_string()));
        assert!(r.contains(&"JavaScript".to_string()));
    }

    #[test]
    fn test_single_line_sql_lowercase() {
        // 小写 SQL：修复前关键词大小写敏感，小写 select 漏判
        let r = classify("select id, name from users where id = 1");
        assert!(r.contains(&"代码".to_string()));
        assert!(r.contains(&"SQL".to_string()));
    }

    #[test]
    fn test_single_line_prose_not_code() {
        // 含括号的散文：无 ;/=>/调用结构 → 不是代码
        let r = classify("I think (as noted) the value differs");
        assert!(!r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_comment_exempt_snippet() {
        // 3 行注释 + 2 行代码：修复前分母 5 行 2 行命中=40%（不 >40%）→ 非代码；
        // 修复后有效行 2 行 2 行命中=100% → 代码
        let r = classify("// c1\n// c2\n// c3\nconst a = 1;\nlet b = 2;");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_ts_java_arbitration() {
        // 规则计分接近（interface/void 两边都命中），解析器仲裁决定：
        // Java 语法能干净解析 void method(Order)，TS 语法不能
        let r = classify("public interface PaymentService {\n    void process(Order order);\n}");
        assert!(r.contains(&"代码".to_string()));
        assert!(r.contains(&"Java".to_string()));
    }

    #[test]
    fn test_nginx_log() {
        // nginx 访问日志：仅有时间戳无级别，旧版本漏判
        let r = classify("127.0.0.1 - - [10/Oct/2024:13:55:36 +0800] \"GET /api HTTP/1.1\" 200 512\n127.0.0.1 - - [10/Oct/2024:13:55:37 +0800] \"POST /login HTTP/1.1\" 401 128");
        assert!(r.contains(&"日志".to_string()));
    }

    #[test]
    fn test_syslog() {
        // syslog 格式：仅有时间戳无级别
        let r = classify("Jan  5 12:00:01 myhost sshd[1234]: Accepted password\nJan  5 12:00:02 myhost sshd[1234]: session opened");
        assert!(r.contains(&"日志".to_string()));
    }

    // ===== v6.10 测试规划 G1：敏感识别系统化用例集 =====
    // 覆盖密钥/Token 的正例与反例,防「加了前缀漏判/长了误判」这类回归。

    #[test]
    fn test_secret_caseset_positive() {
        let c = ContentClassifier::new();
        // 各服务商密钥前缀(JWT/AWS/PEM/Base64 之外,前缀表内)
        let positives = [
            "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
            concat!("xoxb", "-", "123456789012-1234567890123-abcdefghijklmnop"),
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "glpat-abcdefghijklmnopqrstuvwxyz0123456789",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1vP9o4QfQJfK\n-----END RSA PRIVATE KEY-----",
            "AIzaSyDlpT5qXs4vJZqZkQl0xWvWw1i6rY2sQ",
        ];
        for s in positives {
            assert!(c.is_secret(s), "应判为敏感: {s:?}");
        }
    }

    #[test]
    fn test_secret_caseset_negative() {
        let c = ContentClassifier::new();
        // 明显非密钥:短串、带空格的说明、驼峰标识符、普通长词
        let negatives = [
            "sk-",
            "sk-short",
            "请把 API Key 填入设置页面",
            "calculateTotalPriceWithDiscountAndTax12345678",
            "hello world this is a normal sentence",
            "AKIAIOSFODNN7EXAMPL",       // 19 位,不足 20
            "AKIAIOSFODNN7EXAMPLE!",    // 21 位且含符号
            "The quick brown fox jumps over the lazy dog",
        ];
        for s in negatives {
            assert!(!c.is_secret(s), "不应判为敏感: {s:?}");
        }
    }
}

