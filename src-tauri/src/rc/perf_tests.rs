//! `perf` 探针的单元测试（2026-09-21 从 `perf.rs` 拆出）。
//!
//! # 为什么单独一个文件
//!
//! `perf.rs` 的**生产代码**只有 409 行，测试却有 355 行——测试体量接近
//! 生产代码。混在一起时「改一行统计逻辑」要在 30 条断言里翻找对应的一条，
//! 而「看探针整体设计」又被 355 行测试挡住。拆开后：
//! `perf.rs` = 探针怎么算，本文件 = 算得对不对。
//!
//! # 本文件的两组测试
//!
//! | 模块 | 性质 | 干什么 |
//! |---|---|---|
//! | `tests` | 断言 | 统计口径 / 汇总行格式 / 计数器的行为守卫 |
//! | `probe_output_preview` | **肉眼复核** | 把真实输出原样打印，不做断言 |
//!
//! # 🔴 一条纪律（拆文件时保留）
//!
//! **断言全绿 ≠ 输出是对的**。`探针输出预览` 就是为这件事存在的：
//! 跑 `cargo test --lib 探针输出预览 -- --nocapture` 看真东西。
//! 本文件的历史上出过 4 个「25 条断言全绿但输出是垃圾」的问题
//!（`format!` 的 `\` 续行吃掉行尾空格 ×2、短会话均帧率除零印出
//! `34823.0fps`、空上下文多印空行）——全是靠肉眼看打印输出抓到的。

use crate::rc::perf::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_有起始时刻() {
        let s = FrameStats::new();
        assert!(s.start.is_some());
        assert_eq!(s.frames(), 0);
    }

    #[test]
    fn note_frame_累加均值与峰值() {
        let mut s = FrameStats::new();
        s.note_frame(10, 5, Some(1), 20);
        s.note_frame(20, 7, Some(2), 40);
        assert_eq!(s.frames(), 2);
        assert_eq!(s.cap_sum_ms, 30);
        assert_eq!(s.cap_max_ms, 20);
        assert_eq!(s.enc_sum_ms, 12);
        assert_eq!(s.enc_max_ms, 7);
        assert_eq!(s.send_max_ms, 2);
        assert_eq!(s.loop_max_ms, 40);
    }

    #[test]
    fn note_frame_允许_send_为_none() {
        let mut s = FrameStats::new();
        s.note_frame(10, 5, None, 20);
        assert_eq!(s.send_sum_ms, 0);
        assert_eq!(s.send_max_ms, 0);
        assert_eq!(s.frames(), 1);
    }

    #[test]
    fn report_未到间隔返回_none() {
        let mut s = FrameStats::new();
        s.note_frame(10, 5, None, 20);
        // 刚建实例，距上次汇报不足 5s
        assert!(s.report(ReportExtra::default()).is_none());
    }

    #[test]
    fn report_无帧返回_none() {
        let mut s = FrameStats::new();
        // 把 last_report 拨到过去，确保间隔检查通过
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(10));
        assert!(s.report(ReportExtra::default()).is_none());
    }

    #[test]
    fn report_到间隔输出含关键字段() {
        let mut s = FrameStats::new();
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(10));
        s.note_frame(30, 10, Some(2), 50);
        s.note_frame(50, 20, Some(4), 90);
        let extra = ReportExtra {
            profile: "ultra".into(),
            interval_ms: 80,
            pace_scale: 2,
            pipeline: "H264-GPU".into(),
            active_quality: String::new(),
            pick: None,
        };
        let line = s.report(extra).expect("应输出汇总");
        assert!(line.contains("[RC-PERF]"), "缺少前缀: {line}");
        assert!(line.contains("cap 40"), "抓屏均值应为 (30+50)/2=40: {line}");
        assert!(line.contains("enc 15"), "编码均值应为 (10+20)/2=15: {line}");
        assert!(line.contains("send 3"), "发送均值应为 (2+4)/2=3: {line}");
        assert!(line.contains("档位 ultra@80ms"), "缺少档位: {line}");
        assert!(line.contains("pace 2x"), "缺少降频倍数: {line}");
        assert!(line.contains("管线 H264-GPU"), "缺少管线: {line}");
    }

    #[test]
    fn report_后峰值清零但总量保留() {
        let mut s = FrameStats::new();
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(10));
        s.note_frame(100, 50, None, 200);
        let _ = s.report(ReportExtra::default());
        // 峰值是「区间峰值」，汇报后清零
        assert_eq!(s.cap_max_ms, 0);
        assert_eq!(s.enc_max_ms, 0);
        assert_eq!(s.loop_max_ms, 0);
        // 但累加值保留（会话级均值要稳）
        assert_eq!(s.cap_sum_ms, 100);
        assert_eq!(s.frames(), 1);
        // 会话级峰值**不清零**（收尾行要用）
        assert_eq!(s.cap_peak_ms, 100);
        assert_eq!(s.enc_peak_ms, 50);
        assert_eq!(s.loop_peak_ms, 200);
    }

    #[test]
    fn summary_报告全量且含计数器() {
        let mut s = FrameStats::new();
        s.note_frame(10, 5, Some(1), 20);
        s.note_frame(30, 15, Some(3), 60);
        s.note_dropped();
        let line = s.summary(ReportExtra::default()).expect("有帧就该出收尾行");
        assert!(line.contains("本场收尾"), "{line}");
        assert!(line.contains("帧 2"), "累计帧数: {line}");
        assert!(line.contains("cap 20"), "均值 (10+30)/2=20: {line}");
        assert!(line.contains("enc 10"), "均值 (5+15)/2=10: {line}");
        assert!(line.contains("send 2"), "均值 (1+3)/2=2: {line}");
        assert!(line.contains("丢失 1") || line.contains("丢 1"), "丢帧: {line}");
        // 收尾行必须带上全局计数器，否则「熔断过几次」还得翻别的日志
        assert!(line.contains("熔断"), "缺计数器: {line}");
        assert!(line.contains("JPEG兜底"), "缺计数器: {line}");
    }

    #[test]
    fn summary_无帧返回_none() {
        let s = FrameStats::new();
        assert!(s.summary(ReportExtra::default()).is_none());
    }

    /// 🔴 守卫：Rust 的 `\` 续行会把**行尾空白也吃掉**，format 串里
    /// 「`ms\` + `|`」这种写法渲染出来就是 `ms|`（少一个空格）。
    /// 2026-09-21 交付前肉眼复核抓到两处，纯断言发现不了——这里钉住。
    #[test]
    fn 汇总行不含粘连的分隔符() {
        let mut s = FrameStats::new();
        s.note_frame(30, 10, Some(2), 50);
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(10));
        let periodic = s.report(ReportExtra::default()).expect("应输出");
        let final_ = s.summary(ReportExtra::default()).expect("应输出");
        for (what, line) in [("周期行", &periodic), ("收尾行", &final_)] {
            assert!(!line.contains("ms|"), "{what} 的 ms 与 | 粘连：{line}");
            assert!(!line.contains("fps）|"), "{what} 的 | 前缺空格：{line}");
            // 行尾不许有拖尾空格；行内多空格只可能是「空上下文多印了一行」
            for l in line.lines() {
                assert_eq!(l, l.trim_end(), "{what} 出现拖尾空格：{l:?}");
                assert!(
                    l.trim().is_empty() || l.starts_with(' ') || !l.contains("  "),
                    "{what} 行内出现连续空格：{l:?}"
                );
            }
        }
    }

    /// 守卫：短会话（<1s）不许印出 `frames / 0.0s` 那种荒谬帧率。
    #[test]
    fn summary_短会话帧率不爆表() {
        let mut s = FrameStats::new();
        s.note_frame(10, 5, None, 20);
        let line = s.summary(ReportExtra::default()).expect("应输出");
        // 刚建实例 → 时长约 0s → 均帧率必须是占位符而不是天文数字
        assert!(line.contains("均 --"), "短会话应印占位符：{line}");
    }

    #[test]
    fn summary_不清零区间峰值() {
        let mut s = FrameStats::new();
        s.note_frame(10, 5, None, 20);
        let _ = s.summary(ReportExtra::default());
        // 与 report 不同：summary 是终态读取，不许改动任何统计
        assert_eq!(s.cap_max_ms, 10);
        assert_eq!(s.frames(), 1);
        assert_eq!(s.cap_sum_ms, 10);
    }

    #[test]
    fn render_pick_含候选与逐台明细() {
        let r = MftPickReport {
            candidates: 3,
            tried: 2,
            skipped: 1,
            chosen: "NVIDIA H.264 Encoder MF".into(),
            pick_ms: 42,
            details: vec![
                ("Intel QSV H.264".into(), false, 20),
                ("NVIDIA NVENC H.264".into(), true, 22),
            ],
        };
        let s = render_pick(&r);
        assert!(s.contains("候选 3 台"), "{s}");
        assert!(s.contains("试编 2 台"), "{s}");
        assert!(s.contains("跳过 1 台"), "{s}");
        assert!(s.contains("42ms"), "{s}");
        assert!(s.contains("NVIDIA H.264 Encoder MF"), "选中名: {s}");
        // 逐台明细要能看出「哪台挂了、花了多久」
        assert!(s.contains("✗ Intel QSV H.264（20ms）"), "{s}");
        assert!(s.contains("✓ NVIDIA NVENC H.264（22ms）"), "{s}");
    }

    #[test]
    fn render_pick_单台也能渲染() {
        let r = MftPickReport {
            candidates: 1,
            tried: 1,
            skipped: 0,
            chosen: "NVIDIA".into(),
            pick_ms: 8,
            details: vec![("NVIDIA".into(), true, 8)],
        };
        let s = render_pick(&r);
        assert!(s.starts_with("[RC-PERF] 编码器选型"), "{s}");
        assert!(s.contains("✓ NVIDIA（8ms）"), "{s}");
    }

    #[test]
    fn profile_name_阶梯内档位可反查() {
        use crate::rc::video::EncodeProfile;
        assert_eq!(profile_name(&EncodeProfile::of_name("balanced")), "balanced");
        assert_eq!(profile_name(&EncodeProfile::of_name("ultra")), "ultra");
        assert_eq!(profile_name(&EncodeProfile::of_name("smooth")), "smooth");
    }

    #[test]
    fn profile_name_非阶梯档返回空() {
        use crate::rc::video::EncodeProfile;
        // uhd60 不在自动阶梯里 → 不强凑一个名字出来
        let p = EncodeProfile::of_name("uhd60");
        assert!(
            profile_name(&p).is_empty() || profile_name(&p) != "uhd60",
            "非阶梯档不该被谎报成阶梯名"
        );
    }

    #[test]
    fn report_第二次只统计新增帧() {
        let mut s = FrameStats::new();
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(10));
        s.note_frame(10, 10, None, 10);
        let first = s.report(ReportExtra::default()).unwrap();
        assert!(first.contains("本区间 0.1fps") || first.contains("本区间"), "{first}");
        // 再补一帧并把报告时刻拨回去
        s.note_frame(10, 10, None, 10);
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(5));
        let second = s.report(ReportExtra::default()).unwrap();
        // 累计帧数应是 2，而不是重新计数
        assert!(second.contains("帧 2"), "累计帧数应保留: {second}");
    }

    #[test]
    fn note_dropped_累加() {
        let mut s = FrameStats::new();
        s.note_dropped();
        s.note_dropped();
        assert_eq!(s.dropped, 2);
        // 丢帧不计入成功帧数
        assert_eq!(s.frames(), 0);
    }

    #[test]
    fn take_pick_report_once_只给一次() {
        let mut slot = Some(MftPickReport {
            candidates: 3,
            tried: 2,
            skipped: 1,
            chosen: "NVIDIA H.264 Encoder MF".into(),
            pick_ms: 42,
            details: vec![("Intel QSV".into(), false, 20), ("NVIDIA".into(), true, 22)],
        });
        assert!(take_pick_report_once(&mut slot).is_some());
        assert!(slot.is_none(), "取出后槽位应清空");
        assert!(take_pick_report_once(&mut slot).is_none(), "第二次应为 None");
    }

    #[test]
    fn bump_与_read_一致() {
        let c = AtomicU64::new(0);
        bump(&c);
        bump(&c);
        assert_eq!(read(&c), 2);
    }

    #[test]
    fn counters_snapshot_含全部字段() {
        let s = counters::snapshot();
        assert!(s.contains("熔断"));
        assert!(s.contains("流变化"));
        assert!(s.contains("JPEG兜底"));
        assert!(s.contains("抓屏失败"));
    }

    #[test]
    fn mft_pick_report_默认值可用() {
        let r = MftPickReport::default();
        assert_eq!(r.candidates, 0);
        assert_eq!(r.tried, 0);
        assert!(r.chosen.is_empty());
        assert!(r.details.is_empty());
    }

    #[test]
    fn report_extra_render_空字段不产生分隔符() {
        let e = ReportExtra::default();
        assert_eq!(e.render(), "");
    }

    #[test]
    fn report_extra_render_含管线与档位() {
        let e = ReportExtra {
            profile: "balanced".into(),
            interval_ms: 100,
            pace_scale: 1,
            pipeline: "JPEG".into(),
            ..Default::default()
        };
        let s = e.render();
        assert!(s.contains("管线 JPEG"));
        assert!(s.contains("档位 balanced@100ms"));
        // pace=1 时不显示倍数
        assert!(!s.contains("pace"));
    }
}

#[cfg(test)]
mod probe_output_preview {
    use super::*;

    /// 不是断言，是**肉眼复核**：把探针在真实场景下会打出的三段文本
    /// 原样打印出来（`cargo test --lib 探针输出预览 -- --nocapture`）。
    /// 格式错了但断言碰巧没覆盖到，只有看真东西才发现得了。
    #[test]
    fn 探针输出预览() {
        let mut s = FrameStats::new();
        // 模拟 12 帧 1080p 硬编：抓 38ms / 编 10ms / 发 2ms
        for i in 0..12u64 {
            s.note_frame(35 + i % 5, 9 + i % 3, Some(1 + i % 2), 52 + i % 7);
        }
        s.note_dropped();
        s.last_report = Some(Instant::now() - std::time::Duration::from_secs(6));
        let extra = ReportExtra {
            profile: "ultra".into(),
            interval_ms: 80,
            pace_scale: 2,
            pipeline: "H264".into(),
            active_quality: "sharp".into(),
            pick: None,
        };
        println!("\n───────── 周期性汇总行 ─────────");
        println!("{}", s.report(extra.clone()).expect("应输出"));
        println!("\n───────── 会话收尾行 ─────────");
        println!("{}", s.summary(extra).expect("应输出"));
        println!("\n───────── 编码器选型行 ─────────");
        println!(
            "{}",
            render_pick(&MftPickReport {
                candidates: 3,
                tried: 2,
                skipped: 1,
                chosen: "NVIDIA H.264 Encoder MF".into(),
                pick_ms: 47,
                details: vec![
                    ("Intel® Quick Sync Video H.264 Encoder MF".into(), false, 25),
                    ("NVIDIA H.264 Encoder MF".into(), true, 22),
                ],
            })
        );
        println!();
    }
}
