//! RC 性能诊断探针（2026-09-21）。
//!
//! # 为什么需要它
//!
//! 2026-09-21 排查「远程 1fps」时，所有结论都来自**离线探针**
//! （`probe/rc-mft-type`）——真机跑起来后，编码器**选型过程**和
//! **分段耗时**在日志里是隐形的：只知道「硬编没启用」，
//! 不知道试编了几台、每台为何失败、慢在抓屏还是编码。
//!
//! 本模块补上这块：在推流关键路径打**结构化埋点**，dev 起来后
//! 按固定间隔在日志里输出一条可 grep 的汇总行。
//!
//! # 输出样例
//!
//! ```text
//! [RC-PERF] 会话 12.3s | 帧 148（12.0fps）| 分段 cap 38 enc 10 send 2 ms
//!          | 单圈 52ms pace 1x（档位 80ms）| 走 H.264/GPU | 丢 12 帧
//! ```
//!
//! # 设计约束
//!
//! - **常驻开销必须可忽略**：只在推流路径做几次整数加法与一次
//!   `Instant::now()`，汇总行每 [`REPORT_INTERVAL_MS`] 才拼一次字符串。
//! - **不改动现有行为**：埋点是旁路，任何统计失败都不影响推流。
//! - **进程级单例**：多会话（出站/入站）各自有独立的采样器实例，
//!   但开关是全局的（`PP_RC_PERF=0` 关掉）。

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

/// 汇总行输出间隔（ms）。太快会淹日志，太慢分辨不出变化。
pub const REPORT_INTERVAL_MS: u64 = 5_000;

/// 全局开关。默认**开**（dev 诊断场景就是为它存在的）；
/// 设 `PP_RC_PERF=0` 可关掉，正式版若有顾虑可一键静默。
fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var("PP_RC_PERF")
            .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
            .unwrap_or(true)
    })
}

/// 编码器选型结果（`create_h264_mft` 填，诊断时读）。
#[derive(Debug, Clone, Default)]
pub struct MftPickReport {
    /// 枚举到几台候选（去重后）。
    pub candidates: usize,
    /// 实际试编了几台。
    pub tried: usize,
    /// 跳过了几台不可用的。
    pub skipped: usize,
    /// 最终选中那台的名字。
    pub chosen: String,
    /// 整个选型耗时（ms）——试编成本，只在开编码器时付一次。
    pub pick_ms: u64,
    /// 每台的试编明细（名字, 是否通过, 耗时 ms）。
    pub details: Vec<(String, bool, u64)>,
}

/// 推流分段耗时采样器（单会话一个）。
///
/// 用「累加 + 计数」而非 EMA：EMA 会被慢速尾巴拖住看不出尖刺，
/// 而诊断阶段我们需要知道**平均值和最大值**两个口径。
#[derive(Debug, Default)]
pub struct FrameStats {
    start: Option<Instant>,
    /// 抓屏耗时累积与峰值（ms）。
    cap_sum_ms: u64,
    cap_max_ms: u64,
    /// 编码耗时累积与峰值（ms）。
    enc_sum_ms: u64,
    enc_max_ms: u64,
    /// 发送耗时累积与峰值（ms）。
    send_sum_ms: u64,
    send_max_ms: u64,
    /// 单圈总耗时累积与峰值。
    loop_sum_ms: u64,
    loop_max_ms: u64,
    frames: u64,
    /// 🔴 甲-①（2026-10-11）：**空转圈**（本圈没出帧）的计数与单圈耗时。
    /// 此前空转圈一笔都不记——静止画面时 `report()` 的闸门（只看产出帧）直接
    /// 返回 None，整场会话在日志里一片安静；而「每圈 30ms 全花在等桌面更新」
    /// 正是 task #23（顶档只有 19–21fps）要看的那个数。
    idle_frames: u64,
    idle_sum_ms: u64,
    idle_max_ms: u64,
    /// 甲-②：`cap_ms` 里**在 `AcquireNextFrame` 中等待**的那一段（等屏）。
    /// 扣掉它剩下的就是 staging 拷贝 + Map 读回。只统计上报了等待的那些帧
    ///（`wait_frames` 为样本数），抓屏均值与它同一样本集，两个数能直接相减。
    wait_sum_ms: u64,
    wait_max_ms: u64,
    wait_cap_sum_ms: u64,
    wait_frames: u64,
    /// 丢帧计数（编码失败 / 无变化跳过不算丢帧，只有「该出帧但没出」才算）。
    dropped: u64,
    /// 末次汇总时的帧数（算区间帧率用）。
    last_frames: u64,
    last_report: Option<Instant>,
    /// 会话级峰值（`*_max_ms` 是**区间**峰值，汇报后清零；这一组永不清零，
    /// 只给 [`Self::summary`] 的收尾行用）。
    cap_peak_ms: u64,
    enc_peak_ms: u64,
    send_peak_ms: u64,
    loop_peak_ms: u64,
    idle_peak_ms: u64,
    /// 单区间最高帧率（fps）。
    peak_fps: f64,
    /// JPEG 兜底 / 抓屏失败的**会话基线**：这两个计数器是进程级 `static`，
    /// 跨会话累加不清零，所以本会话的量必须减去 `new()` 时刻的读数。
    base_jpeg_fallback: u64,
    base_capture_fail: u64,
    /// 上次汇总时的读数（算区间增量用）。
    last_jpeg_fallback: u64,
    last_capture_fail: u64,
}

impl FrameStats {
    pub fn new() -> Self {
        let (jf, cf) = (
            counters::JPEG_FALLBACK.load(Ordering::Relaxed),
            counters::CAPTURE_FAIL.load(Ordering::Relaxed),
        );
        Self {
            start: Some(Instant::now()),
            last_report: Some(Instant::now()),
            base_jpeg_fallback: jf,
            base_capture_fail: cf,
            last_jpeg_fallback: jf,
            last_capture_fail: cf,
            ..Default::default()
        }
    }

    /// 记录一帧的分段耗时。任何一段传 `None` 表示该路径没有这段
    ///（如 GPU 零拷贝路径没有独立的 BGRA→NV12 转换耗时）。
    ///
    /// 甲（2026-10-11）改为**直接吃 [`FrameTiming`]**：以前四个位置参数按
    /// `cap, enc, send, loop` 排，新增一段（等屏）只能再挂一个尾巴参数，
    /// 而调用点在别的文件里，挂错了不报错、只是数字串位。结构体过界，
    /// 段与含义同源。
    pub fn note_frame(&mut self, t: &FrameTiming, loop_ms: u64) {
        if !enabled() {
            return;
        }
        let (cap_ms, enc_ms, send_ms) = (t.cap_ms, t.enc_ms, t.send_ms);
        self.cap_sum_ms += cap_ms;
        self.cap_max_ms = self.cap_max_ms.max(cap_ms);
        self.cap_peak_ms = self.cap_peak_ms.max(cap_ms);
        self.enc_sum_ms += enc_ms;
        self.enc_max_ms = self.enc_max_ms.max(enc_ms);
        self.enc_peak_ms = self.enc_peak_ms.max(enc_ms);
        if let Some(s) = send_ms {
            self.send_sum_ms += s;
            self.send_max_ms = self.send_max_ms.max(s);
            self.send_peak_ms = self.send_peak_ms.max(s);
        }
        // 甲-②：等屏样本单独记一份（JPEG / Mac 路径没有这一段，不填即不采样，
        // 拿它去稀释 H.264 的均值会把「等桌面」这个信号抹平）。
        if let Some(w) = t.wait_ms {
            self.wait_sum_ms += w;
            self.wait_max_ms = self.wait_max_ms.max(w);
            self.wait_cap_sum_ms += cap_ms;
            self.wait_frames += 1;
        }
        self.loop_sum_ms += loop_ms;
        self.loop_max_ms = self.loop_max_ms.max(loop_ms);
        self.loop_peak_ms = self.loop_peak_ms.max(loop_ms);
        self.frames += 1;
    }

    /// 甲-①（2026-10-11）：本圈没出帧（屏幕未变化 / 被闸丢掉 / 兜底也没编出来）。
    /// 只记墙钟，不记分段——空转圈的 cap/enc 几乎为 0，混进分段均值就会把
    /// 「慢在编码」的真实信号稀释掉（这是当初把空转排除在外的理由，排除的
    /// 却是不计）。
    pub fn note_idle(&mut self, loop_ms: u64) {
        if !enabled() {
            return;
        }
        self.idle_frames += 1;
        self.idle_sum_ms += loop_ms;
        self.idle_max_ms = self.idle_max_ms.max(loop_ms);
        self.idle_peak_ms = self.idle_peak_ms.max(loop_ms);
    }

    pub fn note_dropped(&mut self) {
        if enabled() {
            self.dropped += 1;
        }
    }

    /// 到点了就给出一份汇总（调用方负责 `log::info!` 出去）。
    ///
    /// 返回 `None` = 未到间隔或总开关关着。
    pub fn report(&mut self, extra: ReportExtra) -> Option<String> {
        // 甲-①：闸门从「有产出帧」改成「跑过圈」。静止桌面上一场只有空转圈的
        // 会话，以前 5 秒都不出声——而那正是「生产者墙钟」要看的那一段。
        if !enabled() || self.frames + self.idle_frames == 0 {
            return None;
        }
        let now = Instant::now();
        let since = now.duration_since(self.last_report.unwrap_or(now));
        if since.as_millis() < REPORT_INTERVAL_MS as u128 {
            return None;
        }
        let elapsed_s = self.start.map(|s| now.duration_since(s).as_secs_f64()).unwrap_or(0.0);
        let interval_frames = self.frames.saturating_sub(self.last_frames);
        let interval_s = since.as_secs_f64().max(0.001);
        let fps = interval_frames as f64 / interval_s;

        let n = self.frames.max(1);
        // 兜底计数（2026-10-06）：`管线` 标签只说**最后一圈**，回答不了「是不是
        // 整场都在兜」。区间增量非 0 才附这一段——正常会话一个字都不多，一旦兜底
        // 就是每 5s 一条铁证（过去这两个计数只在收尾行出，会话不结束就完全隐形，
        // 那场「画质清晰但编码是 JPEG」只能靠拆手机 logcat 反推）。
        let jf = counters::JPEG_FALLBACK.load(Ordering::Relaxed);
        let cf = counters::CAPTURE_FAIL.load(Ordering::Relaxed);
        let djf = jf.saturating_sub(self.last_jpeg_fallback);
        let dcf = cf.saturating_sub(self.last_capture_fail);
        let fallback = if djf > 0 || dcf > 0 {
            format!(
                " | 兜底 +{djf}（本场 {}） 抓屏失败 +{dcf}（本场 {}）",
                jf.saturating_sub(self.base_jpeg_fallback),
                cf.saturating_sub(self.base_capture_fail)
            )
        } else {
            String::new()
        };
        // 甲-①：空转圈单独一段。静止画面时这是唯一能看出「生产者每圈花多久」
        // 的数——以前空转一笔不记，整场会话在日志里隐形。有账才多这几个字。
        let idle = if self.idle_frames > 0 {
            format!(
                " | 空转 {} 圈 单圈均值 {} 峰值 {} ms",
                self.idle_frames,
                self.idle_sum_ms / self.idle_frames.max(1),
                self.idle_max_ms
            )
        } else {
            String::new()
        };
        // 甲-②：cap 拆成「在 `AcquireNextFrame` 里等桌面更新」+「staging 读回」。
        // 减法只在这里用一次，且两个均值**同样本集**（`wait_frames` 那几帧的
        // cap 合计就是 `wait_cap_sum_ms`），不会出现「等屏按 8 帧算、cap 按 20 帧算」
        // 这种两个数没法比的假拆分。
        let split = if self.wait_frames > 0 {
            let w = self.wait_frames;
            format!(
                " | 抓屏 {} 帧样本：等屏 {} 读回 {} ms（等屏峰值 {}）",
                w,
                self.wait_sum_ms / w,
                self.wait_cap_sum_ms.saturating_sub(self.wait_sum_ms) / w,
                self.wait_max_ms
            )
        } else {
            String::new()
        };
        let s = format!(
            "[RC-PERF] 会话 {elapsed_s:.1}s | 帧 {}（本区间 {fps:.1}fps） \
             | 分段均值 cap {} enc {} send {} ms | 峰值 cap {} enc {} send {} ms \
             | 单圈均值 {} 峰值 {} ms | 丢 {} 帧{split}{idle}{}{}",
            self.frames,
            self.cap_sum_ms / n,
            self.enc_sum_ms / n,
            self.send_sum_ms / n,
            self.cap_max_ms,
            self.enc_max_ms,
            self.send_max_ms,
            self.loop_sum_ms / n,
            self.loop_max_ms,
            self.dropped,
            fallback,
            extra.render(),
        );

        // 区间统计清零，但**总量保留**（会话级均值要稳）
        self.last_report = Some(now);
        self.last_frames = self.frames;
        self.last_jpeg_fallback = jf;
        self.last_capture_fail = cf;
        self.cap_max_ms = 0;
        self.enc_max_ms = 0;
        self.send_max_ms = 0;
        self.loop_max_ms = 0;
        self.idle_max_ms = 0;
        self.wait_max_ms = 0;
        self.peak_fps = self.peak_fps.max(fps);
        Some(s)
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// 会话收尾的统一摘要（不看清零，取全量）。
    ///
    /// 与 [`Self::report`] 的差别：`report` 是**周期性**的、输出后清区间峰值；
    /// 这个是**终结性**的，会话结束时无条件打一条，用于回答
    /// 「这一场到底跑了多少帧、平均慢在哪」——没有它就只能靠翻日志里
    /// 那几十条 5s 汇总自己算。
    pub fn summary(&self, extra: ReportExtra) -> Option<String> {
        // 甲-①：与 `report` 同一把闸门——一场「只空转、一帧没出」的会话收尾必须
        // 留痕，否则「画不动」在日志里连一行都没有。
        if !enabled() || self.frames + self.idle_frames == 0 {
            return None;
        }
        let elapsed_s = self
            .start
            .map(|s| s.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        // ⚠️ 均帧率只在**跑了足够久**时才有意义：`elapsed_s` 趋近 0 时
        // `frames / elapsed_s` 会爆出一个荒谬数字（实测短会话打出
        // 「均 34823.0fps」）。低于 1s 的会话改用 `--` 表示「不可测」，
        // 而不是印一个会被误读的数。
        let avg_fps = if elapsed_s >= 1.0 {
            format!("{:.1}fps", self.frames as f64 / elapsed_s)
        } else {
            "--".to_string()
        };
        let n = self.frames.max(1);
        // 上下文为空时**不要多印一行空行**（`extra.render()` 会给出空串）
        let ctx = extra.render();
        let ctx = ctx.trim_start_matches(" | ").trim();
        let ctx_line = if ctx.is_empty() {
            String::new()
        } else {
            format!("\n  {ctx}")
        };
        // 甲-①：收尾行了结「这一场画不动」的账——空转圈数与单圈墙钟。
        let idle = if self.idle_frames > 0 {
            format!(
                " | 空转 {} 圈 均值 {} 峰值 {} ms",
                self.idle_frames,
                self.idle_sum_ms / self.idle_frames.max(1),
                self.idle_peak_ms
            )
        } else {
            String::new()
        };
        Some(format!(
            "[RC-PERF] 本场收尾：时长 {elapsed_s:.1}s · 帧 {}（均 {avg_fps} · 峰值区间 {:.1}fps） \
             | 分段均值 cap {} enc {} send {} ms | 峰值 cap {} enc {} send {} ms \
             | 单圈峰值 {} ms | 丢 {} 帧{idle}\n  {}{ctx_line}",
            self.frames,
            self.peak_fps,
            self.cap_sum_ms / n,
            self.enc_sum_ms / n,
            self.send_sum_ms / n,
            self.cap_peak_ms,
            self.enc_peak_ms,
            self.send_peak_ms,
            self.loop_peak_ms,
            self.dropped,
            counters::snapshot(),
        ))
    }
}

/// 一圈推流的分段耗时（探针暂存用）。
///
/// 两条推流路径（H.264 硬编 / JPEG 兜底）各自填这个结构，`run` 在圈末
/// 一次性喂给 [`FrameStats`]。`produced = false` 表示「本圈没出帧」
///（屏幕未变化 / 抓到但编不出），这类圈 **不计入分段均值**，
/// 否则大量空转会稀释掉真正的编码耗时。
#[derive(Debug, Clone, Copy, Default)]
pub struct FrameTiming {
    /// 抓屏耗时（ms）。
    pub cap_ms: u64,
    /// 编码耗时（ms）。
    pub enc_ms: u64,
    /// 发送耗时（ms）；`None` = 这条路径没有独立的发送段。
    pub send_ms: Option<u64>,
    /// 🔴 甲-②（2026-10-11）：`cap_ms` 里花在 `AcquireNextFrame` **等桌面出新帧**
    /// 的那一段（ms）。`None` = 这条路径没有可比的等待段（JPEG / Mac）。
    /// 有了它，`cap - wait` 才是「读回到底慢不慢」；以前两者揉成一个数，
    /// 「顶档只有 19fps」答不了是节拍还是抓屏。
    pub wait_ms: Option<u64>,
    /// 本圈是否真的推出去了一帧。
    pub produced: bool,
}

impl FrameTiming {
    /// 本圈没出帧（重置为一个「空转圈」）。
    pub fn idle() -> Self {
        Self::default()
    }

    /// 本圈出了帧。
    pub fn produced(cap_ms: u64, enc_ms: u64, send_ms: Option<u64>) -> Self {
        Self {
            cap_ms,
            enc_ms,
            send_ms,
            produced: true,
            ..Default::default()
        }
    }

    /// 补上「等桌面更新」那一段（只有走 DXGI duplicator 的路径报得了）。
    /// 刻意做成链式而不是 `produced` 的第 4 个参数：JPEG / Mac 两个构造点
    /// 不必跟着改，也不会出现「传了个 0 假装量过」。
    pub fn with_wait(mut self, wait_ms: u64) -> Self {
        // 等待段不可能大于整段抓屏（同一时间窗内测的），取小防住上游某天真
        // 传进一个跨过 grab 的数——诊断数字宁可偏小，不能自相矛盾。
        self.wait_ms = Some(wait_ms.min(self.cap_ms));
        self
    }
}

/// 汇总行要附带的运行时上下文（档位、节奏、编码器类型、选型报告）。
#[derive(Debug, Clone, Default)]
pub struct ReportExtra {
    /// 当前档位名（`smooth`/`balanced`/…）。
    pub profile: String,
    /// 档位间隔（ms）。
    pub interval_ms: u64,
    /// 自适应降频倍数。
    pub pace_scale: u32,
    /// 实际走的管线：`H264-CPU` / `H264-GPU` / `JPEG`。
    pub pipeline: String,
    /// 自动档实际生效档位（含判档快照）；锁档时为「锁档 <档名>（自动档已关闭…）」，
    /// 不留空——空字符串过去让「自动档被关」只能靠日志缺席反推。
    pub active_quality: String,
    /// 🔴 甲-④（2026-10-11）：本圈走的**链路**（`内网直连` / `公网直连` / `中继`）。
    /// 30fps 到底是闭环限的还是生产者跑不满，以前在日志里长得一样。
    pub path: String,
    /// 甲-④：闭环这一圈给的帧率上限（`media_fps_limit` 的返回值）。
    /// 与 `档位 interval` 并排看才知道限流来自哪一头；0 = 没量到。
    pub fps_cap: u32,
    /// 编码器选型报告（只在有值时附一次）。
    pub pick: Option<MftPickReport>,
}

impl ReportExtra {
    fn render(&self) -> String {
        let mut parts = Vec::new();
        if !self.pipeline.is_empty() {
            parts.push(format!("管线 {}", self.pipeline));
        }
        if !self.path.is_empty() {
            parts.push(format!("链路 {}", self.path));
        }
        if !self.profile.is_empty() {
            let mut p = format!("档位 {}@{}ms", self.profile, self.interval_ms);
            if self.pace_scale > 1 {
                p.push_str(&format!(" pace {}x", self.pace_scale));
            }
            parts.push(p);
        }
        if self.fps_cap > 0 {
            parts.push(format!("闭环帧率上限 {}", self.fps_cap));
        }
        if !self.active_quality.is_empty() {
            parts.push(format!("实际生效 {}", self.active_quality));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!(" | {}", parts.join(" | "))
        }
    }
}

/// 选型报告只打一次（第一次汇总时带上），避免每 5s 重复刷。
pub fn take_pick_report_once(slot: &mut Option<MftPickReport>) -> Option<MftPickReport> {
    slot.take()
}

/// 会话启动时的一条提示（让「日志里没有 [RC-PERF]」这件事有确定含义）。
pub fn log_startup_hint() {
    if enabled() {
        log::info!(
            "[RC-PERF] 诊断探针已启用（每 {}s 一条汇总；`grep RC-PERF` 过滤；\
             设 PP_RC_PERF=0 可关闭）",
            REPORT_INTERVAL_MS / 1000
        );
    } else {
        log::info!("[RC-PERF] 诊断探针已关闭（PP_RC_PERF=0）");
    }
}

/// 编码器选型的**单行**摘要（`MftPickReport` → 一行文本）。
///
/// 与汇总行分开：汇总行每 5s 一条，而选型是**一次性事件**。把它单独打成
/// 一条 `log::info!`，排查时 `grep "编码器选型"` 就能直接看到「试了几台、
/// 每台为什么没过、最终选了谁、花了多久」——这正是 2026-09-21 排查
/// 「硬编为何从未启用」时最缺的那条信息。
pub fn render_pick(r: &MftPickReport) -> String {
    let mut det = String::new();
    for (name, ok, ms) in &r.details {
        det.push_str(&format!(
            "\n  {} {name}（{ms}ms）",
            if *ok { "✓" } else { "✗" }
        ));
    }
    format!(
        "[RC-PERF] 编码器选型：候选 {} 台 · 试编 {} 台 · 跳过 {} 台 · 共 {}ms\n  选中「{}」{det}",
        r.candidates, r.tried, r.skipped, r.pick_ms, r.chosen
    )
}

/// 把当前档位 profile 反查成档位名（非阶梯档如 uhd 返回空）。
///
/// 走 [`super::auto_quality::ladder_index_of`]——它本来就是「profile 是否等于
/// 阶梯里某一档」的判据，比另写一张对照表少一个数据源。
/// 2026-09-22：梯子动态化（fps60 天花板随硬编能力）——诊断口径按**无硬编基础梯**
/// 反查（fps60 档这里会显示空，可接受；诊断名不该依赖硬件能力，否则两台机器
/// 同一档位打出不同名字，日志没法横向对比）。
pub fn profile_name(p: &super::video::EncodeProfile) -> String {
    super::auto_quality::ladder_index_of(p, false)
        .map(|i| super::auto_quality::auto_ladder(false)[i].to_string())
        .unwrap_or_default()
}

/// 原子计数：用于跨线程累加「某事件发生了几次」（如 `auto_quality` 切档）。
/// 诊断用途，不参与任何业务判断。
pub fn bump(counter: &AtomicU64) {
    if enabled() {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// u32 版本的 [`bump`]（`AtomicU32` 的计数器用）。
pub fn bump_u32(counter: &AtomicU32) {
    if enabled() {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// 读一个诊断计数器的值。
pub fn read(counter: &AtomicU64) -> u64 {
    counter.load(Ordering::Relaxed)
}

/// 全局事件计数（诊断只读，供汇总行引用）。
pub mod counters {
    use super::*;

    /// 硬编熔断次数。
    pub static ENC_FUSE: AtomicU32 = AtomicU32::new(0);
    /// 甲-1（2026-10-12）：硬编档连败定罪、本会话改用**软编**的次数。
    /// 与 `ENC_FUSE` 分开设：换引擎是「还在出 H.264」，熔断是「掉到 JPEG」，
    /// 混在一个计数里就看不出阶梯到底走到哪一档。
    pub static ENC_SW_FALLBACK: AtomicU32 = AtomicU32::new(0);
    /// 流变化再协商次数。
    pub static STREAM_CHANGE: AtomicU32 = AtomicU32::new(0);
    /// JPEG 兜底帧数（本该走硬编却回退了）。
    pub static JPEG_FALLBACK: AtomicU64 = AtomicU64::new(0);
    /// 抓屏失败次数。
    pub static CAPTURE_FAIL: AtomicU64 = AtomicU64::new(0);
    /// 数据报通道丢弃的帧数（缓冲满弃 P 帧 / 分片发送中断）。
    ///
    /// C2（2026-09-22）新增：此前数据报丢帧**完全没有计数**，只有两条
    /// `log::debug!`，而 debug 在默认过滤下看不到 ⇒ 「拖动窗口时画面偶尔
    /// 跳一下」这类现场在 `[RC-PERF]` 汇总里是隐形的，只能靠猜。
    pub static DGRAM_DROP: AtomicU64 = AtomicU64::new(0);
    /// 编码器全链重开次数（码率缩放 / fps / 标准变化触发）。重开一次几百 ms
    /// 且计入该帧 enc_ms——「编码慢」与「重开频繁」是两种病，汇总行必须能拆开。
    pub static ENC_REOPEN: AtomicU64 = AtomicU64::new(0);
    /// 🔴 可靠流积压熔断丢弃的 P 帧数（2026-10-03）：可靠流没有「缓冲满」
    /// 信号，写入在 quinn 发送缓冲上阻塞、积压多少延迟涨多少（08:22 真机会话
    /// 往返 450ms → 46s，pong 被同连接的视频积压堵死）。熔断期间弃 P 帧的
    /// 次数在这里可见——持续增长说明链路吞吐低于码控下限，该降帧率/查路径
    /// （分辨率自 2026-10-06 起不再随预算下降，文字优先）。
    pub static STREAM_MELT: AtomicU64 = AtomicU64::new(0);
    /// 🔴 视频专属流重建次数（2026-10-03「传输分 plane」）：熔断持续超阈时
    /// 整流重建——旧流里的积压随流被丢弃，这是延迟封顶的机制本体。持续
    /// 增长 = 链路吞吐长期低于产量，每次重建伴随一次 IDR 重同步。
    pub static STREAM_REBUILD: AtomicU64 = AtomicU64::new(0);

    /// 一次性读出全部计数（供日志行）。
    pub fn snapshot() -> String {
        format!(
            "熔断 {} 软编换档 {} 流变化 {} JPEG兜底 {} 抓屏失败 {} 数据报丢弃 {} 流积压弃帧 {} 流重建 {} 编码重开 {}",
            ENC_FUSE.load(Ordering::Relaxed),
            ENC_SW_FALLBACK.load(Ordering::Relaxed),
            STREAM_CHANGE.load(Ordering::Relaxed),
            JPEG_FALLBACK.load(Ordering::Relaxed),
            CAPTURE_FAIL.load(Ordering::Relaxed),
            DGRAM_DROP.load(Ordering::Relaxed),
            STREAM_MELT.load(Ordering::Relaxed),
            STREAM_REBUILD.load(Ordering::Relaxed),
            ENC_REOPEN.load(Ordering::Relaxed),
        )
    }
}

/// 单元测试已拆到 `perf_tests.rs`（2026-09-21）：生产代码 409 行、
/// 测试 355 行，混在一起改一行统计要在 30 条断言里翻找。
///
/// ⚠️ `perf.rs` 是**文件模块**（不是 `perf/mod.rs`），子模块默认会去
/// `perf/` 目录下找。这里显式给 path 指回同级文件，避免为此把
/// `perf.rs` 改成目录——那会多一层无意义的嵌套。
#[cfg(test)]
#[path = "perf_tests.rs"]
mod perf_tests;
