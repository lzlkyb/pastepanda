//! 锁屏感知（被控端，S1，2026-10-06）。
//!
//! # 它解决什么
//!
//! 被控机一锁屏，注入全部失效且**静默**（`rc/input.rs` 的 `SendInput` 打不进
//! `Winlogon` 桌面，失败不留痕——`docs/远程电脑-锁屏可操作-行业调研与方案-2026-10-06.md`
//! §11 已实测：锁屏后 `OpenInputDesktop` 连 `READOBJECTS` 都 denied(5)）。本模块只做
//! 「感知 + 上报」：锁/解锁状态变化时经 `mpsc` 交一个 `bool`，由会话层发
//! `{"t":"wts","locked":..}` 帧；**不解锁**（那是 S4+S6 的事）。
//!
//! # 为什么必须开一个专用线程（结论同 `keep_awake.rs`，不重推）
//!
//! 注册绑窗口、窗口归线程，清也必须同线程清。推流跑在 tokio 上，任务不固定；
//! 所以这里起一条命名线程：它自己建窗、自己注册、自己泵消息，收到停止信号后
//! 自己反注册销窗再退出。`Drop` 只发 `PostThreadMessageW(WM_QUIT)`，不 join。
//!
//! # 窗口形态
//!
//! 用**不显示的普通顶层窗**而不是 `HWND_MESSAGE`：WTS 通知要求窗口属于交互会话，
//! message-only 窗收不收 `WM_WTSSESSION_CHANGE` 没有官方背书（设计文档 §3.1）。
//! 类名带序号保证并发会话不撞名。
//!
//! # 初始态
//!
//! Windows 没有「查询是否锁定」的 API（微软文档逐字，见调研文档 §0.2）。手机连上来时
//! 电脑**可能已经是锁着的**——此时不会再有 LOCK 事件。所以线程起步先探测一次：
//! `OpenInputDesktop(READOBJECTS)` 读输入桌面名，读不到 = 输入桌面已换成不放行我们的
//! DACL 的东西（= 锁屏/安全桌面）。实测依据（调研文档 §11）：解锁态 203/203 能读到
//! `Default`，且对本机 `Default` 九个桌面权限位全 GRANTED——「读不到」不是缺权，是桌面换了。
//! 探测结果按纯函数 [`classify_open`] 分类，反例有单测钉住。

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc::Sender;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::HBRUSH;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, DestroyWindow, GetMessageW,
        GetWindowLongPtrW, PostQuitMessage, PostThreadMessageW, RegisterClassW,
        SetWindowLongPtrW, TranslateMessage, GWLP_USERDATA, HCURSOR, HICON, MSG,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY, WM_QUIT, WM_WTSSESSION_CHANGE, WNDCLASSW,
        WNDCLASS_STYLES,
    };

    static CLASS_SEQ: AtomicU32 = AtomicU32::new(0);

    // windows 0.58 未导出这两个常量：WM_WTSSESSION_CHANGE 的 wParam 值（winuser.h）。
    const WTS_SESSION_LOCK: usize = 7;
    const WTS_SESSION_UNLOCK: usize = 8;

    /// 窗口过程挂的数据：往会话层送 `bool`。只在建窗线程上触碰。
    struct Sink(Box<dyn Fn(bool) + Send>);
    type SinkPtr = *mut Sink;

    /// 线程入口。返回值为本线程的 Win32 线程 id（`0` = 没建成窗口，无需停止信号）。
    /// 探测/建窗失败都只降级（本会话少一层感知），不上抛——S1 不能因为自己影响会话。
    pub(super) fn start(notify: Sender<bool>) -> u32 {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<u32>();
        let spawned = std::thread::Builder::new().name("pastepanda-rc-wts".into()).spawn(move || {
            // 初始探测：会话建立时可能已经锁着。宁可漏报不可谎报。
            if let Some(locked) = crate::rc::wts_watch::classify_open(
                crate::rc::wts_watch::open_input_desktop_name(),
            ) {
                if notify.send(locked).is_err() {
                    ready_tx.send(0).ok();
                    return;
                }
            }
            match setup(notify) {
                Ok((hwnd, sink)) => {
                    let tid = unsafe { GetCurrentThreadId() };
                    ready_tx.send(tid).ok();
                    pump(hwnd, sink);
                }
                Err(e) => {
                    log::warn!("[RC] 锁屏感知窗口创建失败，本会话退化为只有初始探测：{e}");
                    ready_tx.send(0).ok();
                }
            }
        });
        match spawned {
            Ok(_) => ready_rx.recv().unwrap_or(0),
            Err(e) => {
                log::warn!("[RC] 锁屏感知线程起不来，本会话不感知锁屏：{e}");
                0
            }
        }
    }

    fn setup(notify: Sender<bool>) -> windows::core::Result<(HWND, SinkPtr)> {
        unsafe {
            let hinstance = GetModuleHandleW(None)?;
            let seq = CLASS_SEQ.fetch_add(1, Ordering::Relaxed);
            let class_name = HSTRING::from(format!("{}_{}", super::CLASS_BASE, seq));
            let wc = WNDCLASSW {
                style: WNDCLASS_STYLES(0),
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance.into(),
                hIcon: HICON::default(),
                hCursor: HCURSOR::default(),
                hbrBackground: HBRUSH::default(),
                lpszMenuName: PCWSTR::null(),
                lpszClassName: PCWSTR(class_name.as_ptr()),
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class_name.as_ptr()),
                PCWSTR::null(),
                WINDOW_STYLE(0), // 不调 ShowWindow：不需要被看见，只收消息
                0,
                0,
                0,
                0,
                None,
                None,
                hinstance,
                None,
            )?;
            let sink: SinkPtr = Box::into_raw(Box::new(Sink(Box::new(move |locked: bool| {
                // 上游断了 = 会话在收尾，安静退出；泵循环随后随 WM_QUIT 结束。
                notify.send(locked).ok();
            }))));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, sink as isize);
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)?;
            log::info!("[RC] 锁屏感知已注册（会话结束自动反注册）");
            Ok((hwnd, sink))
        }
    }

    fn pump(hwnd: HWND, sink: SinkPtr) {
        unsafe {
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            // 销窗前先取回 userdata（销毁后句柄失效），归还堆内存。
            let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            WTSUnRegisterSessionNotification(hwnd).ok();
            DestroyWindow(hwnd).ok();
            drop(Box::from_raw(raw as SinkPtr));
            log::info!("[RC] 锁屏感知已释放（交回系统，无残留注册）");
        }
        let _ = sink; // 内存已在上面归还；参数仅表达「泵与它是同一份」
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            if msg == WM_WTSSESSION_CHANGE {
                // SetWindowLongPtrW 之前的建窗期消息（WM_CREATE 等）拿不到 sink，空指针要挡。
                let sink = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as SinkPtr;
                if !sink.is_null() {
                    if wparam.0 == WTS_SESSION_LOCK {
                        (*sink).0(true);
                    } else if wparam.0 == WTS_SESSION_UNLOCK {
                        (*sink).0(false);
                    }
                }
                return LRESULT(0);
            }
            if msg == WM_DESTROY {
                PostQuitMessage(0);
                return LRESULT(0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }
}

/// RAII：drop 即向泵线程投 `WM_QUIT`，线程自己反注册销窗（同线程纪律，参照 `KeepAwake`
/// 「Drop 只发信号不 join」）。`thread_id == 0` = 只做了初始探测/没建成窗，无需停止信号。
#[cfg(target_os = "windows")]
pub struct WtsWatch {
    thread_id: u32,
}

#[cfg(target_os = "windows")]
impl WtsWatch {
    pub fn spawn(notify: std::sync::mpsc::Sender<bool>) -> WtsWatch {
        WtsWatch { thread_id: imp::start(notify) }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WtsWatch {
    fn drop(&mut self) {
        if self.thread_id != 0 {
            unsafe {
                use windows::Win32::Foundation::{LPARAM, WPARAM};
                use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
                if let Err(e) = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) {
                    log::warn!("[RC] 锁屏感知停止信号投递失败（进程退出场景可忽略）：{e}");
                }
            }
        }
    }
}

// ===== 可单测的纯逻辑（无环境依赖，非 Windows 也参与编译与测试） =====

pub const CLASS_BASE: &str = "pastepanda_rc_wts";

/// `OpenInputDesktop(READOBJECTS)` 的结果分类。
/// `Ok(name)` = 读到了输入桌面名；`Err(code)` = 打开失败（Win32 错误码）。
/// 返回 `Some(true)` = 判锁屏；`Some(false)` = 判未锁；`None` = API 异常（按未锁处理）。
fn classify_open(open: Result<String, u32>) -> Option<bool> {
    match open {
        // 读得到名字 ⇒ 输入桌面对我们可读 ⇒ 不是锁屏（屏保桌面 DACL 与 Default 同级）。
        Ok(_) => Some(false),
        // access denied = 输入桌面的 DACL 不放行我们 = 已换成 Winlogon 一类。
        Err(5) => Some(true),
        // 其它错误码当 API 异常：宁可漏报不可谎报（S1 的可信度就是它的全部价值）。
        Err(_) => None,
    }
}

/// `{"t":"wts","locked":bool}` 的字节帧。本仓 serde_json 启用 preserve_order（输出=
/// 插入序，与字典序无关），此处钉死字节形态当跨端契约；控端解析改动必须双端一起改。
fn wts_frame(locked: bool) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "t": "wts", "locked": locked }))
        .expect("json 序列化不可能失败")
}

#[cfg(target_os = "windows")]
fn open_input_desktop_name() -> Result<String, u32> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
        DESKTOP_READOBJECTS, UOI_NAME,
    };
    unsafe {
        // HRESULT 的低 16 位才是 Win32 错误码（0x80070005 → 5），classify 按 5 分支。
        let desk = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            .map_err(|e| (e.code().0 as u32) & 0xFFFF)?;
        let mut buf = [0u16; 64];
        let mut need = 0u32;
        // 0.58 的 HDESK 不满足 Param<HANDLE>，显式拆内核指针。
        let read = GetUserObjectInformationW(
            HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr().cast()),
            (buf.len() * 2) as u32,
            Some(&mut need),
        );
        let _ = CloseDesktop(desk);
        // 能打开却读不出名字：异常路径（u32::MAX ⇒ classify 判 None，不判锁）。
        read.map_err(|_| u32::MAX)?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_open, wts_frame};

    #[test]
    fn classify_denied_is_locked() {
        // 反例主臂：access denied（5）必须判「锁」——锁屏时唯一的可观测形态。
        assert_eq!(classify_open(Err(5)), Some(true));
    }
    #[test]
    fn classify_readable_is_unlocked() {
        assert_eq!(classify_open(Ok("Default".into())), Some(false));
        // 屏保桌面对同会话用户可读，不算锁。
        assert_eq!(classify_open(Ok("ScreenSaver".into())), Some(false));
    }
    #[test]
    fn classify_api_error_is_none_not_locked() {
        // 「宁可漏报不可谎报」：异常错误码绝不允许判成锁屏。
        assert_eq!(classify_open(Err(87)), None);
        assert_eq!(classify_open(Err(u32::MAX)), None);
    }
    #[test]
    fn frame_bytes_are_pinned() {
        // 跨端契约：控端按这两个字节串解析，改动 = 双端一起改。
        assert_eq!(wts_frame(true), br#"{"t":"wts","locked":true}"#.to_vec());
        assert_eq!(wts_frame(false), br#"{"t":"wts","locked":false}"#.to_vec());
    }
}
