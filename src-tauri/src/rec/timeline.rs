//! 录屏视频时间轴（rec/session 用）：给定墙钟时刻，决定每个样本落在哪一毫秒。
//!
//! 为什么单独成模块：录屏有**两条轴**——音频按墙钟走（静音段靠
//! `silence_fill_frames` 补，见 session.rs），视频过去按**已提交帧数**走
//! （`已提交帧数 × 1000 / fps`）。静止画面 DXGI 不出帧 ⇒ 视频轴停住、音频轴照走，
//! 两轴差 = 全部静止时长。MF 封装的时长**由样本时间戳推**（实测见 sink.rs
//! `稀疏时间戳_容器时长跟时间戳不跟帧数`），所以视频轨就真的短了这么多：
//! 长录制里静止累积到几十秒～几分钟，播放器进度条走到视频轨末尾后画面钉住、
//! 音频与时间轴继续 = 用户报的「录制时间较长时保存的视频时间轴会卡死」。
//!
//! 修法：视频轴统一到墙钟——槽号 = `墙钟ms × fps / 1000`，时间戳始终跟着墙钟走，
//! **静止期一个样本都不补**。静止段不会缩短轨长，是因为 MF 把相邻样本之间的空隙
//! 写进了**前一个样本的 duration**（本机实测：`t=132ms` 的样本在 stts 里拿到
//! 90000/30000 = 3000ms，而我们在 `sink.rs` 显式 `SetSampleDuration` 给的 33ms 会被
//! 封装覆盖），播放器就稳定停在那一格直到下一帧出现。RustDesk 1.5.0 与 macOS 屏幕
//! 录制同此（静止零提交 + 每样本带墙钟 pts）；OBS 32.2.2 相反——它的帧源每个 tick
//! 必出新画面，才敢把 pts 当帧计数器用（`enc_frame.pts = cur_pts`），照抄到我们这种
//! 「静止就不出帧」的捕获上正是本次 bug 的成因。反过来按 ~500ms 重编上一格画面要真
//! 编码：本机实测 1080p30 静态帧 16.5ms/帧（见 sink.rs `补帧开销_静态逐格重编`），
//! 密度对静止画面毫无增益，只白吃 CPU。唯一保留的补样是收尾那一格
//! [`VideoAxis::tail_hold`]：最后一个样本没有后继，MF 只能按帧长收尾，不补就是轨尾
//! 短于墙钟。

#[derive(Debug)]
pub struct VideoAxis {
    fps: u32,
    /// 已落样本数（真帧 + 收尾那一格）
    submitted: u64,
    /// 视频轴已推进到的槽（-1 = 一个样本还没落过）。真帧落在它上面；收尾格也推进它。
    written: i64,
}

impl VideoAxis {
    pub fn new(fps: u32) -> Self {
        Self { fps: fps.max(1), submitted: 0, written: -1 }
    }

    /// 墙钟 ms（已扣暂停）→ 槽号。
    fn slot(&self, el_ms: i64) -> i64 {
        el_ms.max(0) * i64::from(self.fps) / 1000
    }

    /// 槽号 → 时间戳 ms。
    fn stamp(&self, slot: i64) -> i64 {
        slot * 1000 / i64::from(self.fps)
    }

    /// 真帧到达：返回它应落在的时间戳 ms。同一槽里连来两帧时顺延一格
    /// （相等的时间戳 MF 拒写）。静止期不会走到这里，也不落任何样本。
    pub fn arrive(&mut self, el_ms: i64) -> i64 {
        let target = self.slot(el_ms).max(self.written + 1);
        self.written = target;
        self.submitted += 1;
        self.stamp(target)
    }

    /// 收尾用（一次会话只调一次）：**无视「静止期不落样」**返回轨尾应落的时间戳。
    /// MF 只能按帧长给最后一个样本收尾，不补这一格就是轨尾短于墙钟（成品末尾没有
    /// 视频、rec-done 时长与成品对不上）。None = 无需补（手里没有可编的画面，或轨尾
    /// 已经就在墙钟那一格）。
    pub fn tail_hold(&mut self, el_ms: i64, has_prev: bool) -> Option<i64> {
        let target = self.slot(el_ms);
        if !has_prev || self.written < 0 || target <= self.written {
            return None;
        }
        self.written = target;
        self.submitted += 1;
        Some(self.stamp(target))
    }

    /// 事件打点 / 涟漪用的当前时间（不改状态）。
    pub fn at(&self, el_ms: i64) -> i64 {
        self.stamp(self.slot(el_ms).max(self.written))
    }

    /// rec-done 的时长口径 = 视频轴已推进到的槽 + 一帧。
    pub fn duration_ms(&self) -> u64 {
        if self.written < 0 {
            return 0;
        }
        (self.stamp(self.written) + 1000 / i64::from(self.fps)).max(1) as u64
    }

    /// 已落样本数（= 视频轨样本数）。
    pub fn submitted(&self) -> u64 {
        self.submitted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 场景：录了 60 秒，画面只在每 2 秒变化一次（其余静止，DXGI 不出帧）。
    /// 视频轴必须跟住墙钟——否则视频轨短于音频轨，播放器末尾就「卡死」。
    #[test]
    fn 静止段_视频轴必须跟住墙钟() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        let mut last = -1i64;
        for i in 0..30i64 {
            let at = axis.arrive(i * 2000);
            last = at;
        }
        println!(
            "60 秒会话（30 个真帧、间隔 2 秒）：末帧时间戳={last}ms 时长口径={}ms 样本数={}",
            axis.duration_ms(),
            axis.submitted()
        );
        assert!(
            last + 100 >= 58_000,
            "静止段被压缩了：末帧时间戳 {last}ms，墙钟已到 58000ms（视频轨会比音频轨短这么多，\
             播放端表现为时间轴提前结束/画面钉住）"
        );
        assert!(
            axis.duration_ms() + 100 >= 58_000,
            "rec-done 时长口径 {}ms，真实会话已录到 58000ms",
            axis.duration_ms()
        );
    }

    /// 静止期**不落任何补帧**：画面每 2 秒才变一次、主循环按 ~1/fps 跑满 60 秒时，
    /// 样本数必须只等于真帧数（31），不再每 500ms 把上一格画面重编一遍。轨长仍跟住
    /// 墙钟——空隙由封装写进**前一个样本**的 stts duration（实测见 sink.rs
    /// `稀疏时间戳_容器时长跟时间戳不跟帧数`）。谁把补帧改回来，这条就顶红。
    #[test]
    fn 静止圈不落样_时长靠时间戳() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        let mut last = -1i64;
        for k in 0..1818i64 {
            let el = k * 33;
            if k % 60 == 0 {
                last = axis.arrive(el);
            }
            // 静止圈：什么都不做（过去这里调 fill_holds，每 500ms 重编上一格画面）
        }
        let old_cadence = (60 * 1000 / 500) as u64; // 旧节奏 60 秒里要落的补帧数
        println!(
            "60 秒@30fps、每 2 秒变一次画面：样本数={} 末帧时间戳={last}ms 时长口径={}ms\
             （旧节奏≈{old_cadence} 格补帧，逐格 CFR={}）",
            axis.submitted(),
            axis.duration_ms(),
            u64::from(fps) * 60
        );
        assert_eq!(
            axis.submitted(),
            31,
            "静止圈落了样本：{} ≠ 真帧数 31——静止期不该再重编上一格画面，\
             时长本就由时间戳保证（空隙进前一样本的 stts duration）",
            axis.submitted()
        );
        assert!(
            last + 100 >= 59_000 && axis.duration_ms() + 100 >= 59_000,
            "不补帧之后时间戳没跟住墙钟：末帧 {last}ms、口径 {}ms（墙钟≈59997ms）",
            axis.duration_ms()
        );
    }

    /// 异常停顿（睡眠 / 被抢占）不追 backlog：10 分钟的停顿只落**一个**样本，
    /// 但时间戳必须跳到墙钟，否则视频轨仍按停顿前的位置走。
    #[test]
    fn 超长空洞_不追帧只跳戳() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        axis.arrive(0);
        // 机器睡了 10 分钟才回来
        let before = axis.submitted();
        let at = axis.arrive(600_000);
        println!(
            "10 分钟停顿：at_ms={at} 新增样本数={}",
            axis.submitted() - before
        );
        assert_eq!(
            axis.submitted() - before,
            1,
            "一次停顿补了 {} 个样本——主循环不该追 backlog",
            axis.submitted() - before
        );
        assert!(
            at + 100 >= 600_000,
            "弃槽也必须让时间戳跳到墙钟：at_ms={at} 而墙钟已到 600000ms"
        );
    }

    /// 收尾：静止期不落样，轨上最后一个样本可能比会话末尾早好几十秒，那一段视频轨
    /// 没有样本可停靠（MF 只能按帧长给最后一个样本收尾）= 成品末尾没有内容、
    /// rec-done 时长比成品短。tail_hold 把轨尾推到墙钟，一次会话只补这一格。
    #[test]
    fn 收尾_轨尾对齐墙钟() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        axis.arrive(0);
        let before = axis.duration_ms();
        let tail = axis.tail_hold(3_000, true);
        println!(
            "会话在 3000ms 结束：补尾前时长口径={before}ms 尾格={tail:?} 补后={}ms",
            axis.duration_ms()
        );
        assert_eq!(tail, Some(3_000), "轨尾要补在墙钟那一格，不是上一个样本的下一格");
        assert!(
            axis.duration_ms() + 100 >= 3_000,
            "补完尾格时长口径仍比墙钟短：{}ms vs 3000ms",
            axis.duration_ms()
        );
    }

    /// 时间戳必须单调不回退（回退样本让 MF 拒写、播放器乱序）。
    /// 墙钟本身不回退，但调用方可能在同一槽里连来两帧（循环跑得快）。
    #[test]
    fn 时间戳_单调不回退() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        let mut prev = i64::MIN;
        for el in [0i64, 33, 33, 20_000, 20_033, 20_040, 61_000] {
            let at = axis.arrive(el);
            assert!(at >= prev, "时间戳回退：{prev} → {at}（el_ms={el}）");
            prev = at;
        }
    }
}
