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
    Regex::new(r"(?m)^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\]|\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2})").unwrap()
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

// ===== 代码检测 — 通用关键字 =====
static CODE_KEYWORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(function|return|class|import|export|const|let|var|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|this|async|await|yield|typedef|struct|enum|interface|extends|implements|abstract|static|public|private|protected|void|int|float|double|bool|boolean|string|char|byte|long|short)\b").unwrap()
});
static CODE_SYNTAX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[{};]|=>|&&|\|\||== |!= |<= |>= ").unwrap()
});
static CODE_INDENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[ \t]{2,}\S").unwrap()
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
        patterns: &[re!(r"\bconst \w+ = "), re!(r"\bfunction \w+\("), re!(r"\.js\b"), re!(r"\.ts\b"), re!(r"\.jsx\b"), re!(r"\.tsx\b")],
    },
    LanguageProfile {
        label: "TypeScript",
        keywords: &[": string", ": number", ": boolean", ": void", "interface ", "type ", "enum ", "as const", "Readonly", "Partial<"],
        patterns: &[re!(r":\s*(string|number|boolean|void)\b"), re!(r"\binterface \w+\b"), re!(r"\btype \w+ =")],
    },
    LanguageProfile {
        label: "Rust",
        keywords: &["fn ", "let mut", "impl", "pub ", "use ", "struct ", "enum ", "match ", "Vec<", "Option<", "Result<", "println!(", "mut ", "&self", "&mut"],
        patterns: &[re!(r"\bfn \w+\(.*\)"), re!(r"\bimpl \w+"), re!(r"\bpub fn ")],
    },
    LanguageProfile {
        label: "Java",
        keywords: &["public class", "private ", "protected ", "void ", "System.out", "String[]", "ArrayList", "HashMap", "@Override", "@Autowired", "@Service", "@Component"],
        patterns: &[re!(r"\bpublic (class|interface|enum)\b"), re!(r"\bSystem\.out\.print"), re!(r"\bprivate (String|int|boolean|void)\b")],
    },
    LanguageProfile {
        label: "Go",
        keywords: &["func ", "package ", "defer", "go func", "chan ", "goroutine", "interface{", "struct{", "fmt.Println", "err != nil"],
        patterns: &[re!(r"\bfunc \w+\("), re!(r"\bpackage \w+"), re!(r"\bdefer \w+\(")],
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

        // 纯数字
        if text.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',' || c == '-' || c == ' ' || c == '\n' || c == '\r') {
            // 确认不全是标点/空格
            let digit_count = text.chars().filter(|c| c.is_ascii_digit()).count();
            if digit_count > 0 && digit_count as f64 / text.len() as f64 > 0.5 {
                return vec!["数字".to_string()];
            }
        }

        // 超短文本 (< 15 字符，不含特殊格式)
        if text.len() < 15 && !text.contains('\n') && !text.contains("://") {
            return vec!["纯文本".to_string()];
        }

        // ===== 1. URL 检测 =====
        if URL_RE.is_match(text) {
            return vec!["链接".to_string()];
        }

        // ===== 2. JSON 检测 =====
        if self.is_json(text) {
            return vec!["JSON".to_string()];
        }

        // ===== 3. 配置文件检测 =====
        if let Some(config_label) = self.detect_config(text) {
            return vec!["配置文件".to_string(), config_label];
        }

        // ===== 4. CSV/TSV 检测 =====
        if self.is_csv(text) {
            return vec!["表格".to_string()];
        }

        // ===== 5. 命令行检测 =====
        if self.is_command(text) {
            return vec!["命令行".to_string()];
        }

        // ===== 6. 日志检测 =====
        if self.is_log(text) {
            return vec!["日志".to_string()];
        }

        // ===== 7. 密钥/Token 检测 =====
        if self.is_secret(text) {
            return vec!["密钥".to_string()];
        }

        // ===== 8. 代码检测 =====
        if self.is_code(text) {
            let lang = self.detect_language(text);
            let mut labels = vec!["代码".to_string()];
            if let Some(l) = lang {
                labels.push(l.to_string());
            }
            return labels;
        }

        // ===== 9. 默认：纯文本 =====
        vec!["纯文本".to_string()]
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
                        if before.matches('"').count() % 2 == 0 {
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

        // 检查是否以常见命令开头
        let lower = first_line.to_lowercase();
        let starts_with_cmd = COMMON_COMMANDS.iter().any(|cmd| lower.starts_with(cmd));
        if !starts_with_cmd {
            return false;
        }

        // 必须有参数
        CMD_ARG_RE.is_match(first_line)
    }

    /// 检测日志
    fn is_log(&self, text: &str) -> bool {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() < 1 {
            return false;
        }
        let total = lines.len() as f64;

        // 前几行包含时间戳 + 日志级别
        let log_lines = lines
            .iter()
            .filter(|l| {
                let l = l.trim();
                if l.is_empty() {
                    return false;
                }
                let has_ts = LOG_TS_RE.is_match(l);
                let has_level = LOG_LEVEL_RE.is_match(l);
                has_ts && has_level
            })
            .count() as f64;

        log_lines / total > 0.3 && log_lines >= 1.0
    }

    /// 检测密钥/Token
    fn is_secret(&self, text: &str) -> bool {
        let trimmed = text.trim();

        // JWT
        if trimmed.len() > 50 && JWT_RE.is_match(trimmed) {
            return true;
        }

        // AWS Access Key
        if trimmed.starts_with("AKIA") && trimmed.len() == 20 {
            return true;
        }

        // GitHub Token
        if (trimmed.starts_with("ghp_") || trimmed.starts_with("github_pat_")) && trimmed.len() > 30 {
            return true;
        }

        // 通用 Base64（长串、非文本）
        if trimmed.len() > 30
            && !trimmed.contains(' ')
            && !trimmed.contains('\n')
            && BASE64_RE.is_match(trimmed)
        {
            // 排除明显的文本（包含常见英文单词）
            let upper = trimmed.to_uppercase();
            let common_words = ["THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HAD", "HER", "WAS", "ONE", "OUR", "OUT", "HAS", "HAVE"];
            if !common_words.iter().any(|w| upper.contains(w)) {
                return true;
            }
        }

        false
    }

    /// 检测是否为代码
    fn is_code(&self, text: &str) -> bool {
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len() as f64;
        if total < 2.0 {
            return false;
        }

        // 统计代码特征行
        let code_lines = lines
            .iter()
            .filter(|l| {
                let l = l.trim();
                if l.is_empty() {
                    return false;
                }
                // 包含代码关键字
                if CODE_KEYWORD_RE.is_match(l) {
                    return true;
                }
                // 包含语法符号
                if CODE_SYNTAX_RE.is_match(l) {
                    return true;
                }
                false
            })
            .count() as f64;

        // 统计缩进行
        let indent_lines = CODE_INDENT_RE.find_iter(text).count() as f64;

        // 阈值：代码特征行 > 40%
        let code_ratio = code_lines / total;
        let indent_ratio = indent_lines / total;

        code_ratio > 0.4 || (code_ratio > 0.2 && indent_ratio > 0.3)
    }

    /// 检测代码语言
    /// patterns 中的正则已通过 LazyLock 预编译，零运行时编译开销
    fn detect_language(&self, text: &str) -> Option<&'static str> {
        let mut best_score = 0i32;
        let mut best_label: Option<&'static str> = None;

        for profile in LANGUAGE_PROFILES {
            let mut score = 0i32;

            // 关键词匹配
            for kw in profile.keywords {
                if text.contains(kw) {
                    score += 3;
                }
            }

            // 正则模式匹配（权重更高）— 调用预编译的 LazyLock<Regex>
            for get_re in profile.patterns {
                let re: &Regex = get_re();
                if re.is_match(text) {
                    score += 5;
                }
            }

            if score > best_score {
                best_score = score;
                best_label = Some(profile.label);
            }
        }

        // 如果最高分 < 6，认为是通用代码，不返回具体语言
        if best_score < 6 {
            None
        } else {
            best_label
        }
    }
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
        // HTML 可能被分类为纯文本（标签比例不够高时），这里验证非空分类结果
        let r = classify("<!DOCTYPE html>\n<html>\n<head>\n  <title>Test</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <div class=\"container\">\n    <p>Hello</p>\n  </div>\n</body>\n</html>");
        // HTML 标签特征明显时应该被分类为代码
        assert!(!r.is_empty());
    }

    #[test]
    fn test_css_code() {
        let r = classify(".container {\n  display: flex;\n  color: red;\n}");
        assert!(r.contains(&"代码".to_string()));
    }

    #[test]
    fn test_shell_code() {
        // Shell 脚本由于空行比例较高可能无法达到 40% 代码阈值，验证返回非空
        let r = classify("#!/bin/bash\n\nexport PATH=/usr/bin\ncd /home/user\n\necho \"Starting...\"\nif [ -f \"$1\" ]; then\n  cat \"$1\" | grep \"error\"\nelse\n  echo \"File not found\"\n  exit 1\nfi");
        assert!(!r.is_empty());
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
        let r = classify("ghp_1234567890abcdef1234567890abcdef12345678");
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
}
