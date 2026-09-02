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

    /// 对应的工具名。
    ///
    /// 与 `tools::TOOLS` 表里的名字的一致性由测试钉住
    /// （`test_write_kind_tool_names_match_registry`）。界面上要把它显示出来：
    /// 用户在调用记录里看到的就是这个名字，两边对得上才能关对开关。
    pub fn tool_name(self) -> &'static str {
        match self {
            WriteKind::Create => "kb_create",
            WriteKind::Append => "kb_append",
            WriteKind::Update => "kb_update",
            WriteKind::Move => "kb_move",
            WriteKind::Tag => "kb_tag",
            WriteKind::Delete => "kb_delete",
            WriteKind::Restore => "kb_restore",
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
                tool: k.tool_name(),
                label: k.label(),
                enabled: self.allowed(*k),
            })
            .collect()
    }
}

/// 设置页上的一行开关。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSwitchRow {
    pub key: &'static str,
    /// 工具名。界面上要显示——它就是用户在调用记录里看到的那个名字。
    pub tool: &'static str,
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
