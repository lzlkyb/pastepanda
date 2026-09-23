//! 远程电脑 · 局域网配对的命令层（A3，2026-09-17）。
//!
//! 与 `commands/rc.rs` **分开**：那个文件 700+ 行（邀请码、会话、目标列表、
//! 邀请门都在里面），而局域网配对是**独立的一条路**——不走邀请码、不走 Endpoint
//! 握手，靠 presence 上的明文包 + 6 位数字核对完成。混进那个文件只会让
//! 「改哪一段」变成靠记忆的事。
//!
//! # 与邀请码那条路的关系
//!
//! 邀请码（`commands/rc.rs::rc_invite_create` / `rc_pair`）是**兜底**：
//! 不在同一局域网时只能靠带外渠道搬一串码。这条局域网路径把「搬字符串」
//! 整个消掉，而且**信任强度更高**（中间人换公钥会让两端数字对不上，
//! 见 `rc/pin.rs` 的模块头）。
//!
//! 两条路的产物是同一张表（`rc_devices`），配完之后界面上没有区别。

use crate::rc::pin::{Confirmed, Done, PairPrompt};
use crate::rc::service::RcService;
use crate::sync::presence::Neighbor;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// 附近设备 + 当前配对状态。
#[derive(Debug, Clone, Serialize)]
pub struct RcNearbyStatus {
    /// 同一局域网里**还没配对**的邻居，最近听到的排前面。
    ///
    /// ❗ 名字是**对方自报**的，界面必须与指纹一起显示并标注「可自称」——
    /// 见 `wire::clean_name` 的注释。
    pub neighbors: Vec<Neighbor>,
    /// 正在进行的那一轮配对（没有则为 `null`）。
    pub pair: Option<PairPrompt>,
    /// 刚配对成功的那一台。
    ///
    /// 🔴 P1-7（2026-09-23 审计）：语义从「读完即清」改成「**60 秒窗口内多重可读**」——
    /// 主窗口与工作台两个轮询者并发调本命令，旧语义下先读到的那个把成功屏独占走，
    /// 另一个永远看不见。载荷形状没变（`Done`，带 `at_ms`），所以「这一条我已经弹过了」
    /// 的去重归界面（按 `at_ms` 比对），不归后端。
    pub done: Option<Done>,
}

/// 本端点了「确认」之后的结局。
#[derive(Debug, Clone, Serialize)]
pub struct RcPairResult {
    /// `waiting` = 本端确认了、在等对方；`committed` = 两边都确认了、**已配对**；
    /// `gone` = 会话已过期或被取消。
    pub state: String,
    pub peer_id: String,
    pub peer_name: String,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 附近设备 + 当前配对状态。
///
/// 🔴 界面对话框打开期间按 **2 秒**轮询它，而这个命令**顺带把该重传的配对包
/// 重传掉**（`RcService::nearby_prompt` → `discovery.tick`）。这是刻意的：
/// 配对只有 60 秒窗口，UDP 丢一个包就卡住，而「有人在看着」恰好是重传的前提
/// ——没有界面在读状态时，也就没有人在等这次配对。
#[tauri::command]
pub fn rc_nearby_status(svc: State<'_, Arc<RcService>>) -> RcNearbyStatus {
    let now = now_ms();
    RcNearbyStatus {
        neighbors: svc.nearby_neighbors(now),
        pair: svc.nearby_prompt(now),
        done: svc.nearby_done(now),
    }
}

/// 对着一台附近的设备发起配对。
///
/// 返回的 `pair.pin` 多半是空串——在等对方的公钥（一个来回，局域网内毫秒级）。
/// 界面这时该显示「正在与对方核对…」而不是一个空框。
#[tauri::command]
pub fn rc_nearby_pair(
    peer_id: String,
    svc: State<'_, Arc<RcService>>,
) -> Result<PairPrompt, String> {
    svc.nearby_pair_start(&peer_id, now_ms())
}

/// 本端点了「两边一样，确认」。
///
/// `waiting` 不是错误：两端的确认有先后，先点的那一侧本来就要等。
#[tauri::command]
pub fn rc_nearby_confirm(svc: State<'_, Arc<RcService>>) -> Result<RcPairResult, String> {
    let c = svc.nearby_confirm(now_ms())?;
    Ok(match c {
        Confirmed::Waiting { peer_id } => RcPairResult {
            state: "waiting".to_string(),
            peer_id,
            peer_name: String::new(),
        },
        Confirmed::Committed { peer_id, peer_name } => RcPairResult {
            state: "committed".to_string(),
            peer_id,
            peer_name,
        },
        Confirmed::Gone => RcPairResult {
            state: "gone".to_string(),
            peer_id: String::new(),
            peer_name: String::new(),
        },
    })
}

/// 取消这一轮配对。
///
/// 本端是**被请求**的那一侧时，顺带记一次「拒绝」——30 分钟内对方再来敲门
/// 不会再弹窗（`RcJoins::deny`）。发起方取消不记：那只是「我不发了」。
#[tauri::command]
pub fn rc_nearby_cancel(svc: State<'_, Arc<RcService>>) -> bool {
    svc.nearby_cancel(now_ms())
}
