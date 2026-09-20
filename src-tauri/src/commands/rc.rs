//! 远程电脑命令层（方案 A）。
//!
//! 配对与同步**完全分开**：邀请码格式共用，信任表是 `rc_devices`。
//! 通道在 `rc_enabled` 时由 `RcService::start` 自建，不依赖知识库同步。

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::data_store::DataStore;
use crate::rc::join;
// 本机设备名的唯一来源在 rc 域：局域网配对要把名字随握手包自报给对方
// （`rc/pin.rs` + `rc/discovery.rs`），命令层只是也用它显示。见 `rc/mod.rs`。
use crate::rc::local_device_name;
use crate::rc::protocol::Capability;
use crate::rc::service::{RcService, RcStatus};
use crate::rc::uno;
use crate::rc::video::FrameCodec;
use crate::rc::session::{
    is_rc_online_for, rc_presence_level, Session, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED,
};
use crate::sync::identity::NodeIdentity;
use crate::sync::invite::{self, Invite};

fn app_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
}

/// 备注名长度上限，**按字符数**计（不是字节、也不是 UTF-16 单元）。
///
/// 🔴 这里曾经用 `note.len()`（字节数）：60 字节只够 20 个汉字，而前端
///    `maxLength` / `slice` 数的是 UTF-16 单元 —— 于是 21~60 个汉字的备注
///    在前端**看着完全合法**、存下去必然被后端拒掉。两边口径分开还会继续漂，
///    所以前端 `lib/rcDevice.ts` 有一份同值常量与同一个截断函数。
pub const NOTE_MAX_CHARS: usize = 60;

/// 备注名归一化：trim + 按**字符**截断到上限。前后端同一口径的唯一实现处。
/// 空串是合法值（= 清除备注，显示回落对端自报名）。
pub fn normalize_note(raw: &str) -> String {
    raw.trim().chars().take(NOTE_MAX_CHARS).collect()
}

fn emit_changed(app: &AppHandle, svc: &RcService) {
    let _ = app.emit("rc-session-changed", svc.status());
}

#[derive(Debug, Clone, Serialize)]
pub struct RcTargetDevice {
    pub node_id: String,
    pub name: String,
    pub conn_state: String,
    pub last_seen: i64,
    pub denied: bool,
    /// `rc` = 远程配对；`sync` = 仅同步配对（方案 A：可直接发起远程）。
    pub source: String,
    /// 可达性档位：`live` / `recent` / `seen` / `never`（设计稿）。
    pub presence: String,
    /// 上一次会话**实测**走的路径（`lan` / `direct` / `relay`；空串 = 还没连过）。
    /// 只有远程配对（`source == "rc"`）有实测值；仅同步配对的设备恒为空串。
    pub last_path: String,
    /// 用户起的本地备注名（A1）。空串 = 没起过，前端回落显示 `name`。
    /// 仅同步配对的设备没有备注入口——它的行还没进 rc 表。
    pub note: String,
    /// 方案 D「免确认直连」：这台设备发起远程时跳过人工同意。默认 false。
    pub trusted: bool,
}

#[derive(Serialize)]
pub struct RcInviteCreated {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Serialize)]
pub struct RcIdentity {
    pub node_id: String,
    pub fingerprint: String,
    pub device_name: String,
    pub running: bool,
}

#[tauri::command]
pub fn rc_status(svc: State<'_, Arc<RcService>>) -> Result<RcStatus, String> {
    Ok(svc.status())
}

#[tauri::command]
pub async fn rc_identity(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
) -> Result<RcIdentity, String> {
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    Ok(RcIdentity {
        node_id: me.node_id(),
        fingerprint: me.fingerprint(),
        device_name: local_device_name(),
        running: svc.is_running(),
    })
}

/// 远程可发起目标 = rc_devices ∪ 同步 devices（方案 A 单向继承）。
/// `presence` 四档：live / recent / seen / never（见 `rc_presence_level`）。
#[tauri::command]
pub fn rc_targets(
    store: State<DataStore>,
    svc: State<'_, Arc<RcService>>,
) -> Result<Vec<RcTargetDevice>, String> {
    let deny = svc.device_deny();
    let live: std::collections::HashSet<String> = svc.presence_live_ids().into_iter().collect();
    let session_peer = svc.active_session_peer();
    let now = chrono::Utc::now().timestamp_millis();
    let mut out: Vec<RcTargetDevice> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for d in store.rc_device_list()? {
        seen.insert(d.node_id.clone());
        let level = rc_presence_level(&d.node_id, d.last_seen, &live, session_peer.as_deref(), now);
        let online = is_rc_online_for(
            &d.node_id,
            &d.conn_state,
            d.last_seen,
            &live,
            session_peer.as_deref(),
            now,
        );
        out.push(RcTargetDevice {
            denied: deny.get(&d.node_id).copied().unwrap_or(false),
            node_id: d.node_id,
            name: d.name,
            conn_state: if online {
                "online".into()
            } else {
                "offline".into()
            },
            last_seen: d.last_seen,
            source: "rc".into(),
            presence: level.as_str().into(),
            last_path: d.last_path,
            note: d.note,
            trusted: d.trusted,
        });
    }
    for d in store.device_list()? {
        if seen.contains(&d.node_id) {
            continue;
        }
        seen.insert(d.node_id.clone());
        let level = rc_presence_level(&d.node_id, d.last_seen, &live, session_peer.as_deref(), now);
        let online = is_rc_online_for(
            &d.node_id,
            &d.conn_state,
            d.last_seen,
            &live,
            session_peer.as_deref(),
            now,
        );
        out.push(RcTargetDevice {
            denied: deny.get(&d.node_id).copied().unwrap_or(false),
            node_id: d.node_id,
            name: d.name,
            conn_state: if online {
                "online".into()
            } else {
                "offline".into()
            },
            last_seen: d.last_seen,
            source: "sync".into(),
            presence: level.as_str().into(),
            // 同步设备表（`devices`）没有路径列——它只做笔记同步，从没跑过 rc 会话。
            // 空串 = 前端不显示这一格（而不是编一个「绕中继」出来）。
            last_path: String::new(),
            // 仅同步配对还没提升进 rc 表，没有备注入口。
            note: String::new(),
            // 仅同步配对还没提升进 rc 表，无从谈「免确认」——恒 false。
            trusted: false,
        });
    }
    // C1：最近用过的在前。live 的 last_seen 本来就最新，纯 last_seen 排序
    // 自然把「正在会话/刚见过」的浮到顶；纯同步设备 last_seen=0 沉底（从未连过）。
    out.sort_by_key(|d| std::cmp::Reverse(d.last_seen));
    Ok(out)
}

/// 按需探活：对名单里的节点短超时拨一次，通了刷 last_seen。
/// 返回 node_id → 是否可达。打开设备列表 / 用户点刷新时调用。
#[tauri::command]
pub async fn rc_probe_targets(
    svc: State<'_, Arc<RcService>>,
    node_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, bool>, String> {
    if node_ids.is_empty() {
        return Ok(Default::default());
    }
    Ok(svc.probe_peers(&node_ids).await)
}

/// 已远程配对、尚未允许同步笔记的设备（方案 A 反向门）。
#[derive(Debug, Clone, Serialize)]
pub struct RcSyncOffer {
    pub node_id: String,
    pub name: String,
    pub paired_at: String,
}

pub const CFG_SYNC_OFFER_DENIED: &str = "rc_sync_offer_denied";

#[tauri::command]
pub fn rc_sync_offers(store: State<DataStore>) -> Result<Vec<RcSyncOffer>, String> {
    let denied: Vec<String> = store
        .get_config()
        .ok()
        .and_then(|c| {
            c.get(CFG_SYNC_OFFER_DENIED)
                .and_then(|v| serde_json::from_value(v.clone()).ok())
        })
        .unwrap_or_default();
    let sync_ids: std::collections::HashSet<String> = store
        .device_list()?
        .into_iter()
        .map(|d| d.node_id)
        .collect();
    Ok(store
        .rc_device_list()?
        .into_iter()
        .filter(|d| !sync_ids.contains(&d.node_id) && !denied.contains(&d.node_id))
        .map(|d| RcSyncOffer {
            node_id: d.node_id,
            name: d.name,
            paired_at: d.paired_at,
        })
        .collect())
}

/// 用户同意：远程配对设备允许同步笔记。
#[tauri::command]
pub async fn kb_sync_allow_from_rc(
    app: AppHandle,
    store: State<'_, DataStore>,
    sync: State<'_, crate::sync::service::SyncService>,
    node_id: String,
    name: String,
) -> Result<(), String> {
    let n = if name.trim().is_empty() {
        "新设备".to_string()
    } else {
        name.trim().to_string()
    };
    store.device_pair(&node_id, &n, "")?;
    if sync.is_running().await {
        if let Err(e) = sync.add_peer(&node_id).await {
            log::warn!("[Sync] 从远程配对接入后起同步循环失败：{e}");
        }
    }
    let _ = app.emit("kb-sync-devices-changed", ());
    Ok(())
}

/// 用户拒绝：不再为这台提示「允许同步」。
#[tauri::command]
pub fn kb_sync_deny_from_rc(store: State<DataStore>, node_id: String) -> Result<(), String> {
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    let mut list: Vec<String> = obj
        .get(CFG_SYNC_OFFER_DENIED)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if !list.contains(&node_id) {
        list.push(node_id);
    }
    obj.insert(
        CFG_SYNC_OFFER_DENIED.to_string(),
        serde_json::to_value(list).map_err(|e| e.to_string())?,
    );
    store.save_config(&config)
}

/// RC 邀请门开放时长（毫秒）。
///
/// 🔴 **由 [`invite::RC_TTL_SECS`] 派生，不另写一个数**：码的有效期与门的时长
/// 必须是**同一个口径**——否则用户永远撞在门上，却拿到一句 `not_paired`
/// （「尚未远程配对」），指不到「回去重新生成一个」这个唯一正确的动作。
/// 两个各自独立的字面量就是把口径交给未来去漂（2026-09-17 修的正是这个）。
///
/// 同宽这条由本文件末尾的 `mod tests` 钉住（`commands::rc` 是私有模块，
/// 别的测试文件够不到这个常量）。
const RC_INVITE_DOOR_MS: i64 = invite::RC_TTL_SECS * 1000;

/// 生成远程配对邀请码（开门，等对方粘贴后敲门）。
#[tauri::command]
pub async fn rc_invite_create(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    name: String,
) -> Result<RcInviteCreated, String> {
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    let now = chrono::Utc::now().timestamp_millis();
    let code = invite::encode(&me, name.trim())?;
    // 门与码同宽（两者都由 `invite::RC_TTL_SECS` 定）：码在窗口内才有效，
    // 门在窗口内才受理。配对成功后门会被提前关掉（见 `RcService::approve_join`）。
    let expires_at = now + RC_INVITE_DOOR_MS;
    if let Err(e) = join::open_door(&store, expires_at) {
        log::warn!("[RC] 邀请窗口没能保存（{}）——对方粘完码可能连不上本机", e);
    }
    // 开门同时拉起通道：否则对端敲门时本机 accept 循环没在跑
    if let Err(e) = svc.start(&app_dir(&app)?, true).await {
        log::warn!("[RC] 生成邀请后启动通道失败：{}", e);
    }
    emit_changed(&app, &svc);
    Ok(RcInviteCreated { code, expires_at })
}

#[tauri::command]
pub fn rc_invite_preview(code: String) -> Result<Invite, String> {
    let now = chrono::Utc::now().timestamp_millis();
    invite::decode(&code, now, invite::RC_TTL_SECS)
}

/// 粘贴对方邀请码 → 写入 rc_devices（远程配对，不写同步 devices）。
#[tauri::command]
pub async fn rc_pair(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    code: String,
) -> Result<Invite, String> {
    let now = chrono::Utc::now().timestamp_millis();
    // 与 `rc_invite_create` 同一个窗口：粘贴时先在这里被拦下，
    // 比「连上了再被门拒」早一步，也早一步把话说清楚。
    let inv = invite::decode(&code, now, invite::RC_TTL_SECS)?;
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    if inv.node_id == me.node_id() {
        return Err("这是本机自己的邀请码，不能和自己配对。请把它粘到**另一台**设备上。".into());
    }
    let name = if inv.name.trim().is_empty() {
        "新设备".to_string()
    } else {
        inv.name.trim().to_string()
    };
    store.rc_device_pair(&inv.node_id, &name)?;
    // 配对成功即拉起通道（发起不必等打开「允许被远程」）
    if let Err(e) = svc.start(&app_dir(&app)?, true).await {
        log::warn!("[RC] 配对后启动通道失败：{}", e);
    }
    emit_changed(&app, &svc);
    Ok(inv)
}

/// A1：设置设备的本地备注名。空串 = 清除（回落显示对端自报名）。
/// 纯本地展示属性，不发信令、不动配对状态。
///
/// 超长**不报错而是按字符截断**（`normalize_note`）：前端输入框已经在同一口径上
/// 截断，后端再拒一次只会让「看着合法却存不下去」的怪状态回来。
#[tauri::command]
pub async fn rc_device_rename(
    store: State<'_, DataStore>,
    node_id: String,
    note: String,
) -> Result<(), String> {
    store.rc_device_note_set(&node_id, &normalize_note(&note))
}

#[tauri::command]
pub async fn rc_forget(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
) -> Result<(), String> {
    store.rc_device_forget(&node_id)?;
    // 忘掉最后一台且未开被控 → 收通道
    if !svc.needs_channel() {
        svc.stop().await;
    }
    emit_changed(&app, &svc);
    Ok(())
}

/// 生成方：放行敲门（已核对指纹）。
#[tauri::command]
pub async fn rc_join_approve(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
    name: String,
) -> Result<(), String> {
    svc.approve_join(&node_id, &name)?;
    // 生成方放行后也要能收会话；通道若未起则拉起
    if let Err(e) = svc.start(&app_dir(&app)?, true).await {
        log::warn!("[RC] 放行配对后启动通道失败：{}", e);
    }
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub async fn rc_join_deny(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
) -> Result<(), String> {
    svc.deny_join(&node_id);
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub async fn rc_set_enabled(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    enable: bool,
) -> Result<(), String> {
    let mut config = store.get_config()?;
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象，开关没能保存")?;
    obj.insert(CFG_ENABLED.to_string(), serde_json::Value::Bool(enable));
    store.save_config(&config)?;

    if enable {
        // relay=true：R3 异地路径（与同步同一 n0 relay）；LAN 仍优先直连
        svc.start(&app_dir(&app)?, true).await?;
    } else {
        // 关「允许被远程」≠ 关通道：若还有远程配对（还要发起），通道留着；
        // 入站已由 gate_inbound 按 rc_enabled 拒掉。
        if !svc.needs_channel() {
            svc.stop().await;
        }
    }
    emit_changed(&app, &svc);
    Ok(())
}

/// 工具箱「开启远程通道」：不要求 `rc_enabled`（方案 A）。
#[tauri::command]
pub async fn rc_start_channel(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
) -> Result<(), String> {
    svc.start(&app_dir(&app)?, true).await?;
    emit_changed(&app, &svc);
    Ok(())
}

/// 启动时按「需要通道」拉起。给 lib.rs boot 用。
/// ❗ 不能叫 `boot`：`kb_sync::boot` 已占用该名，两个 `pub use *` 会撞。
pub fn rc_boot(app: &AppHandle) {
    let Some(store) = app.try_state::<DataStore>() else {
        return;
    };
    let enabled = crate::rc::cfg_enabled(&store);
    let has_rc_devices = matches!(store.rc_device_list(), Ok(list) if !list.is_empty());
    // 方案 A：仅同步配对的设备也可直接发起远程（同一 iroh 身份/端点），
    // 漏了它用户看得见设备（source="sync"）却发不起（B9）。
    let has_sync = matches!(store.device_list(), Ok(list) if !list.is_empty());
    if !enabled && !has_rc_devices && !has_sync {
        log::info!("[RC] 未开被控、无远程配对、无同步配对，启动时不起远程通道");
        return;
    }
    let Ok(dir) = app_dir(app) else {
        log::warn!("[RC] 拿不到应用数据目录，远程通道没起来");
        return;
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(svc) = app2.try_state::<Arc<RcService>>() else {
            log::warn!("[RC] RcService 还没就绪");
            return;
        };
        if let Err(e) = svc.start(&dir, true).await {
            log::warn!("[RC] 启动远程通道失败：{}", e);
        }
    });
}

#[tauri::command]
pub async fn rc_set_capability(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    capability: String,
) -> Result<(), String> {
    let cap = Capability::parse(&capability).ok_or("能力档只能是 view 或 control")?;
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        CFG_CAPABILITY.to_string(),
        serde_json::Value::String(cap.as_str().to_string()),
    );
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub async fn rc_set_device_allowed(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
    allowed: bool,
) -> Result<(), String> {
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    let mut deny: serde_json::Map<String, serde_json::Value> = obj
        .get(CFG_DEVICE_DENY)
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if allowed {
        deny.remove(&node_id);
    } else {
        deny.insert(node_id, serde_json::Value::Bool(true));
    }
    obj.insert(CFG_DEVICE_DENY.to_string(), serde_json::Value::Object(deny));
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub async fn rc_request_session(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
    capability: String,
    // 无人值守接入码（Q2 方案 B）。None = 常规发起（必须已配对）。
    uno_code: Option<String>,
    // 固定接入密码（Q2 方案 C）。与 uno_code 互斥携带；被控端只认其一。
    uno_pass: Option<String>,
) -> Result<Session, String> {
    let cap = Capability::parse(&capability).ok_or("能力档只能是 view 或 control")?;
    if !svc.is_running() {
        return Err(
            "远程通道未启动：请在工具箱「远程电脑」里点「开启远程通道」，或先完成远程配对".into(),
        );
    }
    // Q6：手动发起 = 用户自己做了决定，自动重连 episode（含「重连失败」横幅）
    // 立刻让位。episode 任务睡醒看到状态没了会自行退出。
    svc.clear_auto_reconnect();
    let sess = svc
        .request_session(&node_id, cap, uno_code, uno_pass)
        .await?;
    emit_changed(&app, &svc);
    Ok(sess)
}

/// 无人值守接入码的创建结果。`code` 是 `XXXX-XXXX` 展示码（电话可读），
/// `full` 是 `PPU-<码>-<node_id>` 完整接入串（跨网必带设备号）。
#[derive(Serialize)]
pub struct RcUnoCreated {
    pub code: String,
    pub full: String,
    /// 过期时刻（epoch 毫秒）。
    pub expires_at: i64,
}

/// 生成无人值守接入码（Q2 方案 B，被控端）。
///
/// 生成即拉起通道：无人值守场景没有人在场去点「开启」——出码的瞬间
/// 这台机器就必须已经处于可受理状态，否则码是好的、门是关的。
///
/// 参数：
/// - `ttl_secs`：时效秒数，只认 900（15 分钟）/ 86400（24 小时）两档；
/// - `unlimited`：true = 窗口内不限次（装机档）；false = 限 1 次；
/// - `capability`：接入授予的能力档（view / control），生成时选定；
/// - `also_trust`：接入的设备是否同时开免确认（默认否——下次仍要码或现场确认）。
#[tauri::command]
pub async fn rc_uno_generate(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    ttl_secs: i64,
    unlimited: bool,
    capability: String,
    also_trust: bool,
) -> Result<RcUnoCreated, String> {
    if !svc.enabled() {
        return Err("请先打开「允许被远程协助」，接入码才有意义".into());
    }
    let ttl_ms = match ttl_secs.checked_mul(1000) {
        // checked：ttl_secs 来自前端参数，debug 构建下乘法溢出会 panic
        Some(ms) if ms == uno::TTL_SHORT_MS => uno::TTL_SHORT_MS,
        Some(ms) if ms == uno::TTL_DAY_MS => uno::TTL_DAY_MS,
        _ => return Err("接入码时效只能是 15 分钟（限 1 次）或 24 小时".into()),
    };
    let cap = Capability::parse(&capability).ok_or("能力档只能是 view 或 control")?;
    let now = chrono::Utc::now().timestamp_millis();
    let code = svc
        .uno
        .generate(now, ttl_ms, unlimited, cap, also_trust)?;
    let me = NodeIdentity::load_or_create(&app_dir(&app)?)?;
    let full = uno::full_string(&code, &me.node_id());
    // 与 rc_invite_create 同一招：出码即武装，通道没起就拉起来
    if let Err(e) = svc.start(&app_dir(&app)?, true).await {
        log::warn!("[RC] 生成接入码后启动通道失败：{}", e);
    }
    emit_changed(&app, &svc);
    Ok(RcUnoCreated {
        code,
        full,
        expires_at: now + ttl_ms,
    })
}

/// 撤销全部无人值守接入码（被控端「一键作废」）。
#[tauri::command]
pub fn rc_uno_revoke(app: AppHandle, svc: State<'_, Arc<RcService>>) -> Result<usize, String> {
    let n = svc.uno.revoke_all();
    if n > 0 {
        log::info!("[RC] 已撤销 {n} 个无人值守接入码");
    }
    emit_changed(&app, &svc);
    Ok(n)
}

/// 无人值守固定密码（Q2 方案 C）：开启 / 换密码。
///
/// 与 `rc_uno_generate` 同一招：开启即武装——通道没起就拉起（服务器场景没有
/// 人在场去点「开启」）。重复调用 = 换密码（since_ms 刷新，横幅重新计时）。
/// 密码明文只在本次调用的入参里出现过一次；落盘的是 Argon2id PHC 串
/// （`rc/unop.rs`），退出本函数后前端与后端都拿不回明文。
#[tauri::command]
pub async fn rc_uno_pass_enable(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    password: String,
    capability: String,
    allow_wan: bool,
) -> Result<(), String> {
    if !svc.enabled() {
        return Err("请先打开「允许被远程协助」，固定密码才有意义".into());
    }
    let cap = Capability::parse(&capability).ok_or("能力档只能是 view 或 control")?;
    // 长度校验 + Argon2id 都在 unop::hash_password 里
    let cfg = crate::rc::unop::hash_password(
        &password,
        chrono::Utc::now().timestamp_millis(),
        cap,
        allow_wan,
    )?;
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        crate::rc::unop::CFG_KEY.to_string(),
        serde_json::to_value(&cfg).map_err(|e| e.to_string())?,
    );
    store.save_config(&config)?;
    if let Err(e) = svc.start(&app_dir(&app)?, true).await {
        log::warn!("[RC] 开启固定密码后启动通道失败：{}", e);
    }
    log::info!("[RC] 无人值守固定密码已开启（{}，跨网={}）", cap.as_str(), allow_wan);
    emit_changed(&app, &svc);
    Ok(())
}

/// 一键全局关闭固定密码（设计稿第三条对策的另一半：横幅常驻 + 这里）。
/// 幂等；不动通道与其它配置。已接入的会话不受影响——关的是「下一次准入」。
#[tauri::command]
pub async fn rc_uno_pass_disable(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
) -> Result<(), String> {
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    // 存 Null 而不是删键：config 表没有按键删除的口子，读出 Null = 未开启
    //（`unop::cfg_from` 只认对象）。
    obj.insert(crate::rc::unop::CFG_KEY.to_string(), serde_json::Value::Null);
    store.save_config(&config)?;
    log::info!("[RC] 无人值守固定密码已关闭");
    emit_changed(&app, &svc);
    Ok(())
}

/// 只改「允许跨网」开关，不动密码本体——设置页的开关不该要用户重输密码。
#[tauri::command]
pub async fn rc_uno_pass_set_wan(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    allow: bool,
) -> Result<(), String> {
    let mut cfg = crate::rc::unop::cfg_from(&store.get_config()?)
        .ok_or("固定密码未开启，没有可改的跨网开关")?;
    cfg.wan = allow;
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        crate::rc::unop::CFG_KEY.to_string(),
        serde_json::to_value(&cfg).map_err(|e| e.to_string())?,
    );
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub async fn rc_cancel_request(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
) -> Result<(), String> {
    svc.end_session("用户取消申请").await?;
    emit_changed(&app, &svc);
    Ok(())
}

/// 前端展示过后台申请失败后调用，避免每轮 status 都重复弹同一错误。
#[tauri::command]
pub fn rc_clear_outbound_error(svc: State<'_, Arc<RcService>>) -> Result<(), String> {
    svc.clear_outbound_error();
    Ok(())
}

#[tauri::command]
pub async fn rc_approve_inbound(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
) -> Result<Session, String> {
    let s = svc.approve_inbound(&node_id)?;
    emit_changed(&app, &svc);
    Ok(s)
}

#[tauri::command]
pub async fn rc_deny_inbound(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
) -> Result<(), String> {
    svc.deny_inbound(&node_id)?;
    emit_changed(&app, &svc);
    Ok(())
}

/// 方案 D：设置某台设备的「免确认直连」。`trusted=false` 即恢复每次询问。
#[tauri::command]
pub async fn rc_device_trust_set(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
    trusted: bool,
) -> Result<(), String> {
    svc.set_device_trust(&node_id, trusted)?;
    emit_changed(&app, &svc);
    Ok(())
}

/// 决策 10：设置某台设备的「自动接收文件」。`on=false` 即恢复每次确认。
///
/// 🔴 它只影响**要不要弹确认条**，不影响门禁（`gate_inbound` 一律先跑）。
#[tauri::command]
pub async fn rc_device_auto_accept_set(
    app: AppHandle,
    svc: State<'_, Arc<RcService>>,
    node_id: String,
    on: bool,
) -> Result<(), String> {
    svc.set_device_auto_accept(&node_id, on)?;
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub async fn rc_end_session(app: AppHandle, svc: State<'_, Arc<RcService>>) -> Result<(), String> {
    svc.end_session("用户结束会话").await?;
    emit_changed(&app, &svc);
    Ok(())
}

#[tauri::command]
pub fn rc_require_active(svc: State<'_, Arc<RcService>>) -> Result<Session, String> {
    svc.require_active()
}

/// 发起端最近一帧画面（base64 JPEG + 合成元数据）。无画面返 null。
#[derive(Serialize)]
pub struct RcFrameRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Serialize)]
pub struct RcFramePayload {
    pub jpeg_base64: String,
    pub at_ms: i64,
    /// true=整帧；false=脏块（前端画布局部绘制）
    pub full: bool,
    pub width: u32,
    pub height: u32,
    pub rect: Option<RcFrameRect>,
    /// "jpeg" | "h264"
    pub codec: String,
    /// H.264 是否关键帧
    pub key: bool,
}

#[tauri::command]
pub fn rc_latest_frame(svc: State<'_, Arc<RcService>>) -> Result<Option<RcFramePayload>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(svc.latest_frame().map(|f| RcFramePayload {
        jpeg_base64: STANDARD.encode(&f.jpeg),
        at_ms: f.at_ms,
        full: f.full,
        width: f.width,
        height: f.height,
        rect: f.rect.map(|r| RcFrameRect {
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
        }),
        codec: match f.codec {
            FrameCodec::Jpeg => "jpeg".into(),
            FrameCodec::H264 => "h264".into(),
            FrameCodec::Hevc => "hevc".into(),
        },
        key: f.key,
    }))
}

/// 发起端批量拉帧（原始二进制，`tauri::ipc::Response` 直通 ArrayBuffer）。
///
/// 🔴 取代前端 80~200ms 轮询 `rc_latest_frame`（base64 过 JSON IPC）的路径：
/// 一次调用取走 outbox 里**全部**待显示帧——H.264 的 P 帧互相引用、JPEG 脏块
/// 帧各管一块画布，都丢不得、乱序不得，所以是「排队全取」而不是「取最新」。
///
/// 布局（全部小端）：
/// `magic "RCF2" u32` | `count u32`，后跟 count 条：
/// `codec u8`(0=jpeg 1=h264) | `key u8` | `full u8` | `has_rect u8`
/// | `at_ms i64` | `cap_ms u16` | `enc_ms u16`（P0-2 延迟分段）
/// | `width u32` | `height u32`
/// | `rect x,y,w,h 4×u32`（has_rect=0 时忽略）
/// | `data_len u32` | `data`
pub fn encode_frame_batch(frames: &[crate::rc::video::VideoFrame]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + frames.len() * 48);
    buf.extend_from_slice(b"RCF2");
    buf.extend_from_slice(&(frames.len() as u32).to_le_bytes());
    for f in frames {
        buf.push(f.codec.as_u8());
        buf.push(f.key as u8);
        buf.push(f.full as u8);
        let r = f.rect;
        buf.push(r.is_some() as u8);
        buf.extend_from_slice(&f.at_ms.to_le_bytes());
        buf.extend_from_slice(&f.cap_ms.to_le_bytes());
        buf.extend_from_slice(&f.enc_ms.to_le_bytes());
        buf.extend_from_slice(&f.width.to_le_bytes());
        buf.extend_from_slice(&f.height.to_le_bytes());
        let (rx, ry, rw, rh) = r.map(|r| (r.x, r.y, r.w, r.h)).unwrap_or((0, 0, 0, 0));
        for v in [rx, ry, rw, rh] {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        buf.extend_from_slice(&(f.jpeg.len() as u32).to_le_bytes());
        buf.extend_from_slice(&f.jpeg);
    }
    buf
}

/// 前端按帧批量取画面。返回原始字节（前端 invoke 拿到 ArrayBuffer）。
#[tauri::command]
pub fn rc_drain_frames(svc: State<'_, Arc<RcService>>) -> tauri::ipc::Response {
    let frames = svc.drain_frames();
    tauri::ipc::Response::new(encode_frame_batch(&frames))
}

// ── G3 音频 ─────────────────────────────────────────────────────────────

/// 发起端批量取音频（原始二进制直通 ArrayBuffer，同 `rc_drain_frames` 思路）。
///
/// 布局（小端）：`magic "RCA1"` | `count u32`，后跟 count 条：
/// `type u8`（0=cfg 1=AAC帧）| `pts_ms i64`（cfg 恒 0）| `len u32` | data
/// cfg 的 data 是 JSON `{"sr","ch","asc","br"}`（asc=base64 的 AudioSpecificConfig，
/// 前端喂 WebCodecs `description`）；每次 drain 都带当前 cfg，前端按内容变化才重配。
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn rc_drain_audio(svc: State<'_, Arc<RcService>>) -> tauri::ipc::Response {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let (cfg, pkts) = svc.drain_audio();
    let mut items: Vec<(u8, i64, Vec<u8>)> = Vec::with_capacity(pkts.len() + 1);
    if let Some(c) = cfg {
        let json = serde_json::json!({
            "sr": c.sr,
            "ch": c.ch,
            "asc": STANDARD.encode(&c.asc),
            "br": c.br,
        });
        items.push((0, 0, json.to_string().into_bytes()));
    }
    for p in pkts {
        items.push((1, p.pts_ms as i64, p.data));
    }
    let mut buf = Vec::with_capacity(8 + items.len() * 16);
    buf.extend_from_slice(b"RCA1");
    buf.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for (t, pts, data) in items {
        buf.push(t);
        buf.extend_from_slice(&pts.to_le_bytes());
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data);
    }
    tauri::ipc::Response::new(buf)
}

/// 非 Windows 平台的空批（本功能只在 Windows 被控端产生数据）。
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn rc_drain_audio(_svc: State<'_, Arc<RcService>>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(b"RCA1\x00\x00\x00\x00".to_vec())
}

/// 发起端：会话中开关系统声音。被控端有可见提示（emit_stream_note）。
#[tauri::command]
pub async fn rc_audio_toggle(svc: State<'_, Arc<RcService>>, on: bool) -> Result<(), String> {
    svc.send_input(&crate::rc::input::InputEvent::AudioOn { on })
        .await
}

/// 被控端：本机静音系统声音（G3）。一票否决——对端开着也听不到。
///
/// 与 `rc_audio_toggle` 分工相反：那条是**发起端**的开关，会出网（`InputEvent::AudioOn`）、
/// 并让被控端横幅出现提示；这条是**被控者本人**的开关，**纯本机状态、不出网**。
/// 代价是对端此刻没有「对方静音了」的提示——它只会听到静音（已知限制，见清单 G3）。
///
/// 跨会话保持：关了就是关了，下次会话仍是关（隐私开关不做自动回退）。
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn rc_set_audio_local_mute(svc: State<'_, Arc<RcService>>, muted: bool) -> Result<(), String> {
    svc.set_audio_local_mute(muted);
    log::info!(
        "[RC] 本机系统声音{}（{}）",
        if muted { "已静音" } else { "已恢复" },
        if muted {
            "对方将听不到本机播放的声音"
        } else {
            "对方可再次听到本机播放的声音"
        }
    );
    Ok(())
}

/// 非 Windows：音频链路整体是 Windows 被控端专属。**明确报错**而不是静默成功——
/// 前端据返回值提示，静默成功会让按钮切到一个假状态。
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn rc_set_audio_local_mute(
    _svc: State<'_, Arc<RcService>>,
    _muted: bool,
) -> Result<(), String> {
    Err("系统声音只支持 Windows 被控端".into())
}

#[cfg(test)]
mod frame_batch_tests {
    use super::*;

    /// 编码↔前端解析必须共享同一份布局常量：这里锁死字节布局，
    /// 前端 `parseFrameBatch` 按同一张表读。改任何一处都要同步另一处。
    #[test]
    fn 帧批量编码布局_有脏矩形() {
        let frames = vec![
            crate::rc::video::VideoFrame {
                width: 1280,
                height: 720,
                jpeg: vec![1, 2, 3],
                at_ms: 1_758_000_000_000,
                full: true,
                rect: None,
                codec: crate::rc::video::FrameCodec::Jpeg,
                key: true,
                cap_ms: 4,
                enc_ms: 7,
            },
            crate::rc::video::VideoFrame {
                width: 100,
                height: 50,
                jpeg: vec![9; 7],
                at_ms: 1_758_000_000_001,
                full: false,
                rect: Some(crate::rc::video::DirtyRect {
                    x: 10,
                    y: 20,
                    w: 100,
                    h: 50,
                }),
                codec: crate::rc::video::FrameCodec::H264,
                key: false,
                cap_ms: 0,
                enc_ms: 0,
            },
        ];
        let buf = encode_frame_batch(&frames);
        // 头
        assert_eq!(&buf[..4], b"RCF2");
        assert_eq!(u32::from_le_bytes(buf[4..8].try_into().unwrap()), 2);
        let mut off = 8usize;
        // 帧 1：整帧 JPEG，无矩形
        assert_eq!(buf[off], 0); // codec
        assert_eq!(buf[off + 1], 1); // key
        assert_eq!(buf[off + 2], 1); // full
        assert_eq!(buf[off + 3], 0); // has_rect
        let at = i64::from_le_bytes(buf[off + 4..off + 12].try_into().unwrap());
        assert_eq!(at, 1_758_000_000_000);
        let cap = u16::from_le_bytes(buf[off + 12..off + 14].try_into().unwrap());
        let enc = u16::from_le_bytes(buf[off + 14..off + 16].try_into().unwrap());
        assert_eq!((cap, enc), (4, 7), "P0-2 分段必须随帧带过去");
        let w = u32::from_le_bytes(buf[off + 16..off + 20].try_into().unwrap());
        assert_eq!(w, 1280);
        let h = u32::from_le_bytes(buf[off + 20..off + 24].try_into().unwrap());
        assert_eq!(h, 720);
        let len = u32::from_le_bytes(buf[off + 40..off + 44].try_into().unwrap());
        assert_eq!(len, 3);
        assert_eq!(&buf[off + 44..off + 47], &[1, 2, 3]);
        off += 44 + 3;
        // 帧 2：H.264 P 帧 + 脏矩形
        assert_eq!(buf[off], 1);
        assert_eq!(buf[off + 1], 0);
        assert_eq!(buf[off + 2], 0);
        assert_eq!(buf[off + 3], 1);
        let rx = u32::from_le_bytes(buf[off + 24..off + 28].try_into().unwrap());
        let ry = u32::from_le_bytes(buf[off + 28..off + 32].try_into().unwrap());
        let rw = u32::from_le_bytes(buf[off + 32..off + 36].try_into().unwrap());
        let rh = u32::from_le_bytes(buf[off + 36..off + 40].try_into().unwrap());
        assert_eq!((rx, ry, rw, rh), (10, 20, 100, 50));
        let len = u32::from_le_bytes(buf[off + 40..off + 44].try_into().unwrap());
        assert_eq!(len, 7);
    }

    #[test]
    fn 帧批量编码_空队列() {
        let buf = encode_frame_batch(&[]);
        assert_eq!(buf.len(), 8);
        assert_eq!(u32::from_le_bytes(buf[4..8].try_into().unwrap()), 0);
    }
}

/// 画质档：auto | uhd | ultra | sharp | balanced | smooth
/// （auto = 2A 自动档：被控端按 RTT/带宽自动换档；uhd = 主屏硬编原生分辨率，
/// R5.B；无硬编时 JPEG 兜底约 2.5K）
#[tauri::command]
pub async fn rc_set_quality(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    quality: String,
) -> Result<(), String> {
    if !matches!(
        quality.as_str(),
        "auto" | "uhd" | "uhd60" | "ultra" | "sharp" | "balanced" | "smooth" | "fps60" | "fps120"
    ) {
        return Err(
            "画质档只能是 auto / uhd / uhd60 / ultra / sharp / balanced / smooth / fps60 / fps120"
                .into(),
        );
    }
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        crate::rc::service::CFG_QUALITY.to_string(),
        serde_json::Value::String(quality),
    );
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
}

/// Q5：发起端「码率倍率」偏好（50–200，100 = 跟随链路）。只写本机配置；
/// 对会话的生效由 outbound 任务在会话建立时推送、会话中改下拉走 rc_send_input。
#[tauri::command]
pub async fn rc_set_bitrate_pct(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    pct: u32,
) -> Result<(), String> {
    if !(50..=200).contains(&pct) {
        return Err(format!("码率倍率只能是 50–200 的整数，得到 {pct}"));
    }
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        crate::rc::service::CFG_BITRATE_PCT.to_string(),
        serde_json::Value::Number(pct.into()),
    );
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
}

/// P1/P3：本机画面编码能力探测（设置页 / 会话 UI 诚实出档用）。
/// 结果进程内缓存（`gpu::encode_caps`），重复调用零成本。
#[derive(Debug, Serialize)]
pub struct RcEncodeCaps {
    /// 硬件 D3D11-aware H.264 MFT（零拷贝/fps120 的前提）。
    pub h264_gpu: bool,
    /// 硬件 HEVC MFT（P3 实验档的前提）。
    pub hevc_hw: bool,
    /// 主显示器刷新率（Hz）。0 = 查不到。
    pub refresh_hz: u32,
    /// 在线显示器数量（fps120 档要求单屏捕获）。
    pub monitors: u32,
}

#[tauri::command]
pub fn rc_encode_caps() -> Result<RcEncodeCaps, String> {
    #[cfg(target_os = "windows")]
    {
        let c = crate::rc::gpu::encode_caps();
        Ok(RcEncodeCaps {
            h264_gpu: c.h264_gpu,
            hevc_hw: c.hevc_hw,
            refresh_hz: c.refresh_hz,
            monitors: c.monitors,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(RcEncodeCaps {
            h264_gpu: false,
            hevc_hw: false,
            refresh_hz: 0,
            monitors: 0,
        })
    }
}

/// 本机显示器列表（远程多屏切换）。
#[tauri::command]
pub fn rc_list_monitors() -> Result<Vec<crate::screenshot::MonitorInfo>, String> {
    crate::screenshot::list_monitors()
}

/// 截取范围：virtual（整个虚拟屏）| primary（仅主屏）| monitor:N
#[tauri::command]
pub async fn rc_set_capture_scope(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    scope: String,
) -> Result<(), String> {
    if !(scope == "virtual"
        || scope == "primary"
        || scope
            .strip_prefix("monitor:")
            .map(|n| n.parse::<i32>().map(|i| i >= 0).unwrap_or(false))
            .unwrap_or(false))
    {
        return Err("截取范围只能是 virtual / primary / monitor:N".into());
    }
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        crate::rc::service::CFG_CAPTURE_SCOPE.to_string(),
        serde_json::Value::String(scope),
    );
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
}

/// 发起端发送键鼠/剪贴板事件（R2/R3）。
#[tauri::command]
pub async fn rc_send_input(
    svc: State<'_, Arc<RcService>>,
    event: crate::rc::input::InputEvent,
) -> Result<(), String> {
    svc.send_input(&event).await
}

/// 打开「远程电脑」独立工作台窗口（2A 配套，2026-09-18）。
///
/// 为什么是独立窗口：主窗口只有 550×700，会话视图 960px 在里面被压成 ~534px，
/// 画面区根本不够用。独立窗口默认 1200×780（min 960×640），按主窗所在显示器居中。
///
/// - 已存在：`present_window`（最小化状态也能拉回）+ 聚焦，不重建。
/// - async command：同步 command 里建 WebviewWindow 会死锁（tauri#13963，
///   与 `open_fullscreen_editor` 同一条教训）。
#[tauri::command]
pub async fn rc_open_workbench(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("rc-workbench") {
        crate::present_window(&window);
        return Ok(());
    }
    let mut builder = tauri::webview::WebviewWindowBuilder::new(
        &app,
        "rc-workbench",
        tauri::WebviewUrl::App("rc.html".into()),
    )
    .title("远程电脑")
    .inner_size(1200.0, 780.0)
    .min_inner_size(960.0, 640.0)
    .resizable(true);

    // 按主窗口所在显示器（回退主显示器）居中——照 md-editor 的先例
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let mon_w = size.width as f64 / scale;
        let mon_h = size.height as f64 / scale;
        let win_w = 1200.0_f64.min(mon_w * 0.94);
        let win_h = 780.0_f64.min(mon_h * 0.9);
        let pos = monitor.position();
        let x = pos.x as f64 / scale + (mon_w - win_w) / 2.0;
        let y = pos.y as f64 / scale + (mon_h - win_h) / 2.0;
        builder = builder.inner_size(win_w, win_h).position(x, y);
    } else {
        builder = builder.center();
    }
    builder
        .build()
        .map_err(|e| format!("创建远程电脑窗口失败: {}", e))?;
    Ok(())
}

/// 发起端：把本机剪贴板文本推到被控端（R3 文本优先）。
#[tauri::command]
pub async fn rc_push_clipboard(svc: State<'_, Arc<RcService>>, text: String) -> Result<(), String> {
    svc.push_clipboard(&text).await
}

/// 最近会话元数据（只记谁/方向/能力/时长/结果，不记画面）。
#[tauri::command]
pub fn rc_session_history(
    svc: State<'_, Arc<RcService>>,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(svc.session_history())
}

/// 清空全部会话历史（产品红线：日志可见可删除）。幂等：没有记录也返回 Ok。
#[tauri::command]
pub fn rc_history_clear(svc: State<'_, Arc<RcService>>) -> Result<(), String> {
    svc.clear_history()
}

/// 发起端请求拉回对方剪贴板（后端等回包，修前端立刻 take 竞态）。
#[tauri::command]
pub async fn rc_pull_clipboard(svc: State<'_, Arc<RcService>>) -> Result<Option<String>, String> {
    svc.pull_clipboard().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 邀请门的时长**必须**由邀请码的窗口派生，不许各写一个数。
    ///
    /// 修复前是两个独立字面量：码 7 天（`invite::TTL_SECS`）、门 30 分钟
    /// （`RC_INVITE_DOOR_MS = 30 * 60 * 1000`）。于是用户手里的码「还有效」，
    /// 他撞上的是门，而对端只回一句 `not_paired`（「尚未远程配对」）——
    /// **指不到「回去重新生成一个」这个唯一正确的动作**，他只能反复重试同一个失效窗口。
    ///
    /// 这条断言的作用就是：谁把 `RC_INVITE_DOOR_MS` 改回一个字面量，它立刻红。
    #[test]
    fn test_邀请门与邀请码同宽() {
        assert_eq!(
            RC_INVITE_DOOR_MS,
            invite::RC_TTL_SECS * 1000,
            "邀请门必须由 invite::RC_TTL_SECS 派生，不许另写字面量"
        );
        assert_eq!(
            invite::RC_TTL_SECS,
            30 * 60,
            "远程配对的窗口是 30 分钟——改它是个产品决定，不该顺手改"
        );
        // 先落到局部变量：直接写两个 `const` 比较会被 `assertions_on_constants`
        // 判成「常量断言」而要求塞进 `const {}`，但 `const {}` 里带不了格式化参数，
        // 这条断言的「30 vs 604800」恰好是要给人看的。
        let rc_ttl = invite::RC_TTL_SECS;
        let kb_ttl = invite::TTL_SECS;
        assert!(
            rc_ttl < kb_ttl,
            "远程那档必须严于知识库那档（{rc_ttl} vs {kb_ttl}）：远程是把别人的屏幕交出去，骚扰面不同"
        );
    }

    /// 🔴 备注长度是**字符数**口径。曾经写的是 `note.len()`（字节），
    /// 60 字节只够 20 个汉字，而前端数的是 UTF-16 单元 —— 21~60 个汉字的备注
    /// 在前端看着完全合法，存下去必被拒。
    #[test]
    fn test_备注按字符截断而不是按字节() {
        let cn60 = "汉".repeat(60);
        assert_eq!(cn60.len(), 180, "前提：60 个汉字是 180 字节");
        assert_eq!(normalize_note(&cn60), cn60, "60 个汉字必须原样留下");
        assert_eq!(
            normalize_note(&"汉".repeat(61)).chars().count(),
            60,
            "超出的部分截掉，而不是整条拒收"
        );
    }

    /// 空白归一：两端 trim；纯空白等价于「清除备注」。
    #[test]
    fn test_备注归一化去两端空白_空串合法() {
        assert_eq!(normalize_note("  客厅 电脑  "), "客厅 电脑");
        assert_eq!(normalize_note("   "), "", "纯空白 == 清除备注（回落显示自报名）");
        assert_eq!(normalize_note(""), "");
    }

    /// emoji / emoji 这类扩展字符按**字符**计数，不能被切成半个代理对。
    #[test]
    fn test_备注按字符计数不劈开代理对() {
        let s = normalize_note(&"🖥".repeat(80));
        assert_eq!(s, "🖥".repeat(60), "每个 emoji 算 1 个字符，且不被截成乱码");
    }
}
