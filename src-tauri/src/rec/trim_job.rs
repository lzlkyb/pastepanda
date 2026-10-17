//! One recoverable trim task, independent of the lifetime of a preview window.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimStatus {
    pub running: bool,
    pub percent: u8,
    pub done_path: Option<String>,
    pub error: Option<String>,
    pub in_ms: Option<u64>,
    pub out_ms: Option<u64>,
}

pub struct TrimJob {
    source: PathBuf,
    cancel: AtomicBool,
    status: Mutex<TrimStatus>,
}

static JOB: Mutex<Option<Arc<TrimJob>>> = Mutex::new(None);

pub fn start(source: &Path) -> Result<Arc<TrimJob>, String> {
    let mut slot = JOB.lock().unwrap_or_else(|p| p.into_inner());
    if slot.as_ref().is_some_and(|j| j.status.lock().unwrap_or_else(|p| p.into_inner()).running) {
        return Err("已有裁剪正在进行，请等待完成或取消".into());
    }
    let job = Arc::new(TrimJob { source: source.into(), cancel: AtomicBool::new(false),
        status: Mutex::new(TrimStatus { running: true, ..Default::default() }) });
    *slot = Some(job.clone());
    Ok(job)
}

pub fn status(source: &Path) -> TrimStatus {
    JOB.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
        .filter(|j| j.source == source)
        .map(|j| j.status.lock().unwrap_or_else(|p| p.into_inner()).clone()).unwrap_or_default()
}

pub fn cancel(source: &Path) {
    if let Some(job) = JOB.lock().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|j| j.source == source) {
        job.cancel.store(true, Ordering::Relaxed);
    }
}

impl TrimJob {
    pub fn check_cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) { Err("已取消裁剪".into()) } else { Ok(()) }
    }
    pub fn progress(&self, written: u64, total: u64) {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).percent =
            (u128::from(written) * 99 / u128::from(total.max(1))).min(99) as u8;
    }
    pub fn finish(&self, result: &Result<(u64, u64, u64), String>, destination: &Path) {
        let mut status = self.status.lock().unwrap_or_else(|p| p.into_inner());
        *status = match result {
            Ok((_, start, end)) => TrimStatus { running: false, percent: 100,
                done_path: Some(destination.display().to_string()), in_ms: Some(*start), out_ms: Some(*end), error: None },
            Err(error) => TrimStatus { error: Some(error.clone()), ..Default::default() },
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_task_keeps_progress_cancel_and_terminal_result_after_preview_closes() {
        let source=Path::new("trim-task-source.mp4");
        let job=start(source).unwrap();
        assert!(start(Path::new("other.mp4")).is_err());
        job.progress(40,100);
        assert_eq!(status(source).percent,39);
        cancel(Path::new("other.mp4"));
        assert!(job.check_cancelled().is_ok());
        cancel(source);
        assert!(job.check_cancelled().is_err());
        job.finish(&Err("已取消裁剪".into()),Path::new("partial.mp4"));
        let cancelled=status(source);
        assert!(!cancelled.running);
        assert_eq!(cancelled.error.as_deref(),Some("已取消裁剪"));
        assert!(cancelled.done_path.is_none());
        let retry=start(source).unwrap();
        retry.finish(&Ok((100,330,660)),Path::new("saved.mp4"));
        let completed=status(source);
        assert_eq!(completed.done_path.as_deref(),Some("saved.mp4"));
        assert_eq!((completed.percent,completed.in_ms,completed.out_ms),(100,Some(330),Some(660)));
    }
}
