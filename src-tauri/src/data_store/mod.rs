mod history;
mod group;
mod tag;
mod kb_inbox;
mod kb_shadow;
mod mcp_audit;
mod note;
mod note_folder;
mod note_ai;
mod note_access;
mod note_daily;
mod note_md;
mod note_revision;
mod note_vault;
mod image_ocr;
mod snippet;
mod config;
mod ai_usage;
mod ai_action;
mod chains;
mod ai_feedback;
mod pref_signals;
mod content_memory;
mod profile;
mod sequence_memory;
mod action_events;
mod sticky;
mod quota;
mod stack_templates;
#[cfg(test)]
mod tests;
// 字段视图（B2 #9）的用例单独一个文件：tests.rs 已经 5000+ 行，再往里塞找不到东西。
#[cfg(test)]
mod tests_view;
// 问答雏形（B2 #10）的检索用例。同样单独一个文件。
#[cfg(test)]
mod tests_qa;

pub use ai_usage::{
    AiUsageByAction, AiUsageDaily, AiUsageEntry, AiUsageLogRow, AI_USAGE_RETAIN_DAYS,
};
pub use ai_action::{CustomAction, MAX_ACTION_DESC_CHARS, MAX_ACTION_NAME_CHARS};
pub use chains::{ChainDef, ChainStepDef, MAX_CHAIN_DESC_CHARS, MAX_CHAIN_NAME_CHARS, MAX_CHAIN_STEPS};
pub use ai_feedback::{
    ActionPrefRow, AiFeedback, AiFeedbackStat, AI_FEEDBACK_RETAIN_DAYS, FEEDBACK_ACCEPTED,
    FEEDBACK_EDITED, FEEDBACK_REJECTED,
};
pub use pref_signals::{
    PrefSignalTop, PREF_FEATURES, PREF_SIGNAL_MIN_COUNT, PREF_SIGNAL_RETAIN_DAYS,
};
pub use content_memory::{
    HistorySummary, cosine_sim, decode_vec, encode_vec, summarize_text,
};
pub use profile::ProfileRawStats;
pub use sequence_memory::{SequencePattern, SequenceTransition};
pub use action_events::{
    ActionEvent, ActionEventCount, ActionEventStats, ActionDismissal, ActionPin, ActionWeightRow,
    SceneWeightRow, ACTION_EVENTS_RETAIN_DAYS, ACTION_ID_PASTE, OUTCOME_ABANDONED,
    OUTCOME_COPIED, OUTCOME_PASTED, hour_bucket, source_cat,
};
pub use sticky::{CalendarDay, StickyStats};
pub use quota::{
    QuotaBlock, QuotaInfo, RedeemResult, SignResult, generate_redeem_code, redeem_secret,
    verify_redeem_code, DAILY_SPEND_CAP, INITIAL_GRANT, SIGN_CAP,
};
pub use kb_inbox::{InboxCandidate, InboxGroupCount, InboxViewOpts};
pub use kb_shadow::ShadowStats;
pub use mcp_audit::{McpAuditRow, McpClientRow};
// `question_to_or_expr` 对外暴露：MCP 的 kb_search 要用它分开「问题里没拆出词」
// 与「搜了但没命中」——对模型而言这两种的下一步完全不同。
pub use note::{question_to_or_expr, Note, NoteGroupCount, NoteViewOpts};
pub use note_folder::{NoteFolder, MAX_FOLDER_DEPTH};
pub use note_ai::{parse_ai_tags, AI_TAG_SOURCE};
pub use note_daily::DailyAppend;
pub use note_md::{
    markdown_to_note, note_to_markdown, safe_file_stem, to_markdown, MdOut, ParsedNote,
};
pub use note_revision::{NoteRevision, NoteRevisionMeta, MAX_REVISIONS};
pub use note_vault::{ExportReport, ImportReport};
pub use stack_templates::{
    StackTemplate, StackTemplateItem, MAX_STACK_TEMPLATE_ITEMS, MAX_STACK_TEMPLATE_NAME_CHARS,
};

use md5::{Digest, Md5};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// 判断是否为 SQLite "duplicate column name" 错误——ALTER TABLE ADD COLUMN 在列已存在时
/// （例如非首次启动的正常迁移场景）会报此错误，属于幂等场景，可安全忽略；
/// 其他错误（磁盘满、库损坏、权限等）则应视为真实失败并向上传播。
fn is_duplicate_column_error(e: &rusqlite::Error) -> bool {
    e.to_string().contains("duplicate column name")
}

/// 转义 LIKE 模式串中的通配符 `%`、`_` 以及转义符本身 `\`，
/// 需配合 SQL 中的 `ESCAPE '\\'` 子句使用，避免用户搜索文本中的 % / _ 被当作通配符解析。
pub(crate) fn escape_like_pattern(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ===== 数据模型 =====

/// `update_history_time` 的意图标记：这次把时间戳提前，算不算「内容又被采集了一次」。
///
/// 用枚举而不是 `bool`：调用点写 `TimeBump::Recapture` 能看出意图，写 `true` 看不出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeBump {
    /// 同一内容**被重新采集**：剪贴板重复复制 / 局域网同步来的同一条 / 相同截图。
    /// → `recopy_count` +1（§8.3 #2 的「🔁重复复制」信号）。
    Recapture,
    /// 只是同一条被**重新保存**（编辑器 Ctrl+S 但内容未变）。
    /// → 不计数。用户按了三次保存不等于这段内容重要。
    ResaveOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub text: String,
    pub time: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub content: String,
    pub pinned: bool,
    pub source: String,
    pub workspace: String,
    pub md5: Option<String>,
    #[serde(default)]
    pub pinyin_initials: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    /// 来源应用真实图标文件名（存储在 source-icons/ 目录下）
    #[serde(default)]
    pub source_icon: Option<String>,
    /// 统一内容类型（由 ContentClassifier 在插入时计算）
    #[serde(default)]
    pub content_type: Option<String>,
    /// 图片条目的 OCR 识别文本（image_ocr_cache 回填，仅 type=image 有值）。
    /// 三种状态：None=从未识别过；Some("")=识别过但无文字（阻止前端反复重试）；
    /// Some(非空)=识别结果。识别文本是本地 OCR 产物，不出本机。
    #[serde(default)]
    pub ocr_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub sort_order: i32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default = "default_tag_source")]
    pub source: String, // "manual" | "auto"
    pub created_at: String,
}

fn default_tag_source() -> String {
    "manual".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total: u32,
    pub pinned: u32,
    pub today: u32,
    pub text_count: u32,
    pub image_count: u32,
    pub file_count: u32,
    pub earliest_time: Option<String>,
    pub db_size_kb: f64,
}

/// 按天计数条目（近 7 天趋势图）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCount {
    pub date: String,
    pub count: u32,
}

/// 设置页「数据仪表盘」详细统计（get_stats_detail）：
/// 在基础统计之上增加昨日计数、近 7 天按天聚合、24 小时时段分布与来源 Top 5。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsDetail {
    pub total: u32,
    pub pinned: u32,
    pub today: u32,
    pub yesterday: u32,
    /// 近 7 天（含今天）升序，缺日补 0
    pub daily: Vec<DailyCount>,
    /// 0-23 时段复制计数（恒 24 槽）
    pub hours: Vec<u32>,
    pub text_count: u32,
    pub image_count: u32,
    pub file_count: u32,
    /// 来源 Top 5（按计数降序）
    pub sources: Vec<SourceCountEntry>,
    pub earliest_time: Option<String>,
    pub db_size_kb: f64,
}

/// 侧边栏聚合计数来源条目：某来源应用的记录数 + 代表性图标文件名
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCountEntry {
    pub source: String,
    pub count: u32,
    pub source_icon: Option<String>,
}

/// 侧边栏全量计数（GROUP BY 聚合，不依赖前端内存分页窗口）。
/// 前端侧边栏此前直接 filter 内存中已加载的分页窗口（初始 50 条、上限 500 条），
/// 导致计数随滚动变化、未加载的来源/分类不显示，与 TopBar 的 DB 计数互相矛盾。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarCounts {
    pub total: u32,
    pub pinned: u32,
    pub ungrouped: u32,
    pub sources: Vec<SourceCountEntry>,
    /// group_id → 记录数
    pub groups: std::collections::HashMap<String, u32>,
    /// tag_id → 记录数
    pub tags: std::collections::HashMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub copy_count: i64,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

// ===== 数据存储 =====

pub struct DataStore {
    pub(crate) conn: Mutex<Connection>,
    pub(crate) path: String,
}

impl DataStore {
    pub fn new(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        let db_path = path.to_string();

        // 创建表
        conn.execute_batch(
            "            CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL DEFAULT '',
                time TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                workspace TEXT NOT NULL DEFAULT '默认',
                md5 TEXT,
                pinyin_initials TEXT,
                source_icon TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_history_workspace ON history(workspace);
            CREATE INDEX IF NOT EXISTS idx_history_time ON history(time);
            CREATE INDEX IF NOT EXISTS idx_history_pinned ON history(pinned);

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- 一次性迁移的审计留痕。**不是迁移门闩**（本项目的迁移一贯靠探测真实结构
            -- 来判断该不该跑，见 history_fts 的 fts_is_external 与各处 pragma_table_info），
            -- 这张表只负责「跑过没跑过、什么时候、影响多少行」可事后追溯。
            --
            -- 为什么必须落库而不是只打日志：env_logger 在 RUST_LOG 未设时默认只放行
            -- error，全项目 170 个 warn / 128 个 info 一直输出到虚无。
            --
            -- 同一 name 允许多行（不设 UNIQUE）：**重复出现本身就是诊断信号**。
            -- 旧版「每次启动都全量回填」那个 bug，有这张表就会直接暴露成几十行同名记录。
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                tag TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                icon TEXT NOT NULL DEFAULT 'folder',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS history_tags (
                history_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                PRIMARY KEY (history_id, tag_id),
                FOREIGN KEY (history_id) REFERENCES history(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );

            -- 图片 OCR 结果缓存（见 data_store/image_ocr.rs）。
            -- 目的：卡片标题自动显示 OCR 文字，每张图片只识别一次、重启不重跑。
            -- full_text 为空串表示「识别过但无文字」——与「未识别过」区分，
            -- 防止无文字图片（纯图标/照片）被反复送去识别。
            -- 只存图片路径与识别文本，不存图片本体；文本是本地 OCR 产物，不出本机。
            CREATE TABLE IF NOT EXISTS image_ocr_cache (
                image_path TEXT PRIMARY KEY,
                full_text TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS regex_rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                pattern TEXT NOT NULL,
                replacement TEXT NOT NULL DEFAULT '',
                flags TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                preset INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            -- AI 调用明细账。**没有内容字段，也不得加**（见 data_store/ai_usage.rs）。
            -- 它新建于 v6，不需要 ALTER 迁移：IF NOT EXISTS 就是幂等的。
            CREATE TABLE IF NOT EXISTS ai_usage_log (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at        TEXT    NOT NULL,
                action_id         TEXT    NOT NULL,
                provider          TEXT    NOT NULL,
                model             TEXT    NOT NULL,
                prompt_tokens     INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd          REAL    NOT NULL DEFAULT 0,
                cached            INTEGER NOT NULL DEFAULT 0,
                latency_ms        INTEGER NOT NULL DEFAULT 0,
                ok                INTEGER NOT NULL DEFAULT 1,
                error             TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);

            -- 用户自定义的 AI 动作（见 data_store/ai_action.rs）。
            -- 名称 UNIQUE：两个同名动作在变换中心里根本分不清。
            CREATE TABLE IF NOT EXISTS ai_custom_actions (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL UNIQUE,
                description   TEXT NOT NULL DEFAULT '',
                icon          TEXT NOT NULL DEFAULT 'sparkles',
                template      TEXT NOT NULL,
                max_tokens    INTEGER NOT NULL DEFAULT 2000,
                content_types TEXT NOT NULL DEFAULT '',
                enabled       INTEGER NOT NULL DEFAULT 1,
                sort_order    INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            -- 动作使用日志（见 data_store/action_events.rs）。
            -- **没有内容字段，也不得加**：这里只记「动作 + 类型 + 来源 + 时段 + 结果」，
            -- 存内容就等于多一份剪贴板历史。它是 v6.0 起一切学习能力的燃料。
            -- history_id 是 v6.1 迁移列（见下方 ALTER），粘贴信号回写用它关联到具体条目。
            CREATE TABLE IF NOT EXISTS action_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at   TEXT    NOT NULL,
                action_id    TEXT    NOT NULL,
                content_type TEXT    NOT NULL DEFAULT '',
                source_app   TEXT    NOT NULL DEFAULT '',
                hour         INTEGER NOT NULL DEFAULT 0,
                outcome      TEXT    NOT NULL,
                history_id   TEXT,
                -- v6.15 X3 埋点：仅 action_id='paste' 时写。用于回答一个现在无法回答的问题：
                -- “用户粘的是列表的第几条”——如果本来就都粘第一条，那按目标应用重排（X3）就没必要做。
                -- 只存一个下标与一个类别枚举，不含任何内容本身（红线②）。
                paste_index  INTEGER,
                target_cat   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_action_events_created ON action_events(created_at);
            CREATE INDEX IF NOT EXISTS idx_action_events_action ON action_events(action_id);

            -- v6.9 免费额度账本（签到送 token，见 data_store/quota.rs）。
            -- 单行（id=1）本地账本：只记数字（token 额度），不含任何内容。
            CREATE TABLE IF NOT EXISTS ai_quota (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                device_id    TEXT    NOT NULL,
                granted      INTEGER NOT NULL DEFAULT 100000,
                sign_added   INTEGER NOT NULL DEFAULT 0,
                spent        INTEGER NOT NULL DEFAULT 0,
                sign_date    TEXT,
                sign_streak  INTEGER NOT NULL DEFAULT 0,
                redeemed     TEXT    NOT NULL DEFAULT '[]',
                today        TEXT    NOT NULL DEFAULT '',
                today_spent  INTEGER NOT NULL DEFAULT 0,
                updated_at   TEXT    NOT NULL
            );

            -- 用户自定义的动作链（X1 B2，见 data_store/chains.rs）。
            -- steps 存 JSON 数组（[{transformId, risk, label}]）——有序快照，从不单独查询。
            -- 名称 UNIQUE：两条同名链在运行器里分不清。
            CREATE TABLE IF NOT EXISTS chain_defs (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                steps       TEXT NOT NULL DEFAULT '[]',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            -- AI 结果反馈（M3 偏好学习，见 data_store/ai_feedback.rs）。
            -- **没有内容字段，也不得加**：只记动作、类型、三态与产物哈希。
            -- result_hash 是产物去重统计用的散列（非明文），用于统计同款结果被改过几次。
            CREATE TABLE IF NOT EXISTS ai_feedback (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at   TEXT    NOT NULL,
                action_id    TEXT    NOT NULL,
                content_type TEXT    NOT NULL DEFAULT '',
                outcome      TEXT    NOT NULL,
                result_hash  TEXT    NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_ai_feedback_created ON ai_feedback(created_at);
            CREATE INDEX IF NOT EXISTS idx_ai_feedback_action ON ai_feedback(action_id);

            -- 动作偏好指令（M3，见 data_store/ai_feedback.rs）。
            -- 一句话指令，由 ai_run 拼进 system prompt；action_id 主键。
            CREATE TABLE IF NOT EXISTS action_prefs (
                action_id   TEXT PRIMARY KEY,
                preference  TEXT NOT NULL DEFAULT '',
                updated_at  TEXT NOT NULL
            );

            -- 偏好信号（偏好自荐，见 data_store/pref_signals.rs）。
            -- **没有内容字段，也不得加**：feature 是写死的枚举（PREF_FEATURES），
            -- 前端本地比对（原文, 改后）后只上报标签，命令层再校一次白名单。
            -- 存在的意义：ai_feedback 只知道“被改过”，这张表知道“往哪个方向改”。
            CREATE TABLE IF NOT EXISTS pref_signals (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                action_id  TEXT NOT NULL,
                feature    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pref_signals_action ON pref_signals(action_id);
            CREATE INDEX IF NOT EXISTS idx_pref_signals_created ON pref_signals(created_at);

            -- 已处理的 (动作, 特征)：接受过或否决过都记在这里，不再重复提议。
            -- 不跟着 pref_signals 过期——否决是用户的明确表态，不能隔一阵就忘。
            CREATE TABLE IF NOT EXISTS pref_signal_done (
                action_id  TEXT NOT NULL,
                feature    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (action_id, feature)
            );

            -- 内容记忆（M5-1，见 data_store/content_memory.rs）。
            -- history 原文的「检索摘要」（域名/邮箱/正文头），只在本机、可一键清空。
            -- 敏感内容不记；清空后不自动补存量。
            CREATE TABLE IF NOT EXISTS history_summaries (
                history_id  TEXT PRIMARY KEY,
                summary     TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            -- 语义向量（M5-2，见 data_store/content_memory.rs）。
            -- 摘要（非原文）送云端 embedding 得到的向量，**存在本地**做余弦检索；
            -- 随摘要一起清空（删摘要 = 删向量）。model 记录生成它的模型，维度不一致时丢弃重建。
            CREATE TABLE IF NOT EXISTS semantic_vectors (
                history_id  TEXT PRIMARY KEY,
                model       TEXT NOT NULL,
                dim         INTEGER NOT NULL,
                vector      BLOB NOT NULL,
                created_at  TEXT NOT NULL
            );

            -- 「不再推荐这个」负反馈（v6.1，见 data_store/action_events.rs）。
            -- (action_id, content_type) 主键去重：重复点不再推荐是幂等操作。
            CREATE TABLE IF NOT EXISTS action_dismissals (
                action_id    TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL,
                PRIMARY KEY (action_id, content_type)
            );

            -- 「常用置顶」正向偏好（v6.14，见 data_store/action_events.rs）。
            -- 与上面的 action_dismissals 一正一负：一个说“别推这个”，一个说“这个给我排前面”。
            --
            -- 为何需要它：推荐的五个因子里四个（global/scene/sequence/quality）都吃行为数据，
            -- 而行为数据在冷启动时根本不存在——形成“推荐不准 → 用户不用 → 没数据 → 更不准”的死锁。
            -- 置顶是唯一能从内部打破它的动作：用户直接表达意图→开始用→行为数据有了→四个因子活过来。
            --
            -- content_type 空串 = 全局置顶。本版只用全局，但存结构先留好按类型细化的位置。
            CREATE TABLE IF NOT EXISTS action_pins (
                action_id    TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL,
                PRIMARY KEY (action_id, content_type)
            );

            -- 粘贴栈常用模板（P4，见 data_store/stack_templates.rs）。
            -- items 存 JSON 数组（内容快照，不引用 history）；name UNIQUE。
            -- used_at 为 NULL 表示从未用过，载入时回写。
            CREATE TABLE IF NOT EXISTS stack_templates (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                items       TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT NOT NULL,
                used_at     TEXT
            );

            -- ===== 知识库 A 阶段（D15 三模式里的「知识」模式）=====
            -- 源：docs/个人知识库与笔记-规划.md §6。
            -- 与规划原 DDL 有三处**有意偏离**，都是照真实代码纠正的（规划已同步）：
            --   ① note_tags.tag_id 用 TEXT 而不是规划写的 INTEGER——tags.id 是
            --      TEXT PRIMARY KEY，INTEGER 没法外键到它；
            --   ② created_at / updated_at 用 TEXT 而不是 INTEGER——全库时间戳惯例是
            --      '%Y-%m-%d %H:%M:%S' 字符串，用 epoch 会让 notes 成为唯一例外，
            --      跟 history.time 的排序口径分裂；
            --   ③ note_tags 补了 source 列（history_tags 有）——B1 要加 AI 自动标签，
            --      现在不带将来还得迁一次（同规划给 source_agent 的理由）。
            CREATE TABLE IF NOT EXISTS notes (
                id           TEXT PRIMARY KEY,
                history_id   TEXT,                     -- 来源卡片，可空（独立新建的笔记没有来源）
                title        TEXT NOT NULL DEFAULT '',
                content      TEXT NOT NULL DEFAULT '', -- Markdown 正文；[[..]] 原样保存，A 阶段不解析（D7）
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                -- D13：将来由外部 agent 写入的笔记记来源（agent:claude-code / agent:cursor…）。
                -- M4 才启用，但 A 阶段建表就带上，免二次迁移。
                source_agent TEXT NOT NULL DEFAULT '',
                -- W1 软删除：非 NULL = 已删，值是删除时刻。**不是**多余的谨慎——
                --   ① MCP 要放开写入给外部模型，硬删加上 note_revisions 的
                --      ON DELETE CASCADE，一次误删就是笔记 + 20 份历史一起没，不可恢复；
                --   ② M6 多机同步需要墓碑：没有它，A 机的删除会被 B 机的旧副本同步回来。
                -- 两条互不相干的需求指向同一个列，所以它该在这里。
                deleted_at   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_notes_history ON notes(history_id);
            -- 规划只列了 idx_notes_history；这条是额外加的：笔记列表默认按
            -- updated_at DESC 排（同 history 有 idx_history_time）。
            CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);

            -- 笔记标签：复用既有 tags 主表，模式同 history_tags（D2）。
            -- FK 是真生效的（下方 PRAGMA foreign_keys=ON），所以删笔记会自动清关联行。
            CREATE TABLE IF NOT EXISTS note_tags (
                note_id TEXT NOT NULL,
                tag_id  TEXT NOT NULL,
                source  TEXT NOT NULL DEFAULT 'manual',
                PRIMARY KEY (note_id, tag_id),
                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id)  REFERENCES tags(id)  ON DELETE CASCADE
            );

            -- 待沉淀区的「忽略」记忆（§1.6 闸门二，A 阶段即需建表）。
            -- 粒度是**整卡忽略**（按 history_id 主键）——用户说「这条别烦我」更符合直觉。
            -- **故意不建到 history 的外键**：卡片被清理后这里留孤儿行，量小不清，
            -- 查询时自然过滤掉（规划 §6 生命周期 ② 已定此口径）。
            CREATE TABLE IF NOT EXISTS kb_inbox_dismissed (
                history_id TEXT PRIMARY KEY,
                reason     TEXT NOT NULL,   -- star / research / repeat / rule / ocr / ai
                created_at TEXT NOT NULL
            );

            -- 自动收录的**影子运行**记录（§1.6 自动收录档，A 阶段）。
            -- 它只回答一个问题：「如果自动收录开着，会收哪几条？」——**不落库、不影响任何界面**。
            -- 一周后拿它与用户实际手动转的集合对比算准确率，≥ 60% 才在 B2 真开。
            --
            -- 为何不另存「用户手动转了哪些」：`notes.history_id` 已经就是那个集合
            -- （A 阶段没有任何自动写入路径，有笔记就是人手动转的）。再记一份就是两份真相。
            --
            -- `rule_ver` 必须有：阈值（5 / 200 / 7 天）全是拍的，调了之后旧命中不能
            -- 跟新命中混算准确率，否则这个度量本身就废了。
            CREATE TABLE IF NOT EXISTS kb_autofile_shadow (
                history_id   TEXT NOT NULL,
                rule_ver     TEXT NOT NULL,   -- 阈值组合的指纹，见 kb_shadow.rs 的 RULE_VER
                first_hit_at TEXT NOT NULL,   -- 首次命中（算「一周后」的基准）
                last_hit_at  TEXT NOT NULL,
                hit_rounds   INTEGER NOT NULL DEFAULT 1,  -- 命中过几轮，规则稳定性的旁证
                PRIMARY KEY (history_id, rule_ver)
            );

            -- 笔记文件夹（B1 #1）。**规划 §6 未预留此表**，形态由设计稿补定：
            -- design/PastePanda-知识库视图-设计稿.html §5。
            --
            -- 邻接表而不是物化路径：改名/移动是文件夹最高频的操作，邻接表只改一行；
            -- 物化路径要批量改所有后代，漏一行就是孤儿路径。代价是**必须自己防环**
            -- （详见 note_folder.rs 的 folder_move）。
            --
            -- ❗ `ON DELETE CASCADE` 在这里只级联删**子文件夹**。笔记绝不随文件夹删——
            --   那一条靠 notes.folder_id 的 ON DELETE SET NULL（见下方迁移）。
            CREATE TABLE IF NOT EXISTS note_folders (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                parent_id  TEXT,                       -- NULL = 顶层
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES note_folders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_note_folders_parent ON note_folders(parent_id);

            -- 版本快照（D8 / B1 #4）。design/PastePanda-版本快照-设计稿.html §5。
            --
            -- 存的是**旧版本**：每次 note_update 在 UPDATE 之前把当时的 notes 行拍一张。
            -- 所以这张表里永远不含「当前版」（当前版只在 notes），不会多一份冗余副本。
            --
            -- 🔴 `FOREIGN KEY` 是**规划 §6 漏写的**（只写了 note_id TEXT NOT NULL）。
            --   PRAGMA foreign_keys 真开着，不补就是：删一条笔记，它的 20 份历史
            --   永远留在库里无人回收。与 note_tags 同口径。
            --
            -- pinned / source_agent 是 W2 加的（旧库靠下方迁移补上）：
            --   pinned = 1 的快照**永不被 prune 裁掉**。没这一列，模型连续改 21 次
            --   就把你的真实历史全挤没了，而那只需「修改」一个权限。
            CREATE TABLE IF NOT EXISTS note_revisions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id      TEXT NOT NULL,
                title        TEXT NOT NULL,
                content      TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                pinned       INTEGER NOT NULL DEFAULT 0,
                source_agent TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_note_rev ON note_revisions(note_id, created_at);

            -- MCP 调用审计（W3）。红线②：使用日志永不出本机，且用户可见可删。
            --
            -- 🔴 **绝不记返回正文**。记了等于把整个知识库再抄一份到审计表里，
            -- 体积与泄露面都翻倍，而且回收站清了这里还留着副本。
            -- 记 note_ids 不记内容：既能回答「谁、何时、读走了哪几篇」，又不重复存储。
            --
            -- client 填的是请求的 User-Agent（实测 Claude Code 发的是
            -- `claude-code/2.1.233 (sdk-cli)`）。**不用 clientInfo**——MCP over HTTP
            -- 是无状态的，clientInfo 只在 initialize 里出现一次，后续的 tools/call
            -- 根本不带；而 UA **每个请求都有**。
            --
            -- 客户端花名册不单开表：`GROUP BY client` 就是花名册。
            CREATE TABLE IF NOT EXISTS mcp_audit (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at         TEXT NOT NULL,
                client     TEXT NOT NULL DEFAULT '',
                tool       TEXT NOT NULL,
                args       TEXT NOT NULL DEFAULT '',
                ok         INTEGER NOT NULL DEFAULT 1,
                hit_count  INTEGER NOT NULL DEFAULT 0,
                note_ids   TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_mcp_audit_at ON mcp_audit(at);",
        )?;

        // 笔记全文索引。**常规 FTS5，不是外部内容表**——同 history_fts 的取舍
        // （见下方 history_fts 那段长注释：外部内容表与「手工塞 ngram 串」根本矛盾）。
        // 列序 (title, content, pinyin) 照规划 §6。
        // 新表，没有存量要回填（不像 history_fts / image_ocr_fts 那样需要）。
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, pinyin);",
        )?;

        // 数据库迁移：为旧数据库添加 pinyin_initials 列（如果不存在）
        let has_pinyin: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'pinyin_initials'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_pinyin {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN pinyin_initials TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] pinyin_initials 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 pinyin_initials 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 snippets 表添加 tag 列（如果不存在）
        let has_tag: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('snippets') WHERE name = 'tag'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_tag {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE snippets ADD COLUMN tag TEXT NOT NULL DEFAULT '';")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] snippets.tag 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 snippets.tag 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 snippets 表添加 copy_count / last_used_at 列（如果不存在）
        let has_copy_count: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('snippets') WHERE name = 'copy_count'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_copy_count {
            if let Err(e) = conn.execute_batch(
                "ALTER TABLE snippets ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 0;",
            ) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] snippets.copy_count 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 snippets.copy_count 列失败: {}", e);
                    return Err(e);
                }
            }
        }
        let has_last_used: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('snippets') WHERE name = 'last_used_at'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_last_used {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE snippets ADD COLUMN last_used_at TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] snippets.last_used_at 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 snippets.last_used_at 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为 action_events 添加 history_id 列（v6.1，粘贴信号回写关联用）
        let has_history_id: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('action_events') WHERE name = 'history_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_history_id {
            if let Err(e) = conn
                .execute_batch("ALTER TABLE action_events ADD COLUMN history_id TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] action_events.history_id 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 action_events.history_id 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // v6.15 X3 埋点：paste_index / target_cat（两列一起加，缺一不可——
        // 只有下标没类别无法分组对比，只有类别没下标则什么也算不出来）。
        for (col, ddl) in [
            ("paste_index", "ALTER TABLE action_events ADD COLUMN paste_index INTEGER;"),
            ("target_cat", "ALTER TABLE action_events ADD COLUMN target_cat TEXT;"),
        ] {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('action_events') WHERE name = ?1",
                    [col],
                    |row| row.get::<_, i32>(0),
                )
                .unwrap_or(0)
                > 0;
            if exists {
                continue;
            }
            if let Err(e) = conn.execute_batch(ddl) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] action_events.{} 列已存在，忽略: {}", col, e);
                } else {
                    log::error!("[DataStore] 添加 action_events.{} 列失败: {}", col, e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history 表添加 group_id 列（如果不存在）
        let has_group_id: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'group_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_group_id {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN group_id TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] group_id 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 group_id 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 tags 表添加 source 列（如果不存在）
        let has_source: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name = 'source'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_source {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] tags.source 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 tags.source 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history 表添加 source_icon 列（如果不存在）
        let has_source_icon: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'source_icon'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_source_icon {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN source_icon TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] source_icon 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 source_icon 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为旧 history 表添加 content_type 列（如果不存在）
        let has_content_type: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'content_type'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_content_type {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN content_type TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] content_type 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 content_type 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // v6.4 D 搜索：FTS5 全文索引。索引内容在 Rust 侧做字符 bigram 预处理
        // （to_ngram），中文才能被分词命中；增删改在 history.rs 同步。
        //
        // **常规 FTS5，刻意不是外部内容表**（v6.18 修）。旧实现写的是
        // `content='history', content_rowid='rowid'`，与"手工塞 ngram 串"根本矛盾：
        // 外部内容表意味着 FTS5 在 DELETE / rebuild 时要回读 history 的原始列，
        // 而它既取不到 `pinyin`（history 里那列叫 `pinyin_initials`），
        // 取到的也不是 ngram 串。加上 FTS5 虚拟表不支持 UPSERT，
        // 结果是同步与删除两条路径全年报错、被 log::warn 吞掉（详见 history.rs）。
        //
        // 旧库建成了外部内容表 → 这里一次性 DROP 重建，随后走下面的全量回填。
        let fts_is_external: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'history_fts' AND sql LIKE '%content=''history''%'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        if fts_is_external {
            log::info!("[FTS] 检测到旧的外部内容表结构，重建 history_fts 并全量回填");
            conn.execute_batch("DROP TABLE IF EXISTS history_fts;")?;
        }
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, pinyin, content);",
        )?;

        // 首次建表（或索引为空）时全量回填存量数据。回填失败只 warn，不阻断启动。
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_fts", [], |r| r.get(0))
            .unwrap_or(0);
        if fts_count == 0 {
            match Self::backfill_history_fts_on(&conn) {
                Ok(n) if n > 0 => {
                    log::info!("[FTS] 已回填 {} 条历史记录到全文索引", n);
                    // 留痕。重建（旧结构升级）与自愈（索引空了重填）用不同的 name，
                    // 事后才分得清那次到底是升级还是异常恢复。
                    Self::record_migration_on(
                        &conn,
                        if fts_is_external {
                            "history_fts_rebuild"
                        } else {
                            "history_fts_backfill"
                        },
                        &format!("rows={}, was_external={}", n, fts_is_external),
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("[FTS] 存量回填失败: {}", e);
                    Self::record_migration_on(
                        &conn,
                        "history_fts_backfill_failed",
                        &format!("error={}, was_external={}", e, fts_is_external),
                    );
                }
            }
        }

        // 图片 OCR 文本的全文索引。**独立于 history_fts，且刻意不是外部内容表**：
        //
        // 1. OCR 是异步的（图片先入库、文字后到），所以这张索引必须支持「事后更新」。
        //    而 FTS5 虚拟表不支持 UPSERT，外部内容表连 DELETE 都要回读旧值——
        //    history_fts 的列名（pinyin）与 history 的列名（pinyin_initials）对不上，
        //    回读直接失败。常规 FTS5 自己存 token，DELETE + INSERT 才是可用的更新路径。
        // 2. 图片的 history.content 是 md5 文件名（0039a52c….png），没有检索价值，
        //    所以 OCR 文本不能塞进 history_fts 的 content 列去挤掉它——那是两回事。
        //
        // rowid 与 history.rowid 对齐，检索时直接 OR 进 try_search_fts 的子查询。
        // 内容是本地 OCR 产物，与 image_ocr_cache 同级，不出本机。
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS image_ocr_fts USING fts5(ocr);",
        )?;

        // 存量回填：v6.18 之前识别过的图片，文本已在 image_ocr_cache 里但从未进索引。
        // 空索引才回填（同 history_fts 的 fts_count == 0 惯例），不必额外设迁移标记位。
        // 实现在 image_ocr.rs 的 backfill_ocr_fts（可测；这里只负责启动时调一次）。
        let ocr_fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM image_ocr_fts", [], |r| r.get(0))
            .unwrap_or(0);
        if ocr_fts_count == 0 {
            match Self::backfill_ocr_fts_on(&conn) {
                Ok(n) if n > 0 => {
                    log::info!("[FTS] 已回填 {} 张图片的 OCR 文本到全文索引", n)
                }
                Ok(_) => {}
                Err(e) => log::warn!("[FTS] OCR 存量回填失败: {}", e),
            }
        }

        // 数据库迁移：为旧 history_tags 表添加 source 列（如果不存在）
        let has_ht_source: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history_tags') WHERE name = 'source'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_ht_source {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] history_tags.source 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 history_tags.source 列失败: {}", e);
                    return Err(e);
                }
            }
            // 将已有自动标签关联的 source 同步为 'auto'（通过 tags.source 判断）
            let _ = conn.execute_batch(
                "UPDATE history_tags SET source = 'auto'
                 WHERE tag_id IN (SELECT id FROM tags WHERE source = 'auto')
                   AND history_tags.source = 'manual';",
            );
        }

        // 数据库迁移：为 history 添加 search_hit_count 列（v6.1 自我净化——
        // "被搜索命中过"是高价值信号，豁免过期清理；get_history 搜索时批量 +1）
        let has_search_hit: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'search_hit_count'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_search_hit {
            if let Err(e) = conn.execute_batch(
                "ALTER TABLE history ADD COLUMN search_hit_count INTEGER NOT NULL DEFAULT 0;",
            ) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] history.search_hit_count 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 history.search_hit_count 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移（B2 前置）：history.recopy_count ——同一内容被**重复采集**的次数。
        //
        // 这是 §8.3 #2 的「🔁重复复制」信号。之前去重只把时间戳提到最新，**次数没留下来**。
        //
        // ❗ 叫 `recopy_count` 而不是 `copy_count`：`snippets.copy_count` 已经存在且是另一个意思
        //   （片段被使用的次数）。两个同名列不同语义是日后读错的源头。
        //
        // 它是计数器：**只有累加过一段时间才有值**，所以先落列开始写，读它的 UI 晚一步做。
        let has_recopy: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'recopy_count'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_recopy {
            if let Err(e) = conn
                .execute_batch("ALTER TABLE history ADD COLUMN recopy_count INTEGER NOT NULL DEFAULT 0;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] history.recopy_count 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 history.recopy_count 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移（B2 前置）：history.search_hit_at ——**最近一次**被搜索命中的时间。
        //
        // `search_hit_count` 只答「被找回过几次」，答不了「多久没找过」。
        // A-32 那次待沉淀区设计稿里的「最近一次找回」就是因为这列不存在而停工、推到 B2。
        let has_hit_at: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history') WHERE name = 'search_hit_at'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_hit_at {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE history ADD COLUMN search_hit_at TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] history.search_hit_at 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 history.search_hit_at 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移（B2 前置）：notes.last_access_at ——笔记最后一次被**打开阅读**的时间。
        //
        // §8.3 #7 重现的选取口径是「久未访问 × 当初信号强度」，而「久未访问」目前无数据源：
        // `updated_at` 是「最后一次被改」，不是「最后一次被看」——只读不改的笔记永远显得「很久没动」。
        // ❗ 不在 `note_get` 里自动写：它被 note_ai / note_revision 内部调用，那不是用户在看。
        //   写入走一个显式的 note_touch（参见 data_store/note_access.rs）。
        let has_last_access: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'last_access_at'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_last_access {
            if let Err(e) = conn.execute_batch("ALTER TABLE notes ADD COLUMN last_access_at TEXT;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] notes.last_access_at 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 notes.last_access_at 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移（B1 置顶）：notes.pinned。
        //
        // ❗ 不要与 `note_revisions.pinned` 搞混：后者是 **W2 的版本锚定**
        //   （保护某一份快照不被 prune 掉），跟「把这条笔记置顶」是两回事。
        //   两个列同名但不同表、不同语义，改任一个都不影响另一个。
        //
        // 不建索引：置顶只出现在 ORDER BY 里（不做 WHERE 筛选），
        // 而个人规模下笔记总量千条量级，一个布尔列的索引选择性极差、负收益。
        let has_note_pinned: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'pinned'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_note_pinned {
            if let Err(e) =
                conn.execute_batch("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")
            {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] notes.pinned 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 notes.pinned 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为 notes 添加 folder_id 列（B1 #1 文件夹）。
        //
        // **这是迁移而不是建表的一部分**：notes 在 A 阶段就已建好并有了真实数据，
        // 往 CREATE TABLE 里加列对已存在的表无效（IF NOT EXISTS 直接跳过）。
        //
        // ❗ `REFERENCES ... ON DELETE SET NULL` 是本条的全部意义：
        //   删文件夹**绝不能删笔记**，只是把它们变回「未分类」。
        //   （note_folders.parent_id 那边是 CASCADE，只级联子文件夹——两个行为故意不同。）
        //   SQLite 允许 ALTER TABLE ADD COLUMN 带 REFERENCES，前提是默认值为 NULL——此处正是。
        let has_note_folder: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'folder_id'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_note_folder {
            if let Err(e) = conn.execute_batch(
                "ALTER TABLE notes ADD COLUMN folder_id TEXT
                     REFERENCES note_folders(id) ON DELETE SET NULL;
                 CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);",
            ) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] notes.folder_id 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 notes.folder_id 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 数据库迁移：为 notes 添加 summary 列（B1 轻量 AI 的一行摘要）。
        //
        // 同 folder_id，走迁移而不是建表（老库的 notes 已存在）。
        // 允许为 NULL：**没生成过摘要与摘要为空串是两回事**——
        // 前者该在列表里回退到正文截断，后者是用户手动清空的。
        let has_note_summary: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'summary'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_note_summary {
            if let Err(e) = conn.execute_batch("ALTER TABLE notes ADD COLUMN summary TEXT;") {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] notes.summary 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 notes.summary 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // notes.daily_date —— 今日速记（B2 #3 / D11）的**身份列**。
        //
        // 为何不靠「标题等于当天日期」去找那一条：标题用户随时能改，
        // 也可能手动建一条同名的。一旦改了，第二天就会另建一条、今天这条变孤儿，
        // 而用户完全不知道发生了什么——同 #5 导出「文件名不可逆所以身份靠
        // pastepanda_id」的教训。
        let has_note_daily: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'daily_date'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_note_daily {
            if let Err(e) = conn.execute_batch("ALTER TABLE notes ADD COLUMN daily_date TEXT;") {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] notes.daily_date 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 notes.daily_date 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // W1 软删除列（语义见建表处注释）。**必须排在 idx_notes_daily 之前**：
        // 下面那条唯一索引的谓词要引用 deleted_at，列不在就建不出来。
        let has_note_deleted: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'deleted_at'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;
        if !has_note_deleted {
            if let Err(e) = conn.execute_batch("ALTER TABLE notes ADD COLUMN deleted_at TEXT;") {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] notes.deleted_at 列已存在，忽略: {}", e);
                } else {
                    log::error!("[DataStore] 添加 notes.deleted_at 列失败: {}", e);
                    return Err(e);
                }
            }
        }

        // 回收站列表的索引。部分索引：只收已删那几行。
        // 建在全表上没意义——`deleted_at IS NULL` 命中的是绝大多数行，走索引反而更慢。
        if let Err(e) = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_notes_deleted
             ON notes(deleted_at) WHERE deleted_at IS NOT NULL;",
        ) {
            log::error!("[DataStore] 建 idx_notes_deleted 失败: {}", e);
            return Err(e);
        }

        // W2 锚定快照：note_revisions 补两列，**同一次迁移**。
        // 只加 pinned 的话，将来要在历史列表里分辨「模型改的」还是「你自己改的」
        // 还得再迁一次库（A-52 ④）。
        //
        // pinned       —— 1 = 锚定，prune 时豁免（见 note_revision.rs）。
        // source_agent —— '' = 人工编辑；非空 = 外部写入，形如 `agent:claude-code`。
        for (col, ddl) in [
            (
                "pinned",
                "ALTER TABLE note_revisions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "source_agent",
                "ALTER TABLE note_revisions ADD COLUMN source_agent TEXT NOT NULL DEFAULT '';",
            ),
        ] {
            let has: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('note_revisions') WHERE name = ?1",
                    [col],
                    |row| row.get::<_, i32>(0),
                )
                .unwrap_or(0)
                > 0;
            if has {
                continue;
            }
            if let Err(e) = conn.execute_batch(ddl) {
                if is_duplicate_column_error(&e) {
                    log::warn!("[DataStore] note_revisions.{} 列已存在，忽略: {}", col, e);
                } else {
                    log::error!("[DataStore] 添加 note_revisions.{} 列失败: {}", col, e);
                    return Err(e);
                }
            }
        }

        // 一天只能有一条速记——这条约束得落在库上。
        // 只靠应用层「先查再插」的话，热键连按两下就可能撞出两条同日笔记。
        // 部分索引：普通笔记的 NULL 不参与唯一性（SQLite 本就允许多个 NULL，
        // 写上 WHERE 是为了让意图显式，也让索引只覆盖速记那几行）。
        //
        // ❗ W1 后谓词多了 `AND deleted_at IS NULL`，这是必须的：
        //   软删的速记行还占着它的 daily_date，不排掉的话「删掉今天的速记后
        //   再按一次速记热键」会直接撞 UNIQUE 约束——用户看到的是速记彻底坑了。
        //
        // `IF NOT EXISTS` 对已存在的旧索引是空操作，改不了谓词，所以存量库必须先 DROP。
        // 只在旧定义上 DROP（查 sqlite_master 的原文），不是每次启动都重建。
        let daily_idx_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_daily'",
                [],
                |r| r.get(0),
            )
            .ok();
        if daily_idx_sql
            .as_deref()
            .is_some_and(|s| !s.contains("deleted_at"))
        {
            if let Err(e) = conn.execute_batch("DROP INDEX IF EXISTS idx_notes_daily;") {
                log::error!("[DataStore] 重建 idx_notes_daily 前的 DROP 失败: {}", e);
                return Err(e);
            }
            log::info!("[DataStore] idx_notes_daily 已按 W1 软删除语义重建");
        }
        if let Err(e) = conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_daily
             ON notes(daily_date) WHERE daily_date IS NOT NULL AND deleted_at IS NULL;",
        ) {
            log::error!("[DataStore] 建 idx_notes_daily 失败: {}", e);
            return Err(e);
        }

        // 启用 WAL 模式 + 性能/可靠性优化
        // WAL：写操作不阻塞读，并发更好，崩溃恢复更安全
        // synchronous=NORMAL：WAL 模式下足够安全，大幅提升写入性能
        // cache_size=-8000：8MB 缓存（负值表示 KB），减少磁盘 I/O
        // busy_timeout=5000：等待 5 秒而非立即返回 SQLITE_BUSY
        //
        // ❗ journal_size_limit：**必须设**，否则 -wal 文件大小是个只涨不落的高水位。
        //   自动 checkpoint（wal_autocheckpoint 默认 1000 页）跑的是 **PASSIVE** 模式：
        //   它把页合并回主库后会重用 WAL 空间，但**不会把文件截短**。
        //   本项目单张图上限 50MB（clipboard_monitor.rs 的 MAX_IMAGE_BYTES），
        //   复制几张大图就能把 WAL 顶到几百 MB 然后永久停在那里。
        //   实测现场：主库 5MB 而 -wal 209MB（40 倍）。后果是磁盘白占、
        //   启动要扫整个 WAL、崩溃恢复变慢。
        //   设了之后，每次 checkpoint 完成会把 WAL 截回这个上限以内。
        //   32MB 的取法：要能装下一张典型大图的写入，又不致于白占磁盘。
        //   顺序重要：必须排在 journal_mode=WAL 之后。
        let pragmas = [
            "PRAGMA journal_mode=WAL;",
            "PRAGMA journal_size_limit=33554432;",
            "PRAGMA synchronous=NORMAL;",
            "PRAGMA cache_size=-8000;",
            "PRAGMA busy_timeout=5000;",
            "PRAGMA foreign_keys=ON;",
        ];
        for pragma in &pragmas {
            if let Err(e) = conn.execute_batch(pragma) {
                log::warn!("[DataStore] PRAGMA 设置失败 ({}): {}", pragma, e);
            }
        }

        // 一次性回收：上面的 journal_size_limit 只在「下一次 checkpoint 完成」时生效，
        // 而已经膨胀的存量文件可能要等很久才碰上那个时机。这里主动做一次
        // TRUNCATE checkpoint 把存量降下去。
        // 安全性：checkpoint 是把 WAL 合并回主库，**不丢数据**；此时还没有其他
        // 读者（刚 open 完），不会因为旧快照被卡住。
        // 失败不致命（比如真的有并发进程占着），下次自动 checkpoint 会接上。
        {
            let t0 = std::time::Instant::now();
            match conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
                Ok(()) => log::info!(
                    "[DataStore] WAL 已 checkpoint(TRUNCATE)，耗时 {:?}",
                    t0.elapsed()
                ),
                Err(e) => log::warn!(
                    "[DataStore] WAL checkpoint(TRUNCATE) 失败（不影响使用，下次自动 checkpoint 会接上）: {}",
                    e
                ),
            }
        }

        Ok(Self {
            conn: Mutex::new(conn),
            path: db_path,
        })
    }

    /// 获取 DB 连接锁（容忍中毒 — Low 修复）。
    /// 若某持有者 panic 导致 Mutex 中毒，此后所有 lock() 都会永久失败，
    /// DB 访问将彻底瘫痪直到重启。rusqlite 单条语句具备原子性，panic 后
    /// 连接本身仍可用，因此直接 into_inner() 恢复。
    pub(crate) fn lock_conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// 计算文本的拼音首字母（仅中文字符）
pub fn compute_pinyin_initials(text: &str) -> String {
    let args = pinyin::Args::new();
    let pys = pinyin::lazy_pinyin(text, &args);
    let mut initials = String::new();
    for (i, py) in pys.iter().enumerate() {
        if i >= 50 {
            break;
        }
        if let Some(first) = py.chars().next() {
            if first.is_alphabetic() {
                initials.push(first.to_ascii_uppercase());
            }
        }
    }
    initials
}
