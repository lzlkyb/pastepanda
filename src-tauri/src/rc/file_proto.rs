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
    let mut out: String = trimmed
        .chars()
        .map(|c| {
            if c.is_control() || ILLEGAL.contains(&c) {
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
    // 5. 长度：按字符截，但**保留扩展名**（截断后仍要能双击打开）。
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

/// 主干是不是 Windows 保留设备名（大小写不敏感，忽略扩展名）。
fn is_reserved_name(name: &str) -> bool {
    let stem = match name.find('.') {
        Some(i) => &name[..i],
        None => name,
    };
    let up = stem.trim().to_ascii_uppercase();
    if up == "CON" || up == "PRN" || up == "AUX" || up == "NUL" {
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

/// 截断到 Windows 单组件上限内，**保留扩展名**。
fn clamp_component(name: &str) -> String {
    if name.chars().count() <= MAX_COMPONENT && name.len() <= MAX_NAME_BYTES {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    // 扩展名超过 16 个字符基本不是扩展名（是名字里带的点），不保。
    let keep_ext = !ext.is_empty() && ext.chars().count() <= 16;
    let reserve = if keep_ext { ext.chars().count() + 1 } else { 0 };
    let budget = MAX_COMPONENT.saturating_sub(reserve);
    let mut out: String = stem.chars().take(budget).collect();
    // 截断后可能又落回结尾 `.`/空格（`a. .b` 之类），再剥一次。
    out = out.trim_end_matches(['.', ' ']).to_string();
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
    let keep_ext = !ext.is_empty() && ext.chars().count() <= 16;
    for i in 1..=9999u32 {
        let suffix = if keep_ext {
            format!(" ({}).{}", i, ext)
        } else {
            format!(" ({})", i)
        };
        // 🔴 先按**后缀长度**截主干，再拼后缀——反过来（先拼再 clamp）会把刚加的
        //    `(1)` 截掉，候选于是等于原名、永远冲突，一直空转到 9999 次才报错。
        let budget = MAX_COMPONENT.saturating_sub(suffix.chars().count());
        let mut head: String = stem.chars().take(budget).collect();
        head = head.trim_end_matches(['.', ' ']).to_string();
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

/// 从 `.pppart` 反推最终名。不是 part 文件返回 `None`。
pub fn final_from_part(part_name: &str) -> Option<&str> {
    part_name.strip_suffix(PART_SUFFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 文件名净化 ─────────────────────────────────────────────────────

    #[test]
    fn 正常名字原样通过() {
        assert_eq!(safe_file_name("报告.zip").unwrap(), "报告.zip");
        assert_eq!(safe_file_name("  a b.txt  ").unwrap(), "a b.txt");
        assert_eq!(safe_file_name(".gitignore").unwrap(), ".gitignore");
        assert_eq!(safe_file_name("a.b.c.tar.gz").unwrap(), "a.b.c.tar.gz");
    }

    #[test]
    fn 带路径的名字只取最后一段() {
        // 兼容对端误带路径，但绝不重建目录结构（v1 扁平的硬约束）
        assert_eq!(
            safe_file_name("C:\\Users\\x\\报告.zip").unwrap(),
            "报告.zip"
        );
        assert_eq!(safe_file_name("/home/u/photo.png").unwrap(), "photo.png");
        // `..` 段被当路径剥掉——落到本机时只剩文件名
        assert_eq!(safe_file_name("../../etc/passwd").unwrap(), "passwd");
    }

    #[test]
    fn 空名与纯跳转名被拒() {
        assert!(safe_file_name("").is_err());
        assert!(safe_file_name("   ").is_err());
        assert!(safe_file_name(".").is_err());
        assert!(safe_file_name("..").is_err());
        assert!(safe_file_name("C:\\Users\\x\\").is_err(), "剥完为空要拒");
        // 结尾点是 Windows 会静默剥的，剥完为空 ⇒ 拒
        assert!(safe_file_name("...").is_err());
    }

    #[test]
    fn 结尾点与空格被剥掉() {
        // 不剥的话 `a.` 与 `a` 会撞同一个落点，而重名判据看到的却是两个名字
        assert_eq!(safe_file_name("a.").unwrap(), "a");
        assert_eq!(safe_file_name("a.  ").unwrap(), "a");
        assert_eq!(safe_file_name("a .txt").unwrap(), "a .txt", "中间的点不动");
    }

    #[test]
    fn 非法字符被替换成下划线() {
        assert_eq!(safe_file_name("a:b*c?.txt").unwrap(), "a_b_c_.txt");
        assert_eq!(safe_file_name("a<b>c|d.txt").unwrap(), "a_b_c_d.txt");
        assert_eq!(safe_file_name("a\"b.txt").unwrap(), "a_b.txt");
        // 控制字符（含 NUL——它能让 C 侧 API 提前截断）
        assert_eq!(safe_file_name("a\u{0}b\tc.txt").unwrap(), "a_b_c.txt");
    }

    #[test]
    fn windows保留名被前缀化() {
        assert_eq!(safe_file_name("CON").unwrap(), "_CON");
        assert_eq!(safe_file_name("nul").unwrap(), "_nul");
        assert_eq!(safe_file_name("NUL.txt").unwrap(), "_NUL.txt", "带扩展名同样是保留名");
        assert_eq!(safe_file_name("com1.log").unwrap(), "_com1.log");
        assert_eq!(safe_file_name("LPT9").unwrap(), "_LPT9");
        assert_eq!(safe_file_name("COM0").unwrap(), "_COM0");
        // 不是保留名的不能被误伤
        assert_eq!(safe_file_name("CONSOLE.txt").unwrap(), "CONSOLE.txt");
        assert_eq!(safe_file_name("com10.txt").unwrap(), "com10.txt");
        assert_eq!(safe_file_name("MYCON.txt").unwrap(), "MYCON.txt");
        assert_eq!(safe_file_name("a.com1.txt").unwrap(), "a.com1.txt", "主干是 a 不是 com1");
    }

    #[test]
    fn 超长名字被截断且保留扩展名() {
        let long = format!("{}.zip", "字".repeat(500));
        let out = safe_file_name(&long).unwrap();
        assert!(out.chars().count() <= MAX_COMPONENT);
        assert!(out.ends_with(".zip"), "扩展名要留住：{}", out);
        assert!(out.len() <= MAX_NAME_BYTES);

        // 单字节名字走字节口径
        let ascii = format!("{}.txt", "a".repeat(2000));
        let out = safe_file_name(&ascii).unwrap();
        assert!(out.chars().count() <= MAX_COMPONENT);
        assert!(out.ends_with(".txt"));
    }

    // ── 重名递增 ───────────────────────────────────────────────────────

    #[test]
    fn 重名递增不覆盖() {
        let taken = ["报告.zip", "报告 (1).zip"];
        let out = unique_name("报告.zip", |n| taken.contains(&n)).unwrap();
        assert_eq!(out, "报告 (2).zip");
        // 无冲突时原样返回
        assert_eq!(unique_name("新.zip", |_| false).unwrap(), "新.zip");
        // 没有扩展名
        assert_eq!(unique_name("README", |n| n == "README").unwrap(), "README (1)");
        // 隐藏文件（点开头）不会被拆成空主干
        assert_eq!(
            unique_name(".env", |n| n == ".env").unwrap(),
            ".env (1)"
        );
    }

    #[test]
    fn 重名递增不会撑爆长度() {
        let long = format!("{}.zip", "字".repeat(250));
        // 只占原名，让 (1) 候选可用
        let out = unique_name(&long, |n| n == long).unwrap();
        assert!(out.chars().count() <= MAX_COMPONENT, "{}", out.chars().count());
        // 🔴 后缀必须还在：曾经的实现是「先拼后缀再截断」，于是把 `(1)` 截掉了，
        //    候选等于原名 ⇒ 永远冲突 ⇒ 空转到上限报错（下面这条断言就是那个 bug 的守卫）。
        assert!(out.contains("(1)"), "递增后缀被截掉了：{}", out);
        assert!(out.ends_with(".zip"), "扩展名要留住：{}", out);
        // 长名字连续冲突也不能挂
        let out2 = unique_name(&long, |n| n == long || n.contains("(1)")).unwrap();
        assert!(out2.contains("(2)"), "{}", out2);
    }

    // ── 线格式 ─────────────────────────────────────────────────────────

    #[test]
    fn 头帧往返() {
        let h = FileHead::Push {
            v: VERSION,
            name: "报告.zip".into(),
            size: 12_345_678,
        };
        let b = encode_head(&h).unwrap();
        assert_eq!(decode_head(&b).unwrap(), h);
        assert!(String::from_utf8(b.clone()).unwrap().contains("\"t\":\"push\""));

        let p = FileHead::PullReq {
            v: VERSION,
            resume: vec![],
        };
        let b = encode_head(&p).unwrap();
        assert_eq!(decode_head(&b).unwrap(), p);
        let s = String::from_utf8(b.clone()).unwrap();
        assert!(s.contains("\"t\":\"pull_req\""));
        assert!(!s.contains("resume"), "空提示不上线：{}", s);
        // 旧/简写形态（无 resume）要能解
        assert_eq!(
            decode_head(br#"{"t":"pull_req","v":1}"#).unwrap(),
            FileHead::PullReq {
                v: VERSION,
                resume: vec![]
            }
        );

        // 续传提示往返
        let p2 = FileHead::PullReq {
            v: VERSION,
            resume: vec![ResumeHint {
                name: "素材.mp4".into(),
                offset: 123_456,
            }],
        };
        assert_eq!(decode_head(&encode_head(&p2).unwrap()).unwrap(), p2);
    }

    #[test]
    fn 头帧拒绝版本不符与超限() {
        let bad_v = br#"{"t":"push","v":9,"name":"a.txt","size":1}"#;
        let e = decode_head(bad_v).unwrap_err();
        assert_eq!(e.code, code::VERSION);

        let too_big = format!(
            r#"{{"t":"push","v":1,"name":"a.txt","size":{}}}"#,
            MAX_FILE_BYTES + 1
        );
        let e = decode_head(too_big.as_bytes()).unwrap_err();
        assert_eq!(e.code, code::SIZE_LIMIT);

        let bad_name = br#"{"t":"push","v":1,"name":"..","size":1}"#;
        let e = decode_head(bad_name).unwrap_err();
        assert_eq!(e.code, code::BAD_NAME);

        // 空 / 超长 / 垃圾
        assert_eq!(decode_head(b"").unwrap_err().code, code::BAD_HEAD);
        assert_eq!(decode_head(&vec![b'x'; MAX_HEAD_JSON + 1]).unwrap_err().code, code::BAD_HEAD);
        assert_eq!(decode_head(b"not json").unwrap_err().code, code::BAD_HEAD);
    }

    #[test]
    fn 续传提示越界被拒() {
        let too_many = FileHead::PullReq {
            v: VERSION,
            resume: (0..MAX_RESUME_HINTS + 1)
                .map(|i| ResumeHint {
                    name: format!("f{i}"),
                    offset: 1,
                })
                .collect(),
        };
        assert_eq!(encode_head(&too_many).unwrap_err().code, code::BAD_HEAD);

        let too_big = FileHead::PullReq {
            v: VERSION,
            resume: vec![ResumeHint {
                name: "a".into(),
                offset: MAX_FILE_BYTES + 1,
            }],
        };
        assert_eq!(encode_head(&too_big).unwrap_err().code, code::BAD_HEAD);

        // 正常几条要能过
        let ok = FileHead::PullReq {
            v: VERSION,
            resume: vec![ResumeHint {
                name: "a.bin".into(),
                offset: 7,
            }],
        };
        assert!(encode_head(&ok).is_ok());
    }

    #[test]
    fn 确认帧往返与缺字段() {
        let a = FileAck::Accept {
            name: None,
            size: None,
            offset: 0,
        };
        let b = encode_ack(&a).unwrap();
        let s = String::from_utf8(b.clone()).unwrap();
        assert!(!s.contains("offset"), "offset=0 时不上线（保持最小）");
        assert_eq!(decode_ack(&b).unwrap(), a);

        let r = FileAck::Accept {
            name: Some("a.bin".into()),
            size: Some(1024),
            offset: 512,
        };
        assert_eq!(decode_ack(&encode_ack(&r).unwrap()).unwrap(), r);

        let d = FileAck::Deny {
            reason: "不要".into(),
            code: Some(code::DENIED.into()),
        };
        assert_eq!(decode_ack(&encode_ack(&d).unwrap()).unwrap(), d);

        // 取回方向：对端没填 name/size ⇒ 落盘前就该拒（不能拿 None 去开文件）
        let incomplete: FileAck = decode_ack(br#"{"t":"accept","offset":0}"#).unwrap();
        match incomplete {
            FileAck::Accept { name, size, .. } => {
                let e = check_ack_accept(name.as_deref(), size).unwrap_err();
                assert_eq!(e.code, code::BAD_HEAD);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn 确认帧的尺寸同样夹住() {
        let e = check_ack_accept(Some("a.bin"), Some(MAX_FILE_BYTES + 1)).unwrap_err();
        assert_eq!(e.code, code::SIZE_LIMIT);
        // 名字也要过净化（取回方向由对端给名，是最容易被忽略的入口）
        let (clean, size) = check_ack_accept(Some("..\\..\\x.exe"), Some(9)).unwrap();
        assert_eq!(clean, "x.exe");
        assert_eq!(size, 9);
        let e = check_ack_accept(Some(".."), Some(9)).unwrap_err();
        assert_eq!(e.code, code::BAD_NAME);
    }

    #[test]
    fn 魔数识别() {
        assert!(is_magic(b"PPFIL1"));
        assert!(is_magic(b"PPFIL1xxxx"));
        assert!(!is_magic(b"PPAUD1"));
        assert!(!is_magic(b"PPFI"));
        assert!(!is_magic(b""));
    }

    #[test]
    fn part文件命名往返() {
        assert_eq!(part_path("报告.zip"), "报告.zip.pppart");
        assert_eq!(final_from_part("报告.zip.pppart"), Some("报告.zip"));
        assert_eq!(final_from_part("报告.zip"), None);
    }
}
