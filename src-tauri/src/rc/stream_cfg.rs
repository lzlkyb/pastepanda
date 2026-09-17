//! 推流参数（画质档 / 截取范围 / 强制 JPEG）与心跳活性。
//!
//! 为什么单独一个模块：三个 `set_stream_*` 全是**纯校验 + 写字段**，但原先挂在
//! `RcService` 上——而那个类型持有 DataStore、iroh endpoint 和一堆锁，构造不出来，
//! 于是 `set_scope` 的四条分支**一条测试都没有**。采集范围是隐私面（对端能改你
//! 的画面范围），没有守门测试说不过去。搬到这里之后这些分支可以直接断言。
//!
//! **时间不进这个模块**：`touch_activity` / `should_pause` 的「现在」由调用方传入，
//! 暂停判定因此可以用假时钟精确断言，不必 sleep 或依赖机器负载。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use super::service::{CFG_CAPTURE_SCOPE, CFG_QUALITY};

/// 心跳超时：超过这么久没有输入/心跳 ⇒ 暂停推流。
const HEARTBEAT_TIMEOUT_MS: i64 = 3_500;

/// 会话中可被发起端改的推流参数。
///
/// 字段是 `pub(super)` 而不是私有：取流的两条循环（`spawn_outbound_video` /
/// `spawn_inbound_video`）要直接读 `monitor` / `virtual_screen` / `force_jpeg`
/// 来决定抓哪块屏、走 H.264 还是 JPEG。给它们加访问器只会让那两段代码更长。
#[derive(Debug, Clone, Copy)]
pub(super) struct StreamOpts {
    pub(super) profile: super::video::EncodeProfile,
    pub(super) virtual_screen: bool,
    /// >=0 抓指定显示器；-1 跟随 virtual_screen。
    pub(super) monitor: i32,
    /// 发起端解不出 H.264 时置 true，本会话强制 JPEG。
    pub(super) force_jpeg: bool,
}

impl Default for StreamOpts {
    fn default() -> Self {
        Self {
            profile: super::video::EncodeProfile::default(),
            virtual_screen: true,
            monitor: -1,
            force_jpeg: false,
        }
    }
}

/// 推流参数 + 心跳/RTT 活性状态。字段私有，只能走下面这些口子。
pub(super) struct StreamCfg {
    opts: Mutex<StreamOpts>,
    /// 被控端：最近一次收到发起端输入/心跳的时间（0 = 尚未收到）。
    last_activity_ms: AtomicI64,
    /// 发起端最近一次测得的 RTT（毫秒）；0 = 尚未测到。
    last_rtt_ms: AtomicI64,
    /// 发起端上报的 RTT（NetHint）；被控端据此缩 H.264 码率。0 = 尚未收到。
    peer_rtt_ms: AtomicI64,
}

/// RTT → 码率缩放百分比（25–100）。局域网 <50ms 全速；跨网逐步砍。
pub fn bitrate_scale_for_rtt(rtt_ms: i64) -> u32 {
    match rtt_ms.max(0) {
        0..=49 => 100,
        50..=99 => 80,
        100..=199 => 60,
        200..=399 => 40,
        _ => 25,
    }
}

impl StreamCfg {
    pub(super) fn new() -> Self {
        Self {
            opts: Mutex::new(StreamOpts::default()),
            last_activity_ms: AtomicI64::new(0),
            last_rtt_ms: AtomicI64::new(0),
            peer_rtt_ms: AtomicI64::new(0),
        }
    }

    pub(super) fn note_rtt(&self, rtt_ms: i64) {
        self.last_rtt_ms.store(rtt_ms.max(0), Ordering::Relaxed);
    }

    pub(super) fn rtt_ms(&self) -> i64 {
        self.last_rtt_ms.load(Ordering::Relaxed)
    }

    /// 被控端：记录对端上报的 RTT，并给出当前码率缩放（%）。
    pub(super) fn set_peer_rtt(&self, rtt_ms: i64) -> u32 {
        let v = rtt_ms.max(0);
        self.peer_rtt_ms.store(v, Ordering::Relaxed);
        self.bitrate_scale()
    }

    pub(super) fn bitrate_scale(&self) -> u32 {
        bitrate_scale_for_rtt(self.peer_rtt_ms.load(Ordering::Relaxed))
    }

    /// 会话建立时用本机配置初始化推流参数（画质与范围由调用方从配置解析好后传入）。
    pub(super) fn reset_from_cfg(
        &self,
        profile: super::video::EncodeProfile,
        virtual_screen: bool,
    ) {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        g.profile = profile;
        g.virtual_screen = virtual_screen;
        g.monitor = -1;
        g.force_jpeg = false;
        self.peer_rtt_ms.store(0, Ordering::Relaxed);
    }

    /// 发起端在会话中改画质。
    pub(super) fn set_quality(&self, quality: &str) -> Result<(), String> {
        if !matches!(quality, "uhd" | "ultra" | "sharp" | "balanced" | "smooth") {
            return Err("画质档只能是 uhd / ultra / sharp / balanced / smooth".into());
        }
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        g.profile = super::video::EncodeProfile::of_name(quality);
        Ok(())
    }

    /// 发起端在会话中改截取范围。
    pub(super) fn set_scope(&self, scope: &str) -> Result<(), String> {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        if scope == "virtual" {
            g.virtual_screen = true;
            g.monitor = -1;
            return Ok(());
        }
        if scope == "primary" {
            g.virtual_screen = false;
            g.monitor = -1;
            return Ok(());
        }
        if let Some(n) = scope.strip_prefix("monitor:") {
            let idx: i32 = n
                .parse()
                .map_err(|_| "显示器编号无效，应为 monitor:0 / monitor:1…")?;
            if idx < 0 {
                return Err("显示器编号不能为负".into());
            }
            g.virtual_screen = false;
            g.monitor = idx;
            return Ok(());
        }
        Err("截取范围只能是 virtual / primary / monitor:N".into())
    }

    /// 发起端：H.264 解不出时强制本会话走 JPEG；`codec=h264` 可再打开。
    pub(super) fn set_codec(&self, codec: &str) -> Result<(), String> {
        let mut g = self.opts.lock().unwrap_or_else(|p| p.into_inner());
        match codec {
            "jpeg" => {
                g.force_jpeg = true;
                Ok(())
            }
            "h264" => {
                g.force_jpeg = false;
                Ok(())
            }
            _ => Err("编码只能是 jpeg 或 h264".into()),
        }
    }

    pub(super) fn snapshot(&self) -> StreamOpts {
        *self.opts.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn touch_activity(&self, now_ms: i64) {
        self.last_activity_ms.store(now_ms, Ordering::Relaxed);
    }

    /// 是否应暂停推流：会话开始后长时间无心跳/输入。
    pub(super) fn should_pause(&self, now_ms: i64) -> bool {
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        if last == 0 {
            // 尚未收到任何输入：给发起端 5s 窗口发首个心跳
            return false;
        }
        now_ms - last > HEARTBEAT_TIMEOUT_MS
    }
}

/// 从配置里解析画质档。抽成自由函数是为了能直接单测默认值与非法值的回落。
pub(super) fn profile_from_cfg(cfg: &serde_json::Value) -> super::video::EncodeProfile {
    super::video::EncodeProfile::of_name(
        cfg.get(CFG_QUALITY)
            .and_then(|v| v.as_str())
            .unwrap_or("balanced"),
    )
}

/// 从配置里解析「是否抓整个虚拟屏」。只有显式 `primary` 才算否，其余（含缺省）都抓整屏。
pub(super) fn virtual_screen_from_cfg(cfg: &serde_json::Value) -> bool {
    cfg.get(CFG_CAPTURE_SCOPE)
        .and_then(|v| v.as_str())
        .map(|s| s != "primary")
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c() -> StreamCfg {
        StreamCfg::new()
    }

    #[test]
    fn 范围_virtual_抓整屏() {
        let s = c();
        s.set_scope("virtual").expect("virtual 合法");
        let o = s.snapshot();
        assert!(o.virtual_screen);
        assert_eq!(o.monitor, -1);
    }

    #[test]
    fn 范围_primary_抓主屏() {
        let s = c();
        s.set_scope("primary").expect("primary 合法");
        let o = s.snapshot();
        assert!(!o.virtual_screen);
        assert_eq!(o.monitor, -1);
    }

    #[test]
    fn 范围_monitor编号合法时落到具体显示器() {
        let s = c();
        s.set_scope("monitor:1").expect("monitor:1 合法");
        let o = s.snapshot();
        assert!(!o.virtual_screen, "指定显示器就不该再走整屏");
        assert_eq!(o.monitor, 1);
    }

    #[test]
    fn 范围_monitor负号被拒且不改状态() {
        let s = c();
        s.set_scope("monitor:0").expect("先设一个合法值");
        let err = s.set_scope("monitor:-1").expect_err("负数必须被拒");
        assert_eq!(err, "显示器编号不能为负");
        assert_eq!(s.snapshot().monitor, 0, "被拒就不能留下半截改动");
    }

    #[test]
    fn 范围_monitor非数字被拒() {
        let s = c();
        let err = s.set_scope("monitor:x").expect_err("非数字必须被拒");
        assert_eq!(err, "显示器编号无效，应为 monitor:0 / monitor:1…");
    }

    #[test]
    fn 范围_乱字符串被拒() {
        let s = c();
        assert!(s.set_scope("").is_err());
        assert!(s.set_scope("Monitor:0").is_err(), "大小写敏感，不做兜底");
        assert!(s.set_scope("all").is_err());
    }

    #[test]
    fn 画质五档合法其余被拒() {
        let s = c();
        for q in ["uhd", "ultra", "sharp", "balanced", "smooth"] {
            assert!(s.set_quality(q).is_ok(), "{q} 应合法");
        }
        let err = s.set_quality("4k").expect_err("未定义的档位必须被拒");
        assert_eq!(err, "画质档只能是 uhd / ultra / sharp / balanced / smooth");
    }

    #[test]
    fn 编码只认_jpeg_与_h264() {
        let s = c();
        assert!(s.set_codec("jpeg").is_ok());
        assert!(s.snapshot().force_jpeg, "jpeg ⇒ 强制本会话走 JPEG");
        assert!(s.set_codec("h264").is_ok());
        assert!(!s.snapshot().force_jpeg, "h264 ⇒ 放开 H.264");
        let err = s.set_codec("vp9").expect_err("只认两种编码");
        assert_eq!(err, "编码只能是 jpeg 或 h264");
    }

    #[test]
    fn 没收到过任何输入时不暂停() {
        let s = c();
        // 会话刚开始，last_activity 还是 0：不管「现在」多大都不该暂停，
        // 否则首个心跳还没到就被判死。
        assert!(!s.should_pause(1_700_000_000_000));
    }

    #[test]
    fn 超过心跳超时才暂停() {
        let s = c();
        s.touch_activity(1_000);
        assert!(!s.should_pause(1_000 + 3_500), "正好等于阈值不算超时");
        assert!(s.should_pause(1_000 + 3_501), "超出 1ms 就该暂停");
        s.touch_activity(1_000 + 3_501);
        assert!(!s.should_pause(1_000 + 3_501), "刷新活跃后立刻恢复");
    }

    #[test]
    fn rtt_负数归零() {
        let s = c();
        s.note_rtt(-5);
        assert_eq!(s.rtt_ms(), 0);
        s.note_rtt(37);
        assert_eq!(s.rtt_ms(), 37);
    }

    #[test]
    fn rtt_码率缩放分档() {
        assert_eq!(bitrate_scale_for_rtt(0), 100);
        assert_eq!(bitrate_scale_for_rtt(30), 100);
        assert_eq!(bitrate_scale_for_rtt(80), 80);
        assert_eq!(bitrate_scale_for_rtt(150), 60);
        assert_eq!(bitrate_scale_for_rtt(250), 40);
        assert_eq!(bitrate_scale_for_rtt(800), 25);
        let s = c();
        assert_eq!(s.set_peer_rtt(200), 40);
        assert_eq!(s.bitrate_scale(), 40);
    }

    #[test]
    fn 会话初始化会重置推流参数() {
        let s = c();
        s.set_scope("primary").expect("合法");
        s.set_codec("jpeg").expect("合法");
        s.reset_from_cfg(super::super::video::EncodeProfile::default(), true);
        let o = s.snapshot();
        assert!(o.virtual_screen, "由配置决定");
        assert_eq!(o.monitor, -1);
        assert!(!o.force_jpeg, "新会话不该继承上一会话的强制 JPEG");
    }

    #[test]
    fn 配置缺省时画质回落均衡_范围抓整屏() {
        let empty = serde_json::json!({});
        assert!(virtual_screen_from_cfg(&empty), "缺省就是抓整屏");
        assert_eq!(
            profile_from_cfg(&empty),
            super::super::video::EncodeProfile::of_name("balanced")
        );
    }

    #[test]
    fn 配置里写了_primary_才不抓整屏() {
        assert!(!virtual_screen_from_cfg(
            &serde_json::json!({ CFG_CAPTURE_SCOPE: "primary" })
        ));
        assert!(virtual_screen_from_cfg(
            &serde_json::json!({ CFG_CAPTURE_SCOPE: "virtual" })
        ));
        assert!(virtual_screen_from_cfg(
            &serde_json::json!({ CFG_CAPTURE_SCOPE: "monitor:1" })
        ));
    }
}
