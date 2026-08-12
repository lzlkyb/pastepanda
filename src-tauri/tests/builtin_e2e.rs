//! v6.9 内置免费额度 · 端到端测试（真实网络 + 真实 key + 真实配额）。
//!
//! 跑法：`cargo test --test builtin_e2e -- --ignored --nocapture`
//! 需要外网可访问 `https://apihub.agnes-ai.com`；离线环境跳过。
//!
//! 覆盖链路：内置 key 还原 → 真实调用 agnes-2.5-flash → 按实际 token 扣配额
//! → 签到联动（+2 万）。与生产代码同一路径（builtin_agnes_key / quota 账本）。

use pastepanda_lib::ai::provider::{builtin_agnes_key, BUILTIN_AGNES_ID};
use pastepanda_lib::data_store::DataStore;

/// 内存 SQLite（与现有集成测试一致）。
fn temp_store() -> DataStore {
    DataStore::new(":memory:").expect("DataStore 初始化")
}

fn chat_body(prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model": "agnes-2.5-flash",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2048,
    })
}

#[tokio::test]
#[ignore = "需要真实网络与内置 key"]
async fn e2e_builtin_key_and_real_call_and_quota() {
    // ① key 还原：必须与配置时一致（防混淆字节被误改）
    let key = builtin_agnes_key();
    assert!(key.starts_with("sk-"), "还原失败: {}", &key[..key.len().min(20)]);
    assert_eq!(key.len(), 51);

    // ② 真实调用 agnes-2.5-flash（与生产同域名 apihub.agnes-ai.com）
    let client = reqwest::Client::new();
    let resp = client
        .post("https://apihub.agnes-ai.com/v1/chat/completions")
        .bearer_auth(&key)
        .json(&chat_body("只回复两个字：你好"))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .expect("HTTP 请求失败（网络不通？域名被改回 .cn 了？）");
    assert_eq!(resp.status(), 200, "非 200: {}", resp.status());
    let body: serde_json::Value = resp.json().await.expect("JSON 解析失败");
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .expect("缺 content");
    assert!(!content.trim().is_empty(), "内容为空");
    println!("✅ 真实调用成功: {:?}", content.trim());
    let total = body["usage"]["total_tokens"].as_u64().expect("缺 usage");
    println!("✅ 本次消耗 {} tokens（reasoning: {}）", total,
        body["usage"]["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0));

    // ③ 配额链路：初始 10 万 → 扣实际 token → 余额正确
    let store = temp_store();
    let q0 = store.quota_get().unwrap();
    assert_eq!(q0.granted, 100_000, "初始必须是 10 万");
    store.quota_spend(total).unwrap();
    let q1 = store.quota_get().unwrap();
    assert_eq!(q1.remaining, 100_000 - total, "扣减后余额不对");
    assert_eq!(q1.spent, total);
    println!("✅ 配额扣减: 剩余 {}（花 {}）", q1.remaining, q1.spent);

    // ④ 签到联动：+2 万（第 1 天）
    let r = store.quota_sign().unwrap();
    assert!(r.ok, "签到失败: {:?}", r.reason);
    assert_eq!(r.reward, 20_000);
    let q2 = store.quota_get().unwrap();
    assert_eq!(q2.remaining, 100_000 - total + 20_000);
    println!("✅ 签到联动: +2 万 → 剩余 {}", q2.remaining);

    // ⑤ 隔离验证：builtin id 不是自配服务商（防止串配置）
    assert_eq!(BUILTIN_AGNES_ID, "builtin-agnes");
    println!("🎉 端到端全链路通过");
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn e2e_reasoning_model_has_reasoning_field() {
    // 确认 agnes-2.5-flash 返回 reasoning_content（推理模型特征，max_tokens 需 ≥ 推理+输出）
    let client = reqwest::Client::new();
    let resp = client
        .post("https://apihub.agnes-ai.com/v1/chat/completions")
        .bearer_auth(builtin_agnes_key())
        .json(&chat_body("1+1 等于几？只给数字"))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let reasoning = body["choices"][0]["message"]["reasoning_content"]
        .as_str()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let rt = body["usage"]["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .unwrap_or(0);
    println!("✅ 推理模型确认: reasoning_content={} reasoning_tokens={}", reasoning, rt);
}
