//! iroh 传输层（M6）。**只负责把增量目录搬过去，不懂笔记。**
//!
//! # 分层
//!
//! ```text
//! sync::engine     算增量 / 写增量目录 / 应用增量目录   ← 不联网，本地可测
//! sync::transport  把那个目录搬到对端                   ← 本模块
//! ```
//!
//! 这条界线是有意划的：**合并语义与传输完全解耦**，
//! 于是 `engine` 那 20 多条端到端测试不需要网络，
//! 而本模块只需要证明「一个目录能原样到对面」。
//!
//! # 为什么是 iroh 一条通道
//!
//! 局域网直连与跨网打洞/relay 用**同一套栈**。做两套（LAN 组播 + WAN iroh）的话，
//! **同一对设备在不同网络下走不同代码路径** → bug 与所在地点相关、间歇出现，最难查。
//! 探针已证离线局域网下 iroh 不依赖 relay 也能直连（`probe/iroh`）。
//!
//! # ❗ iroh 1.1 不带局域网发现
//!
//! 三个地址发现服务（`PkarrPublisher` / `PkarrResolver` / `DnsAddressLookup`）
//! **全都走 n0 的 DNS、都要联网**。所以「关掉 relay」≠「不用联网」。
//!
//! 离线局域网下对端地址只能我们自己给——第一次靠邀请码里的 `addrs`，
//! 之后靠 `kb_presence` 签名组播（见 [`super::presence`]）。
//! 本模块只管「给了地址就能连」，不负责找地址。

use crate::sync::identity::NodeIdentity;
use iroh::{
    endpoint::{presets, RelayMode},
    Endpoint, EndpointAddr,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 一次读或写**停滞**多久就放弃。
///
/// # 🔴 为什么是「停滞超时」而不是「会话总超时」
///
/// [`super::session::run`] **只在整轮成功之后**才推游标。
/// 也就是说中途中断 = 没有任何部分进度，下一轮从头再来。
/// 所以一旦总超时短于实际需要的时间，那次同步就**永远做不完**——
/// 不是变慢，是永久失败，而且每次重试烧同样的流量。
/// 而首次同步一个带图的知识库走中继时，几十分钟是可能的（附件单张上限 10MB）：
/// **拍不出一个安全的总时长。**
///
/// 按进度算就没有这个矛盾：大文件分块收发、每块各自计时，
/// [`IO_CHUNK`] / 30 秒 ≈ 最低 17 kbps。任何真实链路都高出几个数量级，
/// 而「保活着每分钟挤一个字节」的慢速攻击会在 30 秒内被砍掉。
/// **对「慢但在动」零误伤。**
///
/// ❗ 它顺带把「完全死掉的连接」也兜住了，所以不需要去依赖 QUIC 自己的 idle timeout
/// （iroh presets 里那个值未核实，也不必依赖）。
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 大文件按块收发，每块各自计时。**读写两侧共用这一个块大小。**
///
/// ❗ 不分块的话，一个 256MiB 的文件就是一次 `read_exact` / `write_all`，
/// 包上超时又变回了「总超时」——慢链路上必超。
const IO_CHUNK: usize = 64 * 1024;

/// 给一次读/写加停滞超时。超时就中断整个会话（游标不推，下一轮重来）。
async fn stalled<T>(
    what: &str,
    stall: Duration,
    f: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(stall, f).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "{}：{} 秒内一个字节都没动，已中断本次同步",
            what,
            stall.as_secs()
        )),
    }
}

/// ALPN。带版本号：协议不兼容时**连不上**比连上之后乱解析好得多。
pub const ALPN: &[u8] = b"pastepanda-sync/1";

/// 一次传输的上限。防的是「对端发一个巨大的流把本机磁盘写满」。
///
/// 8 GiB：个人知识库的全量导出远小于它（本机 25 篇 226KB），
/// 首次同步是唯一可能大的场合。
const MAX_TRANSFER_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// 单个文件的上限。在**分配内存之前**夹住对端声明的长度，
/// 否则一行 `vec![0u8; l]` 就能把进程弄死。单篇笔记远不到 256 MiB。
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// 单个文件名长度上限。
const MAX_NAME_LEN: usize = 1024;
/// 反斜杠。**写成 `\u{5C}` 而不是字面量**：这份代码经多层工具传递，
/// 字面反斜杠会被吞掉（本文件为此栽过五次）。
const BACKSLASH: char = '\u{5C}';

/// 建一个端点。
///
/// `relay` 为 `false` 时**同时关掉 relay 与地址发现**——那才是真的「只走局域网」。
/// 只关 relay 的话地址发现仍会打 n0 的 DNS（见模块文档）。
pub async fn bind(me: &NodeIdentity, relay: bool) -> Result<Endpoint, String> {
    // 🔴 密钥只能从身份里取（[`NodeIdentity::iroh_secret`]）。
    // 上一版还另收一个 `seed` 参数、而 `me` 完全没用，
    // 那意味着端点 id 可以与大家配对时认的 `node_id` 不一致——配对直接失效。
    let key = me.iroh_secret();
    let b = if relay {
        Endpoint::builder(presets::N0).secret_key(key)
    } else {
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .relay_mode(RelayMode::Disabled)
            .clear_address_lookup()
    };
    b.alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| format!("绑定 iroh 端点失败：{}", e))
}

/// 一次会话手里的东西：连接 + 一对流。
///
/// 分成 `dial`/`accept` 两头拿，是因为**会话是双向的**：
/// 一次往返里两边都要发自己的增量、也都要收对端的。
/// 老的 [`send_dir`]/[`recv_dir`] 是单向一次性的，喂不了游标交换。
pub struct Wire {
    pub conn: iroh::endpoint::Connection,
    pub send: iroh::endpoint::SendStream,
    pub recv: iroh::endpoint::RecvStream,
}

/// 单个控制帧的长度上限。会话开场那个 hello 只有几十字节，
/// 64 KiB 是给未来加字段留的余量，不是给数据用的。
pub const MAX_FRAME_LEN: usize = 64 * 1024;

/// 主动连一个对端，拿到一对流。
pub async fn dial(ep: &Endpoint, to: EndpointAddr) -> Result<Wire, String> {
    let conn = ep
        .connect(to, ALPN)
        .await
        .map_err(|e| format!("连接对端失败：{}", e))?;
    let (send, recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("开流失败：{}", e))?;
    Ok(Wire { conn, send, recv })
}

/// 等一个对端连进来（**只到握手为止，不等它开流**）。
///
/// 🔴 开流那一步要单独调 [`accept_streams`]，不能并进来：
/// ALPN 是公开的，**没配对的人也连得上**。只要它连上之后不开双向流，
/// `accept_bi().await` 就会一直挂着——而这个函数是在 accept 循环里调的，
/// 于是**所有其它设备的入连接全被堵死**。拆开之后调用方可以把开流
/// 丢进独立任务并加超时。
pub async fn accept_conn(ep: &Endpoint) -> Result<iroh::endpoint::Connection, String> {
    let incoming = ep.accept().await.ok_or("没有连接进来")?;
    incoming.await.map_err(|e| format!("握手失败：{}", e))
}

/// 在一个已握手的连接上等对端开双向流。**调用方应当给它加超时。**
pub async fn accept_streams(conn: iroh::endpoint::Connection) -> Result<Wire, String> {
    let (send, recv) = conn
        .accept_bi()
        .await
        .map_err(|e| format!("开流失败：{}", e))?;
    Ok(Wire { conn, send, recv })
}

/// 等一个对端连进来并开流。**只给单向的 [`recv_dir`] 与测试用**——
/// 编排层走 [`accept_conn`] + [`accept_streams`]，见上面的说明。
pub async fn accept(ep: &Endpoint) -> Result<Wire, String> {
    accept_streams(accept_conn(ep).await?).await
}

/// 发一个控制帧：`u32 长度 | 内容`。
pub async fn write_frame(s: &mut iroh::endpoint::SendStream, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_LEN {
        return Err(format!("控制帧长度不合法（{} 字节）", bytes.len()));
    }
    wr(s, &(bytes.len() as u32).to_be_bytes()).await?;
    wr(s, bytes).await
}

/// 收一个控制帧。
pub async fn read_frame(r: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>, String> {
    let mut n = [0u8; 4];
    stalled("读帧长度", STALL_TIMEOUT, async {
        r.read_exact(&mut n)
            .await
            .map_err(|e| format!("读帧长度失败：{}", e))
    })
    .await?;
    let n = u32::from_be_bytes(n) as usize;
    if n == 0 || n > MAX_FRAME_LEN {
        return Err(format!("对端报的帧长度不合法（{} 字节）", n));
    }
    let mut buf = vec![0u8; n];
    // 控制帧封顶 `MAX_FRAME_LEN`（= [`IO_CHUNK`]），不用再分块
    stalled("读帧内容", STALL_TIMEOUT, async {
        r.read_exact(&mut buf)
            .await
            .map_err(|e| format!("读帧内容失败：{}", e))
    })
    .await?;
    Ok(buf)
}

/// 把一个目录写进流，返回写出的字节数。**不 finish**——调用方可能还要接着写。
///
/// 线格式极简：`u32 名字长度 | 名字 | u64 内容长度 | 内容` 重复，末尾 `u32 0`。
///
/// 🔴 **不用 tar/zip**：那会引入一个解压器，而解压器是路径穿越
/// （`../../windows/system32`）的经典入口。这里的名字自己校验（[`safe_rel`]），
/// 校验规则只有一处，读得完。
pub async fn write_dir(s: &mut iroh::endpoint::SendStream, dir: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for (rel, bytes) in collect(dir)? {
        let name = rel.as_bytes();
        wr(s, &(name.len() as u32).to_be_bytes()).await?;
        wr(s, name).await?;
        wr(s, &(bytes.len() as u64).to_be_bytes()).await?;
        wr(s, &bytes).await?;
        total += bytes.len() as u64;
    }
    wr(s, &0u32.to_be_bytes()).await?;
    Ok(total)
}

/// 从流里读一个目录出来，返回收到的字节数。`dir` 必须已存在。
pub async fn read_dir(r: &mut iroh::endpoint::RecvStream, dir: &Path) -> Result<u64, String> {
    read_dir_with(r, dir, STALL_TIMEOUT).await
}

/// 同上，但停滞上限从参数进。
///
/// ❗ **给测试用**：同 [`super::service::coalesce_writes`] 把窗口参数化的理由——
/// 验证停滞分支不该真等 30 秒。
pub async fn read_dir_with(
    r: &mut iroh::endpoint::RecvStream,
    dir: &Path,
    stall: Duration,
) -> Result<u64, String> {
    let mut total = 0u64;
    // 🔴 条目数上限（2026-09-07 新增）。本循环原有三道门：
    //    单文件 `MAX_FILE_BYTES`、总量 `MAX_TRANSFER_BYTES`、每次读 `stall` 超时。
    //    但**没有条目数上限**，而 `total` 只累加声明长度：
    //    对端持续发**零长度**文件时，`total` 恒为 0 ⇒ 永不触发总量上限；
    //    每个条目又都很快到达 ⇒ 永不停滞 ⇒ 无限循环写满暂存目录所在盘。
    //
    //    上限取得很宽松：一次增量里的条目数 = 笔记数 + 附件数 + 几个元文件，
    //    真实库上万条也远低于它；它只用来接住「无限发」这一种。
    const MAX_ENTRIES: usize = 200_000;
    let mut entries = 0usize;
    loop {
        entries += 1;
        if entries > MAX_ENTRIES {
            return Err(format!(
                "这次传输的条目数超过上限（{}），已中断",
                MAX_ENTRIES
            ));
        }
        let mut n = [0u8; 4];
        stalled("读名字长度", stall, async {
            r.read_exact(&mut n)
                .await
                .map_err(|e| format!("读名字长度失败：{}", e))
        })
        .await?;
        let n = u32::from_be_bytes(n) as usize;
        if n == 0 {
            break;
        }
        if n > MAX_NAME_LEN {
            return Err(format!("文件名过长（{} 字节）", n));
        }
        let mut name = vec![0u8; n];
        stalled("读名字", stall, async {
            r.read_exact(&mut name)
                .await
                .map_err(|e| format!("读名字失败：{}", e))
        })
        .await?;
        let rel = String::from_utf8(name).map_err(|_| "文件名不是 UTF-8".to_string())?;
        let path = safe_rel(dir, &rel)?;

        let mut l = [0u8; 8];
        stalled("读内容长度", stall, async {
            r.read_exact(&mut l)
                .await
                .map_err(|e| format!("读内容长度失败：{}", e))
        })
        .await?;
        let l = u64::from_be_bytes(l);
        // 🔴 单文件也要夹，而且要在**分配之前**。
        // 只看累计值的话，对端声明一个恰好 8 GiB 的文件不会触发
        // `total > MAX`（相等），紧接着就是一次 8 GiB 的归零分配 → 直接 OOM。
        // 单篇笔记远不到这个量级，夹住不会误伤真实数据。
        if l > MAX_FILE_BYTES {
            return Err(format!(
                "对端声明的单个文件太大（{} 字节，上限 {}）",
                l, MAX_FILE_BYTES
            ));
        }
        total += l;
        if total > MAX_TRANSFER_BYTES {
            return Err(format!("这次传输超过上限（{} 字节）", MAX_TRANSFER_BYTES));
        }
        let mut buf = vec![0u8; l as usize];
        // 🔴 分块读，每块各自计时。一次 `read_exact` 整个文件再包超时的话，
        //    那就变回了「总超时」（见 [`STALL_TIMEOUT`]）——256MiB 的文件在慢链路上必超。
        for part in buf.chunks_mut(IO_CHUNK) {
            stalled("读文件内容", stall, async {
                r.read_exact(part)
                    .await
                    .map_err(|e| format!("读内容失败：{}", e))
            })
            .await?;
        }

        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("建目录失败：{}", e))?;
        }
        std::fs::write(&path, &buf).map_err(|e| format!("写文件失败 {}：{}", path.display(), e))?;
    }
    Ok(total)
}

/// 单向：连上去、把一个目录发过去、等对端收完。
///
/// 会话用的是 [`dial`] + [`write_dir`]；这个薄封装留着，
/// 因为它是「一个目录能原样到对面」这件事最小的可测单位。
pub async fn send_dir(ep: &Endpoint, to: EndpointAddr, dir: &Path) -> Result<u64, String> {
    let mut w = dial(ep, to).await?;
    let total = write_dir(&mut w.send, dir).await?;
    w.send.finish().map_err(|e| format!("收尾失败：{}", e))?;
    // 等对端收完再放手：`finish()` 只标记流结束，**不等数据真正送到**
    // （探针里栽过这一条，见 probe/iroh 的 README ③）。
    w.conn.closed().await;
    Ok(total)
}

/// 单向：等一个连接进来、把目录收下来。`dir` 必须已存在。
pub async fn recv_dir(ep: &Endpoint, dir: &Path) -> Result<u64, String> {
    let mut w = accept(ep).await?;
    let total = read_dir(&mut w.recv, dir).await?;
    w.send.finish().ok();
    w.conn.close(0u32.into(), b"done");
    Ok(total)
}

/// 把相对路径解成 `dir` 下的绝对路径，**拒绝任何逃出 `dir` 的写法**。
/// 拒绝绝对路径、盘符、`..`、以及空段。
///
/// 🔴 **凡是拿对端给的字串拼本机路径的地方，都必须先过这里。**
///
/// 这句话原本写的是「本模块唯一的安全边界」，而那个前提**曾经不成立**：
/// [`super::engine::apply_delta`] 从 `.pp-sync-manifest` 里读第三列直接
/// `dir.join(rel)`，绕过了这里。文件**名**过了校验，文件**内容**没人管，
/// 而那条路径下面就是一句 `std::fs::remove_file`——
/// 已配对的对端因此能删本机任意文件（2026-09-07 审出并修掉）。
/// 所以它现在是 `pub(super)`：**边界只有一道，但入口不只一个。**
pub(super) fn safe_rel(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("空文件名".to_string());
    }
    if rel.contains(':') || rel.starts_with('/') || rel.starts_with(BACKSLASH) {
        return Err(format!("拒绝绝对路径或带盘符的名字：{}", rel));
    }
    let mut out = dir.to_path_buf();
    for seg in rel.split(['/', BACKSLASH]) {
        if seg.is_empty() {
            return Err(format!("路径里有空段：{}", rel));
        }
        if seg == "." || seg == ".." {
            return Err(format!("拒绝相对跳转：{}", rel));
        }
        out.push(seg);
    }
    Ok(out)
}

/// 收集目录下所有文件（含子目录），返回 `(相对路径, 内容)`。
///
/// 相对路径统一用 `/`：两端可能是不同的操作系统写法，
/// 统一在发送侧做，接收侧就只需要认一种。
fn collect(dir: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    Ok(out)
}

fn walk(root: &Path, cur: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
    let rd = std::fs::read_dir(cur).map_err(|e| format!("读目录失败 {}：{}", cur.display(), e))?;
    for e in rd {
        let e = e.map_err(|x| format!("读目录项失败：{}", x))?;
        let p = e.path();
        if p.is_dir() {
            walk(root, &p, out)?;
        } else {
            let rel = p
                .strip_prefix(root)
                .map_err(|_| "路径不在根目录下".to_string())?
                .to_string_lossy()
                .replace(BACKSLASH, "/");
            let bytes = std::fs::read(&p).map_err(|x| format!("读文件失败：{}", x))?;
            out.push((rel, bytes));
        }
    }
    Ok(())
}

/// 写一段字节。**分块 + 每块停滞超时**。错误统一成字符串，省得每处写一遍 `map_err`。
///
/// 🔴 写侧同样会挂死：对端不读的话，流控窗口填满后 `write_all` 会永远阻塞。
/// 只包读不包写会漏掉一半的挂死路径。
async fn wr(s: &mut iroh::endpoint::SendStream, b: &[u8]) -> Result<(), String> {
    for part in b.chunks(IO_CHUNK) {
        stalled("写流", STALL_TIMEOUT, async {
            s.write_all(part)
                .await
                .map_err(|e| format!("写流失败：{}", e))
        })
        .await?;
    }
    Ok(())
}
