//! MCP「一键接入」：把本机 MCP 服务写进 AI 客户端自己的配置文件。
//!
//! # 🔴 这是本项目里极少数会去改**别人的文件**的代码
//!
//! `~/.claude.json` 不只有 `mcpServers`：本机那份 500 多行、带着 `projects`
//! （会话历史）、`skillUsage`、`tipsHistory` 等 30 多个顶层键。写坏它
//! 不是「接入失败」，是把用户的东西弄丢了。所以这里四道门一道不能少：
//!
//! 1. **解析不开就一个字都不改**（而不是「那就当空对象重建一份」——那叫清空）
//! 2. **先备份再写**，并把备份路径回给界面
//! 3. **合并不覆盖**：只动 `mcpServers.pastepanda` 这一个键
//! 4. **原子写**（`atomic_write::write_replace`），不留半成品
//!
//! 另外 `MCP_ENTRY_NAME` 写死在后端、**不从前端传**：这样无论前端怎么错，
//! 「移除接入」也只删得掉我们自己那一条，删不到 `filesystem` / `codegraph`。
//!
//! # 两种格式
//!
//! 绝大多数客户端是 JSON，**Codex 是 TOML**（`~/.codex/config.toml`）。
//! 两条路各有一套读/合并/写，但上面那四道门一样都要过；
//! 判定“接没接入”的字段名知识则只在 `judge_entry` 一处，不写两份。
//!
//! # 关于“探测只看文件在不在”
//!
//! 设计稿里写过「探测只做存在性检查、不读内容」，但同一份设计又要求卡片能显示
//! 「已接入 / 令牌已变更」——这两件事不可共存。这里选择读，但**只向前端返回
//! 关于我们自己那一条的判断结果**（四个枚举值），文件里其他任何内容都不过前端。

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};

use crate::atomic_write;
use crate::data_store::DataStore;
use crate::mcp::McpServer;
use crate::user_paths::expand_home;

/// 条目在客户端配置里的名字。
///
/// ❗ 与前端 `src/lib/mcpClients.ts` 的 `MCP_ENTRY_NAME` 必须一致。
/// 改一边不改另一边的后果：探测永远报「未接入」，而每次接入都多写一条。
const MCP_ENTRY_NAME: &str = "pastepanda";

/// 前端拼条目时放在令牌位置的占位符。
///
/// 🔴 条目的**形状**（transport 写法、额外字段）只在 `mcpClients.ts` 里定义一份，
/// 因为屏幕上的复制卡片也靠它。后端不再拼一遍（那就是两份真相，迟早分岔），
/// 只负责把这个占位符换成真令牌——**令牌从头到尾没出过 Rust**。
const TOKEN_SENTINEL: &str = "__PASTEPANDA_TOKEN__";

/// stdio 条目里放在**程序路径**位置的占位符（方案 ①）。
///
/// 为什么这个必须后端填、而 URL 前端就能填：`current_exe()` 只有 Rust 侧知道，
/// 而它是要写进**别人配置文件**里的绝对路径。让前端猜一个（比如写死
/// `PastePanda.exe`）的话，装在非 PATH 目录里的用户得到的是一条打不开的命令，
/// 而 Claude Desktop 那类客户端对打不开的 command **只报「failed to start」**。
const EXE_SENTINEL: &str = "__PASTEPANDA_EXE__";

/// 装 MCP 服务器的那个顶层键。绝大多数客户端都是它。
///
/// 🔴 但**不是全部**：OpenCode 用的是 `mcp`（`~/.config/opencode/opencode.json`）。
/// 所以三个命令都收一个可选的 `container_key`，不传就用这个默认值。
///
/// 🔴 **带点号的容器键 = 嵌套路径**：ZCode 的服务器装在 `mcp.servers` 里
/// （`~/.zcode/cli/config.json` 下的 `{"mcp": {"servers": {…}}}`），不是顶层一个键。
/// 不支持嵌套的话，我们会在它配置里造一个名字就叫 `"mcp.servers"` 的顶层键——
/// 界面显示接入成功，而 ZCode 一个字读不到。
///
/// ❗ 代价是：真有客户端把点号写进**键名本身**的话，这里会拆错。
///   目前名单里没有这种，真碰上了再给注册表加一个「不拆」开关。
///
/// ❗ 它与 `MCP_ENTRY_NAME` 的定位不同：条目名写死在后端是为了「无论前端怎么错，
///   移除接入也只删得掉我们自己那一条」；而容器键必须跟着客户端走，写死就接不了 OpenCode。
const DEFAULT_CONTAINER: &str = "mcpServers";

/// 某个客户端配置的探测结果。
#[derive(Serialize)]
pub struct McpClientProbe {
    /// 展开 `~` 后的绝对路径。界面上直接显示它，用户才能自己去核。
    pub path: String,
    pub exists: bool,
    /// 这台机器上**这个工具在不在**（看它自己的目录，不是看 MCP 配置文件）。
    ///
    /// 🔴 它跟 `exists` 是两回事，而界面分组靠的是它：
    /// 本机 `~/.zcode/` 在（ZCode 装了）但 `~/.zcode/cli/config.json` 不在
    /// （从没配过 MCP）——而那正是一键接入**最有用**的场景（帮他把文件建出来）。
    /// 按 `exists` 分组的话，恰恰把最该露出来的那一类给折起来了。
    ///
    /// 前端不传 `detect_path` 时它就等于 `exists`。
    #[serde(rename = "toolPresent")]
    pub tool_present: bool,
    /// `none` 未接入 · `current` 已接入且现在就能用 ·
    /// `stale` 接入过但已经连不上 · `unreadable` 读不了或解析不开
    ///
    /// ❗ `stale` 对两种条目是**两件事**：http 条目 = 地址或令牌变了，
    /// stdio 条目 = `command` 指向的 exe 或 `--mcp-stdio` 参数不对
    /// （典型成因：换了安装目录）。界面据此选文案，见 `McpClientRow`。
    pub state: &'static str,
    /// `unreadable` 时的原因；其余情况为空串。
    pub detail: String,
}

/// 一次写入（接入或移除）的结果。
#[derive(Serialize)]
pub struct McpConnectOutcome {
    pub path: String,
    /// 备份文件路径；原文件不存在（本次新建）时为空串。
    pub backup: String,
    /// 本次是否盖掉了一条已存在的 `pastepanda` 条目。
    pub replaced: bool,
}

// ---------------------------------------------------------------------------
// 纯逻辑（不碰 Tauri 状态，可单测）
// ---------------------------------------------------------------------------

/// 配置文件的格式。**按扩展名判定，不嗅探内容。**
///
/// 扩展名是客户端自己定死的（`.claude.json` / `config.toml`），比猜内容可靠；
/// 而猜错的下场是把一份 TOML 当 JSON 写回去——那就不是「接入失败」了。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ConfigFormat {
    Json,
    Toml,
}

impl ConfigFormat {
    /// 备份文件末尾要保留的扩展名。
    ///
    /// 一份 TOML 备份成 `.json` 的话，双击打开是报错的——备份就成了只能看不能用的东西。
    fn ext(self) -> &'static str {
        match self {
            ConfigFormat::Json => "json",
            ConfigFormat::Toml => "toml",
        }
    }
}

/// 路径限制：只收 `.json` 与 `.toml`。
///
/// 自定义接入里路径是用户选的，选错一个别的文件虽然还有解析那道关拦着，
/// 但先在这里拦住、报一句直白的话更好。
fn detect_format(path: &Path) -> Result<ConfigFormat, String> {
    match path.extension().and_then(|s| s.to_str()) {
        Some(e) if e.eq_ignore_ascii_case("json") => Ok(ConfigFormat::Json),
        Some(e) if e.eq_ignore_ascii_case("toml") => Ok(ConfigFormat::Toml),
        _ => Err(format!(
            "只能写入 .json 或 .toml 配置文件，但拿到的是：{}",
            path.display()
        )),
    }
}

/// 读并解析配置根对象。文件不存在或为空 → 空对象。
///
/// 🔴 解析失败**必须报错而不能回空对象**：回空对象的话，后面一写就把用户
/// 整份配置替换成了只有我们一条的文件。
fn read_root(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读不了 {}：{}", path.display(), e))?;
    // 先削 BOM：Windows 上的配置文件带 UTF-8 BOM 很常见，而 serde_json 碰到它直接报
    // 「expected value at line 1 column 1」——这条错看上去就像文件内容有问题，最难查。
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let v: Value = serde_json::from_str(text).map_err(|e| {
        format!(
            "{} 不是合法 JSON（{}），为免弄坏它，这里一个字都没改。\
             如果它是带注释的 JSONC（VS Code 那类），请用上面的「复制配置」手动粘进去。",
            path.display(),
            e
        )
    })?;
    if !v.is_object() {
        return Err(format!(
            "{} 的顶层不是一个 JSON 对象，不像是 MCP 客户端配置，这里不动它。",
            path.display()
        ));
    }
    Ok(v)
}

/// 把条目里的占位符递归换成真值，返回换了几处。
///
/// 🔴 **两种占位符走同一个函数**（规则 #11.1）：令牌与程序路径的替换是同一件事
/// ——「前端给形状，后端给只有它知道的本机值」。分成两个函数各查一遍，
/// 下次再加一种本机值（比如某个用户的 profile 目录）就会有人忘了并入
/// 那条「一处都没换到就中止」的护栏，然后把占位符字面量写进别人的配置。
fn substitute_placeholders(v: &mut Value, token: &str, exe: &str) -> usize {
    match v {
        Value::String(s) if s.contains(TOKEN_SENTINEL) || s.contains(EXE_SENTINEL) => {
            // 按**处**数，不是按字符串数：同一个串里可能两个占位符都有，
            // 而返回值是那条「一处都没换到就中止」护栏的唯一判据，报大无妨、报小无益。
            let hits = s.matches(TOKEN_SENTINEL).count() + s.matches(EXE_SENTINEL).count();
            *s = s.replace(TOKEN_SENTINEL, token).replace(EXE_SENTINEL, exe);
            hits
        }
        Value::Array(a) => a
            .iter_mut()
            .map(|x| substitute_placeholders(x, token, exe))
            .sum(),
        Value::Object(o) => o
            .iter_mut()
            .map(|(_, x)| substitute_placeholders(x, token, exe))
            .sum(),
        _ => 0,
    }
}

/// 把条目合并进容器键。返回「是否盖掉了旧条目」。
///
/// ❗ 只动 `container[MCP_ENTRY_NAME]` 一个键，同级的其他服务器原封不动。
fn merge_entry(root: &mut Value, container: &str, entry: Value) -> Result<bool, String> {
    let mut cur = root;
    for seg in container.split('.') {
        let obj = cur.as_object_mut().ok_or_else(|| {
            format!(
                "配置里的 {} 这条路径上有一段不是对象，不敢动它。",
                container
            )
        })?;
        cur = obj
            .entry(seg)
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
    }
    let servers = cur.as_object_mut().ok_or_else(|| {
        format!(
            "配置里的 {} 不是一个对象，不敢动它。请先手动检查这个文件。",
            container
        )
    })?;
    Ok(servers.insert(MCP_ENTRY_NAME.to_string(), entry).is_some())
}

/// 从容器键里拿掉我们那一条。返回「原本在不在」。
fn remove_entry(root: &mut Value, container: &str) -> bool {
    let mut cur = root;
    for seg in container.split('.') {
        match cur.get_mut(seg) {
            Some(next) => cur = next,
            None => return false,
        }
    }
    cur.as_object_mut()
        .and_then(|s| s.remove(MCP_ENTRY_NAME))
        .is_some()
}

/// 已有条目跟当前服务对不对得上。
///
/// 地址或令牌对不上就是 `stale`——两个常见成因：用户换了端口，或者重置了令牌。
/// 不把它当成「已接入」很重要：那个客户端其实已经连不上了，而它不会报错。
///
/// `exe` 是本程序路径，stdio 条目靠它（见 [`judge_stdio_entry`]）。
fn entry_state(root: &Value, container: &str, url: &str, token: &str, exe: &str) -> &'static str {
    let mut cur = Some(root);
    for seg in container.split('.') {
        cur = cur.and_then(|v| v.get(seg));
    }
    judge_entry(cur.and_then(|m| m.get(MCP_ENTRY_NAME)), url, token, exe)
}

/// 判定逻辑本体。**字段名的知识只在这一处**（规则 #11）。
///
/// TOML 那边把条目翻成 JSON 后也走它，不另写一份——
/// 否则哪天又多一家用新字段名，两边得记得都改。
fn judge_entry(entry: Option<&Value>, url: &str, token: &str, exe: &str) -> &'static str {
    let Some(entry) = entry else {
        return "none";
    };
    // 🔴 **先分形状再比内容**：stdio 条目（方案 ①）根本没有 `url` 与令牌，
    //    拿 HTTP 那套判据比它，结果永远是「两个字段都对不上」→ `stale`。
    //    而 `stale` 在界面上叫「令牌或地址已变更」——一句话把用户支去改
    //    一个配置里压根不存在的东西。
    //
    //    判据用 `command` 是不是字符串：它是 stdio 条目的**必要条件**
    //    （客户端靠它起进程），比再看一个 `type` 字段可靠——`type` 恰恰是
    //    各家写法最容易缺的那个键。
    if entry.get("command").and_then(|v| v.as_str()).is_some() {
        return judge_stdio_entry(entry, exe);
    }
    let want_auth = format!("Bearer {}", token);
    // 🔴 URL 与 headers 的**字段名各家不一样**（Gemini CLI 用 `httpUrl`）。
    //    这里不能只认 `url`，否则那几家接入完毕仍然报「未接入」，
    //    用户会反复点接入、每点一次多一份备份。
    let url_ok = ["url", "httpUrl"]
        .iter()
        .any(|k| entry.get(*k).and_then(|v| v.as_str()) == Some(url));
    let auth_ok = ["headers", "http_headers"].iter().any(|k| {
        entry
            .get(*k)
            .and_then(|h| h.get("Authorization"))
            .and_then(|v| v.as_str())
            == Some(want_auth.as_str())
    });
    if url_ok && auth_ok {
        "current"
    } else {
        "stale"
    }
}

/// stdio 条目的判定：`command` 指向的是**现在这个** exe，且带着 stdio 开关。
///
/// 为什么 `command` 变了算 `stale` 而不是「没问题」：换安装目录 / 换盘符之后，
/// 那条 command 指向一个不存在的文件，而客户端只会说 `failed to start`。
/// 显示「程序路径已变更」用户才知道该重新接入一次。
fn judge_stdio_entry(entry: &Value, exe: &str) -> &'static str {
    let command_ok = entry
        .get("command")
        .and_then(|v| v.as_str())
        .is_some_and(|c| same_exe_path(c, exe));
    // `args` 可以是字符串数组，也可以是某些客户端的单个字符串；两种都认。
    let flag = crate::mcp::stdio::ARG_FLAG;
    let args_ok = match entry.get("args") {
        Some(Value::Array(a)) => a.iter().any(|x| x.as_str() == Some(flag)),
        Some(Value::String(s)) => s.split_whitespace().any(|t| t == flag),
        _ => false,
    };
    if command_ok && args_ok {
        "current"
    } else {
        "stale"
    }
}

/// 两个「同一个 exe」的写法。
///
/// Windows 路径不区分大小写，且带不带 `\\?\` 前缀（verbatim）取决于怎么拿到的；
/// 用严格 `==` 比的后果是明明同一个文件却判成 `stale`——用户反复点接入、
/// 每点一次多一份备份，而现场看起来像「我们写坏了它的配置」。
fn same_exe_path(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        let t = s.trim();
        // `\\?\UNC\server\share\x.exe` 与 `\\server\share\x.exe` 是同一个网络位置的
        // 两种写法（程序装在共享盘上时 `current_exe` 给的就是前者）。
        // 🔴 光削掉 `\\?\` 会剩 `UNC\server\share\x.exe`，从此和后者永远对不上——
        // 用户看到的是一条根本没动过的「程序路径已变更」。
        let t = match t.strip_prefix(r"\\?\UNC\") {
            Some(rest) => format!(r"\\{}", rest),
            None => t.trim_start_matches(r"\\?\").to_string(),
        };
        let t = t.replace('\\', "/").trim_end_matches('/').to_string();
        #[cfg(windows)]
        return t.to_ascii_lowercase();
        #[cfg(not(windows))]
        return t;
    }
    let (a, b) = (norm(a), norm(b));
    // 空串不能算相等：那是「两边都没有路径」，不是「两条路径一样」。
    !a.is_empty() && a == b
}

/// 备份原文件，返回备份路径（原文件不存在就返回空串）。
///
/// 名字里带 `pastepanda`：用户在主目录里看到这个文件时，能一眼看出是谁留下的。
/// 末尾保留原来那个扩展名（见 [`ConfigFormat::ext`]）：否则双击打不开，
/// 备份就变成了只能看不能用的东西。
///
/// ❗ 故意**不清理旧备份**。自动删用户目录里的文件是另一类风险，
/// 而接入这个动作一共也就点那么几次。
fn backup(path: &Path, fmt: ConfigFormat) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("路径 {} 没有文件名", path.display()))?;
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = path.with_file_name(format!("{}.pastepanda-bak-{}.{}", stem, ts, fmt.ext()));
    std::fs::copy(path, &dest).map_err(|e| format!("备份 {} 失败：{}", path.display(), e))?;
    Ok(dest.display().to_string())
}

/// 把根对象序列化回磁盘。
///
/// 两空格缩进 + 末尾换行：`~/.claude.json` 本来就是这个样子，
/// 配上 serde_json 的 `preserve_order`（见 Cargo.toml），写回去的 diff 就只有我们那一块。
fn write_root(path: &Path, root: &Value) -> Result<(), String> {
    let mut text =
        serde_json::to_string_pretty(root).map_err(|e| format!("序列化配置失败：{}", e))?;
    text.push('\n');
    atomic_write::write_replace(path, &text)
}

// ---------------------------------------------------------------------------
// TOML 分支（目前只有 Codex：`~/.codex/config.toml`）
//
// 上面那四道门一道不少，只是换个格式。特别是第一道：
// 解析不开就一个字都不改——`config.toml` 里除了 MCP 还有用户自己的模型与
// 审批策略设置，当空文档重建一份同样是把用户的东西弄丢。
// ---------------------------------------------------------------------------

/// 读并解析 TOML 文档。文件不存在 → 空文档（空文件本来就解成空文档，不用特判）。
fn read_toml(path: &Path) -> Result<DocumentMut, String> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读不了 {}：{}", path.display(), e))?;
    // 削 BOM 的理由同 `read_root`。
    let text = text.trim_start_matches('\u{feff}');
    text.parse::<DocumentMut>().map_err(|e| {
        format!(
            "{} 不是合法 TOML（{}），为免弄坏它，这里一个字都没改。",
            path.display(),
            e
        )
    })
}

/// 把前端拼的 JSON 值翻成 TOML 值。
///
/// 嵌套对象一律翻成**行内表**（形如 `http_headers = { Authorization = "..." }`），
/// 不翻成 `[mcp_servers.pastepanda.http_headers]` 子表头：子表头必须排在父表
/// 所有普通键之后，以后条目再多一个字段就容易写出顺序非法的 TOML。
fn json_to_toml_value(v: &Value) -> Result<TomlValue, String> {
    Ok(match v {
        Value::String(s) => TomlValue::from(s.as_str()),
        Value::Bool(b) => TomlValue::from(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                TomlValue::from(i)
            } else if let Some(f) = n.as_f64() {
                TomlValue::from(f)
            } else {
                return Err(format!("条目里有 TOML 表示不了的数字：{}", n));
            }
        }
        Value::Array(a) => {
            let mut arr = toml_edit::Array::new();
            for x in a {
                arr.push(json_to_toml_value(x)?);
            }
            TomlValue::Array(arr)
        }
        Value::Object(o) => {
            let mut t = toml_edit::InlineTable::new();
            for (k, x) in o {
                t.insert(k, json_to_toml_value(x)?);
            }
            TomlValue::InlineTable(t)
        }
        // TOML 没有 null。真出现了就是前端拼错了，报错比静静丢掉一个字段强。
        Value::Null => return Err("条目里有 null，TOML 表示不了".to_string()),
    })
}

/// 把整个条目翻成一张普通表（渲染成 `[mcp_servers.pastepanda]`）。
fn json_entry_to_toml_table(entry: &Value) -> Result<Table, String> {
    let Value::Object(fields) = entry else {
        return Err("要写入的 MCP 条目不是一个对象".to_string());
    };
    let mut tbl = Table::new();
    for (k, v) in fields {
        tbl.insert(k, Item::Value(json_to_toml_value(v)?));
    }
    Ok(tbl)
}

/// 把条目合并进 TOML 的容器表。返回「是否盖掉了旧条目」。
fn merge_entry_toml(doc: &mut DocumentMut, container: &str, entry: &Value) -> Result<bool, String> {
    let tbl = json_entry_to_toml_table(entry)?;
    // 带点号的容器键 = 嵌套路径，语义跟 JSON 那边必须一致（见 `DEFAULT_CONTAINER`）。
    // 目前只有 Codex 走 TOML，而它是单段的 `mcp_servers`；
    // 但两个分支对同一个字串理解不同，就是下一个坑。
    let mut holder = doc.as_table_mut();
    for seg in container.split('.') {
        if !holder.contains_key(seg) {
            let mut t = Table::new();
            // 隐式表：不额外渲染一行光秃秃的 `[mcp_servers]`。
            // 写出来虽然合法，但用户对着备份做 diff 时会多出一处莫名其妙的改动。
            t.set_implicit(true);
            holder.insert(seg, Item::Table(t));
        }
        // 🔴 这里只能用 `as_table_mut`，**不能用 `as_table_like_mut`**：
        //    toml_edit 给行内表实现的 `TableLike::insert` 里是 `value.into_value().unwrap()`，
        //    而我们塞的是一张普通表——那一下会直接 panic（在 Tauri 命令里 panic
        //    比报错严重得多）。容器真被写成了行内表就老实报错、让用户手动粘。
        holder = holder
            .get_mut(seg)
            .and_then(|i| i.as_table_mut())
            .ok_or_else(|| {
                format!(
                    "配置里的 {} 不是一张普通表（或者被写成了行内表），不敢动它。\
                     请把上面的配置手动粘进去。",
                    container
                )
            })?;
    }
    Ok(holder.insert(MCP_ENTRY_NAME, Item::Table(tbl)).is_some())
}

/// 从 TOML 容器表里拿掉我们那一条。返回「原本在不在」。
///
/// 这里用 `as_table_like_mut` 是安全的（`remove` 没有那个 unwrap），
/// 而且移除本来就该尽量能干活：写得再怪的容器也得能把自己那条拿走。
fn remove_entry_toml(doc: &mut DocumentMut, container: &str) -> bool {
    let mut cur: &mut dyn toml_edit::TableLike = doc.as_table_mut();
    for seg in container.split('.') {
        match cur.get_mut(seg).and_then(|i| i.as_table_like_mut()) {
            Some(next) => cur = next,
            None => return false,
        }
    }
    cur.remove(MCP_ENTRY_NAME).is_some()
}

/// 把 TOML 条目里我们关心的字段翻回 JSON，交给 [`judge_entry`] 判。
///
/// ❗ 只翻**字符串、字符串数组、嵌套表**：判定用得着的是 `url` / `httpUrl`、
///   headers 里的 `Authorization`，以及 stdio 条目的 `command` + `args`。
///   `args` 必须翻——它是数组，不翻的话 stdio 条目在 TOML 客户端上
///   永远判成 `stale`（「程序路径已变更」），而它明明是对的。
///   TOML 的日期时间等其余类型一概不翻：翻过去也没人看。
fn toml_entry_to_json(item: &Item) -> Value {
    let mut out = serde_json::Map::new();
    let Some(t) = item.as_table_like() else {
        return Value::Object(out);
    };
    for (k, v) in t.iter() {
        if let Some(s) = v.as_str() {
            out.insert(k.to_string(), Value::String(s.to_string()));
        } else if let Some(arr) = v.as_array() {
            out.insert(
                k.to_string(),
                Value::Array(
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| Value::String(s.to_string())))
                        .collect(),
                ),
            );
        } else if let Some(inner) = v.as_table_like() {
            let mut sub = serde_json::Map::new();
            for (k2, v2) in inner.iter() {
                if let Some(s2) = v2.as_str() {
                    sub.insert(k2.to_string(), Value::String(s2.to_string()));
                }
            }
            out.insert(k.to_string(), Value::Object(sub));
        }
    }
    Value::Object(out)
}

/// TOML 版的状态判定。字段名的知识仍然在 [`judge_entry`] 那一处。
fn entry_state_toml(
    doc: &DocumentMut,
    container: &str,
    url: &str,
    token: &str,
    exe: &str,
) -> &'static str {
    let mut cur: Option<&dyn toml_edit::TableLike> = Some(doc.as_table());
    for seg in container.split('.') {
        cur = cur.and_then(|t| t.get(seg)).and_then(|i| i.as_table_like());
    }
    let entry = cur
        .and_then(|t| t.get(MCP_ENTRY_NAME))
        .map(toml_entry_to_json);
    judge_entry(entry.as_ref(), url, token, exe)
}

/// 把 TOML 文档写回磁盘。
///
/// 不用自己拼格式：`toml_edit` 把原文的注释、空行、缩进都原样拿着，
/// 输出里变化的只有我们那一块。
fn write_toml(path: &Path, doc: &DocumentMut) -> Result<(), String> {
    let mut text = doc.to_string();
    // 只在真缺的时候补换行——无条件 push 会给原有文件末尾白添一个空行，
    // 而那会在用户的 diff 里多出一行不属于我们的改动。
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write::write_replace(path, &text)
}

// ---------------------------------------------------------------------------
// 命令层
// ---------------------------------------------------------------------------

/// 当前服务地址、令牌与本程序路径，**写入版**（令牌没有就当场建一条）。
///
/// `exe` 一起返回是因为 stdio 条目（方案 ①）要把本程序绝对路径写进**别人的**
/// 配置文件，而占位符替换与状态判定都得拿同一个值。分开各拿一次的话，
/// 两边万一取法不同（`current_exe` vs 拼接），判定就会说「路径已变更」。
///
/// ❗ 只给「用户主动点接入」那条路用；批量探测走 [`probe_url_token_exe`]。
fn url_token_exe(
    app: &AppHandle,
    store: &DataStore,
    server: &McpServer,
) -> Result<(String, String, String), String> {
    // 拿的是 **http** 地址：一键接入始终写 http，https 只是并存的第二条路。
    // （第二个参数只影响 `status()` 里的 https 字段，这里用不着。）
    let url = server
        .status(
            super::mcp::configured_port(store),
            super::mcp::configured_https_port(store),
        )
        .url;
    let token = crate::mcp::token::load_or_create(&super::mcp::app_dir(app)?)?;
    Ok((url, token, super::mcp::exe_path()?))
}

/// 探测版：**只读，绝不创建、绝不重建。**
///
/// 🔴 这条不是风格问题。`mcp_client_probe` 是设置面板一打开就批量跑的，
/// 上面那个函数里的 `load_or_create` 在令牌文件损坏时会**顺手换掉令牌**——
/// 后果是用户只是看了一眼设置页，配好的每一条 HTTP 客户端一起 401，
/// 而现场看起来像「MCP 服务坏了」，查不到是我们动的。
/// 令牌损坏同样该由用户点「接入」那一次去重建（那是显式动作），不是被探测顺手做掉。
///
/// 两个取值失败时回空串而不报错：这只是判定的参照物，
/// 为它让整个面板的批量探测报错，代价比收益大（原因仍会由 `state` 显示出来）。
fn probe_url_token_exe(
    app: &AppHandle,
    store: &DataStore,
    server: &McpServer,
) -> (String, String, String) {
    let url = server
        .status(
            super::mcp::configured_port(store),
            super::mcp::configured_https_port(store),
        )
        .url;
    let token = super::mcp::app_dir(app)
        .ok()
        .and_then(|dir| crate::mcp::token::load(&dir).ok().flatten())
        .unwrap_or_default();
    // `current_exe` 实际不会失败；真失败了就是判据偏严（stdio 条目报「路径已变更」），
    // 比让整个探测失败好——而前端那张卡片会单独把「读不到本程序路径」显示出来。
    (url, token, super::mcp::exe_path().unwrap_or_default())
}

/// 探测某个客户端的接入状态。**只返回关于我们自己那一条的判断，不回文件内容。**
///
/// 读不了 / 解析不开不报错而是回 `unreadable`：这个命令是面板一打开就批量跑的，
/// 一个客户端的文件坏了不应该让整面板报错；但原因要带回去显示（规则 #15.3）。
#[tauri::command]
pub fn mcp_client_probe(
    app: AppHandle,
    store: State<DataStore>,
    server: State<McpServer>,
    config_path: String,
    // 不传 = `mcpServers`。OpenCode 那类容器键不同的客户端才需要传。
    // ❗ 参数上不能用 `///`（rustc 只允许 allow/cfg/deny 那几个内置属性）。
    container_key: Option<String>,
    // 这个工具自己的目录（如 `~/.zcode`），只用来算 `tool_present`。
    // 不传就拿配置文件在不在充数。**从不写它，只做存在性检查。**
    detect_path: Option<String>,
) -> Result<McpClientProbe, String> {
    let container = container_key.as_deref().unwrap_or(DEFAULT_CONTAINER);
    let path = expand_home(&config_path)?;
    let display = path.display().to_string();
    let exists = path.exists();
    // ❗ 展开失败当成「不在」，不报错：这只是个分组依据，
    //   为它让整个探测失败不值得。
    let tool_present = match detect_path.as_deref() {
        Some(d) => expand_home(d).map(|p| p.exists()).unwrap_or(false),
        None => exists,
    };
    if !exists {
        return Ok(McpClientProbe {
            path: display,
            exists: false,
            tool_present,
            state: "none",
            detail: String::new(),
        });
    }
    // 后缀不认识也归到 `unreadable`，不报错：面板一打开就批量跑，
    // 一个客户端的路径填错不应该让整面板报错；但原因要带回去显示（规则 #15.3）。
    let fmt = match detect_format(&path) {
        Ok(f) => f,
        Err(detail) => {
            return Ok(McpClientProbe {
                path: display,
                exists: true,
                tool_present,
                state: "unreadable",
                detail,
            })
        }
    };
    let (url, token, exe) = probe_url_token_exe(&app, &store, &server);
    let read = match fmt {
        ConfigFormat::Json => {
            read_root(&path).map(|r| entry_state(&r, container, &url, &token, &exe))
        }
        ConfigFormat::Toml => {
            read_toml(&path).map(|d| entry_state_toml(&d, container, &url, &token, &exe))
        }
    };
    match read {
        Ok(state) => Ok(McpClientProbe {
            path: display,
            exists: true,
            tool_present,
            state,
            detail: String::new(),
        }),
        Err(detail) => Ok(McpClientProbe {
            path: display,
            exists: true,
            tool_present,
            state: "unreadable",
            detail,
        }),
    }
}

/// 一键接入：备份 → 合并 → 原子写。
///
/// `entry` 是前端用 `buildMcpEntry()` 拼好的，令牌位置放的是 `TOKEN_SENTINEL`。
///
/// 🔴 **占位符一次都没换到就直接报错**（规则 #15.3）。否则前端哪天改了字段名，
/// 这里会把一个带着 `__PASTEPANDA_TOKEN__` 字面量的条目写进用户配置，
/// 界面显示「接入成功」而客户端永远 401——最难查的那种失败。
#[tauri::command]
pub fn mcp_client_connect(
    app: AppHandle,
    store: State<DataStore>,
    server: State<McpServer>,
    config_path: String,
    entry: Value,
    // 不传 = `mcpServers`，见 `DEFAULT_CONTAINER`。参数上不能用 `///`。
    container_key: Option<String>,
) -> Result<McpConnectOutcome, String> {
    let container = container_key.as_deref().unwrap_or(DEFAULT_CONTAINER);
    let path = expand_home(&config_path)?;
    let fmt = detect_format(&path)?;
    if !entry.is_object() {
        return Err("要写入的 MCP 条目不是一个对象".to_string());
    }

    let (_, token, exe) = url_token_exe(&app, &store, &server)?;
    let mut entry = entry;
    if substitute_placeholders(&mut entry, &token, &exe) == 0 {
        return Err(format!(
            "条目里找不到占位符 {} 或 {}，为免写出一份连不上的配置，已中止。",
            TOKEN_SENTINEL, EXE_SENTINEL
        ));
    }

    // 🔴 顺序不能变：**所有可能失败的步骤都在内存里做完**（读、解析、合并），
    // 才备份、才写盘。这样无论哪一步出错，磁盘上什么都没发生——
    // 不会白白在用户目录里留下一个无人认领的备份文件。
    let (backup_path, replaced) = match fmt {
        ConfigFormat::Json => {
            let mut root = read_root(&path)?;
            let replaced = merge_entry(&mut root, container, entry)?;
            let backup_path = backup(&path, fmt)?;
            write_root(&path, &root)?;
            (backup_path, replaced)
        }
        ConfigFormat::Toml => {
            let mut doc = read_toml(&path)?;
            let replaced = merge_entry_toml(&mut doc, container, &entry)?;
            let backup_path = backup(&path, fmt)?;
            write_toml(&path, &doc)?;
            (backup_path, replaced)
        }
    };

    log::info!(
        "[MCP] 已接入 {}（{}）",
        path.display(),
        if replaced {
            "替换旧条目"
        } else {
            "新增条目"
        }
    );
    Ok(McpConnectOutcome {
        path: path.display().to_string(),
        backup: backup_path,
        replaced,
    })
}

/// 移除接入：只删容器里名为 `pastepanda` 的那一条，其余原封不动。
///
/// 条目本来就不在也算成功（幂等），但那种情况不写盘也不备份——
/// 没改动却留下一个备份文件只会让人困惑。
#[tauri::command]
pub fn mcp_client_disconnect(
    config_path: String,
    // 不传 = `mcpServers`，见 `DEFAULT_CONTAINER`。参数上不能用 `///`。
    container_key: Option<String>,
) -> Result<McpConnectOutcome, String> {
    let container = container_key.as_deref().unwrap_or(DEFAULT_CONTAINER);
    let path = expand_home(&config_path)?;
    let fmt = detect_format(&path)?;
    if !path.exists() {
        return Ok(McpConnectOutcome {
            path: path.display().to_string(),
            backup: String::new(),
            replaced: false,
        });
    }
    // 同样先在内存里把活干完：条目本来就不在的话直接返回，
    // 既不写盘也不备份——没改动却留下一个备份只会让人困惑。
    let backup_path = match fmt {
        ConfigFormat::Json => {
            let mut root = read_root(&path)?;
            if !remove_entry(&mut root, container) {
                return Ok(McpConnectOutcome {
                    path: path.display().to_string(),
                    backup: String::new(),
                    replaced: false,
                });
            }
            let backup_path = backup(&path, fmt)?;
            write_root(&path, &root)?;
            backup_path
        }
        ConfigFormat::Toml => {
            let mut doc = read_toml(&path)?;
            if !remove_entry_toml(&mut doc, container) {
                return Ok(McpConnectOutcome {
                    path: path.display().to_string(),
                    backup: String::new(),
                    replaced: false,
                });
            }
            let backup_path = backup(&path, fmt)?;
            write_toml(&path, &doc)?;
            backup_path
        }
    };
    log::info!("[MCP] 已从 {} 移除接入", path.display());
    Ok(McpConnectOutcome {
        path: path.display().to_string(),
        backup: backup_path,
        replaced: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 判定用的「本程序路径」。http 条目根本不看它，stdio 条目看（见 [`judge_stdio_entry`]）。
    const EXE: &str = "C:/Program Files/PastePanda/PastePanda.exe";

    /// 拿本机 `~/.claude.json` 的真实形状做样本：除了 mcpServers 还带着一堆别的键。
    fn claude_like() -> Value {
        json!({
            "numStartups": 193,
            "mcpServers": {
                "filesystem": { "command": "cmd", "args": ["/c", "npx"] },
                "paper_search_mcp": { "command": "python.exe" },
                "codegraph": { "type": "stdio", "command": "codegraph" }
            },
            "projects": { "D:\\work": { "history": [1, 2, 3] } }
        })
    }

    #[test]
    fn 合并不能碰到旁边的服务器与其他顶层键() {
        let mut root = claude_like();
        let replaced =
            merge_entry(&mut root, DEFAULT_CONTAINER, json!({ "type": "http" })).unwrap();
        assert!(!replaced, "本来没有 pastepanda 条目，不应报成替换");

        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 4, "原有 3 条 + 我们 1 条");
        for name in ["filesystem", "paper_search_mcp", "codegraph"] {
            assert!(servers.contains_key(name), "把 {} 弄丢了", name);
        }
        // 🔴 mcpServers 以外的键一个都不能少：`projects` 里是用户的会话历史
        assert_eq!(root["numStartups"], json!(193));
        assert_eq!(root["projects"]["D:\\work"]["history"], json!([1, 2, 3]));
    }

    #[test]
    fn 重复接入只替换自己那一条() {
        let mut root = claude_like();
        merge_entry(&mut root, DEFAULT_CONTAINER, json!({ "url": "a" })).unwrap();
        let replaced = merge_entry(&mut root, DEFAULT_CONTAINER, json!({ "url": "b" })).unwrap();
        assert!(replaced);
        assert_eq!(
            root["mcpServers"].as_object().unwrap().len(),
            4,
            "不能越接越多"
        );
        assert_eq!(root["mcpServers"]["pastepanda"]["url"], json!("b"));
    }

    #[test]
    fn 移除只删自己那一条() {
        let mut root = claude_like();
        merge_entry(&mut root, DEFAULT_CONTAINER, json!({ "url": "a" })).unwrap();
        assert!(remove_entry(&mut root, DEFAULT_CONTAINER));
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 3);
        assert!(servers.contains_key("codegraph"));
        // 再删一次：幂等，不报错也不误伤
        assert!(!remove_entry(&mut root, DEFAULT_CONTAINER));
        assert_eq!(root["mcpServers"].as_object().unwrap().len(), 3);
    }

    #[test]
    fn 没有服务器表的配置会被补上() {
        let mut root = json!({ "foo": 1 });
        merge_entry(&mut root, DEFAULT_CONTAINER, json!({ "url": "a" })).unwrap();
        assert_eq!(root["mcpServers"]["pastepanda"]["url"], json!("a"));
        assert_eq!(root["foo"], json!(1));
    }

    #[test]
    // ❗ 函数名里不写 `mcpServers`：嵌了 ASCII 驼峰会触发 non_snake_case 警告，
    //   而 pre-push 钩子里多一条警告就多一分噪音。
    fn 服务器表不是对象时宁可报错也不覆盖() {
        let mut root = json!({ "mcpServers": "不知道谁写成了字符串" });
        assert!(merge_entry(&mut root, DEFAULT_CONTAINER, json!({})).is_err());
        assert_eq!(
            root["mcpServers"],
            json!("不知道谁写成了字符串"),
            "报错了就不能动它"
        );
    }

    #[test]
    fn 占位符会被换成真令牌() {
        let mut entry = json!({
            "type": "http",
            "url": "http://127.0.0.1:8765/mcp",
            "headers": { "Authorization": "Bearer __PASTEPANDA_TOKEN__" }
        });
        assert_eq!(substitute_placeholders(&mut entry, "abc123", EXE), 1);
        assert_eq!(entry["headers"]["Authorization"], json!("Bearer abc123"));
        // url 里没有占位符，不能被误伤
        assert_eq!(entry["url"], json!("http://127.0.0.1:8765/mcp"));
    }

    /// stdio 条目（方案 ①）：一个令牌都不带，本机值占位符是**程序路径**。
    ///
    /// 🔴 这条钉的是「stdio 卡片也能走同一键入护栏」。如果哪天只换令牌那个
    /// 分支被并回来了，这里会当场挂掉——而不是把
    /// `__PASTEPANDA_EXE__` 字面量写进 Claude Desktop 的配置里。
    #[test]
    fn 程序路径占位符也会被换成真值() {
        let mut entry = json!({
            "type": "stdio",
            "command": "__PASTEPANDA_EXE__",
            "args": ["--mcp-stdio"]
        });
        assert_eq!(substitute_placeholders(&mut entry, "tok", EXE), 1);
        assert_eq!(entry["command"], json!(EXE));
        // 没占位符的串一个字节都不能动
        assert_eq!(entry["args"], json!(["--mcp-stdio"]));
    }

    #[test]
    fn 没有占位符时返回零以便调用方中止() {
        // 🔴 前端改了字段名却忘了改这边时，必须能当场发现，
        // 而不是写出一份“接入成功但永远 401”的配置
        let mut entry = json!({ "url": "http://x" });
        assert_eq!(substitute_placeholders(&mut entry, "abc", EXE), 0);
    }

    /// 同一条字符串里两个占位符都有：护栏数的是**处**，不是「有几个串被碰过」。
    #[test]
    fn 一个串里两种占位符都算上() {
        let mut entry = json!({ "url": "__PASTEPANDA_TOKEN__/__PASTEPANDA_EXE__" });
        assert_eq!(substitute_placeholders(&mut entry, "T", "E"), 2);
        assert_eq!(entry["url"], json!("T/E"));
    }

    #[test]
    fn 状态判定认地址也认令牌() {
        let url = "http://127.0.0.1:8765/mcp";
        let mut root = json!({});
        assert_eq!(
            entry_state(&root, DEFAULT_CONTAINER, url, "tok", EXE),
            "none"
        );

        merge_entry(
            &mut root,
            DEFAULT_CONTAINER,
            json!({ "url": url, "headers": { "Authorization": "Bearer tok" } }),
        )
        .unwrap();
        assert_eq!(
            entry_state(&root, DEFAULT_CONTAINER, url, "tok", EXE),
            "current"
        );
        // 令牌重置后：客户端其实已经连不上了，不能还显示「已接入」
        assert_eq!(
            entry_state(&root, DEFAULT_CONTAINER, url, "new-tok", EXE),
            "stale"
        );
        // 换了端口同理
        assert_eq!(
            entry_state(
                &root,
                DEFAULT_CONTAINER,
                "http://127.0.0.1:9999/mcp",
                "tok",
                EXE
            ),
            "stale"
        );
    }

    /// stdio 条目（方案 ①）的判定。
    ///
    /// 🔴 它**完全不看** url 与令牌：stdio 配置里压根没有这两个字段。
    /// 拿 http 那套判据比它的话结果永远是 `stale`，而界面文案会告诉用户
    /// 「令牌或地址已变更」——一句把他支去改一个不存在的东西的假话。
    #[test]
    fn stdio条目只看程序路径与开关参数() {
        let good = json!({
            "type": "stdio",
            "command": EXE,
            "args": [crate::mcp::stdio::ARG_FLAG]
        });
        // url 与令牌**故意**全给错的：stdio 条目必须无视它们
        assert_eq!(
            judge_entry(Some(&good), "http://nope", "no-tok", EXE),
            "current"
        );

        // 换了安装目录：那条 command 指向一个不存在的文件，客户端只会说 failed to start
        let moved = json!({ "command": "D:\\旧位置\\PastePanda.exe", "args": ["--mcp-stdio"] });
        assert_eq!(judge_entry(Some(&moved), "u", "t", EXE), "stale");

        // 路径对、但没带 stdio 开关：那是个 normal 启动的参数，桥不会起来
        let no_flag = json!({ "command": EXE, "args": ["--minimized"] });
        assert_eq!(judge_entry(Some(&no_flag), "u", "t", EXE), "stale");

        // 只有 command、没有 args：同样起不了桥
        let bare = json!({ "command": EXE });
        assert_eq!(judge_entry(Some(&bare), "u", "t", EXE), "stale");

        // ❗ 没有 command 的条目仍走 http 判据（不能被上面几条带偏）
        let http = json!({ "url": "u", "headers": { "Authorization": "Bearer t" } });
        assert_eq!(judge_entry(Some(&http), "u", "t", EXE), "current");
    }

    /// `args` 写成单个字符串的客户端也要认得。
    ///
    /// 各家写法不统一是这一层的老问题（`url`/`httpUrl`、`headers`/`http_headers`
    /// 同理）；不认的话那条明明能用的配置会显示「程序路径已变更」。
    #[test]
    fn stdio的args可以是字符串() {
        let entry =
            json!({ "command": EXE, "args": format!("--foo {}", crate::mcp::stdio::ARG_FLAG) });
        assert_eq!(judge_entry(Some(&entry), "u", "t", EXE), "current");
    }

    /// 🔴 Windows 路径不区分大小写，还可能有 `\\?\` verbatim 前缀。
    /// 用严格 `==` 比的后果：同一个文件判成 `stale`，用户反复点接入、
    /// 每点一次多一份备份，现场看起来像我们写坏了他的配置。
    #[test]
    fn 程序路径比较容忍大小写与前缀() {
        assert!(same_exe_path(EXE, EXE));
        assert!(same_exe_path(EXE, &EXE.to_ascii_uppercase()));
        assert!(same_exe_path(EXE, &EXE.replace('/', "\\")));
        assert!(same_exe_path(
            EXE,
            &format!(r"\\?\{}", EXE.replace('/', "\\"))
        ));
        assert!(same_exe_path(EXE, &format!("{}/", EXE)));
        assert!(same_exe_path(EXE, &format!("  {}  ", EXE)));
        // 真的不是同一个文件
        assert!(!same_exe_path(EXE, "C:/Other/PastePanda.exe"));
        // ❗ 两边都空 = 「都没有路径」，不是「路径相同」
        assert!(!same_exe_path("", ""));
        assert!(!same_exe_path("  ", EXE));
    }

    /// 🔴 程序装在共享盘上时，`current_exe` 拿到的是 `\\?\UNC\server\share\…`，
    /// 而配置里那条通常写成 `\\server\share\…`。只削 `\\?\` 会剩一个 `UNC\…`，
    /// 从此两条永远对不上——用户看到的是一条根本没动过的「程序路径已变更」，
    /// 而他唯一能做的就是反复点接入。
    #[test]
    fn unc_paths_match_their_verbatim_form() {
        let plain = r"\\nas\apps\PastePanda\PastePanda.exe";
        let verbatim = r"\\?\UNC\nas\apps\PastePanda\PastePanda.exe";
        assert!(same_exe_path(plain, verbatim));
        assert!(same_exe_path(verbatim, plain));
        assert!(same_exe_path(plain, plain));
        // 换主机名仍然是两条，不能因为都带 `\\` 就算相同
        assert!(!same_exe_path(
            plain,
            r"\\nas2\apps\PastePanda\PastePanda.exe"
        ));
    }

    /// 🔴 守卫（规则 #11.1）：探测是**面板一打开就批量跑**的自动路径，
    /// 它一旦能重建令牌，用户只是看了一眼设置页，就把所有已配好的 HTTP 客户端
    /// 一起 401 掉，而现场看起来像「MCP 服务坏了」。
    ///
    /// 只能钉源码形状：`token::load` 与 `token::load_or_create` 的区别没有任何类型
    /// 表达得出来，而这个差别是整条命令唯一的安全边界。
    #[test]
    fn probe_command_uses_the_read_only_token_helper() {
        let src = include_str!("mcp_connect.rs");
        let start = src.find("pub fn mcp_client_probe").expect("probe 命令改名了");
        let end = start + src[start..].find("\n#[tauri::command]").unwrap();
        let body = &src[start..end];

        assert!(!body.contains("load_or_create"), "探测路径创建/重建了令牌");
        // `probe_url_token_exe(` 里也含着 `url_token_exe(` 这个子串，
        // 所以判据是「两种调用一样多」，而不是「没出现写入版」。
        let read_calls = body.matches("probe_url_token_exe(").count();
        let all_calls = body.matches("url_token_exe(").count();
        assert_eq!(read_calls, 1, "探测没走收口后的只读取值：{}", body);
        assert_eq!(all_calls, read_calls, "探测里混进了写入版 url_token_exe");

        // 只读版自己（定义在 probe 之前，所以从文件头找）：只准 `token::load`，
        // 且失败一律退化成空串而不是整条命令报错。
        let def = src
            .find("fn probe_url_token_exe")
            .expect("只读版没了");
        let def_body = &src[def..def + src[def..].find("\n}").unwrap()];
        assert!(def_body.contains("token::load("), "只读版没走 load");
        assert!(!def_body.contains("load_or_create"), "只读版在写盘");
    }

    /// 🔴 OpenCode 的容器键是 `mcp` 而不是 `mcpServers`（`~/.config/opencode/opencode.json`）。
    /// 容器键写死的话，接入会往它的配置里**凭空造一个它不认的 `mcpServers`**，
    /// 看上去写成功了，而 OpenCode 一个字都读不到。
    #[test]
    fn 容器键可以不是默认那个() {
        // OpenCode 的真实形状：顶层有 $schema，服务器装在 `mcp` 里
        let mut root = json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": { "别人的": { "type": "remote", "url": "https://x" } }
        });
        let replaced = merge_entry(&mut root, "mcp", json!({ "type": "remote" })).unwrap();
        assert!(!replaced);
        assert_eq!(root["mcp"].as_object().unwrap().len(), 2, "不能碰旁边那条");
        assert_eq!(root["$schema"], json!("https://opencode.ai/config.json"));
        // ❗ 绝不能顺手造一个 mcpServers 出来
        assert!(root.get("mcpServers").is_none(), "写错了容器键");

        assert!(remove_entry(&mut root, "mcp"));
        assert_eq!(root["mcp"].as_object().unwrap().len(), 1);
    }

    /// 🔴 ZCode 的服务器装在 `mcp.servers` 里（`~/.zcode/cli/config.json`），
    /// 不是顶层一个键。不拆点号的话，我们会造一个名字就叫 `"mcp.servers"`
    /// 的顶层键——界面显示接入成功，而 ZCode 一个字读不到。
    #[test]
    fn 嵌套容器键要真的嵌套() {
        let mut root = json!({
            "model": "glm-4",
            "mcp": { "servers": { "别人的": { "type": "http", "url": "https://x" } } }
        });
        let replaced = merge_entry(&mut root, "mcp.servers", json!({ "type": "http" })).unwrap();
        assert!(!replaced);
        assert_eq!(
            root["mcp"]["servers"].as_object().unwrap().len(),
            2,
            "不能碰旁边那条"
        );
        assert_eq!(root["model"], json!("glm-4"));
        // ❗ 绝不能造一个字面量叫 "mcp.servers" 的顶层键
        assert!(root.get("mcp.servers").is_none(), "把点号当成键名了");

        assert!(remove_entry(&mut root, "mcp.servers"));
        assert_eq!(root["mcp"]["servers"].as_object().unwrap().len(), 1);
        // 幂等；中间层缺失时也不能报错
        assert!(!remove_entry(&mut root, "mcp.servers"));
        assert!(!remove_entry(&mut root, "压根没有.这个路径"));
    }

    #[test]
    fn 嵌套容器键没有中间层时会补齐() {
        let mut root = json!({ "model": "glm-4" });
        assert_eq!(entry_state(&root, "mcp.servers", "u", "t", EXE), "none");
        merge_entry(
            &mut root,
            "mcp.servers",
            json!({ "type": "http", "url": "u", "headers": { "Authorization": "Bearer t" } }),
        )
        .unwrap();
        assert_eq!(root["mcp"]["servers"]["pastepanda"]["url"], json!("u"));
        assert_eq!(root["model"], json!("glm-4"));
        assert!(root.get("mcp.servers").is_none());
        assert_eq!(entry_state(&root, "mcp.servers", "u", "t", EXE), "current");
    }

    /// 两个分支对同一个容器键字串的理解必须一致。
    /// （目前走 TOML 的只有 Codex、而它是单段的；这条钉的是将来。）
    #[test]
    fn toml的嵌套语义要跟json一致() {
        let mut doc = "model = \"x\"\n".parse::<DocumentMut>().unwrap();
        merge_entry_toml(&mut doc, "mcp.servers", &json!({ "url": "u" })).unwrap();
        let out = doc.to_string();
        assert!(out.contains("[mcp.servers.pastepanda]"), "没嵌套：{}", out);
        assert!(out.contains("model = \"x\""));
        assert_eq!(
            entry_state_toml(&doc, "mcp.servers", "u", "t", EXE),
            "stale"
        );
        assert!(remove_entry_toml(&mut doc, "mcp.servers"));
        assert!(!remove_entry_toml(&mut doc, "mcp.servers"));
    }

    /// 🔴 Gemini CLI 把 URL 写在 `httpUrl` 里（它靠字段名选传输）。
    /// 状态判定只认 `url` 的话，它接入完毕依然报「未接入」——
    /// 用户会反复点接入，而每点一次就在他主目录里多一份备份文件。
    #[test]
    // ❗ 名字里不能写 `httpUrl`：嵌了 ASCII 驼峰会触发 non_snake_case 警告（上一批就报了）。
    fn 状态判定要认gemini那个url字段() {
        let url = "http://127.0.0.1:8765/mcp";
        let mut root = json!({});
        merge_entry(
            &mut root,
            DEFAULT_CONTAINER,
            json!({ "httpUrl": url, "headers": { "Authorization": "Bearer tok" } }),
        )
        .unwrap();
        assert_eq!(
            entry_state(&root, DEFAULT_CONTAINER, url, "tok", EXE),
            "current"
        );
        assert_eq!(
            entry_state(&root, DEFAULT_CONTAINER, url, "另一把", EXE),
            "stale"
        );
    }

    #[test]
    fn 只收两种后缀并据此分流() {
        assert_eq!(
            detect_format(Path::new("C:\\a\\b.json")).unwrap(),
            ConfigFormat::Json
        );
        assert_eq!(
            detect_format(Path::new("C:\\a\\b.JSON")).unwrap(),
            ConfigFormat::Json
        );
        assert_eq!(
            detect_format(Path::new("C:\\a\\config.toml")).unwrap(),
            ConfigFormat::Toml
        );
        assert_eq!(
            detect_format(Path::new("C:\\a\\config.TOML")).unwrap(),
            ConfigFormat::Toml
        );
        assert!(detect_format(Path::new("C:\\a\\b.md")).is_err());
        assert!(detect_format(Path::new("C:\\a\\b")).is_err());
        // 备份得跟着原格式走，否则双击打不开
        assert_eq!(ConfigFormat::Json.ext(), "json");
        assert_eq!(ConfigFormat::Toml.ext(), "toml");
    }

    // ---- TOML（Codex）----

    /// 拿本机 `~/.codex/config.toml` 的真实形状做样本：
    /// 条目是 `[mcp_servers.xxx]` 子表，而且文件里还有用户自己的设置与注释。
    const CODEX_LIKE: &str = "\
# 我自己写的注释，一个字都不能丢
model = \"gpt-5\"

[mcp_servers.codegraph]
command = \"codegraph\"
args = [\"serve\"]
";

    /// 🔴 这条守的是“为什么非用 toml_edit 不可”：
    /// 用 serde 往返会把用户的注释抹掉，而注释没了是找不回来的。
    #[test]
    fn 写回去要保留注释与旁边的服务器() {
        let mut doc = CODEX_LIKE.parse::<DocumentMut>().unwrap();
        let replaced = merge_entry_toml(
            &mut doc,
            "mcp_servers",
            &json!({
                "url": "http://127.0.0.1:8765/mcp",
                "http_headers": { "Authorization": "Bearer tok" }
            }),
        )
        .unwrap();
        assert!(!replaced);

        let out = doc.to_string();
        assert!(
            out.contains("# 我自己写的注释，一个字都不能丢"),
            "注释被抹了：{}",
            out
        );
        assert!(
            out.contains("model = \"gpt-5\""),
            "用户自己的设置丢了：{}",
            out
        );
        assert!(
            out.contains("[mcp_servers.codegraph]"),
            "把旁边那条弄没了：{}",
            out
        );
        assert!(
            out.contains("[mcp_servers.pastepanda]"),
            "没写进去：{}",
            out
        );
        // headers 要是行内表，不另起一个子表头
        assert!(
            out.contains("http_headers = { Authorization = \"Bearer tok\" }"),
            "headers 写法不对：{}",
            out
        );
        // 写出来的东西必须能再解开（序列化出非法 TOML 是最坏的结果）
        assert!(
            out.parse::<DocumentMut>().is_ok(),
            "写出了解不开的 TOML：{}",
            out
        );
    }

    #[test]
    fn 重复接入与移除在toml上同样只动自己那一条() {
        let mut doc = CODEX_LIKE.parse::<DocumentMut>().unwrap();
        merge_entry_toml(&mut doc, "mcp_servers", &json!({ "url": "a" })).unwrap();
        let replaced = merge_entry_toml(&mut doc, "mcp_servers", &json!({ "url": "b" })).unwrap();
        assert!(replaced, "第二次应该是替换");
        let out = doc.to_string();
        assert!(out.contains("url = \"b\""));
        assert!(!out.contains("url = \"a\""), "越接越多了：{}", out);

        assert!(remove_entry_toml(&mut doc, "mcp_servers"));
        let out = doc.to_string();
        assert!(!out.contains("pastepanda"), "没删干净：{}", out);
        assert!(
            out.contains("[mcp_servers.codegraph]"),
            "误伤了旁边那条：{}",
            out
        );
        assert!(out.contains("# 我自己写的注释，一个字都不能丢"));
        // 再删一次：幂等
        assert!(!remove_entry_toml(&mut doc, "mcp_servers"));
    }

    #[test]
    fn 没有服务器表的toml会被补上且不多一行表头() {
        let mut doc = "model = \"gpt-5\"\n".parse::<DocumentMut>().unwrap();
        merge_entry_toml(&mut doc, "mcp_servers", &json!({ "url": "a" })).unwrap();
        let out = doc.to_string();
        assert!(out.contains("[mcp_servers.pastepanda]"), "{}", out);
        // 🔴 容器是隐式表：不能多出一行光秃秃的 `[mcp_servers]`，
        //    否则用户对着备份做 diff 时会看到一处莫名其妙的改动。
        assert!(!out.contains("\n[mcp_servers]"), "多写了一行表头：{}", out);
    }

    #[test]
    fn toml状态判定认http_headers() {
        let url = "http://127.0.0.1:8765/mcp";
        let mut doc = CODEX_LIKE.parse::<DocumentMut>().unwrap();
        assert_eq!(
            entry_state_toml(&doc, "mcp_servers", url, "tok", EXE),
            "none"
        );

        merge_entry_toml(
            &mut doc,
            "mcp_servers",
            &json!({ "url": url, "http_headers": { "Authorization": "Bearer tok" } }),
        )
        .unwrap();
        assert_eq!(
            entry_state_toml(&doc, "mcp_servers", url, "tok", EXE),
            "current"
        );
        // 重置了令牌 / 换了端口：Codex 其实已经连不上了，不能还显示「已接入」
        assert_eq!(
            entry_state_toml(&doc, "mcp_servers", url, "另一把", EXE),
            "stale"
        );
        assert_eq!(
            entry_state_toml(&doc, "mcp_servers", "http://127.0.0.1:9999/mcp", "tok", EXE),
            "stale"
        );
    }

    /// 🔴 TOML 的 `args` 是**数组**。`toml_entry_to_json` 只翻字符串不翻数组的话，
    /// 一条完全正确的 stdio 配置会永远判成 `stale`（「程序路径已变更」），
    /// 用户在界面上看到的就是「我明明接了，它一直说不对」。
    #[test]
    fn toml里的stdio条目也要能判对() {
        let doc = format!(
            "[mcp_servers.pastepanda]\ncommand = '{}'\nargs = ['{}']\n",
            EXE.replace('\'', ""),
            crate::mcp::stdio::ARG_FLAG
        )
        .parse::<DocumentMut>()
        .unwrap();
        // url 与令牌给错值：TOML 版同样不该看它们
        assert_eq!(
            entry_state_toml(&doc, "mcp_servers", "http://nope", "no-tok", EXE),
            "current"
        );
        // 换了安装目录 → stale（判据得走通到 TOML 这条分支，不能只在 JSON 那边成立）
        assert_eq!(
            entry_state_toml(&doc, "mcp_servers", "u", "t", "D:\\别处\\PastePanda.exe"),
            "stale"
        );
    }

    #[test]
    fn 解析不开的toml报错而不是当空文档() {
        // 🔴 同 JSON 那条：当空文档的话，一写就把用户的模型与审批策略设置全抹了。
        let dir = std::env::temp_dir().join(format!("pp_mct_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.toml");
        std::fs::write(&p, "[mcp_servers\n").unwrap();
        assert!(read_toml(&p).is_err());

        // 带 BOM 的合法 TOML 要能读得动
        let p2 = dir.join("bom.toml");
        std::fs::write(&p2, "\u{feff}model = \"x\"\n").unwrap();
        assert_eq!(read_toml(&p2).unwrap()["model"].as_str(), Some("x"));

        // 不存在算空文档（没东西可弄丢）
        assert!(read_toml(&dir.join("nope.toml"))
            .unwrap()
            .as_table()
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🔴 toml_edit 给行内表实现的 `TableLike::insert` 里是 `into_value().unwrap()`，
    /// 往里塞一张普通表会直接 panic。在 Tauri 命令里 panic 比报错严重得多，
    /// 所以这里宁可报错。
    #[test]
    fn 容器被写成行内表时报错而不是panic() {
        let mut doc = "mcp_servers = { a = { url = \"x\" } }\n"
            .parse::<DocumentMut>()
            .unwrap();
        let before = doc.to_string();
        assert!(merge_entry_toml(&mut doc, "mcp_servers", &json!({ "url": "a" })).is_err());
        assert_eq!(doc.to_string(), before, "报错了就一个字都不能改");
    }

    #[test]
    fn 翻译不了的值宁可报错() {
        // TOML 没有 null。静静丢掉这个字段的话，写出去的就是一份连不上的配置
        assert!(json_to_toml_value(&json!(null)).is_err());
        // 常见类型都得能翻（OpenCode 那类客户端的 `enabled: true` 就是布尔）
        assert!(json_to_toml_value(&json!(true)).is_ok());
        assert!(json_to_toml_value(&json!(30000)).is_ok());
        assert!(json_to_toml_value(&json!(["a", "b"])).is_ok());
    }

    #[test]
    fn 解析不开的文件报错而不是当空对象() {
        // 🔴 这条守的是最严重的一种事故：当空对象的话，一写就把用户
        // 500 多行的 .claude.json 替换成了只有我们一条的文件。
        let dir = std::env::temp_dir().join(format!("pp_mc_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.json");
        std::fs::write(&p, "{ 这不是 json").unwrap();
        assert!(read_root(&p).is_err());

        // 带 BOM 的合法 JSON 则要能读得动
        let p2 = dir.join("bom.json");
        std::fs::write(&p2, "\u{feff}{\"a\":1}").unwrap();
        assert_eq!(read_root(&p2).unwrap()["a"], json!(1));

        // 空文件算空对象（没东西可弄丢）
        let p3 = dir.join("empty.json");
        std::fs::write(&p3, "").unwrap();
        assert!(read_root(&p3).unwrap().is_object());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 写回去保持原有键顺序() {
        // 🔴 靠的是 serde_json 的 preserve_order feature（见 Cargo.toml）。
        // 它被关掉的话这条会挂，而那正是「备份对比时满屏 diff」的成因。
        let text = serde_json::to_string_pretty(&claude_like()).unwrap();
        let a = text.find("numStartups").unwrap();
        let b = text.find("mcpServers").unwrap();
        let c = text.find("projects").unwrap();
        assert!(a < b && b < c, "键被按字母重排了：{}", text);
    }
}
