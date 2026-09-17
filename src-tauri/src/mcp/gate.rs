//! 写权限门（M5）。
//!
//! # 为何必须是**双层**
//!
//! 规划里的安全模型写的是「工具级开关控制 `tools/list` 里出现哪些工具——
//! 没开放的工具，模型根本不知道它存在」。这对**新连接**成立，但不够：
//! MCP 客户端会**缓存工具表**。用户关掉「允许删除」之后，一个早就 list 过的
//! 会话手里还握着旧表，照样能发 `tools/call`。
//!
//! 所以两层都要：`tools/list` 过滤（让模型不知道）+ `tools/call` 拦截（让它做不到）。
//! **后者才是真正的门**，前者只是减少诱惑。
//!
//! # 为何不发 `listChanged` 通知
//!
//! 本服务的传输层只有 `POST /mcp` 与 `GET /health`，**没有任何
//! server→client 通道**（无 SSE、无 streamable-HTTP 的 GET 端点）。
//! 声明 `listChanged: true` 却永远不发，是另一种形式的说谎。
//! 改完开关后客户端需重连才能看到新工具表——而 `tools/call` 那一层拦截
//! 是即时生效的，所以「没重连」不会变成安全漏洞，只是模型会白试一次。

use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 权限判定要的文件夹拓扑。
///
/// # 为什么要带 `ai_made`
///
/// `WriteScope` 的白名单是**按 id 沿 parent 链上溯**的，而 AI 建的夹
/// （`NoteFolder::source == "ai"`）**不在用户勾的名单里**。于是出现一个非对称：
/// `kb_folder_create` 建出来的夹，`kb_folder_dissolve` / `kb_folder_rename`
/// 解析出的是**夹子自身 id**，沿 parent 上溯到根级直接 `false`
/// ⇒ **AI 永远管不了自己刚建的那个夹**（每整理一次就留一个收拾不了的夹子）。
///
/// 2026-09-15 在真库上实测到了这一格：用户勾的是「未分类」+ `design`，
/// AI 建的夹 `parent_id = NULL, source = "ai"`，随后 `kb_folder_dissolve`
/// 被拦下（原文：「他只开放了 2 个位置给 AI 写入」）。
///
/// 语义落点：**AI 可以管理自己创建的容器。** 用户手工建的一律走白名单，
/// 一个字节都不放宽 —— 见 `test_ai_建的夹不该被白名单拦住` 那组断言。
///
/// # 🔴 它**只**服务于「容器自身」那条路（2026-09-15 当天修订）
///
/// 第一版把这条旁路也接到了「**往夹里放东西**」上（`kb_create` 的 `folder`、
/// `kb_move` 的目标那一支），当天就在真库上撞出了逃逸：AI 先借「未分类」
/// 那条授权在**根级**建了个夹，再把自己的 5 篇笔记搬进去 —— 全程 `ok=1`，
/// 而那个夹从来不在用户的白名单里。三处证据（`git diff` / `mcp_audit` /
/// 库里实际的 `folder_id`）完全对得上。
///
/// 根因是把「**容器**能不能动」和「**内容**能不能落在这儿」当成了同一件事。
/// 现在两者分得很死：内容是 [`WriteScope::allows`]（严格白名单），
/// 容器才是 [`WriteScope::allows_own`]。不分开的话白名单形同虚设 ——
/// 它是用户唯一能表达「别写这儿」的手段。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FolderTree {
    /// id → parent_id。
    pub parents: HashMap<String, Option<String>>,
    /// `source == "ai"` 的夹子 id。
    pub ai_made: HashSet<String>,
}

impl FolderTree {
    /// 从 `folder_list()` 的结果建。
    ///
    /// 收口成一个构造函数（规则 #11）：`tools::check_scope` 与
    /// `WriteScope::with_scope_view` 都要它，各拼一份的话
    /// 「哪边算了 `ai_made`」迟早会漂 —— 而漂的表现是权限**静默**放宽或收紧。
    ///
    /// `source` 只认字面 `"ai"`：`"manual"` 与（不该出现的）空串都算用户的。
    /// 判错方向要往**严**的那边倒。
    pub fn from_folders(folders: &[crate::data_store::NoteFolder]) -> Self {
        Self {
            parents: folders
                .iter()
                .map(|f| (f.id.clone(), f.parent_id.clone()))
                .collect(),
            ai_made: folders
                .iter()
                .filter(|f| f.source == "ai")
                .map(|f| f.id.clone())
                .collect(),
        }
    }
}

/// 写工具的权限档。一档管一个或多个工具。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WriteKind {
    Create,
    Append,
    Update,
    Move,
    Tag,
    Delete,
    Restore,
    /// 整理文件夹结构（改名 / 解散）。默认开，同其他七档。
    Structure,
}

impl WriteKind {
    /// 全部档位。数组下标就是 `as usize`，所以**顺序不能与 enum 声明错开**。
    pub const ALL: [WriteKind; 8] = [
        WriteKind::Create,
        WriteKind::Append,
        WriteKind::Update,
        WriteKind::Move,
        WriteKind::Tag,
        WriteKind::Delete,
        WriteKind::Restore,
        WriteKind::Structure,
    ];

    /// `config` 表里的键。开关不是秘密，可以进那张明文 KV。
    pub fn cfg_key(self) -> &'static str {
        match self {
            WriteKind::Create => "mcp_write_create",
            WriteKind::Append => "mcp_write_append",
            WriteKind::Update => "mcp_write_update",
            WriteKind::Move => "mcp_write_move",
            WriteKind::Tag => "mcp_write_tag",
            WriteKind::Delete => "mcp_write_delete",
            WriteKind::Restore => "mcp_write_restore",
            WriteKind::Structure => "mcp_write_structure",
        }
    }

    /// 这一档在**配置里没有这个键**时的取值。
    ///
    /// # 🔴 为何不是一句统一的 `unwrap_or(true)`，尽管现在每档都返 `true`
    ///
    /// 因为那句 `unwrap_or(true)` 曾经是「**绝不新开档位**」这条约束的**唯一**理由：
    /// 写成统一默认时，加一个新档位不用做任何选择就自动是开的——
    /// 那个默认是「没人想过」而不是「拍过」。拆成每档自己声明之后，
    /// 默认值仍然可以全是 `true`，但那变成一个**被写下的决定**。
    ///
    /// 🔴 故意不写 `_ => true` 兜底：加新档的人必须在这里亲手写下
    /// 它的默认值，想不明白就编不过。
    ///
    /// ⚠ 默认全开留着一个**已知**副作用，不藏：一个把七个开关全手动关掉的
    /// 老用户，升级后新档位在他配置里没有这个键 ⇒ 读默认值 ⇒ 是**开**的。
    /// 这是 2026-09-09 拍定的（“默认都要开启”），与旧的七档口径一致。
    pub fn default_on(self) -> bool {
        match self {
            WriteKind::Create
            | WriteKind::Append
            | WriteKind::Update
            | WriteKind::Move
            | WriteKind::Tag
            | WriteKind::Delete
            | WriteKind::Restore => true,
            // 整理文件夹：同其他七档默认开。用户能把 MCP 服务开起来
            // （它本身默认关、开启时还有确认弹窗），就已经表达了那个意愿。
            WriteKind::Structure => true,
        }
    }

    /// 这一档管着的工具名。**一档可以对多个工具**。
    ///
    /// 与 `tools::TOOLS` 表里的名字的一致性由测试钉住
    /// （`test_write_kind_tool_names_match_registry`）。界面上要把它们**全部**显示出来：
    /// 用户在调用记录里看到的就是这些名字，两边对得上才能关对开关。
    ///
    /// # 🔴 为何一档多工具，而不是一工具一档
    ///
    /// O-8 新加的精准编辑工具与 `kb_update` 是**同一种能力**的不同粒度。
    /// 若各给一个开关，「关掉修改笔记」就不再等于「AI 不能改我的笔记」。
    ///
    /// 而更硬的一条理由在 [`WriteSwitches::from_config`]：缺失的键读成 **`true`**。
    /// 所以**新增档位会在升级时静默给已经关掉修改权限的用户重新开一条修改通道**
    /// ——那是个真正的权限提升，且用户无从得知。复用现有档位则直接继承
    /// 他当前的选择，不存在这个问题。
    ///
    /// ⚠ 2026-09-09 破了一次例：新增了 [`WriteKind::Structure`]（整理文件夹）。
    /// 上面那个副作用是**明知的**，并且仍然存在（默认值拍定为开）。
    /// 换来的是粒度：改名/解散文件夹与「改笔记」不是同一种能力，
    /// 挂到 `Update` 上会让用户为了挡住前者而关掉后者。
    /// 同时把默认值拆成每档自己声明（[`WriteKind::default_on`]），
    /// 至少让下一个新档的默认值成为一个必须亲手写下的决定。
    ///
    /// 代价：失去「只许精准改、不许整篇覆盖」这种更安全的配置。
    /// 那是一个**模式**而不是「更多开关」，留待后续。
    pub fn tool_names(self) -> &'static [&'static str] {
        match self {
            WriteKind::Create => &["kb_create", "kb_folder_create"],
            WriteKind::Append => &["kb_append", "kb_prepend"],
            WriteKind::Update => &[
                "kb_update",
                "kb_update_section",
                "kb_insert_at_section",
                "kb_replace_in_note",
                // 回滚就是一次正文覆盖（内容来源是历史）；
                // 摘要是改笔记的一个字段。两个都得列在这里——
                // 用户在设置页看的就是这份名单，漏一个就是
                // 「关了修改笔记，但它还能回滚我的笔记」——而它其实不能。
                "kb_revert",
                "kb_summary",
            ],
            WriteKind::Move => &["kb_move"],
            WriteKind::Tag => &["kb_tag"],
            WriteKind::Delete => &["kb_delete"],
            WriteKind::Restore => &["kb_restore"],
            WriteKind::Structure => &["kb_folder_rename", "kb_folder_dissolve"],
        }
    }

    /// 报错文案里给模型看的中文名，与设置页那七行开关同名。
    ///
    /// 同名是有用的：模型把这句转述给用户时，用户能直接在面板上找到那一行。
    pub fn label(self) -> &'static str {
        match self {
            WriteKind::Create => "新建笔记",
            WriteKind::Append => "追加内容",
            WriteKind::Update => "修改笔记",
            WriteKind::Move => "移动文件夹",
            WriteKind::Tag => "改标签",
            WriteKind::Delete => "删除到回收站",
            WriteKind::Restore => "从回收站恢复",
            WriteKind::Structure => "整理文件夹",
        }
    }
}

/// 八个开关的快照。
///
/// 用 `[bool; 8]` 而不是八个具名字段：字段名与配置键要一一对应，
/// 写成八个字段就多一处能对错的地方（且 `move` 是关键字，得写成 `r#move`）。
/// 下标统一走 [`WriteKind::ALL`]，漏一档编译就不过。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteSwitches([bool; 8]);

impl WriteSwitches {
    /// 全开。测试与「配置读不到」时的取值。
    pub const ALL_ON: Self = Self([true; 8]);
    /// 全关。测试用。
    pub const ALL_OFF: Self = Self([false; 8]);

    pub fn allowed(&self, kind: WriteKind) -> bool {
        self.0[kind as usize]
    }

    /// 是不是一个写权限都没开。给 `instructions` 用——全关时得告诉模型「只读」。
    pub fn any_on(&self) -> bool {
        self.0.iter().any(|v| *v)
    }

    /// 从 `config` 表的 JSON 里读。
    ///
    /// 🔴 默认**全开**（已拍板），所以缺失的键要读成 `true`。
    /// 这与项目里其它开关的默认**相反**，别照抄那边的 `unwrap_or(false)`。
    /// 理由：MCP 服务本身默认就是关的、开启时又有确认弹窗，
    /// 用户能把服务开起来就已经表达了「我要让 AI 工具用我的知识库」。
    ///
    /// 具体默认值走 [`WriteKind::default_on`] 而不是写死在这里：
    /// 那一句统一的 `unwrap_or(true)` 曾经是「绝不新开档位」的唯一理由。
    pub fn from_config(cfg: &Value) -> Self {
        // 初值无关紧要：下面那个循环走 `WriteKind::ALL`，每个下标都会被盖一遍。
        // 写 `false` 而不是 `true`，是为了不让人把它误读成「默认全开」的出处。
        let mut out = [false; 8];
        for kind in WriteKind::ALL {
            out[kind as usize] = cfg
                .get(kind.cfg_key())
                .and_then(|v| v.as_bool())
                .unwrap_or(kind.default_on());
        }
        Self(out)
    }

    /// 给设置页的七行。顺序就是 [`WriteKind::ALL`] 的顺序（按风险递增）。
    pub fn rows(&self) -> Vec<WriteSwitchRow> {
        WriteKind::ALL
            .iter()
            .map(|k| WriteSwitchRow {
                key: k.cfg_key(),
                tools: k.tool_names(),
                label: k.label(),
                enabled: self.allowed(*k),
            })
            .collect()
    }
}

// ═════ 可写入的范围（项目②） ═════
//
// 写开关管「能做哪类事」，本节管「能对哪些笔记做」。两者**串联**：都过才行。

/// `config` 表里存白名单的键。值是 JSON 字符串数组。
pub const CFG_WRITE_FOLDERS: &str = "mcp_write_folders";

/// 「未分类」在白名单里的哨兵值。
///
/// 未分类的 `folder_id` 是 SQL `NULL`，存不进 id 数组。用字面串而不是 JSON `null`：
/// `null` 在「没配这一项」与「配了未分类」之间有歧义——那正是 2026-09-07
/// 刚在 `ParsedNote::tags` 上踩过的同一类坑。
///
/// 🔴 它不能撞上真实 folder id 的取值空间。现在 folder id 是 uuid，
/// 不含下划线，所以安全；`test_unfiled_sentinel_is_not_a_possible_id` 钉住这个前提。
pub const UNFILED: &str = "__unfiled__";

/// AI 可写入的范围。
///
/// # 三种状态，不是两种
///
/// 🔴 `None` 与 `Some(空)` 必须分开，理由跟 `ParsedNote::tags` 一模一样：
///   · `None`（配置里没这个键）= 用户从来没配过 ⇒ **不限制**。
///     升级兼容全靠这一条：老用户的 AI 写入不能因为多了个功能就静默失效。
///   · `Some([])` = 用户把每一行都取消了 ⇒ **一篇都不可写**。
///
/// 要是把两者归成「空 = 不限制」（规划初稿就是这么写的），用户在界面上
/// 取消全部勾选得到的结果会是**授权全库** —— 与他刚做的动作正好相反。
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct WriteScope(Option<Vec<String>>);

impl WriteScope {
    /// 不限制（用户未配过）。也是 `Default`。
    pub fn unrestricted() -> Self {
        Self(None)
    }

    /// 只授权这几项。测试与前端存盘用。
    pub fn only<I, S>(items: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self(Some(items.into_iter().map(Into::into).collect()))
    }

    pub fn is_unrestricted(&self) -> bool {
        self.0.is_none()
    }

    /// 已授权的条目（含可能的 [`UNFILED`] 哨兵）。
    ///
    /// 🔴 报错文案只能用它。**绝不得列范围外文件夹的名字** ——
    /// 那等于靠报错把用户的目录结构一点点泄露给模型（它只需要逐个试）。
    pub fn allowed_entries(&self) -> &[String] {
        self.0.as_deref().unwrap_or(&[])
    }

    /// 从 `config` 表的 JSON 里读。
    ///
    /// 键不存在、或被写坏成非数组，都当「没配过」（不限制）。
    /// 后一半是故意的：配置损坏时宁可放行，也不要把用户的 AI 写入全锁死
    /// —— 后者会表现成「AI 突然不工作了」而且没有任何线索。
    pub fn from_config(cfg: &Value) -> Self {
        match cfg.get(CFG_WRITE_FOLDERS).and_then(|v| v.as_array()) {
            None => Self(None),
            Some(arr) => Self(Some(
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
            )),
        }
    }

    /// 存回配置用。`None` 不写键（留给「没配过」）。
    pub fn to_config_value(&self) -> Option<Value> {
        self.0
            .as_ref()
            .map(|v| Value::Array(v.iter().map(|s| Value::String(s.clone())).collect()))
    }

    /// 这一篇（按它所在文件夹）可不可写。`folder` 为 `None` = 未分类。
    ///
    /// **递归**：勾了「工作」就包含它下面所有层。沿 parent 链往上逐级问。
    /// `tree` 由调用方从 `folder_list()` 建（[`FolderTree::from_folders`]）——
    /// 取数据不在这里，权限判定全在这里。
    ///
    /// # 三个判定函数的分工（别用混）
    ///
    /// | 函数 | 回答的问题 | 用在哪 |
    /// |---|---|---|
    /// | 本函数 | 这篇笔记 / 这个**内容落点**在授权范围里吗 | `ByNoteId`、`ByFolderArg`、`ByFolderInside`、`BothSides` 的目标支 |
    /// | [`Self::allows_own`] | 这个**夹子本身**能不能动 | 只给 `ByFolderOwn`（改名 / 解散）|
    /// | `allows_by_scope`（私有）| 用户**勾**了这一行吗（含继承）| 设置页那两个字段 |
    ///
    /// 🔴 **`allows_own` 不得下放到任何「内容落点」上。** 混用的后果见
    /// [`FolderTree`] 那段：AI 自建一个夹就能把授权范围外的地方变成可写。
    /// 反过来拿本函数去判「夹子自身」则是另一个 bug：AI 收拾不了自己建的夹
    /// （第一版就是这么修的，修出了一场逃逸）。
    pub fn allows(&self, folder: Option<&str>, tree: &FolderTree) -> bool {
        let Some(list) = &self.0 else {
            return true; // 没配过 = 不限制
        };
        let Some(id) = folder else {
            // 未分类这一支**不看 `ai_made`**：它问的不是「谁建的」，
            // 而是「用户授没授权 AI 碰没归属的笔记」。两者不是一回事。
            return list.iter().any(|s| s == UNFILED);
        };
        self.allows_by_scope(id, list, tree)
    }

    /// 同 [`Self::allows`]，但**多一条**：目标是 AI 建的夹就放行。
    ///
    /// # 为什么要有它（2026-09-15 在真库上实测到的 bug）
    ///
    /// 见 [`FolderTree`]。一句话：不加这条，`kb_folder_create` 建得出来的夹，
    /// `kb_folder_dissolve` 删不掉 —— AI 每整理一次就留一个自己收拾不了的夹子。
    ///
    /// # 🔴 它**只**用于「目标是文件夹本身」的那条路
    ///
    /// 现在只有 `kb_folder_rename` / `kb_folder_dissolve`（`ScopeTarget::ByFolderOwn`）。
    ///
    /// 2026-09-15 当天第一版还把它接到了 `kb_create` 的 `folder`、`kb_move` 的
    /// **目标夹**上 —— 理由是「那也是往自己的夹里放东西」。**那是错的**，
    /// 当天就在真库上被利用（见 [`FolderTree`] 第二段）：AI 自建一个根级夹，
    /// 就能把自己的东西搬进去，白名单被绕开。
    ///
    /// 判据很简单：**问「这个夹是谁建的」不等于问「这里能不能放内容」。**
    /// 用户完全可能把自己写的笔记放进 AI 建的夹里 —— 反过来说，
    /// AI 建的夹也从来不是用户授权过的内容落点。
    ///
    /// 🔴 `ByNoteId` 那条路同样不要用它：白名单是用户对**内容**的授权，
    /// 而「这个夹是 AI 建的」推不出「夹里的东西都归 AI 管」。容器归容器，内容归内容。
    pub fn allows_own(&self, folder: Option<&str>, tree: &FolderTree) -> bool {
        if !self.is_unrestricted() {
            if let Some(id) = folder {
                if tree.ai_made.contains(id) {
                    return true;
                }
            }
        }
        self.allows(folder, tree)
    }

    /// 授权范围里**可写入的文件夹**有几个（不含未分类）。
    ///
    /// 给 L2 信号用：`kb_folders` 那句「未分类里堆了 N 篇，用 kb_move 收进合适的
    /// 夹子」只在**真有地方可归**时才该说。用户只勾了「未分类」时，`kb_move`
    /// 的合法目的地只剩未分类自己（等于没搬），那句话就成了空话 ——
    /// 而空话的下场是被忽略，还白搭一次被拒的往返。
    ///
    /// 用 [`FolderTree::parents`] 的键当文件夹全集：它由 `folder_list()` 收口建出，
    /// 本来就装着每一个夹子，不必再查一次库（这个方法在一次 `kb_folders` 里被调）。
    ///
    /// ❗ 判据必须是 [`Self::allows`] 而不是 [`Self::allows_own`]：
    /// 这里数的是**内容能落到哪儿**。
    pub fn writable_folder_count(&self, tree: &FolderTree) -> usize {
        tree.parents
            .keys()
            .filter(|id| self.allows(Some(id.as_str()), tree))
            .count()
    }

    /// 只按白名单判（沿 parent 链上溯），**不含** AI 所有权旁路。
    ///
    /// 设置页那两个字段要用它：
    /// - `inherited`（这一行的勾是继承来的吗）—— AI 建的夹虽能通过
    ///   [`Self::allows`]，但那不是继承，标成继承会在界面上变成灰勾，
    ///   用户会以为父级被勾上了；
    /// - `covered`（已勾选的覆盖了多少篇）—— 没被勾的夹不该进这个数。
    fn allows_by_scope(&self, id: &str, list: &[String], tree: &FolderTree) -> bool {
        let mut cur = Some(id.to_string());
        // 步数封顶：正常深度不超 MAX_FOLDER_DEPTH，多给一步容错；
        // 同时它也是环的兜底——脏数据里 parent 链成环时不能死循环。
        for _ in 0..=crate::data_store::MAX_FOLDER_DEPTH {
            let Some(c) = cur else { return false };
            if list.contains(&c) {
                return true;
            }
            cur = tree.parents.get(&c).cloned().flatten();
        }
        false
    }
}

/// 设置页「可写入的范围」那一区要的全部数据。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteScopeView {
    /// `false` = 用户从未配过（不限制）。界面据此显示「全库」。
    pub restricted: bool,
    /// 可勾的行，顺序就是界面顺序：未分类在最前，然后是文件夹。
    pub rows: Vec<ScopeRow>,
    /// 已授权覆盖的笔记数 / 全库笔记数——界面上那个「可写 87 / 166 篇」。
    ///
    /// 为何报篇数：用户在这里做的决定本质上是「我把多少篇笔记交给 AI 写」。
    /// 只列文件夹名的话，他无法知道勾一个夹子是交出去 1 篇还是 500 篇。
    pub covered: i64,
    pub total: i64,
}

/// 选择器里的一行。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRow {
    /// folder id，或 [`UNFILED`]。
    pub id: String,
    pub name: String,
    /// 缩进层级。顶层为 **1**（跟 `folder_list` 的 `depth` 同口径）；未分类也是 1。
    pub depth: i64,
    /// 本文件夹**及其所有后代**里的笔记数（同 `NoteFolder::note_count`）。
    pub notes: i64,
    /// 用户**直接**勾了它。
    pub checked: bool,
    /// 由祖先的勾**继承**而来。
    ///
    /// 界面上显示为已勾但淡色、不可单独取消：后端存的是前缀递归语义，
    /// 允许单独取消子夹就得引入「排除项」，那是另一个量级的数据模型。
    pub inherited: bool,
}

impl WriteScope {
    /// 拼出设置页要的视图。
    ///
    /// 取数据不在这里（`folders` 与 `unfiled` 由调用方查），所以它能被单测。
    pub fn view(
        &self,
        folders: &[crate::data_store::NoteFolder],
        unfiled: i64,
    ) -> WriteScopeView {
        let tree = FolderTree::from_folders(folders);
        let entries = self.allowed_entries();
        let is_checked = |id: &str| entries.iter().any(|s| s == id);

        let mut rows = vec![ScopeRow {
            id: UNFILED.to_string(),
            name: "未分类".to_string(),
            depth: 1,
            notes: unfiled,
            checked: is_checked(UNFILED),
            // 未分类上面没有任何东西，不可能是继承来的。
            inherited: false,
        }];
        for f in folders {
            let checked = is_checked(&f.id);
            rows.push(ScopeRow {
                id: f.id.clone(),
                name: f.name.clone(),
                depth: f.depth,
                notes: f.note_count,
                checked,
                inherited: !checked && self.allows_by_scope(&f.id, entries, &tree),
            });
        }

        // 🔴 `note_count` **含后代**（看 `NoteFolder::note_count`），所以：
        //   · 全库数 = 未分类 + 所有**顶层**夹子的计数（再加子夹就重复了）；
        //   · 已覆盖数只能加**最外层的勾** —— 父子同时被勾时，
        //     直接相加会把子树算两遍（界面上就成了「可写 128 / 166」这种假数）。
        let filed: i64 = folders.iter().filter(|f| f.depth == 1).map(|f| f.note_count).sum();
        let total = unfiled + filed;
        let covered = if self.is_unrestricted() {
            total
        } else {
            let by_folders: i64 = folders
                .iter()
                // 只算自己被勾且**祖先都没被勾**的（即勾中森林的根）。
                .filter(|f| {
                    is_checked(&f.id)
                        && !tree
                            .parents
                            .get(&f.id)
                            .cloned()
                            .flatten()
                            .is_some_and(|p| self.allows_by_scope(&p, entries, &tree))
                })
                .map(|f| f.note_count)
                .sum();
            by_folders + if is_checked(UNFILED) { unfiled } else { 0 }
        };

        WriteScopeView {
            restricted: !self.is_unrestricted(),
            rows,
            covered,
            total,
        }
    }
}

/// 设置页上的一行开关。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSwitchRow {
    pub key: &'static str,
    /// 这一档管着的全部工具名。界面上要**逐个**显示——
    /// 它们就是用户在调用记录里看到的名字，少列一个就会有人找不到该关哪行。
    pub tools: &'static [&'static str],
    pub label: &'static str,
    pub enabled: bool,
}

/// 把一个配置键解回档位。命令层收到前端传的 key 时用。
///
/// 不认识的 key 返回 `None`，命令层报错而不是默默写一个没人读的配置项
/// ——后者会让用户看到一个看似生效了、实际什么也没关的开关（规则 #15.3）。
pub fn kind_of_key(key: &str) -> Option<WriteKind> {
    WriteKind::ALL.into_iter().find(|k| k.cfg_key() == key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_missing_keys_read_as_on() {
        // 🔴 默认全开是拍板结果。这条钉住它：空配置（老用户升级后的实际状态）
        // 必须是全开，而不是默认全关。读错了的后果是“开关看着是开的、实际调不通”。
        let s = WriteSwitches::from_config(&json!({}));
        assert_eq!(s, WriteSwitches::ALL_ON);
        assert!(s.any_on());
    }

    #[test]
    fn test_each_key_maps_to_its_own_kind() {
        // 防的是 `cfg_key` 与 `as usize` 下标错位：那会让用户关「删除」
        // 实际关掉的是「改标签」——一个安静得可怕的错。
        for kind in WriteKind::ALL {
            let cfg = json!({ kind.cfg_key(): false });
            let s = WriteSwitches::from_config(&cfg);
            assert!(!s.allowed(kind), "{} 关不掉", kind.cfg_key());
            for other in WriteKind::ALL {
                if other != kind {
                    assert!(s.allowed(other), "关 {} 误伤了 {}", kind.cfg_key(), other.cfg_key());
                }
            }
        }
    }

    #[test]
    fn test_all_keys_are_distinct() {
        let mut keys: Vec<&str> = WriteKind::ALL.iter().map(|k| k.cfg_key()).collect();
        keys.sort_unstable();
        let n = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), n, "两个档位共用了同一个配置键");
    }

    #[test]
    fn test_all_off_has_nothing_on() {
        assert!(!WriteSwitches::ALL_OFF.any_on());
        for kind in WriteKind::ALL {
            assert!(!WriteSwitches::ALL_OFF.allowed(kind));
        }
    }

    // ===== 文件夹拓扑与 AI 所有权旁路（2026-09-15）=====

    /// 造一个夹，只填权限判定用得到的字段。
    fn folder(id: &str, parent: Option<&str>, source: &str) -> crate::data_store::NoteFolder {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "parent_id": parent,
            "sort_order": 0,
            "created_at": "2026-09-01 10:00:00",
            "note_count": 0,
            "depth": 1,
            "source": source,
        }))
        .expect("造假文件夹失败（NoteFolder 的必填字段变了？）")
    }

    #[test]
    fn test_ai_建的夹不该被白名单拦住() {
        // 🔴 真机实测（2026-09-15）：用户勾的是「未分类」+ design，AI 借
        //    「未分类」那条授权在**根级**建了探针夹（parent_id = NULL,
        //    source = "ai"），随后 `kb_folder_dissolve` 被拦下 ——
        //    原文「他只开放了 2 个位置给 AI 写入」。
        //    非对称：**建得出来，收拾不了**。
        let scope = WriteScope::only([UNFILED]);
        let tree = FolderTree::from_folders(&[
            folder("f_ai", None, "ai"),
            folder("f_user", None, "manual"),
            // 用户建的、挂在 AI 夹下面 —— 它不该因为父级是 AI 的就放行。
            folder("f_user_child", Some("f_ai"), "manual"),
        ]);

        assert!(
            scope.allows_own(Some("f_ai"), &tree),
            "AI 建的夹应当能自己管，否则那个非对称还在"
        );
        assert!(
            !scope.allows(Some("f_ai"), &tree),
            "内容判定不跟着放开：AI 建的夹里可能有用户自己写的笔记"
        );

        assert!(!scope.allows_own(Some("f_user"), &tree), "用户建的夹不得放行");
        assert!(!scope.allows(Some("f_user"), &tree), "同上");
        assert!(
            !scope.allows_own(Some("f_user_child"), &tree),
            "用户建的子夹不因父级是 AI 建的就放行"
        );
    }

    #[test]
    fn test_未分类那一支与_ai_旁路无关() {
        let scope = WriteScope::only(["f_ai"]);
        let tree = FolderTree::from_folders(&[folder("f_ai", None, "ai")]);
        // 勾的是夹、没勾未分类 ⇒ 未分类不可写。`ai_made` 管不着这一支。
        assert!(!scope.allows(None, &tree));
        assert!(!scope.allows_own(None, &tree));
    }

    #[test]
    fn test_不限制时两条路都放行() {
        let tree = FolderTree::from_folders(&[folder("f_user", None, "manual")]);
        let scope = WriteScope::unrestricted();
        assert!(scope.allows(Some("f_user"), &tree));
        assert!(scope.allows_own(Some("f_user"), &tree));
        assert!(scope.allows(None, &tree));
    }

    #[test]
    fn test_ai_旁路不能污染设置页的勾与继承() {
        // 🔴 拿 `allows`（含旁路的那套）去算界面字段，AI 建的夹会被标成
        //    「继承来的勾」——界面上那是灰勾，用户会以为父级被勾上了。
        //    而它其实只是「AI 能自己管」，与用户勾没勾是两回事。
        let scope = WriteScope::only([UNFILED]);
        let v = scope.view(&[folder("f_ai", None, "ai")], 3);
        let row = v.rows.iter().find(|r| r.id == "f_ai").expect("少了 f_ai 那一行");
        assert!(!row.checked, "用户没勾它");
        assert!(!row.inherited, "AI 建的夹不是「继承来的勾」");
        assert_eq!(v.covered, 3, "只勾了未分类，覆盖的就是那 3 篇");
        assert_eq!(v.total, 3);
    }

    #[test]
    fn test_空树与空范围都不炸() {
        let tree = FolderTree::default();
        let scope = WriteScope::only(Vec::<String>::new());
        assert!(!scope.allows(Some("f_x"), &tree), "空树里查任何 id 都该是 false");
        assert!(!scope.allows_own(Some("f_x"), &tree));
        assert!(!scope.allows(None, &tree), "空范围连未分类都不给");
        assert_eq!(scope.writable_folder_count(&tree), 0);
    }

    /// 🔴 2026-09-15 真库逃逸的直接回归：AI 借「未分类」那条授权在**根级**
    /// 建了个夹，再把自己 5 篇笔记搬进去，全程没被拦。
    ///
    /// 修法不是「不让它建」（那是容器的事，见 `allows_own`），
    /// 而是**那个夹不是内容落点** —— 白名单里没有它，就一篇也放不进去。
    #[test]
    fn test_ai_建在根级的夹不是内容落点() {
        let scope = WriteScope::only([UNFILED]);
        let tree = FolderTree::from_folders(&[
            // 真库里那个夹：根级、AI 建的、不在白名单。
            folder("f_ai_root", None, "ai"),
            folder("f_user", None, "manual"),
        ]);

        assert!(
            !scope.allows(Some("f_ai_root"), &tree),
            "AI 建的根级夹不得成为内容落点 —— 否则自建一个夹就等于自授权"
        );
        // 但容器本身它管得着，这是防「建得出来删不掉」的那条（两件事不能混）。
        assert!(scope.allows_own(Some("f_ai_root"), &tree));

        // 授权夹**里面**的子夹仍然是合法落点：那是用户划的地盘内部。
        let tree2 = FolderTree::from_folders(&[
            folder("f_user", None, "manual"),
            folder("f_ai_child", Some("f_user"), "ai"),
        ]);
        let scope2 = WriteScope::only(["f_user"]);
        assert!(
            scope2.allows(Some("f_ai_child"), &tree2),
            "授权夹内部的子夹应当可写 —— 否则 AI 建完就放不进东西（空壳）"
        );
    }

    /// L2 信号那句「收进合适的夹子」只在**真有地方可归**时才该说。
    #[test]
    fn test_可写夹子计数决定那句提示有没有意义() {
        // 两层：技术（用户建的）→ 技术/Rust（AI 建的）；另一个根级夹没人勾。
        let folders = [
            folder("f_tech", None, "manual"),
            folder("f_rust", Some("f_tech"), "ai"),
            folder("f_other", None, "manual"),
        ];
        let tree = FolderTree::from_folders(&folders);

        // 只勾「未分类」⇒ 一个可写的目的地都没有。kb_move 只能原地打转。
        let only_unfiled = WriteScope::only([UNFILED]);
        assert_eq!(
            only_unfiled.writable_folder_count(&tree),
            0,
            "只勾未分类时不该数出可写夹子 —— 数出来了就会推一句做不到的话"
        );

        // 勾了技术 ⇒ 它自己 + 子夹 Rust，共 2。
        let tech = WriteScope::only(["f_tech"]);
        assert_eq!(tech.writable_folder_count(&tree), 2);

        // 用户没配过 ⇒ 不限制，全部可写。
        assert_eq!(WriteScope::unrestricted().writable_folder_count(&tree), 3);
    }
}
