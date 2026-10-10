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
//! 修法：视频轴统一到墙钟——槽号 = `墙钟ms × fps / 1000`，空洞按
//! [`HOLD_MIN_INTERVAL_MS`] 的节奏用上一格画面补写样本（补的是同一个码流，
//! 不重新编码），时间戳始终跟着墙钟走。为什么不是逐格（1/fps）补帧：本机实测
//! 1080p30 静态帧重编 16.5ms/帧（见 sink.rs `补帧开销_静态逐格重编`），逐格等于
//! 让「屏幕不动」这种最常见场景持续吃掉半个核，而样本密度对静止画面毫无增益；
//! 时长由时间戳保证，跳格只是稀疏、不会缩短。

/// 静止段补帧的最小间隔（ms）：距上一个样本不足这个间隔时 [`VideoAxis::fill_holds`]
/// 什么都不写，所以每圈最多落一个样本，静止段密度 ≈ 2 个/秒。
/// 这个节奏同时天然挡住了异常停顿（睡眠 / 被抢占）攒出的巨型 backlog——一次最多
/// 补一个格，剩下的空洞留给时间戳跳格。
const HOLD_MIN_INTERVAL_MS: i64 = 500;

#[derive(Debug)]
pub struct VideoAxis {
    fps: u32,
    /// 已落样本数（真帧 + 补帧）
    submitted: u64,
    /// 视频轴已推进到的槽：真帧落在它上面；补帧批次把它推到静止段的当前槽，
    /// 作为下一批的节奏锚点（-1 = 一个样本还没落过）。
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

    /// 补帧间隔（槽）：至少 1，低 fps 档也不会退化成不补。
    fn step(&self) -> i64 {
        (HOLD_MIN_INTERVAL_MS * i64::from(self.fps) / 1000).max(1)
    }

    /// 把 `(written, to]` 的空洞补掉，返回补写的时间戳（升序）。
    /// 没有上一帧、或一个样本都还没落过 ⇒ 不补（首帧没有「上一帧」可复）。
    /// 距上一个样本不足 [`HOLD_MIN_INTERVAL_MS`] ⇒ 返回空表且**不推进锚点**
    /// （否则锚点跟着墙钟滑，永远凑不满一个间隔，一格都补不出来）。
    fn fill_to(&mut self, to: i64, has_prev: bool) -> Vec<i64> {
        if !has_prev || self.written < 0 || to <= self.written {
            return Vec::new();
        }
        let anchor = self.written + self.step();
        if anchor > to {
            return Vec::new();
        }
        self.written = to;
        self.submitted += 1;
        vec![self.stamp(anchor)]
    }

    /// 真帧到达：返回（需要先用上一帧内容补写的空槽时间戳，本帧时间戳）。
    /// `has_prev` = 手里已有可复用的上一帧；首帧时为 false ⇒ 不补。
    pub fn arrive(&mut self, el_ms: i64, has_prev: bool) -> (Vec<i64>, i64) {
        // 至少比上一个样本晚一格：同一槽里连来两帧会写出相等的时间戳，MF 拒收
        let target = self.slot(el_ms).max(self.written + 1);
        let holds = self.fill_to(target - 1, has_prev);
        self.written = target;
        self.submitted += 1;
        (holds, self.stamp(target))
    }

    /// 静止圈（本圈没有真帧）：把已走到的空槽补上，返回补写的时间戳（升序）。
    pub fn fill_holds(&mut self, el_ms: i64, has_prev: bool) -> Vec<i64> {
        let target = self.slot(el_ms);
        self.fill_to(target, has_prev)
    }

    /// 收尾用（一次会话只调一次）：**无视节奏**在末尾再落一个样本，让视频轨的最后
    /// 一个时间戳就是墙钟。按 [`HOLD_MIN_INTERVAL_MS`] 落样会让轨尾比音频短最多一个
    /// 间隔（成品末尾一小段冻结），[`VideoAxis::duration_ms`] 也会跟着少报这么多。
    pub fn tail_hold(&mut self, el_ms: i64, has_prev: bool) -> Vec<i64> {
        let target = self.slot(el_ms);
        if !has_prev || self.written < 0 || target <= self.written {
            return Vec::new();
        }
        self.written = target;
        self.submitted += 1;
        vec![self.stamp(target)]
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
            let (_, at) = axis.arrive(i * 2000, i > 0);
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

    /// 密度要求：静止段也得持续落样（事件打点、涟漪、播放器拖动都按时间寻址，
    /// 60 秒只剩 30 个样本时这些全对不上），但**不许逐格重编**——每圈最多一个样本，
    /// 且节奏由 HOLD_MIN_INTERVAL_MS 决定。改回逐格会让静屏持续吃半个核（实测见
    /// sink.rs `补帧开销_静态逐格重编`）。
    #[test]
    fn 静止段_按节奏落样不逐格() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        let mut samples = 0u64;
        // 主循环按 ~1/fps 的节奏走 60 秒（1818 圈）；画面每 2 秒才变一次，
        // 即 60 圈里只有第 0 圈拿得到真帧，其余全是 DXGI 的 Ok(None)。
        for k in 0..1818i64 {
            let el = k * 33;
            if k % 60 == 0 {
                let (holds, _) = axis.arrive(el, k > 0);
                samples += 1 + holds.len() as u64;
            } else {
                samples += axis.fill_holds(el, true).len() as u64;
            }
        }
        let nominal = (60 * 1000 / HOLD_MIN_INTERVAL_MS) as u64; // 60 秒按节奏该落这么多
        let cfr = u64::from(fps) * 60;
        println!(
            "60 秒@30fps 逐圈驱动：样本数={samples}（{HOLD_MIN_INTERVAL_MS}ms 节奏≈{nominal}，\
             逐格 CFR={cfr}，完全不补只有 31）"
        );
        assert!(
            samples >= nominal / 2,
            "样本数 {samples} 太稀（60 秒会话、{HOLD_MIN_INTERVAL_MS}ms 节奏应落 {nominal}）——\
             静止段没有按节奏补帧，视频轨会比音频轨短，播放端时间轴提前结束"
        );
        assert!(
            samples <= nominal * 4,
            "样本数 {samples} 逼近逐格 CFR（{cfr}）——补帧退化成每圈重编，\
             静屏白吃半个核（实测见 sink.rs 补帧开销_静态逐格重编）"
        );
    }

    /// 异常停顿（睡眠 / 被抢占）不逐帧追 backlog：一次最多补一个格，
    /// 但锚点必须跳到墙钟，否则时间戳跟不住。
    #[test]
    fn 超长空洞_弃槽不追帧() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        axis.arrive(0, false);
        // 机器睡了 10 分钟才回来
        let (holds, at) = axis.arrive(600_000, true);
        println!("10 分钟停顿：补帧数={} at_ms={at}", holds.len());
        assert!(
            holds.len() <= 1,
            "一次补 {} 个补帧——主循环会被追 backlog 的补帧拖死",
            holds.len()
        );
        assert!(
            at + 100 >= 600_000,
            "弃槽也必须让时间戳跳到墙钟：at_ms={at} 而墙钟已到 600000ms"
        );
    }

    /// 收尾：静止段按节奏落样，最后一次落样可能比会话末尾早一个间隔，那段轨上
    /// 没有样本 = 成品末尾冻结、rec-done 时长比成品短。tail_hold 把轨尾推到墙钟。
    #[test]
    fn 收尾_轨尾对齐墙钟() {
        let fps = 30u32;
        let mut axis = VideoAxis::new(fps);
        axis.arrive(0, false);
        axis.fill_holds(1_000, true);
        let before = axis.duration_ms();
        let tail = axis.tail_hold(3_000, true);
        println!(
            "会话在 3000ms 结束：补尾前时长口径={before}ms 尾格={tail:?} 补后={}ms",
            axis.duration_ms()
        );
        assert_eq!(tail, vec![3_000], "轨尾要补在墙钟那一格，不是上一个样本的下一格");
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
            let (_, at) = axis.arrive(el, true);
            assert!(at >= prev, "时间戳回退：{prev} → {at}（el_ms={el}）");
            prev = at;
        }
    }
}
