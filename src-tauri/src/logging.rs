//! 控制台 + 文件双写日志（2026-09-27 取证补洞）。
//!
//! 安装版没有控制台，env_logger 的输出（`[RC-PERF]` 分段汇总、编码后端
//! 选定行、熔断/降档日志）全落到 stderr 蒸发——被控端出问题只能靠猜。
//! 这里用自定义 `log::Log` 同时写 stderr 与 `%APPDATA%\com.pastepanda.app\rc.log`，
//! 超 5MB 滚动一代（rc.log → rc.1.log）。过滤口径与旧 env_logger 完全一致：
//! 尊重 `RUST_LOG`，缺省用 `default_filter` 串。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use log::{Log, Metadata, Record};

/// 单文件上限：5MB 滚动一代，两代封顶 10MB 磁盘占用。
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

// SDK 的 QNT 事件包含实际交换的两端候选；只放行稀疏事件，避免每包 socket/span 日志。
pub const DEFAULT_FILTER: &str = "info,iroh::socket=off,iroh::socket::remote_map::remote_state=warn,iroh::socket::transports::relay::actor=warn,tracing::span=off,iroh::net_report=warn,iroh_relay=warn,iroh::_events::qnt::init=debug,iroh::_events::path::abandoned=debug,iroh::_events::path::selected=debug";

pub struct FileTeeLogger {
    filter: env_filter::Filter,
    path: PathBuf,
    file: Mutex<Option<File>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_exchange_visible_without_packet_log_flood() {
        let mut builder = env_filter::Builder::new();
        builder.parse(DEFAULT_FILTER);
        let filter = builder.build();
        for target in ["iroh::_events::qnt::init", "iroh::_events::path::abandoned", "iroh::_events::path::selected"] {
            assert!(filter.enabled(&Metadata::builder().target(target).level(log::Level::Debug).build()));
        }
        for target in ["iroh::socket::transports", "iroh::socket::remote_map", "tracing::span"] {
            assert!(!filter.enabled(&Metadata::builder().target(target).level(log::Level::Info).build()));
        }
        let state = "iroh::socket::remote_map::remote_state";
        assert!(filter.enabled(&Metadata::builder().target(state).level(log::Level::Warn).build()));
        assert!(!filter.enabled(&Metadata::builder().target(state).level(log::Level::Debug).build()));
    }

    #[test]
    fn relay_status_warnings_visible_without_relay_packet_logs() {
        let mut builder = env_filter::Builder::new();
        builder.parse(DEFAULT_FILTER);
        let filter = builder.build();
        // RateLimited 在此 target 上报告；上层 socket=off 不能吞掉唯一一次通知。
        let actor = "iroh::socket::transports::relay::actor";
        assert!(filter.enabled(&Metadata::builder().target(actor).level(log::Level::Warn).build()));
        for level in [log::Level::Info, log::Level::Debug, log::Level::Trace] {
            assert!(!filter.enabled(&Metadata::builder().target(actor).level(level).build()));
        }
    }
}

impl FileTeeLogger {
    /// `default_filter`：RUST_LOG 未设置时生效的过滤串（与旧 env_logger 一致）。
    pub fn init(default_filter: &str) {
        let mut b = env_filter::Builder::new();
        b.parse(default_filter);
        if let Ok(spec) = std::env::var("RUST_LOG") {
            b.parse(&spec);
        }
        let filter = b.build();
        let max = filter.filter();
        let path = std::env::var("APPDATA")
            .map(|d| PathBuf::from(d).join("com.pastepanda.app").join("rc.log"))
            .unwrap_or_else(|_| PathBuf::from("rc.log"));
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = log::set_boxed_logger(Box::new(Self {
            filter,
            path,
            file: Mutex::new(None),
        }));
        log::set_max_level(max);
    }

    /// 取可写文件句柄；超限先滚动。失败返回 None（文件写不了不拦日志）。
    fn writable(&self) -> Option<File> {
        let mut guard = self.file.lock().ok()?;
        if let Some(f) = guard.as_ref() {
            let oversized = f.metadata().map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
            if !oversized {
                return f.try_clone().ok();
            }
        }
        // 滚动：rc.log → rc.1.log（旧 rc.1.log 直接删），再开新文件。
        let rotated = self.path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&self.path, &rotated);
        let f = OpenOptions::new().create(true).append(true).open(&self.path).ok()?;
        *guard = Some(f);
        guard.as_ref().and_then(|f| f.try_clone().ok())
    }
}

impl Log for FileTeeLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.filter.enabled(metadata)
    }

    fn log(&self, record: &Record) {
        if !self.filter.matches(record) {
            return;
        }
        let line = format!(
            "{} {:<5} [{}] {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            record.level(),
            record.target(),
            record.args()
        );
        eprint!("{line}");
        if let Some(mut f) = self.writable() {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = f.flush();
            }
        }
    }
}
