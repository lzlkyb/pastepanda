//! stdio 桥（方案 ①）—— 让**只认 stdio** 的宿主（Claude Desktop 那类）也能接上。
//!
//! ## 它是什么
//!
//! 一个**纯转发器**：`PastePanda.exe --mcp-stdio` 不进 Tauri、不开窗口、
//! **不碰 SQLite**，只是把 stdin 上的逐行 JSON-RPC 转发给本机那个已经在跑的
//! HTTP 监听（`http://127.0.0.1:<port>/mcp`），再把应答原样写回 stdout。
//!
//! ## 为什么做转发器而不是「在 stdio 上重新实现一遍协议」
//!
//! 因为协议那一侧已经有 `Origin`/`Host` 门、Bearer 门、写开关双层门、
//! nonce 包裹、W3 审计。在 stdio 上再写一遍这些判断，就是规则 #11.1 定义的
//! 失败——两份安全策略早晚会漂，而漂的方式是「走 stdio 那条门松一点」。
//! 转发的代价是一次本机 loopback HTTP 往返（实测同进程 < 1ms 量级），
//! 换回来的是**只有一套门**。
//!
//! 🔴 硬约束（方案文档 §5）：**不在本进程打开第二个 SQLite 连接**。
//! 这条模块里一行数据库代码都不许出现。
//!
//! ## 端口怎么找
//!
//! 主程序启 MCP 时写 `mcp_endpoint.json`（见 [`endpoint_path`]），停机删。
//! 桥**不扫端口、不猜、不漂**——沿用 `server.rs` 决策 D5 那条理由：
//! 猜出来的地址会让「服务在跑但客户端连不上」这种故障变成最难查的一类。
//! 读不到 / 探活失败就给出一句人话的错误，而不是超时。
//!
//! ## stdout 纯净
//!
//! stdio 传输里 stdout **只有**换行分隔的 JSON-RPC 应答，一个字符都不能多。
//! 所以本模块所有诊断走 stderr；日志器只装 stderr 版（[`init_stderr_log`]）。
//! 回归风险：任何一处 `println!` 都会打断管道，而现象是「客户端显示 0 个工具」。

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

/// 命令行开关。命中即进桥模式，**不启动 GUI**。
pub const ARG_FLAG: &str = "--mcp-stdio";

/// 端口文件（在应用数据目录里）。名字避开 `config_*`，理由同 `token.rs`。
pub const ENDPOINT_FILE: &str = "mcp_endpoint.json";

/// 应用标识符：Tauri 用它拼应用数据目录。
///
/// 🔴 它必须与 `tauri.conf.json` 的 `identifier` 一致，否则桥在 GUI 之外
/// 算出的目录跟主程序写端口文件的目录不是同一个，表现就是「桥说主程序没在跑」。
/// 有一条守卫测试逐字比那两个值（见本文件末尾）。
const APP_IDENTIFIER: &str = "com.pastepanda.app";

/// 探活超时。给得短是对的：桥在父进程的管道里，转成超时=客户端一直转圈。
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 转发超时。`tools/read` 拼一篇长文时确实要写一段时间，给 30s 不嫌多。
const FORWARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `mcp_endpoint.json` 的内容。
///
/// 字段比桥实际要用的多（`pid` / `started_at`）：桥不拿 `pid` 判活（判活走
/// `/health`，那才是「MCP 服务在不在」的直接证据），但这两个字段是人排查时
/// 第一眼要看的东西——陈旧文件到底是哪一次启动留下的。
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub https_port: u16,
    pub pid: u32,
    pub started_at: i64,
}

/// 端口文件的完整路径。
pub fn endpoint_path(app_dir: &Path) -> PathBuf {
    app_dir.join(ENDPOINT_FILE)
}

/// 桥在 GUI 之外运行，拿不到 `AppHandle`，只能按同一套规则把目录算出来。
///
/// 允许 `PASTEPANDA_APP_DIR` 覆盖：单测靠它把端口文件写进临时目录，
/// 用户换过数据目录时也有路可走。覆盖只影响「去哪读端口文件」，
/// 令牌同样在这个目录里，所以两者要么一起找到、要么一起找不到——
/// 不会出现「用 A 目录的端口 + B 目录的令牌」这种拼错的状态。
pub fn app_dir_from_env() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PASTEPANDA_APP_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    #[cfg(windows)]
    {
        let roaming = std::env::var("APPDATA").ok()?;
        return Some(PathBuf::from(roaming).join(APP_IDENTIFIER));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        return Some(
            PathBuf::from(home)
                .join("Library/Application Support")
                .join(APP_IDENTIFIER),
        );
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| format!("{h}/.local/share"))
            })?;
        Some(PathBuf::from(base).join(APP_IDENTIFIER))
    }
}

/// 主程序侧：启服务成功后落端口文件。
///
/// 写失败**不影响服务**（HTTP 那条路一切照常），只让 stdio 桥找不到门——
/// 所以调用方拿 `Err` 去记日志，不往上抛。原子写（临时文件 + rename）：
/// 半截 JSON 会被桥读成解析错误，而现象又是「桥连不上」。
pub fn write_endpoint(app_dir: &Path, port: u16, https_port: u16) -> Result<PathBuf, String> {
    let endpoint = Endpoint {
        port,
        https_port,
        pid: std::process::id(),
        started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default(),
    };
    std::fs::create_dir_all(app_dir).map_err(|e| format!("无法创建数据目录：{}", e))?;
    let path = endpoint_path(app_dir);
    let tmp = app_dir.join(".mcp_endpoint.tmp");
    let body =
        serde_json::to_vec_pretty(&endpoint).map_err(|e| format!("序列化端口文件失败：{}", e))?;
    std::fs::write(&tmp, &body).map_err(|e| format!("写入端口临时文件失败：{}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存端口文件失败：{}", e)
    })?;
    Ok(path)
}

/// 主程序侧：停服务后收掉端口文件。
///
/// 留个残留文件的话，桥会敲一个**已经没人听**的端口，然后靠探活去猜
/// 「主程序没在跑」还是「服务关了」。删得掉就别说谎。删不掉不报错：
/// 桥自己有 [`probe_health`] 兜底，而 [`forward`] 每次都重读端口文件，
/// 陈旧内容最坏也只是变成一句「连不上」。
pub fn remove_endpoint(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[MCP-stdio] 端口文件没删掉：{}", e);
        }
    }
}

/// 解析端口文件内容。坏内容 → `None`（调用方按「没有端口文件」处理）。
///
/// 端口还要过一道合法性检查：`0` 或超界值写进来时转发必然失败，
/// 而失败原因会被报成「连不上」——不如在这里就说「端口文件不可信」。
pub fn parse_endpoint(raw: &str) -> Option<Endpoint> {
    let e: Endpoint = serde_json::from_str(raw).ok()?;
    if e.port < 1024 {
        return None;
    }
    Some(e)
}

/// 读端口文件。
pub fn read_endpoint(app_dir: &Path) -> Option<Endpoint> {
    let raw = std::fs::read_to_string(endpoint_path(app_dir)).ok()?;
    parse_endpoint(&raw)
}

/// 这条请求是不是「不用回话」的通知。
///
/// JSON-RPC 的判据是**没有 `id` 成员**，不是 `id: null`。
/// MCP 的 `notifications/initialized`、`notifications/cancelled` 都走这条路。
/// 回错了会让客户端看到一个它没问过的应答，个别实现直接断管道。
///
/// 🔴 只有**对象**才可能是通知：`Value::Array`（JSON-RPC 批量）与标量上
/// `get("id")` 一律是 `None`，若照上面那句判，它们会被当成通知——**一条都不回**，
/// 而发批量请求的客户端会永远等在那儿（表现是「接上了，然后整个卡死」）。
pub fn is_notification(req: &Value) -> bool {
    req.as_object().is_some_and(|o| !o.contains_key("id"))
}

/// 桥自己造的错误应答：通知一律**不回**。
///
/// 🔴 这条守卫的不是协议洁癖：转发失败时如果给通知也补一条 error 应答，
/// 那些客户端（Claude Desktop 在内）会把它当成一次陌生响应处理，
/// 表现是「连上了但立刻断开」。
pub fn error_line_for(req: &Value, message: &str) -> Option<String> {
    if is_notification(req) {
        return None;
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    render_error(id, -32603, message)
}

/// 把上游 HTTP 应答变成要写回 stdout 的那一行。
///
/// 只在**上游真的返回了合法 JSON** 时原样转发；其余一律自己造错误应答。
/// 重序列化不是为了好看——`serde_json` 会把字符串里的换行转义掉，
/// 而 stdout 的分行协议里混进一个裸换行就是打断管道。
pub fn response_line(req: &Value, status: u16, body: &str) -> Option<String> {
    if is_notification(req) {
        return None;
    }
    let id = req
        .get("id")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    if status >= 400 {
        return render_error(
            id,
            rpc_code_for_status(status),
            &http_error_message(status, body),
        );
    }
    match serde_json::from_str::<Value>(body) {
        Ok(v) => serde_json::to_string(&v).ok(),
        Err(_) => render_error(
            id,
            -32603,
            "MCP 服务返回的不是合法 JSON（本机 HTTP 端口可能被别的程序占了）",
        ),
    }
}

/// 非 2xx 时的错误码。参数问题与鉴权问题分开，客户端据此决定要不要重试。
fn rpc_code_for_status(status: u16) -> i64 {
    match status {
        401 | 403 => -32001,
        404 => -32601,
        429 => -32005,
        _ => -32603,
    }
}

/// 把 HTTP 层的拒绝翻成一句用户看得懂的话。
///
/// 上游这几条是 `auth::Reject::message()` 与 `/health` 404 的原文。
/// 桥在这里补上「为什么」和「去哪儿修」，因为 stdio 客户端只会显示这一句。
fn http_error_message(status: u16, body: &str) -> String {
    let head = body.trim();
    if status == 401 {
        return "未授权：本机 MCP 的访问令牌与主程序当前的不一致（多半是刚重置过令牌）。\
                请在 PastePanda 设置 · MCP 里重新接入。"
            .to_string();
    }
    // 截断后再插值：上游那句拒绝理由很短，但 500 页/半个 JSON 这类东西
    // 不该整条抄进 stdio 的应答里（那是要显示在客户端日志里的）。
    let excerpt = trim_to(head, 200);
    if status == 403 {
        return format!(
            "被拒绝：{}",
            if excerpt.is_empty() {
                "（无响应体）"
            } else {
                &excerpt
            }
        );
    }
    format!(
        "MCP 服务返回 HTTP {}：{}",
        status,
        if excerpt.is_empty() {
            "（无响应体）"
        } else {
            &excerpt
        }
    )
}

fn trim_to(s: &str, max_chars: usize) -> String {
    let out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        format!("{}…", out)
    } else {
        out
    }
}

fn render_error(id: Value, code: i64, message: &str) -> Option<String> {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }))
    .ok()
}

/// 从 `initialize` 里取客户端自报的名字，用作转发请求的 `User-Agent`。
///
/// 为什么值得绕这么一圈：`/mcp` 那边把 **User-Agent** 当成客户端身份
/// （`server.rs:599` 注释：实测 Claude Code 每个请求都带 `claude-code/x.y`，
/// 而 `clientInfo` 只在 initialize 出现一次）。桥如果用自己的 UA 转发，
/// 设置页的「客户端花名册」和写入来源标记（`agent:xxx`）就全都变成
/// `PastePanda-stdio-bridge`——**真实客户端是谁，这个功能上线后反而查不到了**。
/// stdio 桥是单客户端独占的，所以学一次就够用。
pub fn learn_client_name(req: &Value) -> Option<String> {
    if req.get("method").and_then(|m| m.as_str()) != Some("initialize") {
        return None;
    }
    let info = req.get("params")?.get("clientInfo")?;
    let name = header_safe(info.get("name")?.as_str()?.trim());
    if name.is_empty() {
        return None;
    }
    let version = info
        .get("version")
        .and_then(|v| v.as_str())
        // 版本也要截：`trim_to` 是两参函数，直接 `.map(trim_to)` 编不过，
        // 而这个上限的意义就是「别让一个离谱的自报字段撞进 UA」。
        .map(|v| header_safe(&trim_to(v, 40)))
        .filter(|v| !v.is_empty())
        // 🔴 没有版本也要留一个 `/`：`source_agent_from_ua` 按**第一个** `/` 切名字，
        // 而 UA 长的是 `名字/版本 (PastePanda-stdio-bridge/7.2.9)`。少了自己那个
        // `/`，切出来的名字就成了「Kilo (PastePanda-stdio-bridge」——
        // 花名册里会多出一个谁也不认识的来源，而这个功能的全部意义就是
        // 「真实客户端是谁」。
        .unwrap_or_else(|| "0".to_string());
    Some(format!("{}/{}", header_safe(&trim_to(&name, 60)), version))
}

/// 只留 HTTP 头能装的字符（可见 ASCII + 空格），其余一律去掉。
///
/// 🔴 不是防御性洁癖：`HeaderValue` 装不下非 ASCII，而 reqwest 的
/// `.header(USER_AGENT, 坏值)` 会把错误**记到 builder 上**——于是每一条转发的
/// `send()` 都返回「invalid HTTP header value」。客户端自报一个中文名
/// （`clientInfo.name` 是自由字段，谁都拦不住）的代价，是整条 stdio 通道
/// 一条请求都发不出去。宁可把名字丢掉，也不能把通道丢掉。
fn header_safe(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .collect::<String>()
        .trim()
        .to_string()
}

/// 装一个**只写 stderr** 的日志器。
///
/// 不能用主程序那套 `FileTeeLogger`：它写 rc.log，而桥的日志里会有
/// 「谁连进来、转发失败原因」这类东西，混进被控端的取证日志里只会互相干扰。
/// 更要命的是它写 stderr 的同时还开文件——桥不需要那些。
fn init_stderr_log() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // `Target::Stderr` 是这条模块的硬要求，不写出来 `env_logger` 的默认
        // 就是 stdout——那会直接污染协议通道。
        let _ = env_logger::Builder::new()
            .parse_filters(
                std::env::var("RUST_LOG")
                    .unwrap_or_else(|_| "warn,pastepanda_lib::mcp=info".to_string())
                    .as_str(),
            )
            .target(env_logger::Target::Stderr)
            .try_init();
    });
}

/// 往 stderr 写一句诊断，**写不下去也绝不影响主流程**。
///
/// 🔴 为什么不用 `eprintln!`：它遇到写失败会 panic（`failed printing to stderr`），
/// 而本程序 release 版是 `windows_subsystem = "windows"`（`main.rs:2`）——
/// 宿主若把 stderr 接成无效句柄或半路关掉，第一句日志就会把桥打成 101 退出，
/// 现场看到的却是「配好了但一个工具都没有」，跟真实原因（日志写不下去）毫无关系。
/// 诊断是**附加信息**，它没有资格决定这条通道能不能用。
fn note(msg: &str) {
    let mut err = std::io::stderr();
    let _ = writeln!(err, "[MCP-stdio] {}", msg);
    let _ = err.flush();
}

/// [`note`] 的格式串版；刻意做成与 `eprintln!` 同形，方便逐处替换而不变读法。
macro_rules! enote {
    ($($arg:tt)*) => { $crate::mcp::stdio::note(&format!($($arg)*)) };
}

/// 入口：`main` 在构造 Tauri **之前**调用它。
///
/// 返回进程退出码。本函数**永不 panic 到用户看不见**：设置阶段的每个失败
/// 都先写 stderr 再返回码，因为 stdio 客户端只会把 stderr 原样吐给日志。
pub fn serve() -> i32 {
    init_stderr_log();

    let app_dir = match app_dir_from_env() {
        Some(d) => d,
        None => {
            enote!("找不到应用数据目录（APPDATA 未设置），无法定位 MCP 服务。");
            return 2;
        }
    };
    // 令牌**只读不建**（见 `token::load` 的注释）：桥顺手生成会把主程序
    // 正在用的那条顶掉，而已配好的 HTTP 客户端全部 401。
    let token = match super::token::load(&app_dir) {
        Ok(Some(t)) => t,
        Ok(None) => {
            enote!("尚未生成 MCP 访问令牌：请在 PastePanda 设置里开启知识库 MCP 服务。");
            return 3;
        }
        Err(e) => {
            enote!("读取访问令牌失败：{}", e);
            return 4;
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            enote!("运行时启动失败：{}", e);
            return 5;
        }
    };
    rt.block_on(run(app_dir, token))
}

async fn run(app_dir: PathBuf, token: String) -> i32 {
    let client = match reqwest::Client::builder()
        .user_agent(bridge_user_agent(None))
        .timeout(FORWARD_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            enote!("HTTP 客户端创建失败：{}", e);
            return 6;
        }
    };

    // 启动时就探一次活：让「主程序没在跑」在 stderr 里第一时间出现，
    // 而不是等客户端发了第一条请求才有反馈。探活**不拦路**——
    // 主程序可能就在几秒后起来，所以失败也继续读 stdin。
    if let Some(endpoint) = read_endpoint(&app_dir) {
        match probe_health(&client, endpoint.port).await {
            Ok(()) => enote!("已连上本机 MCP（端口 {}），stdio 桥开始工作。", endpoint.port),
            Err(why) => enote!("端口文件在，但连不上 MCP 服务：{}", why),
        }
    } else {
        enote!("没找到端口文件：MCP 服务当前未开启。桥会等着，期间每条请求都回错误。");
    }

    // stdin 读取放独立线程：桥必须串行转发（保持请求-应答一一对应、
    // 也让并发上限那个不变量在这儿依然成立），而读一行可能阻塞到
    // 客户端发下一条为止——那不能占着运行时线程。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        loop {
            buf.clear();
            match stdin.lock().read_line(&mut buf) {
                Ok(0) => return,
                Ok(_) => {
                    let line = buf.trim_end_matches(['\n', '\r']).to_string();
                    if line.trim().is_empty() {
                        continue;
                    }
                    if tx.send(line).is_err() {
                        return;
                    }
                }
                // 🔴 读失败必须**退出**而不是重试：管道断了（客户端关了）时
                // read_line 会立刻返错，重试就是个空转刷屏的死循环。
                Err(e) => {
                    note(&format!("stdin 读取结束：{}", e));
                    return;
                }
            }
        }
    });

    // 应答只有这一个出口：写锁 + `writeln!` 保证一行一条且不会被打断。
    // 🔴 写失败（客户端把读端关了）要把 `false` 传回 [`pump`]，让它收摊——
    // 否则管道断了而桥还在一条条转发，变成一个没人读的僵尸进程。
    let stdout = std::io::stdout();
    pump(&client, &app_dir, &token, &mut rx, &mut |line| {
        writeln!(stdout.lock(), "{}", line).is_ok()
    })
    .await;
    0
}

/// 请求循环本体：收一行 → 转发 → 写一行。
///
/// 从 [`run`] 里单独拎出来是因为**这一段是桥的全部行为**，而它原本唯一的可注入点
/// 是进程的真 stdin/stdout——那就只能在测试里拉起一个真子进程，既慢又没法断言
/// 「服务端到底收到了什么头」。拎出来之后出口是个闭包，整套逻辑可在进程内测。
///
/// ❗ 拎出来的**不是**判定：成形仍然走 [`response_line`] / [`error_line_for`]，
/// 转发仍然走 [`forward`]，这里只是把两根管子接起来。
async fn pump(
    client: &reqwest::Client,
    app_dir: &Path,
    token: &str,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    // `false` = 管道断了（调用方已不再读），循环必须收摊。
    write_line: &mut dyn FnMut(String) -> bool,
) {
    let mut ua: Option<String> = None;
    // 只在内存里跟着「重置令牌」更新，见下面 401 那段。
    let mut token = token.to_string();

    while let Some(line) = rx.recv().await {
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                // 解析不出来连 id 都拿不到，只能按协议回 `id: null`。
                if let Some(out) =
                    render_error(Value::Null, -32700, &format!("JSON 解析失败：{}", e))
                {
                    if !write_line(out) {
                        return;
                    }
                }
                continue;
            }
        };

        // 🔴 非对象（JSON-RPC 批量、标量）**不能转发出去**：上游会把它们拒了，
        // 而拒答的应答没有可对的 `id`，上面 [`is_notification`] 那条判定又会把它们
        // 当成通知吞掉——发的人永远等不到回包，整个客户端就钉在这儿了。
        // 就地给一句明确的 invalid request，比让客户端转圈有用得多。
        if !req.is_object() {
            if let Some(out) = render_error(
                Value::Null,
                -32600,
                "这条请求不是 JSON 对象。stdio 通道一次只处理一个请求，批量（数组）写法请逐条发送。",
            ) {
                if !write_line(out) {
                    return;
                }
            }
            continue;
        }

        if let Some(name) = learn_client_name(&req) {
            ua = Some(name);
        }

        let mut attempt = forward(client, app_dir, &token, ua.as_deref(), &line).await;

        // 401 有两种成因，而桥只认得出其中一种：客户端确实没权限，以及
        // **主程序刚重置过令牌**。后者能自愈——桥跟主程序读同一个 DPAPI 文件，
        // 重读一次再发一次就过去了（stdio 客户端往往几小时不重启子进程，
        // 不自愈的话这条通道会一直 401 到用户手动重开宿主）。
        //
        // 🔴 两道限制：只在**盘上那条确实变了**时才重发，且只重发一次。
        // 重发是安全的，因为 401 出自鉴权门、在 `dispatch` 之前——
        // 写操作一次都没执行过，不存在「同一笔写入落地两次」。
        if matches!(attempt, Ok((401, _))) {
            if let Ok(Some(fresh)) = super::token::load(app_dir) {
                if fresh != token {
                    token = fresh;
                    attempt = forward(client, app_dir, &token, ua.as_deref(), &line).await;
                }
            }
        }

        match attempt {
            Ok((status, body)) => {
                if let Some(out) = response_line(&req, status, &body) {
                    if !write_line(out) {
                        return;
                    }
                }
            }
            Err(why) => {
                if let Some(out) = error_line_for(&req, &why) {
                    if !write_line(out) {
                        return;
                    }
                }
                note(&format!("转发失败：{}", why));
            }
        }
    }
}

/// 转发一行原始请求。**原样透传字节**，不重排键序也不改内容：
/// 桥改了任何字段都可能让上游的签名/校验或客户端的应答比对失败。
async fn forward(
    client: &reqwest::Client,
    app_dir: &Path,
    token: &str,
    ua: Option<&str>,
    raw_line: &str,
) -> Result<(u16, String), String> {
    let endpoint = read_endpoint(app_dir).ok_or_else(|| {
        "PastePanda 的 MCP 服务没有在运行（设置里打开「知识库 MCP 服务」后主程序会写端口文件）。".to_string()
    })?;
    let url = format!("http://127.0.0.1:{}/mcp", endpoint.port);
    let user_agent = bridge_user_agent(ua);
    let res = client
        .post(&url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", token))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        // 🔴 不发 `Origin`：本机 MCP 把它当浏览器的证据（`auth.rs:173` 优先查它）。
        // 非浏览器客户端本来就不发，`Host: 127.0.0.1` 那道门照样过得去。
        .body(raw_line.to_string())
        .send()
        .await
        .map_err(|e| format!("连不上本机 MCP 服务（端口 {}）：{}", endpoint.port, e))?;
    let status = res.status().as_u16();
    // 不再单独给响应体计时：`Client` 上的 `FORWARD_TIMEOUT` 覆盖整条请求
    // （含读体）。这里再套一层短超时的话，一篇长文会被桥自己掐断。
    let body = res
        .text()
        .await
        .map_err(|e| format!("响应体读取失败：{}", e))?;
    Ok((status, body))
}

/// 探活。`/health` 故意不鉴权，所以这里不需要令牌。
async fn probe_health(client: &reqwest::Client, port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health", port);
    client
        .get(&url)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("{}", e))?
        .error_for_status()
        .map_err(|e| format!("{}", e))?;
    Ok(())
}

/// 桥自己的 UA。学到客户端名字时挂在后面，让花名册一眼看出这条是 stdio 来的。
fn bridge_user_agent(client_name: Option<&str>) -> String {
    let base = format!("PastePanda-stdio-bridge/{}", env!("CARGO_PKG_VERSION"));
    match client_name {
        Some(n) if !n.trim().is_empty() => format!("{} ({})", n.trim(), base),
        _ => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pastepanda_mcp_stdio_test_{}", tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── 端口文件 ────────────────────────────────────────────────

    #[test]
    fn test_endpoint_roundtrip_and_bad_port_is_distrusted() {
        let dir = temp_dir("endpoint");
        let path = write_endpoint(&dir, 17650, 17660).unwrap();
        assert_eq!(path, endpoint_path(&dir));
        let e = read_endpoint(&dir).expect("刚写的文件要读得回来");
        assert_eq!(e.port, 17650);
        assert_eq!(e.https_port, 17660);
        assert_eq!(e.pid, std::process::id());

        // 陈旧/损坏内容一律当「没有端口文件」，不能拿它去敲一个不存在的端口。
        for raw in [
            "",
            "not json",
            "{}",
            "{\"port\":0,\"https_port\":0,\"pid\":0,\"started_at\":0}",
            // 1024 以下：特权端口，主程序不可能绑上去，出现即说明文件不可信。
            "{\"port\":80,\"https_port\":443,\"pid\":1,\"started_at\":1}",
        ] {
            assert!(parse_endpoint(raw).is_none(), "不该被采信：{}", raw);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_remove_endpoint_clears_it_and_is_quiet_when_already_gone() {
        let dir = temp_dir("remove");
        let path = write_endpoint(&dir, 17650, 17660).unwrap();
        remove_endpoint(&path);
        assert!(!path.exists());
        // 二次删除不许 panic 也不许报错——`stop()` 会被反复调。
        remove_endpoint(&path);
        assert!(read_endpoint(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🔴 守卫（规则 #11.1）：桥在 GUI 之外算目录，靠的是这个常量；
    /// 主程序写端口文件靠的是 `tauri.conf.json` 的 identifier。
    /// 两处漂了的表现是「桥一口咬定主程序没在跑」，而从两边代码都看不出问题。
    #[test]
    fn test_app_identifier_matches_tauri_conf() {
        let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let raw = std::fs::read_to_string(conf).expect("读不到 tauri.conf.json");
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            v["identifier"].as_str(),
            Some(APP_IDENTIFIER),
            "stdio 桥算出的应用目录与主程序不是同一个"
        );
    }

    #[test]
    fn test_app_dir_from_env_honours_override() {
        // 单测靠这条把端口文件写进临时目录；用户换数据目录时也是同一条路。
        let dir = temp_dir("override");
        std::env::set_var("PASTEPANDA_APP_DIR", &dir);
        assert_eq!(app_dir_from_env(), Some(dir.clone()));
        std::env::remove_var("PASTEPANDA_APP_DIR");
        // 没覆盖时也要给出一个像样的目录，而不是空着。
        let real = app_dir_from_env();
        assert!(real.is_some(), "拿不到应用目录");
        assert!(
            real.unwrap().to_string_lossy().ends_with(APP_IDENTIFIER),
            "目录末尾应是应用标识符"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 应答成形 ────────────────────────────────────────────────

    #[test]
    fn test_notifications_never_get_a_reply() {
        // 判据是「没有 id 成员」而不是 `id: null`。
        let notif = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        assert!(is_notification(&notif));
        assert!(response_line(&notif, 200, r#"{"ok":true}"#).is_none());
        assert!(error_line_for(&notif, "转发失败").is_none());

        // `id: null` 是**有** id（协议里合法的应答形态），不能被当成通知。
        let with_null_id = json!({"jsonrpc":"2.0","id":null,"method":"tools/list"});
        assert!(!is_notification(&with_null_id));
        assert!(response_line(
            &with_null_id,
            200,
            r#"{"jsonrpc":"2.0","id":null,"result":{}}"#
        )
        .is_some());
    }

    #[test]
    fn test_ok_body_passes_through_but_never_spans_two_lines() {
        let req = json!({"jsonrpc":"2.0","id":7,"method":"tools/list"});
        let out = response_line(
            &req,
            200,
            r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#,
        )
        .unwrap();
        assert!(!out.contains('\n') && !out.contains('\r'));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], json!(7));

        // 上游正文里带裸换行（Markdown 里太常见了）时，重序列化必须把它转义回去。
        let messy = r#"{"jsonrpc":"2.0","id":7,"result":{"text":"a\nb"}}"#;
        let out = response_line(&req, 200, messy).unwrap();
        assert!(!out.contains('\n'), "一行协议里出现了裸换行：{}", out);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["result"]["text"], "a\nb");
    }

    #[test]
    fn test_non_json_body_and_http_errors_become_rpc_errors() {
        let req = json!({"jsonrpc":"2.0","id":3,"method":"tools/call"});

        let out: Value =
            serde_json::from_str(&response_line(&req, 200, "<html>not json</html>").unwrap())
                .unwrap();
        assert_eq!(out["error"]["code"], json!(-32603));
        assert_eq!(out["id"], json!(3));

        // 401：只可能是令牌不一致，直接把「去哪儿修」写进 message。
        let out: Value =
            serde_json::from_str(&response_line(&req, 401, r#"{"error":"x"}"#).unwrap()).unwrap();
        let msg = out["error"]["message"].as_str().unwrap();
        assert!(msg.contains("令牌"), "401 要说清是令牌问题：{}", msg);
        assert!(msg.contains("设置"), "要给出修的地方：{}", msg);

        let out: Value =
            serde_json::from_str(&response_line(&req, 403, "拒绝：请求来自非本机页面").unwrap())
                .unwrap();
        assert!(out["error"]["message"]
            .as_str()
            .unwrap()
            .contains("非本机页面"));

        // 超长响应体不许整条塞进 message。
        let out: Value =
            serde_json::from_str(&response_line(&req, 500, &"y".repeat(5000)).unwrap()).unwrap();
        assert!(out["error"]["message"].as_str().unwrap().chars().count() < 400);
    }

    #[test]
    fn test_missing_endpoint_reports_main_app_not_running() {
        // 验收里那条「报错文案是『主程序未运行』而不是超时」。
        let dir = temp_dir("no_endpoint");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder().build().unwrap();
        let why = rt
            .block_on(forward(
                &client,
                &dir,
                "t",
                None,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            ))
            .unwrap_err();
        assert!(why.contains("没有在运行"), "文案要能让人明白原因：{}", why);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 整条回路（假服务端）──────────────────────────────────────

    /// 一个最小假 MCP 服务：`POST /mcp` 回固定 JSON，并把收到的请求头 + 请求体
    /// 一条条吐到 `hits` 里。
    ///
    /// 它存在的理由是**「桥到底发了什么」只能在服务端那一侧断言**：
    /// 🔴 尤其是不发 `Origin` 那条（本机 MCP 把 `Origin` 当浏览器的证据，
    /// 带上就是 403，而桥 403 的话用户在 Claude Desktop 里只看到一句错误），
    /// 以及令牌、UA、原样透传的请求体。这些光测纯函数测不出来。
    fn spawn_fake_hub(reply_body: &'static str) -> (u16, std::sync::mpsc::Receiver<String>) {
        spawn_fake_hub_status(200, reply_body)
    }

    /// 同上，但可以指定**状态码**——401 自愈那条测试要靠它。
    fn spawn_fake_hub_status(
        status: u16,
        reply_body: &'static str,
    ) -> (u16, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, hits) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                // 读到头结束（\r\n\r\n）为止；体按 content-length 再补齐。
                let mut raw: Vec<u8> = Vec::new();
                let mut b = [0u8; 1];
                while stream.read(&mut b).unwrap_or(0) == 1 {
                    raw.push(b[0]);
                    if raw.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&raw).to_lowercase();
                if !head.starts_with("post") {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 2\r\n\r\nok",
                    );
                    continue;
                }
                let len: usize = head
                    .split("content-length:")
                    .nth(1)
                    .and_then(|s| s.trim_start().split("\r\n").next())
                    .and_then(|s| s.trim().parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0u8; len];
                if len > 0 {
                    stream.read_exact(&mut body).ok();
                }
                // 头一律**小写**送出去：hyper 在 HTTP/1.1 上写的是小写头名，
                // 但这是实现细节，断言不该依赖它。
                let _ = tx.send(format!("{}\nBODY:{}", head, String::from_utf8_lossy(&body)));
                let out = format!(
                    "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{}",
                    status,
                    if status == 401 { "Unauthorized" } else { "OK" },
                    reply_body.len(),
                    reply_body
                );
                let _ = stream.write_all(out.as_bytes());
            }
        });
        (port, hits)
    }

    /// 桥的主回路：收一行 → 转一次 → 写一行，且**只写合法 JSON 行**。
    ///
    /// 三条输入是有讲究的一组：`initialize`（要被认成客户端身份）、
    /// 通知（**绝不能**产生任何一行输出，否则严格客户端会把它当成乱码断开）、
    /// `tools/list`（正常应答）。
    #[test]
    fn test_pump_forwards_body_token_ua_and_no_origin() {
        let dir = temp_dir("pump");
        let reply = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        let (port, hits) = spawn_fake_hub(reply);
        write_endpoint(&dir, port, 0).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // 假服务端每个应答都带 `connection: close`，这里再把连接池关掉，
        // 保证三条请求真的是三次连接、能被一条条数出来。
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientInfo":{"name":"Claude Desktop","version":"1.2"}}}"#.to_string()).unwrap();
        tx.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_string())
            .unwrap();
        tx.send(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string())
            .unwrap();
        drop(tx);

        let mut out: Vec<String> = Vec::new();
        rt.block_on(pump(&client, &dir, "tok-abc", &mut rx, &mut |line| {
            out.push(line);
            true
        }));

        // 🔴 通知没有应答 ⇒ 三条输入只该有两行输出。
        assert_eq!(out.len(), 2, "通知也回话了？输出：{:?}", out);
        for line in &out {
            assert!(
                !line.contains('\n') && !line.contains('\r'),
                "不是一行：{}",
                line
            );
            serde_json::from_str::<Value>(line).expect("stdout 上出现了非 JSON");
        }

        let took = |n: &str| {
            hits.recv_timeout(std::time::Duration::from_secs(5))
                .unwrap_or_else(|e| panic!("第 {} 条请求没到服务端：{}", n, e))
        };
        let init = took("1");
        let notif = took("2");
        let list = took("3");
        assert!(
            hits.try_recv().is_err(),
            "服务端多收到请求了：桥不该自己发明请求"
        );

        assert!(init.contains("post /mcp"), "转发目标不对：{}", init);
        assert!(
            init.contains("authorization: bearer tok-abc"),
            "没带上令牌：{}",
            init
        );
        // 🔴 三条都**不发 Origin**（本机 MCP 拿它当浏览器的证据，发了就是 403）。
        for (tag, req) in [
            ("initialize", &init),
            ("notification", &notif),
            ("tools/list", &list),
        ] {
            assert!(!req.contains("origin:"), "{} 带了 Origin：{}", tag, req);
        }
        // 同一条请求里就该带上刚学到的客户端名字（花名册与 `agent:` 来源标记靠它）。
        assert!(
            init.contains("user-agent: claude desktop/1.2 (pastepanda-stdio-bridge/"),
            "initialize 的 UA 没学到身份：{}",
            init
        );
        assert!(
            list.contains("user-agent: claude desktop/1.2"),
            "身份没延续到后续请求：{}",
            list
        );
        // 原样透传：桥不重排、不补字段、不翻译。
        assert!(
            list.contains(r#""method":"tools/list""#),
            "请求体被改过：{}",
            list
        );
        assert!(
            notif.contains(r#""method":"notifications/initialized""#),
            "通知也要照常转出去（只是不许回话）：{}",
            notif
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 主程序没在跑（端口文件被 `stop()` 删了）时，桥**立刻**回错误而不是吊着。
    ///
    /// 这正是验收里那条「关掉 PastePanda 后，工具表显示『主程序未运行』而不是超时」：
    /// stdio 客户端普遍没有超时，桥自己不含超时逻辑就等不到答案。
    #[test]
    fn test_pump_answers_immediately_when_service_is_gone() {
        let dir = temp_dir("pump_gone");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder().build().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(r#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#.to_string())
            .unwrap();
        drop(tx);

        let started = std::time::Instant::now();
        let mut out: Vec<String> = Vec::new();
        rt.block_on(pump(&client, &dir, "t", &mut rx, &mut |l| {
            out.push(l);
            true
        }));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "没有端口文件却耗了 {:?}：那是超时，不是拒绝",
            started.elapsed()
        );
        assert_eq!(out.len(), 1);
        let v: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v["id"], json!(5), "错误应答要认得回的是哪条请求");
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("没有在运行"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 整条回路的边界 ──────────────────────────────────────────

    /// 🔴 非对象请求（批量数组、标量）就地拒绝且**一条都不许转出去**。
    ///
    /// 转发出去的后果：上游按协议拒了，而拒答不带可对的 `id`，
    /// 回到桥里又被 [`is_notification`] 当成通知吞掉——发的人永远等不到回包。
    /// stdio 客户端普遍没有超时，于是整个客户端钉死在这一条上。
    #[test]
    fn test_pump_rejects_non_object_without_forwarding() {
        let dir = temp_dir("pump_nonobject");
        let (port, hits) = spawn_fake_hub(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        write_endpoint(&dir, port, 0).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        for raw in [
            // JSON-RPC 批量：合法 JSON，但不是对象。
            r#"[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]"#,
            r#"42"#,
            r#""tools/list""#,
            r#"null"#,
            // 后面跟一条正常请求：证明拒绝不会把回路一起带走。
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/list"}"#,
        ] {
            tx.send(raw.to_string()).unwrap();
        }
        drop(tx);

        let mut out: Vec<String> = Vec::new();
        rt.block_on(pump(&client, &dir, "t", &mut rx, &mut |line| {
            out.push(line);
            true
        }));

        assert_eq!(out.len(), 5, "五条输入该有五行输出：{:?}", out);
        for line in out.iter().take(4) {
            let v: Value = serde_json::from_str(line).unwrap();
            assert_eq!(v["error"]["code"], json!(-32600), "不是 invalid request：{}", line);
            assert_eq!(v["id"], Value::Null, "非对象没有 id 可对：{}", line);
        }
        let last: Value = serde_json::from_str(&out[4]).unwrap();
        // 桥是**原样透传**上游应答的（连 id 也照上游那个），所以这里不能拿请求的
        // id 去比；要验的是「正常请求没被就地拒掉」。
        assert!(last["error"].is_null(), "正常请求被当成非对象拒了：{}", out[4]);
        assert!(!out[4].contains("-32600"), "{}", out[4]);

        // 🔴 四条非对象一条都不该到服务端；只有最后那条正常的到。
        let only = hits
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("正常的请求没转出去");
        assert!(only.contains(r#""method":"tools/list""#), "{}", only);
        assert!(hits.try_recv().is_err(), "非对象被转给服务端了");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 读端（客户端）把管道关了 ⇒ 桥立刻收摊，而不是留着当僵尸进程。
    #[test]
    fn test_pump_stops_when_the_reader_is_gone() {
        let dir = temp_dir("pump_closed");
        let (port, hits) = spawn_fake_hub(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        write_endpoint(&dir, port, 0).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string())
            .unwrap();
        tx.send(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.to_string())
            .unwrap();
        drop(tx);

        // `false` = 调用方（真桥里就是 `writeln!(stdout)`）写不进去了。
        let mut out: Vec<String> = Vec::new();
        rt.block_on(pump(&client, &dir, "t", &mut rx, &mut |line| {
            out.push(line);
            false
        }));

        assert_eq!(out.len(), 1, "管道断了还继续写：{:?}", out);
        hits.recv_timeout(std::time::Duration::from_secs(5))
            .expect("第一条没转出去");
        assert!(
            hits.try_recv().is_err(),
            "读端都关了还在往服务端转发——那就是没人读的僵尸进程"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 主程序里重置过令牌 ⇒ 桥重读一次、只重发一次。
    ///
    /// 不自愈的话：stdio 宿主往往几小时都不重启子进程，桥会一路 401 到用户
    /// 手动重开宿主，而界面上「复制配置」早就把新令牌写进去了。
    #[test]
    #[cfg(windows)]
    fn test_pump_reloads_rotated_token_and_retries_once() {
        let dir = temp_dir("pump_401");
        let (port, hits) = spawn_fake_hub_status(401, r#"{"error":"unauthorized"}"#);
        write_endpoint(&dir, port, 0).unwrap();
        // 盘上换成新令牌，桥内存里还拿着旧的那条。
        let fresh = crate::mcp::token::regenerate(&dir).unwrap();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string())
            .unwrap();
        drop(tx);

        let mut out: Vec<String> = Vec::new();
        rt.block_on(pump(
            &client,
            &dir,
            "stale-token",
            &mut rx,
            &mut |line| {
                out.push(line);
                true
            },
        ));

        let first = hits
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("一条都没转发");
        assert!(
            first.contains("authorization: bearer stale-token"),
            "首发该用旧令牌：{}",
            first
        );
        let second = hits
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("401 之后没有重发，桥不会自愈");
        // 假服务端把整个请求头**转小写**再吐回来（见 `spawn_fake_hub_status`），
        // 而令牌是 base64url、里面有大写——比的时候得两边同口径。
        assert!(
            second.contains(&format!("authorization: bearer {}", fresh.to_lowercase())),
            "重发没带盘上的新令牌：{}",
            second
        );
        assert!(
            hits.try_recv().is_err(),
            "重发不止一次：写操作虽在鉴权门之后，循环也该有上限"
        );
        assert_eq!(out.len(), 1);
        let v: Value = serde_json::from_str(&out[0]).unwrap();
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("令牌"),
            "自愈仍失败时要说清是令牌：{}",
            out[0]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 令牌没变（或压根没有令牌文件）时**不许**重发：401 就真的是没权限。
    ///
    /// 这条钉住的是「只重发一次 + 只在确实变了时重发」那道闸的反面——
    /// 少了它，一条持续 401 的请求会被桥自己放大成两倍流量。
    #[test]
    fn test_pump_does_not_retry_when_token_unchanged() {
        let dir = temp_dir("pump_401_same");
        let (port, hits) = spawn_fake_hub_status(401, r#"{"error":"unauthorized"}"#);
        write_endpoint(&dir, port, 0).unwrap();
        // 故意不写令牌文件：`load` 回 `Ok(None)`，走的是「读不到就不重发」。

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string())
            .unwrap();
        drop(tx);

        let mut out: Vec<String> = Vec::new();
        rt.block_on(pump(&client, &dir, "t", &mut rx, &mut |line| {
            out.push(line);
            true
        }));

        hits.recv_timeout(std::time::Duration::from_secs(5))
            .expect("一条都没转发");
        assert!(hits.try_recv().is_err(), "令牌没变也重发了");
        assert_eq!(out.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 客户端身份 ──────────────────────────────────────────────

    #[test]
    fn test_client_name_is_learned_only_from_initialize() {
        let init = json!({
            "method": "initialize",
            "id": 1,
            "params": {"clientInfo": {"name": "Claude Desktop", "version": "1.2"}}
        });
        assert_eq!(
            learn_client_name(&init).as_deref(),
            Some("Claude Desktop/1.2")
        );
        // 名字在前：`source_agent_from_ua` 按第一个 `/` 切名字，
        // 反了的话花名册里只剩一个版本号。
        let ua = bridge_user_agent(learn_client_name(&init).as_deref());
        assert!(ua.starts_with("Claude Desktop/"), "{}", ua);
        assert!(ua.contains("PastePanda-stdio-bridge"));

        // 其它方法、缺 clientInfo、空名字都不许污染 UA。
        assert_eq!(
            learn_client_name(&json!({"method":"tools/list","id":2})),
            None
        );
        assert_eq!(
            learn_client_name(&json!({"method":"initialize","id":2,"params":{}})),
            None
        );
        assert_eq!(
            learn_client_name(
                &json!({"method":"initialize","id":2,"params":{"clientInfo":{"name":"  "}}})
            ),
            None
        );
        // 没有版本时**也要留 `/`**（见 `learn_client_name` 里那段）：
        // 少了它，`source_agent_from_ua` 会按桥自己的 `PastePanda-stdio-bridge/`
        // 去切名字，花名册里就冒出「Kilo (PastePanda-stdio-bridge」这种来源。
        let no_version = json!({"method":"initialize","id":2,"params":{"clientInfo":{"name":"Kilo"}}});
        assert_eq!(
            learn_client_name(&no_version).as_deref(),
            Some("Kilo/0")
        );
        assert_eq!(
            crate::mcp::source_agent_from_ua(&bridge_user_agent(
                learn_client_name(&no_version).as_deref()
            )),
            "agent:Kilo",
            "来源标记要落在客户端自己的名字上"
        );
        assert_eq!(bridge_user_agent(None), bridge_user_agent(Some("  ")));
    }

    /// 🔴 自报字段是自由文本，而 `HeaderValue` 装不下非 ASCII：
    /// reqwest 把坏值的错误**记在 builder 上**，之后每一条 `send()` 都失败。
    /// 所以中文名/emoji/控制字符都必须在这里被吃掉，代价只是丢掉名字，
    /// 而不是整条 stdio 通道。
    #[test]
    fn test_client_name_survives_unsendable_characters() {
        let cases: &[(&str, Option<&str>)] = &[
            // 全非 ASCII 的名字：宁可**不**学到身份，也不发一条会拖死通道的 UA。
            ("中文客户端", None),
            // emoji 被吃掉，真名字留住。
            ("🐼 Claude", Some("Claude/1")),
            // 控制字符逐个删掉（不换成空格），首尾再 trim。
            ("Cd \u{1} Tab", Some("Cd  Tab/1")),
            // HTTP 头的可见字符全都允许，空格除外没有需要特殊照顾的。
            (
                "Weird ~!@#$%^&*()_+-={}[]|\\:\"<>?,.;`",
                Some("Weird ~!@#$%^&*()_+-={}[]|\\:\"<>?,.;`/1"),
            ),
        ];
        for (raw, expect) in cases {
            let got = learn_client_name(
                &json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":raw,"version":"1"}}}),
            );
            assert_eq!(got.as_deref(), *expect, "名字 {:?} 洗错了", raw);
            if let Some(g) = got.as_deref() {
                // ① 发得出去：只剩可见 ASCII + 空格。
                assert!(
                    g.chars().all(|c| c.is_ascii_graphic() || c == ' '),
                    "UA 里还剩发不出的字符：{:?} → {:?}",
                    raw,
                    g
                );
                // ② 认得出来：一定带 `/`，`source_agent_from_ua` 才切得到名字。
                assert!(g.contains('/'), "{:?} 的结果没有 `/`：{}", raw, g);
            }
        }
        // 版本位同样要被洗掉，洗空了要退成 `0` 而不是把 `/` 一起丢掉。
        assert_eq!(
            learn_client_name(
                &json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"Ok","version":"版本 β"}}})
            )
            .as_deref(),
            Some("Ok/0")
        );
    }
}
