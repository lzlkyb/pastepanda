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

/// 七个写工具各自的权限档。一档对一个工具（1:1）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WriteKind {
    Create,
    Append,
    Update,
    Move,
    Tag,
    Delete,
    Restore,
}

impl WriteKind {
    /// 全部档位。数组下标就是 `as usize`，所以**顺序不能与 enum 声明错开**。
    pub const ALL: [WriteKind; 7] = [
        WriteKind::Create,
        WriteKind::Append,
        WriteKind::Update,
        WriteKind::Move,
        WriteKind::Tag,
        WriteKind::Delete,
        WriteKind::Restore,
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
            ],
            WriteKind::Move => &["kb_move"],
            WriteKind::Tag => &["kb_tag"],
            WriteKind::Delete => &["kb_delete"],
            WriteKind::Restore => &["kb_restore"],
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
        }
    }
}

/// 七个开关的快照。
///
/// 用 `[bool; 7]` 而不是七个具名字段：字段名与配置键要一一对应，
/// 写成七个字段就多一处能对错的地方（且 `move` 是关键字，得写成 `r#move`）。
/// 下标统一走 [`WriteKind::ALL`]，漏一档编译就不过。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteSwitches([bool; 7]);

impl WriteSwitches {
    /// 全开。测试与「配置读不到」时的取值。
    pub const ALL_ON: Self = Self([true; 7]);
    /// 全关。测试用。
    pub const ALL_OFF: Self = Self([false; 7]);

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
    pub fn from_config(cfg: &Value) -> Self {
        let mut out = [true; 7];
        for kind in WriteKind::ALL {
            out[kind as usize] = cfg
                .get(kind.cfg_key())
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
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
    /// `parent_of` 由调用方从 `folders()` 拼——取数据不在这里，权限判定全在这里。
    pub fn allows(
        &self,
        folder: Option<&str>,
        parent_of: &std::collections::HashMap<String, Option<String>>,
    ) -> bool {
        let Some(list) = &self.0 else {
            return true; // 没配过 = 不限制
        };
        let Some(id) = folder else {
            return list.iter().any(|s| s == UNFILED);
        };
        let mut cur = Some(id.to_string());
        // 步数封顶：正常深度不超 MAX_FOLDER_DEPTH，多给一步容错；
        // 同时它也是环的兜底——脏数据里 parent 链成环时不能死循环。
        for _ in 0..=crate::data_store::MAX_FOLDER_DEPTH {
            let Some(c) = cur else { return false };
            if list.iter().any(|s| *s == c) {
                return true;
            }
            cur = parent_of.get(&c).cloned().flatten();
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
        let parent_of: std::collections::HashMap<String, Option<String>> = folders
            .iter()
            .map(|f| (f.id.clone(), f.parent_id.clone()))
            .collect();
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
                inherited: !checked && self.allows(Some(&f.id), &parent_of),
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
                        && !parent_of
                            .get(&f.id)
                            .cloned()
                            .flatten()
                            .is_some_and(|p| self.allows(Some(&p), &parent_of))
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
}
