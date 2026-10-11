//! Shared recording event schema; no OS hooks.
#[derive(Debug, Clone)]
pub enum RecEvent {
    Click { x: i32, y: i32, button: MouseBtn },
    Key { combo: String },
    Mark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseBtn {
    Left,
    Right,
    Middle,
}

impl MouseBtn {
    pub fn as_str(self) -> &'static str {
        match self {
            MouseBtn::Left => "left",
            MouseBtn::Right => "right",
            MouseBtn::Middle => "middle",
        }
    }
}
