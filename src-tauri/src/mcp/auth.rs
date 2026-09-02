//! MCP 服务的两道门：`Origin` 校验（防 DNS rebinding）+ Bearer 令牌（常量时间比较）。
//!
//! **为何绑了 `127.0.0.1` 还需要这两道门**：
//!
//! 1. `Origin` —— 外网网页里的 JS 能直接 `fetch("http://127.0.0.1:17650/mcp")`，
//!    那是从**用户自己机器**发出的请求，绑回环拦不住。浏览器会带上真实的
//!    `Origin`（这个头是浏览器写的，JS 改不了），所以它是可信的判据。
//! 2. Bearer —— 本机其他进程（不经浏览器）不发 `Origin` 也能请求，
//!    那一层只能靠令牌拦。
//!
//! 它们让一个漏了另一个还在，因此两条都不能省。
//!
//! 参考实现：cc-bridge `src/mcp/http.rs`。但它的 **per-IP 限流没抄**：
//! 那是为远程隧道场景做的，本服务只绑 `127.0.0.1`，对端 IP 永远是同一个，
//! 按 IP 分桶没有任何区分能力。并发上限改用 `ConcurrencyLimitLayer`（见 `server.rs`）。

use axum::http::HeaderMap;

/// 门禁拒绝的原因。分开是为了给不同状态码与不同日志级别。
#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    /// `Origin` 存在但不属于本机——基本就是网页在扫本地端口，403。
    Origin(String),
    /// 缺 `Authorization` 头，401。
    MissingToken,
    /// 令牌不对，401。**不告知“错在哪里”**，避免变成猜令牌的反馈信道。
    BadToken,
}

impl Reject {
    pub fn status(&self) -> axum::http::StatusCode {
        match self {
            Reject::Origin(_) => axum::http::StatusCode::FORBIDDEN,
            Reject::MissingToken | Reject::BadToken => axum::http::StatusCode::UNAUTHORIZED,
        }
    }

    /// 回给客户端的文案。两种令牌失败故意共用同一句。
    pub fn message(&self) -> &'static str {
        match self {
            Reject::Origin(_) => "拒绝：请求来自非本机页面",
            Reject::MissingToken | Reject::BadToken => "未授权：请求需提供正确的 Bearer 令牌",
        }
    }
}

/// 判一个 `Origin` 头的值是不是本机页面。
///
/// 只放行 `http://` 的回环主机（端口任意）。其余全拒，包括：
/// - `null`：`file://` 页面与沙盒 iframe 会发这个值。一个下载到本地的恶意 HTML
///   正好落在这一类，不能当「本机」放。
/// - `http://127.0.0.1.evil.com`：后缀伪装。必须解析出 host 后精确比，
///   不能用 `starts_with` / `contains`。
fn is_local_origin(origin: &str) -> bool {
    let rest = match origin.strip_prefix("http://") {
        Some(r) => r,
        // https 的本机页面在本场景不存在（本服务不启 TLS），
        // 而 `https://evil.com` 正是要拦的那一类，所以直接拒。
        None => return false,
    };
    // 只取 authority 部分（Origin 按规范不带路径，但不能依赖对方守规范）
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // IPv6 写法：[::1]:port
    if let Some(after) = authority.strip_prefix('[') {
        let Some((host, tail)) = after.split_once(']') else {
            return false;
        };
        return matches!(host, "::1" | "0:0:0:0:0:0:0:1") && port_tail_ok(tail);
    }
    let (host, tail) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let host_ok = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1";
    let port_ok = match tail {
        None => true,
        Some(p) => !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()),
    };
    host_ok && port_ok
}

/// IPv6 authority 里 `]` 后面剩下的部分：要么空，要么 `:数字`。
fn port_tail_ok(tail: &str) -> bool {
    if tail.is_empty() {
        return true;
    }
    match tail.strip_prefix(':') {
        Some(p) => !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// 比较两个令牌，不泄露时序信息。
///
/// **为何不能用 `==`**：字符串比较是逐字节短路的，调用方能按响应时间
/// 一位一位猜出令牌。
///
/// **为何不用 `ring::constant_time::verify_slices_are_equal`**：它在 ring 0.17 已弃用，
/// 弃用说明写得很直白 —— *"Internal function not intended for external use with
/// no promises regarding side channels"*。它不再承诺常量时间，拿它当常量时间用
/// 就是把一个不成立的前提写进安全路径。
///
/// 所以这里**先各自 SHA-256 再比摘要**：
/// - 摘要长度恒为 32 字节，连长度都不泄露；
/// - 即使下面那层无分支累加被编译器优化成了短路，泄露的也只是
///   「摘要的第几字节开始不同」—— 对反推原文没有用。
///
/// 两层叠起来，安全性不依赖任何关于编译器行为的假设。
fn token_eq(a: &str, b: &str) -> bool {
    let ha = ring::digest::digest(&ring::digest::SHA256, a.as_bytes());
    let hb = ring::digest::digest(&ring::digest::SHA256, b.as_bytes());
    // 用 zip 而不是下标：无越界可能，panic = "abort" 下一次越界就是整个 app 死掉。
    let mut diff = 0u8;
    for (x, y) in ha.as_ref().iter().zip(hb.as_ref().iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 对一个请求跑完整的两道门。
///
/// **顺序有意义**：先查 `Origin`。那一步不碰令牌，先拒掉网页扫端口的请求，
/// 就不会把令牌比较暴露给它们。
pub fn check(headers: &HeaderMap, expected_token: &str) -> Result<(), Reject> {
    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
        // 不是合法 UTF-8 的 Origin 一律拒，不尝试宽容解析
        let origin = origin.to_str().unwrap_or("");
        if !is_local_origin(origin) {
            return Err(Reject::Origin(origin.to_string()));
        }
    }

    let Some(auth) = headers.get(axum::http::header::AUTHORIZATION) else {
        return Err(Reject::MissingToken);
    };
    let Ok(auth) = auth.to_str() else {
        return Err(Reject::BadToken);
    };
    let Some(presented) = auth.strip_prefix("Bearer ") else {
        return Err(Reject::BadToken);
    };
    if token_eq(presented.trim(), expected_token) {
        Ok(())
    } else {
        Err(Reject::BadToken)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkk";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            if let (Ok(name), Ok(val)) = (
                axum::http::HeaderName::from_bytes(k.as_bytes()),
                axum::http::HeaderValue::from_str(v),
            ) {
                h.insert(name, val);
            }
        }
        h
    }

    #[test]
    fn test_valid_bearer_passes_without_origin() {
        // MCP 客户端是命令行进程，不发 Origin——这是正常路径，不能拦
        let h = headers(&[("authorization", &format!("Bearer {}", TOKEN))]);
        assert_eq!(check(&h, TOKEN), Ok(()));
    }

    #[test]
    fn test_missing_and_bad_token() {
        assert_eq!(check(&headers(&[]), TOKEN), Err(Reject::MissingToken));
        assert_eq!(
            check(&headers(&[("authorization", "Bearer wrong")]), TOKEN),
            Err(Reject::BadToken)
        );
        // 少了 "Bearer " 前缀（直接放裸令牌）也不能放行
        assert_eq!(
            check(&headers(&[("authorization", TOKEN)]), TOKEN),
            Err(Reject::BadToken)
        );
    }

    #[test]
    fn test_two_gates_are_independent() {
        // 令牌对但 Origin 是外网→仍需拦；这就是两道门而不是一道的理由。
        let h = headers(&[
            ("authorization", &format!("Bearer {}", TOKEN)),
            ("origin", "https://evil.com"),
        ]);
        assert!(matches!(check(&h, TOKEN), Err(Reject::Origin(_))));

        // 反过来：Origin 是本机但没令牌也要拦
        let h = headers(&[("origin", "http://localhost:5173")]);
        assert_eq!(check(&h, TOKEN), Err(Reject::MissingToken));
    }

    #[test]
    fn test_origin_gate_checked_before_token() {
        // 先 Origin 后令牌：网页扫端口时不应该走到令牌比较那一步
        let h = headers(&[("origin", "https://evil.com")]);
        assert!(matches!(check(&h, TOKEN), Err(Reject::Origin(_))));
    }

    #[test]
    fn test_local_origins_accepted() {
        for o in [
            "http://127.0.0.1",
            "http://127.0.0.1:17650",
            "http://localhost",
            "http://localhost:5173",
            "http://LocalHost:1420",
            "http://[::1]",
            "http://[::1]:8080",
        ] {
            assert!(is_local_origin(o), "应接受本机 Origin：{}", o);
        }
    }

    #[test]
    fn test_suffix_spoofing_is_rejected() {
        // 这是「必须解析出 host 再精确比」的根据：用 starts_with / contains 写
        // 这两道门，下面每一条都会被放进来。
        for o in [
            "http://127.0.0.1.evil.com",
            "http://localhost.evil.com",
            "http://evil.com/127.0.0.1",
            "http://evil.com#http://localhost",
            "http://[::1].evil.com",
            "https://127.0.0.1",
            "null",
            "",
            "http://127.0.0.1:notaport",
        ] {
            assert!(!is_local_origin(o), "不应接受的 Origin 被放行了：{}", o);
        }
    }

    #[test]
    fn test_token_eq_handles_any_length_without_panic() {
        // 不等长、空串、超长串都不能 panic（panic = "abort"，一次 panic 杀整个 app）
        assert!(!token_eq("", TOKEN));
        assert!(!token_eq("short", TOKEN));
        assert!(!token_eq(&"x".repeat(10_000), TOKEN));
        assert!(token_eq(TOKEN, TOKEN));
        assert!(token_eq("", ""));
    }

    #[test]
    fn test_token_eq_rejects_prefixes_and_near_misses() {
        // 前缀、尾差一位、大小写不同都必须不等 —— 这是摘要比较没把语义改掉的护栏
        let mut near = TOKEN.to_string();
        near.pop();
        assert!(!token_eq(&near, TOKEN), "少一位不得通过");
        assert!(!token_eq(&format!("{}x", TOKEN), TOKEN), "多一位不得通过");
        assert!(
            !token_eq(&TOKEN.to_uppercase(), TOKEN),
            "令牌必须区分大小写"
        );
    }
}
