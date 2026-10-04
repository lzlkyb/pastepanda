//! 设备信任表（免确认/禁止/自动接受）与同步配对 elevate。
//!
//! 2026-09-22 从 `service.rs` 平移（体量合规）。`use crate::rc::*` 沿用
//! `service/mod.rs` 的全部名字；方法体未改动，仅 `pub(super)` 方法
//! 升级为 `pub(in crate::rc)`（原语义就是「rc 子树可见」）。

use super::*;

const CFG_PEER_ADDRS: &str = "rc_peer_addrs";

/// 配对时收到的已签名地址供后续重连使用；无缓存时仍走 iroh 自带的地址发现。
fn saved_peer_addr(config: &serde_json::Value, peer: &str) -> Option<EndpointAddr> {
    let id = iroh::EndpointId::from_str(peer).ok()?;
    let value = config.get(CFG_PEER_ADDRS)?.get(peer)?.clone();
    let addr: EndpointAddr = serde_json::from_value(value).ok()?;
    (addr.id == id).then_some(addr)
}

#[cfg(test)]
mod short_pair_addr_tests {
    use super::*;

    #[test]
    fn saved_address_must_match_authenticated_device_id() {
        let peer = iroh::SecretKey::from_bytes(&[7; 32]).public().to_string();
        let other = iroh::SecretKey::from_bytes(&[8; 32]).public();
        let mut config = serde_json::json!({ "rc_peer_addrs": {} });
        config[CFG_PEER_ADDRS][peer.as_str()] = serde_json::to_value(EndpointAddr::new(other)).unwrap();
        assert!(saved_peer_addr(&config, &peer).is_none());
        let id = iroh::EndpointId::from_str(&peer).unwrap();
        config[CFG_PEER_ADDRS][peer.as_str()] = serde_json::to_value(EndpointAddr::new(id)).unwrap();
        assert_eq!(saved_peer_addr(&config, &peer).unwrap().id, id);
    }
}

impl RcService {
    pub(in crate::rc) fn peer_addr(&self, peer: &str, presence: &PresenceTable) -> Result<EndpointAddr, String> {
        let id = iroh::EndpointId::from_str(peer).map_err(|e| format!("设备号无效：{e}"))?;
        let config = self.store.get_config()?;
        let mut addr = self.joins.exchange_for(peer, now_ms()).and_then(|intent| intent.addr)
            .or_else(|| saved_peer_addr(&config, peer))
            .unwrap_or_else(|| EndpointAddr::new(id));
        for socket in presence.addrs_of(peer, now_ms()) {
            addr = addr.with_ip_addr(socket);
        }
        Ok(addr)
    }

    pub(in crate::rc) fn save_peer_addr(&self, peer: &str, addr: &EndpointAddr) -> Result<(), String> {
        if addr.id.to_string() != peer {
            return Err("设备地址与身份不一致".into());
        }
        let mut config = self.store.get_config()?;
        let obj = config.as_object_mut().ok_or("配置文件不是一个对象")?;
        let addrs = obj.entry(CFG_PEER_ADDRS).or_insert_with(|| serde_json::json!({}));
        let map = addrs.as_object_mut().ok_or("已保存的设备地址格式无效")?;
        map.insert(peer.to_string(), serde_json::to_value(addr).map_err(|e| e.to_string())?);
        self.store.save_config(&config)
    }

    pub fn forget_peer_addr(&self, peer: &str) -> Result<(), String> {
        let mut config = self.store.get_config()?;
        if let Some(map) = config.get_mut(CFG_PEER_ADDRS).and_then(|v| v.as_object_mut()) {
            map.remove(peer);
            self.store.save_config(&config)?;
        }
        Ok(())
    }
    pub fn joins(&self) -> Arc<RcJoins> {
        self.joins.clone()
    }

    pub(in crate::rc) fn cfg(&self) -> serde_json::Value {
        self.store.get_config().unwrap_or_default()
    }

    pub fn enabled(&self) -> bool {
        self.cfg()
            .get(CFG_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// 本机是否开了「会话期间防休眠」。唯一读取点在 `super::cfg_keep_awake`。
    pub fn keep_awake(&self) -> bool {
        super::cfg_keep_awake(&self.store)
    }

    pub fn max_capability(&self) -> Capability {
        self.cfg()
            .get(CFG_CAPABILITY)
            .and_then(|v| v.as_str())
            .and_then(Capability::parse)
            .unwrap_or(Capability::View)
    }

    pub fn device_deny(&self) -> HashMap<String, bool> {
        self.cfg()
            .get(CFG_DEVICE_DENY)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }

    /// 是否在**远程**配对表里。
    /// 是否在**远程**配对表里（只认 `rc_devices`，不含笔记同步表）。
    /// B-b：文件通道 / 免确认 / 自动收文件的准入判据。
    pub(in crate::rc) fn is_rc_paired(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(_)))
    }

    /// 远程信任：远程配对 **或** 同步配对（方案 A 单向继承）。
    ///
    /// 🔴 B-b（2026-09-20 拍板）：这条只用于「能不能敲门 / 列表可见」；
    ///    **文件通道与免确认/自动接收只认 `rc_devices`**（`is_rc_paired`）。
    ///    同步配对设备首次要通过会话批准 elevate 写入 rc 表后，才获得文件准入。
    pub fn has_remote_trust(&self, node_id: &str) -> bool {
        if self.is_rc_paired(node_id) {
            return true;
        }
        matches!(self.store.device_get(node_id), Ok(Some(_)))
    }

    /// 同步设备首次被**人工批准**远程会话时写入 rc_devices（幂等）。
    ///
    /// B-b：同意一次会话 = 用户确认「这台同步设备可以远程我」，此后它就是
    /// 正式远程设备（可开免确认 / 自动收文件）。不在敲门时自动 elevate。
    pub fn elevate_from_sync(&self, node_id: &str) -> Result<(), String> {
        if self.is_rc_paired(node_id) {
            return Ok(());
        }
        let name = self
            .store
            .device_get(node_id)
            .ok()
            .flatten()
            .map(|d| d.name)
            .unwrap_or_else(|| "同步设备".into());
        self.store.rc_device_pair(node_id, &name)
    }

    /// 方案 D：这台设备是否开了「免确认直连」。
    ///
    /// 只认 rc 配对表——仅同步配对、还没被远程用过的设备没有行可查，
    /// 视为未开启（合理：免确认的前提是这台设备已经用过至少一次远程）。
    pub fn device_trusted(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(d)) if d.trusted)
    }

    /// 决策 10：这台设备是否开了「自动接收文件」。
    ///
    /// 与 `device_trusted` 同一口径：只认 rc 配对表，仅同步配对、还没被远程用过
    /// 的设备没有行可查 → 视为未开启（合理：自动接收的前提是它已经用过至少一次）。
    pub fn device_auto_accept(&self, node_id: &str) -> bool {
        matches!(self.store.rc_device_get(node_id), Ok(Some(d)) if d.auto_accept)
    }

    /// 方案 D：设置「免确认直连」。仅同步配对的设备先幂等提升进 rc 表再设。
    ///
    /// 🔴 必须先确认**已配对**（rc 表或 sync 表有行）：对未知 id 不能顺手
    ///    `elevate_from_sync` ——那会凭空造出一行 rc 配对（名字「同步设备」）、
    ///    `has_remote_trust` 立刻变 true，等于绕过 SAS 配对把陌生设备放进白名单。
    pub fn set_device_trust(&self, node_id: &str, trusted: bool) -> Result<(), String> {
        if !self.has_remote_trust(node_id) {
            return Err("该设备尚未与本机配对，无法设置免确认".into());
        }
        self.elevate_from_sync(node_id)?;
        self.store.rc_device_trust_set(node_id, trusted)
    }

    /// 决策 10：设置「自动接收此设备推送的文件」。
    ///
    /// 前置条件与 `set_device_trust` 完全一致（要先是本机认可的设备），
    /// 少任何一个都会让开关在界面上点得动、却写不进去。
    ///
    /// 🔴 它只影响**要不要弹确认条**，不影响门禁：`gate_inbound` 一律先跑。
    /// 🔴 只对推送方向生效（对方发给我）。
    pub fn set_device_auto_accept(&self, node_id: &str, on: bool) -> Result<(), String> {
        if !self.has_remote_trust(node_id) {
            return Err("该设备尚未与本机配对，无法设置自动接收".into());
        }
        self.elevate_from_sync(node_id)?;
        self.store.rc_device_auto_accept_set(node_id, on)
    }

    pub(in crate::rc) fn peer_name(&self, node_id: &str) -> String {
        if let Ok(Some(d)) = self.store.rc_device_get(node_id) {
            return d.name;
        }
        if let Ok(Some(d)) = self.store.device_get(node_id) {
            return d.name;
        }
        String::new()
    }
}
