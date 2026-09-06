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
//! # 关于“探测只看文件在不在”
//!
//! 设计稿里写过「探测只做存在性检查、不读内容」，但同一份设计又要求卡片能显示
//! 「已接入 / 令牌已变更」——这两件事不可共存。这里选择读，但**只向前端返回
//! 关于我们自己那一条的判断结果**（四个枚举值），文件里其他任何内容都不过前端。

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

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

/// 某个客户端配置的探测结果。
#[derive(Serialize)]
pub struct McpClientProbe {
    /// 展开 `~` 后的绝对路径。界面上直接显示它，用户才能自己去核。
    pub path: String,
    pub exists: bool,
    /// `none` 未接入 · `current` 已接入且地址令牌都对 ·
    /// `stale` 接入过但地址/令牌变了 · `unreadable` 读不了或解析不开
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

/// 路径限制：只能改 `.json`。
///
/// 自定义接入（后续步骤）里路径是用户选的，选错一个 `package.json` 以外的东西
/// 虽然还有 JSON 解析那道关拦着，但先在这里拦住报错更直白。
fn ensure_json_path(path: &Path) -> Result<(), String> {
    let ok = path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if ok {
        Ok(())
    } else {
        Err(format!("只能写入 .json 配置文件，但拿到的是：{}", path.display()))
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
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读不了 {}：{}", path.display(), e))?;
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

/// 把条目里的占位符递归换成真令牌，返回换了几处。
fn substitute_token(v: &mut Value, token: &str) -> usize {
    match v {
        Value::String(s) if s.contains(TOKEN_SENTINEL) => {
            *s = s.replace(TOKEN_SENTINEL, token);
            1
        }
        Value::Array(a) => a.iter_mut().map(|x| substitute_token(x, token)).sum(),
        Value::Object(o) => o.iter_mut().map(|(_, x)| substitute_token(x, token)).sum(),
        _ => 0,
    }
}

/// 把条目合并进 `mcpServers`。返回「是否盖掉了旧条目」。
///
/// ❗ 只动 `mcpServers[MCP_ENTRY_NAME]` 一个键，同级的其他服务器原封不动。
fn merge_entry(root: &mut Value, entry: Value) -> Result<bool, String> {
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "配置顶层不是对象".to_string())?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let servers = servers.as_object_mut().ok_or_else(|| {
        "配置里的 mcpServers 不是一个对象，不敢动它。请先手动检查这个文件。".to_string()
    })?;
    Ok(servers.insert(MCP_ENTRY_NAME.to_string(), entry).is_some())
}

/// 从 `mcpServers` 里拿掉我们那一条。返回「原本在不在」。
fn remove_entry(root: &mut Value) -> bool {
    root.as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|s| s.as_object_mut())
        .and_then(|s| s.remove(MCP_ENTRY_NAME))
        .is_some()
}

/// 已有条目跟当前服务对不对得上。
///
/// 地址或令牌对不上就是 `stale`——两个常见成因：用户换了端口，或者重置了令牌。
/// 不把它当成「已接入」很重要：那个客户端其实已经连不上了，而它不会报错。
fn entry_state(root: &Value, url: &str, token: &str) -> &'static str {
    let Some(entry) = root.get("mcpServers").and_then(|m| m.get(MCP_ENTRY_NAME)) else {
        return "none";
    };
    let want_auth = format!("Bearer {}", token);
    let url_ok = entry.get("url").and_then(|v| v.as_str()) == Some(url);
    let auth_ok = entry
        .get("headers")
        .and_then(|h| h.get("Authorization"))
        .and_then(|v| v.as_str())
        == Some(want_auth.as_str());
    if url_ok && auth_ok {
        "current"
    } else {
        "stale"
    }
}

/// 备份原文件，返回备份路径（原文件不存在就返回空串）。
///
/// 名字里带 `pastepanda`：用户在主目录里看到这个文件时，能一眼看出是谁留下的。
/// 末尾保留 `.json`：否则双击打不开，备份就变成了只能看不能用的东西。
///
/// ❗ 故意**不清理旧备份**。自动删用户目录里的文件是另一类风险，
/// 而接入这个动作一共也就点那么几次。
fn backup(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("路径 {} 没有文件名", path.display()))?;
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = path.with_file_name(format!("{}.pastepanda-bak-{}.json", stem, ts));
    std::fs::copy(path, &dest).map_err(|e| format!("备份 {} 失败：{}", path.display(), e))?;
    Ok(dest.display().to_string())
}

/// 把根对象序列化回磁盘。
///
/// 两空格缩进 + 末尾换行：`~/.claude.json` 本来就是这个样子，
/// 配上 serde_json 的 `preserve_order`（见 Cargo.toml），写回去的 diff 就只有我们那一块。
fn write_root(path: &Path, root: &Value) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(root)
        .map_err(|e| format!("序列化配置失败：{}", e))?;
    text.push('\n');
    atomic_write::write_replace(path, &text)
}

// ---------------------------------------------------------------------------
// 命令层
// ---------------------------------------------------------------------------

/// 当前服务地址与令牌。两个命令都要，收在一处。
fn url_and_token(
    app: &AppHandle,
    store: &DataStore,
    server: &McpServer,
) -> Result<(String, String), String> {
    let url = server.status(super::mcp::configured_port(store)).url;
    let token = crate::mcp::token::load_or_create(&super::mcp::app_dir(app)?)?;
    Ok((url, token))
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
) -> Result<McpClientProbe, String> {
    let path = expand_home(&config_path)?;
    let display = path.display().to_string();
    let exists = path.exists();
    if !exists {
        return Ok(McpClientProbe {
            path: display,
            exists: false,
            state: "none",
            detail: String::new(),
        });
    }
    let (url, token) = url_and_token(&app, &store, &server)?;
    match read_root(&path) {
        Ok(root) => Ok(McpClientProbe {
            path: display,
            exists: true,
            state: entry_state(&root, &url, &token),
            detail: String::new(),
        }),
        Err(detail) => Ok(McpClientProbe {
            path: display,
            exists: true,
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
) -> Result<McpConnectOutcome, String> {
    let path = expand_home(&config_path)?;
    ensure_json_path(&path)?;
    if !entry.is_object() {
        return Err("要写入的 MCP 条目不是一个对象".to_string());
    }

    let (_, token) = url_and_token(&app, &store, &server)?;
    let mut entry = entry;
    if substitute_token(&mut entry, &token) == 0 {
        return Err(format!(
            "条目里找不到令牌占位符 {}，为免写出一份连不上的配置，已中止。",
            TOKEN_SENTINEL
        ));
    }

    // 顺序不能变：先把原文件读懂（读不懂就在这里停住，什么都没发生），
    // 再备份，最后才写。先备份后解析的话，一个解析失败会白白在用户目录里留下垃圾。
    let mut root = read_root(&path)?;
    let backup_path = backup(&path)?;
    let replaced = merge_entry(&mut root, entry)?;
    write_root(&path, &root)?;

    log::info!(
        "[MCP] 已接入 {}（{}）",
        path.display(),
        if replaced { "替换旧条目" } else { "新增条目" }
    );
    Ok(McpConnectOutcome {
        path: path.display().to_string(),
        backup: backup_path,
        replaced,
    })
}

/// 移除接入：只删 `mcpServers.pastepanda`，其余原封不动。
///
/// 条目本来就不在也算成功（幂等），但那种情况不写盘也不备份——
/// 没改动却留下一个备份文件只会让人困惑。
#[tauri::command]
pub fn mcp_client_disconnect(config_path: String) -> Result<McpConnectOutcome, String> {
    let path = expand_home(&config_path)?;
    ensure_json_path(&path)?;
    if !path.exists() {
        return Ok(McpConnectOutcome {
            path: path.display().to_string(),
            backup: String::new(),
            replaced: false,
        });
    }
    let mut root = read_root(&path)?;
    if !remove_entry(&mut root) {
        return Ok(McpConnectOutcome {
            path: path.display().to_string(),
            backup: String::new(),
            replaced: false,
        });
    }
    let backup_path = backup(&path)?;
    write_root(&path, &root)?;
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
        let replaced = merge_entry(&mut root, json!({ "type": "http" })).unwrap();
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
        merge_entry(&mut root, json!({ "url": "a" })).unwrap();
        let replaced = merge_entry(&mut root, json!({ "url": "b" })).unwrap();
        assert!(replaced);
        assert_eq!(root["mcpServers"].as_object().unwrap().len(), 4, "不能越接越多");
        assert_eq!(root["mcpServers"]["pastepanda"]["url"], json!("b"));
    }

    #[test]
    fn 移除只删自己那一条() {
        let mut root = claude_like();
        merge_entry(&mut root, json!({ "url": "a" })).unwrap();
        assert!(remove_entry(&mut root));
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 3);
        assert!(servers.contains_key("codegraph"));
        // 再删一次：幂等，不报错也不误伤
        assert!(!remove_entry(&mut root));
        assert_eq!(root["mcpServers"].as_object().unwrap().len(), 3);
    }

    #[test]
    fn 没有mcpServers的配置会被补上() {
        let mut root = json!({ "foo": 1 });
        merge_entry(&mut root, json!({ "url": "a" })).unwrap();
        assert_eq!(root["mcpServers"]["pastepanda"]["url"], json!("a"));
        assert_eq!(root["foo"], json!(1));
    }

    #[test]
    fn mcpServers不是对象时宁可报错也不覆盖() {
        let mut root = json!({ "mcpServers": "不知道谁写成了字符串" });
        assert!(merge_entry(&mut root, json!({})).is_err());
        assert_eq!(root["mcpServers"], json!("不知道谁写成了字符串"), "报错了就不能动它");
    }

    #[test]
    fn 占位符会被换成真令牌() {
        let mut entry = json!({
            "type": "http",
            "url": "http://127.0.0.1:8765/mcp",
            "headers": { "Authorization": "Bearer __PASTEPANDA_TOKEN__" }
        });
        assert_eq!(substitute_token(&mut entry, "abc123"), 1);
        assert_eq!(entry["headers"]["Authorization"], json!("Bearer abc123"));
        // url 里没有占位符，不能被误伤
        assert_eq!(entry["url"], json!("http://127.0.0.1:8765/mcp"));
    }

    #[test]
    fn 没有占位符时返回零以便调用方中止() {
        // 🔴 前端改了字段名却忘了改这边时，必须能当场发现，
        // 而不是写出一份“接入成功但永远 401”的配置
        let mut entry = json!({ "url": "http://x" });
        assert_eq!(substitute_token(&mut entry, "abc"), 0);
    }

    #[test]
    fn 状态判定认地址也认令牌() {
        let url = "http://127.0.0.1:8765/mcp";
        let mut root = json!({});
        assert_eq!(entry_state(&root, url, "tok"), "none");

        merge_entry(
            &mut root,
            json!({ "url": url, "headers": { "Authorization": "Bearer tok" } }),
        )
        .unwrap();
        assert_eq!(entry_state(&root, url, "tok"), "current");
        // 令牌重置后：客户端其实已经连不上了，不能还显示「已接入」
        assert_eq!(entry_state(&root, url, "new-tok"), "stale");
        // 换了端口同理
        assert_eq!(entry_state(&root, "http://127.0.0.1:9999/mcp", "tok"), "stale");
    }

    #[test]
    fn 只收json后缀() {
        assert!(ensure_json_path(Path::new("C:\\a\\b.json")).is_ok());
        assert!(ensure_json_path(Path::new("C:\\a\\b.JSON")).is_ok());
        assert!(ensure_json_path(Path::new("C:\\a\\b.md")).is_err());
        assert!(ensure_json_path(Path::new("C:\\a\\b")).is_err());
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
