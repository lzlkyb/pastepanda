//! 远程电脑（远程协助）· R0 协议与门禁 + R1 UI 壳的后端。
//!
//! 定位见规划 §3.7：已配对自有设备之间的看屏 +（R2）键鼠；
//! **不做** shell / 文件。无人值守接入（Q2 方案 B 一次性接入码、方案 C 固定密码）
//! 2026-09-19 落地。默认关闭。

pub mod ask_pop;
pub mod auto_quality;
pub mod clipboard;
pub mod discovery;
pub mod file_proto;
pub mod file_state;
pub mod file_transfer;
pub mod history;
pub mod host_capability;
pub mod inbound;
pub mod inbound_tasks;
pub mod input;
#[cfg(target_os="macos")]
#[path="../macos/remote_input.rs"]
pub(crate) mod mac_input;
#[cfg(target_os="macos")]
#[path="../macos/remote_capture.rs"]
pub(crate) mod mac_capture;
#[cfg(target_os="macos")]
#[path="../macos/remote_video.rs"]
pub(crate) mod mac_video;
pub mod join;
pub mod jpeg;
pub mod video_params;
/// 被控端会话防休眠（Windows 电源执行状态锁）。**跨平台声明**：非 Windows 由内部
/// stub 返回 `None`，推流任务的字段因此不必写 cfg（与 [`wic_jpeg`] 同一处理）。
/// ⚠️ 与 Android 端那条前台服务保活不是一回事：那条管进程不被冻结，这条管机器不睡。
pub mod keep_awake;
/// RC 会话前台服务保活（B 方案）。仅 Android 装载 Kotlin 插件，桌面 no-op。
pub mod keepalive;
pub mod link;
pub mod local_input;
pub(crate) mod media;
pub(crate) mod media_flow;
pub mod mono;
pub mod notify;
pub mod outbound;
pub mod pace;
pub mod perf;
pub mod pin;
pub mod pressed;
pub mod probe_out;
pub mod protocol;
pub mod rs_fec;
pub mod service;
pub mod settings;
pub mod short_pair;
pub mod session;
pub mod stream_cfg;
pub(crate) mod underlay;
pub mod uno;
pub mod unop;
pub mod video;
/// JPEG 兜底路径的编码器（Windows 自带 WIC，比纯 Rust `image` 快 9.4 倍）。
/// Mac 使用 ImageIO 编码，失败时回退纯 Rust；其它非 Windows 平台返回 Err。`video/encode.rs`
/// 调用点因此不必写 cfg（见该文件头注释）。
pub mod wic_jpeg;
/// 锁屏感知（S1）：WTS 会话通知 + 初始桌名探测，纯逻辑跨平台可测（见文件头）。
pub mod wts_watch;

#[cfg(any(target_os = "windows",target_os="macos"))]
pub mod audio;
#[cfg(target_os = "windows")]
pub mod dxgi;
#[cfg(target_os = "windows")]
pub mod encode_h264;
#[cfg(target_os = "windows")]
pub mod gpu;
#[cfg(target_os = "windows")]
pub mod mft_diag;
#[cfg(target_os = "windows")]
pub mod mft_pick;
pub mod vid_dgram;

#[cfg(test)]
mod tests;

/// 本机设备名：电脑主机名 / Android 原生设备名称或型号。
///
/// 放在 rc 域而不是命令层：**局域网配对要把名字随握手包自报给对方**
/// （`rc/pin.rs` 的会话 + `rc/discovery.rs` 的发送），而命令层也要用它显示。
/// 两处各写一份 `hostname::get()` 就是两个数据源，迟早不一致。
pub fn local_device_name() -> String {
    crate::device_identity::local_device_name()
}

/// 本机操作系统短标签（`Windows 11` / `Windows 10` / `macOS` / `Linux`）。
///
/// 随 `Accept` 帧自报给对端（`rc/protocol.rs` 的 `Accept::os`），对端写进设备行
/// `rc_devices.os`，设备详情显示「在线 · Windows 11 · 局域网可达」那一格。
///
/// 与 `local_device_name` 同样放 rc 域：自报方（`service.rs` 发 Accept）与
/// 展示方（`commands/rc.rs` 读库）必须同源，两处各写一份就会漂。
///
/// 采不到时返回**空串**——调用方据空串不渲染这一格，不编默认值
/// （与 `last_path` 同款约定：宁可少一格也不摆假数据）。
#[cfg(target_os = "windows")]
pub fn local_os_label() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let key = match RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
    {
        Ok(k) => k,
        // 注册表读不到（极罕见：权限被锁 / 非标准环境）。认得出是 Windows 就说
        // Windows，不编具体版本——编一个「Windows 11」出来就是假信息。
        Err(_) => return "Windows".into(),
    };
    let build: String = key.get_value("CurrentBuildNumber").unwrap_or_default();
    os_label_from_build(&build)
}

/// Windows build 号 → 版本标签。**判据的唯一定义处**（注册表读取在
/// [`local_os_label`] 里），抽成纯函数是为了让 22000 这条分界能在单测里被钉住——
/// 真机是 Win10 还是 Win11 由注册表决定，跑不了「换一台机器再试一次」。
///
/// 🔴 **不能拿 `ProductName` 判**：Win11 机器上该键照样返回「Windows 10」
///    （微软为兼容保留的已知行为，至今没改），用它判会让所有 Win11 用户
///    在自己的设备行上看到「Windows 10」。判据取 build 号：22000 = 首个
///    Win11 正式版（21H2）。
///
/// 解不开的 build（空串 / 被改过 / 非数字）退到不带版本的「Windows」——宁可少一个
/// 版本号，也不编一个出来。
#[cfg(target_os = "windows")]
pub fn os_label_from_build(build: &str) -> String {
    /// 首个 Windows 11 正式版的 build 号（21H2）。
    const FIRST_WIN11_BUILD: u32 = 22000;
    match build.trim().parse::<u32>() {
        Ok(n) if n >= FIRST_WIN11_BUILD => "Windows 11".into(),
        Ok(_) => "Windows 10".into(),
        Err(_) => "Windows".into(),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn local_os_label() -> String {
    match std::env::consts::OS {
        "macos" => "macOS".into(),
        "linux" => "Linux".into(),
        // 未知平台原样首字母大写，不编造名字
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
    }
}

pub use pin::{
    commit_allowed, Confirmed, Done, Outgoing, PairPrompt, PinOkIn, Pairs, PAIR_WINDOW_SECS,
};
pub use protocol::{Capability, RcFrame, SessionPhase, ALPN};
pub use service::{cfg_enabled, global, install_global, RcService, RcStatus};
pub use session::{
    gate_inbound, gate_outbound, is_rc_online_for, Gate, Session, SessionSnapshot, CFG_CAPABILITY,
    CFG_DEVICE_DENY, CFG_ENABLED, ONLINE_STALE_MS,
};
pub use video::VideoFrame;
