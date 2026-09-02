//! HTTP 传输层：axum Router + 三层中间件 + 启停。
//!
//! **为何用 axum 而不是手写 hyper**：拿 cc-bridge 当参照时发现它本身就是 axum 0.8
//! （`# HTTP server (MCP protocol handled via axum directly)`），它那句「手写」指的是
//! **手写 dispatch**，不是传输层。它安装包 4.5MB（含 axum）对着 ≤ 20MB 的预算，
//! 本项目实测 axum 只增 ~160 KB（hyper / tower / http 已在 Cargo.lock 里，零新重复依赖）。
//! 手写 hyper 省不下多少，却要自己管连接、路由、体上限。
//!
//! 中间件取自 cc-bridge 但删了压缩层（理由见 [`build_router`]）：
//! 体上限 → 并发上限，后添加的在外层。

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tokio::sync::oneshot;

/// 默认端口（决策 D1）。选 17650 而不是 3000/8080 这类：后者被开发服务器占得太多。
pub const DEFAULT_PORT: u16 = 17650;

/// 请求体上限 1 MB。MCP 请求都是小 JSON，这个限制比它们大两个量级，
/// 作用是拦住「往本机端口灌一个 G」这种把内存打满的玩法。
const BODY_LIMIT: usize = 1024 * 1024;

/// 并发上限（R1）。本服务的每个请求都会去拿 SQLite 的全局锁，
/// 无上限并发只会把线程堆在那把锁上、连带拖死主界面。
///
/// 已核实这是**全局**上限而不是每连接一份：axum 会每连接 clone 一份 service，
/// 而 tower 的 `ConcurrencyLimit` 手写的 Clone 实现是「create a new service with the
/// same semaphore」（tower 0.5.3 `limit/concurrency/service.rs`）——semaphore 是共享的。
/// 若它按连接各管各的，这个上限就形同虚设。
const MAX_CONCURRENCY: usize = 64;

/// 交给 handler 的共享上下文。
///
/// 数据源注入的是 `Arc<dyn KbSource>` 而**不是** `AppHandle`：
/// 这样过线测试能直接塞一个可控的假实现，不必去造 Tauri App
/// —— `tauri::test::mock_app()` 那条路已验过在本机不通（它要的 `test` feature
/// 会把 lib test 二进制链到本机不存在的 `ProcessPrng`，详见 Cargo.toml 的警告）。
#[derive(Clone)]
struct Ctx {
    /// 三个只读工具背后的数据访问。
    kb: Arc<dyn super::source::KbSource>,
    /// 当前明文令牌。只在内存，不经任何命令层外送（除了用户主动要看的那一个）。
    ///
    /// 用 `Arc<Mutex<String>>` 而不是 `Arc<String>`：与 [`McpServer`] 共享同一把，
    /// 所以**重置令牌立即生效**。若靠「停服务 + 带新令牌重启」换令牌，
    /// 优雅停机还没释放旧监听时新 bind 会报端口占用——一个本可不引入的竞态。
    token: Arc<Mutex<String>>,
}

/// 运行中的句柄。
struct Running {
    port: u16,
    /// 优雅停机信号。`oneshot::Sender::send` 会消耗 self，
    /// 所以停服务时是把整个 `Running` `take()` 出来。
    shutdown: oneshot::Sender<()>,
}

/// MCP 服务句柄，作为 Tauri 管理状态存活于整个进程。
///
/// 服务生命周期**跟随进程**（决策 D6）：不单独做守护，不开机自启。
/// PastePanda 本就是常驻托盘的，再加一层生命周期只会多一类「主程序退了
/// 但端口还占着」的故障模式。
pub struct McpServer {
    running: Mutex<Option<Running>>,
    /// 当前令牌，与正在跑的 handler 共享同一把 Arc。
    token: Arc<Mutex<String>>,
}

/// 回给前端的状态（R7：界面上要有一条看得见的状态）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    /// 直接能拷走填进 MCP 客户端的地址。停机时也给，方便用户先看后开。
    pub url: String,
}

impl Default for McpServer {
    fn default() -> Self {
        Self::new()
    }
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            token: Arc::new(Mutex::new(String::new())),
        }
    }

    /// 更新令牌。服务在跑时也可调，**下一个请求就用新令牌**，无需重启。
    pub fn set_token(&self, token: String) -> Result<(), String> {
        let mut guard = self
            .token
            .lock()
            .map_err(|_| "MCP 令牌锁已中毒".to_string())?;
        *guard = token;
        Ok(())
    }

    /// 当前状态。`configured_port` 是**停机时**该显示的端口（从配置读）。
    ///
    /// 为什么要多这个参数：`url` 字段的用途就是让用户拷走填进 MCP 客户端。
    /// 若停机时一律回 `DEFAULT_PORT`，而用户已把端口改成别的值，
    /// 他拷走的就是个**错地址**——而且要等到客户端连不上才会发现。
    pub fn status(&self, configured_port: u16) -> McpStatus {
        let guard = self.running.lock().ok();
        // 在跑就用**实际绑的**端口（配置改了但未重启时，两者会不一致，
        // 此时实际值才是客户端能连上的那个）。
        let port = guard
            .as_ref()
            .and_then(|g| g.as_ref().map(|r| r.port))
            .unwrap_or(configured_port);
        let running = guard.as_ref().is_some_and(|g| g.is_some());
        McpStatus {
            running,
            port,
            url: format!("http://127.0.0.1:{}/mcp", port),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// 启动服务。已在跑则直接返回当前端口。
    ///
    /// 🔴 **端口被占时报错，不自动漂到下一个端口**（决策 D5）。
    /// 端口漂了，用户已经填进 Claude Code 配置的地址就失效了，
    /// 而失效方式是「服务在跑但客户端连不上」—— 比直接启不了难查得多。
    pub fn start(
        &self,
        kb: Arc<dyn super::source::KbSource>,
        token: String,
        port: u16,
    ) -> Result<u16, String> {
        let mut guard = self
            .running
            .lock()
            .map_err(|_| "MCP 服务状态锁已中毒".to_string())?;
        if let Some(r) = guard.as_ref() {
            return Ok(r.port);
        }

        // 先用同步 bind，目的是把「端口被占」当场变成本函数的 Err。
        // 如果把 bind 丢进异步任务，错误就只能进日志，界面会显示「已开启」
        // 而实际什么都没启——那正是规则 #15.3 要防的静默失败。
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
            format!(
                "端口 {} 无法绑定：{}。请先确认是否有其他程序（或另一个 PastePanda 实例）占用它。",
                port, e
            )
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("监听套接字设为非阻塞失败：{}", e))?;

        self.set_token(token)?;
        let router = build_router(kb, self.token.clone());
        let (tx, rx) = oneshot::channel::<()>();

        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => l,
                Err(e) => {
                    log::error!("[MCP] 监听套接字接入运行时失败：{}", e);
                    return;
                }
            };
            log::info!("[MCP] 服务已启动：http://127.0.0.1:{}/mcp", port);
            let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = rx.await;
            });
            if let Err(e) = serve.await {
                log::error!("[MCP] 服务异常退出：{}", e);
            } else {
                log::info!("[MCP] 服务已停止");
            }
        });

        *guard = Some(Running { port, shutdown: tx });
        Ok(port)
    }

    /// 停服务。本来就没在跑也算成功。
    pub fn stop(&self) {
        let taken = match self.running.lock() {
            Ok(mut g) => g.take(),
            Err(_) => {
                log::warn!("[MCP] 状态锁已中毒，无法停服务");
                return;
            }
        };
        if let Some(r) = taken {
            // 接收端已掉（服务自己先挂了）时 send 会失败，那不是错误
            let _ = r.shutdown.send(());
        }
    }
}

/// 组装路由与中间件。抽成函数是为了测试能直接拿到真 Router。
pub(super) fn build_router(
    kb: Arc<dyn super::source::KbSource>,
    token: Arc<Mutex<String>>,
) -> Router {
    let ctx = Ctx { kb, token };
    Router::new()
        .route("/health", get(health_handler))
        .route("/mcp", post(mcp_handler))
        .with_state(ctx)
        // 后添加的层在外面，所以实际执行顺序是：并发上限 → 体上限 → handler。
        // 先拦并发再做活是对的：否则请求已经把体读完了才去排队。
        //
        // ⚠ **没抄 cc-bridge 的 gzip 压缩层。** 它需要压缩是因为有远程隧道；
        // 本服务只绑 `127.0.0.1`，压缩省下的不是网络带宽而是一次内存拷贝，
        // 换来的是真实的 CPU 开销与一整梯 async-compression 依赖。
        // —— 这与不抄 per-IP 限流是同一个理由（见 auth.rs 头部）。
        .layer(tower_http::limit::RequestBodyLimitLayer::new(BODY_LIMIT))
        .layer(tower::limit::ConcurrencyLimitLayer::new(MAX_CONCURRENCY))
}

/// `/health`：活体探针。
///
/// **故意不鉴权**：它存在的意义就是让用户在「客户端连不上」时能分清
/// 是服务没跑还是令牌填错了—— 要是它也要令牌，那两种故障就长得一模一样，
/// 这个接口也就白做了。它不返回任何笔记数据、不确认令牌、不列工具。
async fn health_handler() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "pastepanda-knowledge",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

/// `/mcp`：JSON-RPC 入口。
async fn mcp_handler(State(ctx): State<Ctx>, headers: HeaderMap, body: Bytes) -> Response {
    // 每个请求取一次当前令牌（而不是启动时拷一份），这样重置立即生效。
    let expected = match ctx.token.lock() {
        Ok(g) => g.clone(),
        Err(_) => {
            log::error!("[MCP] 令牌锁已中毒，拒绝本次请求");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "服务内部状态异常" })),
            )
                .into_response();
        }
    };
    if let Err(reject) = super::auth::check(&headers, &expected) {
        // 鉴权失败写 warn：本机服务被未授权请求敲本身就是个信号。
        // 但**不把对方递交的令牌写进日志**，那等于把凭证落盘。
        log::warn!("[MCP] 拒绝请求：{:?}", reject);
        return (reject.status(), Json(json!({ "error": reject.message() }))).into_response();
    }

    let resp = super::protocol::dispatch(&ctx.kb, &body).await;
    (StatusCode::OK, Json(resp)).into_response()
}
