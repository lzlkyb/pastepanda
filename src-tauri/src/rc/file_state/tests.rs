//! `file_state.rs` 的单元测试（从原文件尾部的 mod tests 原样平移）。

use super::*;

const T0: i64 = 1_000_000;

#[test]
fn 超时判据边界() {
    assert!(!ask_timed_out(T0, T0));
    assert!(!ask_timed_out(T0, T0 + ASK_TIMEOUT_MS - 1));
    assert!(ask_timed_out(T0, T0 + ASK_TIMEOUT_MS));
    assert!(ask_timed_out(T0, T0 + ASK_TIMEOUT_MS * 2));
    // 时钟回拨不 panic
    assert!(!ask_timed_out(T0, T0 - 5_000));
}

#[test]
fn 节流判据() {
    assert!(!should_emit(T0, T0 + 50, false));
    assert!(should_emit(T0, T0 + EMIT_MIN_INTERVAL_MS, false));
    // force 无视窗口（终态与按钮反馈必须立刻可见）
    assert!(should_emit(T0, T0, true));
    // 时钟回拨不 panic
    assert!(!should_emit(T0, T0 - 1, false));
}

#[test]
fn 两个并发请求互不干扰() {
    let st = FileState::new();
    let a = st.ask("peerA", "台式机", AskKind::Push, "a.zip", 100, T0);
    let b = st.ask("peerB", "笔记本", AskKind::Pull, "", 0, T0);
    assert_ne!(a, b, "id 必须唯一");
    assert_eq!(st.outcome(&a, T0), AskOutcome::Waiting);
    assert!(st.reply(&b, AskReply::Deny));
    // B 的拒绝不能影响 A
    assert_eq!(st.outcome(&a, T0), AskOutcome::Waiting);
    assert_eq!(st.outcome(&b, T0), AskOutcome::Deny);
    assert_eq!(st.asks().len(), 2, "两条都在，直到各自摘掉");
    st.drop_ask(&b);
    assert_eq!(st.outcome(&b, T0), AskOutcome::Gone);
    assert_eq!(st.asks().len(), 1);
}

#[test]
fn 重复回应以先到的为准() {
    let st = FileState::new();
    let a = st.ask("p", "n", AskKind::Push, "a.bin", 1, T0);
    assert!(st.reply(&a, AskReply::Accept(PathBuf::from("D:\\收"))));
    // 第二下（拒绝）不该改写已生效的决定
    assert!(!st.reply(&a, AskReply::Deny));
    assert_eq!(
        st.outcome(&a, T0),
        AskOutcome::Accept(PathBuf::from("D:\\收"))
    );
    // 不存在的 id
    assert!(!st.reply("nope", AskReply::Deny));
}

#[test]
fn 超时即拒且可被显式取消() {
    let st = FileState::new();
    let a = st.ask("p", "n", AskKind::Push, "a.bin", 1, T0);
    assert_eq!(st.outcome(&a, T0 + ASK_TIMEOUT_MS), AskOutcome::Timeout);
    st.drop_ask(&a);
    assert_eq!(st.outcome(&a, T0 + ASK_TIMEOUT_MS), AskOutcome::Gone);
}

#[test]
fn 任务生命周期与进度节流() {
    let st = FileState::new();
    let id = st.task_start("p", "笔记本", TaskDir::Recv, "大文件.bin", 1_000_000, 0, T0);
    assert_eq!(st.task_state(&id).unwrap(), TaskState::Awaiting);
    // 第一块：立刻上报（上次更新时间 == 起始时间，窗口已过）
    assert!(st.task_progress(&id, 1024, T0));
    // 紧接着的第二块：被节流
    assert!(!st.task_progress(&id, 2048, T0 + 10));
    assert!(!st.task_progress(&id, 3072, T0 + 99));
    // 窗口过了才上报
    assert!(st.task_progress(&id, 4096, T0 + 100));
    assert_eq!(st.task_state(&id).unwrap(), TaskState::Transferring);
    // 终态强制上报 + 补齐 done
    assert!(st.task_finish(&id, TaskState::Done, None, T0 + 120));
    let t = &st.tasks()[0];
    assert_eq!(t.done, t.size, "完成时 done 必须补齐到 size");
    assert_eq!(t.state, TaskState::Done);
    // 进度不会超过 size（对端报大了也不能显示 >100%）
    let id2 = st.task_start("p", "n", TaskDir::Send, "x", 10, 0, T0);
    st.task_progress(&id2, 999, T0 + 200);
    assert_eq!(st.tasks().iter().find(|t| t.id == id2).unwrap().done, 10);
}

#[test]
fn 终态任务不再被进度拉回来() {
    let st = FileState::new();
    let id = st.task_start("p", "n", TaskDir::Send, "a.bin", 100, 0, T0);
    assert!(st.task_progress(&id, 10, T0));
    st.task_finish(&id, TaskState::Canceled, None, T0);
    // 取消之后还在飞的块：不改变状态、不发事件
    assert!(!st.task_progress(&id, 20, T0 + 500));
    assert_eq!(st.task_state(&id).unwrap(), TaskState::Canceled);
    assert_eq!(st.tasks()[0].done, 10, "done 不能被终态后的块改写");
    // 失败态同理
    let id2 = st.task_start("p", "n", TaskDir::Recv, "b.bin", 100, 0, T0);
    st.task_finish(&id2, TaskState::Failed, Some("x".into()), T0);
    assert!(!st.task_progress(&id2, 50, T0 + 500));
    assert_eq!(st.task_state(&id2).unwrap(), TaskState::Failed);
}

#[test]
fn 续传任务从偏移量起算() {
    let st = FileState::new();
    let id = st.task_start("p", "n", TaskDir::Send, "v.zip", 1000, 400, T0);
    let t = &st.tasks()[0];
    assert_eq!(t.offset, 400);
    assert_eq!(t.done, 400, "续传时已完成量从断点起算（百分比直接可用）");
    st.task_progress(&id, 500, T0 + 200);
    assert_eq!(st.tasks()[0].done, 500);
}

#[test]
fn 任务表上限只清已结束的() {
    let st = FileState::new();
    // 一条运行中 + 塞满已结束
    let live = st.task_start("p", "n", TaskDir::Send, "live.bin", 10, 0, T0);
    for i in 0..MAX_TASKS {
        let id = st.task_start("p", "n", TaskDir::Send, "x", 10, 0, T0 + i as i64);
        st.task_finish(&id, TaskState::Done, None, T0 + i as i64);
    }
    // 再加一条触发清理
    st.task_start("p", "n", TaskDir::Recv, "new.bin", 10, 0, T0 + 999);
    let tasks = st.tasks();
    assert!(tasks.len() <= MAX_TASKS, "{}", tasks.len());
    assert!(
        tasks.iter().any(|t| t.id == live),
        "运行中的任务不能被清掉（否则进度条会凭空消失）"
    );
}

#[test]
fn 快照投影字段齐全() {
    let st = FileState::new();
    let _ = st.ask("p1", "台式机", AskKind::Push, "报告.zip", 123, T0);
    let id = st.task_start("p1", "台式机", TaskDir::Recv, "报告.zip", 123, 0, T0);
    st.task_finish(&id, TaskState::Failed, Some("对方断开".into()), T0 + 1);
    let snap = st.snapshot();
    let v = serde_json::to_value(&snap).unwrap();
    assert_eq!(v["asks"][0]["kind"], "push");
    assert_eq!(v["asks"][0]["name"], "报告.zip");
    assert_eq!(v["asks"][0]["size"], 123);
    assert_eq!(v["tasks"][0]["dir"], "recv");
    assert_eq!(v["tasks"][0]["state"], "failed");
    assert_eq!(v["tasks"][0]["err"], "对方断开");
    assert_eq!(v["tasks"][0]["peer_name"], "台式机");
}

/// 完成态「打开所在文件夹」：路径**缺省不进快照**（不占位），写进去后必须带着。
#[test]
fn path缺省不出现在快照里_写入后带上() {
    let st = FileState::new();
    let id = st.task_start("p", "n", TaskDir::Recv, "报告.zip", 123, 0, T0);

    let v = serde_json::to_value(st.snapshot()).unwrap();
    assert!(
        v["tasks"][0].get("path").is_none(),
        "没有路径就不该出现这个键——前端靠「有没有」决定摆不摆按钮"
    );

    assert!(
        st.task_note_path(&id, Path::new(r"C:\Users\me\Downloads\报告.zip")),
        "任务在表里就该写成功"
    );
    let v = serde_json::to_value(st.snapshot()).unwrap();
    assert_eq!(
        v["tasks"][0]["path"], r"C:\Users\me\Downloads\报告.zip",
        "写入的路径必须原样进快照（Windows 反斜杠不能被打弯）"
    );
}

/// 任务已被上限回收时报 `false`，且**不 panic**——这只是展示字段，
/// 缺了就不给按钮，绝不该因此中断传输。
#[test]
fn task_note_path对不存在的任务返回false() {
    let st = FileState::new();
    assert!(!st.task_note_path("task-不存在", Path::new(r"C:\x.bin")));
}

/// 路径**不参与判据**：带不带 path，进度与终态判据完全一致
/// （免得以后有人把 path 当「已落盘」的证据去用）。
#[test]
fn path不参与任何判据() {
    let st = FileState::new();
    let id = st.task_start("p", "n", TaskDir::Recv, "a.bin", 100, 0, T0);
    assert!(st.task_progress(&id, 50, T0 + 200));
    st.task_note_path(&id, Path::new(r"C:\x\a.bin"));
    // 写入 path 之后再推进度：节流与状态机行为不变
    assert!(!st.task_progress(&id, 60, T0 + 210), "仍在节流窗口内");
    assert!(st.task_finish(&id, TaskState::Done, None, T0 + 300));
    assert_eq!(st.task_state(&id), Some(TaskState::Done));
}

#[test]
fn 清空只清结束的() {
    let st = FileState::new();
    let live = st.task_start("p", "n", TaskDir::Send, "live", 1, 0, T0);
    let done = st.task_start("p", "n", TaskDir::Send, "done", 1, 0, T0);
    st.task_finish(&done, TaskState::Done, None, T0);
    st.clear_over();
    let tasks = st.tasks();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, live);
    // 取消判据：运行中的可以取消，已结束的不行
    assert!(st.is_running(&live));
    st.task_finish(&live, TaskState::Canceled, None, T0);
    assert!(!st.is_running(&live));
}

// ── 占位（P1-4 / P2-6）────────────────────────────────────────────

#[test]
fn peer占位互斥且可释放() {
    let st = FileState::new();
    assert!(st.try_reserve_peer("p1"));
    assert!(!st.try_reserve_peer("p1"), "second claim of same peer must fail");
    assert!(st.try_reserve_peer("p2"));
    st.release_peer("p1");
    assert!(st.try_reserve_peer("p1"), "after release, claim must succeed");
}

#[test]
fn peer占位与未结束任务互斥() {
    let st = FileState::new();
    let id = st.task_start("p", "n", TaskDir::Send, "a", 10, 0, T0);
    assert!(!st.try_reserve_peer("p"), "live task blocks reserve");
    st.task_finish(&id, TaskState::Done, None, T0 + 1);
    assert!(st.try_reserve_peer("p"), "finished task must not block reserve");
}

#[test]
fn peer占位与待响应确认条互斥() {
    let st = FileState::new();
    let _ = st.ask("p", "n", AskKind::Push, "a", 1, T0);
    assert!(!st.try_reserve_peer("p"));
}

#[test]
fn part槽互斥且可释放() {
    let st = FileState::new();
    assert!(st.try_reserve_part("a.bin.pppart"));
    assert!(st.part_reserved("a.bin.pppart"));
    assert!(!st.try_reserve_part("a.bin.pppart"), "same part must not double-claim");
    assert!(st.try_reserve_part("b.bin.pppart"));
    st.release_part("a.bin.pppart");
    assert!(!st.part_reserved("a.bin.pppart"));
    assert!(st.try_reserve_part("a.bin.pppart"));
}
