//! 云端 AI 命令层。
//!
//! **这里没有 `ai_get_key`，也不会有。** 密钥只能写入 / 查存在 / 清除，
//! 前端拿不到明文。界面上想展示“已配置”就用 [`ai_has_key`]。
//!
//! **密钥按厂商分开存**（`ai_key_<厂商>.bin`）：切厂商时不用重新输入，
//! 已存的会自动生效。同一时刻仍然只有一个厂商生效。
//!
//! 配置（厂商 / 地址 / 模型 / 预算 / 协议）走普通的 `config` 表——它们不是秘密，
//! 进备份也无妨。只有 Key 走 [`crate::ai::secret_store`]。

use crate::ai::actions::{self, AiAction};
use crate::ai::provider;
use crate::ai::{budget, cache, secret_store, AiConfig};
use crate::content_classifier::ContentClassifier;
use crate::data_store::{
    AiUsageByAction, AiUsageDaily, AiUsageEntry, AiUsageLogRow, CustomAction, DataStore,
};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

// 按职责拆分的子模块。`pub use` 保证命令路径不变（lib.rs 里仍是 `commands::ai::ai_run`），
// 拆分对注册表零影响。
mod actions_cmd;
mod plan;
mod providers;
mod run;
mod test_conn;
mod usage;
pub use actions_cmd::*;
pub use plan::*;
pub use providers::*;
pub use run::*;
pub use test_conn::*;
pub use usage::*;

/// 密钥与数据库同目录。
pub(crate) fn ai_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录：{}", e))
}

/// 给定服务商与“用户密钥文件里的值”，得出**最终要用的密钥**。
///
/// 抽成纯函数是为了能单测（不需要 AppHandle），较真的取值在 [`resolve_ai_key`]。
pub(crate) fn pick_ai_key(provider_id: &str, user_key: String) -> String {
    if provider_id == provider::BUILTIN_AGNES_ID {
        // 内置密钥优先：这家本来就不让用户配密钥，
        // 就算密钥文件里残留了旧值也不能拿它去请求。
        provider::builtin_agnes_key()
    } else {
        user_key
    }
}

/// 解析当前服务商要用的密钥。
///
/// **所有需要密钥的调用路径都必须走这里**，不要各自 `secret_store::load_key`。
///
/// 为什么要收口：v6.9 给内置免费（Agnes）加了应用内置公共 key，
/// 但只补在了 `ai_run` 一处，其余五条路径（测试连接 / 规划 / 自定义动作试跑 /
/// 画像精练 / 语义索引）还在读用户密钥文件——Agnes 根本没那个文件，
/// 于是带着**空密钥**出网，必然 401。
/// 用户看到的现象就是“模型明明能用，一测试就报错”。
pub(crate) fn resolve_ai_key(app: &tauri::AppHandle, cfg: &AiConfig) -> Result<String, String> {
    let dir = ai_data_dir(app)?;
    let user_key = secret_store::load_key(&dir, &cfg.provider)?.unwrap_or_default();
    Ok(pick_ai_key(&cfg.provider, user_key))
}

/// 自定义服务商（用户可添加多个中转/代理服务，每个独立存配置与密钥）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub protocol: String,
}

/// ai_save_custom_provider 的入参（id 为空 = 新增）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub protocol: String,
}

/// 从 config 表读出 AI 配置；缺字段一律回退默认值，不报错。
pub(crate) fn read_ai_config(store: &DataStore) -> Result<AiConfig, String> {
    let raw = store.get_config()?;
    let d = AiConfig::default();
    let s = |key: &str| -> String {
        raw.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let provider = {
        let p = s("ai_provider");
        if p.is_empty() { d.provider } else { p }
    };
    let (base_url, model, protocol) = resolve_provider_values(&raw, &provider, &s);
    Ok(AiConfig {
        enabled: raw
            .get("ai_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(d.enabled),
        provider,
        base_url,
        model,
        protocol,
        daily_budget_cny: raw
            .get("ai_daily_budget_cny")
            .and_then(|v| v.as_f64())
            .unwrap_or(d.daily_budget_cny),
        timeout_secs: raw
            .get("ai_timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(d.timeout_secs),
        thinking_off: raw
            .get("ai_thinking_off")
            .and_then(|v| v.as_bool())
            .unwrap_or(d.thinking_off),
        tags_as_context: raw
            .get("ai_tags_as_context")
            .and_then(|v| v.as_bool())
            .unwrap_or(d.tags_as_context),
    })
}

/// 读取自定义服务商列表（config 表 `ai_custom_providers`，JSON 数组）。
fn read_custom_providers(store: &DataStore) -> Result<Vec<CustomProvider>, String> {
    let raw = store.get_config()?;
    Ok(raw
        .get("ai_custom_providers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<CustomProvider>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default())
}

// per-provider 覆盖的读取统一走 `resolve_provider_values()`（它直接读
// `ai_provider_overrides` 并带旧 key 回退）。曾有一个单独的 `read_overrides()`，
// 重构后从未被调用，已删——两个读路径并存才是真正的隐患。

fn is_builtin_provider(id: &str) -> bool {
    provider::PROVIDERS.iter().any(|p| p.id == id)
}

fn custom_by_id(raw: &Value, id: &str) -> Option<CustomProvider> {
    raw.get("ai_custom_providers")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|v| v.get("id").and_then(|x| x.as_str()) == Some(id))
        })
        .and_then(|v| serde_json::from_value::<CustomProvider>(v.clone()).ok())
}

/// 解析指定 provider 的 baseUrl/model/protocol：
/// - 内置：`ai_provider_overrides[id]`，字段缺失回退旧 key（迁移）；
/// - 自定义：`ai_custom_providers` 数组项。
fn resolve_provider_values(
    raw: &Value,
    provider_id: &str,
    legacy: &impl Fn(&str) -> String,
) -> (String, String, String) {
    let empty = || String::new();
    if is_builtin_provider(provider_id) {
        let get_override = |k: &str| -> Option<String> {
            raw.get("ai_provider_overrides")
                .and_then(|v| v.get(provider_id))
                .and_then(|v| v.get(k))
                .and_then(|v| v.as_str())
                .map(|x| x.to_string())
                .filter(|x| !x.is_empty())
        };
        let fallback = |ov: Option<String>, legacy_val: String| ov.unwrap_or(legacy_val);
        (
            fallback(get_override("baseUrl"), legacy("ai_base_url")),
            fallback(get_override("model"), legacy("ai_model")),
            fallback(get_override("protocol"), legacy("ai_protocol")),
        )
    } else if let Some(c) = custom_by_id(raw, provider_id) {
        (c.base_url, c.model, c.protocol)
    } else {
        (empty(), empty(), empty())
    }
}

/// 写回 config 表。单独抽出来是因为几个命令都要用。
fn write_ai_config(store: &DataStore, cfg: &AiConfig) -> Result<(), String> {
    let mut raw = store.get_config()?;
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("ai_enabled".to_string(), Value::Bool(cfg.enabled));
        obj.insert("ai_provider".to_string(), Value::String(cfg.provider.clone()));
        // 模型/地址/协议按 provider 独立落位（内置 → overrides；自定义 → 数组项）
        if is_builtin_provider(&cfg.provider) {
            let mut overrides = obj
                .get("ai_provider_overrides")
                .cloned()
                .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
            if let Value::Object(m) = &mut overrides {
                let entry = m
                    .entry(cfg.provider.clone())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()));
                if let Value::Object(e) = entry {
                    e.insert("baseUrl".to_string(), Value::String(cfg.base_url.trim().to_string()));
                    e.insert("model".to_string(), Value::String(cfg.model.trim().to_string()));
                    e.insert("protocol".to_string(), Value::String(cfg.protocol.trim().to_string()));
                }
            }
            obj.insert("ai_provider_overrides".to_string(), overrides);
        } else {
            // 自定义：更新数组中同名 id 项，不存在则补一条
            let mut customs: Vec<CustomProvider> = obj
                .get("ai_custom_providers")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| serde_json::from_value::<CustomProvider>(v.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();
            let mut found = false;
            for c in customs.iter_mut() {
                if c.id == cfg.provider {
                    c.base_url = cfg.base_url.trim().to_string();
                    c.model = cfg.model.trim().to_string();
                    c.protocol = cfg.protocol.trim().to_string();
                    found = true;
                    break;
                }
            }
            if !found {
                customs.push(CustomProvider {
                    id: cfg.provider.clone(),
                    name: "自定义服务商".to_string(),
                    base_url: cfg.base_url.trim().to_string(),
                    model: cfg.model.trim().to_string(),
                    protocol: cfg.protocol.trim().to_string(),
                });
            }
            obj.insert(
                "ai_custom_providers".to_string(),
                serde_json::to_value(&customs).unwrap_or(Value::Array(vec![])),
            );
        }
        obj.insert("ai_daily_budget_cny".to_string(), json!(cfg.daily_budget_cny));
        obj.insert("ai_timeout_secs".to_string(), json!(cfg.timeout_secs));
        obj.insert("ai_thinking_off".to_string(), json!(cfg.thinking_off));
        obj.insert(
            "ai_tags_as_context".to_string(),
            json!(cfg.tags_as_context),
        );
    }
    store.save_config(&raw)
}

/// 读取 AI 配置（不含 Key）。
#[tauri::command]
pub fn ai_get_config(store: State<DataStore>) -> Result<AiConfig, String> {
    read_ai_config(&store)
}

/// 保存 AI 配置。
///
/// 故意**不**做完整性校验：用户可能先选厂商再填地址，中间态应该能存住。
/// 真正的校验在 [`ai_test_connection`] 和每次调用时做。
#[tauri::command]
pub fn ai_set_config(store: State<DataStore>, config: AiConfig) -> Result<(), String> {
    let mut cfg = config;
    // 超时太短会把正常回答切断，太长等于卡死界面；夹到合理区间
    cfg.timeout_secs = cfg.timeout_secs.clamp(5, 300);
    if !cfg.daily_budget_cny.is_finite() || cfg.daily_budget_cny < 0.0 {
        cfg.daily_budget_cny = 0.0;
    }

    // 厂商/模型/地址/协议一变，旧结果就不再代表当前配置——不清会拿旧模型的产物充数。
    // thinking_off 同理：开与不开思考，同一段输入的产物可能完全不同。
    let old = read_ai_config(&store)?;
    if old.provider != cfg.provider
        || old.effective_model() != cfg.effective_model()
        || old.effective_base_url() != cfg.effective_base_url()
        || old.effective_protocol() != cfg.effective_protocol()
        || old.thinking_off != cfg.thinking_off
    {
        cache::clear();
    }

    write_ai_config(&store, &cfg)
}

/// 取要操作的厂商 id：前端显式指定优先，否则用当前生效的。
fn target_provider(
    app: &tauri::AppHandle,
    explicit: Option<String>,
) -> Result<String, String> {
    if let Some(p) = explicit {
        let pid = p.trim();
        if !pid.is_empty() {
            // 内置走归一化；自定义 id 原样（密钥本就按 id 分文件存）
            if is_builtin_provider(pid) {
                return Ok(pid.to_string());
            }
            return Ok(pid.to_string());
        }
    }
    let store = app.state::<DataStore>();
    Ok(read_ai_config(&store)?.provider)
}

/// 读取指定服务商的 模型/地址/协议（切换服务商时前端回填用，不动当前选中）。
#[tauri::command]
pub fn ai_get_provider_config(
    store: State<DataStore>,
    provider_id: String,
) -> Result<ProviderConfigValue, String> {
    let raw = store.get_config()?;
    let legacy = |key: &str| -> String {
        raw.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let (base_url, model, protocol) = resolve_provider_values(&raw, &provider_id, &legacy);
    Ok(ProviderConfigValue { base_url, model, protocol })
}

/// 指定服务商的 模型/地址/协议。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigValue {
    pub base_url: String,
    pub model: String,
    pub protocol: String,
}




#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_store::DataStore;

    fn make_store() -> DataStore {
        DataStore::new(":memory:").expect("内存库")
    }

    /// 写 → 读往返：内置服务商的模型/地址独立于其他家
    #[test]
    fn test_builtin_provider_values_roundtrip() {
        let store = make_store();
        let mut cfg = AiConfig::default();
        cfg.provider = "deepseek".to_string();
        cfg.base_url = "https://a.example.com/v1".to_string();
        cfg.model = "deepseek-chat".to_string();
        write_ai_config(&store, &cfg).unwrap();

        let read = read_ai_config(&store).unwrap();
        assert_eq!(read.provider, "deepseek");
        assert_eq!(read.model, "deepseek-chat");
        assert_eq!(read.base_url, "https://a.example.com/v1");
    }

    /// 切到另一家再切回：deepseek 的值仍在（不再被清空覆盖）
    #[test]
    fn test_switch_provider_keeps_previous_values() {
        let store = make_store();
        // 配置 deepseek
        let mut a = AiConfig::default();
        a.provider = "deepseek".to_string();
        a.model = "deepseek-chat".to_string();
        a.base_url = "https://a.example.com/v1".to_string();
        write_ai_config(&store, &a).unwrap();
        // 切到 qwen 配自己的
        let mut b = AiConfig::default();
        b.provider = "qwen".to_string();
        b.model = "qwen-max".to_string();
        b.base_url = "https://b.example.com/v1".to_string();
        write_ai_config(&store, &b).unwrap();
        // 当前配置 = 最后一次写入的（qwen）。
        // 注意：这里并没有“切回 deepseek”的动作——本例要验的是
        // 切走之后 deepseek 的 per-provider 值**没被覆盖**，见下面两条断言。
        let read = read_ai_config(&store).unwrap();
        assert_eq!(read.provider, "qwen");
        // 直接读 deepseek 的值
        let raw = store.get_config().unwrap();
        let legacy = |k: &str| raw.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (base_url, model, _) = resolve_provider_values(&raw, "deepseek", &legacy);
        assert_eq!(model, "deepseek-chat");
        assert_eq!(base_url, "https://a.example.com/v1");
    }

    /// 自定义服务商：写入数组、多实例互不影响
    #[test]
    fn test_custom_provider_roundtrip() {
        let store = make_store();
        let mut customs = read_custom_providers(&store).unwrap();
        customs.push(CustomProvider {
            id: "custom_1".to_string(),
            name: "公司中转".to_string(),
            base_url: "https://relay.example.com/v1".to_string(),
            model: "gpt-4o".to_string(),
            protocol: "openai".to_string(),
        });
        write_custom_providers(&store, &customs).unwrap();

        // 作为当前 provider 读写
        let mut cfg = AiConfig::default();
        cfg.provider = "custom_1".to_string();
        cfg.base_url = "https://relay.example.com/v1".to_string();
        cfg.model = "gpt-4o".to_string();
        write_ai_config(&store, &cfg).unwrap();

        let read = read_ai_config(&store).unwrap();
        assert_eq!(read.provider, "custom_1");
        assert_eq!(read.model, "gpt-4o");

        // 两个自定义互不影响
        let raw = store.get_config().unwrap();
        let legacy = |k: &str| raw.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (_, m2, _) = resolve_provider_values(&raw, "custom_2", &legacy);
        assert_eq!(m2, "", "未配置的自定义返回空，不与 custom_1 串");
    }

    // ===== 密钥解析的守卫 =====
    //
    // 背景：v6.9 给内置免费（Agnes）加了应用内置公共 key，但只补在 ai_run 一处。
    // 其余五条路径（测试连接 / 规划 / 自定义动作试跑 / 画像精练 / 语义索引）
    // 都在自己 load_key，Agnes 根本没那个文件 → 空密钥出网 → 401。
    // 现在全部收口到 pick_ai_key / resolve_ai_key，这几条测试钉住不变量。

    #[test]
    fn builtin_free_always_uses_builtin_key() {
        let k = pick_ai_key(provider::BUILTIN_AGNES_ID, String::new());
        assert!(!k.is_empty(), "内置免费服务商拿到了空密钥（就是那个 401 的根因）");
        assert_eq!(k, provider::builtin_agnes_key());
    }

    #[test]
    fn builtin_free_ignores_stale_user_key() {
        // 密钥文件里残留旧值也不能盖掉内置 key
        let k = pick_ai_key(provider::BUILTIN_AGNES_ID, "stale-leftover".to_string());
        assert_eq!(k, provider::builtin_agnes_key());
    }

    #[test]
    fn other_providers_use_user_key() {
        // 仓库惯例：假 key 用 concat! 拼接，避开 GitHub 密钥扇描拦截
        let user = concat!("sk-", "unit-test-not-a-real-key").to_string();
        assert_eq!(pick_ai_key("deepseek", user.clone()), user);
        assert_eq!(pick_ai_key("custom_1", user.clone()), user);
    }
}
