//! 今日速记（B2 #3 / D11）的数据层。
//!
//! 一天一条笔记，热键 / 右键菜单把内容往里追加。
//! **身份是 `daily_date` 列，不是标题**——标题默认也是日期，但用户随时能改；
//! 靠标题认亲的话，改完第二天就会另建一条、今天这条变孤儿，而用户无从得知。
//!
//! **追加不写版本快照**：它是 append-only 的流水账，内容不会丢。
//! 每追加一段就存一份快照，只会把 20 份的上限迅速吃满，
//! 把用户真正的编辑历史挤出去。（手动编辑速记仍走 `note_update`，那里有快照。）
//!
//! 🔴 红线：无 AI。速记就是普通笔记，AI 摘要得用户自己点。

use serde::Serialize;

use super::note::{note_now, row_to_note, Note, NOTE_COLS};
use super::DataStore;

/// 追加结果。「重复」不是错误，是需要前端说一句话的**正常分支**
/// （同 `AiRunResponse::NeedsConfirm` 的取舍）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DailyAppend {
    /// 追加成功（或当天首次创建）。
    Appended(Note),
    /// 内容与最后一段完全相同。热键手滑连按两下是常态，不该记两遍。
    Duplicate,
}

/// 把一段内容格式化成速记里的一节。
///
/// 用二级标题而不是普通行：Markdown 预览里天然分块，
/// 导出成 md 给 Obsidian 时结构也还在。
/// 来源为空就只写时间——「来自 」后面跟个空白比不写更难看。
pub fn format_entry(hm: &str, source: Option<&str>, text: &str) -> String {
    let head = match source.map(str::trim).filter(|s| !s.is_empty()) {
        Some(src) => format!("## {} · 来自 {}", hm, src),
        None => format!("## {}", hm),
    };
    format!("{}\n{}", head, text.trim_end())
}

/// 取正文里**最后一节的内容**（不含 `## 时间戳` 那行），用于重复判定。
///
/// 只比正文不比时间戳：同一句话隔一小时再复制一次，时间戳不同但内容一样，
/// 那仍然是「刚记过」。用户手动编辑后正文里可能出现别的 `## `，
/// 误判只会影响一句提示，不会丢数据，不为此引一个 Markdown 解析器。
fn last_entry_body(content: &str) -> Option<String> {
    // 整篇只有一节时找不到分隔符，rsplit 会把全文原样返回，
    // 此时首行仍然是标题行，下面的「丢首行」同样成立。
    let last = content.rsplit("\n## ").next()?;
    let mut lines = last.lines();
    lines.next()?;
    Some(lines.collect::<Vec<_>>().join("\n").trim().to_string())
}

impl DataStore {
    /// 往 `date` 那条速记追加一段；没有就建。
    ///
    /// `date` / `hm` 由调用方传入而不是在这里取当前时间：
    /// 否则这个函数永远只能在「今天」被测，跨天、同日叠加这些分支无法写用例。
    pub fn note_append_daily(
        &self,
        date: &str,
        hm: &str,
        source: Option<&str>,
        text: &str,
    ) -> Result<DailyAppend, String> {
        let body = text.trim();
        if body.is_empty() {
            // 不静默成功：热键类操作看不见界面，静默失败会让用户以为热键坏了
            // 然后反复按（规则 #15.3）。
            return Err("内容为空，没有可记的东西".to_string());
        }
        let entry = format_entry(hm, source, body);

        let conn = self.lock_conn();
        let now = note_now();

        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, content FROM notes WHERE daily_date = ?1",
                [date],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let id = match existing {
            Some((id, old)) => {
                if last_entry_body(&old).as_deref() == Some(body) {
                    return Ok(DailyAppend::Duplicate);
                }
                let merged = format!("{}\n\n{}", old.trim_end(), entry);
                conn.execute(
                    "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
                    rusqlite::params![id, merged, now],
                )
                .map_err(|e| e.to_string())?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                // 标题与 daily_date 初值都是日期（同一个 ?2），
                // 但之后标题可改、daily_date 不可——前者是展示，后者是身份。
                conn.execute(
                    "INSERT INTO notes (id, history_id, title, content, created_at, updated_at,
                                        source_agent, daily_date)
                     VALUES (?1, NULL, ?2, ?3, ?4, ?4, '', ?2)",
                    rusqlite::params![id, date, entry, now],
                )
                .map_err(|e| e.to_string())?;
                id
            }
        };

        Self::sync_notes_fts_on(&conn, &id);
        let sql = format!("SELECT {} FROM notes WHERE id = ?1", NOTE_COLS);
        conn.query_row(&sql, [&id], row_to_note)
            .map(DailyAppend::Appended)
            .map_err(|e| e.to_string())
    }

    /// `month` 形如 `2026-09`：返回该月**有速记的日期**（`YYYY-MM-DD`）。日历打点用。
    pub fn note_daily_dates(&self, month: &str) -> Result<Vec<String>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare("SELECT daily_date FROM notes WHERE daily_date LIKE ?1 ORDER BY daily_date")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([format!("{}-%", month)], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 最早一条速记的日期。日历的「‹」翻到头就置灰（不做无限翻）。
    pub fn note_daily_earliest(&self) -> Result<Option<String>, String> {
        self.lock_conn()
            .query_row(
                "SELECT MIN(daily_date) FROM notes WHERE daily_date IS NOT NULL",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_with_source() {
        assert_eq!(
            format_entry("09:14", Some("Chrome"), "正文"),
            "## 09:14 · 来自 Chrome\n正文"
        );
    }

    #[test]
    fn entry_without_source_omits_the_dot() {
        // 来源为空串也算没有，不能留下「· 来自 」这种尾巴
        assert_eq!(format_entry("21:07", None, "正文"), "## 21:07\n正文");
        assert_eq!(format_entry("21:07", Some("  "), "正文"), "## 21:07\n正文");
    }

    #[test]
    fn last_body_of_multi_section() {
        let c = "## 09:14 · 来自 Chrome\n第一段\n\n## 14:32\n第二段";
        assert_eq!(last_entry_body(c).as_deref(), Some("第二段"));
    }

    #[test]
    fn last_body_of_single_section() {
        // 只有一节时找不到 "\n## " 分隔符，走的是另一条路径
        let c = "## 09:14\n唯一一段";
        assert_eq!(last_entry_body(c).as_deref(), Some("唯一一段"));
    }

    #[test]
    fn last_body_handles_multiline_text() {
        let c = "## 09:14\n第一行\n第二行";
        assert_eq!(last_entry_body(c).as_deref(), Some("第一行\n第二行"));
    }
}
