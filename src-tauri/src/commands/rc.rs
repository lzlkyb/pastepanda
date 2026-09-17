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
use crate::rc::session::{
    is_rc_online_for, rc_presence_level, CFG_CAPABILITY, CFG_DEVICE_DENY, CFG_ENABLED, Session,
};
use crate::sync::identity::NodeIdentity;
use crate::sync::invite::{self, Invite};

fn app_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
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
        let level = rc_presence_level(
            &d.node_id,
            d.last_seen,
            &live,
            session_peer.as_deref(),
            now,
        );
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
            conn_state: if online { "online".into() } else { "offline".into() },
            last_seen: d.last_seen,
            source: "rc".into(),
            presence: level.as_str().into(),
            last_path: d.last_path,
        });
    }
    for d in store.device_list()? {
        if seen.contains(&d.node_id) {
            continue;
        }
        seen.insert(d.node_id.clone());
        let level = rc_presence_level(
            &d.node_id,
            d.last_seen,
            &live,
            session_peer.as_deref(),
            now,
        );
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
            conn_state: if online { "online".into() } else { "offline".into() },
            last_seen: d.last_seen,
            source: "sync".into(),
            presence: level.as_str().into(),
            // 同步设备表（`devices`）没有路径列——它只做笔记同步，从没跑过 rc 会话。
            // 空串 = 前端不显示这一格（而不是编一个「绕中继」出来）。
            last_path: String::new(),
        });
    }
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
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象")?;
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
    let code = invite::encode(&me, name.trim(), Vec::new(), now)?;
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
) -> Result<Session, String> {
    let cap = Capability::parse(&capability).ok_or("能力档只能是 view 或 control")?;
    if !svc.is_running() {
        return Err(
            "远程通道未启动：请在工具箱「远程电脑」里点「开启远程通道」，或先完成远程配对"
                .into(),
        );
    }
    let sess = svc.request_session(&node_id, cap).await?;
    emit_changed(&app, &svc);
    Ok(sess)
}

#[tauri::command]
pub async fn rc_cancel_request(app: AppHandle, svc: State<'_, Arc<RcService>>) -> Result<(), String> {
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
    use crate::rc::video::FrameCodec;
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
        },
        key: f.key,
    }))
}

/// 画质档：uhd | ultra | sharp | balanced | smooth
/// （uhd = 主屏硬编原生分辨率，R5.B；无硬编时 JPEG 兜底约 2.5K）
#[tauri::command]
pub async fn rc_set_quality(
    app: AppHandle,
    store: State<'_, DataStore>,
    svc: State<'_, Arc<RcService>>,
    quality: String,
) -> Result<(), String> {
    if !matches!(quality.as_str(), "uhd" | "ultra" | "sharp" | "balanced" | "smooth") {
        return Err("画质档只能是 uhd / ultra / sharp / balanced / smooth".into());
    }
    let mut config = store.get_config()?;
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象")?;
    obj.insert(
        crate::rc::service::CFG_QUALITY.to_string(),
        serde_json::Value::String(quality),
    );
    store.save_config(&config)?;
    emit_changed(&app, &svc);
    Ok(())
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
    let obj = config
        .as_object_mut()
        .ok_or("配置文件不是一个对象")?;
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

/// 发起端：把本机剪贴板文本推到被控端（R3 文本优先）。
#[tauri::command]
pub async fn rc_push_clipboard(
    svc: State<'_, Arc<RcService>>,
    text: String,
) -> Result<(), String> {
    svc.push_clipboard(&text).await
}

/// 最近会话元数据（只记谁/方向/能力/时长/结果，不记画面）。
#[tauri::command]
pub fn rc_session_history(svc: State<'_, Arc<RcService>>) -> Result<Vec<serde_json::Value>, String> {
    Ok(svc.session_history())
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
}
