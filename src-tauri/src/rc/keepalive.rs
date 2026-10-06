//! RC 会话前台服务保活（B 方案，2026-10-02）。
//!
//! # 它解决什么
//!
//! A 方案（bg_pause 协议 + 心跳下沉 Rust）把后台宽限做到 5 分钟，但手机进程
//! 被系统冻结/杀掉后**连 Rust 线程都会停**——心跳断、bg_resume 发不出，只能
//! 等 TTL 收口。本模块在会话期间持一个 Android **前台服务**（specialUse 类型，
//! RustDesk 同款先例）：进程升到前台服务态，Cached Apps Freezer 不冻结、
//! LMK 不优先杀，理论上后台挂多久会话都活着。与 A 方案叠加生效：前台服务
//! 保进程，A 方案保协议（前台服务只是兜底，协议纪律不放松）。
//!
//! # 结构（tauri 移动插件，项目内自持）
//!
//! - Kotlin 侧 `RcKeepalivePlugin`（源文件在 `src-tauri/android` 入库，
//!   `scripts/prepare-android.mjs` 在构建前复制到 gen）：`setKeepalive(on, title)` 启停
//!   `RcSessionForegroundService` 并持/放 WifiLock；
//! - Rust 侧这里：`init()` 注册插件并装载 Kotlin 类（android），管理
//!   [`RcKeepalive`] 状态；`rc_keepalive_set` 命令调用它（桌面 no-op）。
//!
//! 生命周期锚定在前端会话壳（`useRcSessionKeepalive`）：进入会话视图开、
//! 卸载关。服务与 App 同进程——进程死服务陪死，没有孤儿通知。

#[cfg(target_os = "android")]
use serde::Serialize;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
use tauri::Runtime;

/// 传给 Kotlin `setKeepalive` 的参数（camelCase 对齐 `KeepaliveArgs`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "android")]
struct KeepaliveArgs {
    on: bool,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "android")]
struct SessionDisplayArgs {
    session_id: String,
    on: bool,
    landscape: bool,
    orientation: String,
}

/// 已装载的 Kotlin 插件句柄（仅 Android 存在）。
#[cfg(target_os = "android")]
pub struct RcKeepalive<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> RcKeepalive<R> {
    pub fn set_session_display(
        &self,
        session_id: &str,
        on: bool,
        landscape: bool,
        orientation: &str,
    ) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>(
                "setSessionDisplay",
                SessionDisplayArgs {
                    session_id: session_id.to_string(),
                    on,
                    landscape,
                    orientation: orientation.to_string(),
                },
            )
            .map_err(|e| e.to_string())
    }

    /// 开（on=true）/ 停（on=false）前台服务。title 进常驻通知，让用户知道
    /// 「现在有会话在后台活着」。
    pub fn set(&self, on: bool, title: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>(
                "setKeepalive",
                KeepaliveArgs {
                    on,
                    title: title.to_string(),
                },
            )
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("rckeepalive")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                // 插件类在 gen/android 的 app 包下，活动类加载器按名装载
                let handle = api
                    .register_android_plugin("com.pastepanda.app", "RcKeepalivePlugin")
                    .map_err(|e| e.to_string())?;
                app.manage(RcKeepalive(handle));
            }
            let _ = (app, api);
            Ok(())
        })
        .build()
}
