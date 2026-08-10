//! API Key 存储：DPAPI 加密 + 独立文件。
//!
//! **为什么不用 `config` 表**：那张表是明文 KV，而且 `DataStore::save_config()`
//! 每次调用都会先跑一遍 `backup_config()`，把**全量配置明文**写到
//! `config_backups/config_*.json` 并保留最近 10 份。所以 Key 一旦进那张表，
//! 后果不是“多一份明文”而是“**明文散 10 份，且换 Key 后旧 Key 不退休**”。
//!
//! DPAPI（`CryptProtectData`）按**当前 Windows 用户**加密，换用户或换机器都解不开；
//! 另加一个应用级 entropy，使别的程序即使拿到字节也不能直接调 DPAPI 解开。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// 审查 backlog：#12 已配置服务商列表缓存 —— 每个密钥文件都要 DPAPI 解密判断，
/// 设置页每次打开/状态刷新都会调，5 秒内且目录未变时直接复用。
static CONFIGURED_CACHE: Mutex<Option<(SystemTime, Instant, Vec<String>)>> = Mutex::new(None);
const CONFIGURED_TTL: Duration = Duration::from_secs(5);

fn configured_providers_compute(app_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(app_dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_prefix("ai_key_")?.strip_suffix(".bin")?.to_string();
            // 真去解一次：文件在但解不开（拷自其他机器）不算已配置
            if has_key(app_dir, &id) {
                Some(id)
            } else {
                None
            }
        })
        .collect();
    ids.sort();
    ids
}

/// 应用级 entropy：防止别的进程拿走 blob 后直接 CryptUnprotectData。
/// 改动它会使已存的 Key 全部失效（用户需重新输入），因此带了版本后缀。
const ENTROPY: &[u8] = b"PastePanda.AiKey.v1";

/// 旧版的单密钥文件名。保留仅为了迁移。
const LEGACY_KEY_FILE: &str = "ai_key.bin";

/// 把厂商 id 洗成安全的文件名片段。
///
/// 厂商 id 来自内置表（全是 `[a-z-]`），但这里不依赖那个前提——
/// 万一以后厂商 id 变成用户可填，一个 `../` 就能写到目录外面去。
fn sanitize(provider: &str) -> String {
    let cleaned: String = provider
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

/// 密钥文件路径（与数据库同目录，但不入 config 表、不入 config_backups）。
///
/// **每个厂商一个文件**：切厂商时不用重新输入密钥，已存的会自动生效。
pub fn key_path(app_dir: &Path, provider: &str) -> PathBuf {
    app_dir.join(format!("ai_key_{}.bin", sanitize(provider)))
}

#[cfg(windows)]
mod dpapi {
    use super::ENTROPY;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    /// 把切片包成 DPAPI 的 BLOB。注意：pbData 是借用，调用期间原切片必须存活。
    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// 把 DPAPI 输出拷贝成 Vec 并释放它分配的内存。
    ///
    /// # Safety
    /// 仅允许对 CryptProtectData / CryptUnprotectData 成功返回的 out 调用一次。
    unsafe fn take_blob(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() || out.cbData == 0 {
            return Vec::new();
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        // windows 0.58 的 LocalFree 接 `impl Param<HLOCAL>`，不是 Option
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
        v
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(plain);
            let entropy = blob(ENTROPY);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(
                &input,
                PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                0,
                &mut out,
            )
            .map_err(|e| format!("DPAPI 加密失败：{}", e))?;
            Ok(take_blob(out))
        }
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(cipher);
            let entropy = blob(ENTROPY);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                0,
                &mut out,
            )
            .map_err(|e| format!("DPAPI 解密失败（密钥可能来自其他用户或其他机器）：{}", e))?;
            Ok(take_blob(out))
        }
    }
}

#[cfg(not(windows))]
mod dpapi {
    // 非 Windows 平台不提供回退的“明文存盘”实现——宁可不能用，不能默默地把密钥落成明文。
    pub fn protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
        Err("当前平台不支持密钥加密存储".to_string())
    }
    pub fn unprotect(_cipher: &[u8]) -> Result<Vec<u8>, String> {
        Err("当前平台不支持密钥加密存储".to_string())
    }
}

/// 写入某厂商的密钥（加密后原子落盘）。传空串等于清除。
pub fn save_key(app_dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return clear_key(app_dir, provider);
    }

    std::fs::create_dir_all(app_dir).map_err(|e| format!("无法创建数据目录：{}", e))?;
    let cipher = dpapi::protect(key.as_bytes())?;

    // 临时文件 + rename，避免写入中途崩溃留下半个密钥文件
    let path = key_path(app_dir, provider);
    let tmp = app_dir.join(format!(".ai_key_{}.tmp", sanitize(provider)));
    std::fs::write(&tmp, &cipher).map_err(|e| format!("写入密钥临时文件失败：{}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存密钥失败：{}", e)
    })?;
    Ok(())
}

/// 把旧版的单密钥文件归到当前厂商名下。
///
/// 旧版只存一把 Key，无法知道它属于哪家——只能归给当前选中的厂商，
/// 这在绝大多数情况下是对的（用户只配过一家）。迁完就删，只跑一次。
fn migrate_legacy(app_dir: &Path, provider: &str) {
    let legacy = app_dir.join(LEGACY_KEY_FILE);
    if !legacy.exists() {
        return;
    }
    let target = key_path(app_dir, provider);
    if target.exists() {
        // 当前厂商已有新格式密钥，旧文件直接删掉
        let _ = std::fs::remove_file(&legacy);
        return;
    }
    match std::fs::rename(&legacy, &target) {
        Ok(()) => log::info!("[AI] 已将旧密钥文件迁移到厂商 {}", provider),
        Err(e) => log::warn!("[AI] 旧密钥文件迁移失败：{}", e),
    }
}

/// 读回某厂商的密钥明文。**仅限后端内部调用**，不得经命令层暴露给前端。
pub fn load_key(app_dir: &Path, provider: &str) -> Result<Option<String>, String> {
    migrate_legacy(app_dir, provider);
    let path = key_path(app_dir, provider);
    if !path.exists() {
        return Ok(None);
    }
    let cipher = std::fs::read(&path).map_err(|e| format!("读取密钥文件失败：{}", e))?;
    let plain = dpapi::unprotect(&cipher)?;
    let key = String::from_utf8(plain).map_err(|_| "密钥内容不是合法文本".to_string())?;
    let key = key.trim().to_string();
    if key.is_empty() {
        Ok(None)
    } else {
        Ok(Some(key))
    }
}

/// 是否存在**可用的**密钥。
///
/// 故意去真解密一次，而不是只看文件在不在：文件被拷贝自其他用户/机器时 DPAPI 解不开，
/// 此时告诉界面“已配置”只会让用户对着一个永远失败的按钮发懵。
pub fn has_key(app_dir: &Path, provider: &str) -> bool {
    matches!(load_key(app_dir, provider), Ok(Some(_)))
}

/// 列出所有**已配置且可解开**密钥的厂商 id。
///
/// 界面用它在厂商下拉里标出“已配置”，让用户知道切过去不用重新输入。
pub fn configured_providers(app_dir: &Path) -> Vec<String> {
    let dir_mtime = std::fs::metadata(app_dir).and_then(|m| m.modified()).ok();
    if let Ok(mut guard) = CONFIGURED_CACHE.lock() {
        if let Some((mt, at, ids)) = guard.as_ref() {
            if at.elapsed() < CONFIGURED_TTL && dir_mtime.as_ref() == Some(mt) {
                return ids.clone();
            }
        }
        let ids = configured_providers_compute(app_dir);
        if let Some(mt) = dir_mtime {
            *guard = Some((mt, Instant::now(), ids.clone()));
        }
        return ids;
    }
    configured_providers_compute(app_dir)
}

/// 删除某厂商的密钥文件（不存在也算成功）。
pub fn clear_key(app_dir: &Path, provider: &str) -> Result<(), String> {
    let path = key_path(app_dir, provider);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除密钥失败：{}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用临时目录，避免碰真实的应用数据目录
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pastepanda_ai_key_test_{}", tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg(windows)]
    fn test_save_load_round_trip() {
        let dir = temp_dir("round_trip");
        assert!(!has_key(&dir, "deepseek"), "初始应无密钥");

        save_key(&dir, "deepseek", concat!("sk", "-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA")).unwrap();
        assert!(has_key(&dir, "deepseek"));
        assert_eq!(
            load_key(&dir, "deepseek").unwrap().as_deref(),
            Some(concat!("sk", "-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"))
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_keys_are_isolated_per_provider() {
        // 这是“切厂商不用重输密钥”的根据：两家各存各的，互不覆盖
        let dir = temp_dir("per_provider");
        save_key(&dir, "deepseek", "sk-deepseek-xxxxxxxxxxxx").unwrap();
        save_key(&dir, "qwen", "sk-qwen-yyyyyyyyyyyy").unwrap();

        assert_eq!(
            load_key(&dir, "deepseek").unwrap().as_deref(),
            Some("sk-deepseek-xxxxxxxxxxxx")
        );
        assert_eq!(
            load_key(&dir, "qwen").unwrap().as_deref(),
            Some("sk-qwen-yyyyyyyyyyyy")
        );

        // 已配置列表应该同时列出两家
        let configured = configured_providers(&dir);
        assert!(configured.contains(&"deepseek".to_string()));
        assert!(configured.contains(&"qwen".to_string()));

        // 删一家不影响另一家
        clear_key(&dir, "deepseek").unwrap();
        assert!(!has_key(&dir, "deepseek"));
        assert!(has_key(&dir, "qwen"), "删 deepseek 不应连带删掉 qwen");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_legacy_single_key_is_migrated() {
        // 旧版只存一把 ai_key.bin，升级后不能让用户重新输入
        let dir = temp_dir("legacy");
        // 先用新 API 写一把，再把文件改回旧名，模拟升级前的现场
        save_key(&dir, "deepseek", "sk-legacy-000000000000").unwrap();
        std::fs::rename(key_path(&dir, "deepseek"), dir.join(LEGACY_KEY_FILE)).unwrap();
        assert!(!key_path(&dir, "deepseek").exists());

        // 读当前厂商时应自动迁移
        assert_eq!(
            load_key(&dir, "deepseek").unwrap().as_deref(),
            Some("sk-legacy-000000000000")
        );
        assert!(key_path(&dir, "deepseek").exists(), "应迁到新文件名");
        assert!(!dir.join(LEGACY_KEY_FILE).exists(), "迁完应删掉旧文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_disk_content_is_not_plaintext() {
        // 这是本模块存在的全部理由：落盘的字节里不能出现明文密钥
        let dir = temp_dir("not_plaintext");
        let secret = concat!("sk", "-proj-SUPERSECRETVALUE1234567890");
        save_key(&dir, "openai", secret).unwrap();

        let raw = std::fs::read(key_path(&dir, "openai")).unwrap();
        let needle = secret.as_bytes();
        assert!(
            !raw.windows(needle.len()).any(|w| w == needle),
            "密钥明文出现在磁盘文件里"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(windows)]
    fn test_clear_and_empty_key() {
        let dir = temp_dir("clear");
        save_key(&dir, "zhipu", concat!("glpat-", "ABCDEFGHIJKLMNOPQRST")).unwrap();
        assert!(has_key(&dir, "zhipu"));

        clear_key(&dir, "zhipu").unwrap();
        assert!(!has_key(&dir, "zhipu"));
        assert_eq!(load_key(&dir, "zhipu").unwrap(), None);

        // 重复清除不应报错
        clear_key(&dir, "zhipu").unwrap();

        // 写空串 == 清除
        save_key(&dir, "zhipu", concat!("xoxb-", "1234567890-ABCDEFG")).unwrap();
        assert!(has_key(&dir, "zhipu"));
        save_key(&dir, "zhipu", "   ").unwrap();
        assert!(!has_key(&dir, "zhipu"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_key_path_is_outside_config_table() {
        // 回归护栏：密钥文件名必须与 config 备份的命名无交集，
        // 确保它永远不会被 backup_config 的轮换逻辑扫到
        let p = key_path(Path::new("C:/somewhere"), "deepseek");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "ai_key_deepseek.bin");
        assert!(!name.starts_with("config_"));
        assert!(!name.ends_with(".json"));
    }

    #[test]
    fn test_sanitize_blocks_path_traversal() {
        // 厂商 id 目前来自内置表，但不能依赖这个前提：
        // 一个 ../ 就能把密钥写到数据目录外面去
        let p = key_path(Path::new("C:/data"), "../../evil");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "ai_key_evil.bin");
        assert!(!name.contains(".."));
        assert!(!name.contains('/'));

        // 全是非法字符时不能退化成空文件名
        assert_eq!(sanitize("///"), "unknown");
        assert_eq!(sanitize("DeepSeek"), "deepseek");
    }
}
