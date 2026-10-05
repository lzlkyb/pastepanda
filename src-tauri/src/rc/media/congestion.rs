// Reliable media can retransmit random losses without growing its delivery queue.
// The 100ms bound matches the healthy-jitter recovery band in the media controller.
// Without a queue measurement, retain the older conservative loss-only policy.
pub(crate) fn loss_pressure(queue_ms: Option<i64>, loss_pm: u64, threshold_pm: u64) -> bool {
    loss_pm >= threshold_pm && queue_ms.is_none_or(|queue| queue >= 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn measured_delivery_distinguishes_random_loss_from_congestion() {
        assert!(!loss_pressure(Some(0), 60, 31));
        assert!(!loss_pressure(Some(80), 60, 31));
        assert!(loss_pressure(Some(120), 60, 31));
        assert!(!loss_pressure(Some(120), 10, 31));
        assert!(loss_pressure(None, 60, 31), "older peers must retain their loss protection");
    }
}
