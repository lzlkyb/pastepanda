//! 托盘原生右键菜单（2026-10-03 方案丁双轨版）。
//!
//! 背景：部分用户右键托盘后自绘弹窗（`show_tray_popup`）整体显示不出——
//! 根因在「close 旧窗 + 固定等待 + 同名重建」这条 WebView 生命周期链上。
//! 原生菜单由系统 TrackPopupMenu 渲染，物理上不存在"显示不出"；且托盘右键
//! 是低频路径，不值得常驻一个 WebView。设计稿：
//! `design/托盘原生右键菜单-方案丁-设计稿.html`。
//!
//! 口径（与栈浮标开关同一哲学：**只有明确选中降级值才算关**）：
//! config 键 `tray_menu_style`，仅显式 `"popup"` 走自绘弹窗；缺键/脏值一律原生。
//!
//! 分工：动作项（显示/监听/贴图/浮标/设置/退出）在本文件直接调既有 Rust 函数；
//! 只有「粘贴最近记录」和「连接远程设备」经 `tray-menu-paste` /
//! `tray-menu-rc-connect` 事件交给主窗口的 `useTrayMenuBridge`——因为它们要走
//! 前端唯一的分派收口 `pasteHistoryItem`（敏感闸/类型清洗/粘贴信号回写，
//! 规则 11.1，禁止在 Rust 抄第二份）。

use serde::{Deserialize, Serialize};

/// config 键名（前端 `AppConfig.tray_menu_style` 同一份账）。
pub const STYLE_KEY: &str = "tray_menu_style";

/// 判定口径（纯函数，供守卫单测钉住）：只有明确 `"popup"` 才用自绘弹窗。
pub fn native_or_default(v: Option<&serde_json::Value>) -> bool {
    v.and_then(|x| x.as_str()).map(|s| s != "popup").unwrap_or(true)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: String,
    pub item_type: String,
    pub preview: String,
    pub text: String,
    pub content: String,
    pub source: String,
    pub content_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RcItem {
    pub label: String,
    pub cap_label: String,
    pub disabled: bool,
}

/// 一次菜单渲染需要的全部输入（纯数据，layout 单测直接喂它）。
#[derive(Clone)]
pub struct MenuSnapshot {
    pub monitoring: bool,
    pub hud_on: bool,
    pub rc: Option<RcItem>,
    pub recents: Vec<RecentEntry>,
    pub show_hotkey: String,
}

#[derive(Debug, PartialEq)]
pub enum EntrySpec {
    Item {
        id: &'static str,
        index: usize,
        title: String,
        enabled: bool,
    },
    Sep,
}

/// 托盘菜单项 id 前缀（路由判据收口在这里，别处不写字面量）。
pub const ID_SHOW: &str = "tray-native:show";
pub const ID_TOGGLE_MONITOR: &str = "tray-native:toggle_monitor";
pub const ID_PINNED: &str = "tray-native:pinned";
pub const ID_HUD: &str = "tray-native:hud";
pub const ID_SETTINGS: &str = "tray-native:settings";
pub const ID_EXIT: &str = "tray-native:exit";
pub const ID_RC: &str = "tray-native:rc_connect";
pub const ID_RECENT_BASE: &str = "tray-native:recent";
pub const ID_SCREEN_REC: &str = "tray-native:screen_rec";

const RECENT_LIMIT: usize = 3;

/// 最近条目的菜单标题（纯函数）：图片/文件带类型前缀，统一「粘贴：」动词开头。
pub fn recent_title(item_type: &str, preview: &str) -> String {
    let (prefix, text) = match item_type {
        "image" => ("🖼 ", if preview.is_empty() { "图片" } else { preview }),
        "file" => ("📁 ", preview),
        _ => ("", preview),
    };
    format!("{prefix}粘贴：{text}")
}

/// 「该显示什么」的唯一口径（规则 11.1）：条件项不满足=整项不出现；
/// 读取失败=禁用占位（分得清「没配过」与「刚才没读到」，沿用 2026-09-23 审计修）。
pub fn plan_items(snap: &MenuSnapshot) -> Vec<EntrySpec> {
    let mut out: Vec<EntrySpec> = Vec::new();
    if let Some(rc) = &snap.rc {
        out.push(EntrySpec::Item {
            id: ID_RC,
            index: 0,
            title: if rc.disabled {
                rc.label.clone()
            } else {
                format!("🖥️ 连接「{}」", rc.label)
            },
            enabled: !rc.disabled,
        });
        out.push(EntrySpec::Sep);
    }
    for (i, r) in snap.recents.iter().take(RECENT_LIMIT).enumerate() {
        out.push(EntrySpec::Item {
            id: ID_RECENT_BASE,
            index: i,
            title: recent_title(&r.item_type, &r.preview),
            enabled: true,
        });
    }
    if !snap.recents.is_empty() {
        out.push(EntrySpec::Sep);
    }
    out.push(EntrySpec::Item { id: ID_SHOW, index: 0, title: "显示主窗口".into(), enabled: true });
    out.push(EntrySpec::Item { id: ID_SCREEN_REC, index: 0, title: "🎬 屏幕录制".into(), enabled: true });
    out.push(EntrySpec::Item {
        id: ID_TOGGLE_MONITOR,
        index: 0,
        title: if snap.monitoring { "暂停监听" } else { "恢复监听" }.into(),
        enabled: true,
    });
    out.push(EntrySpec::Item { id: ID_PINNED, index: 0, title: "📌 贴图管理…".into(), enabled: true });
    if snap.hud_on {
        out.push(EntrySpec::Item { id: ID_HUD, index: 0, title: "🎯 调整浮标位置…".into(), enabled: true });
    }
    out.push(EntrySpec::Item { id: ID_SETTINGS, index: 0, title: "设置…".into(), enabled: true });
    out.push(EntrySpec::Sep);
    out.push(EntrySpec::Item { id: ID_EXIT, index: 0, title: "退出".into(), enabled: true });
    out
}

#[cfg(desktop)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{LazyLock, Mutex};
    use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
    use tauri::{AppHandle, Emitter, Manager};

    static NATIVE: AtomicBool = AtomicBool::new(true);
    static RC_ITEM: LazyLock<Mutex<Option<RcItem>>> = LazyLock::new(|| Mutex::new(None));
    static LAST_RECENTS: LazyLock<Mutex<Vec<RecentEntry>>> = LazyLock::new(|| Mutex::new(Vec::new()));
    static LAST_KEY: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
    static SHOW_HOTKEY: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));
    static LAST_HOVER: LazyLock<Mutex<std::time::Instant>> = LazyLock::new(|| Mutex::new(std::time::Instant::now()));
    static LAST_RC_EMIT: LazyLock<Mutex<Option<std::time::Instant>>> = LazyLock::new(|| Mutex::new(None));

    pub fn is_native() -> bool {
        NATIVE.load(Ordering::SeqCst)
    }

    /// save_config 钩子刷新「显示主窗口」快捷键提示（只有报文带 `hotkey` 键才动）。
    pub fn set_show_hotkey(hk: &str) {
        if let Ok(mut s) = SHOW_HOTKEY.lock() {
            *s = hk.to_string();
        }
        if is_native() {
            invalidate();
        }
    }

    fn collect_snapshot(app: &AppHandle) -> MenuSnapshot {
        let recents: Vec<RecentEntry> = crate::tray_manager::get_recent_texts_public(app, RECENT_LIMIT)
            .into_iter()
            .map(|(id, item_type, preview, text, content, source, content_type)| RecentEntry {
                id,
                item_type,
                preview,
                text,
                content,
                source,
                content_type,
            })
            .collect();
        let monitoring = crate::tray_manager::is_monitoring_public(app);
        let hud_on = crate::stack_hud::is_enabled();
        let rc = RC_ITEM.lock().ok().and_then(|g| g.clone());
        let show_hotkey = SHOW_HOTKEY.lock().map(|s| s.clone()).unwrap_or_default();
        MenuSnapshot { monitoring, hud_on, rc, recents, show_hotkey }
    }

    fn snapshot_key(snap: &MenuSnapshot) -> String {
        let mut parts: Vec<String> = snap
            .recents
            .iter()
            .map(|r| format!("{}|{}", r.id, r.preview))
            .collect();
        parts.push(format!("m={}", snap.monitoring));
        parts.push(format!("h={}", snap.hud_on));
        parts.push(format!("hk={}", snap.show_hotkey));
        parts.push(match &snap.rc {
            Some(rc) => format!("rc={}|{}", rc.label, rc.disabled),
            None => "rc=-".into(),
        });
        parts.join(";")
    }

    /// 缓存的最近条目整体替换（点击路由按 index 回来取 payload）。
    fn store_recents(recents: &[RecentEntry]) {
        if let Ok(mut v) = LAST_RECENTS.lock() {
            *v = recents.to_vec();
        }
    }

    /// 菜单项 id：最近条目按 index 展开（`tray-native:recent0`…），其余直接使用。
    fn spec_id(id: &'static str, index: usize) -> String {
        if id == ID_RECENT_BASE {
            format!("{id}{index}")
        } else {
            id.to_string()
        }
    }

    fn build_menu(app: &AppHandle, snap: &MenuSnapshot) -> tauri::Result<Menu<tauri::Wry>> {
        // 先把全部条目对象建出来持有，再统一喂给 MenuBuilder：
        // builder.item(&x) 只借引用，x 必须在 build() 前一直活着。
        let mut owned: Vec<OwnedEntry> = Vec::new();
        for spec in plan_items(snap) {
            match spec {
                EntrySpec::Sep => owned.push(OwnedEntry::Sep(PredefinedMenuItem::separator(app)?)),
                EntrySpec::Item { id, index, title, enabled } => {
                    let accel: Option<String> = if id == ID_SHOW && !snap.show_hotkey.is_empty() {
                        Some(snap.show_hotkey.clone())
                    } else if id == ID_SETTINGS {
                        Some("Ctrl+S".into())
                    } else {
                        None
                    };
                    // 快捷键串只作展示用途；用户存的串解析失败时不能让整张菜单构建失败
                    let item = MenuItem::with_id(
                        app,
                        spec_id(&id, index),
                        title.clone(),
                        enabled,
                        accel.as_deref(),
                    )
                    .or_else(|_| {
                        MenuItem::with_id(app, spec_id(&id, index), title, enabled, None::<&str>)
                    })?;
                    owned.push(OwnedEntry::Item(item));
                }
            }
        }
        let mut builder = MenuBuilder::new(app);
        for entry in &owned {
            builder = match entry {
                OwnedEntry::Item(i) => builder.item(i),
                OwnedEntry::Sep(s) => builder.item(s),
            };
        }
        builder.build()
    }

    enum OwnedEntry {
        Item(MenuItem<tauri::Wry>),
        Sep(PredefinedMenuItem<tauri::Wry>),
    }

    fn attach_or_detach(app: &AppHandle, snap: Option<&MenuSnapshot>) {
        let Some(tray) = app.tray_by_id("main-tray") else { return };
        if NATIVE.load(Ordering::SeqCst) {
            let Some(snap_owned) = snap.cloned() else { return };
            match build_menu(app, &snap_owned) {
                Ok(menu) => {
                    store_recents(&snap_owned.recents);
                    if let Ok(mut k) = LAST_KEY.lock() {
                        *k = Some(snapshot_key(&snap_owned));
                    }
                    let _ = tray.set_menu(Some(menu));
                }
                Err(e) => log::warn!("[TrayMenu] 构建原生菜单失败: {}", e),
            }
        } else {
            let _ = tray.set_menu(None::<Menu<tauri::Wry>>);
            if let Ok(mut k) = LAST_KEY.lock() {
                *k = None;
            }
        }
    }

    /// 强制下次 hover 重建（rc 推送 / 配置变更后调用）。
    fn invalidate() {
        if let Ok(mut k) = LAST_KEY.lock() {
            *k = None;
        }
    }

    /// 托盘 Enter/Move hover 时调用：数据有变才重建挂载。已在事件循环线程上。
    /// 节流：Move 每个像素变化都会触发，250ms 内的重复 hover 直接跳过；
    /// 失效标记（LAST_KEY=None，rc 推送/配置变更所置）优先于节流——那是必须重建的。
    pub fn on_hover(app: &AppHandle) {
        if !is_native() {
            return;
        }
        let throttled = LAST_HOVER
            .lock()
            .map(|t| t.elapsed().as_millis() < 250)
            .unwrap_or(false);
        let invalidated = LAST_KEY.lock().map(|k| k.is_none()).unwrap_or(true);
        if throttled && !invalidated {
            return;
        }
        if let Ok(mut t) = LAST_HOVER.lock() {
            *t = std::time::Instant::now();
        }
        let snap = collect_snapshot(app);
        let key = snapshot_key(&snap);
        let same = LAST_KEY.lock().map(|k| k.as_deref() == Some(key.as_str())).unwrap_or(false);
        if same {
            return;
        }
        attach_or_detach(app, Some(&snap));
    }

    /// 前端推送「连接远程设备」项状态；null = 三条判据不满足，整项撤下。
    pub fn set_rc_item(app: &AppHandle, item: Option<RcItem>) {
        if let Ok(mut g) = RC_ITEM.lock() {
            *g = item;
        }
        invalidate();
        if is_native() {
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                let app_ref = &app;
                let snap = collect_snapshot(app_ref);
                attach_or_detach(app_ref, Some(&snap));
            });
        }
    }

    /// `save_config` 钩子：仅本报文带 `tray_menu_style` 键时应用（口径同栈浮标）。
    pub fn apply_style_value(app: &AppHandle, cfg: &serde_json::Value) {
        let native = native_or_default(cfg.get(STYLE_KEY));
        NATIVE.store(native, Ordering::SeqCst);
        invalidate();
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let app_ref = &app;
            if native {
                let snap = collect_snapshot(app_ref);
                attach_or_detach(app_ref, Some(&snap));
            } else {
                attach_or_detach(app_ref, None);
            }
        });
    }

    /// 启动初始化：读一次配置定模式；原生则立刻挂一份菜单（hover 前也保证右键有菜单）。
    pub fn init(app: &AppHandle) {
        let native = match app.try_state::<crate::data_store::DataStore>() {
            Some(store) => match store.get_config() {
                Ok(cfg) => native_or_default(cfg.get(STYLE_KEY)),
                Err(_) => true,
            },
            None => true,
        };
        NATIVE.store(native, Ordering::SeqCst);
        if let Some(hk) = app
            .try_state::<crate::data_store::DataStore>()
            .and_then(|s| s.get_config().ok())
            .and_then(|c| c.get("hotkey").and_then(|v| v.as_str()).map(str::to_string))
        {
            if let Ok(mut s) = SHOW_HOTKEY.lock() {
                *s = hk;
            }
        }
        if native {
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                let snap = collect_snapshot(&app);
                attach_or_detach(&app, Some(&snap));
            });
        }
    }

    /// 悬停时通知前端重拉远程状态（rc 项名以最近一次推送为准，一轮 hover 内完成刷新）。
    /// 1.5s 节流：Move 事件密集，前端每次响应是 rcStatus+rcTargets 两趟命令，不能按像素发。
    pub fn request_rc_refresh(app: &AppHandle) {
        if !is_native() {
            return;
        }
        let should = LAST_RC_EMIT
            .lock()
            .map(|mut g| match *g {
                Some(t) if t.elapsed().as_millis() < 1500 => false,
                _ => {
                    *g = Some(std::time::Instant::now());
                    true
                }
            })
            .unwrap_or(true);
        if should {
            let _ = app.emit("tray-menu-rc-refresh", ());
        }
    }

    /// 菜单项点击路由（`on_menu_event` 调用，已在主线程；耗时动作挪后台线程）。
    pub fn handle_menu_event(app: &AppHandle, id: &str) {
        if id == ID_SHOW {
            let a = app.clone();
            std::thread::spawn(move || {
                let _ = crate::commands::show_main_window(a);
            });
        } else if id == ID_TOGGLE_MONITOR {
            // tooltip 反馈已收口进 toggle_monitor 命令本体，这里只管调
            let a = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = crate::commands::toggle_monitor(a) {
                    log::warn!("[TrayMenu] 切换监听失败: {}", e);
                }
            });
        } else if id == ID_SCREEN_REC {
            // 录屏统一入口：录制中=停止，否则开选区窗（rec/mod.rs 的 open_selector_window）
            let a = app.clone();
            std::thread::spawn(move || {
                #[cfg(windows)]
                crate::rec::open_selector_window(&a);
                #[cfg(not(windows))]
                let _ = a;
            });
        } else if id == ID_PINNED {
            let a = app.clone();
            std::thread::spawn(move || crate::screenshot::open_pinned_panel(a));
        } else if id == ID_HUD {
            let a = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = crate::stack_hud::stack_hud_adjust(a.clone(), None) {
                    log::warn!("[TrayMenu] 浮标调整失败: {}", e);
                    crate::tray_manager::flash_tray_badge(&a, false);
                }
            });
        } else if id == ID_SETTINGS {
            // 先 emit 再唤主窗（口径同弹窗模式 doSettings 的 emit→延迟→toggle_window）：
            // 主窗隐藏时只 emit 的话，设置面板开在看不见的窗口里=用户眼里的「点了没反应」。
            let _ = app.emit("tray-open-settings", ());
            let a = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let _ = crate::commands::show_main_window(a);
            });
        } else if id == ID_EXIT {
            let a = app.clone();
            std::thread::spawn(move || crate::commands::exit_app(a));
        } else if id == ID_RC {
            let _ = app.emit("tray-menu-rc-connect", ());
        } else if let Some(rest) = id.strip_prefix(ID_RECENT_BASE) {
            if let Ok(idx) = rest.parse::<usize>() {
                let payload = LAST_RECENTS
                    .lock()
                    .ok()
                    .and_then(|v| v.get(idx).cloned())
                    .map(|r| serde_json::to_value(&r).unwrap_or(serde_json::Value::Null));
                match payload {
                    Some(p) => {
                        let _ = app.emit("tray-menu-paste", p);
                    }
                    None => log::warn!("[TrayMenu] 最近条目 #{idx} 已过期，忽略"),
                }
            }
        }
    }
}

#[cfg(mobile)]
mod imp {
    use super::*;
    use tauri::AppHandle;
    pub fn is_native() -> bool {
        false
    }
    pub fn set_show_hotkey(_hk: &str) {}
    pub fn on_hover(_app: &AppHandle) {}
    pub fn set_rc_item(_app: &AppHandle, _item: Option<RcItem>) {}
    pub fn apply_style_value(_app: &AppHandle, _cfg: &serde_json::Value) {}
    pub fn init(_app: &AppHandle) {}
    pub fn request_rc_refresh(_app: &AppHandle) {}
    pub fn handle_menu_event(_app: &AppHandle, _id: &str) {}
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(
        monitoring: bool,
        hud_on: bool,
        rc: Option<RcItem>,
        recent_count: usize,
    ) -> MenuSnapshot {
        MenuSnapshot {
            monitoring,
            hud_on,
            rc,
            recents: (0..recent_count)
                .map(|i| RecentEntry {
                    id: format!("r{i}"),
                    item_type: "text".into(),
                    preview: format!("p{i}"),
                    text: String::new(),
                    content: String::new(),
                    source: String::new(),
                    content_type: String::new(),
                })
                .collect(),
            show_hotkey: String::new(),
        }
    }

    fn ids(specs: &[EntrySpec]) -> Vec<&'static str> {
        specs
            .iter()
            .filter_map(|s| match s {
                EntrySpec::Item { id, .. } => Some(*id),
                EntrySpec::Sep => None,
            })
            .collect()
    }

    #[test]
    fn 样式口径_只有显式popup才切自绘() {
        assert!(native_or_default(None));
        assert!(native_or_default(Some(&serde_json::json!("native"))));
        assert!(native_or_default(Some(&serde_json::json!(null))));
        assert!(native_or_default(Some(&serde_json::json!("脏值"))));
        assert!(!native_or_default(Some(&serde_json::json!("popup"))));
    }

    #[test]
    fn 守卫_浮标关不摆调整项浮标开才摆() {
        assert!(!ids(&plan_items(&snap(true, false, None, 0))).contains(&ID_HUD));
        assert!(ids(&plan_items(&snap(true, true, None, 0))).contains(&ID_HUD));
    }

    #[test]
    fn 守卫_rc判据不满足整项消失_读取失败留禁用占位() {
        let plain = plan_items(&snap(true, false, None, 1));
        assert!(!ids(&plain).contains(&ID_RC));

        let err = snap(true, false, Some(RcItem { label: "远程设备暂不可用".into(), cap_label: String::new(), disabled: true }), 1);
        let specs = plan_items(&err);
        let item = specs
            .iter()
            .find(|s| matches!(s, EntrySpec::Item { id, .. } if *id == ID_RC));
        assert!(item.is_some(), "读取失败必须留占位，不能静默消失（2026-09-23 审计口径）");
        if let Some(EntrySpec::Item { enabled, title, .. }) = item {
            assert!(!enabled);
            assert_eq!(title, "远程设备暂不可用");
        }

        let ok = snap(true, false, Some(RcItem { label: "家里台式机".into(), cap_label: "可控".into(), disabled: false }), 1);
        let specs = plan_items(&ok);
        let item = specs.iter().find(|s| matches!(s, EntrySpec::Item { id, .. } if *id == ID_RC));
        if let Some(EntrySpec::Item { enabled, title, .. }) = item {
            assert!(enabled);
            assert!(title.contains("家里台式机"));
        } else {
            panic!("可连状态下必须摆出 rc 项");
        }
    }

    #[test]
    fn 守卫_无最近记录时不出现空段与多余分隔线() {
        let specs = plan_items(&snap(true, false, None, 0));
        assert!(!specs.iter().any(|s| matches!(s, EntrySpec::Item { id, .. } if *id == ID_RECENT_BASE)));
        // 头部（无 rc、无 recent）→ 第一项直接是「显示主窗口」，前面不能有 Sep
        assert!(matches!(specs.first(), Some(EntrySpec::Item { id, .. }) if *id == ID_SHOW));
    }

    #[test]
    fn 监听双态文案随状态翻转() {
        let on = plan_items(&snap(true, false, None, 0));
        let off = plan_items(&snap(false, false, None, 0));
        let title = |specs: &[EntrySpec]| match specs.iter().find(|s| matches!(s, EntrySpec::Item { id, .. } if *id == ID_TOGGLE_MONITOR)) {
            Some(EntrySpec::Item { title, .. }) => title.clone(),
            _ => panic!("监听项恒在"),
        };
        assert_eq!(title(&on), "暂停监听");
        assert_eq!(title(&off), "恢复监听");
    }

    #[test]
    fn 最近条目标题_图片空预览有兜底() {
        assert_eq!(recent_title("text", "你好"), "粘贴：你好");
        assert_eq!(recent_title("image", ""), "🖼 粘贴：图片");
        assert_eq!(recent_title("image", "第一行OCR"), "🖼 粘贴：第一行OCR");
        assert_eq!(recent_title("file", "报告.md"), "📁 粘贴：报告.md");
    }
}
