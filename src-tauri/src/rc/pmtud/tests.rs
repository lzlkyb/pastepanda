use super::*;

#[test]
fn old_probe_cannot_mutate_new_session() {
    let old = ProbeState::new();
    let new = ProbeState::new();
    old.set_frag(FRAG_BIG);
    old.note_ack(1);
    assert_eq!(new.frag(), FRAG);
    assert_eq!(new.ack_seen.load(Ordering::Relaxed), 0);
    new.set_frag(FRAG_BIG);
    old.set_frag(FRAG);
    assert_eq!(new.frag(), FRAG_BIG);
}

#[tokio::test]
async fn session_end_drops_probe_during_reprobe_sleep() {
    struct Dropped(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let guard = Dropped(dropped.clone());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (end_tx, end_rx) = tokio::sync::oneshot::channel();
    let state = Arc::new(ProbeState::new());
    let old_state = state.clone();
    let task = tokio::spawn(run_during(
        async move {
            let _guard = guard;
            let _ = started_tx.send(());
            tokio::time::sleep(Duration::from_secs(REPROBE_SECS)).await;
            old_state.set_frag(FRAG_BIG);
        },
        async move {
            let _ = end_rx.await;
        },
    ));
    started_rx.await.unwrap();
    end_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(dropped.load(Ordering::Relaxed), "不能留下睡眠中的探测任务");
    assert_eq!(state.frag(), FRAG, "取消后不再执行升档");
}

#[tokio::test]
async fn probe_completion_does_not_end_session() {
    let (end_tx, end_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(run_during(async {}, async move {
        let _ = end_rx.await;
    }));
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    end_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
}
