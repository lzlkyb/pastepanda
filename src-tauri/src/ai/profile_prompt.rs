//! 画像 → system prompt 片段（D1）。
//!
//! 把「用户是怎么用这个软件的」压成一段不超 [`MAX_CHARS`] 字的中文，
//! 拼进每次 AI 调用的 system prompt。路线图里的 D1。
//!
//! **为什么是纯函数**：它决定的是“把哪些字节发给第三方”，与
//! `compose_system_with_pref` 同级别的隐私红线，必须能被测试盯着。
//! 所以时间（`hour`）也是参数而不是内部调 `Local::now()`——
//! 否则“高峰时段”那条规则永远只能在特定钟点跑测试。
//!
//! **不自己重写分类逻辑**：角色归一化、内容领域合并（code/shell/log → “代码”）、
//! 时段分桶这些事 `build_profile` 已经做完了，这里直接消费它的产物。
//! 再写一份 `ct == "json"` 之类的判断就是第二份真相，两边迟早漂。
//!
//! **路线图映射表里的“语言倾向 → 默认使用中文表达”没做**：
//! `ProfileRawStats` 里根本没有语言维度的统计（只有动作/内容类型/时段/反馈/偏好）。
//! 为一条提示词新加一整套语言统计不划算，也超出了 D1 的范围。

use crate::commands::profile::{build_profile, UserProfile, HOUR_SEGMENTS};
use crate::data_store::ProfileRawStats;

/// 片段长度上限（按字符数，中文一字算一个）。
///
/// 与 `action_prefs` 各自 ≤300：两段加起来再多就开始抢正文的注意力了。
const MAX_CHARS: usize = 300;

/// 低于这个样本量不注入任何东西。
///
/// 30 次动作以下的“画像”基本是噪声：装完软件头一天随手试了几次 JSON 格式化，
/// 不能就让模型以为“这人是写代码的”。宁可不注，不能注错。
pub const MIN_EVENTS: u32 = 30;

/// 主导角色的最低归一化得分。`role_scores` 已按最高分归一化，首位恒为 1.0，
/// 所以这里卡的是**次位与首位的差距**：两个角色咬得很紧时不下结论。
const ROLE_LEAD_GAP: f32 = 0.25;

/// 领域 / 时段的最低占比（%）。
const SHARE_MIN: u32 = 40;

/// 反馈条的门槛：样本够 + 确实常被改。
///
/// 样本阈值比 `profile_action_boosts` 的 5 高：那边影响的只是本地排序，错了代价小；
/// 这边会真的发一句话给模型，错了会直接把输出带偏。
const FEEDBACK_MIN_TOTAL: u32 = 10;
const FEEDBACK_MIN_RATE: f64 = 0.4;

/// 角色 → 注入句。角色 id 与 `commands/profile.rs` 的 `ROLES` 一致。
///
/// 每句都是**说怎么写，不是说用户是谁**：“用户是开发者”对模型没有可执行含义，
/// “遇代码优先解释思路而非逐句翻译”才能真正改变输出。
fn role_line(role: &str) -> Option<&'static str> {
    Some(match role {
        "developer" => "用户经常处理代码，遇代码优先解释思路与意图，而非逐句翻译。",
        "data" => "用户常做数据与 SQL 处理，保持字段名与结构完整，不自行改写。",
        "writer" => "用户以文案写作为主，措辞自然、避免翻译腔与冗余修饰。",
        "research" => "用户常做资料检索与归纳，先给结论和要点，再给展开。",
        "comm" => "用户常写沟通回复，语气得体、篇幅克制，输出能直接发送。",
        "ops" => "用户常做运营与行政整理，输出条理清晰、便于直接汇报。",
        _ => return None,
    })
}

/// 当前时刻是否落在用户的高峰时段里。
///
/// **这里是路线图纠正过的那个坑**：早期方案的触发条件是“长期高峰在 9-11 点”
/// 但文案写“当前处于高频时段”——高峰在上午的人晚上十点用也会被注入这句，
/// 模型拿到一个与事实相反的前提。所以必须拿 `hour` 真去比区间。
fn is_peak_hour(profile: &UserProfile, hour: u32) -> bool {
    let Some(top) = profile.hours.first() else {
        return false;
    };
    if top.pct < SHARE_MIN {
        return false;
    }
    HOUR_SEGMENTS
        .iter()
        .find(|(label, _)| *label == top.label)
        .is_some_and(|(_, range)| range.contains(&(hour as i64)))
}

/// 本次调用的动作是不是“产物常被改”的那一个。
///
/// 读 `raw.feedback` 而不是 `profile.prefs`：后者的 `PrefItem` 只带 `edit_rate`、
/// **丢了 `total`**，拿不到样本量就卡不住噪声（一次使用改一次 = 100% 编辑率）。
fn feedback_line(raw: &ProfileRawStats, action_id: Option<&str>) -> Option<&'static str> {
    let aid = action_id?;
    raw.feedback
        .iter()
        .find(|f| f.action_id == aid)
        .filter(|f| f.total >= FEEDBACK_MIN_TOTAL && f.edit_rate > FEEDBACK_MIN_RATE)
        .map(|_| "用户经常手动修改本动作的输出，请尽量一次到位、贴合其常见偏好。")
}

/// 主导角色（与次位拉开足够差距才算数）。
fn lead_role(profile: &UserProfile) -> Option<&str> {
    let top = profile.role_scores.first()?;
    let second = profile.role_scores.get(1).map_or(0.0, |r| r.score);
    (top.score - second >= ROLE_LEAD_GAP).then_some(top.role.as_str())
}

/// 生成注入片段。没东西可说时返回空串（调用方据此决定不拼）。
///
/// - `action_id`：本次要跑的动作。`None` = 预览场景，反馈那一条不参与。
/// - `hour`：0~23。交给调用方传，理由见模块注释。
pub fn profile_to_prompt(raw: &ProfileRawStats, action_id: Option<&str>, hour: u32) -> String {
    if raw.total_events < MIN_EVENTS {
        return String::new();
    }
    let profile = build_profile(raw);

    // 按信息量排：角色（最稳）→ 领域 → 本动作反馈 → 时段（最弱，被截也不可惜）
    let mut lines: Vec<&str> = Vec::new();

    if let Some(line) = lead_role(&profile).and_then(role_line) {
        lines.push(line);
    }

    // 领域只补“结构化数据”这一类：“代码”领域与 developer 角色高度重叠，
    // 两句一起拼就是同一件事说两遍，白占 MAX_CHARS 的额度。
    if profile
        .domains
        .first()
        .is_some_and(|d| d.domain == "结构化数据" && d.pct >= SHARE_MIN)
    {
        lines.push("用户常处理 JSON/SQL，改写时保持原有结构与字段名不变。");
    }

    if let Some(line) = feedback_line(raw, action_id) {
        lines.push(line);
    }

    if is_peak_hour(&profile, hour) {
        lines.push("当前处于用户高频使用时段，输出保持精炼。");
    }

    // 截断按**整句**而非整字符：半句话比没这句话更害人，模型会当真去猜后半句。
    let mut out = String::new();
    for line in lines {
        if out.chars().count() + line.chars().count() > MAX_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

/// 缓存签名：片段内容变了，这个串就要变；没变就必须不变。
///
/// **直接拿片段本身算**，不另外抽一套“档位”：
/// 路线图担心的是“画像微小漂移会把 24h 缓存打穿”，而片段本身已经是离散的——
/// 它只有四句固定文案的组合，code 占比从 41% 漂到 58% 片段一个字不变。
/// 再叠一层档位映射只会多一份可能与片段脱节的真相（档位变了片段没变，或反过来）。
///
/// 取 SHA-256 前 16 位十六进制：它只是拼进 `cache_id` 再过一次哈希，不需要全长。
pub fn profile_sig(fragment: &str) -> String {
    if fragment.is_empty() {
        return String::new();
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, fragment.as_bytes());
    digest
        .as_ref()
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_store::AiFeedbackStat;

    /// 构造一份样本量足够的 raw，默认全是 developer 信号。
    fn raw_dev(events: u32) -> ProfileRawStats {
        ProfileRawStats {
            action_counts: vec![("ai-explain-code".into(), events)],
            content_type_counts: vec![("code".into(), events)],
            hour_counts: vec![(9, events)],
            feedback: vec![],
            prefs: vec![],
            total_events: events,
        }
    }

    #[test]
    fn test_样本不足不注入任何内容() {
        let raw = raw_dev(MIN_EVENTS - 1);
        assert_eq!(
            profile_to_prompt(&raw, None, 9),
            "",
            "样本不足时必须一个字不发"
        );
    }

    #[test]
    fn test_主导角色出对应的句子() {
        let out = profile_to_prompt(&raw_dev(100), None, 9);
        assert!(out.contains("遇代码优先解释思路"), "实际：{}", out);
    }

    #[test]
    fn test_角色咬得紧时不下结论() {
        // developer 与 writer 各一半，两边得分接近 → 不出角色句
        let raw = ProfileRawStats {
            action_counts: vec![("ai-explain-code".into(), 50), ("ai-polish".into(), 50)],
            content_type_counts: vec![],
            hour_counts: vec![],
            feedback: vec![],
            prefs: vec![],
            total_events: 100,
        };
        let out = profile_to_prompt(&raw, None, 9);
        assert!(!out.contains("遇代码"), "应该不下结论，实际：{}", out);
        assert!(!out.contains("文案写作"), "应该不下结论，实际：{}", out);
    }

    #[test]
    fn test_结构化数据占比高时补一句() {
        let raw = ProfileRawStats {
            action_counts: vec![("query-result-to-sql".into(), 100)],
            content_type_counts: vec![("json".into(), 60), ("sql".into(), 30), ("text".into(), 10)],
            hour_counts: vec![],
            feedback: vec![],
            prefs: vec![],
            total_events: 100,
        };
        let out = profile_to_prompt(&raw, None, 9);
        assert!(out.contains("JSON/SQL"), "实际：{}", out);
    }

    #[test]
    fn test_代码领域不会与角色句重复() {
        let out = profile_to_prompt(&raw_dev(100), None, 9);
        assert!(!out.contains("JSON/SQL"), "代码领域不该触发结构化数据句：{}", out);
    }

    #[test]
    fn test_高峰时段只在当前时刻真落在区间内才注入() {
        // hour_counts 全在 9 点 → 高峰是“上午 6-12 点”
        let raw = raw_dev(100);
        let at9 = profile_to_prompt(&raw, None, 9);
        let at22 = profile_to_prompt(&raw, None, 22);
        assert!(at9.contains("高频使用时段"), "9 点应命中：{}", at9);
        assert!(
            !at22.contains("高频使用时段"),
            "22 点不该命中（路线图纠正过的坑）：{}",
            at22
        );
    }

    #[test]
    fn test_反馈条需要样本量() {
        let mut raw = raw_dev(100);
        raw.feedback = vec![AiFeedbackStat {
            action_id: "ai-translate".into(),
            total: 5, // < FEEDBACK_MIN_TOTAL
            accepted: 1,
            edited: 4,
            rejected: 0,
            edit_rate: 0.8,
        }];
        let out = profile_to_prompt(&raw, Some("ai-translate"), 9);
        assert!(!out.contains("经常手动修改"), "样本太少不该出：{}", out);

        raw.feedback[0].total = 20;
        raw.feedback[0].edited = 16;
        let out = profile_to_prompt(&raw, Some("ai-translate"), 9);
        assert!(out.contains("经常手动修改"), "样本够了应该出：{}", out);
    }

    #[test]
    fn test_反馈条只看当前动作() {
        let mut raw = raw_dev(100);
        raw.feedback = vec![AiFeedbackStat {
            action_id: "ai-translate".into(),
            total: 20,
            accepted: 4,
            edited: 16,
            rejected: 0,
            edit_rate: 0.8,
        }];
        // 跑的是另一个动作 → 不该把别人的编辑率拼进来
        let out = profile_to_prompt(&raw, Some("ai-summarize"), 9);
        assert!(!out.contains("经常手动修改"), "实际：{}", out);
    }

    #[test]
    fn test_总长不超上限且不截半句() {
        let mut raw = raw_dev(100);
        raw.feedback = vec![AiFeedbackStat {
            action_id: "ai-explain-code".into(),
            total: 50,
            accepted: 10,
            edited: 40,
            rejected: 0,
            edit_rate: 0.8,
        }];
        let out = profile_to_prompt(&raw, Some("ai-explain-code"), 9);
        assert!(out.chars().count() <= MAX_CHARS, "超长：{}", out.chars().count());
        // 每一行都应以句号结尾（没被从中间划开）
        for line in out.lines() {
            assert!(line.ends_with('。'), "被截半句了：{}", line);
        }
    }

    #[test]
    fn test_签名随片段变化且空片段无签名() {
        assert_eq!(profile_sig(""), "", "空片段不该弄出签名，否则关闭态与空态的缓存键会分家");
        let a = profile_sig("甲");
        let b = profile_sig("乙");
        assert_ne!(a, b);
        assert_eq!(a, profile_sig("甲"), "同片段必须同签名");
        assert_eq!(a.len(), 16);
    }
}
