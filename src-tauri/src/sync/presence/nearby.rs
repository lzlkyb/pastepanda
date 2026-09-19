//! 「附近的设备」：用明文招呼包（[`super::wire::WireKind::Hello`]）攒出来的一张候选表。
//!
//! # 🔴 它为什么不能复用地址表
//!
//! 地址表（[`super::PresenceTable`]）在**验签之前**就把未配对设备的公告拦掉了
//! （`if !is_paired(..) { return Heard::Unpaired }`，模块文档写明理由：
//! 「否则同网段任何人都能把表灌满」）。所以它返回的是「**已配对**且在线的设备」，
//! 天然不可能回答「我旁边有哪几台机器」这个问题。
//!
//! 于是附近设备必须另有一条**明文、且一个字都不入地址表**的通道。
//! 2026-09-17 写配对设计稿时查出来的——原方案里「presence 表里已经有附近的设备」
//! 这句在代码上不成立。
//!
//! # 与地址表的三处关键差别
//!
//! | | 地址表 | 本表 |
//! |---|---|---|
//! | 谁能进 | 只有已配对 | 同网段任何**持自己私钥**的机器（名字可自称） |
//! | 过期 | [`super::STALE_MS`]（60 秒，4 个心跳） | [`NEARBY_TTL_MS`]（20 秒，同 `lan_pair`） |
//! | 上限 | 每节点 4 个地址 | 整表 [`MAX_NEIGHBORS`] 台，满了挤掉最旧的 |
//!
//! 20 秒是有理由的短：[`crate::lan_pair::NEARBY_TTL_SECS`] 就是 20，
//! 两套「附近设备」用同一个数字，用户不会看到两种行为。而这个短 TTL 也是
//! **本表的安全边界**——明文包没有「已配对」这道门，能限制的就只有时间和条数。

use crate::lan_pair::NEARBY_TTL_SECS;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

/// 多久没再听到就从列表里消失（毫秒）。
///
/// ❗ 复用 `lan_pair` 那个 20 秒，不另写一个数：知识库同步的「附近设备」用的
/// 就是这个值，两套配对流程给用户的观感必须一致。
pub const NEARBY_TTL_MS: i64 = NEARBY_TTL_SECS * 1000;

/// 整表最多记几台。
///
/// 明文包挡不住同网段的人刷屏，所以必须有上限——否则一份几 KB 的包乘以
/// 无限个假 `node_id` 就是内存增长。32 台对任何真实家用/办公局域网都够
/// （同网段同时开着 PastePanda 并点开配对界面的机器不会更多）。
const MAX_NEIGHBORS: usize = 32;

/// 一台附近设备。给界面用。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Neighbor {
    pub node_id: String,
    /// 对方**自报**的名字。可能为空（对方没带），界面上必须同时显示指纹，
    /// 并标注「可自称，以指纹为准」。
    pub name: String,
    /// 对端自报的可达地址（IP 取源地址、端口取包里的端点端口）。
    pub addr: SocketAddr,
    /// 本机最后一次听到它的时刻（epoch 毫秒）。用**本机**时钟，
    /// 免得对方时钟一歪，设备就从列表里提前消失或永远不走。
    pub last_seen_ms: i64,
}

/// 附近设备表。只在内存里，进程退出即空。
#[derive(Default)]
pub struct Nearby {
    inner: Mutex<HashMap<String, Neighbor>>,
}

impl Nearby {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 收到一份招呼包。返回「这是不是一张新面孔」——调用方用它在**跃变**时
    /// 记一条日志（每 5 秒一份的心跳不该刷屏）。
    ///
    /// `name` 传空串表示对方没带名字：**不清空**已有的名字，因为
    /// 「这一份包没带名字」和「对方改名叫空了」是两件事，按前者处理更安全。
    pub fn note(&self, node_id: &str, name: &str, addr: SocketAddr, now_ms: i64) -> bool {
        if node_id.is_empty() {
            return false;
        }
        let Ok(mut m) = self.inner.lock() else {
            return false;
        };
        // 顺手剪枝：读的时候有 TTL，写的时候也剪一次，避免一直没人读就无限增长。
        Self::prune(&mut m, now_ms);
        let is_new = !m.contains_key(node_id);
        if is_new && m.len() >= MAX_NEIGHBORS {
            // 满了就挤掉最久没听到的那台（而不是最先加进来的）：
            // 关掉机器的邻居不会再被刷新，正好被挤掉。
            if let Some(oldest) = m
                .iter()
                .min_by_key(|(_, n)| n.last_seen_ms)
                .map(|(id, _)| id.clone())
            {
                m.remove(&oldest);
            }
        }
        m.entry(node_id.to_string())
            .and_modify(|n| {
                n.addr = addr;
                n.last_seen_ms = now_ms;
                if !name.is_empty() {
                    n.name = name.to_string();
                }
            })
            .or_insert(Neighbor {
                node_id: node_id.to_string(),
                name: name.to_string(),
                addr,
                last_seen_ms: now_ms,
            });
        is_new
    }

    /// 当前还在的附近设备，最近听到的排前面。**读的时候自带剪枝**，
    /// 所以调用方不需要自己判有效期。
    pub fn list(&self, now_ms: i64) -> Vec<Neighbor> {
        let Ok(mut m) = self.inner.lock() else {
            return Vec::new();
        };
        Self::prune(&mut m, now_ms);
        let mut v: Vec<Neighbor> = m.values().cloned().collect();
        // 名字相同时按 node_id 兜底排序，免得两轮之间顺序抖动（界面会闪）。
        v.sort_by(|a, b| {
            b.last_seen_ms
                .cmp(&a.last_seen_ms)
                .then_with(|| a.node_id.cmp(&b.node_id))
        });
        v
    }

    /// 忘了这一台（配对成功、或用户点了「忽略」之后调）。
    pub fn forget(&self, node_id: &str) {
        if let Ok(mut m) = self.inner.lock() {
            m.remove(node_id);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut m) = self.inner.lock() {
            m.clear();
        }
    }

    fn prune(m: &mut HashMap<String, Neighbor>, now_ms: i64) {
        m.retain(|_, n| now_ms - n.last_seen_ms <= NEARBY_TTL_MS);
    }
}

#[cfg(test)]
mod tests {
    use super::super::wire::WireKind;
    use super::*;

    fn addr(last: u8) -> SocketAddr {
        SocketAddr::from(([192, 168, 31, last], 49238))
    }

    #[test]
    fn 听到一次就进列表_重复听到不重复计() {
        let n = Nearby::new();
        assert!(
            n.note("aa", "办公室台式机", addr(1), 1_000),
            "第一次是新面孔"
        );
        assert!(!n.note("aa", "办公室台式机", addr(1), 1_500), "第二次不是");
        let l = n.list(1_500);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].name, "办公室台式机");
        assert_eq!(l[0].last_seen_ms, 1_500, "重复听到要刷新时间戳");
    }

    #[test]
    fn 超时就消失() {
        let n = Nearby::new();
        n.note("aa", "台式机", addr(1), 1_000);
        assert_eq!(n.list(1_000 + NEARBY_TTL_MS).len(), 1, "正好到点还算在");
        assert!(
            n.list(1_000 + NEARBY_TTL_MS + 1).is_empty(),
            "过了 TTL 必须消失——明文包没有「已配对」那道门，时间就是它的边界"
        );
    }

    #[test]
    fn 没带名字的那一份不清空已有名字() {
        let n = Nearby::new();
        n.note("aa", "办公室台式机", addr(1), 1_000);
        // 对方后来发的一份没带名字
        n.note("aa", "", addr(1), 1_200);
        assert_eq!(
            n.list(1_200)[0].name,
            "办公室台式机",
            "「这份没带名字」不等于「对方改名叫空了」"
        );
    }

    #[test]
    fn 换网卡换地址就覆盖() {
        let n = Nearby::new();
        n.note("aa", "笔记本", addr(1), 1_000);
        n.note("aa", "笔记本", addr(9), 1_100);
        let l = n.list(1_100);
        assert_eq!(l.len(), 1, "同一台机器换了 IP 不该变成两台");
        assert_eq!(l[0].addr, addr(9));
    }

    #[test]
    fn 满了就挤掉最久没听到的() {
        let n = Nearby::new();
        for i in 0..MAX_NEIGHBORS {
            n.note(&format!("id{i:02}"), "邻居", addr(1), 1_000 + i as i64);
        }
        // 再来一台：最旧的（id00）应该被挤掉
        n.note("新来的", "新来的", addr(2), 5_000);
        let ids: Vec<String> = n.list(5_000).into_iter().map(|n| n.node_id).collect();
        assert_eq!(ids.len(), MAX_NEIGHBORS, "上限就是上限");
        assert!(!ids.contains(&"id00".to_string()), "应该挤掉最久没听到的");
        assert!(ids.contains(&"新来的".to_string()));
    }

    #[test]
    fn 剪枝之后不会误伤正在说话的邻居() {
        let n = Nearby::new();
        n.note("老的", "老的", addr(1), 1_000);
        n.note("新的", "新的", addr(2), 1_000 + NEARBY_TTL_MS + 1);
        let ids: Vec<String> = n
            .list(1_000 + NEARBY_TTL_MS + 1)
            .into_iter()
            .map(|n| n.node_id)
            .collect();
        assert_eq!(ids, vec!["新的".to_string()]);
    }

    #[test]
    fn 空node_id不收() {
        let n = Nearby::new();
        assert!(!n.note("", "谁", addr(1), 1_000));
        assert!(n.list(1_000).is_empty());
    }

    #[test]
    fn forget_之后立刻不在列表里() {
        let n = Nearby::new();
        n.note("aa", "台式机", addr(1), 1_000);
        n.forget("aa");
        assert!(n.list(1_000).is_empty());
    }

    #[test]
    fn 明文包这个集合不含地址公告() {
        // 守卫：Nearby 只该喂 Hello；这条断言钉住「明文」这个集合的边界，
        // 免得以后有人把 Addr 也塞进来（那会让已配对设备同时出现在两个列表里）。
        assert!(!WireKind::Addr.is_plain());
        assert!(WireKind::Hello.is_plain());
        assert!(WireKind::PinReq.is_plain());
        assert!(WireKind::PinResp.is_plain());
        assert!(WireKind::PinOk.is_plain());
    }
}
