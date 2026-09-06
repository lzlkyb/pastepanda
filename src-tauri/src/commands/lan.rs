use crate::data_store::DataStore;
use tauri::{Manager, State};

// ===== 局域网同步命令 =====

/// 获取局域网同步状态（是否启用）
#[tauri::command]
pub fn get_lan_status(store: State<DataStore>) -> Result<bool, String> {
    let config = store.get_config()?;
    Ok(config
        .get("lan_sync_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// 监听线程是否真的在跑。
///
/// 🔴 跟 [`get_lan_status`]（开关配置）是两件事。开关是用户的意愿，
/// 这个是实际状态——两者会分开：端口 5007 被占、或一块网卡都没能加入组播组时，
/// 监听线程会自己退出。不把它露出去的话，界面上开关仍然是开的而功能是死的——
/// 那正是用户报的「没报错但就是发现不了」（规则 #15.3）。
#[tauri::command]
pub fn get_lan_running(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app
        .try_state::<crate::lan_sync::LanSync>()
        .is_some_and(|l| l.is_running()))
}

/// 切换局域网同步
#[tauri::command]
pub fn toggle_lan_sync(
    app: tauri::AppHandle,
    store: State<DataStore>,
    enable: bool,
) -> Result<(), String> {
    // 保存配置
    let mut config = store.get_config()?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "lan_sync_enabled".to_string(),
            serde_json::Value::Bool(enable),
        );
    }
    store.save_config(&config)?;

    // 启动/停止 LAN 同步
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        if enable {
            lan_sync.start_listener(app.clone());
        } else {
            lan_sync.stop();
        }
    }
    Ok(())
}

/// 发送测试同步消息
#[tauri::command]
pub fn send_lan_test(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        lan_sync.send("🔔 这是一条局域网同步测试消息");
    }
    Ok(())
}

/// 获取已发现的局域网设备列表
#[tauri::command]
pub fn get_lan_devices(app: tauri::AppHandle) -> Result<Vec<crate::lan_sync::LanDevice>, String> {
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        Ok(lan_sync.get_devices())
    } else {
        Ok(Vec::new())
    }
}

/// 获取当前局域网配对密钥（用于在设置面板中展示，供用户手动复制到其他设备完成配对）
#[tauri::command]
pub fn get_lan_pairing_key(
    app: tauri::AppHandle,
    store: State<DataStore>,
) -> Result<String, String> {
    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        let key = lan_sync.get_pairing_key();
        if !key.is_empty() {
            return Ok(key);
        }
    }
    // 回退：正常情况下启动时已生成并注入 LanSync，这里仅作兜底，直接读配置
    let config = store.get_config()?;
    Ok(config
        .get("lan_pairing_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// 设置（粘贴自其他设备的）局域网配对密钥，持久化并立即在运行时生效
#[tauri::command]
pub fn set_lan_pairing_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("配对密钥不能为空".to_string());
    }
    // 强度校验与落盘都在 `apply_pairing_key` 里（规则 #11）。
    // 旧写法里的 `if let Some(obj)` 会在配置不是对象时**静默跳过写入**
    // 却照样返回 Ok，已一并修掉（规则 #15.3）。
    crate::lan_sync::apply_pairing_key(&app, &key)
}

/// 重新生成一个随机配对密钥，持久化并立即生效，返回新密钥。
/// 注意：更换密钥后，其他已配对设备需要重新粘贴此密钥才能继续同步。
#[tauri::command]
pub fn regenerate_lan_pairing_key(app: tauri::AppHandle) -> Result<String, String> {
    let new_key = crate::lan_sync::generate_pairing_key();
    crate::lan_sync::apply_pairing_key(&app, &new_key)?;
    Ok(new_key)
}

// ===== 附近设备配对（免交换密钥）=====
//
// 设计稿：`design/PastePanda-局域网同步-附近设备配对-设计稿.html`

/// 附近尚未配对的设备。
///
/// 已配对的不列——它们在 `get_lan_devices` 那个列表里，
/// 两处都出现会让用户以为没配上、反复点。
#[tauri::command]
pub fn get_lan_nearby(
    app: tauri::AppHandle,
) -> Result<Vec<crate::lan_pair::NearbyDevice>, String> {
    let Some(lan) = app.try_state::<crate::lan_sync::LanSync>() else {
        return Ok(Vec::new());
    };
    let now = chrono::Utc::now().timestamp();
    // 🔴 过滤依据是**持久化名单**，不是「最近解密成功过」那张内存表。
    //   旧写法拿 `paired_ids()`（= 内存表的 key）做判据，而那张表既不过期也不落盘：
    //   对方掉线后仍被当成「已配对」而从附近设备里滤掉，重启后又全部归零。
    let paired: Vec<String> = crate::lan_sync::load_paired(&app)
        .into_iter()
        .map(|d| d.device_id)
        .collect();
    Ok(lan.pair().list_nearby(now, &paired))
}

/// 记住的设备一行。
///
/// 🔴 `online` 与 `last_sync` 是两件事，必须分开：
/// - `online` 由**招呼包**（每 5 秒一次的心跳）判定
/// - `last_sync` 是最近一次收到它**加密消息**的时刻，而加密消息只在剪贴板变动时才发
///
/// 拿 `last_sync` 当在线判据会同时错两头：一台安静但在线的设备显示成离线，
/// 一台几小时前发过一条、现已关机的设备却一直显示在线。
#[derive(serde::Serialize)]
pub struct PairedDeviceView {
    pub device_id: String,
    pub device_name: String,
    pub paired_at: i64,
    /// 在线：[`crate::lan_pair::NEARBY_TTL_SECS`] 内听到过它的招呼包。
    pub online: bool,
    /// 本次运行内最近一次收到它加密消息的时刻；从未收到则为空串。
    pub last_sync: String,
}

/// 记住的设备名单（含在线情况）。
#[tauri::command]
pub fn get_lan_paired(app: tauri::AppHandle) -> Result<Vec<PairedDeviceView>, String> {
    let lan = app.try_state::<crate::lan_sync::LanSync>();
    let now = chrono::Utc::now().timestamp();
    let last_sync: std::collections::HashMap<String, String> = lan
        .as_ref()
        .map(|l| {
            l.get_devices()
                .into_iter()
                .map(|d| (d.device_id, d.last_seen))
                .collect()
        })
        .unwrap_or_default();

    Ok(crate::lan_sync::load_paired(&app)
        .into_iter()
        .map(|d| PairedDeviceView {
            online: lan
                .as_ref()
                .and_then(|l| l.pair().last_heard(&d.device_id))
                .is_some_and(|t| now - t <= crate::lan_pair::NEARBY_TTL_SECS),
            last_sync: last_sync.get(&d.device_id).cloned().unwrap_or_default(),
            device_id: d.device_id,
            device_name: d.device_name,
            paired_at: d.paired_at,
        })
        .collect())
}

/// 忘记一台设备。
///
/// 🔴 **只清本机记录，不吊销配对密钥**（单一群组密钥模型，详见
/// [`crate::lan_sync::forget_device`]）。界面上必须把这件事说清楚。
#[tauri::command]
pub fn lan_forget_device(app: tauri::AppHandle, device_id: String) -> Result<bool, String> {
    let removed = crate::lan_sync::forget_device(&app, &device_id)?;
    // ❗ 内存那张在线表也要清，否则它还会显示「在线」，
    //   而且下一轮轮询会把它又记回名单里。
    if let Some(lan) = app.try_state::<crate::lan_sync::LanSync>() {
        lan.drop_device(&device_id);
    }
    Ok(removed)
}

/// 进行中的配对快照。两端都轮询它：
/// 发起方拿它显示 pin，接受方拿它弹框 + 显示 pin。
#[derive(serde::Serialize)]
pub struct LanPairState {
    pub peer_id: String,
    pub peer_name: String,
    /// 两端核对用的 6 位数字。协商完成前为空串。
    pub pin: String,
    /// `"initiator"` / `"responder"`。接受方要先弹一个“对方想配对”。
    pub role: String,
    /// 本端用户是否已点确认。
    pub confirmed: bool,
}

#[tauri::command]
pub fn get_lan_pair_state(app: tauri::AppHandle) -> Result<Option<LanPairState>, String> {
    let Some(lan) = app.try_state::<crate::lan_sync::LanSync>() else {
        return Ok(None);
    };
    let now = chrono::Utc::now().timestamp();
    Ok(lan.pair().snapshot(now).map(|(id, name, pin, role, ok)| {
        LanPairState {
            peer_id: id,
            peer_name: name,
            pin,
            role: match role {
                crate::lan_pair::PairRole::Initiator => "initiator".into(),
                crate::lan_pair::PairRole::Responder => "responder".into(),
            },
            confirmed: ok,
        }
    }))
}

/// 发起配对（用户在附近列表里点了某台）。
#[tauri::command]
pub fn lan_pair_start(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    let lan = app
        .try_state::<crate::lan_sync::LanSync>()
        .ok_or_else(|| "局域网同步未启动".to_string())?;
    let now = chrono::Utc::now().timestamp();
    let pair = lan.pair();

    let peer_name = pair
        .device_name_of(&device_id)
        .ok_or_else(|| "这台设备刚刚不见了，请刷新后重试".to_string())?;

    let pending = crate::lan_pair::PendingPair::start(
        &device_id,
        &peer_name,
        crate::lan_pair::PairRole::Initiator,
        now,
    )?;
    let my_pk = pair.begin(pending);

    lan.send_pair_packet(&crate::lan_pair::PairPacket {
        v: crate::lan_pair::PAIR_PROTO_V,
        kind: crate::lan_pair::KIND_REQ.into(),
        from_id: lan.device_id().into(),
        from_name: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        to_id: device_id,
        pk: my_pk,
        nonce: String::new(),
        sealed: String::new(),
        ts: now,
    });
    Ok(())
}

/// 用户点了「一样，确认」。
///
/// 🔴 发起方确认后才把自己的 `pairing_key` 加密送出去；
/// 接受方确认只是置位，等对方送过来（接收侧会检查 `confirmed`，
/// 没确认就拒收——否则对方单方面点一下就能换掉我的密钥）。
#[tauri::command]
pub fn lan_pair_confirm(app: tauri::AppHandle) -> Result<(), String> {
    let lan = app
        .try_state::<crate::lan_sync::LanSync>()
        .ok_or_else(|| "局域网同步未启动".to_string())?;
    let now = chrono::Utc::now().timestamp();
    let pair = lan.pair();

    let info = pair
        .with_pending(now, |p| {
            p.confirmed = true;
            (p.role, p.peer_id.clone(), p.shared.clone())
        })
        .ok_or_else(|| "配对已过期，请重新开始".to_string())?;

    let (role, peer_id, shared) = info;
    if role != crate::lan_pair::PairRole::Initiator {
        return Ok(()); // 接受方：等对方送密钥
    }
    let shared = shared.ok_or_else(|| "还没有协商完成，稍等一下".to_string())?;

    let key = lan.get_pairing_key();
    let (nonce, sealed) = crate::lan_pair::seal_pairing_key(&shared, &key)?;
    lan.send_pair_packet(&crate::lan_pair::PairPacket {
        v: crate::lan_pair::PAIR_PROTO_V,
        kind: crate::lan_pair::KIND_KEY.into(),
        from_id: lan.device_id().into(),
        from_name: String::new(),
        to_id: peer_id,
        pk: String::new(),
        nonce,
        sealed,
        ts: now,
    });
    pair.clear();
    Ok(())
}

/// 用户点了「不一样，取消」或关掉弹框。
///
/// 拒绝会计数，达到阈值后本次进程内不再为该对端弹框（防骚扰）。
#[tauri::command]
pub fn lan_pair_cancel(app: tauri::AppHandle) -> Result<(), String> {
    let Some(lan) = app.try_state::<crate::lan_sync::LanSync>() else {
        return Ok(());
    };
    let now = chrono::Utc::now().timestamp();
    let pair = lan.pair();
    if let Some(peer) = pair.with_pending(now, |p| p.peer_id.clone()) {
        pair.note_reject(&peer);
    }
    pair.clear();
    Ok(())
}
