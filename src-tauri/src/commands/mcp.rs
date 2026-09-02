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
fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
}

/// 从配置读监听端口。
///
/// 拒绝 1024 以下：那些是特权/保留端口。非法值不报错而是回退到默认端口：
/// 这个值由前端输入校验把关，后端只负责不让一个脏配置把服务弄成永远启不了。
fn configured_port(store: &DataStore) -> u16 {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(mcp::CFG_PORT).and_then(|v| v.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(mcp::DEFAULT_PORT)
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
    server.status(configured_port(&store))
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
    let status = server.status(port);
    if port == configured_port(&store) && status.port == port {
        return Ok(status);
    }

    if server.is_running() {
        server.stop();
        let token = mcp::token::load_or_create(&app_dir(&app)?)?;
        let kb = std::sync::Arc::new(mcp::source::AppKbSource::new(app.clone()));
        server.start(app.clone(), kb, token, port)?;
    }
    persist_port(&store, port)?;
    Ok(server.status(port))
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
        server.start(app.clone(), kb, token, port)?;
        if let Err(e) = persist_enabled(&store, true) {
            server.stop();
            return Err(format!("服务已启动但配置保存失败，已回滚到关闭：{}", e));
        }
    } else {
        persist_enabled(&store, false)?;
        server.stop();
    }
    Ok(server.status(configured_port(&store)))
}
