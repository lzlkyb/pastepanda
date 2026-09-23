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
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{EndpointAddr, EndpointId};
use std::path::{Path, PathBuf};
use std::str::FromStr;
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
fn rename_no_overwrite(part: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::hard_link(part, dest)?;
    std::fs::remove_file(part)?;
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
    out
}

/// 默认接收目录：`<下载>/PastePanda 接收/`。
///
/// 🔴 **不能拼 `~/Downloads`**：中文系统那个目录叫「下载」，而且用户可能把整个
/// 下载目录重定向到别的盘。所以要问系统（`SHGetKnownFolderPath`），不能猜。
/// 系统不认（罕见）时退回 `~/Downloads`——宁可落到一个不太准的默认值，
/// 也不能没有默认值。
pub fn default_receive_dir() -> Result<PathBuf, String> {
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