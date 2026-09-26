//! 远程协助的**已配对设备表**（方案 A）。
//!
//! 与 `devices`（知识库同步）**分开**：配对 = 认出这台机器（共用 NodeIdentity），
//! 同步 / 远程是两种各自授权的信任。一台机器可以只被允许远程、不参与笔记同步，
//! 也可以反过来。

use super::DataStore;
use serde::{Deserialize, Serialize};

/// 设备标签（2026-09-26 对齐稿①，RustDesk TagPainter 的本地对应物）。
/// `color` 是**色板键**（red/amber/green/cyan/blue/violet），不是任意 hex——
/// 颜色只能来自主题令牌是 V3 的硬要求，取值收口在前端 `lib/rcDeviceTags`，
/// 存储侧原样进 JSON 文本列，不做翻译。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceTag {
    pub name: String,
    pub color: String,
}

/// 一台已授权「可远程本机」的设备。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RcDevice {
    pub node_id: String,
    pub name: String,
    pub paired_at: String,
    /// 🔴 **仅供展示/调试，不得作为「在线」判定依据**（2026-09-21）。
    ///
    /// 存 `online` / `offline`，是「最后一次记录到的状态」——**历史快照，不是当前事实**。
    /// 判定在线请看 `rc::session::is_rc_online_for`（三条证据：presence live /
    /// 正在会话 / `last_seen` 窗口）。
    ///
    /// 为什么保留：`devices` 表有同名列，两侧结构对齐便于排查；且 `end_session`
    /// 会把它标回 offline（补平「只写 online」的不对称）。
    ///
    /// ❗ **任何判定都不要读它**——它在 2026-09-21 之前长期只写 online 从不写 offline，
    /// 读它必然产生假在线（见 `is_rc_online_for` 的说明与回归守卫
    /// `守卫_在线判定不得读conn_state`）。
    #[serde(default)]
    pub conn_state: String,
    #[serde(default)]
    pub last_seen: i64,
    /// 上一次会话**实测**走的路径（`lan` / `direct` / `relay`；空串 = 还没连过）。
    ///
    /// 🔴 这是实测值，不是推断。此前设备行只能拿「有没有听到局域网宣告」
    /// 去猜「大概走局域网还是中继」，跨网或组播被拦时必然猜错。
    /// 现在由 `end_session` 从活连接读一次写进来。
    #[serde(default)]
    pub last_path: String,
    /// 用户起的**本地备注名**（A1）。空串 = 没起过；
    /// 显示时 note 优先、`name`（对端自报 hostname）兜底。
    /// 🔴 只存在本机：不改对端自报的真名，也不随任何信令同步。
    #[serde(default)]
    pub note: String,
    /// 方案 D「免确认直连」：这台设备发起远程时**跳过人工同意**。
    /// 默认 `false`；逐台开关（无一键全开）；`device_deny` 优先级更高。
    #[serde(default)]
    pub trusted: bool,
    /// 决策 10「按设备记忆自动接收文件」：这台设备**推送**文件过来时跳过确认条。
    ///
    /// 默认 `false`（每次都问）。与 `trusted` 是**两件独立的事**：
    /// 前者管「要不要接管我的屏幕」，这条只管「要不要自动收下它发的文件」，
    /// 用户可以只允许后者。
    ///
    /// 🔴 它**只跳确认这一步，不跳门禁**：`gate_inbound`（是否允许该设备接入）
    ///    仍然先跑，被禁用/未配对的设备照样进不来。
    /// 🔴 只对「推送」方向有效。取回方向是「我挑文件发给对方」，没有可自动的东西。
    #[serde(default)]
    pub auto_accept: bool,
    /// 对端**自报的操作系统**短标签（`Windows 11` / `macOS` / `Linux`）。
    ///
    /// 来源：会话里对端发的 `Accept` 帧（`rc/protocol.rs` 的 `Accept::os`），
    /// 控制端收到即写（`service.rs` 的读帧分支）。空串 = 还没建立过会话，
    /// 或对端是旧版 / 采不到——显示层据空串**不渲染这一格**，不编默认值。
    ///
    /// 与 `last_path` 同款：这是**对端说的**，不是本机推断的；
    /// 同理它也不随任何配对信令同步（那些路径有多个承载点，见数据迁移处的说明）。
    #[serde(default)]
    pub os: String,
    /// 彩色标签（设备组织）。本机私产，不随任何信令同步；
    /// 上限/去重/色板白名单在写入前 `normalize_tags` 收口。
    #[serde(default)]
    pub tags: Vec<DeviceTag>,
    /// **描述性备注**长文本（「双 4K，走中继较卡」）。与 `note`（改名别名）
    /// 刻意分开：note 会进 display_name 顶替设备名，remark 只出现在悬停/详情。
    #[serde(default)]
    pub remark: String,
}

const COLS: &str =
    "node_id, name, note, paired_at, conn_state, last_seen, last_path, trusted, auto_accept, os, tags, remark";

/// 标签写入前的清洗（与前端 `lib/rcDeviceTags` 同口径，双保险）：
/// 名字 trim、空的丢、超 12 字截断、按名字去重、最多 6 个；色板外的键回落 blue。
pub fn normalize_tags(tags: Vec<DeviceTag>) -> Vec<DeviceTag> {
    const COLORS: [&str; 6] = ["red", "amber", "green", "cyan", "blue", "violet"];
    let mut out: Vec<DeviceTag> = Vec::new();
    for t in tags {
        let name: String = t.name.trim().chars().take(12).collect();
        if name.is_empty() || out.iter().any(|x| x.name == name) {
            continue;
        }
        let color = if COLORS.contains(&t.color.as_str()) {
            t.color
        } else {
            "blue".into()
        };
        out.push(DeviceTag { name, color });
        if out.len() >= 6 {
            break;
        }
    }
    out
}

fn row_to(r: &rusqlite::Row) -> rusqlite::Result<RcDevice> {
    let tags_raw: String = r.get(10)?;
    let tags: Vec<DeviceTag> =
        serde_json::from_str(&tags_raw).unwrap_or_else(|e| {
            log::warn!("[DataStore] rc_devices.tags 解析失败，按空处理: {e}");
            Vec::new()
        });
    Ok(RcDevice {
        node_id: r.get(0)?,
        name: r.get(1)?,
        note: r.get(2)?,
        paired_at: r.get(3)?,
        conn_state: r.get(4)?,
        last_seen: r.get(5)?,
        last_path: r.get(6)?,
        trusted: r.get::<_, i64>(7)? != 0,
        auto_accept: r.get::<_, i64>(8)? != 0,
        os: r.get(9)?,
        tags,
        remark: r.get(11)?,
    })
}

impl DataStore {
    /// 配对（或更新名字）。与同步的 `device_pair` 互不影响。
    pub fn rc_device_pair(&self, node_id: &str, name: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO rc_devices (node_id, name, paired_at, conn_state, last_seen)
             VALUES (?1, ?2, ?3, 'offline', 0)
             ON CONFLICT(node_id) DO UPDATE SET name = ?2",
            rusqlite::params![node_id, name, super::note::note_now()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    pub fn rc_device_list(&self) -> Result<Vec<RcDevice>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(&format!(
                "SELECT {} FROM rc_devices ORDER BY paired_at DESC",
                COLS
            ))
            .map_err(|e| e.to_string())?;
        let rows = st.query_map([], row_to).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn rc_device_get(&self, node_id: &str) -> Result<Option<RcDevice>, String> {
        let conn = self.lock_conn();
        let mut st = conn
            .prepare(&format!(
                "SELECT {} FROM rc_devices WHERE node_id = ?1",
                COLS
            ))
            .map_err(|e| e.to_string())?;
        let mut rows = st.query_map([node_id], row_to).map_err(|e| e.to_string())?;
        rows.next().transpose().map_err(|e| e.to_string())
    }

    pub fn rc_device_forget(&self, node_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM rc_devices WHERE node_id = ?1", [node_id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// 标设备为在线，并把 `last_seen` 刷成现在。
    ///
    /// ⚠️ 这是**唯一**该刷新 `last_seen` 的入口。它只应由**真实接触**调用：
    /// 会话建立 / 真握手成功 / 组播听见对端。**探测（probe）不许调它**——
    /// 探测是「此刻可达」的瞬时事实，不是「在线」这个持久状态，
    /// 写进去会制造假在线（2026-09-21 修复，见 `RcService::probe_peer` 的注释）。
    pub fn rc_device_touch(&self, node_id: &str, online: bool) -> Result<(), String> {
        let conn = self.lock_conn();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE rc_devices SET conn_state = ?2, last_seen = ?3 WHERE node_id = ?1",
            rusqlite::params![
                node_id,
                if online { "online" } else { "offline" },
                if online { now } else { 0i64 }
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 标设备为离线，**不动 `last_seen`**。
    ///
    /// # 为什么需要它（而不是 `rc_device_touch(x, false)`）
    ///
    /// `rc_device_touch(x, false)` 会把 `last_seen` 清成 0。这在会话收口时用是错的：
    /// 「会话结束」只是「**这次**接触结束了」，不代表「从未在线过」。清 0 的后果
    /// 是「上次在线」这句话永远显示不出来，且配合旧的判定逻辑会让设备**永远离线**
    /// （这正是 2026-09-21 之前那轮修复把 offline 写回整个删掉的原因——
    /// 它在两个错误极端之间来回摆）。
    ///
    /// 语义与 `devices` 表的 [`Self::device_mark_offline`] 对齐：**只动 `conn_state`**。
    /// 本方法与它是一对——那张表有的，这张表也要有，否则调用方没有正确的工具可用，
    /// 只能被迫用 `touch(x, false)` 或干脆不写。
    pub fn rc_device_mark_offline(&self, node_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE rc_devices SET conn_state = 'offline' WHERE node_id = ?1",
            rusqlite::params![node_id],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 记下本次会话**实测**走的路径（`lan` / `direct` / `relay`）。
    ///
    /// 空串会被忽略：`PathKind::None`（一条路都没通）不该覆盖上一次的有效实测，
    /// 否则失败一次就把设备行上的「上次走局域网直连」抹成空白。
    pub fn rc_device_note_path(&self, node_id: &str, path: &str) -> Result<(), String> {
        if path.is_empty() {
            return Ok(());
        }
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE rc_devices SET last_path = ?2 WHERE node_id = ?1",
            rusqlite::params![node_id, path],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 记下对端**自报**的操作系统短标签（会话 `Accept` 帧带来）。
    ///
    /// 空串会被忽略：对端是旧版（`Accept` 没有这个字段）或采不到时不该覆盖
    /// 上一次的有效值——否则升级前的最后一次会话会把设备行这一格抹白。
    /// 同 `rc_device_note_path` 的判据。
    ///
    /// 与 `note_set` / `auto_accept_set` 的「影响 0 行必须报错」**刻意不同**：
    /// 那两条是用户点了按钮、界面会 toast「已保存」，静默失效能骗出一个假确认；
    /// 这条是会话过程中后台顺手写的一笔，没有对应的用户动作，
    /// 且设备尚未落库（首次走无人值守码时可能还没写完）属正常竞态，
    /// 报错只会污染会话流程。
    pub fn rc_device_note_os(&self, node_id: &str, os: &str) -> Result<(), String> {
        if os.trim().is_empty() {
            return Ok(());
        }
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE rc_devices SET os = ?2 WHERE node_id = ?1",
            rusqlite::params![node_id, os.trim()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 方案 D：设置「免确认直连」。`false` 即恢复每次询问（开关可逆）。
    pub fn rc_device_trust_set(&self, node_id: &str, trusted: bool) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE rc_devices SET trusted = ?2 WHERE node_id = ?1",
            rusqlite::params![node_id, trusted as i64],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// 决策 10：设置「自动接收此设备推送的文件」。`false` 即恢复每次询问。
    ///
    /// 🔴 与 `trusted` 是两件独立的事：那条管「要不要接管我的屏幕」，
    ///    这条只管「要不要自动收下它发的文件」——可以只允许后者。
    /// 🔴 影响 0 行必须报错（照 `note_set` 的判据）：设备不在 `rc_devices` 表里时
    ///    静默 `Ok` 会让 UI 的开关**看起来打开了、实际没落库**，
    ///    下次进来又变回关——「成功了但没生效」比报错难查得多。
    ///    （`rc_device_trust_set` 是更早写的，还没这个守卫。）
    pub fn rc_device_auto_accept_set(&self, node_id: &str, on: bool) -> Result<(), String> {
        let conn = self.lock_conn();
        let changed = conn
            .execute(
                "UPDATE rc_devices SET auto_accept = ?2 WHERE node_id = ?1",
                rusqlite::params![node_id, on as i64],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("这台设备不在远程配对列表里（可能只做了同步配对，或已被忘记），设置未保存".into());
        }
        Ok(())
    }

    /// A1：设置本地备注名。空串 = 清除备注（回落显示对端自报名）。
    /// 🔴 刻意不写 `name`：那是对端自报的机器名，是核对身份的锚点，不许被覆盖。
    ///
    /// 🔴 影响 0 行必须报错：这台设备不在 `rc_devices` 表里（典型：只在同步
    ///    `devices` 表、或已被忘记）时，静默 `Ok` 会让界面 toast「备注已保存」
    ///    而列表毫无变化、再进来编辑框依旧是空的——「成功了但没生效」比报错难查得多。
    pub fn rc_device_note_set(&self, node_id: &str, note: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let changed = conn
            .execute(
                "UPDATE rc_devices SET note = ?2 WHERE node_id = ?1",
                rusqlite::params![node_id, note.trim()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("这台设备不在远程配对列表里（可能只做了同步配对，或已被忘记），备注未保存".into());
        }
        Ok(())
    }

    /// 设备彩色标签（2026-09-26 对齐稿①）。调用方传什么都先进 `normalize_tags`
    /// 清洗再落库——上限/去重/色板白名单不许绕过。空数组 = 清空。
    ///
    /// 🔴 影响 0 行必须报错（照 `note_set` 判据）：这是用户点按钮保存的组织信息，
    ///    静默 `Ok` 会骗出「已保存」的假确认。
    pub fn rc_device_tags_set(&self, node_id: &str, tags: Vec<DeviceTag>) -> Result<(), String> {
        let json = serde_json::to_string(&normalize_tags(tags)).map_err(|e| e.to_string())?;
        let conn = self.lock_conn();
        let changed = conn
            .execute(
                "UPDATE rc_devices SET tags = ?2 WHERE node_id = ?1",
                rusqlite::params![node_id, json],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("这台设备不在远程配对列表里（可能只做了同步配对，或已被忘记），标签未保存".into());
        }
        Ok(())
    }

    /// 描述性备注长文本。空串 = 清除。上限 200 字（超出截断而非报错，照 `normalize_note` 判据）。
    /// 🔴 影响 0 行必须报错，同 `tags_set`。
    pub fn rc_device_remark_set(&self, node_id: &str, remark: &str) -> Result<(), String> {
        let trimmed = remark.trim();
        let clipped: String = trimmed.chars().take(200).collect();
        let conn = self.lock_conn();
        let changed = conn
            .execute(
                "UPDATE rc_devices SET remark = ?2 WHERE node_id = ?1",
                rusqlite::params![node_id, clipped],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("这台设备不在远程配对列表里（可能只做了同步配对，或已被忘记），描述未保存".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> DataStore {
        DataStore::new(":memory:").expect("open store")
    }

    #[test]
    fn new_device_has_empty_last_path() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert_eq!(
            d.last_path, "",
            "还没连过就是空串——不能编一个默认值假装知道"
        );
    }

    #[test]
    fn note_path_roundtrips_and_overwrites() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_path("peer-a", "relay").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().last_path,
            "relay"
        );
        // 下一次会话走了局域网直连 → 覆盖旧值
        s.rc_device_note_path("peer-a", "lan").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().last_path, "lan");
    }

    #[test]
    fn empty_path_does_not_overwrite_measured() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_path("peer-a", "direct").unwrap();
        // `PathKind::None` 落成空串 ⇒ 必须忽略，否则失败一次就抹掉实测值
        s.rc_device_note_path("peer-a", "").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().last_path,
            "direct",
            "空路径（一条路都没通）不该覆盖上一次的有效实测"
        );
    }

    #[test]
    fn device_list_carries_last_path() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_path("peer-a", "lan").unwrap();
        let list = s.rc_device_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].last_path, "lan",
            "列表查询的 COLS 必须带上 last_path"
        );
    }

    /// 方案 D：默认关、可开可关（开关可逆，不是一次性决定）。
    #[test]
    fn trust_defaults_off_and_roundtrips() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        assert!(
            !s.rc_device_get("peer-a").unwrap().unwrap().trusted,
            "免确认必须默认关——这是方案 D 的红线之一"
        );
        s.rc_device_trust_set("peer-a", true).unwrap();
        assert!(s.rc_device_get("peer-a").unwrap().unwrap().trusted);
        s.rc_device_trust_set("peer-a", false).unwrap();
        assert!(!s.rc_device_get("peer-a").unwrap().unwrap().trusted);
    }

    /// 决策 10：自动接收必须默认关（红线②：不能默认静默写盘）、可开可关。
    #[test]
    fn auto_accept_defaults_off_and_roundtrips() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        assert!(
            !s.rc_device_get("peer-a").unwrap().unwrap().auto_accept,
            "自动接收必须默认关——默认开就是静默写盘，触红线②"
        );
        s.rc_device_auto_accept_set("peer-a", true).unwrap();
        assert!(s.rc_device_get("peer-a").unwrap().unwrap().auto_accept);
        s.rc_device_auto_accept_set("peer-a", false).unwrap();
        assert!(
            !s.rc_device_get("peer-a").unwrap().unwrap().auto_accept,
            "撤销必须真的生效（「可见可撤销」的撤销那一半）"
        );
    }

    /// 决策 10：`auto_accept` 与 `trusted` 必须**互不影响**——用户可以只允许
    /// 「自动收文件」而不允许「免确认接管屏幕」。一个字段当两个用就会串味。
    #[test]
    fn auto_accept与trusted是两件独立的事() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_auto_accept_set("peer-a", true).unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert!(d.auto_accept && !d.trusted, "只开自动收文件，不该顺带免确认接管");

        s.rc_device_trust_set("peer-a", true).unwrap();
        s.rc_device_auto_accept_set("peer-a", false).unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert!(d.trusted && !d.auto_accept, "关掉自动收文件，不该顺带关掉免确认");
    }

    /// 决策 10：`COLS` 必须带上 `auto_accept`——列表查询漏列会让 UI 永远显示「未开」，
    /// 而存储里其实是开的（开关看着没生效，最难查的那种）。
    #[test]
    fn device_list_carries_auto_accept() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_auto_accept_set("peer-a", true).unwrap();
        let list = s.rc_device_list().unwrap();
        assert_eq!(list.len(), 1);
        assert!(
            list[0].auto_accept,
            "列表查询的 COLS 必须带上 auto_accept"
        );
    }

    /// 🔴 影响 0 行必须报错（照 `note_set` 的判据）：否则 UI 开关显示「已开」，
    /// 存储里什么都没有，重启后又变回关。
    #[test]
    fn auto_accept_对不在表里的设备报错而不是静默成功() {
        let s = store();
        let err = s
            .rc_device_auto_accept_set("peer-only-sync", true)
            .expect_err("不在 rc 表里就必须显形，不能假装成功");
        assert!(
            err.contains("不在远程配对列表"),
            "报错要说清原因，不能只丢一个 SQL 错误：{err}"
        );
    }

    /// A1：备注名默认空、可写可清；清空 = 回落显示自报名。
    #[test]
    fn note_defaults_empty_and_roundtrips() {
        let s = store();
        s.rc_device_pair("peer-a", "DESKTOP-A").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().note,
            "",
            "没起过备注就是空串，显示层回落用 name"
        );
        s.rc_device_note_set("peer-a", "客厅的电脑").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().note,
            "客厅的电脑"
        );
        s.rc_device_note_set("peer-a", "").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().note, "");
    }

    /// A1：改备注不覆盖自报名；对端改名（重新配对/自报）也不冲掉本地备注。
    #[test]
    fn note_and_name_are_independent() {
        let s = store();
        s.rc_device_pair("peer-a", "DESKTOP-A").unwrap();
        s.rc_device_note_set("peer-a", "客厅的电脑").unwrap();
        // 对端重装后自报名变了 → 重新配对写入新 name
        s.rc_device_pair("peer-a", "DESKTOP-NEW").unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert_eq!(d.name, "DESKTOP-NEW");
        assert_eq!(d.note, "客厅的电脑", "配对更新只动 name，不动本地备注");
    }

    /// 🔴 影响 0 行必须报错：仅同步配对（只在 `devices` 表）或已被忘记的设备，
    /// UPDATE 不中任何行。静默 `Ok` 会让界面 toast「备注已保存」而列表毫无变化。
    #[test]
    fn note_对不在表里的设备报错而不是静默成功() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        let err = s
            .rc_device_note_set("peer-only-sync", "客厅")
            .expect_err("不在 rc 表里就必须显形，不能假装成功");
        assert!(
            err.contains("不在远程配对列表"),
            "报错要说清原因，不能只丢一个 SQL 错误：{err}"
        );
        // 已被忘记的设备同理
        s.rc_device_forget("peer-a").unwrap();
        assert!(s.rc_device_note_set("peer-a", "客厅").is_err());
    }

    /// os：默认空串（还没建立过会话）；写入后往返；**空串不覆盖已有值**。
    #[test]
    fn os_defaults_empty_and_empty_does_not_wipe_measured() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().os,
            "",
            "还没建立过会话就是空串——不能编一个「未知系统」当默认值"
        );
        s.rc_device_note_os("peer-a", "Windows 11").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().os, "Windows 11");
        // 对端换成旧版（Accept 不带 os）→ 空串必须忽略，不能抹掉上一次的有效值
        s.rc_device_note_os("peer-a", "").unwrap();
        s.rc_device_note_os("peer-a", "   ").unwrap();
        assert_eq!(
            s.rc_device_get("peer-a").unwrap().unwrap().os,
            "Windows 11",
            "空串（采不到 / 旧对端）不该覆盖上一次的有效实测"
        );
        // 对端重装换了系统 → 覆盖
        s.rc_device_note_os("peer-a", "macOS").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().os, "macOS");
    }

    /// 🔴 `COLS` 必须带上 `os`——列表查询漏列会让设备详情永远不显示系统，
    /// 而库里有值（同 `device_list_carries_auto_accept` 的教训，是最难查的一类）。
    #[test]
    fn device_list_carries_os() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_os("peer-a", "Windows 11").unwrap();
        let list = s.rc_device_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].os, "Windows 11", "列表查询的 COLS 必须带上 os");
    }

    /// 写入时 trim 两端空白（对端可能带来带空白的值）。
    #[test]
    fn os_写入时trim两端空白() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        s.rc_device_note_os("peer-a", "  Windows 11  ").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().os, "Windows 11");
    }

    /// 设备还没落库时写 os 是**静默 no-op**，不报错。
    ///
    /// 与 `note_set` / `auto_accept_set` 的「影响 0 行必须报错」刻意不同：
    /// 那两条是用户点了按钮、界面会 toast「已保存」，静默失效能骗出假确认；
    /// 这条是会话过程中后台顺手写的一笔（首次走无人值守码时设备可能还没写完），
    /// 报错只会污染会话流程。
    #[test]
    fn os_对不在表里的设备静默忽略而不是报错() {
        let s = store();
        assert!(
            s.rc_device_note_os("peer-only-sync", "Windows 11").is_ok(),
            "后台顺手写的字段，设备尚未落库属正常竞态，不该污染会话流程"
        );
    }

    fn tag(name: &str, color: &str) -> DeviceTag {
        DeviceTag { name: name.into(), color: color.into() }
    }

    /// 标签：默认空、写入往返、可清空；列表查询必须带上（COLS 漏列是最难查的静默失效）。
    #[test]
    fn tags_roundtrip_and_list_carries() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        assert!(s.rc_device_get("peer-a").unwrap().unwrap().tags.is_empty());
        s.rc_device_tags_set("peer-a", vec![tag("家用", "blue"), tag("装机", "amber")]).unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert_eq!(d.tags, vec![tag("家用", "blue"), tag("装机", "amber")]);
        let list = s.rc_device_list().unwrap();
        assert_eq!(list[0].tags.len(), 2, "列表查询的 COLS 必须带上 tags");
        s.rc_device_tags_set("peer-a", vec![]).unwrap();
        assert!(s.rc_device_get("peer-a").unwrap().unwrap().tags.is_empty());
    }

    /// 清洗不许绕过：空名丢、重名去重、超 6 截断、色板外回落 blue、超长名截断。
    #[test]
    fn tags_写入前清洗() {
        let s = store();
        s.rc_device_pair("peer-a", "A").unwrap();
        let many: Vec<DeviceTag> = (0..9)
            .map(|i| tag(&format!("标签{i}"), "magenta"))
            .chain(std::iter::once(tag("  ", "red")))
            .chain(std::iter::once(tag("标签0", "green")))
            .collect();
        s.rc_device_tags_set("peer-a", many).unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert_eq!(d.tags.len(), 6, "上限 6 个");
        assert!(d.tags.iter().all(|t| t.color == "blue"), "色板外必须回落 blue");
        assert_eq!(d.tags.iter().filter(|t| t.name == "标签0").count(), 1, "重名去重");
        s.rc_device_tags_set("peer-a", vec![tag(&"超".to_string().repeat(30), "red")]).unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().tags[0].name.chars().count(), 12);
    }

    #[test]
    fn tags_对不在表里的设备报错而不是静默成功() {
        let s = store();
        let err = s
            .rc_device_tags_set("peer-only-sync", vec![tag("家用", "blue")])
            .expect_err("不在 rc 表里就必须显形");
        assert!(err.contains("不在远程配对列表"), "报错要说清原因：{err}");
    }

    /// 描述备注：默认空、trim、200 字截断（超出截断而非报错，照 normalize_note 判据）、
    /// 与 note（改名别名）互不串扰。
    #[test]
    fn remark_roundtrips_and_clips_and_independent_of_note() {
        let s = store();
        s.rc_device_pair("peer-a", "DESKTOP-A").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().remark, "");
        s.rc_device_remark_set("peer-a", "  双 4K，走中继较卡  ").unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().remark, "双 4K，走中继较卡");
        s.rc_device_remark_set("peer-a", &"长".repeat(300)).unwrap();
        assert_eq!(s.rc_device_get("peer-a").unwrap().unwrap().remark.chars().count(), 200);
        s.rc_device_remark_set("peer-a", "").unwrap();
        let d = s.rc_device_get("peer-a").unwrap().unwrap();
        assert_eq!(d.remark, "");
        assert_eq!(d.name, "DESKTOP-A", "写 remark 不该碰 name");
        assert_eq!(d.note, "", "写 remark 不该碰改名别名 note");
        assert!(s.rc_device_remark_set("peer-only-sync", "x").is_err(), "影响 0 行必须报错");
    }
}
