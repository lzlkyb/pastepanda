//! 云端结果缓存：同一份内容 + 同一个动作 + 同一组选项，24 小时内不重复计费。
//!
//! **只存内存，不落盘**。两个理由：
//! 1. 缓存值里装的是剪贴板内容的处理结果，落盘等于又多一份明文副本；
//! 2. 它要解决的是“手滑了反复点同一个按钮”，这件事发生在分钟级，不需要跨重启。
//!
//! 代价是重启后缓存清空，这是有意接受的取舍。

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// 缓存有效期。
const TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 条目上限。超出时淘汰最早写入的那条。
/// 剪贴板动作是人手动触发的，200 条已经远超单日实际用量。
const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone)]
pub struct CachedValue {
    pub content: String,
    pub model: String,
}

struct Entry {
    value: CachedValue,
    at: Instant,
}

static CACHE: LazyLock<Mutex<HashMap<String, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 缓存键：动作 + 选项 + 内容的 SHA-256。
///
/// 选项先排序再拼，否则 HashMap 的遍历顺序会让同一组选项算出不同的键，
/// 缓存就永远命不中。
pub fn make_key(action_id: &str, opts: &HashMap<String, String>, text: &str) -> String {
    let mut pairs: Vec<(&String, &String)> = opts.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));

    let mut buf = String::new();
    buf.push_str(action_id);
    buf.push('\u{0}');
    for (k, v) in pairs {
        buf.push_str(k);
        buf.push('=');
        buf.push_str(v);
        buf.push(';');
    }
    buf.push('\u{0}');
    buf.push_str(text);

    let digest = ring::digest::digest(&ring::digest::SHA256, buf.as_bytes());
    digest
        .as_ref()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

fn get_at(key: &str, now: Instant) -> Option<CachedValue> {
    let mut map = CACHE.lock().ok()?;
    match map.get(key) {
        Some(e) if now.duration_since(e.at) < TTL => Some(e.value.clone()),
        Some(_) => {
            // 过期就顺手清掉，不留垃圾
            map.remove(key);
            None
        }
        None => None,
    }
}

fn put_at(key: String, value: CachedValue, now: Instant) {
    let Ok(mut map) = CACHE.lock() else { return };

    // 先清过期，再考虑容量淘汰
    map.retain(|_, e| now.duration_since(e.at) < TTL);

    if map.len() >= MAX_ENTRIES {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, e)| e.at)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }
    map.insert(key, Entry { value, at: now });
}

pub fn get(key: &str) -> Option<CachedValue> {
    get_at(key, Instant::now())
}

pub fn put(key: String, value: CachedValue) {
    put_at(key, value, Instant::now());
}

/// 清空缓存（切换厂商/模型后应该调，否则会拿旧模型的结果充数）。
pub fn clear() {
    if let Ok(mut map) = CACHE.lock() {
        map.clear();
    }
}

/// 正在计算中的缓存键集合（single-flight，审查 backlog：#4 防同内容并发双倍计费）。
/// 同一内容并发触发同一动作时，只放行一个真实 API 调用，其余等待其缓存结果。
static INFLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// 登记在跑；返回 false 表示已有同 key 在跑（应等待而非重复调用）。
pub fn inflight_add(key: &str) -> bool {
    INFLIGHT.lock().map(|mut s| s.insert(key.to_string())).unwrap_or(true)
}

/// 调用完成（无论成败）后释放。
pub fn inflight_done(key: &str) {
    if let Ok(mut s) = INFLIGHT.lock() {
        s.remove(key);
    }
}

/// 是否仍在跑。
pub fn inflight_active(key: &str) -> bool {
    INFLIGHT.lock().map(|s| s.contains(key)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓存是进程级全局状态，而 Rust 测试默认并行跑。
    /// 没这把锁的话，`test_clear_empties_cache` 会把别的测试刚写入的条目一起清掉，
    /// 造成难复现的偶发失败。所有碰全局缓存的测试都要先拿它。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 锁中毒时继续用（某个测试 panic 不应该让其余测试连带报错）
    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn opts(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn val(s: &str) -> CachedValue {
        CachedValue {
            content: s.to_string(),
            model: "test-model".to_string(),
        }
    }

    #[test]
    fn test_key_is_stable_regardless_of_opts_order() {
        // HashMap 遍历无序，不排序的话缓存会永远命不中
        let a = make_key("ai-translate", &opts(&[("lang", "ja"), ("tone", "x")]), "hello");
        let b = make_key("ai-translate", &opts(&[("tone", "x"), ("lang", "ja")]), "hello");
        assert_eq!(a, b);
    }

    #[test]
    fn test_key_differs_by_action_opts_and_text() {
        let base = make_key("ai-translate", &opts(&[("lang", "zh")]), "hello");
        assert_ne!(base, make_key("ai-summarize", &opts(&[("lang", "zh")]), "hello"));
        assert_ne!(base, make_key("ai-translate", &opts(&[("lang", "en")]), "hello"));
        assert_ne!(base, make_key("ai-translate", &opts(&[("lang", "zh")]), "hello!"));
    }

    #[test]
    fn test_key_has_no_plaintext_of_content() {
        // 键是摘要，不能把剪贴板原文带出去
        let key = make_key("ai-translate", &HashMap::new(), "这是机密内容");
        assert!(!key.contains("机密"));
        assert_eq!(key.len(), 64, "SHA-256 十六进制应为 64 位");
    }

    #[test]
    fn test_put_then_get_hits() {
        let _g = test_guard();
        let key = make_key("ai-translate", &HashMap::new(), "__test_put_then_get__");
        put(key.clone(), val("你好"));
        let got = get(&key).expect("应该命中");
        assert_eq!(got.content, "你好");
        assert_eq!(got.model, "test-model");
    }

    #[test]
    fn test_miss_on_unknown_key() {
        let _g = test_guard();
        let key = make_key("ai-translate", &HashMap::new(), "__test_never_written__");
        assert!(get(&key).is_none());
    }

    #[test]
    fn test_expired_entry_is_a_miss() {
        let _g = test_guard();
        let key = make_key("ai-summarize", &HashMap::new(), "__test_expiry__");
        let now = Instant::now();
        // 写入一条“25 小时前”的条目
        let Some(long_ago) = now.checked_sub(Duration::from_secs(25 * 60 * 60)) else {
            // 进程刚启动时 Instant 可能减不动，此时跳过而不是让测试假红
            return;
        };
        put_at(key.clone(), val("旧结果"), long_ago);
        assert!(get_at(&key, now).is_none(), "超过 24 小时应该不命中");
    }

    #[test]
    fn test_clear_empties_cache() {
        let _g = test_guard();
        let key = make_key("ai-rewrite", &HashMap::new(), "__test_clear__");
        put(key.clone(), val("x"));
        assert!(get(&key).is_some());
        clear();
        assert!(get(&key).is_none());
    }
}
