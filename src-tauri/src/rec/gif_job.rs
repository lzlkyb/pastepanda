//! Shared single-job GIF export progress and cancellation.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[derive(Debug, Clone)]
pub struct GifStatus {
    pub running: bool,
    /// 0–99（100 由完成态表达）。
    pub percent: u8,
    /// 完成时的产物路径。
    pub done_path: Option<String>,
    /// 失败/取消的文案（"已取消"）。
    pub error: Option<String>,
}

struct GifJob {
    src: PathBuf,
    cancel: AtomicBool,
    percent: Mutex<u8>,
    /// true = 正在跑；结束（完成/失败/取消）后置 false 并填 result。
    running: AtomicBool,
    result: Mutex<GifStatus>,
}

static GIF_JOB: Mutex<Option<Arc<GifJob>>> = Mutex::new(None);

/// 当前导出状态（命令 rec_gif_status）。`src` 与在跑/已结束任务不匹配时返回空态。
pub fn status(src: &std::path::Path) -> GifStatus {
    let job = GIF_JOB.lock().unwrap_or_else(|p| p.into_inner()).clone();
    match job {
        Some(j) if j.running.load(Ordering::Relaxed) || j.src == src => {
            if j.running.load(Ordering::Relaxed) {
                GifStatus {
                    running: true,
                    percent: *j.percent.lock().unwrap_or_else(|p| p.into_inner()),
                    done_path: None,
                    error: None,
                }
            } else {
                j.result.lock().unwrap_or_else(|p| p.into_inner()).clone()
            }
        }
        _ => GifStatus {
            running: false,
            percent: 0,
            done_path: None,
            error: None,
        },
    }
}

/// 启动导出。已有任务在跑时拒绝（单任务串行，「取消」才有明确语义）。
pub fn start(
    src: PathBuf,
    export: fn(&std::path::Path, &AtomicBool, &Mutex<u8>) -> Result<PathBuf, String>,
) -> Result<(), String> {
    let mut slot = GIF_JOB.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = slot.as_ref() {
        if j.running.load(Ordering::Relaxed) {
            return Err("已有 GIF 导出在进行".into());
        }
    }
    let job = Arc::new(GifJob {
        src: src.clone(),
        cancel: AtomicBool::new(false),
        percent: Mutex::new(0),
        running: AtomicBool::new(true),
        result: Mutex::new(GifStatus {
            running: true,
            percent: 0,
            done_path: None,
            error: None,
        }),
    });
    *slot = Some(job.clone());
    drop(slot);
    std::thread::Builder::new()
        .name("rec-gif".into())
        .spawn({
            let job = job.clone();
            move || {
                let outcome = export(&job.src, &job.cancel, &job.percent);
                let mut result = job.result.lock().unwrap_or_else(|p| p.into_inner());
                *result = match outcome {
                    Ok(dst) => GifStatus {
                        running: false,
                        percent: 100,
                        done_path: Some(dst.display().to_string()),
                        error: None,
                    },
                    Err(e) => GifStatus {
                        running: false,
                        percent: 0,
                        done_path: None,
                        error: Some(e),
                    },
                };
                job.running.store(false, Ordering::Relaxed);
            }
        })
        .map_err(|e| {
            job.running.store(false, Ordering::Relaxed);
            let error = format!("创建导出线程失败：{e}");
            *job.result.lock().unwrap_or_else(|p| p.into_inner()) = GifStatus {
                running: false,
                percent: 0,
                done_path: None,
                error: Some(error.clone()),
            };
            error
        })?;
    Ok(())
}

/// 取消当前导出（丢弃半成品）。无任务在跑 = no-op。
pub fn cancel() {
    let slot = GIF_JOB.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = slot.as_ref() {
        if j.running.load(Ordering::Relaxed) {
            j.cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn waiting_export(
        _src: &std::path::Path,
        cancel: &AtomicBool,
        percent: &Mutex<u8>,
    ) -> Result<PathBuf, String> {
        *percent.lock().unwrap() = 42;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !cancel.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Err("已取消".into())
    }
    #[test]
    fn serial_export_reports_progress_cancels_and_releases_slot() {
        let src = PathBuf::from("test-gif-job.mp4");
        start(src.clone(), waiting_export).unwrap();
        assert!(start(PathBuf::from("other.mp4"), waiting_export).is_err());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while status(&src).percent != 42 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(status(&src).percent, 42);
        cancel();
        while status(&src).running && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let done = status(&src);
        assert!(!done.running);
        assert_eq!(done.error.as_deref(), Some("已取消"));
        assert!(status(std::path::Path::new("unrelated.mp4"))
            .error
            .is_none());
    }
}
