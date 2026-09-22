//! 文件传输（G6）的线格式与文件名净化。
//!
//! 本模块**只有纯逻辑**：编解码 + 判据 + 限额。网络与磁盘在
//! `file_transfer.rs`、跨会话状态收口在 `file_state.rs`。
//! 这样切是为了让「协议怎么解」和「名字能不能落盘」这两件最容易出事的
//! 事**能被单测直接打**——它们错了不会编译报错，只会静默传坏 / 写错地方。
//!
//! 线格式（一个文件 = 一条 bi-stream，见设计稿 §4.2）：
//!
//! ```text
//! 发送半流：  "PPFIL1" | frame(JSON 头) | [裸字节 × size] | finish()
//! 接收半流：  frame({"t":"accept", ...}) | frame({"t":"deny", ...})
//! ```
//!
//! `frame` = [`crate::sync::transport::write_frame`]（u32 **大端** 长度 + 内容）。
//! `rc/audio.rs` 的 `PPAUD1` 用**小端**是它自成一体的包封装；这里刻意复用
//! transport 那一套，因为确认帧本来就走它——同一份代码里两套字节序是白送的
//! bug 源。魔数仍是 6 字节，认流靠它而不靠长度前缀。
//!
//! 头帧有两个变体（`t` 区分）：
//! - `{"t":"push","v":1,"name":"报告.zip","size":12345678}` —— 我要发给你
//! - `{"t":"pull_req","v":1,"resume":[{"name":"素材.mp4","offset":123456}]}` ——
//!   我请求你发给我，并附上本机已有的未完成文件（见 [`ResumeHint`]）
//!
//! 两个方向**共用**同一套收发代码，区别只在谁 `open_bi`、头帧是哪个变体
//! （设计稿第十节决策 7 的派生纪律：不要写两条平行路径）。

use serde::{Deserialize, Serialize};

/// 文件流魔数（版本号缀在末尾：协议不兼容时对端认不出，直接关流）。
pub const MAGIC: &[u8; 6] = b"PPFIL1";

/// 单个文件大小上限。与 `sync/transport.rs::MAX_TRANSFER_BYTES` 同口径——
/// **在分配内存 / 开文件句柄之前**夹住对端声明的长度（那行注释的原话：
/// 「一行 `vec![0u8; l]` 就能把进程弄死」）。
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 头帧 JSON 上限。头只有几百字节；`write_frame` 的 64 KiB 是给未来留的余量，
/// 这里再收一道，免得对端拿一个巨型 JSON 顶满内存。
pub const MAX_HEAD_JSON: usize = 4096;

/// 文件名字节上限。沿用 `sync/transport.rs::MAX_NAME_LEN` 的口径。
pub const MAX_NAME_BYTES: usize = 1024;

/// Windows 单个路径组件的字符上限（UTF-16 单元数）。
const MAX_COMPONENT: usize = 255;

/// 未完成文件的后缀。接收端先写 `.pppart`，收满后 `rename`——
/// 于是「同名 + 同大小」就是续传判据（设计稿决策 9）。
pub const PART_SUFFIX: &str = ".pppart";

/// 取回方向最多带几条续传提示。列表来自本机目标目录的 `.pppart` 扫描，
/// 上限是为了不让一个头帧变成目录清单（头帧总量另有 `MAX_HEAD_JSON` 兜底）。
pub const MAX_RESUME_HINTS: usize = 8;

/// 落盘前必须替换掉的字符（Windows 文件名禁用集）。
///
/// ❗ 反斜杠写成 `'\u{5C}'` 而**不是字面量**：本仓库的文件内容经多层工具
/// 传递，字面反斜杠被吞过五次（见 `sync/transport.rs::BACKSLASH` 的注释）。
const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\u{5C}', '|', '?', '*'];

/// 路径分隔符（正斜杠 + 反斜杠）。
const SEP: [char; 2] = ['/', '\u{5C}'];

/// 拒绝码。前端 `rcDeny.ts` 据此分档，**不允许塌缩成「连接失败」**——
/// 「对端版本不支持文件传输」必须能被单独认出来（调研文档点名要求）。
pub mod code {
    /// 头帧解不开 / 不是期望的变体。
    pub const BAD_HEAD: &str = "file_bad_head";
    /// 协议版本不认。
    pub const VERSION: &str = "file_version";
    /// 超过大小上限。
    pub const SIZE_LIMIT: &str = "file_size_limit";
    /// 文件名无法净化。
    pub const BAD_NAME: &str = "file_bad_name";
    /// 人点了拒绝。
    pub const DENIED: &str = "file_denied";
    /// 等确认超时。
    pub const TIMEOUT: &str = "file_timeout";
    /// 传输中无进展。
    pub const STALL: &str = "file_stall";
    /// 主动取消。
    pub const CANCELED: &str = "file_canceled";
    /// 本机拒收（磁盘/权限等）。
    pub const LOCAL: &str = "file_local";
}

/// 协议版本。加字段不算改版本（`serde` 容忍未知字段）；改语义才算。
pub const VERSION: u8 = 1;

/// 拒绝原因（`reason` 给人看，`code` 给前端分档）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deny {
    pub reason: String,
    pub code: &'static str,
}

impl Deny {
    pub fn new(reason: impl Into<String>, code: &'static str) -> Self {
        Self {
            reason: reason.into(),
            code,
        }
    }
}

// ── 线格式 ──────────────────────────────────────────────────────────────

/// 取回方向：请求方告诉对方「我这儿已有哪些未完成文件」。
///
/// **为什么需要它**：取回方向的数据是**对方**发的，对方不知道本机已经收了多少——
/// 不给提示就只能整包重来。而「取回」恰好是最高频的方向（拿回家里电脑的文件），
/// 大文件中断重来最痛（设计稿 11.4）。
///
/// 语义是**提示而非承诺**：发送方命中就续、不命中就从头传，绝不因为对不上而失败。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeHint {
    /// 上一次传输时对方报的文件名（就是 `.pppart` 去掉后缀的那部分）。
    pub name: String,
    /// 本机已落盘的字节数。
    pub offset: u64,
}

/// 发送半流的头帧。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum FileHead {
    /// 推送：我要把 `name`（`size` 字节）发给你。
    Push { v: u8, name: String, size: u64 },
    /// 取回：我请求你选一个文件发给我。对方在**接收半流**回
    /// `Accept { name, size, offset }` 然后灌字节——数据方向与请求方向相反。
    PullReq {
        v: u8,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        resume: Vec<ResumeHint>,
    },
}

/// 接收半流的确认帧。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum FileAck {
    /// 接受。
    Accept {
        /// 取回方向：由**发送方**（被请求方）填写；推送方向为 `None`
        /// （发送方已经知道名字）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        /// ❗ 语义是「**收数据那一侧**已落盘的字节数」，不是发送侧的进度：
        /// 推送时 = 接收方回报；取回时 = 请求方回报。0 = 从头传。
        #[serde(default, skip_serializing_if = "is_zero")]
        offset: u64,
    },
    /// 拒绝。
    Deny {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

/// `serde` 的 `skip_serializing_if` 判据：0 不上线。
fn is_zero(v: &u64) -> bool {
    *v == 0
}

/// 是不是文件流（按魔数认，不按长度前缀）。
pub fn is_magic(b: &[u8]) -> bool {
    b.starts_with(&MAGIC[..])
}

/// 编码一个头帧（校验失败会返回 `Err`，调用方据此本地拒，不必上网络）。
pub fn encode_head(h: &FileHead) -> Result<Vec<u8>, Deny> {
    validate_head(h)?;
    serde_json::to_vec(h).map_err(|e| Deny::new(format!("编码文件头失败：{}", e), code::BAD_HEAD))
}

/// 解码头帧。**先夹长度**再交给 serde。
///
/// 与 `RcFrame::decode` 的差别：这里**校验版本与限额**（那个只解码）。
/// 文件头来自网络且紧接着就要落盘，判据必须在对端数据到达的同一处收口。
pub fn decode_head(bytes: &[u8]) -> Result<FileHead, Deny> {
    if bytes.is_empty() || bytes.len() > MAX_HEAD_JSON {
        return Err(Deny::new(
            format!("文件头长度不合法（{} 字节）", bytes.len()),
            code::BAD_HEAD,
        ));
    }
    let h: FileHead = serde_json::from_slice(bytes)
        .map_err(|e| Deny::new(format!("文件头无法识别：{}", e), code::BAD_HEAD))?;
    validate_head(&h)?;
    Ok(h)
}

/// 头帧判据（纯函数，单测直接打）。
pub fn validate_head(h: &FileHead) -> Result<(), Deny> {
    let v = match h {
        FileHead::Push { v, .. } | FileHead::PullReq { v, .. } => *v,
    };
    if v != VERSION {
        return Err(Deny::new(
            format!("对方文件传输协议版本 {} 不兼容", v),
            code::VERSION,
        ));
    }
    if let FileHead::Push { name, size, .. } = h {
        if *size > MAX_FILE_BYTES {
            return Err(Deny::new(
                format!("文件超过上限（{} 字节）", MAX_FILE_BYTES),
                code::SIZE_LIMIT,
            ));
        }
        safe_file_name(name)
            .map_err(|e| Deny::new(format!("文件名不可用：{}", e), code::BAD_NAME))?;
    }
    if let FileHead::PullReq { resume, .. } = h {
        if resume.len() > MAX_RESUME_HINTS {
            return Err(Deny::new(
                format!("续传提示过多（{} 条）", resume.len()),
                code::BAD_HEAD,
            ));
        }
        for r in resume {
            if r.offset > MAX_FILE_BYTES || r.name.len() > MAX_NAME_BYTES {
                return Err(Deny::new("续传提示字段越界", code::BAD_HEAD));
            }
        }
    }
    Ok(())
}

/// 校验确认帧里对端报的 size（取回方向由对端填，同样要在落盘前夹住）。
pub fn check_ack_accept(name: Option<&str>, size: Option<u64>) -> Result<(String, u64), Deny> {
    let name = name.ok_or_else(|| Deny::new("对方未提供文件名", code::BAD_HEAD))?;
    let size = size.ok_or_else(|| Deny::new("对方未提供文件大小", code::BAD_HEAD))?;
    if size > MAX_FILE_BYTES {
        return Err(Deny::new(
            format!("文件超过上限（{} 字节）", MAX_FILE_BYTES),
            code::SIZE_LIMIT,
        ));
    }
    let clean = safe_file_name(name)
        .map_err(|e| Deny::new(format!("文件名不可用：{}", e), code::BAD_NAME))?;
    Ok((clean, size))
}

pub fn encode_ack(a: &FileAck) -> Result<Vec<u8>, String> {
    serde_json::to_vec(a).map_err(|e| format!("编码确认帧失败：{}", e))
}

pub fn decode_ack(bytes: &[u8]) -> Result<FileAck, String> {
    if bytes.is_empty() || bytes.len() > MAX_HEAD_JSON {
        return Err(format!("确认帧长度不合法（{} 字节）", bytes.len()));
    }
    serde_json::from_slice(bytes).map_err(|e| format!("确认帧无法识别：{}", e))
}

// ── 文件名净化（🔴 全库唯一入口）──────────────────────────────────────

/// 把对端给的名字净化成**可以安全落盘**的名字。
///
/// 🔴 **凡是拿对端给的字串拼本机路径的地方，都必须先过这里。**
/// `sync/transport.rs::safe_rel` 的注释记着 2026-09-07 那次教训：文件**名**
/// 过了校验、文件**内容**没人管，而那条路径下面就是一句 `std::fs::remove_file`
/// ——已配对的对端因此能删本机任意文件。v1 是扁平文件（不拼相对路径），
/// 但边界**只有这一道**，P1 的目录树版本也必须过它。
///
/// 与 `safe_rel` 的差别是策略不同：那边越界一律 **Err**；这里对「非法字符」
/// 选**替换**而不是拒绝——因为拒绝会让用户完全传不了那个文件，而替换 + 落盘后
/// UI 明确显示实际文件名，是可解释的失败。真正危险的（路径跳转、空名、
/// 保留名）仍然拒绝或前缀化。
pub fn safe_file_name(raw: &str) -> Result<String, String> {
    // 1. 取 basename：兼容对端误带路径（`C:\Users\x\报告.zip`），
    //    **绝不重建目录结构**——扁平是 v1 的硬约束。
    let base = basename(raw.trim());
    if base.is_empty() {
        return Err("空文件名".to_string());
    }
    // 2. 剥掉结尾的 `.` 与空格：Windows 会**静默**剥掉，于是 `a.` 与 `a`
    //    会撞同一个落点（而本模块的重名判据看到的还是两个不同的名字）。
    let trimmed = base.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(format!("非法文件名：{}", raw));
    }
    // 3. 替换非法字符与控制字符（控制字符包含 NUL——它能让 C 侧 API 提前截断）。
    //    🔴 Cf 类（格式控制符）也要拦（P1-6）：`U+202E`（RTL Override）能把
    //    `gpj.exe` 显示成 `exe.jpg`——RTLO 欺骗，确认条与资源管理器都会中招。
    //    `is_control()` 只覆盖 Cc 类，Cf 类要显式按码位拦。
    let mut out: String = trimmed
        .chars()
        .map(|c| {
            if c.is_control() || is_format_control(c) || ILLEGAL.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // 4. Windows 保留名：`CON` / `NUL` / `COM1`… **带扩展名也是保留名**
    //    （`NUL.txt` 一样打不开，这是经典坑）。前缀 `_` 而不是拒绝——
    //    拒绝会让「对方机器上那个叫 NUL.txt 的文件」永远传不过来。
    if is_reserved_name(&out) {
        out.insert(0, '_');
    }
    // 5. 长度：按 **UTF-16 码元**截（Windows 的口径），但**保留扩展名**
    //    （截断后仍要能双击打开）。见 `clamp_component` 的 D8 注释。
    let out = clamp_component(&out);
    if out.is_empty() {
        return Err("文件名净化后为空".to_string());
    }
    Ok(out)
}

/// 取最后一段路径。用 `rsplit` 而不是「找第一个分隔符」——名字里带
/// 分隔符时**只有最后一段**才是对端想传的文件名。
fn basename(raw: &str) -> &str {
    raw.rsplit(SEP).next().unwrap_or("")
}

/// Unicode Cf 类（格式控制符）要拦：`is_control()` 只覆盖 Cc 类，
/// `U+202E`（RTL Override）等 Cf 字符会把显示顺序整个翻转（RTLO 欺骗）。
/// 覆盖 Bidi 嵌入/覆盖、隔离符与零宽系列——文件名里它们没有合法用途。
fn is_format_control(c: char) -> bool {
    matches!(u32::from(c),
        0x200B..=0x200F   // 零宽空格/连接符 + LRM/RLM
        | 0x202A..=0x202E // LRE/LRO/RLE/RLO/PDF（含 RTL Override）
        | 0x2066..=0x2069 // LRI/RLI/FSI/PDI
        | 0xFEFF          // BOM / 零宽不换行空格
    )
}

/// 主干是不是 Windows 保留设备名（大小写不敏感，忽略扩展名）。
///
/// D8（2026-09-22 审计）：`CONIN$` / `CONOUT$` 也是保留设备名（控制台输入/输出
/// 句柄），原清单只覆盖 CON/PRN/AUX/NUL/COM*/LPT*。它们的 `$` 是名字的一部分，
/// 且**不带扩展名语义**——`CONIN$.txt` 在 Windows 上照样是设备，所以这里和
/// 其它保留名一样按「取第一个点之前的主干」比对即可。
fn is_reserved_name(name: &str) -> bool {
    let stem = match name.find('.') {
        Some(i) => &name[..i],
        None => name,
    };
    let up = stem.trim().to_ascii_uppercase();
    if up == "CON" || up == "PRN" || up == "AUX" || up == "NUL" || up == "CONIN$" || up == "CONOUT$" {
        return true;
    }
    // COM0-9 / LPT0-9。0 也一并算上：部分 Windows 版本把 COM0/LPT0 同样
    // 视为设备名，多挡一个的代价只是多一个下划线。
    let rest = match up.strip_prefix("COM").or_else(|| up.strip_prefix("LPT")) {
        Some(r) => r,
        None => return false,
    };
    rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit()
}

/// 按 **UTF-16 码元**预算取前缀（Windows 的长度口径，见 `clamp_component` 的 D8 注释）。
///
/// 收成一个函数是因为「按码元算」这件事在本文件出现三处（主干截断 / 扩展名判长 /
/// 重名后缀预留），三处口径必须一致：只改一处的话，辅助平面字符组成的名字会
/// 在某个环节被多算一倍，表现为「截得不够 → 后面的 clamp 又把刚加的 `(1)` 削掉」。
fn take_units(s: &str, budget: usize) -> String {
    let mut used = 0usize;
    s.chars()
        .take_while(|c| {
            let w = c.len_utf16();
            if used + w > budget {
                return false;
            }
            used += w;
            true
        })
        .collect()
}

/// 截断到 Windows 单组件上限内，**保留扩展名**。
///
/// 🔴 D8（2026-09-22 审计）：Windows 的 255 上限按 **UTF-16 码元**算，不是码点。
/// 辅助平面字符（emoji、CJK 扩展 B 及以后）**一个码点 = 2 个码元**，原实现用
/// `chars().count() <= 255` 判断会放过最坏 510 码元的文件名——落盘时才失败，
/// 而那时用户已经在等传输了。这里所有长度口径统一改成码元。
fn clamp_component(name: &str) -> String {
    if name.encode_utf16().count() <= MAX_COMPONENT && name.len() <= MAX_NAME_BYTES {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    // 扩展名超过 16 个字符基本不是扩展名（是名字里带的点），不保。
    let keep_ext = !ext.is_empty() && ext.encode_utf16().count() <= 16;
    let reserve = if keep_ext {
        ext.encode_utf16().count() + 1
    } else {
        0
    };
    let budget = MAX_COMPONENT.saturating_sub(reserve);
    // 按**码元**预算取主干（一个 emoji 要吃掉 2 格）
    let stem = take_units(stem, budget);
    // 截断后可能又落回结尾 `.`/空格（`a. .b` 之类），再剥一次。
    let mut out = stem.trim_end_matches(['.', ' ']).to_string();
    if out.len() > MAX_NAME_BYTES {
        let mut cut = String::new();
        for c in out.chars() {
            if cut.len() + c.len_utf8() > MAX_NAME_BYTES {
                break;
            }
            cut.push(c);
        }
        out = cut;
    }
    if keep_ext {
        out.push('.');
        out.push_str(ext);
    }
    out
}

/// 拆「主干 / 扩展名」。只认最后一个点，且点不在开头（`.gitignore` 是
/// 一个没有扩展名的整体，拆成 `""` + `gitignore` 会丢名字）。
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// 重名递增：`报告.zip` → `报告 (1).zip`；**绝不覆盖**已存在的文件。
///
/// `exists` 由调用方给（真查盘 / 测试桩）——这样这个函数保持纯的，
/// 单测不用碰磁盘。`Err` 只在极端重名（>9999 个同名）时出现。
pub fn unique_name<F>(name: &str, exists: F) -> Result<String, String>
where
    F: Fn(&str) -> bool,
{
    if !exists(name) {
        return Ok(name.to_string());
    }
    let (stem, ext) = split_ext(name);
    // 扩展名超过 16 个字符基本不是扩展名（是名字里带的点），不保。
    let keep_ext = !ext.is_empty() && ext.encode_utf16().count() <= 16;
    for i in 1..=9999u32 {
        let suffix = if keep_ext {
            format!(" ({}).{}", i, ext)
        } else {
            format!(" ({})", i)
        };
        // 🔴 先按**后缀长度**截主干，再拼后缀——反过来（先拼再 clamp）会把刚加的
        //    `(1)` 截掉，候选于是等于原名、永远冲突，一直空转到 9999 次才报错。
        //    D8：口径是 **UTF-16 码元**（与 `clamp_component` 一致）——按码点数截
        //    时，辅助平面字符组成的名字会截不够长，`clamp_component` 再把刚拼上
        //    的 `(1)` 削掉，于是候选又等于原名，退化成上面那个空转。
        let budget = MAX_COMPONENT.saturating_sub(suffix.encode_utf16().count());
        let head = take_units(stem, budget);
        let head = head.trim_end_matches(['.', ' ']);
        let cand = clamp_component(&format!("{}{}", head, suffix));
        if !exists(&cand) {
            return Ok(cand);
        }
    }
    Err(format!("同名文件过多，无法为 {} 找到空位", name))
}

/// 未完成文件的落点：`报告.zip` → `报告.zip.ppart`。
pub fn part_path(final_name: &str) -> String {
    format!("{}{}", final_name, PART_SUFFIX)
}

/// 占用判定：最终名**或**其 `.pppart` 任一被占都算冲突。
///
/// P1-4：只查最终名时，同名 `.pppart` 在写会被当成空位，两个接收方互写同一
/// 个 part，收满 rename 后得到的是两段数据拼出来的损坏文件。
pub fn name_or_part_taken<F>(name: &str, exists: F) -> bool
where
    F: Fn(&str) -> bool,
{
    exists(name) || exists(&part_path(name))
}

/// 从 `.pppart` 反推最终名。不是 part 文件返回 `None`。
pub fn final_from_part(part_name: &str) -> Option<&str> {
    part_name.strip_suffix(PART_SUFFIX)
}

#[cfg(test)]
mod tests;
