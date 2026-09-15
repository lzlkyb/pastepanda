//! MCP 工具的数据来源。
//!
//! # 为什么是 trait，而不是让 `Ctx` 直接拿 `AppHandle`
//!
//! 过线测试需要一个能控制的数据源。若 handler 直接依赖 `AppHandle`，
//! 就得造一个 Tauri App——而 `tauri::test::mock_app()` 那条路已经验过在本机不通
//! （它要的 `test` feature 会把 lib test 二进制链到本机不存在的 `ProcessPrng`，
//! 详见 Cargo.toml 里那段警告）。
//!
//! 抽成 trait 后，生产走 [`AppKbSource`]，测试塞一个手搭的假实现。

use super::gate::{FolderTree, WriteScope, WriteSwitches};
use super::pulse;
use crate::data_store::{
    DataStore, Note, NoteFolder, NoteRevision, NoteRevisionMeta, NoteUpdateReport, NoteViewOpts,
};
use crate::markdown::{apply, ContentEdit, EditReport};

/// `kb_list` 的结果。
///
/// 🔴 用枚举而不是 `Vec<Note>` + “记得判空”：**R6 要求未知标签不能退化成
/// 「返回全库第一页」**。靠约定记得判迟早会漏，做成类型就漏不了——
/// 而那个退化对模型来说是最难发现的：它会拿到一堆看似合理的结果，
/// 完全不知道自己的筛选条件被静默丢掉了。
pub enum ListOutcome {
    Ok(Vec<Note>),
    UnknownFolder(String),
    UnknownTag(String),
    /// ③甲：`author` 点名了一个从未写过东西的 agent。
    UnknownAuthor { asked: String, known: Vec<String> },
}

/// `kb_search` 的结果。
///
/// 区分两种「没结果」是有必要的，因为对模型来说它们的**下一步完全不同**：
/// - [`NoSearchableTerms`](Self::NoSearchableTerms)：问题本身没拆出词（全是单字/停用词）
///   → 换个问法重试就能成；
/// - [`NoMatch`](Self::NoMatch)：真搜了但没命中 → 换关键词或改用 `kb_list` 浏览。
///
/// 把两者合并成空数组，模型就只能猜，而它猜错的后果是告诉用户「你库里没记过」。
/// —— AM-1a 又加了两种：范围参数本身就是错的。
/// 这两种不能归入 [`NoMatch`](Self::NoMatch)：模型会把“文件夹名写错了”
/// 读成“这个文件夹里没有相关笔记”，然后带着错结论走下去。
pub enum SearchOutcome {
    Hits(Vec<Note>),
    NoSearchableTerms,
    NoMatch,
    UnknownFolder(String),
    UnknownTag(String),
    /// AM-7：`kind` 参数本身不是个合法类别名（含空格、太长、是 `x` 等）。
    ///
    /// 与「没匹配到」分开报：前者是**参数写错了**，后者是**库里确实没有**。
    /// 混成一个，模型会把自己的笔误读成结论。
    BadKind(String),
    /// AM-7：查询本身有命中，但没有一篇记过这个类别。
    ///
    /// 带上 `matched`（筛掉前有几篇）——只说「没找到」会让模型以为
    /// 连关键词都不匹配，从而换一个完全不同的词重试，白跑一轮。
    NoKindMatch { kind: String, matched: usize },
    /// ③甲：`author` 点名了一个从未写过东西的 agent。同上两档的取舍。
    UnknownAuthor { asked: String, known: Vec<String> },
}

/// 范围参数（名字）解析后的结果。
///
/// 🔴 **收口（规则 #11）**：`kb_list` 与 `kb_search` 必须用同一套解析。
/// 各写一套的后果是两个工具对同一个文件夹名给出不同结果，
/// 而那种不一致在日志里看不出来。
enum Scope {
    Ok {
        folder_id: String,
        tag_ids: Vec<String>,
        /// 已校验的写入者筛选（③甲）。空串 = 不筛。
        /// 取值口径同 [`NoteViewOpts::author`]。
        author: String,
    },
    UnknownFolder(String),
    UnknownTag(String),
    /// ③甲：点名了一个从未写过东西的 agent。带上库里真实的名单。
    ///
    /// 🔴 不能归入「没找到」：模型会把「agent 名写错了」读成
    /// 「那个 agent 确实没记过这个」——同 folder / tag 的取舍。
    UnknownAuthor { asked: String, known: Vec<String> },
}

/// `author` 参数的归一与校验。
///
/// # 🔴 `me` 与 `human` 故意不校验存不存在
///
/// 一个 agent 第一次问「我上次记了什么」时它本来就什么都没写过。
/// 那是一个**有意义的空结果**（“你还没记过东西”），不是错。
/// 报「没有叫 agent:claude-code 的写入者」更是荒谬——那就是它自己。
/// 而点名其他 agent 时，写错名字与「他确实没记过」必须分开。
fn resolve_author(store: &DataStore, author: &str, me: &str) -> Result<Scope, String> {
    // 返回 `Scope` 只为了复用 `UnknownAuthor` 那一支；成功时只看 `author` 字段。
    let want = match author.trim() {
        "" => String::new(),
        // 服务端解 `me`：模型不需要知道自己叫什么，也不会因自报名字而报错。
        "me" => me.to_string(),
        "human" => "human".to_string(),
        // §7.2：与界面那个筛选同口径（规则 #11）。
        // 两边各认一套值早晚会漂，而漂了的表现是「同一个词在界面与 AI 那里
        // 筛出不同结果」——这种不一致在日志里看不出来。
        // 不校验存不存在：同 `me` / `human`，“库里没任何 AI 写过的东西”
        // 是一个有意义的空结果，不是错。
        "ai" => "ai".to_string(),
        "ai_edited" => "ai_edited".to_string(),
        // 宽容一个缩写：`claude-code` 等价于 `agent:claude-code`。
        // 这不是「静默放宽」——两者指的是同一个对象，只是拼法不同。
        a if a.starts_with("agent:") => a.to_string(),
        a => format!("agent:{}", a),
    };
    if want.is_empty() || matches!(want.as_str(), "human" | "ai" | "ai_edited") || want == me {
        return Ok(Scope::Ok {
            folder_id: String::new(),
            tag_ids: Vec::new(),
            author: want,
        });
    }
    let known = store.note_writers()?;
    if known.iter().any(|w| *w == want) {
        Ok(Scope::Ok {
            folder_id: String::new(),
            tag_ids: Vec::new(),
            author: want,
        })
    } else {
        Ok(Scope::UnknownAuthor { asked: want, known })
    }
}

/// 把工具参数里的**名字**解成底层要的 **id**。
///
/// 同名文件夹可能存在于不同父级下，取第一个匹配——个人规模下不值得
/// 为此引入路径语法，但这个取舍已写在工具描述里。
///
/// 🔴 R6：名字找不到**绝不能落回空筛选**——那就是无声无息地把全库返回去。
fn resolve_scope(
    store: &DataStore,
    folder: Option<&str>,
    tag: Option<&str>,
    author: Option<&str>,
    me: &str,
) -> Result<Scope, String> {
    let folder_id = match folder {
        None => String::new(),
        Some(name) => {
            let folders = store.folder_list()?;
            match folders.iter().find(|f| f.name == name) {
                Some(f) => f.id.clone(),
                None => return Ok(Scope::UnknownFolder(name.to_string())),
            }
        }
    };
    let tag_ids: Vec<String> = match tag {
        None => Vec::new(),
        Some(name) => {
            let tags = store.get_tags()?;
            match tags.iter().find(|t| t.name == name) {
                Some(t) => vec![t.id.clone()],
                None => return Ok(Scope::UnknownTag(name.to_string())),
            }
        }
    };
    // ③甲：写入者校验也收口在本函数（同一个理由：两个工具必须同口径）。
    let author = match author {
        None => String::new(),
        Some(a) => match resolve_author(store, a, me)? {
            Scope::Ok { author, .. } => author,
            // 不是 `Ok` 就只可能是 `UnknownAuthor`，原样往上报。
            other => return Ok(other),
        },
    };
    Ok(Scope::Ok {
        folder_id,
        tag_ids,
        author,
    })
}

/// 三个只读工具背后的数据访问。
///
/// 全部方法都是**同步**的（里面要拿 SQLite 的 `std::sync::Mutex`），
/// 调用方负责包 `spawn_blocking`——见 `tools.rs`。
pub trait KbSource: Send + Sync + 'static {
    fn read(&self, id: &str) -> Result<Option<Note>, String>;

    /// `me` = 本次调用者的 `source_agent`（③甲）。只用于把 `author: "me"`
    /// 在**服务端**解成具体名字——模型不需要知道自己叫什么。
    fn list(
        &self,
        folder: Option<&str>,
        tag: Option<&str>,
        author: Option<&str>,
        me: &str,
        limit: u32,
        offset: u32,
    ) -> Result<ListOutcome, String>;

    /// `me` 同 [`Self::list`]。
    fn search(
        &self,
        query: &str,
        folder: Option<&str>,
        tag: Option<&str>,
        kind: Option<&str>,
        author: Option<&str>,
        me: &str,
        limit: u32,
    ) -> Result<SearchOutcome, String>;

    /// 文件夹 id → 名字（展示用）。拿不到就不显示，不报错。
    fn folder_name(&self, folder_id: &str) -> Option<String>;

    /// O-2：这一篇的反链与断链。
    ///
    /// 返回 `(反链的源标题, 断掉的目标标题)`。与 [`Self::title_dups`] 同口径——
    /// 这是**附加信息**，拿不到就不显示，不能让 `kb_read` 失败。
    fn links_of(&self, id: &str) -> (Vec<String>, Vec<String>);

    /// AM-8：库里疑似重复的笔记标题。
    ///
    /// 与 [`Self::folder_name`] 同口径——这是一条**附加提示**，
    /// 拿不到就不显示，不能让整个 `kb_folders` 失败。
    fn title_dups(&self) -> Vec<crate::similar::DupGroup>;

    /// 全部文件夹（`kb_folders` 用）。
    fn folders(&self) -> Result<Vec<NoteFolder>, String>;

    /// **被笔记用到**的标签名（`kb_folders` 用）。
    ///
    /// 🔴 不是全库标签。`tags` 是剪贴板与知识库的共用表，而本工具描述的是
    /// **知识库**。拿全库的话，模型会看到一堆剪贴板自动标签（`CSS` / `邮箱` ……），
    /// 拿它们去 `kb_search(tag=)` 只会得到空结果。详见 `DataStore::note_tag_names`。
    fn note_tag_names(&self) -> Result<Vec<String>, String>;

    /// L2 信号：库的脉搏（[`pulse::pulse_hint`] 的输入）。
    ///
    /// 与 [`Self::title_dups`] 同口径——**附加提示**，拿不到就不显示。
    /// 但这里仍返回 `Result` 而不是像它那样直接吐默认值：
    /// 「查失败了」与「库里真是一片空白」在下面那两句话上是**同一个效果**
    /// （都不说），可这层不该替调用方做那个决定。
    fn library_pulse(&self) -> Result<pulse::LibraryPulse, String>;

    // ===== 写入（M5）=====
    //
    // 写入侧**不做** `ListOutcome` 那种枚举，直接 `Result<_, String>`：
    // 那个枚举防的是「静默退化成返回错数据」（R6），而写入只有两种结果：
    // 写成了，或者报错且错误文本直接给到模型眼前。没有「看似合理的错结果」这种中间态。
    //
    // 🔴 `source` 必须非空：空串在 W2 里的语义是「人亲自改的」，
    // 传空等于让锚定快照**静默失效**（见 `gate.rs` 与 `note_revision.rs`）。

    /// 新建。`folder` 是**名字**，不存在就报错（不自动建文件夹）。
    fn create(
        &self,
        title: &str,
        content: &str,
        folder: Option<&str>,
        source: &str,
    ) -> Result<Note, String>;

    /// 改标题/正文。两个都省略就报错（那是一次无意义的调用，不当成功）。
    fn update(
        &self,
        id: &str,
        title: Option<&str>,
        content: Option<&str>,
        source: &str,
    ) -> Result<(Note, NoteUpdateReport), String>;

    /// 往末尾追一段。
    fn append(&self, id: &str, text: &str, source: &str) -> Result<Note, String>;

    /// 删到回收站（**只能软删**）。返回被删笔记的标题，好让模型回话。
    fn delete(&self, id: &str) -> Result<String, String>;

    /// 从回收站拿回。返回标题。
    fn restore(&self, id: &str) -> Result<String, String>;

    /// 移到指定文件夹（`None` = 未分类）。返回目标的显示名。
    fn move_to(&self, id: &str, folder: Option<&str>) -> Result<String, String>;

    /// 加/减标签（按**名字**）。返回（实际新增数, 实际移除数）。
    fn tag(&self, id: &str, add: &[String], remove: &[String]) -> Result<(usize, usize), String>;

    /// 一次正文级精准编辑（O-8）。
    ///
    /// **为何是一个方法带一个操作枚举，而不是四个方法**：四个写工具的形状
    /// 完全相同（读正文 → 纯变换 → 写回），各加一个方法要改 trait、
    /// [`AppKbSource`] 实现、以及测试里那份假实现，共 4×3 处。
    ///
    /// 🔴 它**不是原子的**（`DataStore` 每个方法各自拿锁）。
    /// 但它的价值不在锁，而在「写入依据的是多新的内容」：
    /// `kb_update` 是 AI 拿着几十秒前读到的全文覆盖回来，
    /// 而这里是服务端写之前微秒刚读的。
    fn edit_content(
        &self,
        id: &str,
        op: &ContentEdit,
        source: &str,
    ) -> Result<(Note, EditReport), String>;

    /// 七个写开关的当前快照。
    ///
    /// **为何放在 KbSource 而不另开一个 trait**：它与其它方法的契约完全一样
    /// （同步、里面拿 SQLite 锁、调用方包 `spawn_blocking`），而多一个 trait
    /// 就多一份要在测试里搭的假实现。
    fn write_switches(&self) -> WriteSwitches;

    /// 用户手写的库简介（AM-6）。空串 = 不推（默认）。
    fn library_blurb(&self) -> String;

    /// 回收站的保留天数（`note_trash_days`，用户可在设置里改）。
    ///
    /// 🔴 `kb_delete` 的描述要拿它去拼，而不是写死「30 天」：
    /// 写死的话，用户改成 7 天后模型会继续向他保证「30 天内都能恢复」。
    /// `<= 0` = 用户关掉了自动销毁，回收站里的东西不会到期。
    fn trash_days(&self) -> i64;

    /// 回收站里的笔记（`kb_trash_list` 用）。
    ///
    /// 🔴 为何要开这一个：已删的笔记**不会**出现在 `kb_search` / `kb_list` 里，
    /// 所以在有它之前，`kb_restore` 只能恢复「本轮刚刚自己删的」——
    /// 上一次会话删的东西永远拿不回来，因为没有任何途径取到那个 id。
    fn trash_list(&self, limit: u32, offset: u32) -> Result<Vec<Note>, String>;

    /// AI 可写入的范围快照（项目②）。理由同 `write_switches`。
    fn write_scope(&self) -> WriteScope;

    /// 这一篇当前在哪个文件夹 —— 专给权限判定用。
    ///
    /// 🔴 **必须含回收站里的**，不能用 `read()` 代替：
    /// `note_get` 带了 `deleted_at IS NULL`（`note.rs:1700`），已删的笔记读不到。
    /// 而 `kb_restore` 恰好只动回收站里的 ⇒ 拿 `read()` 判它会永远取不到归属。
    ///
    /// 也不能用 `trash_list(limit)` 凑：它只返回最近 N 条，
    /// 超出 limit 的那些会查不到 ⇒ 权限判定静默走错分支。
    fn folder_of(&self, note_id: &str) -> Result<NoteSpot, String>;

    /// 权限判定要的文件夹拓扑（id → parent_id，外加哪些夹是 AI 建的）。
    ///
    /// 递归判定要沿 parent 链往上走；`ai_made` 是那条「AI 可以管理自己创建的东西」
    /// 的旁路所需的（见 `gate::FolderTree`）。
    fn folder_tree(&self) -> Result<FolderTree, String>;

    /// 建一个文件夹（项目③）。`parent` 是**名字**，`None` = 顶层。
    ///
    /// 校验全靠数据层现有的三道（名字非空 / 同父不重名 / 深度不超
    /// `MAX_FOLDER_DEPTH`）—— 不在这层再写一份，两份就会漂。
    ///
    /// 返回新夹子的名字（给模型回显用）。
    fn folder_create(&self, name: &str, parent: Option<&str>) -> Result<String, String>;

    /// 这一篇的版本快照列表（新 → 旧）。`kb_history` 用。
    fn revisions(&self, id: &str) -> Result<Vec<NoteRevisionMeta>, String>;

    /// 读某一份快照的正文。
    ///
    /// 🔴 **必须同时传 `id`**，不能只拿 `rev_id` 去读。
    /// `rev_id` 是全库递增的整数，模型能猜；而权限与范围判定走的是
    /// `ScopeTarget::ByNoteId`（看 `arguments.id`）。两边不对的话，
    /// 传一个**别的笔记**的 `rev_id` 就能把白名单外那篇的历史正文读出来。
    /// 不属于这一篇时返 `Ok(None)`（与「没这个版本」同一个出口，
    /// 不告知它“这个版本存在但不是你的”）。
    fn revision(&self, id: &str, rev_id: i64) -> Result<Option<NoteRevision>, String>;

    /// 回滚到某一份快照。返回回滚后的标题。
    ///
    /// 🔴 同 `revision`：`rev_id` 不属于 `id` 时必须报错。
    /// 这里漏掉比读那里漏掉更严重——那是**改写**白名单外的笔记。
    fn revert(&self, id: &str, rev_id: i64, source: &str) -> Result<String, String>;

    /// 写摘要。`None` = 清掉。
    fn set_summary(&self, id: &str, text: Option<&str>) -> Result<(), String>;

    /// 文件夹改名。`folder` 是**名字**（同 `folder_create` 的 `parent`）。
    /// 返回新名字。
    fn folder_rename(&self, folder: &str, name: &str) -> Result<String, String>;

    /// 解散一层文件夹：里面的笔记与子夹全部上提到它的父夹，然后删这一层。
    /// 返回（挪走的笔记数, 挪走的子夹数）。
    ///
    /// 🔴 给模型的是解散而不是 `folder_delete`：后者会**连带删子文件夹**
    /// （看 `test_folder_delete_keeps_notes_but_cascades_subfolders`）。
    /// 两者都不删笔记，但一个只拆一层、一个拆整棵子树。
    fn folder_dissolve(&self, folder: &str) -> Result<(usize, usize), String>;
}

/// 一篇笔记在权限判定里的位置。
///
/// 用枚举而不是 `Option<Option<String>>`：后者的两层 `None` 语义完全不同
/// （“没这篇” vs “未分类”），而它们在权限判定里要走相反的分支。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoteSpot {
    /// 在这个文件夹里。
    In(String),
    /// 未分类（`folder_id IS NULL`）。
    Unfiled,
    /// 库里（含回收站）根本没这个 id。
    ///
    /// **不当权限问题处理**：没东西可保护，放它过去、让工具自己报
    /// 「没有 id xxx」——那比一句笼统的「没权限」有用得多。
    /// （注意这不是 fail-open：查库出错走的是 `Err`，那一条是 fail-closed。）
    Missing,
}

/// 生产实现：从 Tauri 管理状态里取 `DataStore`。
///
/// 持 `AppHandle` 而不是 `DataStore`：后者被 `app.manage()` 持有，拿不到所有权。
pub struct AppKbSource {
    app: tauri::AppHandle,
}

impl AppKbSource {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    /// 取 store。用 `try_state` 而不是 `state`：后者在缺失时 panic，
    /// 而 `panic = "abort"` 下一次 panic 就是整个应用死掉（R3）。
    fn with_store<T>(&self, f: impl FnOnce(&DataStore) -> T) -> Result<T, String> {
        use tauri::Manager;
        let state = self
            .app
            .try_state::<DataStore>()
            .ok_or_else(|| "数据库尚未就绪".to_string())?;
        Ok(f(&state))
    }
}

impl KbSource for AppKbSource {
    fn read(&self, id: &str) -> Result<Option<Note>, String> {
        self.with_store(|s| s.note_get(id))?
    }

    fn list(
        &self,
        folder: Option<&str>,
        tag: Option<&str>,
        author: Option<&str>,
        me: &str,
        limit: u32,
        offset: u32,
    ) -> Result<ListOutcome, String> {
        self.with_store(|s| list_on(s, folder, tag, author, me, limit, offset))?
    }

    fn search(
        &self,
        query: &str,
        folder: Option<&str>,
        tag: Option<&str>,
        kind: Option<&str>,
        author: Option<&str>,
        me: &str,
        limit: u32,
    ) -> Result<SearchOutcome, String> {
        self.with_store(|s| search_on(s, query, folder, tag, kind, author, me, limit))?
    }

    fn links_of(&self, id: &str) -> (Vec<String>, Vec<String>) {
        let got = self.with_store(|s| {
            let back = s.note_backlinks(id).unwrap_or_default();
            let out = s.note_links_out(id).unwrap_or_default();
            (
                back.into_iter().map(|b| b.from_title).collect::<Vec<_>>(),
                out.into_iter()
                    .filter(|l| l.to_id.is_none())
                    .map(|l| l.target)
                    .collect::<Vec<_>>(),
            )
        });
        got.unwrap_or_default()
    }

    fn title_dups(&self) -> Vec<crate::similar::DupGroup> {
        // 两层 Result：外层是「拿不到 store」，内层是「查询失败」。
        // 两者都只影响这一条**附加提示**，不能让整个 kb_folders 挂掉。
        self.with_store(|s| s.note_title_dups())
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default()
    }

    fn folder_name(&self, folder_id: &str) -> Option<String> {
        self.with_store(|s| {
            s.folder_list()
                .ok()?
                .into_iter()
                .find(|f| f.id == folder_id)
                .map(|f| f.name)
        })
        .ok()
        .flatten()
    }

    fn folders(&self) -> Result<Vec<NoteFolder>, String> {
        self.with_store(|s| s.folder_list())?
    }

    fn note_tag_names(&self) -> Result<Vec<String>, String> {
        self.with_store(|s| s.note_tag_names())?
    }

    fn library_pulse(&self) -> Result<pulse::LibraryPulse, String> {
        let (unfiled, last_ai_ms, total) = self.with_store(|s| s.note_library_pulse())??;
        Ok(pulse::LibraryPulse {
            unfiled,
            last_ai_ms,
            total,
        })
    }

    fn create(
        &self,
        title: &str,
        content: &str,
        folder: Option<&str>,
        source: &str,
    ) -> Result<Note, String> {
        self.with_store(|s| create_on(s, title, content, folder, source))?
    }

    fn update(
        &self,
        id: &str,
        title: Option<&str>,
        content: Option<&str>,
        source: &str,
    ) -> Result<(Note, NoteUpdateReport), String> {
        self.with_store(|s| update_on(s, id, title, content, source))?
    }

    fn append(&self, id: &str, text: &str, source: &str) -> Result<Note, String> {
        self.with_store(|s| append_on(s, id, text, source))?
    }

    fn delete(&self, id: &str) -> Result<String, String> {
        self.with_store(|s| {
            let title = note_title_on(s, id)?;
            s.note_delete(id)?;
            Ok(title)
        })?
    }

    fn restore(&self, id: &str) -> Result<String, String> {
        self.with_store(|s| {
            // 先恢复再读标题：已删的行被 `push_note_filters` 滤掉了，恢复前读不到。
            s.note_restore_deleted(id)?;
            note_title_on(s, id)
        })?
    }

    fn move_to(&self, id: &str, folder: Option<&str>) -> Result<String, String> {
        self.with_store(|s| move_on(s, id, folder))?
    }

    fn tag(&self, id: &str, add: &[String], remove: &[String]) -> Result<(usize, usize), String> {
        self.with_store(|s| tag_on(s, id, add, remove))?
    }

    fn edit_content(
        &self,
        id: &str,
        op: &ContentEdit,
        source: &str,
    ) -> Result<(Note, EditReport), String> {
        self.with_store(|s| edit_on(s, id, op, source))?
    }

    fn write_switches(&self) -> WriteSwitches {
        // 读不到配置时走 `from_config(&Null)` 而不是直接 ALL_ON：
        // 两者目前结果相同，但前者把「默认值」只留在 gate.rs 一处。
        self.with_store(|s| s.get_config().unwrap_or_default())
            .map(|cfg| WriteSwitches::from_config(&cfg))
            .unwrap_or(WriteSwitches::ALL_ON)
    }

    fn library_blurb(&self) -> String {
        // 读不到配置就不推——这一项的安全默认与写开关相反：
        // 开关默认全开是因为用户已经表达了「让 AI 用我的库」；
        // 而这一段是**主动推给每个客户端的内容**，没明确填就什么都不推。
        self.with_store(|s| s.get_config().unwrap_or_default())
            .map(|cfg| super::blurb::from_config(&cfg))
            .unwrap_or_default()
    }

    fn trash_days(&self) -> i64 {
        // 🔴 读与真正执行清理那一侧**同一个函数**（规则 #11）。
        // 在这里另写一遍 `get("note_trash_days").unwrap_or(30)` 的话，
        // 两边会在下次改默认值时静默分叉，而分叉的后果是模型向用户
        // 报了一个错的可恢复期限。
        let cfg = self
            .with_store(|s| s.get_config().unwrap_or_default())
            .unwrap_or_default();
        crate::auto_cleanup::trash_days(&cfg)
    }

    fn trash_list(&self, limit: u32, offset: u32) -> Result<Vec<Note>, String> {
        self.with_store(|s| s.note_list_deleted_paged(limit, offset))?
    }

    fn write_scope(&self) -> WriteScope {
        let cfg = self
            .with_store(|s| s.get_config())
            .and_then(|r| r)
            .unwrap_or_default();
        WriteScope::from_config(&cfg)
    }

    fn folder_of(&self, note_id: &str) -> Result<NoteSpot, String> {
        let got = self.with_store(|s| s.note_folder_of_any(note_id))??;
        Ok(match got {
            None => NoteSpot::Missing,
            Some(None) => NoteSpot::Unfiled,
            Some(Some(fid)) => NoteSpot::In(fid),
        })
    }

    fn folder_tree(&self) -> Result<FolderTree, String> {
        let list = self.with_store(|s| s.folder_list())??;
        Ok(FolderTree::from_folders(&list))
    }

    fn folder_create(&self, name: &str, parent: Option<&str>) -> Result<String, String> {
        let name = name.to_string();
        let parent = parent.map(|s| s.to_string());
        self.with_store(move |s| {
            // 父夹按**名字**解，同 `kb_create` / `kb_move`：模型手里只有名字
            // （`kb_folders` 返回的就是名字），让它猜 id 是不现实的。
            let pid = match parent.as_deref() {
                None => None,
                Some(p) => Some(resolve_folder_on(s, p)?),
            };
            s.folder_create_by_ai(&name, pid.as_deref()).map(|f| f.name)
        })?
    }

    fn revisions(&self, id: &str) -> Result<Vec<NoteRevisionMeta>, String> {
        let id = id.to_string();
        self.with_store(move |s| s.note_revision_list(&id))?
    }

    // 🔴 下面两个只是管子：归属校验在数据层
    // （`note_revision_get_in` / `note_restore_in`），不在这里。
    // 理由写在那两个方法的注释里：本层的真实实现需要 `tauri::AppHandle`，
    // 在 `--no-default-features` 下根本构造不出来 ⇒ 写在这里的校验
    // 只有 `FakeKb` 的镜像能被测到，那种测试是空的。
    fn revision(&self, id: &str, rev_id: i64) -> Result<Option<NoteRevision>, String> {
        let id = id.to_string();
        self.with_store(move |s| s.note_revision_get_in(&id, rev_id))?
    }

    fn revert(&self, id: &str, rev_id: i64, source: &str) -> Result<String, String> {
        let id = id.to_string();
        let source = source.to_string();
        self.with_store(move |s| s.note_restore_in(&id, rev_id, &source).map(|n| n.title))?
    }

    fn set_summary(&self, id: &str, text: Option<&str>) -> Result<(), String> {
        let id = id.to_string();
        let text = text.map(|s| s.to_string());
        self.with_store(move |s| s.note_set_summary(&id, text.as_deref()))?
    }

    fn folder_rename(&self, folder: &str, name: &str) -> Result<String, String> {
        let folder = folder.to_string();
        let name = name.to_string();
        self.with_store(move |s| {
            // 同 `folder_create`：模型手里只有名字，所以先解名。
            // 重名 / 空名 / 深度那三道校验全靠数据层现有的，不在这层再写一份。
            let fid = resolve_folder_on(s, &folder)?;
            s.folder_rename(&fid, &name)?;
            Ok(name)
        })?
    }

    fn folder_dissolve(&self, folder: &str) -> Result<(usize, usize), String> {
        let folder = folder.to_string();
        self.with_store(move |s| {
            let fid = resolve_folder_on(s, &folder)?;
            s.folder_dissolve(&fid)
        })?
    }
}

/// 名字 → id 的解析在这里，不在 trait 实现里：以后再添一个实现也能直接复用。
fn list_on(
    store: &DataStore,
    folder: Option<&str>,
    tag: Option<&str>,
    author: Option<&str>,
    me: &str,
    limit: u32,
    offset: u32,
) -> Result<ListOutcome, String> {
    // 名字 → id 的解析收口在 `resolve_scope`（与 kb_search 共用）。
    let (folder_filter, tag_ids, author) = match resolve_scope(store, folder, tag, author, me)? {
        Scope::Ok {
            folder_id,
            tag_ids,
            author,
        } => (folder_id, tag_ids, author),
        Scope::UnknownFolder(n) => return Ok(ListOutcome::UnknownFolder(n)),
        Scope::UnknownTag(n) => return Ok(ListOutcome::UnknownTag(n)),
        Scope::UnknownAuthor { asked, known } => {
            return Ok(ListOutcome::UnknownAuthor { asked, known })
        }
    };

    // 🔴 `author` 走 SQL 而不是取回来再筛（不同于 `kind`）：
    //    `kb_list` 带 `offset`，而 offset 是 SQL 算的——在 Rust 里后筛会让
    //    第二页跳行或重复。`kind` 没这个问题是因为 `kb_search` 没有 offset。
    let opts = NoteViewOpts {
        author,
        ..NoteViewOpts::default()
    };
    let notes = store.note_list_view(&folder_filter, &tag_ids, &opts, limit, offset)?;
    Ok(ListOutcome::Ok(notes))
}

/// AM-7 `kind` 筛选的过取倍数。
///
/// `kind` 是**内容里的约定行**，SQL 层筛不了，只能取回来再过滤。
/// 不过取的话，「前 5 篇里恰好没有带 decision 的」就会被报成「库里没有决定」——
/// 那是个看不出来的错答案。
///
/// 取 6 不是拍脑袋：库里 25 篇，`limit` 默认 5，6 倍即 30 > 全库，
/// 也就是**当前规模下等价于全库扫**；库长大后它退化成一个合理的过取窗口。
/// 🔴 真正的窗口大小要等 AM-5（它扫 `limit ∈ {5,10,20}` 就是在量这个 k）。
const KIND_OVER_FETCH: u32 = 6;

fn search_on(
    store: &DataStore,
    query: &str,
    folder: Option<&str>,
    tag: Option<&str>,
    kind: Option<&str>,
    author: Option<&str>,
    me: &str,
    limit: u32,
) -> Result<SearchOutcome, String> {
    // 先单独跑一次拆词，就是为了分开那两种「没结果」。
    // 多一次纯字符串处理的开销，换模型一句可执行的提示，很划算。
    if crate::data_store::question_to_or_expr(query).is_none() {
        return Ok(SearchOutcome::NoSearchableTerms);
    }
    // AM-1a：范围参数。底层 `note_search_relevant` 本来就收这两个，
    // 之前 MCP 层硬编码传空——**是遗漏，不是取舍**。
    let (folder_filter, tag_ids, author) = match resolve_scope(store, folder, tag, author, me)? {
        Scope::Ok {
            folder_id,
            tag_ids,
            author,
        } => (folder_id, tag_ids, author),
        Scope::UnknownFolder(n) => return Ok(SearchOutcome::UnknownFolder(n)),
        Scope::UnknownTag(n) => return Ok(SearchOutcome::UnknownTag(n)),
        Scope::UnknownAuthor { asked, known } => {
            return Ok(SearchOutcome::UnknownAuthor { asked, known })
        }
    };
    // AM-7：kind 写错要当场报错，不能等它筛空了再说「没找到」——
    // 后者会被模型读成「库里确实没有」，然后带着错结论走下去。
    let kind = kind.map(str::trim).filter(|k| !k.is_empty());
    if let Some(k) = kind {
        if !crate::markdown::annotate::is_kind_label(k) {
            return Ok(SearchOutcome::BadKind(k.to_string()));
        }
    }

    let opts = NoteViewOpts {
        author,
        ..NoteViewOpts::default()
    };
    // 带 kind 时多取一些再筛（见 KIND_OVER_FETCH）。
    let fetch = match kind {
        Some(_) => limit.saturating_mul(KIND_OVER_FETCH),
        None => limit,
    };
    let notes = store.note_search_relevant(query, &folder_filter, &tag_ids, &opts, fetch)?;
    if notes.is_empty() {
        return Ok(SearchOutcome::NoMatch);
    }
    let Some(k) = kind else {
        return Ok(SearchOutcome::Hits(notes));
    };

    let matched = notes.len();
    let want = k.to_lowercase();
    let kept: Vec<Note> = notes
        .into_iter()
        .filter(|n| crate::markdown::kinds_of(&n.content).iter().any(|x| *x == want))
        .take(limit as usize)
        .collect();
    if kept.is_empty() {
        Ok(SearchOutcome::NoKindMatch {
            kind: k.to_string(),
            matched,
        })
    } else {
        Ok(SearchOutcome::Hits(kept))
    }
}

// ===== 写入侧（M5）=====

/// 读一条笔记的标题；不存在就给一句**模型能照着做**的错误。
///
/// 不回「未知错误」之类：模型拿到含糊报错后的典型反应是拿着同一个坏 id 重试。
fn note_title_on(store: &DataStore, id: &str) -> Result<String, String> {
    match store.note_get(id)? {
        Some(n) => Ok(display_title(&n)),
        None => Err(format!(
            "没有 id 为 {} 的笔记（或它已在回收站里）。id 要从 kb_search / kb_list 的结果里拿。",
            id
        )),
    }
}

/// 标题为空时给个占位——回话里出现一对空书名号比没有名字更难读。
fn display_title(n: &Note) -> String {
    let t = n.title.trim();
    if t.is_empty() {
        "（无标题）".to_string()
    } else {
        t.to_string()
    }
}

/// 文件夹名 → id。**不自动创建**。
///
/// 组织结构是用户的心智模型，让模型随手新建文件夹会让他自己的库变得陌生。
/// 同名取第一个匹配（同 `list_on` 的口径）。
fn resolve_folder_on(store: &DataStore, name: &str) -> Result<String, String> {
    let folders = store.folder_list()?;
    folders
        .iter()
        .find(|f| f.name == name)
        .map(|f| f.id.clone())
        .ok_or_else(|| {
            format!(
                "没有叫「{}」的文件夹。**不会自动新建文件夹**——先用 kb_folders 看看有哪些，\
                 或不带 folder 参数让它落入未分类。",
                name
            )
        })
}

/// 标签名 → id。**不自动创建**，理由同上。
fn resolve_tags_on(store: &DataStore, names: &[String]) -> Result<Vec<String>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let tags = store.get_tags()?;
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        match tags.iter().find(|t| t.name == *name) {
            Some(t) => ids.push(t.id.clone()),
            None => {
                let known: Vec<String> = tags.iter().map(|t| t.name.clone()).collect();
                return Err(unknown_tag_msg(name, &known));
            }
        }
    }
    Ok(ids)
}

/// 「没这个标签」的报错。**把库里真实的名单给回去**——取舍同 `tools/mod.rs`
/// 里的兄弟 `unknown_author_msg`。
///
/// 🔴 为何必须列名单，而不是像原来那样只说「可能还有别的」：
/// 模型那份「别的」从哪来？**没有任何工具能列全库标签**——
/// `kb_folders` 只列**笔记在用的**（`note_tag_names`），而这里认的是全库标签
/// （`get_tags`，含只被剪贴板条目用过的）。两边口径不同是故意的，
/// 但就不能再把 `kb_folders` 说成「能用哪些」的全部依据，
/// 否则模型会对一个**真存在**的标签告诉用户「库里没有、得你先建」。
///
/// 名单本来就在 `tags` 里，零额外查询；静态描述写不出这份名单，
/// 而模型拿到它就能自己改对。这是本项目「报错路径带真实上下文，
/// 比静态句子说得好」那条原则的正向应用（见 `tools/mod.rs` 的预算注释）。
///
/// 抽成纯函数是为了能测——`AppKbSource` 要 `AppHandle`，
/// 测试里起不来（见本文件头部），所以报错文案得能脱开 `DataStore` 单测。
fn unknown_tag_msg(asked: &str, known: &[String]) -> String {
    let list = if known.is_empty() {
        "（库里一个标签都还没有）".to_string()
    } else {
        clip_tag_list(known)
    };
    format!(
        "没有叫「{}」的标签。库里现有的标签是：{}\n\
         其中含只被剪贴板条目用过的——那些**也能直接用**，\
         而 kb_folders 不列它们（它只列笔记在用的）。\n\
         且**不会自动新建**：若上面确实没有，请让用户确认该怎么写，\
         不要直接断定「库里没有」。",
        asked, list
    )
}

/// 报错里那份标签名单：超过上限就截断，防止报错本身吃掉一大片上下文。
///
/// 真库实测量级在几十个（2026-09-04 那次是 38 个全库标签），
/// 但库会长大，而这条报错**每次写错标签都会付一遍**。
const TAG_LIST_MAX: usize = 30;

fn clip_tag_list(names: &[String]) -> String {
    let shown = names.len().min(TAG_LIST_MAX);
    let mut s = names
        .iter()
        .take(shown)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("、");
    if names.len() > shown {
        s.push_str(&format!("……（共 {} 个，只列了前 {} 个）", names.len(), shown));
    }
    s
}

fn create_on(
    store: &DataStore,
    title: &str,
    content: &str,
    folder: Option<&str>,
    source: &str,
) -> Result<Note, String> {
    // 先解文件夹再建：反过来的话文件夹名写错时已经多出一条未分类笔记，
    // 而模型看到的是一个失败——它会重试，于是多出两条。
    let folder_id = match folder {
        Some(name) => Some(resolve_folder_on(store, name)?),
        None => None,
    };
    let note = store.note_create_from(None, title, content, source)?;
    if let Some(fid) = folder_id {
        // 新建一律落入未分类，归档另走 note_set_folder（那边的注释写了为何不往 create 堆参数）。
        store.note_set_folder(&note.id, Some(&fid))?;
    }
    // 重读一次：这样返回的 folder_id 与库里一致，不用在这里手拼一份。
    store
        .note_get(&note.id)?
        .ok_or_else(|| "新建后立即读不到这条笔记".to_string())
}

fn update_on(
    store: &DataStore,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
    source: &str,
) -> Result<(Note, NoteUpdateReport), String> {
    // 两个都没传不当成功：否则模型会以为自己改成了（规则 #15.3）。
    if title.is_none() && content.is_none() {
        return Err("kb_update 至少要给 title 或 content 之一。".to_string());
    }
    let old = store
        .note_get(id)?
        .ok_or_else(|| format!("没有 id 为 {} 的笔记（或它已在回收站里）。", id))?;
    let new_title = title.unwrap_or(&old.title);
    let new_content = content.unwrap_or(&old.content);
    // O-9：改标题会顺带重写其它笔记里的 `[[旧标题]]`。
    // 那个数字必须一路传回给模型：它改了一个标题，实际动了 N+1 篇笔记，
    // 不告知的话它向用户交代的就是一个不完整的事实。
    let report = store.note_update_from(id, new_title, new_content, source)?;
    let fresh = store
        .note_get(id)?
        .ok_or_else(|| "修改后读不到这条笔记".to_string())?;
    Ok((fresh, report))
}

/// 精准编辑：读正文 → 纯变换 → 写回。
///
/// 变换里任何失败（定位不到、命中多处）都在**写之前**返回，
/// 所以失败就是一个字都没改。这一点必须成立：
/// 否则「改坏了一半」与「没改」对模型是不可分的两种结果。
fn edit_on(
    store: &DataStore,
    id: &str,
    op: &ContentEdit,
    source: &str,
) -> Result<(Note, EditReport), String> {
    let old = store
        .note_get(id)?
        .ok_or_else(|| format!("没有 id 为 {} 的笔记（或它已在回收站里）。", id))?;
    let (content, report) = apply(&old.content, op)?;

    if content == old.content {
        // 不写：一次写入会产生版本快照并刷新 updated_at，
        // 让一次无效编辑在历史里留痕是误导。
        //
        // 但这**不是失败**：AI 想要的状态已经达成了。报错会让它去重试，
        // 或者向用户报一个并不存在的故障。
        let summary = format!("{}（内容与原文完全相同，未写入、未产生新版本）", report.summary);
        return Ok((
            old,
            EditReport {
                summary,
                untouched_children: report.untouched_children,
            },
        ));
    }

    store.note_update_from(id, &old.title, &content, source)?;
    let fresh = store
        .note_get(id)?
        .ok_or_else(|| "修改后读不到这条笔记".to_string())?;
    Ok((fresh, report))
}

fn append_on(store: &DataStore, id: &str, text: &str, source: &str) -> Result<Note, String> {
    let old = store
        .note_get(id)?
        .ok_or_else(|| format!("没有 id 为 {} 的笔记（或它已在回收站里）。", id))?;
    // 空篇追加不要开头就留两个空行。
    let merged = if old.content.trim().is_empty() {
        text.to_string()
    } else {
        format!("{}\n\n{}", old.content.trim_end(), text)
    };
    store.note_update_from(id, &old.title, &merged, source)?;
    store
        .note_get(id)?
        .ok_or_else(|| "追加后读不到这条笔记".to_string())
}

fn move_on(store: &DataStore, id: &str, folder: Option<&str>) -> Result<String, String> {
    // 先确认笔记存在：note_set_folder 对不存在的 id 只会影响 0 行。
    let _ = note_title_on(store, id)?;
    match folder {
        Some(name) => {
            let fid = resolve_folder_on(store, name)?;
            store.note_set_folder(id, Some(&fid))?;
            Ok(name.to_string())
        }
        None => {
            store.note_set_folder(id, None)?;
            Ok("未分类".to_string())
        }
    }
}

fn tag_on(
    store: &DataStore,
    id: &str,
    add: &[String],
    remove: &[String],
) -> Result<(usize, usize), String> {
    if add.is_empty() && remove.is_empty() {
        return Err("kb_tag 至少要给 add 或 remove 之一。".to_string());
    }
    let _ = note_title_on(store, id)?;
    // 两边名字先全部解完再写：边解边写的话，第二个名字写错时第一个已经生效了。
    let add_ids = resolve_tags_on(store, add)?;
    let remove_ids = resolve_tags_on(store, remove)?;
    store.note_tags_edit(id, &add_ids, &remove_ids)
}

#[cfg(test)]
mod tests {
    use super::{clip_tag_list, unknown_tag_msg, TAG_LIST_MAX};

    fn names(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("标签{:02}", i)).collect()
    }

    /// 报错必须**把真实名单给回去**——这是补上「没有工具能列全库标签」那个缺口的地方。
    #[test]
    fn test_没这个标签的报错要列出全库标签() {
        let known = vec!["Rust".to_string(), "CSS".to_string(), "邮箱".to_string()];
        let msg = unknown_tag_msg("rust", &known);

        assert!(
            msg.contains("没有叫「rust」的标签"),
            "得说清是哪个名字写错了：{}",
            msg
        );
        for n in &known {
            assert!(msg.contains(n.as_str()), "名单里少了「{}」：{}", n, msg);
        }
        // 口径说明不能丢：名单里混着剪贴板标签，而 kb_folders 不列它们。
        assert!(
            msg.contains("剪贴板") && msg.contains("也能直接用"),
            "必须说清「名单含剪贴板标签、它们也能用」，否则模型会把它们当无效的：{}",
            msg
        );
        assert!(msg.contains("不会自动新建"), "防呆句不能丢：{}", msg);
        // 🔴 「不要直接断定库里没有」这句是原文案的核心，改名后必须还在。
        assert!(
            msg.contains("不要直接断定"),
            "原文案这条防「对真存在的标签说库里没有」的话不能丢：{}",
            msg
        );
    }

    /// 空库时不能输出「库里现有的标签是：」后面接一片空白——那读起来像解析失败。
    #[test]
    fn test_空库时不输出空白名单() {
        let msg = unknown_tag_msg("Rust", &[]);
        assert!(
            msg.contains("一个标签都还没有"),
            "空库要给一句话，不能留个空档：{}",
            msg
        );
    }

    /// 名单超上限要截断，且**明说截了**——报错本身不能吃掉一大片上下文。
    #[test]
    fn test_标签名单超上限要截断并明说() {
        let many = names(TAG_LIST_MAX + 5);
        let msg = unknown_tag_msg("不存在", &many);

        assert!(
            msg.contains(&format!("共 {} 个", TAG_LIST_MAX + 5)),
            "截了就要报出总数，否则模型以为这就是全部：{}",
            msg
        );
        // 第 31 个不该出现，但前 30 个都在。
        assert!(!msg.contains("标签31"), "超上限的没被截掉：{}", msg);
        for i in 1..=TAG_LIST_MAX {
            let want = format!("标签{:02}", i);
            assert!(
                msg.contains(&want),
                "前 {} 个应当全列：缺 {}",
                TAG_LIST_MAX,
                want
            );
        }
    }

    /// 刚好等于上限时不加截断尾巴——多印一句「共 30 个，只列了前 30 个」是废话。
    #[test]
    fn test_名单刚好等于上限时不加截断尾巴() {
        let s = clip_tag_list(&names(TAG_LIST_MAX));
        assert!(!s.contains("只列了前"), "刚好等于上限不该报截断：{}", s);
    }
}
