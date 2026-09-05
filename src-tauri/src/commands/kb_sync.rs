//! 知识库同步的命令层（M6）。
//!
//! # 这一层为什么这么薄
//!
//! `sync/` 里已经把决策与状态都收好了（[`crate::sync::service::SyncService`]），
//! 这里只做三件事：取应用数据目录、读写那个开关、把错误翻成人话。
//!
//! # 🔴 `sync/` 不认识 tauri，这是有意的
//!
//! 库句柄用 `store.clone()` 交进去（`DataStore` 是 Arc 句柄）。
//! **不要**改成把 `AppHandle` 传进 `sync/` 再 `try_state`——
//! 那会让 tauri 运行时变成单测可达代码，`getrandom 0.3` 的 Windows 后端跟着可达，
//! lib test 二进制**启动即挂**（0xc0000139，一条测试都跑不了）。
//! 这个坑今天踩过一次，`Cargo.toml` 的 `[dev-dependencies]` 里也记着同根因。
//!
//! # 指纹为什么单独一个命令
//!
//! 开关关着时界面也要显示本机指纹（用户得先把它给对方看），
//! 所以 [`kb_sync_identity`] **不经过** `SyncService`，直接读身份文件。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::data_store::DataStore;
use crate::sync::identity::NodeIdentity;
use crate::sync::presence::ENABLE_KEY;
use crate::sync::service::SyncService;
use crate::sync::{invite, presence};

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
}

fn enabled(store: &DataStore) -> bool {
    store
        .get_config()
        .ok()
        .and_then(|c| c.get(ENABLE_KEY).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

/// 本机身份。`fingerprint` 是给人肉眼核对的那 16 个字符。
#[derive(serde::Serialize)]
pub struct SyncIdentity {
    pub node_id: String,
    pub fingerprint: String,
    pub running: bool,
}

#[tauri::command]
pub async fn kb_sync_identity(
    app: AppHandle,
    svc: State<'_, SyncService>,
) -> Result<SyncIdentity, String> {
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    Ok(SyncIdentity {
        node_id: me.node_id(),
        fingerprint: me.fingerprint(),
        running: svc.is_running().await,
    })
}

/// 生成邀请码。`name` 是本机设备名，纯展示用。
#[tauri::command]
pub fn kb_sync_invite_create(app: AppHandle, name: String) -> Result<String, String> {
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    let now = chrono::Utc::now().timestamp_millis();
    // 地址留空：地址会漂，靠 kb_presence 组播现场发现（见 sync::presence）。
    // 邀请码里塞一个当时的 IP，第二天就是错的。
    invite::encode(&me, name.trim(), Vec::new(), now)
}

/// 只解码、不配对。给「核对指纹」那一步用。
#[tauri::command]
pub fn kb_sync_invite_preview(code: String) -> Result<invite::Invite, String> {
    let now = chrono::Utc::now().timestamp_millis();
    invite::decode(&code, now)
}

/// 配对。
///
/// 🔴 配对成功后**必须**立刻给这台设备起一条同步循环，否则要重启应用才生效——
/// 而用户配完正盯着界面看，什么都不动就等于坏的。
#[tauri::command]
pub async fn kb_sync_pair(
    store: State<'_, DataStore>,
    svc: State<'_, SyncService>,
    code: String,
) -> Result<invite::Invite, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let inv = invite::decode(&code, now)?;
    store.device_pair(&inv.node_id, &inv.name, "")?;
    svc.add_peer(&inv.node_id).await?;
    Ok(inv)
}

/// 已配对设备 + 在线情况 + 最近一次的结果。
///
/// ❗ 三个东西合成一个命令返回：面板本来就在 5 秒轮询，
/// 拆成三个命令就是三倍往返，而且三者的快照可能对不上。
#[derive(serde::Serialize)]
pub struct SyncDevices {
    pub devices: Vec<crate::data_store::device::Device>,
    /// 当前组播里听得见的 `node_id`。
    pub live: Vec<String>,
    /// 每个对端最近一次会话的结果。
    pub last: Vec<crate::sync::service::LastSync>,
    /// 库里**还没处理完**的冲突副本总数。
    /// 与 `last[].conflicts`（刚刚产生了几处）是两个数，界面上别混。
    pub conflict_backlog: i64,
}

#[tauri::command]
pub async fn kb_sync_devices(
    store: State<'_, DataStore>,
    svc: State<'_, SyncService>,
) -> Result<SyncDevices, String> {
    Ok(SyncDevices {
        devices: store.device_list()?,
        live: svc.live_peers().await,
        last: svc.last_syncs().await,
        conflict_backlog: store.note_conflict_count()?,
    })
}

/// 忘记此设备。
///
/// ❗ 要同时做三件事，少一件就留脏东西：删记录、停循环、清地址。
/// 地址不清的话，表里会留一条**永不刷新也永不被覆盖**的僵尸地址
/// （`is_paired` 已经在拒它的新公告了）。
#[tauri::command]
pub async fn kb_sync_forget(
    store: State<'_, DataStore>,
    svc: State<'_, SyncService>,
    node_id: String,
) -> Result<bool, String> {
    let removed = store.device_forget(&node_id)?;
    svc.drop_peer(&node_id).await;
    Ok(removed)
}

/// 立刻跟某台同步一次。
#[tauri::command]
pub async fn kb_sync_now(svc: State<'_, SyncService>, node_id: String) -> Result<(), String> {
    svc.sync_now(&node_id).await
}

/// 开关当前状态。
#[tauri::command]
pub fn get_kb_sync_status(store: State<DataStore>) -> Result<bool, String> {
    Ok(enabled(&store))
}

/// 拨开关。
#[tauri::command]
pub async fn toggle_kb_sync(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, SyncService>,
    enable: bool,
) -> Result<(), String> {
    let mut config = store.get_config()?;
    // ❗ 不能 `if let Some(..) { .. }` 了事：配置不是对象时会静默跳过写入，
    //   而 `save_config` 照样返回 Ok，前端以为开关已保存（规则 #15.3）。
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象，开关没能保存")?;
    obj.insert(ENABLE_KEY.to_string(), serde_json::Value::Bool(enable));
    store.save_config(&config)?;

    if enable {
        // relay=true：跨网是硬需求，用 n0 公共 relay（见 M6 设计稿的传输层拍板）
        svc.start((*store).clone(), &app_dir(&app)?, true, true)
            .await?;
    } else {
        svc.stop().await;
    }
    Ok(())
}

/// 启动时按开关起同步。给 `lib.rs` 的 setup 用，不是命令。
pub fn boot(app: &AppHandle) {
    let Some(store) = app.try_state::<DataStore>() else {
        return;
    };
    if !enabled(&store) {
        log::info!(
            "[Sync] 知识库同步开关（{}）是关的，启动时不起同步",
            presence::ENABLE_KEY
        );
        return;
    }
    let store = (*store).clone();
    let Ok(dir) = app_dir(app) else {
        log::warn!("[Sync] 拿不到应用数据目录，同步没起来");
        return;
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // ❗ 这里要重新取 State：`SyncService` 是 setup 里 manage 的，
        //   而 boot 可能在它之后才跑到。
        let Some(svc) = app2.try_state::<SyncService>() else {
            log::warn!("[Sync] SyncService 还没就绪，同步没起来");
            return;
        };
        if let Err(e) = svc.start(store, &dir, true, true).await {
            log::warn!("[Sync] 启动同步失败：{}", e);
        }
    });
}
