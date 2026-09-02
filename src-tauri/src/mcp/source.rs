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

use crate::data_store::{DataStore, Note, NoteViewOpts};

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
pub enum SearchOutcome {
    Hits(Vec<Note>),
    NoSearchableTerms,
    NoMatch,
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

    fn search(&self, query: &str, limit: u32) -> Result<SearchOutcome, String>;

    /// 文件夹 id → 名字（展示用）。拿不到就不显示，不报错。
    fn folder_name(&self, folder_id: &str) -> Option<String>;
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

    fn search(&self, query: &str, limit: u32) -> Result<SearchOutcome, String> {
        self.with_store(|s| search_on(s, query, limit))?
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
}

/// 名字 → id 的解析在这里，不在 trait 实现里：以后再添一个实现也能直接复用。
fn list_on(
    store: &DataStore,
    folder: Option<&str>,
    tag: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<ListOutcome, String> {
    // 文件夹：工具参数收的是**名字**，而 `note_list_view` 要的是 **id**。
    // 同名文件夹可能存在于不同父级下，取第一个匹配——个人规模下不值得
    // 为此引入路径语法，但这个取舍要写在工具描述里。
    let folder_filter = match folder {
        None => String::new(),
        Some(name) => {
            let folders = store.folder_list()?;
            match folders.iter().find(|f| f.name == name) {
                Some(f) => f.id.clone(),
                None => return Ok(ListOutcome::UnknownFolder(name.to_string())),
            }
        }
    };

    let tag_ids: Vec<String> = match tag {
        None => Vec::new(),
        Some(name) => {
            let tags = store.get_tags()?;
            match tags.iter().find(|t| t.name == name) {
                Some(t) => vec![t.id.clone()],
                // 🔴 R6：不能落回空 `tag_ids`——那就是「无声无息地返回全库第一页」。
                None => return Ok(ListOutcome::UnknownTag(name.to_string())),
            }
        }
    };

    let opts = NoteViewOpts::default();
    let notes = store.note_list_view(&folder_filter, &tag_ids, &opts, limit, offset)?;
    Ok(ListOutcome::Ok(notes))
}

fn search_on(store: &DataStore, query: &str, limit: u32) -> Result<SearchOutcome, String> {
    // 先单独跑一次拆词，就是为了分开那两种「没结果」。
    // 多一次纯字符串处理的开销，换模型一句可执行的提示，很划算。
    if crate::data_store::question_to_or_expr(query).is_none() {
        return Ok(SearchOutcome::NoSearchableTerms);
    }
    let opts = NoteViewOpts::default();
    let notes = store.note_search_relevant(query, "", &[], &opts, limit)?;
    if notes.is_empty() {
        Ok(SearchOutcome::NoMatch)
    } else {
        Ok(SearchOutcome::Hits(notes))
    }
}
