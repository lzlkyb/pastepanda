//! 会话防休眠（被控端，2026-10-04）。
//!
//! # 它解决什么
//!
//! 被控的这台机器一旦按电源策略进休眠，**三件事同时没**且界面永远报不出来：
//! 桌面复制断了（`rc/dxgi.rs` 已写明「个别输出复制不了（休眠/受保护内容）」）、
//! QUIC 连接随网络栈一起停、`SendInput` 打在锁屏上。发起端那边只会看到画面冻住，
//! 而被控端用户回来只会看到「会话不知什么时候断了」——这不是网络问题，本机没有任何
//! 提示位可摆。无人值守（`rc/unop.rs`）更是直接被作废：远程唤不醒一台睡着的机器，
//! 我们也没有 WOL。
//!
//! # 为什么必须开一个专用线程
//!
//! 🔴 `SetThreadExecutionState` 的请求**绑在调用它的那个 OS 线程上，该线程退出即清除**
//! （MSDN 明确：ES_CONTINUOUS 的组合只影响调用线程自己的持续请求）。本项目的推流跑在
//! tokio 上，任务/线程都不固定，RAII `Drop` 更可能落在任意一个 worker 上——照「构造时
//! 设、析构时清」写，设和清大概率不在同一线程，结果是**请求泄漏**（会话早结束了机器
//! 还不睡）或**提前消失**。所以这里起一条命名线程：它自己设、收到停止信号后自己清、
//! 然后退出，两次调用天然同线程。
//!
//! 顺带两个好处：`Drop` 只需发信号、不必 join（发信号后线程自己收尾，不阻塞 `.await`）；
//! 连开两场会话时旧线程即使还没退出，它清掉的也只是自己那份请求，**不会**取消新会话的。
//!
//! # 与 Android 端「会话前台服务保活」的分工
//!
//! 那条持前台服务 + WifiLock，管的是「App 进程还活着吗」（不被系统冻结/杀掉）；
//! 这条是 Windows 电源执行状态锁，管的是「机器还醒着吗」。两者不互相替代。

/// 一场会话的防休眠守卫。`None`（不构造）= 本会话不防休眠。
///
/// 释放方式是 `Drop`：把它做成推流任务（`InboundVideo`）的字段，`run(mut self)` 的
/// 每一条退出路径——正常收口、对端断链、被「结束会话」强制收掉——都会析构它。
/// 不依赖任何「记得在结束时调一次 release」的纪律。
#[cfg(target_os = "windows")]
pub struct KeepAwake {
    /// 停止信号。`Option` 只为 `Drop` 能取走它（取不到 = 已经发过）。
    stop: Option<std::sync::mpsc::Sender<()>>,
}

#[cfg(target_os = "windows")]
impl KeepAwake {
    /// 持住「系统不睡 + 显示器不熄」。
    ///
    /// 返回 `None` = 没拿到锁（起线程失败 / 系统拒绝），调用方照常推流——
    /// 防休眠是加分项，不能因为它失败就把会话掐了。失败一定有 warn 日志。
    ///
    /// 🔴 `ES_DISPLAY_REQUIRED` 必须和 `ES_SYSTEM_REQUIRED` 一起拿：只保系统不睡的话，
    ///    显示器按策略照常熄，而输出一进休眠 DXGI 复制就失败（见模块头注释），
    ///    等于这个开关开了却没解决主要问题。代价写在设置页文案里（屏幕常亮吃电发热），
    ///    所以 [`CFG_KEEP_AWAKE_DEFAULT`](crate::rc::service::CFG_KEEP_AWAKE_DEFAULT) 是关。
    pub fn start() -> Option<Self> {
        use windows::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let spawned = std::thread::Builder::new()
            .name("rc-keep-awake".into())
            .spawn(move || {
                let both = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED;
                // 🔴 返回值的契约（MSDN winbase/SetThreadExecutionState，2025-07-01 版原文）：
                //   成功返回**本线程之前的**执行状态，失败返回 NULL。
                // 所以这个值**不能当成败标志**：它说的是「这条线程之前提过什么请求」，
                // 而 0 恰好又是失败哨兵——首版按 `got.0 == 0` 判失败，把「之前没状态」
                // 读成了「申请被拒」。本机实测（P/Invoke 走同样写法）：新进程首次调用返回
                // 0x80000000，也就是 Windows 给线程的初值自带 ES_CONTINUOUS，那次并没有
                // 当场误判——但初值随线程来路而变，拿它判成败从契约上就不成立。
                // 想要真值只能**再设一次同样的参数探**：第二次返回的就是第一次设下的状态
                // （本机实测 0x80000003 = 系统位与显示器位都真的给了）。
                unsafe { SetThreadExecutionState(both) };
                let held = unsafe { SetThreadExecutionState(both) };
                if !held.contains(ES_SYSTEM_REQUIRED) {
                    log::warn!("[RC] 防休眠未生效（系统位没拿到），本会话不保活");
                    return;
                }
                if held.contains(ES_DISPLAY_REQUIRED) {
                    log::info!("[RC] 会话防休眠已生效：系统不休眠、显示器不熄（会话结束自动恢复）");
                } else {
                    // 显示器位被忽略不影响本会话可用：画面靠的是采集侧，显示器熄了
                    // 也只是省不了电的那半没做到（`rc/dxgi.rs` 的休眠失败是系统睡过去）。
                    log::info!("[RC] 会话防休眠已生效（本机只接受了系统保活，显示器位被忽略）");
                }
                // 阻塞等释放信号。对面 drop 后发送端关闭（或被 drop）→ recv 也返回 Err，
                // 同样落到清理，不会出现「守卫没了但线程还在等」的挂死。
                let _ = rx.recv();
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                log::info!("[RC] 会话防休眠已释放（交回本机原电源策略）");
            });
        match spawned {
            Ok(_) => Some(Self { stop: Some(tx) }),
            Err(e) => {
                log::warn!("[RC] 防休眠线程起不来，本会话不保活：{e}");
                None
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            // 只发信号、不 join：清理由那条线程自己在它的线程上做。
            let _ = tx.send(());
        }
    }
}

/// 非 Windows：能力整体是 Windows 电源 API 专属。**明确不保活**（返回 `None`），
/// 设置项那条路径由 `rc_set_keep_awake` 直接报错拦住，静默成功会让开关切到假状态。
#[cfg(not(target_os = "windows"))]
pub struct KeepAwake;

#[cfg(not(target_os = "windows"))]
impl KeepAwake {
    pub fn start() -> Option<Self> {
        None
    }
}
