//! 内容哈希的**单一实现**。
//!
//! 为何单独建模块：“内容文本的 md5”这一个语义之前在 5 处各写一份
//! （`clipboard_monitor`、`lan_sync`、`commands/history`、`data_store/history` ×2、
//! `paste_engine`），而 `lan_sync` 新增那份的注释还写着“与
//! `clipboard_monitor::md5_hex` 同口径”——同口径是靠**注释承诺**而不是代码保证。
//!
//! 这不是洁癖问题：v6.8 的“智能合并”完全依赖两边算出同一个 md5：
//! 不一致就合并不上、LAN 同步收几条广播就堆几条重复记录。
//!
//! 注意：其余 md5 用途（自定义动作模板指纹、图片字节、兑换码签名）**不属于**
//! 这个语义，不要往这里并——它们只是恰好也用 md5。

use md5::{Digest, Md5};

/// 字节串的 md5 十六进制（图片字节、文件路径等通用场景）。
pub fn md5_hex(data: &[u8]) -> String {
    format!("{:x}", Md5::new().chain_update(data).finalize())
}

/// 内容文本的 md5（历史去重 / 智能合并 / LAN 同步去重 共用的那一个）。
///
/// 不做 trim、不做大小写归一——保持与旧实现字节级一致，否则已存库的 md5 全部失效。
pub fn content_md5(text: &str) -> String {
    md5_hex(text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_md5_matches_bytes_md5() {
        // 两个入口必须同口径（旧代码里两种写法混用，靠这条钉住）
        assert_eq!(content_md5("hello"), md5_hex(b"hello"));
        assert_eq!(content_md5("中文内容"), md5_hex("中文内容".as_bytes()));
    }

    #[test]
    fn known_value_pins_algorithm() {
        // 钉死具体值：改算法会让已入库的 md5 全部对不上，必须拦住
        assert_eq!(content_md5("hello"), "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn no_trim_no_case_fold() {
        assert_ne!(content_md5(" a"), content_md5("a"));
        assert_ne!(content_md5("A"), content_md5("a"));
    }
}
