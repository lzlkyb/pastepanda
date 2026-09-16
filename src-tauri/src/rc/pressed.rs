//! 追踪「当前按住的键 / 鼠标键」，会话收口时补发 up 事件。
//!
//! 对端断线或会话结束时，目标机上被按住的 Ctrl/Shift/鼠标键不会自动弹起，
//! 会永久卡在按下态。本模块在 `handle_inbound_input` 里记录每次按下/抬起，
//! 由 `end_session` 调 `release_all()` 直接注入 up，不依赖会话能力校验。

use super::input::{inject, InputEvent, ScreenRegion};
use std::collections::HashSet;

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

    /// 补发所有 up 事件（直接注入本机，不走会话能力校验），然后清空集合。
    /// 键的扩展标志由 `input::inject` 内 `is_extended_vk` 判定，这里只管发 up。
    pub fn release_all(&mut self) {
        let region = ScreenRegion::virtual_screen();
        for &vk in &self.keys {
            let _ = inject(&InputEvent::Key { vk, down: false }, &region);
        }
        for &b in &self.buttons {
            // 鼠标 up 不依赖坐标
            let _ = inject(
                &InputEvent::MouseButton {
                    x: 0,
                    y: 0,
                    button: b,
                    down: false,
                },
                &region,
            );
        }
        self.keys.clear();
        self.buttons.clear();
    }
}
