//! 自动收录影子运行的命令层（知识库 A 阶段 · 规划 §8.1 5️⃣）。
//!
//! 本层比其他命令文件多一件事：**排除 3（`is_secret` 不命中）在这里做**。
//! 它住在 `content_classifier`，而 `data_store` 不应反向依赖分类器；且它是正则判定，
//! SQL 里写不了。这是 `is_secret` 的**第三次复用**（前两处：剪贴板监听的「要不要入库」、
//! AI 出网闸的「要不要发送」）。
//!
//! 🔴 红线：无 AI。影子运行不落库、不弹提示、不改任何界面。

use crate::content_classifier::ContentClassifier;
use crate::data_store::{DataStore, ShadowStats};
use tauri::State;

/// 跑一轮影子评估并记录命中，返回本轮命中数。
///
/// 前端在启动时 fire-and-forget 调一次。为何启动而不是定时：规则的输入（找回数、
/// 年龄）变得很慢，一天跑几轮与跑一轮的结果集几乎一样，而启动钩子零额外机制。
#[tauri::command]
pub fn kb_shadow_run(store: State<DataStore>, workspace: String) -> Result<usize, String> {
    let rows = store.kb_shadow_candidates(&workspace)?;

    // 排除 3：密钥 / 凭证类内容永不进自动收录的候选集。
    // 即使现在只是影子运行（不落库）也要挡：影子集就是将来 B2 真开时的集合，
    // 现在不挡，算出的准确率就不是将来那个规则的准确率。
    let classifier = ContentClassifier::new();
    let ids: Vec<String> = rows
        .into_iter()
        .filter(|(_, text)| !classifier.is_secret(text))
        .map(|(id, _)| id)
        .collect();

    let n = ids.len();
    store.kb_shadow_record(&ids)?;
    Ok(n)
}

/// 读出准确率统计（红线②：使用日志可见）。
#[tauri::command]
pub fn kb_shadow_stats(store: State<DataStore>) -> Result<ShadowStats, String> {
    store.kb_shadow_stats()
}

/// 清空影子运行记录（红线②：使用日志可删）。返回删了多少行。
#[tauri::command]
pub fn kb_shadow_clear(store: State<DataStore>) -> Result<usize, String> {
    store.kb_shadow_clear()
}
