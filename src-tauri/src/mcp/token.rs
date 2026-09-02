//! MCP 访问令牌：生成、DPAPI 加密落盘、读回。
//!
//! **为何不进 `config` 表**：那张表是明文 KV，而 `DataStore::save_config()`
//! 每次调用都会先把**全量配置明文**备份到 `config_backups/config_*.json`
//! 并保留最近 10 份。令牌一旦进那张表，后果不是「多一份明文」而是
//! 「**明文散 10 份，且重置后旧令牌不退休**」—— 与 AI API Key 同一个坑，
//! 参见 `ai::secret_store` 的头部注释。

use std::path::{Path, PathBuf};

use base64::Engine;

/// 应用级 entropy：与 AI Key 的不同，两边的 blob 互不能解开。
/// 改动它会使已存令牌失效（用户需重新拷一次令牌到 MCP 客户端），因此带版本后缀。
const ENTROPY: &[u8] = b"PastePanda.McpToken.v1";

/// 令牌文件名。必须与 `config_*.json` 的命名无交集，以免被配置备份轮换扫到。
const TOKEN_FILE: &str = "mcp_token.bin";

/// 令牌的原始随机字节数。256 bit 远超暴破阈值；编码后是 43 个 URL-safe 字符。
const TOKEN_BYTES: usize = 32;

/// 令牌文件路径。
pub fn token_path(app_dir: &Path) -> PathBuf {
    app_dir.join(TOKEN_FILE)
}

/// 生成一个新令牌字符串（不落盘）。
///
/// 用 `ring::rand::SystemRandom`（即操作系统 CSPRNG）而不是 `uuid::new_v4()`：
/// UUID v4 只有 122 bit 熵且带固定版本位，不是为当凭证设计的。
pub fn generate() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let rng = ring::rand::SystemRandom::new();
    let mut buf = [0u8; TOKEN_BYTES];
    rng.fill(&mut buf)
        .map_err(|_| "生成随机令牌失败（系统随机数源不可用）".to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

/// 把令牌加密后原子落盘。
fn save(app_dir: &Path, token: &str) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| format!("无法创建数据目录：{}", e))?;
    let cipher = crate::dpapi::protect(token.as_bytes(), ENTROPY)?;

    // 临时文件 + rename，避免写入中途崩溃留下半个令牌文件
    let path = token_path(app_dir);
    let tmp = app_dir.join(".mcp_token.tmp");
    std::fs::write(&tmp, &cipher).map_err(|e| format!("写入令牌临时文件失败：{}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存令牌失败：{}", e)
    })?;
    Ok(())
}

/// 读回令牌；不存在或解不开时自动生成一个新的并落盘。
///
/// 「解不开就重建」是故意的：令牌不是用户输入的秘密，丢了重发一个就行，
/// 而把服务卡在「令牌损坏」上只会让用户无法恢复。但重建会写 log，
/// 因为它意味着已配置的 MCP 客户端会突然 401（规则 #15.3：失败不静默）。
pub fn load_or_create(app_dir: &Path) -> Result<String, String> {
    let path = token_path(app_dir);
    if path.exists() {
        match std::fs::read(&path) {
            Ok(cipher) => match crate::dpapi::unprotect(&cipher, ENTROPY) {
                Ok(plain) => match String::from_utf8(plain) {
                    Ok(s) if !s.trim().is_empty() => {
                        let token = s.trim().to_string();
                        // 登记哈希，使用户拷走令牌时不会被剪贴板监听记成明文历史。
                        // 放在这里（读出即登记）而不是命令层：漏一条路径就是静默泄露。
                        crate::secret_registry::register(
                            crate::secret_registry::SLOT_MCP_TOKEN,
                            &token,
                        );
                        return Ok(token);
                    }
                    Ok(_) => log::warn!("[MCP] 令牌文件为空，将重新生成"),
                    Err(_) => log::warn!("[MCP] 令牌内容不是合法文本，将重新生成"),
                },
                Err(e) => log::warn!(
                    "[MCP] 令牌解密失败，将重新生成（已配置的客户端需重新填）：{}",
                    e
                ),
            },
            Err(e) => log::warn!("[MCP] 读取令牌文件失败，将重新生成：{}", e),
        }
    }
    let token = generate()?;
    save(app_dir, &token)?;
    crate::secret_registry::register(crate::secret_registry::SLOT_MCP_TOKEN, &token);
    log::info!("[MCP] 已生成新的访问令牌");
    Ok(token)
}

/// 强制重新生成并落盘，返回新令牌。旧令牌立即作废。
pub fn regenerate(app_dir: &Path) -> Result<String, String> {
    let token = generate()?;
    save(app_dir, &token)?;
    // 覆盖登记：旧令牌的哈希要同时失效，否则用户日后复制一段恰好等于
    // 旧令牌的文本会被莫名吞掉。
    crate::secret_registry::register(crate::secret_registry::SLOT_MCP_TOKEN, &token);
    log::info!("[MCP] 访问令牌已重置，旧令牌作废");
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pastepanda_mcp_token_test_{}", tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_generated_token_shape() {
        let a = generate().unwrap();
        let b = generate().unwrap();
        // 32 字节 → base64url 无填充 = 43 字符
        assert_eq!(a.len(), 43);
        assert_ne!(a, b, "两次生成不得相同");
        // 令牌要整条放进 HTTP 头，不能出现需转义的字符
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "令牌包含非 URL-safe 字符：{}",
            a
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_load_or_create_is_stable_then_regenerate_changes_it() {
        let dir = temp_dir("stable");
        let first = load_or_create(&dir).unwrap();
        // 重启进程不应换令牌，否则用户每次开机都要重配 MCP 客户端
        assert_eq!(load_or_create(&dir).unwrap(), first);

        let rotated = regenerate(&dir).unwrap();
        assert_ne!(rotated, first, "重置后必须是新令牌");
        assert_eq!(load_or_create(&dir).unwrap(), rotated);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_disk_content_is_not_plaintext() {
        // 本模块存在的全部理由：落盘字节里不能出现令牌明文
        let dir = temp_dir("not_plaintext");
        let token = load_or_create(&dir).unwrap();
        let raw = std::fs::read(token_path(&dir)).unwrap();
        let needle = token.as_bytes();
        assert!(
            !raw.windows(needle.len()).any(|w| w == needle),
            "令牌明文出现在磁盘文件里"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_corrupt_file_is_rebuilt_not_fatal() {
        // 令牌不是用户输入的秘密，损坏了重建就行；
        // 卡在这里只会让服务永久启不了。
        let dir = temp_dir("corrupt");
        std::fs::write(token_path(&dir), b"not a dpapi blob").unwrap();
        let token = load_or_create(&dir).unwrap();
        assert_eq!(token.len(), 43);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_token_file_name_is_outside_config_backup_rotation() {
        // 回归护栏：文件名必须与 config 备份的命名无交集
        let p = token_path(Path::new("C:/somewhere"));
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "mcp_token.bin");
        assert!(!name.starts_with("config_"));
        assert!(!name.ends_with(".json"));
    }
}
