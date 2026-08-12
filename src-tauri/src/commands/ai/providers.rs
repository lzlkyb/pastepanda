//! 服务商与密钥的命令层：自定义服务商 CRUD、密钥写入/查存在/清除、厂商清单。
//!
//! 从 `commands/ai.rs` 拆出。两条纪律写在这里，改动前先读：
//! - **没有 `ai_get_key`，也不会有**——密钥只能写入 / 查存在 / 清除，前端拿不到明文；
//! - 厂商清单是**手拼 JSON**（内置与自定义的字段集不同，一个结构体描不住两边），
//!   加字段时两处 `json!` 都要改，漏一处前端就少一个字段。

use super::*;

/// 新增或更新自定义服务商。id 为空 = 新增（自动生成），返回该条 id。
#[tauri::command]
pub fn ai_save_custom_provider(
    store: State<DataStore>,
    item: CustomProviderInput,
) -> Result<String, String> {
    let mut customs = read_custom_providers(&store)?;
    let id = if item.id.trim().is_empty() {
        format!(
            "custom_{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        item.id.trim().to_string()
    };
    // 审查 backlog：#7 拒绝与内置厂商重名 —— 否则内置分支会遮蔽自定义项，
    // 密钥文件还会与内置家互相覆盖。
    let key = id.trim().to_ascii_lowercase();
    if provider::PROVIDERS.iter().any(|p| p.id == key) {
        return Err("不能使用内置服务商的名称".to_string());
    }
    if let Some(existing) = customs.iter_mut().find(|c| c.id == id) {
        existing.name = item.name.trim().to_string();
        existing.base_url = item.base_url.trim().to_string();
        // 审查：编辑时 model/protocol 传空 = 保留原值（防前端漏传把已存配置清掉）
        if !item.model.trim().is_empty() {
            existing.model = item.model.trim().to_string();
        }
        if !item.protocol.trim().is_empty() {
            existing.protocol = item.protocol.trim().to_string();
        }
    } else {
        customs.push(CustomProvider {
            id: id.clone(),
            name: item.name.trim().to_string(),
            base_url: item.base_url.trim().to_string(),
            model: item.model.trim().to_string(),
            protocol: item.protocol.trim().to_string(),
        });
    }
    write_custom_providers(&store, &customs)?;
    Ok(id)
}

/// 删除自定义服务商。若删除的是当前选中的服务商，切回默认。
#[tauri::command]
pub fn ai_delete_custom_provider(
    app: tauri::AppHandle,
    store: State<DataStore>,
    id: String,
) -> Result<(), String> {
    let mut customs = read_custom_providers(&store)?;
    let before = customs.len();
    customs.retain(|c| c.id != id);
    if customs.len() == before {
        return Err("未找到该自定义服务商".to_string());
    }
    write_custom_providers(&store, &customs)?;
    // 当前选中被删 → 切回默认厂商；只改 ai_provider 键，不碰各家已存的模型/地址
    // （此前用空值走 write_ai_config 会把空 model/URL 写进默认家的 overrides，破坏配置）
    let cfg = read_ai_config(&store)?;
    if cfg.provider == id {
        let mut raw = store.get_config()?;
        if let Some(obj) = raw.as_object_mut() {
            obj.insert("ai_provider".to_string(), Value::String(provider::DEFAULT_PROVIDER.to_string()));
        }
        store.save_config(&raw)?;
    }
    // 密钥文件随 id 一起清掉
    let _ = secret_store::clear_key(&ai_data_dir(&app)?, &id);
    Ok(())
}

/// 写入自定义服务商列表。
pub(crate) fn write_custom_providers(store: &DataStore, items: &[CustomProvider]) -> Result<(), String> {
    let mut raw = store.get_config()?;
    if let Some(obj) = raw.as_object_mut() {
        obj.insert(
            "ai_custom_providers".to_string(),
            serde_json::to_value(items).unwrap_or(Value::Array(vec![])),
        );
    }
    store.save_config(&raw)
}

/// 写入密钥（传空串等于清除）。不指定厂商时写给当前选中的那家。
#[tauri::command]
pub fn ai_set_key(
    app: tauri::AppHandle,
    key: String,
    provider: Option<String>,
) -> Result<(), String> {
    let p = target_provider(&app, provider)?;
    secret_store::save_key(&ai_data_dir(&app)?, &p, &key)
}

/// 是否已配置可用的密钥。只返回布尔值，不返回密钥本身。
#[tauri::command]
pub fn ai_has_key(app: tauri::AppHandle, provider: Option<String>) -> Result<bool, String> {
    let p = target_provider(&app, provider)?;
    Ok(secret_store::has_key(&ai_data_dir(&app)?, &p))
}

/// 删除已保存的密钥。
#[tauri::command]
pub fn ai_clear_key(app: tauri::AppHandle, provider: Option<String>) -> Result<(), String> {
    let p = target_provider(&app, provider)?;
    secret_store::clear_key(&ai_data_dir(&app)?, &p)
}

// 厂商清单的返回结构曾是一个 `ProviderInfo` 结构体（`#[serde(flatten)]` 包 spec）。
// per-provider v2 后改成手拼 `Vec<Value>`（内置与自定义厂商的字段集不同，一个结构体
// 描不住两边），该结构体从此再未被构造，已删。
//
// 留着它的真实危害：它看上去像接口契约，改字段时很容易只改它、而漏改下面两处
// 手拼 JSON——真正发给前端的是手拼的那份。

#[tauri::command]
pub fn ai_list_providers(
    app: tauri::AppHandle,
    store: State<DataStore>,
) -> Result<Vec<Value>, String> {
    let dir = ai_data_dir(&app)?;
    let configured = secret_store::configured_providers(&dir);
    let mut out: Vec<Value> = Vec::with_capacity(provider::PROVIDERS.len() + 4);

    // 内置 16 家（v6.9 含 builtin-agnes 内置免费额度）
    for spec in provider::PROVIDERS.iter() {
        out.push(json!({
            "id": spec.id,
            "name": spec.name,
            "baseUrl": spec.base_url,
            "models": spec.models,
            "supportsThinkingOff": spec.thinking_control() != provider::ThinkingControl::Unsupported,
            "keyUrl": spec.key_url,
            "note": spec.note,
            "needsKey": spec.needs_key,
            "modelIsFreeText": spec.model_is_free_text,
            "modelHint": spec.model_hint,
            "priceIn": spec.price_in,
            "priceOut": spec.price_out,
            "protocol": spec.protocol.id(),
            "hasKey": configured.iter().any(|id| id == spec.id),
            "custom": false,
            // v6.9：内置免费额度服务商（前端据此显示「免费额度」角标与配额 UI）
            "builtinFree": spec.is_builtin_free(),
        }));
    }

    // 自定义服务商（用户添加的多个中转/代理）
    for c in read_custom_providers(&store)? {
        out.push(json!({
            "id": c.id,
            "name": c.name,
            "baseUrl": c.base_url,
            "models": [],
            // 中转服务背后是什么完全未知，不能假定它认识 `thinking` 字段。
            // 写死 true 的后果：界面摆出开关，开了就往请求里塞一个对方可能直接
            // 400 的字段，整个 AI 对该服务不可用。
            "supportsThinkingOff": false,
            "keyUrl": "",
            "note": "自定义服务商",
            "needsKey": true,
            "modelIsFreeText": true,
            "modelHint": "模型名",
            "priceIn": 0.0,
            "priceOut": 0.0,
            "protocol": if c.protocol.is_empty() { "openai".to_string() } else { c.protocol },
            "model": c.model, // 审查：供编辑弹窗回填（此前列表不返回 model，编辑会清空已存模型）
            "hasKey": configured.iter().any(|id| id == &c.id),
            "custom": true,
        }));
    }

    Ok(out)
}
