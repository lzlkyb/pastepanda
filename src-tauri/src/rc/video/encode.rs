//! 抓屏编码主路径：capture_and_encode / encode_rgba(_ts) 与脏块检测。

use super::*;

/// 抓屏并编码（带脏矩形与自适应）。按 profile 选虚拟屏或主屏。
pub fn capture_and_encode(state: &mut EncoderState) -> Result<Encoded, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("远程画面目前仅支持 Windows".into())
    }
    #[cfg(target_os = "windows")]
    {
        // 采集时刻（epoch ms）：随帧带到发起端，前端据其算「画面链路延迟」。
        // 必须在抓屏**之前**取，把编码耗时排除在延迟口径之外。
        let ts = chrono::Utc::now().timestamp_millis();
        // P0-2 延迟分段：采集耗时单独记，前端 HUD 能看到「慢在抓还是慢在编」。
        let t0 = std::time::Instant::now();
        let (w, h, rgba) = if state.monitor >= 0 {
            crate::screenshot::capture_monitor_rgba(state.monitor)?
        } else if state.virtual_screen {
            crate::screenshot::capture_virtual_screen_rgba()?
        } else {
            crate::screenshot::capture_primary_screen_rgba()?
        };
        let cap_ms = t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
        // 🔴 所有权直传：抓屏函数产出的 Vec 直接进编码器，
        // 不再为 `&[u8]` 签名白白 clone 一份全屏（4K 一次就是 33MB）。
        let mut out = encode_rgba_ts(state, w as u32, h as u32, rgba, ts)?;
        out.frame.cap_ms = cap_ms;
        Ok(out)
    }
}

/// RGBA → 降采样 →（脏矩形或整帧）JPEG。
pub fn encode_rgba(
    state: &mut EncoderState,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<Encoded, String> {
    encode_rgba_ts(state, width, height, rgba.to_vec(), chrono::Utc::now().timestamp_millis())
}

pub fn encode_rgba_ts(
    state: &mut EncoderState,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    ts: i64,
) -> Result<Encoded, String> {
    if width == 0 || height == 0 {
        return Err("空画面".into());
    }
    let img = image::RgbaImage::from_raw(width, height, rgba).ok_or("像素数据构造失败")?;
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    let max_w = state.profile.max_w;
    let (tw, th) = if width > max_w {
        let th = ((height as u64 * max_w as u64) / width as u64).max(1) as u32;
        (max_w, th)
    } else {
        (width, height)
    };
    let resized = if (tw, th) != (width, height) {
        dyn_img.resize_exact(tw, th, FilterType::Triangle)
    } else {
        dyn_img
    };
    let rgb = resized.to_rgb8();
    let rgb_bytes = rgb.as_raw();
    let now = ts;

    state.frame_idx = state.frame_idx.wrapping_add(1);
    let force_key = state.frame_idx % KEYFRAME_EVERY == 1;

    // 与上一帧比脏块。先算出纯结论再改状态（last_rgb 的借用要跨过 match）。
    enum Compare {
        NoBaseline,
        Resized,
        Static,
        Full,
        Rect(DirtyRect),
    }
    let outcome = if force_key {
        Compare::Full
    } else if let Some((lw, lh, last)) = state.last_rgb.as_ref() {
        if *lw == tw && *lh == th {
            match find_dirty_rect(last, rgb_bytes, tw, th) {
                DirtyOutcome::Static => Compare::Static,
                DirtyOutcome::Full => Compare::Full,
                DirtyOutcome::Rect(r) => Compare::Rect(r),
            }
        } else {
            Compare::Resized
        }
    } else {
        Compare::NoBaseline
    };

    let mut refine_now = false;
    let dirty: Option<DirtyRect> = match outcome {
        Compare::Static => {
            // 静止跳帧（调用方不发送）；但静止持续超过阈值且还没回补过，
            // 就发一帧高保真整帧——「越看越清晰」（AnyDesk 式体验）。
            let since = now.saturating_sub(state.last_change_ms);
            if state.last_change_ms > 0 && !state.refined && since >= REFINE_AFTER_MS {
                refine_now = true;
                state.refined = true; // 一次性：画面再变才复位
                None
            } else {
                return Ok(Encoded {
                    rect: Some(DirtyRect {
                        x: 0,
                        y: 0,
                        w: 0,
                        h: 0,
                    }),
                    refine: false,
                    frame: VideoFrame {
                        width: 0,
                        height: 0,
                        jpeg: Vec::new(),
                        at_ms: ts,
                        full: false,
                        rect: None,
                        codec: FrameCodec::Jpeg,
                        key: false,
                        cap_ms: 0,
                        enc_ms: 0,
                    },
                });
            }
        }
        Compare::Rect(r) => {
            remember_last(state, tw, th, rgb_bytes);
            state.last_change_ms = now;
            state.refined = false;
            Some(r)
        }
        _ => {
            // 整帧（首次 / 尺寸变了 / 强制关键帧）：画面真变了
            remember_last(state, tw, th, rgb_bytes);
            state.last_change_ms = now;
            state.refined = false;
            None
        }
    };

    // 🔴 整帧路径直接借 `rgb` 的缓冲编码，不再 clone 一份全屏；
    // 只有脏矩形裁剪需要自有缓冲。
    let crop;
    let (jpeg_src, out_w, out_h): (&[u8], u32, u32) = if let Some(r) = dirty {
        crop = crop_rgb(rgb_bytes, tw, th, r)?;
        (&crop, r.w, r.h)
    } else {
        (rgb_bytes, tw, th)
    };

    let enc_quality = if refine_now { REFINE_QUALITY } else { state.quality };
    // P0-2 延迟分段：JPEG 编码耗时单独记。
    //
    // 🔴 编码器是**系统 WIC**（`rc/wic_jpeg`），不再是 `image` crate 那个纯 Rust 实现：
    // 同一张 2560x1440 图 196.78 → 20.9 ms/帧（2026-09-24 探针实测），而真机
    // 「整圈 190ms/帧」几乎全是这一段。`image` 仍留给 PNG 路径与测试用。
    let enc_t0 = std::time::Instant::now();
    let buf = crate::rc::wic_jpeg::encode_jpeg(jpeg_src, out_w, out_h, enc_quality)?;
    let enc_ms = enc_t0.elapsed().as_millis().min(u16::MAX as u128) as u16;
    if buf.len() > MAX_JPEG_BYTES {
        return Err(format!("JPEG 帧过大（{} 字节）", buf.len()));
    }
    // 回补帧不计入码控：它是一次性的画质投资，按它降质会让正常帧跟着遭殃
    if !refine_now {
        state.adapt(buf.len());
    }
    Ok(Encoded {
        rect: dirty,
        refine: refine_now,
        frame: VideoFrame {
            width: out_w,
            height: out_h,
            jpeg: buf,
            at_ms: ts,
            full: dirty.is_none(),
            rect: dirty,
            codec: FrameCodec::Jpeg,
            key: dirty.is_none(),
            cap_ms: 0,
            enc_ms,
        },
    })
}

/// 把当前帧存为下一帧的比较基准。尺寸没变时复用旧缓冲，
/// 免掉每帧一次全屏 clone（原实现 2560 宽一帧白拷 ~20MB）。
fn remember_last(state: &mut EncoderState, tw: u32, th: u32, cur: &[u8]) {
    match state.last_rgb.as_mut() {
        Some((lw, lh, buf)) if *lw == tw && *lh == th => {
            buf.clear();
            buf.extend_from_slice(cur);
        }
        _ => state.last_rgb = Some((tw, th, cur.to_vec())),
    }
}

enum DirtyOutcome {
    Static,
    Full,
    Rect(DirtyRect),
}

fn find_dirty_rect(prev: &[u8], cur: &[u8], w: u32, h: u32) -> DirtyOutcome {
    let tiles_x = w.div_ceil(TILE);
    let tiles_y = h.div_ceil(TILE);
    let mut dirty_tiles = 0u32;
    let mut min_x = u32::MAX;
    let mut min_y = u32::MAX;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let x0 = tx * TILE;
            let y0 = ty * TILE;
            let x1 = (x0 + TILE).min(w);
            let y1 = (y0 + TILE).min(h);
            if tile_dirty(prev, cur, w, x0, y0, x1, y1) {
                dirty_tiles += 1;
                min_x = min_x.min(x0);
                min_y = min_y.min(y0);
                max_x = max_x.max(x1);
                max_y = max_y.max(y1);
            }
        }
    }
    if dirty_tiles == 0 {
        return DirtyOutcome::Static;
    }
    let total = tiles_x * tiles_y;
    let ratio = dirty_tiles as f32 / total.max(1) as f32;
    if ratio >= DIRTY_RATIO_SEND {
        return DirtyOutcome::Full;
    }
    // 外扩 1 块，减少接缝
    let pad = TILE;
    let x0 = min_x.saturating_sub(pad);
    let y0 = min_y.saturating_sub(pad);
    let x1 = (max_x + pad).min(w);
    let y1 = (max_y + pad).min(h);
    if x1 <= x0 || y1 <= y0 {
        return DirtyOutcome::Full;
    }
    DirtyOutcome::Rect(DirtyRect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

/// 单块差分判定：**整块平均差** ≥ 阈值才算脏（与逐像素扫全图的旧语义一致）。
///
/// 剪枝只做「不可能脏」的上界退出：剩余像素全取最大差（255×3）也够不着
/// 阈值时提前收。🔴 不能反向剪——曾写的是「当前和 ≥ 阈值×已扫数就判脏」，
/// 借口「均值只增不减」，可运行均值并不单调（后续小于均值的像素会拉低它）：
/// 块内第 1 个像素 d=100 就立即判脏，全块均值 0.39 本不该脏——微噪点块
/// 永久判脏，静止跳帧与 q95 精修静默失效（2026-09-19 审查 P2）。
pub(in crate::rc) fn tile_dirty(prev: &[u8], cur: &[u8], w: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> bool {
    let threshold = TILE_DIFF_THRESHOLD as u64;
    let max_d = (255u64) * 3;
    let total = ((x1 - x0) as u64) * ((y1 - y0) as u64);
    let mut sum = 0u64;
    let mut n = 0u64;
    for y in y0..y1 {
        let row = (y * w) as usize * 3;
        for x in x0..x1 {
            let i = row + (x as usize) * 3;
            if i + 2 >= prev.len() || i + 2 >= cur.len() {
                continue;
            }
            let d = (prev[i] as i32 - cur[i] as i32).abs()
                + (prev[i + 1] as i32 - cur[i + 1] as i32).abs()
                + (prev[i + 2] as i32 - cur[i + 2] as i32).abs();
            sum += d as u64;
            n += 1;
            // 上界剪枝（双向）：
            // 「必然脏」——已扫的差分和就算剩下全 0 也够阈值（拖动整窗时
            //   前几个大差像素就能退出，不必扫完全块）；
            // 「必然静」——剩下全取最大差也够不着阈值。
            // （被越界跳过的像素两头都不计入，等式仍成立。）
            if sum >= threshold * total {
                return true;
            }
            if sum + (total - n) * max_d < threshold * n {
                return false;
            }
        }
    }
    n > 0 && sum >= threshold * n
}

fn crop_rgb(rgb: &[u8], w: u32, h: u32, r: DirtyRect) -> Result<Vec<u8>, String> {
    if r.x + r.w > w || r.y + r.h > h || r.w == 0 || r.h == 0 {
        return Err("脏矩形越界".into());
    }
    let mut out = vec![0u8; (r.w * r.h * 3) as usize];
    for y in 0..r.h {
        let src = ((r.y + y) * w + r.x) as usize * 3;
        let dst = (y * r.w) as usize * 3;
        let n = (r.w as usize) * 3;
        if src + n > rgb.len() {
            return Err("裁剪越界".into());
        }
        out[dst..dst + n].copy_from_slice(&rgb[src..src + n]);
    }
    Ok(out)
}
