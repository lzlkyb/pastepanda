//! 丢包窗口只属于实际发送路径；连接总计会混入旧中继的迟到丢包。
use iroh::endpoint::{Connection, PathId};

#[derive(Default)]
pub(crate) struct LossSampler {
    previous: Option<(PathId, u64, u64)>,
    ema: Option<u64>,
}

impl LossSampler {
    pub(crate) fn sample(&mut self, conn: &Connection) -> Option<(i64, i64)> {
        let paths = conn.paths();
        let path = paths.iter().find(|p| p.is_selected())?;
        let stats = path.stats();
        let loss = self.observe(path.id(), stats.lost_packets, stats.udp_tx.datagrams);
        Some((stats.rtt.as_millis() as i64, loss))
    }

    fn observe(&mut self, path: PathId, lost: u64, sent: u64) -> i64 {
        let previous = self.previous.replace((path, lost, sent));
        let Some((old_path, old_lost, old_sent)) = previous else { return 0; };
        if old_path != path || lost < old_lost || sent < old_sent {
            // 新路径尚无窗口样本，清掉旧 EMA；不能让中继拥塞压低直连起步预算。
            self.ema = None;
            return 0;
        }
        if sent == old_sent { return -1; }
        let loss = lost.saturating_sub(old_lost).saturating_mul(1000)
            / (sent - old_sent);
        let loss = loss.min(1000);
        let next = self.ema.map_or(loss, |ema| (ema * 7 + loss * 3) / 10);
        self.ema = Some(next);
        next as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_drops_old_loss_and_measures_new_path_independently() {
        let mut sampler = LossSampler::default();
        let relay = PathId::ZERO;
        let direct = PathId::MAX;
        assert_eq!(sampler.observe(relay, 0, 100), 0);
        assert_eq!(sampler.observe(relay, 10, 200), 100);
        assert_eq!(sampler.observe(direct, 0, 20), 0);
        assert_eq!(sampler.observe(direct, 0, 120), 0);
        assert_eq!(sampler.observe(direct, 10, 220), 30,
            "真实新路径丢包仍须触发码控，不能一直忽略");
        assert_eq!(sampler.observe(relay, 50, 400), 0);
    }

    #[test]
    fn idle_and_reset_counters_do_not_invent_loss() {
        let mut sampler = LossSampler::default();
        assert_eq!(sampler.observe(PathId::ZERO, 10, 100), 0);
        assert_eq!(sampler.observe(PathId::ZERO, 10, 100), -1);
        assert_eq!(sampler.observe(PathId::ZERO, 0, 0), 0);
        assert_eq!(sampler.observe(PathId::ZERO, u64::MAX, 1), 1000);
    }
}
