//! 被控端：本场会话的按键口径（乙-①，2026-09-29）。
//!
//! 与 `stream_cfg` / `link` 同样的收法：**状态、判据、作废入口同文件**。
//!
//! # 为什么是「被控端存一份」而不是「每条 Key 事件带一份」
//!
//! 档位是**会话级偏好**（控端在胶囊上拨一次），不是每条输入的属性：
//! - 逐条带 → 帧变胖，且按下与补发的 up 可能带不同值（前端改了档恰好在中间）；
//! - 存一份 → 按下、抬起、收口补发读到的必然是同一个口径。
//!
//! # 为什么不做进程级全局
//!
//! `SendInput` 本身是进程级的，看着藏个 `static` 最省事；但档位有**会话生命周期**：
//! 会话结束必须回到默认档，否则下一场会话（可能是另一台设备、另一个档）在收到
//! 它的 `set_key_mode` 之前，会拿着上一场的口径打键——而它可能压根不发这条
//! （旧版控端没有这个功能）。状态挂在 `RcService` 上，收口处就有地方复位。

use super::RcService;
use crate::rc::input::KeyMode;
use std::sync::atomic::Ordering;

/// 原子存储的编解码（`AtomicU8` 存不下枚举，判据收在这两个函数里）。
fn mode_code(m: KeyMode) -> u8 {
    match m {
        KeyMode::VirtualKey => 0,
        KeyMode::ScanCode => 1,
    }
}

/// 任何非 1 的值都读成默认档：内存里出现脏值的可能性极低，但一旦发生，
/// 「读成直传」会让键按错口径注入，「读成默认」只是退回历史行为。
fn mode_of_code(v: u8) -> KeyMode {
    if v == mode_code(KeyMode::ScanCode) {
        KeyMode::ScanCode
    } else {
        KeyMode::VirtualKey
    }
}

impl RcService {
    /// 当前按键口径（注入路径与收口补发都读它）。
    pub(crate) fn key_mode(&self) -> KeyMode {
        mode_of_code(self.key_mode.load(Ordering::Relaxed))
    }

    /// 控端要求改档。返回**改前**的档位，调用方据此决定要不要给被控者提示。
    pub(crate) fn set_peer_key_mode(&self, mode: KeyMode) -> KeyMode {
        let prev = self.key_mode();
        self.key_mode.store(mode_code(mode), Ordering::Relaxed);
        prev
    }

    /// 会话收口：回到默认档。
    ///
    /// 🔴 必须在 `release_all` **之后**调——补发 up 要用本场按下时的口径，
    /// 先复位就会把扫描码按下的键用 `wVk` 弹起，只读扫描码的应用那头键卡住。
    pub(crate) fn reset_key_mode(&self) {
        self.key_mode
            .store(mode_code(KeyMode::default()), Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 编解码往返只认两档() {
        for m in [KeyMode::VirtualKey, KeyMode::ScanCode] {
            assert_eq!(mode_of_code(mode_code(m)), m);
        }
        // 脏值 → 默认档（退回历史行为，而不是换个口径打错键）
        for v in [2u8, 9, 255] {
            assert_eq!(mode_of_code(v), KeyMode::VirtualKey, "{v} 必须读成打字档");
        }
    }

    #[test]
    fn 默认是打字档_复位后仍是() {
        let svc = RcService::new(crate::rc::tests::store());
        assert_eq!(svc.key_mode(), KeyMode::VirtualKey);
        svc.set_peer_key_mode(KeyMode::ScanCode);
        assert_eq!(svc.key_mode(), KeyMode::ScanCode);
        svc.reset_key_mode();
        assert_eq!(svc.key_mode(), KeyMode::VirtualKey);
    }

    /// 乙-① 契约：`set_peer_key_mode` 返回**改前**档位（被控端要提示得先知道是不是真变了）。
    #[test]
    fn 改档返回改前值_同档重复设置也算没变() {
        let svc = RcService::new(crate::rc::tests::store());
        assert_eq!(
            svc.set_peer_key_mode(KeyMode::ScanCode),
            KeyMode::VirtualKey
        );
        assert_eq!(
            svc.set_peer_key_mode(KeyMode::ScanCode),
            KeyMode::ScanCode,
            "同档重复设置回显「没变」，不是又改了一次"
        );
    }
}
