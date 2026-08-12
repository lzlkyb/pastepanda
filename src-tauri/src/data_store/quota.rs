//! 免费额度账本（v6.9 签到送 token）：初始赠送 + 每日签到 + 兑换码 + 用量计量。
//!
//! **纯本地，无服务器**。上游为免费 API（agnes-2.5-flash），配额的意义是
//! 体验管理 + 合规护栏（保护免费 key 的 RPM），不是计费——所以本地可绕过是
//! 可接受取舍（绕过=白用免费资源，无金钱损失）。
//!
//! 规则（用户定稿 2026-08-11）：
//! - 初始 10 万 token
//! - 签到：第 1 天 2 万，每天 +1 万，第 4 天起封顶 5 万/天；
//!   连续签到 streak；`初始 + 签到累计 ≤ 100 万`
//! - 兑换码：离线验证（md5 类 HMAC 签名），**不设上限**（仅防数值溢出）
//! - 计量：仅内置服务商（builtin-agnes）调用扣减；每日用量上限 10 万
//!
//! 与自配服务商完全隔离（《PastePanda-签到送Token-规划.md》§10.11）：
//! 本模块只被 builtin-agnes 路径调用，其他 provider 一律不经过。

use super::*;

/// 初始赠送（token）
pub const INITIAL_GRANT: u64 = 100_000;
/// 签到累计上限：初始 + sign_added ≤ 100 万
pub const SIGN_CAP: u64 = 1_000_000;
/// 每日用量上限（合规护栏，保护免费 key）
pub const DAILY_SPEND_CAP: u64 = 100_000;
/// 签到基础奖励（第 1 天）
pub const SIGN_BASE: u64 = 20_000;
/// 连续签到每日递增
pub const SIGN_STEP: u64 = 10_000;
/// 签到单日封顶
pub const SIGN_MAX: u64 = 50_000;

/// 兑换码签名密钥（内置客户端，XOR 混淆存储见 `crate::mask`；可被逆向——
/// 免费场景接受；防普通用户猜码）
pub fn redeem_secret() -> String {
    const XOR: u8 = 0x5A;
    const BUF: &[u8] = &[
        0x2a, 0x3b, 0x29, 0x2e, 0x3f, 0x2a, 0x3b, 0x34, 0x3e, 0x3b, 0x77, 0x28, 0x3f, 0x3e,
        0x3f, 0x3f, 0x37, 0x77, 0x2c, 0x6b, 0x60, 0x60, 0x36, 0x35, 0x39, 0x3b, 0x36, 0x77,
        0x2b, 0x2f, 0x35, 0x2e, 0x3b,
    ];
    crate::mask::reveal_xor(BUF, XOR)
}
/// 兑换码前缀（P1 = 批次 1 格式）
pub const CODE_PREFIX: &str = "P1";

/// 签到的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignResult {
    pub ok: bool,
    pub reward: u64,
    pub streak: u32,
    pub reason: String,
}

/// 兑换码解析结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemPayload {
    pub batch: String,
    pub amount: u64,
    pub expiry: String,
}

/// 兑换结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResult {
    pub ok: bool,
    pub amount: u64,
    pub reason: String,
}

/// 前置检查被拒的原因（v6.9 缺陷修复：区分余额耗尽与每日上限，前端给不同引导）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaBlock {
    /// 余额为 0 → 引导签到 / 兑换
    Exhausted,
    /// 今日用量已达上限 → 提示明天再试
    DailyCap,
}

/// 前端展示的额度信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaInfo {
    pub device_id: String,
    /// 总余额（初始 + 签到 + 兑换）
    pub granted: u64,
    /// 签到累计部分
    pub sign_added: u64,
    /// 已消耗
    pub spent: u64,
    /// 剩余
    pub remaining: u64,
    pub sign_date: Option<String>,
    pub sign_streak: u32,
    pub can_sign: bool,
    pub today_spent: u64,
    pub daily_cap: u64,
    pub sign_cap: u64,
    pub redeemed_count: usize,
    /// 连续 7 天累计可得（固定值，UI 直接展示）
    pub week_total: u64,
}

/// 内部账本行（ai_quota 表单行，id=1）
#[derive(Debug, Clone, Default)]
struct QuotaRow {
    device_id: String,
    granted: u64,
    sign_added: u64,
    spent: u64,
    sign_date: Option<String>,
    sign_streak: u32,
    redeemed: Vec<String>,
    today: String,
    today_spent: u64,
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn today_compact() -> String {
    chrono::Local::now().format("%Y%m%d").to_string()
}

/// 类 HMAC 签名：md5(secret || payload || secret)，取前 8 位 hex。
/// 故意不用标准 HMAC：secret 本就内置客户端，安全性同为零，md5 足够防"猜码"，
/// 免去新增依赖。
fn sig_of(secret: &str, payload: &str) -> String {
    use md5::{Digest, Md5};
    let d = Md5::new()
        .chain_update(secret.as_bytes())
        .chain_update(payload.as_bytes())
        .chain_update(secret.as_bytes())
        .finalize();
    d.iter().take(4).map(|b| format!("{:02x}", b)).collect()
}

/// 生成兑换码（供开发者脚本/测试用）。码 = P1-<批次4><序号4><面额6><有效期8>-<签名8>
///
/// 序号(1~9999)是批量发码唯一性的关键：同批次同面额同有效期下,序号不同 → payload 不同
/// → 签名不同 → 码不同。无序号时(旧 18 位格式)同批次批量会生成一模一样的码,客户端
/// 按码幂等去重后只有第一个能兑换——G2 测试抓到的真实 bug。
pub fn generate_redeem_code(batch: &str, amount: u64, expiry: &str, secret: &str) -> String {
    generate_redeem_code_seq(batch, 1, amount, expiry, secret)
}

/// 带序号的生成版本(批量发码用,脚本侧按 1..N 递增)。
pub fn generate_redeem_code_seq(
    batch: &str,
    seq: u32,
    amount: u64,
    expiry: &str,
    secret: &str,
) -> String {
    let payload = format!(
        "{}{:04}{:06}{}",
        batch,
        seq.min(9999),
        amount.min(999_999),
        expiry
    );
    format!("{}-{}-{}", CODE_PREFIX, payload, sig_of(secret, &payload))
}

/// 离线验证兑换码：格式 / 签名 / 有效期。返回面额等载荷。
pub fn verify_redeem_code(code: &str, secret: &str) -> Option<RedeemPayload> {
    let trimmed = code.trim().to_uppercase();
    let parts: Vec<&str> = trimmed.split('-').collect();
    if parts.len() != 3 || parts[0] != CODE_PREFIX {
        return None;
    }
    let payload = parts[1];
    let sig = parts[2];
    // 新格式 22 位:批次4+序号4+面额6+有效期8;旧 18 位(无序号)仍接受(序号视为 0)
    let (batch, amount, expiry) = if payload.len() == 22 {
        (
            payload[0..4].to_string(),
            payload[8..14].parse::<u64>().ok()?,
            payload[14..22].to_string(),
        )
    } else if payload.len() == 18 {
        (
            payload[0..4].to_string(),
            payload[4..10].parse::<u64>().ok()?,
            payload[10..18].to_string(),
        )
    } else {
        return None;
    };
    if sig.to_lowercase() != sig_of(secret, payload) {
        return None;
    }
    if expiry < today_compact() {
        return None; // 已过期
    }
    if amount == 0 {
        return None;
    }
    Some(RedeemPayload { batch, amount, expiry })
}

impl DataStore {
    /// 读账本行（带锁版本：调用方必须已持有连接锁，供原子操作复用）。
    fn quota_row_locked(&self, conn: &rusqlite::Connection) -> Result<QuotaRow, String> {
        // 先尝试读：无行 = 首次使用（初始化）。同一把锁内完成，无二次加锁（死锁坑见历史）。
        conn.query_row(
            "SELECT device_id, granted, sign_added, spent, sign_date, sign_streak, redeemed, today, today_spent
             FROM ai_quota WHERE id = 1",
            [],
            |r| {
                Ok(QuotaRow {
                    device_id: r.get(0)?,
                    granted: r.get::<_, i64>(1)? as u64,
                    sign_added: r.get::<_, i64>(2)? as u64,
                    spent: r.get::<_, i64>(3)? as u64,
                    sign_date: r.get(4)?,
                    sign_streak: r.get::<_, i64>(5)? as u32,
                    redeemed: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                    today: r.get(7)?,
                    today_spent: r.get::<_, i64>(8)? as u64,
                })
            },
        )
        .map_err(|e| e.to_string())
        .or_else(|_| {
            // 首次：初始化账本（device_id + 初始 10 万）
            let device_id = uuid::Uuid::new_v4().to_string();
            let now = now_str();
            conn.execute(
                "INSERT INTO ai_quota (id, device_id, granted, sign_added, spent, sign_date, sign_streak, redeemed, today, today_spent, updated_at)
                 VALUES (1, ?1, ?2, 0, 0, NULL, 0, '[]', '', 0, ?3)",
                params![device_id, INITIAL_GRANT as i64, now],
            )
            .map_err(|e| e.to_string())?;
            Ok(QuotaRow {
                device_id,
                granted: INITIAL_GRANT,
                sign_added: 0,
                spent: 0,
                sign_date: None,
                sign_streak: 0,
                redeemed: Vec::new(),
                today: String::new(),
                today_spent: 0,
            })
        })
    }

    /// 读账本行（不存在则初始化）。
    fn quota_row(&self) -> Result<QuotaRow, String> {
        let conn = self.lock_conn();
        self.quota_row_locked(&conn)
    }

    /// 写账本行（带锁版本：调用方必须已持有连接锁，供原子操作复用）。
    fn save_quota_locked(&self, conn: &rusqlite::Connection, row: &QuotaRow) -> Result<(), String> {
        conn.execute(
            "UPDATE ai_quota SET granted=?1, sign_added=?2, spent=?3, sign_date=?4, sign_streak=?5, redeemed=?6, today=?7, today_spent=?8, updated_at=?9 WHERE id=1",
            params![
                row.granted as i64,
                row.sign_added as i64,
                row.spent as i64,
                row.sign_date,
                row.sign_streak as i64,
                serde_json::to_string(&row.redeemed).unwrap_or_else(|_| "[]".into()),
                row.today,
                row.today_spent as i64,
                now_str(),
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    // （原有的 `save_quota()` 自己加一把锁再写，已删：它只被签到/兑换用过，
    //   而那两处正是因为“读完释锁、写时重新加锁”而丢更新的。留着它等于给
    //   下一个写入点准备好了同一个陷——所有写入一律走 `save_quota_locked`。）

    /// 额度总览（前端 QuotaDialog/浮窗用）。
    pub fn quota_get(&self) -> Result<QuotaInfo, String> {
        let row = self.quota_row()?;
        let today = today_str();
        let can_sign = row.sign_date.as_deref() != Some(today.as_str());
        // 连续 7 天可得 = 2+3+4+5+5+5+5
        let week_total = SIGN_BASE + (SIGN_BASE + SIGN_STEP) + (SIGN_BASE + 2 * SIGN_STEP) + 4 * SIGN_MAX;
        Ok(QuotaInfo {
            device_id: row.device_id.clone(),
            granted: row.granted,
            sign_added: row.sign_added,
            spent: row.spent,
            remaining: row.granted,
            sign_date: row.sign_date,
            sign_streak: row.sign_streak,
            can_sign,
            today_spent: if row.today == today { row.today_spent } else { 0 },
            daily_cap: DAILY_SPEND_CAP,
            sign_cap: SIGN_CAP,
            redeemed_count: row.redeemed.len(),
            week_total,
        })
    }

    /// 每日签到。返回本次奖励与实际连续天数。
    ///
    /// **单锁原子**（同 `quota_spend`）：读-改-写全程持同一把连接锁。
    /// 之前用 `quota_row()` / `save_quota()`（各自加锁再释放），两次并发签到
    /// （双击按钮、或悬浮球与面板各点一次）会都读到“今天未签”，各自
    /// `granted +=`，白送一次奖励且 `sign_streak` 多加一天。
    pub fn quota_sign(&self) -> Result<SignResult, String> {
        let conn = self.lock_conn();
        let mut row = self.quota_row_locked(&conn)?;
        let today = today_str();
        if row.sign_date.as_deref() == Some(today.as_str()) {
            return Ok(SignResult {
                ok: false,
                reward: 0,
                streak: row.sign_streak,
                reason: "今日已签到".to_string(),
            });
        }
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let streak = if row.sign_date.as_deref() == Some(yesterday.as_str()) {
            row.sign_streak + 1
        } else {
            1
        };
        let reward = (SIGN_BASE + (streak as u64 - 1) * SIGN_STEP).min(SIGN_MAX);
        // 封顶：初始 + 签到累计 ≤ 100 万（超出部分裁剪，streak 照常累计）
        let headroom = SIGN_CAP
            .saturating_sub(INITIAL_GRANT)
            .saturating_sub(row.sign_added);
        let actual = reward.min(headroom);

        row.sign_added += actual;
        row.granted += actual;
        row.sign_date = Some(today.clone());
        row.sign_streak = streak;
        self.save_quota_locked(&conn, &row)?;
        Ok(SignResult {
            ok: true,
            reward: actual,
            streak,
            reason: if actual < reward {
                "签到累计已达 100 万上限，本次部分到账".to_string()
            } else {
                "ok".to_string()
            },
        })
    }

    /// 兑换码激活（离线验证 + 本地幂等）。不设上限（仅数值安全上限）。
    pub fn quota_redeem(&self, code: &str) -> Result<RedeemResult, String> {
        let payload = match verify_redeem_code(code, &redeem_secret()) {
            Some(p) => p,
            None => {
                return Ok(RedeemResult {
                    ok: false,
                    amount: 0,
                    reason: "无效或已过期的兑换码".to_string(),
                })
            }
        };
        // 单锁原子（同 `quota_spend` / `quota_sign`）：否则并发兑换**同一个码**时
        // 两次都能通过下面的“已使用过”检查，一张码兑出两份额度。
        // 验签（md5）故意放在加锁之前，不把计算包在锁内。
        let conn = self.lock_conn();
        let mut row = self.quota_row_locked(&conn)?;
        let key = format!("{}:{}", payload.batch, code.trim().to_uppercase());
        if row.redeemed.iter().any(|c| c == &key) {
            return Ok(RedeemResult {
                ok: false,
                amount: 0,
                reason: "该兑换码已使用过".to_string(),
            });
        }
        // 兑换**不受额度上限**（与签到不同：签到受 SIGN_CAP 100 万约束）。
        // 这里只需防 u64 溢出：面额最多 6 位（≤999999，见 generate_redeem_code_seq），
        // 要溢出得兑上万亿次，saturating_add 兜住就够。
        //
        // 原先写的是 `amount.min(SAFETY_CAP - granted)`（SAFETY_CAP = 1 亿）：granted
        // 一旦撞到 1 亿，add 就变 0，而代码照样 push 进 redeemed 并返回
        // ok:true / amount:0——用户看到“兑换成功”、额度没变，码却永久作废且
        // 本地记录说“已使用过”，无法申诉。去掉夹取后这条路径不存在了
        // （verify_redeem_code 已保证 amount >= 1，所以 add 恒 > 0）。
        let add = payload.amount;
        row.granted = row.granted.saturating_add(add);
        row.redeemed.push(key);
        self.save_quota_locked(&conn, &row)?;
        Ok(RedeemResult {
            ok: true,
            amount: add,
            reason: "ok".to_string(),
        })
    }

    /// 计量扣减（仅 builtin-agnes 调用后调用）。
    /// 返回 Err 表示超额拒绝（每日上限或余额不足）。
    /// **单锁原子**：读-改-写在同一把连接锁内完成，避免并发扣减丢更新（v6.9 缺陷修复）。
    pub fn quota_spend(&self, tokens: u64) -> Result<(), String> {
        let conn = self.lock_conn();
        let mut row = self.quota_row_locked(&conn)?;
        let today = today_str();
        if row.today != today {
            row.today = today.clone();
            row.today_spent = 0;
        }
        if row.today_spent + tokens > DAILY_SPEND_CAP {
            return Err("今日免费额度用量已达上限".to_string());
        }
        if row.granted < tokens {
            return Err("免费额度不足".to_string());
        }
        row.granted -= tokens;
        row.spent += tokens;
        row.today_spent += tokens;
        self.save_quota_locked(&conn, &row)?;
        Ok(())
    }

    /// 前置检查（调用前）：余额 > 0 且未超每日上限。
    /// 返回细分原因，供 ai_run 转成对应引导（余额耗尽 → 签到/兑换；每日上限 → 明天再试）。
    pub fn quota_check(&self) -> Result<(), QuotaBlock> {
        let row = self.quota_row().map_err(|_| QuotaBlock::Exhausted)?;
        let today = today_str();
        let today_spent = if row.today == today { row.today_spent } else { 0 };
        if today_spent >= DAILY_SPEND_CAP {
            return Err(QuotaBlock::DailyCap);
        }
        if row.granted == 0 {
            return Err(QuotaBlock::Exhausted);
        }
        Ok(())
    }

    /// 是否有足够额度（供 ai_run 前置检查；不扣减）。
    pub fn quota_remaining(&self) -> u64 {
        self.quota_row().map(|r| r.granted).unwrap_or(0)
    }

    /// 今日已用（前端展示）
    pub fn quota_today_spent(&self) -> u64 {
        let row = match self.quota_row() {
            Ok(r) => r,
            Err(_) => return 0,
        };
        if row.today == today_str() {
            row.today_spent
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> DataStore {
        DataStore::new(":memory:").expect("无法创建内存数据库")
    }

    /// 兑换**不受额度上限**：累计越过原先那个 1 亿"安全上限"后仍应足额到账。
    ///
    /// 回归点：原实现是 `amount.min(SAFETY_CAP - granted)`，granted 撞到 1 亿后
    /// add 变 0，却照样把码写进 redeemed 并返回 ok:true / amount:0——
    /// 用户看到"兑换成功"、额度没变，而这张码永久作废。
    #[test]
    fn test_redeem_not_capped() {
        let s = store();
        let secret = redeem_secret();
        let base = s.quota_get().expect("总览").granted;
        let mut total = 0u64;
        // 101 张 999999 面额 → 累计 > 1 亿，必然越过旧的 SAFETY_CAP
        for seq in 1..=101u32 {
            let code = generate_redeem_code_seq("CAPT", seq, 999_999, "20991231", &secret);
            let r = s.quota_redeem(&code).expect("兑换不应报错");
            assert!(r.ok, "第 {seq} 张应成功，实际：{}", r.reason);
            assert_eq!(r.amount, 999_999, "第 {seq} 张应足额到账，不被夹取");
            total += r.amount;
        }
        assert_eq!(
            s.quota_get().expect("总览").granted,
            base + total,
            "额度应等于初始 + 全部面额之和"
        );
    }

    /// 并发兑换：总额必须精确，且不得死锁。
    ///
    /// 诚实说明它能与不能担保什么：
    /// - **能**：钉住本次改动最大的风险——`quota_redeem` 现在全程持锁，如果
    ///   `quota_row_locked` / `save_quota_locked` 里有任何一处重新 `lock_conn()`，
    ///   `std::sync::Mutex` 不可重入，这个测试会直接挂死。
    /// - **不能**：证明丢更新已修。旧写法的竞争窗口（读完释锁到重新加锁）极短，
    ///   这个测试在旧代码上大概率也会过。原子性靠的是代码结构（单一 `_locked`
    ///   写入口），不是这条测试。
    #[test]
    fn test_concurrent_redeem_no_lost_update() {
        use std::sync::Arc;
        let s = Arc::new(store());
        let secret = redeem_secret();
        let base = s.quota_get().expect("总览").granted;
        let codes: Vec<String> = (1..=40u32)
            .map(|seq| generate_redeem_code_seq("CONC", seq, 1_000, "20991231", &secret))
            .collect();
        let mut hs = Vec::new();
        for chunk in codes.chunks(10) {
            let s2 = Arc::clone(&s);
            let batch: Vec<String> = chunk.to_vec();
            hs.push(std::thread::spawn(move || {
                for c in batch {
                    let _ = s2.quota_redeem(&c);
                }
            }));
        }
        for h in hs {
            h.join().expect("线程不应 panic");
        }
        assert_eq!(
            s.quota_get().expect("总览").granted,
            base + 40 * 1_000,
            "40 张 1000 面额并发兑换后总额必须精确"
        );
    }
}
