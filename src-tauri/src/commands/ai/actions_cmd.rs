//! 动作清单与自定义动作的 CRUD。
//!
//! 内置动作在 `crate::ai::actions`（纯函数、无状态）；这里只做命令层与库表。
//! 属于 AI 层的校验放在这里而不是数据层——数据层不认识 `crate::ai`：
//! 模板必含内容占位符、不能与内置动作重名。

use super::*;

// ===== 动作执行 =====

/// 可用动作清单（含选项规格，前端据此自动生成 chip）。仅内置；自定义走 [`ai_list_custom_actions`]。
#[tauri::command]
pub fn ai_list_actions() -> Vec<AiAction> {
    // 滤掉画布内部动作：前端 initAiTransforms 会把这份清单里的每一条都注册成变换，
    // 而 ai-diagram 这三条的输入输出都是流程图专用格式，摆到卡片的变换中心里只会干扰。
    // 不影响 ai_run：它走 find_action，照旧能找到。
    actions::ACTIONS
        .iter()
        .filter(|a| !actions::is_internal_action(a.id))
        .cloned()
        .collect()
}

// ===== 自定义动作 =====

/// 编辑器里可选的“适用内容类型”。
///
/// 从后端拿而不是前端写一份：同一张表在两边各维护，加一类就得改两处。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeOption {
    pub id: &'static str,
    pub label: &'static str,
}

#[tauri::command]
pub fn ai_list_content_types() -> Vec<ContentTypeOption> {
    actions::SELECTABLE_CONTENT_TYPES
        .iter()
        .map(|(id, label)| ContentTypeOption { id, label })
        .collect()
}

#[tauri::command]
pub fn ai_list_custom_actions(store: State<DataStore>) -> Result<Vec<CustomAction>, String> {
    store.ai_custom_actions()
}

/// 新建或更新自定义动作，返回最终 id。
///
/// 两条属于 AI 层的校验在这里做（数据层不认识 `crate::ai`）：
/// 模板必含内容占位符、不能与内置动作重名。
#[tauri::command]
pub fn ai_save_custom_action(
    store: State<DataStore>,
    action: CustomAction,
) -> Result<String, String> {
    actions::validate_template(&action.template)?;

    let name = action.name.trim();
    if let Some(hit) = actions::ACTIONS.iter().find(|a| a.label == name) {
        return Err(format!(
            "“{}”是内置动作的名字，换一个吧",
            hit.label
        ));
    }

    // 选了不存在的内容类型 → 这个动作将永远不会出现，而用户看不出来
    for ct in &action.content_types {
        if !actions::SELECTABLE_CONTENT_TYPES.iter().any(|(id, _)| id == ct) {
            return Err(format!("不认识的内容类型：{}", ct));
        }
    }

    let id = store.ai_custom_action_save(&action)?;
    // 模板可能变了，旧结果不再代表当前配置。缓存键里虽然拌了模板哈希（已够），
    // 这里再清一把是为了连“改了名字/适用类型”这种不影响哈希的改动也给个干净状态
    cache::clear();
    Ok(id)
}

#[tauri::command]
pub fn ai_delete_custom_action(store: State<DataStore>, id: String) -> Result<(), String> {
    store.ai_custom_action_delete(&id)
}

#[tauri::command]
pub fn ai_reorder_custom_actions(
    store: State<DataStore>,
    ids: Vec<String>,
) -> Result<(), String> {
    store.ai_custom_actions_reorder(&ids)
}

/// 模板指纹，拌进缓存键。
///
/// **不拌就是个真 bug**：自定义动作的 id 在编辑前后不变，改完模板再跑会直接
/// 命中旧结果，用户会以为自己的修改没生效。
pub(crate) fn template_fingerprint(template: &str) -> String {
    let digest = Md5::new().chain_update(template.as_bytes()).finalize();
    format!("{:x}", digest)[..8].to_string()
}


