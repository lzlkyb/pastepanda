//! Windows-only pacing for the pinned UDP punch sender.
use std::time::Duration;

#[link(name = "winmm")]
unsafe extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
    fn timeEndPeriod(period: u32) -> u32;
}

type TimerCall = unsafe extern "system" fn(u32) -> u32;

struct TimerResolution {
    release: Option<TimerCall>,
}

impl TimerResolution {
    fn acquire(begin: TimerCall, end: TimerCall) -> Self {
        let granted = unsafe { begin(1) } == 0;
        Self { release: granted.then_some(end) }
    }
}

impl Drop for TimerResolution {
    fn drop(&mut self) {
        if let Some(end) = self.release.take() {
            unsafe { end(1); }
        }
    }
}

pub(super) struct WindowsPunchPace {
    interval: tokio::time::Interval,
    // Own the request only while sending this probe batch, including cancellation.
    _resolution: TimerResolution,
}

impl WindowsPunchPace {
    pub(super) fn new() -> Self {
        let resolution = TimerResolution::acquire(timeBeginPeriod, timeEndPeriod);
        let mut interval = tokio::time::interval(Duration::from_millis(1));
        // Repeated sleep(1ms) drifts into ~16ms Windows ticks. Keep the intended
        // schedule without an unbounded catch-up burst after a stalled task.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        Self { interval, _resolution: resolution }
    }

    pub(super) async fn tick(&mut self) {
        self.interval.tick().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, atomic::{AtomicUsize, Ordering}};

    static LOCK: Mutex<()> = Mutex::new(());
    static BEGIN: AtomicUsize = AtomicUsize::new(0);
    static END: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "system" fn begin(period: u32) -> u32 {
        assert_eq!(period, 1);
        BEGIN.fetch_add(1, Ordering::SeqCst);
        0
    }
    unsafe extern "system" fn begin_failed(period: u32) -> u32 {
        assert_eq!(period, 1);
        BEGIN.fetch_add(1, Ordering::SeqCst);
        1
    }
    unsafe extern "system" fn end(period: u32) -> u32 {
        assert_eq!(period, 1);
        END.fetch_add(1, Ordering::SeqCst);
        0
    }
    fn reset() { BEGIN.store(0, Ordering::SeqCst); END.store(0, Ordering::SeqCst); }

    #[test]
    fn granted_timer_is_restored_once_on_drop() {
        let _lock = LOCK.lock().unwrap();
        reset();
        let timer = TimerResolution::acquire(begin, end);
        assert_eq!(END.load(Ordering::SeqCst), 0);
        drop(timer);
        assert_eq!(BEGIN.load(Ordering::SeqCst), 1);
        assert_eq!(END.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn denied_timer_is_not_released() {
        let _lock = LOCK.lock().unwrap();
        reset();
        drop(TimerResolution::acquire(begin_failed, end));
        assert_eq!(BEGIN.load(Ordering::SeqCst), 1);
        assert_eq!(END.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancelling_a_sender_restores_its_timer() {
        let _lock = LOCK.lock().unwrap();
        reset();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let _pace = WindowsPunchPace {
                interval: tokio::time::interval(Duration::from_millis(1)),
                _resolution: TimerResolution::acquire(begin, end),
            };
            tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        rx.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert_eq!(BEGIN.load(Ordering::SeqCst), 1);
        assert_eq!(END.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn schedule_uses_one_millisecond_and_skips_large_backlogs() {
        let pace = WindowsPunchPace::new();
        assert_eq!(pace.interval.period(), Duration::from_millis(1));
        assert_eq!(pace.interval.missed_tick_behavior(), tokio::time::MissedTickBehavior::Skip);
    }
}
