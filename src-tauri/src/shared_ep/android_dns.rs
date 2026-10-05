//! Wry 不初始化 ndk-context；iroh 的 Android 系统 DNS 读取器需要这份上下文。

pub(super) async fn init() -> Result<(), String> {
    static READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    READY.get_or_try_init(|| async {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tauri::wry::prelude::dispatch(move |env, activity, _webview| {
            let result = (|| -> Result<(), String> {
                let vm = env.get_java_vm().map_err(|e| e.to_string())?;
                let application = env.call_method(
                    activity, "getApplicationContext", "()Landroid/content/Context;", &[],
                ).and_then(|value| value.l()).map_err(|e| e.to_string())?;
                let application = env.new_global_ref(application).map_err(|e| e.to_string())?;
                // SDK 要求 jobject 有效直到进程退出；只保留一份 Application 全局引用，
                // 不保存会随 Activity 销毁的局部引用。READY 防止重复初始化。
                let application = Box::leak(Box::new(application));
                unsafe {
                    iroh::dns::install_android_jni_context(
                        vm.get_java_vm_pointer().cast(), application.as_obj().as_raw().cast(),
                    );
                }
                log::info!("[IROH-DNS] Android 系统 DNS 上下文已初始化");
                Ok(())
            })();
            let _ = tx.send(result);
        });
        rx.await.map_err(|e| format!("Android DNS 初始化回调失败：{e}"))?
    }).await?;
    Ok(())
}
