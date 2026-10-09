//! AES-GCM blobs; the master key is kept in macOS Keychain, never beside SQLite.
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};

use std::sync::Mutex;

const PREFIX: &[u8] = b"PPMAC1";
const NOT_FOUND: i32 = -25300;
const DUPLICATE: i32 = -25299;
extern "C" {
    fn pp_mac_keychain_read(key: *mut u8, capacity: usize) -> i32;
    fn pp_mac_keychain_create(key: *const u8, length: usize) -> i32;
}
/// Serialize key loading. Keychain calls are noninteractive, including the first call.
#[derive(Default)]
struct KeyCache {
    key: Option<[u8; 32]>,
}
impl KeyCache {
    fn get(
        &mut self,
        create: bool,
        load: impl FnOnce(bool) -> Result<[u8; 32], String>,
    ) -> Result<[u8; 32], String> {
        if let Some(key) = self.key {
            return Ok(key);
        }
        let key = load(create)?;
        self.key = Some(key);
        Ok(key)
    }
}
static KEY_CACHE: Mutex<KeyCache> = Mutex::new(KeyCache { key: None });
fn local_key(create: bool) -> Result<[u8; 32], String> {
    KEY_CACHE
        .lock()
        .map_err(|_| "加密密钥缓存不可用，请重启应用")?
        .get(create, load_key)
}
fn keychain_error(status: i32) -> String {
    format!("无法访问 PastePanda 钥匙串密钥（{status}）；启动时不会弹出认证窗口；需要加密的功能暂不可用。请在钥匙串访问中授权此应用后重启。")
}
fn read_key() -> Result<[u8; 32], i32> {
    let mut key = [0u8; 32];
    let status = unsafe { pp_mac_keychain_read(key.as_mut_ptr(), key.len()) };
    if status == 0 {
        Ok(key)
    } else {
        Err(status)
    }
}
#[cfg(test)]
fn load_key(_create: bool) -> Result<[u8; 32], String> {
    // Tests encrypt temporary fixtures with a process-local random key. They must
    // never read/create the user's Keychain identity. Native Security query policy
    // is verified separately with mocked Security calls.
    let mut key = [0u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "无法生成测试密钥")?;
    Ok(key)
}
#[cfg(not(test))]
fn load_key(create: bool) -> Result<[u8; 32], String> {
    match read_key() {
        Ok(key) => return Ok(key),
        Err(status) if create && status == NOT_FOUND => {}
        Err(status) => return Err(keychain_error(status)),
    }
    let mut key = [0u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "无法生成加密密钥")?;
    let status = unsafe { pp_mac_keychain_create(key.as_ptr(), key.len()) };
    match status {
        0 => Ok(key),
        // A different process may create it concurrently; never overwrite its key.
        DUPLICATE => read_key().map_err(keychain_error),
        status => Err(keychain_error(status)),
    }
}
fn cipher(key: &[u8; 32]) -> Result<aead::LessSafeKey, String> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key)
        .map(aead::LessSafeKey::new)
        .map_err(|_| "无法初始化加密器".into())
}
fn seal(plain: &[u8], entropy: &[u8], key: &[u8; 32], nonce: [u8; 12]) -> Result<Vec<u8>, String> {
    let mut body = plain.to_vec();
    cipher(key)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(entropy),
            &mut body,
        )
        .map_err(|_| "加密失败")?;
    let mut out = Vec::with_capacity(PREFIX.len() + 12 + body.len());
    out.extend_from_slice(PREFIX);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    Ok(out)
}
fn encrypted_body(blob: &[u8]) -> Result<&[u8], String> {
    let data = blob
        .strip_prefix(PREFIX)
        .ok_or("加密格式不匹配，不能读取其它平台的密钥文件")?;
    if data.len() < 12 + aead::AES_256_GCM.tag_len() {
        return Err("加密数据不完整".into());
    }
    Ok(data)
}
fn open(blob: &[u8], entropy: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let data = encrypted_body(blob)?;
    let nonce: [u8; 12] = data[..12].try_into().map_err(|_| "加密数据不完整")?;
    let mut body = data[12..].to_vec();
    let plain = cipher(key)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(entropy),
            &mut body,
        )
        .map_err(|_| "解密失败：数据已损坏、用途不匹配或钥匙串密钥已变化")?;
    Ok(plain.to_vec())
}
pub fn protect(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "无法生成加密随机数")?;
    seal(plain, entropy, &local_key(true)?, nonce)
}
pub fn unprotect(blob: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    // Check format before accessing Keychain; decryption never creates a replacement key.
    encrypted_body(blob)?;
    open(blob, entropy, &local_key(false)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_blob_is_rejected_before_system_authorization() {
        assert_eq!(unprotect(PREFIX, b"ai-v1").unwrap_err(), "加密数据不完整");
        assert!(unprotect(b"PPANDROID1test", b"ai-v1")
            .unwrap_err()
            .contains("格式不匹配"));
    }
    #[test]
    fn cached_key_is_reused_without_more_system_access() {
        let mut cache = KeyCache::default();
        assert_eq!(
            cache
                .get(true, |create| {
                    assert!(create);
                    Ok([9; 32])
                })
                .unwrap(),
            [9; 32]
        );
        assert_eq!(
            cache
                .get(false, |_| panic!("cached key must not access Keychain"))
                .unwrap(),
            [9; 32]
        );
    }
    #[test]
    fn denied_access_does_not_cache_an_invalid_key() {
        let mut cache = KeyCache::default();
        assert!(cache
            .get(false, |create| {
                assert!(!create);
                Err("denied".into())
            })
            .is_err());
        assert!(cache.key.is_none());
        assert_eq!(
            cache
                .get(true, |create| {
                    assert!(create);
                    Ok([8; 32])
                })
                .unwrap(),
            [8; 32]
        );
    }
    #[test]
    fn authenticated_blobs_reject_tampering_wrong_key_and_wrong_purpose() {
        let key = [7; 32];
        let blob = seal(b"test secret", b"ai-v1", &key, [1; 12]).unwrap();
        assert_eq!(open(&blob, b"ai-v1", &key).unwrap(), b"test secret");
        assert!(open(&blob, b"mcp-v1", &key).is_err());
        assert!(open(&blob, b"ai-v1", &[8; 32]).is_err());
        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open(&tampered, b"ai-v1", &key).is_err());
        assert!(open(b"PPANDROID1test", b"ai-v1", &key).is_err());
        assert!(open(PREFIX, b"ai-v1", &key).is_err());
    }
}
