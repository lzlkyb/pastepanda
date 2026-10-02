//! 远程电脑 · 文件传输命令（G6 · B3）。
//!
//! 刻意**不放 `commands/rc.rs`**：那个文件已经 1300 行，再塞会把「找一条 rc 命令」
//! 变成翻巨人肩膀。与 `commands/rc_pair.rs` 的分法一致。
//!
//! 命令本身只做「参数转换 + 转调服务层」——所有判据都在 `rc/file_proto.rs`
//! （协议）、`rc/file_state.rs`（状态）、`rc/file_transfer.rs`（收发）。

use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::data_store::DataStore;
use crate::rc::file_state::FileSnapshot;
use crate::rc::service::RcService;

/// 把本机文件发给对端。可多选，**串行**传（弱网下并发文件互挤，总时长反而更长）。
///
/// 返回成功只代表「已受理」：不合法的文件在这一步就被拒（同步做完），
/// 真正的传输在后台跑，进度经 `rc-file-state` 事件回传。
#[tauri::command]
pub async fn rc_file_send(
    svc: State<'_, Arc<RcService>>,
    peer: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    svc.file_send(&peer, paths).await
}

/// 向对端要文件，落到 `dir`。
///
/// ❗ `dir` 必须在调用**之前**由用户选好：对方一接受就会开始灌字节，
/// 没有「先请求再选目录」这种顺序（设计稿 11.2 的注意事项 1）。
#[tauri::command]
pub async fn rc_file_pull(
    svc: State<'_, Arc<RcService>>,
    peer: String,
    dir: String,
) -> Result<(), String> {
    svc.file_pull(&peer, PathBuf::from(dir)).await
}

/// 用户在确认条上回应：`accept_dir` 有值 = 接受（推送方向是落盘目录、
/// 取回方向是要发送的文件路径）；`None` = 拒绝。
#[tauri::command]
pub fn rc_file_respond(
    svc: State<'_, Arc<RcService>>,
    ask_id: String,
    accept_dir: Option<String>,
) -> Result<(), String> {
    svc.file_respond(&ask_id, accept_dir.map(PathBuf::from))
}

/// 取消一条进行中的任务（收侧保留 `.pppart`，下次可续）。
#[tauri::command]
pub fn rc_file_cancel(svc: State<'_, Arc<RcService>>, task_id: String) {
    svc.file_cancel(&task_id);
}

/// 清掉已结束的任务（前端「清空」按钮）。
#[tauri::command]
pub fn rc_file_clear_finished(svc: State<'_, Arc<RcService>>, peer: Option<String>) {
    svc.file_clear_finished(peer.as_deref());
}

/// 文件状态快照。前端首次挂载取一次；之后靠 `rc-file-state` 事件
/// （**同一个形状**，见 `file_state::FileSnapshot`）。
#[tauri::command]
pub fn rc_file_snapshot(svc: State<'_, Arc<RcService>>) -> FileSnapshot {
    svc.file_snapshot()
}

/// 接收目录（用户在设置里配置的覆盖目录；未配置 = `<下载>/PastePanda 接收/`）。
///
/// 由 Rust 给而不是前端拼：中文系统的下载目录叫「下载」，且可能被用户
/// 重定向到别的盘——只有 `SHGetKnownFolderPath` 知道真实位置。
/// 2026-09-27：push 接受不再每次弹目录选择框（用户拍板：默认落 + 设置可改），
/// 本命令成为「落点」的唯一取值口；`rc_file_receive_dir_set` 是唯一写入口。
#[tauri::command]
pub fn rc_file_default_dir(store: State<'_, DataStore>) -> Result<String, String> {
    let config = store.get_config()?;
    crate::rc::file_transfer::effective_receive_dir(&config)
        .map(|p| p.to_string_lossy().to_string())
}

/// 设置文件接收目录（空串 = 恢复默认 `<下载>/PastePanda 接收/`）。
///
/// 保存前就创建目录：设置那一刻就暴露「盘符不存在」这类问题，
/// 别等第一场传输落盘才炸。
#[tauri::command]
pub fn rc_file_receive_dir_set(store: State<'_, DataStore>, dir: String) -> Result<String, String> {
    let trimmed = dir.trim().to_string();
    let effective = if trimmed.is_empty() {
        crate::rc::file_transfer::default_receive_dir()?
    } else {
        let p = std::path::PathBuf::from(&trimmed);
        if !p.is_absolute() {
            return Err("接收目录必须是绝对路径".into());
        }
        std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败：{e}"))?;
        p
    };
    let mut config = store.get_config()?;
    let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
    obj.insert(
        "rc_file_receive_dir".to_string(),
        serde_json::Value::String(if trimmed.is_empty() {
            String::new()
        } else {
            effective.to_string_lossy().to_string()
        }),
    );
    store.save_config(&config)?;
    Ok(effective.to_string_lossy().to_string())
}

// ── 手机端发文件（2026-10-01，P1.6）─────────────────────────────────────
//
// Android 系统选择器（tauri-plugin-dialog）给的是 `content://` 虚拟 URI，
// `std::fs` 读不了；但 WebView 的 `<input type="file">` 经 wry 的
// `onShowFileChooser` 拿得到文件**内容**。所以手机端的发送路径是：
//
//   前端按块（4MB）读文件 → `invoke("rc_file_send_blob", chunk, { headers })`
//   → 本命令把块写进暂存目录 → 最后一块到位时校验总长并转给既有
//   `file_send`（同一套信任门 / 确认条 / 传输协议）。
//
// 分块而不是整个文件一次上载：WebView 里一个 512MB 的 ArrayBuffer 就能把
// 渲染进程顶爆，4MB 的块对任何手机都是零压力。元数据（peer / 文件名 /
// 总长 / 偏移）走自定义 header——header 只认 ASCII，文件名必须先
// `encodeURIComponent`，这里解码。

/// 单块上限。前端按 4MB 切，这里放宽到 16MB 留余地；超了就是前端发疯。
const BLOB_CHUNK_MAX: usize = 16 * 1024 * 1024;

/// 暂存目录：`<临时目录>/pastePanda-send/`。
///
/// ❗ 暂存文件喂给 `file_send` 后**不能立刻删**——真正的传输在后台跑，
/// 现在删了流就读空。目录靠 [`prune_send_spool`] 兜底清理。
fn send_spool_dir() -> PathBuf {
    std::env::temp_dir().join("pastePanda-send")
}

/// 暂存目录只留 24 小时内的文件（正常流转完几分钟内就该被读走；
/// 留一天是给「传输挂了半天」的极端情况留证据）。
const SPOOL_KEEP_MS: u128 = 24 * 60 * 60 * 1000;

/// 清理超龄的暂存文件。每次发送的**第一块**顺带跑一次（无需启动钩子，
/// 也避免每块都扫目录）。出错只记日志——清理失败不该挡用户发送。
fn prune_send_spool() {
    let dir = send_spool_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let ok = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_millis() > SPOOL_KEEP_MS);
        if ok {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// header 取值（不存在或非 ASCII 视为缺失，由调用方报人话错误）。
fn header_str<'r>(request: &'r tauri::ipc::Request<'_>, name: &str) -> Option<&'r str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// percent-decode（`encodeURIComponent` 的逆）。收口在本地而不是引
/// `percent-encoding` 依赖：只此一处用，解码规则就几行，值得带测试自带。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 一块写入暂存文件。返回本块落盘的路径（同一 `upload_id` 的所有块必然相同——
/// 🔴 路径前缀**不能**用「当前时间」：跨毫秒的块会散落到两个文件里，传输悄悄发空）。
///
/// 校验（都在纯函数里，测试直接打这里）：
/// - 偏移必须落在总长内；最后一块必须**恰好**补齐总长；
/// - 名字过 [`safe_file_name`]（路径跳转 / RTLO / 非法字符都在那一层拦）。
fn write_blob_chunk(
    dir: &std::path::Path,
    upload_id: &str,
    name: &str,
    total: u64,
    offset: u64,
    last: bool,
    chunk: &[u8],
) -> Result<PathBuf, String> {
    if chunk.len() > BLOB_CHUNK_MAX {
        return Err(format!("单块超过 {} MB", BLOB_CHUNK_MAX / 1024 / 1024));
    }
    // upload_id 是路径组件，前端给什么都不能全信：只放行 UUID 的字符集
    if upload_id.is_empty()
        || !upload_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("上传标识不合法".into());
    }
    let safe = crate::rc::file_proto::safe_file_name(name)?;
    // 协议上限同源：file_send 那一步还会再查一次，这里提前给人话
    if total > crate::rc::file_proto::MAX_FILE_BYTES {
        return Err(format!(
            "文件超过 {} GiB 上限",
            crate::rc::file_proto::MAX_FILE_BYTES / 1024 / 1024 / 1024
        ));
    }
    // 偏移必须落在总长内；total=0 的空文件只允许 offset=0
    if offset >= total.max(1) {
        return Err(format!("偏移 {offset} 超出文件总长 {total}"));
    }
    if offset.saturating_add(chunk.len() as u64) > total {
        return Err("分块总量超过声明的文件大小".into());
    }
    if last && offset.saturating_add(chunk.len() as u64) != total {
        return Err(format!(
            "最后一块应补齐到 {total} 字节，实际到 {}",
            offset + chunk.len() as u64
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("暂存目录建不出来：{e}"))?;
    let path = dir.join(format!("{upload_id}-{safe}"));
    use std::io::{Seek, SeekFrom, Write};
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("暂存文件打开失败：{e}"))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("暂存文件定位失败：{e}"))?;
    f.write_all(chunk).map_err(|e| format!("暂存写入失败：{e}"))?;
    if last {
        let meta = f.metadata().map_err(|e| format!("暂存文件读长失败：{e}"))?;
        if meta.len() != total {
            return Err(format!("落盘长度 {} 与声明 {total} 不一致", meta.len()));
        }
    }
    Ok(path)
}

/// 手机端发文件（分块上载）。
///
/// 每块一次 invoke；`last=true` 的那块落盘后转给既有 `file_send`，
/// 之后的一切（信任门、对方确认条、传输、进度事件）与桌面发送完全同一条路。
#[tauri::command]
pub async fn rc_file_send_blob(
    svc: State<'_, Arc<RcService>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let peer = header_str(&request, "x-pp-peer")
        .filter(|s| !s.is_empty())
        .ok_or("缺少目标设备（x-pp-peer）")?
        .to_string();
    let upload_id = header_str(&request, "x-pp-id")
        .filter(|s| !s.is_empty())
        .ok_or("缺少上传标识（x-pp-id）")?
        .to_string();
    let name_raw = header_str(&request, "x-pp-name").ok_or("缺少文件名（x-pp-name）")?;
    let name = percent_decode(name_raw);
    let total: u64 = header_str(&request, "x-pp-total")
        .ok_or("缺少总长（x-pp-total）")?
        .parse()
        .map_err(|_| "总长不是数字")?;
    let offset: u64 = header_str(&request, "x-pp-offset")
        .ok_or("缺少偏移（x-pp-offset）")?
        .parse()
        .map_err(|_| "偏移不是数字")?;
    let last = header_str(&request, "x-pp-last").is_some_and(|v| v == "1");
    let chunk = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("需要二进制载荷（body 应为 ArrayBuffer）".into()),
    };

    // 第一块顺带清理超龄暂存（本命令是这条路的唯一入口）
    if offset == 0 {
        prune_send_spool();
    }
    let path = write_blob_chunk(&send_spool_dir(), &upload_id, &name, total, offset, last, chunk)?;
    if !last {
        return Ok(());
    }
    svc.file_send(&peer, vec![path]).await
}

#[cfg(test)]
mod blob_tests {
    use super::*;

    #[test]
    fn percent_decode_中文与普通字符() {
        assert_eq!(percent_decode("%E6%8A%A5%E5%91%8A.pdf"), "报告.pdf");
        assert_eq!(percent_decode("a.pdf"), "a.pdf");
        // 半个 % 序列不是编码：原样保留（攻击者喂垃圾不欠他解释）
        assert_eq!(percent_decode("100%off"), "100%off");
        assert_eq!(percent_decode("%GG"), "%GG");
        // + 不是空格（那是 form 编码；encodeURIComponent 不转 +）
        assert_eq!(percent_decode("a+b.pdf"), "a+b.pdf");
    }

    #[test]
    fn 分块组装_同id同路径_最后一块补齐() {
        let dir = std::env::temp_dir().join(format!("pp-blob-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let payload: Vec<u8> = (0u8..=200).collect();
        let (a, b, c) = (0u64, 100u64, 150u64);
        let p1 = write_blob_chunk(&dir, "id-1", "报告.bin", 201, a, false, &payload[0..100]).unwrap();
        let p2 = write_blob_chunk(&dir, "id-1", "报告.bin", 201, b, false, &payload[100..150]).unwrap();
        assert_eq!(p1, p2, "同一 upload_id 的块必须落同一个文件");
        let p3 = write_blob_chunk(&dir, "id-1", "报告.bin", 201, c, true, &payload[150..]).unwrap();
        assert_eq!(p3, p1);
        assert_eq!(std::fs::read(&p3).unwrap(), payload, "落盘内容必须按偏移拼回原样");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 分块校验_偏移越界与总量超声明都拒() {
        let dir = std::env::temp_dir().join(format!("pp-blob-bad-{}", std::process::id()));
        // 偏移超出总长
        assert!(write_blob_chunk(&dir, "id", "a", 10, 10, false, &[1, 2]).is_err());
        // 块加起来超过声明大小
        assert!(write_blob_chunk(&dir, "id", "a", 3, 0, false, &[1, 2, 3, 4]).is_err());
        // 最后一块没补齐
        assert!(write_blob_chunk(&dir, "id", "a", 10, 0, true, &[1, 2]).is_err());
        // 单块超上限
        let big = vec![0u8; BLOB_CHUNK_MAX + 1];
        assert!(write_blob_chunk(&dir, "id", "a", big.len() as u64, 0, true, &big).is_err());
        // upload_id 带路径字符 → 拒（它是路径组件）
        assert!(write_blob_chunk(&dir, "../evil", "a", 2, 0, true, &[1, 2]).is_err());
        // 文件名带路径 → safe_file_name 取 basename 展平（它的既定策略：
        // 「兼容对端误带路径，绝不重建目录结构」），落盘名只含最后的分量
        let p = write_blob_chunk(&dir, "id", "../../etc/passwd", 2, 0, true, &[1, 2]).unwrap();
        assert!(
            p.file_name().and_then(|n| n.to_str()).unwrap_or("").ends_with("passwd"),
            "路径型文件名应展平为 basename，实际：{}",
            p.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 空文件_单块即完成() {
        let dir = std::env::temp_dir().join(format!("pp-blob-empty-{}", std::process::id()));
        let p = write_blob_chunk(&dir, "id", "空.txt", 0, 0, true, &[]).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), Vec::<u8>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_只清超龄文件() {
        let dir = send_spool_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("pp-prune-old.txt");
        let fresh = dir.join("pp-prune-fresh.txt");
        std::fs::write(&old, b"old").unwrap();
        std::fs::write(&fresh, b"fresh").unwrap();
        // 把 old 的修改时间拨到 25 小时前
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_millis(25 * 60 * 60 * 1000);
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(mtime)).unwrap();
        drop(f);
        prune_send_spool();
        assert!(!old.exists(), "超龄文件应被清掉");
        assert!(fresh.exists(), "新文件必须保留");
        let _ = std::fs::remove_file(&fresh);
    }
}
