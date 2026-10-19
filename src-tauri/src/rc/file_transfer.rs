//! 文件传输的收发（G6 · B2）。
//!
//! 三层里的「网络与磁盘」层（判据在 `file_proto.rs`、状态在 `file_state.rs`）。
//!
//! 全部走独立 ALPN `rc-file/1`，**不依赖 RC 会话**——这是设计稿决策 1 的直接
//! 结果，也是「不接管屏幕也能传文件」（决策 8）天然成立的原因：发起端不需要
//! 先建会话。但门禁一样严（`enabled` + `has_remote_trust`）：**ALPN 是公开的，
//! 连得上 ≠ 有权限**。
//!
//! 两个方向共用同一对字节搬运函数（`send_bytes` / `recv_bytes`），区别只在
//! 谁先开口（决策 7 的派生纪律：不要写两条平行路径）：
//!
//! | 方向 | 发起侧 A 的 send 半流 | 接住侧 B 的 send 半流 |
//! |---|---|---|
//! | 推送 A→B | `PPFIL1` + `{push,name,size}`，然后字节 | `{accept,offset}` |
//! | 取回 B→A | `PPFIL1` + `{pull_req,resume}` | `{accept,name,size,offset}`，然后字节 |
//!
//! 🔴 **头写完必须等确认再灌字节**：不等的话对方拒绝时几 MB 已经塞进流控窗口，
//! 带宽白费，而且「拒绝」在用户看来没生效（设计稿 §4.2 纪律 1）。

use super::file_proto::{
    self, check_ack_accept, code, decode_ack, encode_ack, encode_head, final_from_part, part_path,
    safe_file_name, FileAck, FileHead, ResumeHint, MAX_FILE_BYTES, MAGIC,
};
use super::file_state::{AskKind, AskOutcome, AskReply, TaskDir, TaskState};
use super::protocol::FILE_ALPN;
use super::service::{now_ms, RcService};
use crate::sync::transport::{read_frame, write_frame};
use iroh::endpoint::{Connection, ConnectionError, RecvStream, SendStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// 分块 1 MiB。太小则 syscall 次数多、太大则进度条颗粒粗且取消迟钝。
const CHUNK: usize = 1024 * 1024;
/// 等对端开流。
const OPEN_STREAM_SECS: u64 = 10;
/// 等确认帧（含人工点确认条的 60s，留点网络余量）。
const ACK_WAIT_SECS: u64 = 75;
/// 传输中「没有进展」的判定。大文件慢慢传正常，卡住不动不正常。
const STALL_SECS: u64 = 30;
/// 等对端「已把这条流收完并落盘」的收尾信号（见 [`wait_peer_stream_end`]）。
///
/// 起点是**我方已经写完最后一个字节**，剩下的只是对方读完缓冲 + 刷盘 + 改名，
/// 15s 对慢盘 / 杀软扫描足够。超时不判失败，只是不再等（见该函数的口径）。
const RECEIPT_WAIT_SECS: u64 = 15;

/// 一次字节搬运的结局。
///
/// **分档而不是塌缩成「失败」**：用户与排查都需要知道是断了、停了、还是自己取消的。
#[derive(Debug)]
enum TxOutcome {
    Done,
    Canceled,
    /// 对端 30s 没动静。
    Stalled,
    /// 对端提前关了流（数据没发完）。
    RemoteClosed,
    Io(String),
}

impl TxOutcome {
    fn finish(&self, got: u64, size: u64) -> (TaskState, Option<String>) {
        match self {
            // P1-5: Done must mean the on-disk byte count matches the declared
            // size. Trusting plan.offset alone produced short-file "Done".
            TxOutcome::Done => {
                if got == size {
                    (TaskState::Done, None)
                } else {
                    (
                        TaskState::Failed,
                        Some(format!("完成态字节数不一致：{got}/{size}")),
                    )
                }
            }
            TxOutcome::Canceled => (TaskState::Canceled, None),
            TxOutcome::Stalled => (
                TaskState::Failed,
                Some(format!("传输中断：{} 秒没有数据往来", STALL_SECS)),
            ),
            TxOutcome::RemoteClosed => (
                TaskState::Failed,
                Some(format!("对端提前结束（已传 {} / {}）", got, size)),
            ),
            TxOutcome::Io(e) => (TaskState::Failed, Some(e.clone())),
        }
    }
}

/// 落点规划（重名递增 + `.pppart` + 续传偏移）。
struct RecvPlan {
    final_name: String,
    part: PathBuf,
    #[allow(dead_code)] // 展示用绝对路径；收尾改名按 dir+final_name 重算
    final_path: PathBuf,
    offset: u64,
    /// `FileState` 里的 part 槽名（传输结束必须 `release_part`）。
    part_key: String,
}

/// part 槽 RAII：收/失败/取消路径统一释放，不靠每条分支手写。
struct PartSlotGuard<'a> {
    file: &'a super::file_state::FileState,
    key: String,
}

impl Drop for PartSlotGuard<'_> {
    fn drop(&mut self) {
        self.file.release_part(&self.key);
    }
}

/// peer 占位 RAII（P2-6）：handle_file_conn 返回时释放。
struct PeerSlotGuard<'a> {
    file: &'a super::file_state::FileState,
    peer: String,
}

impl Drop for PeerSlotGuard<'_> {
    fn drop(&mut self) {
        self.file.release_peer(&self.peer);
    }
}


/// 把文件从 `offset` 起灌进流。返回 (结局, 已发字节数)。
async fn send_bytes(
    svc: &Arc<RcService>,
    send: &mut SendStream,
    path: &Path,
    size: u64,
    offset: u64,
    task_id: &str,
) -> (TxOutcome, u64) {
    let mut f = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => return (TxOutcome::Io(format!("打开源文件失败：{e}")), offset),
    };
    if offset > 0 {
        if let Err(e) = f.seek(std::io::SeekFrom::Start(offset)).await {
            return (TxOutcome::Io(format!("定位断点失败：{e}")), offset);
        }
    }
    let mut buf = vec![0u8; CHUNK];
    let mut sent = offset;
    while sent < size {
        if !svc.file.is_running(task_id) {
            let _ = send.finish();
            return (TxOutcome::Canceled, sent);
        }
        let want = ((size - sent) as usize).min(CHUNK);
        let n = match f.read(&mut buf[..want]).await {
            Ok(0) => {
                return (
                    TxOutcome::Io("源文件在传输中被改短了".into()),
                    sent,
                )
            }
            Ok(n) => n,
            Err(e) => return (TxOutcome::Io(format!("读源文件失败：{e}")), sent),
        };
        // write 会被 QUIC 流控压住（对端跟不上），所以也要有 stall 判据
        match tokio::time::timeout(Duration::from_secs(STALL_SECS), send.write_all(&buf[..n])).await
        {
            Err(_) => return (TxOutcome::Stalled, sent),
            Ok(Err(e)) => {
                return (
                    TxOutcome::Io(format!("写流出错（对端可能已断开）：{e}")),
                    sent,
                )
            }
            Ok(Ok(())) => {}
        }
        sent += n as u64;
        if svc.file.task_progress(task_id, sent, now_ms()) {
            svc.emit_file_state();
        }
    }
    if send.finish().is_err() {
        return (TxOutcome::Io("关闭发送流失败".into()), sent);
    }
    (TxOutcome::Done, sent)
}

/// 把流里的字节写到 `plan.part`，收满后以**绝不覆盖**的方式改成最终名。
async fn recv_bytes(
    svc: &Arc<RcService>,
    recv: &mut RecvStream,
    plan: &RecvPlan,
    size: u64,
    task_id: &str,
) -> (TxOutcome, u64) {
    let mut f = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&plan.part)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            return (
                TxOutcome::Io(format!("打开落盘文件失败（{}）：{e}", plan.part.display())),
                plan.offset,
            )
        }
    };
    // P1-5: never trust plan.offset alone. If the on-disk part length disagrees,
    // starting from that offset produces a short/corrupt file that still renames
    // to Done. Offset 0 + leftover tail -> truncate and take the full stream.
    // Negotiated resume offset + mismatch -> abort (sender is mid-file; we cannot
    // rewind without a new handshake).
    let actual = match f.metadata().await {
        Ok(m) => m.len(),
        Err(e) => {
            return (
                TxOutcome::Io(format!("读落盘文件长度失败：{e}")),
                plan.offset,
            )
        }
    };
    let mut got = plan.offset;
    if actual != plan.offset {
        if plan.offset == 0 {
            if let Err(e) = f.set_len(0).await {
                return (TxOutcome::Io(format!("清空落盘残余失败：{e}")), 0);
            }
            got = 0;
        } else {
            return (
                TxOutcome::Io(format!(
                    "续传偏移与磁盘长度不一致（声明 {}，实际 {}），请重试",
                    plan.offset, actual
                )),
                0,
            );
        }
    }
    let mut buf = vec![0u8; CHUNK];
    while got < size {
        if !svc.file.is_running(task_id) {
            // 主动取消：**保留 `.pppart`**，下次可续（设计稿 11.4 白送的暂停/恢复）
            let _ = f.flush().await;
            return (TxOutcome::Canceled, got);
        }
        let want = ((size - got) as usize).min(CHUNK);
        let n = match tokio::time::timeout(Duration::from_secs(STALL_SECS), recv.read(&mut buf[..want]))
            .await
        {
            Err(_) => {
                let _ = f.flush().await;
                return (TxOutcome::Stalled, got);
            }
            Ok(Ok(Some(0))) | Ok(Ok(None)) => {
                let _ = f.flush().await;
                return (TxOutcome::RemoteClosed, got);
            }
            Ok(Ok(Some(n))) => n,
            Ok(Err(e)) => {
                let _ = f.flush().await;
                return (TxOutcome::Io(format!("读流出错：{e}")), got);
            }
        };
        if let Err(e) = f.write_all(&buf[..n]).await {
            // C6：不猜原因——OS 错误串里本来就有「磁盘已满」这类信息，
            // 括号里问一句「磁盘满？」反而把真实原因埋了。
            return (TxOutcome::Io(format!("写盘失败：{e}")), got);
        }
        got += n as u64;
        if svc.file.task_progress(task_id, got, now_ms()) {
            svc.emit_file_state();
        }
    }
    if let Err(e) = f.flush().await {
        return (TxOutcome::Io(format!("落盘失败：{e}")), got);
    }
    drop(f);
    // P1-5: assert real on-disk length before claiming Done / renaming.
    let final_len = match std::fs::metadata(&plan.part) {
        Ok(m) => m.len(),
        Err(e) => return (TxOutcome::Io(format!("收尾读长度失败：{e}")), got),
    };
    if got != size || final_len != size {
        return (
            TxOutcome::Io(format!(
                "落盘长度与声明大小不一致（got={got}, disk={final_len}, size={size}）"
            )),
            got,
        );
    }
    // P1-4: rename must never clobber an existing final file. Windows
    // std::fs::rename uses MOVEFILE_REPLACE_EXISTING — hard_link fails if dest
    // exists, then drop the part name. Same-dir = same volume = hard_link ok.
    let dir = plan
        .part
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    match finalize_recv_name(&plan.part, &dir, &plan.final_name) {
        Ok(_final_name) => (TxOutcome::Done, got),
        Err(e) => (TxOutcome::Io(e), got),
    }
}

/// Claim the final name without overwriting. On conflict, bump the name and retry.
/// `dir` is the receive directory used to re-check disk occupancy.
fn finalize_recv_name(
    part: &Path,
    dir: &Path,
    preferred: &str,
) -> Result<String, String> {
    let mut name = preferred.to_string();
    let mut tried: Vec<String> = vec![name.clone()];
    for _ in 0..32 {
        let dest = extend_long_path(dir.join(&name));
        match rename_no_overwrite(part, &dest) {
            Ok(()) => return Ok(name),
            Err(e) if is_name_conflict(&e) => {
                name = file_proto::unique_name(preferred, |n| {
                    tried.iter().any(|t| t == n) || dir.join(n).exists()
                })?;
                tried.push(name.clone());
            }
            Err(e) => return Err(format!("改名失败：{e}")),
        }
    }
    Err("同名文件过多，无法为收尾腾出空位".into())
}

fn is_name_conflict(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
    ) || e.raw_os_error() == Some(183) /* ERROR_ALREADY_EXISTS */
}

/// 收尾改名：**绝不覆盖**已有最终文件。
///
/// Windows 的 `std::fs::rename` 走 `MOVEFILE_REPLACE_EXISTING`，目标存在会被
/// 静默替换。`hard_link` 在目标存在时失败；同目录 = 同卷，必可 hard_link。
///
/// 🔴 P3-16（2026-09-25 审计）：`hard_link` 成功后删 `.pppart` **失败**（最常见
/// 是杀软 / 索引器短暂锁住文件）不得把整个任务打成 `Failed`——此时最终文件
/// 已经完整落盘，报失败会引诱用户重试，而重试会在续传判据下落成 `(1)` 重复
/// 文件。这里降级为 `log::warn` 并照常报成功。
///
/// 残余 `.pppart` 的无害性与清理时机：数据与最终文件**同一体**（hard_link），
/// 不占双份内容只是多一个目录项；下一次同名传输的 `prepare_recv` 会按续传
/// 判据处理它（长度超出声明即删），用户手动清理也无任何副作用。
fn rename_no_overwrite(part: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::hard_link(part, dest)?;
    if let Err(e) = std::fs::remove_file(part) {
        // 交付物已存在，失败只影响目录整洁，不影响正确性（P3-16）。
        log::warn!(
            "[RC] 交付完成但清理 .pppart 失败（可能被杀软短暂锁定，无害，下次同名传输会按续传判据处理）：{e}"
        );
    }
    Ok(())
}

// ── 落点与目录 ──────────────────────────────────────────────────────────

/// 定下落点：重名递增（绝不覆盖）、`.pppart`、续传偏移。
///
/// 续传判据（设计稿决策 9）：`<name>.pppart` 存在**且**长度 ≤ `size` ⇒ 续；
/// 否则删掉旧的从头来。`Last-Modified` 不参与判断——FAT/exFAT 精度不够，
/// 比了反而误判。
/// Windows 长路径兜底（C6）：落盘路径逼近 MAX_PATH(260) 时加 `\\?\` 前缀，
/// 让 NT 命名空间接管（实际上限 32767）。触发场景：深层接收目录 + 长文件名。
/// 已带扩展前缀的、不够长的原样返回；UNC 走 `\\?\UNC\` 变体。
#[cfg(target_os = "windows")]
fn extend_long_path(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if s.len() < 240 || s.starts_with(r"\\?\") {
        return p;
    }
    let abs = if p.is_absolute() {
        p
    } else {
        match std::env::current_dir() {
            Ok(c) => c.join(&p),
            Err(_) => return p,
        }
    };
    let abs_s = abs.to_string_lossy().replace('/', r"\");
    if let Some(rest) = abs_s.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{rest}"));
    }
    PathBuf::from(format!(r"\\?\{abs_s}"))
}

#[cfg(not(target_os = "windows"))]
fn extend_long_path(p: PathBuf) -> PathBuf {
    p
}

fn prepare_recv(
    dir: &Path,
    name: &str,
    size: u64,
    file: &super::file_state::FileState,
) -> Result<RecvPlan, String> {
    if !dir.is_dir() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("建目录失败（{}）：{}", dir.display(), e))?;
    }
    // P1-4: final name OR its .pppart counts as taken (on disk or reserved).
    let mut local_taken: Vec<String> = Vec::new();
    let final_name = loop {
        let candidate = file_proto::unique_name(name, |n| {
            file_proto::name_or_part_taken(n, |p| dir.join(p).exists())
                || file.part_reserved(file_proto::part_path(n).as_str())
                || local_taken.iter().any(|t| t == n)
        })?;
        let key = file_proto::part_path(&candidate);
        if file.try_reserve_part(&key) {
            break candidate;
        }
        local_taken.push(candidate);
    };
    // fs 操作（append / rename / remove）走前缀化路径；给前端展示 /
    // 「打开所在文件夹」的路径保持原样（explorer 不认 `\\?\` 形态）。
    let final_path = extend_long_path(dir.join(&final_name));
    let part = extend_long_path(dir.join(part_path(&final_name)));
    let part_key = part_path(&final_name);
    let offset = match std::fs::metadata(&part) {
        Ok(m) if m.is_file() => {
            let len = m.len();
            if len <= size {
                len
            } else {
                // part 比声明的还大 ⇒ 是另一个文件留下的，删掉重来
                let _ = std::fs::remove_file(&part);
                0
            }
        }
        Ok(_) => {
            file.release_part(&part_key);
            return Err("落点上有个同名的目录，写不进去".to_string());
        }
        Err(_) => 0,
    };
    Ok(RecvPlan {
        final_name,
        part,
        final_path,
        offset,
        part_key,
    })
}

/// 扫目标目录里的 `.pppart`，供取回方向告诉对方「我这儿已经有什么」。
fn resume_hints(dir: &Path) -> Vec<ResumeHint> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if out.len() >= file_proto::MAX_RESUME_HINTS {
            break;
        }
        let raw = e.file_name().to_string_lossy().to_string();
        let Some(final_name) = final_from_part(&raw) else {
            continue;
        };
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() {
            continue;
        }
        out.push(ResumeHint {
            name: final_name.to_string(),
            offset: m.len(),
        });
    }
    // 🔴 B7（2026-09-25 审计）：发送侧按**编码后总长**自检。逐条查名字长度
    // 的旧口径放得过「长中文名 ×8」，接收侧按总长拒收 → 整次取回失败。
    // 收口在 file_proto::clamp_resume_hints（hints 的唯一生产者就是这里）。
    file_proto::clamp_resume_hints(out)
}

/// 默认接收目录：桌面在系统下载目录下；Android 在系统提供的应用下载目录下。
///
/// 🔴 桌面**不能拼 `~/Downloads`**：中文系统那个目录叫「下载」，而且用户可能把
/// 整个下载目录重定向到别的盘。所以要问系统（`SHGetKnownFolderPath`），不能猜。
/// 系统不认（罕见）时退回 `~/Downloads`——宁可落到一个不太准的默认值，
/// 也不能没有默认值。Android 只取 setup 缓存的系统路径，失败时明确报错，不猜目录。
pub fn default_receive_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        return ANDROID_RECEIVE_DIR
            .get()
            .cloned()
            .ok_or_else(|| "手机接收位置尚未准备好，请重新打开 PastePanda 后重试".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "windows")]
        let base = known_downloads_dir();
        #[cfg(not(target_os = "windows"))]
        let base = None;
        let base = match base {
            Some(d) => d,
            None => crate::user_paths::home_dir()?.join("Downloads"),
        };
        Ok(base.join("PastePanda 接收"))
    }
}

#[cfg(target_os = "android")]
static ANDROID_RECEIVE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Android 11+ 的应用外部目录必须由系统创建；自行拼路径再 mkdir 可能被拒绝。
/// setup 传入 PathResolver::download_dir()，它调用 getExternalFilesDir(DIRECTORY_DOWNLOADS)。
#[cfg(target_os = "android")]
pub fn init_android_receive_dir(system_downloads: PathBuf) {
    let _ = ANDROID_RECEIVE_DIR.set(system_downloads.join("PastePanda 接收"));
}

/// 生效的接收目录 = 用户在设置里配置的覆盖目录，未配置回落 [`default_receive_dir`]。
///
/// 🔴 2026-09-27（用户拍板：push 接受不再每次弹目录选择框）：所有「文件落到哪」
/// 的取值口（`rc_file_default_dir` 命令、`auto_accept_dir`）都必须走这里——
/// 若有第 3 处直接调 `default_receive_dir`，「这次落哪儿」和「设置说落哪儿」
/// 就会分叉。写入口只有 `commands::rc_file::rc_file_receive_dir_set`。
pub fn effective_receive_dir(config: &serde_json::Value) -> Result<PathBuf, String> {
    let override_dir = config
        .get("rc_file_receive_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match override_dir {
        Some(d) => {
            let p = std::path::PathBuf::from(d);
            // 目录可能被用户在资源管理器里删掉：落盘前补建，失败才回落默认
            if std::fs::create_dir_all(&p).is_ok() {
                Ok(p)
            } else {
                log::warn!("[RC] 配置的接收目录不可用（{d}），回落默认接收目录");
                default_receive_dir()
            }
        }
        None => default_receive_dir(),
    }
}

#[cfg(target_os = "windows")]
fn known_downloads_dir() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    // SAFETY: 返回的 PWSTR 由系统用 CoTaskMemAlloc 分配，取走字符串后立刻释放；
    // 中间不做任何可能 panic 的操作（`.ok()?` 失败时提前返回，会漏一次释放——
    // 代价是几十字节，换的是不在这里写 unsafe 的 drop guard）。
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
        s.map(PathBuf::from).filter(|d| !d.as_os_str().is_empty())
    }
}

// ── 小工具 ──────────────────────────────────────────────────────────────

/// 读尽对端那一半 bi-stream 直到 FIN —— 这是「对方已经拿到全部字节」的**应用层**凭据。
///
/// 🔴 为什么非要有它：`SendStream::finish()` 只把「流结束」排进发送队列，不等任何
/// 确认；`Connection::close()` 走的是 RFC 9000 §10.2 的**立即关闭**——连接进了
/// closed 状态后只再发一个 CONNECTION_CLOSE 帧，**发送队列里还没发出去的 STREAM
/// 帧连同整条重传队列一起作废**。对端能读到的只是已经落地的那几个包，之后就是
/// `connection lost`。于是「发完就 close(0, "done")」等于把文件尾巴扔进黑洞：
/// 2026-10-11 真机日志里一批两个文件，第 1 个（3.5 MB）`已接收`、第 2 个（45 KB）
/// 报 `接收 rc.log.1 未完成：读流出错：connection lost（closed by peer: done (code 0)）`。
/// 第 1 个之所以活下来，推测正是因为它后面还跟着「开第 2 条流 + 等对方回确认」两个
/// 往返，那些 RTT 恰好够它的尾巴送达；第 2 个后面什么都没有，写完就关。
/// noq 没有 `SendStream::closed()` 这类传输层 flush 可等（只有 `stopped()`，语义是
/// 「对方要求我别发了」，不是「对方收到了」），所以只能靠应用层信号。
///
/// 信号本身不需要新加协议字段：两条方向的**读方**都会 `finish()` 自己的半流
/// （推送侧见 `serve_push` 收尾，取回侧见 `run_pull_inner` 收尾），写方等到 FIN
/// 才允许关连接。对端是旧版、不发这个 FIN 时它也不会干等——旧版一 close 连接，
/// 这里的 `read` 立刻报错返回 `false`。
///
/// 返回 `true` = 看到对端 FIN（对方确认收完）；`false` = 超时或连接已断。
/// **`false` 不是失败判据**：调用方照常收尾，只是不能再声称对方已收全（打 warn）。
/// 把成功打成失败会让旧版对端每次传输都「报错但其实成功」。
async fn wait_peer_stream_end(recv: &mut RecvStream) -> bool {
    // 对端半流上只有确认帧，且已被 read_frame 精确取走；这里读到的是收尾 FIN。
    // 万一将来对端在这半流上追加字节，读掉即可——不能因为多读了就判失败。
    let mut buf = [0u8; 64];
    let drained = async {
        loop {
            match recv.read(&mut buf).await {
                Ok(Some(0)) | Ok(None) => return true,
                Ok(Some(_)) => continue,
                Err(_) => return false,
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(RECEIPT_WAIT_SECS), drained).await.unwrap_or(false)
}

/// 对端是不是用「批次收尾」的理由（code 0 / `done`）主动关掉了连接。
///
/// 这正是 [`wait_peer_stream_end`] 文档里那个旧版发送端 bug 的现场指纹：
/// 旧版发完 `finish()` 就立刻 `close(0, "done")`，收方读流必然截断且关连接
/// 理由是 `done`。网络故障、对端崩溃、被门禁拒（`bad_head`）等走的是别的
/// 理由 / 错误码，不会落进这个档。
fn peer_closed_batch_end(conn: &Connection) -> bool {
    match conn.close_reason() {
        Some(ConnectionError::ApplicationClosed(c)) => {
            c.error_code == 0u32.into() && &c.reason[..] == b"done"
        }
        _ => false,
    }
}

/// 收方读流失败时的人话收口（`serve_push` / `run_pull` 两处收尾共用）。
///
/// 截断 + 对端用批次收尾理由主动关连接 = 旧版发送端「发完即关」的已知问题
/// （或对方取消了发送），不是网络故障。照抄 [`crate::rc::service::explain`]
/// 的「读流出错：connection lost（closed by peer: done (code 0)）」会把用户
/// 引去查网络、查路由器；人话档必须给出可执行的出路。
fn explain_recv_err(conn: &Connection, e: String) -> String {
    if peer_closed_batch_end(conn) {
        return "对方在文件传完之前主动断开了连接，文件不完整——通常是对方版本较旧（发完即断的已知问题）或对方取消了发送；断点已保留，对方重发可自动续传"
            .into();
    }
    crate::rc::service::explain(conn, e)
}

/// 抢一个确认帧 / 魔数，带超时（`read_frame` 内部有自己的 stall 判据，
/// 这个用于固定长度的裸读）。
async fn recv_exact(r: &mut RecvStream, buf: &mut [u8]) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(OPEN_STREAM_SECS), r.read_exact(buf))
        .await
        .map_err(|_| "等对端数据超时".to_string())?
        .map_err(|e| format!("读流出错：{e}"))
}

/// 拒绝一条文件请求：回 `deny` 帧并结束**本条 bi-stream**。
///
/// P2-5: do **not** close the whole connection — a multi-file batch must keep
/// going after one file is denied. The sender closes the connection when the
/// batch ends. Single-file callers close on their own exit path.
async fn deny_file(send: &mut SendStream, reason: &str, c: &str) {
    let ack = FileAck::Deny {
        reason: reason.to_string(),
        code: Some(c.to_string()),
    };
    if let Ok(bytes) = encode_ack(&ack) {
        let _ = write_frame(send, &bytes).await;
    }
    let _ = send.finish();
}

// impl RcService 的文件传输方法按发起/批传/接收三组平移到子模块。
mod api;
mod transfer;
mod serve;

#[cfg(test)]
mod tests;
