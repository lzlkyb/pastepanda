//! 内置密钥混淆工具（v6.9）。
//!
//! 目的：内置在客户端里的密钥（免费 API key / 兑换码 secret 等）不做明文存储，
//! 编译期 XOR 混淆 + 运行时还原，防止 `strings` 级别的明文扫描直接搜到
//! `sk-` 等前缀。**这不是真正加密**——XOR 密钥就在同一份二进制里，
//! 懂逆向的人仍可还原，属"提高门槛"而非"防提取"。
//!
//! ## 怎么内置一个新密钥
//!
//! 1. 用生成器算出混淆字节（任选 XOR 常量，如 `0x5A`）：
//!    `cargo test --lib mask::tests::gen -- --nocapture` 里改样例，或直接用：
//!    `python3 -c "s='sk-xxx'; print([hex(b^0x5A) for b in s.encode()])"`
//! 2. 在业务模块里写：
//!    （标 `ignore` 是必需的：这段带 `0x..` 占位，不是可编译代码。
//!     不标的话 rustdoc 会把它当 doctest 去编译，`cargo test` 整体退出码
//!     就永远非 0，把真实失败一起掩掉。）
//!    ```ignore
//!    pub fn my_secret() -> String {
//!        const XOR: u8 = 0x5A;
//!        const BUF: &[u8] = &[0x.., 0x.., /* 生成器输出的字节 */];
//!        crate::mask::reveal_xor(BUF, XOR)
//!    }
//!    ```
//! 3. 跑 `cargo test --lib mask` 确认往返还原正确。

/// XOR 混淆还原：把编译期混淆的字节还原成字符串（生产用）。
///
/// 先还原字节序列再按 UTF-8 解码，任意文本（含中文/emoji）都正确；
/// XOR 常量配错时返回空串（防御式，不 panic）。
pub fn reveal_xor(buf: &[u8], xor: u8) -> String {
    String::from_utf8(buf.iter().map(|&b| b ^ xor).collect()).unwrap_or_default()
}

/// XOR 混淆生成：明文 → 混淆字节（工具用，产物写进 `const BUF`）。
///
/// 生产路径用不到；保留为 pub 方便写测试与生成新密钥。
/// allow(dead_code)：只有下方单测与人工生成新密钥时调用，生产构建里必然没有调用方，
/// 不加就会在每次 dev 启动时报一条 never used 警告。
#[allow(dead_code)]
pub fn mask_xor(s: &str, xor: u8) -> Vec<u8> {
    s.bytes().map(|b| b ^ xor).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xor_roundtrip() {
        let s = "sk-test-key-abcdef1234567890";
        let x = 0x5A;
        let buf = mask_xor(s, x);
        // 还原一致
        assert_eq!(reveal_xor(&buf, x), s);
        // 混淆后不含明文片段
        assert!(!String::from_utf8_lossy(&buf).contains("sk-"));
        // 换个 XOR 常量还原必然失败（防止用错常量）
        assert_ne!(reveal_xor(&buf, x ^ 1), s);
    }

    #[test]
    fn empty_and_ascii() {
        assert_eq!(reveal_xor(&[], 0x5A), "");
        let buf = mask_xor("纯中文key-🧪", 0x5A);
        // 非 ASCII 多字节：逐字节 XOR 仍可还原（每个字节独立）
        assert_eq!(reveal_xor(&buf, 0x5A), "纯中文key-🧪");
    }
}
