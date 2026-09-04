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
//! 之后靠 `kb_presence` 签名组播（还没做，见设计稿）。
//! 本模块只管「给了地址就能连」，不负责找地址。

use crate::sync::identity::NodeIdentity;
use iroh::{
    endpoint::{presets, RelayMode},
    Endpoint, EndpointAddr, SecretKey,
};
use std::path::{Path, PathBuf};

/// ALPN。带版本号：协议不兼容时**连不上**比连上之后乱解析好得多。
pub const ALPN: &[u8] = b"pastepanda-sync/1";

/// 一次传输的上限。防的是「对端发一个巨大的流把本机磁盘写满」。
///
/// 8 GiB：个人知识库的全量导出远小于它（本机 25 篇 226KB），
/// 首次同步是唯一可能大的场合。
const MAX_TRANSFER_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// 单个文件名长度上限。
const MAX_NAME_LEN: usize = 1024;
/// 反斜杠。**写成 `\u{5C}` 而不是字面量**：这份代码经多层工具传递，
/// 字面反斜杠会被吞掉（本文件为此栽过五次）。
const BACKSLASH: char = '\u{5C}';

/// 建一个端点。
///
/// `relay` 为 `false` 时**同时关掉 relay 与地址发现**——那才是真的「只走局域网」。
/// 只关 relay 的话地址发现仍会打 n0 的 DNS（见模块文档）。
pub async fn bind(me: &NodeIdentity, seed: [u8; 32], relay: bool) -> Result<Endpoint, String> {
    // `me` 现在只用来表明「身份是调用方的事」；种子必须与它同源。
    let _ = me;
    let key = SecretKey::from_bytes(&seed);
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

/// 把一个目录打成流发给对端，返回发出的字节数。
///
/// 线格式极简：`u32 名字长度 | 名字 | u64 内容长度 | 内容` 重复，末尾 `u32 0`。
///
/// 🔴 **不用 tar/zip**：那会引入一个解压器，而解压器是路径穿越
/// （`../../windows/system32`）的经典入口。这里的名字自己校验（[`safe_rel`]），
/// 校验规则只有一处，读得完。
pub async fn send_dir(ep: &Endpoint, to: EndpointAddr, dir: &Path) -> Result<u64, String> {
    let conn = ep
        .connect(to, ALPN)
        .await
        .map_err(|e| format!("连接对端失败：{}", e))?;
    let (mut send, _recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("开流失败：{}", e))?;

    let mut total = 0u64;
    for (rel, bytes) in collect(dir)? {
        let name = rel.as_bytes();
        wr(&mut send, &(name.len() as u32).to_be_bytes()).await?;
        wr(&mut send, name).await?;
        wr(&mut send, &(bytes.len() as u64).to_be_bytes()).await?;
        wr(&mut send, &bytes).await?;
        total += bytes.len() as u64;
    }
    wr(&mut send, &0u32.to_be_bytes()).await?;
    send.finish().map_err(|e| format!("收尾失败：{}", e))?;
    // 等对端收完再放手：`finish()` 只标记流结束，**不等数据真正送到**
    // （探针里栽过这一条，见 probe/iroh 的 README ③）。
    conn.closed().await;
    Ok(total)
}

/// 收一个目录，返回收到的字节数。`dir` 必须已存在。
pub async fn recv_dir(ep: &Endpoint, dir: &Path) -> Result<u64, String> {
    let incoming = ep.accept().await.ok_or("没有连接进来")?;
    let conn = incoming.await.map_err(|e| format!("握手失败：{}", e))?;
    let (mut send, mut recv) = conn
        .accept_bi()
        .await
        .map_err(|e| format!("开流失败：{}", e))?;

    let mut total = 0u64;
    loop {
        let mut n = [0u8; 4];
        recv.read_exact(&mut n)
            .await
            .map_err(|e| format!("读名字长度失败：{}", e))?;
        let n = u32::from_be_bytes(n) as usize;
        if n == 0 {
            break;
        }
        if n > MAX_NAME_LEN {
            return Err(format!("文件名过长（{} 字节）", n));
        }
        let mut name = vec![0u8; n];
        recv.read_exact(&mut name)
            .await
            .map_err(|e| format!("读名字失败：{}", e))?;
        let rel = String::from_utf8(name).map_err(|_| "文件名不是 UTF-8".to_string())?;
        let path = safe_rel(dir, &rel)?;

        let mut l = [0u8; 8];
        recv.read_exact(&mut l)
            .await
            .map_err(|e| format!("读内容长度失败：{}", e))?;
        let l = u64::from_be_bytes(l);
        total += l;
        if total > MAX_TRANSFER_BYTES {
            return Err(format!("这次传输超过上限（{} 字节）", MAX_TRANSFER_BYTES));
        }
        let mut buf = vec![0u8; l as usize];
        recv.read_exact(&mut buf)
            .await
            .map_err(|e| format!("读内容失败：{}", e))?;

        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("建目录失败：{}", e))?;
        }
        std::fs::write(&path, &buf)
            .map_err(|e| format!("写文件失败 {}：{}", path.display(), e))?;
    }
    send.finish().ok();
    conn.close(0u32.into(), b"done");
    Ok(total)
}

/// 把相对路径解成 `dir` 下的绝对路径，**拒绝任何逃出 `dir` 的写法**。
///
/// 🔴 这是本模块唯一的安全边界：名字来自网络。
/// 拒绝绝对路径、盘符、`..`、以及空段。
fn safe_rel(dir: &Path, rel: &str) -> Result<PathBuf, String> {
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

/// 给测试用。`safe_rel` 是私有的，而路径穿越是本模块唯一的安全边界，必须能测。
#[cfg(test)]
pub fn safe_rel_for_test(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    safe_rel(dir, rel)
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

/// 写一段字节。把错误统一成字符串，省得每处都写一遍 `map_err`。
async fn wr(s: &mut iroh::endpoint::SendStream, b: &[u8]) -> Result<(), String> {
    s.write_all(b)
        .await
        .map_err(|e| format!("写流失败：{}", e))
}
