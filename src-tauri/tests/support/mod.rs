//! 测试支持库:本地 mock OpenAI 兼容服务。
//!
//! 用途:契约测试(e2e 之外)不碰真实网络、不花免费额度、毫秒级可重复。
//! `AiConfig.base_url` 指向 mock 地址即可把 `ai::chat` 的全部请求打到本地。
//!
//! 支持脚本化响应:正常 / 流式分块 / 推理模型(思考占满)/ 截断 / 错误状态码 / 挂起(超时)。
//! 同时记录每次请求的 body,供断言(缓存命中=请求次数不增、max_tokens 放宽等)。

use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

/// 响应模式。
#[derive(Clone, Debug)]
pub enum MockMode {
    /// 非流式正常回答。
    Ok(String),
    /// 流式 SSE,按块输出,最后 [DONE]。
    OkStream(Vec<String>),
    /// 非流式:content 为空 + reasoning_content 占满(ThinkingOnly 场景)。
    ThinkingOnly,
    /// 流式:先 reasoning 块,再 content 空(ThinkingOnly 场景)。
    ThinkingOnlyStream,
    /// 首次返回 ThinkingOnly(内容空+思维链),之后返回 Ok。
    /// 专测 chat() 的「自动放宽重试」链路:第一次触发放宽,第二次成功。
    ThinkingThenOk,
    /// 截断:有部分内容,finish_reason=length。
    Truncated(String),
    /// 指定状态码(429/500/401 等)。
    Status(u16),
    /// 挂起不响应(测超时;注意会占住 mock 线程)。
    Hang,
}

/// 本地 mock 服务。
pub struct MockServer {
    port: u16,
    mode: Arc<Mutex<MockMode>>,
    /// 收到的请求 body(按序)。
    requests: Arc<Mutex<Vec<Value>>>,
    /// 每个 worker 线程的句柄(join 用,防测试进程提前退出)。
    _handles: Vec<thread::JoinHandle<()>>,
}

impl MockServer {
    /// 起服务,返回 base_url = http://127.0.0.1:{port}
    pub fn start(mode: MockMode) -> (MockServer, String) {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("mock 服务启动失败");
        let port = server.server_addr().to_ip().expect("ip 地址").port();
        let mode = Arc::new(Mutex::new(mode));
        let requests: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        // ThinkingThenOk 的调用次序计数器(共享,防多 worker 各自计数)
        let call_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // tiny_http Server 不支持 Clone,契约测试串行,单 worker 足够。
        // 并发场景(配额原子性)由 data_store 单测覆盖,不依赖 mock 并发。
        let handles = {
            let server = server;
            let mode = Arc::clone(&mode);
            let requests = Arc::clone(&requests);
            let call_count = Arc::clone(&call_count);
            vec![thread::spawn(move || {
                for mut req in server.incoming_requests() {
                    eprintln!("[mock] 收到请求: {} {}", req.method(), req.url());
                    let body = {
                        let mut reader = req.as_reader();
                        let mut buf = Vec::new();
                        let _ = std::io::Read::read_to_end(&mut reader, &mut buf);
                        buf
                    };
                    eprintln!("[mock] 请求体 {} 字节", body.len());
                    let text = String::from_utf8_lossy(&body).to_string();
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        requests.lock().unwrap().push(v);
                    }
                    // ThinkingThenOk:按调用次序翻页,第一个返回 ThinkingOnly,其余走正常
                    let m = {
                        let mut m = mode.lock().unwrap().clone();
                        if let MockMode::ThinkingThenOk = m {
                            if call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                                MockMode::ThinkingOnly
                            } else {
                                MockMode::Ok("放宽后成功".to_string())
                            }
                        } else {
                            m
                        }
                    };
                    respond(req, &m);
                    eprintln!("[mock] 已响应");
                }
            })]
        };
        let base = format!("http://127.0.0.1:{port}/v1");
        (MockServer { port, mode, requests, _handles: handles }, base)
    }

    pub fn set_mode(&self, mode: MockMode) {
        *self.mode.lock().unwrap() = mode;
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 收到请求的次数。
    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    /// 第 i 个请求 body(解析失败返回 None)。
    pub fn request_body(&self, i: usize) -> Option<Value> {
        self.requests.lock().unwrap().get(i).cloned()
    }

    /// 最近一次请求的 max_tokens。
    pub fn last_max_tokens(&self) -> Option<u32> {
        let reqs = self.requests.lock().unwrap();
        reqs.last().and_then(|r| r["max_tokens"].as_u64().map(|v| v as u32))
    }
}

fn respond(req: tiny_http::Request, mode: &MockMode) {
    let (status, body) = match mode {
        MockMode::Ok(content) => (
            200,
            json!({
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": "mock-agnes",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": content },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 20 }
            }),
        ),
        MockMode::OkStream(chunks) => {
            let mut sse = String::new();
            for c in chunks {
                sse.push_str(&format!(
                    "data: {}\n\n",
                    json!({
                        "id": "chatcmpl-mock",
                        "object": "chat.completion.chunk",
                        "model": "mock-agnes",
                        "choices": [{ "index": 0, "delta": { "content": c }, "finish_reason": null }]
                    })
                ));
            }
            sse.push_str("data: [DONE]\n\n");
            // 流式响应必须带 content-type: text/event-stream(chat 客户端不校验,但保持真实)
            // 且 Connection: close——否则 tiny_http keep-alive 会让 reqwest 的
            // bytes_stream 永远等不到流结束(测试挂死 60 秒的根因)
            let body = sse.into_bytes();
            let resp = tiny_http::Response::from_data(body)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..])
                        .expect("header"),
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Connection"[..], &b"close"[..])
                        .expect("header"),
                );
            let _ = req.respond(resp);
            return;
        }
        MockMode::ThinkingOnly => (
            200,
            json!({
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": "mock-reasoner",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning_content": "让我们一步步分析……这是一段很长的思维链占满额度"
                    },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 30 }
            }),
        ),
        MockMode::ThinkingOnlyStream => {
            let mut sse = String::new();
            for c in ["思考第一段", "思考第二段"] {
                sse.push_str(&format!(
                    "data: {}\n\n",
                    json!({
                        "id": "chatcmpl-mock",
                        "object": "chat.completion.chunk",
                        "model": "mock-reasoner",
                        "choices": [{ "index": 0, "delta": { "content": "", "reasoning_content": c }, "finish_reason": null }]
                    })
                ));
            }
            sse.push_str("data: [DONE]\n\n");
            let body = sse.into_bytes();
            let resp = tiny_http::Response::from_data(body)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..])
                        .expect("header"),
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Connection"[..], &b"close"[..])
                        .expect("header"),
                );
            let _ = req.respond(resp);
            return;
        }
        MockMode::Truncated(content) => (
            200,
            json!({
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": "mock-agnes",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": content },
                    "finish_reason": "length"
                }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 30 }
            }),
        ),
        MockMode::Status(code) => (*code, json!({ "error": { "message": "mock error", "type": "mock", "code": *code } })),
        // 正常不会走到(调用前已翻页为 ThinkingOnly/Ok),兜底防漏
        MockMode::ThinkingThenOk => (200, json!({ "choices": [ { "message": { "content": "" }, "finish_reason": "stop" } ] })),
        MockMode::Hang => {
            // 挂起:不响应。调用方设短超时即可触发 timeout 路径。
            thread::sleep(std::time::Duration::from_secs(60));
            return;
        }
    };

    let body = serde_json::to_vec(&body).unwrap_or_default();
    let resp = tiny_http::Response::from_data(body).with_status_code(status);
    let _ = req.respond(resp);
}

/// 构造指向 mock 的 AiConfig(OpenAI 协议、provider 用 deepseek 占位)。
pub fn mock_config(base_url: &str) -> pastepanda_lib::ai::AiConfig {
    pastepanda_lib::ai::AiConfig {
        enabled: true,
        provider: "deepseek".to_string(),
        base_url: base_url.to_string(),
        model: "mock-agnes-2.5-flash".to_string(),
        daily_budget_cny: 0.0, // 契约测试不管金额预算
        timeout_secs: 3,
        thinking_off: true,
        protocol: String::new(),
        // 契约测试不走标签上下文：它会把一行前置文本拼进 prompt，
        // 而这批测试断言的是请求体的确切形状。
        tags_as_context: false,
        // 同理：画像注入会往 system 里拼一段最多 300 字的使用习惯描述。
        profile_as_context: false,
    }
}
