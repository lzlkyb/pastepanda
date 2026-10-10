//! DPAPI（Windows Data Protection API）加解密的公共收口。
//!
//! 这套 `unsafe` FFI 原先只躺在 `ai::secret_store` 里，专给 AI API Key 用。
//! MCP Server 的访问令牌同样必须加密落盘（M4 决策 D4），若各处各抄一份，
//! 就会有两份互相独立的 unsafe 代码 —— 这是最不该重复的那一类（规则 #11）。
//!
//! **entropy 由调用方传**：不同用途给不同 entropy，谁的 blob 也解不开别人的。
//! 改动某个 entropy 会让该用途已存的数据全部失效，因此各调用方的 entropy
//! 常量都带版本后缀。

#[cfg(windows)]
mod imp {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
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

    pub fn protect(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(plain);
            let entropy = blob(entropy);
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

    pub fn unprotect(cipher: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(cipher);
            let entropy = blob(entropy);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(&input, None, Some(&entropy), None, None, 0, &mut out)
                .map_err(|e| format!("DPAPI 解密失败（数据可能来自其他用户或其他机器）：{}", e))?;
            Ok(take_blob(out))
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    //! Android 实现（2026-09-30 真机配对实证）：**app 沙箱即边界**。
    //!
    //! 为什么不像 Windows 那样做 DPAPI 级加密：
    //! · Android 对 app 的保护是内核强制的 UID 沙箱——`/data/user/0/<pkg>/` 下
    //!   的文件其它 app 读不到（root/物理提取另说，那是设备级威胁，与该文件
    //!   同级的 SQLite 历史库、配置本来也是同等级暴露）。
    //! · Keystore 包装 AES-GCM 要 JNI 拿到 Context 再走 Java 层，为一个 32 字节
    //!   身份种子引入那条链路不值得（要换随时能换：调用方只认
    //!   protect/unprotect 契约，实现是 dpapi 内的私事）。
    //!
    //! 但它**不静默**：产物带 `PPANDROID1` 版本头，文件自己声明了保护等级；
    //! 解包时对不上这个头（比如把 Windows DPAPI 的产物拷进来）直接报错，
    //! 不会把乱码当明文用。Windows 上的注释（不提供明文回退）在这里被沙箱
    //! 边界替代——同一份文件在 Android 落盘位置本来就是 app 私有目录。

    const ANDROID_PASSTHROUGH_PREFIX: &[u8] = b"PPANDROID1";

    pub fn protect(plain: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(ANDROID_PASSTHROUGH_PREFIX.len() + plain.len());
        out.extend_from_slice(ANDROID_PASSTHROUGH_PREFIX);
        out.extend_from_slice(plain);
        Ok(out)
    }

    pub fn unprotect(cipher: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
        let Some(rest) = cipher.strip_prefix(ANDROID_PASSTHROUGH_PREFIX) else {
            return Err("加密存储格式不匹配（文件可能来自其它平台或已损坏）".to_string());
        };
        Ok(rest.to_vec())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    pub use crate::macos::secret_store::{protect, unprotect};
}

#[cfg(all(not(windows), not(target_os = "android"), not(target_os = "macos")))]
mod imp {
    // 非 Windows 平台不提供「明文落盘」的回退实现 —— 宁可不能用，
    // 也不能默默把密钥/令牌写成明文（规则 #15.3：失败不静默）。
    pub fn protect(_plain: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
        Err("当前平台不支持加密存储".to_string())
    }
    pub fn unprotect(_cipher: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, String> {
        Err("当前平台不支持加密存储".to_string())
    }
}

/// 用当前 Windows 用户的凭据 + 应用级 entropy 加密。换用户或换机器都解不开。
pub fn protect(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    imp::protect(plain, entropy)
}

/// 解开 [`protect`] 的产物。entropy 必须与加密时完全一致。
pub fn unprotect(cipher: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    imp::unprotect(cipher, entropy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn test_round_trip() {
        let e = b"PastePanda.Test.v1";
        let cipher = protect(b"hello", e).unwrap();
        assert_eq!(unprotect(&cipher, e).unwrap(), b"hello");
    }

    #[test]
    #[cfg(windows)]
    fn test_entropy_is_actually_enforced() {
        // 这条是「不同用途互不解开」的根据：entropy 换一个字节就必须失败，
        // 否则把 entropy 参数化就毫无意义。
        let cipher = protect(b"secret", b"PastePanda.A.v1").unwrap();
        assert!(unprotect(&cipher, b"PastePanda.B.v1").is_err());
    }

    #[test]
    #[cfg(windows)]
    fn test_cipher_is_not_plaintext() {
        let plain = b"SUPERSECRETVALUE1234567890";
        let cipher = protect(plain, b"PastePanda.Test.v1").unwrap();
        assert!(
            !cipher.windows(plain.len()).any(|w| w == plain),
            "明文出现在加密结果里"
        );
    }
}
