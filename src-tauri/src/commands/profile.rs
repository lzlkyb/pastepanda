//! 用户画像命令层（M6-2/M6-3）。
//!
//! **画像 = 纯函数(现有数据) + 用户覆盖**——不做持久表、不做同步：
//! 每次打开「我的画像」时从 action_events / ai_feedback / action_prefs 实时聚合
//! （几千条量级毫秒级），用户修正存 config 表 `profile_overrides`，永远最新。
//!
//! 隐私（红线②同构）：画像只含**统计值**（动作名/内容类型/时段/偏好指令），
//! 不含任何内容文本。三条对外路径，都由用户主动触发、且都先过 `sanitize_profile`：
//!
//! - `profile_export` / `profile_install_skill`——**写本地文件**，不出网；
//! - `profile_refine`——**这才是唯一的出网口**，把统计值发给云端服务商润色。
//!
//! （旧注释写的是“导出是唯一出网口”——那会把红线的位置指错：真正会把数据
//! 交给第三方的是 `profile_refine`，而导出只是落到用户自己的盘上。）

use crate::content_classifier::ContentClassifier;
use crate::data_store::{DataStore, ProfileRawStats};
use serde::Serialize;
use tauri::{Manager, State};

/// 画像默认统计窗口（天）。
const PROFILE_DAYS: u32 = 30;

// ===================== 数据结构 =====================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleScore {
    pub role: String,
    pub label: String,
    /// 归一化打分 0~1（最高分角色 = 1.0）。
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainShare {
    pub domain: String,
    /// 百分比（向下取整）。
    pub pct: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopAction {
    pub action_id: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourSegment {
    pub label: String,
    pub pct: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefItem {
    pub action_id: String,
    pub preference: String,
    pub edit_rate: f64,
}

/// 完整画像（前端「我的画像」展示 + 导出数据源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    /// 角色概率（降序）。
    pub role_scores: Vec<RoleScore>,
    /// 内容领域分布（降序）。
    pub domains: Vec<DomainShare>,
    /// 高频动作 top 8。
    pub top_actions: Vec<TopAction>,
    /// 活跃时段分布（4 段）。
    pub hours: Vec<HourSegment>,
    /// 风格偏好（动作偏好指令 + 被改率）。
    pub prefs: Vec<PrefItem>,
    /// 用户手动覆盖（config `profile_overrides`）。
    pub overrides: serde_json::Value,
    /// 样本：参与统计的动作事件总数。
    pub sample_events: u32,
    /// 置信度提示（样本不足时前端标注）。
    pub confidence: f32,
}

// ===================== 规则打分（v1 纯规则，零 LLM） =====================

/// 动作 → 角色加分（权重）。只列有区分度的动作，中性动作不计。
fn action_role_weight(action: &str) -> &'static [(&'static str, f32)] {
    use std::sync::OnceLock;
    static MAP: OnceLock<std::collections::HashMap<&'static str, Vec<(&'static str, f32)>>> =
        OnceLock::new();
    let map = MAP.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        m.insert("ai-explain-code", vec![("developer", 1.2)]);
        m.insert("ai-json-to-type", vec![("developer", 1.2)]);
        m.insert("json_format", vec![("developer", 1.0)]);
        m.insert("sql-in", vec![("developer", 0.9)]);
        m.insert("column-to-sql-in", vec![("developer", 0.8)]);
        m.insert("delimited-to-sql-in", vec![("developer", 0.8)]);
        m.insert("sql_format", vec![("developer", 0.8)]);
        m.insert("ai-commit-message", vec![("developer", 0.8)]);
        m.insert("sql_keywords_upper", vec![("developer", 0.5)]);
        m.insert("url-summary", vec![("research", 1.2)]);
        m.insert("ai-summarize", vec![("research", 0.5)]);
        m.insert("doc_clean_html", vec![("research", 0.3)]);
        m.insert("ai-polish", vec![("writer", 1.2)]);
        m.insert("ai-rewrite", vec![("writer", 1.0)]);
        m.insert("ai-merge-polish", vec![("writer", 0.8)]);
        m.insert("ai-key-points", vec![("writer", 0.4)]);
        m.insert("ai-reply-draft", vec![("comm", 1.2)]);
        m.insert("ai-weekly-report", vec![("ops", 1.0), ("comm", 0.4)]);
        m.insert("ai-tabulate", vec![("ops", 0.8)]);
        m.insert("mask-sensitive", vec![("ops", 0.4)]);
        m.insert("query-result-to-sql", vec![("data", 1.0)]);
        m.insert("config_to_json", vec![("data", 0.5)]);
        m
    });
    map.get(action).map(|v| v.as_slice()).unwrap_or(&[])
}

/// 内容类型 → 角色加分。
fn content_type_role_weight(ct: &str) -> &'static [(&'static str, f32)] {
    match ct {
        "code" | "json" | "shell" | "log" | "xml" | "yaml" | "sql" => {
            &[("developer", 1.0), ("data", 0.3)]
        }
        "url" => &[("research", 0.8)],
        _ => &[],
    }
}

/// 内容类型 → 领域标签（前端展示用）。未知类型归 "other"。
fn domain_label(ct: &str) -> &'static str {
    match ct {
        "code" | "shell" | "log" | "xml" | "yaml" => "代码",
        "json" | "sql" => "结构化数据",
        "url" => "链接",
        "text" => "文本",
        "image" => "图片",
        "file" => "文件",
        _ => "其他",
    }
}

const ROLES: &[(&str, &str)] = &[
    ("developer", "开发者"),
    ("research", "研究/学习"),
    ("writer", "文案/写作"),
    ("comm", "沟通/客服"),
    ("ops", "运营/行政"),
    ("data", "数据/分析"),
];

const HOUR_SEGMENTS: &[(&str, std::ops::Range<i64>)] = &[
    ("凌晨 0-6 点", 0..6),
    ("上午 6-12 点", 6..12),
    ("下午 12-18 点", 12..18),
    ("晚上 18-24 点", 18..24),
];

fn build_profile(raw: &ProfileRawStats) -> UserProfile {
    // 角色打分：动作权重 × 次数 + 内容类型权重 × 次数
    let mut scores: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
    for (action, count) in &raw.action_counts {
        let w = action_role_weight(action);
        for (role, weight) in w {
            *scores.entry(role).or_insert(0.0) += *weight as f64 * *count as f64;
        }
    }
    for (ct, count) in &raw.content_type_counts {
        let w = content_type_role_weight(ct);
        for (role, weight) in w {
            *scores.entry(role).or_insert(0.0) += *weight as f64 * *count as f64;
        }
    }
    let max_score = scores.values().cloned().fold(0.0f64, f64::max);
    let mut role_scores: Vec<RoleScore> = ROLES
        .iter()
        .map(|(role, label)| RoleScore {
            role: role.to_string(),
            label: label.to_string(),
            score: if max_score > 0.0 {
                (scores.get(role).copied().unwrap_or(0.0) / max_score) as f32
            } else {
                0.0
            },
        })
        .filter(|r| r.score > 0.0)
        .collect();
    role_scores.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // 内容领域分布。**先按领域合并原始计数，再算一次百分比**——
    // 反过来（每个 content_type 各自整除取整，再把同领域的取整结果相加）会让
    // 截断误差按类型个数累积：code/shell/log 各占 1/3 时，各自取整得 33，
    // 合并后“代码”只有 99%，类型越多缺口越大。
    let total_ct: u32 = raw.content_type_counts.iter().map(|(_, c)| c).sum();
    let mut merged: std::collections::HashMap<&'static str, u32> = std::collections::HashMap::new();
    for (ct, c) in &raw.content_type_counts {
        // 同领域合并（如 code/shell/log 都是"代码"）
        *merged.entry(domain_label(ct)).or_insert(0) += *c;
    }
    let mut domains: Vec<DomainShare> = merged
        .into_iter()
        .map(|(domain, c)| DomainShare {
            domain: domain.to_string(),
            // 除零保护：没有任何内容类型样本时 total_ct = 0。
            // 走 u64 再转回：事件量到千万级时 c * 100 在 u32 里会溢出。
            pct: if total_ct > 0 {
                ((c as u64 * 100) / total_ct as u64) as u32
            } else {
                0
            },
        })
        .collect();
    // 同占比时再按领域名排：HashMap 的遍历顺序不确定，不加这一层输出会每次不一样
    domains.sort_by(|a, b| b.pct.cmp(&a.pct).then(a.domain.cmp(&b.domain)));

    // 高频动作
    let top_actions: Vec<TopAction> = raw
        .action_counts
        .iter()
        .take(8)
        .map(|(action_id, count)| TopAction {
            action_id: action_id.clone(),
            count: *count,
        })
        .collect();

    // 活跃时段
    let total_h = raw.total_events.max(1);
    let mut hours: Vec<HourSegment> = HOUR_SEGMENTS
        .iter()
        .map(|(label, range)| {
            let c: u32 = raw
                .hour_counts
                .iter()
                .filter(|(h, _)| range.contains(h))
                .map(|(_, c)| c)
                .sum();
            HourSegment {
                label: label.to_string(),
                pct: (c * 100 / total_h) as u32,
            }
        })
        .collect();
    hours.sort_by(|a, b| b.pct.cmp(&a.pct));

    // 风格偏好：偏好指令 + 被改率
    let mut prefs: Vec<PrefItem> = raw
        .prefs
        .iter()
        .map(|p| PrefItem {
            action_id: p.action_id.clone(),
            preference: p.preference.clone(),
            edit_rate: raw
                .feedback
                .iter()
                .find(|f| f.action_id == p.action_id)
                .map(|f| f.edit_rate)
                .unwrap_or(0.0),
        })
        .collect();
    // 没有偏好指令但被改率高的动作 → 提示候选（供前端"一键加偏好"）
    for f in &raw.feedback {
        if f.total >= 5 && f.edit_rate >= 0.4 && !prefs.iter().any(|p| p.action_id == f.action_id) {
            prefs.push(PrefItem {
                action_id: f.action_id.clone(),
                preference: String::new(),
                edit_rate: f.edit_rate,
            });
        }
    }
    prefs.sort_by(|a, b| b.edit_rate.partial_cmp(&a.edit_rate).unwrap_or(std::cmp::Ordering::Equal));

    let sample_events = raw.total_events;
    let confidence = (sample_events as f32 / 300.0).clamp(0.0, 1.0);

    UserProfile {
        role_scores,
        domains,
        top_actions,
        hours,
        prefs,
        overrides: serde_json::Value::Null,
        sample_events,
        confidence,
    }
}

/// 角色 → 擅长动作（画像驱动推荐的加成来源）。
/// 权重 0~1：该动作对判断"这个角色"的代表性。
fn role_actions(role: &str) -> &'static [(&'static str, f32)] {
    match role {
        "developer" => &[
            ("ai-explain-code", 1.0),
            ("json_format", 0.9),
            ("sql-in", 0.8),
            ("ai-commit-message", 0.7),
            ("sql_format", 0.6),
        ],
        "research" => &[("url-summary", 1.0), ("ai-summarize", 0.7)],
        "writer" => &[("ai-polish", 1.0), ("ai-rewrite", 0.9), ("ai-merge-polish", 0.7)],
        "comm" => &[("ai-reply-draft", 1.0)],
        "ops" => &[
            ("ai-weekly-report", 1.0),
            ("ai-tabulate", 0.7),
            ("mask-sensitive", 0.5),
        ],
        "data" => &[
            ("query-result-to-sql", 1.0),
            ("config_to_json", 0.6),
            ("json_format", 0.5),
        ],
        _ => &[],
    }
}

/// 一条动作加成（画像 v2 推荐注入）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionBoost {
    pub action_id: String,
    /// 排序乘法加成（1 + boost 作为 roleFactor）。
    pub boost: f32,
}

/// 画像驱动的推荐加成：主导/次要角色 → 该角色擅长动作的加成表。
///
/// 只返回 ≥0.35 置信度的角色贡献；同一动作取各角色加成最大值（不叠加，防雪球）。
/// 前端 recommendScored 排序时乘 roleFactor = 1 + boost。
#[tauri::command]
pub fn profile_action_boosts(store: State<DataStore>) -> Result<Vec<ActionBoost>, String> {
    let raw = store.profile_raw_stats(PROFILE_DAYS)?;
    let profile = build_profile(&raw);
    let mut boosts: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
    for rs in &profile.role_scores {
        if rs.score < 0.35 {
            continue;
        }
        for (action, w) in role_actions(&rs.role) {
            let b = rs.score * w * 0.35;
            let e = boosts.entry(action.to_string()).or_insert(0.0);
            if b > *e {
                *e = b;
            }
        }
    }
    let mut out: Vec<ActionBoost> = boosts
        .into_iter()
        .map(|(action_id, boost)| ActionBoost { action_id, boost })
        .filter(|a| a.boost > 0.05)
        .collect();
    out.sort_by(|a, b| b.boost.partial_cmp(&a.boost).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

// ===================== 出网载荷（唯一把画像发给云端第三方的地方） =====================

/// action_id → 人类可读名称（出网前必做的翻译）。
///
/// 内置动作的 id 还算可读（`ai-translate`），但**自定义动作的 id 是 uuid**
/// （`uuid::Uuid::new_v4()`，见 `data_store::ai_action`）。把 uuid 发给模型，
/// 它要么忽略要么瞎猜：白烧 token，还让画像描述质量静默变差。
///
/// **自定义名称必须过和偏好指令同一套敏感判定**：内置 `label` 是编译期常量，
/// 而自定义名称是**用户自由输入的文本**——把 uuid 换成它，等于新开了一条用户
/// 文本出网通道，用户完全可能把密钥之类的东西打进动作名里。所以这里复用
/// [`sanitize_sensitive_text`]（就是 [`sanitize_profile`] 用的那个判定源），
/// 命中就退回 uuid：宁可发个没信息量的 id，也不能把疑似敏感的用户文本送出去。
///
/// 查不到时（自定义动作已被删、或前端本地变换如 `json_format` 不在两张表里）
/// **回退原始 id 而不是丢弃这一项**——丢了会让统计看起来比实际少。
fn display_action_name(id: &str, custom_action_name: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(a) = crate::ai::actions::find_action(id) {
        return a.label.to_string();
    }
    if let Some(name) = custom_action_name(id) {
        let name = name.trim();
        if !name.is_empty() && sanitize_sensitive_text(name).is_none() {
            return name.to_string();
        }
    }
    id.to_string()
}

/// 组装 [`profile_refine`] 的出网载荷。
///
/// 从 `profile_refine` 里抽出来是为了能单测：原命令是 `async` 且要 `AppHandle`，
/// 而这里决定的是"到底把什么字节发给第三方"，是隐私红线，必须有测试盯着。
/// `custom_action_name` 把"查自定义动作名"这件需要 `DataStore` 的事隔开。
///
/// 入参 `profile` **必须已经过 [`sanitize_profile`]**：本函数只负责把已被换成
/// [`HIDDEN`] 占位文案的偏好项整条剔除（占位文案发给模型是纯噪声：它描述的是
/// "这里有东西被藏了"，对生成画像描述零信息量），**不重复做敏感判定**。
fn build_refine_input(
    profile: &UserProfile,
    custom_action_name: &dyn Fn(&str) -> Option<String>,
) -> serde_json::Value {
    let prefs: Vec<String> = profile
        .prefs
        .iter()
        .filter(|p| !p.preference.is_empty() && p.preference != HIDDEN)
        .map(|p| {
            format!(
                "{}：{}",
                display_action_name(&p.action_id, custom_action_name),
                p.preference
            )
        })
        .collect();
    serde_json::json!({
        "角色概率": profile.role_scores.iter().take(3)
            .map(|r| format!("{} {:.0}%", r.label, r.score * 100.0)).collect::<Vec<_>>(),
        "内容领域": profile.domains.iter()
            .map(|d| format!("{} {}%", d.domain, d.pct)).collect::<Vec<_>>(),
        "高频动作": profile.top_actions.iter().take(6)
            .map(|a| format!(
                "{}（{} 次）",
                display_action_name(&a.action_id, custom_action_name),
                a.count
            )).collect::<Vec<_>>(),
        "活跃时段": profile.hours.iter()
            .map(|h| format!("{} {}%", h.label, h.pct)).collect::<Vec<_>>(),
        "风格偏好": prefs,
        "样本量": profile.sample_events,
    })
}

// ===================== 命令 =====================

/// LLM 精炼画像（V3-C）：把统计画像润色成一段自然语言描述。
///
/// 出网内容 = **纯统计值**（角色概率 / 领域占比 / 动作名 / 时段 / 偏好指令），
/// 不含任何内容文本；过日预算；计入用量明细。
///
/// 这是全项目**唯一把用户画像发往云端第三方**的路径，所以：
/// ① 敏感判定只用 [`sanitize_profile`]（和写本地文件的两条路径同一个源，
///    不在这里另写一份）；② 载荷组装在 [`build_refine_input`] 里，那里有单测。
/// 手动触发（按钮），不缓存——每次生成都是用户主动、可见的一次出网。
#[tauri::command]
pub async fn profile_refine(app: tauri::AppHandle) -> Result<String, String> {
    // 1. 配置 + 密钥（块内取，锁不跨 await）
    let (cfg, key) = {
        let store = app.state::<DataStore>();
        let cfg = crate::commands::ai::read_ai_config(&store)?;
        let dir = crate::commands::ai::ai_data_dir(&app)?;
        let key = crate::ai::secret_store::load_key(&dir, &cfg.provider)?.unwrap_or_default();
        if cfg.spec().needs_key && key.trim().is_empty() {
            return Err("未配置当前服务商的 API Key".to_string());
        }
        (cfg, key)
    };
    if !cfg.enabled {
        return Err("AI 功能未启用".to_string());
    }
    cfg.validate()?;
    let spec = cfg.spec();

    // 2. 画像数据（实时聚合，纯统计）
    let raw = app.state::<DataStore>().profile_raw_stats(PROFILE_DAYS)?;
    let profile = build_profile(&raw);
    if profile.sample_events < 10 {
        return Err("行为样本不足（至少需要 10 条操作记录），暂时无法生成可靠的画像描述".to_string());
    }

    // 3. 敏感清洗：走和 profile_export / profile_install_skill **完全同一个**
    //    `sanitize_profile`。之前这里内联了一份 `!is_secret(..)` 过滤，功能上与清洗
    //    等价，但方向是反的：强保护装在"写本地文件"上，而"发给云端第三方"——后果最
    //    严重的这条——用另一份实现。以后有人扩展 `sanitize_profile`（比如加上对其它
    //    字段的清洗），出网路径不会自动获得那个改进。现在出网只认这一个判定源。
    let profile = sanitize_profile(profile);

    // 4. 组装出网载荷。自定义动作名要查库，闭包在这里注入；同时用块把 `State` 关住，
    //    不让它跨过后面的 `.await`（与本函数开头取密钥时同一个理由）。
    let input = {
        let store = app.state::<DataStore>();
        build_refine_input(&profile, &|id| {
            store.ai_custom_action(id).ok().flatten().map(|a| a.name)
        })
    };

    // 5. 预算检查（本地厂商零费用跳过）
    if !spec.is_local() {
        let today = app.state::<DataStore>().ai_usage_daily(1)?;
        let today_row = today.first().cloned().unwrap_or_default();
        if let Err((spent, budget_usd)) = crate::ai::budget::check(&today_row, cfg.daily_budget_usd()) {
            return Err(format!(
                "今日预算已用完（已用 ${:.2}，上限 ${:.2}）——画像精炼需要出网计费",
                spent, budget_usd
            ));
        }
    }

    // 6. 生成
    let system = "你是用户画像分析师。根据提供的行为统计数据，用简体中文写 2~3 句自然连贯的用户画像描述（像人话，不是列表）。只描述统计里能看到的事实，不编造、不说教、不用敬语。这段描述会被粘贴给其它 AI 工具，让它在任务开始前快速了解用户。";
    let user = format!("行为统计数据：\n{}", serde_json::to_string_pretty(&input).map_err(|e| e.to_string())?);
    let started = std::time::Instant::now();
    let result = crate::ai::chat(&cfg, &key, Some(system), &user, Some(600)).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    // 7. 用量记账（失败也记，账目才对得上）
    let outcome = match result {
        Ok(o) => o,
        Err(e) => {
            let msg = e.to_string();
            let _ = app.state::<DataStore>().ai_usage_add(&crate::data_store::AiUsageEntry {
                action_id: "profile-refine".to_string(),
                provider: spec.id.to_string(),
                model: cfg.effective_model(),
                prompt_tokens: 0,
                completion_tokens: 0,
                cost_usd: 0.0,
                cached: false,
                latency_ms,
                ok: false,
                error: Some(msg.clone()),
            });
            return Err(msg);
        }
    };
    let _ = app.state::<DataStore>().ai_usage_add(&crate::data_store::AiUsageEntry {
        action_id: "profile-refine".to_string(),
        provider: spec.id.to_string(),
        model: outcome.model.clone(),
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        cost_usd: crate::ai::budget::estimate_cost(spec, outcome.prompt_tokens, outcome.completion_tokens),
        cached: false,
        latency_ms,
        ok: true,
        error: None,
    });
    Ok(outcome.content)
}

/// 画像查询（实时聚合 + 用户覆盖合并）。
#[tauri::command]
pub fn profile_get(store: State<DataStore>) -> Result<UserProfile, String> {
    let raw = store.profile_raw_stats(PROFILE_DAYS)?;
    let mut profile = build_profile(&raw);
    // 用户覆盖（config `profile_overrides` JSON 对象，如 {"role": "developer"}）
    let cfg = store.get_config()?;
    profile.overrides = cfg
        .get("profile_overrides")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok(profile)
}

/// 用户修正画像字段（写入 config `profile_overrides`，如 role / domain）。
#[tauri::command]
pub fn profile_set_override(
    store: State<DataStore>,
    key: String,
    value: String,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("key 不能为空".to_string());
    }
    let mut raw = store.get_config()?;
    if let Some(obj) = raw.as_object_mut() {
        let overrides = obj
            .entry("profile_overrides".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(m) = overrides {
            if value.trim().is_empty() {
                m.remove(&key);
            } else {
                m.insert(key, serde_json::Value::String(value.trim().to_string()));
            }
        }
    }
    store.save_config(&raw)?;
    Ok(())
}

/// 一键安装为 Claude Code / Cursor 的 skill：
/// 写入 `~/.claude/skills/pastepanda-profile/SKILL.md` + `references/profile.json`。
/// 返回安装目录（前端提示用）。全程本地写文件，无网络。
///
/// `categories` 与 [`profile_export`] 同义（见 [`cat_filter`]）：之前这里没有这个
/// 参数、写死 `|_| true`，于是同一个面板上"预览"按勾选过滤、"安装"落盘却是全量。
/// 注意只有 SKILL.md 受它影响；`references/profile.json` 与 skill 预览里那份一样，
/// 始终是完整快照（json 的定位就是完整结构化快照，导出的 json 分支同样不过滤）。
#[tauri::command]
pub fn profile_install_skill(
    store: State<DataStore>,
    categories: Option<Vec<String>>,
) -> Result<String, String> {
    let raw = store.profile_raw_stats(PROFILE_DAYS)?;
    // 同 `profile_export`：写盘前必须清洗。这条路径比导出更需要它——
    // 技能包是**直接落盘到会被 AI 工具自动读取的目录**，而不是交给用户
    // 自己处理的一串文本。之前 references/profile.json 写的是未清洗的原文。
    let profile = sanitize_profile(build_profile(&raw));
    let cfg = store.get_config()?;
    let overrides = cfg
        .get("profile_overrides")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let wanted = cat_filter(&categories);
    let md = render_md(&profile, &overrides, &wanted);
    let mut p = profile;
    p.overrides = overrides;
    let json = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录（USERPROFILE / HOME 均未设置）".to_string())?;
    let base = std::path::Path::new(&home)
        .join(".claude")
        .join("skills")
        .join("pastepanda-profile");

    let skill_md = format!(
        "---\nname: pastepanda-profile\ndescription: 用户的 PastePanda 行为画像——角色、内容领域、风格偏好与使用红线。在任何任务开始时先读此画像以贴合用户习惯。\n---\n\n{}",
        md
    );

    std::fs::create_dir_all(base.join("references")).map_err(|e| e.to_string())?;
    std::fs::write(base.join("SKILL.md"), skill_md).map_err(|e| e.to_string())?;
    std::fs::write(base.join("references").join("profile.json"), json)
        .map_err(|e| e.to_string())?;
    Ok(base.display().to_string())
}

/// 敏感内容的占位文案。
///
/// 提到模块级是因为出网路径要靠它认出"这一条被清洗过"（认出后整条剔除，
/// 见 [`build_refine_input`]）——如果继续藏在函数里，出网路径就只能自己
/// 再判一次敏感，那正是本次要消灭的"第二套判定"。
const HIDDEN: &str = "（已隐藏：内容疑似敏感，未写入导出）";

/// 敏感文本的**唯一判定源**：疑似敏感返回 `Some(占位文案)`，干净返回 `None`。
///
/// 全文件只有这里调 `is_secret`。所有"要把数据拿出去"的路径——写本地文件的
/// [`profile_export`] / [`profile_install_skill`]，以及真的发去云端第三方的
/// [`profile_refine`]——都必须经由它或 [`sanitize_profile`]，不许各自内联一份
/// 判定。理由：内联版本改一处会漏另一处，而漏掉的偏偏可能是出网那条。
fn sanitize_sensitive_text(text: &str) -> Option<&'static str> {
    if text.trim().is_empty() {
        return None;
    }
    if ContentClassifier::new().is_secret(text) {
        Some(HIDDEN)
    } else {
        None
    }
}

/// 导出 / 出网前的敏感清洗：把看上去像密钥的偏好指令换成占位文案。
///
/// **换而不是删**：删了用户不知道有东西被藏了，以为自己的偏好没存上。
/// （唯一例外是出网载荷——占位文案对模型是纯噪声，[`build_refine_input`] 会把
/// 已被替换的整条剔除。但"什么算敏感"仍然只由这里和
/// [`sanitize_sensitive_text`] 决定，出网路径不做自己的判断。）
///
/// 以后要扩展清洗范围（比如再洗某个新字段），改这一个函数即可，
/// 三条对外路径同时受益。
fn sanitize_profile(mut p: UserProfile) -> UserProfile {
    for item in &mut p.prefs {
        if let Some(hidden) = sanitize_sensitive_text(&item.preference) {
            item.preference = hidden.to_string();
        }
    }
    p
}

/// 大类过滤器的**唯一实现**：`profile_export` 与 `profile_install_skill` 共用一份。
///
/// `None` 与空数组必须分开判，这是两个 bug 的共同根因：
/// - `None`——调用方没表态，视为全部大类；
/// - `Some([])`——用户把四个勾**全取消了**，一个大类都不要（`render_md` 尾部
///   早就写好了「（未选择任何导出类别）」兜底，之前那个分支永远走不到）；
/// - `Some([..])`——只要列出的那些。
///
/// 之前两个命令各写一份闭包：导出那份把空数组当"全部"，用户全取消勾选拿到的却是
/// 全量画像；安装那份直接写死 `|_| true`，导致同一个面板上预览按勾选过滤、落盘
/// 却是全量。同一个语义分两处实现，改一处必然漏另一处——所以收成一份。
fn cat_filter(categories: &Option<Vec<String>>) -> impl Fn(&str) -> bool + '_ {
    move |cat: &str| match categories {
        None => true,
        // 空数组走到这里 `any` 恒为 false，正是"一个都不要"
        Some(cats) => cats.iter().any(|c| c == cat),
    }
}

/// 导出画像。format: `md`（5 大类通用格式）| `json`（结构化）| `skill`（SKILL.md 包）。
/// categories: 大类子集（md/skill 生效），如 ["profession","preferences","instructions"]；
/// 语义见 [`cat_filter`]：不传 = 全部，空数组 = 一个都不要。导出前过敏感清洗（兜底）。
#[tauri::command]
pub fn profile_export(
    store: State<DataStore>,
    format: String,
    categories: Option<Vec<String>>,
) -> Result<String, String> {
    let raw = store.profile_raw_stats(PROFILE_DAYS)?;
    // 清洗必须在这一处做，而不是交给各个渲染分支。
    // 之前只有 md 路径过了 is_secret，json 直接 to_string_pretty 原样输出；
    // 而 skill 格式**两份都包**——md 里写着已隐藏，同一个文件下方的
    // references/profile.json 里就是明文。而导出物是专门给外部 AI 工具读的。
    //
    // 注意：`profile_get`（界面展示）故意**不**清洗——那是用户看自己的数据，
    // 对自己遮蔽没有意义；只有“要拿出去”的路径才需要清洗。
    let profile = sanitize_profile(build_profile(&raw));
    let cfg = store.get_config()?;
    let overrides = cfg
        .get("profile_overrides")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let wanted = cat_filter(&categories);

    match format.as_str() {
        "json" => {
            let mut p = profile;
            p.overrides = overrides;
            serde_json::to_string_pretty(&p).map_err(|e| e.to_string())
        }
        "md" => Ok(render_md(&profile, &overrides, &wanted)),
        "skill" => {
            let md = render_md(&profile, &overrides, &wanted);
            let mut p = profile;
            p.overrides = overrides;
            let json = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;
            let mut s = String::new();
            s.push_str("# pastepanda-profile 技能包\n\n");
            s.push_str("生成时间：");
            s.push_str(&chrono::Local::now().format("%Y-%m-%d %H:%M").to_string());
            s.push_str("\n\n---\n\n");
            s.push_str("## SKILL.md\n\n");
            s.push_str("```markdown\n");
            s.push_str("---\n");
            s.push_str("name: pastepanda-profile\n");
            s.push_str("description: 用户的 PastePanda 行为画像——角色、内容领域、风格偏好与使用红线。在任何任务开始时先读此画像以贴合用户习惯。\n");
            s.push_str("---\n\n");
            s.push_str(&md);
            s.push_str("```\n\n---\n\n");
            s.push_str("## references/profile.json\n\n");
            s.push_str("```json\n");
            s.push_str(&json);
            s.push_str("\n```\n");
            Ok(s)
        }
        other => Err(format!("未知导出格式：{other}（支持 md / json / skill）")),
    }
}

/// 渲染 5 大类 Markdown（copy-my-profile 兼容结构）。
fn render_md(
    profile: &UserProfile,
    overrides: &serde_json::Value,
    wanted: &dyn Fn(&str) -> bool,
) -> String {
    let mut s = String::new();
    s.push_str("# 用户画像（PastePanda 生成）\n\n");
    s.push_str("> 由 PastePanda 根据最近 30 天剪贴板使用行为自动生成。\n");
    s.push_str("> 本文件仅含行为统计，不含具体内容；敏感信息已清洗。\n\n");
    let mut any = false;
    if wanted("profession") {
        s.push_str("## Profession\n\n");
        if let Some(r) = profile.role_scores.first() {
            let ov = overrides.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let role_label = if !ov.is_empty() {
                ov.to_string()
            } else {
                format!("{}（置信度 {:.0}%）", r.label, r.score * 100.0)
            };
            s.push_str(&format!("- 推断角色：{role_label}\n"));
        }
        if !profile.domains.is_empty() {
            let ds = profile
                .domains
                .iter()
                .map(|d| format!("{} {}%", d.domain, d.pct))
                .collect::<Vec<_>>()
                .join(" · ");
            s.push_str(&format!("- 内容领域：{ds}\n"));
        }
        s.push('\n');
        any = true;
    }
    if wanted("projects") && !profile.top_actions.is_empty() {
        s.push_str("## Projects\n\n");
        s.push_str("- 高频动作：");
        let acts = profile
            .top_actions
            .iter()
            .map(|a| format!("{}（{} 次）", a.action_id, a.count))
            .collect::<Vec<_>>()
            .join(" · ");
        s.push_str(&format!("{acts}\n"));
        s.push_str(&format!(
            "- 活跃时段：{}\n\n",
            profile
                .hours
                .iter()
                .map(|h| format!("{} {}%", h.label, h.pct))
                .collect::<Vec<_>>()
                .join(" · ")
        ));
        any = true;
    }
    if wanted("preferences") && !profile.prefs.is_empty() {
        s.push_str("## Preferences\n\n");
        // 敏感清洗已在 `sanitize_profile()` 统一做过（包括 json / skill 路径），
        // 这里只管渲染。之前在这里判的后果是两个：json 没清洗；且当命中敏感时
        // 两个分支条件互斥，敏感偏好会**静默消失**，那句“已隐藏”永远不会被输出。
        for p in &profile.prefs {
            let pref_text = p.preference.clone();
            if !pref_text.is_empty() {
                s.push_str(&format!("- {}：{}\n", p.action_id, pref_text));
            } else {
                s.push_str(&format!(
                    "- {}：结果常被修改（被改率 {:.0}%）——建议为该动作设定偏好\n",
                    p.action_id,
                    p.edit_rate * 100.0
                ));
            }
        }
        s.push('\n');
        any = true;
    }
    if wanted("instructions") {
        s.push_str("## Instructions\n\n");
        s.push_str("- 所有输出使用简体中文\n");
        s.push_str("- 涉及密钥/凭证/敏感信息时拒绝处理，且不写入任何记忆\n");
        s.push_str("- 需要联网或调用云端 API 前先征得确认\n");
        if let serde_json::Value::Object(m) = overrides {
            if let Some(v) = m.get("instructions") {
                s.push_str(&format!("- （用户自定义）{}\n", v.as_str().unwrap_or("")));
            }
        }
        s.push('\n');
        any = true;
    }
    if !any {
        s = "# 用户画像\n\n（未选择任何导出类别）\n".to_string();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 隐私回归：导出 / 安装技能包前，疑似密钥的偏好指令不得原样带出。
    ///
    /// 之前只有 md 渲染路径判了 is_secret：json 直接 to_string_pretty，
    /// skill 格式两份都包（md 写着已隐藏、旁边 profile.json 就是明文），
    /// 而 `profile_install_skill` 更是直接把未清洗的 json 写到盘上。
    #[test]
    fn test_sanitize_profile_hides_secret_preference() {
        let mut p = build_profile(&raw_with(&[("ai-translate", 5)], &[("text", 5)]));
        p.prefs = vec![
            PrefItem {
                action_id: "ai-translate".to_string(),
                preference: "译文更简洁".to_string(),
                edit_rate: 0.2,
            },
            PrefItem {
                action_id: "ai-rewrite".to_string(),
                // 看上去像密钥的偏好（用户可能误粘进去过）
                preference: concat!("sk-", "abcdef1234567890abcdef1234567890").to_string(),
                edit_rate: 0.9,
            },
        ];

        let out = sanitize_profile(p);
        assert_eq!(out.prefs[0].preference, "译文更简洁", "普通偏好不能被动");
        assert!(
            !out.prefs[1].preference.contains("abcdef1234567890"),
            "疑似密钥必须被替掉，实际：{:?}",
            out.prefs[1].preference
        );
        assert!(
            out.prefs[1].preference.contains("已隐藏"),
            "要给占位文案而不是静默删掉——否则用户以为自己的偏好没存上"
        );
    }

    /// 隐私回归：疑似密钥的偏好指令不得进入**出网载荷**。
    ///
    /// 单测 `sanitize_profile` 本身不够：出网路径曾经自己内联了一份 is_secret
    /// 过滤，改 `sanitize_profile` 影响不到它。这条直接测 `profile_refine`
    /// 真正用的那段组装逻辑。
    #[test]
    fn test_refine_input_drops_secret_preference() {
        let mut p = build_profile(&raw_with(&[("ai-translate", 5)], &[("text", 5)]));
        p.prefs = vec![
            PrefItem {
                action_id: "ai-translate".to_string(),
                preference: "译文更简洁".to_string(),
                edit_rate: 0.2,
            },
            PrefItem {
                action_id: "ai-rewrite".to_string(),
                preference: concat!("sk-", "abcdef1234567890abcdef1234567890").to_string(),
                edit_rate: 0.9,
            },
        ];

        // 与 profile_refine 同次序：先 sanitize_profile，再组装载荷
        let input = build_refine_input(&sanitize_profile(p), &|_| None);
        let sent = serde_json::to_string(&input).unwrap();

        assert!(
            !sent.contains("abcdef1234567890"),
            "疑似密钥的偏好绝不能出网，实际载荷：{sent}"
        );
        assert!(
            !sent.contains("已隐藏"),
            "占位文案也不应发给模型——它对生成画像描述是纯噪声"
        );
        assert!(sent.contains("译文更简洁"), "普通偏好要照发");
        let prefs = input.get("风格偏好").unwrap().as_array().unwrap();
        assert_eq!(prefs.len(), 1, "只剩那一条正常偏好");
        assert_eq!(prefs[0].as_str().unwrap(), "翻译：译文更简洁", "偏好里的 id 也要换成名称");
    }

    /// action_id → 名称：内置动作换成可读 label；两张表都查不到就回退原 id。
    #[test]
    fn test_refine_input_maps_builtin_action_names() {
        let mut p = build_profile(&raw_with(&[("ai-translate", 9)], &[("text", 9)]));
        p.top_actions = vec![
            TopAction { action_id: "ai-translate".to_string(), count: 9 },
            // 前端本地变换，不在 ACTIONS 也不在自定义表里
            TopAction { action_id: "json_format".to_string(), count: 4 },
        ];
        let acts = build_refine_input(&p, &|_| None);
        let acts = acts.get("高频动作").unwrap().as_array().unwrap();
        assert_eq!(acts[0].as_str().unwrap(), "翻译（9 次）", "内置动作要发可读名");
        assert_eq!(
            acts[1].as_str().unwrap(),
            "json_format（4 次）",
            "查不到就回退原 id，不能把这一项丢掉"
        );
    }

    /// 自定义动作：uuid 要换成用户起的名字，否则模型只能瞎猜。
    #[test]
    fn test_refine_input_maps_custom_action_name() {
        let uuid = "a3f1c2e8-4b91-4d2a-8f77-9c1e2f3a4b5c";
        let mut p = build_profile(&raw_with(&[("ai-translate", 3)], &[("text", 3)]));
        p.top_actions = vec![TopAction { action_id: uuid.to_string(), count: 12 }];
        let input = build_refine_input(&p, &|id| {
            if id == uuid {
                Some("转成周报口吻".to_string())
            } else {
                None
            }
        });
        let acts = input.get("高频动作").unwrap().as_array().unwrap();
        assert_eq!(acts[0].as_str().unwrap(), "转成周报口吻（12 次）");
    }

    /// 隐私：自定义动作名是**用户自由输入的文本**，把 uuid 换成它等于新开了一条
    /// 用户文本出网通道。疑似敏感的名字必须退回 uuid，不能原样发出去——
    /// 否则修好了正确性同时开了一个隐私洞。
    #[test]
    fn test_refine_input_hides_secret_custom_action_name() {
        let uuid = "b7d2f0a1-1111-2222-3333-444455556666";
        // 长度 24（正好卡在 MAX_ACTION_NAME_CHARS 上），是个真能存进库的名字
        let secret_name = concat!("sk-", "live-a1b2c3d4e5f6g7h8");
        let mut p = build_profile(&raw_with(&[("ai-translate", 3)], &[("text", 3)]));
        p.top_actions = vec![TopAction { action_id: uuid.to_string(), count: 7 }];
        p.prefs = vec![PrefItem {
            action_id: uuid.to_string(),
            preference: "短一点".to_string(),
            edit_rate: 0.5,
        }];

        let input = build_refine_input(&sanitize_profile(p), &|_| Some(secret_name.to_string()));
        let sent = serde_json::to_string(&input).unwrap();

        assert!(
            !sent.contains("a1b2c3d4e5f6"),
            "疑似敏感的自定义动作名不得出网，实际载荷：{sent}"
        );
        assert!(
            sent.contains(uuid),
            "应该退回 uuid，而不是把这一项整条丢掉（丢了统计会变少）：{sent}"
        );
    }

    fn raw_with(actions: &[(&str, u32)], ctypes: &[(&str, u32)]) -> ProfileRawStats {
        ProfileRawStats {
            action_counts: actions.iter().map(|(a, c)| (a.to_string(), *c)).collect(),
            content_type_counts: ctypes.iter().map(|(c, n)| (c.to_string(), *n)).collect(),
            hour_counts: vec![(10, 3)],
            feedback: vec![],
            prefs: vec![],
            total_events: actions.iter().map(|(_, c)| c).sum(),
        }
    }

    #[test]
    fn test_developer_dominant_with_code_actions() {
        let raw = raw_with(
            &[("ai-explain-code", 5), ("json_format", 4), ("sql-in", 2)],
            &[("code", 6), ("json", 4)],
        );
        let p = build_profile(&raw);
        let top = p.role_scores.first().unwrap();
        assert_eq!(top.role, "developer");
        assert!((top.score - 1.0).abs() < 1e-6, "最高分应归一为 1.0");
    }

    #[test]
    fn test_writer_dominant_with_reply_actions() {
        let raw = raw_with(&[("ai-polish", 6), ("ai-rewrite", 4)], &[("text", 10)]);
        let p = build_profile(&raw);
        assert_eq!(p.role_scores.first().unwrap().role, "writer");
    }

    #[test]
    fn test_domains_merged_and_sorted() {
        let raw = raw_with(
            &[("ai-explain-code", 2)],
            &[("code", 6), ("shell", 3), ("url", 1)],
        );
        let p = build_profile(&raw);
        // code + shell 都归"代码"，应合并
        let code = p.domains.iter().find(|d| d.domain == "代码").unwrap();
        assert_eq!(code.pct, 90, "代码 9/10 = 90%");
        assert!(p.domains[0].domain == "代码", "代码应排最前");
    }

    /// 回归：同领域的多个 content_type 各占 1/3 时，合并后必须是 100% 而不是 99%。
    ///
    /// 以前是先对每个 content_type 整除取整、再把取整结果相加，截断误差按类型
    /// 个数累积（3 个类型 → 33+33+33 = 99），用户看到的领域占比之和明显少于 100。
    #[test]
    fn test_domain_pct_no_rounding_gap_when_merged() {
        // code / shell / log 都归"代码"，各 3 条 → 合并后应为 9/9 = 100%
        let raw = raw_with(
            &[("ai-explain-code", 9)],
            &[("code", 3), ("shell", 3), ("log", 3)],
        );
        let p = build_profile(&raw);
        let code = p.domains.iter().find(|d| d.domain == "代码").unwrap();
        assert_eq!(
            code.pct, 100,
            "先合并计数再算百分比应得 100%（先取整再合并只有 99%），实际：{:?}",
            p.domains
        );
        assert_eq!(p.domains.len(), 1, "三个类型全归一个领域");
    }

    /// 除零保护：没有任何内容类型样本时不能 panic（total_ct = 0）。
    #[test]
    fn test_domain_pct_zero_total_no_panic() {
        let raw = raw_with(&[("ai-translate", 3)], &[]);
        let p = build_profile(&raw);
        assert!(p.domains.is_empty());
    }

    #[test]
    fn test_confidence_scales_with_samples() {
        let raw = raw_with(&[("ai-reply-draft", 20)], &[("text", 20)]);
        assert!((build_profile(&raw).confidence - 20.0 / 300.0).abs() < 0.01);
        let raw2 = raw_with(&[("ai-reply-draft", 600)], &[("text", 600)]);
        assert!((build_profile(&raw2).confidence - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_empty_profile_no_panic() {
        let raw = ProfileRawStats::default();
        let p = build_profile(&raw);
        assert!(p.role_scores.is_empty());
        assert!(p.domains.is_empty());
    }

    #[test]
    fn test_developer_role_boosts_code_actions() {
        // developer 满格 → ai-explain-code 拿到 max 加成
        let raw = raw_with(
            &[("ai-explain-code", 5), ("json_format", 4)],
            &[("code", 6), ("json", 4)],
        );
        let p = build_profile(&raw);
        let top = p.role_scores.first().unwrap();
        assert_eq!(top.role, "developer");
        assert!((top.score - 1.0).abs() < 1e-6);

        // 手动验证加成计算（developer 1.0 × ai-explain-code 1.0 × 0.35 = 0.35）
        let dev = role_actions("developer");
        let ec = dev.iter().find(|(a, _)| *a == "ai-explain-code").unwrap();
        assert!((ec.1 - 1.0).abs() < 1e-6);
        let boost = top.score * ec.1 * 0.35;
        assert!((boost - 0.35).abs() < 1e-6);
    }

    #[test]
    fn test_low_confidence_role_no_boost() {
        // 全零数据 → 无角色 → 无加成
        let raw = ProfileRawStats::default();
        let p = build_profile(&raw);
        assert!(p.role_scores.is_empty());
        // 没有任何角色达到 0.35 → role_actions 遍历空 → 无 boost
        let mut boosts = std::collections::HashMap::new();
        for rs in &p.role_scores {
            if rs.score < 0.35 {
                continue;
            }
            for (action, w) in role_actions(&rs.role) {
                let b = rs.score * w * 0.35;
                let e = boosts.entry(action.to_string()).or_insert(0.0);
                if b > *e {
                    *e = b;
                }
            }
        }
        assert!(boosts.is_empty());
    }

    /// 大类过滤：`None`（调用方不传）= 全部。
    #[test]
    fn test_cat_filter_none_means_all() {
        let none: Option<Vec<String>> = None;
        let f = cat_filter(&none);
        for c in ["profession", "projects", "preferences", "instructions"] {
            assert!(f(c), "{c} 应当被包含");
        }
    }

    /// 大类过滤：空数组 = 一个都不要，**不是**全部。
    ///
    /// 回归测试：之前 `cats.is_empty() || …` 把空数组当成了全部，用户在导出面板里
    /// 把四个勾全取消，拿到的却是全量画像——恰好和他的意思相反。
    #[test]
    fn test_cat_filter_empty_means_none() {
        let empty: Option<Vec<String>> = Some(vec![]);
        let f = cat_filter(&empty);
        for c in ["profession", "projects", "preferences", "instructions"] {
            assert!(!f(c), "{c} 不应被包含");
        }
    }

    #[test]
    fn test_cat_filter_subset() {
        let cats = Some(vec![
            "profession".to_string(),
            "instructions".to_string(),
        ]);
        let f = cat_filter(&cats);
        assert!(f("profession"));
        assert!(f("instructions"));
        assert!(!f("projects"));
        assert!(!f("preferences"));
    }

    /// 一个大类都不选时，产物是明确的空态提示，而不是悄悄给出全量。
    #[test]
    fn test_render_md_empty_cats_yields_placeholder() {
        let p = build_profile(&raw_with(&[("ai-translate", 5)], &[("text", 5)]));
        let md = render_md(&p, &serde_json::Value::Null, &cat_filter(&Some(vec![])));
        assert!(md.contains("未选择任何导出类别"), "实际产物：{md}");
        assert!(!md.contains("## Profession"));
        assert!(!md.contains("## Instructions"));
    }

    /// 勾选子集时，未勾的大类不出现在产物里。
    ///
    /// `profile_install_skill` 与 `profile_export` 现在共用这同一个过滤器，
    /// 所以这条同时钉住了「预览与落盘一致」。
    #[test]
    fn test_render_md_respects_subset() {
        let p = build_profile(&raw_with(&[("ai-translate", 5)], &[("text", 5)]));
        let md = render_md(
            &p,
            &serde_json::Value::Null,
            &cat_filter(&Some(vec!["instructions".to_string()])),
        );
        assert!(md.contains("## Instructions"), "实际产物：{md}");
        assert!(!md.contains("## Profession"));
        assert!(!md.contains("## Projects"));
    }
}
