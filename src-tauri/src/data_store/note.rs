//! data_store/note.rs — 知识库笔记（A 阶段）。
//!
//! 对应 docs/个人知识库与笔记-规划.md 的 §8.1 2️⃣（建表）与 §7 L1（检索第三路）。
//! 建表 DDL 在 `mod.rs`（跟其它表放一起），这里只管读写。
//!
//! # 中文检索的两侧预处理（改这里前必读）
//!
//! `notes_fts` 是**裸的** `fts5(title, content, pinyin)`，一个 tokenizer 参数也没有
//! （同 `history_fts`）。中文能搜到全靠 [`to_ngram`] 的 **bigram 双侧预处理**：
//!
//! 1. 写入时切二元存进 FTS（[`Self::sync_notes_fts_on`]）；
//! 2. 查询词也要过 `to_ngram` 再 MATCH（[`Self::note_search`]）。
//!
//! **漏掉任一侧，中文就搜不到**——A 阶段验收里「中文与拼音关键词都能命中
//! notes_fts」会直接踩空。
//!
//! # FTS5 不支持 UPSERT
//!
//! 同步必须是「按 rowid 删旧行 → 再插」。history_fts 曾因为用 `ON CONFLICT`
//! 而整年报错并被 `log::warn` 吞掉，首次回填之后新增内容从未进过索引。不要重蹈。

use super::*;

// `to_ngram` 住在 history.rs（它是那里先需要的），并未从 mod.rs 再导出，
// 所以 `use super::*` 带不进来，得显式引。现在它有两个使用方了；
// 若再出现第三个，就该把它上提到 mod.rs 当共用 FTS 工具（规则 #11）。
use super::history::{is_cjk, to_ngram};
// 文件夹子树的递归 CTE 住在 note_folder.rs（那里是主要使用方）。
// 复用而不重写：写两份递归定义，改树结构时必定漏改一份（规则 #11）。
use super::note_folder::SUBTREE_CTE;

/// 一条笔记。字段与 `notes` 表一一对应，`tags` 不在表里（走 `note_tags` 关联表）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    /// 来源卡片 id。为 `None` = 独立新建的笔记（规划 §1.6 入口 #2，B1 才做 UI）。
    pub history_id: Option<String>,
    pub title: String,
    /// Markdown 正文。`[[..]]` 是合法字符，**原样保存不解析**（D7，解析归 C 阶段）。
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    /// D13：外部 agent 写入的来源标记。M4 才启用，手动笔记是空串。
    #[serde(default)]
    pub source_agent: String,
    /// 所属文件夹（B1 #1）。`None` = 未分类。
    ///
    /// 删文件夹时由 `ON DELETE SET NULL` 自动变回 None——**笔记不随文件夹删**。
    #[serde(default)]
    pub folder_id: Option<String>,
    /// 一行 AI 摘要（B1 轻量 AI）。`None` = 从未生成过，列表里回退到正文截断。
    ///
    /// 只能由用户主动触发生成（受 `ai_enabled` 门控，规则 #16），永远不自动跑。
    #[serde(default)]
    pub summary: Option<String>,
    /// 今日速记的日期（B2 #3 / D11），`YYYY-MM-DD`。`None` = 普通笔记。
    ///
    /// **这是速记的身份，不是标题**。标题默认也是日期，但用户随时能改；
    /// 若靠标题认亲，改完第二天就会另建一条、今天这条变孤儿，而用户无从得知。
    #[serde(default)]
    pub daily_date: Option<String>,
    /// W1 软删除时刻。正常查询拿到的永远是 `None`（已删的根本不会返回），
    /// 只有 [`DataStore::note_list_deleted`] 会给出非 `None` 的值。
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    /// 当前分组下的**组名**（B2 #9）。`None` = 不分组。
    ///
    /// 不是表里的列，不在 `NOTE_COLS` 里——它是查询时算出来的。
    /// 存的直接是可显示的字符串（文件夹名 / 标签名 / `2026-09`），
    /// 前端只在相邻两行不同时插一个组头，不需要再去解析 id。
    #[serde(default)]
    pub group_key: Option<String>,
}

/// 取列顺序写一次，所有查询共用——否则加字段时必定漏改某一处。
///
/// `pub(super)`：速记（`note_daily`）追加后也要回读整条笔记，
/// 它得用同一份列顺序，不能另写一份。
pub(super) const NOTE_COLS: &str =
    "id, history_id, title, content, created_at, updated_at, source_agent, \
     folder_id, summary, daily_date, deleted_at";

pub(super) fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        history_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        source_agent: row.get(6)?,
        folder_id: row.get(7)?,
        summary: row.get(8)?,
        daily_date: row.get(9)?,
        deleted_at: row.get(10)?,
        tags: Vec::new(),
        // 分组键不在 NOTE_COLS 里，由 note_list_view 在读完本函数后另行填
        group_key: None,
    })
}

/// 拼音首字母的输入：标题 + 正文头部。
///
/// 为何要先截：[`compute_pinyin_initials`] 内部只取前 50 个拼音，但 `lazy_pinyin`
/// 会先把**整串**转完再丢掉——一篇万字笔记全转一遍纯浪费。
/// 200 字已远超 50 个拼音的阀值，结果不变。
fn pinyin_source(title: &str, content: &str) -> String {
    let head: String = content.chars().take(200).collect();
    format!("{} {}", title, head)
}

/// 笔记时间戳。**比全库惯例多了毫秒**，这是有意的：
///
/// 其它表用 `'%Y-%m-%d %H:%M:%S'`（秒粒度）。history 是追加型、并列时按 rowid
/// 天然有序，所以秒粒度够用。但**笔记会被编辑**，而列表按 `updated_at DESC`
/// 排——秒粒度下「同一秒内改了一条旧笔记」会并列，它跳不到最前，
/// 而「改完跳最前」正是笔记列表的核心交互。
///
/// 仍是 TEXT、仍是字典序可排，所以没破坏「全库时间戳用字符串」这个惯例，
/// 只是精度更高。notes 的时间戳不与任何其它表做比较或 join。
pub(super) fn note_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

/// 把用户关键词转成 FTS5 的 MATCH 表达式。
///
/// 两条路径，分岔的理由很具体：
///
/// - **纯 ASCII 字母数字 → 前缀查询 `kw*`**。拼音首字母列存的是整篇笔记的
///   首字母串（如「会议记录 正文」→ `HYJLZW`），它是**一个长 token**；
///   而用户只会输开头几个字母（`hyjl`）。FTS5 默认整词匹配，不加 `*`
///   **拼音检索永远不可能命中**——规划 A 阶段验收的「拼音关键词能命中
///   notes_fts」就是卡在这里。附带好处：英文词（`API`）也变成前缀检索。
/// - **含中文 → 走 [`to_ngram`]**。bigram 本身就是精确匹配单元，加 `*` 只会扩大误命中。
///
/// 两路都先把非字母数字字符剔干净，否则引号 / `*` / `NEAR` 会撞上 MATCH 语法。
fn to_match_expr(kw: &str) -> String {
    let is_ascii_word = kw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-');
    if is_ascii_word {
        let cleaned: String = kw
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
            .collect();
        let terms: Vec<String> = cleaned
            .split_whitespace()
            .map(|t| format!("{}*", t))
            .collect();
        if !terms.is_empty() {
            return terms.join(" ");
        }
    }
    to_ngram(kw)
}

/// 问答检索的停用字：**bigram 里含它就丢掉这个 bigram**。
///
/// 只做字级、只做这一张小表。作用是把「这个」「目的」「的部」这类从问句里
/// **必然产生**的噪声 bigram 去掉，不是做中文分词（那要词典，不在本阶段范围）。
const QA_STOP_CHARS: &[char] = &[
    '的', '了', '是', '在', '这', '那', '个', '和', '与', '吗', '呢', '吧', '啊', '呀', '有', '我',
    '你', '他', '她', '它', '们', '之', '于', '对', '把', '被', '就', '都', '也', '还', '很', '太',
    '要', '会', '能', '怎', '么', '什', '如', '何', '请', '问',
];

/// 一次问答检索最多取多少个词。防一句超长问题拼出几百个 OR。
const QA_MAX_TERMS: usize = 24;

/// 把一句自然语言问题变成 FTS5 的 **OR** 表达式（B2 #10 问答雏形）。
///
/// 🔴 **不能直接把问题丢给 [`DataStore::note_search`]**：`to_ngram` 会把整句切成
/// 「每个单字 + 每个相邻 bigram」再 `join(" ")`，而 **FTS5 的隐含运算符是 AND**。
/// 一句 10 字的问题 = ~19 个词全部 AND，要求一篇笔记同时含问题里的**每个字与每对相邻字**——
/// 零命中是必然的；句末的「？」还会被切成一个裸 term，可能直接让 MATCH 语法报错、
/// 退到 `LIKE '%整句问题%'`，同样零命中。
///
/// 所以问答走 OR，靠 BM25 排相关度：命中词多的排前面。
///
/// 限定 `{title content}` 两列：`pinyin` 列存的是拼音首字母，
/// 让问题里的英文词去撞它只会带进无关笔记。
///
/// 返 `None` = 问题里没有可检索的词（如纯标点、单字），调用方按零命中处理。
pub fn question_to_or_expr(q: &str) -> Option<String> {
    let chars: Vec<char> = q.chars().collect();
    let n = chars.len();
    let mut terms: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n && terms.len() < QA_MAX_TERMS {
        let c = chars[i];
        if is_cjk(c) {
            // 只取 bigram，不取单字：单字 OR 进去会把半个库都命中（中文单字太常见），
            // BM25 也因此失去区分度。这与写入侧不对称是故意的：写入存单字是为了
            // 让搜索能命中单字关键词，而问句里的单字几乎全是噪声。
            if i + 1 < n && is_cjk(chars[i + 1]) {
                let (a, b) = (c, chars[i + 1]);
                if !QA_STOP_CHARS.contains(&a) && !QA_STOP_CHARS.contains(&b) {
                    let t: String = [a, b].iter().collect();
                    if !terms.contains(&t) {
                        terms.push(t);
                    }
                }
            }
            i += 1;
        } else if c.is_ascii_alphanumeric() {
            let start = i;
            while i < n && chars[i].is_ascii_alphanumeric() {
                i += 1;
            }
            // 单字符的英文/数字（"a" "3"）不作检索词：噪声远大于信息
            if i - start >= 2 {
                let t = format!("{}*", chars[start..i].iter().collect::<String>());
                if !terms.contains(&t) {
                    terms.push(t);
                }
            }
        } else {
            i += 1;
        }
    }
    if terms.is_empty() {
        return None;
    }
    Some(format!("{{title content}} : ({})", terms.join(" OR ")))
}

/// 笔记视图选项（B2 #9）。**全部字段空串 = 默认态 = 与做这个功能之前一模一样**。
///
/// 那个等式是结构上保证的，不靠自律：`note_list` / `note_search` / `note_count_filtered`
/// 保留原签名并转调 `*_view`，传 `NoteViewOpts::default()`。所以旧调用点（导出、
/// 今日速记、测试）一行都不用改，也不可能被新参数影响。
///
/// 筛选全是**三态字串**（`""` 不筛 / `"yes"` / `"no"`）而不是 `Option<bool>`：
/// 与前端 chip 的三态一一对应，反序列化时不存在「`null` 还是 `false`」的歧义。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteViewOpts {
    /// `""`|`"updated"` 最近修改 / `"created"` 最近创建 / `"accessed"` 最近打开 / `"title"` 标题
    pub sort: String,
    /// `""` 不分组 / `"folder"` / `"month"` / `"tag"`
    pub group_by: String,
    /// 有无摘要
    pub summary: String,
    /// 是否来自卡片
    pub from_card: String,
    /// 有无标签
    pub tagged: String,
}

impl NoteViewOpts {
    /// 排序片段。未知值退回默认（命令层会先记一条 warn）。
    fn order_by(&self) -> &'static str {
        match self.sort.as_str() {
            "created" => "notes.created_at DESC, notes.rowid DESC",
            // ❗ `IS NULL` 那一段是关键：从未打开过的笔记 last_access_at 是 NULL，
            //   而 SQLite 里 NULL 在 DESC 下排最后、ASC 下排最前——都不是我们要的。
            //   先按「是否为 NULL」升序（false<true），把没打开过的全部压到末尾。
            "accessed" => {
                "notes.last_access_at IS NULL, notes.last_access_at DESC, notes.rowid DESC"
            }
            // 中文按 UTF-8 码位序，**不是拼音序**——SQLite 没中文 collation，不假装有。
            "title" => "notes.title COLLATE NOCASE ASC, notes.rowid DESC",
            _ => "notes.updated_at DESC, notes.rowid DESC",
        }
    }

    /// 分组键的 SELECT 表达式。**算出来的就是给人看的字符串**（文件夹名 / 标签名 / `2026-09`），
    /// 不是 id——否则前端还要再查一遍名字，而那份映射早晚与后端对不上。
    fn group_expr(&self) -> &'static str {
        match self.group_by.as_str() {
            "folder" => "COALESCE(f.name, '未分类')",
            "month" => "substr(notes.created_at, 1, 7)",
            "tag" => "COALESCE(t.name, '无标签')",
            _ => "NULL",
        }
    }

    /// 组之间的顺序。月份倒序（最近的月在前，同「最近修改」的直觉），名字类升序。
    fn group_order(&self) -> Option<&'static str> {
        match self.group_by.as_str() {
            "month" => Some("grp DESC"),
            "folder" | "tag" => Some("grp COLLATE NOCASE ASC"),
            _ => None,
        }
    }

    /// 按标签分组需要 JOIN，会把一条多标签的笔记展成多行。
    fn joins(&self) -> &'static str {
        match self.group_by.as_str() {
            "folder" => " LEFT JOIN note_folders f ON f.id = notes.folder_id",
            // LEFT 而不是 INNER：否则没标签的笔记会**整批从列表里消失**。
            // 它们归到「无标签」组，而不是默默不见。
            // ❗ 不用 `\` 续行：它会把换行**和行首空白一起吃掉**，
            //   两个 JOIN 直接粘成 `notes.idLEFT JOIN`（已被用例抓到过一次）。
            "tag" => {
                " LEFT JOIN note_tags nt ON nt.note_id = notes.id \
                 LEFT JOIN tags t ON t.id = nt.tag_id"
            }
            _ => "",
        }
    }
}

/// `NOTE_COLS` 加 `notes.` 前缀。分组要 JOIN，而 `tags` 也有 `id` / `name`，
/// 不限定就是 `ambiguous column name`（同 kb_inbox.rs 给 history 加 `h.` 的做法）。
fn note_cols_q() -> String {
    NOTE_COLS
        .split(", ")
        .map(|c| format!("notes.{c}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 三个三态筛选。全是字面 SQL、**不带参数**，所以可以随意拼在哪一步，
/// 不会扰乱位置绑定的序号（那是 `bump_search_hits` 里刚钉过的一类坑）。
fn push_view_filters(sql: &mut String, o: &NoteViewOpts) {
    match o.summary.as_str() {
        // ❗ 两个条件都要：`summary` 是迁移加的、可为 NULL，
        //   而今日速记插入时写的是空串。只写一个会漏一半。
        "yes" => sql.push_str(" AND notes.summary IS NOT NULL AND notes.summary != ''"),
        "no" => sql.push_str(" AND (notes.summary IS NULL OR notes.summary = '')"),
        _ => {}
    }
    match o.from_card.as_str() {
        "yes" => sql.push_str(" AND notes.history_id IS NOT NULL"),
        "no" => sql.push_str(" AND notes.history_id IS NULL"),
        _ => {}
    }
    match o.tagged.as_str() {
        "yes" => sql.push_str(" AND EXISTS (SELECT 1 FROM note_tags WHERE note_id = notes.id)"),
        "no" => sql.push_str(" AND NOT EXISTS (SELECT 1 FROM note_tags WHERE note_id = notes.id)"),
        _ => {}
    }
}

/// ` ORDER BY [组序, ]排序 LIMIT ?`——搜索的 FTS 与 LIKE 两条路径共用（规则 #11）。
/// 写两份的结果就是「FTS 正常时排序对、退到 LIKE 就不对」，而那条路径平时跑不到。
fn order_clause(o: &NoteViewOpts) -> String {
    let mut s = String::from(" ORDER BY ");
    if let Some(g) = o.group_order() {
        s.push_str(g);
        s.push_str(", ");
    }
    s.push_str(o.order_by());
    s.push_str(" LIMIT ?");
    s
}

/// 读一行「笔记 + 分组键」。grp 固定接在 `NOTE_COLS` 的 10 列之后。
///
/// 收口三处（列表 / 搜索 FTS / 搜索 LIKE 回退）：列下标写死在三个地方，
/// 以后 `NOTE_COLS` 加一列就会漏改，而那会读到错列而不报错。
fn row_to_note_grouped(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    let mut n = row_to_note(row)?;
    // ❗ 按**列名**取，不能写死下标。三条查询都是 `SELECT {NOTE_COLS}, … AS grp`，
    //   一旦 `NOTE_COLS` 加列，写死的下标就指到别人身上——而且不报错，
    //   只是分组头静默全没了（W1 加 deleted_at 时实际撞过一次）。
    n.group_key = row.get::<_, Option<String>>("grp")?;
    Ok(n)
}

/// 一个分组的真实条数。
#[derive(Debug, Clone, Serialize)]
pub struct NoteGroupCount {
    pub key: String,
    pub count: i64,
}

/// 文件夹 + 标签的筛选片段（**交集**语义）。
///
/// - `folder_filter`：`"all"` | `"unfiled"` | `<folder_id>`。
///   这个魔法字符串形式是**照搬项目现有的 `group_filter`**（history.rs:396，
///   前端类型 `GroupFilter = "all" | "ungrouped" | string`），不另发明一套。
///   具体 id 时**含全部后代**——与侧栏计数同口径（设计稿 §4）。
/// - `tag_ids`：多个标签是 **AND**（必须全部命中），同记录模式的卡片筛选（history.rs:402）。
///   并集会让「选了更多条件反而结果更多」，与用户对筛选器的直觉相反。
///
/// 调用方的 `sql` 必须已经以 `WHERE 1=1` 结尾（所以这里一律拼 `AND`）。
/// ❗ 列名全部带 `notes.` 前缀：分组（B2 #9）会 JOIN `tags` / `note_folders`，
/// 而 `tags` 也有 `id`——不限定就是 `ambiguous column name`。
/// 不 JOIN 时加前缀无任何副作用，所以一律加，不分两种写法。
fn push_note_filters(
    sql: &mut String,
    params: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
    folder_filter: &str,
    tag_ids: &[String],
) {
    // ❗ W1 软删除的**唯一收口点**。本函数被六条路径调用：列表 / 计数 / 组头
    //   （走 note_view_from_where）、FTS 检索、LIKE 回退、问答相关度。
    //   写在这里而不是各自拼，是因为漏掉任一条的表现是「已删的笔记只从某一个
    //   入口漏出来」——不报错、不崩，靠看代码发现不了。
    //   新增任何笔记查询必须走这里，或自行带上同样的条件（规则 #11.1）。
    sql.push_str(" AND notes.deleted_at IS NULL");
    if folder_filter == "unfiled" {
        // 速记不算「未分类」：「未分类」的语义是「该归档还没归档」，
        // 而速记本来就不需要归档。不排掉的话，一周后这个入口里全是速记，就废了。
        sql.push_str(" AND notes.folder_id IS NULL AND notes.daily_date IS NULL");
    } else if folder_filter == "daily" {
        sql.push_str(" AND notes.daily_date IS NOT NULL");
    } else if let Some(day) = folder_filter.strip_prefix("daily:") {
        sql.push_str(" AND notes.daily_date = ?");
        params.push(Box::new(day.to_string()));
    } else if folder_filter != "all" && !folder_filter.is_empty() {
        // SQLite 允许子查询自带 WITH 子句，所以递归 CTE 可以嵌在 IN 里。
        // 常量里的占位符是 `?1`，而这里走的是位置绑定，换成匿名 `?`。
        sql.push_str(" AND notes.folder_id IN (");
        sql.push_str(&SUBTREE_CTE.replace("?1", "?"));
        sql.push_str(" SELECT id FROM sub)");
        params.push(Box::new(folder_filter.to_string()));
    }
    for tag_id in tag_ids {
        sql.push_str(" AND notes.id IN (SELECT note_id FROM note_tags WHERE tag_id = ?)");
        params.push(Box::new(tag_id.clone()));
    }
}

impl DataStore {
    // ===== FTS 同步 =====

    /// 把一条笔记同步进 `notes_fts`。失败只 `warn`，不阻断主流程
    /// （同 `sync_history_fts_on` 的取舍：索引是加速器，不能因它存不下笔记）。
    pub(super) fn sync_notes_fts_on(conn: &rusqlite::Connection, id: &str) {
        let res = conn
            .query_row(
                "SELECT rowid, title, content FROM notes WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .and_then(|(rowid, title, content)| {
                let pinyin = compute_pinyin_initials(&pinyin_source(&title, &content));
                // FTS5 不支持 UPSERT：必须先删后插（见本文件头部注释）。
                conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", rusqlite::params![rowid])?;
                conn.execute(
                    "INSERT INTO notes_fts (rowid, title, content, pinyin) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        rowid,
                        to_ngram(&title),
                        to_ngram(&content),
                        to_ngram(&pinyin)
                    ],
                )
            });
        if let Err(e) = res {
            log::warn!("[Notes] FTS 索引同步失败 (id={}): {}", id, e);
        }
    }

    // ===== CRUD =====

    /// 新建笔记。`history_id` 为 `None` = 与剪贴板无关的独立笔记。
    pub fn note_create(
        &self,
        history_id: Option<&str>,
        title: &str,
        content: &str,
    ) -> Result<Note, String> {
        let conn = self.lock_conn();
        let id = uuid::Uuid::new_v4().to_string();
        let now = note_now();
        conn.execute(
            "INSERT INTO notes (id, history_id, title, content, created_at, updated_at, source_agent)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, '')",
            rusqlite::params![id, history_id, title, content, now],
        )
        .map_err(|e| e.to_string())?;
        Self::sync_notes_fts_on(&conn, &id);
        Ok(Note {
            id,
            history_id: history_id.map(|s| s.to_string()),
            title: title.to_string(),
            content: content.to_string(),
            created_at: now.clone(),
            updated_at: now,
            source_agent: String::new(),
            // 新建笔记一律落入「未分类」。归档走 `note_set_folder`（右键「移动到文件夹」
            // 与 #13 新建空白笔记的「落入当前文件夹」都用它），不往 create 里堆参数。
            folder_id: None,
            // 新建笔记没有摘要：摘要只能用户主动生成，永远不自动跑
            summary: None,
            // 普通新建不是速记。速记走 `note_append_daily`（那里才写 daily_date）
            daily_date: None,
            // 刚建的笔记当然没被删
            deleted_at: None,
            // 新建返回的单条不属于任何列表视图，没有分组上下文
            group_key: None,
            tags: Vec::new(),
        })
    }

    /// 改标题与正文。`created_at` 不动，`updated_at` 刷新。
    pub fn note_update(&self, id: &str, title: &str, content: &str) -> Result<(), String> {
        let conn = self.lock_conn();

        // 先读旧值：既用来判「真的改了吗」，也顺便代替了原来靠 UPDATE 影响行数
        // 判笔记是否存在（无变化时 UPDATE 本就不会发，那个判法失效）。
        let (old_title, old_content): (String, String) = conn
            .query_row(
                // 带 deleted_at 条件：改一条已删的笔记会落到下面那个「笔记不存在」分支。
                // 不加的话写入会静默成功但永远看不到——对 MCP 写入尤其危险。
                "SELECT title, content FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| match e {
                // 不静默（规则 #15.3）：改不存在的笔记是调用方的 bug，不是正常情况。
                rusqlite::Error::QueryReturnedNoRows => format!("笔记不存在: {}", id),
                other => other.to_string(),
            })?;

        // 标题与正文都没变 ⇒ **什么都不做**：不写快照，也不动 updated_at。
        // 后一半容易漏：列表默认按 updated_at 排，一次「打开→直接保存」就把一条
        // 没改过的笔记顶到最前，看上去像数据乱了（设计稿 §1）。
        if old_title == title && old_content == content {
            return Ok(());
        }

        // 快照存的是**旧版本**，所以必须在 UPDATE 之前拍（D8 / note_revision.rs）。
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        Self::snapshot_note_on(&tx, id).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
            rusqlite::params![id, title, content, note_now()],
        )
        .map_err(|e| e.to_string())?;
        Self::prune_revisions_on(&tx, id).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Self::sync_notes_fts_on(&conn, id);
        Ok(())
    }

    /// 删笔记——**软删除**（W1）。只置 `deleted_at`，行还在。
    ///
    /// 为什么不再硬删：`note_revisions` 带 `ON DELETE CASCADE`（A-36 有意加的），
    /// 硬删一条笔记 = 连它的 20 份历史快照一起没，**完全不可恢复**。
    /// M4 要把写入能力放给外部模型，这个代价不能接受。
    ///
    /// `note_tags` **不再**被 CASCADE 清掉，这正是想要的：恢复时标签跟着回来。
    /// 真正的 CASCADE 清理推迟到 [`Self::note_purge`]。
    ///
    /// `notes_fts` 则必须当场删：软删后笔记不应再被搜到。
    /// （检索路径同时还有 `push_note_filters` 的条件兼着，两道都拦。不是冗余：
    /// 前者管 FTS 命中集，后者还管 LIKE 回退那条完全不过 FTS 的路径。）
    pub fn note_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let rowid: Option<i64> = conn
            .query_row(
                "SELECT rowid FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                |r| r.get(0),
            )
            .ok();
        conn.execute(
            "UPDATE notes SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id, note_now()],
        )
        .map_err(|e| e.to_string())?;
        if let Some(rid) = rowid {
            if let Err(e) =
                conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", rusqlite::params![rid])
            {
                log::warn!("[Notes] FTS 删除失败 (id={}): {}", id, e);
            }
        }
        Ok(())
    }

    /// 回收站列表，按删除时间倒序。不带标签（回收站只需要认出是哪条）。
    pub fn note_list_deleted(&self, limit: u32) -> Result<Vec<Note>, String> {
        let conn = self.lock_conn();
        let sql = format!(
            "SELECT {} FROM notes WHERE deleted_at IS NOT NULL \
             ORDER BY deleted_at DESC, rowid DESC LIMIT ?1",
            NOTE_COLS
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit], row_to_note)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 从回收站恢复一条。
    ///
    /// ❗ 速记有个真实的冲突：`idx_notes_daily` 是 `(daily_date) WHERE … deleted_at IS NULL`
    /// 的唯一索引。删掉今天的速记、又新建了一条，再恢复旧的就会撞约束。
    /// 先查再报人话错误，不把裸 SQLite 报错扇给用户（规则 #15.3）。
    /// 名字带 `_deleted` 后缀是必须的：`note_revision.rs` 里已有一个 `note_restore`，
    /// 那个是「回滚到某个历史版本」，两件事没关系。
    pub fn note_restore_deleted(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let daily: Option<String> = conn
            .query_row(
                "SELECT daily_date FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("回收站里没有这条笔记: {}", id)
                }
                other => other.to_string(),
            })?;
        if let Some(day) = daily.as_deref() {
            let taken: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM notes WHERE daily_date = ?1 AND deleted_at IS NULL",
                    [day],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if taken > 0 {
                return Err(format!(
                    "{} 已经有一条速记了，恢复会撞上。先把现有的速记处理掉再试。",
                    day
                ));
            }
        }
        conn.execute("UPDATE notes SET deleted_at = NULL WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        // 删的时候从 FTS 拿掉了，恢复必须重建——否则笔记回来了却搜不到。
        Self::sync_notes_fts_on(&conn, id);
        Ok(())
    }

    /// 彻底销毁一条已软删的笔记（含它的全部历史快照，不可恢复）。
    ///
    /// 只能动已在回收站的：`AND deleted_at IS NOT NULL` 是故意的保险，
    /// 万一哪天有人把它接到外部写入上，也不至于一步平掉一条活笔记。
    pub fn note_purge(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let rowid: Option<i64> = conn
            .query_row("SELECT rowid FROM notes WHERE id = ?1", [id], |r| r.get(0))
            .ok();
        let n = conn
            .execute(
                "DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
                [id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("回收站里没有这条笔记: {}", id));
        }
        // 软删时已经从 FTS 拿掉了，这里再删一次是兼容性兼底（旧库可能有残留行）。
        if let Some(rid) = rowid {
            let _ = conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", rusqlite::params![rid]);
        }
        Ok(())
    }
}

impl DataStore {
    // ===== 查询 =====

    /// 按 id 取一条（带标签）。不存在返回 `Ok(None)`。
    pub fn note_get(&self, id: &str) -> Result<Option<Note>, String> {
        let conn = self.lock_conn();
        let sql = format!(
            "SELECT {} FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            NOTE_COLS
        );
        let mut note = match conn.query_row(&sql, [id], row_to_note) {
            Ok(n) => n,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        note.tags = Self::load_note_tags_on(&conn, &note.id);
        Ok(Some(note))
    }

    /// 笔记列表，按 `updated_at` 降序（最近改的在前）。
    ///
    /// 分页而不是一次铺开：规划 §3.2 按真实数据估算笔记年化约 670 条，
    /// 两三年后上千，不分页早晚会撞上渲染成本。
    ///
    /// `folder_filter` / `tag_ids` 见 `push_note_filters`。
    pub fn note_list(
        &self,
        folder_filter: &str,
        tag_ids: &[String],
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Note>, String> {
        self.note_list_view(
            folder_filter,
            tag_ids,
            &NoteViewOpts::default(),
            limit,
            offset,
        )
    }

    /// 列表 / 计数 / 组头计数共用的 `FROM … WHERE …` 与参数（B2 #9）。
    ///
    /// **三处必须共用这一份**：分开写早晚漂，而漂了就是「面包屑/组头写 12 条、
    /// 列表里却有 20 条」——A-32 那个 bug 就是这么来的。
    fn note_view_from_where(
        folder_filter: &str,
        tag_ids: &[String],
        opts: &NoteViewOpts,
    ) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
        let mut sql = format!(" FROM notes{} WHERE 1=1", opts.joins());
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        push_note_filters(&mut sql, &mut params, folder_filter, tag_ids);
        push_view_filters(&mut sql, opts);
        (sql, params)
    }

    /// 带视图选项的笔记列表（B2 #9）。`opts` 全默认时与旧行为完全一致。
    ///
    /// ❗ **分组不在前端做，就是多一层 `ORDER BY`。**
    /// 前端分组只能对已加载的那几页分，滚一次组就变一次；
    /// 放进 SQL 后分页天然正确：新行要么接在当前组里，要么开一个新组。
    pub fn note_list_view(
        &self,
        folder_filter: &str,
        tag_ids: &[String],
        opts: &NoteViewOpts,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Note>, String> {
        let conn = self.lock_conn();
        let (from_where, mut params) =
            Self::note_view_from_where(folder_filter, tag_ids, opts);
        let mut sql = format!(
            "SELECT {}, {} AS grp{}",
            note_cols_q(),
            opts.group_expr(),
            from_where
        );

        // 速记按日期倒序（它是流水账，按“最近改过”排会让翻旧账时顺序乱跳）。
        // 用户显式选了排序时以用户为准——他手动改过的东西不应该被默认规则盖掉。
        let daily_default = folder_filter.starts_with("daily") && opts.sort.is_empty();
        let order = if daily_default {
            "notes.daily_date DESC, notes.rowid DESC"
        } else {
            opts.order_by()
        };
        sql.push_str(" ORDER BY ");
        if let Some(g) = opts.group_order() {
            sql.push_str(g);
            sql.push_str(", ");
        }
        sql.push_str(order);
        sql.push_str(" LIMIT ? OFFSET ?");
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut notes: Vec<Note> = stmt
            .query_map(refs.as_slice(), row_to_note_grouped)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for n in notes.iter_mut() {
            n.tags = Self::load_note_tags_on(&conn, &n.id);
        }
        Ok(notes)
    }

    /// 每个分组的**真实**条数（B2 #9）。不分组时返回空。
    ///
    /// ❗ 组头的数字必须走这里，**不能数前端已加载的行**——否则就是
    /// 「组头写 12 条而实际 20 条」，与本次要修的那个截断 bug 同一类。
    pub fn note_group_counts(
        &self,
        folder_filter: &str,
        tag_ids: &[String],
        opts: &NoteViewOpts,
    ) -> Result<Vec<NoteGroupCount>, String> {
        if opts.group_order().is_none() {
            return Ok(Vec::new());
        }
        let conn = self.lock_conn();
        let (from_where, params) = Self::note_view_from_where(folder_filter, tag_ids, opts);
        let sql = format!(
            "SELECT {} AS grp, COUNT(*) AS c{} GROUP BY grp ORDER BY {}",
            opts.group_expr(),
            from_where,
            opts.group_order().unwrap_or("grp"),
        );
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(refs.as_slice(), |r| {
                Ok(NoteGroupCount {
                    key: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    count: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 当前筛选下的笔记总数。列表分页靠它判「还有更多」。
    ///
    /// 与 `note_list` 共用 `push_note_filters`：分开写早晚漂，结果就是计数与列表不一致
    /// （待沉淀区那个「横幅 225 / 列表 200」就是这么来的，`↩A-32`）。
    pub fn note_count_filtered(
        &self,
        folder_filter: &str,
        tag_ids: &[String],
    ) -> Result<i64, String> {
        self.note_count_filtered_view(folder_filter, tag_ids, &NoteViewOpts::default())
    }

    /// 带视图选项的总数（B2 #9）。
    ///
    /// ❗ `COUNT(DISTINCT notes.id)` 而不是 `COUNT(*)`：按标签分组时 JOIN 会把
    /// 一条多标签的笔记展成多行，`COUNT(*)` 会把面包屑的「共 N 条」抬得比真实笔记数高。
    /// 面包屑说的是「多少条笔记」，不是「多少行」。
    pub fn note_count_filtered_view(
        &self,
        folder_filter: &str,
        tag_ids: &[String],
        opts: &NoteViewOpts,
    ) -> Result<i64, String> {
        let conn = self.lock_conn();
        let (from_where, params) = Self::note_view_from_where(folder_filter, tag_ids, opts);
        let sql = format!("SELECT COUNT(DISTINCT notes.id){}", from_where);
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.query_row(&sql, refs.as_slice(), |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    /// 某张卡片是否已转过笔记。一张卡片可能转过多条，这里只取最新一条
    /// （卡片上的 📝 角标只需要知道「有没有」）。
    pub fn note_by_history(&self, history_id: &str) -> Result<Option<Note>, String> {
        let conn = self.lock_conn();
        let sql = format!(
            "SELECT {} FROM notes WHERE history_id = ?1 AND deleted_at IS NULL \
             ORDER BY updated_at DESC, rowid DESC LIMIT 1",
            NOTE_COLS
        );
        match conn.query_row(&sql, [history_id], row_to_note) {
            Ok(mut n) => {
                n.tags = Self::load_note_tags_on(&conn, &n.id);
                Ok(Some(n))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 所有已转过笔记的 `history_id` 集合。
    ///
    /// 两个地方要用，且都是**批量**场景，所以不能逐张卡片调 `note_by_history`：
    /// ① 卡片列表的 📝 角标（一屏几十张）；
    /// ② 待沉淀区的「无对应笔记」排除条件（规划 §1.6，存量 225 条候选）。
    pub fn note_history_ids(&self) -> Result<Vec<String>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare(
                // 带 deleted_at：删掉笔记后，那张卡片就不再是「已转笔记」了。
                "SELECT DISTINCT history_id FROM notes \
                 WHERE history_id IS NOT NULL AND deleted_at IS NULL",
            )
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    pub fn note_count(&self) -> i64 {
        self.lock_conn()
            .query_row("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap_or(0)
    }

    /// 笔记全文检索（规划 §7 L1 的第三路）。
    ///
    /// FTS 快速路径＋**失败回退 LIKE**——同 `try_search_fts` 的先例。
    /// 回退不是多余的：查询词里的特殊字符（引号 / `*` / `NEAR`）会让 FTS5 的
    /// MATCH 语法报错，而用户只是在搜一个带引号的词。
    pub fn note_search(
        &self,
        keyword: &str,
        folder_filter: &str,
        tag_ids: &[String],
        limit: u32,
    ) -> Result<Vec<Note>, String> {
        self.note_search_view(keyword, folder_filter, tag_ids, &NoteViewOpts::default(), limit)
    }

    /// 带视图选项的搜索（B2 #9）。
    ///
    /// 筛选 / 排序 / 分组在搜索下**也要生效**：否则用户筛着「无标签」一搜索，
    /// 筛选就静默失效了——而 chips 还亮在那里说自己生效着。
    pub fn note_search_view(
        &self,
        keyword: &str,
        folder_filter: &str,
        tag_ids: &[String],
        opts: &NoteViewOpts,
        limit: u32,
    ) -> Result<Vec<Note>, String> {
        let kw = keyword.trim();
        if kw.is_empty() {
            return self.note_list_view(folder_filter, tag_ids, opts, limit, 0);
        }
        let conn = self.lock_conn();

        // 快速路径：MATCH。查询词必须过 to_ngram，否则中文命中不了（见文件头部）。
        //
        // 筛选条件也要叠上：选着文件夹搜索时，用户的预期是「在这个文件夹里搜」，
        // 而不是搜索结果突然跳出当前范围。
        let mut fts_sql = format!(
            "SELECT {}, {} AS grp FROM notes{}
             WHERE notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)",
            note_cols_q(),
            opts.group_expr(),
            opts.joins()
        );
        let mut fts_params: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(to_match_expr(kw))];
        push_note_filters(&mut fts_sql, &mut fts_params, folder_filter, tag_ids);
        push_view_filters(&mut fts_sql, opts);
        fts_sql.push_str(&order_clause(opts));
        fts_params.push(Box::new(limit));

        let fts_res: Result<Vec<Note>, rusqlite::Error> =
            conn.prepare(&fts_sql).and_then(|mut stmt| {
                let refs: Vec<&dyn rusqlite::types::ToSql> =
                    fts_params.iter().map(|p| p.as_ref()).collect();
                let rows = stmt
                    .query_map(refs.as_slice(), row_to_note_grouped)?
                    .filter_map(|r| r.ok())
                    .collect::<Vec<_>>();
                Ok(rows)
            });

        let mut notes = match fts_res {
            Ok(v) => v,
            Err(e) => {
                // 不静默（规则 #15.3）：回退能给结果，但得知道 FTS 为什么挂了。
                log::warn!("[Notes] FTS 检索失败，回退 LIKE: {}", e);
                let mut like_sql = format!(
                    "SELECT {}, {} AS grp FROM notes{} WHERE (notes.title LIKE ? OR notes.content LIKE ?)",
                    note_cols_q(),
                    opts.group_expr(),
                    opts.joins()
                );
                let pattern = format!("%{}%", kw);
                let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> =
                    vec![Box::new(pattern.clone()), Box::new(pattern)];
                push_note_filters(&mut like_sql, &mut like_params, folder_filter, tag_ids);
                push_view_filters(&mut like_sql, opts);
                like_sql.push_str(&order_clause(opts));
                like_params.push(Box::new(limit));

                let mut stmt = conn.prepare(&like_sql).map_err(|e| e.to_string())?;
                let refs: Vec<&dyn rusqlite::types::ToSql> =
                    like_params.iter().map(|p| p.as_ref()).collect();
                // 必须先绑到局部变量再作为尾表达式：直接把链式调用放在块尾会让
                // MappedRows 的临时值比 `stmt` 活得久（E0597）。
                let rows: Vec<Note> = stmt
                    .query_map(refs.as_slice(), row_to_note_grouped)
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                rows
            }
        };
        for n in notes.iter_mut() {
            n.tags = Self::load_note_tags_on(&conn, &n.id);
        }
        Ok(notes)
    }

    /// 问答检索（B2 #10）：按**相关度**取 top-N，不按时间。
    ///
    /// 与 [`Self::note_search_view`] 是两件事，不能合并：那边是 AND 语义 + 按时间/标题排序，
    /// 为「找一篇笔记」而写；这边要的是「哪几篇最能回答这个问题」。
    /// 排序用 `bm25(notes_fts, 10.0, 1.0, 0.0)`：标题权重 10 倍（标题命中通常就是主题命中），
    /// `pinyin` 列权重 0（它是首字母索引，不该参与相关度）。**bm25 越小越相关**，故 ASC。
    ///
    /// **筛选照旧叠上**：文件夹 / 标签 / 三态筛选都生效——问答的范围就是用户眼前那个范围。
    ///
    /// 🔴 **故意不做 `note_search` 那样的 LIKE 回退。** 那边回退是对的（给不了结果不如给个模糊结果）；
    /// 而问答里的空结果会被展示成「知识库中没有相关笔记」——那是个**错答案**。
    /// 宁可报错让用户看见，也不能把检索挂了伪装成「你库里没这个」（规则 #15.3）。
    pub fn note_search_relevant(
        &self,
        question: &str,
        folder_filter: &str,
        tag_ids: &[String],
        opts: &NoteViewOpts,
        limit: u32,
    ) -> Result<Vec<Note>, String> {
        let expr = match question_to_or_expr(question) {
            Some(e) => e,
            None => return Ok(Vec::new()),
        };
        let conn = self.lock_conn();

        // JOIN 而不是 `rowid IN (SELECT …)`：bm25() 必须能在外层看见 notes_fts，
        // 子查询里的排名出不来。rowid 对应关系成立：sync_notes_fts_on 插入时
        // 显式写的就是 notes.rowid。
        let mut sql = format!(
            "SELECT {}, NULL AS grp FROM notes_fts
             JOIN notes ON notes.rowid = notes_fts.rowid
             WHERE notes_fts MATCH ?",
            note_cols_q()
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(expr)];
        push_note_filters(&mut sql, &mut params, folder_filter, tag_ids);
        push_view_filters(&mut sql, opts);
        // 不复用 order_clause：它排的是时间/标题，而这里要的是相关度。
        // 分组也不参与（上面固定给 `NULL AS grp`）：问答取的是 5 篇片段，没有分组语义。
        sql.push_str(" ORDER BY bm25(notes_fts, 10.0, 1.0, 0.0) LIMIT ?");
        params.push(Box::new(limit));

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut notes: Vec<Note> = stmt
            .query_map(refs.as_slice(), row_to_note_grouped)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for n in notes.iter_mut() {
            n.tags = Self::load_note_tags_on(&conn, &n.id);
        }
        Ok(notes)
    }

    // ===== 标签（复用 tags 主表，D2）=====

    /// 读一条笔记的标签。失败返回空 Vec 而不是报错：
    /// 标签读不到不应该让整条笔记取不出来（同 HistoryItem.tags 的取舍）。
    fn load_note_tags_on(conn: &rusqlite::Connection, note_id: &str) -> Vec<Tag> {
        let sql = "SELECT t.id, t.name, t.color, COALESCE(t.source, 'manual'), t.created_at
                   FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                   WHERE nt.note_id = ?1 ORDER BY t.name ASC";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[Notes] 标签查询准备失败: {}", e);
                return Vec::new();
            }
        };
        stmt.query_map([note_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                source: row.get::<_, String>(3).unwrap_or_else(|_| "manual".to_string()),
                created_at: row.get(4)?,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// 整体替换一条笔记的标签（先删后插，包在事务里）。
    ///
    /// 选「替换」而不是「增/删单条」：TagEditor 组件交的本来就是一整张标签集，
    /// 接口对齐它能免掉前端算 diff。`source` 固定 `manual`；
    /// B1 的 AI 自动标签会另走一个写 `'ai'` 的路径，**不要把这个方法改成带参数的**
    /// ——否则一次手动保存会把 AI 打的标签整批抹成 manual。
    pub fn note_set_tags(&self, note_id: &str, tag_ids: &[String]) -> Result<(), String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", [note_id])
            .map_err(|e| e.to_string())?;
        for tid in tag_ids {
            tx.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source) VALUES (?1, ?2, 'manual')",
                rusqlite::params![note_id, tid],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
}
