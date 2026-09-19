//! MCP 服务的命令层：开关、状态、令牌。
//!
//! 🔴 **令牌只在用户主动索取时才返回给前端**（`mcp_get_token`）。
//! 不把它塞进 `mcp_get_status`——那个命令会被设置页轮询，令牌也就跟着
//! 一遍遍地过到前端、进到开发者工具的网络面板里去。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::data_store::DataStore;
use crate::mcp::{self, McpServer, McpStatus};

/// 应用数据目录（令牌文件就在这里）。
pub(super) fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
}

/// 从配置读监听端口。
///
/// 拒绝 1024 以下：那些是特权/保留端口。非法值不报错而是回退到默认端口：
/// 这个值由前端输入校验把关，后端只负责不让一个脏配置把服务弄成永远启不了。
pub(super) fn configured_port(store: &DataStore) -> u16 {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(mcp::CFG_PORT).and_then(|v| v.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(mcp::DEFAULT_PORT)
}

/// HTTPS 开关。**缺省为关**——它要配套往系统信任库里装根证书，
/// 不能因为配置里没这个键就当成开。
pub(super) fn https_enabled(store: &DataStore) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(mcp::CFG_HTTPS_ENABLED).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

/// 局域网直连开关。**缺省为关**。
pub(super) fn lan_enabled(store: &DataStore) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(mcp::CFG_LAN_ENABLED).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn lan_start_opts(store: &DataStore) -> mcp::LanStartOpts {
    mcp::LanStartOpts {
        enabled: lan_enabled(store),
    }
}

/// HTTPS 端口。规则同 [`configured_port`]。
pub(super) fn configured_https_port(store: &DataStore) -> u16 {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(mcp::CFG_HTTPS_PORT).and_then(|v| v.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(mcp::DEFAULT_HTTPS_PORT)
}

/// 启服务时要不要带上 https。关着就是 `None`。
///
/// ❗ 证书是**按需**生成的：开关不打开，这台机器上就永远不会出现任何
///   证书文件。生成失败也不报错、只记日志并返回 `None`——
///   同理：https 是可选功能，不能因为它让主服务启不了。
///   真失败了界面会从 `status()` 的 `httpsRunning=false` 看到。
fn https_opts(app: &AppHandle, store: &DataStore) -> Option<mcp::HttpsOpts> {
    if !https_enabled(store) {
        return None;
    }
    let dir = app_dir(app).ok()?;
    match mcp::tls::ensure(&dir) {
        Ok(material) => Some(mcp::HttpsOpts {
            port: configured_https_port(store),
            material,
        }),
        Err(e) => {
            log::warn!("[MCP] 证书准备失败，HTTPS 本次不开：{}", e);
            None
        }
    }
}

/// 把端口写回 `config` 表。
fn persist_port(store: &DataStore, port: u16) -> Result<(), String> {
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存 MCP 端口".to_string());
    };
    obj.insert(
        mcp::CFG_PORT.to_string(),
        serde_json::Value::Number(port.into()),
    );
    store.save_config(&cfg)
}

/// 把开关写回 `config` 表。开关不是秘密，可以进那张明文 KV。
fn persist_enabled(store: &DataStore, enabled: bool) -> Result<(), String> {
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存 MCP 开关".to_string());
    };
    obj.insert(
        mcp::CFG_ENABLED.to_string(),
        serde_json::Value::Bool(enabled),
    );
    store.save_config(&cfg)
}

/// 七个写开关的当前状态（M5）。
#[tauri::command]
pub fn mcp_get_write_switches(store: State<DataStore>) -> Vec<mcp::gate::WriteSwitchRow> {
    let cfg = store.get_config().unwrap_or_default();
    mcp::gate::WriteSwitches::from_config(&cfg).rows()
}

/// 改一个写开关。**无需重启服务**：每个请求现读一次配置。
///
/// 改完下一个 `tools/call` 就拦得住；但已连的客户端手里的**工具表是缓存的**，
/// 要重连才看得到新表（本服务发不了 `listChanged` 通知，原因见 `mcp::gate`）。
/// 界面上得把这一句说清楚。
///
/// 不认识的 key 直接报错，不默默写一个没人读的配置项（规则 #15.3）。
#[tauri::command]
pub fn mcp_set_write_switch(
    store: State<DataStore>,
    key: String,
    enabled: bool,
) -> Result<Vec<mcp::gate::WriteSwitchRow>, String> {
    if mcp::gate::kind_of_key(&key).is_none() {
        return Err(format!("未知的写权限开关：{}", key));
    }
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存写权限开关".to_string());
    };
    obj.insert(key, serde_json::Value::Bool(enabled));
    store.save_config(&cfg)?;
    Ok(mcp::gate::WriteSwitches::from_config(&cfg).rows())
}

/// 可写入的范围（项目②）。
///
/// ⚠ 篇数的口径跟**侧栏一致**（`folder_unfiled_count` 排掉速记），
/// 而不是字面的「全库笔记数」—— 选择器要跟用户在侧栏看到的数对得上，
/// 两处不一样会让人以为算错了。
/// 得说清楚的是：**范围检查本身是覆盖速记的**（它们 `folder_id IS NULL`，
/// 归在未分类那一行下），只是不计入那个展示数字。
#[tauri::command]
pub fn mcp_get_write_scope(store: State<DataStore>) -> Result<mcp::gate::WriteScopeView, String> {
    let cfg = store.get_config().unwrap_or_default();
    let folders = store.folder_list()?;
    let unfiled = store.folder_unfiled_count()?;
    Ok(mcp::gate::WriteScope::from_config(&cfg).view(&folders, unfiled))
}

/// 存可写入范围。**无需重启服务**：每个请求现读一次配置。
///
/// `entries` 为 `None` = 回到「没配过」（全库可写），对应界面上的「恢复全库」。
///
/// 🔴 `Some(空数组)` 与 `None` **不是一回事**：前者是用户把每一行都
/// 取消了（一篇都不可写），后者是从未配过。归成一类的后果是：
/// 用户取消全部勾选 ⇒ 得到「授权全库」，与他刚做的动作正好相反。
#[tauri::command]
pub fn mcp_set_write_scope(
    store: State<DataStore>,
    entries: Option<Vec<String>>,
) -> Result<mcp::gate::WriteScopeView, String> {
    let scope = match entries {
        None => mcp::gate::WriteScope::unrestricted(),
        Some(v) => mcp::gate::WriteScope::only(v),
    };
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存可写入范围".to_string());
    };
    match scope.to_config_value() {
        Some(v) => {
            obj.insert(mcp::gate::CFG_WRITE_FOLDERS.to_string(), v);
        }
        // 「恢复全库」= 把键删掉，而不是写一个空数组（那是相反的意思）。
        None => {
            obj.remove(mcp::gate::CFG_WRITE_FOLDERS);
        }
    }
    store.save_config(&cfg)?;
    let folders = store.folder_list()?;
    let unfiled = store.folder_unfiled_count()?;
    Ok(scope.view(&folders, unfiled))
}

/// AI 经 MCP 建的文件夹（项目③）。设置页的「撤销」列表靠它。
#[tauri::command]
pub fn mcp_ai_folders(
    store: State<DataStore>,
) -> Result<Vec<crate::data_store::NoteFolder>, String> {
    store.folder_list_ai()
}

/// 撤销一个 AI 建的文件夹：删掉它，**里面的东西都升到父级**。
///
/// 返回（挑走的笔记数, 挑走的子夹数），给界面报结果用。
///
/// 🔴 **只能撤 `source = 'ai'` 的**。不限制的后果是它变成一个通用的
/// 「删文件夹」命令，而那条路上本来有自己的确认流程与影响预览
/// （`folder_delete_impact`）—— 绕过去就把那些护栏全丢了。
#[tauri::command]
pub fn mcp_undo_ai_folder(store: State<DataStore>, id: String) -> Result<(usize, usize), String> {
    let is_ai = store.folder_list_ai()?.iter().any(|f| f.id == id);
    if !is_ai {
        return Err("只能撤销由 AI 创建的文件夹".to_string());
    }
    store.folder_dissolve(&id)
}

/// 最近的调用记录（W3）。红线②的「可见」就靠它。
#[tauri::command]
pub fn mcp_audit_list(
    store: State<DataStore>,
    limit: u32,
) -> Result<Vec<crate::data_store::McpAuditRow>, String> {
    store.mcp_audit_list(limit)
}

/// 客户端花名册。从审计表聚合，不单存一份。
///
/// ❗ 它回答不了「当前连着几个」——MCP over HTTP 无状态，根本没有「连着」
/// 这回事。界面文案必须是「最近活动过的客户端」，不能写成连接数。
#[tauri::command]
pub fn mcp_audit_clients(
    store: State<DataStore>,
) -> Result<Vec<crate::data_store::McpClientRow>, String> {
    store.mcp_audit_clients()
}

/// 清空调用记录。红线②的「可删」就靠它，前端得把这个入口给出来。
#[tauri::command]
pub fn mcp_audit_clear(store: State<DataStore>) -> Result<usize, String> {
    store.mcp_audit_clear()
}

/// 当前状态（R7：界面上要有一条看得见的状态）。**不包含令牌**。
#[tauri::command]
pub fn mcp_get_status(store: State<DataStore>, server: State<McpServer>) -> McpStatus {
    server.status(configured_port(&store), configured_https_port(&store))
}

/// 改监听端口。服务在跑就当场换到新端口，停着就只存配置。
///
/// 下限 1024：以下是特权/保留端口。上限靠 `u16` 天然卡住。
///
/// 换端口不会撞上「旧监听未释放」的竞态——因为新端口与旧端口不同，
/// 不存在重绑同一个地址的问题（这也是重置令牌故意不走重启的原因）。
///
/// 🔴 **新端口启失败就不写配置**：此时服务已停，配置里仍是旧端口，
/// 状态仍然自洽（下次开机还是试旧端口）。写了才是把用户锁在一个启不了的端口上。
#[tauri::command]
pub fn mcp_set_port(
    app: AppHandle,
    store: State<DataStore>,
    server: State<McpServer>,
    port: u16,
) -> Result<McpStatus, String> {
    if port < 1024 {
        return Err(format!("端口 {} 不可用：1024 以下是特权/保留端口", port));
    }
    // 已经就是这个端口（配置与运行中都是）就什么都不做。
    // 停机时 `status(port).port` 就是传入值，所以这个条件在停机下退化成只比配置。
    let status = server.status(port, configured_https_port(&store));
    if port == configured_port(&store) && status.port == port {
        return Ok(status);
    }

    if server.is_running() {
        server.stop();
        let token = mcp::token::load_or_create(&app_dir(&app)?)?;
        let kb = std::sync::Arc::new(mcp::source::AppKbSource::new(app.clone()));
        server.start(
            app.clone(),
            kb,
            token,
            port,
            https_opts(&app, &store),
            lan_start_opts(&store),
        )?;
    }
    persist_port(&store, port)?;
    Ok(server.status(port, configured_https_port(&store)))
}

/// 取当前令牌（用户点「显示令牌」/「复制」时才调）。
///
/// 没有就生成一个：用户想看令牌时往往服务还没开过，
/// 回个「请先开启服务」只是把一步拆成两步。
#[tauri::command]
pub fn mcp_get_token(app: AppHandle) -> Result<String, String> {
    mcp::token::load_or_create(&app_dir(&app)?)
}

/// 重置令牌。旧令牌立即作废，**服务无需重启**。
///
/// 重启换令牌会撞上「优雅停机还没释放旧监听、新 bind 报端口占用」的竞态，
/// 所以 `McpServer` 与 handler 共享同一把令牌（见 `mcp::server::Ctx`）。
#[tauri::command]
pub fn mcp_regenerate_token(app: AppHandle, server: State<McpServer>) -> Result<String, String> {
    let token = mcp::token::regenerate(&app_dir(&app)?)?;
    server.set_token(token.clone())?;
    Ok(token)
}

/// 开/关 MCP 服务，并把开关持久化。
///
/// 🔴 **开与关两条路径的顺序是反的，且各自原子。**
///
/// - 开：先启动、成功了再写配置。反过来的话，端口被占导致启动失败时配置已经
///   写成 `enabled = true`，下次开机会无声无息地再试一次、再失败一次，
///   而用户看到的只是个永远「已开启」的开关。
///   但写配置也可能失败（磁盘满 / 备份写不下），那时必须**把已启动的服务停回去**：
///   否则命令返回 Err、界面显示失败，而一个监听端口真在后台跑着——
///   “以为没开其实开着”是本功能最不能出的一类状态。
/// - 关：先写配置、成功了再停。写失败就什么都不动，状态仍然自洽。
#[tauri::command]
pub fn mcp_set_enabled(
    app: AppHandle,
    store: State<DataStore>,
    server: State<McpServer>,
    enabled: bool,
) -> Result<McpStatus, String> {
    if enabled {
        let token = mcp::token::load_or_create(&app_dir(&app)?)?;
        let port = configured_port(&store);
        let kb = std::sync::Arc::new(mcp::source::AppKbSource::new(app.clone()));
        server.start(
            app.clone(),
            kb,
            token,
            port,
            https_opts(&app, &store),
            lan_start_opts(&store),
        )?;
        if let Err(e) = persist_enabled(&store, true) {
            server.stop();
            return Err(format!("服务已启动但配置保存失败，已回滚到关闭：{}", e));
        }
    } else {
        persist_enabled(&store, false)?;
        server.stop();
    }
    Ok(server.status(configured_port(&store), configured_https_port(&store)))
}

/// 把 HTTPS 开关写回 `config` 表。
fn persist_https_enabled(store: &DataStore, enabled: bool) -> Result<(), String> {
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存 HTTPS 开关".to_string());
    };
    obj.insert(
        mcp::CFG_HTTPS_ENABLED.to_string(),
        serde_json::Value::Bool(enabled),
    );
    store.save_config(&cfg)
}

/// 开/关 HTTPS 监听，并持久化。
///
/// 🔴 **打开 ≠ 客户端就能用了**：还得把 CA 装进系统信任库（另一个命令，
/// 会弹 Windows 的确认框）。这里只负责把监听起来。
///
/// ❗ **不重启整个服务**：那会撞上同一个 http 端口的「旧监听未释放」竞态
///   （参看 `mcp_set_port` 为什么只在端口真变了时才重启）。
///   https 那一路是单独启停的。
///
/// 先写配置再动服务：写失败就什么都不变，状态仍然自洽。
/// 而监听起不来不回滚配置——开关就是用户的意愿，下次开机还得接着试；
/// 失败原因会从 `httpsError` 带到界面上，不静默。
#[tauri::command]
pub fn mcp_set_https_enabled(
    app: AppHandle,
    store: State<DataStore>,
    server: State<McpServer>,
    enabled: bool,
) -> Result<McpStatus, String> {
    persist_https_enabled(&store, enabled)?;
    if enabled {
        if let Some(opts) = https_opts(&app, &store) {
            if let Err(e) = server.enable_https(opts) {
                log::warn!("[MCP] HTTPS 开启失败：{}", e);
            }
        }
    } else {
        server.disable_https();
    }
    Ok(server.status(configured_port(&store), configured_https_port(&store)))
}

/// 读用户手写的库简介（AM-6）。空串 = 没填 = 不推。
#[tauri::command]
pub fn mcp_get_library_blurb(store: State<DataStore>) -> String {
    let cfg = store.get_config().unwrap_or_default();
    mcp::blurb::from_config(&cfg)
}

/// 写库简介。**无需重启服务**：每次 `initialize` 现读一次配置。
///
/// 🔴 这一段是**推**给模型的：不经任何工具调用就到它手里，每次连接都付一遍，
/// 因此也**不进调用记录**。所以只接受用户手打的内容，界面上绝不能提供
/// 「一键采用自动生成的建议」——文件夹名本身就可能是敏感信息
/// （「离职计划」「体检报告」这种名字，名字本身就是信息）。
///
/// 超长按字符截断而不是报错：用户粘贴一大段时，
/// 报错让他自己数字数是把麻烦丢回去；截断 + 界面显示实时字数才是能用的做法。
#[tauri::command]
pub fn mcp_set_library_blurb(store: State<DataStore>, text: String) -> Result<String, String> {
    let normalized = mcp::blurb::normalize(&text);
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存库简介".to_string());
    };
    obj.insert(
        mcp::blurb::CFG_KEY.to_string(),
        serde_json::Value::String(normalized.clone()),
    );
    store.save_config(&cfg)?;
    Ok(normalized)
}

// ─── HTTPS / CA 信任库（TLS-1 / TLS-2）───

/// CA 状态：证书生成没生成、装进信任库没有。
///
/// 查询**不生成**证书——生成是打开 HTTPS 开关时的事（见 `https_opts`）。
/// 界面打开时轮询这个，CA 行才显示得对。
#[tauri::command]
pub fn mcp_tls_ca_status(app: AppHandle) -> Result<mcp::tls::CaStatus, String> {
    Ok(mcp::tls::ca_status(&app_dir(&app)?))
}

/// 把 CA 装进**当前用户**的信任根证书库。
///
/// 🔴 这是本软件对用户机器做过的最重的一件事，前端必须先弹确认框。
/// `certutil` 自己也会再弹一次系统确认——两道都别省。
#[tauri::command]
pub fn mcp_tls_install_ca(app: AppHandle) -> Result<mcp::tls::CaStatus, String> {
    let dir = app_dir(&app)?;
    // 确保证书存在。用户可能先点了「装」而从未开过 HTTPS。
    if !mcp::tls::exists(&dir) {
        mcp::tls::ensure(&dir)?;
    }
    mcp::tls::install_ca(&dir)
}

/// 从**当前用户**的信任根证书库移除我们的 CA。
///
/// 幂等：本来就没装就直接返回当前状态，不报错。
/// 移除**不会**删本地的证书文件——下次开 HTTPS 还能直接用。
#[tauri::command]
pub fn mcp_tls_remove_ca(app: AppHandle) -> Result<mcp::tls::CaStatus, String> {
    mcp::tls::remove_ca(&app_dir(&app)?)
}

// ─── 局域网直连 ───

fn persist_lan_enabled(store: &DataStore, enabled: bool) -> Result<(), String> {
    let mut cfg = store.get_config().unwrap_or_default();
    let Some(obj) = cfg.as_object_mut() else {
        return Err("配置格式异常，无法保存局域网设置".to_string());
    };
    obj.insert(
        mcp::CFG_LAN_ENABLED.to_string(),
        serde_json::Value::Bool(enabled),
    );
    store.save_config(&cfg)
}

/// 开/关局域网直连。服务在跑则重启监听（127.0.0.1 ↔ 0.0.0.0 同端口，必须 rebind）。
///
/// 🔴 **不做 IP 白名单**：开着时凭 Bearer 令牌即可连入。
#[tauri::command]
pub fn mcp_set_lan_enabled(
    app: AppHandle,
    store: State<DataStore>,
    server: State<McpServer>,
    enabled: bool,
) -> Result<McpStatus, String> {
    persist_lan_enabled(&store, enabled)?;

    if server.is_running() {
        server.stop();
        let token = mcp::token::load_or_create(&app_dir(&app)?)?;
        let port = configured_port(&store);
        let kb = std::sync::Arc::new(mcp::source::AppKbSource::new(app.clone()));
        server.start(
            app.clone(),
            kb,
            token,
            port,
            https_opts(&app, &store),
            lan_start_opts(&store),
        )?;
    }
    Ok(server.status(configured_port(&store), configured_https_port(&store)))
}
