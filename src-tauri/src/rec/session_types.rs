//! Shared recording options/status schema.
use super::quality::RecQuality;
#[derive(Clone, Debug)]
pub struct RecOpts {
    /// 选区矩形（虚拟屏物理像素坐标）。
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub quality: RecQuality,
    pub sys_audio: bool,
    pub mic_audio: bool,
    /// 点击高亮烧帧（四期 1.3；设置页开关，默认开）。
    pub click_highlight: bool,
    /// sidecar 事件轨道 `.events.json`（四期 1.3；默认开）。
    pub event_sidecar: bool,
}

pub struct RecStatus {
    pub recording: bool,
    pub finalizing: bool,
    /// true = 暂停中（不录内容、不计时）。
    pub paused: bool,
    pub path: Option<String>,
    /// 录制时长（扣除暂停段；毫秒）。
    pub elapsed_ms: u64,
    /// 已写入的媒体字节（视频+音频裸流；控制条体积显示）。
    pub bytes: u64,
    /// 画质档 key（控制条展示用；无会话为 None）。
    pub quality: Option<String>,
}
