//! 兑换码跨语言一致性（v6.9 缺陷修复：兑换码生成器）。
//!
//! tools/gen_redeem_code.py（Python 生成器）与 Rust 端 generate_redeem_code
//! 必须产出相同码。本测试把 Python 端实测值钉死，防止任一侧算法漂移。
//! 若改签名/格式，两端要一起改，此测试会拦住单边改动。

use pastepanda_lib::data_store::{generate_redeem_code, redeem_secret, verify_redeem_code};

#[test]
fn python_generator_matches_rust() {
    let secret = redeem_secret();
    // 与 tools/gen_redeem_code.py 实测输出一致（同批次/面额/有效期；序号 1 → 0001）
    let code = generate_redeem_code("GRP1", 100_000, "20300101", &secret);
    assert_eq!(
        code, "P1-GRP1000110000020300101-a68a964a",
        "Python 生成器与 Rust 端不一致——检查 tools/gen_redeem_code.py 的 payload/签名格式"
    );
    // Rust 端自身验签也必须通过（生成器自检逻辑对齐）
    let p = verify_redeem_code(&code, &secret).expect("自产码必须可验签");
    assert_eq!(p.batch, "GRP1");
    assert_eq!(p.amount, 100_000);
    assert_eq!(p.expiry, "20300101");
}
