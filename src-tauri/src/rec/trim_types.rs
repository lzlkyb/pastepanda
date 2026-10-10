//! Shared trim timeline types and keyframe alignment.
/// 视频轨关键帧索引（播放域毫秒）。
pub struct KeyframeIndex {
    pub duration_ms: u64,
    pub keyframes_ms: Vec<u64>,
    pub warning: Option<String>,
}

/// 吸附（纯函数，宁多勿少）：入点向下吸关键帧、出点向上吸关键帧。
/// `keyframes_ms` 为空（音频轨）→ 原值返回。
pub fn snap(keyframes_ms: &[u64], duration_ms: u64, in_ms: u64, out_ms: u64) -> (u64, u64) {
    let in_m = in_ms.min(out_ms);
    let out_m = out_ms.max(in_ms).min(duration_ms);
    if keyframes_ms.is_empty() {
        return (in_m, out_m);
    }
    let kf_in = keyframes_ms.iter().rev().find(|&&k| k <= in_m).copied().unwrap_or(0);
    let kf_out = keyframes_ms.iter().find(|&&k| k >= out_m).copied().unwrap_or(duration_ms);
    (kf_in, kf_out.max(kf_in))
}
