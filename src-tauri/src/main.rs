// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // stdio 桥（方案 ①）：命中开关就**只**跑桥，不构造 Tauri、不开窗口、不碰数据库。
    //
    // 🔴 必须拦在 `run()` 之前，也就是单实例插件（`lib.rs` 的
    // `tauri_plugin_single_instance`）之前：那个插件的行为是「第二个实例把参数
    // 转交给第一个实例然后自己退出」。桥若走到那一步，Claude Desktop 起的那条
    // 命令会在几毫秒内静默退出，现象是「加了配置但一个工具都没有」——
    // 而两边代码都挑不出错。
    //
    // 反过来也安全：桥自己不监听端口、不起托盘、不注册热键，
    // 所以不需要单实例保护，也不需要那套生命周期。
    if std::env::args().any(|a| a == pastepanda_lib::mcp::stdio::ARG_FLAG) {
        std::process::exit(pastepanda_lib::mcp::stdio::serve());
    }

    pastepanda_lib::run()
}
