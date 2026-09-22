//! R0 门禁与状态机单测（不起网络、不起 tauri）。按主题拆分的子模块：
//!
//! - `gate`：配对门 / 能力门 / needs_channel
//! - `clip_wait` / `scope_notice` / `lifecycle`：剪贴板等待、范围通知、会话收口
//! - `join_door`：邀请门与免确认重连
//! - `motion`：运动判定与发送序号
//! - `pace`：推流节拍判据（提帧上限 / 编码器 fps / IDR 限频）
//! - `pass_admit`：固定密码 / 接入码准入（含 D1/D12 回归钉）
//! - `audio`：G3 音频三因子（仅 Windows）
//! - `guards`：2026-09-20 全量审计的 include_str! 接线守卫

// 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
#![allow(non_snake_case)]

mod audio;
mod clip_wait;
mod gate;
mod guards;
mod join_door;
mod lifecycle;
mod motion;
mod pace;
mod pass_admit;
mod scope_notice;

use crate::data_store::DataStore;

pub(super) fn store() -> DataStore {
    DataStore::new(":memory:").expect("open store")
}

pub(super) fn set_cfg(store: &DataStore, key: &str, val: serde_json::Value) {
    let mut c = store.get_config().unwrap_or_default();
    c.as_object_mut().unwrap().insert(key.to_string(), val);
    store.save_config(&c).unwrap();
}

/// 守卫单测的「锚点 + 窗口」截取：`src[start..start+len]`，但把结束点**对齐到
/// 字符边界**。
///
/// 🔴 为什么需要它：这些守卫用固定**字节**窗口圈住一段函数体，而被圈的源码里
/// 有中文（一个字 3 字节）。窗口尾端落在多字节字符中间时会直接
/// `byte index … is not a char boundary` **panic**——2026-09-22 实测：给
/// `approve_inbound` 加了几行（合法改动）就炸了 `守卫_approve_inbound会elevate同步设备`。
/// 窗口本来只是「大致划个范围」，往前收最多 3 字节不影响断言语义，
/// 但把「改无关代码就炸」这类假失败去掉了。
pub(super) fn window(src: &str, start: usize, len: usize) -> &str {
    let mut end = (start + len).min(src.len());
    while end > start && !src.is_char_boundary(end) {
        end -= 1;
    }
    &src[start..end]
}
