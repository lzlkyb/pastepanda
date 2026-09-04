//! data_store/note_ai.rs —— 笔记的轻量 AI 产物落库（B1 ＋轻量 AI）。
//!
//! 🔴 **这里不调模型**。调用走现成的 `ai_run`（出网闸 / 预算 / 缓存 / 用量都在那条路上），
//! 本文件只负责把**已经拿到的模型输出**解析与写库。
//! 另开一条 AI 通路就意味着出网闸与预算要再实现一遍，而那两样漏一次就是事故。
//!
//! 标签写入的口径照搬历史卡片那套：**直接写库但标 `source`**，
//! 用户确认后翻成 `manual`（同 `confirm_auto_tags`）。不搞一套单独的「待确认建议」表：
//! 那是第二份真相，而现有的 source 列就是为这个场景留的（规划 §6）。

use super::*;

/// 一次最多接受几个 AI 标签。模型偶尔会吐出十几个，全收下来等于把标签体系污染掉。
const MAX_AI_TAGS: usize = 5;

/// 单个标签的字数上限。超过这个基本是模型把一句话当标签了。
const MAX_TAG_CHARS: usize = 12;

/// AI 标签的来源标记。与历史卡片的 `'auto'`（本地分类器）区分开：
/// 一个没花钱、一个花了钱且内容出过本机，将来要分开统计与回溯。
pub const AI_TAG_SOURCE: &str = "ai";

/// 把模型返回的一团文本解析成标签名。
///
/// **必须容错**：prompt 里写了「只输出标签、逗号分隔」，但模型违反格式是常态：
/// 会加开场白、会编号、会用顶格/顿号/换行、会给标签加 `#` 或引号。
/// 解析失败就返回空数组——**宁可不加标签，不能把「1. 注意：」这种东西当标签写进去**。
pub fn parse_ai_tags(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // 先按行走，再每行取**冒号之后**的部分：
    // 「好的，标签如下：」这种引导语整行就没了，而「标签：前端, React」还能拿到后半句。
    // （先按分隔符切再判冒号是不行的：开场白会被逗号切碎，前半截「好的」不含冒号就漏进来了。）
    let bodies = raw.lines().map(|line| match line.rsplit_once([':', '\u{ff1a}']) {
        Some((_, after)) => after,
        None => line,
    });

    for piece in bodies.flat_map(|b| b.split([',', '\u{ff0c}', '\u{3001}', ';', '\u{ff1b}'])) {
        let mut t = piece.trim().to_string();

        // 剥掉常见的装饰：序号、项目符、#、引号、书名号。
        // ❗ 每剥一层都要 trim：「1. #前端」剥完序号剩的是「 #前端」，
        //   开头是空格的话下一步就剥不掉 `#`。
        t = t
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == '\u{3001}')
            .trim_start()
            .trim_start_matches(['-', '*', '\u{2022}', '#'])
            .trim()
            .trim_matches(['"', '\'', '\u{201c}', '\u{201d}', '\u{300a}', '\u{300b}', '`'])
            .trim()
            .to_string();

        if t.is_empty() {
            continue;
        }
        if t.chars().count() > MAX_TAG_CHARS {
            continue;
        }
        // 去重（大小写不敏感）
        if out.iter().any(|e| e.eq_ignore_ascii_case(&t)) {
            continue;
        }
        out.push(t);
        if out.len() >= MAX_AI_TAGS {
            break;
        }
    }
    out
}

impl DataStore {
    /// 写一行摘要。传空串 = 用户手动清空（存空串，与「从未生成」的 NULL 区分）。
    ///
    /// **不动 `updated_at`**：摘要不是用户对正文的修改，把笔记顶到列表最前会让人以为自己改过它。
    /// 同理也不写版本快照：快照记的是正文，摘要不在其中。
    pub fn note_set_summary(&self, id: &str, summary: Option<&str>) -> Result<(), String> {
        let conn = self.lock_conn();
        let n = conn
            .execute(
                "UPDATE notes SET summary = ?2 WHERE id = ?1",
                rusqlite::params![id, summary],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("笔记不存在: {}", id));
        }
        Ok(())
    }

    /// 把模型输出里的标签**追加**给笔记，标为 `source = 'ai'`。
    ///
    /// 追加而不是覆盖：用户手工打的标签不能被 AI 抹掉。
    /// 已存在的关联不动（`INSERT OR IGNORE`）——包括用户已经确认过的同名标签，
    /// **不能把它从 manual 退回 ai**。
    ///
    /// 返回实际新增上去的标签名（给 UI 提示用）。
    pub fn note_add_ai_tags(&self, note_id: &str, raw: &str) -> Result<Vec<String>, String> {
        let names = parse_ai_tags(raw);
        if names.is_empty() {
            return Ok(Vec::new());
        }
        if self.note_get(note_id)?.is_none() {
            return Err(format!("笔记不存在: {}", note_id));
        }

        let ids = self.ensure_tag_ids(&names)?;
        let conn = self.lock_conn();
        let mut added = Vec::new();
        for (name, tag_id) in names.iter().zip(ids.iter()) {
            let n = conn
                .execute(
                    // M6-P3：同上。
                    "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    rusqlite::params![note_id, tag_id, AI_TAG_SOURCE, super::note::note_now()],
                )
                .map_err(|e| e.to_string())?;
            if n > 0 {
                added.push(name.clone());
            }
        }
        Ok(added)
    }

    /// 把这篇笔记的 AI 标签转为手动标签（用户确认）。同 `confirm_auto_tags` 的口径。
    pub fn note_confirm_ai_tags(&self, note_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            // M6-P3：用户认可一个 AI 标签是一次真实修改（source 变了），
            // 不刷时间戳的话，对端那份还标着 'ai' 的旧行会把这次认可盖回去。
            "UPDATE note_tags SET source = 'manual', updated_at = ?3 \
             WHERE note_id = ?1 AND source = ?2",
            rusqlite::params![note_id, AI_TAG_SOURCE, super::note::note_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
