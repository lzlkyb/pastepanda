//! AI 编链（B）的后端：`ai_plan_chain`——让模型根据内容编一条动作流水线。
//!
//! ## 职责划分：为什么可用动作清单由前端传进来
//!
//! 链的步骤是**前端变换注册表**里的 id（`src/lib/transforms/`）——后端只认得自己的
//! AI 动作，不认识 `strip_html` / `json_format` 这些。所以清单只能前端给。
//!
//! 分工结果：**后端管出网（闸、预算、记账），前端管语义（白名单、risk、确认）**。
//! 本命令只返回模型原始文本，解析与校验全在 `src/lib/chains/planner.ts`，
//! 因为只有那里才能回答“这个 id 真存在吗”。
//!
//! ## 与 `ai_run` 的三处有意差异
//!
//! 1. **不走缓存**。编链的输入是“内容 + 当前可用动作清单”，后者会随自定义动作变，
//!    缓存命中率低而失效条件复杂，不值得；
//! 2. **只发内容前 {@link SAMPLE_CHARS} 字**。判断“这是什么、该怎么处理”不需要全文，
//!    而剪贴板里动辄几十 KB——既是钱也是隐私；
//! 3. **不拼动作偏好**（`action_prefs`）。偏好管的是“输出风格”，而这里输出的是一份
//!    JSON 结构，把“译文更简洁”之类的句子拼进来只会干扰它。
//!
//! 出网闸、预算、用量记账与 `ai_run` 完全一致——这是又一个会把剪贴板内容发出去的
//! 入口，不能因为“只是问个方案”就绕过任何一道。

use super::*;

/// 发给模型的内容样本上限。
///
/// 1500 字足够判断内容类型与处理方向（这是一段 HTML？一堆日志？一份 JSON？），
/// 而完整内容既花钱又多传了用户本不需要传的东西。
const SAMPLE_CHARS: usize = 1500;

/// 清单里最多带多少个动作。清单本身就是 prompt 的主体，不限就会被自定义动作撞破。
const MAX_ACTIONS: usize = 60;

/// 输出上限。一份 step 列表很小，但带思考的推理模型光思考就要几百 token，
/// 给小了会只得到一半 JSON（就是那个 `<think>` 截断的坑）。
const PLAN_MAX_TOKENS: u32 = 1024;

/// 前端传过来的一个可用动作。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAction {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// 按字符（非字节）截断，不切坏中文。
fn head_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    s.chars().take(n).collect()
}

/// 拼出给模型的 (system, user)。
///
/// 抽成函数是为了能单测：prompt 里“只能用清单里的 id”这句约束一旦丢了，
/// 模型就会开始编动作名，而前端白名单会把它们全丢掉——表现为“总是编不出链”。
fn build_plan_prompt(text: &str, actions: &[PlanAction]) -> (String, String) {
    let system = "你是剪贴板工具的动作编排器。用户给你一段内容和一份可用动作清单，\
你从清单里挑出 1 到 6 个动作，按执行顺序组成一条流水线（上一步的输出是下一步的输入）。\n\n硬规则：\n\
1. transformId **只能**从清单里原样复制，不得自己造名字；\n\
2. 没有合适的组合就返回空步骤，不要硬凑；\n\
3. 只输出 JSON，不要任何解释、不要代码围栅。\n\n输出格式：\n\
{\"name\":\"简短链名\",\"description\":\"一句话说明\",\"steps\":[{\"transformId\":\"xxx\"}]}"
        .to_string();

    let mut list = String::new();
    for a in actions.iter().take(MAX_ACTIONS) {
        if a.description.trim().is_empty() {
            list.push_str(&format!("- {}（{}）\n", a.id.trim(), a.label.trim()));
        } else {
            list.push_str(&format!(
                "- {}（{}）：{}\n",
                a.id.trim(),
                a.label.trim(),
                a.description.trim()
            ));
        }
    }

    let user = format!(
        "可用动作清单：\n{}\n内容（可能已截断）：\n{}",
        list,
        head_chars(text, SAMPLE_CHARS)
    );
    (system, user)
}

/// 让模型根据当前内容编一条动作链。
///
/// 返回的是**模型原始文本**（`AiRunOk.content`），由前端 `parseChainPlan` 解析 + 校验。
/// 复用 `AiRunResponse` 是因为三态（正常 / 需确认 / 超预算）跟 `ai_run` 一模一样，
/// 前端现成的分支能直接用。
///
/// 编出来的链**不会自动执行**，必须用户确认（红线①）。
#[tauri::command]
pub async fn ai_plan_chain(
    app: tauri::AppHandle,
    text: String,
    actions: Vec<PlanAction>,
    force: Option<bool>,
) -> Result<AiRunResponse, String> {
    let force = force.unwrap_or(false);

    if text.trim().is_empty() {
        return Err("内容为空，无法编链".to_string());
    }
    if actions.is_empty() {
        return Err("没有可用动作".to_string());
    }

    let (cfg, key) = {
        let store = app.state::<DataStore>();
        let cfg = read_ai_config(&store)?;
        let dir = ai_data_dir(&app)?;
        let key = secret_store::load_key(&dir, &cfg.provider)?.unwrap_or_default();
        if cfg.spec().needs_key && key.is_empty() {
            return Err("尚未配置 API Key".to_string());
        }
        (cfg, key)
    };

    if !cfg.enabled {
        return Err("AI 功能未启用".to_string());
    }
    cfg.validate()?;
    let spec = cfg.spec();

    // 出网闸：同 `ai_run`。“只是让它帮我想个方案”不是例外——内容照样要出本机。
    let classifier = ContentClassifier::new();
    if !force && !spec.is_local() && classifier.is_secret(&text) {
        return Ok(AiRunResponse::NeedsConfirm(AiRunNeedsConfirm {
            reason: "这段内容看起来是密钥或凭证。让模型编链也需要把它发到云端，确认要继续吗？"
                .to_string(),
        }));
    }

    // 预算：本地厂商零费用不受约束。守卫限在块里，锁不能跨 await。
    if !spec.is_local() {
        let today = { app.state::<DataStore>().ai_usage_today() };
        if let Err((spent_usd, budget_usd)) = budget::check(&today, cfg.daily_budget_usd()) {
            return Ok(AiRunResponse::BudgetExceeded(AiRunBudgetExceeded {
                spent_cny: spent_usd * provider::USD_TO_CNY,
                budget_cny: budget_usd * provider::USD_TO_CNY,
            }));
        }
    }

    let (system, user) = build_plan_prompt(&text, &actions);

    let started = std::time::Instant::now();
    let result =
        crate::ai::chat(&cfg, &key, Some(system.as_str()), &user, Some(PLAN_MAX_TOKENS)).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    // 用一个固定的伪动作 id 记账，让用量页能看出“编链花了多少钱”
    const PLAN_ACTION_ID: &str = "ai-plan-chain";

    let outcome = match result {
        Ok(o) => o,
        Err(e) => {
            // 失败也记：不记就对不上账（同 `ai_run`）
            let msg = e.to_string();
            record_usage(
                &app,
                AiUsageEntry {
                    action_id: PLAN_ACTION_ID.to_string(),
                    provider: spec.id.to_string(),
                    model: cfg.effective_model(),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    cost_usd: 0.0,
                    cached: false,
                    latency_ms,
                    ok: false,
                    error: Some(msg.clone()),
                },
            );
            return Err(msg);
        }
    };

    record_usage(
        &app,
        AiUsageEntry {
            action_id: PLAN_ACTION_ID.to_string(),
            provider: spec.id.to_string(),
            model: outcome.model.clone(),
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            cost_usd: budget::estimate_cost(spec, outcome.prompt_tokens, outcome.completion_tokens),
            cached: false,
            latency_ms,
            ok: true,
            error: None,
        },
    );

    Ok(AiRunResponse::Ok(AiRunOk {
        content: outcome.content,
        model: outcome.model,
        cached: false,
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        truncated: outcome.truncated,
    }))
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    fn acts() -> Vec<PlanAction> {
        vec![
            PlanAction {
                id: "strip_html".to_string(),
                label: "剥 HTML".to_string(),
                description: "去掉标签只留文字".to_string(),
            },
            PlanAction {
                id: "strip".to_string(),
                label: "去首尾空白".to_string(),
                description: String::new(),
            },
        ]
    }

    #[test]
    fn test_head_chars_does_not_split_chinese() {
        // 按字节截会把中文切成乱码，这里必须是按字符
        assert_eq!(head_chars("一二三四五", 3), "一二三");
        assert_eq!(head_chars("一二", 10), "一二");
        assert_eq!(head_chars("", 5), "");
    }

    #[test]
    fn test_prompt_lists_every_action_id() {
        let (_, user) = build_plan_prompt("随便一段内容", &acts());
        assert!(user.contains("strip_html"));
        assert!(user.contains("strip"));
        // 没写说明的动作也要在清单里，不能因为 description 为空就漏掉
        assert!(user.contains("去首尾空白"));
    }

    #[test]
    fn test_prompt_keeps_the_no_invented_ids_rule() {
        // 这句约束一旦丢掉，模型就会编动作名，而前端白名单会全丢掉——
        // 表现成“总是编不出链”，而且很难查
        let (system, _) = build_plan_prompt("x", &acts());
        assert!(system.contains("不得自己造名字"));
        assert!(system.contains("steps"));
    }

    #[test]
    fn test_prompt_truncates_long_text() {
        let long = "字".repeat(SAMPLE_CHARS + 500);
        let (_, user) = build_plan_prompt(&long, &acts());
        // 精确到上限：恰好 SAMPLE_CHARS 个在里面，多一个就不在。
        // （不能数字符总数——清单里的说明文字自己也带“字”，会多算一个）
        assert!(user.contains(&"字".repeat(SAMPLE_CHARS)));
        assert!(
            !user.contains(&"字".repeat(SAMPLE_CHARS + 1)),
            "超过上限的正文不得发出去"
        );
    }

    #[test]
    fn test_prompt_caps_action_list() {
        let many: Vec<PlanAction> = (0..(MAX_ACTIONS + 20))
            .map(|i| PlanAction {
                id: format!("act-{}", i),
                label: format!("动作{}", i),
                description: String::new(),
            })
            .collect();
        let (_, user) = build_plan_prompt("x", &many);
        assert!(user.contains(&format!("act-{}", MAX_ACTIONS - 1)));
        assert!(
            !user.contains(&format!("act-{}", MAX_ACTIONS)),
            "超出上限的动作不得进 prompt，否则自定义动作一多就把请求体撞破"
        );
    }
}
