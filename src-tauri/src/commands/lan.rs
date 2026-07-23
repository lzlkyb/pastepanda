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
pub fn set_lan_pairing_key(
    app: tauri::AppHandle,
    store: State<DataStore>,
    key: String,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("配对密钥不能为空".to_string());
    }
    // 修复 M14：密钥强度校验，拒绝 "1" 这类可离线爆破的弱密钥
    crate::lan_sync::validate_pairing_key(&key)?;

    let mut config = store.get_config()?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "lan_pairing_key".to_string(),
            serde_json::Value::String(key.clone()),
        );
    }
    store.save_config(&config)?;

    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        lan_sync.set_pairing_key(key);
    }
    Ok(())
}

/// 重新生成一个随机配对密钥，持久化并立即生效，返回新密钥。
/// 注意：更换密钥后，其他已配对设备需要重新粘贴此密钥才能继续同步。
#[tauri::command]
pub fn regenerate_lan_pairing_key(
    app: tauri::AppHandle,
    store: State<DataStore>,
) -> Result<String, String> {
    let new_key = crate::lan_sync::generate_pairing_key();

    let mut config = store.get_config()?;
    if let Some(obj) = config.as_object_mut() {
        obj.insert(
            "lan_pairing_key".to_string(),
            serde_json::Value::String(new_key.clone()),
        );
    }
    store.save_config(&config)?;

    if let Some(lan_sync) = app.try_state::<crate::lan_sync::LanSync>() {
        lan_sync.set_pairing_key(new_key.clone());
    }
    Ok(new_key)
}
