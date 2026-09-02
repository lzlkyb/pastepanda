//! 本机自有凭证的**哈希**登记处 —— 让剪贴板监听认得出「这是我们自己发的密钥」。
//!
//! # 解决的问题
//!
//! 用户从设置页拿走 MCP 令牌 / 局域网配对密钥时，剪贴板监听会把它
//! **明文**记进 `history` 表；开了局域网同步还会同步到其他设备。
//! 而 `mcp/token.rs` 与 `ai/secret_store.rs` 特意用 DPAPI 加密落盘，就是为了让
//! 这些东西永不明文着地 —— 一个复制动作就把那份用心全抵消了。
//!
//! # 为什么不能靠 `ContentClassifier::is_secret` 认出来
//!
//! 它的通用 base64 分支要求 `trimmed.len() % 4 == 0`，而 MCP 令牌是 **43 字符**
//! （32 字节 base64url 无填充），`43 % 4 == 3`，**永远不命中**；它也没有
//! `sk-` / `ghp_` 这类前缀，不是 JWT、不是 AKIA、不是 PEM。
//! 而且那条路还需要用户**开着**「跳过敏感内容」开关。
//!
//! 把令牌长度改成 4 的倍数去迎合那个启发式也不行：那只是赌一个启发式碰巧命中，
//! 且仍然受制于那个开关。
//!
//! # 为什么不能靠 `PasteSuppress`
//!
//! 那套是「应用自己写剪贴板前先报备哈希」。但局域网面板里的配对密钥是个
//! `readOnly` 输入框 + `onFocus` 全选，**用户按 Ctrl+C 是系统级复制**，
//! 应用根本没参与，也就没有报备的时机。
//!
//! # 所以在**记录处**认
//!
//! 不管这次复制是谁发起的，只要内容就是我们自己的凭证就不记。
//! **只存哈希，不存明文** —— 登记处自己不能变成第三份明文副本。

use std::sync::Mutex;

/// 登记位（每个用途一个，重新登记会覆盖旧值 —— 密钥轮换后旧哈希必须失效，
/// 否则用户真想复制一段恰好等于旧密钥的文本时会被莫名吞掉）。
pub const SLOT_MCP_TOKEN: &str = "mcp_token";
pub const SLOT_LAN_PAIRING: &str = "lan_pairing_key";

/// 太短的东西不登记。
///
/// 防的是退化情况：假如某个密钥因 bug 变成了 `"1"` 或空串，登记进去就会把
/// 用户真实复制的同名短文本一并吞掉，而且没任何提示。
const MIN_SECRET_LEN: usize = 12;

/// 全进程共一份。
///
/// 用 `static` 而不是把句柄一路传下去：记录点在 `clipboard_monitor` 的
/// `process_text` / `process_rich` / `process_doc` 里，那几个函数**已经被 clippy
/// 报了 `too many arguments`（8~9 个）**，再加一个参数是在加剧已知问题；
/// 而这东西天然就是进程全局的事实（本机当前的凭证），没有多实例语义。
///
/// `Vec` 而不是 `HashMap`：`Vec::new()` 是 const fn（能直接做 static 初值），
/// 而条目永远只有两三条，线性扫描比哈希表更快也更简单。
static SECRET_HASHES: Mutex<Vec<(&'static str, String)>> = Mutex::new(Vec::new());

/// 登记（或更新）一个位置上的凭证。传空串 = 注销该位置。
///
/// 调用时机：凭证**刚被读出或刚被生成**那一刻。放在那里而不是“界面显示时”，
/// 是因为用户可能先打开设置页、过一会儿才复制，也可能根本不经过界面。
pub fn register(slot: &'static str, secret: &str) {
    let secret = secret.trim();
    let Ok(mut guard) = SECRET_HASHES.lock() else {
        // 锁中毒时不静默（规则 #15.3）：后果是凭证会被记进历史。
        log::error!("[SecretRegistry] 登记锁已中毒，{} 未能登记", slot);
        return;
    };
    guard.retain(|(s, _)| *s != slot);
    if secret.len() >= MIN_SECRET_LEN {
        guard.push((slot, crate::hashing::md5_hex(secret.as_bytes())));
    } else if !secret.is_empty() {
        log::warn!(
            "[SecretRegistry] {} 的值短于 {} 字符，未登记（避免误吞用户的短文本）",
            slot,
            MIN_SECRET_LEN
        );
    }
}

/// 这段文本是不是我们自己的凭证。
///
/// 先 `trim` 再比：从输入框选中复制很容易带上尾随空白或换行，
/// 不归一化的话这个防护会在最常见的场景下静默失效。
pub fn is_own_secret(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() < MIN_SECRET_LEN {
        return false;
    }
    let hash = crate::hashing::md5_hex(trimmed.as_bytes());
    SECRET_HASHES
        .lock()
        .map(|g| g.iter().any(|(_, h)| *h == hash))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试共用进程全局登记处，用专用 slot 避免互相干扰。
    const SLOT_A: &str = "__test_a";
    const SLOT_B: &str = "__test_b";

    #[test]
    fn test_register_and_match() {
        let secret = "aaaabbbbccccddddeeee";
        register(SLOT_A, secret);
        assert!(is_own_secret(secret));
        // 尾随空白/换行仍要认得出——从输入框选中复制是最常见的路径
        assert!(is_own_secret(&format!("  {}\n", secret)));
        assert!(!is_own_secret("完全不相干的一段文字内容"));
        register(SLOT_A, "");
    }

    #[test]
    fn test_rotation_invalidates_old() {
        // 🔴 轮换后旧哈希必须失效：否则用户后来真想复制一段恰好等于旧密钥的
        // 文本时会被莫名吞掉，而且没任何提示。
        register(SLOT_B, "old-secret-0000000000");
        register(SLOT_B, "new-secret-1111111111");
        assert!(!is_own_secret("old-secret-0000000000"));
        assert!(is_own_secret("new-secret-1111111111"));
        register(SLOT_B, "");
        assert!(!is_own_secret("new-secret-1111111111"));
    }

    #[test]
    fn test_short_values_are_refused() {
        // 退化保护：密钥因 bug 变成 "1" 时不能把用户真实复制的 "1" 也吞掉
        register(SLOT_A, "short");
        assert!(!is_own_secret("short"));
        register(SLOT_A, "");
    }

    #[test]
    fn test_real_mcp_token_shape_is_matched() {
        // 🔴 回归护栏：这正是 `is_secret` 漏掉的那种形状
        // （43 字符 base64url 无填充，43 % 4 == 3，无前缀）。
        let token = "aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkk";
        assert_eq!(token.len(), 43);
        assert_ne!(token.len() % 4, 0, "这个形状才是重点：不是 4 的倍数");
        register(SLOT_A, token);
        assert!(is_own_secret(token));
        register(SLOT_A, "");
    }
}
