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
    /// 本机计算机名，给配对向导当设备名的默认值用。
    ///
    /// 🔴 取不到时返回**空串**，不要兜底成「未知设备」之类：
    /// 输入框里一旦有值用户就不会去改，最后对端设备列表里躺着一个
    /// 没有意义的名字。留空反而会逼他自己起一个。
    pub device_name: String,
}

/// 本机计算机名。失败返回空串，理由见 [`SyncIdentity::device_name`]。
fn local_device_name() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().trim().to_string())
        .unwrap_or_default()
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
        device_name: local_device_name(),
    })
}

/// 生成邀请码的结果。
///
/// ❗ `expires_at` 由**后端**算好一起返回，而不是让前端拿一个写死的 7 天去推：
/// 有效期是 [`invite::TTL_SECS`] 定的，前端硬编码一个 7 就成了第二处事实来源，
/// 改 TTL 时必然漏掉一处，界面上写的到期日和后端真正的判定就对不上了。
#[derive(serde::Serialize)]
pub struct InviteCreated {
    pub code: String,
    /// 过期时刻（epoch 毫秒）。
    pub expires_at: i64,
}

/// 生成邀请码。`name` 是本机设备名，纯展示用。
#[tauri::command]
pub fn kb_sync_invite_create(
    app: AppHandle,
    store: State<DataStore>,
    name: String,
) -> Result<InviteCreated, String> {
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    let now = chrono::Utc::now().timestamp_millis();
    // 地址留空：地址会漂，靠 kb_presence 组播现场发现（见 sync::presence）。
    // 邀请码里塞一个当时的 IP，第二天就是错的。
    let code = invite::encode(&me, name.trim(), Vec::new(), now)?;
    let expires_at = now + invite::TTL_SECS * 1000;

    // 🔴 生成邀请码 = 开一扇有时限的门。
    //   没这一步的话，对方粘完码拨过来会被本机当 `NotPaired` 拒掉，
    //   而本机从头到尾不会知道有人来过——那正是「配对上了却直接离线」与
    //   「邀请方看不到已配对记录」的根因。详见 `sync::join` 模块注释。
    //   开门失败不让整个生成失败，但也不静默（规则 #15.3）：
    //   码已经生出来了，报错会让用户以为白生一场；而没开成的后果
    //   只是退回到旧行为（对方连不上），得在日志里看得见。
    if let Err(e) = crate::sync::join::open_door(&store, expires_at) {
        log::warn!("[Sync] 邀请窗口没能保存（{}）——对方粘完码可能连不上本机", e);
    }

    Ok(InviteCreated { code, expires_at })
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
///
/// 🔴 **必须拦住「粘自己的邀请码」**（2026-09-05 实际碰到）。不拦的后果不是
/// 「白干一场」，而是造出一个**永远显示离线、又永远不会好的幽灵设备**：
/// 自己发的组播公告会回环回来，但 [`presence`] 把它判为 [`presence::Heard::Mine`]
/// 直接丢弃、不记地址，于是 `last_seen` 恒为 0、`live_peers()` 里永远没它。
/// 用户看到的就是「配对成功了但它就是不上线」，而任何重试都无法改变。
///
/// 顺带还会给自己起一条往自己拨的同步循环，一直跑、一直失败。
#[tauri::command]
pub async fn kb_sync_pair(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, SyncService>,
    code: String,
) -> Result<invite::Invite, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let inv = invite::decode(&code, now)?;

    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    if inv.node_id == me.node_id() {
        return Err("这是本机自己的邀请码，不能和自己配对。请把它粘到**另一台**设备上。".into());
    }

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
    /// 正拿着本机发出的邀请在敲门、等用户确认的对端（见 [`crate::sync::join`]）。
    ///
    /// ❗ 搭进这个命令而不另开一个：面板本来就在 5 秒轮询它，
    /// 另开一个就是两倍往返，而且两边的快照可能对不上。
    pub pending: Vec<crate::sync::join::JoinRequest>,
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
        pending: svc.pending_joins(chrono::Utc::now().timestamp_millis()),
    })
}

/// 放行一条敲门（用户已经核对过两边指纹）。
///
/// 🔴 这是**生成方**那一半的 `device_pair`。以前它不存在，
/// 所以配对是单边的：只有粘贴方记下了对方，而生成方把对方的每一次
/// 连接都拒掉。两件事必须一起做，少一件就还是连不上：
/// ① 写 `devices` 表（之后 `is_paired` 才为真，presence 与 serve 才不再拒）；
/// ② `add_peer` 起循环（否则要重启应用才同步，而用户正盯着界面看）。
#[tauri::command]
pub async fn kb_sync_join_approve(
    store: State<'_, DataStore>,
    svc: State<'_, SyncService>,
    node_id: String,
    name: String,
) -> Result<(), String> {
    // ❗ 只能放行**真的敲过门**的：不卡这一道的话，前端传任意一串 node_id
    //   就能把任何人写进设备表。
    if !svc.take_join(&node_id) {
        return Err("这条连接请求已经不在了（对方可能已放弃），请让它重新试一次".into());
    }
    let name = name.trim();
    let name = if name.is_empty() { "新设备" } else { name };
    store.device_pair(&node_id, name, "")?;
    svc.add_peer(&node_id).await?;
    // 配完了就把门关上，不再敞着（要再加一台就再生一次邀请码）。
    if let Err(e) = crate::sync::join::close_door(&store) {
        log::warn!("[Sync] 邀请窗口没能关上（{}）", e);
    }
    Ok(())
}

/// 拒绝一条敲门。本次进程内不再为它弹（防反复骚扰）。
#[tauri::command]
pub fn kb_sync_join_deny(svc: State<SyncService>, node_id: String) -> Result<(), String> {
    svc.deny_join(&node_id);
    Ok(())
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
