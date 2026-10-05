//! CPU 降分辨率时复用 SIMD 三角卷积和输出缓冲；BGRA 通道原样保留。
pub(in crate::rc) use pastepanda_rc_scale::BgraScaler;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(in crate::rc) struct CpuPerf {
    since: Option<Instant>,
    frames: u64,
    sums_us: [u128; 4],
    peaks_us: [u128; 4],
}

impl CpuPerf {
    pub(super) fn note(&mut self, source: (u32, u32), target: (u32, u32), parts: [Duration; 4]) {
        let now = Instant::now();
        let since = *self.since.get_or_insert(now);
        self.frames += 1;
        for (i, time) in parts.iter().enumerate() {
            self.sums_us[i] += time.as_micros();
            self.peaks_us[i] = self.peaks_us[i].max(time.as_micros());
        }
        if now.duration_since(since) < Duration::from_secs(5) { return; }
        let means = self.sums_us.map(|us| us / self.frames as u128 / 1_000);
        let peaks = self.peaks_us.map(|us| us / 1_000);
        log::info!("[RC-ENC] CPU {}x{} -> {}x{} frames={} | mean open/scale/nv12/encode={means:?}ms peak={peaks:?}ms",
            source.0, source.1, target.0, target.1, self.frames);
        *self = Self { since: Some(now), ..Default::default() };
    }
}

#[cfg(test)]
mod tests;
