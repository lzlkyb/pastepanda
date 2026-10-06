//! `dxgi.rs` 的单元测试（NV12 色彩口径等，原样平移）。

use super::*;

#[test]
fn bgra_to_rgba_swaps() {
    let bgra = [10u8, 20, 30, 255];
    let rgba = bgra_to_rgba(&bgra);
    assert_eq!(&rgba[..], &[30, 20, 10, 255]);
}

#[test]
fn nv12_len() {
    let bgra = vec![0u8; 4 * 4 * 4];
    let nv = bgra_to_nv12(&bgra, 4, 4).unwrap();
    assert_eq!(nv.len(), 4 * 4 + 4 * 4 / 2);
}

#[test]
fn nv12_mixed_block_ignores_alpha_and_reuses_output() {
    let bgra = [0, 0, 255, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 255, 255];
    let mut out = Vec::with_capacity(64);
    let allocated = out.as_ptr();
    bgra_to_nv12_into(&bgra, 2, 2, &mut out).unwrap();
    assert_eq!(out, [63, 172, 32, 235, 128, 128]);
    bgra_to_nv12_into(&bgra, 2, 2, &mut out).unwrap();
    assert_eq!(out.as_ptr(), allocated);
    assert!(bgra_to_nv12_into(&bgra[..12], 2, 2, &mut out).is_err());
    assert!(bgra_to_nv12_into(&[], 0, 2, &mut out).is_err());
}

#[test]
fn nv12_奇数尺寸显式报错() {
    let bgra = vec![0u8; 5 * 5 * 4];
    // P0-1 B7：奇数输入曾静默取偶——行步进与调用方不一致时会把错位画面
    // 编码进去。现在必须显式报错，让调用方走 JPEG 兜底。
    assert!(bgra_to_nv12(&bgra, 5, 5).is_err());
    assert!(bgra_to_nv12(&bgra, 4, 5).is_err());
    assert!(bgra_to_nv12(&bgra, 5, 4).is_err());
}

/// 灰度输入（R=G=B）应得到中灰 Y 与中性 U/V=128，验证通道序与系数没写反。
#[test]
fn nv12_灰色输入uv中性() {
    let w = 4usize;
    let h = 4usize;
    let mut bgra = Vec::new();
    for _ in 0..w * h {
        bgra.extend_from_slice(&[128, 128, 128, 255]); // BGRA
    }
    let nv = bgra_to_nv12(&bgra, w as u32, h as u32).unwrap();
    for &y in &nv[..w * h] {
        assert!((y as i32 - 126).abs() <= 2, "灰色 Y 应 ≈126（limited range：0.859×128+16），得到 {y}");
    }
    for &uv in &nv[w * h..] {
        assert_eq!(uv, 128, "灰色的 U/V 必须是 128");
    }
}

#[test]
fn nv12_色彩矩阵是_bt709_limited() {
    // Q1：601 编码 × 浏览器 709 解读 = 整体偏色。锁死 709 limited 的
    // 特征值——红 Y = 16+219×0.2126 ≈ 63（601 是 81）、绿 ≈ 173（601 是 145）、
    // 蓝 ≈ 32（601 是 90）。
    let px = |r: u8, g: u8, b: u8| -> (u8, u8, u8) {
        let mut bgra = vec![0u8; 2 * 2 * 4];
        for p in bgra.chunks_exact_mut(4) {
            p[0] = b;
            p[1] = g;
            p[2] = r;
            p[3] = 255;
        }
        let nv = bgra_to_nv12(&bgra, 2, 2).unwrap();
        (nv[0], nv[4], nv[5]) // Y00, U(0,0), V(0,0)——UV 平面跟在 4 字节 Y 后
    };
    let (yr, ur, vr) = px(255, 0, 0);
    assert!((yr as i32 - 63).abs() <= 1, "709 limited 红的 Y，得到 {yr}");
    // 系数整数化允许极值处 ±1 的舍入差（色度抽样后不可见）
    assert!((vr as i32 - 240).abs() <= 1, "红的 Cr，得到 {vr}");
    let (yb, ub, _) = px(0, 0, 255);
    assert!((yb as i32 - 32).abs() <= 1, "709 limited 蓝的 Y，得到 {yb}");
    assert!((ub as i32 - 240).abs() <= 1, "蓝的 Cb，得到 {ub}");
    let (yg, _, _) = px(0, 255, 0);
    assert!((yg as i32 - 173).abs() <= 1, "709 limited 绿的 Y，得到 {yg}");
    let _ = (ur, ub);
}

// ── 熔断复位（2026-10-06）──────────────────────────────────────────
// 现场：15:53:40 一次 `DuplicateOutput 失败：拒绝访问`（桌面态瞬变，同窗口
// `SetCursorPos` 也在报拒绝访问）→ 旧代码 `disabled = true` 一刀判死、全仓没有
// 复位点 → 此后 25 分钟每帧 `Err("DXGI 已禁用")` → 静默 JPEG 兜底，而 nvenc
// 全程健康。这三条测试钉的是「熔断必须会自己复活」这件事。

#[test]
fn 熔断退避翻倍到六十秒封顶() {
    assert_eq!(next_disable_retry_secs(5), 10);
    assert_eq!(next_disable_retry_secs(10), 20);
    assert_eq!(next_disable_retry_secs(40), 60);
    // 封顶：长期不可用（受保护内容 / 显示器真拔掉）不该越退越久，
    // 否则一场长会话后半段等于永久放弃 DXGI。
    assert_eq!(next_disable_retry_secs(60), 60);
    assert_eq!(next_disable_retry_secs(1000), 60);
}

#[test]
fn 熔断必须排上一次自动重试() {
    let mut p = DxgiPool::default();
    assert!(p.is_enabled());
    p.note_disabled("测试：重建失败");
    assert!(!p.is_enabled());
    assert_eq!(p.retry_backoff_secs, DISABLE_RETRY_START_SECS);
    assert!(
        p.retry_after.is_some(),
        "熔断不排重试 = 一次瞬态失败变成整场 JPEG（2026-10-06 的原病）"
    );
    assert_eq!(p.disabled_reason, "测试：重建失败", "熔断原因要能在错误串里读出来");
}

#[test]
fn 重复熔断不得把冷却一直往后推() {
    // 熔断后每一圈都会再进一次「抓屏失败」，若每次note_disabled 都重置
    // retry_after，冷却永远走不完 ⇒ 又变成事实上的永久熔断。
    let mut p = DxgiPool::default();
    p.note_disabled("第一次");
    let scheduled = p.retry_after;
    assert!(scheduled.is_some());
    p.note_disabled("第二次");
    assert_eq!(p.retry_after, scheduled, "已熔断时不得重排重试时刻");
    assert_eq!(p.retry_backoff_secs, DISABLE_RETRY_START_SECS, "退避只在重建失败时翻倍");
}

#[test]
fn 未到冷却时刻时重试入口不动设备() {
    // `maybe_revive` 会真去建 D3D 设备，测试环境里不能让它跑起来：
    // 这里只钉两条早退（未熔断 / 冷却未到），它们必须在 `open()` 之前返回。
    let mut p = DxgiPool::default();
    p.maybe_revive();
    assert!(p.is_enabled() && p.outs.is_empty());
    p.note_disabled("测试");
    p.retry_after = Some(std::time::Instant::now() + std::time::Duration::from_secs(3600));
    p.maybe_revive();
    assert!(!p.is_enabled(), "冷却未到就重开等于每圈白烧一次设备初始化");
}
