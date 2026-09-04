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

use super::gate::WriteSwitches;
use crate::data_store::{DataStore, Note, NoteFolder, NoteUpdateReport, NoteViewOpts, Tag};
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
}

/// 范围参数（名字）解析后的结果。
///
/// 🔴 **收口（规则 #11）**：`kb_list` 与 `kb_search` 必须用同一套解析。
/// 各写一套的后果是两个工具对同一个文件夹名给出不同结果，
/// 而那种不一致在日志里看不出来。
enum Scope {
    Ok { folder_id: String, tag_ids: Vec<String> },
    UnknownFolder(String),
    UnknownTag(String),
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
    Ok(Scope::Ok { folder_id, tag_ids })
}

/// 三个只读工具背后的数据访问。
///
/// 全部方法都是**同步**的（里面要拿 SQLite 的 `std::sync::Mutex`），
/// 调用方负责包 `spawn_blocking`——见 `tools.rs`。
pub trait KbSource: Send + Sync + 'static {
    fn read(&self, id: &str) -> Result<Option<Note>, String>;

    fn list(
        &self,
        folder: Option<&str>,
        tag: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<ListOutcome, String>;

    fn search(
        &self,
        query: &str,
        folder: Option<&str>,
        tag: Option<&str>,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<SearchOutcome, String>;

    /// 文件夹 id → 名字（展示用）。拿不到就不显示，不报错。
    fn folder_name(&self, folder_id: &str) -> Option<String>;

    /// 全部文件夹（`kb_folders` 用）。
    fn folders(&self) -> Result<Vec<NoteFolder>, String>;

    /// 全部标签（`kb_folders` 用）。
    fn tags(&self) -> Result<Vec<Tag>, String>;

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
        limit: u32,
        offset: u32,
    ) -> Result<ListOutcome, String> {
        self.with_store(|s| list_on(s, folder, tag, limit, offset))?
    }

    fn search(
        &self,
        query: &str,
        folder: Option<&str>,
        tag: Option<&str>,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<SearchOutcome, String> {
        self.with_store(|s| search_on(s, query, folder, tag, kind, limit))?
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

    fn tags(&self) -> Result<Vec<Tag>, String> {
        self.with_store(|s| s.get_tags())?
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
}

/// 名字 → id 的解析在这里，不在 trait 实现里：以后再添一个实现也能直接复用。
fn list_on(
    store: &DataStore,
    folder: Option<&str>,
    tag: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<ListOutcome, String> {
    // 名字 → id 的解析收口在 `resolve_scope`（与 kb_search 共用）。
    let (folder_filter, tag_ids) = match resolve_scope(store, folder, tag)? {
        Scope::Ok { folder_id, tag_ids } => (folder_id, tag_ids),
        Scope::UnknownFolder(n) => return Ok(ListOutcome::UnknownFolder(n)),
        Scope::UnknownTag(n) => return Ok(ListOutcome::UnknownTag(n)),
    };

    let opts = NoteViewOpts::default();
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
    limit: u32,
) -> Result<SearchOutcome, String> {
    // 先单独跑一次拆词，就是为了分开那两种「没结果」。
    // 多一次纯字符串处理的开销，换模型一句可执行的提示，很划算。
    if crate::data_store::question_to_or_expr(query).is_none() {
        return Ok(SearchOutcome::NoSearchableTerms);
    }
    // AM-1a：范围参数。底层 `note_search_relevant` 本来就收这两个，
    // 之前 MCP 层硬编码传空——**是遗漏，不是取舍**。
    let (folder_filter, tag_ids) = match resolve_scope(store, folder, tag)? {
        Scope::Ok { folder_id, tag_ids } => (folder_id, tag_ids),
        Scope::UnknownFolder(n) => return Ok(SearchOutcome::UnknownFolder(n)),
        Scope::UnknownTag(n) => return Ok(SearchOutcome::UnknownTag(n)),
    };
    // AM-7：kind 写错要当场报错，不能等它筛空了再说「没找到」——
    // 后者会被模型读成「库里确实没有」，然后带着错结论走下去。
    let kind = kind.map(str::trim).filter(|k| !k.is_empty());
    if let Some(k) = kind {
        if !crate::markdown::annotate::is_kind_label(k) {
            return Ok(SearchOutcome::BadKind(k.to_string()));
        }
    }

    let opts = NoteViewOpts::default();
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
                return Err(format!(
                    "没有叫「{}」的标签。**不会自动新建标签**——先用 kb_folders 看看现有哪些。",
                    name
                ))
            }
        }
    }
    Ok(ids)
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
