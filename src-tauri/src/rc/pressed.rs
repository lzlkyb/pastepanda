//! 追踪「当前按住的键 / 鼠标键」，会话收口时补发 up 事件。
//!
//! 对端断线或会话结束时，目标机上被按住的 Ctrl/Shift/鼠标键不会自动弹起，
//! 会永久卡在按下态。本模块在 `handle_inbound_input` 里记录每次按下/抬起，
//! 由 `end_session` 调 `release_all()` 直接注入 up，不依赖会话能力校验。

use super::input::{inject, InputEvent, InjectResult, ScreenRegion};
use std::collections::HashSet;

/// 🔴 P1-3（2026-09-23 审计）：收口补发 up 时**重试后仍失败**的一项。
///
/// 调用方（`end_session`）拿它决定要不要报错给用户：本机 Ctrl/Shift 卡在按下态
/// 会毁掉用户接下来的每一次本地键鼠操作，这不是「记录一下就好」的级别。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseFailure {
    /// 人话描述被卡住的输入，例：`按键 vk=160` / `鼠标键 2`。
    pub what: String,
    /// 注入器返回的失败原因（UIPI 拦截、非 Windows 平台等）。
    pub error: String,
}

/// 当前按住的输入集合。
pub struct Pressed {
    keys: HashSet<u32>,
    buttons: HashSet<u8>,
}

impl Pressed {
    pub fn new() -> Self {
        Self {
            keys: HashSet::new(),
            buttons: HashSet::new(),
        }
    }

    /// 记录一次键按下，返回是否此前未按下（新按下）。
    pub fn press_key(&mut self, vk: u32) -> bool {
        self.keys.insert(vk)
    }

    /// 记录一次键抬起，返回此前是否按下。
    pub fn release_key(&mut self, vk: u32) -> bool {
        self.keys.remove(&vk)
    }

    /// 记录一次鼠标键按下，返回是否此前未按下。
    pub fn press_button(&mut self, button: u8) -> bool {
        self.buttons.insert(button)
    }

    /// 记录一次鼠标键抬起，返回此前是否按下。
    pub fn release_button(&mut self, button: u8) -> bool {
        self.buttons.remove(&button)
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty() && self.buttons.is_empty()
    }

    /// 生产入口：用真实注入函数补发 up（语义见 [`Self::release_all_with`]）。
    pub fn release_all(&mut self) -> Vec<ReleaseFailure> {
        self.release_all_with(inject)
    }

    /// 补发所有 up 事件（直接注入本机，不走会话能力校验），然后清空集合；
    /// 返回**重试一次后仍然失败**的项，交给调用方上报。
    /// 键的扩展标志由 `input::inject` 内 `is_extended_vk` 判定，这里只管发 up。
    ///
    /// 🔴 P1-3：旧实现把每个注入结果都 `let _ =` 咽掉。UIPI 拦下 up 时本机
    /// 会永久卡在按下态，用户却什么提示都看不到——静默是最坏的处理。现在：
    /// - 每项失败先重试一次（`SendInput` 的偶发失败多为瞬时队列/前台焦点问题）；
    /// - 仍失败才进返回值，由 `end_session` 经 `rc-inject-error` 事件报给前端。
    ///
    /// ❗ 无论成败最后集合都清空（`mem::take` 已达成）：这场会话已经结束了，
    ///    留着失败项只会在下一场收口时对着新的输入状态重复注入。
    ///
    /// 注入函数以参数传入（同 `stream_cfg` 把「现在几点」交给调用方的做法）：
    /// 重试与失败收集这两条纯逻辑就能在没有注入环境的机器上钉住。
    pub fn release_all_with(
        &mut self,
        mut do_inject: impl FnMut(&InputEvent, &ScreenRegion) -> InjectResult,
    ) -> Vec<ReleaseFailure> {
        let region = ScreenRegion::virtual_screen();
        let mut failures = Vec::new();
        for vk in std::mem::take(&mut self.keys) {
            let ev = InputEvent::Key { vk, down: false };
            if let Some(error) = inject_up_with_retry(&mut do_inject, &ev, &region) {
                failures.push(ReleaseFailure {
                    what: format!("按键 vk={vk}"),
                    error,
                });
            }
        }
        for b in std::mem::take(&mut self.buttons) {
            // 鼠标 up 不依赖坐标
            let ev = InputEvent::MouseButton {
                x: 0,
                y: 0,
                button: b,
                down: false,
            };
            if let Some(error) = inject_up_with_retry(&mut do_inject, &ev, &region) {
                failures.push(ReleaseFailure {
                    what: format!("鼠标键 {b}"),
                    error,
                });
            }
        }
        failures
    }
}

/// 注入一次 up；失败就原样再试一次。返回「重试后仍失败」的错误文本。
fn inject_up_with_retry(
    do_inject: &mut impl FnMut(&InputEvent, &ScreenRegion) -> InjectResult,
    ev: &InputEvent,
    region: &ScreenRegion,
) -> Option<String> {
    if do_inject(ev, region).ok {
        return None;
    }
    let second = do_inject(ev, region);
    if second.ok {
        return None;
    }
    Some(second.error)
}

impl Default for Pressed {
    /// 空集：尚无任何键按下。
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn ok(error: &str) -> InjectResult {
        InjectResult {
            ok: true,
            error: error.into(),
        }
    }

    fn fail() -> InjectResult {
        InjectResult {
            ok: false,
            error: "UIPI 拦截".into(),
        }
    }

    #[test]
    fn test_释放全部成功时不上报任何失败() {
        let mut p = Pressed::new();
        p.press_key(160);
        p.press_button(1);
        let failures = p.release_all_with(|ev, _| ok(&format!("{ev:?}")));
        assert!(failures.is_empty(), "全成功不该有失败项：{failures:?}");
        assert!(p.is_empty(), "无论成败都必须清空集合");
    }

    #[test]
    fn test_注入失败先重试一次_第二次成功就不上报() {
        let mut p = Pressed::new();
        p.press_key(160);
        let calls = std::cell::Cell::new(0usize);
        let failures = p.release_all_with(|_, _| {
            let n = calls.get();
            calls.set(n + 1);
            if n == 0 {
                fail()
            } else {
                ok("")
            }
        });
        assert!(failures.is_empty(), "重试成功不该打扰用户：{failures:?}");
        assert_eq!(calls.get(), 2, "第一次失败必须原样再注入一次");
    }

    #[test]
    fn test_重试后仍失败才上报_带得上是哪个输入和原因() {
        let mut p = Pressed::new();
        p.press_key(160);
        p.press_key(17);
        p.press_button(2);
        let failures = p.release_all_with(|_, _| fail());
        assert_eq!(failures.len(), 3, "三项都卡住了：{failures:?}");
        // 每项各试两次（一次正式 + 一次重试）
        let what: Vec<&str> = failures.iter().map(|f| f.what.as_str()).collect();
        assert!(what.iter().any(|w| *w == "按键 vk=160"), "{what:?}");
        assert!(what.iter().any(|w| *w == "按键 vk=17"), "{what:?}");
        assert!(what.iter().any(|w| *w == "鼠标键 2"), "{what:?}");
        assert!(
            failures.iter().all(|f| f.error == "UIPI 拦截"),
            "错误原因要原样交给用户：{failures:?}"
        );
        assert!(p.is_empty(), "上报之后集合照样清空");
    }

    #[test]
    fn test_空集合释放是空操作() {
        let mut p = Pressed::new();
        let calls = std::cell::Cell::new(0usize);
        let failures = p.release_all_with(|_, _| {
            calls.set(calls.get() + 1);
            ok("")
        });
        assert!(failures.is_empty());
        assert_eq!(calls.get(), 0, "没按住任何东西时不该发任何注入");
    }

    #[test]
    fn test_键盘与鼠标分别用各自的up事件() {
        let mut p = Pressed::new();
        p.press_key(160);
        p.press_button(3);
        let seen = std::rc::Rc::new(RefCell::new(Vec::<InputEvent>::new()));
        let seen2 = seen.clone();
        let failures = p.release_all_with(|ev, _| {
            seen2.borrow_mut().push(ev.clone());
            ok("")
        });
        assert!(failures.is_empty());
        let seen = seen.borrow();
        assert!(
            seen.contains(&InputEvent::Key { vk: 160, down: false }),
            "键要补发 up：{seen:?}"
        );
        assert!(
            seen.contains(&InputEvent::MouseButton {
                x: 0,
                y: 0,
                button: 3,
                down: false
            }),
            "鼠标要补发 up：{seen:?}"
        );
        assert!(
            seen.iter().all(|ev| match ev {
                InputEvent::Key { down, .. } => !down,
                InputEvent::MouseButton { down, .. } => !down,
                other => panic!("释放集合里不该出现别的输入：{other:?}"),
            }),
            "只能发抬起，不能发按下"
        );
    }
}
