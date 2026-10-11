//! Native progress is a preview only; frontend history layers remain the navigation authority.
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
pub struct MobileInteraction<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobile-interaction")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(MobileInteraction(api.register_android_plugin(
                "com.pastepanda.app",
                "MobileInteractionPlugin",
            )?));
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn mobile_interaction_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return app
        .state::<MobileInteraction<tauri::Wry>>()
        .0
        .run_mobile_plugin::<()>("setEnabled", serde_json::json!({ "enabled": enabled }))
        .map_err(|_| "手机返回交互未就绪".to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

#[tauri::command]
pub async fn mobile_interaction_haptic(app: AppHandle, kind: String) -> Result<(), String> {
    if !matches!(kind.as_str(), "ready" | "confirm" | "reject") {
        return Err("不支持的触感类型".into());
    }
    #[cfg(target_os = "android")]
    return app
        .state::<MobileInteraction<tauri::Wry>>()
        .0
        .run_mobile_plugin::<()>("haptic", serde_json::json!({ "kind": kind }))
        .map_err(|_| "手机触感反馈不可用".to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}
