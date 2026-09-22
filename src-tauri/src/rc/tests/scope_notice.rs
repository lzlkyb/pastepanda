// —— B3：被控端要能收到「对端改了画面范围」 ——

use super::store;
use crate::rc::service::RcService;
use std::sync::{Arc, Mutex};

#[test]
fn notify_callback_receives_scope() {
    let svc = RcService::new(store());
    let got = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = got.clone();
    svc.set_scope_notify(Arc::new(move |scope: &str| {
        sink.lock().unwrap().push(scope.to_string());
    }));

    svc.emit_scope_changed("primary");
    svc.emit_scope_changed("monitor:1");

    // 原样透传，不能被吞掉或改写——前端靠它拼「改成了 X」的提示
    assert_eq!(
        *got.lock().unwrap(),
        vec!["primary".to_string(), "monitor:1".to_string()]
    );
}

#[test]
fn no_callback_is_not_a_panic() {
    // 没注册回调（例如单测/无 GUI 环境）时调用不能崩
    let svc = RcService::new(store());
    svc.emit_scope_changed("virtual");
}

#[test]
fn local_scope_change_does_not_notify() {
    // 本机自己在设置页改范围（set_stream_scope）不该触发「对端改了」提示，
    // 否则被控端会被自己点的操作弹一条误导性通知。
    let svc = RcService::new(store());
    let hits = Arc::new(Mutex::new(0usize));
    let sink = hits.clone();
    svc.set_scope_notify(Arc::new(move |_s: &str| {
        *sink.lock().unwrap() += 1;
    }));

    svc.set_stream_scope("primary").expect("合法 scope");
    svc.set_stream_scope("monitor:0").expect("合法 scope");

    assert_eq!(*hits.lock().unwrap(), 0, "本机改范围不应通知被控提示");
}
